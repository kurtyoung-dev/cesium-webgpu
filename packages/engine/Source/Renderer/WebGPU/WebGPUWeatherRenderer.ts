/// <reference types="@webgpu/types" />
/**
 * WebGPU Weather Particle Renderer
 *
 * GPU-driven weather particle system using compute shaders for simulation
 * and instanced rendering for display. Supports rain, snow, fog, and hail.
 *
 * Activated via `scene.weather.enabled = true`.
 *
 * Configuration on scene.weather:
 *   - enabled: boolean (default false)
 *   - type: 'rain' | 'snow' | 'fog' | 'hail' (default 'rain')
 *   - intensity: number 0-1 (default 0.5)
 *   - windSpeed: number m/s (default 5.0)
 *   - windDirection: Cartesian3 (default {x: 1, y: 0, z: 0})
 *   - maxParticles: number (default 50000)
 *   - particleLifetime: number seconds (default 5.0)
 *   - particleSize: number (default 1.0)
 *   - turbulence: number 0-1 (default 0.3)
 *   - spawnRadius: number meters (default 500)
 *
 * @private
 */
import WeatherParticlesWGSL from "../../Shaders/WebGPU/Compute/WeatherParticles.js";
import WeatherParticleRenderWGSL from "../../Shaders/WebGPU/Compute/WeatherParticleRender.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  storageBuffer,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import { ShaderSourceId } from "./WebGPUShaderDefines.js";
import { WebGPUShaderModuleCache } from "./WebGPUShaderModuleCache.js";
import type {
  WebGPURenderPipelineCache,
  WebGPURenderPipelineDescriptor,
} from "./WebGPURenderPipelineCache.js";
import type { WebGPUComputePipelineCache } from "./WebGPUComputePipelineCache.js";

// Per-device shader module cache so two contexts with weather enabled
// share a single compiled `GPUShaderModule` for both the compute and
// render shaders. (C-R7-SHADER-MODULE-DEDUP, Batch 72.)
const _weatherShaderModuleCaches = new WeakMap<
  GPUDevice,
  WebGPUShaderModuleCache
>();

function getWeatherShaderModuleCache(
  device: GPUDevice,
): WebGPUShaderModuleCache {
  let cache = _weatherShaderModuleCaches.get(device);
  if (!cache) {
    cache = new WebGPUShaderModuleCache(device);
    _weatherShaderModuleCaches.set(device, cache);
  }
  return cache;
}

const WEATHER_TYPES = { rain: 0, snow: 1, fog: 2, hail: 3 } as const;
const PARTICLE_SIZE_BYTES = 32; // 8 floats per particle
const WEATHER_PARAMS_FLOATS = 24; // matches WeatherParams struct
const WEATHER_PARAMS_BYTES = WEATHER_PARAMS_FLOATS * 4;
// DP-H41 (Batch 27) — render-pass CameraUniforms now carries
// `previousViewProjection` (mat4x4, 64 bytes) at the tail for
// TAA / motion-vector reprojection. Total = 128 + 64 = 192.
const RENDER_UNIFORM_SIZE = 192;

export interface WeatherCache {
  resetPipeline: GPUComputePipeline | null;
  updatePipeline: GPUComputePipeline | null;
  emitPipeline: GPUComputePipeline | null;
  particleBuffer: GPUBuffer | null;
  counterBuffer: GPUBuffer | null;
  uniformBuffer: GPUBuffer | null;
  bindGroupLayout: GPUBindGroupLayout | null;
  bindGroup: GPUBindGroup | null;
  uniformData: Float32Array;
  maxParticles: number;
  initialized: boolean;
  // RTE: previous frame's camera position as a Float64 triple. We
  // subtract on the CPU in FP64 to produce a small `cameraDelta` vec3
  // that the compute shader applies to keep camera-relative particles
  // world-stationary. Without this, particles would visibly snap to a
  // ~0.6 m grid at Earth radius because FP32 precision is exhausted.
  prevCameraPosition: { x: number; y: number; z: number } | null;
  // Render pass resources
  renderPipeline: GPURenderPipeline | null;
  renderBindGroupLayout: GPUBindGroupLayout | null;
  renderBindGroup: GPUBindGroup | null;
  renderUniformBuffer: GPUBuffer | null;
  renderUniformData: Float32Array;
  renderInitialized: boolean;
  // C-R7-RENDERER-MIGRATION (Batch 72) — render pipeline arrives
  // asynchronously from `WebGPURenderPipelineCache.getPipeline()`. The
  // descriptor is held alongside the pipeline so re-resolution keys
  // off a stable shape.
  renderPipelineRequestPending: boolean;
  renderPipelineDescriptor: WebGPURenderPipelineDescriptor | null;
}

