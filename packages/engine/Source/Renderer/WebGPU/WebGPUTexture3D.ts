/**
 * WebGPU equivalent of Texture3D.js.
 *
 * Wraps a `WebGPUTexture` (3D dimension) with the same API surface as the
 * WebGL `Texture3D` class so that consumers like `Megatexture.js` (voxels)
 * can work on both backends.
 *
 * Key differences from WebGL Texture3D:
 *   - Uses `device.queue.writeTexture()` instead of `gl.texSubImage3D()`
 *   - Uses `GPUTexture` descriptors instead of GL state machine
 *   - Mipmap generation via blit-based `WebGPUMipmapGenerator`
 *   - No `gl.pixelStorei` — alignment handled by `bytesPerRow`
 *
 * @private
 */

import WebGPUTexture from "./WebGPUTexture.js";

/**
 * Map CesiumJS PixelFormat + PixelDatatype to WebGPU GPUTextureFormat.
 */
function cesiumFormatToWebGPU(
  pixelFormat: number,
  pixelDatatype: number,
): GPUTextureFormat {
  // PixelFormat constants (from CesiumJS Core/PixelFormat.js):
  // RGBA = 0x1908, RGB = 0x1907, RG = 0x8227, RED = 0x1903
  // LUMINANCE = 0x1909, LUMINANCE_ALPHA = 0x190A
  // DEPTH_COMPONENT = 0x1902, DEPTH_STENCIL = 0x84F9

  // PixelDatatype constants (from CesiumJS Renderer/PixelDatatype.js):
  // UNSIGNED_BYTE = 0x1401, UNSIGNED_SHORT = 0x1403
  // UNSIGNED_INT = 0x1405, FLOAT = 0x1406
  // HALF_FLOAT = 0x140B (OES) or 0x8D61 (WebGL2)
  // UNSIGNED_INT_24_8 = 0x84FA

  const PF_RGBA = 0x1908;
  const PF_RGB = 0x1907;
  const PF_RG = 0x8227;
  const PF_RED = 0x1903;
  const PF_LUMINANCE = 0x1909;
  const PF_DEPTH_COMPONENT = 0x1902;
  const PF_DEPTH_STENCIL = 0x84f9;

  const PD_UNSIGNED_BYTE = 0x1401;
  const PD_FLOAT = 0x1406;
  const PD_HALF_FLOAT = 0x140b;
  const PD_HALF_FLOAT_WEBGL2 = 0x8d61;
  const PD_UNSIGNED_SHORT = 0x1403;
  const PD_UNSIGNED_INT = 0x1405;
  const PD_UNSIGNED_INT_24_8 = 0x84fa;

  // Depth formats
  if (pixelFormat === PF_DEPTH_COMPONENT) {
    if (pixelDatatype === PD_UNSIGNED_SHORT) return "depth16unorm";
    if (pixelDatatype === PD_UNSIGNED_INT) return "depth32float";
    return "depth24plus";
  }
  if (pixelFormat === PF_DEPTH_STENCIL) {
    return "depth24plus-stencil8";
  }

  // RGBA
  if (pixelFormat === PF_RGBA) {
    if (pixelDatatype === PD_UNSIGNED_BYTE) return "rgba8unorm";
    if (pixelDatatype === PD_FLOAT) return "rgba32float";
    if (
      pixelDatatype === PD_HALF_FLOAT ||
      pixelDatatype === PD_HALF_FLOAT_WEBGL2
    )
      return "rgba16float";
    return "rgba8unorm";
  }

  // RGB — WebGPU has no RGB format, use RGBA
  if (pixelFormat === PF_RGB) {
    if (pixelDatatype === PD_UNSIGNED_BYTE) return "rgba8unorm";
    if (pixelDatatype === PD_FLOAT) return "rgba32float";
    return "rgba8unorm";
  }

  // RG
  if (pixelFormat === PF_RG) {
    if (pixelDatatype === PD_UNSIGNED_BYTE) return "rg8unorm";
    if (pixelDatatype === PD_FLOAT) return "rg32float";
    if (
      pixelDatatype === PD_HALF_FLOAT ||
      pixelDatatype === PD_HALF_FLOAT_WEBGL2
    )
      return "rg16float";
    return "rg8unorm";
  }

  // RED / LUMINANCE — use r8unorm
  if (pixelFormat === PF_RED || pixelFormat === PF_LUMINANCE) {
    if (pixelDatatype === PD_UNSIGNED_BYTE) return "r8unorm";
    if (pixelDatatype === PD_FLOAT) return "r32float";
    if (
      pixelDatatype === PD_HALF_FLOAT ||
      pixelDatatype === PD_HALF_FLOAT_WEBGL2
    )
      return "r16float";
    return "r8unorm";
  }

  // Default fallback
  return "rgba8unorm";
}

