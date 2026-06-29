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
import EnvCubeMipDownsampleWGSL from "../../Shaders/WebGPU/Compute/EnvCubeMipDownsample.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  storageTexture,
  texture,
  sampler,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";

const IRRADIANCE_SIZE = 32;
const RADIANCE_BASE_SIZE = 128;
const RADIANCE_MIP_LEVELS = 6; // log2(128) - 1, roughness 0..1

/**
 * Item 1.3 (IBL-PREFILTER-HQ, Batch 426). Quality mode for the radiance
 * prefilter. `'parity'` (default) samples the source cube at mip 0 exactly
 * as shipped; `'high'` first box-downsamples the source cube into a mip
 * chain, then samples a GGX-pdf-derived LOD (Karis/UE4) to kill bright-sun
 * firefly aliasing at high roughness.
 */
type IBLPrefilterQuality = "parity" | "high";

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
  // Item 1.3 (IBL-PREFILTER-HQ, Batch 426) — high-quality radiance pipeline
  // (entry point `mainHQ`) + the source-cube mip-chain downsample pipeline.
  // Lazily built only when `quality === 'high'`; null on the parity path so
  // the parity build never references the HQ shaders.
  radianceHQPipeline?: GPUComputePipeline | null;
  radianceHQBGL?: GPUBindGroupLayout | null;
  mipDownsamplePipeline?: GPUComputePipeline | null;
  mipDownsampleBGL?: GPUBindGroupLayout | null;
  // Source-cube format the HQ downsample pipeline was built against (the
  // storage-texture format token is baked into the pipeline; rebuild when
  // the env cube flips between rgba8unorm/rgba16float).
  mipDownsampleFormat?: GPUTextureFormat;
}

/**
 * Creates the compute pipeline for irradiance convolution.
 *
 * C-R7-COMPUTE-PIPELINE-CACHE (Batch 76) — routes through the central
 * cache when supplied, sync-creates otherwise.
 */
function createIrradiancePipeline(
  device: GPUDevice,
  computePipelineCache:
    | import("./WebGPUComputePipelineCache.js").WebGPUComputePipelineCache
    | null,
): {
  pipeline: GPUComputePipeline;
  bgl: GPUBindGroupLayout;
} {
  const bgl = makeBindGroupLayout(device, "IBL-Irradiance-BGL", [
    texture(0, Stage.COMPUTE, { viewDimension: "cube" }),
    sampler(1, Stage.COMPUTE),
    storageTexture(2, Stage.COMPUTE, "rgba16float", {
      viewDimension: "2d-array",
    }),
    uniformBuffer(3, Stage.COMPUTE),
  ]);

  const module = device.createShaderModule({ code: IrradianceConvolutionWGSL });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
  const pipeline = computePipelineCache
    ? computePipelineCache.getOrCreateSync({
        name: "IBL-Irradiance",
        layout,
        compute: { module, entryPoint: "main" },
      })
    : device.createComputePipeline({
        label: "IBL-Irradiance",
        layout,
        compute: { module, entryPoint: "main" },
      });

  return { pipeline, bgl };
}

/**
 * Creates the compute pipeline for radiance prefiltering.
 */
function createRadiancePipeline(
  device: GPUDevice,
  computePipelineCache:
    | import("./WebGPUComputePipelineCache.js").WebGPUComputePipelineCache
    | null,
): {
  pipeline: GPUComputePipeline;
  bgl: GPUBindGroupLayout;
} {
  const bgl = makeBindGroupLayout(device, "IBL-Radiance-BGL", [
    texture(0, Stage.COMPUTE, { viewDimension: "cube" }),
    sampler(1, Stage.COMPUTE),
    storageTexture(2, Stage.COMPUTE, "rgba16float", {
      viewDimension: "2d-array",
    }),
    uniformBuffer(3, Stage.COMPUTE),
  ]);

  const module = device.createShaderModule({ code: RadiancePrefilterWGSL });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
  const pipeline = computePipelineCache
    ? computePipelineCache.getOrCreateSync({
        name: "IBL-Radiance",
        layout,
        compute: { module, entryPoint: "main" },
      })
    : device.createComputePipeline({
        label: "IBL-Radiance",
        layout,
        compute: { module, entryPoint: "main" },
      });

  return { pipeline, bgl };
}

