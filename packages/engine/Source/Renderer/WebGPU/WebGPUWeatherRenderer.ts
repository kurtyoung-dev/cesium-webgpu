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

const WEATHER_TYPES = { rain: 0, snow: 1, fog: 2, hail: 3 } as const;
const PARTICLE_SIZE_BYTES = 32; // 8 floats per particle
const WEATHER_PARAMS_FLOATS = 24; // matches WeatherParams struct
const WEATHER_PARAMS_BYTES = WEATHER_PARAMS_FLOATS * 4;

interface WeatherCache {
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
}

function ensureWeatherCache(context: any): WeatherCache {
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
    } as WeatherCache;
  }
  return context._weatherCache;
}

function initializeWeatherPipelines(
  device: GPUDevice,
  cache: WeatherCache,
  maxParticles: number,
): void {
  if (cache.initialized && cache.maxParticles === maxParticles) return;

  // Destroy old buffers on resize
  cache.particleBuffer?.destroy();
  cache.counterBuffer?.destroy();
  cache.uniformBuffer?.destroy();

  const shaderModule = device.createShaderModule({
    label: "WeatherParticles compute",
    code: WeatherParticlesWGSL,
  });

  cache.bindGroupLayout = device.createBindGroupLayout({
    label: "Weather BGL",
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
    ],
  });

  const pipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [cache.bindGroupLayout],
  });

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

  // Create particle storage buffer (zero-initialized = all dead)
  cache.particleBuffer = device.createBuffer({
    label: "Weather particles",
    size: maxParticles * PARTICLE_SIZE_BYTES,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
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
  context: any,
  frameState: any,
  weatherConfig: any,
): void {
  const device = context._device;
  if (!device || !weatherConfig?.enabled) return;

  const maxParticles = weatherConfig.maxParticles ?? 50000;
  const cache = ensureWeatherCache(context);
  initializeWeatherPipelines(device, cache, maxParticles);

  // Pack weather uniforms
  const data = cache.uniformData;
  let offset = 0;

  // cameraPosition (vec3) + deltaTime
  const camPos = frameState.camera?.positionWC;
  data[offset++] = camPos?.x ?? 0;
  data[offset++] = camPos?.y ?? 0;
  data[offset++] = camPos?.z ?? 0;
  data[offset++] = frameState.deltaTime ?? 0.016;

  // wind (vec4): xyz=direction, w=speed
  const windDir = weatherConfig.windDirection;
  data[offset++] = windDir?.x ?? 1;
  data[offset++] = windDir?.y ?? 0;
  data[offset++] = windDir?.z ?? 0;
  data[offset++] = weatherConfig.windSpeed ?? 5.0;

  // gravity (vec4): xyz=direction, w=magnitude
  data[offset++] = 0; data[offset++] = -1; data[offset++] = 0;
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

  // groundParams (vec4): x=groundAlt, y=turbulence, z=fadeDistance, w=time
  data[offset++] = weatherConfig.groundAltitude ?? 0;
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
export function getWeatherParticleBuffer(context: any): GPUBuffer | null {
  return context._weatherCache?.particleBuffer ?? null;
}

export function getWeatherMaxParticles(context: any): number {
  return context._weatherCache?.maxParticles ?? 0;
}

export function destroyWeatherResources(context: any): void {
  const cache = context._weatherCache as WeatherCache | undefined;
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
    context._weatherCache = undefined;
  }
}
