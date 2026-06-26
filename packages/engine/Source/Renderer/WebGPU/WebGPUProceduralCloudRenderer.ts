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
} from "./WebGPUCloudTierPresets.js";
import { buildCloudNoiseResources } from "./WebGPUCloudNoiseResources.js";
import type { CloudNoiseResources } from "./WebGPUCloudNoiseResources.js";
// V11 (Batch 408) — per-genus vertical-density profiles. Backend-neutral Scene
// data (the WGSL just reads the packed profile floats).
import CloudTypeProfile from "../../Scene/CloudTypeProfile.js";
import CloudType from "../../Scene/CloudType.js";

// Weather Phase 1 grew the struct 64→80 (added the weather-map seam lanes).
const CLOUD_UNIFORM_FLOATS = 108; // must match CloudUniforms struct in WGSL (Batch 408: +104-107)
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
  weatherFilled: boolean; // procedural fill uploaded once
  // V2 — 3D noise bake (bound at 6/7/8; INERT until V3 samples it).
  noise: CloudNoiseResources | null;
  noiseBaked: boolean;
  noiseFallbackTexture: GPUTexture | null;
  noiseFallbackView: GPUTextureView | null; // 1×1×1 white 3D, bound until baked
  noiseFallbackSampler: GPUSampler | null;
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
      weatherFilled: false,
      noise: null,
      noiseBaked: false,
      noiseFallbackTexture: null,
      noiseFallbackView: null,
      noiseFallbackSampler: null,
    };
  }
  return context._cloudCache;
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
  if (!cache.weatherFilled) {
    const tex = device.createTexture({
      size: {
        width: WEATHER_TEX_W,
        height: WEATHER_TEX_H,
        depthOrArrayLayers: 1,
      },
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      dimension: "2d",
      label: "Procedural WeatherMap",
    });
    device.queue.writeTexture(
      { texture: tex },
      buildProceduralWeatherMap(WEATHER_TEX_W, WEATHER_TEX_H),
      { bytesPerRow: WEATHER_TEX_W * 4, rowsPerImage: WEATHER_TEX_H },
      {
        width: WEATHER_TEX_W,
        height: WEATHER_TEX_H,
        depthOrArrayLayers: 1,
      },
    );
    cache.weatherTexture = tex;
    cache.weatherView = tex.createView({ dimension: "2d-array" });
    cache.weatherFilled = true;
  }
  return cache.weatherView!;
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

  // resolution + pad
  const canvas = context._canvas;
  data[offset++] = canvas?.width ?? 1920;
  data[offset++] = canvas?.height ?? 1080;
  data[offset++] = 0;
  data[offset++] = 0;

  // Weather Phase 1 — weather-map seam lanes (floats 64-79).
  const weatherEnabled = globe.cloudWeatherMap === true;
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
  data[offset++] =
    noiseBakedBit |
    ((Math.min(7, cloudPreset.multiScatterOctaves) & 7) <<
      CLOUD_QF_OCTAVES_SHIFT); // 74 qualityFlags
  data[offset++] = 0; // 75 reserved (V8 curlAmplitude)
  data[offset++] = 0; // 76 reserved (V6 frameCounter)
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
  data[offset++] = 0; // 105 pad
  data[offset++] = 0; // 106 pad
  data[offset++] = 0; // 107 pad

  device.queue.writeBuffer(cache.uniformBuffer!, 0, data);

  // Weather Phase 1 — resolve the weather view (procedural map when enabled,
  // 1×1 white fallback otherwise).
  const weatherView = ensureWeatherView(device, cache, weatherEnabled);
  // `noise` (the 3D shape/detail views + sampler) was resolved up-front so the
  // qualityFlags noiseSource bit reflects the same-frame baked state.

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
    cache.initialized = false;
    context._cloudCache = undefined;
  }
}
