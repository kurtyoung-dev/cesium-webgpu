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
import ProjectRadianceToSHWGSL from "../../Shaders/WebGPU/Compute/ProjectRadianceToSH.js";
import Cartesian3 from "../../Core/Cartesian3.js";
import Transforms from "../../Core/Transforms.js";
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
  // NEW-WEBGPU-KHR-SPECULAR-IBL-OVERBRIGHT (Batch 354) -- atmosphere-derived
  // diffuse-IBL spherical-harmonic coefficients (9 vec4 + control vec4),
  // projected from the radiance cube. Bound by `buildModelIBLEntries` at
  // SHUniforms binding 36 so models evaluate SH instead of sampling the
  // irradiance cubemap (matching WebGL's czm_sphericalHarmonics path).
  _webgpuSHBuffer?: GPUBuffer | null;
  // Optional sky tuning. When undefined the manager uses sensible
  // studio-HDR defaults (warm zenith, cool ground, white sun).
  skyColor?: { red: number; green: number; blue: number };
  groundColor?: { red: number; green: number; blue: number };
  // NEW-MODEL-PBR-DIRECT-LIGHT-IBL-PARITY D1 — atmosphere-derived sky
  // fill needs the same lighting controls the WebGL ComputeRadianceMapFS
  // reads from the manager. These live on the upstream
  // DynamicEnvironmentMapManager (defaults: 2.0 / 1.0 / 0.31).
  atmosphereScatteringIntensity?: number;
  gamma?: number;
  groundAlbedo?: number;
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
  // Item 1.2 (IBL-HDR, Batch 426) — the env-cube texture format the
  // current resources were built against. `undefined` until the first
  // create; flipping `hdrEnvironmentMap` changes this, triggering a full
  // texture + sky-pipeline + sky-BGL rebuild (the format token is baked
  // into all three). Parity default is "rgba8unorm".
  cubemapFormat?: GPUTextureFormat;
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
  // NEW-WEBGPU-KHR-SPECULAR-IBL-OVERBRIGHT (Batch 354) -- SH-L2 projection
  // pass. Pipeline + BGL are built once; `shBuffer` (9 vec4 + control,
  // STORAGE|UNIFORM) receives the projected coefficients and is published
  // as `manager._webgpuSHBuffer`. `shParamBuffer` carries the
  // atmosphereScatteringIntensity second-multiply. `shBindGroup` is reset
  // to null on cube recreation (the cube view it references changes).
  shPipeline: GPUComputePipeline | null;
  shBGL: GPUBindGroupLayout | null;
  shBuffer: GPUBuffer | null;
  shParamBuffer: GPUBuffer | null;
  shBindGroup: GPUBindGroup | null;
  // Item 2.2 (ENV-AERIAL-MS, Batch 430) — sun-relative sky-view + MS LUT
  // sampler + a 1×1 white placeholder texture/view. The sky compute pass binds
  // the real LUT views (shared from the perf manager) when `envMapMultiScatter`
  // is on; otherwise it binds the placeholder so the BGL + bind group stay
  // constant (and the WGSL `useMultiScatterLut` flag keeps them unsampled →
  // byte-identical parity). The LUT views the bind group was last built against
  // are tracked so it rebuilds when they first appear / change.
  lutSampler: GPUSampler | null;
  lutPlaceholderTex: GPUTexture | null;
  lutPlaceholderView: GPUTextureView | null;
  lutSkyViewView: GPUTextureView | null;
  lutMsView: GPUTextureView | null;
  // Item 2.2 — whether the LAST sky fill used the LUT path. When the effective
  // LUT-path availability flips (flag toggled, or the LUTs finished baking a
  // frame after the first fill), force a re-fill so the cube isn't stuck on the
  // wrong path on a static (non-sun-moving) scene.
  lastUsedMultiScatterLut: boolean;
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
      shPipeline: null,
      shBGL: null,
      shBuffer: null,
      shParamBuffer: null,
      shBindGroup: null,
      lutSampler: null,
      lutPlaceholderTex: null,
      lutPlaceholderView: null,
      lutSkyViewView: null,
      lutMsView: null,
      lastUsedMultiScatterLut: false,
    } as DynEnvMapCache;
  }

  const cache = manager._webgpuCache as DynEnvMapCache;
  const size = manager._cubemapSize || 256;
  const mipmapLevels = manager._mipmapLevels || 1;

  // Item 1.2 (IBL-HDR, Batch 426) — opt-in HDR env cube. Default false →
  // `rgba8unorm` (WebGL-parity, byte-identical). True → `rgba16float` so
  // the HDR sun disc + bright sky survive into the GGX prefilter. Read
  // off the WebGPU context's `hdrEnvironmentMap` getter (threaded from
  // `contextOptions.webgpu.hdrEnvironmentMap`). rgba16float is in core
  // WebGPU's storage-write-capable + render-attachment list, so the same
  // STORAGE_BINDING | RENDER_ATTACHMENT usage stays valid.
  const hdrEnvironmentMap =
    (
      context as unknown as {
        hdrEnvironmentMap?: boolean;
      }
    ).hdrEnvironmentMap === true;
  const cubemapFormat: GPUTextureFormat = hdrEnvironmentMap
    ? "rgba16float"
    : "rgba8unorm";

  // Create/recreate cubemap if size changed OR the HDR-format flag flipped.
  // The format is baked into the texture, the sky storage BGL, and the sky
  // pipeline's shader-module format token, so all three rebuild together.
  if (
    cache.size !== size ||
    cache.mipmapLevels !== mipmapLevels ||
    cache.cubemapFormat !== cubemapFormat
  ) {
    if (cache.cubemapTexture) {
      cache.cubemapTexture.destroy();
    }

    const mipLevelCount = Math.max(1, mipmapLevels);

    cache.cubemapTexture = device.createTexture({
      size: { width: size, height: size, depthOrArrayLayers: 6 },
      format: cubemapFormat,
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
    // Item 1.2 (Batch 426) — if the HDR format flipped, the sky storage
    // BGL + pipeline encode the storage-texture format token, so force a
    // full pipeline rebuild (not just the bind group). The recreate
    // condition above already covers the format-change case.
    if (cache.cubemapFormat !== cubemapFormat) {
      cache.skyPipeline = null;
      cache.skyBGL = null;
    }
    cache.cubemapFormat = cubemapFormat;
    cache.needsUpdate = true;
    // Force pipeline rebuild on size change (BGL/pipeline don't depend
    // on size but the bind group references the storage view which DID
    // change, so rebuild it).
    cache.skyBindGroup = null;
    // SH bind group references the recreated cube view -- rebuild it too.
    cache.shBindGroup = null;
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
  // Item 2.2 (ENV-AERIAL-MS, Batch 430) — re-fill when the effective LUT-path
  // availability flips so a static (non-sun-moving) scene isn't stuck on the
  // wrong path. `wantLut` mirrors the predicate `runProceduralSkyFill` uses
  // (context flag on AND dynamic lighting non-NONE); if the LUTs aren't baked
  // yet the fill falls back to the placeholder and leaves `lastUsed...` false,
  // so this keeps re-trying until the LUTs land, then settles.
  const wantLut =
    (frameState.context as unknown as { envMapMultiScatter?: boolean })
      .envMapMultiScatter === true &&
    (frameState.atmosphere?.dynamicLighting ?? 0) !== 0;
  const lutPathChanged = wantLut !== cache.lastUsedMultiScatterLut;
  if (cache.needsUpdate || sunMoved || lutPathChanged) {
    runProceduralSkyFill(device, cache, manager, frameState);
    runIBLPrefilter(device, cache, frameState);
    // NEW-WEBGPU-KHR-SPECULAR-IBL-OVERBRIGHT (Batch 354) -- project the
    // freshly-filled radiance cube to SH-L2. Submitted after the sky fill
    // so the queue serializes the cube write before this read.
    runSphericalHarmonicProjection(device, cache, manager);
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
  // NEW-WEBGPU-KHR-SPECULAR-IBL-OVERBRIGHT (Batch 354) -- expose the SH
  // coefficient buffer for `buildModelIBLEntries`. Present once the first
  // projection has run; the buffer's own control.w gate keeps it inert
  // until the compute pass populates it.
  if (cache.shBuffer) {
    manager._webgpuSHBuffer = cache.shBuffer;
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

// NEW-MODEL-PBR-DIRECT-LIGHT-IBL-PARITY D1 — atmosphere-derived sky
// fill. The SkyUniforms struct is now 9 vec4 = 144 bytes. Byte-exact
// lockstep with `ProceduralSkyCubemap.wgsl`'s SkyUniforms (WGSL uniform
// layout: each vec3 occupies a 16-byte slot, the trailing f32 packs into
// the slot's 4th lane). Float32Array index = byte offset / 4:
//   0..2  positionWC      3  faceSize
//   4..6  enuX            7  innerRadius
//   8..10 enuY           11  outerRadius
//   12..14 enuZ          15  intensity (atmosphere.lightIntensity)
//   16..18 sunDirectionWC 19 gamma
//   20..22 rayleighCoeff  23 mieAnisotropy
//   24..26 mieCoeff       27 rayleighScaleHeight
//   28..30 groundColor    31 mieScaleHeight
//   32 groundAlbedo  33 dynamicLightingEnum  34 scatteringIntensity  35 _pad0
const SKY_UNIFORM_SIZE = 144;
const SKY_UNIFORM_FLOATS = 36;

// Reused scratch so the per-fill pack does not allocate.
const scratchPosition = new Cartesian3();
// Default Atmosphere.js scattering terms (used when frameState.atmosphere
// omits a field, mirroring the WebGL automatic-uniform fallbacks).
const DEFAULT_RAYLEIGH_COEFFICIENT = { x: 5.5e-6, y: 13.0e-6, z: 28.4e-6 };
const DEFAULT_MIE_COEFFICIENT = { x: 21e-6, y: 21e-6, z: 21e-6 };
const DEFAULT_RAYLEIGH_SCALE_HEIGHT = 10000.0;
const DEFAULT_MIE_SCALE_HEIGHT = 3200.0;
const DEFAULT_MIE_ANISOTROPY = 0.9;
const DEFAULT_LIGHT_INTENSITY = 10.0;
// czm_computeScattering's ATMOSPHERE_THICKNESS (AtmosphereCommon.glsl).
const ATMOSPHERE_THICKNESS = 111000.0;

function runProceduralSkyFill(
  device: GPUDevice,
  cache: DynEnvMapCache,
  manager: DynEnvMapManagerLike,
  frameState: CesiumFrameState,
): void {
  // Build pipeline + BGL once per cache.
  if (!cache.skyPipeline || !cache.skyBGL) {
    // Item 1.2 (IBL-HDR, Batch 426) — the storage-texture format token
    // must match the env-cube texture format. Parity default
    // "rgba8unorm" → byte-identical BGL + the unmodified
    // `ProceduralSkyCubemap.wgsl` string (which declares `rgba8unorm`).
    // HDR-on → "rgba16float" in the BGL AND a single in-place swap of the
    // WGSL `texture_storage_2d_array<...>` format token (the storage
    // format is a static token; the `//>>ifdef` preprocessor only gates
    // executable lines, not the storage decl, so a scoped string replace
    // is the correct lever here).
    const storageFormat: GPUTextureFormat = cache.cubemapFormat ?? "rgba8unorm";
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
            format: storageFormat,
            viewDimension: "2d-array",
          },
        },
        // Item 2.2 (ENV-AERIAL-MS, Batch 430) — sun-relative sky-view + MS LUT
        // sampler + textures. Bound unconditionally (placeholder when off) so
        // the BGL/pipeline layout never changes.
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          sampler: { type: "filtering" },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: "float", viewDimension: "2d" },
        },
        {
          binding: 4,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: "float", viewDimension: "2d" },
        },
      ],
    });
    const layout = device.createPipelineLayout({
      label: "DynEnvMap Sky PipelineLayout",
      bindGroupLayouts: [cache.skyBGL],
    });
    const skyCode =
      storageFormat === "rgba8unorm"
        ? ProceduralSkyCubemapWGSL
        : ProceduralSkyCubemapWGSL.replace(
            "texture_storage_2d_array<rgba8unorm, write>",
            "texture_storage_2d_array<rgba16float, write>",
          );
    const module = device.createShaderModule({
      label: "ProceduralSkyCubemap",
      code: skyCode,
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

  // ── Atmosphere-derived uniforms (mirrors ComputeRadianceMapFS) ──
  //
  // Sun direction: SUNLIGHT uses frameState.sunDirectionWC; SCENE_LIGHT
  // uses uniformState.lightDirectionWC; NONE (default) resolves to the
  // local zenith per-direction inside the shader (so sunDirectionWC is a
  // safe placeholder on that path).
  const uniformState = (
    frameState.context as unknown as {
      uniformState?: {
        sunDirectionWC?: { x: number; y: number; z: number };
        lightDirectionWC?: { x: number; y: number; z: number };
      };
    }
  ).uniformState;
  const sceneLight = uniformState?.lightDirectionWC;
  const sunDir = uniformState?.sunDirectionWC ??
    frameState.sunDirectionWC ?? { x: 0.3, y: 0.0, z: 0.95 };

  const atmosphere = frameState.atmosphere;
  const rayleighCoefficient =
    atmosphere?.rayleighCoefficient ?? DEFAULT_RAYLEIGH_COEFFICIENT;
  const mieCoefficient = atmosphere?.mieCoefficient ?? DEFAULT_MIE_COEFFICIENT;
  const rayleighScaleHeight =
    atmosphere?.rayleighScaleHeight ?? DEFAULT_RAYLEIGH_SCALE_HEIGHT;
  const mieScaleHeight = atmosphere?.mieScaleHeight ?? DEFAULT_MIE_SCALE_HEIGHT;
  const mieAnisotropy = atmosphere?.mieAnisotropy ?? DEFAULT_MIE_ANISOTROPY;
  const lightIntensity = atmosphere?.lightIntensity ?? DEFAULT_LIGHT_INTENSITY;
  const dynamicLighting = atmosphere?.dynamicLighting ?? 0;
  // When dynamicLighting === SCENE_LIGHT, feed the scene light vector as
  // the "sun" the shader uses; the shader's NONE/SUNLIGHT paths use the
  // packed sunDirectionWC / local zenith respectively.
  const lightVec = dynamicLighting === 1 && sceneLight ? sceneLight : sunDir;

  // Position + ENU->fixed basis (WGS84 default, matching the WebGL
  // DynamicEnvironmentMapManager). Inner radius = position magnitude
  // (the model's surface radius); outer = inner + 111 km, matching
  // czm_computeScattering's ATMOSPHERE_THICKNESS.
  const position = manager._position;
  scratchPosition.x = position.x;
  scratchPosition.y = position.y;
  scratchPosition.z = position.z;
  const innerRadius = Cartesian3.magnitude(scratchPosition);
  const outerRadius = innerRadius + ATMOSPHERE_THICKNESS;
  const enu = Transforms.eastNorthUpToFixedFrame(scratchPosition);

  const skyColorScattering = manager.atmosphereScatteringIntensity ?? 2.0;
  const gamma = manager.gamma ?? 1.0;
  const groundColor = manager.groundColor ?? {
    red: 0.45,
    green: 0.45,
    blue: 0.27,
  };
  const groundAlbedo = manager.groundAlbedo ?? 0.31;

  // Item 2.2 (ENV-AERIAL-MS, Batch 430) — opt-in: source the sky color from
  // the sun-relative sky-view + MS LUTs (the SAME tables the visible
  // SkyAtmosphere samples) instead of the inline march, so reflected env sky
  // matches the visible MS sky. Read off the context's getter (threaded from
  // `contextOptions.webgpu.envMapMultiScatter`). The LUT path is gated in the
  // shader to non-NONE dynamic lighting (it bakes a single light direction);
  // when dynamicLighting is NONE (the default smooth ambient) we leave the flag
  // off so the radially-symmetric inline march keeps the at-rest IBL look.
  const ctx = frameState.context as unknown as {
    envMapMultiScatter?: boolean;
    performanceManager?: {
      ensureAtmosphereLUTResources?: (d: GPUDevice) => {
        skyViewView?: GPUTextureView;
        multipleScatterView?: GPUTextureView;
      } | null;
    };
  };
  let lutSkyViewView: GPUTextureView | null = null;
  let lutMsView: GPUTextureView | null = null;
  if (ctx.envMapMultiScatter === true && dynamicLighting !== 0) {
    const lutRes =
      ctx.performanceManager?.ensureAtmosphereLUTResources?.(device);
    lutSkyViewView = lutRes?.skyViewView ?? null;
    lutMsView = lutRes?.multipleScatterView ?? null;
  }
  // The shader path is active only when both real LUT views are bound. When off
  // (or the LUTs aren't baked yet) the 1×1 placeholder is bound and the flag is
  // 0 → byte-identical inline march.
  const useMultiScatterLut = lutSkyViewView !== null && lutMsView !== null;
  // Record the effective path so the update gate re-fills when it flips (e.g.
  // the LUTs finish baking a frame after the first fill on a static scene).
  cache.lastUsedMultiScatterLut = useMultiScatterLut;

  const data = new Float32Array(SKY_UNIFORM_FLOATS);
  // positionWC + faceSize
  data[0] = position.x;
  data[1] = position.y;
  data[2] = position.z;
  data[3] = cache.size;
  // enuX (column 0: East) + innerRadius
  data[4] = enu[0];
  data[5] = enu[1];
  data[6] = enu[2];
  data[7] = innerRadius;
  // enuY (column 1: North) + outerRadius
  data[8] = enu[4];
  data[9] = enu[5];
  data[10] = enu[6];
  data[11] = outerRadius;
  // enuZ (column 2: Up) + intensity (atmosphere.lightIntensity)
  data[12] = enu[8];
  data[13] = enu[9];
  data[14] = enu[10];
  data[15] = lightIntensity;
  // sunDirectionWC + gamma
  data[16] = lightVec.x;
  data[17] = lightVec.y;
  data[18] = lightVec.z;
  data[19] = gamma;
  // rayleighCoefficient + mieAnisotropy
  data[20] = rayleighCoefficient.x;
  data[21] = rayleighCoefficient.y;
  data[22] = rayleighCoefficient.z;
  data[23] = mieAnisotropy;
  // mieCoefficient + rayleighScaleHeight
  data[24] = mieCoefficient.x;
  data[25] = mieCoefficient.y;
  data[26] = mieCoefficient.z;
  data[27] = rayleighScaleHeight;
  // groundColor + mieScaleHeight
  data[28] = groundColor.red;
  data[29] = groundColor.green;
  data[30] = groundColor.blue;
  data[31] = mieScaleHeight;
  // groundAlbedo, dynamicLightingEnum, scatteringIntensity, useMultiScatterLut
  data[32] = groundAlbedo;
  data[33] = dynamicLighting;
  data[34] = skyColorScattering;
  // Item 2.2 (ENV-AERIAL-MS, Batch 430) — the WGSL flag (was _pad0). 1 only
  // when the real LUT views are bound; 0 (default / LUTs unbaked) → the inline
  // march, byte-identical parity.
  data[35] = useMultiScatterLut ? 1.0 : 0.0;
  device.queue.writeBuffer(cache.skyUniformBuffer, 0, data);

  // Item 2.2 (ENV-AERIAL-MS, Batch 430) — LUT sampler + 1×1 white placeholder
  // (built once). The placeholder backs bindings 3/4 whenever the real sky-view
  // / MS LUT views aren't available, keeping the bind group valid + constant.
  if (!cache.lutSampler) {
    cache.lutSampler = device.createSampler({
      label: "DynEnvMap LUT Sampler",
      minFilter: "linear",
      magFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
  }
  if (!cache.lutPlaceholderView) {
    cache.lutPlaceholderTex = device.createTexture({
      label: "DynEnvMap LUT Placeholder",
      size: { width: 1, height: 1 },
      format: "rgba16float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    // rgba16float black (0) — never sampled when the flag is off, so the value
    // is irrelevant to parity; zero is the safe inert default.
    const zero = new Uint16Array([0, 0, 0, 0]);
    device.queue.writeTexture(
      { texture: cache.lutPlaceholderTex },
      zero,
      { bytesPerRow: 8 },
      { width: 1, height: 1 },
    );
    cache.lutPlaceholderView = cache.lutPlaceholderTex.createView();
  }
  const boundSkyView = lutSkyViewView ?? cache.lutPlaceholderView;
  const boundMsView = lutMsView ?? cache.lutPlaceholderView;

  // (Re)build bind group when the storage view changed (size change resets
  // `skyBindGroup` to null in the texture-create path) OR when the bound LUT
  // views change (they first appear once the atmosphere LUTs are baked).
  if (
    !cache.skyBindGroup ||
    cache.lutSkyViewView !== boundSkyView ||
    cache.lutMsView !== boundMsView
  ) {
    cache.skyBindGroup = device.createBindGroup({
      label: "DynEnvMap Sky BG",
      layout: cache.skyBGL,
      entries: [
        { binding: 0, resource: { buffer: cache.skyUniformBuffer } },
        { binding: 1, resource: cache.storageView! },
        { binding: 2, resource: cache.lutSampler },
        { binding: 3, resource: boundSkyView },
        { binding: 4, resource: boundMsView },
      ],
    });
    cache.lutSkyViewView = boundSkyView;
    cache.lutMsView = boundMsView;
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

// ─── SH-L2 projection pass (Batch 354) ───────────────────────────────────
//
// NEW-WEBGPU-KHR-SPECULAR-IBL-OVERBRIGHT. Projects the freshly-filled
// radiance cube onto 9 SH-L2 coefficients and writes them (×
// atmosphereScatteringIntensity, WebGL's step-3 multiply) into a
// STORAGE|UNIFORM buffer the model binds at SHUniforms binding 36. Mirrors
// WebGL's `ComputeIrradianceFS` + `updateSphericalHarmonicCoefficients`,
// but writes the buffer directly instead of a render-to-texture + readback.
function runSphericalHarmonicProjection(
  device: GPUDevice,
  cache: DynEnvMapCache,
  manager: DynEnvMapManagerLike,
): void {
  if (!cache.cubemapTextureView || !cache.sampler) {
    return;
  }

  // Build pipeline + BGL once per cache.
  if (!cache.shPipeline || !cache.shBGL) {
    cache.shBGL = device.createBindGroupLayout({
      label: "DynEnvMap SH BGL",
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
          buffer: { type: "storage" },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "uniform" },
        },
      ],
    });
    const layout = device.createPipelineLayout({
      label: "DynEnvMap SH PipelineLayout",
      bindGroupLayouts: [cache.shBGL],
    });
    const module = device.createShaderModule({
      label: "ProjectRadianceToSH",
      code: ProjectRadianceToSHWGSL,
    });
    cache.shPipeline = device.createComputePipeline({
      label: "DynEnvMap SH Pipeline",
      layout,
      compute: { module, entryPoint: "main" },
    });
  }

  // SH output buffer: 9 vec4 coeffs + 1 vec4 control = 160 bytes. STORAGE
  // for the compute write, UNIFORM so the model binds it as SHUniforms.
  if (!cache.shBuffer) {
    cache.shBuffer = device.createBuffer({
      label: "DynEnvMap SH Coefficients",
      size: 160,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.UNIFORM |
        GPUBufferUsage.COPY_DST,
    });
  }

  // Param uniform: atmosphereScatteringIntensity in .x (16-byte minimum).
  if (!cache.shParamBuffer) {
    cache.shParamBuffer = device.createBuffer({
      label: "DynEnvMap SH Params",
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }
  const intensity = manager.atmosphereScatteringIntensity ?? 2.0;
  device.queue.writeBuffer(
    cache.shParamBuffer,
    0,
    new Float32Array([intensity, 0.0, 0.0, 0.0]),
  );

  // (Re)build bind group when the cube view changed (cube recreate resets
  // shBindGroup to null).
  if (!cache.shBindGroup) {
    cache.shBindGroup = device.createBindGroup({
      label: "DynEnvMap SH BG",
      layout: cache.shBGL,
      entries: [
        { binding: 0, resource: cache.cubemapTextureView },
        { binding: 1, resource: cache.sampler },
        { binding: 2, resource: { buffer: cache.shBuffer } },
        { binding: 3, resource: { buffer: cache.shParamBuffer } },
      ],
    });
  }

  // Dispatch 1 workgroup of 9 invocations (one coefficient each).
  const encoder = device.createCommandEncoder({ label: "DynEnvMap SH Pass" });
  const pass = encoder.beginComputePass();
  pass.setPipeline(cache.shPipeline);
  pass.setBindGroup(0, cache.shBindGroup);
  pass.dispatchWorkgroups(1, 1, 1);
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
  // Item 1.3 (IBL-PREFILTER-HQ, Batch 426) — opt-in high-quality prefilter.
  // Default 'parity' → pass `undefined` so `generateIBLMaps` takes the
  // byte-identical mip-0 path (no source-mip pass, `main` entry point).
  // 'high' → pass the source cube + format so the prefilter box-downsamples
  // the source mip chain and samples a GGX-pdf-derived LOD (`mainHQ`).
  const quality =
    (
      frameState.context as unknown as {
        iblPrefilterQuality?: "parity" | "high";
      }
    ).iblPrefilterQuality ?? "parity";
  const hqOptions =
    quality === "high"
      ? {
          quality: "high" as const,
          sourceCube: cache.cubemapTexture,
          sourceFormat:
            cache.cubemapFormat ?? ("rgba8unorm" as GPUTextureFormat),
        }
      : undefined;
  generateIBLMaps(
    device,
    cache.iblCache,
    cache.cubemapTextureView!,
    (
      frameState.context as unknown as {
        webgpuComputePipelineCache?: import("./WebGPUComputePipelineCache.js").WebGPUComputePipelineCache;
      }
    ).webgpuComputePipelineCache ?? null,
    hqOptions,
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
  // Item 2.2 (ENV-AERIAL-MS, Batch 430) — the manager owns only the 1×1 LUT
  // placeholder; the real sky-view / MS LUT textures are owned by the perf
  // manager and must NOT be destroyed here.
  if (cache.lutPlaceholderTex) {
    cache.lutPlaceholderTex.destroy();
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
