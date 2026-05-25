/// <reference types="@webgpu/types" />
/**
 * WebGPU NPR Outline Effect — Slice 5c-B Batch 123.
 *
 * Reads the always-allocated G-buffer normal-roughness texture (slot 1)
 * + scene depth, samples each fragment's 4 cardinal neighbors, and
 * paints silhouette / crease edges. Activated via
 * `scene.enableNPROutlines = true`.
 *
 * Configuration:
 *   - scene.nprNormalThreshold (default 0.2) — 1 - dot threshold;
 *     smaller = more sensitive crease detection.
 *   - scene.nprDepthThreshold (default 0.02) — fractional depth gradient
 *     threshold scaled by center depth.
 *   - scene.nprEdgeStrength (default 1.0) — 0..1 mix factor between
 *     base color and edge color.
 *   - scene.nprEdgeColor (default Color.BLACK) — RGBA, painted over the
 *     base color at edge pixels.
 *
 * Architecture notes:
 *   - Modeled on WebGPUSSREffect.ts. Same cache + initialize +
 *     execute + destroy shape, same FeatureRenderer hookup.
 *   - Sentinel-aware: emits the base color unchanged at G-buffer
 *     sentinel pixels (sky / billboards / labels / lines / any
 *     Phase 1 non-emitting pipeline). Without that, every emitter →
 *     non-emitter boundary would false-positive as a silhouette.
 *   - Renders directly into `outputView` with loadOp="load", so
 *     callers can chain it after other post-process effects.
 *
 * @private
 */

import NPROutlinesWGSL from "../../Shaders/WebGPU/PostProcess/NPROutlines.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  texture,
  sampler,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";

const NPR_UNIFORM_FLOATS = 12; // params(4) + edgeColor(4) + texelSize(4)
const NPR_UNIFORM_BYTES = NPR_UNIFORM_FLOATS * 4;

export interface NPROutlineCache {
  pipeline: GPURenderPipeline | null;
  uniformBuffer: GPUBuffer | null;
  bindGroupLayout: GPUBindGroupLayout | null;
  sampler: GPUSampler | null;
  uniformData: Float32Array;
  initialized: boolean;
}

function ensureCache(context: CesiumGraphicsContext): NPROutlineCache {
  const ctx = context as unknown as {
    _nprOutlineCache?: NPROutlineCache;
  };
  if (!ctx._nprOutlineCache) {
    ctx._nprOutlineCache = {
      pipeline: null,
      uniformBuffer: null,
      bindGroupLayout: null,
      sampler: null,
      uniformData: new Float32Array(NPR_UNIFORM_FLOATS),
      initialized: false,
    };
  }
  return ctx._nprOutlineCache;
}

