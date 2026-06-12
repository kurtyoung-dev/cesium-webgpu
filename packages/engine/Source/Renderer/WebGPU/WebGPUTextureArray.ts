/**
 * Texture array manager for imagery layer optimization.
 * Instead of binding separate textures for each imagery layer,
 * packs multiple layers into a single 2D texture array with one bind group.
 *
 * WebGPU texture arrays use `dimension: "2d"` with `depthOrArrayLayers > 1`
 * and are sampled with `texture_2d_array<f32>` + `textureSample(tex, samp, uv, layer)`.
 *
 * @example
 * const texArray = new WebGPUTextureArray(device, {
 *   width: 256, height: 256, maxLayers: 16, format: 'rgba8unorm'
 * });
 * texArray.uploadLayer(0, imageBitmap);
 * texArray.uploadLayer(1, anotherImageBitmap);
 * // In shader: textureSample(textureArray, sampler, uv, layerIndex)
 * @module WebGPUTextureArray
 */

/// <reference types="@webgpu/types" />
import { gpuData } from "./webgpuTypeHelpers.js";

/**
 * Options for creating a texture array.
 */
export interface TextureArrayOptions {
  /** Width of each layer in pixels */
  width: number;
  /** Height of each layer in pixels */
  height: number;
  /** Maximum number of layers (default: 16) */
  maxLayers?: number;
  /** Texture format (default: 'rgba8unorm') */
  format?: GPUTextureFormat;
  /** Number of mip levels (default: 1) */
  mipLevelCount?: number;
  /** Whether to generate mipmaps on upload (default: false) */
  generateMipmaps?: boolean;
  /** Label for debug */
  label?: string;
}

/**
 * Information about a single layer in the texture array.
 */
export interface TextureLayerInfo {
  /** Layer index in the array */
  index: number;
  /** Whether this layer has data */
  hasData: boolean;
  /** Optional label/name for this layer */
  name: string;
  /** Last update frame number */
  lastUpdateFrame: number;
}

/**
 * Statistics for the texture array.
 */
export interface TextureArrayStats {
  /** Total layers allocated */
  maxLayers: number;
  /** Layers with data */
  activeLayers: number;
  /** Width × height per layer */
  layerSize: [number, number];
  /** Total GPU memory estimate in bytes */
  estimatedMemoryBytes: number;
  /** Texture format */
  format: GPUTextureFormat;
}

/**
 * Manages a 2D texture array for efficient multi-layer imagery rendering.
 *
 * A single GPUTexture with `depthOrArrayLayers = maxLayers` replaces
 * multiple individual textures, reducing bind group changes and
 * enabling single-draw multi-layer rendering.
 */
export class WebGPUTextureArray {
  private _device: GPUDevice;
  private _texture: GPUTexture;
  private _textureView: GPUTextureView;
  private _width: number;
  private _height: number;
  private _maxLayers: number;
  private _format: GPUTextureFormat;
  private _mipLevelCount: number;
  private _generateMipmaps: boolean;
  private _label: string;

  // Per-layer metadata
  private _layers: TextureLayerInfo[] = [];
  private _frameCount: number = 0;

  private _isDestroyed: boolean = false;

  /**
   * Creates a new texture array.
   *
   * @param device - The GPU device
   * @param options - Configuration options
   */
  constructor(device: GPUDevice, options: TextureArrayOptions) {
    this._device = device;
    this._width = options.width;
    this._height = options.height;
    this._maxLayers = options.maxLayers ?? 16;
    this._format = options.format ?? "rgba8unorm";
    this._generateMipmaps = options.generateMipmaps ?? false;
    this._label = options.label ?? "TextureArray";

    // Compute mip level count
    this._mipLevelCount = this._generateMipmaps
      ? Math.floor(Math.log2(Math.max(this._width, this._height))) + 1
      : (options.mipLevelCount ?? 1);

    // Create the 2D array texture
    this._texture = device.createTexture({
      size: {
        width: this._width,
        height: this._height,
        depthOrArrayLayers: this._maxLayers,
      },
      format: this._format,
      mipLevelCount: this._mipLevelCount,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
      dimension: "2d",
      label: `${this._label} (${this._width}×${this._height}×${this._maxLayers})`,
    });

    // Create array view (all layers)
    this._textureView = this._texture.createView({
      dimension: "2d-array",
      baseArrayLayer: 0,
      arrayLayerCount: this._maxLayers,
      label: `${this._label} Array View`,
    });

    // Initialize layer metadata
    for (let i = 0; i < this._maxLayers; i++) {
      this._layers.push({
        index: i,
        hasData: false,
        name: `Layer ${i}`,
        lastUpdateFrame: 0,
      });
    }
  }

  /**
   * Upload an ImageBitmap to a specific layer using zero-copy path.
   *
   * @param layerIndex - The layer index (0 to maxLayers-1)
   * @param source - The image source
   * @param name - Optional layer name
   */
  uploadLayer(
    layerIndex: number,
    source: ImageBitmap | HTMLCanvasElement | OffscreenCanvas,
    name?: string,
  ): void {
    if (layerIndex < 0 || layerIndex >= this._maxLayers) {
      //>>includeStart('debug', pragmas.debug);
      console.warn(
        `[${this._label}] Layer index ${layerIndex} out of range [0, ${this._maxLayers})`,
      );
      //>>includeEnd('debug');
      return;
    }

    // Use copyExternalImageToTexture for zero-copy upload
    this._device.queue.copyExternalImageToTexture(
      { source: source as ImageBitmap },
      {
        texture: this._texture,
        origin: { x: 0, y: 0, z: layerIndex },
      },
      { width: this._width, height: this._height },
    );

    // Update layer metadata
    this._layers[layerIndex].hasData = true;
    this._layers[layerIndex].lastUpdateFrame = this._frameCount;
    if (name) {
      this._layers[layerIndex].name = name;
    }
  }

