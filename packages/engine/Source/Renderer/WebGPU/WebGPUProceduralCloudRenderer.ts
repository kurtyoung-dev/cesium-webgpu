/// <reference types="@webgpu/types" />
/**
 * WebGPU Procedural Cloud Renderer
 *
 * Renders volumetric clouds as a full-screen pass using ray marching.
 * Activated by a VOLUMETRIC {@link CloudCollection} (the Scene/Globe managed
 * `globe.defaultCloudCollection`, or a user collection) — cloud-unification epic
 * slice 4B removed the legacy `globe.showProceduralClouds` / `globe.cloud*` API.
 *
 * Configuration is carried by the collection's `.volumetric` {@link CloudVolumetrics}
 * (identical field names to the former `globe.cloud*`), resolved into a
 * {@link CloudVolumetricsConfig} snapshot each frame:
 *   - enabled: boolean (default false) → collection renderMode VOLUMETRIC
 *   - cloudCoverage: number 0-1 (default 0.5)
 *   - cloudLayerBottom: number meters (default 1500)
 *   - cloudLayerTop: number meters (default 4000)
 *   - cloudWindSpeed: number m/s (default 15)
 *   - cloudWindDirection: {x, y} (default {x: 0.7, y: 0.3})
 *   - cloudDensity: number (default 0.3)
 *   - cloudQuality: number 32-128 steps (default 64)
 *
 * @private
 */
import ProceduralCloudsWGSL from "../../Shaders/WebGPU/Environment/ProceduralClouds.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  texture,
  sampler,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import {
  resolveCloudPreset,
  CloudNoiseSource,
  CLOUD_QF_OCTAVES_SHIFT,
  CLOUD_QF_NOISE_BAKED,
  CLOUD_QF_HALF_RES,
  CLOUD_QF_TEMPORAL,
  CLOUD_QF_AERIAL_LUT,
  CLOUD_QF_AMBIENT_LUT,
  CLOUD_QF_LIGHT_CONE,
  CLOUD_QF_MULTI_DECK,
  CLOUD_QF_HIGH_PRECISION,
} from "./WebGPUCloudTierPresets.js";
// Batch 445 (4.12 CLOUD-RTE) — RTE high/low camera split for the camera-relative
// high-precision cloud march. Only the encoded floats (slots 120-127) are sourced
// from this; the WGSL reads them solely inside the CLOUD_QF_HIGH_PRECISION branch.
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
// V9 (Batch 432) — half-res bilateral-upscale composite shader.
import CloudUpscaleWGSL from "../../Shaders/WebGPU/Environment/CloudUpscale.js";
// V10 (Batch 433) — temporal reprojection + accumulation resolve shader.
import CloudTemporalResolveWGSL from "../../Shaders/WebGPU/Environment/CloudTemporalResolve.js";
import { buildCloudNoiseResources } from "./WebGPUCloudNoiseResources.js";
import type { CloudNoiseResources } from "./WebGPUCloudNoiseResources.js";
// V11 (Batch 408) — per-genus vertical-density profiles. Backend-neutral Scene
// data (the WGSL just reads the packed profile floats).
import CloudTypeProfile from "../../Scene/CloudTypeProfile.js";
import CloudType from "../../Scene/CloudType.js";

// CloudUniforms float count — grown ADD-ONLY: 64→80 (weather seam) → 96 (W1-W8
// lighting) → 104 (Batch 407 dials 96-103) → 108 (Batch 408 V11 profile 104-107;
// Batch 409 renamed pads 105-106 → nearPlane/farPlane, no count change) → 112
// (Batch 434 atmosphere-LUT coupling: aerialLutMode/ambientLutMode/atmosphereThickness/pad 108-111)
// → 120 (Batch 443 multi-deck: multiDeck/pad + deckBoundsLow/Mid/High vec2 112-119)
// → 128 (Batch 445 CLOUD-RTE: encodedCameraHigh.xyz+pad 120-123, encodedCameraLow.xyz+pad 124-127)
// → 132 (Batch 555 E2 CLOUD-MAMMATUS: mammatusStrength/Scale/Depth+pad 128-131).
// → 136 (Batch 610 E1 CLOUD-EXOTIC-SPECIES: speciesMode/Strength/Scale/Param 132-135).
// → 140 (Batch 611 E2 CLOUD-EXOTIC-FEATURES-REMAINING: featureMode/Strength/Scale/Param 136-139).
// → 144 (Batch 612 E3 CLOUD-EXOTIC-SPECIAL: specialShadeMode/Strength/Scale/Param 140-143).
// → 148 (Batch 634 C6-CLOUD-STBN-TAAU LOD half: marchStepGrowth/maxRayDistance+2 pads 144-147).
const CLOUD_UNIFORM_FLOATS = 148; // MUST equal the CloudUniforms struct length in WGSL
const CLOUD_UNIFORM_BYTES = CLOUD_UNIFORM_FLOATS * 4;
const WGS84_EQUATORIAL_RADIUS = 6378137.0;
const WGS84_POLAR_RADIUS = 6356752.314245179;
// Procedural weather-map texture (coarse global coverage field).
const WEATHER_TEX_W = 256;
const WEATHER_TEX_H = 128;
// Batch 445 (4.12 CLOUD-RTE) — reused EncodedCartesian3 result for the per-frame
// camera high/low split (avoids a per-frame allocation). Only written when the
// camera position is defined; read into the cloud UB slots 120-127.
const scratchEncodedCamera = new EncodedCartesian3();

export interface CloudCache {
  pipeline: GPURenderPipeline | null;
  uniformBuffer: GPUBuffer | null;
  bindGroupLayout: GPUBindGroupLayout | null;
  sampler: GPUSampler | null;
  uniformData: Float32Array;
  initialized: boolean;
  // Weather Phase 0 — clock-bind. Day-seconds of the first frame, cached so the
  // cloud `time` uniform starts near 0 (keeps the wind offset in f32 precision).
  timeEpoch: number | null;
  // Weather Phase 1 — weather-map seam.
  weatherTexture: GPUTexture | null; // 2d-array depth-1 coverage field
  weatherView: GPUTextureView | null;
  weatherFallbackView: GPUTextureView | null; // 1×1 white, bound when disabled
  weatherSampler: GPUSampler | null;
  // Weather ingest (Phase 1) — which bytes the weatherTexture currently holds:
  // -2 = nothing, -1 = procedural map, >=0 = WeatherProvider.version uploaded.
  weatherProviderVersion: number;
  // V2 — 3D noise bake (bound at 6/7/8; INERT until V3 samples it).
  noise: CloudNoiseResources | null;
  noiseBaked: boolean;
  noiseFallbackTexture: GPUTexture | null;
  noiseFallbackView: GPUTextureView | null; // 1×1×1 white 3D, bound until baked
  noiseFallbackSampler: GPUSampler | null;
  // V9 (Batch 432) — half-res cloud target + bilateral-upscale pass. ALL null on
  // the default full-res path (allocated lazily only when a tier resolves
  // renderResScale<1). `halfPipeline` renders the raymarch into `halfView`
  // (rgba16float); `upscalePipeline` reads it + full-res scene/depth and
  // composites to the canvas. The half-res target is re-created on canvas resize.
  halfTexture: GPUTexture | null;
  halfView: GPUTextureView | null;
  halfWidth: number;
  halfHeight: number;
  halfPipeline: GPURenderPipeline | null; // raymarch → rgba16float half target
  upscalePipeline: GPURenderPipeline | null;
  upscaleBindGroupLayout: GPUBindGroupLayout | null;
  upscaleUniformBuffer: GPUBuffer | null;
  upscaleUniformData: Float32Array;
  upscaleSampler: GPUSampler | null;
  frameCounter: number; // per-frame Bayer index for the half-res jitter
  // V10 (Batch 433) — temporal reprojection + accumulation. ALL null on the
  // default / cinematic / escape-hatch path (temporal OFF → byte-identical). The
  // history is DOUBLE-BUFFERED (ping-pong) at HALF-RES (it accumulates the
  // premultiplied half-res cloud): `temporalHistory[read]` is reprojected + blended
  // with this frame's freshly-marched `halfTexture` by the resolve pass, which
  // writes `temporalHistory[write]`; the upscale pass then reads that written
  // history instead of `halfTexture`. Re-created on canvas/half-res resize. `temporalFirstFrame`
  // forces an identity-history seed (no startup flash, TAA/CSM first-frame convention).
  temporalHistory: [GPUTexture | null, GPUTexture | null];
  temporalHistoryView: [GPUTextureView | null, GPUTextureView | null];
  temporalWidth: number;
  temporalHeight: number;
  temporalRead: number; // ping-pong index (0/1) of the history to READ this frame
  temporalFirstFrame: boolean;
  temporalPipeline: GPURenderPipeline | null; // reproject + clamp + blend → new history
  temporalBindGroupLayout: GPUBindGroupLayout | null;
  temporalUniformBuffer: GPUBuffer | null;
  temporalUniformData: Float32Array;
  temporalSampler: GPUSampler | null;
  // Batch 434 (3.3 + 3.4) — atmosphere-LUT coupling. The cloud BGL ALWAYS declares
  // the three LUT textures (sky-view / MS / transmittance) + a linear sampler at
  // bindings 9-12 so the pipeline layout never forks. When the modes are off (or the
  // LUTs aren't baked) a 1×1 BLACK rgba16float placeholder is bound — the WGSL gates
  // each LUT sample on its mode bit AND a non-zero radiance, so a black placeholder
  // is the same as "unbaked" and the legacy heuristic/constant path runs.
  lutPlaceholderTexture: GPUTexture | null;
  lutPlaceholderView: GPUTextureView | null; // 1×1 black, bound when off/unbaked
  lutSampler: GPUSampler | null;
  // ── Batch 437 (CLOUD-SHADOWS) — sun-view "beer shadow map" ──
  // Allocated ONLY when `globe.cloudCastShadows` is on; otherwise everything here
  // stays null and consumers read the shared 1×1-white placeholder
  // (`shadowPlaceholderView`, optical depth 0 → transmittance 1). The map stores the
  // cloud optical depth (Σ density·length) along the sun ray, rasterized from the
  // sun's orthographic view by the `cloudShadowMain` entry point. `shadowSunViewVP`
  // is the world→sun-clip matrix consumers project a world point through to read the
  // column's optical depth; `shadowActive` is the per-frame "real map is bound" flag
  // (consumers gate on it so the off path never samples a stale map).
  shadowTexture: GPUTexture | null;
  shadowView: GPUTextureView | null; // r16float, sun-view optical depth
  shadowPlaceholderTexture: GPUTexture | null;
  shadowPlaceholderView: GPUTextureView | null; // 1×1 r16float zero (no shadow)
  shadowSampler: GPUSampler | null; // linear clamp
  shadowPipeline: GPURenderPipeline | null;
  shadowBindGroupLayout: GPUBindGroupLayout | null;
  shadowUniformBuffer: GPUBuffer | null; // CloudShadowUniforms (binding 13)
  shadowUniformData: Float32Array;
  shadowSize: number; // current square shadow-map resolution
  // Stashed each frame for the consumers (globe terrain / aerial / fog / env):
  shadowSunViewVP: Float32Array; // 16 floats, column-major world→sun-clip
  shadowActive: boolean; // true when the real map was rendered this frame
  shadowAbsorption: number; // absorptionCoeff used so consumers' exp() matches
  // ── CLOUD-LOD-R5-CASCADED-CLOUD-SHADOW-MAP — opt-in 3-cascade atlas ──
  // Allocated ONLY when `config.cloudShadowCascades` is on (and cast shadows).
  // The atlas is 512×1536 r16float: three 512² tiles stacked (tile 0 = top =
  // finest near cascade). Rendered by three viewport-scoped draws of the same
  // `cloudShadowMain` entry point, each fed its own cascade uniforms via a
  // 256-aligned slice of `shadowCascadeUniformBuffer`. The globe terrain reads
  // this atlas (via the cascade branch); aerial/fog keep reading the single map.
  shadowCascadeTexture: GPUTexture | null;
  shadowCascadeView: GPUTextureView | null; // r16float atlas, 3 stacked tiles
  shadowCascadeUniformBuffer: GPUBuffer | null; // 3×256B CloudShadowUniforms
  shadowCascadeUniformData: Float32Array; // 3×64 floats (256B stride)
  shadowCascadeVP: Float32Array; // 48 floats, 3 forward VPs for the consumers
  shadowCascadeActive: boolean; // true when the atlas was rendered this frame
  shadowCascadeSize: number; // per-tile square resolution currently allocated
  // Item 4.2 (CLOUD-IBL, Batch 441) — effective cloud coverage in [0, 1] that
  // the dynamic-env-map sky fill darkens + flattens its radiance toward, so an
  // overcast procedural-cloud sky yields a dim, flat ambient on lit glTF models
  // / 3D tiles (via the SH-L2 projection of the env cube) and the sky-LUT fog
  // ambient. Published every frame by the environmental-effects dispatch
  // (`publishCloudIblCoverage`) — REGARDLESS of frustum culling or whether the
  // cloud raymarch ran — so toggling `showProceduralClouds` / `cloudContributesIBL`
  // off resets it to 0 (no staleness). 0 (default / both flags off) → the env
  // fill's overcast blend is skipped → byte-identical to the pre-4.2 cube.
  iblCoverage: number;
  // Item 3-C (CLOUD-IBL-FULL, Batch 450) — the real visible-cloud march params,
  // published every frame alongside `iblCoverage` from the env-effects dispatch
  // (where `scene.globe` is genuinely in scope). The dynamic-env-map manager
  // reads THESE (not the nonexistent `frameState.globe`) so the reflected IBL
  // cloud deck tracks the user's live cloud customization (deck altitude, wind,
  // density) instead of frozen constructor defaults. `iblPWActive` mirrors the
  // visible renderer's `cloudNoiseMorphology === "perlin-worley"` decision so
  // the IBL march samples the SAME baked base shape view the visible deck does.
  // These are inert on the OFF path — the manager only consumes them when the
  // `cloudsInReflections` flag is on AND coverage > 0 (the march gate).
  iblDeckBottom: number;
  iblDeckTop: number;
  iblWindX: number;
  iblWindY: number;
  iblWindSpeed: number;
  iblDensity: number;
  iblPWActive: boolean;
  // ── TAKRAM-9 (cloud-aware god rays) — screen-space transmittance mask ──
  // Allocated ONLY when a consumer (the PP god-ray pass) requests the mask via
  // `setCloudTransmittanceCapture(context, true)`. Everything here stays null on
  // the default path so the shipped cloud composite pass is byte-identical. When
  // capture is on, a dedicated full-res r8unorm target is rendered by the
  // `fragmentCloudMaskMain` entry point (transmittance = Πᵢ(1-αᵢ)) right after
  // the composite pass, sharing the SAME per-frame bind group / uniforms.
  maskCaptureEnabled: boolean;
  maskTexture: GPUTexture | null;
  maskView: GPUTextureView | null; // r8unorm, 1=clear 0=opaque cloud
  maskWidth: number;
  maskHeight: number;
  maskPipeline: GPURenderPipeline | null;
  maskShaderModule: GPUShaderModule | null;
  maskRenderedThisFrame: boolean;
}

