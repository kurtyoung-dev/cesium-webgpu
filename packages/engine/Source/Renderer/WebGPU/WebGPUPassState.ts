/**
 * WebGPU per-pass rendering state.
 *
 * Mirrors the WebGL PassState.js but adds WebGPU-specific state management
 * such as render target binding, viewport tracking, and pipeline state overrides.
 *
 * Each rendering pass (ENVIRONMENT, GLOBE, OPAQUE, TRANSLUCENT, etc.) gets
 * its own WebGPUPassState to track the framebuffer, viewport, and state overrides.
 *
 * @private
 */

export interface WebGPUViewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WebGPUScissorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Shape of a WebGPU render target / framebuffer as accessed by WebGPUPassState.
 * Both WebGPURenderTarget and WebGPUFramebufferManager satisfy this interface.
 */
interface WebGPURenderTargetLike {
  getColorTextureView?(): GPUTextureView;
  colorTextureView?: GPUTextureView;
  resolveTextureView?: GPUTextureView;
  getDepthStencilTextureView?(): GPUTextureView;
  depthStencilTextureView?: GPUTextureView;
}

class WebGPUPassState {
  /**
   * The WebGPU context for this pass.
   */
  context: CesiumGraphicsContext;

  /**
   * The framebuffer (WebGPURenderTarget or WebGPUFramebufferManager) to render to.
   * When undefined, renders to the default canvas framebuffer.
   * Commands can override this with their own framebuffer.
   */
  framebuffer: WebGPURenderTargetLike | undefined;

  /**
   * When defined, overrides the blending property of a DrawCommand's render state.
   * Used to disable blending during the picking pass, for example.
   */
  blendingEnabled: boolean | undefined;

  /**
   * When defined, overrides the scissor test property of a DrawCommand's render state.
   */
  scissorTestEnabled: boolean | undefined;

  /**
   * The scissor rectangle when scissor testing is enabled.
   */
  scissorRect: WebGPUScissorRect | undefined;

  /**
   * The viewport for this pass. If undefined, uses the full framebuffer/canvas size.
   */
  viewport: WebGPUViewport | undefined;

  /**
   * When defined, overrides the depth test property of a DrawCommand's render state.
   * Used to disable depth testing for certain passes (e.g., OVERLAY).
   */
  depthTestEnabled: boolean | undefined;

  /**
   * When defined, overrides the depth write property of a DrawCommand's render state.
   */
  depthWriteEnabled: boolean | undefined;

  /**
   * When defined, overrides the cull face property of a DrawCommand's render state.
   */
  cullFaceEnabled: boolean | undefined;

  /**
   * When defined, overrides the stencil test property of a DrawCommand's render state.
   */
  stencilTestEnabled: boolean | undefined;

  /**
   * The stencil reference value for this pass (used in stencil compare operations).
   */
  stencilReference: number;

  /**
   * Constant blend color used when a command's pipeline blend factors
   * reference `constant` / `one-minus-constant`. WebGPU exposes this as
   * a per-encoder dynamic state via
   * `GPURenderPassEncoder.setBlendConstant(color)`; this field carries
   * the pass-level default so commands that don't override it via
   * `WebGPUDrawCommand.renderState` still get the right value at the
   * pass boundary. `undefined` means "don't set one" — the encoder
   * default `(0, 0, 0, 0)` is used.
   */
  blendConstant: GPUColor | undefined;

  /**
   * Whether this pass should clear the color buffer before rendering.
   */
  clearColor: boolean;

  /**
   * Whether this pass should clear the depth buffer before rendering.
   */
  clearDepth: boolean;

  /**
   * Whether this pass should clear the stencil buffer before rendering.
   */
  clearStencil: boolean;

  /**
   * The render target to use for this pass (WebGPURenderTarget).
   * This is the WebGPU-specific equivalent of framebuffer.
   */
  renderTarget: WebGPURenderTargetLike | undefined;

  /**
   * Whether this pass uses MSAA. Determined from the render target configuration.
   */
  private _msaaSampleCount: number;

  constructor(context: CesiumGraphicsContext) {
    this.context = context;
    this.framebuffer = undefined;
    this.blendingEnabled = undefined;
    this.scissorTestEnabled = undefined;
    this.scissorRect = undefined;
    this.viewport = undefined;
    this.depthTestEnabled = undefined;
    this.depthWriteEnabled = undefined;
    this.cullFaceEnabled = undefined;
    this.stencilTestEnabled = undefined;
    this.stencilReference = 0;
    this.blendConstant = undefined;
    this.clearColor = false;
    this.clearDepth = false;
    this.clearStencil = false;
    this.renderTarget = undefined;
    this._msaaSampleCount = 1;
  }

  /**
   * The MSAA sample count for this pass.
   */
  get msaaSampleCount(): number {
    return this._msaaSampleCount;
  }

