/// <reference types="@webgpu/types" />
/**
 * WebGPU Screen-Space Reflections Effect
 *
 * Integrates into the post-process pipeline as a complex multi-pass effect.
 * Activated via `scene.screenSpaceReflections = true`.
 *
 * Configuration:
 *   - scene.ssrMaxDistance: number (default 50.0)
 *   - scene.ssrThickness: number (default 0.5)
 *   - scene.ssrMaxSteps: number (default 64)
 *   - scene.ssrStride: number (default 2.0)
 *   - scene.ssrReflectionStrength: number 0-1 (default 0.5)
 *
 * @private
 */
import SSRShaderWGSL from "../../Shaders/WebGPU/PostProcess/ScreenSpaceReflections.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  texture,
  sampler,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";

const SSR_UNIFORM_FLOATS = 44; // matches SSRUniforms struct
const SSR_UNIFORM_BYTES = SSR_UNIFORM_FLOATS * 4;

export interface SSRCache {
  pipeline: GPURenderPipeline | null;
  uniformBuffer: GPUBuffer | null;
  bindGroupLayout: GPUBindGroupLayout | null;
  sampler: GPUSampler | null;
  normalTexture: GPUTexture | null;
  normalView: GPUTextureView | null;
  uniformData: Float32Array;
  initialized: boolean;
  width: number;
  height: number;
}

function ensureSSRCache(context: CesiumGraphicsContext): SSRCache {
  if (!context._ssrCache) {
    context._ssrCache = {
      pipeline: null,
      uniformBuffer: null,
      bindGroupLayout: null,
      sampler: null,
      normalTexture: null,
      normalView: null,
      uniformData: new Float32Array(SSR_UNIFORM_FLOATS),
      initialized: false,
      width: 0,
      height: 0,
    };
  }
  return context._ssrCache;
}

function initializeSSRPipeline(
  device: GPUDevice,
  cache: SSRCache,
  canvasFormat: GPUTextureFormat,
): void {
  if (cache.initialized) return;

  const shaderModule = device.createShaderModule({
    label: "SSR shader",
    code: SSRShaderWGSL,
  });

  cache.bindGroupLayout = makeBindGroupLayout(device, "SSR BGL", [
    texture(0, Stage.FRAGMENT),
    texture(1, Stage.FRAGMENT),
    texture(2, Stage.FRAGMENT),
    sampler(3, Stage.FRAGMENT),
    uniformBuffer(4, Stage.FRAGMENT),
  ]);

  const pipelineLayout = device.createPipelineLayout({
    label: "SSR pipeline layout",
    bindGroupLayouts: [cache.bindGroupLayout],
  });

  cache.pipeline = device.createRenderPipeline({
    label: "SSR pipeline",
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
    label: "SSR UB",
    size: Math.max(SSR_UNIFORM_BYTES, 256),
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  cache.initialized = true;
}

function ensureNormalTexture(
  device: GPUDevice,
  cache: SSRCache,
  width: number,
  height: number,
): void {
  if (cache.normalTexture && cache.width === width && cache.height === height)
    return;

  cache.normalTexture?.destroy();
  cache.normalTexture = device.createTexture({
    label: "SSR normal placeholder",
    size: [width, height],
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  cache.normalView = cache.normalTexture.createView();
  cache.width = width;
  cache.height = height;
}

/**
 * Execute the SSR effect pass.
 * Inserted into post-process pipeline after AO, before bloom.
 */
export function executeSSR(
  context: CesiumGraphicsContext,
  frameState: CesiumFrameState,
  colorTextureView: GPUTextureView,
  depthTextureView: GPUTextureView,
  normalTextureView: GPUTextureView | null,
  outputView: GPUTextureView,
  scene: CesiumScene,
): void {
  const device = context._device;
  if (!device) return;

  const cache = ensureSSRCache(context);
  initializeSSRPipeline(device, cache, context._canvasFormat || "bgra8unorm");

  const canvas = context._canvas;
  const w = canvas?.width ?? 1920;
  const h = canvas?.height ?? 1080;

  // Use provided normal texture or fallback placeholder
  let normalView = normalTextureView;
  if (!normalView) {
    ensureNormalTexture(device, cache, w, h);
    normalView = cache.normalView!;
  }

  // Pack uniforms
  const data = cache.uniformData;
  const us = frameState.context?.uniformState ?? context.uniformState;
  let offset = 0;

  // projection (mat4, 16 floats)
  const proj = us?.projection;
  if (proj) {
    for (let i = 0; i < 16; i++) data[offset++] = proj[i];
  } else {
    offset += 16;
  }

  // inverseProjection (mat4, 16 floats)
  const invProj = us?.inverseProjection;
  if (invProj) {
    for (let i = 0; i < 16; i++) data[offset++] = invProj[i];
  } else {
    offset += 16;
  }

  // resolution (vec4)
  data[offset++] = w;
  data[offset++] = h;
  data[offset++] = 1.0 / w;
  data[offset++] = 1.0 / h;

  // params (vec4): maxDistance, thickness, maxSteps, stride
  data[offset++] = scene.ssrMaxDistance ?? 50.0;
  data[offset++] = scene.ssrThickness ?? 0.5;
  data[offset++] = scene.ssrMaxSteps ?? 64.0;
  data[offset++] = scene.ssrStride ?? 2.0;

  // params2 (vec4): fadeScreenEdge, fadeDistance, reflectionStrength, fresnelPower
  data[offset++] = 0.1;
  data[offset++] = 1.0;
  data[offset++] = scene.ssrReflectionStrength ?? 0.5;
  data[offset++] = 5.0;

  device.queue.writeBuffer(cache.uniformBuffer!, 0, data);

  const bindGroup = device.createBindGroup({
    layout: cache.bindGroupLayout!,
    entries: [
      { binding: 0, resource: colorTextureView },
      { binding: 1, resource: depthTextureView },
      { binding: 2, resource: normalView },
      { binding: 3, resource: cache.sampler! },
      { binding: 4, resource: { buffer: cache.uniformBuffer! } },
    ],
  });

  const encoder = device.createCommandEncoder({ label: "SSR" });
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
  pass.draw(3);
  pass.end();
  device.queue.submit([encoder.finish()]);
}

export function destroySSRResources(context: CesiumGraphicsContext): void {
  const cache = context._ssrCache;
  if (cache) {
    cache.uniformBuffer?.destroy();
    cache.normalTexture?.destroy();
    cache.pipeline = null;
    cache.uniformBuffer = null;
    cache.bindGroupLayout = null;
    cache.sampler = null;
    cache.normalTexture = null;
    cache.normalView = null;
    cache.initialized = false;
    context._ssrCache = undefined;
  }
}
