/// <reference types="@webgpu/types" />
/**
 * WebGPU Procedural Cloud Renderer
 *
 * Renders volumetric clouds as a full-screen pass using ray marching. Activated
 * by a {@link CloudCollection} whose render mode is volumetric — either the
 * Scene/Globe-managed `globe.defaultCloudCollection` or a user collection.
 *
 * Configuration is carried by the collection's `.volumetric`
 * {@link CloudVolumetrics}, resolved into a {@link CloudVolumetricsConfig}
 * snapshot each frame:
 *   - enabled: boolean (default false) → collection renderMode VOLUMETRIC
 *   - cloudCoverage: number 0-1 (default 0.5)
 *   - cloudLayerBottom: number meters (default 1500)
 *   - cloudLayerTop: number meters (default 4000)
 *   - cloudWindSpeed: number m/s (default 15)
 *   - cloudWindDirection: {x, y} (default {x: 0.7, y: 0.3})
 *   - cloudDensity: number (default 0.3)
 *   - cloudQuality: number 32-128 steps (default 64)
 *
 * Reconstruction attachments. The attachment pass writes front and
 * transmittance-weighted cloud depth, screen-space motion with an explicit
 * validity channel, and the depth/coverage moment pair, at the half-resolution
 * march size, with full creation, resize and device-swap lifecycle behind a
 * monotonic generation key. It is opt-in and off by default
 * (`setCloudReconstructionAttachments`, surfaced as
 * `CesiumDebug.cloudReconstructionAttachments(true)`): with it off nothing
 * allocates and no pass is encoded, so the cloud lane is unchanged in both
 * pixels and cost.
 *
 * The set is written but nothing samples it yet, so those targets are
 * producer-side scaffolding rather than unused resources. Cloud depth still
 * comes from the analytic estimator — the shell interval under the march's own
 * resolved alpha — rather than from per-sample accumulation emitted by the
 * march, and the temporal resolve does not read the motion, moment or depth
 * channels for rejection, variance clipping, reactive history, wind advection
 * or disocclusion.
 *
 * Orthographic and morph frames produce no attachments: the producer needs a
 * usable inverse current view-projection-relative-to-eye for its per-pixel ray,
 * which those projections do not supply. Carrying a per-pixel ray origin
 * through reconstruction instead would lift the restriction.
 *
 * @private
 */
import ProceduralCloudsWGSL from "../../Shaders/WebGPU/Environment/ProceduralClouds.js";
import CloudDensityDomainWGSL from "../../Shaders/WebGPU/Environment/CloudDensityDomain.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  texture,
  sampler,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import {
  CloudCpuStage,
  CloudCpuStageAccumulator,
  createCloudFrameCounters,
  recordCloudPass,
  resetCloudFrameCounters,
} from "./WebGPUCloudObservability.js";
import type { CloudFrameCounters } from "./WebGPUCloudObservability.js";
import {
  resolveCloudPreset,
  CloudNoiseSource,
  CLOUD_QF_OCTAVES_SHIFT,
  CLOUD_QF_NOISE_BAKED,
  CLOUD_QF_HALF_RES,
  CLOUD_QF_TEMPORAL,
  CLOUD_QF_JITTER,
  CLOUD_QF_AERIAL_LUT,
  CLOUD_QF_AMBIENT_LUT,
  CLOUD_QF_LIGHT_CONE,
  CLOUD_QF_MULTI_DECK,
  CLOUD_QF_HIGH_PRECISION,
  CLOUD_QF_PLANET_DENSITY,
} from "./WebGPUCloudTierPresets.js";
import {
  CLOUD_DENSITY_MORPHOLOGY_ORIGIN_FLOATS,
  CLOUD_DENSITY_ORIGIN_PHASE_FLOATS,
  CLOUD_DENSITY_PRIMARY_ORIGIN_FLOATS,
  writeCloudDensityAdvectedOriginPhases,
  writeCloudMorphologyOriginHighLow,
} from "./WebGPUCloudDensityDomain.js";
// The single owner of the relative-to-eye WGS84 frame, shared by the
// beer-shadow-map producer and every consumer that projects into it.
import {
  CLOUD_SHADOW_WGS84_A,
  CLOUD_SHADOW_WGS84_B,
  type CloudShadowFrame,
  computeCloudShadowFrame,
  createCloudShadowFrame,
  writeCloudShadowInverseViewProjectionRelativeToEye,
  writeCloudShadowViewProjection,
} from "./WebGPUCloudShadowFrame.js";
// Supplies the relative-to-eye high/low camera split for the camera-relative
// high-precision march. Only the encoded floats in uniform slots 120-127 come
// from here, and the shader reads them solely inside the
// CLOUD_QF_HIGH_PRECISION branch.
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import OrthographicFrustum from "../../Core/OrthographicFrustum.js";
import OrthographicOffCenterFrustum from "../../Core/OrthographicOffCenterFrustum.js";
import SceneMode from "../../Scene/SceneMode.js";
// Half-resolution bilateral-upscale composite shader.
import CloudUpscaleWGSL from "../../Shaders/WebGPU/Environment/CloudUpscale.js";
// Temporal reprojection and accumulation resolve shader.
import CloudTemporalResolveWGSL from "../../Shaders/WebGPU/Environment/CloudTemporalResolve.js";
// The reconstruction attachment producer, kept in its own shader module and its
// own pipeline. WGSL register allocation is static across a module, so folding
// this into `ProceduralClouds.wgsl` would charge every march variant for
// registers only the attachment producer uses.
import CloudReconstructionAttachmentsWGSL from "../../Shaders/WebGPU/Environment/CloudReconstructionAttachments.js";
import {
  CLOUD_ATTACHMENT_DEFAULT_DEPTH_NORMALIZATION_METERS,
  CLOUD_ATTACHMENT_UNIFORM_BYTES,
  CLOUD_ATTACHMENT_UNIFORM_FLOATS,
  CLOUD_EMITTED_ATTACHMENTS,
  CLOUD_MARCH_EMITTED_SLOT,
  CLOUD_OWNED_ATTACHMENTS,
  cloudAttachmentsNeedAllocation,
  commitCloudAttachmentGeneration,
  createCloudAttachmentGeneration,
  packCloudAttachmentUniforms,
  releaseCloudAttachmentGeneration,
} from "./WebGPUCloudReconstructionAttachments.js";
// The reconstruction emission and consumption axes. Two compile-time bits
// rather than a uniform: WGSL register allocation is static, so gating the
// march's emission on a uniform would charge the shadow map, the cascade atlas,
// the god-ray mask and the full-resolution march for registers only the
// half-resolution march uses.
import { ShaderDefineHi } from "./WebGPUShaderDefines.js";
import { preprocess } from "./WebGPUShaderPreprocessor.js";
import type {
  CloudAttachmentGeneration,
  CloudAttachmentUniformInputs,
} from "./WebGPUCloudReconstructionAttachments.js";
import { buildCloudNoiseResources } from "./WebGPUCloudNoiseResources.js";
import type { CloudNoiseResources } from "./WebGPUCloudNoiseResources.js";
import {
  CLOUD_TEMPORAL_RESET_RESOURCE,
  classifyCloudTemporalHistoryReset,
  cloudTemporalResetStartsGeneration,
  commitCloudTemporalHistoryState,
  createCloudTemporalHistorySample,
  createCloudTemporalHistoryState,
} from "./WebGPUCloudTemporalHistory.js";
import type {
  CloudTemporalHistorySample,
  CloudTemporalHistoryState,
} from "./WebGPUCloudTemporalHistory.js";
// Per-genus vertical-density profiles. Backend-neutral scene data; the shader
// only reads the packed profile floats.
import CloudTypeProfile from "../../Scene/CloudTypeProfile.js";
import CloudType from "../../Scene/CloudType.js";
// The default global weather map. Shared with the real-data packer so both
// producers write the one dateline- and pole-safe equirectangular convention
// defined in `Scene/Weather/WeatherMapSeam.ts`.
import { buildProceduralWeatherMap } from "../../Scene/Weather/ProceduralWeatherMap.js";
// The eclipse response for this subsystem: backend-neutral scene math over the
// eclipse state published by the frame. Nothing about the eclipse geometry is
// recomputed here.
import {
  applyEclipseCloudDimming,
  eclipseCloudDirectionalFraction,
  resolveEclipseCloudFactor,
} from "../../Scene/EclipseCloudResponse.js";

// Float count of the `CloudUniforms` block. The layout is append-only: the WGSL
// struct and this count are two spellings of one memory image, so a slot may be
// renamed or repurposed in place but never moved, and new fields extend the
// tail. The trailing terms name the two blocks that already do so.
const CLOUD_GENUS_MORPHOLOGY_FLOATS = 4;
const CLOUD_UNIFORM_FLOATS =
  148 + CLOUD_DENSITY_PRIMARY_ORIGIN_FLOATS + CLOUD_GENUS_MORPHOLOGY_FLOATS;
const CLOUD_UNIFORM_BYTES = CLOUD_UNIFORM_FLOATS * 4;
const PROCEDURAL_CLOUDS_SOURCE = `${CloudDensityDomainWGSL}\n${ProceduralCloudsWGSL}`;
// High-word define masks for the emitting march and the consuming resolve.
// Named once so no call site spells a bit inline, and so a spec can assert the
// renderer preprocesses with the axis the registry documents rather than with a
// literal that happens to match it today.
const CLOUD_MARCH_EMIT_DEFINES_HI =
  ShaderDefineHi.CLOUD_MARCH_EMIT_RECONSTRUCTION as number;
const CLOUD_RECONSTRUCTION_CONSUME_DEFINES_HI =
  ShaderDefineHi.CLOUD_RECONSTRUCTION_CONSUME as number;
// Format of the attachment the march writes directly under the emission
// variant. Read from the contract table, never restated: the pipeline target,
// the texture and the WGSL output must agree by construction.
const CLOUD_MARCH_EMITTED_FORMAT: GPUTextureFormat =
  CLOUD_OWNED_ATTACHMENTS[CLOUD_MARCH_EMITTED_SLOT - 1].format;
// The shell axes the march reads and the axes the sun-view frame projects the
// footprint centre onto have to be one value, or the shadow map lands on a
// different deck than the one the visible march renders.
const WGS84_EQUATORIAL_RADIUS = CLOUD_SHADOW_WGS84_A;
const WGS84_POLAR_RADIUS = CLOUD_SHADOW_WGS84_B;
// Procedural weather-map texture (coarse global coverage field).
const WEATHER_TEX_W = 256;
const WEATHER_TEX_H = 128;
// Reused result for the per-frame camera high/low split, avoiding a per-frame
// allocation. Written only when the camera position is defined, and read into
// cloud uniform slots 120-127.
const scratchEncodedCamera = new EncodedCartesian3();
const scratchInverseViewRelativeToEye = new Matrix4();
const scratchInverseCurrentViewProjectionRelativeToEye = new Matrix4();

export interface CloudMainBindGroupEntry {
  layout: GPUBindGroupLayout;
  uniformBuffer: GPUBuffer;
  colorView: GPUTextureView;
  depthView: GPUTextureView;
  mainSampler: GPUSampler;
  weatherView: GPUTextureView;
  weatherSampler: GPUSampler;
  shapeView: GPUTextureView;
  detailView: GPUTextureView;
  noiseSampler: GPUSampler;
  skyView: GPUTextureView;
  multipleScatterView: GPUTextureView;
  transmittanceView: GPUTextureView;
  lutSampler: GPUSampler;
  bindGroup: GPUBindGroup;
}

export interface CloudUpscaleBindGroupEntry {
  layout: GPUBindGroupLayout;
  uniformBuffer: GPUBuffer;
  upscaleSourceView: GPUTextureView;
  colorView: GPUTextureView;
  depthView: GPUTextureView;
  sampler: GPUSampler;
  bindGroup: GPUBindGroup;
}

function matrix4IsFinite(matrix: ArrayLike<number> | undefined): boolean {
  if (!matrix || matrix.length < 16) {
    return false;
  }
  for (let index = 0; index < 16; index++) {
    if (!Number.isFinite(matrix[index])) {
      return false;
    }
  }
  return true;
}

function matrix4HasNonZeroEntry(matrix: ArrayLike<number>): boolean {
  for (let index = 0; index < 16; index++) {
    if (matrix[index] !== 0.0) {
      return true;
    }
  }
  return false;
}

/**
 * Resolves the inverse current view-projection-relative-to-eye into the shared
 * scratch matrix and reports whether the result is usable.
 *
 * Since inverse(P * Vrot) = inverse(Vrot) * inverse(P), this reuses the inverse
 * view and inverse projection `UniformState` already produced and drops the
 * inverse-view translation, rather than generally inverting the
 * relative-to-eye matrix — the cheaper form in the perspective hot path.
 * Orthographic and morph projections are unsupported and are gated by the
 * caller's `supported` flag before any resource is allocated.
 *
 * Both the temporal resolve and the reconstruction attachment producer need
 * this same current-ray transform, so it lives in one place; two independently
 * maintained relative-to-eye inversions would drift out of the shared
 * coordinate contract.
 *
 * The previous-frame transform is not part of this predicate. It is a
 * reprojection input rather than a current-ray input, and the two callers need
 * different things from it: the temporal resolve cannot run without it and
 * checks it alongside this call, while the attachment producer's depth and
 * moment channels are well defined on a frame with no usable history. Only its
 * velocity channel is not, and that channel carries its own validity flag for
 * exactly this case.
 */
function resolveCloudInverseCurrentVpRte(
  supported: boolean,
  inverseProjection: ArrayLike<number> | undefined,
  inverseView: ArrayLike<number> | undefined,
): boolean {
  if (
    !supported ||
    !matrix4IsFinite(inverseProjection) ||
    !matrix4IsFinite(inverseView) ||
    !matrix4HasNonZeroEntry(inverseProjection as Matrix4)
  ) {
    return false;
  }
  Matrix4.clone(inverseView as Matrix4, scratchInverseViewRelativeToEye);
  scratchInverseViewRelativeToEye[12] = 0.0;
  scratchInverseViewRelativeToEye[13] = 0.0;
  scratchInverseViewRelativeToEye[14] = 0.0;
  Matrix4.multiply(
    scratchInverseViewRelativeToEye,
    inverseProjection as Matrix4,
    scratchInverseCurrentViewProjectionRelativeToEye,
  );
  return matrix4IsFinite(scratchInverseCurrentViewProjectionRelativeToEye);
}

/**
 * True when both camera positions exist and are finite, that is, when the
 * `f64` `currentCameraWC - previousCameraWC` delta the shaders add before the
 * previous-frame projection is meaningful.
 */
function cloudCameraPairIsFinite(
  currentCamera: { x: number; y: number; z: number } | undefined,
  previousCamera: { x: number; y: number; z: number } | undefined,
): boolean {
  return (
    currentCamera !== undefined &&
    previousCamera !== undefined &&
    Number.isFinite(currentCamera.x) &&
    Number.isFinite(currentCamera.y) &&
    Number.isFinite(currentCamera.z) &&
    Number.isFinite(previousCamera.x) &&
    Number.isFinite(previousCamera.y) &&
    Number.isFinite(previousCamera.z)
  );
}

