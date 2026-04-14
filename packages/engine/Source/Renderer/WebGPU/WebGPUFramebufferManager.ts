/**
 * @module WebGPUFramebufferManager
 *
 * Manages WebGPU render targets (color, depth, stencil) with MSAA support.
 * This is the WebGPU equivalent of FramebufferManager.js for WebGL.
 *
 * In WebGPU there are no framebuffer objects. Instead, render pass descriptors
 * reference color/depth textures. This class manages the underlying textures,
 * handles resize, MSAA resolve, and provides GPURenderPassDescriptor generation.
 *
 * Usage patterns this supports:
 * - **Globe depth**: Single depth texture for terrain depth readback
 * - **OIT**: Multiple render targets (MRT) for weighted blended OIT
 * - **Shadow maps**: Depth-only render targets for shadow cascades
 * - **Post-processing**: Color+depth chain for bloom, FXAA, SSAO, HDR
 * - **Pick framebuffer**: Color render target for GPU pick readback
 *
 * @example
 * // OIT framebuffer with 2 color attachments + depth-stencil
 * const oitFB = new WebGPUFramebufferManager({
 *   colorAttachmentsLength: 2,
 *   depthStencil: true,
 *   numSamples: 4,
 * });
 * oitFB.update(device, width, height);
 * const passDesc = oitFB.getRenderPassDescriptor();
 * const encoder = commandEncoder.beginRenderPass(passDesc);
 *
 * @private
 */

/// <reference types="@webgpu/types" />

import defined from "../../Core/defined.js";
import DeveloperError from "../../Core/DeveloperError.js";

// =========================================================================
// Transient attachment helper (WGF-2)
// =========================================================================
//
// `GPUTextureUsage.TRANSIENT_ATTACHMENT` is an optional flag that lets a
// driver keep a render-attachment-only texture in tile memory and never
// write its contents back to DRAM. It saves substantial bandwidth on
// tile-based mobile GPUs (Apple, Mali, Adreno) for textures that:
//   - have RENDER_ATTACHMENT in their usage
//   - have NO TEXTURE_BINDING / STORAGE_BINDING / COPY_SRC / COPY_DST
//   - are written by exactly one render pass per frame
//   - use loadOp=clear (no preserved content)
//   - use storeOp=discard (or are an MSAA source resolved + discarded)
//
// The bit is not yet enabled by default in every browser. We feature-detect
// via `device.features.has("transient-attachments")` (the spec name during
// the Chrome rollout) and fall back to 0 — OR-ing 0 is a no-op so callers
// don't need to branch.
function getTransientAttachmentBit(device: GPUDevice): number {
  // The texture-usage constant may not exist on older `@webgpu/types`.
  // `Reflect.get` reads the potentially-missing property without pinning
  // the TypeScript build to a specific @webgpu/types version.
  const bit =
    (Reflect.get(GPUTextureUsage, "TRANSIENT_ATTACHMENT") as
      | number
      | undefined) ?? 0x10;
  // Two possible feature names depending on spec snapshot — accept either.
  if (
    device.features.has("transient-attachments" as GPUFeatureName) ||
    device.features.has("transient-attachment" as GPUFeatureName)
  ) {
    return bit;
  }
  return 0;
}

// =========================================================================
// Types
// =========================================================================

export interface WebGPUFramebufferManagerOptions {
  /** Number of MSAA samples (1 = no MSAA, 4 = 4x MSAA) */
  numSamples?: number;
  /** Number of color attachments (MRT support) */
  colorAttachmentsLength?: number;
  /** Whether to create color attachments */
  color?: boolean;
  /** Whether to create a depth-only attachment */
  depth?: boolean;
  /** Whether to create a combined depth-stencil attachment */
  depthStencil?: boolean;
  /** Color texture format */
  colorFormat?: GPUTextureFormat;
  /** Depth/stencil texture format */
  depthFormat?: GPUTextureFormat;
  /** Whether to allow sampling the color textures (adds TEXTURE_BINDING usage) */
  colorSamplable?: boolean;
  /** Whether to allow sampling the depth texture (adds TEXTURE_BINDING usage) */
  depthSamplable?: boolean;
  /** Clear color for render pass (default: transparent black) */
  clearColor?: GPUColorDict;
  /** Label prefix for GPU debugging */
  label?: string;
}

// =========================================================================
// WebGPUFramebufferManager
// =========================================================================

