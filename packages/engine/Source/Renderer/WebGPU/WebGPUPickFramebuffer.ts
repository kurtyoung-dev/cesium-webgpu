/// <reference types="@webgpu/types" />
/**
 * WebGPU Pick Framebuffer
 *
 * Manages the pick framebuffer for scene.pick() and scene.drillPick().
 * Renders pick commands into an rgba8unorm texture where each pixel encodes
 * a pick ID. The picked pixel is read back to CPU via a staging buffer.
 *
 * Equivalent to PickFramebuffer.js + PickDepth.js in the WebGL renderer.
 *
 * Usage flow:
 *   1. begin() — start a pick pass (clear pick texture)
 *   2. end(screenPosition) — end the pass, read back the pixel at the given position
 *   3. The returned color is decoded to a pick ID via context._pickObjects
 *
 * @private
 */

export interface PickResult {
  /** The RGBA color read from the pick buffer (0-255 per channel) */
  color: Uint8Array;
  /** Whether the pick hit something (non-zero color) */
  hit: boolean;
}

export class WebGPUPickFramebuffer {
  private _device: GPUDevice | null = null;
  private _width: number = 0;
  private _height: number = 0;

  // Pick render target (rgba8unorm for pick ID encoding)
  private _pickTexture: GPUTexture | null = null;
  private _pickTextureView: GPUTextureView | null = null;

  // Depth-stencil for pick pass
  private _depthTexture: GPUTexture | null = null;
  private _depthTextureView: GPUTextureView | null = null;

  // Staging buffer for GPU→CPU readback
  private _stagingBuffer: GPUBuffer | null = null;
  private _readbackPending: boolean = false;

  private _isDestroyed: boolean = false;

