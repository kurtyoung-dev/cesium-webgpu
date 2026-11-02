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
  materialFlowBuffer?: GPUBuffer;
  occupancyView?: GPUTextureView;
  occupancyUniformBuffer?: GPUBuffer;
  densityCacheView?: GPUTextureView;
  densityCacheUniform?: GPUBuffer;
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
  materialFlowBuffer?: GPUBuffer,
  occupancyView?: GPUTextureView,
  occupancyUniformBuffer?: GPUBuffer,
  densityCacheView?: GPUTextureView,
  densityCacheUniform?: GPUBuffer,
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
    entry.shadowUniformSize === shadowUniformSize &&
    entry.materialFlowBuffer === materialFlowBuffer &&
    entry.occupancyView === occupancyView &&
    entry.occupancyUniformBuffer === occupancyUniformBuffer &&
    entry.densityCacheView === densityCacheView &&
    entry.densityCacheUniform === densityCacheUniform
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
      ...(materialFlowBuffer
        ? [{ binding: 15, resource: { buffer: materialFlowBuffer } }]
        : []),
      ...(occupancyView && occupancyUniformBuffer
        ? [
            { binding: 17, resource: occupancyView },
            {
              binding: 18,
              resource: { buffer: occupancyUniformBuffer, size: 32 },
            },
          ]
        : []),
      ...(densityCacheView && densityCacheUniform
        ? [
            { binding: 20, resource: densityCacheView },
            {
              binding: 21,
              resource: { buffer: densityCacheUniform, size: 48 },
            },
          ]
        : []),
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
    materialFlowBuffer,
    occupancyView,
    occupancyUniformBuffer,
    densityCacheView,
    densityCacheUniform,
    bindGroup,
  };
  return bindGroup;
}
