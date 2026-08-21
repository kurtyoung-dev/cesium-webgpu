/// <reference types="@webgpu/types" />
import { dispatchDepthResolve } from "./WebGPUDepthResolveMSAA.js";

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

  /**
   * Whether the depth attachment should be readable by subsequent passes.
   * Adds `TEXTURE_BINDING` to the depth texture usage and creates an
   * `aspect: "depth-only"` view.
   *
   * Cost: adds binding usage to the depth texture. Under MSAA it also allocates
   * a single-sample color target and requires a fullscreen conversion pass.
   * Use only when downstream passes need depth.
   *
   * For MSAA, the depth-only view feeds a conversion pass that writes sample
   * zero into a single-sample `r16float` color target. In that mode
   * {@link WebGPURenderTarget.getDepthSampleableView} returns the converted
   * color view rather than the multisampled depth view.
   *
   * Default: false.
   */
  depthSamplable?: boolean;
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

  // Depth-only aspect view for sampling (only created when depthSamplable=true)
  private _depthSampleableView?: GPUTextureView;

  // MSAA depth-conversion target, allocated when `sampleCount > 1` and
  // `depthSamplable` is true. Each frame a fullscreen pass reads sample zero
  // from multisampled depth and writes it through `@location(0)` to this
  // single-sample `r16float` color attachment. Downstream consumers must bind
  // the returned view as `texture_2d<f32>`, not `texture_depth_2d`.
  private _msaaDepthResolveTexture: GPUTexture | null = null;
  private _msaaDepthResolveAttachmentView: GPUTextureView | null = null;
  private _msaaDepthResolveSampleableView: GPUTextureView | null = null;

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
        GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC,
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
      const wantSampleable = this.descriptor.depthSamplable === true;
      const isMSAA = (sampleCount ?? 1) > 1;
      let depthUsage: GPUTextureUsageFlags = GPUTextureUsage.RENDER_ATTACHMENT;
      if (wantSampleable) {
        // Single-sample depth can be read in WGSL via `textureSample`
        // (depth comparison) or `textureLoad` (raw depth). Multisample
        // depth can only be read via `textureLoad` (per-sample fetch).
        // Both paths still require `TEXTURE_BINDING` on the underlying
        // texture so the bind group can attach it. Without this bit, bind-group
        // creation fails because the texture lacks `TEXTURE_BINDING` usage.
        depthUsage |= GPUTextureUsage.TEXTURE_BINDING;
        // Sampleable depth textures are also the source of
        // `copyTextureToTexture` in
        // `WebGPUTranslucentTileClassification.executeTranslucentDepthPass`.
        // WebGPU validation requires the source texture's usage to
        // include `COPY_SRC`; without this bit the copy emits a
        // "usage doesn't include CopySrc" validation error.
        // (Skip COPY_SRC for MSAA — multisampled textures can't be
        // copy sources; the copy path falls back gracefully.)
        if (!isMSAA) {
          depthUsage |= GPUTextureUsage.COPY_SRC;
        }
      }

      const depthTexture = this.device.createTexture({
        label: `${this.descriptor.name}_depth`,
        size: { width, height, depthOrArrayLayers: 1 },
        format: depthStencilFormat,
        usage: depthUsage,
        sampleCount: sampleCount!,
        mipLevelCount: 1, // Depth textures don't use mipmaps
      });

      this.depthStencilAttachment = {
        texture: depthTexture,
        view: depthTexture.createView(),
        format: depthStencilFormat,
      };

      // Cache the depth-only aspect view for sampling. This is the view
      // bound to a `texture_depth_2d` in WGSL — separate from the
      // attachment view (which is depth+stencil aspect for rendering).
      if (wantSampleable) {
        this._depthSampleableView = depthTexture.createView({
          label: `${this.descriptor.name}_depth_sampleable`,
          aspect: "depth-only",
        });
      }

      // Allocate the MSAA depth-conversion target when downstream sampling is
      // requested. The aspect view above is still
      // multisampled (texture_depth_multisampled_2d-compatible only);
      // Environmental effects, ambient occlusion, and depth of field need a
      // single-sample view. Each frame `resolveDepthMSAA(encoder)` reads
      // sample zero of the MSAA depth via a fullscreen fragment pass and
      // writes it to this r16float texture's @location(0). Format
      // choice rationale: r16float is filterable-float-compatible
      // (matches AO's existing BGL declaration); depth32float would
      // force every consumer to switch to unfilterable-float + non-
      // filtering samplers, much larger blast radius.
      if (wantSampleable && isMSAA) {
        this._msaaDepthResolveTexture = this.device.createTexture({
          label: `${this.descriptor.name}_depth_resolve_ss`,
          size: { width, height, depthOrArrayLayers: 1 },
          format: "r16float",
          usage:
            GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
          sampleCount: 1,
          mipLevelCount: 1,
        });
        this._msaaDepthResolveAttachmentView =
          this._msaaDepthResolveTexture.createView({
            label: `${this.descriptor.name}_depth_resolve_ss_attach`,
          });
        // Same view used for both attachment AND sampleable — r16float
        // doesn't have aspects (unlike depth formats).
        this._msaaDepthResolveSampleableView =
          this._msaaDepthResolveAttachmentView;
      }
    }
  }

  /**
   * Dispatches the MSAA depth-conversion render pass. No-op when MSAA is not
   * enabled (single-sample depth is already
   * sampleable via the aspect view) or when the depth attachment
   * isn't sampleable (`depthSamplable: true` not set on descriptor).
   * Caller (SceneFramebuffer or SceneRenderer) calls this once per
   * frame, AFTER the main scene render pass ends so depth is final.
   *
   * @param encoder - Main frame command encoder.
   */
  resolveDepthMSAA(encoder: GPUCommandEncoder): void {
    if (
      !this._msaaDepthResolveAttachmentView ||
      !this._depthSampleableView ||
      !this.depthStencilAttachment
    ) {
      return;
    }
    dispatchDepthResolve(
      encoder,
      this.device,
      this._depthSampleableView,
      this._msaaDepthResolveAttachmentView,
    );
  }

  /**
   * Get color attachment descriptors for render pass
   *
   * @param clearValues - Optional clear values for each attachment
   * @param options - Optional behavior flags. `resolve` (default `true`)
   *   controls whether an MSAA `resolveTarget` is attached. Scene-framebuffer
   *   pass-open sites can pass `resolve:false` to avoid resolving intermediate
   *   segments at every `pass.end()`; a demand pass then resolves color before
   *   a consumer reads it. The default gives callers that do not opt into
   *   elision a populated single-sample target at pass end.
   * @returns Array of color attachment descriptors
   */
  getColorAttachments(
    clearValues?: GPUColor[],
    options?: { resolve?: boolean },
  ): GPURenderPassColorAttachment[] {
    const withResolve = options?.resolve !== false;
    return this.colorAttachments.map((attachment, index) => {
      const descriptor: GPURenderPassColorAttachment = {
        view: attachment.view,
        clearValue: clearValues?.[index] || { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear" as const,
        storeOp: "store" as const,
      };

      // Add a resolve target when MSAA is enabled and the caller wants the
      // per-segment resolve. Scene-framebuffer segments may pass
      // `resolve:false` and defer this work to a demand pass.
      if (withResolve && this.resolveTargets.length > 0) {
        descriptor.resolveTarget = this.resolveTargets[index].view;
      }

      return descriptor;
    });
  }

  /**
   * Builds a zero-draw, single-color-attachment render-pass descriptor that
   * resolves multisampled color attachment zero into its single-sample target.
   * Used by
   * `WebGPUSceneRenderer._ensureSceneColorResolved` to perform the
   * demand-driven "resolve-on-consume" once per frame, replacing the eager
   * per-segment resolves elided via `getColorAttachments({ resolve:false })`.
   *
   * `loadOp:"load"` preserves the accumulated MSAA color; `storeOp:"store"`
   * is mandatory — later scene segments resume with color `loadOp:"load"`, so
   * a `"discard"` here would destroy the accumulated scene. No depth-stencil
   * attachment and no MRT slot 1: a pass with zero draws carries no
   * pipeline-compat constraints, and slot-1 (G-buffer) resolves are a separate
   * concern owned by `buildMrtSlot1Attachment`.
   *
   * @returns The resolve-only descriptor, or `null` when there is no MSAA
   *   resolve target (single-sample) or the target is not single-color
   *   (conservative skip — the scene FB is single-color by construction).
   */
  createColorResolvePassDescriptor(): GPURenderPassDescriptor | null {
    if (this.resolveTargets.length === 0) {
      return null;
    }
    // Scene FB is single-color-target (MRT slot-1 lives outside this class,
    // appended by `buildMrtSlot1Attachment`). Stay conservative for any other
    // multi-target user: only index 0 is resolved here.
    if (this.colorAttachments.length !== 1) {
      return null;
    }
    return {
      label: `${this.descriptor.name}_demand_resolve`,
      colorAttachments: [
        {
          view: this.colorAttachments[0].view,
          loadOp: "load" as const,
          storeOp: "store" as const,
          resolveTarget: this.resolveTargets[0].view,
        },
      ],
    };
  }

  /**
   * Get depth/stencil attachment descriptor for render pass.
   *
   * Load and store operations are caller-selectable because a reopened scene
   * pass must preserve depth accumulated by earlier frustums. Such callers
   * must pass `depthLoadOp: "load"`; clearing on reopen would erase that depth
   * and leave depth-sampling overlays with the clear value instead of scene
   * geometry.
   *
   * @param depthClearValue - Depth clear value (default: 1.0)
   * @param stencilClearValue - Stencil clear value (default: 0)
   * @param depthLoadOp - Depth load op (default: "clear")
   * @param depthStoreOp - Depth store op (default: "store")
   * @param stencilLoadOp - Stencil load op (default: "clear")
   * @param stencilStoreOp - Stencil store op (default: "store")
   * @returns Depth/stencil attachment descriptor or undefined
   */
  getDepthStencilAttachment(
    depthClearValue: number = 1.0,
    stencilClearValue: number = 0,
    depthLoadOp: GPULoadOp = "clear",
    depthStoreOp: GPUStoreOp = "store",
    stencilLoadOp: GPULoadOp = "clear",
    stencilStoreOp: GPUStoreOp = "store",
  ): GPURenderPassDepthStencilAttachment | undefined {
    if (!this.depthStencilAttachment) {
      return undefined;
    }

    const descriptor: GPURenderPassDepthStencilAttachment = {
      view: this.depthStencilAttachment.view,
      depthClearValue,
      depthLoadOp,
      depthStoreOp,
    };

    // Add stencil operations if format includes stencil
    if (this.depthStencilAttachment.format.includes("stencil")) {
      descriptor.stencilClearValue = stencilClearValue;
      descriptor.stencilLoadOp = stencilLoadOp;
      descriptor.stencilStoreOp = stencilStoreOp;
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
    // Under MSAA, return the single-sample resolve allocation. The caller must
    // ensure a resolving pass has populated it before reading.
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
   * Gets the underlying depth attachment texture. Downstream readers should
   * use {@link getDepthSampleableView}, whose representation accounts for the
   * target's sample count.
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
   * Get combined depth-stencil texture view.
   * Alias for `getDepthTextureView()` — the underlying texture already
   * contains both depth and stencil aspects when the format includes stencil
   * (e.g., `depth24plus-stencil8`).
   *
   * @returns Depth/stencil texture view or undefined
   */
  getDepthStencilTextureView(): GPUTextureView | undefined {
    return this.depthStencilAttachment?.view;
  }

  /**
   * Gets the single-sample view for downstream depth reads. Returns undefined
   * unless the descriptor opted in via `depthSamplable: true`.
   *
   * In single-sample mode this is a depth-only aspect view for
   * `texture_depth_2d`. In MSAA mode it is the `r16float` color target produced
   * by {@link resolveDepthMSAA} and must be bound as `texture_2d<f32>`.
   *
   * @returns Sampleable depth view or undefined
   */
  getDepthSampleableView(): GPUTextureView | undefined {
    // Under MSAA, return the single-sample `r16float` conversion target. The
    // original depth-aspect view remains multisampled and is valid only for a
    // `texture_depth_multisampled_2d` binding. The caller must invoke
    // `resolveDepthMSAA` each frame before consumers read this color view.
    if (this._msaaDepthResolveSampleableView) {
      return this._msaaDepthResolveSampleableView;
    }
    return this._depthSampleableView;
  }

  /**
   * Check if the depth/stencil attachment includes a stencil component.
   *
   * @returns True if the format contains stencil (e.g., `depth24plus-stencil8`)
   */
  hasStencil(): boolean {
    if (!this.depthStencilAttachment) {
      return false;
    }
    return this.depthStencilAttachment.format.includes("stencil");
  }

  /**
   * Get a stencil-only texture view for shader sampling.
   * Creates a view with `aspect: 'stencil-only'` so the stencil plane
   * can be read as an `r8uint` texture in a shader.
   *
   * @returns Stencil-only texture view, or undefined if no stencil
   */
  getStencilTextureView(): GPUTextureView | undefined {
    if (!this.depthStencilAttachment) {
      return undefined;
    }
    if (!this.depthStencilAttachment.format.includes("stencil")) {
      return undefined;
    }
    // Create a stencil-aspect-only view (useful for reading stencil in shaders)
    return this.depthStencilAttachment.texture.createView({
      aspect: "stencil-only",
      label: `${this.descriptor.name}_stencil_view`,
    });
  }

  /**
   * Get a depth-only texture view for shader sampling.
   * Creates a view with `aspect: 'depth-only'` so the depth plane
   * can be read independently of the stencil component.
   *
   * @returns Depth-only texture view, or undefined if no depth attachment
   */
  getDepthOnlyTextureView(): GPUTextureView | undefined {
    if (!this.depthStencilAttachment) {
      return undefined;
    }
    return this.depthStencilAttachment.texture.createView({
      aspect: "depth-only",
      label: `${this.descriptor.name}_depth_only_view`,
    });
  }

  /**
   * Convenience getter: a default clear-mode render pass descriptor.
   */
  get renderPassDescriptor(): GPURenderPassDescriptor {
    return {
      label: `${this.descriptor.name}_render_pass`,
      colorAttachments: this.getColorAttachments(),
      depthStencilAttachment: this.getDepthStencilAttachment(),
    };
  }

  /**
   * Get a render pass descriptor that clears with the given color.
   */
  getClearPassDescriptor(clearColor: {
    red: number;
    green: number;
    blue: number;
    alpha: number;
  }): GPURenderPassDescriptor {
    return {
      label: `${this.descriptor.name}_clear_pass`,
      colorAttachments: this.getColorAttachments([
        {
          r: clearColor.red,
          g: clearColor.green,
          b: clearColor.blue,
          a: clearColor.alpha,
        },
      ]),
      depthStencilAttachment: this.getDepthStencilAttachment(),
    };
  }

  /**
   * Get a render pass descriptor that loads (preserves) existing content.
   */
  getLoadPassDescriptor(): GPURenderPassDescriptor {
    const colorAtts = this.colorAttachments.map((attachment, index) => {
      const desc: GPURenderPassColorAttachment = {
        view: attachment.view,
        loadOp: "load" as const,
        storeOp: "store" as const,
      };
      if (this.resolveTargets.length > 0) {
        desc.resolveTarget = this.resolveTargets[index].view;
      }
      return desc;
    });

    let dsAtt: GPURenderPassDepthStencilAttachment | undefined;
    if (this.depthStencilAttachment) {
      dsAtt = {
        view: this.depthStencilAttachment.view,
        depthLoadOp: "load" as const,
        depthStoreOp: "store" as const,
      };
      if (this.depthStencilAttachment.format.includes("stencil")) {
        dsAtt.stencilLoadOp = "load";
        dsAtt.stencilStoreOp = "store";
      }
    }

    return {
      label: `${this.descriptor.name}_load_pass`,
      colorAttachments: colorAtts,
      depthStencilAttachment: dsAtt,
    };
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
