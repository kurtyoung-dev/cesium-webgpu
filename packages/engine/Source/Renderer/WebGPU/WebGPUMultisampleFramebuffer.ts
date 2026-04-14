/**
 * WebGPU equivalent of MultisampleFramebuffer.js.
 *
 * In WebGL2, MSAA requires two framebuffers:
 *   1. Render FBO with multisampled renderbuffer attachments
 *   2. Resolve FBO with texture attachments
 *   + explicit `blitFramebuffers()` to resolve MSAA → texture
 *
 * In WebGPU, MSAA is handled natively by the render pass descriptor:
 *   - Color attachment uses a multisampled texture (`view`)
 *   - `resolveTarget` is set to a single-sampled texture
 *   - The GPU resolves automatically at the end of the render pass
 *
 * `WebGPURenderTarget.ts` already implements this pattern. This class
 * wraps it with the same API surface as `MultisampleFramebuffer.js` so
 * `FramebufferManager.js` and other consumers can work unchanged.
 *
 * @private
 */

interface MultisampleFramebufferOptions {
  context: CesiumGraphicsContext;
  width: number;
  height: number;
  colorFormats?: GPUTextureFormat[];
  depthStencilFormat?: GPUTextureFormat;
  sampleCount?: number;
  destroyAttachments?: boolean;
}

class WebGPUMultisampleFramebuffer {
  private _context: CesiumGraphicsContext | null;
  private _renderTarget: WebGPURenderTargetLike | null; // WebGPURenderTarget
  private _width: number;
  private _height: number;
  private _sampleCount: number;
  private _destroyed: boolean;

  constructor(options: MultisampleFramebufferOptions) {
    const context = options.context;
    const width = options.width;
    const height = options.height;
    const sampleCount = options.sampleCount ?? 4;

    this._context = context;
    this._width = width;
    this._height = height;
    this._sampleCount = sampleCount;
    this._destroyed = false;

    // WebGPURenderTarget handles MSAA natively:
    // - Creates multisampled color textures
    // - Creates single-sampled resolve targets
    // - Wires resolveTarget in GPURenderPassDescriptor
    const renderTarget = context.createRenderTarget?.({
      width: width,
      height: height,
      colorFormats: options.colorFormats ?? [
        context._canvasFormat ?? "bgra8unorm",
      ],
      depthStencilFormat: options.depthStencilFormat ?? "depth24plus-stencil8",
      sampleCount: sampleCount,
      label: "WebGPUMultisampleFramebuffer",
    });
    this._renderTarget = (renderTarget as WebGPURenderTargetLike) ?? null;

    // Fallback: already null if context doesn't have createRenderTarget
  }

  /**
   * Returns the render target for drawing (MSAA).
   * In WebGL this returned the multisampled renderbuffer FBO.
   * In WebGPU this returns the render target whose pass descriptor
   * already includes the MSAA texture as the primary view.
   */
  getRenderFramebuffer(): WebGPURenderTargetLike | null {
    return this._renderTarget;
  }

  /**
   * Returns the resolve target for reading (single-sampled textures).
   * In WebGL this returned the texture FBO after blit.
   * In WebGPU the resolve targets are inside the render target and
   * are automatically populated when the render pass ends.
   */
  getColorFramebuffer(): WebGPURenderTargetLike | null {
    return this._renderTarget;
  }

  /**
   * Returns a color texture from the resolve target.
   * After the render pass ends, the resolved (single-sampled) texture
   * is available for sampling.
   */
  getColorTexture(index: number = 0): GPUTexture | undefined {
    if (this._renderTarget) {
      return this._renderTarget.getColorTexture?.(index);
    }
    return undefined;
  }

  /**
   * Returns the depth-stencil texture.
   */
  getDepthStencilTexture(): GPUTexture | undefined {
    if (this._renderTarget) {
      return this._renderTarget.getDepthTexture?.();
    }
    return undefined;
  }

  /**
   * Resolve MSAA samples to single-sampled textures.
   *
   * In WebGL2 this calls `gl.blitFramebuffer()` to copy from the
   * multisampled renderbuffers to the texture FBO.
   *
   * In WebGPU this is a **no-op** because MSAA resolve happens
   * automatically at the end of the render pass when `resolveTarget`
   * is set in the color attachment descriptor. The GPU handles the
   * resolve implicitly.
   *
   * @param context - The rendering context
   * @param blitStencil - Whether to also resolve stencil (ignored in WebGPU)
   */
  blitFramebuffers(
    context?: CesiumGraphicsContext,
    blitStencil?: boolean,
  ): void {
    // No-op in WebGPU — resolve happens automatically via resolveTarget
    // in the GPURenderPassDescriptor color attachments.
  }

  /**
   * Resize the multisample framebuffer.
   */
  resize(width: number, height: number): void {
    if (this._width === width && this._height === height) {
      return;
    }
    this._width = width;
    this._height = height;

    if (this._renderTarget) {
      this._renderTarget.resize?.(width, height);
    }
  }

  get width(): number {
    return this._width;
  }

  get height(): number {
    return this._height;
  }

  get sampleCount(): number {
    return this._sampleCount;
  }

  isDestroyed(): boolean {
    return this._destroyed;
  }

  destroy(): void {
    if (this._renderTarget) {
      this._renderTarget.destroy?.();
    }
    this._renderTarget = null;
    this._context = null;
    this._destroyed = true;
  }
}

export default WebGPUMultisampleFramebuffer;