/**
 * Get bytes per pixel for a WebGPU format.
 */
function bytesPerPixel(format: GPUTextureFormat): number {
  const map: Record<string, number> = {
    rgba8unorm: 4,
    rgba32float: 16,
    rgba16float: 8,
    rg8unorm: 2,
    rg32float: 8,
    rg16float: 4,
    r8unorm: 1,
    r32float: 4,
    r16float: 2,
  };
  return map[format] ?? 4;
}

interface WebGPUTexture3DOptions {
  context: CesiumGraphicsContext;
  source?: {
    width: number;
    height: number;
    depth: number;
    arrayBufferView: ArrayBufferView;
    mipLevels?: ArrayBufferView[];
  };
  pixelFormat?: number;
  pixelDatatype?: number;
  width?: number;
  height?: number;
  depth?: number;
  sampler?: CesiumOpaqueSampler | null;
  flipY?: boolean;
  preMultiplyAlpha?: boolean;
  id?: string;
}

class WebGPUTexture3D {
  _id: string;
  _context: CesiumGraphicsContext | null;
  _gpuTexture: WebGPUTexture | null;
  _pixelFormat: number;
  _pixelDatatype: number;
  _width: number;
  _height: number;
  _depth: number;
  _webgpuFormat: GPUTextureFormat;
  _hasMipmap: boolean;
  _sizeInBytes: number;
  _preMultiplyAlpha: boolean;
  _flipY: boolean;
  _initialized: boolean;
  _sampler: CesiumOpaqueSampler | null;
  _destroyed: boolean;

