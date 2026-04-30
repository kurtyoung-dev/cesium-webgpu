/// <reference types="@webgpu/types" />
/**
 * WebGPU equivalent of SceneFramebuffer.js
 *
 * Manages the main scene color + depth render targets for WebGPU.
 * Supports MSAA, HDR, and provides access to resolved color/depth textures.
 *
 * In the WebGL path, SceneFramebuffer wraps two FramebufferManagers
 * (color + id). Here we use WebGPU render targets directly.
 *
 * @private
 */

import { WebGPURenderTarget } from "./WebGPURenderTarget.js";

// Texture formats for HDR rendering
const HDR_FORMAT_PREFERRED = "rgba16float" as GPUTextureFormat;
const HDR_FORMAT_FALLBACK = "rg11b10ufloat" as GPUTextureFormat;
const LDR_FORMAT = "rgba8unorm" as GPUTextureFormat;

export class WebGPUSceneFramebuffer {
  private _device: GPUDevice | null = null;
  private _colorTarget: WebGPURenderTarget | null = null;
  private _idTarget: WebGPURenderTarget | null = null;
  private _width: number = 0;
  private _height: number = 0;
  private _numSamples: number = 1;
  private _hdr: boolean = false;
  private _colorFormat: GPUTextureFormat = LDR_FORMAT;
  private _isDestroyed: boolean = false;
  // TAA Slice 2d (Batch 104) — per-pixel velocity texture written by
  // the model FS @location(1) when MRT velocity output is enabled.
  // Lazily allocated the first frame TAA is enabled; reset on resize.
  // rg16float, single-sample (MSAA velocity isn't sensible — the TAA
  // resolve pass samples the resolved color, so velocity must match).
  private _velocityTexture: GPUTexture | null = null;
  private _velocityView: GPUTextureView | null = null;

  /**
   * The main color render target (MSAA if numSamples > 1).
   */
  get colorTarget(): WebGPURenderTarget | null {
    return this._colorTarget;
  }

  /**
   * The WebGPU texture format used by the scene color target. Tracks
   * HDR state — `rgba16float` (or the `rg11b10ufloat` fallback) when
   * HDR is enabled, the canvas format otherwise. Feature renderers
   * that allocate their own framebuffers which must interop with
   * scene pipelines (e.g., InvertClassification's `classifiedTexture`,
   * OIT accumulation targets) should read this instead of hardcoding
   * `navigator.gpu.getPreferredCanvasFormat()`.
   */
  get colorFormat(): GPUTextureFormat {
    return this._colorFormat;
  }

  /**
   * True when the scene is currently rendering in HDR mode.
   */
  get hdr(): boolean {
    return this._hdr;
  }

  /**
   * The ID render target for object picking.
   */
  get idTarget(): WebGPURenderTarget | null {
    return this._idTarget;
  }

  /**
   * TAA Slice 2d (Batch 104) — per-pixel motion-vector texture.
   * `rg16float`, single-sample. Allocated on first access via
   * {@link ensureVelocityTexture} so static scenes (TAA off) don't pay
   * the W*H*4 bytes upfront. Returns the texture view that velocity-
   * aware pipelines (model FS @location(1)) write into and the TAA
   * shader samples through `motionTex` at @binding(5).
   */
  get velocityView(): GPUTextureView | null {
    return this._velocityView;
  }

  /**
   * Allocate (or reuse) the per-pixel velocity texture. Returns the
   * view bound to TAA's `motionTex`. Idempotent — only re-allocates
   * when device or dimensions change. Caller is the SceneRenderer at
   * the start of the velocity pass.
   */
  ensureVelocityTexture(
    device: GPUDevice,
    width: number,
    height: number,
  ): GPUTextureView | null {
    if (
      this._velocityTexture &&
      this._device === device &&
      this._velocityTexture.width === width &&
      this._velocityTexture.height === height
    ) {
      return this._velocityView;
    }
    this._velocityTexture?.destroy();
    this._velocityTexture = device.createTexture({
      label: "SceneFramebuffer-Velocity",
      size: [width, height, 1],
      format: "rg16float",
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_SRC,
    });
    this._velocityView = this._velocityTexture.createView();
    return this._velocityView;
  }

  /**
   * The resolved color texture (after MSAA resolve).
   */
  get colorTexture(): GPUTexture | undefined {
    return this._colorTarget?.getColorTexture() ?? undefined;
  }

  /**
   * The depth-stencil texture.
   */
  get depthStencilTexture(): GPUTexture | undefined {
    return this._colorTarget?.getDepthTexture() ?? undefined;
  }

  /**
   * Depth-only aspect view suitable for binding to `texture_depth_2d` in
   * WGSL. Returns undefined when MSAA is on (multisampled depth can't be
   * sampled). Used by the Tier 2 debug depth-as-color overlay.
   */
  get depthSampleableView(): GPUTextureView | undefined {
    return this._colorTarget?.getDepthSampleableView();
  }

