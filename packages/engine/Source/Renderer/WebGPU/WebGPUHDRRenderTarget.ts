/**
 * HDR render target using rg11b10ufloat format for high dynamic range
 * post-processing. Requires the 'rg11b10ufloat-renderable' device feature.
 *
 * The rg11b10ufloat format provides:
 * - 11 bits for red, 11 bits for green, 10 bits for blue (no alpha)
 * - Unsigned float encoding (0 to 65024 range)
 * - Same memory footprint as rgba8unorm (4 bytes per pixel)
 * - Sufficient precision for bloom, tonemapping, and basic HDR effects
 *
 * For full precision HDR, use rgba16float (8 bytes/pixel) as fallback.
 *
 * @example
 * const hdr = new WebGPUHDRRenderTarget(device, {
 *   width: canvas.width,
 *   height: canvas.height,
 *   preferRG11B10: context.hasFeature('rg11b10ufloat-renderable'),
 * });
 *
 * // Render to HDR target, then tonemap to LDR for display
 * const renderPass = encoder.beginRenderPass(hdr.renderPassDescriptor);
 * // ... render scene ...
 * renderPass.end();
 * // Tonemap hdr.colorView → canvas
 * @module WebGPUHDRRenderTarget
 */

/// <reference types="@webgpu/types" />

/**
 * Options for creating an HDR render target.
 */
export interface HDRRenderTargetOptions {
  /** Render target width */
  width: number;
  /** Render target height */
  height: number;
  /** Prefer rg11b10ufloat if available (default: true) */
  preferRG11B10?: boolean;
  /** Force rgba16float even if rg11b10 is available (default: false) */
  forceRGBA16F?: boolean;
  /** Include depth/stencil attachment (default: true) */
  includeDepthStencil?: boolean;
  /** Depth format (default: 'depth24plus-stencil8') */
  depthFormat?: GPUTextureFormat;
  /** MSAA sample count (default: 1) */
  sampleCount?: number;
  /** Label prefix */
  label?: string;
}

/**
 * HDR format capabilities.
 */
export interface HDRFormatInfo {
  /** The actual format being used */
  format: GPUTextureFormat;
  /** Whether using the preferred compact format */
  isRG11B10: boolean;
  /** Bytes per pixel */
  bytesPerPixel: number;
  /** Human-readable description */
  description: string;
}

/**
 * HDR render target for post-processing with high dynamic range.
 *
 * Automatically selects the best HDR format based on device capabilities:
 * - rg11b10ufloat (4 bytes/pixel) — preferred, compact, same bandwidth as LDR
 * - rgba16float (8 bytes/pixel) — fallback, full precision with alpha
 */
export class WebGPUHDRRenderTarget {
  private _device: GPUDevice;
  private _width: number;
  private _height: number;
  private _format: GPUTextureFormat;
  private _depthFormat: GPUTextureFormat;
  private _sampleCount: number;
  private _label: string;

  // GPU resources
  private _colorTexture: GPUTexture | null = null;
  private _colorView: GPUTextureView | null = null;
  private _depthTexture: GPUTexture | null = null;
  private _depthView: GPUTextureView | null = null;
  private _msaaTexture: GPUTexture | null = null;
  private _msaaView: GPUTextureView | null = null;

  private _includeDepthStencil: boolean;
  private _isRG11B10: boolean;

  private _isDestroyed: boolean = false;

  /**
   * Creates a new HDR render target.
   *
   * @param device - The GPU device
   * @param options - Configuration options
   */
  constructor(device: GPUDevice, options: HDRRenderTargetOptions) {
    this._device = device;
    this._width = options.width;
    this._height = options.height;
    this._depthFormat = options.depthFormat ?? "depth24plus-stencil8";
    this._sampleCount = options.sampleCount ?? 1;
    this._includeDepthStencil = options.includeDepthStencil ?? true;
    this._label = options.label ?? "HDR RenderTarget";

    // Select HDR format
    const preferRG11B10 = options.preferRG11B10 ?? true;
    const forceRGBA16F = options.forceRGBA16F ?? false;

    if (
      !forceRGBA16F &&
      preferRG11B10 &&
      device.features.has("rg11b10ufloat-renderable")
    ) {
      this._format = "rg11b10ufloat";
      this._isRG11B10 = true;
    } else {
      this._format = "rgba16float";
      this._isRG11B10 = false;
    }

    this._createResources();
  }

