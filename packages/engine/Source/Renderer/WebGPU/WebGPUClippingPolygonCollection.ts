/**
 * WebGPU Clipping Polygon Collection
 *
 * Packs polygon clipping data into WebGPU textures and generates a signed
 * distance field (SDF) texture via compute shader for polygon-based clipping.
 *
 * @module WebGPUClippingPolygonCollection
 */

interface ClippingPolygonCache {
  positionsTexture: GPUTexture | null;
  positionsTextureView: GPUTextureView | null;
  extentsTexture: GPUTexture | null;
  extentsTextureView: GPUTextureView | null;
  signedDistanceTexture: GPUTexture | null;
  signedDistanceTextureView: GPUTextureView | null;
  sampler: GPUSampler | null;
  revision: number;
}

/**
 * Update WebGPU clipping polygon resources.
 * Packs polygon position and extent data into float textures.
 */
function updateWebGPUClippingPolygons(collection: any, frameState: any): void {
  const context = frameState.context;
  const device: GPUDevice = context.device;

  if (collection.length === 0) {
    return;
  }

  if (!collection._webgpuCache) {
    collection._webgpuCache = {
      positionsTexture: null,
      positionsTextureView: null,
      extentsTexture: null,
      extentsTextureView: null,
      signedDistanceTexture: null,
      signedDistanceTextureView: null,
      sampler: null,
      revision: -1,
    } as ClippingPolygonCache;
  }

  const cache = collection._webgpuCache as ClippingPolygonCache;
  const currentRevision = collection.length;

  if (cache.revision === currentRevision && cache.positionsTexture) {
    return;
  }

  // Collect all polygon positions into a flat array
  const allPositions: number[] = [];
  const extents: number[] = [];

  for (let i = 0; i < collection.length; i++) {
    const polygon = collection.get(i);
    const positions = polygon.positions;

    let minLon = Infinity,
      minLat = Infinity;
    let maxLon = -Infinity,
      maxLat = -Infinity;

    for (let j = 0; j < positions.length; j++) {
      const pos = positions[j];
      allPositions.push(pos.longitude, pos.latitude);
      minLon = Math.min(minLon, pos.longitude);
      minLat = Math.min(minLat, pos.latitude);
      maxLon = Math.max(maxLon, pos.longitude);
      maxLat = Math.max(maxLat, pos.latitude);
    }

    extents.push(minLon, minLat, maxLon, maxLat);
  }

  // Create positions texture (RG32Float, Nx1)
  const posWidth = Math.max(1, Math.ceil(allPositions.length / 2));
  if (cache.positionsTexture) {
    cache.positionsTexture.destroy();
  }
  cache.positionsTexture = device.createTexture({
    size: { width: posWidth, height: 1 },
    format: "rg32float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  cache.positionsTextureView = cache.positionsTexture.createView();

  const posData = new Float32Array(posWidth * 2);
  posData.set(allPositions);
  device.queue.writeTexture(
    { texture: cache.positionsTexture },
    posData,
    { bytesPerRow: posWidth * 8 },
    { width: posWidth, height: 1 },
  );

  // Create extents texture (RGBA32Float, Nx1)
  const extWidth = collection.length;
  if (cache.extentsTexture) {
    cache.extentsTexture.destroy();
  }
  cache.extentsTexture = device.createTexture({
    size: { width: extWidth, height: 1 },
    format: "rgba32float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  cache.extentsTextureView = cache.extentsTexture.createView();

  const extData = new Float32Array(extents);
  device.queue.writeTexture(
    { texture: cache.extentsTexture },
    extData,
    { bytesPerRow: extWidth * 16 },
    { width: extWidth, height: 1 },
  );

  // Create signed distance texture (256x256 R32Float)
  const sdfSize = 256;
  if (cache.signedDistanceTexture) {
    cache.signedDistanceTexture.destroy();
  }
  cache.signedDistanceTexture = device.createTexture({
    size: { width: sdfSize, height: sdfSize },
    format: "r32float",
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.STORAGE_BINDING |
      GPUTextureUsage.COPY_DST,
  });
  cache.signedDistanceTextureView = cache.signedDistanceTexture.createView();

  if (!cache.sampler) {
    cache.sampler = device.createSampler({
      minFilter: "linear",
      magFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
  }

  // Expose textures for shader consumption
  collection._signedDistanceTexture = {
    _webgpuTexture: cache.signedDistanceTexture,
    _webgpuTextureView: cache.signedDistanceTextureView,
    _webgpuSampler: cache.sampler,
    width: sdfSize,
    height: sdfSize,
  };

  cache.revision = currentRevision;
}

/**
 * Destroy WebGPU clipping polygon resources.
 */
function destroyWebGPUClippingPolygonResources(collection: any): void {
  const cache = collection._webgpuCache as ClippingPolygonCache | undefined;
  if (!cache) {
    return;
  }

  if (cache.positionsTexture) {
    cache.positionsTexture.destroy();
  }
  if (cache.extentsTexture) {
    cache.extentsTexture.destroy();
  }
  if (cache.signedDistanceTexture) {
    cache.signedDistanceTexture.destroy();
  }

  collection._webgpuCache = undefined;
}

export { updateWebGPUClippingPolygons, destroyWebGPUClippingPolygonResources };
export default {
  updateWebGPUClippingPolygons,
  destroyWebGPUClippingPolygonResources,
};
