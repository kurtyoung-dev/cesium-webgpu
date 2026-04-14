/// <reference types="@webgpu/types" />
/**
 * WebGPU Pick Framebuffer — Renders pick-color pass and reads back pixel data
 *
 * Equivalent of PickFramebuffer.js for WebGPU. Creates an offscreen render
 * target (rgba8unorm + depth24plus-stencil8), renders the scene's pick pass
 * into it, then uses copyTextureToBuffer + mapAsync for GPU readback.
 *
 * Because WebGPU readback is inherently async, synchronous `end()` uses a
 * pre-mapped staging buffer that was mapped in a previous frame. The first
 * call may return empty results. `endAsync()` always works correctly.
 *
 * @private
 */

import BoundingRectangle from "../../Core/BoundingRectangle.js";
import Color from "../../Core/Color.js";
import defined from "../../Core/defined.js";

/**
 * Spiral search pattern for finding picked objects from center outward.
 */
function pickObjectsFromPixels(
  context: CesiumGraphicsContext,
  pixels: Uint8Array,
  width: number,
  height: number,
  limit: number = 1,
): object[] {
  const max = Math.max(width, height);
  const length = max * max;
  const halfWidth = Math.floor(width * 0.5);
  const halfHeight = Math.floor(height * 0.5);

  let x = 0;
  let y = 0;
  let dx = 0;
  let dy = -1;

  const objects = new Set<object>();
  for (let i = 0; i < length; ++i) {
    if (
      -halfWidth <= x &&
      x <= halfWidth &&
      -halfHeight <= y &&
      y <= halfHeight
    ) {
      const index = 4 * ((halfHeight - y) * width + x + halfWidth);
      const r = pixels[index];
      const g = pixels[index + 1];
      const b = pixels[index + 2];
      const a = pixels[index + 3];

      if (a > 0) {
        // Non-zero alpha means something was rendered
        const pickColor = Color.bytesToRgba(r, g, b, a);
        const object = context.getObjectByPickColor(pickColor);
        if (defined(object)) {
          objects.add(object);
          if (objects.size >= limit) {
            break;
          }
        }
      }
    }

    // Spiral direction changes
    if (x === y || (x < 0 && -x === y) || (x > 0 && x === 1 - y)) {
      const temp = dx;
      dx = -dy;
      dy = temp;
    }

    x += dx;
    y += dy;
  }
  return [...objects];
}

export class WebGPUPickFramebuffer {
  private _context: CesiumGraphicsContext;
  private _device: GPUDevice | null = null;
  private _colorTexture: GPUTexture | null = null;
  private _depthTexture: GPUTexture | null = null;
  private _width: number = 0;
  private _height: number = 0;
  private _passState: CesiumPassState;

  // Staging buffer for color readback
  private _stagingBuffer: GPUBuffer | null = null;
  private _stagingBufferSize: number = 0;
  private _lastReadPixels: Uint8Array | null = null;

  // Depth readback resources (separate depth32float target for copyable depth)
  private _readableDepthTexture: GPUTexture | null = null;
  private _depthStagingBuffer: GPUBuffer | null = null;

  constructor(context: CesiumGraphicsContext) {
    this._context = context;
    this._device = context._device ?? null;

    // Create pass state with scissor/viewport
    this._passState = {
      context: context,
      framebuffer: undefined,
      blendingEnabled: false,
      scissorTest: {
        enabled: true,
        rectangle: new BoundingRectangle(),
      },
      viewport: new BoundingRectangle(),
    };
  }

