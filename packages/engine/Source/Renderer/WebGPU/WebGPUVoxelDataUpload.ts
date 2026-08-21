/**
 * Uploads decoded voxel property data to a WebGPU 3D texture.
 *
 * The root tile maps directly from shape coordinates to its padded texel grid.
 * The first metadata property is expanded to RGBA; missing color channels are
 * zero and a missing alpha channel is one.
 *
 * Box providers with `availableLevels >= 2` use a Z-stacked atlas. Slot 0 is
 * the root and slots 1..8 are level-1 children, indexed by `x + 2y + 4z` in
 * the Z-up shape frame. A missing child retains `childSlots[i] = -1`, causing
 * the WGSL walk to sample the deepest resident ancestor for that octant.
 *
 * A provider with at least three levels can use a 73-slot atlas when it fits
 * `maxTextureDimension3D`: slots 9..72 hold level-2 tiles in `x + 4y + 16z`
 * order. A provider with at least four levels can use a 585-slot atlas when it
 * fits: slots 73..584 hold level-3 tiles in `x + 8y + 64z` order. The fixed
 * per-level slot arrays must remain on shallower paths because their `-1`
 * entries preserve stable UBO ranges and terminate traversal at the deepest
 * uploaded ancestor.
 *
 * Descendants upload only while the camera's SSE ladder demands their level.
 * The demand is capped by atlas capacity rather than current residency, so a
 * close camera can converge to the fully populated atlas while a far camera
 * retains only the root.
 *
 * If all 64 level-2 tiles do not fit, slots after the root and level-1 region
 * form an LRU pool. A demanded ready tile takes a free slot or evicts the
 * least-recently-demanded resident not demanded in the current frame. Uploads
 * wait when every resident is currently demanded, preventing overflow and
 * same-frame thrashing. Root and level-1 slots are never evicted.
 *
 * Level-3 residency is intentionally static: dynamic eviction is implemented
 * only for level 2, so a level-3 set that does not fit falls back to the
 * level-2 cap. Extending partial residency deeper requires a per-level page
 * table; the existing per-level state and slot arrays are scaffolding for that
 * separation and must not be collapsed into one undifferentiated tile list.
 * Cylinder and ellipsoid sampling supports padded root textures but remains
 * root-only until their octree coordinate mapping is supported. Traversal
 * stops at level 3. Refined picking composes the level-1 slot into the
 * megatexture index.
 *
 * The caller uses this module only when provider content is available.
 * Otherwise it retains the placeholder gradient texture. Both paths expose a
 * `texture_3d<f32>` to the ray marcher, so only the texture source differs.
 *
 * @module WebGPUVoxelDataUpload
 */

// `CesiumFrameState` is an ambient global declared in cesium-js-types.d.ts —
// referenced without an import, matching WebGPUVoxelRenderer.ts.

// Provider metadata is ordered in the input orientation (glTF Y-up for
// box/cylinder tiles from Cesium3DTilesVoxelProvider, 3D Tiles Z-up
// otherwise) and includes padding voxels. Size the destination with the
// padded, Y-up-adjusted input dimensions so a linear copy matches
// Octree.glsl's `inputCoordinate` mapping.
import VoxelMetadataOrder from "../../Scene/VoxelMetadataOrder.js";
import VoxelShapeType from "../../Scene/VoxelShapeType.js";
import {
  captureVoxelResourceLifecycleToken,
  createVoxelAsyncFailureState,
  detachVoxelResourceLifecycle,
  disposeAllVoxelContents,
  disposeUnpublishedVoxelContent,
  ensureVoxelAtlasSlotCapacity,
  isVoxelAtlasSlotPickSafe,
  isVoxelResourceLifecycleTokenCurrent,
  publishVoxelAtlasSlot,
  recordVoxelAsyncFailure,
  releaseVoxelContent,
  retireVoxelAtlasSlot,
  selectVoxelAtlasLruVictim,
  stampVoxelAtlasDemandFrame,
  tryRetainVoxelContentForToken,
  type VoxelAsyncFailureState,
  type VoxelResourceLifecycle,
} from "./WebGPUVoxelResourceLifecycle.js";

/**
 * Minimal structural view of a {@link VoxelContent}. `metadata` is an array of
 * flattened typed arrays (one per property), each ordered X, then Y, then Z.
 */
interface VoxelContentLike {
  update(primitive: unknown, frameState: unknown): void;
  readonly ready: boolean;
  readonly metadata: ArrayLike<number>[] | undefined;
  destroy?(): unknown;
  isDestroyed?(): boolean;
}

/**
 * Minimal structural view of the voxel provider needed to request the root
 * tile and size the destination texture.
 */
interface VoxelProviderLike {
  requestData(options: {
    tileLevel: number;
    tileX: number;
    tileY: number;
    tileZ: number;
    keyframe: number;
  }): Promise<VoxelContentLike> | undefined;
  readonly dimensions: { x: number; y: number; z: number };
  // Optional fields used to size the texture in input orientation
  // and record the sample-frame convention.
  readonly paddingBefore?: { x: number; y: number; z: number };
  readonly paddingAfter?: { x: number; y: number; z: number };
  readonly metadataOrder?: number;
  readonly shape?: string;
  // Number of octree levels with available tiles. Undefined or less than two
  // keeps the single-tile path.
  readonly availableLevels?: number;
}

/**
 * Sample-frame convention used to lay out the uploaded texture. The renderer
 * packs the same extents into its UBO so its shape-UV-to-input-coordinate
 * mapping matches Octree.glsl. A `null` convention selects direct
 * `uvw = p + 0.5` sampling.
 */
export interface VoxelSampleConvention {
  /** Unpadded tile dimensions in the Z-up shape orientation (u_dimensions). */
  dimensions: { x: number; y: number; z: number };
  /** Padding before the tile, Z-up orientation (u_paddingBefore). */
  paddingBefore: { x: number; y: number; z: number };
  /**
   * Padded dimensions in the input-data orientation (u_inputDimensions):
   * `dimensions + paddingBefore + paddingAfter`, then Y/Z swapped when the
   * metadata order is glTF Y-up. These are the texture extents.
   */
  inputDimensions: { x: number; y: number; z: number };
  /** True when the Y-up box swap/flip (Octree.glsl Y_UP_METADATA_ORDER + SHAPE_BOX) applies. */
  yUpBox: boolean;
}