export interface CloudCache {
  pipeline: GPURenderPipeline | null;
  uniformBuffer: GPUBuffer | null;
  bindGroupLayout: GPUBindGroupLayout | null;
  sampler: GPUSampler | null;
  uniformData: Float32Array;
  mainBindGroups: [
    CloudMainBindGroupEntry | null,
    CloudMainBindGroupEntry | null,
  ];
  mainBindGroupNextSlot: number;
  initialized: boolean;
  // Day-seconds of the first frame, cached so the cloud `time` uniform starts
  // near 0 and the accumulated wind offset stays inside f32 precision.
  timeEpoch: number | null;
  // Global coverage field sampled by the march.
  weatherTexture: GPUTexture | null; // 2d-array depth-1 coverage field
  weatherView: GPUTextureView | null;
  weatherFallbackView: GPUTextureView | null; // 1×1 white, bound when disabled
  weatherSampler: GPUSampler | null;
  // Which bytes `weatherTexture` currently holds: -2 = nothing, -1 = the
  // procedural map, >= 0 = the uploaded `WeatherProvider.version`.
  weatherProviderVersion: number;
  // Baked 3D shape and detail noise, bound at 6, 7 and 8.
  noise: CloudNoiseResources | null;
  noiseBaked: boolean;
  noiseFallbackTexture: GPUTexture | null;
  noiseFallbackView: GPUTextureView | null; // 1×1×1 white 3D, bound until baked
  noiseFallbackSampler: GPUSampler | null;
  // Half-resolution cloud target and its bilateral-upscale pass, all null on the
  // full-resolution path and allocated lazily only when a tier resolves
  // `renderResScale` below 1. `halfPipeline` marches into `halfView`
  // (rgba16float); `upscalePipeline` reads that together with the full-resolution
  // scene and depth and composites to the canvas. The half-resolution target is
  // recreated on canvas resize.
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
  upscaleBindGroups: [
    CloudUpscaleBindGroupEntry | null,
    CloudUpscaleBindGroupEntry | null,
  ];
  upscaleBindGroupNextSlot: number;
  // Shared exact integer phase: the low 4 bits carry the Bayer and light-cone
  // 16-phase sequence, and all 6 bits drive the animated interleaved-gradient
  // noise sequence.
  frameCounter: number;
  // Temporal reprojection and accumulation, all null while temporal is off. The
  // history is ping-ponged at half resolution and accumulates the premultiplied
  // half-resolution cloud: the resolve pass reprojects `temporalHistory[read]`,
  // blends it with this frame's freshly marched `halfTexture` and writes
  // `temporalHistory[write]`, and the upscale pass then reads that written
  // history instead of `halfTexture`. Recreated on canvas or half-resolution
  // resize. `temporalFirstFrame` forces an identity-history seed, matching the
  // first-frame convention used by TAA and CSM, so there is no startup flash.
  temporalHistory: [GPUTexture | null, GPUTexture | null];
  temporalHistoryView: [GPUTextureView | null, GPUTextureView | null];
  temporalWidth: number;
  temporalHeight: number;
  temporalRead: number; // ping-pong index (0/1) of the history to READ this frame
  temporalFirstFrame: boolean;
  temporalPipeline: GPURenderPipeline | null; // reproject + clamp + blend → new history
  temporalBindGroupLayout: GPUBindGroupLayout | null;
  // One bind group per history-read parity, rebuilt only when the
  // half-resolution or history views are reallocated, so the temporal path
  // selects by parity and allocates no bind group per frame.
  temporalBindGroups: [GPUBindGroup | null, GPUBindGroup | null];
  temporalUniformBuffer: GPUBuffer | null;
  temporalUniformData: Float32Array;
  temporalSampler: GPUSampler | null;
  // Allocation-free coarse history compatibility and its externally visible
  // diagnostics. Wind, weather and depth rejection are not part of it.
  temporalHistoryState: CloudTemporalHistoryState;
  temporalHistorySample: CloudTemporalHistorySample;
  // Reset reasons observed continuously in the current reset episode. A new
  // reason bit starts a new generation even on an adjacent reset frame, while a
  // persistent reason, such as an in-progress morph, does not increment it
  // every frame.
  temporalHistoryLatchedResetReasons: number;
  // Renderer-owned reasons such as history texture reallocation are ORed with
  // the pure classifier on the next resolve and then consumed.
  temporalHistoryPendingResetReasons: number;
  temporalHistoryGeneration: number;
  temporalHistoryResetReasons: number;
  temporalHistoryResetCount: number;
  temporalHistoryAcceptedFrames: number;
  // Atmosphere-LUT coupling. The cloud bind-group layout always declares the
  // three LUT textures — sky-view, multiple-scattering and transmittance — plus
  // a linear sampler at bindings 9-12, so the pipeline layout never forks on
  // whether the LUTs are in use. When the modes are off, or the LUTs are not
  // baked, a 1×1 black rgba16float placeholder is bound instead: the shader
  // gates each LUT sample on both its mode bit and a non-zero radiance, so a
  // black placeholder reads as unbaked and the heuristic constant path runs.
  lutPlaceholderTexture: GPUTexture | null;
  lutPlaceholderView: GPUTextureView | null; // 1×1 black, bound when off/unbaked
  lutSampler: GPUSampler | null;
  // Sun-view Beer shadow map, allocated only when `globe.cloudCastShadows` is
  // on. Otherwise everything here stays null and consumers read the shared 1×1
  // placeholder `shadowPlaceholderView`, whose optical depth of 0 gives
  // transmittance 1. The map stores cloud optical depth, the sum of density
  // times segment length along the sun ray, rasterized from the sun's
  // orthographic view by the `cloudShadowMain` entry point. `shadowFrame` is the
  // authoritative f64 projection: consumers derive their own eye-relative matrix
  // from it, and `shadowSunViewVP` is the absolute matrix kept for the planar
  // scene modes. Consumers gate on `shadowActive` so the off path never samples
  // a stale map.
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
  // The f64 sun-view frame the matrix above is derived from. Consumers read this
  // and emit their own eye-relative matrix against their own camera through
  // `writeCloudShadowViewProjectionRelativeToEye`, so no consumer forms a
  // planet-scale f32 matrix product. `shadowSunViewVP` remains the absolute
  // fallback for the planar scene modes, whose fragments have no ECEF
  // eye-relative position.
  shadowFrame: CloudShadowFrame;
  shadowCascadeFrames: CloudShadowFrame[];
  shadowActive: boolean; // true when the real map was rendered this frame
  shadowAbsorption: number; // absorptionCoeff used so consumers' exp() matches
  // The cast-shadow strength all four consumers mix with, published through this
  // one seam exactly as `shadowAbsorption` is, so the globe terrain, the
  // cascaded atlas branch, aerial perspective and the high-fidelity volumetric
  // fog path cannot drift apart. It is 1.0 outside a solar eclipse and falls to
  // 0 at totality, because the umbral sky is nonlocal multiple scattering that
  // no local cloud can shadow. See `Scene/EclipseCloudResponse.js`.
  shadowStrength: number;
  // Opt-in three-cascade shadow atlas, allocated only when
  // `config.cloudShadowCascades` is on and clouds cast shadows. The atlas is a
  // 512×1536 r16float texture holding three stacked 512² tiles, tile 0 being the
  // finest near cascade. It is rendered by three viewport-scoped draws of the
  // same `cloudShadowMain` entry point, each fed its own cascade uniforms
  // through a 256-aligned slice of `shadowCascadeUniformBuffer`. The globe
  // terrain reads this atlas through its cascade branch; aerial perspective and
  // fog keep reading the single map.
  shadowCascadeTexture: GPUTexture | null;
  shadowCascadeView: GPUTextureView | null; // r16float atlas, 3 stacked tiles
  shadowCascadeUniformBuffer: GPUBuffer | null; // 3×256B CloudShadowUniforms
  shadowCascadeUniformData: Float32Array; // 3×64 floats (256B stride)
  shadowCascadeVP: Float32Array; // 48 floats, 3 forward VPs for the consumers
  shadowCascadeActive: boolean; // true when the atlas was rendered this frame
  shadowCascadeSize: number; // per-tile square resolution currently allocated
  // Effective cloud coverage in [0, 1] that the dynamic environment map's sky
  // fill darkens and flattens its radiance toward, so an overcast procedural
  // sky produces a dim, flat ambient on lit glTF models and 3D tiles through
  // the SH-L2 projection of the environment cube, and on the sky-LUT fog
  // ambient. Published every frame by the environmental-effects dispatch in
  // `publishCloudIblCoverage`, independently of frustum culling and of whether
  // the raymarch ran, so turning `showProceduralClouds` or
  // `cloudContributesIBL` off resets it to 0 rather than leaving a stale value.
  // At 0 the fill's overcast blend is skipped entirely.
  iblCoverage: number;
  // The visible march parameters, published every frame alongside
  // `iblCoverage` from the environmental-effects dispatch, which is where
  // `scene.globe` is in scope. The dynamic environment map manager reads these
  // rather than `frameState.globe`, which does not exist, so the reflected
  // cloud deck tracks live deck altitude, wind and density instead of frozen
  // constructor defaults. `iblPWActive` mirrors the visible renderer's
  // `cloudNoiseMorphology === "perlin-worley"` decision so the reflection march
  // samples the same baked base shape the visible deck does. They are inert
  // while reflections are off: the manager consumes them only when the
  // `cloudsInReflections` flag is on and coverage exceeds 0.
  iblDeckBottom: number;
  iblDeckTop: number;
  iblWindX: number;
  iblWindY: number;
  iblWindSpeed: number;
  iblTimeSeconds: number;
  iblDensity: number;
  iblPuffSize: number;
  iblPWActive: boolean;
  // The discrete "does the cloud deck contribute to reflections at all" state,
  // that is `showProceduralClouds` and `cloudContributesIBL` together. Held
  // separately from `iblCoverage` and compared exactly, so toggling either flag
  // bumps `iblRevision` immediately even when the deck's coverage sits below the
  // coverage quantization step that debounces the continuous inputs.
  iblContributesIbl: boolean;
  // Bounded invalidation signal for the expensive environment-cube cloud march.
  // Static appearance changes increment it immediately; pure advection
  // increments it only after a meaningful world-space displacement.
  iblRevision: number;
  iblRevisionAdvectionX: number;
  iblRevisionAdvectionZ: number;
  // Screen-space cloud transmittance mask for cloud-aware god rays, allocated
  // only when a consumer — the post-process god-ray pass — requests it through
  // `setCloudTransmittanceCapture(context, true)`. Everything here stays null
  // otherwise, so the composite pass is unchanged when nothing wants the mask.
  // With capture on, a dedicated full-resolution r8unorm target is rendered by
  // the `fragmentCloudMaskMain` entry point, holding transmittance Πᵢ(1-αᵢ),
  // immediately after the composite pass and sharing its per-frame bind group
  // and uniforms.
  maskCaptureEnabled: boolean;
  maskTexture: GPUTexture | null;
  maskView: GPUTextureView | null; // r8unorm, 1=clear 0=opaque cloud
  maskWidth: number;
  maskHeight: number;
  maskPipeline: GPURenderPipeline | null;
  maskShaderModule: GPUShaderModule | null;
  maskRenderedThisFrame: boolean;
  // Reconstruction attachments: front and transmittance-weighted depth,
  // velocity, and the depth/coverage moment pair. `attachmentsEnabled` starts
  // false, so nothing here allocates and no pass is encoded until it is turned
  // on through `setCloudReconstructionAttachments`, surfaced as
  // `CesiumDebug.cloudReconstructionAttachments(true)`. The producer writes the
  // set at the half-resolution march size, because the attachments are defined
  // at the reconstruction resolution and the full-resolution path has no
  // intermediate march target to derive them from.
  //
  // With only `attachmentsEnabled` set, the attachments are produced and never
  // read: `reconstructionEnabled` below is the separate opt-in that makes the
  // march emit and the resolve consume. The targets are the producer half of an
  // unfinished pair, not unused resources.
  attachmentsEnabled: boolean;
  attachmentTextures: (GPUTexture | null)[];
  attachmentViews: (GPUTextureView | null)[];
  attachmentGeneration: CloudAttachmentGeneration;
  attachmentPipeline: GPURenderPipeline | null;
  attachmentBindGroupLayout: GPUBindGroupLayout | null;
  attachmentBindGroup: GPUBindGroup | null;
  /**
   * The march-target view `attachmentBindGroup` was built against. Exact
   * identity, so a reallocated half-res target rebuilds the group instead of
   * silently sampling a destroyed texture.
   */
  attachmentBindGroupSourceView: GPUTextureView | null;
  attachmentUniformBuffer: GPUBuffer | null;
  attachmentUniformData: Float32Array;
  /** Reused packing record — the per-frame path must not allocate one. */
  attachmentUniformInputs: CloudAttachmentUniformInputs;
  attachmentRenderedThisFrame: boolean;
  // March-emitted reconstruction and its first consumer: a second opt-in, off by
  // default, layered on `attachmentsEnabled`. When it is set, the half-resolution
  // march compiles with `CLOUD_MARCH_EMIT_RECONSTRUCTION` and writes contract
  // slot 1, depth, as a second colour target; the producer compiles with the
  // same bit, reads that target and drops the depth slot from its own MRT; and
  // the temporal resolve compiles with `CLOUD_RECONSTRUCTION_CONSUME` and
  // validates history against the set.
  //
  // Each variant pipeline is a separate object alongside the base one —
  // `halfEmitPipeline` beside `halfPipeline`, and so on. Nothing is rebuilt,
  // invalidated or recompiled when the flag flips, so the base pipelines are the
  // same GPU objects whether or not the variants exist.
  reconstructionEnabled: boolean;
  /** Half-res march compiled with the emission bit; 2 colour targets. */
  halfEmitPipeline: GPURenderPipeline | null;
  /** Producer compiled with the emission bit; reads depth, writes 2 targets. */
  attachmentEmitPipeline: GPURenderPipeline | null;
  attachmentEmitBindGroupLayout: GPUBindGroupLayout | null;
  attachmentEmitBindGroup: GPUBindGroup | null;
  /** March-target view `attachmentEmitBindGroup` was built against. */
  attachmentEmitBindGroupSourceView: GPUTextureView | null;
  /** Depth-attachment view `attachmentEmitBindGroup` was built against. */
  attachmentEmitBindGroupDepthView: GPUTextureView | null;
  /** Temporal resolve compiled with the consumption bit. */
  temporalConsumePipeline: GPURenderPipeline | null;
  temporalConsumeBindGroupLayout: GPUBindGroupLayout | null;
  /** One consuming bind group per history READ parity, as the base path has. */
  temporalConsumeBindGroups: [GPUBindGroup | null, GPUBindGroup | null];
  /** Attachment generation the consuming bind groups were built under. */
  temporalConsumeAttachmentGeneration: number;
  /** True when the emitting march actually ran this frame. */
  reconstructionEmittedThisFrame: boolean;
  /** True when the consuming resolve actually ran this frame. */
  reconstructionConsumedThisFrame: boolean;
  // The observability surface. `observability` is reset in place at the top of
  // every execute, including the culled early return, so a skipped frame reports
  // zeros rather than the last drawn frame's numbers. `cpuStages` is disabled by
  // default so the normal path pays no clock reads and the render result cannot
  // depend on the instrumentation.
  observability: CloudFrameCounters;
  cpuStages: CloudCpuStageAccumulator;
}

/**
 * The mutable record {@link packCloudAttachmentUniforms} reads.
 *
 * The published interface is `readonly` so consumers cannot mutate the
 * contract; the cache holds this widened alias so the single per-context
 * instance can be rewritten in place every frame without allocating.
 */
type MutableCloudAttachmentUniformInputs = {
  -readonly [
    K in keyof CloudAttachmentUniformInputs
  ]: CloudAttachmentUniformInputs[K];
};

function createCloudAttachmentUniformInputs(): MutableCloudAttachmentUniformInputs {
  return {
    previousViewProjectionRelativeToEye: null,
    inverseCurrentViewProjectionRelativeToEye: null,
    encodedCameraHighX: 0.0,
    encodedCameraHighY: 0.0,
    encodedCameraHighZ: 0.0,
    encodedCameraLowX: 0.0,
    encodedCameraLowY: 0.0,
    encodedCameraLowZ: 0.0,
    cameraGeodeticHeight: 0.0,
    cameraDeltaX: 0.0,
    cameraDeltaY: 0.0,
    cameraDeltaZ: 0.0,
    depthNormalizationMeters:
      CLOUD_ATTACHMENT_DEFAULT_DEPTH_NORMALIZATION_METERS,
    width: 0,
    height: 0,
    reprojectionValid: false,
    deckBottom: 0.0,
    deckTop: 0.0,
    deckLowBottom: 0.0,
    deckLowTop: 0.0,
    deckMidBottom: 0.0,
    deckMidTop: 0.0,
    deckHighBottom: 0.0,
    deckHighTop: 0.0,
    multiDeck: false,
    generation: 0,
  };
}

function ensureCloudCache(context: CesiumGraphicsContext): CloudCache {
  if (!context._cloudCache) {
    context._cloudCache = {
      pipeline: null,
      uniformBuffer: null,
      bindGroupLayout: null,
      sampler: null,
      uniformData: new Float32Array(CLOUD_UNIFORM_FLOATS),
      mainBindGroups: [null, null],
      mainBindGroupNextSlot: 0,
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
      upscaleBindGroups: [null, null],
      upscaleBindGroupNextSlot: 0,
      frameCounter: 0,
      temporalHistory: [null, null],
      temporalHistoryView: [null, null],
      temporalWidth: 0,
      temporalHeight: 0,
      temporalRead: 0,
      temporalFirstFrame: true,
      temporalPipeline: null,
      temporalBindGroupLayout: null,
      temporalBindGroups: [null, null],
      temporalUniformBuffer: null,
      temporalUniformData: new Float32Array(TEMPORAL_UNIFORM_FLOATS),
      temporalSampler: null,
      temporalHistoryState: createCloudTemporalHistoryState(),
      temporalHistorySample: createCloudTemporalHistorySample(),
      temporalHistoryLatchedResetReasons: 0,
      temporalHistoryPendingResetReasons: 0,
      temporalHistoryGeneration: 0,
      temporalHistoryResetReasons: 0,
      temporalHistoryResetCount: 0,
      temporalHistoryAcceptedFrames: 0,
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
      shadowFrame: createCloudShadowFrame(),
      shadowCascadeFrames: [
        createCloudShadowFrame(),
        createCloudShadowFrame(),
        createCloudShadowFrame(),
      ],
      shadowActive: false,
      shadowAbsorption: 0.04,
      shadowStrength: 1.0,
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
      // Seeded with the Globe constructor defaults so a read taken before the
      // first publish still matches the visible deck.
      iblDeckBottom: 1500.0,
      iblDeckTop: 4000.0,
      iblWindX: 0.7,
      iblWindY: 0.3,
      iblWindSpeed: 15.0,
      iblTimeSeconds: 0.0,
      iblDensity: 0.3,
      iblPuffSize: 0.45,
      iblPWActive: false,
      iblContributesIbl: false,
      iblRevision: 0,
      iblRevisionAdvectionX: Number.NaN,
      iblRevisionAdvectionZ: Number.NaN,
      maskCaptureEnabled: false,
      maskTexture: null,
      maskView: null,
      maskWidth: 0,
      maskHeight: 0,
      maskPipeline: null,
      maskShaderModule: null,
      maskRenderedThisFrame: false,
      attachmentsEnabled: false,
      attachmentTextures: new Array<GPUTexture | null>(
        CLOUD_OWNED_ATTACHMENTS.length,
      ).fill(null),
      attachmentViews: new Array<GPUTextureView | null>(
        CLOUD_OWNED_ATTACHMENTS.length,
      ).fill(null),
      attachmentGeneration: createCloudAttachmentGeneration(),
      attachmentPipeline: null,
      attachmentBindGroupLayout: null,
      attachmentBindGroup: null,
      attachmentBindGroupSourceView: null,
      attachmentUniformBuffer: null,
      attachmentUniformData: new Float32Array(CLOUD_ATTACHMENT_UNIFORM_FLOATS),
      attachmentUniformInputs: createCloudAttachmentUniformInputs(),
      attachmentRenderedThisFrame: false,
      reconstructionEnabled: false,
      halfEmitPipeline: null,
      attachmentEmitPipeline: null,
      attachmentEmitBindGroupLayout: null,
      attachmentEmitBindGroup: null,
      attachmentEmitBindGroupSourceView: null,
      attachmentEmitBindGroupDepthView: null,
      temporalConsumePipeline: null,
      temporalConsumeBindGroupLayout: null,
      temporalConsumeBindGroups: [null, null],
      temporalConsumeAttachmentGeneration: 0,
      reconstructionEmittedThisFrame: false,
      reconstructionConsumedThisFrame: false,
      observability: createCloudFrameCounters(),
      cpuStages: new CloudCpuStageAccumulator(),
    };
  }
  return context._cloudCache;
}

/** Resolve the cloud march bind group from a bounded exact-identity cache. */
export function getOrCreateCloudMainBindGroup(
  device: GPUDevice,
  cache: CloudCache,
  colorView: GPUTextureView,
  depthView: GPUTextureView,
  weatherView: GPUTextureView,
  shapeView: GPUTextureView,
  detailView: GPUTextureView,
  noiseSampler: GPUSampler,
  lutViews: CloudLutViews,
): GPUBindGroup {
  const mainSampler = cache.sampler!;
  const weatherSampler = cache.weatherSampler!;
  const lutSampler = cache.lutSampler!;
  const layout = cache.bindGroupLayout!;
  const uniformBuffer = cache.uniformBuffer!;
  for (let i = 0; i < cache.mainBindGroups.length; i++) {
    const entry = cache.mainBindGroups[i];
    if (
      entry?.layout === layout &&
      entry.uniformBuffer === uniformBuffer &&
      entry.colorView === colorView &&
      entry.depthView === depthView &&
      entry.mainSampler === mainSampler &&
      entry.weatherView === weatherView &&
      entry.weatherSampler === weatherSampler &&
      entry.shapeView === shapeView &&
      entry.detailView === detailView &&
      entry.noiseSampler === noiseSampler &&
      entry.skyView === lutViews.skyView &&
      entry.multipleScatterView === lutViews.multipleScatter &&
      entry.transmittanceView === lutViews.transmittance &&
      entry.lutSampler === lutSampler
    ) {
      return entry.bindGroup;
    }
  }

  const bindGroup = device.createBindGroup({
    layout,
    entries: [
      { binding: 0, resource: colorView },
      { binding: 1, resource: depthView },
      { binding: 2, resource: mainSampler },
      { binding: 3, resource: { buffer: uniformBuffer } },
      { binding: 4, resource: weatherView },
      { binding: 5, resource: weatherSampler },
      { binding: 6, resource: shapeView },
      { binding: 7, resource: detailView },
      { binding: 8, resource: noiseSampler },
      { binding: 9, resource: lutViews.skyView },
      { binding: 10, resource: lutViews.multipleScatter },
      { binding: 11, resource: lutViews.transmittance },
      { binding: 12, resource: lutSampler },
    ],
  });
  const slot = cache.mainBindGroupNextSlot;
  cache.mainBindGroups[slot] = {
    layout,
    uniformBuffer,
    colorView,
    depthView,
    mainSampler,
    weatherView,
    weatherSampler,
    shapeView,
    detailView,
    noiseSampler,
    skyView: lutViews.skyView,
    multipleScatterView: lutViews.multipleScatter,
    transmittanceView: lutViews.transmittance,
    lutSampler,
    bindGroup,
  };
  cache.mainBindGroupNextSlot = (slot + 1) & 1;
  return bindGroup;
}

