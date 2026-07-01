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
 * What is NOT done here (honest partial — separate increments):
 *   - Octree / multi-tile LOD data path (needs the traversal + a real
 *     megatexture atlas + octree leaf-node lookup texture).
 *   - Non-VEC4 properties (VEC3/VEC2/scalar) — this increment uploads the first
 *     property expanded to RGBA. Missing channels default to 0, alpha to 1.
 *   - Padding voxels (paddingBefore/paddingAfter) — root tile is uploaded at
 *     its raw `dimensions` with no border.
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
}

export function createVoxelDataUploadState(): VoxelDataUploadState {
  return {
    phase: "idle",
    content: null,
    texture: null,
    view: null,
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
  const width = Math.max(1, Math.floor(dims.x));
  const height = Math.max(1, Math.floor(dims.y));
  const depth = Math.max(1, Math.floor(dims.z));
  const voxelCount = width * height * depth;

  const rgba = expandToRGBA(metadata[0], voxelCount);

  const { format, float32 } = chooseFormat(device);
  const texture = device.createTexture({
    label: "Voxel real-data 3D texture (root tile)",
    size: { width, height, depthOrArrayLayers: depth },
    format,
    dimension: "3d",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });

  const bytesPerTexel = float32 ? 16 : 8;
  const data: ArrayBufferView = float32 ? rgba : toHalfFloat(rgba);
  device.queue.writeTexture(
    { texture },
    data,
    { bytesPerRow: width * bytesPerTexel, rowsPerImage: height },
    { width, height, depthOrArrayLayers: depth },
  );

  state.texture = texture;
  state.view = texture.createView();
  state.phase = "done";
  return true;
}
