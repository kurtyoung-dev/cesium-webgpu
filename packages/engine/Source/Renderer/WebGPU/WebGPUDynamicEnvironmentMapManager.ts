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
import CloudDensityDomainWGSL from "../../Shaders/WebGPU/Environment/CloudDensityDomain.js";
import ProjectRadianceToSHWGSL from "../../Shaders/WebGPU/Compute/ProjectRadianceToSH.js";
import EnvCubeTemporalBlendWGSL from "../../Shaders/WebGPU/Compute/EnvCubeTemporalBlend.js";
import Cartesian3 from "../../Core/Cartesian3.js";
import Transforms from "../../Core/Transforms.js";
import {
  createIBLCommandEncodingScope,
  destroyIBLCommandEncodingScope,
  generateIBLMaps,
  getIBLRefreshParameterCapacity,
  submitIBLCommandEncodingScope,
} from "./WebGPUIBLPipeline.js";
import type {
  IBLCommandEncodingScope,
  IBLPipelineCache,
  RadianceHQOptions,
} from "./WebGPUIBLPipeline.js";
import {
  getRenderableSceneCaptureSourceRevision,
  runSceneCapture,
  SceneCaptureResult,
  type SceneCaptureCache,
  type SceneCaptureManager,
  type SceneCaptureResultValue,
} from "./WebGPUDynamicEnvironmentMapCapture.js";
import {
  resolveAtmosphereScattering,
  usesSceneLightDirection,
  type AtmosphereScatteringDefaults,
} from "./WebGPUAtmosphereUniforms.js";
import {
  CLOUD_DENSITY_ORIGIN_PHASE_FLOATS,
  writeCloudDensityAdvectedOriginPhases,
} from "./WebGPUCloudDensityDomain.js";

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
  // C2-25 ENV-SCENE-CAPTURE (Batch 446) — opt-in (WebGPU only). When true AND
  // `context.sceneCaptureReflections` is true, `runSceneCapture` renders the
  // opaque globe surface into the env cube's 6 faces so terrain reflects in
  // water / PBR models. Default false → no capture pass (byte-identical).
  enableSceneCapture?: boolean;
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
  // GPU objects are valid only for the device generation that created them.
  // Keep both identities: `device` catches replacement-device swaps directly,
  // while `resourceGeneration` follows WebGPUContext's recovery epoch even if
  // a future recovery implementation preserves a wrapper identity.
  device: GPUDevice;
  resourceGeneration: number;
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
  // Item 4.2 (CLOUD-IBL, Batch 441) — the effective cloud coverage the LAST sky
  // fill was packed with. The update gate re-fills when the live coverage moves
  // by more than `CLOUD_COVERAGE_REFRESH_EPSILON` so a static (non-sun-moving)
  // scene still re-darkens its IBL when cloud cover changes. NaN sentinel forces
  // the first-frame run (same convention as `lastSunDir*`).
  lastCloudCoverage: number;
  // C13-37 — monotonic revision of the complete cloud state used by the IBL
  // march. Coverage has its own epsilon gate above, but wind/time/deck/density/
  // morphology changes also alter the reflected formation. Tracking one
  // publisher-owned revision keeps that gate O(1) and edge-triggered.
  lastCloudRevision: number;
  // Item 3-C (CLOUD-IBL-FULL, Batch 450) — full per-face cloud march. A 1×1×1
  // white 3D placeholder + sampler back bindings 5/6/7 whenever the march is off
  // (or the cloud noise hasn't baked), mirroring the LUT placeholder. The bound
  // cloud-noise views/sampler the bind group was last built against are tracked
  // so it rebuilds when they first appear / flip with the march activation.
  cloudPlaceholderTex: GPUTexture | null;
  cloudPlaceholderView: GPUTextureView | null;
  cloudPlaceholderSampler: GPUSampler | null;
  cloudShapeBoundView: GPUTextureView | null;
  cloudDetailBoundView: GPUTextureView | null;
  cloudSamplerBound: GPUSampler | null;
  // Whether the LAST sky fill used the full cloud march. When this flips (flag
  // toggled, cloud noise finished baking, or coverage crossed 0) force a re-fill
  // so a static (non-sun-moving) scene isn't stuck on the wrong path.
  lastUsedCloudMarch: boolean;
  // C2-25 ENV-SCENE-CAPTURE (Batch 446) — transient `size×size` depth target
  // shared across the 6 capture face passes (cleared per face). Lazily
  // allocated INSIDE `runSceneCapture` (OFF allocates nothing) and reallocated
  // when `size` changes. Format `depth24plus` (no stencil) — matches the
  // capture pipeline variant, deliberately different from the on-screen
  // `depth24plus-stencil8`.
  captureDepthTexture: GPUTexture | null;
  captureDepthView: GPUTextureView | null;
  captureDepthSize: number;
  // C2-25 — frames since the last capture pass ran, for the every-K-frames
  // debounce (behind the capture flags, so OFF gating is byte-identical).
  framesSinceCapture: number;
  // C2-25 — world-space eye the last capture was run from, for the
  // camera-translation debounce. NaN sentinel forces the first capture.
  lastCaptureCameraX: number;
  lastCaptureCameraY: number;
  lastCaptureCameraZ: number;
  lastCaptureSourceRevision: number;
  // Failed or empty attempts do not advance the successful-capture debounce
  // above. These separate fields bound retries without pretending a scene
  // composite succeeded.
  framesSinceCaptureAttempt: number;
  lastCaptureAttemptCameraX: number;
  lastCaptureAttemptCameraY: number;
  lastCaptureAttemptCameraZ: number;
  lastCaptureAttemptSourceRevision: number;
  // The source state represented by the current radiance cube. Mode changes
  // (disabled / model-only / globe) and publication changes are temporal
  // discontinuities and reset history before the next blend.
  lastSceneCaptureMode: number;
  lastSceneCaptureSourceRevision: number;
  lastSceneCaptureResult: SceneCaptureResultValue;
  // C2-25 ENV-TEMPORAL (Batch 449) — temporal-accumulation resources. ALL of
  // these stay null/0 when `envMapTemporalAccumulation` is OFF (the lazy
  // allocation lives entirely inside `runEnvCubeTemporalBlend`, which is only
  // reached on the ON path) → byte-identical default parity.
  //
  // Temporal accumulation uses THREE same-format/size 2d cube textures plus the
  // main cube, with NO texture read+written in the same pass (WebGPU forbids
  // aliasing a writable storage binding with a sampled binding on the same
  // subresource):
  //   • main cube (`cubemapTexture`) — the freshly-captured "current", read
  //     SAMPLED only by the blend (never written by it).
  //   • `historyCube` — LAST frame's accumulated cube, read SAMPLED only.
  //   • `accumCube` — the blend's WRITE target (STORAGE). After the pass it is
  //     copied → main cube (so prefilter/SH read the accumulated cube) AND →
  //     history cube (next frame's history).
  historyCube: GPUTexture | null;
  historyArrayView: GPUTextureView | null; // 2d-array SAMPLED view of historyCube
  currentArrayView: GPUTextureView | null; // 2d-array SAMPLED view of the main cube
  accumCube: GPUTexture | null;
  accumStorageView: GPUTextureView | null; // 2d-array STORAGE write view of accumCube
  blendPipeline: GPUComputePipeline | null;
  blendBGL: GPUBindGroupLayout | null;
  blendUniformBuffer: GPUBuffer | null;
  blendBindGroup: GPUBindGroup | null;
  blendSampler: GPUSampler | null;
  // The cube format the temporal resources were built against — the storage
  // token in the blend shader is baked per-format, so a format flip rebuilds
  // the pipeline (mirrors `cubemapFormat` on the sky pipeline).
  blendFormat?: GPUTextureFormat;
  // True once the history cube holds a valid accumulated frame. False on first
  // ON frame OR after a cube recreate → the blend runs with alpha=1 (current
  // only, no smear) and seeds history. Also forced true→reset on large
  // sun/camera deltas via the gate below.
  historyValid: boolean;
  // Monotonic frame index for the per-face Hammersley jitter rotation.
  temporalFrameIndex: number;
  // Eye the LAST accumulated frame was blended from, for the large-camera-delta
  // history reset (distinct from the capture debounce, which is coarser).
  lastBlendCameraX: number;
  lastBlendCameraY: number;
  lastBlendCameraZ: number;
  // Sun direction the LAST accumulated frame was blended against, for the
  // large-sun-delta history reset. NaN sentinel forces a reset on the first run.
  lastBlendSunX: number;
  lastBlendSunY: number;
  lastBlendSunZ: number;
}

