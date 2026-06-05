/// <reference types="@webgpu/types" />
/**
 * WebGPU Screen-Space Reflections Effect
 *
 * Integrates into the post-process pipeline as a complex multi-pass effect.
 * Activated via `scene.screenSpaceReflections = true`.
 *
 * Configuration:
 *   - scene.ssrMaxDistance: number (default 200.0 — Batch 136 tuning)
 *   - scene.ssrThickness: number (default 0.5)
 *   - scene.ssrMaxSteps: number (default 96 — Batch 136 tuning)
 *   - scene.ssrStride: number (default 2.0)
 *   - scene.ssrReflectionStrength: number 0-1 (default 0.5)
 *
 * Tuning notes (Batch 136):
 *   - Pre-Batch-136 defaults were maxDistance=50m, maxSteps=64. The
 *     50m march budget rarely reached reflectors more than a few
 *     meters from the reflective surface — a typical aerial scene
 *     with an object 50-200m away from a lake produced essentially
 *     zero visible reflection signal. Bumping to 200m + 96 steps
 *     covers the typical mid-range case (urban reflective surfaces
 *     with buildings up to ~200m away) without a major perf hit.
 *   - The trade is per-frame cost: 96 steps × ~1.4-4M ray-marched
 *     pixels per HD frame is bounded by the GPU's texture-sample
 *     throughput. SSR remains opt-in (off by default), so the cost
 *     only applies to scenes that explicitly enable it.
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

// AUDIT_2026_05_02 B.15 — bumped from 44 to 48 for the new `flags: vec4`
// trailing field in SSRUniforms (hasNormalGBuffer flag).
const SSR_UNIFORM_FLOATS = 48; // matches SSRUniforms struct
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
  warnedNoNormalGBuffer: boolean;
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
      warnedNoNormalGBuffer: false,
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

  // Use provided normal texture or fallback placeholder. The placeholder
  // is uninitialized — SSR will sample garbage and produce noise rather
  // than reflections. A real normal G-buffer is gated on FEAT-GAP-01
  // (Phase-8a Foundation: depth prepass + normal G-buffer). Surface this
  // once so users don't think SSR is broken — they're seeing the
  // documented placeholder behavior.
  let normalView = normalTextureView;
  if (!normalView) {
    if (!cache.warnedNoNormalGBuffer) {
      cache.warnedNoNormalGBuffer = true;
      //>>includeStart('debug', pragmas.debug);
      console.warn(
        "[CesiumJS:webgpu] Screen-space reflections enabled without a normal G-buffer. " +
          "SSR will sample an uninitialized placeholder and produce noise. " +
          "A real normal G-buffer is gated on FEAT-GAP-01 (Phase-8a Foundation). " +
          "See migration_doc/DEFERRED_WORK.md.",
      );
      //>>includeEnd('debug');
    }
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
  // Batch 136 — bumped maxDistance 50→200 and maxSteps 64→96. See
  // file header for rationale (the 50m budget was too small for
  // typical scenes).
  data[offset++] = scene.ssrMaxDistance ?? 200.0;
  data[offset++] = scene.ssrThickness ?? 0.5;
  data[offset++] = scene.ssrMaxSteps ?? 96.0;
  data[offset++] = scene.ssrStride ?? 2.0;

  // params2 (vec4): fadeScreenEdge, fadeDistance, reflectionStrength, fresnelPower
  data[offset++] = 0.1;
  data[offset++] = 1.0;
  data[offset++] = scene.ssrReflectionStrength ?? 0.5;
  data[offset++] = 5.0;

  // AUDIT_2026_05_02 B.15 — flags.x = hasNormalGBuffer flag. When the
  // caller passed a real normal G-buffer (`normalTextureView !== null`)
  // the FS samples the texture; otherwise it falls back to depth-derived
  // normals via `cross(dFdy, dFdx)`. Far better than the all-noise
  // placeholder produced by sampling an uninitialized texture.
  data[offset++] = normalTextureView ? 1.0 : 0.0;
  data[offset++] = 0.0;
  data[offset++] = 0.0;
  data[offset++] = 0.0;

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

  // Slice 5c-B Batch 127 — record into the MAIN frame encoder (parallel
  // change to NPR outlines in this batch). Pre-fix: SSR created its own
  // encoder + submitted eagerly → ran BEFORE the main encoder's
  // post-process blit → SSR's canvas write was overwritten and
  // invisible. Now SSR records into the main encoder AFTER
  // _runPostProcessing's commands so the blend-on-top survives.
  const mainEncoder = (
    context as unknown as { _currentCommandEncoder?: GPUCommandEncoder }
  )._currentCommandEncoder;
  const useMain = !!mainEncoder;
  const encoder =
    mainEncoder ?? device.createCommandEncoder({ label: "SSR (orphan)" });
  const pass = encoder.beginRenderPass({
    label: "SSR pass",
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
  if (!useMain) {
    device.queue.submit([encoder.finish()]);
  }
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
