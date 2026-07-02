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
 * advertises `availableLevels >= 2` and the shape is a BOX (the convention
 * path), the destination texture is allocated as a 9-slot 3D ATLAS stacked
 * along Z: slot 0 = root tile, slots 1..8 = the eight level-1 child tiles
 * (childIndex = x + 2y + 4z in the Z-up shape frame). Child tiles are
 * requested + uploaded asynchronously after the root; a child that is
 * unavailable / fails keeps `childSlots[i] = -1` and the WGSL march falls back
 * to sampling the ROOT for that octant — the same semantics as Octree.glsl's
 * OCTREE_FLAG_PACKED_LEAF_FROM_PARENT leaf, specialised to depth 1.
 *
 * What is NOT done here (honest partial — separate increments):
 *   - Octree traversal DEEPER than level 1 (needs a real megatexture slot
 *     allocator + the internal-node lookup texture from VoxelTraversal.js).
 *   - LOD refinement for non-BOX shapes (cylinder/ellipsoid stay root-only).
 *   - Non-VEC4 properties (VEC3/VEC2/scalar) — this increment uploads the first
 *     property expanded to RGBA. Missing channels default to 0, alpha to 1.
 *   - Per-cell pickVoxel against refined tiles (pick marches the ROOT slab).
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
   * math in the WGSL); 9 = root (slot 0) + eight level-1 children (slots 1..8).
   */
  slotCount: number;
  /**
   * VOXEL-OCTREE-LOD — atlas slot per level-1 child octant (childIndex =
   * x + 2y + 4z, Z-up shape frame), or -1 while the child is not uploaded.
   * Packed verbatim into the ray-march UBO (floats 108..115).
   */
  childSlots: Float32Array;
  /** VOXEL-OCTREE-LOD — child-request lifecycle. "none" = single-tile path. */
  childPhase: "none" | "loading" | "done";
  /** VOXEL-OCTREE-LOD — internal per-child async states (8 entries). */
  childStates: VoxelChildTileState[];
  /** Texture format chosen at root upload (children must match). */
  uploadFormat: GPUTextureFormat | null;
  /**
   * VOXEL-OCTREE-LOD — the LOD level the renderer packed into the UBO on the
   * most recent frame (0 = root, 1 = refined). Diagnostic — read by probes.
   */
  lastTargetLevel: number;
}

export function createVoxelDataUploadState(): VoxelDataUploadState {
  const childStates: VoxelChildTileState[] = [];
  for (let i = 0; i < 8; i++) {
    childStates.push({ phase: "idle", content: null });
  }
  return {
    phase: "idle",
    content: null,
    texture: null,
    view: null,
    convention: null,
    slotCount: 1,
    childSlots: new Float32Array([-1, -1, -1, -1, -1, -1, -1, -1]),
    childPhase: "none",
    childStates,
    uploadFormat: null,
    lastTargetLevel: 0,
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
  // Non-box shapes keep the legacy unpadded Z-up extents + direct sampling.
  const isBox = provider.shape === VoxelShapeType.BOX;
  let width = Math.max(1, Math.floor(dims.x));
  let height = Math.max(1, Math.floor(dims.y));
  let depth = Math.max(1, Math.floor(dims.z));
  let convention: VoxelSampleConvention | null = null;
  if (isBox) {
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
      yUpBox: yUp,
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
  const availableLevels = provider.availableLevels ?? 1;
  const maxDim3D = device.limits?.maxTextureDimension3D ?? 2048;
  const multiLevel =
    convention !== null && availableLevels >= 2 && depth * 9 <= maxDim3D;
  const slotCount = multiLevel ? 9 : 1;

  const texture = device.createTexture({
    label: multiLevel
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
  state.phase = "done";
  return true;
}

/**
 * VOXEL-OCTREE-LOD — drive the asynchronous level-1 child-tile uploads into
 * atlas slots 1..8. Call once per frame from the voxel renderer's update AFTER
 * the root has uploaded (`state.phase === "done"`); no-ops for single-level
 * providers (`childPhase === "none"`) and once every child has settled.
 *
 * Child octant i maps to tile (x = i & 1, y = (i >> 1) & 1, z = (i >> 2) & 1)
 * at tileLevel 1 — the Z-up shape-frame octant convention (`childIndex =
 * z * 4 + y * 2 + x`, matching Octree.glsl's getOctreeChildData). A child that
 * is unavailable (provider rejects) or fails to decode keeps
 * `childSlots[i] = -1`; the WGSL march then samples the ROOT for that octant.
 */
export function tryUploadChildVoxelTiles(
  device: GPUDevice,
  primitive: unknown,
  frameState: CesiumFrameState,
  state: VoxelDataUploadState,
): void {
  if (
    state.phase !== "done" ||
    state.childPhase !== "loading" ||
    !state.texture ||
    !state.convention ||
    state.slotCount < 9
  ) {
    return;
  }

  const provider = getProvider(primitive);
  if (!provider) {
    return;
  }

  const { inputDimensions } = state.convention;
  const width = inputDimensions.x;
  const height = inputDimensions.y;
  const depth = inputDimensions.z;
  const voxelCount = width * height * depth;
  const float32 = state.uploadFormat === "rgba32float";
  const bytesPerTexel = float32 ? 16 : 8;

  let settled = 0;
  for (let i = 0; i < 8; i++) {
    const child = state.childStates[i];
    if (child.phase === "done" || child.phase === "failed") {
      settled++;
      continue;
    }

    if (child.phase === "idle") {
      const promise = provider.requestData({
        tileLevel: 1,
        tileX: i & 1,
        tileY: (i >> 1) & 1,
        tileZ: (i >> 2) & 1,
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
          // Tile not available (or failed) — root fallback for this octant.
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
    const slot = 1 + i;
    device.queue.writeTexture(
      { texture: state.texture, origin: { x: 0, y: 0, z: slot * depth } },
      data,
      { bytesPerRow: width * bytesPerTexel, rowsPerImage: height },
      { width, height, depthOrArrayLayers: depth },
    );
    state.childSlots[i] = slot;
    child.content = null;
    child.phase = "done";
    settled++;
  }

  if (settled === 8) {
    state.childPhase = "done";
  }
}
