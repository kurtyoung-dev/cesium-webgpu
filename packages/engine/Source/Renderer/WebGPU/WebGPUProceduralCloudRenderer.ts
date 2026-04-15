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

const CLOUD_UNIFORM_FLOATS = 64; // must match CloudUniforms struct in WGSL
const CLOUD_UNIFORM_BYTES = CLOUD_UNIFORM_FLOATS * 4;

export interface CloudCache {
  pipeline: GPURenderPipeline | null;
  uniformBuffer: GPUBuffer | null;
  bindGroupLayout: GPUBindGroupLayout | null;
  sampler: GPUSampler | null;
  uniformData: Float32Array;
  initialized: boolean;
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
    };
  }
  return context._cloudCache;
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

  cache.uniformBuffer = device.createBuffer({
    label: "ProceduralClouds UB",
    size: Math.max(CLOUD_UNIFORM_BYTES, 256),
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  cache.initialized = true;
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
  data[offset++] = performance.now() / 1000.0; // time

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

  // Quality params
  data[offset++] = globe.cloudQuality ?? 64.0;
  data[offset++] = 6.0; // lightSteps
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

  device.queue.writeBuffer(cache.uniformBuffer!, 0, data);

  // Create bind group
  const bindGroup = device.createBindGroup({
    layout: cache.bindGroupLayout!,
    entries: [
      { binding: 0, resource: colorTextureView },
      { binding: 1, resource: depthTextureView },
      { binding: 2, resource: cache.sampler! },
      { binding: 3, resource: { buffer: cache.uniformBuffer! } },
    ],
  });

  // Render
  const encoder = device.createCommandEncoder({ label: "ProceduralClouds" });
  const pass = encoder.beginRenderPass({
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
  device.queue.submit([encoder.finish()]);
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