/** Resolve the temporal-upscale bind group without parity-frame churn. */
export function getOrCreateCloudUpscaleBindGroup(
  device: GPUDevice,
  cache: CloudCache,
  upscaleSourceView: GPUTextureView,
  colorView: GPUTextureView,
  depthView: GPUTextureView,
): GPUBindGroup {
  const sampler = cache.upscaleSampler!;
  const layout = cache.upscaleBindGroupLayout!;
  const uniformBuffer = cache.upscaleUniformBuffer!;
  for (let i = 0; i < cache.upscaleBindGroups.length; i++) {
    const entry = cache.upscaleBindGroups[i];
    if (
      entry?.layout === layout &&
      entry.uniformBuffer === uniformBuffer &&
      entry.upscaleSourceView === upscaleSourceView &&
      entry.colorView === colorView &&
      entry.depthView === depthView &&
      entry.sampler === sampler
    ) {
      return entry.bindGroup;
    }
  }

  const bindGroup = device.createBindGroup({
    layout,
    entries: [
      { binding: 0, resource: upscaleSourceView },
      { binding: 1, resource: colorView },
      { binding: 2, resource: depthView },
      { binding: 3, resource: sampler },
      { binding: 4, resource: { buffer: uniformBuffer } },
    ],
  });
  const slot = cache.upscaleBindGroupNextSlot;
  cache.upscaleBindGroups[slot] = {
    layout,
    uniformBuffer,
    upscaleSourceView,
    colorView,
    depthView,
    sampler,
    bindGroup,
  };
  cache.upscaleBindGroupNextSlot = (slot + 1) & 1;
  return bindGroup;
}

export function clearCloudCompositeBindGroupCaches(
  cache: Pick<
    CloudCache,
    | "mainBindGroups"
    | "mainBindGroupNextSlot"
    | "upscaleBindGroups"
    | "upscaleBindGroupNextSlot"
  >,
): void {
  cache.mainBindGroups = [null, null];
  cache.mainBindGroupNextSlot = 0;
  cache.upscaleBindGroups = [null, null];
  cache.upscaleBindGroupNextSlot = 0;
}

/**
 * Requests or releases the per-frame screen-space cloud transmittance mask. The
 * post-process god-ray pass turns this on when cloud-aware god rays are active
 * and procedural clouds are enabled; the cloud renderer then renders the
 * `fragmentCloudMaskMain` pass into a dedicated full-resolution r8unorm target
 * after the composite pass. While it is off, no mask pipeline or texture is
 * allocated and the cloud render is unaffected.
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
 * The screen-space cloud transmittance view rendered this frame, or null when
 * capture is off or no cloud pass ran, in which case the god-ray pass falls back
 * to its white 1×1 texture and applies no attenuation. `maskRenderedThisFrame`
 * is what stops a consumer reading a stale map on a frame the cloud march was
 * culled.
 */
export function getCloudTransmittanceView(
  context: CesiumGraphicsContext,
): GPUTextureView | null {
  const cache = context._cloudCache;
  if (!cache || !cache.maskRenderedThisFrame) return null;
  return cache.maskView;
}

/**
 * Requests or releases the reconstruction attachment set.
 *
 * Off by default: nothing allocates and no pass is encoded, so the cloud lane
 * is unchanged in both pixels and cost. Turning it on runs the producer and
 * populates the counters, but on its own it changes no output, because nothing
 * samples the set until {@link setCloudReconstruction} is also on.
 *
 * @param context The owning graphics context.
 * @param enabled True to allocate and produce the attachments.
 */
export function setCloudReconstructionAttachments(
  context: CesiumGraphicsContext,
  enabled: boolean,
): void {
  const cache = context._cloudCache;
  if (!cache) {
    // No cloud cache yet — stash the request on a lazily-created cache so the
    // first cloud frame honors it (the transmittance-capture convention).
    if (enabled) ensureCloudCache(context).attachmentsEnabled = true;
    return;
  }
  cache.attachmentsEnabled = enabled;
  if (!enabled) {
    cache.reconstructionEnabled = false;
    releaseCloudAttachmentResources(cache);
  }
}

/**
 * Requests or releases march-emitted reconstruction and its first consumer.
 *
 * A second opt-in layered on {@link setCloudReconstructionAttachments}, kept
 * separate so a build exists that produces the attachment set without consuming
 * it — with both behind one switch, the produced-but-unread state would not be
 * reachable and could not be tested. With this flag set:
 *
 *   - the half-resolution march compiles with
 *     `ShaderDefineHi.CLOUD_MARCH_EMIT_RECONSTRUCTION` and writes contract slot
 *     1 itself, accumulating true transmittance-weighted depth from the same
 *     weights its radiance uses rather than leaving the producer to estimate it
 *     from the resolved alpha;
 *   - the producer compiles with the same bit, reads that target, and drops the
 *     depth slot from its own MRT, since a pass cannot sample what it writes;
 *   - the temporal resolve compiles with
 *     `ShaderDefineHi.CLOUD_RECONSTRUCTION_CONSUME` and validates history
 *     against the set.
 *
 * Output can change while this is on, since it is the only configuration in
 * which anything reads the attachments; with it clear, producing the set leaves
 * the composite untouched.
 *
 * Enabling implies {@link setCloudReconstructionAttachments}: the consumer
 * cannot read a set that was never allocated.
 *
 * @param context The owning graphics context.
 * @param enabled True to compile and run the emitting and consuming variants.
 */
export function setCloudReconstruction(
  context: CesiumGraphicsContext,
  enabled: boolean,
): void {
  const cache = context._cloudCache;
  if (!cache) {
    if (enabled) {
      const created = ensureCloudCache(context);
      created.attachmentsEnabled = true;
      created.reconstructionEnabled = true;
    }
    return;
  }
  cache.reconstructionEnabled = enabled;
  if (enabled) {
    cache.attachmentsEnabled = true;
  }
}

/**
 * The attachment view for `slot`, or null when the set was not produced this
 * frame. `attachmentRenderedThisFrame` is what stops a consumer reading a stale
 * generation on a frame the cloud march was culled or the tier resolved to the
 * full-resolution path.
 *
 * @param context The owning graphics context.
 * @param slot A {@link CloudAttachmentSlot} value. Slot 0 (the shared march
 *   target) is not owned here and always returns null.
 */
export function getCloudReconstructionAttachmentView(
  context: CesiumGraphicsContext,
  slot: number,
): GPUTextureView | null {
  const cache = context._cloudCache;
  if (!cache || !cache.attachmentRenderedThisFrame) return null;
  const index = slot - 1;
  if (index < 0 || index >= cache.attachmentViews.length) return null;
  return cache.attachmentViews[index];
}

/**
 * The generation the resident attachment set was built under, or 0 when nothing
 * is resident. Monotonic across resize and device swap, so a retained bind group
 * captured under an earlier generation is recognisable as stale rather than
 * being served.
 *
 * @param context The owning graphics context.
 */
export function getCloudReconstructionAttachmentGeneration(
  context: CesiumGraphicsContext,
): number {
  return context._cloudCache?.attachmentGeneration.generation ?? 0;
}

/**
 * Resolve scene-clock seconds relative to this context's first cloud frame.
 * The subtraction happens in CPU f64 before any f32 uniform store, keeping wind
 * advection stable while ensuring the visible and IBL cloud consumers share the
 * same time coordinate.
 */
function resolveCloudTimeSeconds(
  cache: CloudCache,
  frameState: CesiumFrameState | undefined,
): number {
  const jd = frameState?.time as unknown as
    { dayNumber: number; secondsOfDay: number } | undefined;
  if (
    jd &&
    typeof jd.dayNumber === "number" &&
    typeof jd.secondsOfDay === "number"
  ) {
    const seconds = jd.dayNumber * 86400.0 + jd.secondsOfDay;
    if (cache.timeEpoch === null) {
      cache.timeEpoch = seconds;
    }
    return seconds - cache.timeEpoch;
  }
  return performance.now() / 1000.0;
}

// Debounce grid for the environment-cube refill. The env-cube cloud march is
// expensive — a full cube fill, an image-based-lighting prefilter and an SH-L2
// projection — and `publishCloudIblCoverage` runs every frame, edge-triggering
// that refill through `iblRevision`. Comparing the raw continuous inputs with
// `!==` would bump the revision on any float wobble, so an application animating
// coverage, density or wind refills the whole cube every frame. Each continuous
// input is therefore snapped to a per-input quantization grid and the snapped
// values are compared: sub-step jitter is inert, while a genuine drift still
// crosses a grid boundary and refills, which a per-frame delta test would miss
// because snapping accumulates. Discrete inputs — the enable flags, the
// Perlin-Worley morphology switch, a tier change that moves a parameter past its
// step — bump immediately. The snapped values are also what the manager binds:
// the deviation from the exact input is at most half a step, which the
// low-resolution prefilter and SH projection cannot resolve.
const IBL_REVISION_UNIT_STEP = 1.0 / 256.0; // coverage / density / puff (∈ [0,1])
const IBL_REVISION_WIND_DIR_STEP = 1.0 / 256.0; // wind-direction components
const IBL_REVISION_WIND_SPEED_STEP_MPS = 0.05; // wind speed (m/s)
const IBL_REVISION_DECK_STEP_M = 1.0; // deck bottom / top altitude (m)

function quantizeCloudIblInput(value: number, step: number): number {
  return Math.round(value / step) * step;
}

/**
 * Publishes the effective cloud coverage the dynamic environment map's sky fill
 * uses to darken and flatten its radiance. Called every frame from the
 * environmental-effects dispatch rather than from the cullable raymarch, so
 * turning `showProceduralClouds` or `cloudContributesIBL` off resets the
 * published coverage to 0 on that frame and the fill's overcast blend is
 * skipped.
 *
 * The coverage is a coarse global scalar: cloud coverage modulated by a mild
 * density term, since a thin high-coverage haze dims and flattens less than a
 * dense deck. It is not a per-face raymarch. It is 0 unless both
 * `showProceduralClouds` and `cloudContributesIBL` are true.
 *
 * Also publishes deck altitude, wind direction and speed, density and the
 * Perlin-Worley-shape state onto the cloud cache, so the environment map
 * manager's per-face march reads live cloud customization; `scene.globe` is in
 * scope here and is not a `FrameState` field. Those fields are inert while
 * reflections are off, because the manager gates its march on
 * `cloudsInReflections` and a coverage above 0, and they always reflect the
 * current globe so a customization reaches the reflected deck on the same frame
 * it reaches the visible one.
 */
