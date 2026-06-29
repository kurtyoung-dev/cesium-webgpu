/// <reference types="@webgpu/types" />
/**
 * WebGPU Procedural Cloud Renderer
 *
 * Renders volumetric clouds as a full-screen pass using ray marching.
 * Activated via `globe.showProceduralClouds = true`.
 *
 * Configuration on Globe:
 *   - showProceduralClouds: boolean (default false)
 *   - cloudCoverage: number 0-1 (default 0.5)
 *   - cloudLayerBottom: number meters (default 1500)
 *   - cloudLayerTop: number meters (default 4000)
 *   - cloudWindSpeed: number m/s (default 15)
 *   - cloudWindDirection: Cartesian2 (default {x: 0.7, y: 0.3})
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
} from "./WebGPUCloudTierPresets.js";
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
// (Batch 434 atmosphere-LUT coupling: aerialLutMode/ambientLutMode/atmosphereThickness/pad 108-111).
const CLOUD_UNIFORM_FLOATS = 112; // MUST equal the CloudUniforms struct length in WGSL
const CLOUD_UNIFORM_BYTES = CLOUD_UNIFORM_FLOATS * 4;
// Procedural weather-map texture (coarse global coverage field).
const WEATHER_TEX_W = 256;
const WEATHER_TEX_H = 128;

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
    };
  }
  return context._cloudCache;
}

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
  if (!cache.noiseBaked) {
    const res = buildCloudNoiseResources(device, 128, 32);
    if (res) {
      cache.noise = res;
      cache.noiseBaked = true;
    }
  }
  if (cache.noiseBaked && cache.noise) {
    return {
      shapeView: cache.noise.shapeSampleView,
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
  globe: CesiumGlobe,
): void {
  const device = context._device;
  if (!device) return;

  // Frustum cull (Batch 413) — the cloud shell is a sphere at the planet origin
  // (radius = planetRadius + cloudLayerTop). Skip the full-screen raymarch
  // entirely when that sphere is outside the view frustum (e.g. the globe panned
  // off-screen in space). For a sphere centered at the world origin the signed
  // distance to each frustum plane is just `plane.w` (dot(normal, 0) + w), so the
  // shell is OUTSIDE iff some plane has w < -outerR — matching Cesium
  // BoundingSphere.intersectPlane (OUTSIDE when distanceToPlane < -radius).
  // Perf-only: ZERO visual change while any of the shell is in view (so the
  // cloud probes, which all look at the globe, stay green).
  const planes = frameState.cullingVolume?.planes;
  if (planes !== undefined && planes.length > 0) {
    const outerR = 6378137.0 + (globe.cloudLayerTop ?? 4000.0);
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
  const noise = ensureNoiseBaked(device, cache);

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
    | { dayNumber: number; secondsOfDay: number }
    | undefined;
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
  data[offset++] = globe.atmosphereLightIntensity ?? 10.0; // sunIntensity

  // Cloud layer params
  data[offset++] = globe.cloudLayerBottom ?? 1500.0;
  data[offset++] = globe.cloudLayerTop ?? 4000.0;
  data[offset++] = 6378137.0; // planetRadius
  data[offset++] = globe.cloudCoverage ?? 0.5;

  // Quality params (Phase 6d/6b resolver).
  // Reads `globe.cloudVolumetricQuality` preset string + camera
  // altitude + the AtmosphericConditions enable/disable altitudes for
  // auto mode. Falls back verbatim to `globe.cloudQuality` when the
  // user has hand-tuned that field to a non-default value.
  const atmoClouds = (
    globe as unknown as {
      atmosphericConditions?: {
        clouds?: {
          volumetricEnableAltitude?: number;
          volumetricDisableAltitude?: number;
        };
      };
    }
  ).atmosphericConditions?.clouds;
  const globeForQuality = globe as unknown as {
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
  data[offset++] = globe.cloudDensity ?? 0.3;
  data[offset++] = 0.04; // absorptionCoeff

  // Wind
  const windDir = globe.cloudWindDirection;
  data[offset++] = windDir?.x ?? 0.7;
  data[offset++] = windDir?.y ?? 0.3;
  data[offset++] = globe.cloudWindSpeed ?? 15.0;
  // Config — silver-lining intensity (live via atmosphericConditions.clouds.silverLining).
  data[offset++] = globe.cloudSilverLiningIntensity ?? 0.8; // silverLiningIntensity

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

  // resolution + pad. V9 (Batch 432) — when half-res is active this is the HALF-RES
  // target size so the shader's Bayer jitter step (1/resolution) is one half-res
  // texel; the full-res path keeps the canvas size (jitter branch is skipped, so
  // the value is byte-irrelevant there but stays the canvas size as before).
  data[offset++] = halfResActive ? cache.halfWidth : canvasW;
  data[offset++] = halfResActive ? cache.halfHeight : canvasH;
  data[offset++] = 0;
  data[offset++] = 0;

  // Weather Phase 1 — weather-map seam lanes (floats 64-79).
  // Ingest (Phase 1): if a WeatherProvider has real data, use it AND auto-enable
  // the weather map (so real cloud-cover drives the deck without the user setting
  // cloudWeatherMap). getPackedTexture returns null until the async fetch lands —
  // until then the renderer keeps the procedural map (no overcast-everywhere flash).
  const weatherProvider = globe.weatherProvider;
  const providerBytes =
    weatherProvider?.getPackedTexture(WEATHER_TEX_W, WEATHER_TEX_H) ?? null;
  const providerVersion = weatherProvider?.version ?? -1;
  const weatherEnabled =
    globe.cloudWeatherMap === true || providerBytes !== null;
  data[offset++] = weatherEnabled ? 1.0 : 0.0; // 64 weatherMapEnabled
  // 65 weatherStrength — the global cloudCoverage folded in as a per-cell
  // multiplier (default coverage 0.5 → 1.0 neutral so the map's R drives directly).
  data[offset++] = (globe.cloudCoverage ?? 0.5) * 2.0;
  // 66/67 — W1 dual-lobe phase: back-scatter g + forward/back blend. Config —
  // live via atmosphericConditions.clouds.phaseBackG / .phaseBlend.
  data[offset++] = globe.cloudPhaseBackG ?? -0.3; // 66 phaseG2
  data[offset++] = globe.cloudPhaseBlend ?? 0.7; // 67 phaseBlend
  // 68-71 weatherTexBounds — global equirect (radians): minLon, minLat, lonRange, latRange.
  data[offset++] = -Math.PI;
  data[offset++] = -Math.PI / 2.0;
  data[offset++] = 2.0 * Math.PI;
  data[offset++] = Math.PI;
  // 72 — W1 forward-scatter g. Sharper than the old hardcoded 0.8 for a stronger
  // silver lining toward the sun (HG forward peak at g=0.85 is ~1.8x g=0.8).
  data[offset++] = globe.cloudPhaseForwardG ?? 0.85; // 72 phaseG1 (config: .phaseForwardG)
  // 73 — W2 ambient intensity (sky/ground fill on the shadow side; config: .ambientIntensity).
  data[offset++] = globe.cloudAmbientIntensity ?? 1.5; // 73 ambientIntensity
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
  data[offset++] = 0; // 75 reserved (V8 curlAmplitude)
  // 76 — V9 frameCounter (Bayer jitter index for the half-res sub-pixel offset).
  // Only consumed when QF_HALF_RES is set; full-res ignores it (jitter branch
  // skipped), so writing it is byte-irrelevant on the default path. Wraps at 16
  // (the Bayer LUT length) to keep the f32 store exact.
  cache.frameCounter = (cache.frameCounter + 1) & 15;
  data[offset++] = halfResActive ? cache.frameCounter : 0; // 76 frameCounter
  data[offset++] = 0; // 77 reserved (V8 curlFrequency)
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
    globe.cloudErosionStrength ?? (cloudPreset.tier <= 1 ? 0.1 : 0.18); // 79 erosionStrength
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
  // scale baked into the shader; 0 disables). Dialable via globe.cloudAerialStrength.
  data[offset++] = globe.cloudAerialStrength ?? 1.0; // 91 aerialStrength
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
  // globe fields unset this is byte-identical to the pre-407 render.
  data[offset++] = globe.cloudPuffSize ?? 0.45; // 96 puffSize (was SHAPE_SCALE)
  data[offset++] = globe.cloudExposure ?? 0.22; // 97 exposure (was CLOUD_EXPOSURE)
  data[offset++] = globe.cloudMsDecayScatter ?? 0.5; // 98 msDecayA
  data[offset++] = globe.cloudMsDecayExtinction ?? 0.5; // 99 msDecayB
  data[offset++] = globe.cloudMsDecayPhase ?? 0.85; // 100 msDecayC
  // ── Batch 408 — V11 per-genus vertical-density profile. globe.cloudType
  // (default CUMULUS) selects a CloudTypeProfile; CUMULUS → shape BILLOWY(1) +
  // densityScale 1.0, so the default render is byte-identical (the WGSL BILLOWY
  // branch is the literal old gradient).
  const profile = CloudTypeProfile.get(globe.cloudType ?? CloudType.CUMULUS);
  const cumulusBase = CloudTypeProfile.get(CloudType.CUMULUS).baseDensity; // 0.7
  data[offset++] = profile.shape; // 101 profileShape (0 SLAB / 1 BILLOWY / 2 TOWER)
  data[offset++] = cumulusBase > 0 ? profile.baseDensity / cumulusBase : 1.0; // 102 profileDensityScale (CUMULUS=1.0)
  data[offset++] = profile.extinction; // 103 profileExtinction (scaffolding; not yet sampled)
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
  // weatherMapEnabled=0 reproduces today's pixels. `globe.cloudWeatherChannelStrength`
  // tunes it live (0 = legacy R-only).
  data[offset++] = globe.cloudWeatherChannelStrength ?? 1.0; // 107 weatherChannelStrength
  // ── Batch 434 (3.3 CLOUD-AERIAL-LUT + 3.4 CLOUD-AMBIENT-LUT) — atmosphere-LUT
  // coupling modes (108-111). Both default to the legacy path: 'heuristic' aerial +
  // 'constant' ambient → mode floats 0 → the WGSL takes the verbatim legacy branch,
  // byte-identical. The qualityFlags bits (8/9) carry the same on/off below; the
  // mode floats are belt-and-suspenders for shader readers. atmosphereThickness MUST
  // match the LUT bake (ATMOSPHERE_THICKNESS = 111e3) so the transmittance v-lookup
  // lands on the right row.
  const globeForLut = globe as unknown as {
    cloudAerialMode?: string;
    cloudAmbientSource?: string;
  };
  const aerialLutOn = globeForLut.cloudAerialMode === "physical";
  const ambientLutOn = globeForLut.cloudAmbientSource === "sky-lut";
  data[offset++] = aerialLutOn ? 1.0 : 0.0; // 108 aerialLutMode
  data[offset++] = ambientLutOn ? 1.0 : 0.0; // 109 ambientLutMode
  data[offset++] = 111000.0; // 110 atmosphereThickness (matches the LUT bake)
  data[offset++] = 0.0; // 111 pad

  // Fold the two LUT-coupling bits into qualityFlags (slot 74, already packed
  // above). Add-only bits 8/9; set ONLY when the mode is on so the default render
  // leaves them clear → the WGSL gates stay closed → byte-identical.
  if (aerialLutOn || ambientLutOn) {
    let qf = data[74];
    if (aerialLutOn) qf = qf | CLOUD_QF_AERIAL_LUT;
    if (ambientLutOn) qf = qf | CLOUD_QF_AMBIENT_LUT;
    data[74] = qf;
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
      const innerR = 6378137.0 + (globe.cloudLayerBottom ?? 1500.0);
      const outerR = 6378137.0 + (globe.cloudLayerTop ?? 4000.0);
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

  if (!useMain) {
    device.queue.submit([encoder.finish()]);
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
    cache.initialized = false;
    context._cloudCache = undefined;
  }
}