  /**
   * Update the pick framebuffer to match the viewport size.
   */
  update(device: GPUDevice, width: number, height: number): void {
    if (width <= 0 || height <= 0) {
      return;
    }

    const needsRecreate =
      this._device !== device ||
      this._width !== width ||
      this._height !== height;

    if (!needsRecreate && this._pickTexture) {
      return;
    }

    this._device = device;
    this._width = width;
    this._height = height;

    this._destroyTextures();

    // Pick color texture — rgba8unorm for pick ID encoding
    this._pickTexture = device.createTexture({
      label: "PickFramebuffer-Color",
      size: { width, height },
      format: "rgba8unorm",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    this._pickTextureView = this._pickTexture.createView({
      label: "PickFramebuffer-ColorView",
    });

    // Depth-stencil for correct depth testing during pick pass
    this._depthTexture = device.createTexture({
      label: "PickFramebuffer-Depth",
      size: { width, height },
      format: "depth24plus-stencil8",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this._depthTextureView = this._depthTexture.createView({
      label: "PickFramebuffer-DepthView",
    });

    // Staging buffer for single-pixel readback (4 bytes = rgba8)
    this._stagingBuffer?.destroy();
    this._stagingBuffer = device.createBuffer({
      label: "PickFramebuffer-Staging",
      size: 256, // Minimum buffer mapping size; we only need 4 bytes
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  }

  /**
   * Get a GPURenderPassDescriptor for the pick pass.
   * Clears the pick texture to (0,0,0,0) — zero means "nothing picked".
   */
  getPickPassDescriptor(): GPURenderPassDescriptor | null {
    if (!this._pickTextureView || !this._depthTextureView) {
      return null;
    }

    return {
      label: "PickPass",
      colorAttachments: [
        {
          view: this._pickTextureView,
          loadOp: "clear" as GPULoadOp,
          storeOp: "store" as GPUStoreOp,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
      depthStencilAttachment: {
        view: this._depthTextureView,
        depthClearValue: 1.0,
        depthLoadOp: "clear" as GPULoadOp,
        depthStoreOp: "store" as GPUStoreOp,
        stencilClearValue: 0,
        stencilLoadOp: "clear" as GPULoadOp,
        stencilStoreOp: "store" as GPUStoreOp,
      },
    };
  }

  /**
   * Get the pick texture view for external use (e.g., derived commands).
   */
  get pickTextureView(): GPUTextureView | null {
    return this._pickTextureView;
  }

  /**
   * Get the depth texture view for external use.
   */
  get depthTextureView(): GPUTextureView | null {
    return this._depthTextureView;
  }

  /**
   * Read the pick color at a specific screen position.
   * Copies a single pixel from the pick texture to a staging buffer,
   * then maps and reads the result.
   *
   * @param encoder The command encoder (before submit)
   * @param x Screen x coordinate
   * @param y Screen y coordinate
   * @returns Promise resolving to the pick result
   */
  async readPickPixel(
    encoder: GPUCommandEncoder,
    x: number,
    y: number,
  ): Promise<PickResult> {
    if (!this._pickTexture || !this._stagingBuffer || !this._device) {
      return { color: new Uint8Array(4), hit: false };
    }

    // Clamp coordinates to texture bounds
    const px = Math.max(0, Math.min(Math.floor(x), this._width - 1));
    const py = Math.max(0, Math.min(Math.floor(y), this._height - 1));

    // Copy the single pixel from pick texture to staging buffer
    encoder.copyTextureToBuffer(
      {
        texture: this._pickTexture,
        origin: { x: px, y: py },
      },
      {
        buffer: this._stagingBuffer,
        bytesPerRow: 256, // Must be multiple of 256
      },
      { width: 1, height: 1 },
    );

    return { color: new Uint8Array(4), hit: false };
  }

  /**
   * After command buffer submission, map the staging buffer and read the pixel.
   * Call this after device.queue.submit() and device.queue.onSubmittedWorkDone().
   */
  async readStagingBuffer(): Promise<PickResult> {
    if (!this._stagingBuffer || !this._device) {
      return { color: new Uint8Array(4), hit: false };
    }

    try {
      await this._stagingBuffer.mapAsync(GPUMapMode.READ, 0, 4);
      const data = new Uint8Array(this._stagingBuffer.getMappedRange(0, 4));
      const color = new Uint8Array([data[0], data[1], data[2], data[3]]);
      this._stagingBuffer.unmap();

      const hit =
        color[0] !== 0 || color[1] !== 0 || color[2] !== 0 || color[3] !== 0;

      return { color, hit };
    } catch {
      return { color: new Uint8Array(4), hit: false };
    }
  }

  /**
   * Perform a complete pick operation: copy pixel + submit + read back.
   * This is a convenience method that handles the full async flow.
   *
   * @param device The GPU device
   * @param x Screen x coordinate
   * @param y Screen y coordinate
   * @returns Promise resolving to the pick result
   */
  async pick(device: GPUDevice, x: number, y: number): Promise<PickResult> {
    if (!this._pickTexture || !this._stagingBuffer) {
      return { color: new Uint8Array(4), hit: false };
    }

    const px = Math.max(0, Math.min(Math.floor(x), this._width - 1));
    const py = Math.max(0, Math.min(Math.floor(y), this._height - 1));

    // Create a dedicated encoder for the copy
    const encoder = device.createCommandEncoder({
      label: "PickFramebuffer-ReadbackEncoder",
    });

    encoder.copyTextureToBuffer(
      {
        texture: this._pickTexture,
        origin: { x: px, y: py },
      },
      {
        buffer: this._stagingBuffer,
        bytesPerRow: 256,
      },
      { width: 1, height: 1 },
    );

    device.queue.submit([encoder.finish()]);

    // Wait for GPU to complete, then read
    await device.queue.onSubmittedWorkDone();
    return this.readStagingBuffer();
  }

  private _destroyTextures(): void {
    this._pickTexture?.destroy();
    this._depthTexture?.destroy();
    this._pickTexture = null;
    this._depthTexture = null;
    this._pickTextureView = null;
    this._depthTextureView = null;
  }

  destroy(): void {
    if (this._isDestroyed) {
      return;
    }
    this._destroyTextures();
    this._stagingBuffer?.destroy();
    this._stagingBuffer = null;
    this._isDestroyed = true;
  }

  get isDestroyed(): boolean {
    return this._isDestroyed;
  }
}