/**
 * Item 1.3 (IBL-PREFILTER-HQ, Batch 426). Creates the high-quality radiance
 * prefilter pipeline — identical BGL to the parity pipeline, but compiled
 * against the `mainHQ` entry point which samples the source cube at a
 * GGX-pdf-derived LOD. Only built when `quality === 'high'`.
 */
function createRadianceHQPipeline(
  device: GPUDevice,
  computePipelineCache:
    | import("./WebGPUComputePipelineCache.js").WebGPUComputePipelineCache
    | null,
): {
  pipeline: GPUComputePipeline;
  bgl: GPUBindGroupLayout;
} {
  const bgl = makeBindGroupLayout(device, "IBL-Radiance-HQ-BGL", [
    texture(0, Stage.COMPUTE, { viewDimension: "cube" }),
    sampler(1, Stage.COMPUTE),
    storageTexture(2, Stage.COMPUTE, "rgba16float", {
      viewDimension: "2d-array",
    }),
    uniformBuffer(3, Stage.COMPUTE),
  ]);

  const module = device.createShaderModule({ code: RadiancePrefilterWGSL });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
  const pipeline = computePipelineCache
    ? computePipelineCache.getOrCreateSync({
        name: "IBL-Radiance-HQ",
        layout,
        compute: { module, entryPoint: "mainHQ" },
      })
    : device.createComputePipeline({
        label: "IBL-Radiance-HQ",
        layout,
        compute: { module, entryPoint: "mainHQ" },
      });

  return { pipeline, bgl };
}

/**
 * Item 1.3 (IBL-PREFILTER-HQ, Batch 426). Box-downsamples the source env
 * cube into its already-allocated mip chain (mips 1..N from mip 0), so the
 * HQ prefilter can sample a real LOD. One dispatch per destination mip
 * level. The storage-texture format token must match the source cube
 * format (rgba8unorm LDR / rgba16float HDR); the WGSL declares rgba16float
 * and is string-swapped to rgba8unorm when the source is LDR.
 *
 * @returns true if a mip chain was generated (source has >1 mip level).
 */
function dispatchSourceCubeMipChain(
  device: GPUDevice,
  cache: IBLPipelineCache,
  sourceCube: GPUTexture,
  sourceFormat: GPUTextureFormat,
): boolean {
  const mipLevelCount = sourceCube.mipLevelCount;
  if (mipLevelCount <= 1) {
    return false;
  }

  // Rebuild the pipeline if the format flipped (the storage format token is
  // baked into the BGL + shader module).
  if (
    !cache.mipDownsamplePipeline ||
    !cache.mipDownsampleBGL ||
    cache.mipDownsampleFormat !== sourceFormat
  ) {
    cache.mipDownsampleBGL = makeBindGroupLayout(
      device,
      "IBL-EnvMipDownsample-BGL",
      [
        texture(0, Stage.COMPUTE, { viewDimension: "2d-array" }),
        sampler(1, Stage.COMPUTE),
        storageTexture(2, Stage.COMPUTE, sourceFormat, {
          viewDimension: "2d-array",
        }),
        uniformBuffer(3, Stage.COMPUTE),
      ],
    );
    const code =
      sourceFormat === "rgba16float"
        ? EnvCubeMipDownsampleWGSL
        : EnvCubeMipDownsampleWGSL.replace(
            "texture_storage_2d_array<rgba16float, write>",
            `texture_storage_2d_array<${sourceFormat}, write>`,
          );
    const module = device.createShaderModule({
      label: "EnvCubeMipDownsample",
      code,
    });
    const layout = device.createPipelineLayout({
      bindGroupLayouts: [cache.mipDownsampleBGL],
    });
    cache.mipDownsamplePipeline = device.createComputePipeline({
      label: "IBL-EnvMipDownsample",
      layout,
      compute: { module, entryPoint: "main" },
    });
    cache.mipDownsampleFormat = sourceFormat;
  }

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

  const baseSize = sourceCube.width;
  const encoder = device.createCommandEncoder({
    label: "IBL-EnvMipDownsample",
  });
  const tmpBuffers: GPUBuffer[] = [];

  for (let mip = 1; mip < mipLevelCount; mip++) {
    const dstSize = Math.max(1, baseSize >> mip);
    const srcView = sourceCube.createView({
      dimension: "2d-array",
      baseMipLevel: mip - 1,
      mipLevelCount: 1,
      arrayLayerCount: 6,
      baseArrayLayer: 0,
    });
    const dstView = sourceCube.createView({
      dimension: "2d-array",
      baseMipLevel: mip,
      mipLevelCount: 1,
      arrayLayerCount: 6,
      baseArrayLayer: 0,
    });

    const paramsBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    tmpBuffers.push(paramsBuffer);
    device.queue.writeBuffer(
      paramsBuffer,
      0,
      new Uint32Array([dstSize, 0, 0, 0]),
    );

    const bindGroup = device.createBindGroup({
      layout: cache.mipDownsampleBGL,
      entries: [
        { binding: 0, resource: srcView },
        { binding: 1, resource: cache.sampler },
        { binding: 2, resource: dstView },
        { binding: 3, resource: { buffer: paramsBuffer } },
      ],
    });

    const pass = encoder.beginComputePass();
    pass.setPipeline(cache.mipDownsamplePipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(dstSize / 8), Math.ceil(dstSize / 8), 6);
    pass.end();
  }

  device.queue.submit([encoder.finish()]);
  for (const b of tmpBuffers) {
    b.destroy();
  }
  return true;
}

