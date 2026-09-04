/// <reference types="@webgpu/types" />
/**
 * Shader-side resolve of the source-agnostic per-fragment
 * feature-ID G-buffer.
 *
 * `WebGPUSceneRendererPickPass` already rasterizes a 24-bit
 * object/feature ID for EVERY source (globe, 3D-tile, model, voxel,
 * Gaussian-splat) into ONE shared rgba8 pick target (`WebGPUPickFramebuffer`).
 * That target is therefore a unified, source-agnostic, per-fragment feature-ID
 * texture — but it was only ever consumed on the CPU (byte readback + registry
 * lookup), never sampled inside a shader.
 *
 * This helper closes that gap: given the pick FBO's ID texture it runs a
 * fullscreen post-process pass (`FeatureIdResolve.wgsl`) that `textureLoad`s the
 * ID at every fragment, decodes the 24-bit key on the GPU, and recolors each
 * distinct feature with a deterministic hash into an output texture. The output
 * is read back so callers can prove that cross-source feature IDs are resolvable
 * inside a PP pass (distinct sources → distinct in-shader colours), which is the
 * enabling primitive for the R-2a cross-source attribute join.
 *
 * Default-OFF: nothing constructs this unless an app/probe explicitly calls
 * `WebGPUPickFramebuffer.resolveFeatureIdRecolorAsync()`, so untouched scenes are
 * byte-identical. This is *distinct from* per-model glTF feature IDs
 * (`WebGPUModelFeatureId`), which are source-local, not cross-source.
 *
 * @module WebGPUFeatureIdTexture
 */

import FeatureIdResolveWGSL from "../../Shaders/WebGPU/PostProcess/FeatureIdResolve.js";
import { createFullscreenPipeline } from "./WebGPUPostProcessEffects.js";

/** Recolored feature-ID resolve result, read back to the CPU. */
export interface FeatureIdResolveResult {
  width: number;
  height: number;
  /** Tightly-packed RGBA8 recolor bytes, row-major, `width * height * 4` long. */
  pixels: Uint8Array;
}

const OUTPUT_FORMAT: GPUTextureFormat = "rgba8unorm";

export class WebGPUFeatureIdTexture {
  private _device: GPUDevice;
  private _pipeline: GPURenderPipeline | null = null;
  private _bindGroupLayout: GPUBindGroupLayout | null = null;
  private _outputTexture: GPUTexture | null = null;
  private _outputView: GPUTextureView | null = null;
  private _width: number = 0;
  private _height: number = 0;
  private _isDestroyed: boolean = false;

  constructor(device: GPUDevice) {
    this._device = device;
  }

