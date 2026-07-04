/**
 * WebGPU Voxel Data Upload — PARITY-VOXEL-MEGATEXTURE-UPLOAD (increment 1)
 *
 * Replaces the 4×4×4 gradient placeholder in {@link WebGPUVoxelRenderer} with
 * the REAL per-tile voxel property data for the ROOT (single) voxel tile.
 *
 * Scope (deliberately narrow — one clean increment):
 *   - ROOT tile only (tileLevel/x/y/z = 0). No octree traversal, no LOD, no
 *     multi-tile megatexture atlas. Direct uvw→texel sampling: the ray-march
 *     cube maps 1:1 to the tile's `dimensions` grid.
 *   - Single metadata property (the first channel-4 / VEC4 property). The test
 *     asset (VoxelBox3DTiles) has exactly one VEC4 FLOAT32 property `a`.
 *
 * VOXEL-OCTREE-LOD (increment: depth-1 octree traversal) — when the provider
 * advertises `availableLevels >= 2` and the shape is a BOX (the sampling
 * convention now also covers ELLIPSOID — NEW-VOXEL-ELLIPSOID-SHAPEUV — and
 * CYLINDER — NEW-VOXEL-CYLINDER-SHAPEUV — but multi-level atlases stay
 * box-gated), the destination texture is allocated
 * as a 9-slot 3D ATLAS stacked
 * along Z: slot 0 = root tile, slots 1..8 = the eight level-1 child tiles
 * (childIndex = x + 2y + 4z in the Z-up shape frame). Child tiles are
 * requested + uploaded asynchronously after the root; a child that is
 * unavailable / fails keeps `childSlots[i] = -1` and the WGSL march falls back
 * to sampling the ROOT for that octant — the same semantics as Octree.glsl's
 * OCTREE_FLAG_PACKED_LEAF_FROM_PARENT leaf, specialised to depth 1.
 *
 * NEW-VOXEL-OCTREE-DEEP-TRAVERSAL (increment: depth-2) — when the provider
 * advertises `availableLevels >= 3` (and the 73-slot atlas fits the device's
 * `maxTextureDimension3D`), the atlas grows to 73 slots: slot 0 = root,
 * 1..8 = level-1 children, 9..72 = the 64 level-2 tiles in linear order
 * `x + 4y + 16z` (the radix-2 extension of the level-1 octant convention,
 * Z-up shape frame). Level-2 tiles upload asynchronously alongside the
 * level-1 set; an unavailable level-2 tile keeps `l2Slots[i] = -1` and the
 * WGSL walk stops at the deepest uploaded ancestor for that region.
 *
 * NEW-VOXEL-STREAMING-UPLOAD (increment: demand-driven upload) — descendant
 * tiles are no longer uploaded eagerly the moment the root lands. Each frame
 * the renderer evaluates the camera's SSE refinement ladder UNCAPPED by what
 * is uploaded (capped only by the atlas capacity) and passes the resulting
 * DEMAND level into {@link tryUploadChildVoxelTiles}: level-1 tiles are
 * requested/uploaded only while the camera demands level >= 1, level-2 tiles
 * only while it demands level >= 2 — mirroring upstream VoxelTraversal, which
 * only adds a tile to the megatexture when the SSE test visits it. A far
 * camera therefore keeps a root-only atlas; zooming in streams descendants in
 * on demand. Scenes whose camera demands the deepest level converge to the
 * SAME fully-uploaded steady state as the historical eager path
 * (pixel-identical steady state — the off-gate).
 *
 * NEW-VOXEL-ATLAS-LRU-EVICT (increment: LRU slot eviction) — when the
 * level-2 tile set does NOT fit the atlas (the device's
 * `maxTextureDimension3D` caps the slot count below 73, or the opt-in
 * per-primitive `_webgpuVoxelAtlasMaxSlots` override does), the level-2
 * region of the atlas becomes a DYNAMIC slot pool (slots 9..slotCount-1)
 * with LRU eviction — the upstream VoxelTraversal megatexture add/remove
 * analogue. Residency follows per-tile demand (the renderer's
 * `computeVoxelL2DemandMask`: per-tile SSE + frustum visibility): a demanded
 * tile that is ready to upload takes a free slot, or evicts the
 * least-recently-demanded resident that is NOT demanded this frame; if every
 * resident is currently demanded the upload simply waits (no overflow, no
 * thrash). An evicted tile resets to `idle` and re-requests/re-uploads the
 * next time the camera demands it. Root (slot 0) and the eight level-1 tiles
 * (slots 1..8) keep their static assignments and are never evicted.
 * Under-capacity scenes (the full 73-slot atlas fits and no override is set)
 * take the exact static B19 path — byte-identical (the off-gate).
 *
 * What is NOT done here (honest partial — separate increments):
 *   - Octree traversal DEEPER than level 2 (the WGSL walk + slot indirection
 *     arrays are depth-2; a deeper walk would reuse this increment's LRU pool
 *     with a per-level page table instead of the fixed l2Slots array).
 *   - LOD refinement for non-BOX shapes (cylinder/ellipsoid stay root-only).
 *   - Non-VEC4 properties (VEC3/VEC2/scalar) — this increment uploads the first
 *     property expanded to RGBA. Missing channels default to 0, alpha to 1.
 *   (Per-cell pickVoxel against refined tiles shipped in
 *   NEW-VOXEL-PICK-OCTREE-COMPOSE — the pick march composes the same depth-1
 *   traversal and emits the child slot as the megatexture index.)
 *
 * Off-gate: this module is only invoked when a real voxel provider + tile
 * content is available. When no provider/data is present the caller keeps the
 * placeholder gradient path (byte-identical off-case). The ray-march WGSL is
 * unchanged — it still samples a `texture_3d<f32>`; only the SOURCE of that
 * texture changes (placeholder → real data).
 *
 * @module WebGPUVoxelDataUpload
 */

