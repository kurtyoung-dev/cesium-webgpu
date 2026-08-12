export interface CloudShadowBindGroupCacheEntry {
  layout: GPUBindGroupLayout;
  cloudUniformBuffer: GPUBuffer;
  weatherView: GPUTextureView;
  weatherSampler: GPUSampler;
  shapeView: GPUTextureView;
  detailView: GPUTextureView;
  noiseSampler: GPUSampler;
  shadowUniformBuffer: GPUBuffer;
  shadowUniformOffset: number;
  shadowUniformSize: number;
  bindGroup: GPUBindGroup;
}

export type CloudShadowBindGroupCache = [
  CloudShadowBindGroupCacheEntry | null,
  CloudShadowBindGroupCacheEntry | null,
  CloudShadowBindGroupCacheEntry | null,
  CloudShadowBindGroupCacheEntry | null,
];

export function createCloudShadowBindGroupCache(): CloudShadowBindGroupCache {
  return [null, null, null, null];
}

export function getOrCreateCloudShadowBindGroup(
  device: GPUDevice,
  cache: CloudShadowBindGroupCache,
  slot: number,
  layout: GPUBindGroupLayout,
  cloudUniformBuffer: GPUBuffer,
  weatherView: GPUTextureView,
  weatherSampler: GPUSampler,
  shapeView: GPUTextureView,
  detailView: GPUTextureView,
  noiseSampler: GPUSampler,
  shadowUniformBuffer: GPUBuffer,
  shadowUniformOffset: number,
  shadowUniformSize: number,
): GPUBindGroup {
  const entry = cache[slot];
  if (
    entry?.layout === layout &&
    entry.cloudUniformBuffer === cloudUniformBuffer &&
    entry.weatherView === weatherView &&
    entry.weatherSampler === weatherSampler &&
    entry.shapeView === shapeView &&
    entry.detailView === detailView &&
    entry.noiseSampler === noiseSampler &&
    entry.shadowUniformBuffer === shadowUniformBuffer &&
    entry.shadowUniformOffset === shadowUniformOffset &&
    entry.shadowUniformSize === shadowUniformSize
  ) {
    return entry.bindGroup;
  }

  const bindGroup = device.createBindGroup({
    layout,
    entries: [
      { binding: 3, resource: { buffer: cloudUniformBuffer } },
      { binding: 4, resource: weatherView },
      { binding: 5, resource: weatherSampler },
      { binding: 6, resource: shapeView },
      { binding: 7, resource: detailView },
      { binding: 8, resource: noiseSampler },
      {
        binding: 13,
        resource: {
          buffer: shadowUniformBuffer,
          offset: shadowUniformOffset,
          size: shadowUniformSize,
        },
      },
    ],
  });
  cache[slot] = {
    layout,
    cloudUniformBuffer,
    weatherView,
    weatherSampler,
    shapeView,
    detailView,
    noiseSampler,
    shadowUniformBuffer,
    shadowUniformOffset,
    shadowUniformSize,
    bindGroup,
  };
  return bindGroup;
}
