/**
 * WebGPU Render Target
 *
 * Abstraction for render-to-texture functionality with support for:
 * - Multiple render targets (MRT)
 * - Depth/stencil attachments
 * - MSAA (multisampling)
 * - Automatic resource management
 *
 * @module WebGPURenderTarget
 */

/**
 * Render target configuration
 */
export interface WebGPURenderTargetDescriptor {
  /**
   * Render target name/identifier
   */
  name: string;

  /**
   * Width in pixels
   */
  width: number;

  /**
   * Height in pixels
   */
  height: number;

  /**
   * Color attachment formats
   */
  colorFormats?: GPUTextureFormat[];

  /**
   * Depth/stencil format (optional)
   */
  depthStencilFormat?: GPUTextureFormat;

  /**
   * Sample count for MSAA (default: 1 = no MSAA)
   */
  sampleCount?: number;

  /**
   * Texture usage flags (default: RENDER_ATTACHMENT | TEXTURE_BINDING)
   */
  usage?: GPUTextureUsageFlags;

  /**
   * Mipmap level count (default: 1)
   */
  mipLevelCount?: number;
}

/**
 * Render target attachment
 */
export interface RenderTargetAttachment {
  texture: GPUTexture;
  view: GPUTextureView;
  format: GPUTextureFormat;
}

/**
 * WebGPU Render Target
 *
 * Manages textures for render-to-texture operations
 */
export class WebGPURenderTarget {
  private device: GPUDevice;
  private descriptor: WebGPURenderTargetDescriptor;

  // Color attachments
  private colorAttachments: RenderTargetAttachment[] = [];

  // Depth/stencil attachment (optional)
  private depthStencilAttachment?: RenderTargetAttachment;

  // MSAA resolve targets (if MSAA enabled)
  private resolveTargets: RenderTargetAttachment[] = [];

  // Resource tracking
  private destroyed = false;

  /**
   * Create a new render target
   *
   * @param device - GPUDevice for creating textures
   * @param descriptor - Render target configuration
   */
  constructor(device: GPUDevice, descriptor: WebGPURenderTargetDescriptor) {
    this.device = device;
    this.descriptor = {
      ...descriptor,
      colorFormats: descriptor.colorFormats || ["bgra8unorm"],
      sampleCount: descriptor.sampleCount || 1,
      usage:
        descriptor.usage ||
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      mipLevelCount: descriptor.mipLevelCount || 1,
    };

    this.createTextures();
  }

  /**
   * Create all textures for this render target
   */
  private createTextures(): void {
    const {
      width,
      height,
      colorFormats,
      depthStencilFormat,
      sampleCount,
      usage,
      mipLevelCount,
    } = this.descriptor;

    // Create color attachments
    for (const format of colorFormats!) {
      const texture = this.device.createTexture({
        label: `${this.descriptor.name}_color_${format}`,
        size: { width, height, depthOrArrayLayers: 1 },
        format,
        usage: usage!,
        sampleCount: sampleCount!,
        mipLevelCount: mipLevelCount!,
      });

      this.colorAttachments.push({
        texture,
        view: texture.createView(),
        format,
      });

      // Create resolve target if MSAA is enabled
      if (sampleCount! > 1) {
        const resolveTexture = this.device.createTexture({
          label: `${this.descriptor.name}_resolve_${format}`,
          size: { width, height, depthOrArrayLayers: 1 },
          format,
          usage: usage!,
          sampleCount: 1, // Resolve target is always single-sampled
          mipLevelCount: mipLevelCount!,
        });

        this.resolveTargets.push({
          texture: resolveTexture,
          view: resolveTexture.createView(),
          format,
        });
      }
    }

    // Create depth/stencil attachment if specified
    if (depthStencilFormat) {
      const depthTexture = this.device.createTexture({
        label: `${this.descriptor.name}_depth`,
        size: { width, height, depthOrArrayLayers: 1 },
        format: depthStencilFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
        sampleCount: sampleCount!,
        mipLevelCount: 1, // Depth textures don't use mipmaps
      });

      this.depthStencilAttachment = {
        texture: depthTexture,
        view: depthTexture.createView(),
        format: depthStencilFormat,
      };
    }
  }

