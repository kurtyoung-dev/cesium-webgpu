/**
 * WebGPU Image-Based Lighting Manager
 *
 * Manages IBL resources for WebGPU PBR rendering:
 * - BRDF LUT texture (via WebGPUBrdfLutGenerator)
 * - Specular environment map (prefiltered cubemap for reflections)
 * - Diffuse irradiance (spherical harmonics or convolved cubemap)
 *
 * The IBL pipeline supports two modes for diffuse irradiance:
 * 1. Spherical Harmonics (SH L2) — 9 coefficients packed into a uniform buffer.
 *    Evaluated in the PBR fragment shader. Preferred when SH data is available.
 * 2. Irradiance cubemap — Convolved from the environment map via compute shader.
 *    Used when SH coefficients are not provided but an environment map exists.
 *
 * Specular IBL always uses a prefiltered radiance cubemap (128×128 base, 6 mips)
 * combined with the BRDF LUT for the split-sum approximation.
 *
 * @module WebGPUImageBasedLighting
 */

import {
  generateIBLMaps,
  packSphericalHarmonics,
  RADIANCE_MIP_LEVELS,
} from "./WebGPUIBLPipeline.js";

import type { IBLPipelineCache } from "./WebGPUIBLPipeline.js";

interface IBLCache extends IBLPipelineCache {
  brdfLutGenerated: boolean;
  defaultSpecularTexture: GPUTexture | null;
  defaultSpecularView: GPUTextureView | null;
  defaultDiffuseTexture: GPUTexture | null;
  defaultDiffuseView: GPUTextureView | null;
  shBuffer: GPUBuffer | null;
  hasSH: boolean;
  maxMipLevel: number;
  iblFactor: Float32Array;
}

/**
 * Creates a 1x1 default specular cubemap (black — no reflections) for fallback.
 */
function createDefaultSpecularCubemap(device: GPUDevice): {
  texture: GPUTexture;
  view: GPUTextureView;
} {
  const texture = device.createTexture({
    size: { width: 1, height: 1, depthOrArrayLayers: 6 },
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    dimension: "2d",
  });

  const blackPixel = new Uint8Array([0, 0, 0, 255]);
  for (let face = 0; face < 6; face++) {
    device.queue.writeTexture(
      { texture, origin: { x: 0, y: 0, z: face } },
      blackPixel,
      { bytesPerRow: 4 },
      { width: 1, height: 1, depthOrArrayLayers: 1 },
    );
  }

  const view = texture.createView({ dimension: "cube" });
  return { texture, view };
}

/**
 * Creates a 1x1 default diffuse irradiance cubemap (ambient gray).
 */
function createDefaultDiffuseCubemap(device: GPUDevice): {
  texture: GPUTexture;
  view: GPUTextureView;
} {
  const texture = device.createTexture({
    size: { width: 1, height: 1, depthOrArrayLayers: 6 },
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    dimension: "2d",
  });

  // Low ambient gray — provides minimal fill light
  const grayPixel = new Uint8Array([30, 30, 30, 255]);
  for (let face = 0; face < 6; face++) {
    device.queue.writeTexture(
      { texture, origin: { x: 0, y: 0, z: face } },
      grayPixel,
      { bytesPerRow: 4 },
      { width: 1, height: 1, depthOrArrayLayers: 1 },
    );
  }

  const view = texture.createView({ dimension: "cube" });
  return { texture, view };
}

/**
 * Creates default SH buffer with zero coefficients (no irradiance).
 */
