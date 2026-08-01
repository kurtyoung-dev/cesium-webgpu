/// <reference types="@webgpu/types" />
/**
 * WebGPU equivalent of `Scene/EdgeFramebuffer.js`.
 *
 * C-R8-EDGE-FBO (Batch 44) — Owns the MRT render target used by the
 * `CESIUM_3D_TILE_EDGES` pass: three color attachments (edge color,
 * edge id + metadata, packed depth) plus a depth-stencil. Mirrors the
 * WebGL `FramebufferManager({ colorAttachmentsLength: 3, depthStencil: true })`
 * setup from `EdgeFramebuffer.js:27-33`.
 *
 * Sample count matches the scene framebuffer so edge-emitter pipelines
 * (built against scene MSAA) bind validly in this pass. Each MSAA
 * color attachment pairs with a single-sample resolve target so
 * downstream consumers sample the resolved view — WGSL can't
 * `textureSample` a multisampled color texture.
 *
 * The depth-stencil is MSAA-matched but NOT sampleable — edge
 * consumers read the packed-depth color attachment (location 2)
 * instead, which is already resolved when MSAA is on.
 *
 * @private
 */

export class WebGPUEdgeFramebuffer {
  private _device: GPUDevice | null = null;
  private _width: number = 0;
  private _height: number = 0;
  private _numSamples: number = 1;
  private _colorFormat: GPUTextureFormat = "bgra8unorm";

  // MSAA color attachments (one per MRT slot: color, id, packedDepth)
  private _colorTextures: GPUTexture[] = [];
  private _colorViews: GPUTextureView[] = [];

  // Single-sample resolve targets (present when _numSamples > 1;
  // otherwise alias to the attachment views so downstream consumers
  // always have a single-sample `view` to sample).
  private _resolveTextures: (GPUTexture | null)[] = [];
  private _resolveViews: (GPUTextureView | null)[] = [];

  // Depth-stencil (MSAA-matched, not sampleable — emitters write it,
  // consumers read the packed-depth color attachment instead).
  private _depthStencilTexture: GPUTexture | null = null;
  private _depthStencilView: GPUTextureView | null = null;

  private _isDestroyed: boolean = false;

  /**
   * The sample count used by the color attachments (matches scene).
   */
  get sampleCount(): number {
    return this._numSamples;
  }

  /**
   * The packed-depth color attachment's single-sample sampleable view
   * (location 2 in the MRT). `undefined` when the framebuffer isn't
   * initialized.
   */
  get depthSampleableView(): GPUTextureView | undefined {
    return this._resolveViews[2] ?? undefined;
  }

  /**
   * The edge color attachment's single-sample sampleable view
   * (location 0). Main consumer binding — composite stages sample
   * this to overlay edges onto scene color.
   */
  get colorSampleableView(): GPUTextureView | undefined {
    return this._resolveViews[0] ?? undefined;
  }

  /**
   * The edge id + metadata attachment's single-sample sampleable view
   * (location 1). Encodes edge type + feature ID, used by per-feature
   * edge gating.
   */
  get idSampleableView(): GPUTextureView | undefined {
    return this._resolveViews[1] ?? undefined;
  }

  /**
   * Returns `true` when the framebuffer has been initialized and the
   * underlying textures are allocated. False before the first call to
   * `update()`.
   */
  get isReady(): boolean {
    return (
      !this._isDestroyed &&
      this._colorTextures.length === 3 &&
      !!this._depthStencilView
    );
  }

