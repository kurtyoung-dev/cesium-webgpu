/// <reference types="@webgpu/types" />
/**
 * @module WebGPUTAAEffect
 *
 * Temporal Anti-Aliasing post-process effect. Accumulates jittered frames
 * into a history buffer using neighborhood clamping to suppress ghosting.
 *
 * Toggle: `scene.taaEnabled` (default false).
 * Pipeline position: after ColorGrading, before FXAA.
 *
 * Requires:
 *   - Sub-pixel camera jitter (Halton 2,3 sequence)
 *   - History ping-pong textures (managed internally)
 *   - Depth texture for future motion vector reprojection
 *
 * @private
 */

import type { PostProcessEffect } from "./WebGPUPostProcessEffects.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
import TAASource from "../../Shaders/WebGPU/PostProcess/TAA.js";

// TAA params UBO: texelSize(2) + blendWeight(1) + frameIndex(1) + jitterOffset(2) + pad(2) = 32 bytes
const TAA_PARAMS_BYTES = 32;

/**
 * Halton sequence evaluator — low-discrepancy quasi-random sequence
 * for sub-pixel jitter offsets. Uses bases 2 and 3 (standard for TAA).
 */
export function halton(index: number, base: number): number {
  let result = 0;
  let f = 1 / base;
  let i = index;
  while (i > 0) {
    result += f * (i % base);
    i = Math.floor(i / base);
    f /= base;
  }
  return result;
}

export class WebGPUTAAEffect implements PostProcessEffect {
  readonly name = "TAA";
  enabled = false;

  private _device: GPUDevice | null = null;
  private _pipeline: GPURenderPipeline | null = null;
  private _bindGroupLayout: GPUBindGroupLayout | null = null;
  private _paramsBuffer: GPUBuffer | null = null;
  private _paramsScratch = new Float32Array(TAA_PARAMS_BYTES / 4);

  // History ping-pong: write to _historyIndex, read from 1 - _historyIndex.
  private _historyTextures: [GPUTexture | null, GPUTexture | null] = [
    null,
    null,
  ];
  private _historyViews: [GPUTextureView | null, GPUTextureView | null] = [
    null,
    null,
  ];
  private _historyIndex = 0;

  private _width = 0;
  private _height = 0;
  private _format: GPUTextureFormat = "bgra8unorm";
  private _frameCounter = 0;
  private _sampler: GPUSampler | null = null;

  // Current jitter offset in UV space (set by the caller before execute).
  jitterX = 0;
  jitterY = 0;

  /** Blend weight: fraction of current frame in the blend (0.1 = 10%). */
  blendWeight = 0.1;