export class WebGPUFramebufferManager {
  // Configuration
  private _numSamples: number;
  private _colorAttachmentsLength: number;
  private _hasColor: boolean;
  private _hasDepth: boolean;
  private _hasDepthStencil: boolean;
  private _colorFormat: GPUTextureFormat;
  private _depthFormat: GPUTextureFormat;
  private _colorSamplable: boolean;
  private _depthSamplable: boolean;
  private _clearColor: GPUColorDict;
  private _label: string;

  // Dimensions
  private _width: number = 0;
  private _height: number = 0;

  // GPU resources
  private _device: GPUDevice | null = null;
  private _colorTextures: (GPUTexture | null)[] = [];
  private _colorTextureViews: (GPUTextureView | null)[] = [];
  private _msaaColorTextures: (GPUTexture | null)[] = [];
  private _msaaColorTextureViews: (GPUTextureView | null)[] = [];
  private _depthTexture: GPUTexture | null = null;
  private _depthTextureView: GPUTextureView | null = null;

  // State tracking
  private _isDirty: boolean = true;
  private _isDestroyed: boolean = false;

  constructor(options?: WebGPUFramebufferManagerOptions) {
    options = options ?? {};

    this._numSamples = options.numSamples ?? 1;
    this._colorAttachmentsLength = options.colorAttachmentsLength ?? 1;
    this._hasColor = options.color ?? true;
    this._hasDepth = options.depth ?? false;
    this._hasDepthStencil = options.depthStencil ?? false;
    this._colorFormat = options.colorFormat ?? "bgra8unorm";
    this._depthFormat = options.depthFormat ?? "depth24plus-stencil8";
    this._colorSamplable = options.colorSamplable ?? true;
    this._depthSamplable = options.depthSamplable ?? false;
    this._clearColor = options.clearColor ?? { r: 0, g: 0, b: 0, a: 0 };
    this._label = options.label ?? "WebGPUFB";

    //>>includeStart('debug', pragmas.debug);
    if (!this._hasColor && !this._hasDepth && !this._hasDepthStencil) {
      throw new DeveloperError(
        "Must enable at least one attachment type (color, depth, or depthStencil).",
      );
    }
    if (this._hasDepth && this._hasDepthStencil) {
      throw new DeveloperError(
        "Cannot have both depth and depthStencil attachments.",
      );
    }
    //>>includeEnd('debug');

    // If depth-only format requested but depthStencil flag is set, adjust format
    if (this._hasDepth && !this._hasDepthStencil) {
      this._depthFormat = options.depthFormat ?? "depth24plus";
    }
  }

  // =========================================================================
  // Properties
  // =========================================================================

  /** Current width */
  get width(): number {
    return this._width;
  }

  /** Current height */
  get height(): number {
    return this._height;
  }

  /** Number of MSAA samples */
  get numSamples(): number {
    return this._numSamples;
  }

  /** Whether MSAA is enabled */
  get isMSAA(): boolean {
    return this._numSamples > 1;
  }

  /** Whether resources have been created */
  get isReady(): boolean {
    return !this._isDirty && this._device !== null;
  }

  // =========================================================================
  // Dirty Tracking
  // =========================================================================

  /**
   * Checks if the framebuffer needs to be recreated.
   */
  isDirty(width: number, height: number, numSamples?: number): boolean {
    numSamples = numSamples ?? this._numSamples;
    return (
      this._isDirty ||
      this._width !== width ||
      this._height !== height ||
      this._numSamples !== numSamples ||
      this._device === null
    );
  }

  // =========================================================================
  // Resource Creation
  // =========================================================================

  /**
   * Creates or recreates render target textures if dimensions/settings changed.
   *
   * @param device - The GPU device
   * @param width - Render target width
   * @param height - Render target height
   * @param numSamples - MSAA sample count (optional, uses constructor value)
   */
  update(
    device: GPUDevice,
    width: number,
    height: number,
    numSamples?: number,
  ): void {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(device)) {
      throw new DeveloperError("device is required.");
    }
    if (width <= 0 || height <= 0) {
      throw new DeveloperError("width and height must be > 0.");
    }
    //>>includeEnd('debug');

    numSamples = numSamples ?? this._numSamples;

    if (!this.isDirty(width, height, numSamples)) {
      return;
    }

    // Destroy old resources
    this._destroyTextures();

    this._device = device;
    this._width = width;
    this._height = height;
    this._numSamples = numSamples;