function ensureCloudCache(context: CesiumGraphicsContext): CloudCache {
  if (!context._cloudCache) {
    context._cloudCache = {
      pipeline: null,
      uniformBuffer: null,
      bindGroupLayout: null,
      sampler: null,
      uniformData: new Float32Array(CLOUD_UNIFORM_FLOATS),
      initialized: false,
      timeEpoch: null,
      weatherTexture: null,
      weatherView: null,
      weatherFallbackView: null,
      weatherSampler: null,
      weatherProviderVersion: -2,
      noise: null,
      noiseBaked: false,
      noiseFallbackTexture: null,
      noiseFallbackView: null,
      noiseFallbackSampler: null,
      halfTexture: null,
      halfView: null,
      halfWidth: 0,
      halfHeight: 0,
      halfPipeline: null,
      upscalePipeline: null,
      upscaleBindGroupLayout: null,
      upscaleUniformBuffer: null,
      upscaleUniformData: new Float32Array(UPSCALE_UNIFORM_FLOATS),
      upscaleSampler: null,
      frameCounter: 0,
      temporalHistory: [null, null],
      temporalHistoryView: [null, null],
      temporalWidth: 0,
      temporalHeight: 0,
      temporalRead: 0,
      temporalFirstFrame: true,
      temporalPipeline: null,
      temporalBindGroupLayout: null,
      temporalUniformBuffer: null,
      temporalUniformData: new Float32Array(TEMPORAL_UNIFORM_FLOATS),
      temporalSampler: null,
      lutPlaceholderTexture: null,
      lutPlaceholderView: null,
      lutSampler: null,
      shadowTexture: null,
      shadowView: null,
      shadowPlaceholderTexture: null,
      shadowPlaceholderView: null,
      shadowSampler: null,
      shadowPipeline: null,
      shadowBindGroupLayout: null,
      shadowUniformBuffer: null,
      shadowUniformData: new Float32Array(CLOUD_SHADOW_UNIFORM_FLOATS),
      shadowSize: 0,
      shadowSunViewVP: new Float32Array(16),
      shadowActive: false,
      shadowAbsorption: 0.04,
      shadowCascadeTexture: null,
      shadowCascadeView: null,
      shadowCascadeUniformBuffer: null,
      shadowCascadeUniformData: new Float32Array(
        CLOUD_SHADOW_CASCADE_COUNT * CLOUD_SHADOW_CASCADE_STRIDE_FLOATS,
      ),
      shadowCascadeVP: new Float32Array(CLOUD_SHADOW_CASCADE_COUNT * 16),
      shadowCascadeActive: false,
      shadowCascadeSize: 0,
      iblCoverage: 0.0,
      // Item 3-C (CLOUD-IBL-FULL, Batch 450) — seed with the Globe constructor
      // defaults so a pre-publish read still matches the visible defaults.
      iblDeckBottom: 1500.0,
      iblDeckTop: 4000.0,
      iblWindX: 0.7,
      iblWindY: 0.3,
      iblWindSpeed: 15.0,
      iblDensity: 0.3,
      iblPWActive: false,
      maskCaptureEnabled: false,
      maskTexture: null,
      maskView: null,
      maskWidth: 0,
      maskHeight: 0,
      maskPipeline: null,
      maskShaderModule: null,
      maskRenderedThisFrame: false,
    };
  }
  return context._cloudCache;
}

/**
 * TAKRAM-9 — request (or release) the per-frame screen-space cloud
 * transmittance mask. The PP god-ray pass turns this on when cloud-aware god
 * rays are active AND procedural clouds are enabled; the cloud renderer then
 * renders the `fragmentCloudMaskMain` pass into a dedicated full-res r8unorm
 * target after the composite pass. Default OFF → no mask pipeline/texture is
 * allocated and the cloud render is byte-identical.
 */
export function setCloudTransmittanceCapture(
  context: CesiumGraphicsContext,
  enabled: boolean,
): void {
  const cache = context._cloudCache;
  if (!cache) {
    // No cloud cache yet — stash the request on a lazily-created cache so the
    // first cloud frame honors it.
    if (enabled) ensureCloudCache(context).maskCaptureEnabled = true;
    return;
  }
  cache.maskCaptureEnabled = enabled;
}

/**
 * TAKRAM-9 — the screen-space cloud transmittance view rendered THIS frame, or
 * null when capture is off / no cloud pass ran (the god-ray pass then falls
 * back to its white 1×1 = no attenuation). `maskRenderedThisFrame` guards
 * against a consumer reading a stale map on a frame the cloud march was culled.
 */
export function getCloudTransmittanceView(
  context: CesiumGraphicsContext,
): GPUTextureView | null {
  const cache = context._cloudCache;
  if (!cache || !cache.maskRenderedThisFrame) return null;
  return cache.maskView;
}

/**
 * Item 4.2 (CLOUD-IBL, Batch 441) — publish the effective cloud coverage the
 * dynamic-env-map sky fill uses to darken + flatten its radiance. Called every
 * frame from the environmental-effects dispatch (NOT from the culled raymarch),
 * so flipping `showProceduralClouds` / `cloudContributesIBL` off immediately
 * resets the published coverage to 0 (the env fill's overcast blend is then
 * skipped → byte-identical to the pre-4.2 cube).
 *
 * The coverage is a COARSE global scalar: `globe.cloudCoverage` modulated by a
 * mild `cloudDensity` term (a thin high-coverage haze dims/flattens less than a
 * dense deck). This is deliberately not a per-face cloud raymarch — that is
 * deferred (CLOUD-IBL-FULL). Returns 0 unless BOTH `showProceduralClouds` AND
 * `cloudContributesIBL` are true.
 *
 * Item 3-C (CLOUD-IBL-FULL, Batch 450) — ALSO publishes the real deck altitude,
 * wind dir+speed, density, and the PW-shape-active state onto `_cloudCache`, so
 * the dynamic-env-map manager's per-face cloud march reads the user's live cloud
 * customization (`scene.globe` is in scope HERE; it is NOT a `FrameState` field).
 * These extra fields are inert on the OFF path (the manager gates its march on
 * `cloudsInReflections` AND coverage > 0); they always reflect the current globe
 * so a customization shows up in the reflected deck the same frame it shows up in
 * the visible deck.
 */
export function publishCloudIblCoverage(
  context: CesiumGraphicsContext,
  config: CloudVolumetricsConfig | undefined,
): void {
  const cache = ensureCloudCache(context);
  // Item 3-C — publish the real march params unconditionally (so a clear-flag
  // toggle never leaves a stale deck). These match the Globe constructor
  // defaults when unset, which equals the visible renderer's fallback.
  cache.iblDeckBottom = config?.cloudLayerBottom ?? 1500.0;
  cache.iblDeckTop = config?.cloudLayerTop ?? 4000.0;
  cache.iblWindX = config?.cloudWindDirection?.x ?? 0.7;
  cache.iblWindY = config?.cloudWindDirection?.y ?? 0.3;
  cache.iblWindSpeed = config?.cloudWindSpeed ?? 15.0;
  cache.iblDensity = config?.cloudDensity ?? 0.3;
  // Mirror WebGPUProceduralCloudRenderer's PW selection so the IBL march binds
  // the SAME base shape view (PW vs value-FBM) the visible deck samples.
  cache.iblPWActive = config?.cloudNoiseMorphology === "perlin-worley";
  if (
    !config ||
    config.showProceduralClouds !== true ||
    config.cloudContributesIBL !== true
  ) {
    cache.iblCoverage = 0.0;
    return;
  }
  const coverage = clampUnit(config.cloudCoverage ?? 0.5);
  const density = clampUnit(config.cloudDensity ?? 0.3);
  // Density biases the effective coverage modestly: a dense deck reads as
  // ~fully overcast; a wispy layer at the same coverage transmits more sky.
  // Map density [0,1] → multiplier [0.7, 1.0] so the floor never erases a
  // genuinely high coverage.
  const densityWeight = 0.7 + 0.3 * density;
  cache.iblCoverage = clampUnit(coverage * densityWeight);
}

function clampUnit(v: number): number {
  if (v < 0.0) {
    return 0.0;
  }
  if (v > 1.0) {
    return 1.0;
  }
  return v;
}

// ── Batch 437 (CLOUD-SHADOWS) — beer-shadow-map constants ──
// CloudShadowUniforms = sunViewInvVP(16) + sunDirAndSteps(4) = 20 floats.
const CLOUD_SHADOW_UNIFORM_FLOATS = 20;
const CLOUD_SHADOW_UNIFORM_BYTES = CLOUD_SHADOW_UNIFORM_FLOATS * 4;
// Square low-res shadow map. 512² is plenty for the soft, slowly-moving cloud
// shadow; the bilinear sampler + the cloud's own softness hide the resolution.
const CLOUD_SHADOW_SIZE = 512;
// r16float: a single optical-depth channel, filterable, half the bandwidth of rgba.
const CLOUD_SHADOW_FORMAT: GPUTextureFormat = "r16float";
// Sun-view ortho footprint half-extent (metres) centered on the camera ground
// point. Covers the near visible terrain where cast shadows read; far terrain
// falls outside and reads "no shadow" (transmittance 1) — acceptable for a soft
// local effect (the alternative, a planet-wide ortho, would blur every shadow to
// nothing at this resolution).
const CLOUD_SHADOW_FOOTPRINT_M = 60000.0;
// Light-march steps for the optical-depth accumulation along the sun ray.
const CLOUD_SHADOW_LIGHT_STEPS = 16;

// ── CLOUD-LOD-R5-CASCADED-CLOUD-SHADOW-MAP — opt-in 3-cascade constants ──
// Three cascades reusing a geometric (÷3) CSM-style split: cascade 2 (far)
// matches the single-map footprint (±60 km); cascades 1/0 tighten to ±20 km and
// ±6.67 km, so the finest cascade packs the same 512² over 9× less ground → ~3×
// the effective shadow resolution near the camera. Uniform-buffer offsets must be
// 256-aligned, so each cascade's CloudShadowUniforms (20 floats) is padded to a
// 64-float (256-byte) stride.
const CLOUD_SHADOW_CASCADE_COUNT = 3;
const CLOUD_SHADOW_CASCADE_STRIDE_FLOATS = 64; // 256 bytes (uniform offset align)
const CLOUD_SHADOW_CASCADE_STRIDE_BYTES =
  CLOUD_SHADOW_CASCADE_STRIDE_FLOATS * 4;
// Per-cascade footprint HALF-extent (metres): near, mid, far. Far == the single
// map; each step is ÷3 (geometric split).
const CLOUD_SHADOW_CASCADE_FOOTPRINTS_M = [
  CLOUD_SHADOW_FOOTPRINT_M / 9.0,
  CLOUD_SHADOW_FOOTPRINT_M / 3.0,
  CLOUD_SHADOW_FOOTPRINT_M,
];
// Per-cascade light-march steps — full for the crisp near cascade, fewer for the
// cheaper far cascades (they cover coarse coverage where step count barely reads).
const CLOUD_SHADOW_CASCADE_STEPS = [CLOUD_SHADOW_LIGHT_STEPS, 12, 8];

// V9 (Batch 432) — half-res target format. rgba16float so the premultiplied HDR
// cloud radiance survives the bilateral interpolation without banding.
const CLOUD_HALF_FORMAT: GPUTextureFormat = "rgba16float";
// UpscaleUniforms float count — MUST equal the WGSL struct length (CloudUpscale.wgsl).
const UPSCALE_UNIFORM_FLOATS = 16;
const UPSCALE_UNIFORM_BYTES = UPSCALE_UNIFORM_FLOATS * 4;
// Bilateral depth-similarity falloff, tuned in the renderer-wide NONLINEAR log
// depth space ([0,1], NOT metres). Small enough that a cloud/terrain edge rejects
// the far-side taps (crisp silhouette) but not so small that cloud interiors over
// a smooth depth gradient lose all four taps.
const CLOUD_UPSCALE_DEPTH_SIGMA = 5.0e-3;
// V10 (Batch 433) — temporal history format MUST match the half-res target
// (rgba16float, premultiplied HDR cloud) since the history accumulates that buffer.
const CLOUD_TEMPORAL_FORMAT: GPUTextureFormat = CLOUD_HALF_FORMAT;
// TemporalUniforms float count — MUST equal the WGSL struct length
// (CloudTemporalResolve.wgsl): prevVP(16) + invProj(16) + invView(16) +
// cameraPositionAndBlend(4) + shellRadiiAndRes(4) + firstFrameFlags(4) = 60.
const TEMPORAL_UNIFORM_FLOATS = 60;
const TEMPORAL_UNIFORM_BYTES = TEMPORAL_UNIFORM_FLOATS * 4;

/**
 * V10 (Batch 433) — (re)allocate the DOUBLE-BUFFERED (ping-pong) half-res cloud
 * HISTORY targets + the reproject/clamp/blend resolve pipeline. Called ONLY when a
 * temporal tier is active (T1 low / T2 medium); T3 cinematic + the escape hatch keep
 * temporal OFF so none of this allocates → byte-identical default. The history pair
 * is sized to the HALF-RES target (it accumulates the premultiplied half-res cloud)
 * and re-created on resize (size validation per CLAUDE.md). On (re)allocation the
 * first-frame flag is reset so the next resolve seeds identity history (no flash).
 * Returns false (caller falls back to plain half-res) if anything can't build.
 */