// `CesiumFrameState` is an ambient global declared in cesium-js-types.d.ts —
// referenced without an import, matching WebGPUVoxelRenderer.ts.

// VOXEL-SHAPEUV-CONVENTION — the metadata array is ordered in the INPUT
// orientation (glTF Y-up for box/cylinder tiles from Cesium3DTilesVoxelProvider,
// 3D Tiles Z-up otherwise) and includes padding voxels. The destination 3D
// texture must therefore be sized with the INPUT dimensions (padded +
// Y-up-swapped) — mirroring `initFromProvider`'s `_inputDimensions` — so a
// straight linear copy lands every texel where WebGL's Octree.glsl
// `inputCoordinate` mapping expects it.
import VoxelMetadataOrder from "../../Scene/VoxelMetadataOrder.js";
import VoxelShapeType from "../../Scene/VoxelShapeType.js";

/**
 * Minimal structural view of a {@link VoxelContent}. `metadata` is an array of
 * flattened typed arrays (one per property), each ordered X, then Y, then Z.
 */
interface VoxelContentLike {
  update(primitive: unknown, frameState: unknown): void;
  readonly ready: boolean;
  readonly metadata: ArrayLike<number>[] | undefined;
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
  // VOXEL-SHAPEUV-CONVENTION — optional provider fields consumed to size the
  // texture in the INPUT orientation and to record the sample-frame convention.
  readonly paddingBefore?: { x: number; y: number; z: number };
  readonly paddingAfter?: { x: number; y: number; z: number };
  readonly metadataOrder?: number;
  readonly shape?: string;
  // VOXEL-OCTREE-LOD — number of octree levels with available tiles. Gate for
  // the level-1 child requests; undefined / <2 keeps the single-tile path.
  readonly availableLevels?: number;
}

/**
 * VOXEL-SHAPEUV-CONVENTION — the sample-frame convention the uploaded texture
 * was laid out with, recorded so the renderer's UBO pack mirrors WebGL's
 * shapeUv → inputCoordinate mapping (Octree.glsl) against the SAME extents the
 * texel data was written with. `null` convention on the state means the legacy
 * direct `uvw = p + 0.5` sampling applies (non-box shapes — unchanged path).
 */