/**
 * Immutable compute kernels shared by all dynamic-environment managers on one
 * GPU device generation. Textures, buffers, bind groups, capture state, and
 * regional/weather uniforms deliberately remain manager-local.
 */
interface DynEnvMapKernelPack {
  skyPipeline: GPUComputePipeline;
  skyBGL: GPUBindGroupLayout;
  shPipeline: GPUComputePipeline;
  shBGL: GPUBindGroupLayout;
}

interface DynEnvMapDeviceKernelPacks {
  resourceGeneration: number;
  byStorageFormat: Map<GPUTextureFormat, DynEnvMapKernelPack>;
  shPipeline: GPUComputePipeline | null;
  shBGL: GPUBindGroupLayout | null;
}

let dynamicEnvironmentKernelPacks = new WeakMap<
  GPUDevice,
  DynEnvMapDeviceKernelPacks
>();

/**
 * Update WebGPU dynamic environment map resources.
 * Creates cubemap textures and schedules re-rendering when needed.
 */
function updateWebGPUDynamicEnvironmentMap(
  manager: DynEnvMapManagerLike,
  frameState: CesiumFrameState,
): void {
  const context = frameState.context;
  const observeDemand = (
    context as unknown as {
      observeEnvironmentMapDemand?: (manager: object) => string;
    }
  ).observeEnvironmentMapDemand;
  if (typeof observeDemand === "function") {
    // C11-193 telemetry only. Do not branch on the result until the bounded
    // scheduler and all conservative visibility gates land.
    observeDemand.call(context, manager);
  }
  const device: GPUDevice = context.device;
  const mode = frameState.mode;
  const resourceGeneration =
    (
      context as unknown as {
        resourceGeneration?: number;
      }
    ).resourceGeneration ?? 0;

  // A recovered WebGPUContext cannot reuse any texture, view, pipeline, bind
  // group, sampler, or buffer from the lost device. Invalidate before the
  // ordinary enabled/update gates so a temporarily disabled manager cannot
  // continue publishing old-device IBL handles to model/fog consumers.
  const existingCache = manager._webgpuCache;
  if (
    existingCache &&
    (existingCache.device !== device ||
      existingCache.resourceGeneration !== resourceGeneration)
  ) {
    destroyWebGPUDynamicEnvironmentMapResources(manager);
  }

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
      device,
      resourceGeneration,
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
      lastCloudCoverage: NaN,
      lastCloudRevision: NaN,
      // Item 3-C (CLOUD-IBL-FULL, Batch 450) — cloud-march placeholder + bound
      // views (all null until the first fill builds the placeholder).
      cloudPlaceholderTex: null,
      cloudPlaceholderView: null,
      cloudPlaceholderSampler: null,
      cloudShapeBoundView: null,
      cloudDetailBoundView: null,
      cloudSamplerBound: null,
      lastUsedCloudMarch: false,
      // C2-25 ENV-SCENE-CAPTURE (Batch 446) — lazy capture-depth + debounce.
      captureDepthTexture: null,
      captureDepthView: null,
      captureDepthSize: 0,
      framesSinceCapture: 0,
      lastCaptureCameraX: NaN,
      lastCaptureCameraY: NaN,
      lastCaptureCameraZ: NaN,
      lastCaptureSourceRevision: -1,
      framesSinceCaptureAttempt: 0,
      lastCaptureAttemptCameraX: NaN,
      lastCaptureAttemptCameraY: NaN,
      lastCaptureAttemptCameraZ: NaN,
      lastCaptureAttemptSourceRevision: -1,
      lastSceneCaptureMode: SCENE_CAPTURE_MODE_DISABLED,
      lastSceneCaptureSourceRevision: -1,
      lastSceneCaptureResult: SceneCaptureResult.SKY_ONLY,
      // C2-25 ENV-TEMPORAL (Batch 449) — temporal accumulation (all inert OFF).
      historyCube: null,
      historyArrayView: null,
      currentArrayView: null,
      accumCube: null,
      accumStorageView: null,
      blendPipeline: null,
      blendBGL: null,
      blendUniformBuffer: null,
      blendBindGroup: null,
      blendSampler: null,
      historyValid: false,
      temporalFrameIndex: 0,
      lastBlendCameraX: NaN,
      lastBlendCameraY: NaN,
      lastBlendCameraZ: NaN,
      lastBlendSunX: NaN,
      lastBlendSunY: NaN,
      lastBlendSunZ: NaN,
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
    // C2-25 ENV-TEMPORAL (Batch 449) — the history cube + the cached 2d-array
    // views reference the old (now-destroyed) cube AND are sized/formatted to
    // the old config. Drop the history texture + all blend bind state so the
    // ON path lazily reallocates against the new cube; mark history invalid so
    // the next blend seeds (alpha=1) instead of mixing a stale frame.
    if (cache.historyCube) {
      cache.historyCube.destroy();
      cache.historyCube = null;
    }
    if (cache.accumCube) {
      cache.accumCube.destroy();
      cache.accumCube = null;
    }
    cache.historyArrayView = null;
    cache.currentArrayView = null;
    cache.accumStorageView = null;
    cache.blendBindGroup = null;
    cache.historyValid = false;
    // A format flip also invalidates the blend pipeline (the storage token is
    // baked per-format), mirroring the sky-pipeline rebuild above.
    if (cache.blendFormat !== cubemapFormat) {
      cache.blendPipeline = null;
      cache.blendBGL = null;
    }
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
  // (context flag on AND a scene-light dynamic-lighting mode); if the LUTs
  // aren't baked yet the fill falls back to the placeholder and leaves
  // `lastUsed...` false, so this keeps re-trying until the LUTs land, then
  // settles. C12-31: `usesSceneLightDirection` replaced `!== 0` so the new
  // LEGACY_OVERHEAD enum (3), whose IBL light direction is per-texel local up,
  // is treated like NONE. Byte-identical for enums 0/1/2.
  const wantLut =
    (frameState.context as unknown as { envMapMultiScatter?: boolean })
      .envMapMultiScatter === true &&
    usesSceneLightDirection(frameState.atmosphere?.dynamicLighting ?? 0);
  const lutPathChanged = wantLut !== cache.lastUsedMultiScatterLut;
  // Item 4.2 (CLOUD-IBL, Batch 441) — re-fill when the live cloud coverage moved
  // (so a static scene re-darkens its IBL as cloud cover changes). The published
  // coverage is already 0 when the cloud-IBL flags are off, so the off path's
  // `cloudCoverage` is a constant 0 → this never trips → byte-identical gating.
  const liveCloudState = (
    frameState.context as unknown as {
      _cloudCache?: { iblCoverage?: number; iblRevision?: number };
    }
  )._cloudCache;
  const liveCloudCoverage = liveCloudState?.iblCoverage ?? 0.0;
  const liveCloudRevision = liveCloudState?.iblRevision ?? 0;
  const cloudCoverageMoved = !(
    Math.abs(liveCloudCoverage - cache.lastCloudCoverage) <
    CLOUD_COVERAGE_REFRESH_EPSILON
  );
  // Item 3-C (CLOUD-IBL-FULL, Batch 450) — re-fill when the full cloud-march
  // path becomes available/unavailable (flag toggled, or the cloud noise just
  // finished baking) so a static scene doesn't stay on the wrong path. `wantMarch`
  // mirrors the predicate the fill uses (context flag on AND a non-zero published
  // coverage); the fill self-heals to the placeholder if the noise isn't baked
  // yet and leaves `lastUsedCloudMarch` false, so this keeps re-trying until the
  // noise lands, then settles. When the flag is off, `wantMarch` is a constant
  // false → this never trips → byte-identical gating.
  const wantMarch =
    (frameState.context as unknown as { cloudsInReflections?: boolean })
      .cloudsInReflections === true && liveCloudCoverage > 0.0;
  // C13-37 — coverage alone cannot detect a moving or reconfigured density
  // field. The cloud renderer advances this revision at a controlled cadence
  // when any full-march-visible input changes. A revision is relevant only while
  // the full reflected-cloud march is requested, or while the previous fill
  // still contains that march and needs one final teardown fill. This keeps
  // visible-cloud-only animation from launching an otherwise inert cube fill +
  // prefilter + SH projection. Revisions published while the march is off remain
  // unconsumed, so the next opt-in observes the latest state immediately.
  const cloudRevisionChanged =
    (wantMarch || cache.lastUsedCloudMarch) &&
    liveCloudRevision !== cache.lastCloudRevision;
  const cloudMarchPathChanged = wantMarch !== cache.lastUsedCloudMarch;
  // C2-25 ENV-SCENE-CAPTURE (Batch 446) — capture refresh gate. Stable OFF has
  // no capture work. An ON→OFF transition deliberately contributes one mode
  // edge so a fresh procedural sky erases captured terrain. While ON, a moving
  // eye, source epoch, or every-K-frames cadence re-runs the FULL refresh,
  // because each
  // `runProceduralSkyFill` rewrites the whole cube (erasing last capture's
  // terrain), so the terrain composite (`runSceneCapture`, below) must re-run
  // whenever the sky is re-filled, and conversely a camera move must force a
  // sky-fill + re-composite so the reflection tracks the eye.
  const sceneCaptureEnabled =
    (frameState.context as unknown as { sceneCaptureReflections?: boolean })
      .sceneCaptureReflections === true &&
    manager.enableSceneCapture === true &&
    frameState.mode === 3; /* SceneMode.SCENE3D */
  const sceneCaptureMode = resolveSceneCaptureMode(
    sceneCaptureEnabled,
    frameState.globeVisible,
  );
  const wantCapture = sceneCaptureMode !== SCENE_CAPTURE_MODE_DISABLED;
  const includeGlobe = sceneCaptureMode === SCENE_CAPTURE_MODE_GLOBE;
  const captureSourceRevision = includeGlobe
    ? getRenderableSceneCaptureSourceRevision(frameState)
    : wantCapture
      ? MODEL_ONLY_SOURCE_REVISION
      : -1;
  if (wantCapture) {
    cache.framesSinceCapture++;
    cache.framesSinceCaptureAttempt++;
  }
  const captureModeChanged = sceneCaptureMode !== cache.lastSceneCaptureMode;
  const captureSourceStateChanged =
    includeGlobe &&
    captureSourceRevision !== cache.lastSceneCaptureSourceRevision;
  const captureRefresh =
    wantCapture &&
    shouldRefreshSceneCapture(cache, manager._position, captureSourceRevision);
  if (
    cache.needsUpdate ||
    sunMoved ||
    lutPathChanged ||
    cloudCoverageMoved ||
    cloudRevisionChanged ||
    cloudMarchPathChanged ||
    captureModeChanged ||
    captureSourceStateChanged ||
    captureRefresh
  ) {
    let sceneCaptureResult: SceneCaptureResultValue =
      SceneCaptureResult.SKY_ONLY;
    const hqOptions = resolveIBLHQOptions(cache, frameState);
    const encodingScope = createIBLCommandEncodingScope(
      device,
      "Dynamic Environment Map Refresh",
      getIBLRefreshParameterCapacity(hqOptions),
    );
    const refreshEncoder = encodingScope.encoder;
    try {
      runProceduralSkyFill(device, cache, manager, frameState, refreshEncoder);
      // Composite globe/model sources over the sky before downstream readers.
      if (wantCapture) {
        sceneCaptureResult = runSceneCapture(
          device,
          cache as unknown as SceneCaptureCache,
          manager as unknown as SceneCaptureManager,
          frameState,
          includeGlobe,
          refreshEncoder,
        );
      }
      const wantTemporal =
        (
          frameState.context as unknown as {
            envMapTemporalAccumulation?: boolean;
          }
        ).envMapTemporalAccumulation === true;
      if (
        shouldResetSceneCaptureHistory(
          cache,
          sceneCaptureMode,
          captureSourceRevision,
          sceneCaptureResult,
        )
      ) {
        // Never blend terrain from the previous provider/content epoch into a
        // fresh provider, a hidden/disabled globe, or a failed globe replay.
        cache.historyValid = false;
      }
      if (wantTemporal) {
        runEnvCubeTemporalBlend(device, cache, manager, sunDir, refreshEncoder);
      }
      runIBLPrefilter(device, cache, frameState, hqOptions, encodingScope);
      runSphericalHarmonicProjection(device, cache, manager, refreshEncoder);
      submitIBLCommandEncodingScope(device, encodingScope);
    } finally {
      // Idempotent after submit; releases the arena if encoding throws and the
      // unfinished command encoder is intentionally abandoned.
      destroyIBLCommandEncodingScope(encodingScope);
    }
    // Commit capture cadence only after the complete refresh has been queued.
    if (wantCapture) {
      updateSceneCaptureAttemptBookkeeping(
        cache,
        manager._position,
        captureSourceRevision,
      );
      updateSceneCaptureBookkeeping(
        cache,
        manager._position,
        sceneCaptureResult === SceneCaptureResult.SUBMITTED,
        captureSourceRevision,
      );
    }
    // The globe producer requests a follow-up frame when it first publishes
    // current capture sources. A miss can therefore settle on the sky fallback
    // here without spinning requestRenderMode or rerunning the prefilter.
    cache.needsUpdate = false;
    cache.lastSunDirX = sunDir.x;
    cache.lastSunDirY = sunDir.y;
    cache.lastSunDirZ = sunDir.z;
    cache.lastSceneCaptureMode = sceneCaptureMode;
    cache.lastSceneCaptureSourceRevision = captureSourceRevision;
    cache.lastSceneCaptureResult = sceneCaptureResult;
    // Item 4.2 (CLOUD-IBL, Batch 441) — record the coverage this fill used.
    cache.lastCloudCoverage = liveCloudCoverage;
    cache.lastCloudRevision = liveCloudRevision;
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

// Item 4.2 (CLOUD-IBL, Batch 441) — minimum cloud-coverage change that triggers
// an env-cube re-fill. 1/256 ~ one rgba8 quantization step on the cube, so
// smaller moves are visually imperceptible after the SH projection. NaN-against-
// anything coerces > epsilon, so the first frame always runs.
const CLOUD_COVERAGE_REFRESH_EPSILON = 1.0 / 256.0;

// C2-25 ENV-SCENE-CAPTURE (Batch 446) — capture debounce (behind the double
// flag, so OFF gating is byte-identical). Re-capture when the reflective owner's
// eye moves > 500 m, OR at least every K frames so a slow drift / sun-static
// scene still keeps the reflected terrain fresh. Caps the 6-pass capture cost.
const CAPTURE_CAMERA_MOVE_SQ = 500.0 * 500.0;
const CAPTURE_EVERY_K_FRAMES = 8;
const SCENE_CAPTURE_MODE_DISABLED = 0;
const SCENE_CAPTURE_MODE_MODEL_ONLY = 1;
const SCENE_CAPTURE_MODE_GLOBE = 2;
const MODEL_ONLY_SOURCE_REVISION = 0;

function resolveSceneCaptureMode(
  sceneCaptureEnabled: boolean,
  globeVisible: boolean | undefined,
): number {
  if (!sceneCaptureEnabled) {
    return SCENE_CAPTURE_MODE_DISABLED;
  }
  return globeVisible === false
    ? SCENE_CAPTURE_MODE_MODEL_ONLY
    : SCENE_CAPTURE_MODE_GLOBE;
}

function shouldResetSceneCaptureHistory(
  cache: Pick<
    DynEnvMapCache,
    | "lastSceneCaptureMode"
    | "lastSceneCaptureSourceRevision"
    | "lastSceneCaptureResult"
  >,
  sceneCaptureMode: number,
  captureSourceRevision: number,
  sceneCaptureResult: SceneCaptureResultValue,
): boolean {
  return (
    sceneCaptureMode !== cache.lastSceneCaptureMode ||
    captureSourceRevision !== cache.lastSceneCaptureSourceRevision ||
    sceneCaptureResult !== cache.lastSceneCaptureResult ||
    (sceneCaptureMode === SCENE_CAPTURE_MODE_GLOBE &&
      sceneCaptureResult !== SceneCaptureResult.SUBMITTED)
  );
}

/**
 * Decide whether a renderable source publication needs a fresh six-face
 * capture. A publication revision is an immediate trigger so the single
 * producer-requested follow-up frame cannot be swallowed by the ordinary
 * movement/cadence debounce.
 *
 * @internal
 */
function shouldRefreshSceneCapture(
  cache: Pick<
    DynEnvMapCache,
    | "framesSinceCaptureAttempt"
    | "lastCaptureAttemptCameraX"
    | "lastCaptureAttemptCameraY"
    | "lastCaptureAttemptCameraZ"
    | "lastCaptureAttemptSourceRevision"
  >,
  position: Pick<CesiumCartesian3, "x" | "y" | "z">,
  captureSourceRevision: number,
): boolean {
  if (captureSourceRevision < 0) {
    return false;
  }

  const cdx = position.x - cache.lastCaptureAttemptCameraX;
  const cdy = position.y - cache.lastCaptureAttemptCameraY;
  const cdz = position.z - cache.lastCaptureAttemptCameraZ;
  // NaN (first capture) coerces the negated comparison to true.
  const captureMoved = !(
    cdx * cdx + cdy * cdy + cdz * cdz <
    CAPTURE_CAMERA_MOVE_SQ
  );
  return (
    captureSourceRevision !== cache.lastCaptureAttemptSourceRevision ||
    captureMoved ||
    cache.framesSinceCaptureAttempt >= CAPTURE_EVERY_K_FRAMES
  );
}

/**
 * Bound retries independently of the successful-capture debounce. A failed
 * replay can be attempted again on a new publication, movement, or the normal
 * cadence, but it cannot turn one request-render wake into a per-frame loop.
 *
 * @internal
 */
function updateSceneCaptureAttemptBookkeeping(
  cache: Pick<
    DynEnvMapCache,
    | "framesSinceCaptureAttempt"
    | "lastCaptureAttemptCameraX"
    | "lastCaptureAttemptCameraY"
    | "lastCaptureAttemptCameraZ"
    | "lastCaptureAttemptSourceRevision"
  >,
  position: Pick<CesiumCartesian3, "x" | "y" | "z">,
  captureSourceRevision: number,
): void {
  cache.framesSinceCaptureAttempt = 0;
  cache.lastCaptureAttemptCameraX = position.x;
  cache.lastCaptureAttemptCameraY = position.y;
  cache.lastCaptureAttemptCameraZ = position.z;
  cache.lastCaptureAttemptSourceRevision = captureSourceRevision;
}

/**
 * Commit capture debounce state only after a real scene-capture submission.
 *
 * @internal
 */
function updateSceneCaptureBookkeeping(
  cache: Pick<
    DynEnvMapCache,
    | "framesSinceCapture"
    | "lastCaptureCameraX"
    | "lastCaptureCameraY"
    | "lastCaptureCameraZ"
    | "lastCaptureSourceRevision"
  >,
  position: Pick<CesiumCartesian3, "x" | "y" | "z">,
  sceneCaptureRan: boolean,
  captureSourceRevision: number,
): void {
  if (!sceneCaptureRan) {
    return;
  }

  cache.framesSinceCapture = 0;
  cache.lastCaptureCameraX = position.x;
  cache.lastCaptureCameraY = position.y;
  cache.lastCaptureCameraZ = position.z;
  cache.lastCaptureSourceRevision = captureSourceRevision;
}

// C2-25 ENV-TEMPORAL (Batch 449) — temporal-accumulation tuning.
//
// Per-frame EMA blend fraction of the freshly-captured cube folded in (history
// keeps 1-α). 0.15 ≈ a ~6-frame e-folding time: fast enough to track a moving
// sun without visible lag, slow enough to crossfade smoothly between the
// debounced single-frame refreshes. The fixed point of the EMA for a CONSTANT
// (static-scene) capture is that constant → the accumulated cube converges to
// the same look as the OFF single-frame cube.
const ENV_TEMPORAL_ALPHA = 0.15;
// Large sun-direction delta (unit-sphere squared distance) that RESETS the
// history so a day→night-scale jump doesn't smear. (0.05)^2 ≈ 2.9° — an order
// of magnitude above the per-frame `SUN_REFRESH_EPSILON_SQ` refresh threshold,
// so ordinary smooth sun progression accumulates while a large jump snaps.
const ENV_TEMPORAL_SUN_RESET_SQ = 0.05 * 0.05;
// Large camera/eye-translation delta (m^2) that RESETS the history. 2 km — well
// above the 500 m capture-refresh debounce, so a small drift accumulates while
// a teleport-scale move snaps the env map to the new view (no smear).
const ENV_TEMPORAL_CAMERA_RESET_SQ = 2000.0 * 2000.0;

// ─── Temporal env-cube accumulation pass (ENV-TEMPORAL, Batch 449) ────────
//
// Inserted between the cube capture and the IBL prefilter ONLY on the
// `envMapTemporalAccumulation` ON path (the caller gates the whole call). It:
//
//   1. Lazily allocates the history cube (same format/size as the main cube)
//      + the blend pipeline / bind state INSIDE this function — OFF allocates
//      nothing (the function is never reached).
//   2. Decides α: 1.0 on the first ON frame, after a cube recreate, or on a
//      LARGE sun/camera delta (history reset → current only, no smear);
//      otherwise `ENV_TEMPORAL_ALPHA` (EMA crossfade).
//   3. Runs a compute pass: out = mix(history, current_jittered, α), writing
//      the blended result into the MAIN cube's storage view (so the prefilter
//      + SH downstream read the accumulated cube).
//   4. Copies the accumulated main cube → history for next frame.
function runEnvCubeTemporalBlend(
  device: GPUDevice,
  cache: DynEnvMapCache,
  manager: DynEnvMapManagerLike,
  sunDir: { x: number; y: number; z: number },
  encoder: GPUCommandEncoder,
): void {
  if (!cache.cubemapTexture) {
    return;
  }
  const format: GPUTextureFormat = cache.cubemapFormat ?? "rgba8unorm";

  // ── Lazy history cube (same format/size as the main cube) ──
  // The main cube + history cube are read SAMPLED by the blend; the WRITE
  // target is the SEPARATE accumCube. No texture is both read and written in
  // the pass (WebGPU usage-scope hazard avoided).
  if (!cache.historyCube) {
    cache.historyCube = device.createTexture({
      label: "DynEnvMap History Cube",
      size: { width: cache.size, height: cache.size, depthOrArrayLayers: 6 },
      format,
      mipLevelCount: 1,
      // SAMPLED (blend reads it) + COPY_DST (JS copies the accumulated cube
      // into it each frame).
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      dimension: "2d",
    });
    cache.historyArrayView = cache.historyCube.createView({
      dimension: "2d-array",
      baseArrayLayer: 0,
      arrayLayerCount: 6,
      baseMipLevel: 0,
      mipLevelCount: 1,
    });
    // First history allocation → no valid accumulated frame yet.
    cache.historyValid = false;
    cache.blendBindGroup = null;
  }

  // ── Lazy accumulation cube (the blend's STORAGE write target) ──
  if (!cache.accumCube) {
    cache.accumCube = device.createTexture({
      label: "DynEnvMap Accum Cube",
      size: { width: cache.size, height: cache.size, depthOrArrayLayers: 6 },
      format,
      mipLevelCount: 1,
      // STORAGE (blend writes it) + COPY_SRC (copied → main cube + history).
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
      dimension: "2d",
    });
    cache.accumStorageView = cache.accumCube.createView({
      dimension: "2d-array",
      baseArrayLayer: 0,
      arrayLayerCount: 6,
      baseMipLevel: 0,
      mipLevelCount: 1,
    });
    cache.blendBindGroup = null;
  }

  // 2d-array SAMPLED view of the MAIN cube (the just-captured "current"). The
  // existing `storageView` is the 2d-array WRITE target; a sampled texture
  // binding needs a non-storage view, so cache a dedicated one.
  if (!cache.currentArrayView) {
    cache.currentArrayView = cache.cubemapTexture.createView({
      dimension: "2d-array",
      baseArrayLayer: 0,
      arrayLayerCount: 6,
      baseMipLevel: 0,
      mipLevelCount: 1,
    });
    cache.blendBindGroup = null;
  }

  // ── Blend pipeline + BGL (once per cache; rebuilt on format flip) ──
  if (!cache.blendPipeline || !cache.blendBGL) {
    cache.blendBGL = device.createBindGroupLayout({
      label: "DynEnvMap Temporal Blend BGL",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: "float", viewDimension: "2d-array" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: "float", viewDimension: "2d-array" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          sampler: { type: "filtering" },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: {
            access: "write-only",
            format,
            viewDimension: "2d-array",
          },
        },
        {
          binding: 4,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "uniform" },
        },
      ],
    });
    const layout = device.createPipelineLayout({
      label: "DynEnvMap Temporal Blend PipelineLayout",
      bindGroupLayouts: [cache.blendBGL],
    });
    // The WGSL declares `rgba16float`; swap to `rgba8unorm` for the LDR parity
    // cube (same lever as the sky pipeline + EnvCubeMipDownsample).
    const blendCode =
      format === "rgba16float"
        ? EnvCubeTemporalBlendWGSL
        : EnvCubeTemporalBlendWGSL.replace(
            "texture_storage_2d_array<rgba16float, write>",
            "texture_storage_2d_array<rgba8unorm, write>",
          );
    const module = device.createShaderModule({
      label: "EnvCubeTemporalBlend",
      code: blendCode,
    });
    cache.blendPipeline = device.createComputePipeline({
      label: "DynEnvMap Temporal Blend Pipeline",
      layout,
      compute: { module, entryPoint: "main" },
    });
    cache.blendFormat = format;
    cache.blendBindGroup = null;
  }

  if (!cache.blendSampler) {
    cache.blendSampler = device.createSampler({
      label: "DynEnvMap Temporal Blend Sampler",
      minFilter: "linear",
      magFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
  }

  if (!cache.blendUniformBuffer) {
    cache.blendUniformBuffer = device.createBuffer({
      label: "DynEnvMap Temporal Blend Uniforms",
      // BlendParams: 2 vec4 = 32 bytes.
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  // ── Decide α (reset vs EMA) ──
  // Reset when: no valid history yet (first ON frame / post-recreate), OR a
  // large sun delta, OR a large camera/eye translation. Reset → α=1 (current
  // only; history is seeded by the copy below) so a big change can't smear.
  const sdx = sunDir.x - cache.lastBlendSunX;
  const sdy = sunDir.y - cache.lastBlendSunY;
  const sdz = sunDir.z - cache.lastBlendSunZ;
  // NaN (first run) coerces > threshold → reset on the first run.
  const sunReset = !(
    sdx * sdx + sdy * sdy + sdz * sdz <
    ENV_TEMPORAL_SUN_RESET_SQ
  );
  const px = manager._position;
  const cdx = px.x - cache.lastBlendCameraX;
  const cdy = px.y - cache.lastBlendCameraY;
  const cdz = px.z - cache.lastBlendCameraZ;
  const cameraReset = !(
    cdx * cdx + cdy * cdy + cdz * cdz <
    ENV_TEMPORAL_CAMERA_RESET_SQ
  );
  const reset = !cache.historyValid || sunReset || cameraReset;
  const alpha = reset ? 1.0 : ENV_TEMPORAL_ALPHA;

  // ── Per-face Hammersley-rotated sub-texel jitter ──
  // Radical-inverse (base 2) of the frame index gives a low-discrepancy 1-D
  // sequence; pair it with the golden-ratio fractional sequence for the second
  // axis → a Hammersley-like 2-D point, recentred to [-0.5,0.5] texels. Subtle
  // for the deterministic capture; load-bearing for the future stochastic
  // cloud-in-IBL consumer (3-C). Zeroed on reset (current is sampled exactly).
  let jx = 0.0;
  let jy = 0.0;
  if (!reset) {
    const i = cache.temporalFrameIndex >>> 0;
    // Van der Corput radical inverse, base 2.
    let bits = i;
    bits = ((bits & 0x55555555) << 1) | ((bits & 0xaaaaaaaa) >>> 1);
    bits = ((bits & 0x33333333) << 2) | ((bits & 0xcccccccc) >>> 2);
    bits = ((bits & 0x0f0f0f0f) << 4) | ((bits & 0xf0f0f0f0) >>> 4);
    bits = ((bits & 0x00ff00ff) << 8) | ((bits & 0xff00ff00) >>> 8);
    bits = (bits << 16) | (bits >>> 16);
    const vdc = (bits >>> 0) * 2.3283064365386963e-10; // / 2^32, in [0,1)
    const golden = (i * 0.6180339887498949) % 1.0; // golden-ratio low-discrepancy
    jx = vdc - 0.5;
    jy = golden - 0.5;
  }
  cache.temporalFrameIndex = (cache.temporalFrameIndex + 1) >>> 0;

  const params = new Float32Array(8);
  params[0] = alpha;
  params[1] = cache.size;
  // params[2], params[3] reserved (0).
  params[4] = jx;
  params[5] = jy;
  // params[6], params[7] reserved (0).
  device.queue.writeBuffer(cache.blendUniformBuffer, 0, params);

  if (!cache.blendBindGroup) {
    cache.blendBindGroup = device.createBindGroup({
      label: "DynEnvMap Temporal Blend BG",
      layout: cache.blendBGL,
      entries: [
        { binding: 0, resource: cache.currentArrayView! },
        { binding: 1, resource: cache.historyArrayView! },
        { binding: 2, resource: cache.blendSampler },
        { binding: 3, resource: cache.accumStorageView! },
        { binding: 4, resource: { buffer: cache.blendUniformBuffer } },
      ],
    });
  }

  const groupsXY = Math.ceil(cache.size / 8);
  const pass = encoder.beginComputePass();
  pass.setPipeline(cache.blendPipeline);
  pass.setBindGroup(0, cache.blendBindGroup);
  pass.dispatchWorkgroups(groupsXY, groupsXY, 6);
  pass.end();
  // Copy the accumulated cube → the MAIN cube (so the downstream prefilter + SH
  // read the accumulated result) AND → the history cube (next frame's history).
  // Both are same-format/size 2d textures with 6 array layers. Done outside the
  // compute pass (copy commands are encoder-level), so no read/write alias with
  // the blend dispatch's storage write.
  encoder.copyTextureToTexture(
    { texture: cache.accumCube!, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
    {
      texture: cache.cubemapTexture,
      mipLevel: 0,
      origin: { x: 0, y: 0, z: 0 },
    },
    { width: cache.size, height: cache.size, depthOrArrayLayers: 6 },
  );
  encoder.copyTextureToTexture(
    { texture: cache.accumCube!, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
    { texture: cache.historyCube!, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
    { width: cache.size, height: cache.size, depthOrArrayLayers: 6 },
  );
  // Record the eye + sun this accumulated frame was blended from, and mark the
  // history valid so subsequent frames EMA-blend (until the next reset).
  cache.historyValid = true;
  cache.lastBlendCameraX = px.x;
  cache.lastBlendCameraY = px.y;
  cache.lastBlendCameraZ = px.z;
  cache.lastBlendSunX = sunDir.x;
  cache.lastBlendSunY = sunDir.y;
  cache.lastBlendSunZ = sunDir.z;
}

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
//   32 groundAlbedo  33 dynamicLightingEnum  34 scatteringIntensity  35 useMultiScatterLut
//   36 cloudCoverage  37 cloudMarch  38 cloudPlanetRadius  39 ellipsoidHeight
//   40..42 cloudSunLocal     43 cloudDeckBottom
//   44..46 deprecatedCloudWind  47 cloudDeckTop
//   48..50 cloudBaseColor    51 cloudDensityMult
//   52..54 cloudTopColor     55 cloudPuffSize
//   56..59 densityShapeOriginPhase
//   60..63 densityWarpOriginPhase
//   64..67 densityDetailOriginPhase
// Item 4.2 (CLOUD-IBL, Batch 441) grew the struct 144→160 bytes (one new vec4
// slot) for the effective cloud-coverage scalar. Item 3-C (CLOUD-IBL-FULL,
// Batch 450) grew it 160→224 bytes (four new vec4 rows) for the full per-face
// cloud-march controls. Add-only; the off path packs cloudMarch = 0 → the WGSL
// march branch is skipped + the noise bindings are 1×1×1 placeholders →
// byte-identical to the 4.2 fill. C13-37 grows it 224→272 bytes with three
// CPU-f64 planet-domain origin-phase rows shared with the visible cloud march.
const SKY_UNIFORM_FLOATS = 56 + CLOUD_DENSITY_ORIGIN_PHASE_FLOATS;
const SKY_UNIFORM_SIZE = SKY_UNIFORM_FLOATS * 4;
const PROCEDURAL_SKY_SOURCE = `${CloudDensityDomainWGSL}\n${ProceduralSkyCubemapWGSL}`;

// Reused scratch so the per-fill pack does not allocate.
const scratchPosition = new Cartesian3();
const scratchSurfacePosition = new Cartesian3();

// NEW-MODEL-IBL-AMBIENT (re-land of the audited-GO B3 fix) — minimal shape of
// `frameState.mapProjection.ellipsoid` (opaque in cesium-js-types.d.ts) for
// the WebGL-parity radii derivation (DynamicEnvironmentMapManager.js
// `atmosphereNeedsUpdate`).
interface EllipsoidLike {
  scaleToGeodeticSurface?: (
    cartesian: Cartesian3,
    result: Cartesian3,
  ) => Cartesian3 | undefined;
  maximumRadius?: number;
}
// Default Atmosphere.js scattering terms (used when frameState.atmosphere
// omits a field, mirroring the WebGL automatic-uniform fallbacks).
const DEFAULT_RAYLEIGH_COEFFICIENT = { x: 5.5e-6, y: 13.0e-6, z: 28.4e-6 };
const DEFAULT_MIE_COEFFICIENT = { x: 21e-6, y: 21e-6, z: 21e-6 };
const DEFAULT_RAYLEIGH_SCALE_HEIGHT = 10000.0;
const DEFAULT_MIE_SCALE_HEIGHT = 3200.0;
const DEFAULT_MIE_ANISOTROPY = 0.9;
const DEFAULT_LIGHT_INTENSITY = 10.0;
// DP-H47 (Campaign-7) — the model IBL sky fill's fallback set, passed to the
// shared `resolveAtmosphereScattering` resolver. These are the same historical
// `DEFAULT_*` constants above, so resolving through the shared seam is
// byte-identical when `scene.atmosphere` leaves a field unset.
const MODEL_ATMOSPHERE_DEFAULTS: AtmosphereScatteringDefaults = {
  rayleighCoefficient: DEFAULT_RAYLEIGH_COEFFICIENT,
  mieCoefficient: DEFAULT_MIE_COEFFICIENT,
  rayleighScaleHeight: DEFAULT_RAYLEIGH_SCALE_HEIGHT,
  mieScaleHeight: DEFAULT_MIE_SCALE_HEIGHT,
  mieAnisotropy: DEFAULT_MIE_ANISOTROPY,
  lightIntensity: DEFAULT_LIGHT_INTENSITY,
};
// WGS84 max radius — fallback when the map projection's ellipsoid is
// unavailable (mirrors WebGL's `ellipsoid.maximumRadius` fallback in
// DynamicEnvironmentMapManager.js `atmosphereNeedsUpdate`).
const DEFAULT_MAX_RADIUS = 6378137.0;
// WebGL's outer-atmosphere shell scale (DynamicEnvironmentMapManager.js
// `atmosphereNeedsUpdate`: `const outerEllipsoidScale = 1.025`). NOT the
// 111 km czm_computeScattering shell — that one lives inside the WGSL
// scattering march (ATMOSPHERE_THICKNESS in ProceduralSkyCubemap.wgsl).
const OUTER_ELLIPSOID_SCALE = 1.025;

/**
 * Return the immutable dynamic-environment kernels for a device generation.
 *
 * The procedural-sky storage format is pipeline-baked, so LDR and HDR keep
 * distinct sky kernels. SH projection has a fixed layout and is shared across
 * both formats. A generation change replaces the device entry even when a
 * recovery implementation happens to retain the same wrapper identity.
 *
 * @internal
 */
function getOrCreateDynamicEnvironmentKernelPack(
  device: GPUDevice,
  resourceGeneration: number,
  storageFormat: GPUTextureFormat,
): DynEnvMapKernelPack {
  let devicePacks = dynamicEnvironmentKernelPacks.get(device);
  if (!devicePacks || devicePacks.resourceGeneration !== resourceGeneration) {
    devicePacks = {
      resourceGeneration,
      byStorageFormat: new Map(),
      shPipeline: null,
      shBGL: null,
    };
    dynamicEnvironmentKernelPacks.set(device, devicePacks);
  }

  const existing = devicePacks.byStorageFormat.get(storageFormat);
  if (existing) {
    return existing;
  }

  const skyBGL = device.createBindGroupLayout({
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
      {
        binding: 5,
        visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType: "float", viewDimension: "3d" },
      },
      {
        binding: 6,
        visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType: "float", viewDimension: "3d" },
      },
      {
        binding: 7,
        visibility: GPUShaderStage.COMPUTE,
        sampler: { type: "filtering" },
      },
    ],
  });
  const skyLayout = device.createPipelineLayout({
    label: "DynEnvMap Sky PipelineLayout",
    bindGroupLayouts: [skyBGL],
  });
  const skyCode =
    storageFormat === "rgba8unorm"
      ? PROCEDURAL_SKY_SOURCE
      : PROCEDURAL_SKY_SOURCE.replace(
          "texture_storage_2d_array<rgba8unorm, write>",
          "texture_storage_2d_array<rgba16float, write>",
        );
  const skyModule = device.createShaderModule({
    label: "ProceduralSkyCubemap",
    code: skyCode,
  });
  const skyPipeline = device.createComputePipeline({
    label: "DynEnvMap Sky Pipeline",
    layout: skyLayout,
    compute: { module: skyModule, entryPoint: "main" },
  });

  if (!devicePacks.shPipeline || !devicePacks.shBGL) {
    devicePacks.shBGL = device.createBindGroupLayout({
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
    const shLayout = device.createPipelineLayout({
      label: "DynEnvMap SH PipelineLayout",
      bindGroupLayouts: [devicePacks.shBGL],
    });
    const shModule = device.createShaderModule({
      label: "ProjectRadianceToSH",
      code: ProjectRadianceToSHWGSL,
    });
    devicePacks.shPipeline = device.createComputePipeline({
      label: "DynEnvMap SH Pipeline",
      layout: shLayout,
      compute: { module: shModule, entryPoint: "main" },
    });
  }

  const pack = {
    skyPipeline,
    skyBGL,
    shPipeline: devicePacks.shPipeline,
    shBGL: devicePacks.shBGL,
  };
  devicePacks.byStorageFormat.set(storageFormat, pack);
  return pack;
}

/** @internal */
function resetDynamicEnvironmentKernelPacksForSpecs(): void {
  dynamicEnvironmentKernelPacks = new WeakMap();
}

function runProceduralSkyFill(
  device: GPUDevice,
  cache: DynEnvMapCache,
  manager: DynEnvMapManagerLike,
  frameState: CesiumFrameState,
  encoder: GPUCommandEncoder,
): void {
  // Kernels are immutable for a device generation and storage format. Share
  // them across managers; only bind groups, buffers, textures, and state are
  // probe-local.
  if (!cache.skyPipeline || !cache.skyBGL) {
    const storageFormat: GPUTextureFormat = cache.cubemapFormat ?? "rgba8unorm";
    const kernels = getOrCreateDynamicEnvironmentKernelPack(
      device,
      cache.resourceGeneration,
      storageFormat,
    );
    cache.skyPipeline = kernels.skyPipeline;
    cache.skyBGL = kernels.skyBGL;
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

  // DP-H47 (Campaign-7) — resolve the scattering terms + dynamicLighting
  // through the shared `WebGPUAtmosphereUniforms` seam. Byte-identical to the
  // former inline `frameState.atmosphere?.X ?? DEFAULT` reads (same source,
  // same fallbacks via MODEL_ATMOSPHERE_DEFAULTS).
  const resolvedAtmosphere = resolveAtmosphereScattering(
    frameState,
    MODEL_ATMOSPHERE_DEFAULTS,
  );
  const rayleighCoefficient = resolvedAtmosphere.rayleighCoefficient;
  const mieCoefficient = resolvedAtmosphere.mieCoefficient;
  const rayleighScaleHeight = resolvedAtmosphere.rayleighScaleHeight;
  const mieScaleHeight = resolvedAtmosphere.mieScaleHeight;
  const mieAnisotropy = resolvedAtmosphere.mieAnisotropy;
  const lightIntensity = resolvedAtmosphere.lightIntensity;
  const dynamicLighting = resolvedAtmosphere.dynamicLighting;
  // When dynamicLighting === SCENE_LIGHT, feed the scene light vector as
  // the "sun" the shader uses; the shader's NONE/SUNLIGHT paths use the
  // packed sunDirectionWC / local zenith respectively.
  const lightVec = dynamicLighting === 1 && sceneLight ? sceneLight : sunDir;

  // Position + ENU->fixed basis (WGS84 default, matching the WebGL
  // DynamicEnvironmentMapManager). NEW-MODEL-IBL-AMBIENT (re-land of the
  // audited-GO B3 fix) — radii per DynamicEnvironmentMapManager.js
  // `atmosphereNeedsUpdate` (u_radiiAndDynamicAtmosphereColor semantics):
  //   inner = |scaleToGeodeticSurface(position)|  (surface radius under the
  //           model, NOT the model position's magnitude)
  //   outer = inner × 1.025                       (NOT inner + 111 km — the
  //           111 km shell is internal to the WGSL scattering march)
  //   ellipsoidHeight = max(|position| − inner, 0) (slot 39; view-origin
  //           scaling + skyAlpha / ground-blend height terms)
  const position = manager._position;
  scratchPosition.x = position.x;
  scratchPosition.y = position.y;
  scratchPosition.z = position.z;
  const positionHeight = Cartesian3.magnitude(scratchPosition);
  const ellipsoid = (
    frameState.mapProjection as unknown as { ellipsoid?: EllipsoidLike } | null
  )?.ellipsoid;
  const surfacePosition = ellipsoid?.scaleToGeodeticSurface?.(
    scratchPosition,
    scratchSurfacePosition,
  );
  const innerRadius = surfacePosition
    ? Cartesian3.magnitude(surfacePosition)
    : (ellipsoid?.maximumRadius ?? DEFAULT_MAX_RADIUS);
  const outerRadius = innerRadius * OUTER_ELLIPSOID_SCALE;
  const ellipsoidHeight = Math.max(positionHeight - innerRadius, 0.0);
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
  if (
    ctx.envMapMultiScatter === true &&
    usesSceneLightDirection(dynamicLighting)
  ) {
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
  // Item 4.2 (CLOUD-IBL, Batch 441) — effective cloud coverage [0,1]. The cloud
  // renderer publishes it onto `context._cloudCache.iblCoverage` every frame,
  // already gated to 0 unless BOTH `globe.showProceduralClouds` AND
  // `globe.cloudContributesIBL` are on. 0 (default) → the WGSL overcast blend is
  // skipped → byte-identical fill.
  const cloudCache = (
    frameState.context as unknown as {
      _cloudCache?: {
        iblCoverage?: number;
        // Item 3-C (CLOUD-IBL-FULL, Batch 450) — the real visible-cloud march
        // params, published every frame from the env-effects dispatch (where
        // `scene.globe` is in scope). Read HERE instead of the nonexistent
        // `frameState.globe`, so the reflected deck tracks live customization.
        iblDeckBottom?: number;
        iblDeckTop?: number;
        iblWindX?: number;
        iblWindY?: number;
        iblWindSpeed?: number;
        iblTimeSeconds?: number;
        iblRevision?: number;
        iblDensity?: number;
        iblPuffSize?: number;
        iblPWActive?: boolean;
        noise?: {
          shapeSampleView?: GPUTextureView;
          shapePWSampleView?: GPUTextureView | null;
          detailSampleView?: GPUTextureView;
          sampler3d?: GPUSampler;
        } | null;
      };
    }
  )._cloudCache;
  data[36] = cloudCache?.iblCoverage ?? 0.0;

  // Item 3-C (CLOUD-IBL-FULL, Batch 450) — the full per-face cloud march. Gated
  // on the `cloudsInReflections` context flag AND the baked cloud noise actually
  // existing on `_cloudCache.noise` (the cloud renderer bakes it once the
  // volumetric clouds run). When EITHER is missing the march flag is 0 → the
  // WGSL march branch is never taken + the 1×1×1 placeholder noise is bound →
  // byte-identical to the 4.2 path. `wantCloudMarch` is also AND-ed with a
  // non-zero published coverage so a flag set on a clear scene stays inert.
  const ctxClouds = frameState.context as unknown as {
    cloudsInReflections?: boolean;
  };
  const cloudNoise = cloudCache?.noise ?? null;
  // Item 3-C (CLOUD-IBL-FULL, Batch 450, FIX 3) — match the visible renderer's
  // PW-shape selection: only sample the Perlin-Worley base shape view when the
  // visible clouds are in PW morphology AND it actually baked; otherwise sample
  // the value-FBM shape view (the visible default). This keeps the reflected
  // clouds on the SAME base shape as the rendered clouds instead of always
  // preferring the PW view when present.
  const usePWShape =
    cloudCache?.iblPWActive === true && !!cloudNoise?.shapePWSampleView;
  const cloudNoiseShapeView =
    (usePWShape
      ? cloudNoise?.shapePWSampleView
      : cloudNoise?.shapeSampleView) ?? null;
  const cloudNoiseDetailView = cloudNoise?.detailSampleView ?? null;
  const cloudNoiseSampler = cloudNoise?.sampler3d ?? null;
  const cloudMarchActive =
    ctxClouds.cloudsInReflections === true &&
    (cloudCache?.iblCoverage ?? 0.0) > 0.0 &&
    cloudNoiseShapeView !== null &&
    cloudNoiseDetailView !== null &&
    cloudNoiseSampler !== null;
  // Record the effective march path so the update gate re-fills when it flips
  // (e.g. the cloud noise finishes baking a frame after the first sky fill, or
  // the flag toggles on a static scene).
  cache.lastUsedCloudMarch = cloudMarchActive;

  // Item 3-C (CLOUD-IBL-FULL, Batch 450, FIX 1) — cloud-march params read from
  // `_cloudCache` (the SAME channel as `iblCoverage`), published every frame by
  // the cloud renderer's `publishCloudIblCoverage` where `scene.globe` is in
  // scope. `FrameState` has NO `globe` field, so the prior `frameState.globe`
  // cast always read undefined and every param froze at the constructor default
  // — silently decoupling the reflected deck from any user cloud customization.
  // The cache seeds with the Globe constructor defaults, so the OFF/pre-publish
  // value still equals the visible default. All inert when `cloudMarch` is 0.
  const deckBottom = cloudCache?.iblDeckBottom ?? 1500.0;
  const deckTop = cloudCache?.iblDeckTop ?? 4000.0;
  const cloudDensity = cloudCache?.iblDensity ?? 0.3;
  const windX = cloudCache?.iblWindX ?? 0.7;
  const windY = cloudCache?.iblWindY ?? 0.3;
  const windSpeed = cloudCache?.iblWindSpeed ?? 15.0;
  // C13-37 — use the visible renderer's scene-clock-relative time. Wall-clock
  // capture drift made reflected formations disagree with paused/scrubbed scenes.
  const cloudTime = cloudMarchActive
    ? (cloudCache?.iblTimeSeconds ?? 0.0)
    : 0.0;
  const cloudPuffSize = cloudCache?.iblPuffSize ?? 0.45;
  // Sun direction in the IBL LOCAL frame (same basis rotation as the shader's
  // `sunLocal`): East→localX, Up→localY, North→localZ.
  const sunLocalX =
    lightVec.x * enu[0] + lightVec.y * enu[1] + lightVec.z * enu[2];
  const sunLocalY =
    lightVec.x * enu[8] + lightVec.y * enu[9] + lightVec.z * enu[10];
  const sunLocalZ =
    lightVec.x * enu[4] + lightVec.y * enu[5] + lightVec.z * enu[6];
  const sunLocalLen = Math.hypot(sunLocalX, sunLocalY, sunLocalZ) || 1.0;

  data[37] = cloudMarchActive ? 1.0 : 0.0;
  // data[38] cloudPlanetRadius — DEAD (Batch 450, FIX 4): the WGSL march uses the
  // passed `innerR`/`u.innerRadius`, never this slot. Packed for documentation
  // only; kept add-only so the row layout + later offsets stay stable.
  data[38] = innerRadius;
  // data[39] — NEW-MODEL-IBL-AMBIENT: ellipsoidHeight (was the always-0
  // reserved pad; a ground-level model still packs 0). View-origin scaling +
  // skyAlpha / ground-blend height terms in the WGSL.
  data[39] = ellipsoidHeight;
  // 40..42 cloudSunLocal (normalized) + 43 cloudDeckBottom
  data[40] = sunLocalX / sunLocalLen;
  data[41] = sunLocalY / sunLocalLen;
  data[42] = sunLocalZ / sunLocalLen;
  data[43] = deckBottom;
  // 44..46 are retained as deprecated add-only layout slots. Wind advection is
  // folded into the CPU-f64 origin phases below so planet-scale capture does
  // not quantize an ever-growing displacement through three f32 uniforms.
  data[44] = 0.0;
  data[45] = 0.0;
  data[46] = 0.0;
  data[47] = deckTop;
  // 48..50 cloudBaseColor (shadowed deck tint) + 51 cloudDensityMult
  data[48] = 0.45;
  data[49] = 0.47;
  data[50] = 0.52;
  data[51] = cloudDensity;
  // 52..54 cloudTopColor (sun-lit tint) + 55 cloudPuffSize
  data[52] = 0.95;
  data[53] = 0.95;
  data[54] = 0.98;
  data[55] = cloudPuffSize;
  // 56..67 — the same three CPU-f64 planet-domain origin phases used by the
  // visible march, evaluated at this environment capture's actual ECEF origin.
  writeCloudDensityAdvectedOriginPhases(
    data,
    56,
    position.x,
    position.y,
    position.z,
    cloudPuffSize,
    windX,
    windY,
    windSpeed,
    cloudTime,
  );
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

  // Item 3-C (CLOUD-IBL-FULL, Batch 450) — 1×1×1 white 3D placeholder + sampler
  // (built once). Backs bindings 5/6/7 whenever the cloud march is off (or the
  // cloud noise hasn't baked), keeping the bind group valid + constant; the WGSL
  // `cloudMarch` flag keeps them unsampled → byte-identical parity.
  if (!cache.cloudPlaceholderView) {
    cache.cloudPlaceholderTex = device.createTexture({
      label: "DynEnvMap Cloud Noise Placeholder",
      size: { width: 1, height: 1, depthOrArrayLayers: 1 },
      format: "rgba8unorm",
      dimension: "3d",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    // White (255) — never sampled when the march is off; the value is irrelevant
    // to parity, white is the inert "no erosion / full shape" default.
    const white = new Uint8Array([255, 255, 255, 255]);
    device.queue.writeTexture(
      { texture: cache.cloudPlaceholderTex },
      white,
      { bytesPerRow: 4, rowsPerImage: 1 },
      { width: 1, height: 1, depthOrArrayLayers: 1 },
    );
    cache.cloudPlaceholderView = cache.cloudPlaceholderTex.createView({
      dimension: "3d",
    });
  }
  if (!cache.cloudPlaceholderSampler) {
    cache.cloudPlaceholderSampler = device.createSampler({
      label: "DynEnvMap Cloud Noise Placeholder Sampler",
      minFilter: "linear",
      magFilter: "linear",
      addressModeU: "repeat",
      addressModeV: "repeat",
      addressModeW: "repeat",
    });
  }
  // Bind the REAL baked cloud noise (shared from the cloud renderer) only when
  // the march is active; otherwise the placeholder. The shape view prefers the
  // Perlin-Worley variant (the cloud renderer's own preference) when present.
  const boundCloudShapeView = cloudMarchActive
    ? (cloudNoiseShapeView ?? cache.cloudPlaceholderView)
    : cache.cloudPlaceholderView;
  const boundCloudDetailView = cloudMarchActive
    ? (cloudNoiseDetailView ?? cache.cloudPlaceholderView)
    : cache.cloudPlaceholderView;
  const boundCloudSampler = cloudMarchActive
    ? (cloudNoiseSampler ?? cache.cloudPlaceholderSampler)
    : cache.cloudPlaceholderSampler;

  // (Re)build bind group when the storage view changed (size change resets
  // `skyBindGroup` to null in the texture-create path) OR when the bound LUT /
  // cloud-noise views change (they first appear once the LUTs / cloud noise are
  // baked, and flip with `cloudMarchActive`).
  if (
    !cache.skyBindGroup ||
    cache.lutSkyViewView !== boundSkyView ||
    cache.lutMsView !== boundMsView ||
    cache.cloudShapeBoundView !== boundCloudShapeView ||
    cache.cloudDetailBoundView !== boundCloudDetailView ||
    cache.cloudSamplerBound !== boundCloudSampler
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
        { binding: 5, resource: boundCloudShapeView },
        { binding: 6, resource: boundCloudDetailView },
        { binding: 7, resource: boundCloudSampler },
      ],
    });
    cache.lutSkyViewView = boundSkyView;
    cache.lutMsView = boundMsView;
    cache.cloudShapeBoundView = boundCloudShapeView;
    cache.cloudDetailBoundView = boundCloudDetailView;
    cache.cloudSamplerBound = boundCloudSampler;
  }

  // Dispatch: workgroup_size(8, 8, 1); grid covers face × face × 6.
  const groupsXY = Math.ceil(cache.size / 8);
  // C13-39 — this dispatch is the environment/IBL leg of the cloud march (it
  // runs `marchCloudFaceIBL` when `cloudMarch > 0`), so it needs its own GPU
  // timestamp lane. `withComputePassTimestamps` returns the exact descriptor
  // when the profiler is not armed, so the default path is unchanged; the
  // optional-call guard keeps it safe on contexts without the accessor.
  const skyPassDescriptor: GPUComputePassDescriptor = {
    label: "DynEnvMap Sky Fill",
  };
  const pass = encoder.beginComputePass(
    frameState.context.withComputePassTimestamps?.(skyPassDescriptor) ??
      skyPassDescriptor,
  );
  pass.setPipeline(cache.skyPipeline);
  pass.setBindGroup(0, cache.skyBindGroup);
  pass.dispatchWorkgroups(groupsXY, groupsXY, 6);
  pass.end();
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
  encoder: GPUCommandEncoder,
): void {
  if (!cache.cubemapTextureView || !cache.sampler) {
    return;
  }

  // Share the immutable SH kernel with every probe on this device generation.
  if (!cache.shPipeline || !cache.shBGL) {
    const kernels = getOrCreateDynamicEnvironmentKernelPack(
      device,
      cache.resourceGeneration,
      cache.cubemapFormat ?? "rgba8unorm",
    );
    cache.shPipeline = kernels.shPipeline;
    cache.shBGL = kernels.shBGL;
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
  const pass = encoder.beginComputePass();
  pass.setPipeline(cache.shPipeline);
  pass.setBindGroup(0, cache.shBindGroup);
  pass.dispatchWorkgroups(1, 1, 1);
  pass.end();
}

// ─── IBL prefilter trigger (Audit A.12, Batch 131) ───────────────────────
//
// Reuses `WebGPUIBLPipeline.generateIBLMaps` -- the same compute path
// that `WebGPUImageBasedLighting` runs for explicit-source IBL. The
// only difference is the source: here it's the procedural cubemap we
// just filled; for explicit IBL it's a user-supplied HDR cubemap.
function resolveIBLHQOptions(
  cache: DynEnvMapCache,
  frameState: CesiumFrameState,
): RadianceHQOptions | undefined {
  const quality =
    (
      frameState.context as unknown as {
        iblPrefilterQuality?: "parity" | "high";
      }
    ).iblPrefilterQuality ?? "parity";
  return quality === "high"
    ? {
        quality: "high",
        sourceCube: cache.cubemapTexture,
        sourceFormat: cache.cubemapFormat ?? ("rgba8unorm" as GPUTextureFormat),
      }
    : undefined;
}

function runIBLPrefilter(
  device: GPUDevice,
  cache: DynEnvMapCache,
  frameState: CesiumFrameState,
  hqOptions: RadianceHQOptions | undefined,
  encodingScope: IBLCommandEncodingScope,
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
    encodingScope,
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
  if (cache.shBuffer) {
    cache.shBuffer.destroy();
  }
  if (cache.shParamBuffer) {
    cache.shParamBuffer.destroy();
  }
  // C2-25 ENV-SCENE-CAPTURE — the manager owns the lazily allocated capture
  // depth attachment. It is not reachable through the IBL cache and therefore
  // must be released explicitly on manager destruction or device recovery.
  if (cache.captureDepthTexture) {
    cache.captureDepthTexture.destroy();
  }
  cache.captureDepthTexture = null;
  cache.captureDepthView = null;
  cache.captureDepthSize = 0;
  // C2-25 ENV-TEMPORAL (Batch 449) — release the history + accum cubes + blend
  // uniform buffer (all null on the OFF path → branches skip).
  if (cache.historyCube) {
    cache.historyCube.destroy();
  }
  if (cache.accumCube) {
    cache.accumCube.destroy();
  }
  if (cache.blendUniformBuffer) {
    cache.blendUniformBuffer.destroy();
  }
  // Item 2.2 (ENV-AERIAL-MS, Batch 430) — the manager owns only the 1×1 LUT
  // placeholder; the real sky-view / MS LUT textures are owned by the perf
  // manager and must NOT be destroyed here.
  if (cache.lutPlaceholderTex) {
    cache.lutPlaceholderTex.destroy();
  }
  // Item 3-C (CLOUD-IBL-FULL, Batch 450) — the manager owns only the 1×1×1 cloud
  // noise placeholder; the real baked cloud noise is owned by the cloud renderer
  // (`_cloudCache.noise`) and must NOT be destroyed here.
  if (cache.cloudPlaceholderTex) {
    cache.cloudPlaceholderTex.destroy();
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
  manager._radianceMap = null;
  manager._webgpuIBLDiffuseView = null;
  manager._webgpuIBLSpecularView = null;
  manager._webgpuIBLSampler = null;
  manager._webgpuIBLMaxMipLevel = 0;
  manager._webgpuSHBuffer = null;
}

export {
  updateWebGPUDynamicEnvironmentMap,
  destroyWebGPUDynamicEnvironmentMapResources,
  getOrCreateDynamicEnvironmentKernelPack,
  resetDynamicEnvironmentKernelPacksForSpecs,
  resolveSceneCaptureMode,
  shouldRefreshSceneCapture,
  shouldResetSceneCaptureHistory,
  updateSceneCaptureAttemptBookkeeping,
  updateSceneCaptureBookkeeping,
};
export default {
  updateWebGPUDynamicEnvironmentMap,
  destroyWebGPUDynamicEnvironmentMapResources,
};