/**
 * Per-child asynchronous state, using the same
 * idle → requesting → processing → done | failed machine as the root.
 */
interface VoxelChildTileState {
  phase: "idle" | "requesting" | "processing" | "done" | "failed";
  /**
   * The tile's decoded content. Populated once the phase reaches "processing"
   * and retained through "done" so refined-tile `scene.pickVoxel` can read the
   * metadata. Reset to null only on LRU eviction or failure, matching WebGL's
   * resident keyframe-node lifetime.
   */
  content: VoxelContentLike | null;
  /**
   * The {@link VoxelDataUploadState.frameIndex} value of the most recent frame
   * this tile was demanded by per-tile SSE and frustum tests. The LRU victim is
   * the resident tile with the smallest value that is not demanded on the
   * current frame. Unused (stays 0) on the static full-atlas path and for
   * level-1 tiles.
   */
  lastDemandFrame: number;
  /** Monotonic request identity; invalidates late promise completion. */
  requestSerial: number;
  /** Atlas-slot identity captured when this content was published. */
  slotGeneration: number;
}

/**
 * Per-primitive state machine for the one-time root-tile upload. Lives on the
 * voxel cache under `dataUpload`.
 */
export interface VoxelDataUploadState {
  /** Idempotent owner-teardown sentinel. */
  destroyed: boolean;
  /** Exact device-generation lifetime shared with the owning renderer cache. */
  lifecycle: VoxelResourceLifecycle;
  /** Monotonic root request identity; invalidates late promise completion. */
  requestSerial: number;
  /** Resource-lifecycle epoch captured by the active mandatory root request. */
  requestLifecycleToken: number;
  /** Lifecycle phase of the async request → process → upload sequence. */
  phase: "idle" | "requesting" | "processing" | "done" | "failed";
  /** First terminal root failure for this exact owner lifecycle. */
  rootFailure: VoxelAsyncFailureState;
  /** The resolved root-tile content (available once phase === 'processing'). */
  content: VoxelContentLike | null;
  /** The real-data texture, once uploaded. Owned here; destroyed by caller. */
  texture: GPUTexture | null;
  /** View of {@link texture} for binding into the ray-march bind group. */
  view: GPUTextureView | null;
  /**
   * Set at upload time. A non-null convention means the texture uses padded
   * input-oriented extents and the renderer must sample through the WebGL
   * shape-UV-to-input-coordinate chain. Null selects unpadded Z-up extents and
   * direct `p + 0.5` sampling.
   */
  convention: VoxelSampleConvention | null;
  /**
   * Number of tile slots stacked along Z in {@link texture}. One is a
   * single-tile texture; nine adds eight level-1 children; 73 adds 64 level-2
   * tiles; 585 adds 512 level-3 tiles.
   */
  slotCount: number;
  /**
   * Atlas slot per level-1 child octant (`x + 2y + 4z` in the Z-up shape
   * frame), or -1 while the child is not uploaded.
   * Packed verbatim into the ray-march UBO (floats 108..115).
   */
  childSlots: Float32Array;
  /**
   * Atlas slot per level-2 tile (`x + 4y + 16z` in the Z-up shape frame; 64
   * entries), or -1 while that tile is not uploaded. Packed verbatim into the
   * ray-march UBO (floats 120..183). All -1 on the 9-slot / single-tile paths
   * (never read there — the WGSL walk only consults level 2 when the target
   * level reaches 2, which requires an uploaded level-2 tile).
   */
  l2Slots: Float32Array;
  /**
   * Atlas slot per level-3 tile (`x + 8y + 64z` over the 8x8x8 level-3 tile
   * grid in the Z-up shape frame; 512 entries), or -1 while that tile is not
   * uploaded. Packed verbatim into the ray-march UBO (floats 228..739). Only
   * non-empty on the static level-3 atlas (`slotCount === 585`, base slot 73);
   * all -1 on shallower atlases (never read there — the WGSL walk only consults
   * level 3 when the target level reaches 3, which requires an uploaded level-3
   * tile CPU-side).
   */
  l3Slots: Float32Array;
  /** Child-request lifecycle. "none" selects the single-tile path. */
  childPhase: "none" | "loading" | "done";
  /** Internal per-child asynchronous states (8 entries). */
  childStates: VoxelChildTileState[];
  /**
   * Internal per-level-2-tile asynchronous states (64 entries). Driven for a
   * static 73-slot atlas or a dynamic level-2 pool.
   */
  l2States: VoxelChildTileState[];
  /**
   * Internal per-level-3-tile asynchronous states (512 entries). Allocated
   * lazily (empty until the static level-3 atlas is built)
   * and driven only when {@link slotCount} is 585.
   */
  l3States: VoxelChildTileState[];
  /**
   * Number of atlas slots reserved for level-3 tiles: 0 or 512. Every level-3
   * tile has a static slot from 73 through 584. Dynamic level-3 eviction is not
   * supported, so refinement reaches level 3 only when the full 585-slot atlas
   * fits the device. Keep this separate from the level-2 pool size because the
   * two levels occupy fixed, independently packed UBO ranges.
   */
  l3PoolSize: number;
  /**
   * Number of atlas slots available to level-2 tiles: 0 (no deep atlas), 64
   * (every level-2 tile has a static reserved slot), or 1..63 (a dynamic LRU
   * pool at slots 9..slotCount-1 when the full set does not fit the capacity).
   */
  l2PoolSize: number;
  /** True when the level-2 pool is LRU-managed. */
  l2Dynamic: boolean;
  /**
   * Free slot indices of the dynamic level-2 pool (LIFO; seeded descending so
   * pop() hands out 9, 10, ... first). Empty on the static paths.
   */
  freeL2Slots: number[];
  /**
   * The LRU clock, incremented on each frame in which
   * {@link tryUploadChildVoxelTiles} actively drives uploads.
   */
  frameIndex: number;
  /** Total evictions performed, exposed for diagnostics. */
  evictionCount: number;
  /**
   * Number of level-2 tiles demanded on the most recent frame with a dynamic
   * pool (per-tile SSE + frustum mask population count). This diagnostic is 0
   * on the static paths.
   */
  lastL2DemandCount: number;
  /** Texture format chosen at root upload (children must match). */
  uploadFormat: GPUTextureFormat | null;
  /**
   * The LOD level the renderer packed into the UBO on the
   * most recent frame (0 = root, 1 = refined). Exposed for diagnostics.
   */
  lastTargetLevel: number;
  /**
   * The camera's demanded refinement level on the most recent frame (SSE ladder
   * capped by atlas capacity, not by what is uploaded). Drives which descendant
   * levels {@link tryUploadChildVoxelTiles} requests/uploads. Exposed for
   * diagnostics.
   */
  demandLevel: number;
  /** Slot-0 identity used to reject stale asynchronous pick readback. */
  rootSlotGeneration: number;
}

