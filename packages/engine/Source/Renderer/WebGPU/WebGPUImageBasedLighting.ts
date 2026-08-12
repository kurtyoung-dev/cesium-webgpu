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

import { generateIBLMaps, RADIANCE_MIP_LEVELS } from "./WebGPUIBLPipeline.js";

import type { IBLPipelineCache } from "./WebGPUIBLPipeline.js";

import loadKTX2 from "../../Core/loadKTX2.js";
import { buildWebGPUSpecularCubeFromKTX2Buffers } from "./WebGPUSpecularEnvironmentCubeMap.js";

interface IBLCache extends IBLPipelineCache {
  owner: CesiumImageBasedLighting;
  context: CesiumGraphicsContext;
  device: GPUDevice;
  resourceGeneration: number;
  brdfLutGenerated: boolean;
  defaultSpecularTexture: GPUTexture | null;
  defaultSpecularView: GPUTextureView | null;
  defaultDiffuseTexture: GPUTexture | null;
  defaultDiffuseView: GPUTextureView | null;
  shBuffer: GPUBuffer | null;
  shData: Float32Array;
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
  // Audit A.9 (Batch 130) -- 40 floats / 160 bytes total:
  //   - 0..35  : 9 SH coefficients (vec4 padding) -- all zero
  //   - 36..39 : control vec4 (.w == 1.0 when SH active; default 0)
  // The shader's `SHUniforms` struct expects this exact layout.
  const data = new Float32Array(40);
  const buffer = device.createBuffer({
    size: data.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buffer, 0, data);
  return buffer;
}

function updateSphericalHarmonics(
  device: GPUDevice,
  cache: IBLCache,
  coefficients: CesiumCartesian3[] | undefined,
): void {
  const data = cache.shData;
  const buffer = cache.shBuffer;
  if (!buffer) {
    return;
  }

  if (!coefficients || coefficients.length < 9) {
    if (!cache.hasSH) {
      return;
    }
    data.fill(0.0);
    device.queue.writeBuffer(buffer, 0, data);
    cache.hasSH = false;
    return;
  }

  let dirty = !cache.hasSH || data[39] !== 1.0;
  for (let i = 0; i < 9; i++) {
    const coefficient = coefficients[i];
    const offset = i * 4;
    const x = Math.fround(coefficient.x);
    const y = Math.fround(coefficient.y);
    const z = Math.fround(coefficient.z);
    dirty =
      dirty ||
      !Object.is(data[offset], x) ||
      !Object.is(data[offset + 1], y) ||
      !Object.is(data[offset + 2], z);
  }

  if (dirty) {
    for (let i = 0; i < 9; i++) {
      const coefficient = coefficients[i];
      const offset = i * 4;
      data[offset] = coefficient.x;
      data[offset + 1] = coefficient.y;
      data[offset + 2] = coefficient.z;
      data[offset + 3] = 0.0;
    }
    data[39] = 1.0;
    device.queue.writeBuffer(buffer, 0, data);
  }
  cache.hasSH = true;
}

function initCache(
  owner: CesiumImageBasedLighting,
  context: CesiumGraphicsContext,
  device: GPUDevice,
  resourceGeneration: number,
): IBLCache {
  const defSpec = createDefaultSpecularCubemap(device);
  const defDiff = createDefaultDiffuseCubemap(device);

  return {
    owner,
    context,
    device,
    resourceGeneration,
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
    shData: new Float32Array(40),
    hasSH: false,
    maxMipLevel: 0,
    iblFactor: new Float32Array([1.0, 1.0]), // diffuse, specular factors
  };
}

/** A lost/replaced device may throw while its stale native handles are drained. */
function destroyBestEffort(resource: { destroy(): void } | null | undefined) {
  try {
    resource?.destroy();
  } catch {
    // Ownership is already detached. Continue draining sibling resources so a
    // stale device cannot prevent the replacement generation from rebuilding.
  }
}

/** Destroy only the GPU objects owned by one exact cache generation. */
function destroyCacheResources(cache: IBLCache): void {
  const resources = [
    cache.defaultSpecularTexture,
    cache.defaultDiffuseTexture,
    cache.irradianceTexture,
    cache.radianceTexture,
    cache.shBuffer,
  ];

  // Detach first. Native destruction is best-effort and must never leave stale
  // cache ownership or published views reachable if one old handle throws.
  cache.defaultSpecularTexture = null;
  cache.defaultSpecularView = null;
  cache.defaultDiffuseTexture = null;
  cache.defaultDiffuseView = null;
  cache.irradianceTexture = null;
  cache.irradianceView = null;
  cache.radianceTexture = null;
  cache.radianceView = null;
  cache.shBuffer = null;
  cache.sampler = null;

  for (const resource of resources) {
    destroyBestEffort(resource);
  }
}

/** Stop publishing handles after their owning device generation is gone. */
function clearPublishedResources(ibl: CesiumImageBasedLighting): void {
  ibl._webgpuSpecularView = undefined;
  ibl._webgpuDiffuseView = undefined;
  ibl._webgpuSampler = undefined;
  ibl._webgpuSHBuffer = undefined;
  ibl._webgpuHasSH = undefined;
  ibl._webgpuMaxMipLevel = undefined;
  ibl._webgpuIBLFactor = undefined;
}

/** Release the device-local cube while retaining its decoded CPU source. */
function destroyDeviceSpecularCube(ibl: CesiumImageBasedLighting): void {
  const cube = ibl._webgpuSpecularCube;
  ibl._webgpuSpecularCube = undefined;
  ibl._specularEnvironmentCubeMap = undefined;
  destroyBestEffort(cube);
}

/**
 * Drop one superseded GPU generation. KTX2 fetch/transcode results are CPU
 * resources keyed by URL + transcode targets, so retain them: the next cache
 * can rebuild the cube without an avoidable network/decode round trip.
 */
function invalidateCacheGeneration(ibl: CesiumImageBasedLighting): void {
  const cache = ibl._webgpuCache as IBLCache | undefined;
  ibl._webgpuCache = undefined;
  clearPublishedResources(ibl);

  if (cache) {
    destroyCacheResources(cache);
  }
  destroyDeviceSpecularCube(ibl);
}

/**
 * Ensure the authored `specularEnvironmentMaps` KTX2 cube is loaded + uploaded
 * to a WebGPU cube texture, then present it to the IBL consumer below in the
 * exact shape it reads (`specEnvMap.ready` + `_texture._webgpuTexture.view` +
 * `_version`). On WebGL this is `SpecularEnvironmentCubeMap.update()`, but that
 * builds a WebGL-only `CubeMap`; on WebGPU `ImageBasedLighting.update()`
 * FR-routes past it, so we own `_specularEnvironmentCubeMap` here.
 *
 * Idempotent + load-once: the KTX2 fetch/transcode runs a single time per URL.
 * A hard failure latches `_webgpuSpecularKTX2Failed` so it does NOT retry every
 * frame (the failure-retry spam loop that forced the Batch 369 revert).
 */
function ensureWebGPUSpecularSource(
  ibl: CesiumImageBasedLighting,
  device: GPUDevice,
  targetFormats: CesiumGraphicsContext["graphicsCapabilities"]["ktx2TranscodeTargets"],
): void {
  const url = ibl._specularEnvironmentMaps;
  const requestKey = url ? `${url}|${targetFormats.cacheKey}` : undefined;

  // No authored map (or it was cleared) — tear down any prior cube + reset.
  if (!url) {
    if (ibl._webgpuSpecularCube) {
      ibl._webgpuSpecularCube.destroy();
      ibl._webgpuSpecularCube = undefined;
    }
    ibl._specularEnvironmentCubeMap = undefined;
    ibl._webgpuSpecularKTX2Buffers = undefined;
    ibl._webgpuSpecularKTX2Url = undefined;
    ibl._webgpuSpecularKTX2RequestKey = undefined;
    ibl._webgpuSpecularKTX2Loading = false;
    ibl._webgpuSpecularKTX2Failed = false;
    return;
  }

  // URL changed — reset so the new map loads.
  if (
    ibl._webgpuSpecularKTX2Url !== undefined &&
    ibl._webgpuSpecularKTX2RequestKey !== requestKey
  ) {
    if (ibl._webgpuSpecularCube) {
      ibl._webgpuSpecularCube.destroy();
      ibl._webgpuSpecularCube = undefined;
    }
    ibl._specularEnvironmentCubeMap = undefined;
    ibl._webgpuSpecularKTX2Buffers = undefined;
    ibl._webgpuSpecularKTX2Loading = false;
    ibl._webgpuSpecularKTX2Failed = false;
  }
  ibl._webgpuSpecularKTX2Url = url;
  ibl._webgpuSpecularKTX2RequestKey = requestKey;

  // Already built — nothing to do.
  if (ibl._webgpuSpecularCube) {
    return;
  }

  // Kick off the KTX2 load exactly once (and never again after a hard failure).
  if (
    !ibl._webgpuSpecularKTX2Buffers &&
    !ibl._webgpuSpecularKTX2Loading &&
    !ibl._webgpuSpecularKTX2Failed
  ) {
    ibl._webgpuSpecularKTX2Loading = true;
    loadKTX2(url, targetFormats)
      .then((buffers: unknown) => {
        if (ibl._webgpuSpecularKTX2RequestKey !== requestKey) {
          return;
        }
        ibl._webgpuSpecularKTX2Buffers = buffers;
        ibl._webgpuSpecularKTX2Loading = false;
      })
      .catch((error: unknown) => {
        if (ibl._webgpuSpecularKTX2RequestKey !== requestKey) {
          return;
        }
        ibl._webgpuSpecularKTX2Loading = false;
        ibl._webgpuSpecularKTX2Failed = true; // latch — no per-frame retry
        console.error(
          `[CesiumJS:webgpu] Failed to load specular environment KTX2 "${url}": ${String(
            error,
          )}`,
        );
      });
  }

  // Buffers ready, cube not built yet — build the on-device cube + publish it.
  if (ibl._webgpuSpecularKTX2Buffers && !ibl._webgpuSpecularCube) {
    const wrapper = buildWebGPUSpecularCubeFromKTX2Buffers(
      device,
      ibl._webgpuSpecularKTX2Buffers,
    );
    if (wrapper) {
      ibl._webgpuSpecularCube = wrapper;
      const version = (ibl._webgpuSpecularVersion =
        (ibl._webgpuSpecularVersion ?? 0) + 1);
      // Minimal SpecularEnvironmentCubeMap-shaped object the consumer reads.
      ibl._specularEnvironmentCubeMap = {
        _texture: wrapper, // wrapper._webgpuTexture.view → cube view
        ready: true,
        _version: version,
        _maximumMipmapLevel: wrapper.maximumMipmapLevel,
        url: url,
        isDestroyed: () => false,
        destroy: () => {},
      };
    } else {
      // Unbuildable payload (e.g. GPU-compressed) — don't retry every frame.
      ibl._webgpuSpecularKTX2Buffers = undefined;
      ibl._webgpuSpecularKTX2Failed = true;
    }
  }
}

/**
 * Update IBL resources for WebGPU rendering.
 * Called from ImageBasedLighting.update() when context.isWebGPU.
 */
function updateWebGPUImageBasedLighting(
  ibl: CesiumImageBasedLighting,
  frameState: CesiumFrameState,
): void {
  const context = frameState.context;
  const device: GPUDevice = context.device;
  const resourceGeneration =
    (
      context as unknown as {
        resourceGeneration?: number;
      }
    ).resourceGeneration ?? 0;

  // Every native object in the cache belongs to this exact
  // (owner, context, device, resourceGeneration) tuple. Check before the
  // duplicate-frame return: recovery can publish a new generation within the
  // same logical frame, and that generation still needs a complete rebuild.
  let cache = ibl._webgpuCache as IBLCache | undefined;
  if (
    cache &&
    (cache.owner !== ibl ||
      cache.context !== context ||
      cache.device !== device ||
      cache.resourceGeneration !== resourceGeneration)
  ) {
    invalidateCacheGeneration(ibl);
    cache = undefined;
  }

  let cacheCreated = false;
  if (!cache) {
    cache = initCache(ibl, context, device, resourceGeneration);
    ibl._webgpuCache = cache;
    cacheCreated = true;
  }

  // Skip duplicate frames
  if (
    !cacheCreated &&
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

  // The buffer identity is stable for the cache lifetime. Authored coefficients
  // are mutable, so compare their packed f32 values every frame and upload only
  // when those values or the active/inactive state actually change.
  updateSphericalHarmonics(device, cache, ibl.sphericalHarmonicCoefficients);

  // C2-2 NEW-MODEL-IBL-KTX2-CUBEMAP-WEBGPU: load + upload the authored KTX2
  // specular env map into a WebGPU cube and publish it as _specularEnvironmentCubeMap.
  ensureWebGPUSpecularSource(
    ibl,
    device,
    context.graphicsCapabilities.ktx2TranscodeTargets,
  );

  // Check if specular environment map has changed
  const specEnvMap = ibl._specularEnvironmentCubeMap;
  if (specEnvMap && specEnvMap.ready) {
    const version = specEnvMap._version ?? 0;
    if (version !== cache.sourceVersion) {
      cache.sourceVersion = version;

      // Get the source cubemap texture view from the specular environment map's
      // internal WebGPU texture. The _texture field wraps a WebGPUTexture which
      // exposes a .view getter at ._webgpuTexture.view.
      const sourceView = specEnvMap._texture?._webgpuTexture?.view;

      if (sourceView) {
        // Run the IBL pipeline: irradiance + radiance generation.
        // C-R7-COMPUTE-PIPELINE-CACHE (Batch 76) — pass the central cache.
        generateIBLMaps(
          device,
          cache,
          sourceView,
          context.webgpuComputePipelineCache ?? null,
        );
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
function destroyWebGPUImageBasedLightingResources(
  ibl: CesiumImageBasedLighting,
): void {
  const cache = ibl._webgpuCache as IBLCache | undefined;
  ibl._webgpuCache = undefined;
  clearPublishedResources(ibl);

  if (cache) {
    destroyCacheResources(cache);
  }

  // C2-2: tear down the authored KTX2 specular cube + reset the load latches.
  destroyDeviceSpecularCube(ibl);
  ibl._webgpuSpecularKTX2Buffers = undefined;
  ibl._webgpuSpecularKTX2Url = undefined;
  ibl._webgpuSpecularKTX2RequestKey = undefined;
  ibl._webgpuSpecularKTX2Loading = false;
  ibl._webgpuSpecularKTX2Failed = false;
}

export {
  updateWebGPUImageBasedLighting,
  destroyWebGPUImageBasedLightingResources,
};
export default {
  updateWebGPUImageBasedLighting,
  destroyWebGPUImageBasedLightingResources,
};