  /**
   * Get color attachment descriptors for render pass
   *
   * @param clearValues - Optional clear values for each attachment
   * @returns Array of color attachment descriptors
   */
  getColorAttachments(
    clearValues?: GPUColor[],
  ): GPURenderPassColorAttachment[] {
    return this.colorAttachments.map((attachment, index) => {
      const descriptor: GPURenderPassColorAttachment = {
        view: attachment.view,
        clearValue: clearValues?.[index] || { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear" as const,
        storeOp: "store" as const,
      };

      // Add resolve target if MSAA is enabled
      if (this.resolveTargets.length > 0) {
        descriptor.resolveTarget = this.resolveTargets[index].view;
      }

      return descriptor;
    });
  }

  /**
   * Get depth/stencil attachment descriptor for render pass
   *
   * @param depthClearValue - Depth clear value (default: 1.0)
   * @param stencilClearValue - Stencil clear value (default: 0)
   * @returns Depth/stencil attachment descriptor or undefined
   */
  getDepthStencilAttachment(
    depthClearValue: number = 1.0,
    stencilClearValue: number = 0,
  ): GPURenderPassDepthStencilAttachment | undefined {
    if (!this.depthStencilAttachment) {
      return undefined;
    }

    const descriptor: GPURenderPassDepthStencilAttachment = {
      view: this.depthStencilAttachment.view,
      depthClearValue,
      depthLoadOp: "clear",
      depthStoreOp: "store",
    };

    // Add stencil operations if format includes stencil
    if (this.depthStencilAttachment.format.includes("stencil")) {
      descriptor.stencilClearValue = stencilClearValue;
      descriptor.stencilLoadOp = "clear";
      descriptor.stencilStoreOp = "store";
    }

    return descriptor;
  }

  /**
   * Get color texture at index (for sampling in shaders)
   *
   * @param index - Attachment index (default: 0)
   * @returns Color texture or undefined
   */
  getColorTexture(index: number = 0): GPUTexture | undefined {
    // If MSAA is enabled, return resolve target (which can be sampled)
    if (this.resolveTargets.length > 0) {
      return this.resolveTargets[index]?.texture;
    }

    return this.colorAttachments[index]?.texture;
  }

  /**
   * Get color texture view at index
   *
   * @param index - Attachment index (default: 0)
   * @returns Color texture view or undefined
   */
  getColorTextureView(index: number = 0): GPUTextureView | undefined {
    // If MSAA is enabled, return resolve target view
    if (this.resolveTargets.length > 0) {
      return this.resolveTargets[index]?.view;
    }

    return this.colorAttachments[index]?.view;
  }

  /**
   * Get depth texture (cannot be sampled with depth24plus format)
   *
   * @returns Depth texture or undefined
   */
  getDepthTexture(): GPUTexture | undefined {
    return this.depthStencilAttachment?.texture;
  }

  /**
   * Get depth texture view
   *
   * @returns Depth texture view or undefined
   */
  getDepthTextureView(): GPUTextureView | undefined {
    return this.depthStencilAttachment?.view;
  }

  /**
   * Get render target dimensions
   *
   * @returns Width and height
   */
  getSize(): { width: number; height: number } {
    return {
      width: this.descriptor.width,
      height: this.descriptor.height,
    };
  }

  /**
   * Get sample count
   *
   * @returns Sample count
   */
  getSampleCount(): number {
    return this.descriptor.sampleCount!;
  }

  /**
   * Get number of color attachments
   *
   * @returns Color attachment count
   */
  getColorAttachmentCount(): number {
    return this.colorAttachments.length;
  }

  /**
   * Check if render target has depth attachment
   *
   * @returns True if depth attachment exists
   */
  hasDepth(): boolean {
    return this.depthStencilAttachment !== undefined;
  }

  /**
   * Check if MSAA is enabled
   *
   * @returns True if sample count > 1
   */
  isMSAA(): boolean {
    return this.descriptor.sampleCount! > 1;
  }

  /**
   * Resize the render target
   *
   * @param width - New width
   * @param height - New height
   */
  resize(width: number, height: number): void {
    if (width === this.descriptor.width && height === this.descriptor.height) {
      return;
    }

    // Destroy old textures
    this.destroyTextures();

    // Update dimensions
    this.descriptor.width = width;
    this.descriptor.height = height;

    // Recreate textures
    this.createTextures();
  }

  /**
   * Destroy textures
   */
  private destroyTextures(): void {
    // Destroy color attachments
    for (const attachment of this.colorAttachments) {
      attachment.texture.destroy();
    }
    this.colorAttachments = [];

    // Destroy resolve targets
    for (const target of this.resolveTargets) {
      target.texture.destroy();
    }
    this.resolveTargets = [];

    // Destroy depth attachment
    if (this.depthStencilAttachment) {
      this.depthStencilAttachment.texture.destroy();
      this.depthStencilAttachment = undefined;
    }
  }

  /**
   * Destroy the render target and release resources
   */
  destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyTextures();
    this.destroyed = true;
  }

  /**
   * Check if render target has been destroyed
   *
   * @returns True if destroyed
   */
  isDestroyed(): boolean {
    return this.destroyed;
  }
}

export default WebGPURenderTarget;