function ensureWeatherCache(context: CesiumGraphicsContext): WeatherCache {
  if (!context._weatherCache) {
    context._weatherCache = {
      resetPipeline: null,
      updatePipeline: null,
      emitPipeline: null,
      particleBuffer: null,
      counterBuffer: null,
      uniformBuffer: null,
      bindGroupLayout: null,
      bindGroup: null,
      uniformData: new Float32Array(WEATHER_PARAMS_FLOATS),
      maxParticles: 0,
      initialized: false,
      prevCameraPosition: null,
      renderPipeline: null,
      renderBindGroupLayout: null,
      renderBindGroup: null,
      renderUniformBuffer: null,
      renderUniformData: new Float32Array(RENDER_UNIFORM_SIZE / 4),
      renderInitialized: false,
      renderPipelineRequestPending: false,
      renderPipelineDescriptor: null,
    };
  }
  return context._weatherCache;
}

function initializeWeatherPipelines(
  device: GPUDevice,
  cache: WeatherCache,
  maxParticles: number,
  computePipelineCache: WebGPUComputePipelineCache | null,
): void {
  if (cache.initialized && cache.maxParticles === maxParticles) return;

  // Destroy old buffers on resize
  cache.particleBuffer?.destroy();
  cache.counterBuffer?.destroy();
  cache.uniformBuffer?.destroy();

  // C-R7-SHADER-MODULE-DEDUP (Batch 72) — route compute shader through
  // the per-device module cache. Compute pipelines themselves are NOT
  // cached centrally yet (no `WebGPUComputePipelineCache`), so the three
  // pipelines still go through `device.createComputePipeline()` directly
  // — but they do share a single deduped `GPUShaderModule`.
  const moduleCache = getWeatherShaderModuleCache(device);
  const shaderModule = moduleCache.getOrCreate(
    ShaderSourceId.WEATHER_PARTICLES_COMPUTE,
    WeatherParticlesWGSL,
    0,
    "WeatherParticles compute",
  );

  cache.bindGroupLayout = makeBindGroupLayout(device, "Weather BGL", [
    storageBuffer(0, Stage.COMPUTE),
    uniformBuffer(1, Stage.COMPUTE),
    storageBuffer(2, Stage.COMPUTE),
  ]);

  const pipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [cache.bindGroupLayout],
  });

  // C-R7-COMPUTE-PIPELINE-CACHE (Batch 76) — route the three Weather
  // compute pipelines through the central cache so two contexts (split-
  // screen) sharing the same shader + layout dedupe. Uses the sync path
  // (`getOrCreateSync`) so this function stays sync — the alternative
  // is making `updateWeatherParticles` async, which would push the
  // change through every feature-renderer dispatch site.
  if (computePipelineCache) {
    cache.resetPipeline = computePipelineCache.getOrCreateSync({
      name: "Weather reset counters",
      layout: pipelineLayout,
      compute: { module: shaderModule, entryPoint: "resetCounters" },
    });
    cache.updatePipeline = computePipelineCache.getOrCreateSync({
      name: "Weather update particles",
      layout: pipelineLayout,
      compute: { module: shaderModule, entryPoint: "updateParticles" },
    });
    cache.emitPipeline = computePipelineCache.getOrCreateSync({
      name: "Weather emit particles",
      layout: pipelineLayout,
      compute: { module: shaderModule, entryPoint: "emitParticles" },
    });
  } else {
    // Fallback path — no central cache (defensive; WebGPU contexts always
    // expose one). Mirrors the historical sync creation pattern.
    cache.resetPipeline = device.createComputePipeline({
      label: "Weather reset counters",
      layout: pipelineLayout,
      compute: { module: shaderModule, entryPoint: "resetCounters" },
    });
    cache.updatePipeline = device.createComputePipeline({
      label: "Weather update particles",
      layout: pipelineLayout,
      compute: { module: shaderModule, entryPoint: "updateParticles" },
    });
    cache.emitPipeline = device.createComputePipeline({
      label: "Weather emit particles",
      layout: pipelineLayout,
      compute: { module: shaderModule, entryPoint: "emitParticles" },
    });
  }

  // Create particle storage buffer (zero-initialized = all dead)
  // STORAGE for compute, VERTEX for render pass readback
  cache.particleBuffer = device.createBuffer({
    label: "Weather particles",
    size: maxParticles * PARTICLE_SIZE_BYTES,
    usage:
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.VERTEX,
  });

  // Counter buffer: 3 u32 atomics
  cache.counterBuffer = device.createBuffer({
    label: "Weather counters",
    size: 12, // 3 × u32
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  cache.uniformBuffer = device.createBuffer({
    label: "Weather params UB",
    size: Math.max(WEATHER_PARAMS_BYTES, 256),
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  cache.bindGroup = device.createBindGroup({
    layout: cache.bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: cache.particleBuffer } },
      { binding: 1, resource: { buffer: cache.uniformBuffer } },
      { binding: 2, resource: { buffer: cache.counterBuffer } },
    ],
  });

  cache.maxParticles = maxParticles;
  cache.initialized = true;
}