function createChildTileState(): VoxelChildTileState {
  return {
    phase: "idle",
    content: null,
    lastDemandFrame: 0,
    requestSerial: 0,
    slotGeneration: 0,
  };
}

export function createVoxelDataUploadState(
  lifecycle: VoxelResourceLifecycle,
): VoxelDataUploadState {
  const childStates: VoxelChildTileState[] = [];
  for (let i = 0; i < 8; i++) {
    childStates.push(createChildTileState());
  }
  const l2States: VoxelChildTileState[] = [];
  for (let i = 0; i < 64; i++) {
    l2States.push(createChildTileState());
  }
  return {
    destroyed: false,
    lifecycle,
    requestSerial: 0,
    requestLifecycleToken: 0,
    phase: "idle",
    rootFailure: createVoxelAsyncFailureState(),
    content: null,
    texture: null,
    view: null,
    convention: null,
    slotCount: 1,
    childSlots: new Float32Array([-1, -1, -1, -1, -1, -1, -1, -1]),
    l2Slots: new Float32Array(64).fill(-1),
    l3Slots: new Float32Array(512).fill(-1),
    childPhase: "none",
    childStates,
    l2States,
    l3States: [],
    l3PoolSize: 0,
    l2PoolSize: 0,
    l2Dynamic: false,
    freeL2Slots: [],
    frameIndex: 0,
    evictionCount: 0,
    lastL2DemandCount: 0,
    uploadFormat: null,
    lastTargetLevel: 0,
    demandLevel: 0,
    rootSlotGeneration: 0,
  };
}

function failRootVoxelTile(
  state: VoxelDataUploadState,
  lifecycleToken: number,
  reason: unknown,
): void {
  const failure = recordVoxelAsyncFailure(
    state.lifecycle,
    lifecycleToken,
    state.rootFailure,
    reason,
  );
  if (!failure) {
    return;
  }

  state.requestSerial++;
  state.phase = "failed";
  const content = state.content;
  state.content = null;
  if (content) {
    releaseVoxelContent(state.lifecycle, content);
  }
}

function destroyVoxelTextureBestEffort(texture: GPUTexture | null): void {
  try {
    texture?.destroy();
  } catch {
    // A cleanup failure must not replace the recorded root upload failure or
    // interrupt teardown of the remaining voxel resources.
  }
}

function releaseTileContent(
  state: VoxelDataUploadState,
  tile: VoxelChildTileState,
): void {
  const content = tile.content;
  tile.content = null;
  if (content) {
    releaseVoxelContent(state.lifecycle, content);
  }
}

function failTile(
  state: VoxelDataUploadState,
  tile: VoxelChildTileState,
): void {
  tile.requestSerial++;
  tile.phase = "failed";
  tile.slotGeneration = 0;
  releaseTileContent(state, tile);
}

function isTileRequestCurrent(
  state: VoxelDataUploadState,
  tile: VoxelChildTileState,
  lifecycleToken: number,
  requestSerial: number,
): boolean {
  return (
    isVoxelResourceLifecycleTokenCurrent(state.lifecycle, lifecycleToken) &&
    tile.requestSerial === requestSerial &&
    tile.phase === "requesting"
  );
}

export function destroyVoxelDataUploadState(state: VoxelDataUploadState): void {
  if (state.destroyed) {
    return;
  }
  state.destroyed = true;
  // Detach first. Promise callbacks may run after this call, but their captured
  // epoch can no longer publish content into the retired owner cache.
  detachVoxelResourceLifecycle(state.lifecycle);
  state.requestSerial++;
  state.content = null;

  const levels = [state.childStates, state.l2States, state.l3States];
  for (const tiles of levels) {
    for (const tile of tiles) {
      tile.requestSerial++;
      tile.phase = "failed";
      tile.slotGeneration = 0;
      tile.content = null;
    }
  }

  state.childSlots.fill(-1);
  state.l2Slots.fill(-1);
  state.l3Slots.fill(-1);
  state.phase = "failed";
  state.childPhase = "none";
  state.rootSlotGeneration = 0;
  // All state fields have dropped their aliases; the ownership table can now
  // dispose each unique VoxelContent/loader once and release its strong keys.
  disposeAllVoxelContents(state.lifecycle);

  const texture = state.texture;
  state.texture = null;
  state.view = null;
  destroyVoxelTextureBestEffort(texture);
}

export function isVoxelDataUploadSlotPickSafe(
  state: VoxelDataUploadState,
  slot: number,
  generation: number,
): boolean {
  return isVoxelAtlasSlotPickSafe(state.lifecycle, slot, generation);
}

function getProvider(primitive: unknown): VoxelProviderLike | undefined {
  const provider = (primitive as { provider?: unknown }).provider;
  if (
    provider &&
    typeof (provider as VoxelProviderLike).requestData === "function" &&
    (provider as VoxelProviderLike).dimensions
  ) {
    return provider as VoxelProviderLike;
  }
  return undefined;
}