    // ── Color textures ──
    if (this._hasColor) {
      this._colorTextures = new Array(this._colorAttachmentsLength);
      this._colorTextureViews = new Array(this._colorAttachmentsLength);
      this._msaaColorTextures = new Array(this._colorAttachmentsLength);
      this._msaaColorTextureViews = new Array(this._colorAttachmentsLength);

      let colorUsage =
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC;
      if (this._colorSamplable) {
        colorUsage |= GPUTextureUsage.TEXTURE_BINDING;
      }

      for (let i = 0; i < this._colorAttachmentsLength; i++) {
        // Resolve texture (always sampleCount=1, used for sampling)
        this._colorTextures[i] = device.createTexture({
          size: { width, height },
          format: this._colorFormat,
          usage: colorUsage,
          sampleCount: 1,
          label: `${this._label}_Color${i}`,
        });
        this._colorTextureViews[i] = this._colorTextures[i]!.createView({
          label: `${this._label}_Color${i}_View`,
        });

        // MSAA texture (if multisampled)
        if (this._numSamples > 1) {
          // MSAA source textures are pure render attachments — they're
          // resolved into _colorTextures and then discarded each pass.
          // Mark them transient on devices that support it so the driver
          // can keep them in tile memory only (TBDR memoryless).
          const transientBit = getTransientAttachmentBit(device);
          this._msaaColorTextures[i] = device.createTexture({
            size: { width, height },
            format: this._colorFormat,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | transientBit,
            sampleCount: this._numSamples,
            label: `${this._label}_MSAAColor${i}`,
          });
          this._msaaColorTextureViews[i] = this._msaaColorTextures[
            i
          ]!.createView({
            label: `${this._label}_MSAAColor${i}_View`,
          });
        }
      }
    }

    // ── Depth / Depth-Stencil texture ──
    if (this._hasDepth || this._hasDepthStencil) {
      let depthUsage = GPUTextureUsage.RENDER_ATTACHMENT;
      if (this._depthSamplable) {
        depthUsage |= GPUTextureUsage.TEXTURE_BINDING;
      } else {
        // Pure render-attachment depth: a later color pass will not sample
        // it, so the contents never need to leave tile memory. Pair this
        // with depthStoreOp: "discard" (already done in
        // getRenderPassDescriptor) to maximise the bandwidth win on TBDR.
        depthUsage |= getTransientAttachmentBit(device);
      }

      this._depthTexture = device.createTexture({
        size: { width, height },
        format: this._depthFormat,
        usage: depthUsage,
        sampleCount: this._numSamples,
        label: `${this._label}_Depth`,
      });
      this._depthTextureView = this._depthTexture.createView({
        label: `${this._label}_Depth_View`,
      });
    }

