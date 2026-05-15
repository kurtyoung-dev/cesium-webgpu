/**
 * WebGPU Dynamic Environment Map Manager
 *
 * Audit A.12 (Batch 131) -- replaces the placeholder mid-grey fill
 * with a procedural Hosek-Wilkie-style sky compute pass that paints
 * all 6 cubemap faces, then invokes the existing
 * `WebGPUIBLPipeline.generateIBLMaps` to produce prefiltered
 * irradiance + radiance for IBL consumption. Models without an
 * explicit `imageBasedLighting.specularEnvironmentMaps` get a real
 * diffuse + specular reflection out of the box.
 *
 * The procedural sky is sun/zenith/ground gradient + sun disc; not a
 * full atmospheric capture (which would require routing the WebGPU
 * sky/atmosphere/sun renderers through 6 cubemap faces -- tracked as
 * `NEW-DYNAMIC-ENVMAP-SCENE-CAPTURE` in DEFERRED_WORK). The procedural
 * fill gives correct directional-IBL relationships (bright top, dim
 * bottom, sun-driven specular highlights) at near-zero cost.
 *
 * @module WebGPUDynamicEnvironmentMapManager
 */

import ProceduralSkyCubemapWGSL from "../../Shaders/WebGPU/Compute/ProceduralSkyCubemap.js";
import { generateIBLMaps } from "./WebGPUIBLPipeline.js";
import type { IBLPipelineCache } from "./WebGPUIBLPipeline.js";

/** Minimal interface for the upstream DynamicEnvironmentMapManager. */
interface DynEnvMapManagerLike {
  _mipmapLevels: number;
  enabled: boolean;
  shouldUpdate: boolean;
  _position: CesiumCartesian3;
  _shouldRegenerateShaders: boolean;
  _webgpuCache?: DynEnvMapCache;
  _cubemapSize?: number;
  _radianceMap?: {
    _webgpuTexture: GPUTexture | null;
    _webgpuTextureView: GPUTextureView | null;
    _webgpuSampler: GPUSampler | null;
  } | null;
  // Audit A.12 (Batch 131) -- prefiltered IBL views exposed for the
  // model material BG. Read by `buildModelIBLEntries` in
  // `WebGPUModelRenderer` when the model has no explicit IBL set up.
  _webgpuIBLDiffuseView?: GPUTextureView | null;
  _webgpuIBLSpecularView?: GPUTextureView | null;
  _webgpuIBLSampler?: GPUSampler | null;
  _webgpuIBLMaxMipLevel?: number;
  // Optional sky tuning. When undefined the manager uses sensible
  // studio-HDR defaults (warm zenith, cool ground, white sun).
  skyColor?: { red: number; green: number; blue: number };
  groundColor?: { red: number; green: number; blue: number };
}

interface DynEnvMapCache {
  cubemapTexture: GPUTexture | null;
  cubemapTextureView: GPUTextureView | null;
  faceViews: GPUTextureView[];
  // Audit A.12 (Batch 131) -- 2d-array view of the cubemap (dimension
  // "2d-array") used as the storage-texture write target for the
  // procedural sky compute. Distinct from `cubemapTextureView`
  // (dimension "cube") which is used by IBL prefilter as a source.
  storageView: GPUTextureView | null;
  sampler: GPUSampler | null;
  size: number;
  mipmapLevels: number;
  needsUpdate: boolean;
  framesSinceUpdate: number;
  // Audit re-review (Batch 134) -- last sun direction the procedural
  // sky was rendered against. The update path re-runs the sky +
  // prefilter when the current sun direction differs from this by
  // more than `SUN_REFRESH_EPSILON` so day/night cycles refresh the
  // cubemap without burning compute every frame. NaN sentinel forces
  // the first-frame re-run.
  lastSunDirX: number;
  lastSunDirY: number;
  lastSunDirZ: number;
  // Audit A.12 (Batch 131) -- compute pipeline for procedural sky
  // fill + uniform buffer + bind group. Kept on the cache so device
  // creation costs are paid once.
  skyPipeline: GPUComputePipeline | null;
  skyBGL: GPUBindGroupLayout | null;
  skyUniformBuffer: GPUBuffer | null;
  skyBindGroup: GPUBindGroup | null;
  // Audit A.12 (Batch 131) -- IBL prefilter cache. Reuses the
  // existing `IBLPipelineCache` shape from `WebGPUIBLPipeline.ts` so
  // the prefilter runs through the same compute pipelines as
  // explicit-source IBL.
  iblCache: IBLPipelineCache | null;
}

