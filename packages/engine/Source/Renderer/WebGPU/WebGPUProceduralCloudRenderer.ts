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

// Weather Phase 1 grew the struct 64→80 (added the weather-map seam lanes).
const CLOUD_UNIFORM_FLOATS = 80; // must match CloudUniforms struct in WGSL
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
  const qualityResolved = resolveCloudQuality({
    preset: globeForQuality.cloudVolumetricQuality,
    rawCloudQuality: globeForQuality.cloudQuality,
    cameraHeightMeters: cameraHeightM,
    enableAltitudeMeters: atmoClouds?.volumetricEnableAltitude ?? 50_000,
    disableAltitudeMeters: atmoClouds?.volumetricDisableAltitude ?? 100_000,
  });
  data[offset++] = qualityResolved.maxSteps;
  data[offset++] = qualityResolved.lightSteps;
  data[offset++] = globe.cloudDensity ?? 0.3;
  data[offset++] = 0.04; // absorptionCoeff

  // Wind
  const windDir = globe.cloudWindDirection;
  data[offset++] = windDir?.x ?? 0.7;
  data[offset++] = windDir?.y ?? 0.3;
  data[offset++] = globe.cloudWindSpeed ?? 15.0;
  data[offset++] = 0.8; // silverLiningIntensity

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
  data[offset++] = 0; // 66 pad
  data[offset++] = 0; // 67 pad
  // 68-71 weatherTexBounds — global equirect (radians): minLon, minLat, lonRange, latRange.
  data[offset++] = -Math.PI;
  data[offset++] = -Math.PI / 2.0;
  data[offset++] = 2.0 * Math.PI;
  data[offset++] = Math.PI;
  // 72-79 reserved (multi-deck etc.)
  for (let i = 72; i < CLOUD_UNIFORM_FLOATS; i++) data[offset++] = 0;

  device.queue.writeBuffer(cache.uniformBuffer!, 0, data);

  // Weather Phase 1 — resolve the weather view (procedural map when enabled,
  // 1×1 white fallback otherwise).
  const weatherView = ensureWeatherView(device, cache, weatherEnabled);

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