function ensureTemporalResources(
  device: GPUDevice,
  cache: CloudCache,
  halfW: number,
  halfH: number,
): boolean {
  // (Re)allocate the ping-pong history pair on first use or half-res resize.
  if (
    !cache.temporalHistory[0] ||
    !cache.temporalHistory[1] ||
    cache.temporalWidth !== halfW ||
    cache.temporalHeight !== halfH
  ) {
    cache.temporalHistory[0]?.destroy();
    cache.temporalHistory[1]?.destroy();
    for (let i = 0; i < 2; i++) {
      const tex = device.createTexture({
        label: `ProceduralClouds Temporal History ${i}`,
        size: { width: halfW, height: halfH, depthOrArrayLayers: 1 },
        format: CLOUD_TEMPORAL_FORMAT,
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      cache.temporalHistory[i] = tex;
      cache.temporalHistoryView[i] = tex.createView();
    }
    cache.temporalWidth = halfW;
    cache.temporalHeight = halfH;
    cache.temporalRead = 0;
    // History contents are undefined after (re)allocation — seed identity next frame.
    cache.temporalFirstFrame = true;
  }

  if (!cache.temporalPipeline) {
    cache.temporalBindGroupLayout = makeBindGroupLayout(
      device,
      "CloudTemporalResolve BGL",
      [
        texture(0, Stage.FRAGMENT), // current freshly-marched half-res cloud
        texture(1, Stage.FRAGMENT), // previous accumulated history
        sampler(2, Stage.FRAGMENT),
        uniformBuffer(3, Stage.FRAGMENT),
      ],
    );
    const resolveModule = device.createShaderModule({
      label: "CloudTemporalResolve shader",
      code: CloudTemporalResolveWGSL,
    });
    cache.temporalPipeline = device.createRenderPipeline({
      label: "CloudTemporalResolve pipeline",
      layout: device.createPipelineLayout({
        label: "CloudTemporalResolve pipeline layout",
        bindGroupLayouts: [cache.temporalBindGroupLayout],
      }),
      vertex: { module: resolveModule, entryPoint: "vertexMain" },
      fragment: {
        module: resolveModule,
        entryPoint: "fragmentMain",
        targets: [{ format: CLOUD_TEMPORAL_FORMAT }],
      },
      primitive: { topology: "triangle-list" },
    });
    cache.temporalUniformBuffer = device.createBuffer({
      label: "CloudTemporalResolve UB",
      size: Math.max(TEMPORAL_UNIFORM_BYTES, 256),
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    cache.temporalSampler = device.createSampler({
      label: "CloudTemporalResolve Sampler",
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
  }

  return (
    !!cache.temporalHistoryView[0] &&
    !!cache.temporalHistoryView[1] &&
    !!cache.temporalPipeline
  );
}

/**
 * V9 (Batch 432) — (re)allocate the half-res cloud target at `floor(w·scale) ×
 * floor(h·scale)`. Re-created on canvas resize (size validation per CLAUDE.md). A
 * null device or a zero size is a no-op (the caller falls back to full-res). The
 * half-res pipeline + the upscale pipeline/BGL/UBO/sampler are built once, lazily.
 */
function ensureHalfResResources(
  device: GPUDevice,
  cache: CloudCache,
  fullWidth: number,
  fullHeight: number,
  scale: number,
  canvasFormat: GPUTextureFormat,
): boolean {
  const halfW = Math.max(1, Math.floor(fullWidth * scale));
  const halfH = Math.max(1, Math.floor(fullHeight * scale));

  // (Re)allocate the half-res color target on first use or canvas resize.
  if (
    !cache.halfTexture ||
    cache.halfWidth !== halfW ||
    cache.halfHeight !== halfH
  ) {
    cache.halfTexture?.destroy();
    cache.halfTexture = device.createTexture({
      label: "ProceduralClouds Half-Res Target",
      size: { width: halfW, height: halfH, depthOrArrayLayers: 1 },
      format: CLOUD_HALF_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    cache.halfView = cache.halfTexture.createView();
    cache.halfWidth = halfW;
    cache.halfHeight = halfH;
  }

  // The raymarch-into-half pipeline reuses the cloud shader + BGL but targets the
  // rgba16float half-res attachment (the full-res pipeline targets canvasFormat).
  if (!cache.halfPipeline && cache.bindGroupLayout) {
    const shaderModule = device.createShaderModule({
      label: "ProceduralClouds shader (half-res)",
      code: ProceduralCloudsWGSL,
    });
    const layout = device.createPipelineLayout({
      label: "ProceduralClouds half-res pipeline layout",
      bindGroupLayouts: [cache.bindGroupLayout],
    });
    cache.halfPipeline = device.createRenderPipeline({
      label: "ProceduralClouds half-res pipeline",
      layout,
      vertex: { module: shaderModule, entryPoint: "vertexMain" },
      fragment: {
        module: shaderModule,
        entryPoint: "fragmentMain",
        targets: [{ format: CLOUD_HALF_FORMAT }],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  // The bilateral-upscale composite pipeline (new shader).
  if (!cache.upscalePipeline) {
    cache.upscaleBindGroupLayout = makeBindGroupLayout(
      device,
      "CloudUpscale BGL",
      [
        texture(0, Stage.FRAGMENT), // half-res cloud (premultiplied)
        texture(1, Stage.FRAGMENT), // full-res scene color
        texture(2, Stage.FRAGMENT), // full-res scene depth
        sampler(3, Stage.FRAGMENT),
        uniformBuffer(4, Stage.FRAGMENT),
      ],
    );
    const upscaleModule = device.createShaderModule({
      label: "CloudUpscale shader",
      code: CloudUpscaleWGSL,
    });
    cache.upscalePipeline = device.createRenderPipeline({
      label: "CloudUpscale pipeline",
      layout: device.createPipelineLayout({
        label: "CloudUpscale pipeline layout",
        bindGroupLayouts: [cache.upscaleBindGroupLayout],
      }),
      vertex: { module: upscaleModule, entryPoint: "vertexMain" },
      fragment: {
        module: upscaleModule,
        entryPoint: "fragmentMain",
        targets: [{ format: canvasFormat }],
      },
      primitive: { topology: "triangle-list" },
    });
    cache.upscaleUniformBuffer = device.createBuffer({
      label: "CloudUpscale UB",
      size: Math.max(UPSCALE_UNIFORM_BYTES, 256),
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    cache.upscaleSampler = device.createSampler({
      label: "CloudUpscale Sampler",
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
  }

  return !!cache.halfView && !!cache.halfPipeline && !!cache.upscalePipeline;
}

// ─── Weather Phase 1 — procedural weather-map producer ───
// Fills a coarse global coverage field with a value-noise FBM so the feature
// ships with ZERO data pipeline (the historical-data ingest later writes the
// SAME texture). R = coverage, G = cloud-type-y (mid), B = base/deck, A =
// density-bias. Contrast-stretched so distinct cloudy regions + clear gaps form.
function buildProceduralWeatherMap(w: number, h: number): Uint8Array {
  const data = new Uint8Array(w * h * 4);
  const hash = (x: number, y: number): number => {
    const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return n - Math.floor(n);
  };
  const vnoise = (x: number, y: number): number => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const a = hash(ix, iy);
    const b = hash(ix + 1, iy);
    const c = hash(ix, iy + 1);
    const d = hash(ix + 1, iy + 1);
    return (
      a * (1 - ux) * (1 - uy) +
      b * ux * (1 - uy) +
      c * (1 - ux) * uy +
      d * ux * uy
    );
  };
  const fbm = (x: number, y: number): number => {
    let v = 0;
    let amp = 0.5;
    let f = 1;
    for (let i = 0; i < 5; i++) {
      v += amp * vnoise(x * f, y * f);
      f *= 2;
      amp *= 0.5;
    }
    return v;
  };
  // smoothstep(0,1) on a normalized value.
  const sstep = (t: number): number => {
    const c = Math.max(0, Math.min(1, t));
    return c * c * (3 - 2 * c);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const vv = y / h;
      // Two octaves of scale so there are continental cloudy/clear REGIONS with
      // finer internal variation. High-contrast smoothstep so clear regions are
      // genuinely clear (R≈0) and storm regions genuinely overcast (R≈1) —
      // distinct weather, not a gentle wash.
      const big = fbm(u * 6, vv * 6);
      const fine = fbm(u * 18, vv * 18);
      const f = big * 0.7 + fine * 0.3;
      const coverage = sstep((f - 0.42) / 0.18);
      const i = (y * w + x) * 4;
      data[i] = Math.round(coverage * 255); // R coverage
      data[i + 1] = 128; // G type-y (mid)
      data[i + 2] = 0; // B base/deck
      data[i + 3] = 128; // A density-bias
    }
  }
  return data;
}

// Returns the weather texture VIEW to bind this frame, building (once) the
// procedural map when enabled and a 1×1 white fallback otherwise. The bind group
// always has a valid 2d-array texture at binding 4.
function ensureWeatherView(
  device: GPUDevice,
  cache: CloudCache,
  enabled: boolean,
  providerBytes: Uint8Array | null,
  providerVersion: number,
): GPUTextureView {
  if (!cache.weatherFallbackView) {
    const fb = device.createTexture({
      size: { width: 1, height: 1, depthOrArrayLayers: 1 },
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      dimension: "2d",
      label: "WeatherMap Fallback (1x1 white)",
    });
    device.queue.writeTexture(
      { texture: fb },
      new Uint8Array([255, 255, 255, 255]),
      { bytesPerRow: 4, rowsPerImage: 1 },
      { width: 1, height: 1, depthOrArrayLayers: 1 },
    );
    cache.weatherFallbackView = fb.createView({ dimension: "2d-array" });
  }
  if (!enabled) {
    return cache.weatherFallbackView;
  }
  // Allocate the 256x128 weather texture once.
  if (!cache.weatherTexture) {
    const tex = device.createTexture({
      size: {
        width: WEATHER_TEX_W,
        height: WEATHER_TEX_H,
        depthOrArrayLayers: 1,
      },
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      dimension: "2d",
      label: "WeatherMap",
    });
    cache.weatherTexture = tex;
    cache.weatherView = tex.createView({ dimension: "2d-array" });
    cache.weatherProviderVersion = -2; // nothing uploaded yet
  }
  const dst = { texture: cache.weatherTexture };
  const layout = {
    bytesPerRow: WEATHER_TEX_W * 4,
    rowsPerImage: WEATHER_TEX_H,
  };
  const size = {
    width: WEATHER_TEX_W,
    height: WEATHER_TEX_H,
    depthOrArrayLayers: 1,
  };
  // Weather ingest (Phase 1) — real data from a WeatherProvider wins; (re)upload
  // only when its version changes. Otherwise fall back to the procedural map
  // (uploaded once, sentinel -1). Switching back from provider to procedural
  // re-uploads the procedural fill.
  if (providerBytes !== null) {
    if (cache.weatherProviderVersion !== providerVersion) {
      device.queue.writeTexture(dst, providerBytes, layout, size);
      cache.weatherProviderVersion = providerVersion;
    }
  } else if (cache.weatherProviderVersion !== -1) {
    device.queue.writeTexture(
      dst,
      buildProceduralWeatherMap(WEATHER_TEX_W, WEATHER_TEX_H),
      layout,
      size,
    );
    cache.weatherProviderVersion = -1;
  }
  return cache.weatherView!;
}

// ─── Batch 434 (3.3 + 3.4) — atmosphere-LUT view resolver ───
// Returns the three LUT views to bind at 9/10/11 this frame. The 1×1 black
// placeholder is built once (lazily) and bound when EITHER mode is off OR the
// atmosphere LUTs haven't been allocated. When at least one mode is on AND the
// perfManager has the LUT resources, the REAL sky-view / MS / transmittance views
// are bound. The WGSL still gates each sample on its mode bit + a non-zero radiance,
// so a real-but-unbaked LUT (all-zero textures before SkyAtmosphere dispatches the
// bake) self-heals to the legacy heuristic/constant path (mirrors the globe fog
// drape's "bind whatever's there, let the shader's luminance test decide" pattern).
interface CloudLutViews {
  skyView: GPUTextureView;
  multipleScatter: GPUTextureView;
  transmittance: GPUTextureView;
}
function ensureCloudLutViews(
  device: GPUDevice,
  context: CesiumGraphicsContext,
  cache: CloudCache,
  wantLut: boolean,
): CloudLutViews {
  if (!cache.lutPlaceholderView) {
    // 1×1 BLACK rgba16float (float16 zero = 8 zero bytes). Black == "no radiance"
    // == the unbaked-LUT sentinel, so a bound placeholder is safe even if a mode
    // bit is set: the WGSL luminance test fails and the legacy branch runs.
    const ph = device.createTexture({
      size: { width: 1, height: 1, depthOrArrayLayers: 1 },
      format: "rgba16float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      dimension: "2d",
      label: "ProceduralClouds LUT placeholder (1x1 black)",
    });
    device.queue.writeTexture(
      { texture: ph },
      new Uint8Array(8), // 4 channels × f16(0.0)
      { bytesPerRow: 8, rowsPerImage: 1 },
      { width: 1, height: 1, depthOrArrayLayers: 1 },
    );
    cache.lutPlaceholderTexture = ph;
    cache.lutPlaceholderView = ph.createView();
  }
  const placeholder = cache.lutPlaceholderView;
  if (!wantLut) {
    return {
      skyView: placeholder,
      multipleScatter: placeholder,
      transmittance: placeholder,
    };
  }
  // Resolve the real LUT views from the performance manager (same accessor the
  // sky / fog / globe-fog batches use; allocate-only — the textures stay all-zero
  // until SkyAtmosphere dispatches the bake, which the WGSL luminance gate handles).
  const perfMgr = (
    context as unknown as {
      performanceManager?: {
        ensureAtmosphereLUTResources?: (d: GPUDevice) => {
          skyViewView?: GPUTextureView;
          multipleScatterView?: GPUTextureView;
          transmittanceView?: GPUTextureView;
        } | null;
      };
    }
  ).performanceManager;
  if (perfMgr?.ensureAtmosphereLUTResources) {
    const res = perfMgr.ensureAtmosphereLUTResources(device);
    if (
      res &&
      res.skyViewView &&
      res.multipleScatterView &&
      res.transmittanceView
    ) {
      return {
        skyView: res.skyViewView,
        multipleScatter: res.multipleScatterView,
        transmittance: res.transmittanceView,
      };
    }
  }
  // No LUT resources (non-compute device, or not allocated yet) — placeholders.
  return {
    skyView: placeholder,
    multipleScatter: placeholder,
    transmittance: placeholder,
  };
}

// ─── V2 — 3D noise bake ───
// Ensure the shape/detail noise textures are baked ONCE and return the views to
// bind at 6/7/8. INERT in V2: the bind group must supply valid 3D views (the BGL
// declares them), but the shader keeps `noiseSource = 0` and never samples them,
// so the live march produces every pixel → byte-identical. A 1×1×1 white 3D
// fallback keeps the bind group valid if the bake is unavailable. V3 flips
// `cloudDensity`/`cloudBaseDensity` to sample these.
function ensureNoiseBaked(
  device: GPUDevice,
  cache: CloudCache,
  perlinWorley: boolean,
): {
  shapeView: GPUTextureView;
  detailView: GPUTextureView;
  sampler: GPUSampler;
} {
  if (!cache.noiseFallbackView) {
    const fb = device.createTexture({
      size: { width: 1, height: 1, depthOrArrayLayers: 1 },
      format: "rgba8unorm",
      dimension: "3d",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      label: "CloudNoise Fallback (1x1x1 white)",
    });
    device.queue.writeTexture(
      { texture: fb },
      new Uint8Array([255, 255, 255, 255]),
      { bytesPerRow: 4, rowsPerImage: 1 },
      { width: 1, height: 1, depthOrArrayLayers: 1 },
    );
    cache.noiseFallbackTexture = fb;
    cache.noiseFallbackView = fb.createView({ dimension: "3d" });
    cache.noiseFallbackSampler = device.createSampler({
      label: "CloudNoise Fallback Sampler",
      magFilter: "linear",
      minFilter: "linear",
    });
  }
  // Batch 439 (4.8 CLOUD-PW-NOISE) — (re)bake when not yet baked OR when the PW
  // variant is requested for the first time (the initial bake may have been
  // value-only). The default value `shapeTexture` is always baked identically, so a
  // re-bake to add the PW variant doesn't change the default output. We re-bake by
  // destroying the prior resources (one-shot upgrade; the flag rarely toggles).
  const needPW =
    perlinWorley && !(cache.noise && cache.noise.shapePWSampleView);
  if (!cache.noiseBaked || needPW) {
    if (needPW && cache.noise) {
      cache.noise.shapeTexture.destroy();
      cache.noise.shapePWTexture?.destroy();
      cache.noise.detailTexture.destroy();
    }
    const res = buildCloudNoiseResources(device, 128, 32, perlinWorley);
    if (res) {
      cache.noise = res;
      cache.noiseBaked = true;
    }
  }
  if (cache.noiseBaked && cache.noise) {
    // Select the PW shape view when requested AND it baked; else the value shape.
    const useShapeView =
      perlinWorley && cache.noise.shapePWSampleView
        ? cache.noise.shapePWSampleView
        : cache.noise.shapeSampleView;
    return {
      shapeView: useShapeView,
      detailView: cache.noise.detailSampleView,
      sampler: cache.noise.sampler3d,
    };
  }
  return {
    shapeView: cache.noiseFallbackView!,
    detailView: cache.noiseFallbackView!,
    sampler: cache.noiseFallbackSampler!,
  };
}

function initializeCloudPipeline(
  device: GPUDevice,
  cache: CloudCache,
  canvasFormat: GPUTextureFormat,
): void {
  if (cache.initialized) return;

  const shaderModule = device.createShaderModule({
    label: "ProceduralClouds shader",
    code: ProceduralCloudsWGSL,
  });
  // TAKRAM-9 — retained so the (lazy) transmittance-mask pipeline can reuse the
  // same module + BGL without recompiling the WGSL.
  cache.maskShaderModule = shaderModule;

  cache.bindGroupLayout = makeBindGroupLayout(device, "ProceduralClouds BGL", [
    texture(0, Stage.FRAGMENT),
    texture(1, Stage.FRAGMENT),
    sampler(2, Stage.FRAGMENT),
    uniformBuffer(3, Stage.FRAGMENT),
    // Weather Phase 1 — weather map (2d-array depth-1) + its sampler.
    texture(4, Stage.FRAGMENT, { viewDimension: "2d-array" }),
    sampler(5, Stage.FRAGMENT),
    // V2 — 3D noise textures (shape + detail) + sampler. Bound but NOT sampled
    // until V3 (noiseSource stays 0); the live march still produces every pixel.
    texture(6, Stage.FRAGMENT, { viewDimension: "3d" }),
    texture(7, Stage.FRAGMENT, { viewDimension: "3d" }),
    sampler(8, Stage.FRAGMENT),
    // Batch 434 (3.3 + 3.4) — atmosphere LUTs (sky-view / MS / transmittance) +
    // a linear sampler. Bound UNCONDITIONALLY (1×1 black placeholders when off /
    // unbaked) so the BGL never forks; the WGSL gates the samples on the mode bits.
    texture(9, Stage.FRAGMENT),
    texture(10, Stage.FRAGMENT),
    texture(11, Stage.FRAGMENT),
    sampler(12, Stage.FRAGMENT),
  ]);

  const pipelineLayout = device.createPipelineLayout({
    label: "ProceduralClouds pipeline layout",
    bindGroupLayouts: [cache.bindGroupLayout],
  });

  cache.pipeline = device.createRenderPipeline({
    label: "ProceduralClouds pipeline",
    layout: pipelineLayout,
    vertex: { module: shaderModule, entryPoint: "vertexMain" },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentMain",
      targets: [{ format: canvasFormat }],
    },
    primitive: { topology: "triangle-list" },
  });

  cache.sampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });

  // Weather Phase 1 — global equirect map: wrap in longitude (U), clamp at the
  // poles (V).
  cache.weatherSampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
    addressModeU: "repeat",
    addressModeV: "clamp-to-edge",
  });

  // Batch 434 (3.3 + 3.4) — linear clamp sampler for the atmosphere LUTs (matches
  // SkyAtmosphere's lutSampler / AerialPerspective's texSampler conventions so the
  // cloud air-light / ambient sample the LUTs identically to the visible sky).
  cache.lutSampler = device.createSampler({
    label: "ProceduralClouds LUT Sampler",
    magFilter: "linear",
    minFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });

  cache.uniformBuffer = device.createBuffer({
    label: "ProceduralClouds UB",
    size: Math.max(CLOUD_UNIFORM_BYTES, 256),
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  cache.initialized = true;
}

/**
 * Session 65 Batch 45 — Phase 6d quality-dial resolver. Maps the
 * `clouds.volumetricQuality` preset string to a `(maxSteps,
 * lightSteps)` pair, with `"auto"` reading camera altitude to pick a
 * preset on the fly (Phase 6b altitude crossfade — high quality below
 * `volumetricEnableAltitude`, dropping to low above
 * `volumetricDisableAltitude`).
 *
 * Preset table:
 *   low    — (24, 3)  mobile / power-saving
 *   medium — (48, 4)  default desktop
 *   high   — (96, 8)  cinematic
 *   auto   — altitude-driven (see below)
 *
 * Auto mode (Phase 6b):
 *   altitude ≤ enableAltitude  → high
 *   altitude ≥ disableAltitude → low
 *   in-between                 → medium (no per-pixel blend yet; the
 *                                 transition is a single step at the
 *                                 midpoint, with hysteresis applied at
 *                                 the caller scale via globe field
 *                                 stickiness — sample-count changes
 *                                 every frame would shimmer at the
 *                                 transition).
 *
 * Escape hatch: if the user has set `globe.cloudQuality` to a
 * non-default value (≠ 64), the resolver returns that verbatim and
 * ignores the preset — power users tuning maxSteps by hand don't get
 * fought by the preset enum.
 */
interface QualityResolverInputs {
  preset: string | undefined;
  rawCloudQuality: number | undefined;
  cameraHeightMeters: number;
  enableAltitudeMeters: number;
  disableAltitudeMeters: number;
}

function resolveCloudQuality(inputs: QualityResolverInputs): {
  maxSteps: number;
  lightSteps: number;
} {
  // Power-user escape hatch.
  const raw = inputs.rawCloudQuality;
  if (typeof raw === "number" && raw !== 64) {
    // Light steps default scales with sqrt(maxSteps / 64) so a custom
    // value gets a sensible light-march count without an extra knob.
    const lightSteps = Math.max(2, Math.round(6 * Math.sqrt(raw / 64)));
    return { maxSteps: raw, lightSteps };
  }
  let preset = inputs.preset ?? "auto";
  if (preset !== "low" && preset !== "medium" && preset !== "high") {
    // Auto + unknown strings → altitude-driven resolution.
    if (inputs.cameraHeightMeters >= inputs.disableAltitudeMeters) {
      preset = "low";
    } else if (inputs.cameraHeightMeters <= inputs.enableAltitudeMeters) {
      preset = "high";
    } else {
      preset = "medium";
    }
  }
  if (preset === "low") return { maxSteps: 24, lightSteps: 3 };
  if (preset === "high") return { maxSteps: 96, lightSteps: 8 };
  return { maxSteps: 48, lightSteps: 4 };
}

// ─── Batch 437 (CLOUD-SHADOWS) — small column-major mat4 helpers ───
// Self-contained (no Core import in this hot file). All matrices are length-16
// Float32Array in Cesium's COLUMN-MAJOR convention (the same convention the WGSL
// `mat4x4` + every other cloud-renderer pack uses).

// result = a × b (both column-major).
function mul4(a: Float32Array, b: Float32Array, out: Float32Array): void {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4 + 0];
    const b1 = b[c * 4 + 1];
    const b2 = b[c * 4 + 2];
    const b3 = b[c * 4 + 3];
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[0 * 4 + r] * b0 +
        a[1 * 4 + r] * b1 +
        a[2 * 4 + r] * b2 +
        a[3 * 4 + r] * b3;
    }
  }
}

// Invert a column-major 4×4 (general; the sun-view VP is affine·ortho so it always
// inverts). Returns false (identity-filled) on a singular matrix.
function invert4(m: Float32Array, out: Float32Array): boolean {
  const m0 = m[0],
    m1 = m[1],
    m2 = m[2],
    m3 = m[3];
  const m4 = m[4],
    m5 = m[5],
    m6 = m[6],
    m7 = m[7];
  const m8 = m[8],
    m9 = m[9],
    m10 = m[10],
    m11 = m[11];
  const m12 = m[12],
    m13 = m[13],
    m14 = m[14],
    m15 = m[15];
  const b00 = m0 * m5 - m1 * m4;
  const b01 = m0 * m6 - m2 * m4;
  const b02 = m0 * m7 - m3 * m4;
  const b03 = m1 * m6 - m2 * m5;
  const b04 = m1 * m7 - m3 * m5;
  const b05 = m2 * m7 - m3 * m6;
  const b06 = m8 * m13 - m9 * m12;
  const b07 = m8 * m14 - m10 * m12;
  const b08 = m8 * m15 - m11 * m12;
  const b09 = m9 * m14 - m10 * m13;
  const b10 = m9 * m15 - m11 * m13;
  const b11 = m10 * m15 - m11 * m14;
  let det =
    b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (det === 0) {
    out.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    return false;
  }
  det = 1.0 / det;
  out[0] = (m5 * b11 - m6 * b10 + m7 * b09) * det;
  out[1] = (m2 * b10 - m1 * b11 - m3 * b09) * det;
  out[2] = (m13 * b05 - m14 * b04 + m15 * b03) * det;
  out[3] = (m10 * b04 - m9 * b05 - m11 * b03) * det;
  out[4] = (m6 * b08 - m4 * b11 - m7 * b07) * det;
  out[5] = (m0 * b11 - m2 * b08 + m3 * b07) * det;
  out[6] = (m14 * b02 - m12 * b05 - m15 * b01) * det;
  out[7] = (m8 * b05 - m10 * b02 + m11 * b01) * det;
  out[8] = (m4 * b10 - m5 * b08 + m7 * b06) * det;
  out[9] = (m1 * b08 - m0 * b10 - m3 * b06) * det;
  out[10] = (m12 * b04 - m13 * b02 + m15 * b00) * det;
  out[11] = (m9 * b02 - m8 * b04 - m11 * b00) * det;
  out[12] = (m5 * b07 - m4 * b09 - m6 * b06) * det;
  out[13] = (m0 * b09 - m1 * b07 + m2 * b06) * det;
  out[14] = (m13 * b01 - m12 * b03 - m14 * b00) * det;
  out[15] = (m8 * b03 - m9 * b01 + m10 * b00) * det;
  return true;
}

// Build the sun-view ORTHOGRAPHIC view-projection (world → sun-clip, column-major)
// covering a square footprint of half-extent `halfExtent` centered on `center`
// (the camera ground point), looking ALONG -sunDir (sun behind the eye). WebGPU
// clip z ∈ [0,1]. The lookAt eye is pushed `dist` up the sun ray so the whole
// shell is between the near/far planes; near/far bracket [0, 2·dist].
//
// RTE: the lookAt translation cancels the large `center` magnitude, so the
// world→eye product for points NEAR the footprint stays small (f32-safe). The
// shell radius (~6.4e6 m) only enters via `center` (the surface point), not as a
// raw coordinate in the matrix product the consumers evaluate.
function buildSunViewOrthoVP(
  center: [number, number, number],
  sunDir: [number, number, number],
  halfExtent: number,
  out: Float32Array,
  invOut: Float32Array,
): void {
  // Normalize sun dir.
  let sx = sunDir[0],
    sy = sunDir[1],
    sz = sunDir[2];
  const sl = Math.hypot(sx, sy, sz) || 1.0;
  sx /= sl;
  sy /= sl;
  sz /= sl;
  // Distance to push the eye up the sun ray — comfortably above the shell top so
  // the ortho near plane sits above the clouds and far plane below the surface.
  const dist = halfExtent * 2.0 + 12000.0;
  const eye: [number, number, number] = [
    center[0] + sx * dist,
    center[1] + sy * dist,
    center[2] + sz * dist,
  ];
  // Forward = (center - eye) normalized = -sunDir.
  const fx = -sx,
    fy = -sy,
    fz = -sz;
  // Up reference: avoid degeneracy when the sun is near the world Z axis.
  let upx = 0,
    upy = 0,
    upz = 1;
  if (Math.abs(fz) > 0.99) {
    upx = 0;
    upy = 1;
    upz = 0;
  }
  // right = normalize(cross(forward, up)).
  let rx = fy * upz - fz * upy;
  let ry = fz * upx - fx * upz;
  let rz = fx * upy - fy * upx;
  const rl = Math.hypot(rx, ry, rz) || 1.0;
  rx /= rl;
  ry /= rl;
  rz /= rl;
  // trueUp = cross(right, forward).
  const ux = ry * fz - rz * fy;
  const uy = rz * fx - rx * fz;
  const uz = rx * fy - ry * fx;
  // View matrix (column-major). Rows are right/up/-forward; translation = -R·eye.
  const tx = -(rx * eye[0] + ry * eye[1] + rz * eye[2]);
  const ty = -(ux * eye[0] + uy * eye[1] + uz * eye[2]);
  const tz = rx * 0; // placeholder, replaced below
  // Standard right-handed lookAt: z-axis points back along +forward·(-1).
  // view = [ right.x  right.y  right.z  tx
  //          up.x     up.y     up.z     ty
  //         -fwd.x   -fwd.y   -fwd.z    tz
  //          0        0        0        1 ]
  const zx = -fx,
    zy = -fy,
    zz = -fz;
  const tzz = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  const view = new Float32Array([
    rx,
    ux,
    zx,
    0,
    ry,
    uy,
    zy,
    0,
    rz,
    uz,
    zz,
    0,
    tx,
    ty,
    tzz,
    1,
  ]);
  void tz;
  // Orthographic projection (WebGPU z ∈ [0,1]). Symmetric L/R/B/T = ±halfExtent.
  const near = 1.0;
  const far = dist * 2.0;
  const invR = 1.0 / halfExtent; // 1/(right) with left=-right
  const invT = 1.0 / halfExtent;
  const invFN = 1.0 / (far - near);
  // Column-major ortho: x' = x/halfExtent, y' = y/halfExtent,
  // z' = (near - z_eye)/(far-near) mapped to [0,1] for a -z forward eye space.
  const proj = new Float32Array([
    invR,
    0,
    0,
    0,
    0,
    invT,
    0,
    0,
    0,
    0,
    -invFN,
    0,
    0,
    0,
    -near * invFN,
    1,
  ]);
  mul4(proj, view, out);
  invert4(out, invOut);
}

// (Re)allocate the shadow map + pipeline + uniform buffer + placeholder. Builds the
// dedicated shadow BGL (only the bindings `cloudShadowMain` references: CloudUniforms
// at 3, weather 4/5, noise 6/7/8, CloudShadowUniforms at 13). Returns false (caller
// falls back to the placeholder) if anything can't allocate. Size validation per
// CLAUDE.md: the placeholder is built once; the map is fixed-size (re-create only
// guarded by `shadowSize`).
function ensureShadowResources(device: GPUDevice, cache: CloudCache): boolean {
  // 1×1 r16float ZERO placeholder (optical depth 0 → transmittance 1 = no shadow).
  if (!cache.shadowPlaceholderView) {
    const ph = device.createTexture({
      label: "CloudShadow Placeholder (1x1 zero r16float)",
      size: { width: 1, height: 1, depthOrArrayLayers: 1 },
      format: CLOUD_SHADOW_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    // f16(0.0) = 0x0000.
    device.queue.writeTexture(
      { texture: ph },
      new Uint16Array([0]),
      { bytesPerRow: 2, rowsPerImage: 1 },
      { width: 1, height: 1, depthOrArrayLayers: 1 },
    );
    cache.shadowPlaceholderTexture = ph;
    cache.shadowPlaceholderView = ph.createView();
  }
  if (!cache.shadowSampler) {
    cache.shadowSampler = device.createSampler({
      label: "CloudShadow Sampler",
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
  }
  // The shadow target (square, fixed size).
  if (!cache.shadowTexture || cache.shadowSize !== CLOUD_SHADOW_SIZE) {
    cache.shadowTexture?.destroy();
    cache.shadowTexture = device.createTexture({
      label: "CloudShadow Map (sun-view optical depth)",
      size: {
        width: CLOUD_SHADOW_SIZE,
        height: CLOUD_SHADOW_SIZE,
        depthOrArrayLayers: 1,
      },
      format: CLOUD_SHADOW_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    cache.shadowView = cache.shadowTexture.createView();
    cache.shadowSize = CLOUD_SHADOW_SIZE;
  }
  if (!cache.shadowUniformBuffer) {
    cache.shadowUniformBuffer = device.createBuffer({
      label: "CloudShadow UB",
      size: Math.max(CLOUD_SHADOW_UNIFORM_BYTES, 256),
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }
  if (!cache.shadowPipeline) {
    cache.shadowBindGroupLayout = makeBindGroupLayout(
      device,
      "CloudShadow BGL",
      [
        uniformBuffer(3, Stage.FRAGMENT), // CloudUniforms (shell/wind/density)
        texture(4, Stage.FRAGMENT, { viewDimension: "2d-array" }), // weather
        sampler(5, Stage.FRAGMENT),
        texture(6, Stage.FRAGMENT, { viewDimension: "3d" }), // shape noise
        texture(7, Stage.FRAGMENT, { viewDimension: "3d" }), // detail noise
        sampler(8, Stage.FRAGMENT),
        uniformBuffer(13, Stage.FRAGMENT), // CloudShadowUniforms (sun-view)
      ],
    );
    const shaderModule = device.createShaderModule({
      label: "ProceduralClouds shader (shadow pass)",
      code: ProceduralCloudsWGSL,
    });
    cache.shadowPipeline = device.createRenderPipeline({
      label: "CloudShadow pipeline",
      layout: device.createPipelineLayout({
        label: "CloudShadow pipeline layout",
        bindGroupLayouts: [cache.shadowBindGroupLayout],
      }),
      vertex: { module: shaderModule, entryPoint: "vertexMain" },
      fragment: {
        module: shaderModule,
        entryPoint: "cloudShadowMain",
        targets: [{ format: CLOUD_SHADOW_FORMAT }],
      },
      primitive: { topology: "triangle-list" },
    });
  }
  return (
    !!cache.shadowView &&
    !!cache.shadowPipeline &&
    !!cache.shadowBindGroupLayout &&
    !!cache.shadowUniformBuffer
  );
}

// CLOUD-LOD-R5 — (Re)allocate the 3-cascade shadow atlas + its cascade uniform
// buffer. REUSES the single-map's pipeline + BGL (`ensureShadowResources` must
// have succeeded first — the caller guarantees this), so only the atlas target
// and the 256-aligned uniform buffer are cascade-specific. The atlas stacks
// `CLOUD_SHADOW_CASCADE_COUNT` square tiles vertically (tile 0 = top = finest).
// Returns false (→ caller falls back to the single map) if allocation fails.
function ensureCascadeResources(device: GPUDevice, cache: CloudCache): boolean {
  if (
    !cache.shadowCascadeTexture ||
    cache.shadowCascadeSize !== CLOUD_SHADOW_SIZE
  ) {
    cache.shadowCascadeTexture?.destroy();
    cache.shadowCascadeTexture = device.createTexture({
      label: "CloudShadow Cascade Atlas (sun-view optical depth, 3 tiles)",
      size: {
        width: CLOUD_SHADOW_SIZE,
        height: CLOUD_SHADOW_SIZE * CLOUD_SHADOW_CASCADE_COUNT,
        depthOrArrayLayers: 1,
      },
      format: CLOUD_SHADOW_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    cache.shadowCascadeView = cache.shadowCascadeTexture.createView();
    cache.shadowCascadeSize = CLOUD_SHADOW_SIZE;
  }
  if (!cache.shadowCascadeUniformBuffer) {
    cache.shadowCascadeUniformBuffer = device.createBuffer({
      label: "CloudShadow Cascade UB (3×256B)",
      size: CLOUD_SHADOW_CASCADE_COUNT * CLOUD_SHADOW_CASCADE_STRIDE_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }
  return (
    !!cache.shadowCascadeView &&
    !!cache.shadowCascadeUniformBuffer &&
    !!cache.shadowPipeline &&
    !!cache.shadowBindGroupLayout
  );
}

/**
 * Execute the procedural cloud rendering pass.
 * Called after globe rendering, before post-processing.
 */
export function executeProceduralClouds(
  context: CesiumGraphicsContext,
  frameState: CesiumFrameState,
  colorTextureView: GPUTextureView,
  depthTextureView: GPUTextureView,
  outputView: GPUTextureView,
  config: CloudVolumetricsConfig,
): void {
  const device = context._device;
  if (!device) return;

  // TAKRAM-9 — reset the per-frame "mask rendered" flag up front so a culled or
  // early-returned frame reports null to the god-ray consumer (no stale map).
  if (context._cloudCache) context._cloudCache.maskRenderedThisFrame = false;

  // Frustum cull (Batch 413) — the cloud shell is a sphere at the planet origin
  // (radius = planetRadius + cloudLayerTop). Skip the full-screen raymarch
  // entirely when that sphere is outside the view frustum (e.g. the config panned
  // off-screen in space). For a sphere centered at the world origin the signed
  // distance to each frustum plane is just `plane.w` (dot(normal, 0) + w), so the
  // shell is OUTSIDE iff some plane has w < -outerR — matching Cesium
  // BoundingSphere.intersectPlane (OUTSIDE when distanceToPlane < -radius).
  // Perf-only: ZERO visual change while any of the shell is in view (so the
  // cloud probes, which all look at the config, stay green).
  const planes = frameState.cullingVolume?.planes;
  if (planes !== undefined && planes.length > 0) {
    const outerR = 6378137.0 + (config.cloudLayerTop ?? 4000.0);
    for (let p = 0; p < planes.length; p++) {
      if (planes[p].w < -outerR) {
        return; // shell entirely outside the frustum — nothing to draw
      }
    }
  }

  const cache = ensureCloudCache(context);
  initializeCloudPipeline(device, cache, context._canvasFormat || "bgra8unorm");

  // V2/V3 — bake (once) + resolve the 3D noise views, BEFORE packing so the
  // qualityFlags noiseSource bit can reflect the same-frame baked state (no
  // one-frame-late flip). The bake's one-shot submit runs before this frame's
  // cloud pass, so the textures are populated when sampled.
  // Batch 439 (4.8 CLOUD-PW-NOISE) — 'perlin-worley' selects the PW shape variant
  // (a separate baked texture); 'value'/undefined keeps the value-FBM bake (default,
  // byte-identical). The flag drives the bake (alloc the PW texture) AND which shape
  // view binds at 6.
  const perlinWorley =
    (config as unknown as { cloudNoiseMorphology?: string })
      .cloudNoiseMorphology === "perlin-worley";
  const noise = ensureNoiseBaked(device, cache, perlinWorley);

  // Pack uniforms
  const data = cache.uniformData;
  const us = frameState.context?.uniformState ?? context.uniformState;
  let offset = 0;

  // inverseProjection (mat4, 16 floats)
  const invProj = us?.inverseProjection;
  if (invProj) {
    for (let i = 0; i < 16; i++) data[offset++] = invProj[i];
  } else {
    offset += 16;
  }

  // inverseView (mat4, 16 floats)
  const invView = us?.inverseView;
  if (invView) {
    for (let i = 0; i < 16; i++) data[offset++] = invView[i];
  } else {
    offset += 16;
  }

  // cameraPosition (vec3 + time)
  const camPos = frameState.camera?.positionWC;
  data[offset++] = camPos?.x ?? 0;
  data[offset++] = camPos?.y ?? 0;
  data[offset++] = camPos?.z ?? 0;
  // Weather Phase 0 — clock-bind cloud motion. Derive `time` (seconds) from
  // `frameState.time` (the scene-clock JulianDate) instead of wall-clock
  // performance.now(), so wind/advection scrubs with the timeline, pauses when
  // `clock.shouldAnimate` is false, and scales with `clock.multiplier`. The
  // day-seconds are computed in f64 and the first-frame epoch is subtracted
  // BEFORE the f32 store (raw day-seconds ~1.9e14 would destroy f32 precision).
  const jd = frameState.time as unknown as
    { dayNumber: number; secondsOfDay: number } | undefined;
  if (jd && typeof jd.dayNumber === "number") {
    const seconds = jd.dayNumber * 86400.0 + jd.secondsOfDay;
    if (cache.timeEpoch === null) {
      cache.timeEpoch = seconds;
    }
    data[offset++] = seconds - cache.timeEpoch;
  } else {
    data[offset++] = performance.now() / 1000.0; // fallback (no clock)
  }

  // sunDirection (vec3 + intensity)
  const sunDir = us?.sunDirectionWC ?? us?.sunDirectionEC;
  data[offset++] = sunDir?.x ?? 0;
  data[offset++] = sunDir?.y ?? 1;
  data[offset++] = sunDir?.z ?? 0;
  data[offset++] = config.atmosphereLightIntensity ?? 10.0; // sunIntensity

  // Cloud layer params
  data[offset++] = config.cloudLayerBottom ?? 1500.0;
  data[offset++] = config.cloudLayerTop ?? 4000.0;
  data[offset++] = WGS84_EQUATORIAL_RADIUS; // planetRadius
  data[offset++] = config.cloudCoverage ?? 0.5;

  // Quality params (Phase 6d/6b resolver).
  // Reads `config.cloudVolumetricQuality` preset string + camera
  // altitude + the AtmosphericConditions enable/disable altitudes for
  // auto mode. Falls back verbatim to `config.cloudQuality` when the
  // user has hand-tuned that field to a non-default value.
  const atmoClouds = (
    config as unknown as {
      atmosphericConditions?: {
        clouds?: {
          volumetricEnableAltitude?: number;
          volumetricDisableAltitude?: number;
        };
      };
    }
  ).atmosphericConditions?.clouds;
  const globeForQuality = config as unknown as {
    cloudVolumetricQuality?: string;
    cloudQuality?: number;
  };
  const cameraHeightM = frameState.camera?.positionCartographic?.height ?? 0;
  const qualityInputs = {
    preset: globeForQuality.cloudVolumetricQuality,
    rawCloudQuality: globeForQuality.cloudQuality,
    cameraHeightMeters: cameraHeightM,
    enableAltitudeMeters: atmoClouds?.volumetricEnableAltitude ?? 50_000,
    disableAltitudeMeters: atmoClouds?.volumetricDisableAltitude ?? 100_000,
  };
  // maxSteps/lightSteps stay on the legacy resolver verbatim (byte-identity).
  const qualityResolved = resolveCloudQuality(qualityInputs);
  // V1 — tier preset for the qualityFlags@74 lane. No shader reads qualityFlags
  // yet (inert spine), so this is byte-identical; feature batches make the WGSL
  // consume each bit in turn (V3 noiseSource, V5 octaves, V6 jitter, V9 halfRes,
  // V10 temporal, V11 profile).
  const cloudPreset = resolveCloudPreset(qualityInputs);
  // V9 (Batch 432) — half-res gate. A tier that resolves renderResScale<1 (T1 low
  // / T2 high / auto-far) renders the raymarch into a 0.5× target + bilateral
  // upscale; the cinematic tier (T3) and the cloudQuality escape hatch keep
  // renderResScale=1.0 → the legacy full-res draw(3)→canvas composite, BYTE-
  // IDENTICAL. `halfResActive` is also gated on the half-res resources actually
  // allocating (self-healing: if the target/pipeline can't be built we fall back
  // to full-res rather than skip the clouds).
  const canvasW = context._canvas?.width ?? 1920;
  const canvasH = context._canvas?.height ?? 1080;
  let halfResActive =
    cloudPreset.renderResScale < 1.0 && cloudPreset.renderResScale > 0.0;
  if (halfResActive) {
    const allocated = ensureHalfResResources(
      device,
      cache,
      canvasW,
      canvasH,
      cloudPreset.renderResScale,
      context._canvasFormat || "bgra8unorm",
    );
    if (!allocated) {
      // Permanent sentinel (CLAUDE.md null-target guard): the tier asked for the
      // half-res path but the target/pipelines couldn't allocate — fall back to
      // the full-res composite so the clouds still render (degraded, not absent).
      // Real bug → no pragma; the user needs to see it.
      console.error(
        `[CesiumJS:webgpu:ctx-${context.id ?? "?"}] Cloud half-res target/pipeline allocation failed (${canvasW}x${canvasH} @${cloudPreset.renderResScale}); falling back to full-res.`,
      );
    }
    halfResActive = allocated;
  }
  // V10 (Batch 433) — temporal gate. A tier with `temporalEnabled` (T1 low / T2
  // medium) layers temporal reprojection/accumulation ON TOP of the half-res march:
  // the history accumulates the premultiplied half-res cloud and is reprojected via
  // `previousViewProjection` + neighborhood-clamped each frame. T3 cinematic and the
  // cloudQuality escape hatch keep `temporalEnabled=false` → NO history allocates →
  // byte-identical. Temporal REQUIRES the half-res path (the history is half-res), so
  // it is additionally gated on `halfResActive`; self-healing: if the history pair /
  // resolve pipeline can't allocate we fall back to plain half-res (no accumulation).
  let temporalActive = cloudPreset.temporalEnabled && halfResActive;
  if (temporalActive) {
    const tAllocated = ensureTemporalResources(
      device,
      cache,
      cache.halfWidth,
      cache.halfHeight,
    );
    if (!tAllocated) {
      // Permanent sentinel (CLAUDE.md null-target guard): the tier asked for
      // temporal but the history/resolve couldn't allocate — fall back to plain
      // half-res so the clouds still render. Real bug → no pragma.
      console.error(
        `[CesiumJS:webgpu:ctx-${context.id ?? "?"}] Cloud temporal history/pipeline allocation failed (${cache.halfWidth}x${cache.halfHeight}); falling back to half-res (no accumulation).`,
      );
    }
    temporalActive = tAllocated;
  }
  data[offset++] = qualityResolved.maxSteps;
  data[offset++] = qualityResolved.lightSteps;
  data[offset++] = config.cloudDensity ?? 0.3;
  data[offset++] = 0.04; // absorptionCoeff

  // Wind
  const windDir = config.cloudWindDirection;
  data[offset++] = windDir?.x ?? 0.7;
  data[offset++] = windDir?.y ?? 0.3;
  data[offset++] = config.cloudWindSpeed ?? 15.0;
  // Config — silver-lining intensity (live via atmosphericConditions.clouds.silverLining).
  data[offset++] = config.cloudSilverLiningIntensity ?? 0.8; // silverLiningIntensity

  // cloudBaseColor (vec3 + pad)
  data[offset++] = 0.65;
  data[offset++] = 0.68;
  data[offset++] = 0.72;
  data[offset++] = 0;
  // cloudTopColor (vec3 + pad)
  data[offset++] = 0.95;
  data[offset++] = 0.95;
  data[offset++] = 0.97;
  data[offset++] = 0;

  // resolution + WGS84 coordinate data. V9 (Batch 432) — when half-res is active this is the HALF-RES
  // target size so the shader's Bayer jitter step (1/resolution) is one half-res
  // texel; the full-res path keeps the canvas size (jitter branch is skipped, so
  // the value is byte-irrelevant there but stays the canvas size as before).
  data[offset++] = halfResActive ? cache.halfWidth : canvasW;
  data[offset++] = halfResActive ? cache.halfHeight : canvasH;
  // C13-04 — reuse the aligned resolution-row pads without growing the uniform:
  // WGS84 semi-minor axis + CPU-f64 geodetic camera height. The latter avoids
  // reclassifying a 20 km polar camera as being below the cloud deck.
  data[offset++] = WGS84_POLAR_RADIUS;
  data[offset++] = cameraHeightM;

  // Weather Phase 1 — weather-map seam lanes (floats 64-79).
  // Ingest (Phase 1): if a WeatherProvider has real data, use it AND auto-enable
  // the weather map (so real cloud-cover drives the deck without the user setting
  // cloudWeatherMap). getPackedTexture returns null until the async fetch lands —
  // until then the renderer keeps the procedural map (no overcast-everywhere flash).
  const weatherProvider = config.weatherProvider;
  const providerBytes =
    weatherProvider?.getPackedTexture(WEATHER_TEX_W, WEATHER_TEX_H) ?? null;
  const providerVersion = weatherProvider?.version ?? -1;
  const weatherEnabled =
    config.cloudWeatherMap === true || providerBytes !== null;
  data[offset++] = weatherEnabled ? 1.0 : 0.0; // 64 weatherMapEnabled
  // 65 weatherStrength — the global cloudCoverage folded in as a per-cell
  // multiplier (default coverage 0.5 → 1.0 neutral so the map's R drives directly).
  data[offset++] = (config.cloudCoverage ?? 0.5) * 2.0;
  // 66/67 — W1 dual-lobe phase: back-scatter g + forward/back blend. Config —
  // live via atmosphericConditions.clouds.phaseBackG / .phaseBlend.
  data[offset++] = config.cloudPhaseBackG ?? -0.3; // 66 phaseG2
  data[offset++] = config.cloudPhaseBlend ?? 0.7; // 67 phaseBlend
  // 68-71 weatherTexBounds — global equirect (radians): minLon, minLat, lonRange, latRange.
  data[offset++] = -Math.PI;
  data[offset++] = -Math.PI / 2.0;
  data[offset++] = 2.0 * Math.PI;
  data[offset++] = Math.PI;
  // 72 — W1 forward-scatter g. Sharper than the old hardcoded 0.8 for a stronger
  // silver lining toward the sun (HG forward peak at g=0.85 is ~1.8x g=0.8).
  data[offset++] = config.cloudPhaseForwardG ?? 0.85; // 72 phaseG1 (config: .phaseForwardG)
  // 73 — W2 ambient intensity (sky/ground fill on the shadow side; config: .ambientIntensity).
  data[offset++] = config.cloudAmbientIntensity ?? 1.5; // 73 ambientIntensity
  // 74 — qualityFlags bitfield. V3 sets bit 0 (noiseSource) when the tier wants
  // the baked 3D-texture core AND the bake actually succeeded — SELF-HEALING:
  // if the bake is unavailable (cache.noise null), the bit stays 0 and the WGSL
  // falls back to the live march. (halfRes/temporal/jitter/profile bits land in
  // V9/V10/V6/V11; the octaves bits carry the preset value, read by V5.)
  const noiseBakedBit =
    cloudPreset.noiseSource === CloudNoiseSource.BAKED &&
    cache.noiseBaked &&
    cache.noise !== null
      ? CLOUD_QF_NOISE_BAKED
      : 0;
  // V9 (Batch 432) — set bit 1 (QF_HALF_RES) ONLY when the half-res path is active
  // (tier renderResScale<1 AND the target/pipelines allocated). The shader keys its
  // premultiplied-emit + jitter branch on this bit; the full-res tiers leave it
  // clear → byte-identical legacy composite.
  const halfResBit = halfResActive ? CLOUD_QF_HALF_RES : 0;
  // V10 (Batch 433) — set bit 2 (QF_TEMPORAL) when temporal accumulation is active.
  // The raymarch shader's emit is IDENTICAL whether or not this is set (temporal
  // adds a separate resolve pass, not a march-branch), so it's byte-irrelevant to
  // the half-res target; it stays clear on the default / cinematic / escape-hatch
  // path. Carried for flag self-consistency with the tier presets + future readers.
  const temporalBit = temporalActive ? CLOUD_QF_TEMPORAL : 0;
  // Batch 436 (3.6 CLOUD-CONE-LIGHT) — set bit 10 (QF_LIGHT_CONE) when the resolved
  // tier wants the cone-sampled light march (T1 low / T2 medium). T3 cinematic + the
  // escape hatch have `lightConeSampling=false` → the bit stays clear → the WGSL
  // takes the verbatim straight light march → byte-identical to pre-436.
  const lightConeBit = cloudPreset.lightConeSampling ? CLOUD_QF_LIGHT_CONE : 0;
  data[offset++] =
    noiseBakedBit |
    halfResBit |
    temporalBit |
    lightConeBit |
    ((Math.min(7, cloudPreset.multiScatterOctaves) & 7) <<
      CLOUD_QF_OCTAVES_SHIFT); // 74 qualityFlags
  // 75 — Batch 439 (4.7 CLOUD-CURL) curl-warp amplitude. Default undefined →
  // packs 0.0 → the BAKED-path detail-erosion curl warp is SKIPPED in WGSL (the
  // `if (curlAmplitude > 0.0)` guard), so the default render is byte-identical.
  // `config.cloudCurlAmplitude` is the sole opt-in (the tier preset's curlAmplitude
  // stays 0 so every DEFAULT tier renders byte-identically — the flag, not the
  // tier, turns curl on). The warp only perturbs where the detail texture is
  // SAMPLED (subtractive erosion), so it can carve wispier edges but never add
  // density — same safety property as the live-path Worley erosion.
  data[offset++] = config.cloudCurlAmplitude ?? 0.0; // 75 curlAmplitude
  // 76 — V9 frameCounter (Bayer jitter index for the half-res sub-pixel offset).
  // Only consumed when QF_HALF_RES is set; full-res ignores it (jitter branch
  // skipped), so writing it is byte-irrelevant on the default path. Wraps at 16
  // (the Bayer LUT length) to keep the f32 store exact.
  cache.frameCounter = (cache.frameCounter + 1) & 15;
  data[offset++] = halfResActive ? cache.frameCounter : 0; // 76 frameCounter
  // 77 — Batch 439 (4.7 CLOUD-CURL) curl-noise swirl wavelength (noise-space
  // scale). Byte-irrelevant when curlAmplitude is 0 (the warp is guarded off), so
  // writing the default frequency on the default path is a no-op. Dialable via
  // `config.cloudCurlFrequency`; default 2.0 ≈ the base-shape feature scale.
  data[offset++] = config.cloudCurlFrequency ?? 2.0; // 77 curlFrequency
  // 78 — V5 light-march step scale. LIVE/escape + T3 keep 1.0 (full light march,
  // unchanged); the lower baked tiers march at 0.5 for cheaper shadowing.
  data[offset++] =
    cloudPreset.noiseSource === CloudNoiseSource.LIVE || cloudPreset.tier >= 3
      ? 1.0
      : 0.5; // 78 lightSampleScale
  // 79 — V4 mean-preserving erosion floor (BAKED path only; the live march
  // ignores it). Low tier = fibrous (0.10), high/cinematic = puffy (0.18).
  // Config — explicit override wins; else the tier default (low fibrous / high puffy).
  data[offset++] =
    config.cloudErosionStrength ?? (cloudPreset.tier <= 1 ? 0.1 : 0.18); // 79 erosionStrength
  // 80-83 — W2 sky ambient (blue, lights cloud tops).
  data[offset++] = 0.5; // 80
  data[offset++] = 0.65; // 81
  data[offset++] = 0.95; // 82
  data[offset++] = 0; // 83 pad
  // 84-87 — W2 ground-bounce ambient (warm grey, lights cloud bottoms).
  data[offset++] = 0.35; // 84
  data[offset++] = 0.34; // 85
  data[offset++] = 0.3; // 86
  data[offset++] = 0; // 87 pad
  // 88-90 — W3 time-of-day sun color. Keyed on the LOCAL sun elevation
  // (sunDir · local-up at the camera), NOT raw ECEF Y: warm orange near the
  // horizon, neutral white by ~20deg up. 91 — W4 aerialStrength (1.0 = neutral).
  let sinElev = 0.5;
  if (camPos && sunDir) {
    const len = Math.hypot(camPos.x, camPos.y, camPos.z) || 1.0;
    sinElev = Math.max(
      0.0,
      Math.min(
        1.0,
        (sunDir.x * camPos.x + sunDir.y * camPos.y + sunDir.z * camPos.z) / len,
      ),
    );
  }
  const e = Math.max(0.0, Math.min(1.0, sinElev / 0.35));
  const todT = e * e * (3.0 - 2.0 * e); // smoothstep(0, 0.35, sinElev)
  data[offset++] = 1.0 + (1.0 - 1.0) * todT; // 88 R (warm 1.0 -> noon 1.0)
  data[offset++] = 0.55 + (1.0 - 0.55) * todT; // 89 G (warm 0.55 -> noon 1.0)
  data[offset++] = 0.25 + (0.98 - 0.25) * todT; // 90 B (warm 0.25 -> noon 0.98)
  // 91 — W4 aerial-perspective strength (1.0 = full horizon haze at the 60 km
  // scale baked into the shader; 0 disables). Dialable via config.cloudAerialStrength.
  data[offset++] = config.cloudAerialStrength ?? 1.0; // 91 aerialStrength
  // 92-94 — W4 horizon inscatter haze tint. Distant clouds blend toward this so
  // they fade into the sky instead of popping. Keyed on the same local sun
  // elevation (todT) as the sun color: warm orange-grey at the horizon (twilight
  // band) -> desaturated sky-blue at day. This roughly tracks the rendered sky's
  // horizon color so far clouds dissolve into it rather than a fixed blue.
  data[offset++] = 0.8 + (0.62 - 0.8) * todT; // 92 R (warm 0.80 -> day 0.62)
  data[offset++] = 0.62 + (0.72 - 0.62) * todT; // 93 G (warm 0.62 -> day 0.72)
  data[offset++] = 0.5 + (0.85 - 0.5) * todT; // 94 B (warm 0.50 -> day 0.85)
  data[offset++] = 0; // 95 pad
  // ── Batch 407 — promoted shader consts → live dials (96-100) + V11-reserved
  // pads (101-103). The ?? defaults EXACTLY match the former WGSL consts
  // (SHAPE_SCALE 0.45, CLOUD_EXPOSURE 0.22, MS a/b/c 0.5/0.5/0.85), so with the
  // config fields unset this is byte-identical to the pre-407 render.
  data[offset++] = config.cloudPuffSize ?? 0.45; // 96 puffSize (was SHAPE_SCALE)
  data[offset++] = config.cloudExposure ?? 0.22; // 97 exposure (was CLOUD_EXPOSURE)
  data[offset++] = config.cloudMsDecayScatter ?? 0.5; // 98 msDecayA
  data[offset++] = config.cloudMsDecayExtinction ?? 0.5; // 99 msDecayB
  data[offset++] = config.cloudMsDecayPhase ?? 0.85; // 100 msDecayC
  // ── Batch 408 — V11 per-genus vertical-density profile. config.cloudType
  // (default CUMULUS) selects a CloudTypeProfile; CUMULUS → shape BILLOWY(1) +
  // densityScale 1.0, so the default render is byte-identical (the WGSL BILLOWY
  // branch is the literal old gradient).
  const profile = CloudTypeProfile.get(config.cloudType ?? CloudType.CUMULUS);
  const cumulusProfile = CloudTypeProfile.get(CloudType.CUMULUS);
  const cumulusBase = cumulusProfile.baseDensity; // 0.7
  const cumulusExtinction = cumulusProfile.extinction; // 0.6
  data[offset++] = profile.shape; // 101 profileShape (0 SLAB / 1 BILLOWY / 2 TOWER)
  data[offset++] = cumulusBase > 0 ? profile.baseDensity / cumulusBase : 1.0; // 102 profileDensityScale (CUMULUS=1.0)
  // 103 profileExtinction — per-genus optical extinction NORMALIZED against the
  // DEFAULT genus (CUMULUS, extinction 0.6) so CUMULUS → 1.0 (the WGSL multiplies
  // cloud.absorptionCoeff by this, so a value of 1.0 is byte-identical to the
  // pre-activation render). Mirrors profileDensityScale@102's CUMULUS-relative
  // normalization. Thin genera (cirrus 0.1 → 0.167x) absorb less → wispier; dense
  // genera (cumulonimbus 0.95 → 1.583x) absorb more → darker/more opaque cores.
  data[offset++] =
    cumulusExtinction > 0 ? profile.extinction / cumulusExtinction : 1.0; // 103 profileExtinction (CUMULUS=1.0)
  data[offset++] =
    profile.shape === CloudTypeProfile.CloudHeightGradientShape.TOWERING_ANVIL
      ? 1.0
      : 0.0; // 104 anvilBias
  // ── Batch 409 — depth occlusion: camera near/far so the shader can reverse
  // the renderer-wide log depth (same source as AerialPerspective).
  data[offset++] = frameState.camera?.frustum?.near ?? 1.0; // 105 nearPlane
  data[offset++] = frameState.camera?.frustum?.far ?? 1e8; // 106 farPlane
  // ── Batch 424 — Weather Phase 3: how strongly the weather map's G/B/A channels
  // (genus, base, density-bias) modulate the cloud model. Default 1.0; a NEUTRAL
  // map cell (G=0.5,B=0,A=0.5) is a no-op at ANY strength, so an R-only map or
  // weatherMapEnabled=0 reproduces today's pixels. `config.cloudWeatherChannelStrength`
  // tunes it live (0 = legacy R-only).
  data[offset++] = config.cloudWeatherChannelStrength ?? 1.0; // 107 weatherChannelStrength
  // ── Batch 434 (3.3 CLOUD-AERIAL-LUT + 3.4 CLOUD-AMBIENT-LUT) — atmosphere-LUT
  // coupling modes (108-111). Both default to the legacy path: 'heuristic' aerial +
  // 'constant' ambient → mode floats 0 → the WGSL takes the verbatim legacy branch,
  // byte-identical. The qualityFlags bits (8/9) carry the same on/off below; the
  // mode floats are belt-and-suspenders for shader readers. atmosphereThickness MUST
  // match the LUT bake (ATMOSPHERE_THICKNESS = 111e3) so the transmittance v-lookup
  // lands on the right row.
  const globeForLut = config as unknown as {
    cloudAerialMode?: string;
    cloudAmbientSource?: string;
  };
  const aerialLutOn = globeForLut.cloudAerialMode === "physical";
  const ambientLutOn = globeForLut.cloudAmbientSource === "sky-lut";
  data[offset++] = aerialLutOn ? 1.0 : 0.0; // 108 aerialLutMode
  data[offset++] = ambientLutOn ? 1.0 : 0.0; // 109 ambientLutMode
  data[offset++] = 111000.0; // 110 atmosphereThickness (matches the LUT bake)
  data[offset++] = 0.0; // 111 pad

  // ── Batch 443 (4.9 CLOUD-MULTIDECK) — multi-deck shell march. Slots 112-119.
  // Default OFF (multiDeck=0) → the WGSL marches exactly ONE shell with
  // cloudLayerBottom/Top + the legacy composite, and these deck-bounds floats are
  // never read → byte-identical. Opt-in via `config.cloudMultiDeck`. The deck bounds
  // come from CloudTypeProfile.CloudDeck.bounds (LOW/MID/HIGH; JS-authoritative —
  // the same table the per-genus deck assignment uses). ──
  const multiDeckOn =
    (config as unknown as { cloudMultiDeck?: boolean }).cloudMultiDeck === true;
  const deckBounds = CloudTypeProfile.CloudDeck.bounds as number[][];
  data[offset++] = multiDeckOn ? 1.0 : 0.0; // 112 multiDeck
  data[offset++] = 0.0; // 113 pad
  data[offset++] = deckBounds[0][0]; // 114 deckBoundsLow.x  (LOW bottom)
  data[offset++] = deckBounds[0][1]; // 115 deckBoundsLow.y  (LOW top)
  data[offset++] = deckBounds[1][0]; // 116 deckBoundsMid.x  (MID bottom)
  data[offset++] = deckBounds[1][1]; // 117 deckBoundsMid.y  (MID top)
  data[offset++] = deckBounds[2][0]; // 118 deckBoundsHigh.x (HIGH bottom)
  data[offset++] = deckBounds[2][1]; // 119 deckBoundsHigh.y (HIGH top)

  // ── Batch 445 (4.12 CLOUD-RTE) — camera-relative high-precision march. Slots
  // 120-127: the RTE high/low split of the SAME camera world position that feeds
  // `cloud.cameraPosition` (slots ~50-52 above). These 8 floats are written EVERY
  // frame but the WGSL READS them ONLY inside the CLOUD_QF_HIGH_PRECISION branch.
  // Planetary precision is automatic; explicit false retains the legacy A/B
  // intersection path. ──
  const highPrecisionOn =
    (config as unknown as { cloudHighPrecision?: boolean })
      .cloudHighPrecision !== false;
  // Encode the camera world position into a high/low f32 pair so the WGSL can
  // subtract the large `high` term before the small `low` refinement (cancellation
  // reduction). `camPos` is the same `frameState.camera.positionWC` packed above.
  if (camPos !== undefined) {
    const enc = EncodedCartesian3.fromCartesian(camPos, scratchEncodedCamera);
    data[offset++] = enc.high.x; // 120 encodedCameraHigh.x
    data[offset++] = enc.high.y; // 121 encodedCameraHigh.y
    data[offset++] = enc.high.z; // 122 encodedCameraHigh.z
    data[offset++] = 0.0; // 123 pad
    data[offset++] = enc.low.x; // 124 encodedCameraLow.x
    data[offset++] = enc.low.y; // 125 encodedCameraLow.y
    data[offset++] = enc.low.z; // 126 encodedCameraLow.z
    data[offset++] = 0.0; // 127 pad
  } else {
    // No camera — leave the split zeroed (off path never reads it anyway).
    data[offset++] = 0.0; // 120
    data[offset++] = 0.0; // 121
    data[offset++] = 0.0; // 122
    data[offset++] = 0.0; // 123 pad
    data[offset++] = 0.0; // 124
    data[offset++] = 0.0; // 125
    data[offset++] = 0.0; // 126
    data[offset++] = 0.0; // 127 pad
  }

  // ── Batch 555 (E2 CLOUD-MAMMATUS) — pendulous underside pouches. Slots 128-131.
  // Default OFF (mammatusStrength=0) → the WGSL mammatusFactor() early-returns 1.0
  // so density is untouched and these floats are never read past the guard →
  // byte-identical. Opt-in via config.cloudMammatusStrength (+ Scale/Depth dials).
  const globeMamma = config as unknown as {
    cloudMammatusStrength?: number;
    cloudMammatusScale?: number;
    cloudMammatusDepth?: number;
  };
  data[offset++] = globeMamma.cloudMammatusStrength ?? 0.0; // 128 mammatusStrength (0 = off)
  data[offset++] = globeMamma.cloudMammatusScale ?? 1.0; // 129 mammatusScale (pouch size)
  data[offset++] = globeMamma.cloudMammatusDepth ?? 0.25; // 130 mammatusDepth (underside band)
  data[offset++] = 0.0; // 131 pad

  // ── Batch 610 (E1 CLOUD-EXOTIC-SPECIES) — species/varieties density shaping.
  // Slots 132-135. Default OFF (speciesMode=0) → the WGSL speciesFactor() early-
  // returns 1.0 so density is untouched and these floats are never read past the
  // guard → byte-identical. Opt-in via config.cloudSpecies (a genus-gated name) or
  // the numeric config.cloudSpeciesMode; default genera leave it unset → mode 0.
  //   name "lenticularis" → 1 ; "fibratus"/"uncinus" → 2 (uncinus adds the hook).
  const globeSpecies = config as unknown as {
    cloudSpecies?: string;
    cloudSpeciesMode?: number;
    cloudSpeciesStrength?: number;
    cloudSpeciesScale?: number;
    cloudSpeciesParam?: number;
  };
  let speciesMode = globeSpecies.cloudSpeciesMode ?? 0.0;
  let speciesParamDefault = 0.0;
  const speciesName = globeSpecies.cloudSpecies;
  if (typeof speciesName === "string") {
    const n = speciesName.toLowerCase();
    if (n === "lenticularis" || n === "lenticular") {
      speciesMode = 1.0;
    } else if (n === "fibratus") {
      speciesMode = 2.0;
      speciesParamDefault = 0.0; // straight filaments
    } else if (n === "uncinus") {
      speciesMode = 2.0;
      speciesParamDefault = 1.0; // hooked fallstreaks
    }
  }
  data[offset++] = speciesMode; // 132 speciesMode (0 = off)
  data[offset++] = globeSpecies.cloudSpeciesStrength ?? 0.8; // 133 speciesStrength
  data[offset++] = globeSpecies.cloudSpeciesScale ?? 1.0; // 134 speciesScale
  data[offset++] = globeSpecies.cloudSpeciesParam ?? speciesParamDefault; // 135 speciesParam (uncinus hook)

  // ── Batch 611 (E2 CLOUD-EXOTIC-FEATURES-REMAINING) — supplementary features
  // (asperitas / fluctus / arcus / virga) as bounded density shaping. Slots 136-139.
  // Default OFF (featureMode=0) → the WGSL featureFactor() early-returns 1.0 so
  // density is untouched and these floats are never read past the guard →
  // byte-identical. Opt-in via config.cloudFeature (a genus-gated name) or the numeric
  // config.cloudFeatureMode; default genera leave it unset → mode 0.
  //   "asperitas" → 1 ; "fluctus"/"kelvin-helmholtz" → 2 ; "arcus" → 3 ;
  //   "virga" → 4 ; "praecipitatio" → 4 (param 1 = denser/reaching streaks).
  const globeFeature = config as unknown as {
    cloudFeature?: string;
    cloudFeatureMode?: number;
    cloudFeatureStrength?: number;
    cloudFeatureScale?: number;
    cloudFeatureParam?: number;
  };
  let featureMode = globeFeature.cloudFeatureMode ?? 0.0;
  let featureParamDefault = 0.0;
  const featureName = globeFeature.cloudFeature;
  if (typeof featureName === "string") {
    const n = featureName.toLowerCase();
    if (n === "asperitas") {
      featureMode = 1.0;
    } else if (
      n === "fluctus" ||
      n === "kelvin-helmholtz" ||
      n === "kelvinhelmholtz"
    ) {
      featureMode = 2.0;
      featureParamDefault = 0.6; // breaking-wave shear
    } else if (n === "arcus") {
      featureMode = 3.0;
      featureParamDefault = 0.3; // shelf width
    } else if (n === "virga") {
      featureMode = 4.0;
      featureParamDefault = 0.0; // wispy trails
    } else if (n === "praecipitatio") {
      featureMode = 4.0;
      featureParamDefault = 1.0; // denser reaching streaks
    }
  }
  data[offset++] = featureMode; // 136 featureMode (0 = off)
  data[offset++] = globeFeature.cloudFeatureStrength ?? 0.8; // 137 featureStrength
  data[offset++] = globeFeature.cloudFeatureScale ?? 1.0; // 138 featureScale
  data[offset++] = globeFeature.cloudFeatureParam ?? featureParamDefault; // 139 featureParam

  // ── Batch 612 (E3 CLOUD-EXOTIC-SPECIAL) — noctilucent / nacreous iridescent
  // SHADING. Slots 140-143. Default OFF (specialShadeMode=0) → the WGSL
  // specialShadeTint() early-returns vec3(1.0) so the cloud color is multiplied by
  // exactly 1.0 and these floats are never read past the guard → byte-identical.
  // Opt-in via config.cloudSpecial (a name) or the numeric config.cloudSpecialShadeMode:
  //   "noctilucent"/"nlc" → 1 ; "nacreous"/"polar-stratospheric"/"psc" → 2.
  // The high-altitude deck is placed via the existing multi-deck deckBoundsHigh
  // bounds (Batch 443); this only supplies the iridescent shading half.
  const globeSpecial = config as unknown as {
    cloudSpecial?: string;
    cloudSpecialShadeMode?: number;
    cloudSpecialShadeStrength?: number;
    cloudSpecialShadeScale?: number;
    cloudSpecialShadeParam?: number;
  };
  let specialShadeMode = globeSpecial.cloudSpecialShadeMode ?? 0.0;
  let specialParamDefault = 0.0;
  const specialName = globeSpecial.cloudSpecial;
  if (typeof specialName === "string") {
    const n = specialName.toLowerCase();
    if (n === "noctilucent" || n === "nlc") {
      specialShadeMode = 1.0;
    } else if (n === "nacreous" || n === "polar-stratospheric" || n === "psc") {
      specialShadeMode = 2.0;
      specialParamDefault = 0.5; // moderate spectral cycling
    }
  }
  data[offset++] = specialShadeMode; // 140 specialShadeMode (0 = off)
  data[offset++] = globeSpecial.cloudSpecialShadeStrength ?? 0.8; // 141 specialShadeStrength
  data[offset++] = globeSpecial.cloudSpecialShadeScale ?? 1.0; // 142 specialShadeScale
  data[offset++] = globeSpecial.cloudSpecialShadeParam ?? specialParamDefault; // 143 specialShadeParam

  // ── Batch 634 (C6-CLOUD-STBN-TAAU, LOD half) — two orbit-cost march dials, slots
  // 144-147. WebGPU-only (no WebGL twin — the WebGL cloud path is a separate,
  // simpler renderer). Default is a NO-OP → byte-identical:
  //   marchStepGrowth defaults 1.0 → WGSL `> 1.0` guard false → curStep == fineStep.
  //   maxRayDistance defaults 0.0  → WGSL `> 0.0` far-cap guard false → tEnd untouched.
  // Opt-in via config.cloudMarchStepGrowth (geometric per-fine-step growth; clamped
  // to [1.0, 1.1] — near samples stay crisp, far shell samples coarsen) and
  // config.cloudMaxRayDistance (meters; the view march stops past this distance
  // where clouds are sub-pixel; clamped >= 0). Both are pure perf/quality knobs.
  const globeLod = config as unknown as {
    cloudMarchStepGrowth?: number;
    cloudMaxRayDistance?: number;
  };
  const marchStepGrowth = Math.min(
    1.1,
    Math.max(1.0, globeLod.cloudMarchStepGrowth ?? 1.0),
  );
  const maxRayDistance = Math.max(0.0, globeLod.cloudMaxRayDistance ?? 0.0);
  data[offset++] = marchStepGrowth; // 144 marchStepGrowth (1.0 = off)
  data[offset++] = maxRayDistance; // 145 maxRayDistance (0 = off/infinite)
  data[offset++] = 0.0; // 146 pad
  data[offset++] = 0.0; // 147 pad

  // Fold the two LUT-coupling bits into qualityFlags (slot 74, already packed
  // above). Add-only bits 8/9; set ONLY when the mode is on so the default render
  // leaves them clear → the WGSL gates stay closed → byte-identical.
  if (aerialLutOn || ambientLutOn) {
    let qf = data[74];
    if (aerialLutOn) qf = qf | CLOUD_QF_AERIAL_LUT;
    if (ambientLutOn) qf = qf | CLOUD_QF_AMBIENT_LUT;
    data[74] = qf;
  }
  // Batch 443 — fold the multi-deck bit (11) into qualityFlags. Set ONLY when
  // opted in so the default leaves it clear → the WGSL takes the single-shell
  // branch → byte-identical.
  if (multiDeckOn) {
    data[74] = data[74] | CLOUD_QF_MULTI_DECK;
  }
  // Batch 445 — fold the high-precision bit (12) into qualityFlags. Set ONLY when
  // opted in so the default leaves it clear → the WGSL takes the verbatim
  // closest-point f32 shell/altitude math → byte-identical.
  if (highPrecisionOn) {
    data[74] = data[74] | CLOUD_QF_HIGH_PRECISION;
  }

  device.queue.writeBuffer(cache.uniformBuffer!, 0, data);

  // Weather Phase 1 — resolve the weather view (procedural map when enabled,
  // 1×1 white fallback otherwise).
  const weatherView = ensureWeatherView(
    device,
    cache,
    weatherEnabled,
    providerBytes,
    providerVersion,
  );
  // `noise` (the 3D shape/detail views + sampler) was resolved up-front so the
  // qualityFlags noiseSource bit reflects the same-frame baked state.

  // Batch 434 (3.3 + 3.4) — resolve the atmosphere-LUT views (real when a mode is
  // on AND the LUTs are allocated, 1×1 black placeholders otherwise). Bound
  // unconditionally at 9/10/11 so the BGL never forks; the WGSL gates the samples.
  const lutViews = ensureCloudLutViews(
    device,
    context,
    cache,
    aerialLutOn || ambientLutOn,
  );

  // Create bind group
  const bindGroup = device.createBindGroup({
    layout: cache.bindGroupLayout!,
    entries: [
      { binding: 0, resource: colorTextureView },
      { binding: 1, resource: depthTextureView },
      { binding: 2, resource: cache.sampler! },
      { binding: 3, resource: { buffer: cache.uniformBuffer! } },
      { binding: 4, resource: weatherView },
      { binding: 5, resource: cache.weatherSampler! },
      { binding: 6, resource: noise.shapeView },
      { binding: 7, resource: noise.detailView },
      { binding: 8, resource: noise.sampler },
      { binding: 9, resource: lutViews.skyView },
      { binding: 10, resource: lutViews.multipleScatter },
      { binding: 11, resource: lutViews.transmittance },
      { binding: 12, resource: cache.lutSampler! },
    ],
  });

  // Slice 5c-B Batch 127 — record into the main frame encoder so the
  // composite-over-post-process ordering survives. Same fix pattern as
  // NPR + SSR in this batch (see NPR's call site comment for the full
  // explanation of the encoder-submission ordering issue).
  const mainEncoder = (
    context as unknown as { _currentCommandEncoder?: GPUCommandEncoder }
  )._currentCommandEncoder;
  const useMain = !!mainEncoder;
  const encoder =
    mainEncoder ??
    device.createCommandEncoder({ label: "ProceduralClouds (orphan)" });

  // ── Batch 437 (CLOUD-SHADOWS) — render the sun-view beer shadow map ──
  // Opt-in via `config.cloudCastShadows`. Default OFF → `shadowActive` stays false,
  // the real map is never rendered, and consumers read the 1×1-white placeholder
  // (transmittance 1, no shadow) → byte-identical. When ON we rasterize the cloud
  // optical depth from the sun's ortho view into `cache.shadowView` using the SAME
  // CloudUniforms + weather/noise the visible march uses, so the cast shadow tracks
  // the rendered cloud field exactly. The sun-view ortho VP is stashed on the cache
  // for the consumers (config terrain reads last frame's; aerial/fog this frame's).
  cache.shadowActive = false;
  cache.shadowCascadeActive = false;
  if (config.cloudCastShadows === true) {
    const shadowOk = ensureShadowResources(device, cache);
    if (!shadowOk) {
      // Permanent null-target sentinel (CLAUDE.md): the feature is on but the map
      // couldn't allocate — fall back to the placeholder (no shadow). Real bug.
      console.error(
        `[CesiumJS:webgpu:ctx-${context.id ?? "?"}] Cloud shadow map allocation failed; falling back to no-shadow placeholder.`,
      );
    } else {
      // Footprint center = camera ground point (camera position projected to the
      // ellipsoid surface along its own radial). Sun-relative ortho keeps the
      // matrix product f32-safe near the footprint.
      const cpx = camPos?.x ?? 0;
      const cpy = camPos?.y ?? 0;
      const cpz = camPos?.z ?? 0;
      const camLen = Math.hypot(cpx, cpy, cpz) || 1.0;
      const surf = 6378137.0;
      const groundCenter: [number, number, number] = [
        (cpx / camLen) * surf,
        (cpy / camLen) * surf,
        (cpz / camLen) * surf,
      ];
      const sdx = sunDir?.x ?? 0;
      const sdy = sunDir?.y ?? 1;
      const sdz = sunDir?.z ?? 0;
      buildSunViewOrthoVP(
        groundCenter,
        [sdx, sdy, sdz],
        CLOUD_SHADOW_FOOTPRINT_M,
        cache.shadowSunViewVP,
        cache.shadowUniformData, // first 16 floats = sunViewInvVP
      );
      // CloudShadowUniforms: [0..15] inverse VP (written by buildSunViewOrthoVP into
      // shadowUniformData), [16..19] sunDir + light steps.
      cache.shadowUniformData[16] = sdx;
      cache.shadowUniformData[17] = sdy;
      cache.shadowUniformData[18] = sdz;
      cache.shadowUniformData[19] = CLOUD_SHADOW_LIGHT_STEPS;
      device.queue.writeBuffer(
        cache.shadowUniformBuffer!,
        0,
        cache.shadowUniformData,
      );
      cache.shadowAbsorption = 0.04; // matches CloudUniforms.absorptionCoeff

      const shadowBindGroup = device.createBindGroup({
        layout: cache.shadowBindGroupLayout!,
        entries: [
          { binding: 3, resource: { buffer: cache.uniformBuffer! } },
          { binding: 4, resource: weatherView },
          { binding: 5, resource: cache.weatherSampler! },
          { binding: 6, resource: noise.shapeView },
          { binding: 7, resource: noise.detailView },
          { binding: 8, resource: noise.sampler },
          { binding: 13, resource: { buffer: cache.shadowUniformBuffer! } },
        ],
      });
      const shadowPass = encoder.beginRenderPass({
        label: "CloudShadow map pass",
        colorAttachments: [
          {
            view: cache.shadowView!,
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      });
      shadowPass.setPipeline(cache.shadowPipeline!);
      shadowPass.setBindGroup(0, shadowBindGroup);
      shadowPass.draw(3);
      shadowPass.end();
      cache.shadowActive = true;

      // ── CLOUD-LOD-R5-CASCADED-CLOUD-SHADOW-MAP — opt-in 3-cascade atlas ──
      // Additive on top of the single map (which aerial/fog still read): render
      // three geometrically-split cascades into a stacked 512×1536 atlas the
      // globe terrain samples. Each cascade reuses the single-map pipeline with
      // its own footprint + march-step count, fed from a 256-aligned slice of the
      // cascade uniform buffer. Default OFF → this whole block is skipped and the
      // render is byte-identical to the single-map path.
      if (config.cloudShadowCascades === true) {
        const cascadeOk = ensureCascadeResources(device, cache);
        if (!cascadeOk) {
          // Real bug: the tier is on but the atlas couldn't allocate. The globe
          // falls back to the single map (shadowCascadeActive stays false).
          console.error(
            `[CesiumJS:webgpu:ctx-${context.id ?? "?"}] Cloud shadow cascade atlas allocation failed; falling back to single beer-shadow-map.`,
          );
        } else {
          const cud = cache.shadowCascadeUniformData;
          for (let ci = 0; ci < CLOUD_SHADOW_CASCADE_COUNT; ci++) {
            const base = ci * CLOUD_SHADOW_CASCADE_STRIDE_FLOATS;
            const fwd = cache.shadowCascadeVP.subarray(ci * 16, ci * 16 + 16);
            // Reuse the shared invVP scratch region (cud[base..base+15]) as the
            // per-cascade inverse VP the shadow FS reconstructs columns from.
            const invVP = cud.subarray(base, base + 16);
            buildSunViewOrthoVP(
              groundCenter,
              [sdx, sdy, sdz],
              CLOUD_SHADOW_CASCADE_FOOTPRINTS_M[ci],
              fwd,
              invVP,
            );
            cud[base + 16] = sdx;
            cud[base + 17] = sdy;
            cud[base + 18] = sdz;
            cud[base + 19] = CLOUD_SHADOW_CASCADE_STEPS[ci];
          }
          device.queue.writeBuffer(cache.shadowCascadeUniformBuffer!, 0, cud);

          const cascadePass = encoder.beginRenderPass({
            label: "CloudShadow cascade atlas pass",
            colorAttachments: [
              {
                view: cache.shadowCascadeView!,
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
                loadOp: "clear",
                storeOp: "store",
              },
            ],
          });
          cascadePass.setPipeline(cache.shadowPipeline!);
          for (let ci = 0; ci < CLOUD_SHADOW_CASCADE_COUNT; ci++) {
            // Tile ci occupies rows [ci*512, (ci+1)*512) of the atlas; the
            // full-screen triangle fills the viewport, so each tile gets a full
            // [0,1] UV reconstruction against its own cascade inverse VP.
            cascadePass.setViewport(
              0,
              ci * CLOUD_SHADOW_SIZE,
              CLOUD_SHADOW_SIZE,
              CLOUD_SHADOW_SIZE,
              0,
              1,
            );
            const cascadeBindGroup = device.createBindGroup({
              layout: cache.shadowBindGroupLayout!,
              entries: [
                { binding: 3, resource: { buffer: cache.uniformBuffer! } },
                { binding: 4, resource: weatherView },
                { binding: 5, resource: cache.weatherSampler! },
                { binding: 6, resource: noise.shapeView },
                { binding: 7, resource: noise.detailView },
                { binding: 8, resource: noise.sampler },
                {
                  binding: 13,
                  resource: {
                    buffer: cache.shadowCascadeUniformBuffer!,
                    offset: ci * CLOUD_SHADOW_CASCADE_STRIDE_BYTES,
                    size: CLOUD_SHADOW_UNIFORM_BYTES,
                  },
                },
              ],
            });
            cascadePass.setBindGroup(0, cascadeBindGroup);
            cascadePass.draw(3);
          }
          cascadePass.end();
          cache.shadowCascadeActive = true;
        }
      }
    }
  }

  if (
    halfResActive &&
    cache.halfView &&
    cache.halfPipeline &&
    cache.upscalePipeline &&
    cache.upscaleBindGroupLayout &&
    cache.upscaleUniformBuffer &&
    cache.upscaleSampler
  ) {
    // ── V9 (Batch 432) — HALF-RES PATH ──
    // Pass 1: raymarch into the 0.5× rgba16float target (CLEAR to transparent so
    // non-cloud texels stay 0; the shader emits premultiplied cloud + alpha).
    const halfPass = encoder.beginRenderPass({
      label: "ProceduralClouds half-res pass",
      colorAttachments: [
        {
          view: cache.halfView,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    halfPass.setPipeline(cache.halfPipeline);
    halfPass.setBindGroup(0, bindGroup);
    halfPass.draw(3); // full-screen triangle
    halfPass.end();

    // V10 (Batch 433) — TEMPORAL RESOLVE (optional, between raymarch and upscale).
    // Reproject the previous accumulated history via `previousViewProjection`,
    // neighborhood-clamp it to the current 3×3 freshly-marched AABB (ghost rejection),
    // and blend → write the new accumulated history. The upscale then reads THAT
    // history instead of the raw half-res march. When temporal is OFF (default /
    // cinematic / escape hatch) this whole block is skipped → byte-identical.
    let upscaleSourceView: GPUTextureView = cache.halfView;
    if (
      temporalActive &&
      cache.temporalPipeline &&
      cache.temporalBindGroupLayout &&
      cache.temporalUniformBuffer &&
      cache.temporalSampler &&
      cache.temporalHistoryView[0] &&
      cache.temporalHistoryView[1]
    ) {
      const readIdx = cache.temporalRead & 1;
      const writeIdx = readIdx ^ 1;
      const readView = cache.temporalHistoryView[readIdx]!;
      const writeView = cache.temporalHistoryView[writeIdx]!;

      // Pack TemporalUniforms (60 floats — byte-locked to CloudTemporalResolve.wgsl).
      const td = cache.temporalUniformData;
      let to = 0;
      // previousViewProjection (mat4, 16) — column-major, same as the cloud packer.
      const prevVP = us?.previousViewProjection;
      if (prevVP) {
        for (let i = 0; i < 16; i++) td[to++] = prevVP[i];
      } else {
        to += 16;
      }
      // inverseProjection (mat4, 16) — current frame.
      if (invProj) {
        for (let i = 0; i < 16; i++) td[to++] = invProj[i];
      } else {
        to += 16;
      }
      // inverseView (mat4, 16) — current frame.
      if (invView) {
        for (let i = 0; i < 16; i++) td[to++] = invView[i];
      } else {
        to += 16;
      }
      // cameraPositionAndBlend (vec4): camera world pos + per-frame blend weight.
      td[to++] = camPos?.x ?? 0;
      td[to++] = camPos?.y ?? 0;
      td[to++] = camPos?.z ?? 0;
      td[to++] = Math.max(
        1 / 16,
        Math.min(1, cloudPreset.temporalUpdateFraction || 1 / 8),
      );
      // shellRadiiAndRes (vec4): inner/outer shell radius + half-res target size.
      const innerR = 6378137.0 + (config.cloudLayerBottom ?? 1500.0);
      const outerR = 6378137.0 + (config.cloudLayerTop ?? 4000.0);
      td[to++] = innerR;
      td[to++] = outerR;
      td[to++] = cache.halfWidth;
      td[to++] = cache.halfHeight;
      // firstFrameFlags (vec4): x=1 on the first temporal frame (seed identity).
      td[to++] = cache.temporalFirstFrame ? 1.0 : 0.0;
      td[to++] = 0;
      td[to++] = 0;
      td[to++] = 0;
      device.queue.writeBuffer(cache.temporalUniformBuffer, 0, td);

      const temporalBindGroup = device.createBindGroup({
        layout: cache.temporalBindGroupLayout,
        entries: [
          { binding: 0, resource: cache.halfView }, // current freshly-marched
          { binding: 1, resource: readView }, // previous accumulated history
          { binding: 2, resource: cache.temporalSampler },
          { binding: 3, resource: { buffer: cache.temporalUniformBuffer } },
        ],
      });
      const temporalPass = encoder.beginRenderPass({
        label: "CloudTemporalResolve pass",
        colorAttachments: [
          {
            view: writeView,
            // No clear: the shader writes every texel (full-screen triangle).
            loadOp: "load",
            storeOp: "store",
          },
        ],
      });
      temporalPass.setPipeline(cache.temporalPipeline);
      temporalPass.setBindGroup(0, temporalBindGroup);
      temporalPass.draw(3);
      temporalPass.end();

      // The upscale reads the freshly-written, accumulated history.
      upscaleSourceView = writeView;
      // Ping-pong: next frame reads what we just wrote.
      cache.temporalRead = writeIdx;
      cache.temporalFirstFrame = false;
    }

    // Pass 2/3: depth-aware bilateral upscale + composite over the scene → canvas.
    const ud = cache.upscaleUniformData;
    ud[0] = canvasW; // fullResolution.x
    ud[1] = canvasH; // fullResolution.y
    ud[2] = 1.0 / Math.max(canvasW, 1); // invFullResolution.x
    ud[3] = 1.0 / Math.max(canvasH, 1); // invFullResolution.y
    ud[4] = cache.halfWidth; // halfResolution.x
    ud[5] = cache.halfHeight; // halfResolution.y
    ud[6] = 1.0 / Math.max(cache.halfWidth, 1); // invHalfResolution.x
    ud[7] = 1.0 / Math.max(cache.halfHeight, 1); // invHalfResolution.y
    ud[8] = CLOUD_UPSCALE_DEPTH_SIGMA; // depthSigma
    ud[9] = 0;
    ud[10] = 0;
    ud[11] = 0;
    device.queue.writeBuffer(cache.upscaleUniformBuffer, 0, ud);

    const upscaleBindGroup = device.createBindGroup({
      layout: cache.upscaleBindGroupLayout,
      entries: [
        { binding: 0, resource: upscaleSourceView },
        { binding: 1, resource: colorTextureView },
        { binding: 2, resource: depthTextureView },
        { binding: 3, resource: cache.upscaleSampler },
        { binding: 4, resource: { buffer: cache.upscaleUniformBuffer } },
      ],
    });
    const upscalePass = encoder.beginRenderPass({
      label: "CloudUpscale composite pass",
      colorAttachments: [
        {
          view: outputView,
          loadOp: "load",
          storeOp: "store",
        },
      ],
    });
    upscalePass.setPipeline(cache.upscalePipeline);
    upscalePass.setBindGroup(0, upscaleBindGroup);
    upscalePass.draw(3);
    upscalePass.end();
  } else {
    // ── Full-res path (default / cinematic / escape hatch) — UNCHANGED ──
    const pass = encoder.beginRenderPass({
      label: "ProceduralClouds pass",
      colorAttachments: [
        {
          view: outputView,
          loadOp: "load",
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(cache.pipeline!);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3); // full-screen triangle
    pass.end();
  }

  // ── TAKRAM-9 (cloud-aware god rays) — screen-space transmittance mask ──
  // Rendered ONLY when a consumer requested it (the PP god-ray pass). Reuses the
  // main per-frame `bindGroup` (same layout/inputs) but a dedicated r8unorm
  // pipeline + target driven by the `fragmentCloudMaskMain` entry point. The
  // shipped composite passes above are untouched → byte-identical when off.
  if (cache.maskCaptureEnabled) {
    ensureCloudMaskResources(device, cache, canvasW, canvasH);
    if (cache.maskPipeline && cache.maskView) {
      const maskPass = encoder.beginRenderPass({
        label: "ProceduralClouds transmittance-mask pass",
        colorAttachments: [
          {
            view: cache.maskView,
            // Clear to 1.0 (fully transmissive) so any pixel the full-screen
            // triangle somehow misses reads as clear sky.
            clearValue: { r: 1, g: 1, b: 1, a: 1 },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      });
      maskPass.setPipeline(cache.maskPipeline);
      maskPass.setBindGroup(0, bindGroup);
      maskPass.draw(3);
      maskPass.end();
      cache.maskRenderedThisFrame = true;
    }
  }

  if (!useMain) {
    device.queue.submit([encoder.finish()]);
  }
}

/**
 * TAKRAM-9 — lazily allocate the transmittance-mask target + pipeline (only
 * reached when a consumer enabled capture). The r8unorm target is re-created on
 * canvas resize; the pipeline (size-independent) is built once from the retained
 * cloud shader module + the shared cloud BGL.
 */
function ensureCloudMaskResources(
  device: GPUDevice,
  cache: CloudCache,
  width: number,
  height: number,
): void {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  if (!cache.maskTexture || cache.maskWidth !== w || cache.maskHeight !== h) {
    cache.maskTexture?.destroy();
    cache.maskTexture = device.createTexture({
      label: "ProceduralClouds transmittance mask",
      size: { width: w, height: h, depthOrArrayLayers: 1 },
      format: "r8unorm",
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    cache.maskView = cache.maskTexture.createView();
    cache.maskWidth = w;
    cache.maskHeight = h;
  }
  if (!cache.maskPipeline && cache.maskShaderModule && cache.bindGroupLayout) {
    const layout = device.createPipelineLayout({
      label: "ProceduralClouds mask pipeline layout",
      bindGroupLayouts: [cache.bindGroupLayout],
    });
    cache.maskPipeline = device.createRenderPipeline({
      label: "ProceduralClouds mask pipeline",
      layout,
      vertex: { module: cache.maskShaderModule, entryPoint: "vertexMain" },
      fragment: {
        module: cache.maskShaderModule,
        entryPoint: "fragmentCloudMaskMain",
        targets: [{ format: "r8unorm" }],
      },
      primitive: { topology: "triangle-list" },
    });
  }
}

export function destroyProceduralCloudResources(
  context: CesiumGraphicsContext,
): void {
  const cache = context._cloudCache;
  if (cache) {
    cache.uniformBuffer?.destroy();
    cache.pipeline = null;
    cache.uniformBuffer = null;
    cache.bindGroupLayout = null;
    cache.sampler = null;
    // V9 (Batch 432) — release the half-res target + upscale resources.
    cache.halfTexture?.destroy();
    cache.halfTexture = null;
    cache.halfView = null;
    cache.halfWidth = 0;
    cache.halfHeight = 0;
    cache.halfPipeline = null;
    cache.upscaleUniformBuffer?.destroy();
    cache.upscaleUniformBuffer = null;
    cache.upscalePipeline = null;
    cache.upscaleBindGroupLayout = null;
    cache.upscaleSampler = null;
    // V10 (Batch 433) — release the temporal ping-pong history + resolve resources.
    cache.temporalHistory[0]?.destroy();
    cache.temporalHistory[1]?.destroy();
    cache.temporalHistory = [null, null];
    cache.temporalHistoryView = [null, null];
    cache.temporalWidth = 0;
    cache.temporalHeight = 0;
    cache.temporalRead = 0;
    cache.temporalFirstFrame = true;
    cache.temporalUniformBuffer?.destroy();
    cache.temporalUniformBuffer = null;
    cache.temporalPipeline = null;
    cache.temporalBindGroupLayout = null;
    cache.temporalSampler = null;
    // Batch 434 (3.3 + 3.4) — release the LUT placeholder + sampler. The real LUT
    // textures are owned by the performance manager, not this cache.
    cache.lutPlaceholderTexture?.destroy();
    cache.lutPlaceholderTexture = null;
    cache.lutPlaceholderView = null;
    cache.lutSampler = null;
    // Batch 437 (CLOUD-SHADOWS) — release the beer-shadow-map resources.
    cache.shadowTexture?.destroy();
    cache.shadowTexture = null;
    cache.shadowView = null;
    cache.shadowPlaceholderTexture?.destroy();
    cache.shadowPlaceholderTexture = null;
    cache.shadowPlaceholderView = null;
    cache.shadowSampler = null;
    cache.shadowPipeline = null;
    cache.shadowBindGroupLayout = null;
    cache.shadowUniformBuffer?.destroy();
    cache.shadowUniformBuffer = null;
    cache.shadowSize = 0;
    cache.shadowActive = false;
    // CLOUD-LOD-R5 — release the cascade atlas + cascade uniform buffer.
    cache.shadowCascadeTexture?.destroy();
    cache.shadowCascadeTexture = null;
    cache.shadowCascadeView = null;
    cache.shadowCascadeUniformBuffer?.destroy();
    cache.shadowCascadeUniformBuffer = null;
    cache.shadowCascadeActive = false;
    cache.shadowCascadeSize = 0;
    // TAKRAM-9 — release the transmittance-mask target + pipeline.
    cache.maskTexture?.destroy();
    cache.maskTexture = null;
    cache.maskView = null;
    cache.maskWidth = 0;
    cache.maskHeight = 0;
    cache.maskPipeline = null;
    cache.maskShaderModule = null;
    cache.maskRenderedThisFrame = false;
    cache.initialized = false;
    context._cloudCache = undefined;
  }
}
