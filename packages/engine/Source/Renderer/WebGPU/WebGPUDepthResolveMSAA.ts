/// <reference types="@webgpu/types" />
/**
 * WebGPUDepthResolveMSAA — Slice 5c-B Batch 128.
 *
 * Per-device cache of the MSAA-depth resolve pipeline. The pipeline runs
 * a fullscreen render pass that reads sample 0 of a
 * `texture_depth_multisampled_2d` and writes the value via
 * `@builtin(frag_depth)` to a single-sample depth attachment. Output
 * format is `depth32float` because depth-format textures aren't
 * storage-bindable; the FS + depth-attachment path is the only way to
 * resolve MSAA depth into a sampleable single-sample depth texture
 * without per-consumer-shader changes (consumers stay at
 * `texture_depth_2d` bindings).
 *
 * @module WebGPUDepthResolveMSAA
 */

import DepthResolveShader from "../../Shaders/WebGPU/PostProcess/DepthResolveMSAA.js";

interface ResolvePipelineCache {
  pipeline: GPURenderPipeline;
  bindGroupLayout: GPUBindGroupLayout;
}

const _perDevicePipelineCache = new WeakMap<GPUDevice, ResolvePipelineCache>();

/**
 * Get-or-create the depth-resolve render pipeline for a device.
 * Pipeline is cached per-device + reused across SceneFramebuffer
 * instances; depth format is fixed at `depth32float` (the only
 * single-sample depth format that's also a valid render attachment
 * without a stencil component).
 */
export function getDepthResolvePipeline(
  device: GPUDevice,
): ResolvePipelineCache {
  const cached = _perDevicePipelineCache.get(device);
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
      // Slice 5c-B Batch 128 — single r16float color attachment. The
      // shader emits depth as @location(0) f32 (NOT @builtin(frag_depth))
      // so consumers keep their filterable-float depth bindings.
      // r16float covers the [0,1] post-perspective depth range with
      // ~10-bit precision near 1.0 — adequate for AO + NPR + DoF, and
      // matches the precision of the upstream perspective-divided
      // depth before resolve.
      targets: [{ format: "r16float" }],
    },
    primitive: { topology: "triangle-list" },
  });

  const entry: ResolvePipelineCache = { pipeline, bindGroupLayout };
  _perDevicePipelineCache.set(device, entry);
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
 *   `depth32float` format, sampleCount 1, RENDER_ATTACHMENT usage.
 */
export function dispatchDepthResolve(
  encoder: GPUCommandEncoder,
  device: GPUDevice,
  msaaDepthView: GPUTextureView,
  resolveTargetView: GPUTextureView,
): void {
  const { pipeline, bindGroupLayout } = getDepthResolvePipeline(device);
  const bindGroup = device.createBindGroup({
    label: "DepthResolveMSAA BG",
    layout: bindGroupLayout,
    entries: [{ binding: 0, resource: msaaDepthView }],
  });
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