    this._isDirty = false;
  }

  // =========================================================================
  // Render Pass Descriptor
  // =========================================================================

  /**
   * Creates a GPURenderPassDescriptor for rendering to this framebuffer.
   *
   * @param clearColor - Override clear color (uses constructor default if not provided)
   * @param loadOp - Color load operation ('clear' or 'load')
   * @param storeOp - Color store operation ('store' or 'discard')
   * @param depthLoadOp - Depth load operation
   * @param depthStoreOp - Depth store operation
   * @param depthClearValue - Depth clear value (default 1.0)
   * @param stencilClearValue - Stencil clear value (default 0)
   * @returns GPURenderPassDescriptor ready for beginRenderPass()
   */
  getRenderPassDescriptor(options?: {
    clearColor?: GPUColorDict;
    loadOp?: GPULoadOp;
    storeOp?: GPUStoreOp;
    depthLoadOp?: GPULoadOp;
    depthStoreOp?: GPUStoreOp;
    depthClearValue?: number;
    stencilClearValue?: number;
  }): GPURenderPassDescriptor {
    const opts = options ?? {};
    const clearColor = opts.clearColor ?? this._clearColor;
    const loadOp: GPULoadOp = opts.loadOp ?? "clear";
    const storeOp: GPUStoreOp = opts.storeOp ?? "store";
    const depthLoadOp: GPULoadOp = opts.depthLoadOp ?? "clear";
    // Transient depth optimization: when the depth texture is not sampled by
    // any later pass, discard it after rendering. On tile-based mobile GPUs
    // (Apple/Mali/Adreno) the driver can then keep the depth buffer in
    // on-chip tile memory only (memoryless), avoiding writeback to DRAM.
    const depthStoreOp: GPUStoreOp =
      opts.depthStoreOp ?? (this._depthSamplable ? "store" : "discard");
    const depthClearValue = opts.depthClearValue ?? 1.0;
    const stencilClearValue = opts.stencilClearValue ?? 0;

    const colorAttachments: GPURenderPassColorAttachment[] = [];

    if (this._hasColor) {
      for (let i = 0; i < this._colorAttachmentsLength; i++) {
        if (this._numSamples > 1) {
          // MSAA: render to multisample texture, resolve to single-sample.
          // Transient MSAA: discard the multisample texture after the resolve
          // — only the resolve target is sampled later. This lets TBDR drivers
          // keep the multisample buffer in tile memory only (memoryless).
          colorAttachments.push({
            view: this._msaaColorTextureViews[i]!,
            resolveTarget: this._colorTextureViews[i]!,
            clearValue: clearColor,
            loadOp,
            storeOp: "discard",
          });
        } else {
          colorAttachments.push({
            view: this._colorTextureViews[i]!,
            clearValue: clearColor,
            loadOp,
            storeOp,
          });
        }
      }
    }

    const descriptor: GPURenderPassDescriptor = {
      colorAttachments,
      label: `${this._label}_RenderPass`,
    };

    if ((this._hasDepth || this._hasDepthStencil) && this._depthTextureView) {
      const depthStencilAttachment: GPURenderPassDepthStencilAttachment = {
        view: this._depthTextureView,
        depthClearValue,
        depthLoadOp,
        depthStoreOp,
      };
      if (this._hasDepthStencil) {
        depthStencilAttachment.stencilClearValue = stencilClearValue;
        depthStencilAttachment.stencilLoadOp = depthLoadOp;
        depthStencilAttachment.stencilStoreOp = depthStoreOp;
      }
      descriptor.depthStencilAttachment = depthStencilAttachment;
    }

    return descriptor;
  }

  // =========================================================================
  // Texture Access (for sampling / readback)
  // =========================================================================

  /**
   * Gets the resolved (single-sample) color texture for sampling.
   * For MSAA, this is the resolve target (not the multisample texture).
   */
  getColorTexture(index: number = 0): GPUTexture | null {
    return this._colorTextures[index] ?? null;
  }

  /**
   * Gets the color texture view for sampling in bind groups.
   */
  getColorTextureView(index: number = 0): GPUTextureView | null {
    return this._colorTextureViews[index] ?? null;
  }

  /**
   * Gets the depth/stencil texture.
   */
  getDepthTexture(): GPUTexture | null {
    return this._depthTexture;
  }

  /**
   * Gets the depth/stencil texture view.
   */
  getDepthTextureView(): GPUTextureView | null {
    return this._depthTextureView;
  }

  // =========================================================================
  // Clear
  // =========================================================================

  /**
   * Creates a clear-only render pass (no drawing, just clears the targets).
   * Useful for clearing before accumulation passes.
   */
  clear(commandEncoder: GPUCommandEncoder, clearColor?: GPUColorDict): void {
    const desc = this.getRenderPassDescriptor({
      clearColor: clearColor ?? this._clearColor,
      loadOp: "clear",
      storeOp: "store",
      depthLoadOp: "clear",
      depthStoreOp: "store",
    });
    const pass = commandEncoder.beginRenderPass(desc);
    pass.end();
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  /**
   * Destroys all GPU textures but keeps the configuration.
   * Call update() again to recreate.
   */
  private _destroyTextures(): void {
    if (this._hasColor) {
      for (let i = 0; i < this._colorTextures.length; i++) {
        this._colorTextures[i]?.destroy();
        this._colorTextures[i] = null;
        this._colorTextureViews[i] = null;
        this._msaaColorTextures[i]?.destroy();
        this._msaaColorTextures[i] = null;
        this._msaaColorTextureViews[i] = null;
      }
    }
    if (this._depthTexture) {
      this._depthTexture.destroy();
      this._depthTexture = null;
      this._depthTextureView = null;
    }
  }

  /**
   * Marks the framebuffer as dirty so it will be recreated on next update().
   */
  markDirty(): void {
    this._isDirty = true;
  }

  /**
   * Destroys all GPU resources. The manager can be reused after calling update().
   */
  destroy(): void {
    this._destroyTextures();
    this._device = null;
    this._isDirty = true;
    this._isDestroyed = true;
  }

  /**
   * Whether the manager has been destroyed.
   */
  get isDestroyed(): boolean {
    return this._isDestroyed;
  }
}

export default WebGPUFramebufferManager;