export interface VoxelSampleConvention {
  /** Unpadded tile dimensions in the Z-up shape orientation (u_dimensions). */
  dimensions: { x: number; y: number; z: number };
  /** Padding before the tile, Z-up orientation (u_paddingBefore). */
  paddingBefore: { x: number; y: number; z: number };
  /**
   * Padded dimensions in the INPUT-data orientation (u_inputDimensions):
   * `dimensions + paddingBefore + paddingAfter`, then Y/Z swapped when the
   * metadata order is glTF Y-up. These are the texture extents.
   */
  inputDimensions: { x: number; y: number; z: number };
  /** True when the Y-up box swap/flip (Octree.glsl Y_UP_METADATA_ORDER + SHAPE_BOX) applies. */
  yUpBox: boolean;
}

/**
 * VOXEL-OCTREE-LOD — per-child-tile async state. Mirrors the root machine:
 * idle → requesting → processing → done | failed.
 */
interface VoxelChildTileState {
  phase: "idle" | "requesting" | "processing" | "done" | "failed";
  content: VoxelContentLike | null;
  /**
   * NEW-VOXEL-ATLAS-LRU-EVICT — the {@link VoxelDataUploadState.frameIndex}
   * value of the most recent frame this tile was DEMANDED (per-tile SSE +
   * frustum gate). The LRU victim is the resident tile with the smallest
   * value that is not demanded on the current frame. Unused (stays 0) on the
   * static full-atlas path and for level-1 tiles.
   */
  lastDemandFrame: number;
}

/**
 * Per-primitive state machine for the one-time root-tile upload. Lives on the
 * voxel cache under `dataUpload`.
 */
export interface VoxelDataUploadState {
  /** Lifecycle phase of the async request → process → upload sequence. */
  phase: "idle" | "requesting" | "processing" | "done" | "failed";
  /** The resolved root-tile content (available once phase === 'processing'). */
  content: VoxelContentLike | null;
  /** The real-data texture, once uploaded. Owned here; destroyed by caller. */
  texture: GPUTexture | null;
  /** View of {@link texture} for binding into the ray-march bind group. */
  view: GPUTextureView | null;
  /**
   * VOXEL-SHAPEUV-CONVENTION — set at upload time. When non-null the texture
   * is laid out in the padded INPUT orientation and the renderer must sample
   * through the WebGL shapeUv → inputCoordinate chain; when null the texture
   * uses the legacy unpadded Z-up extents and direct `p + 0.5` sampling.
   */
  convention: VoxelSampleConvention | null;
  /**
   * VOXEL-OCTREE-LOD — number of tile slots stacked along Z in {@link texture}.
   * 1 = single-tile texture (no atlas — the historical layout, byte-identical
   * math in the WGSL); 9 = root (slot 0) + eight level-1 children (slots 1..8);
   * 73 = the depth-2 atlas adding the 64 level-2 tiles (slots 9..72,
   * NEW-VOXEL-OCTREE-DEEP-TRAVERSAL).
   */
  slotCount: number;
  /**
   * VOXEL-OCTREE-LOD — atlas slot per level-1 child octant (childIndex =
   * x + 2y + 4z, Z-up shape frame), or -1 while the child is not uploaded.
   * Packed verbatim into the ray-march UBO (floats 108..115).
   */
  childSlots: Float32Array;
  /**
   * NEW-VOXEL-OCTREE-DEEP-TRAVERSAL — atlas slot per level-2 tile (linear
   * index x + 4y + 16z, Z-up shape frame; 64 entries), or -1 while that tile
   * is not uploaded. Packed verbatim into the ray-march UBO (floats 120..183).
   * All -1 on the 9-slot / single-tile paths (never read there — the WGSL walk
   * only consults level 2 when the target level reaches 2, which requires an
   * uploaded level-2 tile).
   */
  l2Slots: Float32Array;
  /** VOXEL-OCTREE-LOD — child-request lifecycle. "none" = single-tile path. */
  childPhase: "none" | "loading" | "done";
  /** VOXEL-OCTREE-LOD — internal per-child async states (8 entries). */
  childStates: VoxelChildTileState[];
  /**
   * NEW-VOXEL-OCTREE-DEEP-TRAVERSAL — internal per-level-2-tile async states
   * (64 entries). Only driven when {@link slotCount} is 73.
   */
  l2States: VoxelChildTileState[];
  /**
   * NEW-VOXEL-ATLAS-LRU-EVICT — number of atlas slots available to LEVEL-2
   * tiles: 0 (no deep atlas), 64 (static full atlas — every level-2 tile has
   * a reserved slot, the B17/B19 path), or 1..63 (dynamic LRU pool at slots
   * 9..slotCount-1 when the full set does not fit the capacity).
   */
  l2PoolSize: number;
  /** NEW-VOXEL-ATLAS-LRU-EVICT — true when the level-2 pool is LRU-managed. */
  l2Dynamic: boolean;
  /**
   * NEW-VOXEL-ATLAS-LRU-EVICT — free slot indices of the dynamic level-2 pool
   * (LIFO; seeded descending so pop() hands out 9, 10, ... first). Empty on
   * the static paths.
   */
  freeL2Slots: number[];
  /**
   * NEW-VOXEL-ATLAS-LRU-EVICT — monotonic counter incremented each frame
   * {@link tryUploadChildVoxelTiles} actively drives uploads. The LRU clock.
   */
  frameIndex: number;
  /** NEW-VOXEL-ATLAS-LRU-EVICT — total evictions performed. Probe diagnostic. */
  evictionCount: number;
  /**
   * NEW-VOXEL-ATLAS-LRU-EVICT — number of level-2 tiles demanded on the most
   * recent frame with a dynamic pool (per-tile SSE + frustum mask population
   * count). Probe diagnostic; 0 on the static paths.
   */
  lastL2DemandCount: number;
  /** Texture format chosen at root upload (children must match). */
  uploadFormat: GPUTextureFormat | null;
  /**
   * VOXEL-OCTREE-LOD — the LOD level the renderer packed into the UBO on the
   * most recent frame (0 = root, 1 = refined). Diagnostic — read by probes.
   */
  lastTargetLevel: number;
  /**
   * NEW-VOXEL-STREAMING-UPLOAD — the camera's demanded refinement level on
   * the most recent frame (SSE ladder capped by atlas CAPACITY, not by what
   * is uploaded). Drives which descendant levels {@link tryUploadChildVoxelTiles}
   * requests/uploads. Diagnostic — read by probes.
   */
  demandLevel: number;
}

