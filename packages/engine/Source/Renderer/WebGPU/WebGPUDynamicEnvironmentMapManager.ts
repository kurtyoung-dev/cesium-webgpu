/**
 * WebGPU Dynamic Environment Map Manager
 *
 * A procedural Hosek-Wilkie-style sky compute pass paints all 6 cubemap faces,
 * then `WebGPUIBLPipeline.generateIBLMaps` produces prefiltered irradiance +
 * radiance for IBL consumption. Models without an explicit
 * `imageBasedLighting.specularEnvironmentMaps` therefore get a real diffuse +
 * specular reflection out of the box.
 *
 * The procedural sky is a sun/zenith/ground gradient plus a sun disc rather
 * than a full atmospheric capture, which would mean routing the WebGPU
 * sky/atmosphere/sun renderers through 6 cubemap faces. The procedural fill
 * gives correct directional-IBL relationships — bright top, dim bottom,
 * sun-driven specular highlights — at near-zero cost.
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
  IBLParameterArenaPool,
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
  type SceneCaptureTargetPool,
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
// The eclipse response for the cloud/environment subsystem. The WebGL
// `Scene/DynamicEnvironmentMapManager.js` imports this same module, so the two
// backends share one factor, one composition and one refresh grid.
import {
  applyEclipseCloudDimming,
  quantizeEclipseEnvironmentRefreshInput,
  resolveEclipseCloudFactor,
} from "../../Scene/EclipseCloudResponse.js";

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
  // Prefiltered IBL views exposed for the model material bind group. Read by
  // `buildModelIBLEntries` in `WebGPUModelRenderer` when the model has no
  // explicit IBL set up.
  _webgpuIBLDiffuseView?: GPUTextureView | null;
  _webgpuIBLSpecularView?: GPUTextureView | null;
  _webgpuIBLSampler?: GPUSampler | null;
  _webgpuIBLMaxMipLevel?: number;
  // Atmosphere-derived diffuse-IBL spherical-harmonic coefficients (9 vec4 +
  // control vec4), projected from the radiance cube. Bound by
  // `buildModelIBLEntries` at SHUniforms binding 36 so models evaluate SH
  // instead of sampling the irradiance cubemap, matching WebGL's
  // czm_sphericalHarmonics path.
  _webgpuSHBuffer?: GPUBuffer | null;
  // Opt-in, WebGPU only. When this and `context.sceneCaptureReflections` are
  // both true, `runSceneCapture` renders the opaque globe surface into the env
  // cube's 6 faces so terrain reflects in water / PBR models. Default false
  // leaves no capture pass at all.
  enableSceneCapture?: boolean;
  // Optional sky tuning. When undefined the manager uses sensible
  // studio-HDR defaults (warm zenith, cool ground, white sun).
  skyColor?: { red: number; green: number; blue: number };
  groundColor?: { red: number; green: number; blue: number };
  // The atmosphere-derived sky fill needs the same lighting controls the WebGL
  // ComputeRadianceMapFS reads from the manager. These live on the upstream
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
  // 2d-array view of the cubemap used as the storage-texture write target for
  // the procedural sky compute. Distinct from `cubemapTextureView` (dimension
  // "cube"), which the IBL prefilter reads as a source; "cube" is not a valid
  // storage-binding view dimension.
  storageView: GPUTextureView | null;
  sampler: GPUSampler | null;
  size: number;
  mipmapLevels: number;
  // The env-cube texture format the current resources were built against.
  // `undefined` until the first create; flipping `hdrEnvironmentMap` changes
  // it, triggering a full texture + sky-pipeline + sky-BGL rebuild, because the
  // format token is baked into all three. The parity default is "rgba8unorm".
  cubemapFormat?: GPUTextureFormat;
  needsUpdate: boolean;
  framesSinceUpdate: number;
  // Last sun direction the procedural sky was rendered against. The update path
  // re-runs the sky + prefilter when the current sun direction differs from
  // this by more than `SUN_REFRESH_EPSILON`, so day/night cycles refresh the
  // cubemap without burning compute every frame. A NaN sentinel forces the
  // first-frame re-run.
  lastSunDirX: number;
  lastSunDirY: number;
  lastSunDirZ: number;
  // Compute pipeline for the procedural sky fill, plus its uniform buffer and
  // bind group. Kept on the cache so device creation costs are paid once.
  skyPipeline: GPUComputePipeline | null;
  skyBGL: GPUBindGroupLayout | null;
  skyUniformBuffer: GPUBuffer | null;
  skyBindGroup: GPUBindGroup | null;
  // IBL prefilter cache. Reuses the `IBLPipelineCache` shape from
  // `WebGPUIBLPipeline.ts` so the prefilter runs through the same compute
  // pipelines as explicit-source IBL.
  iblCache: IBLPipelineCache | null;
  // SH-L2 projection pass. Pipeline + BGL are built once; `shBuffer` (9 vec4 +
  // control, STORAGE|UNIFORM) receives the projected coefficients and is
  // published as `manager._webgpuSHBuffer`. `shParamBuffer` carries the
  // atmosphereScatteringIntensity second multiply. `shBindGroup` is reset to
  // null on cube recreation, because the cube view it references changes.
  shPipeline: GPUComputePipeline | null;
  shBGL: GPUBindGroupLayout | null;
  shBuffer: GPUBuffer | null;
  shParamBuffer: GPUBuffer | null;
  shBindGroup: GPUBindGroup | null;
  // Sun-relative sky-view + multiple-scattering LUT sampler, plus a 1×1 white
  // placeholder texture/view. The sky compute pass binds the real LUT views
  // (shared from the perf manager) when `envMapMultiScatter` is on; otherwise
  // it binds the placeholder so the BGL and bind group stay constant, and the
  // WGSL `useMultiScatterLut` flag keeps them unsampled. The LUT views the bind
  // group was last built against are tracked so it rebuilds when they first
  // appear or change.
  lutSampler: GPUSampler | null;
  lutPlaceholderTex: GPUTexture | null;
  lutPlaceholderView: GPUTextureView | null;
  lutSkyViewView: GPUTextureView | null;
  lutMsView: GPUTextureView | null;
  // Whether the previous sky fill used the LUT path. When the effective
  // LUT-path availability flips (flag toggled, or the LUTs finished baking a
  // frame after the first fill), force a re-fill so the cube is not stuck on
  // the wrong path on a static, non-sun-moving scene.
  lastUsedMultiScatterLut: boolean;
  // The effective cloud coverage the previous sky fill was packed with. The
  // update gate re-fills when the live coverage moves by more than
  // `CLOUD_COVERAGE_REFRESH_EPSILON`, so a static, non-sun-moving scene still
  // re-darkens its IBL when cloud cover changes. A NaN sentinel forces the
  // first-frame run, matching `lastSunDir*`.
  lastCloudCoverage: number;
  // Monotonic revision of the complete cloud state used by the IBL march.
  // Coverage has its own epsilon gate above, but wind, time, deck, density and
  // morphology changes also alter the reflected formation. Tracking one
  // publisher-owned revision keeps that gate O(1) and edge-triggered.
  lastCloudRevision: number;
  // The quantized eclipse factor the previous sky fill was packed with.
  // Compared as an exact integer level (`!==`), never a one-way "got darker"
  // test, which is what makes eclipse recovery automatic: the factor returning
  // to 1.0 walks the bucket back to the identity bucket, which differs from the
  // committed dark one, which fires exactly one final re-fill. Deliberately not
  // gated on the cloud march, unlike `lastCloudRevision` — the eclipse dims the
  // whole sky bake, and `cloudsInReflections` is off by default. A NaN sentinel
  // forces the first-frame run, matching `lastCloudRevision`.
  lastEclipseEnvBucket: number;
  // Full per-face cloud march. A 1×1×1 white 3D placeholder and sampler back
  // bindings 5/6/7 whenever the march is off, or the cloud noise has not baked,
  // mirroring the LUT placeholder. The bound cloud-noise views and sampler the
  // bind group was last built against are tracked so it rebuilds when they
  // first appear or flip with the march activation.
  cloudPlaceholderTex: GPUTexture | null;
  cloudPlaceholderView: GPUTextureView | null;
  cloudPlaceholderSampler: GPUSampler | null;
  cloudShapeBoundView: GPUTextureView | null;
  cloudDetailBoundView: GPUTextureView | null;
  cloudSamplerBound: GPUSampler | null;
  // Whether the previous sky fill used the full cloud march. When this flips —
  // flag toggled, cloud noise finished baking, or coverage crossed 0 — force a
  // re-fill so a static, non-sun-moving scene is not stuck on the wrong path.
  lastUsedCloudMarch: boolean;
  // Transient `size×size` depth target shared across the 6 capture face passes
  // and cleared per face. Lazily allocated inside `runSceneCapture`, so the off
  // path allocates nothing, and reallocated when `size` changes. Format
  // `depth24plus` with no stencil matches the capture pipeline variant, and is
  // deliberately different from the on-screen `depth24plus-stencil8`.
  captureDepthTexture: GPUTexture | null;
  captureDepthView: GPUTextureView | null;
  captureDepthSize: number;
  // Frames since the last capture pass ran, for the every-K-frames debounce.
  // It sits behind the capture flags, so the off path never advances it.
  framesSinceCapture: number;
  // World-space eye the last capture was run from, for the camera-translation
  // debounce. A NaN sentinel forces the first capture.
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
  // Temporal-accumulation resources. Every one of these stays null or 0 while
  // `envMapTemporalAccumulation` is off, because the lazy allocation lives
  // entirely inside `runEnvCubeTemporalBlend`, which the off path never reaches.
  //
  // Temporal accumulation uses three same-format, same-size 2d cube textures
  // plus the main cube, and no texture is read and written in the same pass —
  // WebGPU forbids aliasing a writable storage binding with a sampled binding
  // on the same subresource:
  //   • main cube (`cubemapTexture`) — the freshly-captured "current", which
  //     the blend only samples and never writes.
  //   • `historyCube` — the previous frame's accumulated cube, sampled only.
  //   • `accumCube` — the blend's storage write target. After the pass it is
  //     copied to the main cube, so prefilter and SH read the accumulated
  //     result, and to the history cube for the next frame.
  historyCube: GPUTexture | null;
  historyArrayView: GPUTextureView | null; // 2d-array sampled view of historyCube
  currentArrayView: GPUTextureView | null; // 2d-array sampled view of the main cube
  accumCube: GPUTexture | null;
  accumStorageView: GPUTextureView | null; // 2d-array storage write view of accumCube
  blendPipeline: GPUComputePipeline | null;
  blendBGL: GPUBindGroupLayout | null;
  blendUniformBuffer: GPUBuffer | null;
  blendBindGroup: GPUBindGroup | null;
  blendSampler: GPUSampler | null;
  // The cube format the temporal resources were built against — the storage
  // token in the blend shader is baked per-format, so a format flip rebuilds
  // the pipeline (mirrors `cubemapFormat` on the sky pipeline).
  blendFormat?: GPUTextureFormat;
  // True once the history cube holds a valid accumulated frame. False on the
  // first enabled frame and after a cube recreate, so the blend runs with
  // alpha=1 — current only, no smear — and seeds history. Also cleared on
  // large sun or camera deltas by the gate below.
  historyValid: boolean;
  // Monotonic frame index for the per-face Hammersley jitter rotation.
  temporalFrameIndex: number;
  // Eye the previous accumulated frame was blended from, for the
  // large-camera-delta history reset, which is finer than the capture debounce.
  lastBlendCameraX: number;
  lastBlendCameraY: number;
  lastBlendCameraZ: number;
  // Sun direction the previous accumulated frame was blended against, for the
  // large-sun-delta history reset. A NaN sentinel resets on the first run.
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

// Literals mirroring `WebGPUEnvironmentDemandRegistry` and
// `WebGPUEnvironmentRefreshScheduler`. Kept as literals here so this module
// keeps its structural (duck-typed) relationship with the context and stays
// loadable when the scheduler seams are absent.
const ENV_DEMAND_UNKNOWN = "unknown";
const ENV_DEMAND_PROVEN_NONE = "proven-none";
const ENV_REFRESH_URGENCY_MANDATORY = 0;
const ENV_REFRESH_URGENCY_HIGH = 1;
const ENV_REFRESH_URGENCY_NORMAL = 2;
const ENV_REFRESH_DECISION_DEFER = "defer";

/** Structural view of the scheduling/pooling seams on WebGPUContext. */
interface EnvironmentRefreshContextSeams {
  scheduleEnvironmentRefresh?: (manager: object, urgency: number) => string;
  noteEnvironmentRefreshSubmitted?: (manager: object) => void;
  consumeEnvironmentRefreshResume?: () => boolean;
  getEnvironmentTargetPool?: () => EnvironmentRefreshTargetPool | null;
}

