/**
 * WebGPU IBL Pipeline — Irradiance + Radiance Compute Orchestrator
 *
 * Manages the compute shader pipeline for generating IBL cubemaps:
 * - Diffuse irradiance convolution (32×32 per face)
 * - Specular radiance prefiltering (128×128 base, 6 mip levels)
 *
 * These are one-time operations triggered when the environment map changes.
 * The generated textures are cached and reused until the source changes.
 *
 * For diffuse irradiance, CesiumJS also supports spherical harmonics (SH L2,
 * 9 coefficients × 3 channels). When SH coefficients are provided, the
 * irradiance cubemap convolution is skipped — SH evaluation in the fragment
 * shader is cheaper and sufficient for low-frequency diffuse lighting.
 *
 * @module WebGPUIBLPipeline
 */

// Inline WGSL for irradiance convolution (matches Compute/IrradianceConvolution.wgsl)
import IrradianceConvolutionWGSL from "../../Shaders/WebGPU/Compute/IrradianceConvolution.js";
import RadiancePrefilterWGSL from "../../Shaders/WebGPU/Compute/RadiancePrefilter.js";

const IRRADIANCE_SIZE = 32;
const RADIANCE_BASE_SIZE = 128;
const RADIANCE_MIP_LEVELS = 6; // log2(128) - 1, roughness 0..1

interface IBLPipelineCache {
  irradianceTexture: GPUTexture | null;
  irradianceView: GPUTextureView | null;
  radianceTexture: GPUTexture | null;
  radianceView: GPUTextureView | null;
  irradiancePipeline: GPUComputePipeline | null;
  radiancePipeline: GPUComputePipeline | null;
  irradianceBGL: GPUBindGroupLayout | null;
  radianceBGL: GPUBindGroupLayout | null;
  sampler: GPUSampler | null;
  sourceVersion: number;
}

/**
 * Creates the compute pipeline for irradiance convolution.
 */
function createIrradiancePipeline(device: GPUDevice): {
  pipeline: GPUComputePipeline;
  bgl: GPUBindGroupLayout;
} {
  const bgl = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType: "float", viewDimension: "cube" },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        sampler: { type: "filtering" },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: {
          access: "write-only",
          format: "rgba16float",
          viewDimension: "2d-array",
        },
      },
      {
        binding: 3,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "uniform" },
      },
    ],
  });

  const module = device.createShaderModule({ code: IrradianceConvolutionWGSL });
  const pipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
    compute: { module, entryPoint: "main" },
  });

  return { pipeline, bgl };
}

/**
 * Creates the compute pipeline for radiance prefiltering.
 */
function createRadiancePipeline(device: GPUDevice): {
  pipeline: GPUComputePipeline;
  bgl: GPUBindGroupLayout;
} {
  const bgl = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType: "float", viewDimension: "cube" },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        sampler: { type: "filtering" },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: {
          access: "write-only",
          format: "rgba16float",
          viewDimension: "2d-array",
        },
      },
      {
        binding: 3,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "uniform" },
      },
    ],
  });

  const module = device.createShaderModule({ code: RadiancePrefilterWGSL });
  const pipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
    compute: { module, entryPoint: "main" },
  });

  return { pipeline, bgl };
}

/**
 * Dispatches irradiance convolution for all 6 cubemap faces.
 */
function dispatchIrradianceConvolution(
  device: GPUDevice,
  cache: IBLPipelineCache,
  sourceCubeView: GPUTextureView,
): void {
  if (!cache.irradiancePipeline || !cache.irradianceBGL) {
    const result = createIrradiancePipeline(device);
    cache.irradiancePipeline = result.pipeline;
    cache.irradianceBGL = result.bgl;
  }

  // Create output irradiance cubemap
  cache.irradianceTexture = device.createTexture({
    size: {
      width: IRRADIANCE_SIZE,
      height: IRRADIANCE_SIZE,
      depthOrArrayLayers: 6,
    },
    format: "rgba16float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    dimension: "2d",
  });
  cache.irradianceView = cache.irradianceTexture.createView({
    dimension: "cube",
  });

  const outputArrayView = cache.irradianceTexture.createView({
    dimension: "2d-array",
    arrayLayerCount: 6,
    baseArrayLayer: 0,
  });

  const encoder = device.createCommandEncoder();

  for (let face = 0; face < 6; face++) {
    const paramsData = new Uint32Array([face, IRRADIANCE_SIZE, 0, 0]);
    const paramsBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(paramsBuffer, 0, paramsData);

    const bindGroup = device.createBindGroup({
      layout: cache.irradianceBGL!,
      entries: [
        { binding: 0, resource: sourceCubeView },
        { binding: 1, resource: cache.sampler! },
        { binding: 2, resource: outputArrayView },
        { binding: 3, resource: { buffer: paramsBuffer } },
      ],
    });

    const pass = encoder.beginComputePass();
    pass.setPipeline(cache.irradiancePipeline!);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(
      Math.ceil(IRRADIANCE_SIZE / 8),
      Math.ceil(IRRADIANCE_SIZE / 8),
    );
    pass.end();
  }

  device.queue.submit([encoder.finish()]);
}