/**
 * Update WebGPU dynamic environment map resources.
 * Creates cubemap textures and schedules re-rendering when needed.
 */
function updateWebGPUDynamicEnvironmentMap(
  manager: DynEnvMapManagerLike,
  frameState: CesiumFrameState,
): void {
  const context = frameState.context;
  const device: GPUDevice = context.device;
  const mode = frameState.mode;

  // Check basic support conditions
  const isSupported = manager._mipmapLevels >= 1;
  if (
    !isSupported ||
    !manager.enabled ||
    !manager.shouldUpdate ||
    !manager._position ||
    mode === 0 // SceneMode.MORPHING (mirror DynamicEnvironmentMapManager.js:268)
  ) {
    manager._shouldRegenerateShaders = false;
    return;
  }

  if (!manager._webgpuCache) {
    manager._webgpuCache = {
      cubemapTexture: null,
      cubemapTextureView: null,
      faceViews: [],
      storageView: null,
      sampler: null,
      size: 0,
      mipmapLevels: 0,
      needsUpdate: true,
      framesSinceUpdate: 0,
      lastSunDirX: NaN,
      lastSunDirY: NaN,
      lastSunDirZ: NaN,
      skyPipeline: null,
      skyBGL: null,
      skyUniformBuffer: null,
      skyBindGroup: null,
      iblCache: null,
    } as DynEnvMapCache;
  }

  const cache = manager._webgpuCache as DynEnvMapCache;
  const size = manager._cubemapSize || 256;
  const mipmapLevels = manager._mipmapLevels || 1;

  // Create/recreate cubemap if size changed
  if (cache.size !== size || cache.mipmapLevels !== mipmapLevels) {
    if (cache.cubemapTexture) {
      cache.cubemapTexture.destroy();
    }

    const mipLevelCount = Math.max(1, mipmapLevels);

    cache.cubemapTexture = device.createTexture({
      size: { width: size, height: size, depthOrArrayLayers: 6 },
      format: "rgba8unorm",
      mipLevelCount,
      // Audit A.12 (Batch 131) -- adds STORAGE_BINDING so the
      // procedural sky compute pass can write directly into the
      // cubemap. The IBL prefilter consumes the same texture as
      // TEXTURE_BINDING via the cube view.
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_DST,
      dimension: "2d",
    });

    cache.cubemapTextureView = cache.cubemapTexture.createView({
      dimension: "cube",
    });

    // Audit A.12 -- 2d-array view for storage-write from the compute
    // shader. WebGPU requires the storage binding's view dimension to
    // match the BGL declaration; "cube" isn't valid for storage.
    cache.storageView = cache.cubemapTexture.createView({
      dimension: "2d-array",
      baseMipLevel: 0,
      mipLevelCount: 1,
    });

    // Create per-face views for rendering into each face
    cache.faceViews = [];
    for (let face = 0; face < 6; face++) {
      cache.faceViews.push(
        cache.cubemapTexture.createView({
          dimension: "2d",
          baseArrayLayer: face,
          arrayLayerCount: 1,
          baseMipLevel: 0,
          mipLevelCount: 1,
        }),
      );
    }

    cache.size = size;
    cache.mipmapLevels = mipmapLevels;
    cache.needsUpdate = true;
    // Force pipeline rebuild on size change (BGL/pipeline don't depend
    // on size but the bind group references the storage view which DID
    // change, so rebuild it).
    cache.skyBindGroup = null;
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

  // Audit A.12 (Batch 131) + re-review (Batch 134) -- procedural sky
  // compute pass + IBL prefilter. Runs when:
  //   1. cubemap was just (re)created (`cache.needsUpdate`), OR
  //   2. sun direction has moved by more than `SUN_REFRESH_EPSILON`
  //      since the last fill (day/night cycle refresh).
  // The squared-distance check is cheap (3 mults + 2 adds + sqrt-skip)
  // so this runs every frame; the actual compute + prefilter is
  // gated by the threshold.
  const sunDir = (
    frameState.context as unknown as {
      uniformState?: { sunDirectionWC?: { x: number; y: number; z: number } };
    }
  ).uniformState?.sunDirectionWC ?? { x: 0.3, y: 0.0, z: 0.95 };
  const dx = sunDir.x - cache.lastSunDirX;
  const dy = sunDir.y - cache.lastSunDirY;
  const dz = sunDir.z - cache.lastSunDirZ;
  // NaN-against-anything is NaN -> coerces > epsilon, so the first
  // frame always runs.
  const sunMoved = !(dx * dx + dy * dy + dz * dz < SUN_REFRESH_EPSILON_SQ);
  if (cache.needsUpdate || sunMoved) {
    runProceduralSkyFill(device, cache, manager, frameState);
    runIBLPrefilter(device, cache, frameState);
    cache.needsUpdate = false;
    cache.lastSunDirX = sunDir.x;
    cache.lastSunDirY = sunDir.y;
    cache.lastSunDirZ = sunDir.z;
  }

  // Expose cubemap + prefiltered IBL views for shader consumption.
  manager._radianceMap = {
    _webgpuTexture: cache.cubemapTexture,
    _webgpuTextureView: cache.cubemapTextureView,
    _webgpuSampler: cache.sampler,
  };
  if (cache.iblCache) {
    manager._webgpuIBLDiffuseView = cache.iblCache.irradianceView;
    manager._webgpuIBLSpecularView = cache.iblCache.radianceView;
    manager._webgpuIBLSampler = cache.iblCache.sampler;
    // RADIANCE_MIP_LEVELS = 6 in WebGPUIBLPipeline; max mip index = 5.
    manager._webgpuIBLMaxMipLevel = 5;
  }

  cache.framesSinceUpdate++;
}

// Audit re-review (Batch 134) -- minimum sun-direction movement that
// triggers a sky + IBL refresh. (0.005)^2 ~= 0.3 degrees of arc on the
// unit sphere; small enough that day/night progressions feel smooth,
// large enough that a stationary scene doesn't burn a compute pass +
// IBL prefilter on every frame.
const SUN_REFRESH_EPSILON_SQ = 0.005 * 0.005;

// ─── Procedural sky compute pass (Audit A.12, Batch 131) ─────────────────
//
// Builds (lazily) and dispatches the procedural sky shader to fill the
// cubemap's 6 faces in a single dispatch (Z dimension == 6). The
// uniform encodes sun direction + sky/ground/sun colors; sun direction
// comes from `frameState.context.uniformState.sunDirectionWC` so the
// procedural sky tracks the scene's sun.

const SKY_UNIFORM_SIZE = 64; // 4 vec4 = 64 bytes (matches SkyUniforms)

function runProceduralSkyFill(
  device: GPUDevice,
  cache: DynEnvMapCache,
  manager: DynEnvMapManagerLike,
  frameState: CesiumFrameState,
): void {
  // Build pipeline + BGL once per cache.
  if (!cache.skyPipeline || !cache.skyBGL) {
    cache.skyBGL = device.createBindGroupLayout({
      label: "DynEnvMap Sky BGL",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: {
            access: "write-only",
            format: "rgba8unorm",
            viewDimension: "2d-array",
          },
        },
      ],
    });
    const layout = device.createPipelineLayout({
      label: "DynEnvMap Sky PipelineLayout",
      bindGroupLayouts: [cache.skyBGL],
    });
    const module = device.createShaderModule({
      label: "ProceduralSkyCubemap",
      code: ProceduralSkyCubemapWGSL,
    });
    cache.skyPipeline = device.createComputePipeline({
      label: "DynEnvMap Sky Pipeline",
      layout,
      compute: { module, entryPoint: "main" },
    });
  }

  // Lazy uniform buffer.
  if (!cache.skyUniformBuffer) {
    cache.skyUniformBuffer = device.createBuffer({
      label: "DynEnvMap Sky Uniforms",
      size: SKY_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  // Pull sun direction from the frame's uniformState; default to a
  // sensible mid-day "up and a bit east" if absent.
  const sunDir = (
    frameState.context as unknown as {
      uniformState?: { sunDirectionWC?: { x: number; y: number; z: number } };
    }
  ).uniformState?.sunDirectionWC ?? { x: 0.3, y: 0.0, z: 0.95 };

  const skyColor = manager.skyColor ?? { red: 0.45, green: 0.6, blue: 0.85 };
  const groundColor = manager.groundColor ?? {
    red: 0.18,
    green: 0.16,
    blue: 0.13,
  };
  const sunColor = { red: 1.0, green: 0.95, blue: 0.85 };

  const data = new Float32Array(16);
  data[0] = sunDir.x;
  data[1] = sunDir.y;
  data[2] = sunDir.z;
  data[3] = cache.size; // faceSize
  data[4] = skyColor.red;
  data[5] = skyColor.green;
  data[6] = skyColor.blue;
  // data[7] = _pad0
  data[8] = groundColor.red;
  data[9] = groundColor.green;
  data[10] = groundColor.blue;
  data[11] = 4.0; // sunIntensity
  data[12] = sunColor.red;
  data[13] = sunColor.green;
  data[14] = sunColor.blue;
  // data[15] = _pad1
  device.queue.writeBuffer(cache.skyUniformBuffer, 0, data);

  // (Re)build bind group when the storage view changed (size change
  // resets `skyBindGroup` to null in the texture-create path).
  if (!cache.skyBindGroup) {
    cache.skyBindGroup = device.createBindGroup({
      label: "DynEnvMap Sky BG",
      layout: cache.skyBGL,
      entries: [
        { binding: 0, resource: { buffer: cache.skyUniformBuffer } },
        { binding: 1, resource: cache.storageView! },
      ],
    });
  }

  // Dispatch: workgroup_size(8, 8, 1); grid covers face × face × 6.
  const groupsXY = Math.ceil(cache.size / 8);
  const encoder = device.createCommandEncoder({ label: "DynEnvMap Sky Pass" });
  const pass = encoder.beginComputePass();
  pass.setPipeline(cache.skyPipeline);
  pass.setBindGroup(0, cache.skyBindGroup);
  pass.dispatchWorkgroups(groupsXY, groupsXY, 6);
  pass.end();
  device.queue.submit([encoder.finish()]);
}

// ─── IBL prefilter trigger (Audit A.12, Batch 131) ───────────────────────
//
// Reuses `WebGPUIBLPipeline.generateIBLMaps` -- the same compute path
// that `WebGPUImageBasedLighting` runs for explicit-source IBL. The
// only difference is the source: here it's the procedural cubemap we
// just filled; for explicit IBL it's a user-supplied HDR cubemap.
function runIBLPrefilter(
  device: GPUDevice,
  cache: DynEnvMapCache,
  frameState: CesiumFrameState,
): void {
  if (!cache.iblCache) {
    cache.iblCache = {
      irradianceTexture: null,
      irradianceView: null,
      radianceTexture: null,
      radianceView: null,
      irradiancePipeline: null,
      radiancePipeline: null,
      irradianceBGL: null,
      radianceBGL: null,
      sampler: null,
      sourceVersion: -1,
    };
  }
  // Audit re-review (Batch 134) -- `generateIBLMaps` itself doesn't
  // read `sourceVersion` (only the explicit-IBL `WebGPUImageBasedLighting`
  // caller uses it as a regen gate), so the previous bump here was
  // dead. Existing C-P17 cleanup at `WebGPUIBLPipeline.ts:149/239`
  // destroys the old irradiance + radiance textures before recreating
  // them, so re-running prefilter on each sun-direction refresh does
  // not leak GPU memory.
  generateIBLMaps(
    device,
    cache.iblCache,
    cache.cubemapTextureView!,
    (
      frameState.context as unknown as {
        webgpuComputePipelineCache?: import("./WebGPUComputePipelineCache.js").WebGPUComputePipelineCache;
      }
    ).webgpuComputePipelineCache ?? null,
  );
}

/**
 * Destroy WebGPU dynamic environment map resources.
 */
function destroyWebGPUDynamicEnvironmentMapResources(
  manager: DynEnvMapManagerLike,
): void {
  const cache = manager._webgpuCache as DynEnvMapCache | undefined;
  if (!cache) {
    return;
  }

  if (cache.cubemapTexture) {
    cache.cubemapTexture.destroy();
  }
  if (cache.skyUniformBuffer) {
    cache.skyUniformBuffer.destroy();
  }
  if (cache.iblCache) {
    if (cache.iblCache.irradianceTexture) {
      cache.iblCache.irradianceTexture.destroy();
    }
    if (cache.iblCache.radianceTexture) {
      cache.iblCache.radianceTexture.destroy();
    }
  }

  manager._webgpuCache = undefined;
  manager._webgpuIBLDiffuseView = null;
  manager._webgpuIBLSpecularView = null;
  manager._webgpuIBLSampler = null;
}

export {
  updateWebGPUDynamicEnvironmentMap,
  destroyWebGPUDynamicEnvironmentMapResources,
};
export default {
  updateWebGPUDynamicEnvironmentMap,
  destroyWebGPUDynamicEnvironmentMapResources,
};
