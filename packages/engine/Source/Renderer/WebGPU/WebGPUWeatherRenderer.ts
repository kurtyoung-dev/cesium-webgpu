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
import { getAvailableFrameCommandEncoder } from "./WebGPUFrameCommandEncoder.js";

// The per-device cache lets weather-enabled contexts share one compiled
// `GPUShaderModule` for compute and one for rendering.
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
// Render-pass `CameraUniforms` appends the 64-byte `previousViewProjection`
// matrix for TAA and motion-vector reprojection.
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
  // Previous camera position as an FP64 triple. CPU subtraction produces a
  // small `cameraDelta` that keeps camera-relative particles stationary in
  // world space. Absolute FP32 positions would snap to an approximately
  // 0.6-metre grid at Earth radius.
  prevCameraPosition: { x: number; y: number; z: number } | null;
  // Render pass resources
  renderPipeline: GPURenderPipeline | null;
  renderBindGroupLayout: GPUBindGroupLayout | null;
  renderBindGroup: GPUBindGroup | null;
  renderBindGroupParticleBuffer: GPUBuffer | null;
  renderUniformBuffer: GPUBuffer | null;
  renderUniformData: Float32Array;
  renderInitialized: boolean;
  // The render pipeline arrives asynchronously from
  // `WebGPURenderPipelineCache.getPipeline`. Retain its descriptor so every
  // resolution attempt uses the same key.
  renderPipelineRequestPending: boolean;
  renderPipelineDescriptor: WebGPURenderPipelineDescriptor | null;
  // Latest `[0, 1]` snow-cover scalar from `updateSnowAccumulation`. It is
  // exposed through `getWeatherSnowCover`, but no terrain shader currently
  // consumes it, so it does not whiten the ground.
  snowCover: number;
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
      renderBindGroupParticleBuffer: null,
      renderUniformBuffer: null,
      renderUniformData: new Float32Array(RENDER_UNIFORM_SIZE / 4),
      renderInitialized: false,
      renderPipelineRequestPending: false,
      renderPipelineDescriptor: null,
      snowCover: 0,
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

  // Use the per-device module cache so all three compute pipelines share one
  // `GPUShaderModule`.
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

  // Prefer the central compute cache so contexts sharing a device, shader,
  // and layout reuse all three pipelines. Its synchronous path keeps the
  // feature renderer's update contract synchronous.
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
    // Direct creation is the defensive fallback when no central cache exists.
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
  // Mirror the data-driven snow-cover scalar for `getWeatherSnowCover`.
  // Manual and automatic paths that omit it resolve to zero.
  cache.snowCover = weatherConfig.snowCover ?? 0;
  initializeWeatherPipelines(
    device,
    cache,
    maxParticles,
    context.webgpuComputePipelineCache ?? null,
  );

  // Pack weather uniforms
  const data = cache.uniformData;
  let offset = 0;

  // Compute camera delta in FP64 so the shader sees only small, FP32-safe
  // vectors. A zero delta on the first frame or after a large teleport lets
  // existing particles age out instead of applying an extreme translation.
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
    // A move beyond the spawn volume's extent is a teleport. Reset the prior
    // position and leave delta zero so stale particles age out.
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
  // Emission probability is `typeParams.y * dt * 10`, so the visibility-based
  // density scale makes heavier precipitation spawn more particles. Omitted
  // scales resolve to one. Clamp to `[0, 1]` because the probability
  // saturates at one and higher values carry no additional meaning.
  const baseIntensity = weatherConfig.intensity ?? 0.5;
  const densityScale = weatherConfig.densityScale ?? 1.0;
  const effectiveIntensity = Math.min(
    1.0,
    Math.max(0.0, baseIntensity * densityScale),
  );
  data[offset++] = effectiveIntensity;
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
  const frameEncoder = getAvailableFrameCommandEncoder(context);
  const encoder =
    frameEncoder ?? device.createCommandEncoder({ label: "Weather compute" });

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

  if (!frameEncoder) {
    device.queue.submit([encoder.finish()]);
  }
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
 * Return the data-driven ground snow-cover scalar in `[0, 1]`, or zero when
 * snow accumulation is inactive. No terrain shader currently consumes this
 * value, so it does not change ground albedo.
 */