  initialize(
    device: GPUDevice,
    width: number,
    height: number,
    format: GPUTextureFormat,
  ): void {
    this._device = device;
    this._format = format;
    this._width = width;
    this._height = height;

    // Params UBO
    this._paramsBuffer = device.createBuffer({
      label: "TAA_Params",
      size: TAA_PARAMS_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Sampler
    this._sampler = device.createSampler({
      label: "TAA_Sampler",
      magFilter: "linear",
      minFilter: "linear",
    });

    // Bind group layout
    this._bindGroupLayout = device.createBindGroupLayout({
      label: "TAA_BGL",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "depth" },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
        {
          binding: 4,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
      ],
    });

    // Render pipeline
    const shaderModule = device.createShaderModule({
      label: "TAA_Shader",
      code: TAASource as unknown as string,
    });

    this._pipeline = device.createRenderPipeline({
      label: "TAA_Pipeline",
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this._bindGroupLayout],
      }),
      vertex: {
        module: shaderModule,
        entryPoint: "vertexMain",
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fragmentMain",
        targets: [{ format }],
      },
      primitive: { topology: "triangle-list" },
    });

    this._allocateHistoryTextures(width, height, format);
  }

  resize(width: number, height: number): void {
    if (width === this._width && height === this._height) {
      return;
    }
    this._width = width;
    this._height = height;
    this._allocateHistoryTextures(width, height, this._format);
    // Reset history on resize — old history is invalid at new resolution.
    this._frameCounter = 0;
  }

  execute(
    encoder: GPUCommandEncoder,
    sourceView: GPUTextureView,
    depthView: GPUTextureView | null,
    _sampler: GPUSampler,
  ): GPUTextureView {
    if (
      !this._device ||
      !this._pipeline ||
      !this._paramsBuffer ||
      !this._sampler ||
      !this._bindGroupLayout
    ) {
      return sourceView;
    }

    // Determine read/write history slots.
    const readIdx = 1 - this._historyIndex;
    const writeIdx = this._historyIndex;
    const historyReadView = this._historyViews[readIdx];
    const historyWriteView = this._historyViews[writeIdx];

    if (!historyReadView || !historyWriteView) {
      return sourceView;
    }

    // First frame: copy current to history (no blend).
    if (this._frameCounter === 0) {
      this._frameCounter++;
      this._historyIndex = 1 - this._historyIndex;
      return sourceView;
    }

    // Upload params.
    const p = this._paramsScratch;
    p[0] = 1.0 / this._width;
    p[1] = 1.0 / this._height;
    p[2] = this.blendWeight;
    const u32View = new Uint32Array(p.buffer);
    u32View[3] = this._frameCounter;
    p[4] = this.jitterX;
    p[5] = this.jitterY;
    p[6] = 0;
    p[7] = 0;
    this._device.queue.writeBuffer(this._paramsBuffer, 0, p);

    // Use a dummy depth view if none provided.
    // The TAA shader currently doesn't use depth for motion vectors,
    // but the bind group layout requires it.
    if (!depthView) {
      // Can't run without depth — pass through.
      this._frameCounter++;
      return sourceView;
    }

    // Build bind group.
    const bg = this._device.createBindGroup({
      label: "TAA_BG",
      layout: this._bindGroupLayout,
      entries: [
        { binding: 0, resource: sourceView },
        { binding: 1, resource: historyReadView },
        { binding: 2, resource: depthView },
        { binding: 3, resource: this._sampler },
        { binding: 4, resource: { buffer: this._paramsBuffer } },
      ],
    });

    // Render into the write history slot.
    const pass = encoder.beginRenderPass({
      label: "TAA_Pass",
      colorAttachments: [
        {
          view: historyWriteView,
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    pass.setPipeline(this._pipeline);
    pass.setBindGroup(0, bg);
    pass.draw(3, 1, 0, 0);
    pass.end();

    // Flip history slots for next frame.
    this._historyIndex = 1 - this._historyIndex;
    this._frameCounter++;

    return historyWriteView;
  }

  /**
   * Compute jitter offset for the current frame using Halton(2,3).
   * Returns offset in NDC space (apply to projection matrix columns 2,0 and 2,1).
   */
  computeJitter(
    frameIndex: number,
    screenWidth: number,
    screenHeight: number,
  ): { x: number; y: number } {
    const hx = halton(frameIndex % 16 + 1, 2);
    const hy = halton(frameIndex % 16 + 1, 3);
    const x = ((hx - 0.5) * 2.0) / screenWidth;
    const y = ((hy - 0.5) * 2.0) / screenHeight;
    this.jitterX = (hx - 0.5) / screenWidth;
    this.jitterY = (hy - 0.5) / screenHeight;
    return { x, y };
  }

  getStatistics(): object {
    return {
      enabled: this.enabled,
      frameCounter: this._frameCounter,
      blendWeight: this.blendWeight,
      jitterX: this.jitterX,
      jitterY: this.jitterY,
      historyIndex: this._historyIndex,
    };
  }

  destroy(): void {
    for (let i = 0; i < 2; i++) {
      if (this._historyTextures[i]) {
        this._historyTextures[i]!.destroy();
        this._historyTextures[i] = null;
        this._historyViews[i] = null;
      }
    }
    if (this._paramsBuffer) {
      this._paramsBuffer.destroy();
      this._paramsBuffer = null;
    }
    this._pipeline = null;
    this._bindGroupLayout = null;
    this._device = null;
  }

  private _allocateHistoryTextures(
    width: number,
    height: number,
    format: GPUTextureFormat,
  ): void {
    if (!this._device) return;
    for (let i = 0; i < 2; i++) {
      if (this._historyTextures[i]) {
        this._historyTextures[i]!.destroy();
      }
      this._historyTextures[i] = this._device.createTexture({
        label: `TAA_History_${i}`,
        size: { width, height },
        format,
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING,
      });
      this._historyViews[i] = this._historyTextures[i]!.createView({
        label: `TAA_History_${i}_View`,
      });
    }
  }
}