  /**
   * Begin a pick rendering pass.
   * Creates/resizes the offscreen render targets and returns a pass state.
   */
  begin(
    screenSpaceRectangle: CesiumBoundingRectangle,
    viewport: CesiumBoundingRectangle,
  ): CesiumPassState {
    const device = this._context._device;
    if (!device) {
      return this._passState;
    }
    this._device = device;

    const { width, height } = viewport;

    BoundingRectangle.clone(
      screenSpaceRectangle,
      this._passState.scissorTest.rectangle,
    );

    // Create or recreate render targets
    if (width !== this._width || height !== this._height) {
      this._destroyTextures();

      this._colorTexture = device.createTexture({
        label: "Pick color texture",
        size: [width, height],
        format: "rgba8unorm",
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.TEXTURE_BINDING,
      });

      this._depthTexture = device.createTexture({
        label: "Pick depth texture",
        size: [width, height],
        format: "depth24plus-stencil8",
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });

      // Separate depth32float texture for readable depth (pickPosition).
      // depth24plus-stencil8 cannot be copied — depth32float can.
      this._readableDepthTexture = device.createTexture({
        label: "Pick readable depth texture (depth32float)",
        size: [width, height],
        format: "depth32float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });

      this._width = width;
      this._height = height;

      // Create staging buffer for readback
      // Row alignment: WebGPU requires rows to be aligned to 256 bytes
      const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
      const bufferSize = bytesPerRow * height;
      if (bufferSize !== this._stagingBufferSize) {
        if (this._stagingBuffer) {
          this._stagingBuffer.destroy();
        }
        this._stagingBuffer = device.createBuffer({
          label: "Pick staging buffer",
          size: bufferSize,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        this._stagingBufferSize = bufferSize;
      }
    }

    // Store the pick framebuffer info so the context can use it
    this._passState.framebuffer = {
      _isWebGPUPickFBO: true,
      colorTexture: this._colorTexture,
      depthTexture: this._depthTexture,
      colorView: this._colorTexture?.createView(),
      depthView: this._depthTexture?.createView(),
      width: this._width,
      height: this._height,
    };

    this._passState.viewport.width = width;
    this._passState.viewport.height = height;

    return this._passState;
  }

  /**
   * End the pick pass and synchronously read back picked objects.
   * Note: On WebGPU, synchronous readback may return empty results on the first call
   * because GPU readback is inherently async. Use endAsync() for reliable results.
   *
   * For practical use, this returns the result from the previous frame's readback
   * if available, while starting a new readback for the current frame.
   */
  end(
    screenSpaceRectangle: CesiumBoundingRectangle,
    limit: number = 1,
  ): object[] {
    const context = this._context;
    const device = this._device;

    if (!device || !this._colorTexture || !this._stagingBuffer) {
      return [];
    }

    const width = screenSpaceRectangle.width ?? 1;
    const height = screenSpaceRectangle.height ?? 1;

    // Start async readback for the current frame
    this._startReadback(width, height);

    // Return previous frame's results if available
    if (this._lastReadPixels) {
      return pickObjectsFromPixels(
        context,
        this._lastReadPixels,
        width,
        height,
        limit,
      );
    }

    return [];
  }

  /**
   * End the pick pass and asynchronously read back picked objects.
   * This is the recommended path for WebGPU — always returns correct results.
   */
  async endAsync(
    screenSpaceRectangle: CesiumBoundingRectangle,
    frameState: CesiumFrameState,
    limit: number = 1,
  ): Promise<object[]> {
    const context = this._context;
    const device = this._device;

    if (!device || !this._colorTexture || !this._stagingBuffer) {
      return [];
    }

    const width = screenSpaceRectangle.width ?? 1;
    const height = screenSpaceRectangle.height ?? 1;

    // Copy texture to staging buffer
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const encoder = device.createCommandEncoder({
      label: "Pick readback encoder",
    });

    encoder.copyTextureToBuffer(
      { texture: this._colorTexture! },
      {
        buffer: this._stagingBuffer!,
        bytesPerRow,
        rowsPerImage: height,
      },
      [width, height],
    );

    device.queue.submit([encoder.finish()]);

    // Wait for GPU to finish and map the buffer
    await this._stagingBuffer!.mapAsync(GPUMapMode.READ);
    const mappedData = new Uint8Array(this._stagingBuffer!.getMappedRange());

    // Copy data accounting for row padding
    const pixels = new Uint8Array(width * height * 4);
    for (let row = 0; row < height; row++) {
      const srcOffset = row * bytesPerRow;
      const dstOffset = row * width * 4;
      pixels.set(
        mappedData.subarray(srcOffset, srcOffset + width * 4),
        dstOffset,
      );
    }

    this._stagingBuffer!.unmap();
    this._lastReadPixels = pixels;

    return pickObjectsFromPixels(context, pixels, width, height, limit);
  }

  /**
   * Read the center pixel of the pick rectangle.
   * Used for voxel coordinate picking and metadata picking.
   */
  readCenterPixel(screenSpaceRectangle: CesiumBoundingRectangle): Uint8Array {
    if (this._lastReadPixels) {
      const width = screenSpaceRectangle.width ?? 1;
      const height = screenSpaceRectangle.height ?? 1;
      const halfWidth = Math.floor(width * 0.5);
      const halfHeight = Math.floor(height * 0.5);
      const index = 4 * (halfHeight * width + halfWidth);
      return this._lastReadPixels.slice(index, index + 4);
    }
    return new Uint8Array([0, 0, 0, 0]);
  }

  /**
   * Start an async readback without waiting for the result.
   * The result will be available in the next frame via _lastReadPixels.
   */
  private _startReadback(width: number, height: number): void {
    const device = this._device;
    if (!device || !this._colorTexture || !this._stagingBuffer) {
      return;
    }

    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const encoder = device.createCommandEncoder({
      label: "Pick readback encoder (async)",
    });

    encoder.copyTextureToBuffer(
      { texture: this._colorTexture! },
      {
        buffer: this._stagingBuffer!,
        bytesPerRow,
        rowsPerImage: height,
      },
      [width, height],
    );

    device.queue.submit([encoder.finish()]);

    // Fire-and-forget async mapping — result will be used next frame
    this._stagingBuffer!.mapAsync(GPUMapMode.READ)
      .then(() => {
        const mappedData = new Uint8Array(
          this._stagingBuffer!.getMappedRange(),
        );

        const pixels = new Uint8Array(width * height * 4);
        for (let row = 0; row < height; row++) {
          const srcOffset = row * bytesPerRow;
          const dstOffset = row * width * 4;
          pixels.set(
            mappedData.subarray(srcOffset, srcOffset + width * 4),
            dstOffset,
          );
        }

        this._stagingBuffer!.unmap();
        this._lastReadPixels = pixels;
      })
      .catch(() => {
        // Readback failed, likely buffer already mapped or destroyed
      });
  }

  /**
   * Asynchronously read a single depth value from the pick framebuffer.
   * Uses the depth32float readable depth texture (not depth24plus-stencil8).
   *
   * @param x The x pixel coordinate.
   * @param y The y pixel coordinate.
   * @returns The depth value (0.0–1.0), or undefined if readback fails.
   */
  async readDepthPixelAsync(x: number, y: number): Promise<number | undefined> {
    const device = this._device;
    if (!device || !this._readableDepthTexture) {
      return undefined;
    }

    if (x < 0 || x >= this._width || y < 0 || y >= this._height) {
      return undefined;
    }

    // depth32float is 4 bytes per pixel; row must be 256-byte aligned
    const bytesPerPixel = 4;
    const bytesPerRow = 256; // minimum for a single-pixel copy
    const bufferSize = bytesPerRow;

    // Create or reuse depth staging buffer
    if (!this._depthStagingBuffer) {
      this._depthStagingBuffer = device.createBuffer({
        label: "Pick depth staging buffer",
        size: bufferSize,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
    }

    const encoder = device.createCommandEncoder({
      label: "Pick depth readback encoder",
    });

    encoder.copyTextureToBuffer(
      {
        texture: this._readableDepthTexture,
        origin: [x, y, 0],
      },
      {
        buffer: this._depthStagingBuffer,
        bytesPerRow,
      },
      [1, 1],
    );

    device.queue.submit([encoder.finish()]);

    try {
      await this._depthStagingBuffer.mapAsync(GPUMapMode.READ);
      const mapped = new Float32Array(
        this._depthStagingBuffer.getMappedRange(0, bytesPerPixel),
      );
      const depth = mapped[0];
      this._depthStagingBuffer.unmap();
      return depth;
    } catch {
      // Buffer may already be mapped or destroyed
      return undefined;
    }
  }

  /**
   * Get the readable depth texture view for use as a second depth attachment.
   * Scene renderers can attach this alongside the primary stencil depth.
   */
  get readableDepthView(): GPUTextureView | null {
    return this._readableDepthTexture?.createView() ?? null;
  }

  private _destroyTextures(): void {
    if (this._colorTexture) {
      this._colorTexture.destroy();
      this._colorTexture = null;
    }
    if (this._depthTexture) {
      this._depthTexture.destroy();
      this._depthTexture = null;
    }
    if (this._readableDepthTexture) {
      this._readableDepthTexture.destroy();
      this._readableDepthTexture = null;
    }
  }

  isDestroyed(): boolean {
    return false;
  }

  destroy(): void {
    this._destroyTextures();
    if (this._stagingBuffer) {
      this._stagingBuffer.destroy();
      this._stagingBuffer = null;
    }
    if (this._depthStagingBuffer) {
      this._depthStagingBuffer.destroy();
      this._depthStagingBuffer = null;
    }
    this._lastReadPixels = null;
  }
}

export default WebGPUPickFramebuffer;