/**
 * Choose the destination 3D texture format. FLOAT32 voxel data is uploaded as
 * `rgba32float` when the device advertises `float32-filterable` (so the
 * existing `linear` sampler in the ray-march is valid); otherwise falls back
 * to `rgba16float`, which is always filterable and preserves the real data
 * structure at half-float precision. Both are a strict upgrade over the
 * placeholder's `rgba8unorm`.
 */
function chooseFormat(device: GPUDevice): {
  format: GPUTextureFormat;
  float32: boolean;
} {
  const float32 = device.features.has("float32-filterable");
  return {
    format: float32 ? "rgba32float" : "rgba16float",
    float32,
  };
}

/**
 * Expand a flattened per-voxel property array into a tightly-packed RGBA
 * buffer of `voxelCount` texels. Handles VEC4 (channelCount 4) directly and
 * pads narrower properties (scalar/VEC2/VEC3) into RGBA with alpha defaulting
 * to 1 so the ray-march density term stays meaningful.
 */
function expandToRGBA(
  src: ArrayLike<number>,
  voxelCount: number,
): Float32Array {
  const channelCount = Math.max(1, Math.floor(src.length / voxelCount));
  const out = new Float32Array(voxelCount * 4);
  for (let v = 0; v < voxelCount; v++) {
    const s = v * channelCount;
    const d = v * 4;
    out[d] = channelCount > 0 ? src[s] : 0;
    out[d + 1] = channelCount > 1 ? src[s + 1] : 0;
    out[d + 2] = channelCount > 2 ? src[s + 2] : 0;
    // VEC4 carries its own alpha; narrower properties default to opaque so
    // the volume is visible (density = alpha in the ray-march).
    out[d + 3] = channelCount > 3 ? src[s + 3] : 1;
  }
  return out;
}

/**
 * Convert a Float32Array of RGBA texels to packed IEEE-754 half floats
 * (Uint16Array) for a `rgba16float` texture upload.
 */
function toHalfFloat(f32: Float32Array): Uint16Array {
  const out = new Uint16Array(f32.length);
  const dv = new DataView(new ArrayBuffer(4));
  for (let i = 0; i < f32.length; i++) {
    dv.setFloat32(0, f32[i], true);
    const x = dv.getUint32(0, true);
    const sign = (x >>> 16) & 0x8000;
    let exp = ((x >>> 23) & 0xff) - 127 + 15;
    const mant = x & 0x7fffff;
    if (exp <= 0) {
      // Subnormal / underflow → flush to signed zero.
      out[i] = sign;
    } else if (exp >= 0x1f) {
      // Overflow / Inf / NaN → clamp to Inf (or NaN mantissa).
      out[i] = sign | 0x7c00 | (mant ? 0x200 : 0);
    } else {
      out[i] = sign | (exp << 10) | (mant >>> 13);
    }
  }
  return out;
}

/**
 * Drive the one-time root-tile data upload. Call once per frame from the voxel
 * renderer's update. Returns `true` on the frame the real-data texture becomes
 * available (so the caller can rebuild its bind group to point at
 * `state.view`); returns `false` while pending, already-done, or failed (in
 * which case the caller keeps the placeholder).
 */
