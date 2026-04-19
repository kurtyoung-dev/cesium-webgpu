/**
 * WebGPU Clipping Plane Collection
 *
 * Packs clipping plane data into a WebGPU texture for use in fragment shaders.
 * Each clipping plane is a vec4 (normal.xyz, distance) packed into a float texture.
 *
 * Uses clip-distances device feature when available for hardware-accelerated clipping.
 *
 * @module WebGPUClippingPlaneCollection
 */

/** Minimal interface for the upstream ClippingPlaneCollection. */
interface ClippingPlaneCollectionLike {
  length: number;
  get(index: number): {
    normal: { x: number; y: number; z: number };
    distance: number;
  };
  _unionClippingRegions?: number | boolean;
  _webgpuCache?: ClippingPlaneCache;
  _clippingPlanesTexture?: CesiumOpaqueTexture;
}

interface ClippingPlaneCache {
  texture: GPUTexture | null;
  textureView: GPUTextureView | null;
  sampler: GPUSampler | null;
  textureWidth: number;
  textureHeight: number;
  revision: number;
}

/**
 * Update WebGPU clipping plane resources.
 * Packs clipping plane data into a RGBA32Float texture.
 */
function updateWebGPUClippingPlanes(
  collection: ClippingPlaneCollectionLike,
  frameState: CesiumFrameState,
): void {
  const context = frameState.context;
  const device: GPUDevice = context.device;

  if (collection.length === 0) {
    return;
  }

  if (!collection._webgpuCache) {
    collection._webgpuCache = {
      texture: null,
      textureView: null,
      sampler: null,
      textureWidth: 0,
      textureHeight: 0,
      revision: -1,
    } as ClippingPlaneCache;
  }

  const cache = collection._webgpuCache as ClippingPlaneCache;

  // The revision cache is used ONLY to gate texture (re)allocation. The
  // per-frame upload below always runs because the plane data is now
  // eye-space — it depends on the view matrix which changes every frame
  // with camera motion. See C-P6 fix rationale below.
  const currentRevision: number = collection._unionClippingRegions
    ? Number(collection._unionClippingRegions)
    : collection.length;
  // (no early-return; fall through to upload every frame)

  const planeCount = collection.length;
  // Pack planes into a Nx1 texture (each plane = 1 texel with RGBA = normal.xyz + distance)
  const width = planeCount;
  const height = 1;

  // Destroy old texture if size changed
  if (
    cache.texture &&
    (cache.textureWidth !== width || cache.textureHeight !== height)
  ) {
    cache.texture.destroy();
    cache.texture = null;
  }

  // Create texture if needed
  if (!cache.texture) {
    cache.texture = device.createTexture({
      size: { width, height },
      format: "rgba32float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    cache.textureView = cache.texture.createView();
    cache.textureWidth = width;
    cache.textureHeight = height;
  }

  if (!cache.sampler) {
    cache.sampler = device.createSampler({
      minFilter: "nearest",
      magFilter: "nearest",
    });
  }

  // Pack plane data transformed into EYE SPACE so the fragment test
  // `dot(eyePos, plane.xyz) + plane.w` matches the frame of eyePos.
  // Uploading raw world-space `(normal, distance)` while the shader
  // samples eyePos in eye-space produces catastrophic cancellation at
  // Earth ECEF scale — `distance` has components of order 1e7, eyePos
  // is near 0, and the test collapses to `sign(distance)` (clips
  // everything or nothing). See C-P6 in the 2026-04-16 per-feature review.
  //
  // Plane transform rule: a plane `(n, d)` in frame A becomes
  // `(view^-T * (n, d))` in frame B where B = view * A. For the
  // view matrix specifically, `view^-T * (n_world, d_world)` gives
  // `(n_eye, d_eye)`. Cesium's `Matrix4.inverseTranspose()` does this.
  //
  // We upload EVERY frame because the view matrix changes with the
  // camera; the revision check only bounds the texture-reallocation
  // path. Uploads are tiny (≤8 planes × 16 bytes = 128 bytes) so this
  // is negligible bandwidth.
  const uniformState = frameState.context.uniformState;
  const view = uniformState.view;
  const invViewT = uniformState.inverseViewTranspose;
  const data = new Float32Array(planeCount * 4);
  for (let i = 0; i < planeCount; i++) {
    const plane = collection.get(i);
    const nx = plane.normal.x,
      ny = plane.normal.y,
      nz = plane.normal.z;
    const nw = plane.distance;
    let ex: number, ey: number, ez: number, ew: number;
    if (invViewT) {
      // Column-major mat4: entries [col*4 + row]
      ex =
        invViewT[0] * nx +
        invViewT[4] * ny +
        invViewT[8] * nz +
        invViewT[12] * nw;
      ey =
        invViewT[1] * nx +
        invViewT[5] * ny +
        invViewT[9] * nz +
        invViewT[13] * nw;
      ez =
        invViewT[2] * nx +
        invViewT[6] * ny +
        invViewT[10] * nz +
        invViewT[14] * nw;
      ew =
        invViewT[3] * nx +
        invViewT[7] * ny +
        invViewT[11] * nz +
        invViewT[15] * nw;
    } else if (view) {
      // Fallback: rigid view matrix ⇒ view^-T of the normal is
      // `view.xyz * (nx, ny, nz)` (rotation part), and the translated
      // distance is `d - dot(n_eye, view.translation_eye)`.
      // This path is rarely hit because CesiumJS always maintains
      // inverseViewTranspose on the UniformState.
      const rx = view[0] * nx + view[4] * ny + view[8] * nz;
      const ry = view[1] * nx + view[5] * ny + view[9] * nz;
      const rz = view[2] * nx + view[6] * ny + view[10] * nz;
      const tx = view[12],
        ty = view[13],
        tz = view[14];
      ex = rx;
      ey = ry;
      ez = rz;
      ew = nw - (rx * tx + ry * ty + rz * tz);
    } else {
      ex = nx;
      ey = ny;
      ez = nz;
      ew = nw;
    }
    const offset = i * 4;
    data[offset] = ex;
    data[offset + 1] = ey;
    data[offset + 2] = ez;
    data[offset + 3] = ew;
  }

  device.queue.writeTexture(
    { texture: cache.texture },
    data,
    { bytesPerRow: planeCount * 16 },
    { width, height },
  );

  // Expose texture for shader consumption
  collection._clippingPlanesTexture = {
    _webgpuTexture: cache.texture,
    _webgpuTextureView: cache.textureView,
    _webgpuSampler: cache.sampler,
    width,
    height,
  };

  cache.revision = currentRevision;
}

/**
 * Destroy WebGPU clipping plane resources.
 */
function destroyWebGPUClippingPlaneResources(
  collection: CesiumObjectWithWebGPUCache,
): void {
  const cache = collection._webgpuCache as ClippingPlaneCache | undefined;
  if (!cache) {
    return;
  }

  if (cache.texture) {
    cache.texture.destroy();
  }

  collection._webgpuCache = undefined;
}

export { updateWebGPUClippingPlanes, destroyWebGPUClippingPlaneResources };
export default {
  updateWebGPUClippingPlanes,
  destroyWebGPUClippingPlaneResources,
};