/**
 * Execute the weather particle simulation (compute passes).
 * Should be called once per frame when weather is enabled.
 */
export function updateWeatherParticles(
  context: CesiumGraphicsContext,
  frameState: CesiumFrameState,
  weatherConfig: CesiumWeatherConfig,
): void {
  const device = context._device;
  if (!device || !weatherConfig?.enabled) return;

  const maxParticles = weatherConfig.maxParticles ?? 50000;
  const cache = ensureWeatherCache(context);
  initializeWeatherPipelines(
    device,
    cache,
    maxParticles,
    context.webgpuComputePipelineCache ?? null,
  );

  // Pack weather uniforms
  const data = cache.uniformData;
  let offset = 0;

  // RTE: compute camera delta in FP64 on the CPU so the compute shader
  // only ever sees small FP32-safe vectors. On the first frame and
  // after large teleports, clamp the delta so existing particles get
  // "released" (they'll drift offscreen naturally and be replaced).
  const camPos = frameState.camera?.positionWC;
  const currX = camPos?.x ?? 0;
  const currY = camPos?.y ?? 0;
  const currZ = camPos?.z ?? 0;
  let dx = 0;
  let dy = 0;
  let dz = 0;
  if (cache.prevCameraPosition) {
    dx = currX - cache.prevCameraPosition.x;
    dy = currY - cache.prevCameraPosition.y;
    dz = currZ - cache.prevCameraPosition.z;
    // Teleport guard — if the camera moved more than the spawn
    // volume's extent in one frame, don't try to track: snap prev
    // to current, leaving delta=0. Stale particles will age out.
    const spawnRadius = weatherConfig.spawnRadius ?? 500;
    const teleportSq = spawnRadius * 4 * (spawnRadius * 4);
    if (dx * dx + dy * dy + dz * dz > teleportSq) {
      dx = 0;
      dy = 0;
      dz = 0;
    }
  }
  cache.prevCameraPosition = { x: currX, y: currY, z: currZ };

  // cameraDelta (vec3) + deltaTime
  data[offset++] = dx;
  data[offset++] = dy;
  data[offset++] = dz;
  data[offset++] = frameState.deltaTime ?? 0.016;

  // wind (vec4): xyz=direction, w=speed
  const windDir = weatherConfig.windDirection;
  data[offset++] = windDir?.x ?? 1;
  data[offset++] = windDir?.y ?? 0;
  data[offset++] = windDir?.z ?? 0;
  data[offset++] = weatherConfig.windSpeed ?? 5.0;

  // gravity (vec4): xyz=direction, w=magnitude
  data[offset++] = 0;
  data[offset++] = -1;
  data[offset++] = 0;
  data[offset++] = 9.81;

  // spawnVolume (vec4): xyz=half-extents, w=maxParticles
  const spawnRadius = weatherConfig.spawnRadius ?? 500;
  data[offset++] = spawnRadius;
  data[offset++] = spawnRadius * 0.5; // height = half of width
  data[offset++] = spawnRadius;
  data[offset++] = maxParticles;

  // typeParams (vec4): x=type, y=intensity, z=lifetime, w=size
  const typeStr = weatherConfig.type ?? "rain";
  const typeId = WEATHER_TYPES[typeStr as keyof typeof WEATHER_TYPES] ?? 0;
  data[offset++] = typeId;
  data[offset++] = weatherConfig.intensity ?? 0.5;
  data[offset++] = weatherConfig.particleLifetime ?? 5.0;
  data[offset++] = weatherConfig.particleSize ?? 1.0;

  // groundParams (vec4):
  //   x = relativeGroundAltitude (camera-relative Y of the ground plane,
  //       computed on the CPU as `worldGroundAlt - cameraY` so the
  //       compute shader's camera-relative `p.position.y` check lines up)
  //   y = turbulence
  //   z = fadeDistance
  //   w = time
  const worldGroundAlt = weatherConfig.groundAltitude ?? 0;
  data[offset++] = worldGroundAlt - currY;
  data[offset++] = weatherConfig.turbulence ?? 0.3;
  data[offset++] = spawnRadius * 2.0; // fade distance
  data[offset++] = performance.now() / 1000.0;

  device.queue.writeBuffer(cache.uniformBuffer!, 0, data);

  // Dispatch compute passes
  const workgroups = Math.ceil(maxParticles / 256);
  const encoder = device.createCommandEncoder({ label: "Weather compute" });

  // Pass 0: Reset counters
  const resetPass = encoder.beginComputePass();
  resetPass.setPipeline(cache.resetPipeline!);
  resetPass.setBindGroup(0, cache.bindGroup!);
  resetPass.dispatchWorkgroups(1);
  resetPass.end();

  // Pass 1: Update particles
  const updatePass = encoder.beginComputePass();
  updatePass.setPipeline(cache.updatePipeline!);
  updatePass.setBindGroup(0, cache.bindGroup!);
  updatePass.dispatchWorkgroups(workgroups);
  updatePass.end();

  // Pass 2: Emit new particles
  const emitPass = encoder.beginComputePass();
  emitPass.setPipeline(cache.emitPipeline!);
  emitPass.setBindGroup(0, cache.bindGroup!);
  emitPass.dispatchWorkgroups(workgroups);
  emitPass.end();

  device.queue.submit([encoder.finish()]);
}