function initializePipeline(
  device: GPUDevice,
  cache: NPROutlineCache,
  canvasFormat: GPUTextureFormat,
): void {
  if (cache.initialized) return;

  const shaderModule = device.createShaderModule({
    label: "NPR outline shader",
    code: NPROutlinesWGSL,
  });

  cache.bindGroupLayout = makeBindGroupLayout(device, "NPR outline BGL", [
    texture(0, Stage.FRAGMENT),
    // depth texture is sampled as texture_depth_2d in the shader.
    // The shared `texture()` helper produces a generic `texture_2d<f32>`
    // binding which doesn't match. Build the depth binding entry
    // manually to declare `sampleType: "depth"`.
    {
      binding: 1,
      visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "depth" },
    } as unknown as GPUBindGroupLayoutEntry,
    texture(2, Stage.FRAGMENT),
    // Slice 5c-B Batch 127 — non-filtering sampler. The depth_2d
    // binding at slot 1 requires a non-filtering OR comparison
    // sampler (WebGPU spec: filtering samplers + depth textures are
    // incompatible). The actual GPUSampler is nearest-magnify/
    // nearest-minify, so declaring the BGL slot as "non-filtering"
    // matches the runtime sampler shape.
    sampler(3, Stage.FRAGMENT, "non-filtering"),
    uniformBuffer(4, Stage.FRAGMENT),
  ]);

  const pipelineLayout = device.createPipelineLayout({
    label: "NPR outline pipeline layout",
    bindGroupLayouts: [cache.bindGroupLayout],
  });

  cache.pipeline = device.createRenderPipeline({
    label: "NPR outline pipeline",
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
    magFilter: "nearest",
    minFilter: "nearest",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });

  cache.uniformBuffer = device.createBuffer({
    label: "NPR outline UB",
    size: Math.max(NPR_UNIFORM_BYTES, 256),
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  cache.initialized = true;
}

/**
 * Execute the NPR outline pass. Reads colorTextureView (the current
 * scene color), depthTextureView (NDC depth), normalTextureView
 * (G-buffer slot 1 — null is rejected at the caller; this function
 * REQUIRES the G-buffer to be present), and writes the edge-painted
 * result to outputView.
 */
export function executeNPROutlines(
  context: CesiumGraphicsContext,
  frameState: CesiumFrameState,
  colorTextureView: GPUTextureView,
  depthTextureView: GPUTextureView,
  normalTextureView: GPUTextureView,
  outputView: GPUTextureView,
  scene: CesiumScene,
): void {
  void frameState;
  const device = (context as unknown as { _device?: GPUDevice })._device;
  if (!device) return;

  const cache = ensureCache(context);
  const canvasFormat =
    (context as unknown as { _canvasFormat?: GPUTextureFormat })
      ._canvasFormat || "bgra8unorm";
  initializePipeline(device, cache, canvasFormat);

  const canvas = (context as unknown as { _canvas?: HTMLCanvasElement })
    ._canvas;
  const w = canvas?.width ?? 1920;
  const h = canvas?.height ?? 1080;

  // Pack uniforms.
  const sceneAny = scene as unknown as {
    nprNormalThreshold?: number;
    nprDepthThreshold?: number;
    nprEdgeStrength?: number;
    nprEdgeColor?: { red: number; green: number; blue: number; alpha: number };
  };
  const data = cache.uniformData;
  let o = 0;
  // params: normalThreshold, depthThreshold, edgeStrength, unused
  data[o++] = sceneAny.nprNormalThreshold ?? 0.2;
  data[o++] = sceneAny.nprDepthThreshold ?? 0.02;
  data[o++] = sceneAny.nprEdgeStrength ?? 1.0;
  data[o++] = 0.0;
  // edgeColor rgba
  const c = sceneAny.nprEdgeColor;
  data[o++] = c?.red ?? 0.0;
  data[o++] = c?.green ?? 0.0;
  data[o++] = c?.blue ?? 0.0;
  data[o++] = c?.alpha ?? 1.0;
  // texelSize: 1/w, 1/h, unused, unused
  data[o++] = 1.0 / w;
  data[o++] = 1.0 / h;
  data[o++] = 0.0;
  data[o++] = 0.0;

  device.queue.writeBuffer(cache.uniformBuffer!, 0, data);

  const bindGroup = device.createBindGroup({
    layout: cache.bindGroupLayout!,
    entries: [
      { binding: 0, resource: colorTextureView },
      { binding: 1, resource: depthTextureView },
      { binding: 2, resource: normalTextureView },
      { binding: 3, resource: cache.sampler! },
      { binding: 4, resource: { buffer: cache.uniformBuffer! } },
    ],
  });

  // Slice 5c-B Batch 127 — record into the MAIN frame command encoder
  // instead of a separate one. Pre-fix NPR + SSR + ProceduralClouds
  // created their own encoder and submitted eagerly via
  // `device.queue.submit([encoder.finish()])`. The main encoder
  // (which the SceneRenderer records scene rendering + post-process
  // into) submits LATER at end-of-frame. GPU executes in submission
  // order, so post-process's blit-to-canvas overwrote env effects'
  // canvas writes. Recording into the main encoder makes ordering
  // explicit: scene → post-process → env effects, all in one stream
  // where later commands see prior commands' results.
  const mainEncoder = (
    context as unknown as {
      _currentCommandEncoder?: GPUCommandEncoder;
    }
  )._currentCommandEncoder;
  if (!mainEncoder) {
    // No frame in flight — fall back to ephemeral encoder + immediate
    // submit. Same semantics as pre-Batch-127 (used by render-loop
    // unit tests that bypass beginFrame).
    const tmp = device.createCommandEncoder({ label: "NPR outline (orphan)" });
    const pass = tmp.beginRenderPass({
      colorAttachments: [
        { view: outputView, loadOp: "load", storeOp: "store" },
      ],
    });
    pass.setPipeline(cache.pipeline!);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([tmp.finish()]);
    return;
  }
  // Caller (executeEnvironmentalEffects) already called
  // `context.endCurrentRenderPass()` before invoking us, so the main
  // encoder is ready to accept a new render pass. We open our pass,
  // record the draw, and end. The caller resumes the default render
  // pass after we return.
  const pass = mainEncoder.beginRenderPass({
    label: "NPR outline pass",
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
}

export function destroyNPROutlineResources(
  context: CesiumGraphicsContext,
): void {
  const ctx = context as unknown as {
    _nprOutlineCache?: NPROutlineCache;
  };
  const cache = ctx._nprOutlineCache;
  if (cache) {
    cache.uniformBuffer?.destroy();
    cache.pipeline = null;
    cache.uniformBuffer = null;
    cache.bindGroupLayout = null;
    cache.sampler = null;
    cache.initialized = false;
    ctx._nprOutlineCache = undefined;
  }
}