export function createVoxelDataUploadState(): VoxelDataUploadState {
  const childStates: VoxelChildTileState[] = [];
  for (let i = 0; i < 8; i++) {
    childStates.push({ phase: "idle", content: null, lastDemandFrame: 0 });
  }
  const l2States: VoxelChildTileState[] = [];
  for (let i = 0; i < 64; i++) {
    l2States.push({ phase: "idle", content: null, lastDemandFrame: 0 });
  }
  return {
    phase: "idle",
    content: null,
    texture: null,
    view: null,
    convention: null,
    slotCount: 1,
    childSlots: new Float32Array([-1, -1, -1, -1, -1, -1, -1, -1]),
    l2Slots: new Float32Array(64).fill(-1),
    childPhase: "none",
    childStates,
    l2States,
    l2PoolSize: 0,
    l2Dynamic: false,
    freeL2Slots: [],
    frameIndex: 0,
    evictionCount: 0,
    lastL2DemandCount: 0,
    uploadFormat: null,
    lastTargetLevel: 0,
    demandLevel: 0,
  };
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
 * which case the caller keeps the placeholder — off-gate byte-identical).
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
    // No real provider → caller keeps the placeholder gradient (off-gate).
    return false;
  }

  if (state.phase === "idle") {
    const promise = provider.requestData({
      tileLevel: 0,
      tileX: 0,
      tileY: 0,
      tileZ: 0,
      keyframe: 0,
    });
    if (!promise) {
      // Request could not be scheduled this frame — retry next frame.
      return false;
    }
    state.phase = "requesting";
    promise
      .then((content) => {
        if (state.phase === "requesting") {
          state.content = content;
          state.phase = "processing";
        }
      })
      .catch(() => {
        state.phase = "failed";
      });
    return false;
  }

  if (state.phase === "requesting") {
    return false;
  }

  // phase === 'processing' — advance the glTF loader until content is ready.
  const content = state.content;
  if (!content) {
    state.phase = "failed";
    return false;
  }
  content.update(primitive, frameState);
  if (!content.ready) {
    return false;
  }

  const metadata = content.metadata;
  if (!metadata || metadata.length === 0 || !metadata[0]) {
    state.phase = "failed";
    return false;
  }

  const dims = provider.dimensions;
  // VOXEL-SHAPEUV-CONVENTION — for BOX shapes, size the texture with the
  // padded INPUT-orientation dimensions (mirrors `initFromProvider`'s
  // `_inputDimensions`): the metadata array is ordered X, then input-Y, then
  // input-Z INCLUDING padding voxels, and for glTF-sourced tiles the input Y/Z
  // axes are the 3D Tiles Z/flipped-Y axes. The renderer's ray-march applies
  // the matching shapeUv → inputCoordinate mapping (WebGL Octree.glsl).
  // NEW-VOXEL-ELLIPSOID-SHAPEUV — ELLIPSOID shapes carry the same padded
  // convention (dimensions are lon/lat/height cell counts; the extent Y/Z
  // swap for Y_UP metadata mirrors VoxelPrimitiveHelpers' inputDimensions
  // swap) but the Octree.glsl input-axis swap/flip is SHAPE_BOX-gated
  // upstream, so `yUpBox` stays false for ellipsoids.
  // NEW-VOXEL-CYLINDER-SHAPEUV — CYLINDER shapes carry the same padded
  // convention (dimensions are radius/angle/height cell counts); like
  // ELLIPSOID, `yUpBox` stays false (the swap/flip is SHAPE_BOX-gated).
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

  const rgba = expandToRGBA(metadata[0], voxelCount);

  const { format, float32 } = chooseFormat(device);

  // VOXEL-OCTREE-LOD — allocate a 9-slot Z-stacked atlas when the provider
  // has level-1 tiles to refine into AND the convention (BOX) sampling path is
  // active AND the atlas depth fits the device limit. Slot 0 = root; slots
  // 1..8 = level-1 children (uploaded asynchronously afterwards — see
  // tryUploadChildVoxelTiles). Single-level providers keep slotCount = 1 and
  // the exact historical texture layout (off-gate byte-identical).
  //
  // NEW-VOXEL-OCTREE-DEEP-TRAVERSAL — providers advertising a THIRD level get
  // the 73-slot atlas (adds the 64 level-2 tiles at slots 9..72) when it fits
  // the slot capacity.
  //
  // NEW-VOXEL-ATLAS-LRU-EVICT — slot capacity = the device's
  // `maxTextureDimension3D` divided by the per-tile depth, further capped by
  // the opt-in per-primitive `_webgpuVoxelAtlasMaxSlots` override (probe/test
  // hook + an app-level atlas memory bound; undefined by default → device
  // capacity only, the historical budget). When the full 73-slot set fits the
  // capacity the static tile→slot layout is used — byte-identical to the
  // B17/B19 path (the off-gate). When it does NOT fit but at least ONE spare
  // slot beyond the 9 static root+level-1 slots does (capacity >= 10), the
  // level-2 region becomes a dynamic LRU pool of (slotCount - 9) slots —
  // demand exceeding capacity streams tiles through the pool with eviction
  // instead of clamping traversal to depth 1. Capacity < 10 keeps the 9-slot
  // depth-1 atlas exactly as before.
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
  // NEW-VOXEL-ELLIPSOID-SHAPEUV — the multi-level atlas stays BOX-gated (it
  // was previously implied by `convention !== null`, which was box-only):
  // non-box shapes remain root-only until their octree-refinement increment
  // is verified, preserving the NEW-VOXEL-OCTREE-DEEP-TRAVERSAL off-gate.
  const multiLevel =
    isBox && convention !== null && availableLevels >= 2 && slotCap >= 9;
  const wantDeep = multiLevel && availableLevels >= 3;
  const fullDeep = wantDeep && slotCap >= 73;
  const partialDeep = wantDeep && !fullDeep && slotCap >= 10;
  const deepLevel = fullDeep || partialDeep;
  const slotCount = fullDeep ? 73 : partialDeep ? slotCap : multiLevel ? 9 : 1;

  const texture = device.createTexture({
    label: deepLevel
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

  state.texture = texture;
  state.view = texture.createView();
  state.convention = convention;
  state.slotCount = slotCount;
  state.uploadFormat = format;
  state.childPhase = multiLevel ? "loading" : "none";
  // NEW-VOXEL-ATLAS-LRU-EVICT — level-2 pool bookkeeping. Static full atlas
  // keeps an empty free list (slots are pre-assigned baseSlot + i); the
  // dynamic pool seeds its free list descending so pop() hands out ascending
  // slot numbers (9, 10, ...) — deterministic for probes.
  state.l2PoolSize = fullDeep ? 64 : partialDeep ? slotCount - 9 : 0;
  state.l2Dynamic = partialDeep;
  state.freeL2Slots.length = 0;
  if (partialDeep) {
    for (let s = 9 + state.l2PoolSize - 1; s >= 9; s--) {
      state.freeL2Slots.push(s);
    }
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
      const promise = provider.requestData({
        tileLevel: level,
        tileX: i % edge,
        tileY: Math.floor(i / edge) % edge,
        tileZ: Math.floor(i / (edge * edge)),
        keyframe: 0,
      });
      if (!promise) {
        // Could not be scheduled this frame — retry next frame.
        continue;
      }
      child.phase = "requesting";
      promise
        .then((content) => {
          if (child.phase === "requesting") {
            child.content = content;
            child.phase = "processing";
          }
        })
        .catch(() => {
          // Tile not available (or failed) — ancestor fallback for this region.
          child.phase = "failed";
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
    content.update(primitive, frameState);
    if (!content.ready) {
      continue;
    }

    const metadata = content.metadata;
    if (!metadata || metadata.length === 0 || !metadata[0]) {
      child.phase = "failed";
      settled++;
      continue;
    }

    const rgba = expandToRGBA(metadata[0], voxelCount);
    const data: ArrayBufferView = float32 ? rgba : toHalfFloat(rgba);
    const slot = baseSlot + i;
    device.queue.writeTexture(
      { texture: state.texture!, origin: { x: 0, y: 0, z: slot * depth } },
      data,
      { bytesPerRow: width * bytesPerTexel, rowsPerImage: height },
      { width, height, depthOrArrayLayers: depth },
    );
    slots[i] = slot;
    child.content = null;
    child.phase = "done";
    settled++;
  }

  return settled;
}

/**
 * VOXEL-OCTREE-LOD — drive the asynchronous descendant-tile uploads into
 * atlas slots 1..8 (level 1) and — on the 73-slot deep atlas
 * (NEW-VOXEL-OCTREE-DEEP-TRAVERSAL) — slots 9..72 (level 2). Call once per
 * frame from the voxel renderer's update AFTER the root has uploaded
 * (`state.phase === "done"`); no-ops for single-level providers
 * (`childPhase === "none"`) and once every tile has settled.
 *
 * NEW-VOXEL-STREAMING-UPLOAD — uploads are DEMAND-DRIVEN: `demandLevel` is
 * the camera's SSE-ladder refinement level this frame (capped by atlas
 * capacity, NOT by uploaded tiles — see the renderer's
 * `computeVoxelDemandLevel`). Level-1 tiles are only requested/uploaded while
 * `demandLevel >= 1`, level-2 tiles while `demandLevel >= 2` — the upstream
 * VoxelTraversal megatexture-add analogue (tiles enter the megatexture only
 * when the traversal's SSE test visits them). When demand recedes mid-stream,
 * in-flight requests simply pause at their current phase and resume when the
 * camera demands that level again; uploaded slots stay resident on the
 * static full atlas. `childPhase` flips to "done" only when EVERY tile the
 * atlas has capacity for has settled, so a scene whose camera demands the
 * deepest level converges to the exact eager-upload steady state.
 *
 * NEW-VOXEL-ATLAS-LRU-EVICT — when the level-2 pool is DYNAMIC
 * (`state.l2Dynamic`, capacity < 73), the level-2 set is driven by the
 * per-tile demand mask (`l2DemandMask`, renderer-computed SSE + frustum gate)
 * through {@link driveDynamicL2Uploads} instead: demanded tiles take free
 * pool slots or LRU-evict a stale resident; residency follows the camera for
 * the life of the primitive, so `childPhase` never flips to "done" on this
 * path. Static paths ignore the mask entirely — byte-identical B19 flow.
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

  // NEW-VOXEL-ATLAS-LRU-EVICT — advance the LRU clock only on frames that
  // actively drive uploads (same guard set as the drives below).
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
    // NEW-VOXEL-ATLAS-LRU-EVICT — dynamic pool: residency follows demand for
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

  if (settled === total) {
    state.childPhase = "done";
  }
}

/**
 * NEW-VOXEL-ATLAS-LRU-EVICT — evict the least-recently-demanded RESIDENT
 * level-2 tile and return its freed slot, or -1 when every resident is
 * demanded on the current frame (nothing evictable — the caller waits).
 * The victim resets to `idle` so a later demand re-requests + re-uploads it
 * through the normal machine (fresh, correct cell values). Ties break to the
 * lowest tile index — deterministic for probes.
 */
function evictLruL2Slot(state: VoxelDataUploadState): number {
  let victim = -1;
  let oldest = Infinity;
  for (let i = 0; i < 64; i++) {
    if (state.l2Slots[i] < 0) {
      continue;
    }
    const tile = state.l2States[i];
    if (tile.lastDemandFrame >= state.frameIndex) {
      // Demanded this frame — protected.
      continue;
    }
    if (tile.lastDemandFrame < oldest) {
      oldest = tile.lastDemandFrame;
      victim = i;
    }
  }
  if (victim < 0) {
    return -1;
  }
  const slot = state.l2Slots[victim];
  state.l2Slots[victim] = -1;
  const tile = state.l2States[victim];
  tile.phase = "idle";
  tile.content = null;
  state.evictionCount++;
  return slot;
}

/**
 * NEW-VOXEL-ATLAS-LRU-EVICT — drive the level-2 uploads against the DYNAMIC
 * slot pool. Per tile: stamp `lastDemandFrame` when demanded (per-tile SSE +
 * frustum mask from the renderer), advance the request → process machine only
 * for demanded tiles, and on ready-to-write allocate a slot from the free
 * list — or LRU-evict a stale resident when the list is empty. A pool fully
 * held by tiles demanded THIS frame yields no slot: the upload waits (no
 * overflow, no same-frame thrash) and retries when demand shifts. Resident
 * tiles that fall out of demand stay resident until a demanded tile needs
 * their slot. Failed tiles never occupy a slot and are not retried (the WGSL
 * walk falls back to the level-1 ancestor for that region — same semantics
 * as the static path).
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

  let demandCount = 0;
  for (let i = 0; i < 64; i++) {
    const tile = state.l2States[i];
    const demanded =
      demandLevel >= 2 && l2DemandMask !== null && l2DemandMask[i] !== 0;
    if (demanded) {
      tile.lastDemandFrame = state.frameIndex;
      demandCount++;
    } else {
      // Not demanded: residents stay until evicted; in-flight requests pause
      // at their current phase and resume under future demand.
      continue;
    }

    if (tile.phase === "done" || tile.phase === "failed") {
      continue;
    }

    if (tile.phase === "idle") {
      const promise = provider.requestData({
        tileLevel: 2,
        tileX: i % 4,
        tileY: Math.floor(i / 4) % 4,
        tileZ: Math.floor(i / 16),
        keyframe: 0,
      });
      if (!promise) {
        continue;
      }
      tile.phase = "requesting";
      promise
        .then((content) => {
          if (tile.phase === "requesting") {
            tile.content = content;
            tile.phase = "processing";
          }
        })
        .catch(() => {
          tile.phase = "failed";
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
    content.update(primitive, frameState);
    if (!content.ready) {
      continue;
    }
    const metadata = content.metadata;
    if (!metadata || metadata.length === 0 || !metadata[0]) {
      tile.phase = "failed";
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

    const rgba = expandToRGBA(metadata[0], voxelCount);
    const data: ArrayBufferView = float32 ? rgba : toHalfFloat(rgba);
    device.queue.writeTexture(
      { texture: state.texture!, origin: { x: 0, y: 0, z: slot * depth } },
      data,
      { bytesPerRow: width * bytesPerTexel, rowsPerImage: height },
      { width, height, depthOrArrayLayers: depth },
    );
    state.l2Slots[i] = slot;
    tile.content = null;
    tile.phase = "done";
  }

  state.lastL2DemandCount = demandCount;
}