export function publishCloudIblCoverage(
  context: CesiumGraphicsContext,
  config: CloudVolumetricsConfig | undefined,
  frameState?: CesiumFrameState,
): void {
  const cache = ensureCloudCache(context);
  const deckBottom = config?.cloudLayerBottom ?? 1500.0;
  const deckTop = config?.cloudLayerTop ?? 4000.0;
  const windX = config?.cloudWindDirection?.x ?? 0.7;
  const windY = config?.cloudWindDirection?.y ?? 0.3;
  const windSpeed = config?.cloudWindSpeed ?? 15.0;
  const density = config?.cloudDensity ?? 0.3;
  const puffSize = config?.cloudPuffSize ?? 0.45;
  const pwActive = config?.cloudNoiseMorphology === "perlin-worley";
  const cloudsVisible = config?.showProceduralClouds === true;
  const contributesIbl = cloudsVisible && config?.cloudContributesIBL === true;
  // Do not establish the scene-time epoch while clouds are disabled. The first
  // visible cloud frame remains time zero, matching the documented contract.
  const cloudTimeSeconds = cloudsVisible
    ? resolveCloudTimeSeconds(cache, frameState)
    : 0.0;
  const coverage = contributesIbl
    ? clampUnit(config?.cloudCoverage ?? 0.5)
    : 0.0;
  const densityWeight = 0.7 + 0.3 * clampUnit(density);
  const effectiveCoverage = contributesIbl
    ? clampUnit(coverage * densityWeight)
    : 0.0;

  // Snap the continuous inputs to their per-input debounce grid. The snapped
  // values are both what is published and what is compared, so sub-step jitter
  // neither bumps `iblRevision` nor perturbs the bound reflection, while a
  // genuine drift crosses a grid step and refills.
  const quantDeckBottom = quantizeCloudIblInput(
    deckBottom,
    IBL_REVISION_DECK_STEP_M,
  );
  const quantDeckTop = quantizeCloudIblInput(deckTop, IBL_REVISION_DECK_STEP_M);
  const quantWindX = quantizeCloudIblInput(windX, IBL_REVISION_WIND_DIR_STEP);
  const quantWindY = quantizeCloudIblInput(windY, IBL_REVISION_WIND_DIR_STEP);
  const quantWindSpeed = quantizeCloudIblInput(
    windSpeed,
    IBL_REVISION_WIND_SPEED_STEP_MPS,
  );
  const quantDensity = quantizeCloudIblInput(density, IBL_REVISION_UNIT_STEP);
  const quantPuffSize = quantizeCloudIblInput(puffSize, IBL_REVISION_UNIT_STEP);
  const quantCoverage = quantizeCloudIblInput(
    effectiveCoverage,
    IBL_REVISION_UNIT_STEP,
  );

  // Bump the revision immediately for a discrete change — the enable flag, which
  // is compared exactly so a toggle refreshes even below the coverage step, and
  // the base-shape morphology — and for any continuous input whose snapped value
  // crossed a grid step. Pure wind advection is debounced separately below: it
  // displaces the field without changing any of these snapped appearance inputs,
  // so a fixed-sun scene still re-darkens reflected clouds as they drift.
  const staticStateChanged =
    cache.iblContributesIbl !== contributesIbl ||
    cache.iblPWActive !== pwActive ||
    cache.iblDeckBottom !== quantDeckBottom ||
    cache.iblDeckTop !== quantDeckTop ||
    cache.iblWindX !== quantWindX ||
    cache.iblWindY !== quantWindY ||
    cache.iblWindSpeed !== quantWindSpeed ||
    cache.iblDensity !== quantDensity ||
    cache.iblPuffSize !== quantPuffSize ||
    cache.iblCoverage !== quantCoverage;
  // Advection uses the snapped wind (the same values the manager binds) so the
  // 64 m displacement debounce tracks the reflected field's actual motion.
  const advectionMeters = quantWindSpeed * cloudTimeSeconds;
  const advectionX = quantWindX * advectionMeters;
  const advectionZ = quantWindY * advectionMeters;
  const advectionDeltaX = advectionX - cache.iblRevisionAdvectionX;
  const advectionDeltaZ = advectionZ - cache.iblRevisionAdvectionZ;
  const advectionMoved =
    contributesIbl &&
    !(
      advectionDeltaX * advectionDeltaX + advectionDeltaZ * advectionDeltaZ <
      64.0 * 64.0
    );

  // Item 3-C — publish the real (snapped) march params unconditionally (so a
  // clear-flag toggle never leaves a stale deck). These match the constructor
  // defaults, which already lie on their grids.
  cache.iblDeckBottom = quantDeckBottom;
  cache.iblDeckTop = quantDeckTop;
  cache.iblWindX = quantWindX;
  cache.iblWindY = quantWindY;
  cache.iblWindSpeed = quantWindSpeed;
  cache.iblTimeSeconds = cloudTimeSeconds;
  cache.iblDensity = quantDensity;
  cache.iblPuffSize = quantPuffSize;
  // Mirror the visible renderer's Perlin-Worley selection so the reflection
  // march binds the same base shape view the visible deck samples.
  cache.iblPWActive = pwActive;
  cache.iblCoverage = quantCoverage;
  cache.iblContributesIbl = contributesIbl;

  if (staticStateChanged || advectionMoved) {
    cache.iblRevision++;
    if (contributesIbl) {
      cache.iblRevisionAdvectionX = advectionX;
      cache.iblRevisionAdvectionZ = advectionZ;
    } else {
      // Re-enabling must establish a fresh advection baseline and refill.
      cache.iblRevisionAdvectionX = Number.NaN;
      cache.iblRevisionAdvectionZ = Number.NaN;
    }
  }
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

// `CloudShadowUniforms` is `sunViewInvVpRelativeToEye` (16 floats) plus
// `sunDirAndSteps` (4), so 20 floats. The matrix is eye-relative.
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

// Constants for the opt-in cascaded shadow atlas. Three cascades on a geometric
// CSM-style split by thirds: the far cascade matches the single-map footprint of
// ±60 km, and the mid and near cascades tighten to ±20 km and ±6.67 km, so the
// finest cascade packs the same 512² over nine times less ground and roughly
// triples the effective shadow resolution near the camera. Uniform-buffer
// offsets must be 256-aligned, so each cascade's 20-float `CloudShadowUniforms`
// is padded to a 64-float stride.
const CLOUD_SHADOW_CASCADE_COUNT = 3;
const CLOUD_SHADOW_CASCADE_STRIDE_FLOATS = 64; // 256 bytes (uniform offset align)
const CLOUD_SHADOW_CASCADE_STRIDE_BYTES =
  CLOUD_SHADOW_CASCADE_STRIDE_FLOATS * 4;
// Per-cascade footprint half-extent in metres: near, mid, far. The far cascade
// equals the single map and each step divides by three.
const CLOUD_SHADOW_CASCADE_FOOTPRINTS_M = [
  CLOUD_SHADOW_FOOTPRINT_M / 9.0,
  CLOUD_SHADOW_FOOTPRINT_M / 3.0,
  CLOUD_SHADOW_FOOTPRINT_M,
];
// Per-cascade light-march steps — full for the crisp near cascade, fewer for the
// cheaper far cascades (they cover coarse coverage where step count barely reads).
const CLOUD_SHADOW_CASCADE_STEPS = [CLOUD_SHADOW_LIGHT_STEPS, 12, 8];

// Half-resolution target format. rgba16float so the premultiplied HDR cloud
// radiance survives the bilateral interpolation without banding.
const CLOUD_HALF_FORMAT: GPUTextureFormat = "rgba16float";
// `UpscaleUniforms` float count; has to equal the struct length in
// `CloudUpscale.wgsl`.
const UPSCALE_UNIFORM_FLOATS = 16;
const UPSCALE_UNIFORM_BYTES = UPSCALE_UNIFORM_FLOATS * 4;
// Bilateral depth-similarity falloff, expressed in the renderer-wide nonlinear
// log depth space over [0, 1] rather than in metres. Small enough that a
// cloud/terrain edge rejects the far-side taps and keeps a crisp silhouette, but
// not so small that cloud interiors over a smooth depth gradient lose all four
// taps.
const CLOUD_UPSCALE_DEPTH_SIGMA = 5.0e-3;
// The history accumulates the half-resolution buffer, so its format has to match
// that target exactly.
const CLOUD_TEMPORAL_FORMAT: GPUTextureFormat = CLOUD_HALF_FORMAT;
// `TemporalUniforms` float count; has to equal the struct length in
// `CloudTemporalResolve.wgsl`: `previousVpRte` (16) plus `inverseCurrentVpRte`
// (16) plus seven vec4 rows carrying encoded camera, f64 camera delta, deck
// topology, resolution, validity and diagnostics, so 60. That stays inside
// WebGPU's 256-byte minimum uniform-buffer alignment without growing the
// allocation.
const TEMPORAL_UNIFORM_FLOATS = 60;
const TEMPORAL_UNIFORM_BYTES = TEMPORAL_UNIFORM_FLOATS * 4;

function markCloudTemporalInactive(cache: CloudCache): void {
  if (
    !cache.temporalHistoryState.temporalActive &&
    !cache.temporalHistorySample.temporalActive
  ) {
    return;
  }
  cache.temporalHistorySample.temporalActive = false;
  commitCloudTemporalHistoryState(
    cache.temporalHistoryState,
    cache.temporalHistorySample,
    false,
  );
  // Reactivation is a new discontinuity even if the prior active frame was
  // itself invalid (for example, the user toggles tiers during a morph).
  cache.temporalHistoryLatchedResetReasons = 0;
}

/**
 * Allocates or reallocates the ping-pong half-resolution history targets and the
 * reproject, clamp and blend resolve pipeline. Called only while a temporal tier
 * is active; the cinematic tier and the escape hatch keep temporal off, so none
 * of this allocates there. The history pair is sized to the half-resolution
 * target, since it accumulates the premultiplied half-resolution cloud, and is
 * recreated on resize. On reallocation the first-frame flag is reset so the next
 * resolve seeds identity history and no flash is visible. Returns false when
 * anything cannot be built, and the caller then falls back to plain
 * half-resolution.
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
    cache.temporalBindGroups = [null, null];
    // The consuming groups reference the same history views.
    cache.temporalConsumeBindGroups = [null, null];
    cache.temporalConsumeAttachmentGeneration = 0;
    // History contents are undefined after (re)allocation — seed identity next frame.
    cache.temporalFirstFrame = true;
    cache.temporalHistoryPendingResetReasons |= CLOUD_TEMPORAL_RESET_RESOURCE;
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
      // The source carries preprocessor blocks, so its raw text is both
      // branches concatenated and is not valid WGSL — it redeclares
      // `previousUv`. Preprocessing with no defines emits the else branch.
      code: preprocess(CloudTemporalResolveWGSL, 0, 0),
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

  if (
    cache.halfView &&
    cache.temporalBindGroupLayout &&
    cache.temporalUniformBuffer &&
    cache.temporalSampler &&
    cache.temporalHistoryView[0] &&
    cache.temporalHistoryView[1] &&
    (!cache.temporalBindGroups[0] || !cache.temporalBindGroups[1])
  ) {
    for (let readIndex = 0; readIndex < 2; readIndex++) {
      cache.temporalBindGroups[readIndex] = device.createBindGroup({
        label: `CloudTemporalResolve bind group (read ${readIndex})`,
        layout: cache.temporalBindGroupLayout,
        entries: [
          { binding: 0, resource: cache.halfView },
          {
            binding: 1,
            resource: cache.temporalHistoryView[readIndex]!,
          },
          { binding: 2, resource: cache.temporalSampler },
          { binding: 3, resource: { buffer: cache.temporalUniformBuffer } },
        ],
      });
    }
  }

  // The consuming resolve, built alongside the base pipeline rather than
  // replacing it. Its extra bindings are the attachment set; the base bind group
  // cannot be reused because a bind-group layout is part of a pipeline's
  // identity.
  if (cache.reconstructionEnabled && !cache.temporalConsumePipeline) {
    cache.temporalConsumeBindGroupLayout = makeBindGroupLayout(
      device,
      "CloudTemporalResolve consume BGL",
      [
        texture(0, Stage.FRAGMENT), // current freshly-marched half-res cloud
        texture(1, Stage.FRAGMENT), // previous accumulated history
        sampler(2, Stage.FRAGMENT),
        uniformBuffer(3, Stage.FRAGMENT),
        texture(4, Stage.FRAGMENT), // contract slot 1 — depth
        texture(5, Stage.FRAGMENT), // contract slot 2 — velocity
        texture(6, Stage.FRAGMENT), // contract slot 3 — moments
      ],
    );
    const consumeModule = device.createShaderModule({
      label: `CloudTemporalResolve shader (consume, definesHi=0x${CLOUD_RECONSTRUCTION_CONSUME_DEFINES_HI.toString(16)})`,
      code: preprocess(
        CloudTemporalResolveWGSL,
        0,
        CLOUD_RECONSTRUCTION_CONSUME_DEFINES_HI,
      ),
    });
    cache.temporalConsumePipeline = device.createRenderPipeline({
      label: "CloudTemporalResolve pipeline (consume)",
      layout: device.createPipelineLayout({
        label: "CloudTemporalResolve consume pipeline layout",
        bindGroupLayouts: [cache.temporalConsumeBindGroupLayout],
      }),
      vertex: { module: consumeModule, entryPoint: "vertexMain" },
      fragment: {
        module: consumeModule,
        entryPoint: "fragmentMain",
        targets: [{ format: CLOUD_TEMPORAL_FORMAT }],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  return (
    !!cache.temporalHistoryView[0] &&
    !!cache.temporalHistoryView[1] &&
    !!cache.temporalPipeline &&
    !!cache.temporalBindGroups[0] &&
    !!cache.temporalBindGroups[1]
  );
}

/**
 * Rebuilds the consuming resolve's bind groups and reports whether this frame
 * may use them.
 *
 * Called from the composite block after the producer has run, not from
 * `ensureTemporalResources`: the attachment textures do not exist when the
 * temporal gate is resolved, so building the groups there would leave the first
 * enabled frame silently on the non-consuming path.
 *
 * The groups are keyed on the attachment generation rather than on merely being
 * non-null. A resize or a device swap advances that counter and reallocates the
 * three textures the groups reference, and the counter is monotonic —
 * `releaseCloudAttachmentGeneration` never rewinds it — so a group captured
 * under one generation can never key as current under a later one.
 */
function ensureCloudTemporalConsumeBindGroups(
  device: GPUDevice,
  cache: CloudCache,
): boolean {
  const generation = cache.attachmentGeneration.generation;
  if (
    !cache.reconstructionEnabled ||
    !cache.temporalConsumePipeline ||
    !cache.temporalConsumeBindGroupLayout ||
    !cache.halfView ||
    !cache.temporalUniformBuffer ||
    !cache.temporalSampler ||
    !cache.temporalHistoryView[0] ||
    !cache.temporalHistoryView[1] ||
    generation <= 0 ||
    !cache.attachmentViews[0] ||
    !cache.attachmentViews[1] ||
    !cache.attachmentViews[2]
  ) {
    return false;
  }
  if (
    !cache.temporalConsumeBindGroups[0] ||
    !cache.temporalConsumeBindGroups[1] ||
    cache.temporalConsumeAttachmentGeneration !== generation
  ) {
    for (let readIndex = 0; readIndex < 2; readIndex++) {
      cache.temporalConsumeBindGroups[readIndex] = device.createBindGroup({
        label: `CloudTemporalResolve bind group (consume, read ${readIndex})`,
        layout: cache.temporalConsumeBindGroupLayout,
        entries: [
          { binding: 0, resource: cache.halfView },
          { binding: 1, resource: cache.temporalHistoryView[readIndex]! },
          { binding: 2, resource: cache.temporalSampler },
          { binding: 3, resource: { buffer: cache.temporalUniformBuffer } },
          { binding: 4, resource: cache.attachmentViews[0]! },
          { binding: 5, resource: cache.attachmentViews[1]! },
          { binding: 6, resource: cache.attachmentViews[2]! },
        ],
      });
    }
    cache.temporalConsumeAttachmentGeneration = generation;
  }
  return (
    !!cache.temporalConsumeBindGroups[0] && !!cache.temporalConsumeBindGroups[1]
  );
}

/**
 * Releases the owned reconstruction attachments without rewinding the generation
 * counter.
 *
 * Rewinding would let a retired bind group's key collide with a future one. The
 * pipeline, layout and uniform buffer are independent of both size and device,
 * so they survive a resize; only a device teardown through
 * `destroyProceduralCloudResources` drops them.
 */
function releaseCloudAttachmentResources(cache: CloudCache): void {
  for (let i = 0; i < cache.attachmentTextures.length; i++) {
    cache.attachmentTextures[i]?.destroy();
    cache.attachmentTextures[i] = null;
    cache.attachmentViews[i] = null;
  }
  cache.attachmentBindGroup = null;
  cache.attachmentBindGroupSourceView = null;
  cache.attachmentRenderedThisFrame = false;
  // The emitting group and both consuming groups reference textures that were
  // just destroyed. Dropping them here rather than relying on the generation
  // check is what keeps a resize from submitting a bind group whose depth
  // attachment no longer exists.
  cache.attachmentEmitBindGroup = null;
  cache.attachmentEmitBindGroupSourceView = null;
  cache.attachmentEmitBindGroupDepthView = null;
  cache.temporalConsumeBindGroups = [null, null];
  cache.temporalConsumeAttachmentGeneration = 0;
  cache.reconstructionEmittedThisFrame = false;
  cache.reconstructionConsumedThisFrame = false;
  releaseCloudAttachmentGeneration(cache.attachmentGeneration);
}

/**
 * Allocates or reallocates the owned reconstruction attachments and the producer
 * pipeline, and rebuilds the one bind group that reads the current march target.
 *
 * Three cases advance the set:
 *
 *   Creation — the first enabled frame. The generation goes from 0 to 1 and the
 *     live-byte figure the debug surface reports becomes non-zero.
 *   Resize — the half-resolution target changed size, through a canvas resize or
 *     a tier that resolved a different `renderResScale`. Every owned texture is
 *     destroyed and recreated and the generation advances, because the previous
 *     contents describe a different pixel grid and a consumer must not blend
 *     across it.
 *   Device swap — the `deviceKey` identity differs. Textures created on a lost
 *     device are unusable even at an unchanged size, so the comparison is on
 *     identity rather than size. The teardown path additionally drops the
 *     pipeline.
 *
 * `sourceView` is the freshly marched half-resolution target: the bind group is
 * rebuilt whenever that view is reallocated, which the identity check against
 * `attachmentBindGroupSourceView` detects.
 *
 * @returns True when a producer pass can be encoded this frame.
 */
function ensureCloudAttachmentResources(
  device: GPUDevice,
  cache: CloudCache,
  width: number,
  height: number,
  sourceView: GPUTextureView,
): boolean {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));

  if (
    cloudAttachmentsNeedAllocation(cache.attachmentGeneration, w, h, device)
  ) {
    for (let i = 0; i < CLOUD_OWNED_ATTACHMENTS.length; i++) {
      const spec = CLOUD_OWNED_ATTACHMENTS[i];
      cache.attachmentTextures[i]?.destroy();
      const attachmentTexture = device.createTexture({
        label: `ProceduralClouds Reconstruction ${spec.key}`,
        size: { width: w, height: h, depthOrArrayLayers: 1 },
        format: spec.format,
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      cache.attachmentTextures[i] = attachmentTexture;
      cache.attachmentViews[i] = attachmentTexture.createView();
    }
    // Committed only after every owned texture exists, so a partially built set
    // never advertises itself as a complete generation.
    commitCloudAttachmentGeneration(cache.attachmentGeneration, w, h, device);
    cache.attachmentBindGroup = null;
  }

  if (!cache.attachmentPipeline) {
    cache.attachmentBindGroupLayout = makeBindGroupLayout(
      device,
      "CloudReconstructionAttachments BGL",
      [
        texture(0, Stage.FRAGMENT), // freshly marched half-res cloud
        uniformBuffer(1, Stage.FRAGMENT),
      ],
    );
    const attachmentModule = device.createShaderModule({
      label: "CloudReconstructionAttachments shader",
      // The source carries preprocessor blocks, so its raw text is not valid
      // WGSL; preprocessing with no defines emits the estimating branch.
      code: preprocess(CloudReconstructionAttachmentsWGSL, 0, 0),
    });
    cache.attachmentPipeline = device.createRenderPipeline({
      label: "CloudReconstructionAttachments pipeline",
      layout: device.createPipelineLayout({
        label: "CloudReconstructionAttachments pipeline layout",
        bindGroupLayouts: [cache.attachmentBindGroupLayout],
      }),
      vertex: { module: attachmentModule, entryPoint: "vertexMain" },
      fragment: {
        module: attachmentModule,
        entryPoint: "fragmentMain",
        targets: CLOUD_OWNED_ATTACHMENTS.map((spec) => ({
          format: spec.format,
        })),
      },
      primitive: { topology: "triangle-list" },
    });
    cache.attachmentUniformBuffer = device.createBuffer({
      label: "CloudReconstructionAttachments UB",
      size: Math.max(CLOUD_ATTACHMENT_UNIFORM_BYTES, 256),
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  if (
    cache.attachmentBindGroupLayout &&
    cache.attachmentUniformBuffer &&
    (!cache.attachmentBindGroup ||
      cache.attachmentBindGroupSourceView !== sourceView)
  ) {
    cache.attachmentBindGroup = device.createBindGroup({
      label: "CloudReconstructionAttachments bind group",
      layout: cache.attachmentBindGroupLayout,
      entries: [
        { binding: 0, resource: sourceView },
        { binding: 1, resource: { buffer: cache.attachmentUniformBuffer } },
      ],
    });
    cache.attachmentBindGroupSourceView = sourceView;
  }

  // The emitting producer, built beside the estimating one rather than in place
  // of it, so clearing the flag returns to exactly the estimating pipeline.
  // Binding 2 is the depth attachment the march wrote this frame, so the pass
  // writes only the remaining two targets: sampling an attachment it also writes
  // is not expressible in a single render pass, and duplicating the target to
  // make it expressible would cost 8 bytes per texel for the copy.
  if (cache.reconstructionEnabled && !cache.attachmentEmitPipeline) {
    cache.attachmentEmitBindGroupLayout = makeBindGroupLayout(
      device,
      "CloudReconstructionAttachments emit BGL",
      [
        texture(0, Stage.FRAGMENT), // freshly marched half-res cloud
        uniformBuffer(1, Stage.FRAGMENT),
        texture(2, Stage.FRAGMENT), // contract slot 1, written by the march
      ],
    );
    const emitModule = device.createShaderModule({
      label: `CloudReconstructionAttachments shader (emit, definesHi=0x${CLOUD_MARCH_EMIT_DEFINES_HI.toString(16)})`,
      code: preprocess(
        CloudReconstructionAttachmentsWGSL,
        0,
        CLOUD_MARCH_EMIT_DEFINES_HI,
      ),
    });
    cache.attachmentEmitPipeline = device.createRenderPipeline({
      label: "CloudReconstructionAttachments pipeline (emit)",
      layout: device.createPipelineLayout({
        label: "CloudReconstructionAttachments emit pipeline layout",
        bindGroupLayouts: [cache.attachmentEmitBindGroupLayout],
      }),
      vertex: { module: emitModule, entryPoint: "vertexMain" },
      fragment: {
        module: emitModule,
        entryPoint: "fragmentMain",
        targets: CLOUD_EMITTED_ATTACHMENTS.map((spec) => ({
          format: spec.format,
        })),
      },
      primitive: { topology: "triangle-list" },
    });
  }

  const emittedDepthView = cache.attachmentViews[CLOUD_MARCH_EMITTED_SLOT - 1];
  if (
    cache.reconstructionEnabled &&
    cache.attachmentEmitBindGroupLayout &&
    cache.attachmentUniformBuffer &&
    emittedDepthView &&
    (!cache.attachmentEmitBindGroup ||
      cache.attachmentEmitBindGroupSourceView !== sourceView ||
      cache.attachmentEmitBindGroupDepthView !== emittedDepthView)
  ) {
    cache.attachmentEmitBindGroup = device.createBindGroup({
      label: "CloudReconstructionAttachments bind group (emit)",
      layout: cache.attachmentEmitBindGroupLayout,
      entries: [
        { binding: 0, resource: sourceView },
        { binding: 1, resource: { buffer: cache.attachmentUniformBuffer } },
        { binding: 2, resource: emittedDepthView },
      ],
    });
    cache.attachmentEmitBindGroupSourceView = sourceView;
    cache.attachmentEmitBindGroupDepthView = emittedDepthView;
  }

  if (!cache.attachmentPipeline || !cache.attachmentBindGroup) {
    return false;
  }
  for (let i = 0; i < cache.attachmentViews.length; i++) {
    if (!cache.attachmentViews[i]) {
      return false;
    }
  }
  return true;
}

/**
 * True when the emitting and consuming variant is fully built and usable this
 * frame.
 *
 * Both halves of the handshake are required together: a march that emits into a
 * depth target no producer reads leaves the attachment stale, and a producer
 * compiled for the emitting layout cannot run against a march that did not write
 * slot 1. Anything missing falls the whole frame back to the estimator path,
 * which is always correct, rather than to a half-applied variant.
 */
function cloudReconstructionVariantReady(cache: CloudCache): boolean {
  return (
    cache.reconstructionEnabled &&
    !!cache.halfEmitPipeline &&
    !!cache.attachmentEmitPipeline &&
    !!cache.attachmentEmitBindGroup &&
    !!cache.attachmentViews[CLOUD_MARCH_EMITTED_SLOT - 1]
  );
}

/**
 * Allocates or reallocates the half-resolution cloud target at
 * `floor(w·scale) × floor(h·scale)`, recreating it on canvas resize. A null
 * device or a zero size is a no-op and the caller falls back to full resolution.
 * The half-resolution pipeline and the upscale pipeline, bind-group layout,
 * uniform buffer and sampler are built once, lazily.
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
      // The source carries preprocessor blocks, so its raw text is not valid
      // WGSL; preprocessing with no defines emits the non-emitting march.
      code: preprocess(PROCEDURAL_CLOUDS_SOURCE, 0, 0),
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

  // The emitting half-resolution march: a separate pipeline from a separate
  // module, built beside the non-emitting one rather than replacing it, so a
  // runtime flip never invalidates or recompiles the base pipeline. It is the
  // only pipeline in this renderer compiled with the emission bit — the
  // full-resolution march, the Beer shadow map, the cascade atlas and the
  // god-ray mask all keep compiling `PROCEDURAL_CLOUDS_SOURCE` at
  // `definesHi = 0`, which is what holds their register footprint down.
  if (
    cache.reconstructionEnabled &&
    !cache.halfEmitPipeline &&
    cache.bindGroupLayout
  ) {
    const emitModule = device.createShaderModule({
      label: `ProceduralClouds shader (half-res, emit, definesHi=0x${CLOUD_MARCH_EMIT_DEFINES_HI.toString(16)})`,
      code: preprocess(
        PROCEDURAL_CLOUDS_SOURCE,
        0,
        CLOUD_MARCH_EMIT_DEFINES_HI,
      ),
    });
    cache.halfEmitPipeline = device.createRenderPipeline({
      label: "ProceduralClouds half-res pipeline (emit)",
      layout: device.createPipelineLayout({
        label: "ProceduralClouds half-res emit pipeline layout",
        bindGroupLayouts: [cache.bindGroupLayout],
      }),
      vertex: { module: emitModule, entryPoint: "vertexMain" },
      fragment: {
        module: emitModule,
        entryPoint: "fragmentMain",
        // @location(0) is the colour target; @location(1) is contract slot 1,
        // whose format comes from the contract table so the pipeline and the
        // texture cannot disagree.
        targets: [
          { format: CLOUD_HALF_FORMAT },
          { format: CLOUD_MARCH_EMITTED_FORMAT },
        ],
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

// Returns the weather texture view to bind this frame, building the procedural
// map once when enabled and a 1×1 white fallback otherwise, so the bind group
// always has a valid 2d-array texture at binding 4. The default global map lives
// in `Scene/Weather/ProceduralWeatherMap.ts` so that it and the real-data packer
// share one seam and pole convention.
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
  // Real data from a `WeatherProvider` wins and is re-uploaded only when its
  // version changes; otherwise the procedural map is used, uploaded once under
  // sentinel -1. Switching back from provider to procedural re-uploads the
  // procedural fill.
  //
  // A cache hit is a frame on which the resident version already matched the
  // requested one, so no upload was encoded; a miss is a frame that had to
  // re-upload. `weatherLiveBytes` describes the resident texture and therefore
  // survives the per-frame counter reset.
  const counters = cache.observability;
  const weatherBytes = WEATHER_TEX_W * WEATHER_TEX_H * 4;
  counters.weatherLiveBytes = weatherBytes;
  const wantedVersion = providerBytes !== null ? providerVersion : -1;
  if (cache.weatherProviderVersion === wantedVersion) {
    counters.weatherCacheHits++;
  } else {
    counters.weatherCacheMisses++;
    counters.weatherUploads++;
    counters.weatherUploadBytes += weatherBytes;
  }

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

// Returns the three atmosphere LUT views to bind at 9, 10 and 11 this frame. The
// 1×1 black placeholder is built lazily and bound when either mode is off or the
// atmosphere LUTs have not been allocated; when at least one mode is on and the
// performance manager holds the LUT resources, the real sky-view,
// multiple-scattering and transmittance views are bound. The shader gates each
// sample on its mode bit and a non-zero radiance, so a real but unbaked LUT —
// all-zero textures before SkyAtmosphere dispatches the bake — falls back to the
// heuristic constant path on its own, the same way the globe's fog drape lets
// the shader's luminance test decide.
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
    // A 1×1 black rgba16float, which is eight zero bytes. Black means no
    // radiance, which is also the unbaked-LUT sentinel, so binding the
    // placeholder is safe even with a mode bit set: the shader's luminance test
    // fails and the analytic branch runs.
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

// Bakes the shape and detail noise textures once and returns the views to bind
// at 6, 7 and 8. The bind-group layout declares 3D textures at those bindings,
// so valid views are always required; a 1×1×1 white 3D fallback keeps the bind
// group valid when the bake is unavailable, and the shader then marches live
// noise instead.
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
  // Bake when nothing is baked yet, or when the Perlin-Worley variant is
  // requested for the first time and the initial bake was value-noise only. The
  // value `shapeTexture` bakes identically either way, so adding the
  // Perlin-Worley variant does not change the value-noise output. The upgrade
  // destroys the prior resources and rebakes, which is affordable because the
  // flag is effectively one-shot.
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
    // The source carries preprocessor blocks, so its raw text is not valid
    // WGSL; preprocessing with no defines emits the non-emitting march.
    code: preprocess(PROCEDURAL_CLOUDS_SOURCE, 0, 0),
  });
  // Retained so the lazily built transmittance-mask pipeline can reuse the same
  // module and bind-group layout without recompiling the shader.
  cache.maskShaderModule = shaderModule;

  cache.bindGroupLayout = makeBindGroupLayout(device, "ProceduralClouds BGL", [
    texture(0, Stage.FRAGMENT),
    texture(1, Stage.FRAGMENT),
    sampler(2, Stage.FRAGMENT),
    uniformBuffer(3, Stage.FRAGMENT),
    // Weather map, a depth-1 2d-array, and its sampler.
    texture(4, Stage.FRAGMENT, { viewDimension: "2d-array" }),
    sampler(5, Stage.FRAGMENT),
    // Baked 3D shape and detail noise, and their sampler.
    texture(6, Stage.FRAGMENT, { viewDimension: "3d" }),
    texture(7, Stage.FRAGMENT, { viewDimension: "3d" }),
    sampler(8, Stage.FRAGMENT),
    // Atmosphere LUTs — sky-view, multiple-scattering, transmittance — and a
    // linear sampler. Declared unconditionally, with 1×1 black placeholders when
    // off or unbaked, so the layout never forks; the shader gates the samples on
    // the mode bits.
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

  // The weather map is a global equirectangular image, so it wraps in longitude
  // and clamps at the poles.
  cache.weatherSampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
    addressModeU: "repeat",
    addressModeV: "clamp-to-edge",
  });

  // Linear clamp sampler for the atmosphere LUTs, matching SkyAtmosphere's
  // `lutSampler` and AerialPerspective's `texSampler` conventions so the cloud
  // air-light and ambient terms sample the LUTs identically to the visible sky.
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
 * Inputs to the quality-dial resolver, which maps the
 * `clouds.volumetricQuality` preset string to a `(maxSteps, lightSteps)` pair.
 *
 * Preset table:
 *   low    — (24, 3)  mobile and power-saving
 *   medium — (48, 4)  default desktop
 *   high   — (96, 8)  cinematic
 *   auto   — altitude-driven
 *
 * In auto mode an altitude at or below `enableAltitude` resolves to high, an
 * altitude at or above `disableAltitude` resolves to low, and anything between
 * resolves to medium. The transition is a single step rather than a per-pixel
 * blend, and hysteresis is applied by the caller through the stickiness of the
 * globe fields, because changing the sample count every frame shimmers at the
 * transition.
 *
 * A `cloudQuality` set to anything other than the default of 64 is returned
 * verbatim and the preset is ignored, so hand-tuned step counts are not
 * overridden by the preset enum.
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
  // A hand-set step count overrides the preset.
  const raw = inputs.rawCloudQuality;
  if (typeof raw === "number" && raw !== 64) {
    // Light steps scale with sqrt(maxSteps / 64) so a custom value gets a
    // sensible light-march count without a second knob.
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

// Allocates or reallocates the shadow map, its pipeline, uniform buffer and
// placeholder, building the dedicated shadow bind-group layout with only the
// bindings `cloudShadowMain` references: `CloudUniforms` at 3, weather at 4 and
// 5, noise at 6, 7 and 8, and `CloudShadowUniforms` at 13. Returns false when
// anything cannot allocate, and the caller then falls back to the placeholder.
// The placeholder is built once and the map is fixed-size, so recreation is
// guarded only by `shadowSize`. The sun-view frame itself is owned by
// `WebGPUCloudShadowFrame.ts`, which computes the footprint centre as a WGS84
// geodetic surface projection in f64 and emits the matrices relative to a
// caller-supplied eye, so no planet-scale magnitude reaches an f32 matrix entry.
function ensureShadowResources(device: GPUDevice, cache: CloudCache): boolean {
  // 1×1 r16float zero placeholder: optical depth 0 gives transmittance 1, which
  // is no shadow.
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
      // The source carries preprocessor blocks, so its raw text is not valid
      // WGSL; preprocessing with no defines emits the non-emitting march.
      code: preprocess(PROCEDURAL_CLOUDS_SOURCE, 0, 0),
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
 * Routes a cloud render pass through the opt-in GPU timestamp profiler.
 *
 * Every raymarching pass this module opens — shadow map, shadow cascade atlas,
 * half-resolution march, temporal resolve, bilateral upscale, full-resolution
 * march, transmittance mask — is a separate measurable lane. Passes that carry
 * no `timestampWrites` are invisible to `CesiumDebug.gpuPassCost()`, which then
 * attributes no GPU time to the cloud march at all.
 *
 * `withRenderPassTimestamps` returns the same descriptor object when the
 * profiler is not armed for the frame, so an unprofiled frame allocates nothing
 * and the emitted commands are unchanged. The optional-call guard keeps this
 * safe on a context that predates the accessor.
 *
 * Pass results are keyed by the descriptor's `label`.
 */
function timedCloudPass(
  context: CesiumGraphicsContext,
  descriptor: GPURenderPassDescriptor,
): GPURenderPassDescriptor {
  // Pass accounting rides the same seam as pass timing. Every cloud pass already
  // routes through here, so the counts cannot drift away from the encode sites
  // the way seven hand-placed increments could, and a pass count exists even on
  // adapters with no `timestamp-query` support.
  recordCloudPass(context._cloudCache?.observability, descriptor.label);
  return context.withRenderPassTimestamps?.(descriptor) ?? descriptor;
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
): boolean {
  const device = context._device;
  if (!device) return false;

  // Everything a consumer reads per frame is cleared up front, so a culled or
  // early-returned frame reports nothing rather than last frame's state: the
  // god-ray consumer gets a null mask instead of a stale map, and a reconstruction
  // consumer gets no attachment set instead of one describing a frame that was
  // never marched. The counters follow the same convention, since a culled frame
  // that kept the previous target sizes and pass counts would read as work that
  // never happened. `resetCloudFrameCounters` zeroes in place without allocating
  // and bumps the lifetime frame count; the very first execute has no cache yet
  // and is reset just below instead, and the two branches are exclusive so every
  // execute is counted once.
  const existingCache = context._cloudCache;
  if (existingCache) {
    existingCache.maskRenderedThisFrame = false;
    existingCache.attachmentRenderedThisFrame = false;
    existingCache.reconstructionEmittedThisFrame = false;
    existingCache.reconstructionConsumedThisFrame = false;
    resetCloudFrameCounters(existingCache.observability);
    existingCache.cpuStages.beginStage(CloudCpuStage.TOTAL);
  }

  // Frustum cull. The cloud shell is a sphere at the planet origin with radius
  // `planetRadius + cloudLayerTop`, so the full-screen raymarch can be skipped
  // entirely when that sphere is outside the view frustum, for example with the
  // globe panned off-screen in space. For a sphere centred at the world origin
  // the signed distance to each frustum plane reduces to `plane.w`, since
  // dot(normal, 0) is zero, so the shell is outside exactly when some plane has
  // `w < -outerR`. That matches `BoundingSphere.intersectPlane`, which reports
  // OUTSIDE when the distance to the plane is below `-radius`. The test changes
  // nothing visually while any part of the shell is in view.
  const planes = frameState.cullingVolume?.planes;
  if (planes !== undefined && planes.length > 0) {
    const outerR = 6378137.0 + (config.cloudLayerTop ?? 4000.0);
    for (let p = 0; p < planes.length; p++) {
      if (planes[p].w < -outerR) {
        if (context._cloudCache) {
          markCloudTemporalInactive(context._cloudCache);
          context._cloudCache.observability.culledFrames++;
          context._cloudCache.cpuStages.endStage(CloudCpuStage.TOTAL);
        }
        return false; // shell entirely outside the frustum — nothing to draw
      }
    }
  }

  const cache = ensureCloudCache(context);
  if (existingCache === undefined) {
    // First execute on this context: the counters were allocated a line ago.
    resetCloudFrameCounters(cache.observability);
    cache.cpuStages.beginStage(CloudCpuStage.TOTAL);
  }
  const counters = cache.observability;
  const stages = cache.cpuStages;
  stages.beginStage(CloudCpuStage.PACK);
  initializeCloudPipeline(device, cache, context._canvasFormat || "bgra8unorm");

  // Bake once and resolve the 3D noise views before packing, so the
  // `qualityFlags` noise-source bit reflects the same frame's baked state rather
  // than flipping a frame late. The bake's one-shot submit runs before this
  // frame's cloud pass, so the textures are populated when sampled.
  //
  // A `cloudNoiseMorphology` of `"perlin-worley"` selects the Perlin-Worley
  // shape variant, which is a separately baked texture; `"value"` or undefined
  // keeps the value-FBM bake. The flag drives both the bake, which allocates the
  // Perlin-Worley texture, and which shape view binds at 6.
  const perlinWorley =
    (config as unknown as { cloudNoiseMorphology?: string })
      .cloudNoiseMorphology === "perlin-worley";
  const noise = ensureNoiseBaked(device, cache, perlinWorley);

  // Pack uniforms
  const data = cache.uniformData;
  const us = frameState.context?.uniformState ?? context.uniformState;
  // Resolved once per pack so the direct term at float 27 and the ambient term
  // at float 73 carry the same scalar by construction. Exactly 1.0 outside an
  // enabled solar eclipse.
  const eclipseCloudFactor = resolveEclipseCloudFactor(frameState);
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
  // Cloud motion is bound to the scene clock: `time` in seconds comes from
  // `frameState.time` rather than from `performance.now()`, so wind and
  // advection scrub with the timeline, pause when `clock.shouldAnimate` is
  // false, and scale with `clock.multiplier`. The day-seconds are computed in
  // f64 and the first-frame epoch is subtracted before the f32 store, since raw
  // day-seconds of around 1.9e14 leave no usable f32 precision.
  const cloudTimeSeconds = resolveCloudTimeSeconds(cache, frameState);
  data[offset++] = cloudTimeSeconds;
  // Keep the environment-capture consumer synchronized even if its update is
  // requested after this execute rather than through the normal publish call.
  cache.iblTimeSeconds = cloudTimeSeconds;

  // sunDirection (vec3 + intensity)
  const sunDir = us?.sunDirectionWC ?? us?.sunDirectionEC;
  data[offset++] = sunDir?.x ?? 0;
  data[offset++] = sunDir?.y ?? 1;
  data[offset++] = sunDir?.z ?? 0;
  // The deck's direct term is `(msLight + silverLining) * sunIntensity` and this
  // is its only scale, so the eclipse factor applies here. The source is
  // `config.atmosphereLightIntensity`, the undimmed user field, not the
  // per-frame `tileProvider.atmosphereLightIntensity` mirror that `Globe.js`
  // dims for the ground atmosphere; without this multiply the deck stays at full
  // midday brightness over a world already at the twilight floor. A factor of
  // 1.0 is bit-exact, so a non-eclipse frame is unaffected.
  data[offset++] = applyEclipseCloudDimming(
    config.atmosphereLightIntensity ?? 10.0,
    eclipseCloudFactor,
  ); // sunIntensity

  // Cloud layer params
  data[offset++] = config.cloudLayerBottom ?? 1500.0;
  data[offset++] = config.cloudLayerTop ?? 4000.0;
  data[offset++] = WGS84_EQUATORIAL_RADIUS; // planetRadius
  data[offset++] = config.cloudCoverage ?? 0.5;

  // Quality parameters. The resolver reads the `config.cloudVolumetricQuality`
  // preset string, the camera altitude, and the enable and disable altitudes
  // from `AtmosphericConditions` for auto mode, and returns `config.cloudQuality`
  // verbatim when that field has been set to a non-default value.
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
  // Step counts stay on the quality resolver; the tier preset supplies the
  // remaining dials, which reach the shader through the `qualityFlags` lane at
  // float 74.
  const qualityResolved = resolveCloudQuality(qualityInputs);
  const cloudPreset = resolveCloudPreset(qualityInputs);
  // Half-resolution gate. A tier that resolves `renderResScale` below 1 marches
  // into a half-size target and bilaterally upscales; the cinematic tier and the
  // `cloudQuality` escape hatch keep it at 1.0 and take the full-resolution
  // composite straight to the canvas. `halfResActive` is additionally gated on
  // the half-resolution resources actually allocating, so a target or pipeline
  // that cannot be built falls back to full resolution rather than dropping the
  // clouds.
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
      // The tier asked for the half-resolution path but the target or pipelines
      // could not allocate, so the full-resolution composite runs instead and
      // the clouds render degraded rather than absent. Reported unconditionally
      // because it indicates a real allocation failure.
      console.error(
        `[CesiumJS:webgpu:ctx-${context.id ?? "?"}] Cloud half-res target/pipeline allocation failed (${canvasW}x${canvasH} @${cloudPreset.renderResScale}); falling back to full-res.`,
      );
    }
    halfResActive = allocated;
  }
  // Temporal gate. A tier with `temporalEnabled` layers reprojection and
  // accumulation on top of the half-resolution march: the history accumulates
  // the premultiplied half-resolution cloud, is reprojected through the previous
  // relative-to-eye view-projection and the f64 camera delta, and is
  // neighbourhood-clamped each frame. The cinematic tier and the `cloudQuality`
  // escape hatch leave it false and allocate no history. The history is
  // half-resolution, so temporal additionally requires `halfResActive`, and a
  // history pair or resolve pipeline that cannot allocate falls back to plain
  // half resolution with no accumulation.
  const temporalFrustum = frameState.camera?.frustum;
  const temporalProjectionOrthographic =
    temporalFrustum instanceof OrthographicFrustum ||
    temporalFrustum instanceof OrthographicOffCenterFrustum;
  // The current color-only proxy assumes every ray begins at the camera.
  // Orthographic reconstruction needs a per-pixel eye-relative origin, and
  // morphing crosses incompatible projection regimes. Keep the live half-res
  // march/upscale, but do not animate its temporal-only phase, allocate/execute
  // history, or advertise QF_TEMPORAL until that geometry is representable.
  const temporalReprojectionSupported =
    !temporalProjectionOrthographic && frameState.mode !== SceneMode.MORPHING;
  let temporalActive =
    cloudPreset.temporalEnabled &&
    halfResActive &&
    temporalReprojectionSupported;
  if (temporalActive) {
    const tAllocated = ensureTemporalResources(
      device,
      cache,
      cache.halfWidth,
      cache.halfHeight,
    );
    if (!tAllocated) {
      // The tier asked for temporal accumulation but the history or resolve
      // pipeline could not allocate, so plain half resolution runs instead and
      // the clouds still render. Reported unconditionally because it indicates a
      // real allocation failure.
      console.error(
        `[CesiumJS:webgpu:ctx-${context.id ?? "?"}] Cloud temporal history/pipeline allocation failed (${cache.halfWidth}x${cache.halfHeight}); falling back to half-res (no accumulation).`,
      );
    }
    temporalActive = tAllocated;
  }
  if (!temporalActive) {
    // A full-resolution/plain-half frame does not update the temporal history.
    // Even an adjacent re-entry must therefore seed from the current march.
    markCloudTemporalInactive(cache);
  }
  // Raymarch geometry and step budgets, recorded at the one point where the
  // half-resolution gate, the temporal gate and the quality resolver have all
  // settled, so nothing here is derived twice.
  //
  // The sample counts are bounded proxies — dispatched pixels times the resolved
  // budgets — not true sample counts. A true count needs a shader-side atomic,
  // and WGSL register allocation is static, so even a runtime-gated counter would
  // cost occupancy on every frame.
  counters.marchWidth = halfResActive ? cache.halfWidth : canvasW;
  counters.marchHeight = halfResActive ? cache.halfHeight : canvasH;
  counters.marchPixels = counters.marchWidth * counters.marchHeight;
  counters.halfResActive = halfResActive ? 1 : 0;
  counters.maxSteps = qualityResolved.maxSteps;
  counters.lightSteps = qualityResolved.lightSteps;
  counters.primarySampleBudget = counters.marchPixels * counters.maxSteps;
  counters.lightSampleBudget =
    counters.primarySampleBudget * counters.lightSteps;
  counters.resolveWidth = temporalActive ? cache.temporalWidth : 0;
  counters.resolveHeight = temporalActive ? cache.temporalHeight : 0;
  counters.resolvePixels = counters.resolveWidth * counters.resolveHeight;
  counters.upscalePixels = halfResActive ? canvasW * canvasH : 0;
  // `attachmentsEnabled` is also writable from the debug surface without going
  // through `setCloudReconstructionAttachments`, so a set switched off that way
  // frees itself on the next execute rather than staying resident and continuing
  // to report live bytes.
  if (!cache.attachmentsEnabled && cache.attachmentGeneration.liveBytes > 0) {
    releaseCloudAttachmentResources(cache);
  }
  // Consuming a set that is not being produced is the stale read the per-frame
  // flag discipline exists to prevent, so clearing `attachmentsEnabled` directly
  // also clears the dependent flag instead of leaving a half-armed variant.
  if (!cache.attachmentsEnabled && cache.reconstructionEnabled) {
    cache.reconstructionEnabled = false;
  }
  // A resident figure, published every execute rather than only on frames the
  // producer ran: live bytes above 0 with `attachmentPixels` at 0 is the real
  // state "allocated, but this frame produced none".
  counters.attachmentLiveBytes = cache.attachmentGeneration.liveBytes;
  // Resident as well: the requested state, published every execute so a frame
  // that requested the variant but could not build it reads as requested with
  // nothing emitted rather than as never having been asked for.
  counters.reconstructionRequested = cache.reconstructionEnabled ? 1 : 0;

  data[offset++] = qualityResolved.maxSteps;
  data[offset++] = qualityResolved.lightSteps;
  data[offset++] = config.cloudDensity ?? 0.3;
  data[offset++] = 0.04; // absorptionCoeff

  // Wind
  const windDir = config.cloudWindDirection;
  const cloudWindX = windDir?.x ?? 0.7;
  const cloudWindY = windDir?.y ?? 0.3;
  const cloudWindSpeed = config.cloudWindSpeed ?? 15.0;
  data[offset++] = cloudWindX;
  data[offset++] = cloudWindY;
  data[offset++] = cloudWindSpeed;
  // Silver-lining intensity, live from `atmosphericConditions.clouds.silverLining`.
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

  // Resolution and WGS84 coordinate data. While half resolution is active this
  // carries the half-resolution target size, so the shader's Bayer jitter step
  // of 1/resolution is one half-resolution texel; the full-resolution path skips
  // the jitter branch and keeps the canvas size.
  data[offset++] = halfResActive ? cache.halfWidth : canvasW;
  data[offset++] = halfResActive ? cache.halfHeight : canvasH;
  // The aligned pads of the resolution row carry the WGS84 semi-minor axis and
  // the f64 geodetic camera height, so neither needs its own row. The geodetic
  // height is what stops a 20 km polar camera being classified as below the
  // cloud deck.
  data[offset++] = WGS84_POLAR_RADIUS;
  data[offset++] = cameraHeightM;

  // Weather-map seam lanes, floats 64-79. A `WeatherProvider` holding real data
  // both supplies the texture and auto-enables the weather map, so observed
  // cloud cover drives the deck without `cloudWeatherMap` being set explicitly.
  // `getPackedTexture` returns null until the asynchronous fetch lands, and the
  // procedural map is kept until then, which avoids an overcast-everywhere flash.
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
  // 66/67 — dual-lobe phase: back-scatter g and the forward/back blend, live
  // from `atmosphericConditions.clouds.phaseBackG` and `.phaseBlend`.
  data[offset++] = config.cloudPhaseBackG ?? -0.3; // 66 phaseG2
  data[offset++] = config.cloudPhaseBlend ?? 0.7; // 67 phaseBlend
  // 68-71 weatherTexBounds — global equirect (radians): minLon, minLat, lonRange, latRange.
  data[offset++] = -Math.PI;
  data[offset++] = -Math.PI / 2.0;
  data[offset++] = 2.0 * Math.PI;
  data[offset++] = Math.PI;
  // 72 — forward-scatter g. The Henyey-Greenstein forward peak at g = 0.85 is
  // about 1.8 times the peak at g = 0.8, which is what gives a strong silver
  // lining toward the sun.
  data[offset++] = config.cloudPhaseForwardG ?? 0.85; // 72 phaseG1 (config: .phaseForwardG)
  // 73 — ambient intensity: the sky and ground fill on the shadow side, from
  // `.ambientIntensity`. The eclipse factor applies here too. `skyAmbientColor`
  // at 80-82 and `groundAmbientColor` at 84-86 are fixed constants that track no
  // scene light on any path — the `ambientLutMode` route replaces only their hue
  // and chroma and keeps their nominal brightness — so this scalar is the only
  // lever the deck's ambient has. Dimming the direct term alone leaves a fully
  // lit ambient deck glowing over a darkened world at totality.
  data[offset++] = applyEclipseCloudDimming(
    config.cloudAmbientIntensity ?? 1.5,
    eclipseCloudFactor,
  ); // 73 ambientIntensity
  // 74 — the `qualityFlags` bitfield. Bit 0 selects the baked 3D-texture core,
  // and it is set only when the tier asks for it and the bake succeeded; with no
  // baked noise resident the bit stays clear and the shader marches live noise
  // instead.
  const noiseBakedBit =
    cloudPreset.noiseSource === CloudNoiseSource.BAKED &&
    cache.noiseBaked &&
    cache.noise !== null
      ? CLOUD_QF_NOISE_BAKED
      : 0;
  // Bit 1 marks the half-resolution path and is set only when that path is
  // actually running, meaning the tier asked for it and the target and pipelines
  // allocated. The shader keys its premultiplied-emit and jitter branch on this
  // bit, and the full-resolution tiers leave it clear.
  const halfResBit = halfResActive ? CLOUD_QF_HALF_RES : 0;
  // Bit 2 marks active temporal accumulation. The march emits identically either
  // way, since temporal adds a separate resolve pass rather than a march branch;
  // the bit exists so the flags stay consistent with the tier presets and with
  // what any reader of the field would expect.
  const temporalBit = temporalActive ? CLOUD_QF_TEMPORAL : 0;
  // Bit 3 carries the tier's jitter contract: the lower tiers animate the
  // per-pixel interleaved-gradient-noise phase only while temporal accumulation
  // is active, the cinematic tier gets deterministic frame-zero spatial noise,
  // and the hand-tuned escape preset leaves jitter off and keeps exact midpoint
  // sampling.
  const jitterBit = cloudPreset.jitterEnabled ? CLOUD_QF_JITTER : 0;
  // Bit 10 selects the cone-sampled light march, which the lower tiers use. The
  // cinematic tier and the escape hatch leave it clear and take the straight
  // light march.
  const lightConeBit = cloudPreset.lightConeSampling ? CLOUD_QF_LIGHT_CONE : 0;
  data[offset++] =
    noiseBakedBit |
    halfResBit |
    temporalBit |
    jitterBit |
    lightConeBit |
    ((Math.min(7, cloudPreset.multiScatterOctaves) & 7) <<
      CLOUD_QF_OCTAVES_SHIFT); // 74 qualityFlags
  // 75 — curl-warp amplitude. At 0 the shader's `curlAmplitude > 0.0` guard
  // skips the baked-path detail-erosion warp entirely, and
  // `config.cloudCurlAmplitude` is the only thing that raises it: the tier
  // presets leave their own `curlAmplitude` at 0, so curl is a property of the
  // configuration rather than of the tier. The warp perturbs only where the
  // detail texture is sampled, and that erosion is subtractive, so it can carve
  // wispier edges but never add density.
  data[offset++] = config.cloudCurlAmplitude ?? 0.0; // 75 curlAmplitude
  // 76 — the shared temporal phase. The low 4 bits carry the Bayer and cone
  // 16-phase sequence and all 6 bits drive the animated interleaved-gradient
  // noise. The full-resolution cinematic path stores zero so its spatial noise
  // stays deterministic and cannot sparkle with no history to average it.
  cache.frameCounter = (cache.frameCounter + 1) & 63;
  data[offset++] = halfResActive ? cache.frameCounter : 0; // 76 frameCounter
  // 77 — curl-noise swirl wavelength in noise space, read only while
  // `curlAmplitude` is above 0. The default of 2.0 is about the base-shape
  // feature scale.
  data[offset++] = config.cloudCurlFrequency ?? 2.0; // 77 curlFrequency
  // 78 — light-march step scale. The live-noise and cinematic paths march the
  // full light ray; the lower baked tiers halve it for cheaper shadowing.
  data[offset++] =
    cloudPreset.noiseSource === CloudNoiseSource.LIVE || cloudPreset.tier >= 3
      ? 1.0
      : 0.5; // 78 lightSampleScale
  // 79 — mean-preserving erosion floor, read on the baked path only. An explicit
  // override wins; otherwise the tier decides, low tiers being fibrous at 0.10
  // and the higher tiers puffy at 0.18.
  data[offset++] =
    config.cloudErosionStrength ?? (cloudPreset.tier <= 1 ? 0.1 : 0.18); // 79 erosionStrength
  // 80-83 — sky ambient: blue, lighting cloud tops.
  data[offset++] = 0.5; // 80
  data[offset++] = 0.65; // 81
  data[offset++] = 0.95; // 82
  data[offset++] = 0; // 83 pad
  // 84-87 — ground-bounce ambient: warm grey, lighting cloud bottoms.
  data[offset++] = 0.35; // 84
  data[offset++] = 0.34; // 85
  data[offset++] = 0.3; // 86
  data[offset++] = 0; // 87 pad
  // 88-90 — time-of-day sun colour, keyed on the local sun elevation, that is
  // `sunDir` dotted with local up at the camera, rather than on raw ECEF Y:
  // warm orange near the horizon, neutral white by about 20 degrees up.
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
  // 91 — aerial-perspective strength, from `config.cloudAerialStrength`. At 1.0
  // the horizon haze is applied in full at the 60 km scale the shader assumes;
  // at 0 it is off.
  data[offset++] = config.cloudAerialStrength ?? 1.0; // 91 aerialStrength
  // 92-94 — horizon inscatter haze tint. Distant clouds blend toward this so
  // they fade into the sky instead of popping. Keyed on the same local sun
  // elevation (todT) as the sun color: warm orange-grey at the horizon (twilight
  // band) -> desaturated sky-blue at day. This roughly tracks the rendered sky's
  // horizon color so far clouds dissolve into it rather than a fixed blue.
  //
  // The tint is an addend rather than a scale: `ProceduralClouds.wgsl` computes
  // `mix(toneMapped, cloud.aerialColor, aerial)`, so the `aerial` fraction of
  // every deck pixel is this colour irrespective of the deck's own radiance. It
  // models the skylight in-scattered between camera and cloud, and that
  // inscatter dims with the sky it comes from, so the eclipse factor applies
  // here too. Left undimmed, a distant deck keeps a full-brightness horizon tint
  // at totality and the deck's measured brightness ratio is biased upward by
  // `aerial * (1 - F) * A / H(1)`. A factor of 1.0 is bit-exact, so a
  // non-eclipse frame is unaffected.
  //
  // Named rather than inlined so the dimming is greppable in a built bundle:
  // every literal in this block is a float, and esbuild normalises those.
  const dimAerialTint = (channel: number): number =>
    applyEclipseCloudDimming(channel, eclipseCloudFactor);
  data[offset++] = dimAerialTint(0.8 + (0.62 - 0.8) * todT); // 92 R (warm 0.80 -> day 0.62)
  data[offset++] = dimAerialTint(0.62 + (0.72 - 0.62) * todT); // 93 G (warm 0.62 -> day 0.72)
  data[offset++] = dimAerialTint(0.5 + (0.85 - 0.5) * todT); // 94 B (warm 0.50 -> day 0.85)
  data[offset++] = 0; // 95 pad
  // 96-100 — shape scale, exposure and the three multiple-scattering decay
  // terms, all live dials whose defaults are the values the shader would
  // otherwise hard-code.
  const cloudPuffSize = config.cloudPuffSize ?? 0.45;
  data[offset++] = cloudPuffSize; // 96 puffSize
  cache.iblPuffSize = cloudPuffSize;
  data[offset++] = config.cloudExposure ?? 0.22; // 97 exposure
  data[offset++] = config.cloudMsDecayScatter ?? 0.5; // 98 msDecayA
  data[offset++] = config.cloudMsDecayExtinction ?? 0.5; // 99 msDecayB
  data[offset++] = config.cloudMsDecayPhase ?? 0.85; // 100 msDecayC
  // 101-104 — the per-genus vertical-density profile. `config.cloudType` selects
  // a {@link CloudTypeProfile}; cumulus resolves to the billowy shape at density
  // scale 1.0, which is the shader's baseline gradient.
  const profile = CloudTypeProfile.get(config.cloudType ?? CloudType.CUMULUS);
  const cumulusProfile = CloudTypeProfile.get(CloudType.CUMULUS);
  const cumulusBase = cumulusProfile.baseDensity; // 0.7
  const cumulusExtinction = cumulusProfile.extinction; // 0.6
  data[offset++] = profile.shape; // 101 profileShape (0 SLAB / 1 BILLOWY / 2 TOWER)
  data[offset++] = cumulusBase > 0 ? profile.baseDensity / cumulusBase : 1.0; // 102 profileDensityScale (CUMULUS=1.0)
  // 103 — per-genus optical extinction, normalised against cumulus at 0.6 so
  // cumulus resolves to 1.0, mirroring how `profileDensityScale` at 102 is
  // normalised. The shader multiplies `cloud.absorptionCoeff` by this, so thin
  // genera such as cirrus at 0.167× absorb less and read wispier, while dense
  // genera such as cumulonimbus at 1.583× absorb more and read as darker, more
  // opaque cores.
  data[offset++] =
    cumulusExtinction > 0 ? profile.extinction / cumulusExtinction : 1.0; // 103 profileExtinction (CUMULUS=1.0)
  data[offset++] =
    profile.shape === CloudTypeProfile.CloudHeightGradientShape.TOWERING_ANVIL
      ? 1.0
      : 0.0; // 104 anvilBias
  // 105/106 — camera near and far, so the shader can reverse the renderer-wide
  // log depth for occlusion. Same source as AerialPerspective uses.
  data[offset++] = frameState.camera?.frustum?.near ?? 1.0; // 105 nearPlane
  data[offset++] = frameState.camera?.frustum?.far ?? 1e8; // 106 farPlane
  // 107 — how strongly the weather map's green, blue and alpha channels, which
  // carry genus, base altitude and density bias, modulate the cloud model. A
  // neutral map cell of (0.5, 0, 0.5) in those channels is a no-op at any
  // strength, so a red-only map behaves the same at every setting; 0 reduces the
  // map to its red coverage channel.
  data[offset++] = config.cloudWeatherChannelStrength ?? 1.0; // 107 weatherChannelStrength
  // 108-111 — atmosphere-LUT coupling modes. Both default to the analytic path,
  // a heuristic aerial term and a constant ambient, which the shader selects when
  // these mode floats are 0. The `qualityFlags` bits 8 and 9 carry the same
  // on/off state; the mode floats make it legible from the shader side.
  // `atmosphereThickness` has to match the LUT bake, so the transmittance
  // v-lookup lands on the right row.
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

  // 112-119 — the multi-deck shell march. With `multiDeck` at 0 the shader
  // marches exactly one shell between `cloudLayerBottom` and `cloudLayerTop` and
  // never reads the deck bounds. The bounds come from
  // `CloudTypeProfile.CloudDeck.bounds`, the same table the per-genus deck
  // assignment uses, so the two cannot disagree.
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

  // 120-127 — the camera-relative high-precision march: the relative-to-eye
  // high/low split of the same camera world position that feeds
  // `cloud.cameraPosition`. All eight floats are written every frame, but the
  // shader reads them only inside the CLOUD_QF_HIGH_PRECISION branch. The branch
  // is on unless it is explicitly disabled, which returns the march to the
  // direct shell-intersection form.
  const highPrecisionOn =
    (config as unknown as { cloudHighPrecision?: boolean })
      .cloudHighPrecision !== false;
  // Encode the camera world position into a high/low f32 pair so the shader can
  // subtract the large high term before applying the small low refinement, which
  // is what keeps the subtraction from cancelling into noise.
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
    // With no camera the split has nothing to encode; the branch that reads it
    // cannot run either.
    data[offset++] = 0.0; // 120
    data[offset++] = 0.0; // 121
    data[offset++] = 0.0; // 122
    data[offset++] = 0.0; // 123 pad
    data[offset++] = 0.0; // 124
    data[offset++] = 0.0; // 125
    data[offset++] = 0.0; // 126
    data[offset++] = 0.0; // 127 pad
  }

  // 128-131 — mammatus, the pendulous pouches on a cloud's underside. At a
  // strength of 0 the shader's `mammatusFactor()` returns 1.0 immediately and the
  // remaining floats are never read past that guard.
  const globeMamma = config as unknown as {
    cloudMammatusStrength?: number;
    cloudMammatusScale?: number;
    cloudMammatusDepth?: number;
  };
  data[offset++] = globeMamma.cloudMammatusStrength ?? 0.0; // 128 mammatusStrength (0 = off)
  data[offset++] = globeMamma.cloudMammatusScale ?? 1.0; // 129 mammatusScale (pouch size)
  data[offset++] = globeMamma.cloudMammatusDepth ?? 0.25; // 130 mammatusDepth (underside band)
  data[offset++] = 0.0; // 131 pad

  // 132-135 — species and variety density shaping. At mode 0 the shader's
  // `speciesFactor()` returns 1.0 immediately and the remaining floats are never
  // read past that guard. `cloudSpecies` takes a genus-gated name, or
  // `cloudSpeciesMode` the numeric equivalent: "lenticularis" is mode 1, and
  // "fibratus" and "uncinus" are both mode 2, with uncinus adding the hook
  // through its parameter.
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

  // 136-139 — the supplementary features asperitas, fluctus, arcus and virga, as
  // bounded density shaping. At mode 0 the shader's `featureFactor()` returns
  // 1.0 immediately and the remaining floats are never read past that guard.
  // `cloudFeature` takes a genus-gated name, or `cloudFeatureMode` the numeric
  // equivalent: "asperitas" is 1, "fluctus" and "kelvin-helmholtz" are 2,
  // "arcus" is 3, and "virga" and "praecipitatio" are both 4, praecipitatio
  // differing only in its parameter, which gives denser, further-reaching
  // streaks.
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

  // 140-143 — noctilucent and nacreous iridescent shading. At mode 0 the
  // shader's `specialShadeTint()` returns `vec3(1.0)` immediately, so the cloud
  // colour is multiplied by exactly 1.0 and the remaining floats are never read
  // past that guard. `cloudSpecial` takes a name, or `cloudSpecialShadeMode` the
  // numeric equivalent: "noctilucent" and "nlc" are 1, and "nacreous",
  // "polar-stratospheric" and "psc" are 2. This supplies only the shading; the
  // high-altitude deck itself is placed through the multi-deck high bounds.
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

  // 144-147 — two march dials that trade quality for cost at orbital distance,
  // both no-ops at their defaults: `marchStepGrowth` at 1.0 fails the shader's
  // `> 1.0` guard and every step stays the fine step, and `maxRayDistance` at 0
  // fails its `> 0.0` guard and the ray end is untouched. `cloudMarchStepGrowth`
  // is geometric growth per fine step, clamped to [1.0, 1.1] so near samples stay
  // crisp while far shell samples coarsen; `cloudMaxRayDistance` is a distance
  // in metres past which the view march stops, where clouds are sub-pixel
  // anyway. The WebGL cloud path is a separate, simpler renderer and has no
  // equivalent.
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

  // 148-159 — f64 planet-domain origin phases, three vec4 rows. The march
  // reconstructs density coordinates from these camera-origin phases plus its
  // own small camera-relative sample offset. Wind advection is folded into the
  // origin here in f64, so a long timeline scrub never constructs a
  // planet-scale f32 displacement in the shader.
  writeCloudDensityAdvectedOriginPhases(
    data,
    offset,
    camPos?.x ?? 0.0,
    camPos?.y ?? 0.0,
    camPos?.z ?? 0.0,
    cloudPuffSize,
    cloudWindX,
    cloudWindY,
    cloudWindSpeed,
    cloudTimeSeconds,
  );
  offset += CLOUD_DENSITY_ORIGIN_PHASE_FLOATS;

  // 160-167 — the encoded canonical morphology origin, as high xyz plus pad and
  // low xyz plus pad. The analytic species and feature terms work in an
  // unrotated x/z wind plane, which this supplies without them having to consume
  // the wrapped texture coordinates.
  writeCloudMorphologyOriginHighLow(
    data,
    offset,
    camPos?.x ?? 0.0,
    camPos?.y ?? 0.0,
    camPos?.z ?? 0.0,
    cloudWindX,
    cloudWindY,
    cloudWindSpeed,
    cloudTimeSeconds,
  );
  offset += CLOUD_DENSITY_MORPHOLOGY_ORIGIN_FLOATS;

  // 168-171 — per-genus morphology, carrying two {@link CloudTypeProfile} axes
  // into the shader: the fibrous or puffy erosion style, which becomes an
  // anisotropic wind-sheared filament carve so the cirrus family reads as ice
  // streaks rather than faint cumulus lobes, and the per-genus
  // Henyey-Greenstein `phaseG`, which becomes a forward-lobe offset because ice
  // scatters far more forward-peaked than water.
  //
  // Both are derived from the profile table rather than from separate public
  // dials, since `cloudType` is already the selector and the profile is what it
  // selects. Cumulus, the default genus, is puffy with a fibre strength of
  // exactly 0 and is its own phase reference, so both shader guards return their
  // unmodified expressions for it.
  const fibreMorphology = CloudTypeProfile.getFibreMorphology(
    config.cloudType ?? CloudType.CUMULUS,
  );
  data[offset++] = fibreMorphology.strength; // 168 genusFibreStrength (0 = PUFFY/off)
  data[offset++] = fibreMorphology.anisotropy; // 169 genusFibreAnisotropy (1 = isotropic)
  data[offset++] = fibreMorphology.shear; // 170 genusFibreShear (0 = no fallstreak tilt)
  data[offset++] = profile.phaseG - cumulusProfile.phaseG; // 171 genusPhaseDelta (CUMULUS = 0)

  // Fold the two LUT-coupling bits into `qualityFlags` at slot 74, already
  // packed above. Bits 8 and 9 are set only while the corresponding mode is on,
  // so with both off the shader's gates stay closed.
  if (aerialLutOn || ambientLutOn) {
    let qf = data[74];
    if (aerialLutOn) qf = qf | CLOUD_QF_AERIAL_LUT;
    if (ambientLutOn) qf = qf | CLOUD_QF_AMBIENT_LUT;
    data[74] = qf;
  }
  // Bit 11 selects the multi-deck march; clear, the shader takes the
  // single-shell branch.
  if (multiDeckOn) {
    data[74] = data[74] | CLOUD_QF_MULTI_DECK;
  }
  // Bit 12 selects the high-precision march, which is on unless
  // `cloudHighPrecision` is explicitly false; clear, the shell intersection is
  // computed in single-part f32.
  if (highPrecisionOn) {
    data[74] = data[74] | CLOUD_QF_HIGH_PRECISION;
  }
  // Bit 13 selects the planet-scale density domain, and only a realized baked
  // resource can supply it; the live-noise fallback keeps its own formula.
  // Unlike the high-precision bit this one has no public override, so the only
  // way to flip it in isolation is a diagnostic that writes slot 74 directly
  // after upload.
  if (noiseBakedBit !== 0) {
    data[74] = data[74] | CLOUD_QF_PLANET_DENSITY;
  }

  device.queue.writeBuffer(cache.uniformBuffer!, 0, data);

  // Resolve the weather view: the procedural map when enabled, a 1×1 white
  // fallback otherwise.
  const weatherView = ensureWeatherView(
    device,
    cache,
    weatherEnabled,
    providerBytes,
    providerVersion,
  );
  // `noise` (the 3D shape/detail views + sampler) was resolved up-front so the
  // qualityFlags noiseSource bit reflects the same-frame baked state.

  // Resolve the atmosphere-LUT views: the real textures when a mode is on and
  // the LUTs are allocated, 1×1 black placeholders otherwise. They are bound
  // unconditionally at 9, 10 and 11 so the bind-group layout never forks, and
  // the shader gates the samples.
  const lutViews = ensureCloudLutViews(
    device,
    context,
    cache,
    aerialLutOn || ambientLutOn,
  );

  const bindGroup = getOrCreateCloudMainBindGroup(
    device,
    cache,
    colorTextureView,
    depthTextureView,
    weatherView,
    noise.shapeView,
    noise.detailView,
    noise.sampler,
    lutViews,
  );

  // Record into the main frame encoder so the composite lands over the
  // post-process output; a separate encoder submits in its own order and the
  // composite would be overwritten. The NPR and SSR passes bind their work the
  // same way.
  const mainEncoder = (
    context as unknown as { _currentCommandEncoder?: GPUCommandEncoder }
  )._currentCommandEncoder;
  const useMain = !!mainEncoder;
  const encoder =
    mainEncoder ??
    device.createCommandEncoder({ label: "ProceduralClouds (orphan)" });

  // The sun-view Beer shadow map, opted into through `config.cloudCastShadows`.
  // With it off, `shadowActive` stays false, the real map is never rendered, and
  // consumers read the 1×1 placeholder at transmittance 1. With it on, the cloud
  // optical depth is rasterized from the sun's orthographic view into
  // `cache.shadowView` using the same `CloudUniforms`, weather and noise the
  // visible march uses, so the cast shadow tracks the rendered field exactly.
  // The sun-view projection is stashed on the cache for the consumers; the globe
  // terrain reads the previous frame's, while aerial perspective and fog read
  // this frame's.
  cache.shadowActive = false;
  cache.shadowCascadeActive = false;
  // Publish the cast-shadow strength through the same cache seam
  // `shadowAbsorption` travels through, and do it unconditionally so a frame
  // that skips the shadow block cannot leave a stale value behind. It tracks the
  // directional share of the surviving illumination, not the scene-light factor:
  // scaling the strength by the scene factor gives shadowed ground
  // `F * (1 - 0.65F)`, which peaks at F = 0.769 above its un-eclipsed value, so
  // a shadowed patch would brighten as the eclipse deepened. See
  // `Scene/EclipseCloudResponse.js` for the derivation. It is exactly 1.0
  // outside an eclipse.
  cache.shadowStrength = eclipseCloudDirectionalFraction(frameState);
  stages.endStage(CloudCpuStage.PACK);
  stages.beginStage(CloudCpuStage.SHADOW);
  if (config.cloudCastShadows === true) {
    const shadowOk = ensureShadowResources(device, cache);
    if (!shadowOk) {
      // Cast shadows are on but the map could not allocate, so the placeholder
      // is used and nothing is shadowed. Reported unconditionally because it
      // indicates a real allocation failure.
      console.error(
        `[CesiumJS:webgpu:ctx-${context.id ?? "?"}] Cloud shadow map allocation failed; falling back to no-shadow placeholder.`,
      );
    } else {
      // The footprint centre is the camera's WGS84 geodetic surface point. A
      // radial projection onto a 6378137 m sphere instead lands up to about
      // 21.4 km off in the radial direction at the poles, which at a low sun
      // swings the whole ±60 km footprint tens of kilometres away from the
      // ground the camera is looking at.
      const cpx = camPos?.x ?? 0;
      const cpy = camPos?.y ?? 0;
      const cpz = camPos?.z ?? 0;
      const sdx = sunDir?.x ?? 0;
      const sdy = sunDir?.y ?? 1;
      const sdz = sunDir?.z ?? 0;
      const frameOk = computeCloudShadowFrame(
        cache.shadowFrame,
        cpx,
        cpy,
        cpz,
        sdx,
        sdy,
        sdz,
        CLOUD_SHADOW_FOOTPRINT_M,
        WGS84_EQUATORIAL_RADIUS,
        WGS84_POLAR_RADIUS,
      );
      if (!frameOk) {
        // A degenerate camera or sun input would otherwise upload a meaningless
        // projection that every consumer then samples.
        console.error(
          `[CesiumJS:webgpu:ctx-${context.id ?? "?"}] Cloud shadow sun-view frame is degenerate; leaving the shadow map inert this frame.`,
        );
      }
      // The absolute matrix stays published for the planar scene modes, whose
      // globe fragments carry no ECEF camera-relative position.
      writeCloudShadowViewProjection(
        cache.shadowSunViewVP,
        0,
        cache.shadowFrame,
      );
      // `CloudShadowUniforms` holds the camera-relative inverse view-projection
      // in floats 0-15, so the shadow fragment shader reconstructs a
      // camera-relative column point and stays in the same relative-to-eye frame
      // as the visible march, and the sun direction plus the light-step count in
      // floats 16-19.
      writeCloudShadowInverseViewProjectionRelativeToEye(
        cache.shadowUniformData,
        0,
        cache.shadowFrame,
        cpx,
        cpy,
        cpz,
      );
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
      const shadowPass = encoder.beginRenderPass(
        timedCloudPass(context, {
          label: "CloudShadow map pass",
          colorAttachments: [
            {
              view: cache.shadowView!,
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
              loadOp: "clear",
              storeOp: "store",
            },
          ],
        }),
      );
      shadowPass.setPipeline(cache.shadowPipeline!);
      shadowPass.setBindGroup(0, shadowBindGroup);
      shadowPass.draw(3);
      shadowPass.end();
      // A degenerate frame leaves the map inert rather than publishing an
      // identity projection every consumer would then sample as a real shadow.
      cache.shadowActive = frameOk;
      // The single Beer shadow map is one pass, at this resolution.
      counters.shadowPassCount++;
      counters.shadowSize = cache.shadowSize;

      // The opt-in three-cascade atlas, additive on top of the single map that
      // aerial perspective and fog keep reading: three geometrically split
      // cascades rendered into a stacked 512×1536 atlas the globe terrain
      // samples. Each cascade reuses the single-map pipeline with its own
      // footprint and march-step count, fed from a 256-aligned slice of the
      // cascade uniform buffer.
      if (config.cloudShadowCascades === true) {
        const cascadeOk = ensureCascadeResources(device, cache);
        if (!cascadeOk) {
          // Cascades are on but the atlas could not allocate, so
          // `shadowCascadeActive` stays false and the globe falls back to the
          // single map. Reported unconditionally because it indicates a real
          // allocation failure.
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
            // Each cascade is the same geodetic-centred sun frame at a tighter
            // half-extent. The fragment shader reconstructs camera-relative
            // columns from its own inverse view-projection, while the forward
            // matrix stays absolute for the planar-mode consumer branch.
            const cascadeFrame = cache.shadowCascadeFrames[ci];
            computeCloudShadowFrame(
              cascadeFrame,
              cpx,
              cpy,
              cpz,
              sdx,
              sdy,
              sdz,
              CLOUD_SHADOW_CASCADE_FOOTPRINTS_M[ci],
              WGS84_EQUATORIAL_RADIUS,
              WGS84_POLAR_RADIUS,
            );
            writeCloudShadowViewProjection(fwd, 0, cascadeFrame);
            writeCloudShadowInverseViewProjectionRelativeToEye(
              invVP,
              0,
              cascadeFrame,
              cpx,
              cpy,
              cpz,
            );
            cud[base + 16] = sdx;
            cud[base + 17] = sdy;
            cud[base + 18] = sdz;
            cud[base + 19] = CLOUD_SHADOW_CASCADE_STEPS[ci];
          }
          device.queue.writeBuffer(cache.shadowCascadeUniformBuffer!, 0, cud);

          const cascadePass = encoder.beginRenderPass(
            timedCloudPass(context, {
              label: "CloudShadow cascade atlas pass",
              colorAttachments: [
                {
                  view: cache.shadowCascadeView!,
                  clearValue: { r: 0, g: 0, b: 0, a: 0 },
                  loadOp: "clear",
                  storeOp: "store",
                },
              ],
            }),
          );
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
          cache.shadowCascadeActive = frameOk;
          // The atlas is one render pass carrying `CLOUD_SHADOW_CASCADE_COUNT`
          // viewport-scoped draws. Counting it as one pass and recording the
          // tile count separately keeps `shadowPassCount` comparable with the
          // profiler's pass ledger.
          counters.shadowPassCount++;
          counters.shadowCascadeSize = cache.shadowCascadeSize;
          counters.shadowCascadeCount = CLOUD_SHADOW_CASCADE_COUNT;
        }
      }
    }
  }
  stages.endStage(CloudCpuStage.SHADOW);
  stages.beginStage(CloudCpuStage.COMPOSITE);

  if (
    halfResActive &&
    cache.halfView &&
    cache.halfPipeline &&
    cache.upscalePipeline &&
    cache.upscaleBindGroupLayout &&
    cache.upscaleUniformBuffer &&
    cache.upscaleSampler
  ) {
    // Attachment resources are resolved before the march: the transform check
    // and the allocation sit above the raymarch because the emitting variant
    // needs contract slot 1 to exist as a colour attachment of the march pass
    // itself. With the attachment stage off, neither call runs.
    const attachmentStageActive = cache.attachmentsEnabled && !!cache.halfView;
    let attachmentsReady = false;
    if (attachmentStageActive) {
      const attachmentTransformValid = resolveCloudInverseCurrentVpRte(
        temporalReprojectionSupported,
        us?.inverseProjection,
        us?.inverseView,
      );
      attachmentsReady =
        attachmentTransformValid &&
        ensureCloudAttachmentResources(
          device,
          cache,
          cache.halfWidth,
          cache.halfHeight,
          cache.halfView,
        );
    }
    // The emitting march runs only when both halves of the handshake built. A
    // half-applied variant — a march emitting into a target no producer reads,
    // or a producer expecting a slot the march never wrote — is never encoded,
    // and the frame falls back to the estimator path instead.
    const emitReconstruction =
      attachmentsReady && cloudReconstructionVariantReady(cache);

    // Half-resolution path, first pass: raymarch into the half-size rgba16float
    // target, cleared to transparent so non-cloud texels stay at 0, with the
    // shader emitting premultiplied cloud colour and alpha. When emitting, the
    // same pass also writes contract slot 1 from the march's own per-sample
    // accumulation, so the depth is a by-product of one traversal rather than a
    // second march.
    const halfPass = encoder.beginRenderPass(
      timedCloudPass(context, {
        label: "ProceduralClouds half-res pass",
        colorAttachments: emitReconstruction
          ? [
              {
                view: cache.halfView,
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
                loadOp: "clear" as const,
                storeOp: "store" as const,
              },
              {
                view: cache.attachmentViews[CLOUD_MARCH_EMITTED_SLOT - 1]!,
                // The contract's own sentinel: a texel the triangle somehow
                // misses must read "no cloud", never distance zero.
                clearValue:
                  CLOUD_OWNED_ATTACHMENTS[CLOUD_MARCH_EMITTED_SLOT - 1]
                    .clearValue,
                loadOp: "clear" as const,
                storeOp: "store" as const,
              },
            ]
          : [
              {
                view: cache.halfView,
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
                loadOp: "clear" as const,
                storeOp: "store" as const,
              },
            ],
      }),
    );
    halfPass.setPipeline(
      emitReconstruction ? cache.halfEmitPipeline! : cache.halfPipeline,
    );
    halfPass.setBindGroup(0, bindGroup);
    halfPass.draw(3); // full-screen triangle
    halfPass.end();
    cache.reconstructionEmittedThisFrame = emitReconstruction;

    // The reconstruction attachment producer. It runs between the raymarch and
    // the temporal resolve, so a consumer can read the set inside the resolve
    // without anything being reordered, and it writes front and
    // transmittance-weighted cloud depth, screen-space motion with its validity
    // flag, and the depth/coverage moment pair.
    //
    // With `attachmentsEnabled` false this block does not run at all: no target
    // is allocated and no pass is encoded. With it on but `reconstructionEnabled`
    // clear, the producer writes and the counters report while the upscale still
    // reads what it read before, which is the produced-but-unconsumed state.
    // With both on, the march wrote slot 1 itself, this pass reads it and writes
    // the remaining two, and the resolve below validates history against the set.
    //
    // A usable current inverse view-projection-relative-to-eye is required:
    // without it the per-pixel ray direction is meaningless and every channel
    // would be noise. Orthographic and morph frames therefore produce no
    // attachments until reconstruction carries a per-pixel ray origin.
    if (attachmentStageActive) {
      if (attachmentsReady && cache.attachmentUniformBuffer) {
        const attachmentCurrentCamera = us?.cameraPosition ?? camPos;
        const attachmentPreviousCamera = us?.previousCameraPosition;
        // Only the velocity channel needs history. Depth and moments are well
        // defined on a frame that has none — first use, a reset, a teleport — so
        // a missing previous transform marks velocity invalid rather than
        // suppressing the whole set.
        const attachmentReprojectionValid =
          matrix4IsFinite(us?.previousViewProjectionRelativeToEye) &&
          cloudCameraPairIsFinite(
            attachmentCurrentCamera,
            attachmentPreviousCamera,
          );
        const inputs =
          cache.attachmentUniformInputs as MutableCloudAttachmentUniformInputs;
        inputs.previousViewProjectionRelativeToEye = attachmentReprojectionValid
          ? (us?.previousViewProjectionRelativeToEye ?? null)
          : null;
        inputs.inverseCurrentViewProjectionRelativeToEye =
          scratchInverseCurrentViewProjectionRelativeToEye;
        // The same encoded high/low camera split the primary march packed into
        // slots 120-127, so both derive the planet centre from one origin.
        inputs.encodedCameraHighX = data[120];
        inputs.encodedCameraHighY = data[121];
        inputs.encodedCameraHighZ = data[122];
        inputs.encodedCameraLowX = data[124];
        inputs.encodedCameraLowY = data[125];
        inputs.encodedCameraLowZ = data[126];
        inputs.cameraGeodeticHeight =
          frameState.camera?.positionCartographic?.height ?? 0.0;
        // Both operands are JS numbers (f64); only the per-frame-small result
        // is down-cast when the packer writes it.
        inputs.cameraDeltaX = attachmentReprojectionValid
          ? attachmentCurrentCamera!.x - attachmentPreviousCamera!.x
          : 0.0;
        inputs.cameraDeltaY = attachmentReprojectionValid
          ? attachmentCurrentCamera!.y - attachmentPreviousCamera!.y
          : 0.0;
        inputs.cameraDeltaZ = attachmentReprojectionValid
          ? attachmentCurrentCamera!.z - attachmentPreviousCamera!.z
          : 0.0;
        // Slot 145 is the resolved far cap (0 means "no cap"). Dividing the
        // moment pair by zero would publish NaN, so an uncapped march
        // normalizes by the planetary fallback instead.
        inputs.depthNormalizationMeters =
          data[145] > 0.0
            ? data[145]
            : CLOUD_ATTACHMENT_DEFAULT_DEPTH_NORMALIZATION_METERS;
        inputs.width = cache.halfWidth;
        inputs.height = cache.halfHeight;
        inputs.reprojectionValid = attachmentReprojectionValid;
        inputs.deckBottom = config.cloudLayerBottom ?? 1500.0;
        inputs.deckTop = config.cloudLayerTop ?? 4000.0;
        inputs.deckLowBottom = deckBounds[0][0];
        inputs.deckLowTop = deckBounds[0][1];
        inputs.deckMidBottom = deckBounds[1][0];
        inputs.deckMidTop = deckBounds[1][1];
        inputs.deckHighBottom = deckBounds[2][0];
        inputs.deckHighTop = deckBounds[2][1];
        inputs.multiDeck = multiDeckOn;
        inputs.generation = cache.attachmentGeneration.generation;
        packCloudAttachmentUniforms(cache.attachmentUniformData, inputs);
        device.queue.writeBuffer(
          cache.attachmentUniformBuffer,
          0,
          cache.attachmentUniformData,
        );

        // The emitting variant's target list starts at contract slot 2, because
        // slot 1 was already written by the march this pass reads it from. Both
        // lists come from the contract table, so the pipeline's formats and the
        // attachment list cannot disagree.
        //
        // The pass label below is spelled out rather than routed through
        // `CLOUD_ATTACHMENT_PASS_LABEL` because the observability check reads
        // the encode sites as source text; the constant and the literal are
        // pinned equal by `cloud-reconstruction-attachments.spec.mjs`.
        const producedAttachments = emitReconstruction
          ? CLOUD_EMITTED_ATTACHMENTS
          : CLOUD_OWNED_ATTACHMENTS;
        const producedViewOffset = emitReconstruction ? 1 : 0;
        const attachmentPass = encoder.beginRenderPass(
          timedCloudPass(context, {
            label: "CloudReconstructionAttachments pass",
            // Every target is cleared, so a texel the full-screen triangle
            // somehow misses reads as no cloud, no motion and no variance
            // rather than as the previous generation's contents.
            colorAttachments: producedAttachments.map((spec, index) => ({
              view: cache.attachmentViews[index + producedViewOffset]!,
              clearValue: spec.clearValue,
              loadOp: "clear" as const,
              storeOp: "store" as const,
            })),
          }),
        );
        attachmentPass.setPipeline(
          emitReconstruction
            ? cache.attachmentEmitPipeline!
            : cache.attachmentPipeline!,
        );
        attachmentPass.setBindGroup(
          0,
          emitReconstruction
            ? cache.attachmentEmitBindGroup!
            : cache.attachmentBindGroup!,
        );
        attachmentPass.draw(3); // full-screen triangle
        attachmentPass.end();
        cache.attachmentRenderedThisFrame = true;

        counters.attachmentWidth = cache.halfWidth;
        counters.attachmentHeight = cache.halfHeight;
        counters.attachmentPixels = cache.halfWidth * cache.halfHeight;
        // The contract set is always three targets; what changes with the
        // variant is which pass wrote each one, not how many exist.
        counters.attachmentCount = cache.attachmentViews.length;
        counters.attachmentGeneration = cache.attachmentGeneration.generation;
        counters.reconstructionEmitted = emitReconstruction ? 1 : 0;
        counters.reconstructionProducerTargets = producedAttachments.length;
      }
    }

    // The temporal resolve, between the raymarch and the upscale. It reprojects
    // the previous accumulated history through the relative-to-eye
    // `previousViewProjectionRelativeToEye`, clamps it to the axis-aligned
    // bounding box of the current 3×3 freshly marched neighbourhood to reject
    // ghosting, blends, and writes the new accumulated history. The upscale then
    // reads that history instead of the raw half-resolution march. With temporal
    // off the whole block is skipped.
    let upscaleSourceView: GPUTextureView = cache.halfView;
    if (
      temporalActive &&
      cache.temporalPipeline &&
      cache.temporalBindGroupLayout &&
      cache.temporalUniformBuffer &&
      cache.temporalSampler &&
      cache.temporalHistoryView[0] &&
      cache.temporalHistoryView[1] &&
      cache.temporalBindGroups[0] &&
      cache.temporalBindGroups[1]
    ) {
      stages.beginStage(CloudCpuStage.TEMPORAL);
      const readIdx = cache.temporalRead & 1;
      const writeIdx = readIdx ^ 1;
      const writeView = cache.temporalHistoryView[writeIdx]!;

      // Compare against the last frame that actually wrote cloud history rather
      // than against `UniformState`'s immediately preceding scene frame. That
      // catches culling and disable gaps and tier re-entry, while leaving
      // ordinary bounded camera motion accepted.
      const previousVpRte = us?.previousViewProjectionRelativeToEye;
      const inverseProjection = us?.inverseProjection;
      const inverseView = us?.inverseView;
      const currentCamera = us?.cameraPosition ?? camPos;
      const previousCamera = us?.previousCameraPosition;
      // The previous transform is checked here rather than inside the helper:
      // the temporal resolve cannot run without it, while the attachment
      // producer can, since its velocity channel carries its own validity flag.
      const inverseCurrentVpRteValid =
        matrix4IsFinite(previousVpRte) &&
        resolveCloudInverseCurrentVpRte(
          temporalReprojectionSupported,
          inverseProjection,
          inverseView,
        );

      // Written out rather than routed through `cloudCameraPairIsFinite` so
      // TypeScript still narrows both operands for the delta below.
      const transformsValid =
        inverseCurrentVpRteValid &&
        currentCamera !== undefined &&
        previousCamera !== undefined &&
        Number.isFinite(currentCamera.x) &&
        Number.isFinite(currentCamera.y) &&
        Number.isFinite(currentCamera.z) &&
        Number.isFinite(previousCamera.x) &&
        Number.isFinite(previousCamera.y) &&
        Number.isFinite(previousCamera.z);
      // Both operands are JS numbers (f64). Only the per-frame-small result is
      // down-cast when written to the uniform buffer.
      const cameraDeltaX = transformsValid
        ? currentCamera.x - previousCamera.x
        : 0.0;
      const cameraDeltaY = transformsValid
        ? currentCamera.y - previousCamera.y
        : 0.0;
      const cameraDeltaZ = transformsValid
        ? currentCamera.z - previousCamera.z
        : 0.0;
      const layerBottom = config.cloudLayerBottom ?? 1500.0;
      const layerTop = config.cloudLayerTop ?? 4000.0;
      const historySample = cache.temporalHistorySample;
      historySample.frameNumber = frameState.frameNumber;
      historySample.temporalActive = true;
      historySample.transformValid = transformsValid;
      historySample.cameraX = currentCamera?.x ?? 0.0;
      historySample.cameraY = currentCamera?.y ?? 0.0;
      historySample.cameraZ = currentCamera?.z ?? 0.0;
      historySample.sceneMode = frameState.mode;
      historySample.morphing = frameState.mode === SceneMode.MORPHING;
      historySample.projectionType = temporalProjectionOrthographic ? 1 : 0;
      historySample.deckBottom = layerBottom;
      historySample.deckTop = layerTop;
      historySample.multiDeck = multiDeckOn;

      const temporalResetReasons =
        classifyCloudTemporalHistoryReset(
          cache.temporalHistoryState,
          historySample,
        ) | cache.temporalHistoryPendingResetReasons;
      cache.temporalHistoryPendingResetReasons = 0;
      // The per-frame history verdict, recorded on the same branches that
      // maintain the lifetime totals so the two cannot disagree. `historyReset`
      // follows `temporalHistoryResetCount` exactly and marks only the
      // rejections that started a new generation, so a persistent reason such as
      // an in-progress morph does not read as a fresh reset every frame.
      counters.historyResetReasons = temporalResetReasons;
      if (temporalResetReasons !== 0) {
        cache.temporalFirstFrame = true;
        counters.historyRejected = 1;
        if (
          cloudTemporalResetStartsGeneration(
            cache.temporalHistoryLatchedResetReasons,
            temporalResetReasons,
          )
        ) {
          cache.temporalHistoryGeneration++;
          cache.temporalHistoryResetCount++;
          counters.historyReset = 1;
        }
        cache.temporalHistoryLatchedResetReasons |= temporalResetReasons;
      } else if (!cache.temporalFirstFrame) {
        cache.temporalHistoryAcceptedFrames++;
        cache.temporalHistoryLatchedResetReasons = 0;
        counters.historyAccepted = 1;
      }
      cache.temporalHistoryResetReasons = temporalResetReasons;

      // Pack TemporalUniforms (60 floats — byte-locked to
      // CloudTemporalResolve.wgsl). Clear first so a missing transform cannot
      // reuse stale matrix values from an earlier valid frame.
      const td = cache.temporalUniformData;
      td.fill(0.0);
      let to = 0;
      // previousViewProjectionRelativeToEye (mat4, 16), column-major.
      if (matrix4IsFinite(previousVpRte)) {
        for (let i = 0; i < 16; i++) td[to++] = previousVpRte[i];
      } else {
        to += 16;
      }
      // inverseCurrentViewProjectionRelativeToEye (mat4, 16).
      if (inverseCurrentVpRteValid) {
        for (let i = 0; i < 16; i++) {
          td[to++] = scratchInverseCurrentViewProjectionRelativeToEye[i];
        }
      } else {
        to += 16;
      }
      // encodedCameraHighAndBlend (vec4). Reuse the primary march's exact
      // high/low split so both paths share one camera origin.
      td[to++] = data[120];
      td[to++] = data[121];
      td[to++] = data[122];
      td[to++] = Math.max(
        1 / 16,
        Math.min(1, cloudPreset.temporalUpdateFraction || 1 / 8),
      );
      // encodedCameraLowAndHeight (vec4): low split + CPU-f64 WGS84 height.
      td[to++] = data[124];
      td[to++] = data[125];
      td[to++] = data[126];
      td[to++] = frameState.camera?.positionCartographic?.height ?? 0.0;
      // cameraDeltaAndWidth (vec4).
      td[to++] = cameraDeltaX;
      td[to++] = cameraDeltaY;
      td[to++] = cameraDeltaZ;
      td[to++] = cache.halfWidth;
      // primaryDeckAndResolutionY (vec4).
      td[to++] = layerBottom;
      td[to++] = layerTop;
      td[to++] = cache.halfHeight;
      td[to++] = 0.0;
      // Low and middle multi-deck bounds.
      td[to++] = deckBounds[0][0];
      td[to++] = deckBounds[0][1];
      td[to++] = deckBounds[1][0];
      td[to++] = deckBounds[1][1];
      // High bounds + topology/history-validity flags.
      td[to++] = deckBounds[2][0];
      td[to++] = deckBounds[2][1];
      td[to++] = multiDeckOn ? 1.0 : 0.0;
      td[to++] = cache.temporalFirstFrame ? 1.0 : 0.0;
      // Probe-visible diagnostics (the shader does not branch on this row).
      td[to++] = cache.temporalHistoryGeneration;
      td[to++] = temporalResetReasons;
      td[to++] = frameState.frameNumber;
      td[to++] = 0.0;
      device.queue.writeBuffer(cache.temporalUniformBuffer, 0, td);

      // Consumption is gated on the attachments having been produced this frame
      // through `attachmentRenderedThisFrame`, not merely on their being
      // allocated. A frame whose producer was skipped — no usable inverse
      // transform, or a culled march — would otherwise validate this frame's
      // history against the previous frame's motion vectors.
      const consumeReconstruction =
        cache.reconstructionEnabled &&
        cache.attachmentRenderedThisFrame &&
        ensureCloudTemporalConsumeBindGroups(device, cache);
      const temporalBindGroup = consumeReconstruction
        ? cache.temporalConsumeBindGroups[readIdx]!
        : cache.temporalBindGroups[readIdx]!;
      const temporalPass = encoder.beginRenderPass(
        timedCloudPass(context, {
          label: "CloudTemporalResolve pass",
          colorAttachments: [
            {
              view: writeView,
              // No clear: the shader writes every texel (full-screen triangle).
              loadOp: "load",
              storeOp: "store",
            },
          ],
        }),
      );
      temporalPass.setPipeline(
        consumeReconstruction
          ? cache.temporalConsumePipeline!
          : cache.temporalPipeline,
      );
      temporalPass.setBindGroup(0, temporalBindGroup);
      temporalPass.draw(3);
      temporalPass.end();
      cache.reconstructionConsumedThisFrame = consumeReconstruction;
      counters.reconstructionConsumed = consumeReconstruction ? 1 : 0;

      // The upscale reads the freshly-written, accumulated history.
      upscaleSourceView = writeView;
      // Ping-pong the history: the next frame reads what this one wrote.
      cache.temporalRead = writeIdx;
      commitCloudTemporalHistoryState(
        cache.temporalHistoryState,
        historySample,
        true,
      );
      cache.temporalFirstFrame = false;
      stages.endStage(CloudCpuStage.TEMPORAL);
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

    const upscaleBindGroup = getOrCreateCloudUpscaleBindGroup(
      device,
      cache,
      upscaleSourceView,
      colorTextureView,
      depthTextureView,
    );
    const upscalePass = encoder.beginRenderPass(
      timedCloudPass(context, {
        label: "CloudUpscale composite pass",
        colorAttachments: [
          {
            view: outputView,
            loadOp: "load",
            storeOp: "store",
          },
        ],
      }),
    );
    upscalePass.setPipeline(cache.upscalePipeline);
    upscalePass.setBindGroup(0, upscaleBindGroup);
    upscalePass.draw(3);
    upscalePass.end();
  } else {
    // Full-resolution path: march straight into the output view.
    const pass = encoder.beginRenderPass(
      timedCloudPass(context, {
        label: "ProceduralClouds pass",
        colorAttachments: [
          {
            view: outputView,
            loadOp: "load",
            storeOp: "store",
          },
        ],
      }),
    );
    pass.setPipeline(cache.pipeline!);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3); // full-screen triangle
    pass.end();
  }

  // The screen-space cloud transmittance mask, rendered only when a consumer has
  // requested it. It reuses the main per-frame bind group, which has the layout
  // and inputs it needs, with a dedicated r8unorm pipeline and target driven by
  // the `fragmentCloudMaskMain` entry point, so the composite passes above are
  // untouched.
  if (cache.maskCaptureEnabled) {
    ensureCloudMaskResources(device, cache, canvasW, canvasH);
    if (cache.maskPipeline && cache.maskView) {
      const maskPass = encoder.beginRenderPass(
        timedCloudPass(context, {
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
        }),
      );
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
  stages.endStage(CloudCpuStage.COMPOSITE);
  stages.endStage(CloudCpuStage.TOTAL);
  return true;
}

/**
 * Lazily allocates the transmittance-mask target and pipeline; only reached once
 * a consumer has enabled capture. The r8unorm target is recreated on canvas
 * resize, while the pipeline is size-independent and is built once from the
 * retained cloud shader module and the shared cloud bind-group layout.
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
    // Half-resolution target and upscale resources.
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
    clearCloudCompositeBindGroupCaches(cache);
    // Temporal ping-pong history and resolve resources.
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
    cache.temporalBindGroups = [null, null];
    cache.temporalSampler = null;
    cache.temporalHistoryState = createCloudTemporalHistoryState();
    cache.temporalHistorySample = createCloudTemporalHistorySample();
    cache.temporalHistoryLatchedResetReasons = 0;
    cache.temporalHistoryPendingResetReasons = 0;
    cache.temporalHistoryGeneration = 0;
    cache.temporalHistoryResetReasons = 0;
    cache.temporalHistoryResetCount = 0;
    cache.temporalHistoryAcceptedFrames = 0;
    // The LUT placeholder and its sampler. The real LUT textures are owned by
    // the performance manager, not by this cache.
    cache.lutPlaceholderTexture?.destroy();
    cache.lutPlaceholderTexture = null;
    cache.lutPlaceholderView = null;
    cache.lutSampler = null;
    // Beer shadow map resources.
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
    // Cascade atlas and its uniform buffer.
    cache.shadowCascadeTexture?.destroy();
    cache.shadowCascadeTexture = null;
    cache.shadowCascadeView = null;
    cache.shadowCascadeUniformBuffer?.destroy();
    cache.shadowCascadeUniformBuffer = null;
    cache.shadowCascadeActive = false;
    cache.shadowCascadeSize = 0;
    // Transmittance-mask target and pipeline.
    cache.maskTexture?.destroy();
    cache.maskTexture = null;
    cache.maskView = null;
    cache.maskWidth = 0;
    cache.maskHeight = 0;
    cache.maskPipeline = null;
    cache.maskShaderModule = null;
    cache.maskRenderedThisFrame = false;
    // Reconstruction attachments. The targets and the bind group go through the
    // shared release, which keeps the generation counter monotonic so a retired
    // bind group's key can never be reused; the pipeline, layout and uniform
    // buffer are device-owned and only a teardown drops them.
    releaseCloudAttachmentResources(cache);
    cache.attachmentPipeline = null;
    cache.attachmentBindGroupLayout = null;
    cache.attachmentUniformBuffer?.destroy();
    cache.attachmentUniformBuffer = null;
    // The variant pipelines and layouts are device-owned exactly as the base
    // ones are, so they are dropped here and only here. Destroying them on a
    // flag flip would rebuild a pipeline on a user toggle, which is the hitch
    // the separate-object design avoids.
    cache.halfEmitPipeline = null;
    cache.attachmentEmitPipeline = null;
    cache.attachmentEmitBindGroupLayout = null;
    cache.temporalConsumePipeline = null;
    cache.temporalConsumeBindGroupLayout = null;
    cache.initialized = false;
    context._cloudCache = undefined;
  }
}