  set msaaSampleCount(value: number) {
    // Validate: must be 1 or 4 (WebGPU supports 1 and 4)
    if (value !== 1 && value !== 4) {
      value = 1;
    }
    this._msaaSampleCount = value;
  }

  /**
   * Gets the effective viewport for this pass.
   * Falls back to the full canvas size if no viewport is specified.
   */
  getEffectiveViewport(): WebGPUViewport {
    if (this.viewport) {
      return this.viewport;
    }

    const context = this.context;
    return {
      x: 0,
      y: 0,
      width: context.drawingBufferWidth || context.canvas?.width || 1,
      height: context.drawingBufferHeight || context.canvas?.height || 1,
    };
  }

  /**
   * Gets the effective scissor rect for this pass.
   * Returns undefined if scissor testing is not enabled.
   */
  getEffectiveScissorRect(): WebGPUScissorRect | undefined {
    if (this.scissorTestEnabled && this.scissorRect) {
      return this.scissorRect;
    }
    return undefined;
  }

  // No `applyToRenderPass` method here. Per-
  // encoder dynamic state (viewport, scissor, stencilReference,
  // blendConstant) is applied via `applyPerEncoderState` in
  // WebGPUDrawCommand from `renderState` forwarding, not from this pass
  // state.

  /**
   * Creates a GPURenderPassDescriptor from this pass state.
   * If a render target is set, uses its textures. Otherwise, uses context defaults.
   */
  createRenderPassDescriptor(
    clearColorValue?: GPUColor,
    clearDepthValue?: number,
    clearStencilValue?: number,
  ): GPURenderPassDescriptor {
    const colorLoadOp: GPULoadOp = this.clearColor ? "clear" : "load";
    const depthLoadOp: GPULoadOp = this.clearDepth ? "clear" : "load";
    const stencilLoadOp: GPULoadOp = this.clearStencil ? "clear" : "load";

    const descriptor: GPURenderPassDescriptor = {
      colorAttachments: [],
    };

    // If we have a render target, use it
    if (this.renderTarget) {
      const rt = this.renderTarget;
      const colorAttachment: GPURenderPassColorAttachment = {
        view: rt.getColorTextureView
          ? rt.getColorTextureView()
          : rt.colorTextureView,
        loadOp: colorLoadOp,
        storeOp: "store" as GPUStoreOp,
      };

      if (this.clearColor && clearColorValue) {
        colorAttachment.clearValue = clearColorValue;
      }

      // MSAA resolve target
      if (rt.resolveTextureView) {
        colorAttachment.resolveTarget = rt.resolveTextureView;
      }

      (descriptor.colorAttachments as GPURenderPassColorAttachment[]).push(
        colorAttachment,
      );

      // Depth/stencil
      const depthView = rt.getDepthStencilTextureView
        ? rt.getDepthStencilTextureView()
        : rt.depthStencilTextureView;

      if (depthView) {
        descriptor.depthStencilAttachment = {
          view: depthView,
          depthLoadOp: depthLoadOp,
          depthStoreOp: "store",
          depthClearValue: clearDepthValue ?? 1.0,
          stencilLoadOp: stencilLoadOp,
          stencilStoreOp: "store",
          stencilClearValue: clearStencilValue ?? 0,
        };
      }
    }

    return descriptor;
  }

  /**
   * Creates a copy of this pass state with optional overrides.
   */
  clone(overrides?: Partial<WebGPUPassState>): WebGPUPassState {
    const cloned = new WebGPUPassState(this.context);
    cloned.framebuffer = this.framebuffer;
    cloned.blendingEnabled = this.blendingEnabled;
    cloned.scissorTestEnabled = this.scissorTestEnabled;
    cloned.scissorRect = this.scissorRect ? { ...this.scissorRect } : undefined;
    cloned.viewport = this.viewport ? { ...this.viewport } : undefined;
    cloned.depthTestEnabled = this.depthTestEnabled;
    cloned.depthWriteEnabled = this.depthWriteEnabled;
    cloned.cullFaceEnabled = this.cullFaceEnabled;
    cloned.stencilTestEnabled = this.stencilTestEnabled;
    cloned.stencilReference = this.stencilReference;
    // GPUColor is either a GPUColorDict ({r,g,b,a}) or a 4-element array.
    // The spread works for both — for the array variant it copies indices,
    // which `setBlendConstant` accepts as an `Iterable<number>`.
    cloned.blendConstant = this.blendConstant
      ? Array.isArray(this.blendConstant)
        ? ([...this.blendConstant] as [number, number, number, number])
        : { ...this.blendConstant }
      : undefined;
    cloned.clearColor = this.clearColor;
    cloned.clearDepth = this.clearDepth;
    cloned.clearStencil = this.clearStencil;
    cloned.renderTarget = this.renderTarget;
    cloned._msaaSampleCount = this._msaaSampleCount;

    if (overrides) {
      Object.assign(cloned, overrides);
    }

    return cloned;
  }
}

export default WebGPUPassState;