  /**
   * Create GPU textures and views.
   * @private
   */
  private _createResources(): void {
    // Color texture (HDR)
    this._colorTexture = this._device.createTexture({
      size: { width: this._width, height: this._height },
      format: this._format,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
      sampleCount: this._sampleCount > 1 ? 1 : 1, // Resolve target is always 1
      label: `${this._label} Color (${this._format})`,
    });
    this._colorView = this._colorTexture.createView({
      label: `${this._label} Color View`,
    });

    // MSAA texture if needed
    if (this._sampleCount > 1) {
      this._msaaTexture = this._device.createTexture({
        size: { width: this._width, height: this._height },
        format: this._format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
        sampleCount: this._sampleCount,
        label: `${this._label} MSAA (${this._sampleCount}x)`,
      });
      this._msaaView = this._msaaTexture.createView({
        label: `${this._label} MSAA View`,
      });
    }

    // Depth/stencil texture
    if (this._includeDepthStencil) {
      this._depthTexture = this._device.createTexture({
        size: { width: this._width, height: this._height },
        format: this._depthFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
        sampleCount: this._sampleCount,
        label: `${this._label} Depth`,
      });
      this._depthView = this._depthTexture.createView({
        label: `${this._label} Depth View`,
      });
    }
  }

  /**
   * Resize the render target. Destroys and recreates GPU resources.
   *
   * @param width - New width
   * @param height - New height
   */
  resize(width: number, height: number): void {
    if (width === this._width && height === this._height) return;

    this._width = width;
    this._height = height;

    this._destroyResources();
    this._createResources();
  }

  /**
   * Get a render pass descriptor for rendering into this HDR target.
   *
   * @param clearColor - Clear color (default: black)
   * @returns GPURenderPassDescriptor
   */
  getRenderPassDescriptor(clearColor?: {
    r: number;
    g: number;
    b: number;
    a: number;
  }): GPURenderPassDescriptor {
    const clear = clearColor ?? { r: 0, g: 0, b: 0, a: 1 };

    const colorAttachment: GPURenderPassColorAttachment = this._msaaView
      ? {
          view: this._msaaView,
          resolveTarget: this._colorView!,
          clearValue: clear,
          loadOp: "clear" as GPULoadOp,
          storeOp: "store" as GPUStoreOp,
        }
      : {
          view: this._colorView!,
          clearValue: clear,
          loadOp: "clear" as GPULoadOp,
          storeOp: "store" as GPUStoreOp,
        };

    const desc: GPURenderPassDescriptor = {
      label: `${this._label} Render Pass`,
      colorAttachments: [colorAttachment],
    };

    if (this._depthView) {
      desc.depthStencilAttachment = {
        view: this._depthView,
        depthClearValue: 1.0,
        depthLoadOp: "clear",
        depthStoreOp: "store",
        stencilClearValue: 0,
        stencilLoadOp: "clear",
        stencilStoreOp: "store",
      };
    }

    return desc;
  }

  /**
   * Get information about the HDR format in use.
   */
  getFormatInfo(): HDRFormatInfo {
    return {
      format: this._format,
      isRG11B10: this._isRG11B10,
      bytesPerPixel: this._isRG11B10 ? 4 : 8,
      description: this._isRG11B10
        ? "rg11b10ufloat (compact HDR, 4 bytes/pixel)"
        : "rgba16float (full HDR, 8 bytes/pixel)",
    };
  }

  // --- Accessors ---

  /** The resolved color texture (for sampling in tonemapping) */
  get colorTexture(): GPUTexture | null {
    return this._colorTexture;
  }

  /** The color texture view */
  get colorView(): GPUTextureView | null {
    return this._colorView;
  }

  /** The HDR format in use */
  get format(): GPUTextureFormat {
    return this._format;
  }

  /** Width */
  get width(): number {
    return this._width;
  }

  /** Height */
  get height(): number {
    return this._height;
  }

  /** Whether this target uses the compact rg11b10 format */
  get isCompactHDR(): boolean {
    return this._isRG11B10;
  }

  /** Whether destroyed */
  get isDestroyed(): boolean {
    return this._isDestroyed;
  }

  /**
   * Destroy internal GPU resources without destroying the object.
   * @private
   */
  private _destroyResources(): void {
    this._colorTexture?.destroy();
    this._depthTexture?.destroy();
    this._msaaTexture?.destroy();
    this._colorTexture = null;
    this._depthTexture = null;
    this._msaaTexture = null;
    this._colorView = null;
    this._depthView = null;
    this._msaaView = null;
  }

  /** Destroy all GPU resources */
  destroy(): void {
    if (this._isDestroyed) return;
    this._destroyResources();
    this._isDestroyed = true;
  }
}

export default WebGPUHDRRenderTarget;