/**
 * Get the particle storage buffer for rendering.
 * The render pass reads this buffer to draw particles as camera-facing quads.
 */
export function getWeatherParticleBuffer(
  context: CesiumGraphicsContext,
): GPUBuffer | null {
  const cache = context._weatherCache;
  return cache?.particleBuffer ?? null;
}

export function getWeatherMaxParticles(context: CesiumGraphicsContext): number {
  const cache = context._weatherCache;
  return cache?.maxParticles ?? 0;
}

/**
 * Initialize the weather particle render pipeline (once).
 * Creates pipeline, bind group layout, and uniform buffer for rendering
 * particles as instanced camera-facing quads.
 */
function initializeRenderPipeline(
  device: GPUDevice,
  cache: WeatherCache,
  format: GPUTextureFormat,
  depthFormat: GPUTextureFormat,
): void {
  if (cache.renderInitialized) return;

  // C-R7-SHADER-MODULE-DEDUP (Batch 72) — route render shader through
  // the per-device module cache.
  const moduleCache = getWeatherShaderModuleCache(device);
  const shaderModule = moduleCache.getOrCreate(
    ShaderSourceId.WEATHER_PARTICLE_RENDER,
    WeatherParticleRenderWGSL,
    0,
    "WeatherParticle render",
  );

  cache.renderBindGroupLayout = makeBindGroupLayout(
    device,
    "Weather render BGL",
    [
      storageBuffer(0, Stage.VERTEX, { readOnly: true }),
      uniformBuffer(1, Stage.VERTEX_FRAGMENT),
    ],
  );

  const pipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [cache.renderBindGroupLayout],
  });

  // C-R7-RENDERER-MIGRATION (Batch 72) — descriptor-only construction;
  // pipeline is materialized below via `tryResolveWeatherRenderPipeline`
  // through the central `webgpuPipelineCache` so two contexts with
  // weather enabled share a single `GPURenderPipeline`.
  cache.renderPipelineDescriptor = {
    name: "Weather particle render",
    layout: pipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMain",
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentMain",
      targets: [
        {
          format,
          blend: {
            color: {
              srcFactor: "src-alpha",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
            alpha: {
              srcFactor: "one",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
          },
        },
      ],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: false,
      depthCompare: "less-equal",
    },
  };

  cache.renderUniformBuffer = device.createBuffer({
    label: "Weather render uniforms",
    size: RENDER_UNIFORM_SIZE,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  cache.renderInitialized = true;
}

/**
 * Resolve the weather render pipeline through the central pipeline cache.
 * Returns true when the pipeline is ready, false when async creation is
 * still in flight (caller should skip the draw this frame).
 *
 * C-R7-RENDERER-MIGRATION (Batch 72).
 */
function tryResolveWeatherRenderPipeline(
  device: GPUDevice,
  pipelineCache: WebGPURenderPipelineCache | null | undefined,
  cache: WeatherCache,
): boolean {
  if (cache.renderPipeline) {
    return true;
  }
  const desc = cache.renderPipelineDescriptor;
  if (!desc) {
    return false;
  }

  if (pipelineCache) {
    const sync = pipelineCache.getPipelineSync(desc);
    if (sync) {
      cache.renderPipeline = sync;
      cache.renderPipelineRequestPending = false;
      return true;
    }
    if (!cache.renderPipelineRequestPending) {
      cache.renderPipelineRequestPending = true;
      pipelineCache
        .getPipeline(desc)
        .then((p) => {
          cache.renderPipeline = p;
          cache.renderPipelineRequestPending = false;
        })
        .catch(() => {
          cache.renderPipelineRequestPending = false;
        });
    }
    return false;
  }

  // Fallback: no central cache.
  cache.renderPipeline = device.createRenderPipeline({
    label: desc.name,
    layout: desc.layout ?? "auto",
    vertex: {
      module: desc.vertex.module,
      entryPoint: desc.vertex.entryPoint,
      buffers: desc.vertex.buffers,
    },
    fragment: desc.fragment
      ? {
          module: desc.fragment.module,
          entryPoint: desc.fragment.entryPoint,
          targets: desc.fragment.targets,
        }
      : undefined,
    primitive: desc.primitive,
    depthStencil: desc.depthStencil,
    multisample: desc.multisample,
  });
  return true;
}

/**
 * Render weather particles to the current render pass.
 * Should be called after compute simulation, during the environmental effects phase.
 *
 * @param context - WebGPU context
 * @param frameState - Current frame state (camera, timing)
 * @param weatherConfig - Weather configuration
 * @param renderPassEncoder - Active render pass encoder
 */
export function renderWeatherParticles(
  context: CesiumGraphicsContext,
  frameState: CesiumFrameState,
  weatherConfig: CesiumWeatherConfig,
  renderPassEncoder: GPURenderPassEncoder,
): void {
  const device: GPUDevice | undefined = context._device;
  const cache = context._weatherCache;
  if (!device || !cache?.initialized || !cache.particleBuffer) return;
  if (!weatherConfig?.enabled) return;

  const format: GPUTextureFormat = context.presentationFormat ?? "bgra8unorm";
  const depthFormat: GPUTextureFormat =
    context.depthFormat ?? "depth24plus-stencil8";

  initializeRenderPipeline(device, cache, format, depthFormat);
  if (!cache.renderUniformBuffer) return;

  // C-R7-RENDERER-MIGRATION (Batch 72) — resolve the render pipeline
  // through the central cache. Skip the draw on not-yet-ready frames so
  // we never enqueue a draw command with a null pipeline.
  if (!cache.renderPipeline) {
    const ctxAny = context as unknown as {
      webgpuPipelineCache?: WebGPURenderPipelineCache | null;
    };
    if (
      !tryResolveWeatherRenderPipeline(
        device,
        ctxAny.webgpuPipelineCache ?? null,
        cache,
      )
    ) {
      return;
    }
  }

  // Pack render uniforms: CameraUniforms struct
  const data = cache.renderUniformData;
  const cam = frameState.camera;
  const uniformState = context.uniformState;

  // mvpRelativeToEye (mat4x4) — 16 floats.
  // Particles are stored in a camera-relative frame, so the projection
  // matrix must be the view-projection with its translation column
  // zeroed. `UniformState.modelViewProjectionRelativeToEye` gives us
  // exactly that (identity model × translation-zeroed view × proj).
  const mvpRte =
    uniformState?.modelViewProjectionRelativeToEye ??
    uniformState?.viewProjection;
  if (mvpRte) {
    for (let i = 0; i < 16; i++) {
      data[i] = mvpRte[i];
    }
  }

  // cameraRight (vec3 + pad)
  const right = cam?.rightWC;
  data[16] = right?.x ?? 1;
  data[17] = right?.y ?? 0;
  data[18] = right?.z ?? 0;
  data[19] = 0;

  // cameraUp (vec3 + pad)
  const up = cam?.upWC;
  data[20] = up?.x ?? 0;
  data[21] = up?.y ?? 1;
  data[22] = up?.z ?? 0;
  data[23] = 0;

  // Legacy cameraPosition slot — the shader no longer reads this (it
  // operates entirely in camera-relative space via mvpRelativeToEye)
  // but the binary layout is preserved so we don't need to reshape the
  // uniform buffer. Keep maxLifetime in the same w slot.
  data[24] = 0;
  data[25] = 0;
  data[26] = 0;
  data[27] = weatherConfig.particleLifetime ?? 5.0;

  // viewportSize (vec2) + weatherType (u32) + particleAlpha
  const canvas = context.canvas;
  data[28] = canvas?.width ?? 1920;
  data[29] = canvas?.height ?? 1080;
  // weatherType as u32 bit pattern
  const typeStr = weatherConfig.type ?? "rain";
  const typeId = WEATHER_TYPES[typeStr as keyof typeof WEATHER_TYPES] ?? 0;
  const u32View = new Uint32Array(data.buffer, 30 * 4, 1);
  u32View[0] = typeId;
  data[31] = weatherConfig.intensity ?? 0.5;

  // DP-H41 (Batch 27) — previousViewProjection at slots 32..47 for
  // TAA / motion-vector reprojection.
  const prevVP = uniformState?.previousViewProjection;
  if (prevVP) {
    for (let i = 0; i < 16; i++) data[32 + i] = prevVP[i];
  } else {
    data[32] = 1;
    data[33] = 0;
    data[34] = 0;
    data[35] = 0;
    data[36] = 0;
    data[37] = 1;
    data[38] = 0;
    data[39] = 0;
    data[40] = 0;
    data[41] = 0;
    data[42] = 1;
    data[43] = 0;
    data[44] = 0;
    data[45] = 0;
    data[46] = 0;
    data[47] = 1;
  }

  device.queue.writeBuffer(cache.renderUniformBuffer, 0, data);

  // Create render bind group (per-frame — particle buffer may have been recreated)
  cache.renderBindGroup = device.createBindGroup({
    layout: cache.renderBindGroupLayout!,
    entries: [
      { binding: 0, resource: { buffer: cache.particleBuffer } },
      { binding: 1, resource: { buffer: cache.renderUniformBuffer } },
    ],
  });

  // Draw: 6 vertices per quad, instanced by particle count
  renderPassEncoder.setPipeline(cache.renderPipeline);
  renderPassEncoder.setBindGroup(0, cache.renderBindGroup);
  renderPassEncoder.draw(6, cache.maxParticles);
}

export function destroyWeatherResources(context: CesiumGraphicsContext): void {
  const cache = context._weatherCache;
  if (cache) {
    cache.particleBuffer?.destroy();
    cache.counterBuffer?.destroy();
    cache.uniformBuffer?.destroy();
    cache.resetPipeline = null;
    cache.updatePipeline = null;
    cache.emitPipeline = null;
    cache.particleBuffer = null;
    cache.counterBuffer = null;
    cache.uniformBuffer = null;
    cache.bindGroupLayout = null;
    cache.bindGroup = null;
    cache.initialized = false;
    cache.renderPipeline = null;
    cache.renderBindGroupLayout = null;
    cache.renderBindGroup = null;
    cache.renderUniformBuffer?.destroy();
    cache.renderUniformBuffer = null;
    cache.renderInitialized = false;
    context._weatherCache = undefined;
  }
}