export function tryUploadRootVoxelTile(
  device: GPUDevice,
  primitive: unknown,
  frameState: CesiumFrameState,
  state: VoxelDataUploadState,
): boolean {
  if (state.phase === "done" || state.phase === "failed") {
    return false;
  }

  const provider = getProvider(primitive);
  if (!provider) {
    // Without a real provider, the caller keeps the placeholder gradient.
    return false;
  }

  if (state.phase === "idle") {
    const lifecycleToken = captureVoxelResourceLifecycleToken(state.lifecycle);
    let promise: Promise<VoxelContentLike> | undefined;
    try {
      promise = provider.requestData({
        tileLevel: 0,
        tileX: 0,
        tileY: 0,
        tileZ: 0,
        keyframe: 0,
      });
    } catch (reason) {
      failRootVoxelTile(state, lifecycleToken, reason);
      return false;
    }
    if (!promise) {
      // Request could not be scheduled this frame — retry next frame.
      return false;
    }
    state.requestLifecycleToken = lifecycleToken;
    state.phase = "requesting";
    const requestSerial = ++state.requestSerial;
    promise
      .then((content) => {
        if (
          !isVoxelResourceLifecycleTokenCurrent(
            state.lifecycle,
            lifecycleToken,
          ) ||
          state.requestSerial !== requestSerial ||
          state.phase !== "requesting"
        ) {
          disposeUnpublishedVoxelContent(state.lifecycle, content);
          return;
        }
        if (
          tryRetainVoxelContentForToken(
            state.lifecycle,
            lifecycleToken,
            content,
          )
        ) {
          state.content = content;
          state.phase = "processing";
        }
      })
      .catch((reason) => {
        if (
          isVoxelResourceLifecycleTokenCurrent(
            state.lifecycle,
            lifecycleToken,
          ) &&
          state.requestSerial === requestSerial &&
          state.phase === "requesting"
        ) {
          failRootVoxelTile(state, lifecycleToken, reason);
        }
      });
    return false;
  }

  if (state.phase === "requesting") {
    return false;
  }

  // phase === 'processing' — advance the glTF loader until content is ready.
  const content = state.content;
  if (!content) {
    failRootVoxelTile(
      state,
      state.requestLifecycleToken,
      new Error("WebGPU voxel root tile resolved without content"),
    );
    return false;
  }
  try {
    content.update(primitive, frameState);
  } catch (reason) {
    failRootVoxelTile(state, state.requestLifecycleToken, reason);
    return false;
  }
  if (!content.ready) {
    return false;
  }

  const metadata = content.metadata;
  if (!metadata || metadata.length === 0 || !metadata[0]) {
    failRootVoxelTile(
      state,
      state.requestLifecycleToken,
      new Error("WebGPU voxel root tile contains no metadata property"),
    );
    return false;
  }

  const dims = provider.dimensions;
  // Box shapes use padded input-orientation dimensions, matching
  // `initFromProvider`'s `_inputDimensions`: the metadata array is ordered X,
  // then input-Y, then input-Z including padding voxels, and for glTF-sourced
  // tiles the input Y/Z axes are the 3D Tiles Z/flipped-Y axes. The renderer's
  // ray-march applies the matching shapeUv → inputCoordinate mapping (WebGL
  // Octree.glsl). Ellipsoid shapes carry the same padded convention (dimensions
  // are lon/lat/height cell counts; the extent Y/Z swap for Y_UP metadata
  // mirrors VoxelPrimitiveHelpers' inputDimensions swap) but the Octree.glsl
  // input-axis swap/flip is `SHAPE_BOX`-gated upstream, so `yUpBox` stays false
  // for ellipsoids. Cylinder shapes carry the same padded convention
  // (dimensions are radius/angle/height cell counts); like ellipsoids, `yUpBox`
  // stays false because the swap/flip is box-gated.
  const isBox = provider.shape === VoxelShapeType.BOX;
  const isEllipsoid = provider.shape === VoxelShapeType.ELLIPSOID;
  const isCylinder = provider.shape === VoxelShapeType.CYLINDER;
  let width = Math.max(1, Math.floor(dims.x));
  let height = Math.max(1, Math.floor(dims.y));
  let depth = Math.max(1, Math.floor(dims.z));
  let convention: VoxelSampleConvention | null = null;
  if (isBox || isEllipsoid || isCylinder) {
    const padB = provider.paddingBefore ?? { x: 0, y: 0, z: 0 };
    const padA = provider.paddingAfter ?? { x: 0, y: 0, z: 0 };
    const yUp = provider.metadataOrder === VoxelMetadataOrder.Y_UP;
    const paddedX = Math.max(1, Math.floor(dims.x + padB.x + padA.x));
    const paddedY = Math.max(1, Math.floor(dims.y + padB.y + padA.y));
    const paddedZ = Math.max(1, Math.floor(dims.z + padB.z + padA.z));
    width = paddedX;
    height = yUp ? paddedZ : paddedY;
    depth = yUp ? paddedY : paddedZ;
    convention = {
      dimensions: { x: dims.x, y: dims.y, z: dims.z },
      paddingBefore: { x: padB.x, y: padB.y, z: padB.z },
      inputDimensions: { x: width, y: height, z: depth },
      yUpBox: yUp && isBox,
    };
  }
  const voxelCount = width * height * depth;

  let rgba: Float32Array;
  try {
    rgba = expandToRGBA(metadata[0], voxelCount);
  } catch (reason) {
    failRootVoxelTile(state, state.requestLifecycleToken, reason);
    return false;
  }

  const { format, float32 } = chooseFormat(device);

  // Allocate a 9-slot Z-stacked atlas when the provider has level-1 tiles, the
  // box sampling convention is active, and the atlas depth fits the device
  // limit. Slot 0 is the root and slots 1..8 are asynchronously uploaded
  // level-1 children. Single-level providers keep `slotCount = 1`.
  //
  // Providers advertising a third level get the 73-slot atlas (adds the 64
  // level-2 tiles at slots 9..72) when it fits the slot capacity.
  //
  // Slot capacity is the device's `maxTextureDimension3D` divided by the
  // per-tile depth, further capped by the optional per-primitive
  // `_webgpuVoxelAtlasMaxSlots` memory bound. When undefined, the allocation
  // uses only the device capacity. When the full 73-slot set fits, use the
  // static tile-to-slot layout. When it does not fit but at least one spare
  // slot beyond the 9 static root+level-1 slots does (capacity >= 10), the
  // level-2 region becomes a dynamic LRU pool of (slotCount - 9) slots — demand
  // exceeding capacity streams tiles through the pool with eviction instead of
  // clamping traversal to depth 1. Capacity < 10 retains the 9-slot depth-1
  // atlas.
  const availableLevels = provider.availableLevels ?? 1;
  const maxDim3D = device.limits?.maxTextureDimension3D ?? 2048;
  const override = (
    primitive as {
      _webgpuVoxelAtlasMaxSlots?: number;
    }
  )._webgpuVoxelAtlasMaxSlots;
  const deviceSlotCap = Math.floor(maxDim3D / Math.max(1, depth));
  const slotCap =
    typeof override === "number" && override >= 1
      ? Math.min(deviceSlotCap, Math.floor(override))
      : deviceSlotCap;
  // Multilevel atlases remain box-gated because their octree-coordinate
  // mapping is box-specific. Keep ellipsoids and cylinders on the root-only
  // path until their refinement mapping is supported; testing only for a
  // non-null convention would send them through incompatible atlas indexing.
  const multiLevel =
    isBox && convention !== null && availableLevels >= 2 && slotCap >= 9;
  const wantDeep = multiLevel && availableLevels >= 3;
  const fullDeep = wantDeep && slotCap >= 73;
  const partialDeep = wantDeep && !fullDeep && slotCap >= 10;
  const deepLevel = fullDeep || partialDeep;
  // A provider advertising a fourth level (availableLevels >= 4) gets the
  // 585-slot atlas (adds the 512 level-3 tiles at slots 73..584) when the full
  // set fits the slot capacity. Only the static full atlas is supported at
  // level 3; the dynamic LRU pool remains level-2-only. When the 585-slot set
  // does not fit, traversal uses the level-2 cap. `fullDeep3` implies fullDeep
  // (585 > 73), so level 2 keeps its static slots too.
  const fullDeep3 = fullDeep && availableLevels >= 4 && slotCap >= 585;
  const slotCount = fullDeep3
    ? 585
    : fullDeep
      ? 73
      : partialDeep
        ? slotCap
        : multiLevel
          ? 9
          : 1;
  ensureVoxelAtlasSlotCapacity(state.lifecycle, slotCount);

  let texture: GPUTexture | null = null;
  let view: GPUTextureView;
  try {
    texture = device.createTexture({
      label: fullDeep3
        ? "Voxel real-data 3D atlas (root + level-1 + level-2 + level-3 tiles)"
        : deepLevel
          ? "Voxel real-data 3D atlas (root + level-1 + level-2 tiles)"
          : multiLevel
            ? "Voxel real-data 3D atlas (root + level-1 tiles)"
            : "Voxel real-data 3D texture (root tile)",
      size: { width, height, depthOrArrayLayers: depth * slotCount },
      format,
      dimension: "3d",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    const bytesPerTexel = float32 ? 16 : 8;
    const data: ArrayBufferView = float32 ? rgba : toHalfFloat(rgba);
    device.queue.writeTexture(
      { texture, origin: { x: 0, y: 0, z: 0 } },
      data,
      { bytesPerRow: width * bytesPerTexel, rowsPerImage: height },
      { width, height, depthOrArrayLayers: depth },
    );
    view = texture.createView();
  } catch (reason) {
    failRootVoxelTile(state, state.requestLifecycleToken, reason);
    destroyVoxelTextureBestEffort(texture);
    return false;
  }

  state.texture = texture;
  state.view = view;
  state.convention = convention;
  state.slotCount = slotCount;
  state.uploadFormat = format;
  state.rootSlotGeneration = publishVoxelAtlasSlot(state.lifecycle, 0);
  state.childPhase = multiLevel ? "loading" : "none";
  // Level-2 pool bookkeeping. A static full atlas
  // keeps an empty free list (slots are pre-assigned baseSlot + i); the
  // dynamic pool seeds its free list descending so pop() hands out ascending
  // slot numbers (9, 10, ...), keeping allocation deterministic.
  state.l2PoolSize = fullDeep ? 64 : partialDeep ? slotCount - 9 : 0;
  state.l2Dynamic = partialDeep;
  state.freeL2Slots.length = 0;
  if (partialDeep) {
    for (let s = 9 + state.l2PoolSize - 1; s >= 9; s--) {
      state.freeL2Slots.push(s);
    }
  }
  // Static level-3 pool bookkeeping. Slots 73..584 are pre-assigned as
  // baseSlot + i (no free list — parallels the static full level-2 path).
  // Level-3 tile states are allocated lazily here so shallower providers never
  // pay for 512 unused state objects.
  state.l3Slots.fill(-1);
  if (fullDeep3) {
    state.l3PoolSize = 512;
    if (state.l3States.length !== 512) {
      state.l3States = [];
      for (let i = 0; i < 512; i++) {
        state.l3States.push(createChildTileState());
      }
    } else {
      for (let i = 0; i < 512; i++) {
        releaseTileContent(state, state.l3States[i]);
        state.l3States[i].phase = "idle";
        state.l3States[i].lastDemandFrame = 0;
        state.l3States[i].requestSerial++;
        state.l3States[i].slotGeneration = 0;
      }
    }
  } else {
    state.l3PoolSize = 0;
    for (const tile of state.l3States) {
      tile.requestSerial++;
      releaseTileContent(state, tile);
    }
    state.l3States = [];
  }
  state.phase = "done";
  return true;
}

/**
 * Drive one level's asynchronous tile uploads into the atlas. Shared by the
 * level-1 (slots 1..8) and level-2 (slots 9..72) sets — same idle →
 * requesting → processing → done | failed machine per tile. Tile i at `level`
 * maps to coordinates (x = i % edge, y = (i / edge) % edge, z = i / edge²)
 * with `edge = 2^level` — the radix-2 extension of the Z-up shape-frame
 * octant convention (`childIndex = z * 4 + y * 2 + x` at level 1, matching
 * Octree.glsl's getOctreeChildData). A tile that is unavailable (provider
 * rejects) or fails to decode keeps `slots[i] = -1`; the WGSL walk then stops
 * at the deepest uploaded ancestor for that region.
 *
 * @returns the number of settled (done or failed) tiles in the set.
 */
function driveTileLevelUploads(
  device: GPUDevice,
  primitive: unknown,
  frameState: CesiumFrameState,
  state: VoxelDataUploadState,
  provider: VoxelProviderLike,
  level: number,
  states: VoxelChildTileState[],
  slots: Float32Array,
  baseSlot: number,
): number {
  const { inputDimensions } = state.convention!;
  const width = inputDimensions.x;
  const height = inputDimensions.y;
  const depth = inputDimensions.z;
  const voxelCount = width * height * depth;
  const float32 = state.uploadFormat === "rgba32float";
  const bytesPerTexel = float32 ? 16 : 8;
  const edge = 1 << level;
  const count = edge * edge * edge;

  let settled = 0;
  for (let i = 0; i < count; i++) {
    const child = states[i];
    if (child.phase === "done" || child.phase === "failed") {
      settled++;
      continue;
    }

    if (child.phase === "idle") {
      let promise: Promise<VoxelContentLike> | undefined;
      try {
        promise = provider.requestData({
          tileLevel: level,
          tileX: i % edge,
          tileY: Math.floor(i / edge) % edge,
          tileZ: Math.floor(i / (edge * edge)),
          keyframe: 0,
        });
      } catch {
        // Descendants are optional refinements. A synchronous provider failure
        // must settle only this child and retain its uploaded ancestor.
        failTile(state, child);
        settled++;
        continue;
      }
      if (!promise) {
        // Could not be scheduled this frame — retry next frame.
        continue;
      }
      child.phase = "requesting";
      const lifecycleToken = captureVoxelResourceLifecycleToken(
        state.lifecycle,
      );
      const requestSerial = ++child.requestSerial;
      promise
        .then((content) => {
          if (
            isTileRequestCurrent(state, child, lifecycleToken, requestSerial) &&
            tryRetainVoxelContentForToken(
              state.lifecycle,
              lifecycleToken,
              content,
            )
          ) {
            child.content = content;
            child.phase = "processing";
          } else {
            disposeUnpublishedVoxelContent(state.lifecycle, content);
          }
        })
        .catch(() => {
          // Tile not available (or failed) — ancestor fallback for this region.
          if (
            isTileRequestCurrent(state, child, lifecycleToken, requestSerial)
          ) {
            failTile(state, child);
          }
        });
      continue;
    }

    if (child.phase === "requesting") {
      continue;
    }

    // phase === "processing" — advance the loader until the content is ready.
    const content = child.content;
    if (!content) {
      child.phase = "failed";
      settled++;
      continue;
    }
    try {
      content.update(primitive, frameState);
    } catch {
      failTile(state, child);
      settled++;
      continue;
    }
    if (!content.ready) {
      continue;
    }

    const metadata = content.metadata;
    if (!metadata || metadata.length === 0 || !metadata[0]) {
      failTile(state, child);
      settled++;
      continue;
    }

    const slot = baseSlot + i;
    try {
      const rgba = expandToRGBA(metadata[0], voxelCount);
      const data: ArrayBufferView = float32 ? rgba : toHalfFloat(rgba);
      device.queue.writeTexture(
        { texture: state.texture!, origin: { x: 0, y: 0, z: slot * depth } },
        data,
        { bytesPerRow: width * bytesPerTexel, rowsPerImage: height },
        { width, height, depthOrArrayLayers: depth },
      );
    } catch {
      failTile(state, child);
      settled++;
      continue;
    }
    slots[i] = slot;
    child.slotGeneration = publishVoxelAtlasSlot(state.lifecycle, slot);
    // Retain the CPU-side content so a refined-tile `scene.pickVoxel` can build
    // a full VoxelCell from this child's metadata. VoxelTraversal keeps
    // `keyframeNode.content` for every resident tile, which is what
    // `findKeyframeNode(tileIndex).content` reads. Rendering uses the uploaded
    // texture; retaining content aligns CPU metadata lifetime with traversal.
    child.phase = "done";
    settled++;
  }

  return settled;
}

/**
 * Drives asynchronous descendant-tile uploads into atlas slots 1..8 (level 1)
 * and, on a 73-slot atlas, slots 9..72 (level 2). Call once per frame from the
 * voxel renderer's update after the root has uploaded
 * (`state.phase === "done"`); no-ops for single-level providers
 * (`childPhase === "none"`) and once every tile has settled.
 *
 * Uploads are demand-driven: `demandLevel` is the camera's SSE-ladder
 * refinement level for this frame, capped by atlas capacity rather than by
 * uploaded tiles (see the renderer's `computeVoxelDemandLevel`). Level-1 tiles
 * are only requested/uploaded while `demandLevel >= 1`, level-2 tiles while
 * `demandLevel >= 2`, matching VoxelTraversal megatexture behavior: tiles enter
 * the megatexture only when the traversal's SSE test visits them. When demand
 * recedes mid-stream, in-flight requests simply pause at their current phase
 * and resume when the camera demands that level again; uploaded slots stay
 * resident on the static full atlas. `childPhase` flips to "done" only when
 * every tile the atlas has capacity for has settled, so a scene whose camera
 * demands the deepest level converges with every supported tile resident.
 *
 * When the level-2 pool is dynamic (`state.l2Dynamic`, capacity < 73), the
 * level-2 set is driven by the per-tile demand mask (`l2DemandMask`,
 * renderer-computed SSE + frustum gate) through {@link driveDynamicL2Uploads}
 * instead: demanded tiles take free pool slots or LRU-evict a stale resident;
 * residency follows the camera for the life of the primitive, so `childPhase`
 * never flips to "done" on this path. Static paths ignore the mask entirely.
 */
export function tryUploadChildVoxelTiles(
  device: GPUDevice,
  primitive: unknown,
  frameState: CesiumFrameState,
  state: VoxelDataUploadState,
  demandLevel: number,
  l2DemandMask: Uint8Array | null = null,
): void {
  if (
    state.phase !== "done" ||
    state.childPhase !== "loading" ||
    !state.texture ||
    !state.convention ||
    state.slotCount < 9 ||
    demandLevel < 1
  ) {
    return;
  }

  const provider = getProvider(primitive);
  if (!provider) {
    return;
  }

  // Advance the LRU clock only on frames that actively drive uploads, using
  // the same guard conditions as the drives below.
  state.frameIndex++;

  let settled = driveTileLevelUploads(
    device,
    primitive,
    frameState,
    state,
    provider,
    1,
    state.childStates,
    state.childSlots,
    1,
  );
  let total = 8;

  if (state.l2Dynamic) {
    // In the dynamic pool, residency follows demand for
    // the life of the primitive; no terminal "done" state exists.
    driveDynamicL2Uploads(
      device,
      primitive,
      frameState,
      state,
      provider,
      demandLevel,
      l2DemandMask,
    );
    return;
  }

  if (state.slotCount >= 73) {
    total += 64;
    if (demandLevel >= 2) {
      settled += driveTileLevelUploads(
        device,
        primitive,
        frameState,
        state,
        provider,
        2,
        state.l2States,
        state.l2Slots,
        9,
      );
    } else {
      // Level 2 not demanded this frame — count (without driving) any tiles
      // that already settled under earlier demand, so a later demand recession
      // cannot deadlock the "done" transition after everything has settled.
      for (let i = 0; i < 64; i++) {
        const phase = state.l2States[i].phase;
        if (phase === "done" || phase === "failed") {
          settled++;
        }
      }
    }
  }

  // The static level-3 set occupies slots 73..584 and is driven
  // only when the camera demands level >= 3 (the streaming semantics — a tile
  // enters the atlas only when the SSE ladder visits its level). Uses the same
  // level-generic `driveTileLevelUploads` machine (edge = 2^3 = 8, count 512).
  if (state.slotCount >= 585) {
    total += 512;
    if (demandLevel >= 3) {
      settled += driveTileLevelUploads(
        device,
        primitive,
        frameState,
        state,
        provider,
        3,
        state.l3States,
        state.l3Slots,
        73,
      );
    } else {
      for (let i = 0; i < 512; i++) {
        const phase = state.l3States[i].phase;
        if (phase === "done" || phase === "failed") {
          settled++;
        }
      }
    }
  }

  if (settled === total) {
    state.childPhase = "done";
  }
}

/**
 * Evicts the least-recently-demanded resident level-2 tile and return its freed
 * slot, or -1 when every resident is demanded on the current frame (nothing
 * evictable — the caller waits). The victim resets to `idle` so a later demand
 * re-requests + re-uploads it through the normal machine (fresh, correct cell
 * values). Ties break to the lowest tile index for deterministic eviction.
 */
function evictLruL2Slot(state: VoxelDataUploadState): number {
  const victim = selectVoxelAtlasLruVictim(
    state.l2Slots,
    state.l2States,
    state.frameIndex,
  );
  if (victim < 0) {
    return -1;
  }
  const slot = state.l2Slots[victim];
  state.l2Slots[victim] = -1;
  const tile = state.l2States[victim];
  tile.requestSerial++;
  tile.phase = "idle";
  retireVoxelAtlasSlot(state.lifecycle, slot, tile.slotGeneration);
  tile.slotGeneration = 0;
  releaseTileContent(state, tile);
  state.evictionCount++;
  return slot;
}

/**
 * Drives level-2 uploads against the dynamic slot pool. Per tile: stamp
 * `lastDemandFrame` when demanded (per-tile SSE + frustum mask from the
 * renderer), advance the request → process machine only for demanded tiles, and
 * on ready-to-write allocate a slot from the free list — or LRU-evict a stale
 * resident when the list is empty. A pool fully held by tiles demanded in the
 * current frame yields no slot: the upload waits (no overflow or same-frame
 * thrashing) and retries when demand shifts. Resident tiles that fall out of
 * demand stay resident until a demanded tile needs their slot. Failed tiles
 * never occupy a slot and are not retried (the WGSL walk falls back to the
 * level-1 ancestor for that region — same semantics as the static path).
 */
function driveDynamicL2Uploads(
  device: GPUDevice,
  primitive: unknown,
  frameState: CesiumFrameState,
  state: VoxelDataUploadState,
  provider: VoxelProviderLike,
  demandLevel: number,
  l2DemandMask: Uint8Array | null,
): void {
  const { inputDimensions } = state.convention!;
  const width = inputDimensions.x;
  const height = inputDimensions.y;
  const depth = inputDimensions.z;
  const voxelCount = width * height * depth;
  const float32 = state.uploadFormat === "rgba32float";
  const bytesPerTexel = float32 ? 16 : 8;

  // Declare the complete demand set before any ready tile can allocate or
  // evict. Stamping inside the loop lets a low-index upload evict a resident
  // high-index tile that is also demanded but has not been visited yet.
  const demandCount = stampVoxelAtlasDemandFrame(
    state.l2States,
    demandLevel,
    l2DemandMask,
    state.frameIndex,
  );
  for (let i = 0; i < 64; i++) {
    const tile = state.l2States[i];
    const demanded =
      demandLevel >= 2 && l2DemandMask !== null && l2DemandMask[i] !== 0;
    if (!demanded) {
      // Not demanded: residents stay until evicted; in-flight requests pause
      // at their current phase and resume under future demand.
      continue;
    }

    if (tile.phase === "done" || tile.phase === "failed") {
      continue;
    }

    if (tile.phase === "idle") {
      let promise: Promise<VoxelContentLike> | undefined;
      try {
        promise = provider.requestData({
          tileLevel: 2,
          tileX: i % 4,
          tileY: Math.floor(i / 4) % 4,
          tileZ: Math.floor(i / 16),
          keyframe: 0,
        });
      } catch {
        // Dynamic descendants use the same ancestor-fallback contract as the
        // static levels, including synchronous provider failures.
        failTile(state, tile);
        continue;
      }
      if (!promise) {
        continue;
      }
      tile.phase = "requesting";
      const lifecycleToken = captureVoxelResourceLifecycleToken(
        state.lifecycle,
      );
      const requestSerial = ++tile.requestSerial;
      promise
        .then((content) => {
          if (
            isTileRequestCurrent(state, tile, lifecycleToken, requestSerial) &&
            tryRetainVoxelContentForToken(
              state.lifecycle,
              lifecycleToken,
              content,
            )
          ) {
            tile.content = content;
            tile.phase = "processing";
          } else {
            disposeUnpublishedVoxelContent(state.lifecycle, content);
          }
        })
        .catch(() => {
          if (
            isTileRequestCurrent(state, tile, lifecycleToken, requestSerial)
          ) {
            failTile(state, tile);
          }
        });
      continue;
    }

    if (tile.phase === "requesting") {
      continue;
    }

    // phase === "processing" — advance the loader until the content is ready.
    const content = tile.content;
    if (!content) {
      tile.phase = "failed";
      continue;
    }
    try {
      content.update(primitive, frameState);
    } catch {
      failTile(state, tile);
      continue;
    }
    if (!content.ready) {
      continue;
    }
    const metadata = content.metadata;
    if (!metadata || metadata.length === 0 || !metadata[0]) {
      failTile(state, tile);
      continue;
    }

    // Ready to write — allocate a slot (free list first, else LRU-evict).
    let slot: number;
    if (state.freeL2Slots.length > 0) {
      slot = state.freeL2Slots.pop()!;
    } else {
      slot = evictLruL2Slot(state);
    }
    if (slot < 0) {
      // Pool fully held by currently-demanded residents — wait, retry later.
      continue;
    }

    try {
      const rgba = expandToRGBA(metadata[0], voxelCount);
      const data: ArrayBufferView = float32 ? rgba : toHalfFloat(rgba);
      device.queue.writeTexture(
        { texture: state.texture!, origin: { x: 0, y: 0, z: slot * depth } },
        data,
        { bytesPerRow: width * bytesPerTexel, rowsPerImage: height },
        { width, height, depthOrArrayLayers: depth },
      );
    } catch {
      state.freeL2Slots.push(slot);
      failTile(state, tile);
      continue;
    }
    state.l2Slots[i] = slot;
    tile.slotGeneration = publishVoxelAtlasSlot(state.lifecycle, slot);
    // Retain the CPU-side content so a refined-tile pick can construct its
    // VoxelCell (see the static-path note in driveTileLevelUploads). An LRU
    // eviction resets `content` to null in evictLruL2Slot, so a resident
    // dynamic slot always maps to live content.
    tile.phase = "done";
  }

  state.lastL2DemandCount = demandCount;
}
