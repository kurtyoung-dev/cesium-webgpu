/**
 * WebGPU Clipping Polygon Collection
 *
 * Packs polygon clipping data into WebGPU textures and generates a signed
 * distance field (SDF) texture via compute shader for polygon-based clipping.
 *
 * @module WebGPUClippingPolygonCollection
 */

/** Minimal interface for the upstream ClippingPolygonCollection. */
interface ClippingPolygonCollectionLike {
  length: number;
  get(index: number): { positions: { longitude: number; latitude: number }[] };
  _webgpuCache?: ClippingPolygonCache;
  _clippingPolygonsTexture?: CesiumOpaqueTexture;
  _signedDistanceTexture?: CesiumOpaqueTexture;
}

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
function updateWebGPUClippingPolygons(
  collection: ClippingPolygonCollectionLike,
  frameState: CesiumFrameState,
): void {
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

  // Dispatch compute shader to generate the SDF
  computePolygonSDF(device, cache, allPositions, collection.length, posWidth);

  cache.revision = currentRevision;
}

// ---- SDF compute pipeline ----

// Module-level pipeline cache (shared across all collections on same device)
let _sdfComputePipeline: GPUComputePipeline | null = null;
let _sdfBindGroupLayout: GPUBindGroupLayout | null = null;
let _sdfPipelineDevice: GPUDevice | null = null;

/**
 * Dispatch the PolygonSignedDistance.wgsl compute shader to fill the SDF texture.
 */
function computePolygonSDF(
  device: GPUDevice,
  cache: ClippingPolygonCache,
  allPositions: number[],
  polygonCount: number,
  positionsWidth: number,
): void {
  if (
    !cache.positionsTexture ||
    !cache.extentsTexture ||
    !cache.signedDistanceTexture
  ) {
    return;
  }

  // Lazily create the compute pipeline
  if (!_sdfComputePipeline || _sdfPipelineDevice !== device) {
    _sdfPipelineDevice = device;

    _sdfBindGroupLayout = device.createBindGroupLayout({
      label: "PolygonSDF-BindGroupLayout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: "unfilterable-float" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: "unfilterable-float" },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: "write-only", format: "r32float" },
        },
      ],
    });

    // Inline the WGSL source (matches PolygonSignedDistance.wgsl)
    const shaderModule = device.createShaderModule({
      label: "PolygonSDF-Compute",
      code: POLYGON_SDF_WGSL,
    });

    _sdfComputePipeline = device.createComputePipeline({
      label: "PolygonSDF-Pipeline",
      layout: device.createPipelineLayout({
        bindGroupLayouts: [_sdfBindGroupLayout],
      }),
      compute: { module: shaderModule, entryPoint: "main" },
    });
  }

  // Create uniform buffer: { polygonsLength, extentsLength, positionsWidth, pad }
  const uniformData = new Uint32Array([
    polygonCount,
    polygonCount, // extentsLength == polygonsLength (one extent per polygon)
    positionsWidth,
    0, // padding
  ]);
  const uniformBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(uniformBuffer, 0, uniformData);

  // Create bind group
  const bindGroup = device.createBindGroup({
    layout: _sdfBindGroupLayout!,
    entries: [
      { binding: 0, resource: { buffer: uniformBuffer } },
      { binding: 1, resource: cache.positionsTextureView! },
      { binding: 2, resource: cache.extentsTextureView! },
      { binding: 3, resource: cache.signedDistanceTextureView! },
    ],
  });

  // Dispatch compute shader
  const sdfSize = 256;
  const encoder = device.createCommandEncoder({ label: "PolygonSDF-Compute" });
  const pass = encoder.beginComputePass({ label: "PolygonSDF-Pass" });
  pass.setPipeline(_sdfComputePipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(Math.ceil(sdfSize / 8), Math.ceil(sdfSize / 8), 1);
  pass.end();
  device.queue.submit([encoder.finish()]);

  // Cleanup one-shot uniform buffer
  uniformBuffer.destroy();
}

// Inline WGSL source for the SDF compute shader (avoids async shader loading)
const POLYGON_SDF_WGSL = /* wgsl */ `
struct PolygonParams {
  polygonsLength: u32,
  extentsLength: u32,
  positionsWidth: u32,
  _pad: u32,
};

@group(0) @binding(0) var<uniform> params: PolygonParams;
@group(0) @binding(1) var positionsTexture: texture_2d<f32>;
@group(0) @binding(2) var extentsTexture: texture_2d<f32>;
@group(0) @binding(3) var outputSDF: texture_storage_2d<r32float, write>;

fn getPolygonPosition(index: u32) -> vec2<f32> {
  let width = params.positionsWidth;
  return textureLoad(positionsTexture, vec2<u32>(index % width, index / width), 0).xy;
}

fn getExtents(index: u32) -> vec4<f32> {
  return textureLoad(extentsTexture, vec2<u32>(index, 0u), 0);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let outputSize = textureDimensions(outputSDF);
  if (gid.x >= outputSize.x || gid.y >= outputSize.y) { return; }

  let uv = vec2<f32>(
    (f32(gid.x) + 0.5) / f32(outputSize.x),
    (f32(gid.y) + 0.5) / f32(outputSize.y),
  );

  var dimension = f32(params.extentsLength);
  if (params.extentsLength > 2u) { dimension = ceil(log2(f32(params.extentsLength))); }
  let regionIndex = u32(floor(uv.y * dimension)) * u32(dimension) + u32(floor(uv.x * dimension));

  var result = 1.0;
  var lastIdx = 0u;

  for (var pi = 0u; pi < params.polygonsLength; pi++) {
    let header = getPolygonPosition(lastIdx);
    let posLen = u32(header.x);
    let extIdx = u32(header.y);
    lastIdx += 1u;

    if (extIdx == regionIndex) {
      let ext = getExtents(extIdx);
      let tOff = vec2<f32>(f32(extIdx % u32(dimension)), floor(f32(extIdx) / dimension)) / dimension;
      let lUV = (uv - tOff) * dimension;
      let p = vec2<f32>(mix(ext.x, ext.x + 1.0 / ext.z, lUV.y), mix(ext.y, ext.y + 1.0 / ext.w, lUV.x));

      var clip = 1e10;
      var s = 1.0;
      for (var i = 0u; i < posLen; i++) {
        let j = select(i - 1u, posLen - 1u, i == 0u);
        let a = getPolygonPosition(lastIdx + i);
        let b = getPolygonPosition(lastIdx + j);
        let ab = b - a;
        let pa = p - a;
        let t = clamp(dot(pa, ab) / dot(ab, ab), 0.0, 1.0);
        let d = length(pa - t * ab);
        let c1 = p.y >= a.y; let c2 = p.y < b.y; let c3 = ab.x * pa.y > ab.y * pa.x;
        if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) { s = -s; }
        if (abs(d) < abs(clip)) { clip = d; }
      }
      result = min(result, (s * clip * length(ext.zw)) / 2.0 + 0.5);
    }
    lastIdx += posLen;
  }

  textureStore(outputSDF, vec2<u32>(gid.x, gid.y), vec4<f32>(result, 0.0, 0.0, 0.0));
}
`;

/**
 * Destroy WebGPU clipping polygon resources.
 */
function destroyWebGPUClippingPolygonResources(
  collection: CesiumObjectWithWebGPUCache,
): void {
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

  (collection as CesiumObjectWithWebGPUCache)._webgpuCache = undefined;
}

export { updateWebGPUClippingPolygons, destroyWebGPUClippingPolygonResources };
export default {
  updateWebGPUClippingPolygons,
  destroyWebGPUClippingPolygonResources,
};