  /**
   * Upload raw pixel data to a specific layer.
   *
   * @param layerIndex - The layer index
   * @param data - Raw pixel data (RGBA)
   */
  uploadLayerData(layerIndex: number, data: Uint8Array | Float32Array): void {
    if (layerIndex < 0 || layerIndex >= this._maxLayers) return;

    const bytesPerPixel = this._getBytesPerPixel();
    const bytesPerRow = this._width * bytesPerPixel;
    // Align bytesPerRow to 256
    const alignedBytesPerRow = Math.ceil(bytesPerRow / 256) * 256;

    this._device.queue.writeTexture(
      {
        texture: this._texture,
        origin: { x: 0, y: 0, z: layerIndex },
      },
      gpuData(data),
      {
        bytesPerRow: alignedBytesPerRow,
        rowsPerImage: this._height,
      },
      { width: this._width, height: this._height, depthOrArrayLayers: 1 },
    );

    this._layers[layerIndex].hasData = true;
    this._layers[layerIndex].lastUpdateFrame = this._frameCount;
  }

  /**
   * Create a view for a single layer (for per-layer rendering).
   *
   * @param layerIndex - The layer index
   * @returns GPUTextureView for the single layer
   */
  getLayerView(layerIndex: number): GPUTextureView {
    return this._texture.createView({
      dimension: "2d",
      baseArrayLayer: layerIndex,
      arrayLayerCount: 1,
      label: `${this._label} Layer ${layerIndex} View`,
    });
  }

  /**
   * Create a view for a range of layers.
   *
   * @param baseLayer - Starting layer index
   * @param layerCount - Number of layers
   * @returns GPUTextureView for the layer range
   */
  getLayerRangeView(baseLayer: number, layerCount: number): GPUTextureView {
    return this._texture.createView({
      dimension: "2d-array",
      baseArrayLayer: baseLayer,
      arrayLayerCount: layerCount,
      label: `${this._label} Layers ${baseLayer}-${baseLayer + layerCount - 1} View`,
    });
  }

  /**
   * Clear a layer to transparent black.
   *
   * @param layerIndex - The layer index to clear
   */
  clearLayer(layerIndex: number): void {
    if (layerIndex < 0 || layerIndex >= this._maxLayers) return;

    const bytesPerPixel = this._getBytesPerPixel();
    const data = new Uint8Array(this._width * this._height * bytesPerPixel);
    const bytesPerRow = this._width * bytesPerPixel;

    this._device.queue.writeTexture(
      {
        texture: this._texture,
        origin: { x: 0, y: 0, z: layerIndex },
      },
      gpuData(data),
      { bytesPerRow },
      { width: this._width, height: this._height, depthOrArrayLayers: 1 },
    );

    this._layers[layerIndex].hasData = false;
  }

  /**
   * Advance frame counter (for tracking layer staleness).
   */
  advanceFrame(): void {
    this._frameCount++;
  }

  /**
   * Get bytes per pixel for the current format.
   * @private
   */
  private _getBytesPerPixel(): number {
    switch (this._format) {
      case "rgba8unorm":
      case "rgba8snorm":
      case "bgra8unorm":
      case "rgba8uint":
      case "rgba8sint":
        return 4;
      case "rgba16float":
        return 8;
      case "rgba32float":
        return 16;
      case "rg11b10ufloat":
        return 4;
      case "r8unorm":
        return 1;
      case "rg8unorm":
        return 2;
      default:
        return 4;
    }
  }

  // --- Accessors ---

  /** The underlying GPUTexture */
  get texture(): GPUTexture {
    return this._texture;
  }

  /** The full array texture view (all layers) */
  get view(): GPUTextureView {
    return this._textureView;
  }

  /** Width of each layer */
  get width(): number {
    return this._width;
  }

  /** Height of each layer */
  get height(): number {
    return this._height;
  }

  /** Maximum layer count */
  get maxLayers(): number {
    return this._maxLayers;
  }

  /** Number of layers with data */
  get activeLayers(): number {
    return this._layers.filter((l) => l.hasData).length;
  }

  /** Layer info array */
  get layers(): readonly TextureLayerInfo[] {
    return this._layers;
  }

  /** Get statistics */
  getStats(): TextureArrayStats {
    const bpp = this._getBytesPerPixel();
    return {
      maxLayers: this._maxLayers,
      activeLayers: this.activeLayers,
      layerSize: [this._width, this._height],
      estimatedMemoryBytes: this._width * this._height * bpp * this._maxLayers,
      format: this._format,
    };
  }

  /** Whether the array has been destroyed */
  get isDestroyed(): boolean {
    return this._isDestroyed;
  }

  /** Destroy GPU resources */
  destroy(): void {
    if (this._isDestroyed) return;
    this._texture.destroy();
    this._isDestroyed = true;
  }
}

export default WebGPUTextureArray;
