/// <reference types="@webgpu/types" />

import type { WebGPUPassTimestampProvider } from "./WebGPUPerformanceManager.js";
/**
 * WebGPU Post-Process Effects
 *
 * Complex multi-pass post-processing effects that manage their own
 * intermediate textures and render passes. Each effect implements the
 * same interface for integration with WebGPUPostProcessPipeline.
 *
 * Effects:
 * - BloomEffect: BrightPass → GaussianBlur (H+V) → BloomComposite
 * - AmbientOcclusionEffect: SSAO Generate → GaussianBlur (H+V) → AO Modulate
 * - DepthOfFieldEffect: GaussianBlur (H+V) → DoF Composite
 *
 * @private
 */

// Effect classes live in per-effect files. This file retains the shared
// helper layer, the `PostProcessEffect` interface, and re-exports of the
// public-API symbols, so external callers continue to resolve through the
// parent module.
//
// Per-effect files:
//   - WebGPUBloomEffect.ts            (BloomConfig, BloomEffect)
//   - WebGPUAmbientOcclusionEffect.ts (AmbientOcclusionConfig, AOAlgorithm,
//                                      AmbientOcclusionEffect)
//   - WebGPUDepthOfFieldEffect.ts     (DepthOfFieldConfig, DepthOfFieldEffect)
//   - WebGPUGodRayEffect.ts           (GodRayConfig, GodRayEffect)

// ======================================================================
//  Shared helpers
// ======================================================================

/** Create a standard fullscreen render pipeline from WGSL source. */
export function createFullscreenPipeline(
  device: GPUDevice,
  label: string,
  wgsl: string,
  format: GPUTextureFormat,
  bindGroupLayout: GPUBindGroupLayout,
): GPURenderPipeline {
  const module = device.createShaderModule({
    label: `${label}-Shader`,
    code: wgsl,
  });
  const pipelineLayout = device.createPipelineLayout({
    label: `${label}-PipelineLayout`,
    bindGroupLayouts: [bindGroupLayout],
  });
  return device.createRenderPipeline({
    label: `${label}-Pipeline`,
    layout: pipelineLayout,
    vertex: { module, entryPoint: "vertexMain" },
    fragment: { module, entryPoint: "fragmentMain", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });
}

export function createTexture(
  device: GPUDevice,
  label: string,
  width: number,
  height: number,
  format: GPUTextureFormat,
): GPUTexture {
  return device.createTexture({
    label,
    size: { width, height },
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
}

export function createUniformBuffer(
  device: GPUDevice,
  label: string,
  data: Float32Array,
): GPUBuffer {
  const buf = device.createBuffer({
    label,
    size: Math.max(data.byteLength, 16),
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buf, 0, data as Float32Array<ArrayBuffer>);
  return buf;
}

export function executePass(
  encoder: GPUCommandEncoder,
  label: string,
  pipeline: GPURenderPipeline,
  bindGroup: GPUBindGroup,
  targetView: GPUTextureView,
  timestampProvider?: WebGPUPassTimestampProvider,
): void {
  const descriptor: GPURenderPassDescriptor = {
    label,
    colorAttachments: [
      {
        view: targetView,
        loadOp: "clear" as GPULoadOp,
        storeOp: "store" as GPUStoreOp,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      },
    ],
  };
  const pass = encoder.beginRenderPass(
    timestampProvider?.withRenderPassTimestamps(descriptor) ?? descriptor,
  );
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(3);
  pass.end();
}

// ======================================================================
//  PostProcessEffect interface
// ======================================================================

export interface PostProcessEffect {
  readonly name: string;
  enabled: boolean;
  initialize(
    device: GPUDevice,
    width: number,
    height: number,
    format: GPUTextureFormat,
  ): void;
  resize(width: number, height: number): void;
  /**
   * Execute the effect. Returns the texture view containing the result.
   * @param encoder - Command encoder
   * @param sourceView - Scene color input
   * @param depthView - Scene depth input (may be null for effects that don't need depth)
   * @param sampler - Shared linear sampler
   */
  execute(
    encoder: GPUCommandEncoder,
    sourceView: GPUTextureView,
    depthView: GPUTextureView | null,
    sampler: GPUSampler,
  ): GPUTextureView;
  destroy(): void;
}

// Re-exports from per-effect modules

export { BloomEffect } from "./WebGPUBloomEffect.js";
export type { BloomConfig } from "./WebGPUBloomEffect.js";

export { AmbientOcclusionEffect } from "./WebGPUAmbientOcclusionEffect.js";
export type {
  AmbientOcclusionConfig,
  AOAlgorithm,
} from "./WebGPUAmbientOcclusionEffect.js";

export { DepthOfFieldEffect } from "./WebGPUDepthOfFieldEffect.js";
export type { DepthOfFieldConfig } from "./WebGPUDepthOfFieldEffect.js";

export { GodRayEffect } from "./WebGPUGodRayEffect.js";
export type { GodRayConfig } from "./WebGPUGodRayEffect.js";

export { HeatShimmerEffect } from "./WebGPUHeatShimmerEffect.js";
export type { HeatShimmerConfig } from "./WebGPUHeatShimmerEffect.js";

export { ColdOpticsEffect } from "./WebGPUColdOpticsEffect.js";
export type { ColdOpticsConfig } from "./WebGPUColdOpticsEffect.js";
