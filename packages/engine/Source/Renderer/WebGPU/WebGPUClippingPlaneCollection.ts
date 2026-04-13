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
function updateWebGPUClippingPlanes(collection: any, frameState: CesiumFrameState): void {
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

  // Check if we need to update
  const currentRevision = collection._unionClippingRegions
    ? collection._unionClippingRegions
    : collection.length;

  if (cache.revision === currentRevision && cache.texture) {
    return;
  }

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

  // Pack plane data: normal(xyz) + distance(w)
  const data = new Float32Array(planeCount * 4);
  for (let i = 0; i < planeCount; i++) {
    const plane = collection.get(i);
    const offset = i * 4;
    data[offset] = plane.normal.x;
    data[offset + 1] = plane.normal.y;
    data[offset + 2] = plane.normal.z;
    data[offset + 3] = plane.distance;
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
function destroyWebGPUClippingPlaneResources(collection: any): void {
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