/**
 * Dispatches radiance prefiltering for all 6 faces × N mip levels.
 */
function dispatchRadiancePrefilter(
  device: GPUDevice,
  cache: IBLPipelineCache,
  sourceCubeView: GPUTextureView,
): void {
  if (!cache.radiancePipeline || !cache.radianceBGL) {
    const result = createRadiancePipeline(device);
    cache.radiancePipeline = result.pipeline;
    cache.radianceBGL = result.bgl;
  }

  // Create output radiance cubemap with mip chain
  cache.radianceTexture = device.createTexture({
    size: {
      width: RADIANCE_BASE_SIZE,
      height: RADIANCE_BASE_SIZE,
      depthOrArrayLayers: 6,
    },
    format: "rgba16float",
    mipLevelCount: RADIANCE_MIP_LEVELS,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    dimension: "2d",
  });
  cache.radianceView = cache.radianceTexture.createView({
    dimension: "cube",
    mipLevelCount: RADIANCE_MIP_LEVELS,
  });

  const encoder = device.createCommandEncoder();

  for (let mip = 0; mip < RADIANCE_MIP_LEVELS; mip++) {
    const mipSize = RADIANCE_BASE_SIZE >> mip;
    const mipArrayView = cache.radianceTexture.createView({
      dimension: "2d-array",
      baseMipLevel: mip,
      mipLevelCount: 1,
      arrayLayerCount: 6,
      baseArrayLayer: 0,
    });

    for (let face = 0; face < 6; face++) {
      const paramsData = new Uint32Array([
        face,
        mip,
        RADIANCE_MIP_LEVELS,
        mipSize,
      ]);
      const paramsBuffer = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(paramsBuffer, 0, paramsData);

      const bindGroup = device.createBindGroup({
        layout: cache.radianceBGL!,
        entries: [
          { binding: 0, resource: sourceCubeView },
          { binding: 1, resource: cache.sampler! },
          { binding: 2, resource: mipArrayView },
          { binding: 3, resource: { buffer: paramsBuffer } },
        ],
      });

      const pass = encoder.beginComputePass();
      pass.setPipeline(cache.radiancePipeline!);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(mipSize / 8), Math.ceil(mipSize / 8));
      pass.end();
    }
  }

  device.queue.submit([encoder.finish()]);
}

/**
 * Packs 9 L2 spherical harmonic coefficients into a GPU buffer.
 * Each coefficient is a vec3 (RGB), packed as vec4 with padding.
 * Total: 9 × vec4 = 144 bytes.
 *
 * @param device - GPU device
 * @param shCoefficients - Array of 9 Cartesian3 objects (or null)
 * @returns GPU buffer with packed SH data, or null
 */
function packSphericalHarmonics(
  device: GPUDevice,
  shCoefficients: { x: number; y: number; z: number }[] | undefined,
): GPUBuffer | null {
  if (!shCoefficients || shCoefficients.length < 9) {
    return null;
  }

  // 9 coefficients × 4 floats (vec4 with padding) = 36 floats
  const data = new Float32Array(36);
  for (let i = 0; i < 9; i++) {
    const c = shCoefficients[i];
    data[i * 4 + 0] = c.x;
    data[i * 4 + 1] = c.y;
    data[i * 4 + 2] = c.z;
    data[i * 4 + 3] = 0.0; // padding
  }

  const buffer = device.createBuffer({
    size: data.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buffer, 0, data);
  return buffer;
}

/**
 * Runs the full IBL pipeline: irradiance + radiance generation.
 * Called when the environment cubemap source changes.
 *
 * @param device - GPU device
 * @param cache - IBL pipeline cache object
 * @param sourceCubeView - Source environment cubemap view
 */
function generateIBLMaps(
  device: GPUDevice,
  cache: IBLPipelineCache,
  sourceCubeView: GPUTextureView,
): void {
  if (!cache.sampler) {
    cache.sampler = device.createSampler({
      minFilter: "linear",
      magFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
      addressModeW: "clamp-to-edge",
    });
  }

  try {
    dispatchIrradianceConvolution(device, cache, sourceCubeView);
  } catch (e) {
    // Irradiance convolution failed — fall back to default cubemap
    // The ambient term in the PBR shader will use a constant
  }

  try {
    dispatchRadiancePrefilter(device, cache, sourceCubeView);
  } catch (e) {
    // Radiance prefilter failed — fall back to sampling source at mip 0
  }
}

export {
  generateIBLMaps,
  packSphericalHarmonics,
  dispatchIrradianceConvolution,
  dispatchRadiancePrefilter,
  IRRADIANCE_SIZE,
  RADIANCE_BASE_SIZE,
  RADIANCE_MIP_LEVELS,
};

export type { IBLPipelineCache };