export function getWeatherSnowCover(context: CesiumGraphicsContext): number {
  const cache = context._weatherCache;
  return cache?.snowCover ?? 0;
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

  // Use the per-device shader-module cache.
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

  // Store a descriptor here and materialize it through
  // `tryResolveWeatherRenderPipeline`, allowing weather-enabled contexts to
  // share one centrally cached `GPURenderPipeline`.
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
      // Weather particles composite after post-processing onto the default
      // canvas pass, which has one color attachment. Declare one alpha-over
      // canvas target instead of the two-target scene-framebuffer MRT layout;
      // an extra rgba16float target would be incompatible with this pass.
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
 * Renders weather particles to the current render pass after compute
 * simulation during the environmental-effects pass.
 *
 * @param context - The WebGPU context.
 * @param frameState - The current camera and timing state.
 * @param weatherConfig - The weather configuration.
 * @param renderPassEncoder - The active render-pass encoder.
 */
export function renderWeatherParticles(
  context: CesiumGraphicsContext,
  frameState: CesiumFrameState,
  weatherConfig: CesiumWeatherConfig,
  renderPassEncoder: GPURenderPassEncoder,
): boolean {
  const device: GPUDevice | undefined = context._device;
  const cache = context._weatherCache;
  if (!device || !cache?.initialized || !cache.particleBuffer) return false;
  if (!weatherConfig?.enabled) return false;

  // Weather particles composite onto the default canvas pass after
  // post-processing, so the pipeline uses the presentation format instead of
  // the HDR scene-framebuffer format. Scene-format generation also advances
  // on swap-chain reconfiguration, rebuilding for any canvas-format change.
  const format: GPUTextureFormat =
    context.presentationFormat ??
    (context as unknown as { scenePipelineFormat?: GPUTextureFormat })
      .scenePipelineFormat ??
    "bgra8unorm";
  const depthFormat: GPUTextureFormat =
    context.depthFormat ?? "depth24plus-stencil8";
  const sceneGen =
    (context as unknown as { _scenePipelineFormatGeneration?: number })
      ._scenePipelineFormatGeneration ?? 0;
  if (
    cache.renderPipeline &&
    (cache as unknown as { _pipelineFormatGeneration?: number })
      ._pipelineFormatGeneration !== sceneGen
  ) {
    cache.renderPipeline = undefined;
    (
      cache as unknown as { _pipelineFormatGeneration?: number }
    )._pipelineFormatGeneration = sceneGen;
  }

  initializeRenderPipeline(device, cache, format, depthFormat);
  if (!cache.renderUniformBuffer) return false;

  // Resolve through the central render-pipeline cache. Skip frames while an
  // asynchronous request is pending rather than enqueueing a null pipeline.
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
      return false;
    }
  }

  // Pack render uniforms: CameraUniforms struct
  const data = cache.renderUniformData;
  const cam = frameState.camera;
  const uniformState = context.uniformState;

  // mvpRelativeToEye (mat4x4) — 16 floats.
  // Particles are stored in a camera-relative frame, so the projection
  // matrix must be the view-projection with its translation column
  // zeroed. `UniformState.modelViewProjectionRelativeToEye` provides that
  // identity-model × translation-zeroed-view × projection transform.
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

  // The reserved camera-position slot preserves the uniform layout even
  // though the shader works entirely in camera-relative space. `maxLifetime`
  // remains in its w component.
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

  // Slots 32 through 47 hold `previousViewProjection` for TAA and
  // motion-vector reprojection.
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

  // The particle buffer changes only when maxParticles forces a resource
  // rebuild. Reuse the bind group on settled frames; the uniform contents
  // remain dynamic and are still uploaded above every rendered frame.
  if (
    !cache.renderBindGroup ||
    cache.renderBindGroupParticleBuffer !== cache.particleBuffer
  ) {
    cache.renderBindGroup = device.createBindGroup({
      layout: cache.renderBindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: cache.particleBuffer } },
        { binding: 1, resource: { buffer: cache.renderUniformBuffer } },
      ],
    });
    cache.renderBindGroupParticleBuffer = cache.particleBuffer;
  }

  // Draw: 6 vertices per quad, instanced by particle count
  renderPassEncoder.setPipeline(cache.renderPipeline);
  renderPassEncoder.setBindGroup(0, cache.renderBindGroup);
  renderPassEncoder.draw(6, cache.maxParticles);
  return true;
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
    cache.renderBindGroupParticleBuffer = null;
    cache.renderUniformBuffer?.destroy();
    cache.renderUniformBuffer = null;
    cache.renderInitialized = false;
    cache.snowCover = 0;
    context._weatherCache = undefined;
  }
}