  /**
   * Update framebuffer dimensions + sample count + color format.
   * Reallocates on any change.
   */
  update(
    device: GPUDevice,
    width: number,
    height: number,
    numSamples: number,
    colorFormat: GPUTextureFormat,
  ): void {
    if (width <= 0 || height <= 0) return;
    const needsRecreate =
      this._device !== device ||
      this._width !== width ||
      this._height !== height ||
      this._numSamples !== numSamples ||
      this._colorFormat !== colorFormat;
    if (!needsRecreate) return;

    this._destroyTextures();

    this._device = device;
    this._width = width;
    this._height = height;
    this._numSamples = numSamples;
    this._colorFormat = colorFormat;

    // MRT attachments mirror WebGL's EdgeFramebuffer layout:
    //   0: edge color (matches scene color format so emitters' fragment
    //      output type lines up with the scene color targets their
    //      pipelines were built for)
    //   1: edge id / metadata (fixed rgba8unorm — edge type + feature ID)
    //   2: packed depth (fixed rgba8unorm — czm_packDepth)
    const formats: GPUTextureFormat[] = [
      colorFormat,
      "rgba8unorm",
      "rgba8unorm",
    ];
    const labels = [
      "EdgeFramebuffer_Color",
      "EdgeFramebuffer_Id",
      "EdgeFramebuffer_Depth",
    ];
    const attachmentUsage =
      numSamples > 1
        ? GPUTextureUsage.RENDER_ATTACHMENT
        : GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;

    this._colorTextures = [];
    this._colorViews = [];
    this._resolveTextures = [];
    this._resolveViews = [];

    for (let i = 0; i < 3; i++) {
      const tex = device.createTexture({
        label: `${labels[i]}_${numSamples}x`,
        size: { width, height },
        format: formats[i],
        sampleCount: numSamples,
        usage: attachmentUsage,
      });
      this._colorTextures.push(tex);
      this._colorViews.push(tex.createView());

      if (numSamples > 1) {
        const resolve = device.createTexture({
          label: `${labels[i]}_resolve_1x`,
          size: { width, height },
          format: formats[i],
          sampleCount: 1,
          usage:
            GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        this._resolveTextures.push(resolve);
        this._resolveViews.push(resolve.createView());
      } else {
        this._resolveTextures.push(null);
        this._resolveViews.push(this._colorViews[i]);
      }
    }

    // Depth-stencil attachment. MSAA-matched to the color targets so
    // WebGPU's "all attachments share sample count" invariant holds.
    // Not sampleable — edges that need depth access sample the
    // packed-depth color attachment (location 2) instead.
    this._depthStencilTexture = device.createTexture({
      label: `EdgeFramebuffer_DepthStencil_${numSamples}x`,
      size: { width, height },
      format: "depth24plus-stencil8",
      sampleCount: numSamples,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this._depthStencilView = this._depthStencilTexture.createView();
  }

  /**
   * Build the MRT color attachments array for a render pass descriptor.
   * All three attachments use `loadOp: "clear"` with a transparent
   * clear value (WebGL also clears to `Color(0,0,0,0)` via
   * `EdgeFramebuffer._clearCommand`). Resolve targets are attached
   * automatically when MSAA is active.
   */
  buildColorAttachments(): GPURenderPassColorAttachment[] {
    const out: GPURenderPassColorAttachment[] = [];
    for (let i = 0; i < this._colorTextures.length; i++) {
      out.push({
        view: this._colorViews[i],
        resolveTarget:
          this._numSamples > 1
            ? (this._resolveViews[i] ?? undefined)
            : undefined,
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      });
    }
    return out;
  }

  /**
   * Build the depth-stencil attachment for a render pass descriptor.
   * Depth clears to 1.0 and stencil to 0, matching the WebGL
   * `ClearCommand({ depth: 1.0, stencil: 0 })` from
   * `EdgeFramebuffer.js:41-46`.
   */
  buildDepthStencilAttachment():
    GPURenderPassDepthStencilAttachment | undefined {
    if (!this._depthStencilView) return undefined;
    return {
      view: this._depthStencilView,
      depthLoadOp: "clear",
      depthStoreOp: "store",
      depthClearValue: 1.0,
      stencilLoadOp: "clear",
      stencilStoreOp: "store",
      stencilClearValue: 0,
    };
  }

  private _destroyTextures(): void {
    for (const tex of this._colorTextures) {
      tex.destroy();
    }
    for (const tex of this._resolveTextures) {
      tex?.destroy();
    }
    this._depthStencilTexture?.destroy();

    this._colorTextures = [];
    this._colorViews = [];
    this._resolveTextures = [];
    this._resolveViews = [];
    this._depthStencilTexture = null;
    this._depthStencilView = null;
  }

  destroy(): void {
    if (this._isDestroyed) return;
    this._destroyTextures();
    this._device = null;
    this._isDestroyed = true;
  }

  isDestroyed(): boolean {
    return this._isDestroyed;
  }
}

export default WebGPUEdgeFramebuffer;