  private _ensurePipeline(): GPURenderPipeline {
    if (this._pipeline && this._bindGroupLayout) {
      return this._pipeline;
    }
    const device = this._device;
    // textureLoad needs no sampler — a single sampled-texture binding suffices.
    this._bindGroupLayout = device.createBindGroupLayout({
      label: "FeatureIdResolve-BGL",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float", viewDimension: "2d" },
        },
      ],
    });
    this._pipeline = createFullscreenPipeline(
      device,
      "FeatureIdResolve",
      FeatureIdResolveWGSL,
      OUTPUT_FORMAT,
      this._bindGroupLayout,
    );
    return this._pipeline;
  }

  private _ensureOutput(width: number, height: number): void {
    if (
      this._outputTexture &&
      width === this._width &&
      height === this._height
    ) {
      return;
    }
    if (this._outputTexture) {
      this._outputTexture.destroy();
    }
    // RENDER_ATTACHMENT (pass target) | TEXTURE_BINDING (future re-sample) |
    // COPY_SRC (readback path).
    this._outputTexture = this._device.createTexture({
      label: "FeatureIdResolve-Output",
      size: { width, height },
      format: OUTPUT_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });
    this._outputView = this._outputTexture.createView();
    this._width = width;
    this._height = height;
  }

  /**
   * The persistent recolor output texture (`rgba8unorm`, RENDER_ATTACHMENT |
   * TEXTURE_BINDING | COPY_SRC). Populated by {@link record} / {@link resolveAsync};
   * `null` until the first resolve sizes it. Standing per-frame consumers
   * (R-2a cross-source join PP stage / a feature-ID debug overlay) re-sample this
   * across frames without any per-call reallocation.
   */
  get outputTexture(): GPUTexture | null {
    return this._outputTexture;
  }

  /** Texture view over {@link outputTexture}, or `null` before first resolve. */
  get outputView(): GPUTextureView | null {
    return this._outputView;
  }

  /**
   * Standing per-frame PP wiring.
   * Record the feature-ID recolor pass into a caller-provided per-frame command
   * encoder, writing into the persistent {@link outputTexture}. Unlike
   * {@link resolveAsync} this issues NO separate submit and NO readback — it is the
   * primitive a standing post-process pipeline needs so the recolor lives inside
   * the frame's own command stream and its output view can be sampled by a
   * downstream same-frame stage (the R-2a join / a debug overlay). The pipeline and
   * output texture persist across frames (only reallocated on size change).
   *
   * @param encoder - The per-frame command encoder to record into (not submitted here).
   * @param idTexture - The unified pick-ID target (rgba8unorm / bgra8unorm).
   * @param width - Texture width in pixels.
   * @param height - Texture height in pixels.
   * @returns The persistent output view (sample-able downstream), or `null` if unavailable.
   */
  record(
    encoder: GPUCommandEncoder,
    idTexture: GPUTexture,
    width: number,
    height: number,
  ): GPUTextureView | null {
    if (this._isDestroyed || width <= 0 || height <= 0) {
      return null;
    }
    const device = this._device;
    const pipeline = this._ensurePipeline();
    this._ensureOutput(width, height);
    if (!this._outputTexture || !this._outputView || !this._bindGroupLayout) {
      return null;
    }

    const bindGroup = device.createBindGroup({
      label: "FeatureIdResolve-BindGroup",
      layout: this._bindGroupLayout,
      entries: [{ binding: 0, resource: idTexture.createView() }],
    });

    const pass = encoder.beginRenderPass({
      label: "FeatureIdResolve-Pass",
      colorAttachments: [
        {
          view: this._outputView,
          loadOp: "clear" as GPULoadOp,
          storeOp: "store" as GPUStoreOp,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();

    return this._outputView;
  }

  /**
   * Run the feature-ID recolor pass over `idTexture` and read the result back.
   * Records via {@link record} into a private one-shot encoder, then copies the
   * result to a staging buffer and maps it — the CPU-readback convenience path
   * used by probes / tooling.
   *
   * @param idTexture - The unified pick-ID target (rgba8unorm / bgra8unorm).
   * @param width - Texture width in pixels.
   * @param height - Texture height in pixels.
   * @returns The recolored RGBA8 pixels, or null if the device/texture is gone.
   */
  async resolveAsync(
    idTexture: GPUTexture,
    width: number,
    height: number,
  ): Promise<FeatureIdResolveResult | null> {
    if (this._isDestroyed || width <= 0 || height <= 0) {
      return null;
    }
    const device = this._device;

    const encoder = device.createCommandEncoder({
      label: "FeatureIdResolve-Encoder",
    });
    const view = this.record(encoder, idTexture, width, height);
    if (!view || !this._outputTexture) {
      return null;
    }

    // 256-byte row alignment for copyTextureToBuffer readback.
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const bufferSize = bytesPerRow * height;
    const staging = device.createBuffer({
      label: "FeatureIdResolve-Staging",
      size: bufferSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    encoder.copyTextureToBuffer(
      { texture: this._outputTexture },
      { buffer: staging, bytesPerRow, rowsPerImage: height },
      [width, height],
    );
    device.queue.submit([encoder.finish()]);

    try {
      await staging.mapAsync(GPUMapMode.READ);
    } catch {
      staging.destroy();
      return null;
    }
    if (this._isDestroyed) {
      staging.destroy();
      return null;
    }
    const mapped = new Uint8Array(staging.getMappedRange());
    const pixels = new Uint8Array(width * height * 4);
    for (let row = 0; row < height; row++) {
      const srcOffset = row * bytesPerRow;
      const dstOffset = row * width * 4;
      pixels.set(mapped.subarray(srcOffset, srcOffset + width * 4), dstOffset);
    }
    staging.unmap();
    staging.destroy();

    return { width, height, pixels };
  }

  destroy(): void {
    this._isDestroyed = true;
    if (this._outputTexture) {
      this._outputTexture.destroy();
      this._outputTexture = null;
    }
    this._outputView = null;
    this._pipeline = null;
    this._bindGroupLayout = null;
  }
}

export default WebGPUFeatureIdTexture;