/**
 * Dispatches irradiance convolution for all 6 cubemap faces.
 */
function dispatchIrradianceConvolution(
  device: GPUDevice,
  cache: IBLPipelineCache,
  sourceCubeView: GPUTextureView,
  computePipelineCache:
    | import("./WebGPUComputePipelineCache.js").WebGPUComputePipelineCache
    | null = null,
): void {
  if (!cache.irradiancePipeline || !cache.irradianceBGL) {
    const result = createIrradiancePipeline(device, computePipelineCache);
    cache.irradiancePipeline = result.pipeline;
    cache.irradianceBGL = result.bgl;
  }

  // C-P17: destroy any existing irradiance texture before replacing.
  // Previously this path leaked one cube texture per env-map version
  // rotation (each one 6 × 64×64 × rgba16float × mip count ≈ 500 KB);
  // apps that animate time-of-day or toggle skyboxes leaked unbounded
  // VRAM across the frame stream.
  if (cache.irradianceTexture) {
    cache.irradianceTexture.destroy();
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

  // C-P17: batch per-face param buffers so they can be destroyed in a
  // single tight loop after queue.submit. Previously each of the 6
  // faces created an un-tracked 16-byte UBO that leaked across IBL
  // regenerations. Collect the handles and destroy them once the
  // submit has queued the compute commands.
  const leakedParamsBuffers: GPUBuffer[] = [];
  for (let face = 0; face < 6; face++) {
    const paramsData = new Uint32Array([face, IRRADIANCE_SIZE, 0, 0]);
    const paramsBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    leakedParamsBuffers.push(paramsBuffer);
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
  // After submit, the 6 params UBOs have been consumed by the GPU
  // command stream. WebGPU guarantees the buffer contents outlive the
  // submit; explicit destroy releases VRAM immediately instead of
  // waiting for GC.
  for (const b of leakedParamsBuffers) b.destroy();
}

/**
 * Item 1.3 (IBL-PREFILTER-HQ, Batch 426). Optional high-quality inputs for
 * `dispatchRadiancePrefilter` / `generateIBLMaps`. Undefined / `'parity'`
 * keeps the byte-identical shipped path (mip-0 sample, no downsample).
 */
interface RadianceHQOptions {
  quality?: IBLPrefilterQuality;
  /** The source env cube texture (needed to populate its mip chain). */
  sourceCube?: GPUTexture | null;
  /** The source env cube format (rgba8unorm LDR / rgba16float HDR). */
  sourceFormat?: GPUTextureFormat;
}

/**
 * Dispatches radiance prefiltering for all 6 faces × N mip levels.
 */
function dispatchRadiancePrefilter(
  device: GPUDevice,
  cache: IBLPipelineCache,
  sourceCubeView: GPUTextureView,
  computePipelineCache:
    | import("./WebGPUComputePipelineCache.js").WebGPUComputePipelineCache
    | null = null,
  hqOptions?: RadianceHQOptions,
): void {
  // Item 1.3 — high-quality path: box-downsample the source cube into its
  // mip chain, then select the `mainHQ` pipeline (GGX-pdf LOD sampling).
  // Falls back to the parity pipeline if the source has no extra mips.
  const wantsHQ = hqOptions?.quality === "high";
  let useHQ = false;
  if (wantsHQ && hqOptions?.sourceCube) {
    const fmt = hqOptions.sourceFormat ?? "rgba8unorm";
    const built = dispatchSourceCubeMipChain(
      device,
      cache,
      hqOptions.sourceCube,
      fmt,
    );
    if (built) {
      if (!cache.radianceHQPipeline || !cache.radianceHQBGL) {
        const result = createRadianceHQPipeline(device, computePipelineCache);
        cache.radianceHQPipeline = result.pipeline;
        cache.radianceHQBGL = result.bgl;
      }
      useHQ = true;
    }
  }

  if (!cache.radiancePipeline || !cache.radianceBGL) {
    const result = createRadiancePipeline(device, computePipelineCache);
    cache.radiancePipeline = result.pipeline;
    cache.radianceBGL = result.bgl;
  }

  // C-P17 (matching irradiance path): destroy existing radiance
  // cubemap before replacing. Radiance is heavier (mipLevelCount = 6
  // by default) so the per-regen leak is ~2 MB per rotation here.
  if (cache.radianceTexture) {
    cache.radianceTexture.destroy();
  }

  // Create output radiance cubemap with mip chain. COPY_SRC is a capability
  // flag (permits texture→buffer readback for probes/diagnostics) — it never
  // changes the texture contents or sampling, so the parity path stays byte-
  // identical.
  cache.radianceTexture = device.createTexture({
    size: {
      width: RADIANCE_BASE_SIZE,
      height: RADIANCE_BASE_SIZE,
      depthOrArrayLayers: 6,
    },
    format: "rgba16float",
    mipLevelCount: RADIANCE_MIP_LEVELS,
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.STORAGE_BINDING |
      GPUTextureUsage.COPY_SRC,
    dimension: "2d",
  });
  cache.radianceView = cache.radianceTexture.createView({
    dimension: "cube",
    mipLevelCount: RADIANCE_MIP_LEVELS,
  });

  const encoder = device.createCommandEncoder();
  // See irradiance path for the rationale on batching destroys.
  const leakedParamsBuffers: GPUBuffer[] = [];

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
      leakedParamsBuffers.push(paramsBuffer);
      device.queue.writeBuffer(paramsBuffer, 0, paramsData);

      const bindGroup = device.createBindGroup({
        layout: useHQ ? cache.radianceHQBGL! : cache.radianceBGL!,
        entries: [
          { binding: 0, resource: sourceCubeView },
          { binding: 1, resource: cache.sampler! },
          { binding: 2, resource: mipArrayView },
          { binding: 3, resource: { buffer: paramsBuffer } },
        ],
      });

      const pass = encoder.beginComputePass();
      pass.setPipeline(
        useHQ ? cache.radianceHQPipeline! : cache.radiancePipeline!,
      );
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(mipSize / 8), Math.ceil(mipSize / 8));
      pass.end();
    }
  }

  device.queue.submit([encoder.finish()]);
  for (const b of leakedParamsBuffers) b.destroy();
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

  // Audit A.9 (Batch 130) -- 40 floats / 160 bytes total:
  //   - 0..35  : 9 SH coefficients (vec4 padding)
  //   - 36..39 : control vec4 -- .w = 1.0 marks SH active so the FS
  //              evaluates analytically instead of sampling the
  //              irradiance cubemap.
  const data = new Float32Array(40);
  for (let i = 0; i < 9; i++) {
    const c = shCoefficients[i];
    data[i * 4 + 0] = c.x;
    data[i * 4 + 1] = c.y;
    data[i * 4 + 2] = c.z;
    data[i * 4 + 3] = 0.0; // padding
  }
  data[39] = 1.0; // control.w -- SH active

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
  computePipelineCache:
    | import("./WebGPUComputePipelineCache.js").WebGPUComputePipelineCache
    | null = null,
  hqOptions?: RadianceHQOptions,
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
    dispatchIrradianceConvolution(
      device,
      cache,
      sourceCubeView,
      computePipelineCache,
    );
  } catch (e) {
    // Irradiance convolution failed — fall back to default cubemap
    // The ambient term in the PBR shader will use a constant
  }

  try {
    dispatchRadiancePrefilter(
      device,
      cache,
      sourceCubeView,
      computePipelineCache,
      hqOptions,
    );
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

export type { IBLPipelineCache, RadianceHQOptions, IBLPrefilterQuality };