  constructor(options: WebGPUTexture3DOptions) {
    const context = options.context;
    const device = context._device;
    if (!device) {
      throw new Error("A WebGPU context with an active device is required.");
    }

    const source = options.source;
    const pixelFormat = options.pixelFormat ?? 0x1908; // RGBA
    const pixelDatatype = options.pixelDatatype ?? 0x1401; // UNSIGNED_BYTE

    let width = options.width;
    let height = options.height;
    let depth = options.depth;

    if (source) {
      width = width ?? source.width;
      height = height ?? source.height;
      depth = depth ?? source.depth;
    }

    if (!width || !height || !depth) {
      throw new Error(
        "Texture3D requires width, height, and depth (or a source).",
      );
    }

    const webgpuFormat = cesiumFormatToWebGPU(pixelFormat, pixelDatatype);
    const bpp = bytesPerPixel(webgpuFormat);
    const mipLevelCount = source?.mipLevels ? source.mipLevels.length + 1 : 1;

    // Create the WebGPU 3D texture
    const gpuTexture = WebGPUTexture.create3D(
      device,
      width,
      height,
      depth,
      webgpuFormat,
      options.id ?? `Texture3D-${Date.now()}`,
    );

    this._id =
      options.id ??
      `tex3d-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this._context = context;
    this._gpuTexture = gpuTexture;
    this._pixelFormat = pixelFormat;
    this._pixelDatatype = pixelDatatype;
    this._width = width;
    this._height = height;
    this._depth = depth;
    this._webgpuFormat = webgpuFormat;
    this._hasMipmap = false;
    this._sizeInBytes = width * height * depth * bpp;
    this._preMultiplyAlpha = options.preMultiplyAlpha ?? false;
    this._flipY = options.flipY ?? true;
    this._initialized = false;
    this._sampler = options.sampler ?? null;
    this._destroyed = false;

    // Upload initial data if provided
    if (source && source.arrayBufferView) {
      this._writeData(source.arrayBufferView, 0, 0, 0, width, height, depth, 0);

      // Upload mip levels
      if (source.mipLevels) {
        let mw = width,
          mh = height,
          md = depth;
        for (let i = 0; i < source.mipLevels.length; i++) {
          mw = Math.max(1, Math.floor(mw / 2));
          mh = Math.max(1, Math.floor(mh / 2));
          md = Math.max(1, Math.floor(md / 2));
          this._writeData(source.mipLevels[i], 0, 0, 0, mw, mh, md, i + 1);
        }
      }

      this._initialized = true;
    }
  }

  /**
   * Write typed array data to the 3D texture.
   */
  private _writeData(
    data: ArrayBufferView,
    xOffset: number,
    yOffset: number,
    zOffset: number,
    width: number,
    height: number,
    depth: number,
    mipLevel: number,
  ): void {
    const device = this._context?._device;
    if (!device || !this._gpuTexture) return;

    const bpp = bytesPerPixel(this._webgpuFormat);
    const bytesPerRow = width * bpp;
    // WebGPU requires bytesPerRow to be a multiple of 256
    const alignedBytesPerRow = Math.ceil(bytesPerRow / 256) * 256;

    const gpuTex = this._gpuTexture.texture;

    // If bytesPerRow is already aligned or the data fits, write directly
    if (bytesPerRow === alignedBytesPerRow || width * bpp >= 256) {
      device.queue.writeTexture(
        {
          texture: gpuTex,
          mipLevel: mipLevel,
          origin: { x: xOffset, y: yOffset, z: zOffset },
        },
        data,
        {
          bytesPerRow: bytesPerRow,
          rowsPerImage: height,
        },
        {
          width: width,
          height: height,
          depthOrArrayLayers: depth,
        },
      );
    } else {
      // Need to pad rows for alignment
      const view = data as ArrayBufferView;
      const srcData = new Uint8Array(
        view.buffer,
        view.byteOffset,
        view.byteLength,
      );
      const paddedData = new Uint8Array(alignedBytesPerRow * height * depth);
      for (let z = 0; z < depth; z++) {
        for (let y = 0; y < height; y++) {
          const srcOffset = (z * height + y) * bytesPerRow;
          const dstOffset = (z * height + y) * alignedBytesPerRow;
          paddedData.set(
            srcData.subarray(srcOffset, srcOffset + bytesPerRow),
            dstOffset,
          );
        }
      }
      device.queue.writeTexture(
        {
          texture: gpuTex,
          mipLevel: mipLevel,
          origin: { x: xOffset, y: yOffset, z: zOffset },
        },
        paddedData,
        {
          bytesPerRow: alignedBytesPerRow,
          rowsPerImage: height,
        },
        {
          width: width,
          height: height,
          depthOrArrayLayers: depth,
        },
      );
    }
  }

  /**
   * Factory method matching Texture3D.create API.
   */
  static create(options: WebGPUTexture3DOptions): WebGPUTexture3D {
    return new WebGPUTexture3D(options);
  }

  /**
   * Copy new data into this 3D texture.
   * Matches `Texture3D.prototype.copyFrom` API.
   */
  copyFrom(options: {
    source: {
      width: number;
      height: number;
      depth: number;
      arrayBufferView: ArrayBufferView;
    };
    xOffset?: number;
    yOffset?: number;
    zOffset?: number;
  }): void {
    const { source, xOffset = 0, yOffset = 0, zOffset = 0 } = options;

    if (!source || !source.arrayBufferView) {
      throw new Error("options.source with arrayBufferView is required.");
    }

    if (!this._initialized) {
      // First write initializes the full texture if dimensions match
      if (
        xOffset === 0 &&
        yOffset === 0 &&
        zOffset === 0 &&
        source.width === this._width &&
        source.height === this._height &&
        source.depth === this._depth
      ) {
        this._writeData(
          source.arrayBufferView,
          0,
          0,
          0,
          source.width,
          source.height,
          source.depth,
          0,
        );
        this._initialized = true;
        return;
      }
    }

    this._writeData(
      source.arrayBufferView,
      xOffset,
      yOffset,
      zOffset,
      source.width,
      source.height,
      source.depth,
      0,
    );
    this._initialized = true;
  }

  /**
   * Generate mipmaps for this 3D texture.
   * Note: 3D texture mipmap generation via blit is more complex.
   * For now, delegate to WebGPUMipmapGenerator if available.
   */
  generateMipmap(hint?: number): void {
    if (this._gpuTexture) {
      this._gpuTexture.generateMipmaps();
    }
    this._hasMipmap = true;
  }

  /** The underlying WebGPU texture view for binding. */
  get textureView(): GPUTextureView | null {
    return this._gpuTexture?.view ?? null;
  }

  /** The underlying GPUTexture for direct access. */
  get gpuTexture(): GPUTexture | null {
    return this._gpuTexture?.texture ?? null;
  }

  get id(): string {
    return this._id;
  }
  get pixelFormat(): number {
    return this._pixelFormat;
  }
  get pixelDatatype(): number {
    return this._pixelDatatype;
  }
  get width(): number {
    return this._width;
  }
  get height(): number {
    return this._height;
  }
  get depth(): number {
    return this._depth;
  }
  get sizeInBytes(): number {
    if (this._hasMipmap) {
      return Math.floor((this._sizeInBytes * 8) / 7);
    }
    return this._sizeInBytes;
  }
  get sampler(): CesiumOpaqueSampler | null {
    return this._sampler;
  }
  set sampler(value: CesiumOpaqueSampler | null) {
    this._sampler = value;
  }
  get preMultiplyAlpha(): boolean {
    return this._preMultiplyAlpha;
  }
  get flipY(): boolean {
    return this._flipY;
  }

  isDestroyed(): boolean {
    return this._destroyed;
  }

  destroy(): void {
    if (this._gpuTexture) {
      this._gpuTexture.destroy();
    }
    this._gpuTexture = null;
    this._context = null;
    this._destroyed = true;
  }
}

export default WebGPUTexture3D;
export { cesiumFormatToWebGPU, bytesPerPixel };
