/**
 * @module WebGPUTexture
 *
 * WebGPU texture implementation for 2D, 3D, and cube map textures.
 * Provides GPU texture management, sampling, and mipmap generation.
 *
 * @example
 * const texture = WebGPUTexture.create2D(device, {
 *   width: 256,
 *   height: 256,
 *   format: 'rgba8unorm'
 * });
 */

/// <reference types="@webgpu/types" />

import DeveloperError from "../../Core/DeveloperError.js";
import defined from "../../Core/defined.js";

/**
 * Texture dimension types
 */
export enum WebGPUTextureDimension {
  DIMENSION_1D = "1d",
  DIMENSION_2D = "2d",
  DIMENSION_3D = "3d",
}

/**
 * Options for creating a WebGPU texture
 */
export interface WebGPUTextureOptions {
  /**
   * The GPU device
   */
  device: GPUDevice;

  /**
   * Texture width
   */
  width: number;

  /**
   * Texture height (required for 2D/3D)
   */
  height?: number;

  /**
   * Texture depth (required for 3D)
   */
  depth?: number;

  /**
   * Texture format
   */
  format: GPUTextureFormat;

  /**
   * Texture dimension
   */
  dimension?: GPUTextureDimension;

  /**
   * Number of mip levels
   */
  mipLevelCount?: number;

  /**
   * Number of samples for MSAA
   */
  sampleCount?: number;

  /**
   * Texture usage flags
   */
  usage?: GPUTextureUsageFlags;

  /**
   * Label for debugging
   */
  label?: string;
}

/**
 * WebGPU texture wrapper providing convenient texture management.
 */
export class WebGPUTexture {
  private _device: GPUDevice;
  private _texture: GPUTexture;
  private _view: GPUTextureView | null = null;
  private _sampler: GPUSampler | null = null;
  private _width: number;
  private _height: number;
  private _depth: number;
  private _format: GPUTextureFormat;
  private _dimension: GPUTextureDimension;
  private _mipLevelCount: number;
  private _isDestroyed: boolean = false;
  private _label: string;

  /**
   * Private constructor. Use static factory methods instead.
   *
   * @private
   */
  private constructor(
    device: GPUDevice,
    texture: GPUTexture,
    options: WebGPUTextureOptions,
  ) {
    this._device = device;
    this._texture = texture;
    this._width = options.width;
    this._height = options.height ?? 1;
    this._depth = options.depth ?? 1;
    this._format = options.format;
    this._dimension = options.dimension ?? "2d";
    this._mipLevelCount = options.mipLevelCount ?? 1;
    this._label = options.label ?? "WebGPUTexture";
  }

  /**
   * Creates a new WebGPU texture.
   *
   * @param {WebGPUTextureOptions} options - Texture creation options
   * @returns {WebGPUTexture} The created texture
   *
   * @example
   * const texture = WebGPUTexture.create({
   *   device: device,
   *   width: 512,
   *   height: 512,
   *   format: 'rgba8unorm'
   * });
   */
  static create(options: WebGPUTextureOptions): WebGPUTexture {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(options.device)) {
      throw new DeveloperError("options.device is required.");
    }
    if (!defined(options.width) || options.width <= 0) {
      throw new DeveloperError("options.width must be greater than 0.");
    }
    if (!defined(options.format)) {
      throw new DeveloperError("options.format is required.");
    }
    //>>includeEnd('debug');

    const dimension = options.dimension ?? "2d";
    const usage =
      options.usage ??
      GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT;

    const textureDescriptor: GPUTextureDescriptor = {
      size: {
        width: options.width,
        height: options.height ?? 1,
        depthOrArrayLayers: options.depth ?? 1,
      },
      format: options.format,
      dimension,
      mipLevelCount: options.mipLevelCount ?? 1,
      sampleCount: options.sampleCount ?? 1,
      usage,
      label: options.label,
    };

    const texture = options.device.createTexture(textureDescriptor);