  /**
   * The GPURenderPassDescriptor for writing to this framebuffer.
   */
  get framebuffer(): GPURenderPassDescriptor | null {
    return this._colorTarget?.renderPassDescriptor ?? null;
  }

  /**
   * The GPURenderPassDescriptor for the ID framebuffer.
   */
  get idFramebuffer(): GPURenderPassDescriptor | null {
    return this._idTarget?.renderPassDescriptor ?? null;
  }

  /**
   * Update framebuffer dimensions, sample count, and HDR mode.
   * Only recreates GPU resources when parameters change.
   */
  update(
    device: GPUDevice,
    width: number,
    height: number,
    hdr: boolean,
    numSamples: number,
    canvasFormat: GPUTextureFormat,
  ): void {
    if (width <= 0 || height <= 0) return;

    const colorFormat = hdr ? this._pickHDRFormat(device) : canvasFormat;

    const needsRecreate =
      this._device !== device ||
      this._width !== width ||
      this._height !== height ||
      this._numSamples !== numSamples ||
      this._hdr !== hdr ||
      this._colorFormat !== colorFormat;

    if (!needsRecreate) return;

    this._device = device;
    this._width = width;
    this._height = height;
    this._numSamples = numSamples;
    this._hdr = hdr;
    this._colorFormat = colorFormat;

    // Destroy existing targets
    this._colorTarget?.destroy();
    this._idTarget?.destroy();
    // TAA Slice 2d (Batch 104) — invalidate velocity texture too so
    // the next `ensureVelocityTexture` call reallocates at the new
    // dimensions.
    this._velocityTexture?.destroy();
    this._velocityTexture = null;
    this._velocityView = null;

    // Create main color target with MSAA + depth-stencil.
    //
    // depthSamplable=true makes the depth attachment usable as a sampled
    // texture in subsequent passes (depth-as-color debug overlay, future
    // soft-particle / depth-aware effects). Only takes effect when
    // sampleCount === 1 — multisampled depth textures can't be sampled
    // in WGSL, so MSAA scenes silently fall back to non-sampleable depth.
    this._colorTarget = new WebGPURenderTarget(device, {
      name: "SceneFramebuffer-Color",
      width,
      height,
      colorFormats: [colorFormat],
      depthStencilFormat: "depth24plus-stencil8",
      sampleCount: numSamples,
      depthSamplable: true,
    });

    // Create ID target for picking (no MSAA, always rgba8unorm)
    this._idTarget = new WebGPURenderTarget(device, {
      name: "SceneFramebuffer-ID",
      width,
      height,
      colorFormats: ["rgba8unorm"],
      depthStencilFormat: "depth24plus-stencil8",
      sampleCount: 1,
    });
  }

  /**
   * Clear both framebuffers.
   */
  clear(
    encoder: GPUCommandEncoder,
    clearColor: { red: number; green: number; blue: number; alpha: number },
  ): void {
    if (this._colorTarget) {
      this._clearTarget(encoder, this._colorTarget, clearColor);
    }
    if (this._idTarget) {
      this._clearTarget(encoder, this._idTarget, {
        red: 0,
        green: 0,
        blue: 0,
        alpha: 0,
      });
    }
  }

  /**
   * If MSAA is enabled, resolve the multisample color texture to a single-sample texture.
   */
  prepareColorTextures(): void {
    // WebGPU MSAA resolve is automatic when using resolveTarget in the render pass descriptor.
    // The WebGPURenderTarget handles this in its renderPassDescriptor.
    // No manual resolve step needed.
  }

  /**
   * Pick the best HDR format supported by the device.
   */
  private _pickHDRFormat(device: GPUDevice): GPUTextureFormat {
    // rg11b10ufloat is more compact (4 bytes/pixel vs 8) but needs the renderable feature
    const features = device.features;
    if (features.has("rg11b10ufloat-renderable")) {
      return HDR_FORMAT_FALLBACK; // Actually preferred due to bandwidth
    }
    return HDR_FORMAT_PREFERRED;
  }

  /**
   * Clear a single render target via a load-clear render pass.
   */
  private _clearTarget(
    encoder: GPUCommandEncoder,
    target: WebGPURenderTarget,
    clearColor: { red: number; green: number; blue: number; alpha: number },
  ): void {
    const desc = target.getClearPassDescriptor(clearColor);
    if (desc) {
      const pass = encoder.beginRenderPass(desc);
      pass.end();
    }
  }

  destroy(): void {
    if (this._isDestroyed) return;
    this._colorTarget?.destroy();
    this._idTarget?.destroy();
    this._velocityTexture?.destroy();
    this._colorTarget = null;
    this._idTarget = null;
    this._velocityTexture = null;
    this._velocityView = null;
    this._isDestroyed = true;
  }

  get isDestroyed(): boolean {
    return this._isDestroyed;
  }
}
