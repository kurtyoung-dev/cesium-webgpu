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
  // Per-pixel velocity texture written by the model fragment shader at
  // `@location(1)` when MRT velocity output is enabled. It is allocated lazily
  // when TAA first needs it and reset on resize. The TAA resolve shader binds
  // velocity as a regular `texture_2d`, so this `rg16float` target is always
  // single-sample.
  private _velocityTexture: GPUTexture | null = null;
  private _velocityView: GPUTextureView | null = null;
  // Refraction scene-color capture target. Holds an opaque-only snapshot of
  // scene color
  // taken between OPAQUE/MASK passes and the TRANSLUCENT pass; the
  // model FS samples it at @group(2)@binding(23) when a primitive
  // declares KHR_materials_transmission. The capture path uses
  // `GPUCommandEncoder.copyTextureToTexture` from scene color into
  // this texture. The source must be single-sample, so MSAA scenes populate
  // the color resolve target before capture. Allocated lazily on first use and
  // reset on resize.
  // Format matches `_colorFormat` so the copy is a same-format blit.
  private _refractionTexture: GPUTexture | null = null;
  private _refractionView: GPUTextureView | null = null;
  private _refractionFormat: GPUTextureFormat | null = null;

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
   * Per-pixel motion-vector texture in single-sample `rg16float` format.
   * Allocated on first access via
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
   * View of the opaque-only refraction scene-color snapshot. Returns null
   * until {@link ensureRefractionTexture} is invoked at least once
   * (the SceneRenderer's transmission capture pass is the only caller).
   * Bound by transmissive Model primitives at @binding(23) so the FS
   * can sample scene color along the refracted view direction.
   */
  get refractionView(): GPUTextureView | null {
    return this._refractionView;
  }

  /**
   * Allocate (or reuse) the refraction capture texture matching scene
   * color format and dimensions. Idempotent — only re-allocates when
   * device, dimensions, or color format changes (the latter happens
   * when HDR toggles flip rgba16float ↔ canvas format). Caller is the
   * SceneRenderer at the start of the transmission capture pass.
   */
  ensureRefractionTexture(
    device: GPUDevice,
    width: number,
    height: number,
    format: GPUTextureFormat,
  ): GPUTextureView | null {
    if (
      this._refractionTexture &&
      this._device === device &&
      this._refractionFormat === format &&
      this._refractionTexture.width === width &&
      this._refractionTexture.height === height
    ) {
      return this._refractionView;
    }
    this._refractionTexture?.destroy();
    this._refractionTexture = device.createTexture({
      label: "SceneFramebuffer-RefractionCapture",
      size: [width, height, 1],
      format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this._refractionView = this._refractionTexture.createView();
    this._refractionFormat = format;
    return this._refractionView;
  }

  /**
   * Captures the current scene color texture into the refraction target with a
   * same-format `copyTextureToTexture` blit. MSAA scenes must populate the
   * single-sample color resolve before this call; `getColorTexture()` selects
   * that allocation but does not perform the resolve. Caller is the
   * SceneRenderer between the opaque and translucent passes; after this call
   * the texture
   * bound to model FS @binding(23) reflects opaque-only scene color
   * and transmissive primitives can sample it for the refraction
   * lookup.
   *
   * Returns true on success, false if the source texture or target
   * texture is missing (caller should skip the transmission pass for
   * the current frame). The method does not end the current render
   * pass — caller is responsible for that and for resuming after.
   */
  captureRefraction(
    device: GPUDevice,
    encoder: GPUCommandEncoder,
    width: number,
    height: number,
  ): boolean {
    const colorTex = this.colorTexture;
    if (!colorTex || !this._colorFormat) {
      return false;
    }
    this.ensureRefractionTexture(device, width, height, this._colorFormat);
    if (!this._refractionTexture) {
      return false;
    }
    encoder.copyTextureToTexture(
      { texture: colorTex, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
      {
        texture: this._refractionTexture,
        mipLevel: 0,
        origin: { x: 0, y: 0, z: 0 },
      },
      { width, height, depthOrArrayLayers: 1 },
    );
    return true;
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
   * Single-sample view for downstream depth reads. In single-sample mode this
   * is a depth-only aspect view suitable for `texture_depth_2d`. In MSAA mode
   * it is the `r16float` color resolve suitable for `texture_2d<f32>`, populated
   * by {@link resolveDepthMSAA} after the scene pass.
   */
  get depthSampleableView(): GPUTextureView | undefined {
    return this._colorTarget?.getDepthSampleableView();
  }

  /**
   * Converts sample zero of the MSAA depth attachment into the single-sample
   * `r16float` color target. No-op in single-sample mode, where the depth
   * aspect view is already sampleable. The SceneRenderer invokes this after
   * the main scene render pass closes so environmental effects, ambient
   * occlusion, and depth of field read current-frame depth.
   */
  resolveDepthMSAA(encoder: GPUCommandEncoder): void {
    this._colorTarget?.resolveDepthMSAA?.(encoder);
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
    // Invalidate velocity so the next `ensureVelocityTexture` call reallocates
    // at the new dimensions.
    this._velocityTexture?.destroy();
    this._velocityTexture = null;
    this._velocityView = null;
    // Invalidate refraction capture so the next `ensureRefractionTexture` call
    // reallocates at the new dimensions and color format.
    this._refractionTexture?.destroy();
    this._refractionTexture = null;
    this._refractionView = null;
    this._refractionFormat = null;

    // Create main color target with MSAA + depth-stencil.
    //
    // `depthSamplable` makes depth available to later passes. Single-sample
    // scenes expose a depth-only aspect view directly; MSAA scenes use that
    // view as the input to a per-frame conversion into a sampleable
    // single-sample `r16float` target.
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
   * Compatibility hook for preparing scene color textures.
   */
  prepareColorTextures(): void {
    // No setup is required here. Render-pass descriptors either attach a
    // `resolveTarget` or deliberately defer resolution to an explicit
    // demand-resolve pass.
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
    this._refractionTexture?.destroy();
    this._colorTarget = null;
    this._idTarget = null;
    this._velocityTexture = null;
    this._velocityView = null;
    this._refractionTexture = null;
    this._refractionView = null;
    this._refractionFormat = null;
    this._isDestroyed = true;
  }

  get isDestroyed(): boolean {
    return this._isDestroyed;
  }
}