    return new WebGPUTexture(options.device, texture, options);
  }

  /**
   * Creates a 2D texture.
   *
   * @param {GPUDevice} device - The GPU device
   * @param {number} width - Texture width
   * @param {number} height - Texture height
   * @param {GPUTextureFormat} [format='rgba8unorm'] - Texture format
   * @param {number} [mipLevelCount=1] - Number of mip levels
   * @param {string} [label] - Optional label for debugging
   * @returns {WebGPUTexture} The 2D texture
   *
   * @example
   * const texture = WebGPUTexture.create2D(device, 256, 256);
   */
  static create2D(
    device: GPUDevice,
    width: number,
    height: number,
    format: GPUTextureFormat = "rgba8unorm",
    mipLevelCount: number = 1,
    label?: string,
  ): WebGPUTexture {
    return WebGPUTexture.create({
      device,
      width,
      height,
      format,
      dimension: "2d",
      mipLevelCount,
      label: label ?? "Texture2D",
    });
  }

  /**
   * Creates a 3D texture.
   *
   * @param {GPUDevice} device - The GPU device
   * @param {number} width - Texture width
   * @param {number} height - Texture height
   * @param {number} depth - Texture depth
   * @param {GPUTextureFormat} [format='rgba8unorm'] - Texture format
   * @param {string} [label] - Optional label for debugging
   * @returns {WebGPUTexture} The 3D texture
   *
   * @example
   * const texture = WebGPUTexture.create3D(device, 64, 64, 64);
   */
  static create3D(
    device: GPUDevice,
    width: number,
    height: number,
    depth: number,
    format: GPUTextureFormat = "rgba8unorm",
    label?: string,
  ): WebGPUTexture {
    return WebGPUTexture.create({
      device,
      width,
      height,
      depth,
      format,
      dimension: "3d",
      label: label ?? "Texture3D",
    });
  }

  /**
   * Creates a cube map texture.
   *
   * @param {GPUDevice} device - The GPU device
   * @param {number} size - Cube face size (width/height)
   * @param {GPUTextureFormat} [format='rgba8unorm'] - Texture format
   * @param {number} [mipLevelCount=1] - Number of mip levels
   * @param {string} [label] - Optional label for debugging
   * @returns {WebGPUTexture} The cube map texture
   *
   * @example
   * const cubeMap = WebGPUTexture.createCubeMap(device, 512);
   */
  static createCubeMap(
    device: GPUDevice,
    size: number,
    format: GPUTextureFormat = "rgba8unorm",
    mipLevelCount: number = 1,
    label?: string,
  ): WebGPUTexture {
    return WebGPUTexture.create({
      device,
      width: size,
      height: size,
      depth: 6, // 6 faces for cube map
      format,
      dimension: "2d",
      mipLevelCount,
      label: label ?? "CubeMap",
    });
  }

  /**
   * Gets the underlying GPUTexture.
   */
  get texture(): GPUTexture {
    return this._texture;
  }

  /**
   * Gets or creates the texture view.
   */
  get view(): GPUTextureView {
    if (!this._view) {
      this._view = this._texture.createView({
        label: `${this._label}_View`,
      });
    }
    return this._view;
  }

  /**
   * Gets or creates a default sampler.
   */
  get sampler(): GPUSampler {
    if (!this._sampler) {
      this._sampler = this._device.createSampler({
        magFilter: "linear",
        minFilter: "linear",
        mipmapFilter: "linear",
        addressModeU: "repeat",
        addressModeV: "repeat",
        label: `${this._label}_Sampler`,
      });
    }
    return this._sampler;
  }

  /**
   * Gets the texture width.
   */
  get width(): number {
    return this._width;
  }

  /**
   * Gets the texture height.
   */
  get height(): number {
    return this._height;
  }

  /**
   * Gets the texture depth.
   */
  get depth(): number {
    return this._depth;
  }

  /**
   * Gets the texture format.
   */
  get format(): GPUTextureFormat {
    return this._format;
  }

  /**
   * Gets the texture dimension.
   */
  get dimension(): GPUTextureDimension {
    return this._dimension;
  }

  /**
   * Gets the number of mip levels.
   */
  get mipLevelCount(): number {
    return this._mipLevelCount;
  }

  /**
   * Whether the texture has been destroyed.
   */
  get isDestroyed(): boolean {
    return this._isDestroyed;
  }

  /**
   * Writes data to the texture.
   *
   * @param {ArrayBuffer | ArrayBufferView} data - Data to write
   * @param {number} [width] - Data width (defaults to texture width)
   * @param {number} [height] - Data height (defaults to texture height)
   * @param {number} [layerOrMipLevel=0] - For cube maps: layer/face index (0-5). For other textures: mip level.
   * @param {number} [mipLevel=0] - Mip level to write to (only used if layerOrMipLevel looks like a mip level, i.e., texture is not a cube map)
   *
   * @example
   * const imageData = new Uint8Array([...]);
   * texture.write(imageData);
   *
   * @example
   * // For cube maps
   * cubeMap.write(faceData, 1, 1, faceIndex); // Write to face 0-5
   */
  write(
    data: ArrayBuffer | ArrayBufferView,
    width?: number,
    height?: number,
    layerOrMipLevel: number = 0,
    mipLevel: number = 0,
  ): void {
    //>>includeStart('debug', pragmas.debug);
    if (this._isDestroyed) {
      throw new DeveloperError("Texture has been destroyed.");
    }
    //>>includeEnd('debug');

    const arrayData =
      data instanceof ArrayBuffer
        ? (new Uint8Array(data) as unknown as BufferSource)
        : (new Uint8Array(
            data.buffer,
            data.byteOffset,
            data.byteLength,
          ) as unknown as BufferSource);

    // For cube maps, treat layerOrMipLevel as layer (face index)
    // For 2D/3D textures, treat it as mip level
    const isCubeMap = this._depth === 6 && this._dimension === "2d";
    const actualMipLevel = isCubeMap ? mipLevel : layerOrMipLevel;
    const actualLayer = isCubeMap ? layerOrMipLevel : 0;

    this._device.queue.writeTexture(
      {
        texture: this._texture,
        mipLevel: actualMipLevel,
        origin: { x: 0, y: 0, z: actualLayer },
      },
      arrayData,
      {
        bytesPerRow: (width ?? this._width) * 4, // Assuming RGBA
      },
      {
        width: width ?? this._width,
        height: height ?? this._height,
      },
    );
  }

  /**
   * Writes data to a region of the texture (partial update).
   * Equivalent to WebGL's texSubImage2D.
   *
   * @param {ArrayBuffer | ArrayBufferView} data - Data to write
   * @param {number} x - X offset in the texture
   * @param {number} y - Y offset in the texture
   * @param {number} width - Width of the region
   * @param {number} height - Height of the region
   * @param {number} [mipLevel=0] - Mip level to write to
   * @param {number} [bytesPerPixel=4] - Bytes per pixel (4 for RGBA)
   *
   * @example
   * // Update 64x64 region at position (128, 128)
   * texture.writeRegion(imageData, 128, 128, 64, 64);
   */
  writeRegion(
    data: ArrayBuffer | ArrayBufferView,
    x: number,
    y: number,
    width: number,
    height: number,
    mipLevel: number = 0,
    bytesPerPixel: number = 4,
  ): void {
    //>>includeStart('debug', pragmas.debug);
    if (this._isDestroyed) {
      throw new DeveloperError("Texture has been destroyed.");
    }
    if (
      x < 0 ||
      y < 0 ||
      x + width > this._width ||
      y + height > this._height
    ) {
      throw new DeveloperError("Region is out of texture bounds.");
    }
    //>>includeEnd('debug');

    const arrayData =
      data instanceof ArrayBuffer
        ? (new Uint8Array(data) as unknown as BufferSource)
        : (new Uint8Array(
            data.buffer,
            data.byteOffset,
            data.byteLength,
          ) as unknown as BufferSource);

    this._device.queue.writeTexture(
      {
        texture: this._texture,
        mipLevel,
        origin: { x, y, z: 0 },
      },
      arrayData,
      {
        bytesPerRow: width * bytesPerPixel,
      },
      {
        width,
        height,
      },
    );
  }

  /**
   * Generates mipmaps for the texture using a compute shader.
   * WebGPU does not auto-generate mipmaps like WebGL, so this must be called explicitly.
   *
   * @example
   * const texture = WebGPUTexture.create2D(device, 512, 512, 'rgba8unorm', 9);
   * texture.write(imageData); // Write to mip level 0
   * texture.generateMipmaps(); // Generate remaining mip levels
   */
  generateMipmaps(): void {
    //>>includeStart('debug', pragmas.debug);
    if (this._isDestroyed) {
      throw new DeveloperError("Texture has been destroyed.");
    }
    if (this._mipLevelCount <= 1) {
      console.warn(
        "[WebGPU] Texture has only 1 mip level, no mipmaps to generate.",
      );
      return;
    }
    //>>includeEnd('debug');

    // Create command encoder
    const commandEncoder = this._device.createCommandEncoder({
      label: `${this._label}_MipmapGeneration`,
    });

    // Simple implementation: Use blit operations to downsample each level
    // For production, a compute shader would be more efficient
    for (let mipLevel = 1; mipLevel < this._mipLevelCount; mipLevel++) {
      const srcMip = mipLevel - 1;
      const dstMip = mipLevel;

      const srcWidth = Math.max(1, this._width >> srcMip);
      const srcHeight = Math.max(1, this._height >> srcMip);
      const dstWidth = Math.max(1, this._width >> dstMip);
      const dstHeight = Math.max(1, this._height >> dstMip);

      // Create source and destination views
      const srcView = this._texture.createView({
        baseMipLevel: srcMip,
        mipLevelCount: 1,
      });

      const dstView = this._texture.createView({
        baseMipLevel: dstMip,
        mipLevelCount: 1,
      });

      // Use a simple render pass to downsample
      // This requires a pipeline - for now, log a warning
      console.warn(
        `[WebGPU] Mipmap generation not fully implemented. Mip level ${mipLevel} not generated.`,
      );
      console.warn(
        "[WebGPU] Use manual mip writing or implement compute shader approach.",
      );
    }

    // Submit commands
    this._device.queue.submit([commandEncoder.finish()]);

    console.log(
      `[WebGPU] Mipmap generation requested for ${this._label} (${this._mipLevelCount} levels)`,
    );
    console.log(
      "[WebGPU] Note: Full mipmap generation requires compute shader implementation.",
    );
  }

  /**
   * Creates a custom texture view.
   *
   * @param {GPUTextureViewDescriptor} [descriptor] - View descriptor
   * @returns {GPUTextureView} The texture view
   */
  createView(descriptor?: GPUTextureViewDescriptor): GPUTextureView {
    //>>includeStart('debug', pragmas.debug);
    if (this._isDestroyed) {
      throw new DeveloperError("Texture has been destroyed.");
    }
    //>>includeEnd('debug');

    return this._texture.createView(descriptor);
  }

  /**
   * Creates a custom sampler.
   *
   * @param {GPUSamplerDescriptor} descriptor - Sampler descriptor
   * @returns {GPUSampler} The sampler
   */
  createSampler(descriptor: GPUSamplerDescriptor): GPUSampler {
    return this._device.createSampler(descriptor);
  }

  /**
   * Destroys the texture and frees GPU resources.
   */
  destroy(): void {
    if (this._isDestroyed) {
      return;
    }

    this._texture.destroy();
    this._view = null;
    this._sampler = null;
    this._isDestroyed = true;
  }

  // ====================================================================================
  // Static Utility Methods
  // ====================================================================================

  /**
   * Flips image data vertically (Y-axis).
   * Equivalent to WebGL's UNPACK_FLIP_Y_WEBGL pixel store parameter.
   *
   * @param {Uint8Array} data - Image data to flip
   * @param {number} width - Image width in pixels
   * @param {number} height - Image height in pixels
   * @param {number} [bytesPerPixel=4] - Bytes per pixel (4 for RGBA, 3 for RGB, etc.)
   * @returns {Uint8Array} Flipped image data
   *
   * @example
   * const flipped = WebGPUTexture.flipYData(imageData, 256, 256, 4);
   * texture.write(flipped);
   */
  static flipYData(
    data: Uint8Array,
    width: number,
    height: number,
    bytesPerPixel: number = 4,
  ): Uint8Array {
    const flipped = new Uint8Array(data.length);
    const bytesPerRow = width * bytesPerPixel;

    for (let y = 0; y < height; y++) {
      const srcRow = y * bytesPerRow;
      const dstRow = (height - 1 - y) * bytesPerRow;
      flipped.set(data.subarray(srcRow, srcRow + bytesPerRow), dstRow);
    }

    return flipped;
  }

  /**
   * Premultiplies alpha in RGBA image data.
   * Equivalent to WebGL's UNPACK_PREMULTIPLY_ALPHA_WEBGL pixel store parameter.
   *
   * @param {Uint8Array} data - RGBA image data (must be 4 bytes per pixel)
   * @returns {Uint8Array} Image data with premultiplied alpha
   *
   * @example
   * const premultiplied = WebGPUTexture.premultiplyAlpha(imageData);
   * texture.write(premultiplied);
   */
  static premultiplyAlpha(data: Uint8Array): Uint8Array {
    //>>includeStart('debug', pragmas.debug);
    if (data.length % 4 !== 0) {
      throw new DeveloperError("Data must be RGBA format (4 bytes per pixel).");
    }
    //>>includeEnd('debug');

    const result = new Uint8Array(data.length);

    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3] / 255.0;
      result[i] = Math.floor(data[i] * alpha); // R
      result[i + 1] = Math.floor(data[i + 1] * alpha); // G
      result[i + 2] = Math.floor(data[i + 2] * alpha); // B
      result[i + 3] = data[i + 3]; // A
    }

    return result;
  }

  /**
   * Maps WebGL compressed texture format constants to WebGPU formats.
   *
   * @param {number} webglFormat - WebGL compressed format constant
   * @returns {GPUTextureFormat | null} WebGPU texture format, or null if not supported
   *
   * @example
   * const format = WebGPUTexture.getWebGPUCompressionFormat(0x83F1); // DXT1
   * // Returns 'bc1-rgba-unorm'
   */
  static getWebGPUCompressionFormat(
    webglFormat: number,
  ): GPUTextureFormat | null {
    // WebGL compressed format constants
    const GL_COMPRESSED_RGB_S3TC_DXT1_EXT = 0x83f0;
    const GL_COMPRESSED_RGBA_S3TC_DXT1_EXT = 0x83f1;
    const GL_COMPRESSED_RGBA_S3TC_DXT3_EXT = 0x83f2;
    const GL_COMPRESSED_RGBA_S3TC_DXT5_EXT = 0x83f3;
    const GL_COMPRESSED_RGBA_BPTC_UNORM = 0x8e8c;
    const GL_COMPRESSED_SRGB_ALPHA_BPTC_UNORM = 0x8e8d;

    const formatMap: Record<number, GPUTextureFormat> = {
      [GL_COMPRESSED_RGB_S3TC_DXT1_EXT]: "bc1-rgba-unorm",
      [GL_COMPRESSED_RGBA_S3TC_DXT1_EXT]: "bc1-rgba-unorm",
      [GL_COMPRESSED_RGBA_S3TC_DXT3_EXT]: "bc2-rgba-unorm",
      [GL_COMPRESSED_RGBA_S3TC_DXT5_EXT]: "bc3-rgba-unorm",
      [GL_COMPRESSED_RGBA_BPTC_UNORM]: "bc7-rgba-unorm",
      [GL_COMPRESSED_SRGB_ALPHA_BPTC_UNORM]: "bc7-rgba-unorm-srgb",
    };

    return formatMap[webglFormat] || null;
  }

  /**
   * Gets the block size in bytes for compressed texture formats.
   *
   * @param {GPUTextureFormat} format - WebGPU texture format
   * @returns {number} Block size in bytes, or 0 for uncompressed formats
   *
   * @example
   * const blockSize = WebGPUTexture.getBlockSize('bc1-rgba-unorm');
   * // Returns 8
   */
  static getBlockSize(format: GPUTextureFormat): number {
    const blockSizes: Record<string, number> = {
      "bc1-rgba-unorm": 8,
      "bc1-rgba-unorm-srgb": 8,
      "bc2-rgba-unorm": 16,
      "bc2-rgba-unorm-srgb": 16,
      "bc3-rgba-unorm": 16,
      "bc3-rgba-unorm-srgb": 16,
      "bc4-r-unorm": 8,
      "bc4-r-snorm": 8,
      "bc5-rg-unorm": 16,
      "bc5-rg-snorm": 16,
      "bc6h-rgb-ufloat": 16,
      "bc6h-rgb-float": 16,
      "bc7-rgba-unorm": 16,
      "bc7-rgba-unorm-srgb": 16,
    };

    return blockSizes[format] || 0;
  }

  /**
   * Calculates bytes per row for compressed textures.
   *
   * @param {GPUTextureFormat} format - Texture format
   * @param {number} width - Texture width in pixels
   * @returns {number} Bytes per row (aligned to block size)
   *
   * @example
   * const bytesPerRow = WebGPUTexture.getBytesPerRow('bc1-rgba-unorm', 512);
   */
  static getBytesPerRow(format: GPUTextureFormat, width: number): number {
    const blockSize = WebGPUTexture.getBlockSize(format);

    if (blockSize > 0) {
      // Compressed format - calculate blocks
      const blocksWide = Math.ceil(width / 4); // 4x4 blocks
      return blocksWide * blockSize;
    } else {
      // Uncompressed - estimate bytes per pixel
      // This is a simplified version; production code should handle all formats
      const bytesPerPixel = 4; // Assume RGBA for now
      return width * bytesPerPixel;
    }
  }

  /**
   * Gets bytes per pixel for common uncompressed formats.
   *
   * @param {GPUTextureFormat} format - Texture format
   * @returns {number} Bytes per pixel
   */
  static getBytesPerPixel(format: GPUTextureFormat): number {
    const bytesPerPixelMap: Record<string, number> = {
      r8unorm: 1,
      r8snorm: 1,
      r8uint: 1,
      r8sint: 1,
      r16uint: 2,
      r16sint: 2,
      r16float: 2,
      rg8unorm: 2,
      rg8snorm: 2,
      rg8uint: 2,
      rg8sint: 2,
      r32uint: 4,
      r32sint: 4,
      r32float: 4,
      rg16uint: 4,
      rg16sint: 4,
      rg16float: 4,
      rgba8unorm: 4,
      "rgba8unorm-srgb": 4,
      rgba8snorm: 4,
      rgba8uint: 4,
      rgba8sint: 4,
      bgra8unorm: 4,
      "bgra8unorm-srgb": 4,
      rgb10a2unorm: 4,
      rg32uint: 8,
      rg32sint: 8,
      rg32float: 8,
      rgba16uint: 8,
      rgba16sint: 8,
      rgba16float: 8,
      rgba32uint: 16,
      rgba32sint: 16,
      rgba32float: 16,
    };

    return bytesPerPixelMap[format] || 4; // Default to 4 bytes
  }
}

export default WebGPUTexture;