/** Union of the pool surface the two refresh consumers need. */
type EnvironmentRefreshTargetPool = IBLParameterArenaPool &
  SceneCaptureTargetPool;

/**
 * Refresh resume path. Re-arms a render so a `requestRenderMode` scene cannot
 * idle while deferred refresh work is still owed a frame. One callback per
 * frame at most: the context arms the flag only for the frame's first deferral,
 * and `afterRender` is drained (and its truthy return turned into
 * `scene.requestRender()`) by `callAfterRenderFunctions`.
 */
function requestRenderForEnvironmentRefreshResume(): boolean {
  return true;
}

/**
 * Offer a refresh to the context-owned bounded drain.
 *
 * Returns true when the caller must run the refresh now. A context without the
 * seam — a WebGL stub, for instance — always runs, unconditionally.
 *
 * On a deferral this arms the resume path before returning false, so there is
 * no path on which work is deferred without a frame to resume on.
 */
function scheduleEnvironmentRefresh(
  context: CesiumGraphicsContext,
  manager: object,
  urgency: number,
  frameState: CesiumFrameState,
): boolean {
  const seams = context as unknown as EnvironmentRefreshContextSeams;
  const schedule = seams.scheduleEnvironmentRefresh;
  if (typeof schedule !== "function") {
    return true;
  }
  const decision = schedule.call(context, manager, urgency);
  if (decision !== ENV_REFRESH_DECISION_DEFER) {
    return true;
  }

  const afterRender = frameState.afterRender;
  const consumeResume = seams.consumeEnvironmentRefreshResume;
  const armResume =
    typeof consumeResume === "function" ? consumeResume.call(context) : true;
  if (armResume && afterRender) {
    // `includes` is a belt-and-braces dedupe alongside the context's
    // once-per-frame flag; the same precedent guards the scene-capture
    // publication request in GlobeSurfaceTileProviderRendering.
    if (!afterRender.includes(requestRenderForEnvironmentRefreshResume)) {
      afterRender.push(requestRenderForEnvironmentRefreshResume);
    }
  } else if (armResume && !afterRender) {
    // Permanent sentinel: without an afterRender list a deferral has no resume
    // path, which is the freeze shape this design exists to prevent.
    console.error(
      "[CesiumJS:webgpu] Environment refresh deferred with no frameState.afterRender to resume on.",
    );
  }
  return false;
}

