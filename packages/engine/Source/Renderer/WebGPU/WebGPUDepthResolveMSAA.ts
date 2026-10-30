/// <reference types="@webgpu/types" />
/**
 * WebGPUDepthResolveMSAA.
 *
 * Per-device cache of the MSAA-depth resolve pipeline. The pipeline runs
 * a fullscreen render pass that reads sample 0 of a
 * `texture_depth_multisampled_2d` and writes the value to a single-sample
 * float color attachment. Clouds use full-precision unfiltered reads; other
 * consumers retain the filterable f16 target. Neither is a depth-aspect texture.
 *
 * @module WebGPUDepthResolveMSAA
 */

import DepthResolveShader from "../../Shaders/WebGPU/PostProcess/DepthResolveMSAA.js";

interface ResolvePipelineCache {
  pipeline: GPURenderPipeline;
  bindGroupLayout: GPUBindGroupLayout;
  bindGroups: WeakMap<GPUTextureView, GPUBindGroup>;
}

type ResolveDepthFormat = "r16float" | "r32float";
const _perDevicePipelineCache = new WeakMap<
  GPUDevice,
  Map<ResolveDepthFormat, ResolvePipelineCache>
>();

/**
 * Get-or-create the depth-resolve render pipeline for a device.
 * Pipeline is cached per-device + reused across SceneFramebuffer
 * instances; the selected output format is part of the cache identity.
 */
export function getDepthResolvePipeline(
  device: GPUDevice,
  format: ResolveDepthFormat = "r16float",
): ResolvePipelineCache {
  const formats =
    _perDevicePipelineCache.get(device) ??
    new Map<ResolveDepthFormat, ResolvePipelineCache>();
  const cached = formats.get(format);
  if (cached) return cached;

  const shaderModule = device.createShaderModule({
    label: "DepthResolveMSAA shader",
    code: DepthResolveShader,
  });

  const bindGroupLayout = device.createBindGroupLayout({
    label: "DepthResolveMSAA BGL",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "depth", multisampled: true },
      },
    ],
  });

  const pipeline = device.createRenderPipeline({
    label: "DepthResolveMSAA pipeline",
    layout: device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout],
    }),
    vertex: { module: shaderModule, entryPoint: "vertexMain" },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentMain",
      // Clouds require the original f32 log depth; existing consumers retain
      // the filterable f16 resolve. Each output format has its own pipeline.
      targets: [{ format }],
    },
    primitive: { topology: "triangle-list" },
  });

  const entry: ResolvePipelineCache = {
    pipeline,
    bindGroupLayout,
    bindGroups: new WeakMap(),
  };
  formats.set(format, entry);
  _perDevicePipelineCache.set(device, formats);
  return entry;
}

/**
 * Dispatch one resolve pass. The caller is responsible for opening
 * the render-pass-side encoder; this just records the draw into the
 * provided encoder.
 *
 * @param encoder - Main frame command encoder. The resolve records
 *   into it so the dispatch ordering matches the rest of the frame
 *   (no separate `queue.submit`).
 * @param device - For the lazy pipeline init.
 * @param msaaDepthView - Sampleable view of the MSAA scene depth
 *   texture (depth-only aspect). Bound at `@binding(0)` as
 *   `texture_depth_multisampled_2d`.
 * @param resolveTargetView - Render-attachment view of the
 *   single-sample resolve texture (the output destination). Must be
 *   selected float format, sampleCount 1, RENDER_ATTACHMENT usage.
 */
export function dispatchDepthResolve(
  encoder: GPUCommandEncoder,
  device: GPUDevice,
  msaaDepthView: GPUTextureView,
  resolveTargetView: GPUTextureView,
  format: ResolveDepthFormat = "r16float",
): void {
  const cache = getDepthResolvePipeline(device, format);
  const { pipeline, bindGroupLayout } = cache;
  let bindGroup = cache.bindGroups.get(msaaDepthView);
  if (!bindGroup) {
    bindGroup = device.createBindGroup({
      label: "DepthResolveMSAA BG",
      layout: bindGroupLayout,
      entries: [{ binding: 0, resource: msaaDepthView }],
    });
    cache.bindGroups.set(msaaDepthView, bindGroup);
  }
  const pass = encoder.beginRenderPass({
    label: "DepthResolveMSAA pass",
    colorAttachments: [
      {
        view: resolveTargetView,
        loadOp: "clear",
        clearValue: { r: 1.0, g: 0.0, b: 0.0, a: 0.0 },
        storeOp: "store",
      },
    ],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(3);
  pass.end();
}