function createDefaultSHBuffer(device: GPUDevice): GPUBuffer {
  const data = new Float32Array(36); // 9 × vec4 = 36 floats, all zero
  const buffer = device.createBuffer({
    size: data.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buffer, 0, data);
  return buffer;
}

function initCache(device: GPUDevice): IBLCache {
  const defSpec = createDefaultSpecularCubemap(device);
  const defDiff = createDefaultDiffuseCubemap(device);

  return {
    brdfLutGenerated: false,
    defaultSpecularTexture: defSpec.texture,
    defaultSpecularView: defSpec.view,
    defaultDiffuseTexture: defDiff.texture,
    defaultDiffuseView: defDiff.view,
    // IBLPipelineCache fields
    irradianceTexture: null,
    irradianceView: null,
    radianceTexture: null,
    radianceView: null,
    irradiancePipeline: null,
    radiancePipeline: null,
    irradianceBGL: null,
    radianceBGL: null,
    sampler: device.createSampler({
      minFilter: "linear",
      magFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
      addressModeW: "clamp-to-edge",
    }),
    sourceVersion: -1,
    shBuffer: createDefaultSHBuffer(device),
    hasSH: false,
    maxMipLevel: 0,
    iblFactor: new Float32Array([1.0, 1.0]), // diffuse, specular factors
  };
}

/**
 * Update IBL resources for WebGPU rendering.
 * Called from ImageBasedLighting.update() when context.isWebGPU.
 */
function updateWebGPUImageBasedLighting(ibl: any, frameState: CesiumFrameState): void {
  const context = frameState.context;
  const device: GPUDevice = context.device;

  if (!ibl._webgpuCache) {
    ibl._webgpuCache = initCache(device);
  }

  const cache = ibl._webgpuCache as IBLCache;

  // Skip duplicate frames
  if (
    frameState.frameNumber === ibl._previousFrameNumber &&
    frameState.context === ibl._previousFrameContext
  ) {
    return;
  }
  ibl._previousFrameNumber = frameState.frameNumber;
  ibl._previousFrameContext = frameState.context;

  // Ensure BRDF LUT is generated
  if (frameState.brdfLutGenerator) {
    frameState.brdfLutGenerator.update(frameState);
  }

  // Update IBL factor from user-provided imageBasedLightingFactor
  if (ibl.imageBasedLightingFactor) {
    cache.iblFactor[0] = ibl.imageBasedLightingFactor.x;
    cache.iblFactor[1] = ibl.imageBasedLightingFactor.y;
  }

  // Update spherical harmonics if provided
  if (ibl.sphericalHarmonicCoefficients) {
    const newSH = packSphericalHarmonics(device, ibl.sphericalHarmonicCoefficients);
    if (newSH) {
      if (cache.shBuffer) {
        cache.shBuffer.destroy();
      }
      cache.shBuffer = newSH;
      cache.hasSH = true;
    }
  } else if (cache.hasSH) {
    // SH was removed, reset to default
    if (cache.shBuffer) {
      cache.shBuffer.destroy();
    }
    cache.shBuffer = createDefaultSHBuffer(device);
    cache.hasSH = false;
  }

  // Check if specular environment map has changed
  const specEnvMap = ibl._specularEnvironmentCubeMap;
  if (specEnvMap && specEnvMap._ready) {
    const version = specEnvMap._version ?? 0;
    if (version !== cache.sourceVersion) {
      cache.sourceVersion = version;

      // Get the source cubemap texture view
      const sourceView = specEnvMap._texture?._webgpuTextureView ??
                         specEnvMap._texture?._textureView;

      if (sourceView) {
        // Run the IBL pipeline: irradiance + radiance generation
        generateIBLMaps(device, cache, sourceView);
        cache.maxMipLevel = RADIANCE_MIP_LEVELS - 1;
      }
    }
  }

  // Expose getters for the PBR shader to access IBL textures
  ibl._webgpuSpecularView = cache.radianceView ?? cache.defaultSpecularView;
  ibl._webgpuDiffuseView = cache.irradianceView ?? cache.defaultDiffuseView;
  ibl._webgpuSampler = cache.sampler;
  ibl._webgpuSHBuffer = cache.shBuffer;
  ibl._webgpuHasSH = cache.hasSH;
  ibl._webgpuMaxMipLevel = cache.maxMipLevel;
  ibl._webgpuIBLFactor = cache.iblFactor;
}

/**
 * Destroy WebGPU IBL resources.
 */
function destroyWebGPUImageBasedLightingResources(ibl: any): void {
  const cache = ibl._webgpuCache as IBLCache | undefined;
  if (!cache) {
    return;
  }

  if (cache.defaultSpecularTexture) cache.defaultSpecularTexture.destroy();
  if (cache.defaultDiffuseTexture) cache.defaultDiffuseTexture.destroy();
  if (cache.irradianceTexture) cache.irradianceTexture.destroy();
  if (cache.radianceTexture) cache.radianceTexture.destroy();
  if (cache.shBuffer) cache.shBuffer.destroy();

  ibl._webgpuCache = undefined;
  ibl._webgpuSpecularView = undefined;
  ibl._webgpuDiffuseView = undefined;
  ibl._webgpuSampler = undefined;
  ibl._webgpuSHBuffer = undefined;
}

export {
  updateWebGPUImageBasedLighting,
  destroyWebGPUImageBasedLightingResources,
};
export default {
  updateWebGPUImageBasedLighting,
  destroyWebGPUImageBasedLightingResources,
};