function noteEnvironmentRefreshSubmitted(
  context: CesiumGraphicsContext,
  manager: object,
): void {
  const note = (context as unknown as EnvironmentRefreshContextSeams)
    .noteEnvironmentRefreshSubmitted;
  if (typeof note === "function") {
    note.call(context, manager);
  }
}

function getEnvironmentTargetPool(
  context: CesiumGraphicsContext,
): EnvironmentRefreshTargetPool | null {
  const get = (context as unknown as EnvironmentRefreshContextSeams)
    .getEnvironmentTargetPool;
  if (typeof get !== "function") {
    return null;
  }
  return get.call(context) ?? null;
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
  const observeDemand = (
    context as unknown as {
      observeEnvironmentMapDemand?: (manager: object) => string;
    }
  ).observeEnvironmentMapDemand;
  let demand = ENV_DEMAND_UNKNOWN;
  if (typeof observeDemand === "function") {
    // The classification may only influence priority inside the bounded drain.
    // It can never decide whether a refresh happens: `proven-none` goes last,
    // never nowhere. See `WebGPUEnvironmentRefreshScheduler` for why gating an
    // environment tick on consumer visibility freezes a partial map.
    demand = observeDemand.call(context, manager);
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
      lastEclipseEnvBucket: NaN,
      // Cloud-march placeholder and bound views, all null until the first fill
      // builds the placeholder.
      cloudPlaceholderTex: null,
      cloudPlaceholderView: null,
      cloudPlaceholderSampler: null,
      cloudShapeBoundView: null,
      cloudDetailBoundView: null,
      cloudSamplerBound: null,
      lastUsedCloudMarch: false,
      // Lazy capture-depth target and its debounce state.
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
      // Temporal accumulation; all of it stays inert while the flag is off.
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

  // Opt-in HDR env cube. Default false gives `rgba8unorm`, matching WebGL;
  // true gives `rgba16float` so the HDR sun disc and bright sky survive into
  // the GGX prefilter. Read off the WebGPU context's `hdrEnvironmentMap`
  // getter, threaded from `contextOptions.webgpu.hdrEnvironmentMap`.
  // rgba16float is in core WebGPU's storage-write-capable and
  // render-attachment lists, so the same STORAGE_BINDING | RENDER_ATTACHMENT
  // usage stays valid.
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
      // STORAGE_BINDING lets the procedural sky compute pass write directly
      // into the cubemap. The IBL prefilter consumes the same texture as
      // TEXTURE_BINDING through the cube view.
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

    // 2d-array view for storage-write from the compute shader. WebGPU requires
    // the storage binding's view dimension to match the BGL declaration, and
    // "cube" is not valid for storage.
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
    // The sky storage BGL and pipeline encode the storage-texture format token,
    // so a format flip forces a full pipeline rebuild rather than only a bind
    // group rebuild. The recreate condition above already covers it.
    if (cache.cubemapFormat !== cubemapFormat) {
      cache.skyPipeline = null;
      cache.skyBGL = null;
    }
    cache.cubemapFormat = cubemapFormat;
    cache.needsUpdate = true;
    // The BGL and pipeline do not depend on size, but the bind group references
    // the storage view, which a size change replaced.
    cache.skyBindGroup = null;
    // The SH bind group references the recreated cube view.
    cache.shBindGroup = null;
    // The history cube and the cached 2d-array views reference the old,
    // now-destroyed cube and are sized and formatted to the old config. Drop
    // the history texture and all blend bind state so the enabled path lazily
    // reallocates against the new cube, and mark history invalid so the next
    // blend seeds at alpha=1 instead of mixing a stale frame.
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

  // The procedural sky compute pass and IBL prefilter run when either the
  // cubemap was just (re)created (`cache.needsUpdate`), or the sun direction
  // has moved by more than `SUN_REFRESH_EPSILON` since the last fill, for the
  // day/night cycle refresh. The squared-distance check is cheap — three
  // multiplies, two adds, no square root — so it runs every frame while the
  // compute and prefilter stay behind the threshold.
  const sunDir = (
    frameState.context as unknown as {
      uniformState?: { sunDirectionWC?: { x: number; y: number; z: number } };
    }
  ).uniformState?.sunDirectionWC ?? { x: 0.3, y: 0.0, z: 0.95 };
  const dx = sunDir.x - cache.lastSunDirX;
  const dy = sunDir.y - cache.lastSunDirY;
  const dz = sunDir.z - cache.lastSunDirZ;
  // Any comparison against NaN is false, so the negation makes the first frame
  // always run.
  const sunMoved = !(dx * dx + dy * dy + dz * dz < SUN_REFRESH_EPSILON_SQ);
  // Re-fill when the effective LUT-path availability flips, so a static,
  // non-sun-moving scene is not stuck on the wrong path. `wantLut` mirrors the
  // predicate `runProceduralSkyFill` uses — context flag on and a scene-light
  // dynamic-lighting mode. If the LUTs are not baked yet the fill falls back to
  // the placeholder and leaves `lastUsed...` false, so this keeps re-trying
  // until the LUTs land, then settles. `usesSceneLightDirection` rather than
  // `!== 0` so the LEGACY_OVERHEAD enum (3), whose IBL light direction is
  // per-texel local up, is treated like NONE; enums 0/1/2 are unaffected.
  const wantLut =
    (frameState.context as unknown as { envMapMultiScatter?: boolean })
      .envMapMultiScatter === true &&
    usesSceneLightDirection(frameState.atmosphere?.dynamicLighting ?? 0);
  const lutPathChanged = wantLut !== cache.lastUsedMultiScatterLut;
  // Re-fill when the live cloud coverage moved, so a static scene re-darkens
  // its IBL as cloud cover changes. The published coverage is already 0 when
  // the cloud-IBL flags are off, so on that path `cloudCoverage` is a constant
  // 0 and this term never trips.
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
  // Re-fill when the full cloud-march path becomes available or unavailable —
  // flag toggled, or the cloud noise just finished baking — so a static scene
  // does not stay on the wrong path. `wantMarch` mirrors the predicate the fill
  // uses: context flag on and a non-zero published coverage. The fill self-heals
  // to the placeholder if the noise is not baked yet and leaves
  // `lastUsedCloudMarch` false, so this keeps re-trying until the noise lands,
  // then settles. With the flag off, `wantMarch` is a constant false and this
  // term never trips.
  const wantMarch =
    (frameState.context as unknown as { cloudsInReflections?: boolean })
      .cloudsInReflections === true && liveCloudCoverage > 0.0;
  // Coverage alone cannot detect a moving or reconfigured density field. The
  // cloud renderer advances this revision at a controlled cadence when any
  // full-march-visible input changes. A revision is relevant only while the
  // full reflected-cloud march is requested, or while the previous fill still
  // contains that march and needs one final teardown fill. That keeps
  // visible-cloud-only animation from launching an otherwise inert cube fill,
  // prefilter and SH projection. Revisions published while the march is off
  // stay unconsumed, so the next opt-in observes the latest state immediately.
  const cloudRevisionChanged =
    (wantMarch || cache.lastUsedCloudMarch) &&
    liveCloudRevision !== cache.lastCloudRevision;
  const cloudMarchPathChanged = wantMarch !== cache.lastUsedCloudMarch;
  // The eclipse-keyed refresh input. `runProceduralSkyFill` dims its whole bake
  // by the scene-light eclipse factor, and the rest of this gate cannot see
  // that: `sunMoved` needs about 0.3 degrees of arc, which a total eclipse's
  // few minutes of totality does not supply under a stepped or paused clock,
  // and the cloud terms are gated on a march that is off by default. Without
  // this term a dimmed bake latches dark and stays dark after third contact.
  //
  // Quantized on the same 1/256 unit grid every other unit-interval IBL input
  // uses, alongside the cloud publish-side snap and
  // `CLOUD_COVERAGE_REFRESH_EPSILON`. It is a snap and compare, not a per-frame
  // delta, so a slow fade still accumulates across a grid edge instead of never
  // firing. The comparison is a level against committed bookkeeping like every
  // other term here, which is what keeps a deferral lossless and makes recovery
  // symmetric with dimming.
  const eclipseEnvBucket = quantizeEclipseEnvironmentRefreshInput(
    resolveEclipseCloudFactor(frameState),
  );
  const eclipseEnvChanged = eclipseEnvBucket !== cache.lastEclipseEnvBucket;
  // Capture refresh gate. Steadily off, there is no capture work. A transition
  // from on to off deliberately contributes one mode edge so a fresh procedural
  // sky erases captured terrain. While on, a moving eye, a new source epoch, or
  // the every-K-frames cadence re-runs the full refresh: each
  // `runProceduralSkyFill` rewrites the whole cube and erases the last
  // capture's terrain, so the terrain composite (`runSceneCapture`, below) must
  // re-run whenever the sky is re-filled, and conversely a camera move must
  // force a sky fill plus re-composite so the reflection tracks the eye.
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
  // The complete dirty predicate, hoisted so the bounded drain sees exactly the
  // condition the refresh body runs under. Every term is a level comparison of
  // live state against committed `cache.last*` bookkeeping, never a consumed
  // edge, which is what makes a deferral lossless: the deferred path commits no
  // bookkeeping, so this identical expression re-evaluates true next frame.
  const refreshRequested =
    cache.needsUpdate ||
    sunMoved ||
    lutPathChanged ||
    // Grouped with the sky-bake terms above rather than with the cloud terms
    // below, because it is deliberately not march-gated.
    eclipseEnvChanged ||
    cloudCoverageMoved ||
    cloudRevisionChanged ||
    cloudMarchPathChanged ||
    captureModeChanged ||
    captureSourceStateChanged ||
    captureRefresh;

  // A refresh is only deferrable while this manager still has valid, published
  // resources for its consumers to keep reading. Anything else requests
  // `ENV_REFRESH_URGENCY_MANDATORY` and bypasses the per-frame budget entirely.
  const hasPublishedResources =
    !cache.needsUpdate && cache.iblCache !== null && cache.shBuffer !== null;
  const refreshUrgency = !hasPublishedResources
    ? ENV_REFRESH_URGENCY_MANDATORY
    : demand === ENV_DEMAND_PROVEN_NONE
      ? ENV_REFRESH_URGENCY_NORMAL
      : ENV_REFRESH_URGENCY_HIGH;

  const refreshGranted =
    refreshRequested &&
    scheduleEnvironmentRefresh(context, manager, refreshUrgency, frameState);

  if (refreshGranted) {
    let sceneCaptureResult: SceneCaptureResultValue =
      SceneCaptureResult.SKY_ONLY;
    const hqOptions = resolveIBLHQOptions(cache, frameState);
    const targetPool = getEnvironmentTargetPool(context);
    const encodingScope = createIBLCommandEncodingScope(
      device,
      "Dynamic Environment Map Refresh",
      getIBLRefreshParameterCapacity(hqOptions),
      targetPool,
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
          targetPool,
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
      // Only a real submission updates the drain's fairness anchor. A refresh
      // that throws mid-encode simply re-requests next frame through the
      // unchanged level-triggered predicate above.
      noteEnvironmentRefreshSubmitted(context, manager);
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
    // Record the coverage this fill used.
    cache.lastCloudCoverage = liveCloudCoverage;
    cache.lastCloudRevision = liveCloudRevision;
    // Committed only here, alongside every other consumed level, so a
    // budget-deferred refresh re-evaluates true next frame.
    cache.lastEclipseEnvBucket = eclipseEnvBucket;
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
  // Expose the SH coefficient buffer for `buildModelIBLEntries`. Present once
  // the first projection has run; the buffer's own control.w gate keeps it
  // inert until the compute pass populates it.
  if (cache.shBuffer) {
    manager._webgpuSHBuffer = cache.shBuffer;
  }

  cache.framesSinceUpdate++;
}

// Minimum sun-direction movement that triggers a sky + IBL refresh.
// (0.005)^2 is about 0.3 degrees of arc on the unit sphere: small enough that
// day/night progressions feel smooth, large enough that a stationary scene does
// not burn a compute pass and IBL prefilter on every frame.
const SUN_REFRESH_EPSILON_SQ = 0.005 * 0.005;

// Minimum cloud-coverage change that triggers an env-cube re-fill. 1/256 is one
// rgba8 quantization step on the cube, so smaller moves are visually
// imperceptible after the SH projection. Any comparison against NaN is false,
// so the negated test makes the first frame always run.
const CLOUD_COVERAGE_REFRESH_EPSILON = 1.0 / 256.0;

// Capture debounce, sitting behind both capture flags. Re-capture when the
// reflective owner's eye moves more than 500 m, or at least every K frames so a
// slow drift or sun-static scene still keeps the reflected terrain fresh. This
// caps the cost of the six-pass capture.
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

// Per-frame EMA blend fraction of the freshly-captured cube folded in; history
// keeps 1-α. 0.15 is roughly a six-frame e-folding time: fast enough to track a
// moving sun without visible lag, slow enough to crossfade smoothly between the
// debounced single-frame refreshes. The fixed point of the EMA for a constant
// static-scene capture is that constant, so the accumulated cube converges to
// the same look as the single-frame cube produced with accumulation off.
const ENV_TEMPORAL_ALPHA = 0.15;
// Sun-direction delta (unit-sphere squared distance) large enough to reset the
// history so a day-to-night-scale jump does not smear. (0.05)^2 is about 2.9°,
// an order of magnitude above the per-frame `SUN_REFRESH_EPSILON_SQ` refresh
// threshold, so ordinary smooth sun progression accumulates while a large jump
// snaps.
const ENV_TEMPORAL_SUN_RESET_SQ = 0.05 * 0.05;
// Camera/eye-translation delta (m^2) large enough to reset the history. 2 km is
// well above the 500 m capture-refresh debounce, so a small drift accumulates
// while a teleport-scale move snaps the env map to the new view without smear.
const ENV_TEMPORAL_CAMERA_RESET_SQ = 2000.0 * 2000.0;

// The temporal env-cube accumulation pass, inserted between the cube capture
// and the IBL prefilter only while `envMapTemporalAccumulation` is on — the
// caller gates the whole call. It:
//
//   1. Lazily allocates the history cube (same format and size as the main
//      cube) and the blend pipeline / bind state inside this function, so the
//      disabled path, which never reaches it, allocates nothing.
//   2. Decides α: 1.0 on the first enabled frame, after a cube recreate, or on
//      a large sun or camera delta — a history reset, current only, no smear;
//      otherwise `ENV_TEMPORAL_ALPHA` for the EMA crossfade.
//   3. Runs a compute pass, out = mix(history, current_jittered, α), writing
//      the blended result into the main cube's storage view so the downstream
//      prefilter and SH read the accumulated cube.
//   4. Copies the accumulated main cube into history for the next frame.
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

  // Lazy history cube, same format and size as the main cube. The blend samples
  // the main cube and the history cube; its write target is the separate
  // accumCube. No texture is both read and written in the pass, which is what
  // avoids the WebGPU usage-scope hazard.
  if (!cache.historyCube) {
    cache.historyCube = device.createTexture({
      label: "DynEnvMap History Cube",
      size: { width: cache.size, height: cache.size, depthOrArrayLayers: 6 },
      format,
      mipLevelCount: 1,
      // TEXTURE_BINDING because the blend reads it, COPY_DST because the
      // accumulated cube is copied into it each frame.
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
    // A first history allocation has no valid accumulated frame yet.
    cache.historyValid = false;
    cache.blendBindGroup = null;
  }

  // Lazy accumulation cube: the blend's storage write target.
  if (!cache.accumCube) {
    cache.accumCube = device.createTexture({
      label: "DynEnvMap Accum Cube",
      size: { width: cache.size, height: cache.size, depthOrArrayLayers: 6 },
      format,
      mipLevelCount: 1,
      // STORAGE_BINDING because the blend writes it, COPY_SRC because it is
      // copied into both the main cube and the history cube.
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

  // 2d-array sampled view of the main cube, the just-captured "current". The
  // existing `storageView` is the 2d-array write target, and a sampled texture
  // binding needs a non-storage view, so a dedicated one is cached here.
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

  // Blend pipeline and BGL: built once per cache, rebuilt on a format flip.
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

  // Decide α: reset or EMA. Reset when there is no valid history yet (first
  // enabled frame, or after a recreate), on a large sun delta, or on a large
  // camera/eye translation. A reset uses α=1 — current only, with history
  // seeded by the copy below — so a big change cannot smear.
  const sdx = sunDir.x - cache.lastBlendSunX;
  const sdy = sunDir.y - cache.lastBlendSunY;
  const sdz = sunDir.z - cache.lastBlendSunZ;
  // Any comparison against NaN is false, so the first run always resets.
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

  // Per-face Hammersley-rotated sub-texel jitter. The base-2 radical inverse of
  // the frame index gives a low-discrepancy 1-D sequence; pairing it with the
  // golden-ratio fractional sequence for the second axis gives a
  // Hammersley-like 2-D point, recentred to [-0.5, 0.5] texels. It is subtle
  // for the deterministic capture and load-bearing for a stochastic
  // cloud-in-IBL consumer. Zeroed on reset, so current is sampled exactly.
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
  // Copy the accumulated cube into the main cube, so the downstream prefilter
  // and SH read the accumulated result, and into the history cube for the next
  // frame. Both are same-format, same-size 2d textures with 6 array layers.
  // Copy commands are encoder-level, so running them outside the compute pass
  // avoids any read/write alias with the blend dispatch's storage write.
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

// The atmosphere-derived sky fill's uniform block, in byte-exact lockstep with
// `ProceduralSkyCubemap.wgsl`'s SkyUniforms. In the WGSL uniform layout each
// vec3 occupies a 16-byte slot and the trailing f32 packs into that slot's
// fourth lane, so the Float32Array index is the byte offset divided by 4:
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
// The block is add-only: rows are appended, never reordered or reused, so an
// existing offset stays valid. With the reflected-cloud march off, slot 37
// packs cloudMarch = 0, the WGSL march branch is never taken, and the noise
// bindings are 1×1×1 placeholders, so the fill is unchanged by the march rows.
const SKY_UNIFORM_FLOATS = 56 + CLOUD_DENSITY_ORIGIN_PHASE_FLOATS;
const SKY_UNIFORM_SIZE = SKY_UNIFORM_FLOATS * 4;
const PROCEDURAL_SKY_SOURCE = `${CloudDensityDomainWGSL}\n${ProceduralSkyCubemapWGSL}`;

// Reused scratch so the per-fill pack does not allocate.
const scratchPosition = new Cartesian3();
const scratchSurfacePosition = new Cartesian3();

// Minimal shape of `frameState.mapProjection.ellipsoid`, which is opaque in
// cesium-js-types.d.ts, for the WebGL-parity radii derivation in
// `DynamicEnvironmentMapManager.js`'s `atmosphereNeedsUpdate`.
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
// The model IBL sky fill's fallback set, passed to the shared
// `resolveAtmosphereScattering` resolver. These are the same `DEFAULT_*`
// constants declared above, so resolving through the shared seam produces the
// same values an inline `?? DEFAULT` read would when `scene.atmosphere` leaves
// a field unset.
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
// WebGL's outer-atmosphere shell scale (`DynamicEnvironmentMapManager.js`
// `atmosphereNeedsUpdate`: `const outerEllipsoidScale = 1.025`). This is not
// the 111 km czm_computeScattering shell, which lives inside the WGSL
// scattering march as ATMOSPHERE_THICKNESS in ProceduralSkyCubemap.wgsl.
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

// Lazily builds and dispatches the procedural sky shader, filling the cubemap's
// 6 faces in a single dispatch whose Z dimension is 6. The uniform encodes sun
// direction plus sky, ground and sun colors; the sun direction comes from
// `frameState.context.uniformState.sunDirectionWC`, so the procedural sky
// tracks the scene's sun.
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

  // Atmosphere-derived uniforms, mirroring ComputeRadianceMapFS. For the sun
  // direction, SUNLIGHT uses frameState.sunDirectionWC, SCENE_LIGHT uses
  // uniformState.lightDirectionWC, and NONE — the default — resolves to the
  // local zenith per direction inside the shader, so sunDirectionWC is a safe
  // placeholder on that path.
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

  // Resolve the scattering terms and dynamicLighting through the shared
  // `WebGPUAtmosphereUniforms` seam. It reads the same source with the same
  // fallbacks, supplied through MODEL_ATMOSPHERE_DEFAULTS, as an inline
  // `frameState.atmosphere?.X ?? DEFAULT` would.
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

  // Position and ENU-to-fixed basis, WGS84 by default, matching the WebGL
  // DynamicEnvironmentMapManager. Radii follow
  // `DynamicEnvironmentMapManager.js`'s `atmosphereNeedsUpdate`, with
  // u_radiiAndDynamicAtmosphereColor semantics:
  //   inner = |scaleToGeodeticSurface(position)|  (the surface radius under
  //           the model, not the model position's magnitude)
  //   outer = inner × 1.025                       (not inner + 111 km — the
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

  // The eclipse dims this bake. `scatteringIntensity` is the manager-level
  // multiplier applied to the final sky, ground and reflected-cloud radiance
  // (the WGSL lines `skyColor * scatteringIntensity` and
  // `lit * u.scatteringIntensity`), and its WebGL twin is `adjustments.w` /
  // `u_brightnessSaturationGammaIntensity.w` in
  // `Scene/DynamicEnvironmentMapManager.js`, so both backends dim the same
  // lockstep scalar and neither needs a shader edit. The SH projection's
  // intensity multiply is deliberately left undimmed on both backends: it
  // projects this cube, so it inherits the dimming exactly once.
  //
  // This is only safe because `eclipseEnvBucket` gives the refresh gate an
  // eclipse-keyed input. Dimming a debounced bake without one produces the
  // stale-dark latch — the same trap that keeps the eclipse factor out of the
  // sun-direction-debounced sky-atmosphere LUT bake.
  const skyColorScattering = applyEclipseCloudDimming(
    manager.atmosphereScatteringIntensity ?? 2.0,
    resolveEclipseCloudFactor(frameState),
  );
  const gamma = manager.gamma ?? 1.0;
  const groundColor = manager.groundColor ?? {
    red: 0.45,
    green: 0.45,
    blue: 0.27,
  };
  const groundAlbedo = manager.groundAlbedo ?? 0.31;

  // Opt-in: source the sky color from the sun-relative sky-view and
  // multiple-scattering LUTs — the same tables the visible SkyAtmosphere
  // samples — instead of the inline march, so the reflected env sky matches the
  // visible multiple-scattering sky. Read off the context's getter, threaded
  // from `contextOptions.webgpu.envMapMultiScatter`. The shader gates the LUT
  // path to non-NONE dynamic lighting because it bakes a single light
  // direction; under NONE, the default smooth ambient, the flag stays off so
  // the radially-symmetric inline march keeps the at-rest IBL look.
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
  // The shader path is active only when both real LUT views are bound. When it
  // is off, or the LUTs are not baked yet, the 1×1 placeholder is bound and the
  // flag is 0, leaving the inline march.
  const useMultiScatterLut = lutSkyViewView !== null && lutMsView !== null;
  // Record the effective path so the update gate re-fills when it flips, for
  // instance when the LUTs finish baking a frame after the first fill on an
  // otherwise static scene.
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
  // The WGSL LUT flag: 1 only when the real LUT views are bound, otherwise 0 —
  // the default, and the value while the LUTs are unbaked — which selects the
  // inline march.
  data[35] = useMultiScatterLut ? 1.0 : 0.0;
  // Effective cloud coverage in [0,1]. The cloud renderer publishes it onto
  // `context._cloudCache.iblCoverage` every frame, already gated to 0 unless
  // both `globe.showProceduralClouds` and `globe.cloudContributesIBL` are on.
  // At 0, the default, the WGSL overcast blend is skipped.
  const cloudCache = (
    frameState.context as unknown as {
      _cloudCache?: {
        iblCoverage?: number;
        // The real visible-cloud march params, published every frame from the
        // env-effects dispatch, where `scene.globe` is in scope. `FrameState`
        // has no `globe` field, so reading them here is what lets the reflected
        // deck track live customization.
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

  // The full per-face cloud march. Gated on the `cloudsInReflections` context
  // flag and on the baked cloud noise existing on `_cloudCache.noise`, which
  // the cloud renderer bakes once the volumetric clouds run. With either
  // missing, the march flag is 0, the WGSL march branch is never taken, and the
  // 1×1×1 placeholder noise is bound. The gate is also combined with a non-zero
  // published coverage, so the flag set on a clear scene stays inert.
  const ctxClouds = frameState.context as unknown as {
    cloudsInReflections?: boolean;
  };
  const cloudNoise = cloudCache?.noise ?? null;
  // Match the visible renderer's Perlin-Worley shape selection: sample the
  // Perlin-Worley base shape view only when the visible clouds are in that
  // morphology and the view actually baked, and otherwise sample the value-FBM
  // shape view, which is the visible default. Always preferring the
  // Perlin-Worley view when present would put the reflected clouds on a
  // different base shape from the rendered clouds.
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
  // Record the effective march path so the update gate re-fills when it flips,
  // for instance when the cloud noise finishes baking a frame after the first
  // sky fill, or the flag toggles on a static scene.
  cache.lastUsedCloudMarch = cloudMarchActive;

  // Cloud-march params read from `_cloudCache`, the same channel as
  // `iblCoverage`, published every frame by the cloud renderer's
  // `publishCloudIblCoverage` where `scene.globe` is in scope. `FrameState` has
  // no `globe` field, so reading these through a `frameState.globe` cast would
  // yield undefined and freeze every param at its constructor default, silently
  // decoupling the reflected deck from user cloud customization. The cache
  // seeds with the Globe constructor defaults, so the pre-publish value still
  // equals the visible default. All of it is inert when `cloudMarch` is 0.
  const deckBottom = cloudCache?.iblDeckBottom ?? 1500.0;
  const deckTop = cloudCache?.iblDeckTop ?? 4000.0;
  const cloudDensity = cloudCache?.iblDensity ?? 0.3;
  const windX = cloudCache?.iblWindX ?? 0.7;
  const windY = cloudCache?.iblWindY ?? 0.3;
  const windSpeed = cloudCache?.iblWindSpeed ?? 15.0;
  // The visible renderer's scene-clock-relative time. A wall-clock capture
  // drifts, so reflected formations disagree with paused or scrubbed scenes.
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
  // data[38] cloudPlanetRadius is unread: the WGSL march takes the radius from
  // the passed `innerR` / `u.innerRadius`, never this slot. It is packed for
  // documentation and kept add-only so the row layout and every later offset
  // stay stable.
  data[38] = innerRadius;
  // data[39] ellipsoidHeight feeds the view-origin scaling and the skyAlpha /
  // ground-blend height terms in the WGSL. A ground-level model packs 0.
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

  // LUT sampler and 1×1 white placeholder, built once. The placeholder backs
  // bindings 3 and 4 whenever the real sky-view / multiple-scattering LUT views
  // are unavailable, keeping the bind group valid and constant.
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
    // rgba16float black. It is never sampled while the flag is off, so the
    // value does not reach the output; zero is the safe inert default.
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

  // 1×1×1 white 3D placeholder and sampler, built once. They back bindings 5,
  // 6 and 7 whenever the cloud march is off, or the cloud noise has not baked,
  // keeping the bind group valid and constant; the WGSL `cloudMarch` flag keeps
  // them unsampled.
  if (!cache.cloudPlaceholderView) {
    cache.cloudPlaceholderTex = device.createTexture({
      label: "DynEnvMap Cloud Noise Placeholder",
      size: { width: 1, height: 1, depthOrArrayLayers: 1 },
      format: "rgba8unorm",
      dimension: "3d",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    // White. It is never sampled while the march is off, and white is the inert
    // "no erosion, full shape" default.
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
  // Bind the baked cloud noise shared from the cloud renderer only while the
  // march is active, and the placeholder otherwise. The shape view follows the
  // cloud renderer's own Perlin-Worley preference.
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
  // This dispatch is the environment/IBL leg of the cloud march — it runs
  // `marchCloudFaceIBL` when `cloudMarch > 0` — so it carries its own GPU
  // timestamp lane. `withComputePassTimestamps` returns the exact descriptor
  // when the profiler is not armed, leaving the default path unchanged, and the
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

// The SH-L2 projection pass. Projects the freshly-filled radiance cube onto 9
// SH-L2 coefficients and writes them, scaled by atmosphereScatteringIntensity
// to match WebGL's third-step multiply, into a STORAGE|UNIFORM buffer the model
// binds at SHUniforms binding 36. This mirrors WebGL's `ComputeIrradianceFS`
// plus `updateSphericalHarmonicCoefficients`, but writes the buffer directly
// instead of rendering to a texture and reading it back.
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

  // Rebuild the bind group when the cube view changed; a cube recreate resets
  // `shBindGroup` to null.
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

// Runs `WebGPUIBLPipeline.generateIBLMaps`, the same compute path
// `WebGPUImageBasedLighting` uses for explicit-source IBL. The only difference
// is the source: here it is the procedural cubemap just filled above, where for
// explicit IBL it is a user-supplied HDR cubemap.
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
  // `generateIBLMaps` does not read `sourceVersion`; only the explicit-IBL
  // `WebGPUImageBasedLighting` caller uses it as a regeneration gate, so there
  // is nothing to bump here. `WebGPUIBLPipeline` destroys the old irradiance
  // and radiance textures before recreating them, so re-running the prefilter
  // on each sun-direction refresh does not leak GPU memory.
  //
  // The prefilter quality is opt-in. The default 'parity' passes `undefined`,
  // so `generateIBLMaps` takes the mip-0 path with no source-mip pass and the
  // `main` entry point; 'high' passes the source cube and format so the
  // prefilter box-downsamples the source mip chain and samples a
  // GGX-pdf-derived LOD through `mainHQ`.
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
  // The manager owns the lazily allocated capture depth attachment. It is not
  // reachable through the IBL cache, so it must be released explicitly on
  // manager destruction or device recovery.
  if (cache.captureDepthTexture) {
    cache.captureDepthTexture.destroy();
  }
  cache.captureDepthTexture = null;
  cache.captureDepthView = null;
  cache.captureDepthSize = 0;
  // Release the history and accumulation cubes and the blend uniform buffer.
  // All three are null while temporal accumulation is off, so the branches skip.
  if (cache.historyCube) {
    cache.historyCube.destroy();
  }
  if (cache.accumCube) {
    cache.accumCube.destroy();
  }
  if (cache.blendUniformBuffer) {
    cache.blendUniformBuffer.destroy();
  }
  // The manager owns only the 1×1 LUT placeholder. The real sky-view and
  // multiple-scattering LUT textures belong to the perf manager and must not be
  // destroyed here.
  if (cache.lutPlaceholderTex) {
    cache.lutPlaceholderTex.destroy();
  }
  // The manager owns only the 1×1×1 cloud noise placeholder. The real baked
  // cloud noise belongs to the cloud renderer (`_cloudCache.noise`) and must
  // not be destroyed here.
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
