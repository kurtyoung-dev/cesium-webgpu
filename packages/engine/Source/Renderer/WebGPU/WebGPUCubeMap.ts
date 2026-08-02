/**
 * WebGPU equivalent of CubeMap.js.
 *
 * Wraps a `WebGPUTexture` (cubemap) with the same API surface as the WebGL
 * `CubeMap` class. In WebGL, cubemaps use `gl.TEXTURE_CUBE_MAP` with 6
 * separate face targets. In WebGPU, cubemaps are 2D textures with
 * `depthOrArrayLayers: 6` and a `"cube"` texture view dimension.
 *
 * Consumers: loadCubeMap, Context (default cubemap), CubeMapPanorama,
 * DynamicEnvironmentMapManager, Material, ShadowMap, SpecularEnvironmentCubeMap.
 *
 * @private
 */

import WebGPUTexture from "./WebGPUTexture.js";
import WebGPUCubeMapFace from "./WebGPUCubeMapFace.js";
import { cesiumFormatToWebGPU, bytesPerPixel } from "./WebGPUTexture3D.js";
import {
  supportsWebGPULayeredMipmapGeneration,
  supportsWebGPUMipmapGeneration,
  supportsWebGPURenderAttachment,
} from "./WebGPUMipmapGenerator.js";

/**
 * Face name constants matching CubeMap.FaceName in WebGL.
 */
const FaceName = Object.freeze({
  POSITIVEX: 0,
  NEGATIVEX: 1,
  POSITIVEY: 2,
  NEGATIVEY: 3,
  POSITIVEZ: 4,
  NEGATIVEZ: 5,
});

interface CubeMapSource {
  positiveX?:
    | ImageBitmap
    | HTMLImageElement
    | HTMLCanvasElement
    | { width: number; height: number; arrayBufferView: ArrayBufferView };
  negativeX?:
    | ImageBitmap
    | HTMLImageElement
    | HTMLCanvasElement
    | { width: number; height: number; arrayBufferView: ArrayBufferView };
  positiveY?:
    | ImageBitmap
    | HTMLImageElement
    | HTMLCanvasElement
    | { width: number; height: number; arrayBufferView: ArrayBufferView };
  negativeY?:
    | ImageBitmap
    | HTMLImageElement
    | HTMLCanvasElement
    | { width: number; height: number; arrayBufferView: ArrayBufferView };
  positiveZ?:
    | ImageBitmap
    | HTMLImageElement
    | HTMLCanvasElement
    | { width: number; height: number; arrayBufferView: ArrayBufferView };
  negativeZ?:
    | ImageBitmap
    | HTMLImageElement
    | HTMLCanvasElement
    | { width: number; height: number; arrayBufferView: ArrayBufferView };
}

interface WebGPUCubeMapOptions {
  context: CesiumGraphicsContext;
  source?: CubeMapSource;
  width?: number;
  height?: number;
  pixelFormat?: number;
  pixelDatatype?: number;
  flipY?: boolean;
  preMultiplyAlpha?: boolean;
  sampler?: CesiumOpaqueSampler | null;
}

class WebGPUCubeMap {
  private _context: CesiumGraphicsContext | null;
  private _gpuTexture: WebGPUTexture | null;
  private _size: number;
  private _pixelFormat: number;
  private _pixelDatatype: number;
  private _webgpuFormat: GPUTextureFormat;
  private _hasMipmap: boolean;
  private _sizeInBytes: number;
  private _preMultiplyAlpha: boolean;
  private _flipY: boolean;
  private _sampler: CesiumOpaqueSampler | null;
  private _destroyed: boolean;

  // Individual face accessors (matching CubeMap.js API)
  private _positiveX: WebGPUCubeMapFace;
  private _negativeX: WebGPUCubeMapFace;
  private _positiveY: WebGPUCubeMapFace;
  private _negativeY: WebGPUCubeMapFace;
  private _positiveZ: WebGPUCubeMapFace;
  private _negativeZ: WebGPUCubeMapFace;

  constructor(options: WebGPUCubeMapOptions) {
    const context = options.context;
    const device = context._device;
    if (!device) {
      throw new Error("A WebGPU context with an active device is required.");
    }

    const source = options.source;
    const pixelFormat = options.pixelFormat ?? 0x1908; // RGBA
    const pixelDatatype = options.pixelDatatype ?? 0x1401; // UNSIGNED_BYTE
    const flipY = options.flipY ?? false;
    const preMultiplyAlpha = options.preMultiplyAlpha ?? false;

    // Determine size from source or options
    let size = options.width ?? options.height;
    if (!size && source) {
      const firstFace =
        source.positiveX ??
        source.negativeX ??
        source.positiveY ??
        source.negativeY ??
        source.positiveZ ??
        source.negativeZ;
      if (firstFace) {
        // All union members (ImageBitmap, HTMLImageElement, HTMLCanvasElement,
        // {width,height,arrayBufferView}) have a .width property
        size = (firstFace as { width: number }).width ?? 1;
      }
    }
    if (!size) {
      throw new Error("CubeMap requires a size (width/height or source).");
    }

    const webgpuFormat = cesiumFormatToWebGPU(pixelFormat, pixelDatatype);
    const bpp = bytesPerPixel(webgpuFormat);

    // WebGPU texture storage is immutable: generateMipmap cannot add levels
    // later. Reserve the exact full chain only when the filtering color-blit
    // generator supports this format. Integer/depth/non-renderable formats
    // retain a valid single-level cube instead of publishing an invalid mip
    // pass or exposing zero-filled tail levels.
    const canGenerateMipmaps =
      supportsWebGPUMipmapGeneration(device, webgpuFormat) &&
      supportsWebGPULayeredMipmapGeneration(device);
    const mipLevelCount = canGenerateMipmaps
      ? Math.floor(Math.log2(size)) + 1
      : 1;
    const gpuTexture = WebGPUTexture.createCubeMap(
      device,
      size,
      webgpuFormat,
      mipLevelCount,
      `CubeMap-${size}`,
      GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        (supportsWebGPURenderAttachment(device, webgpuFormat)
          ? GPUTextureUsage.RENDER_ATTACHMENT
          : 0),
    );

    this._context = context;
    this._gpuTexture = gpuTexture;
    this._size = size;
    this._pixelFormat = pixelFormat;
    this._pixelDatatype = pixelDatatype;
    this._webgpuFormat = webgpuFormat;
    this._hasMipmap = false;
    // Residency accounting: WebGPU reserves every immutable mip level at
    // texture creation even before generateMipmap populates it.
    let residentBytes = 0;
    for (let level = 0; level < mipLevelCount; ++level) {
      const levelSize = Math.max(1, size >> level);
      residentBytes += levelSize * levelSize * 6 * bpp;
    }
    this._sizeInBytes = residentBytes;
    this._preMultiplyAlpha = preMultiplyAlpha;
    this._flipY = flipY;
    this._sampler = options.sampler ?? null;
    this._destroyed = false;

    // Create face wrappers
    const initialized = !!source;
    this._positiveX = new WebGPUCubeMapFace(
      context,
      gpuTexture,
      0,
      pixelFormat,
      pixelDatatype,
      size,
      preMultiplyAlpha,
      flipY,
      initialized,
    );
    this._negativeX = new WebGPUCubeMapFace(
      context,
      gpuTexture,
      1,
      pixelFormat,
      pixelDatatype,
      size,
      preMultiplyAlpha,
      flipY,
      initialized,
    );
    this._positiveY = new WebGPUCubeMapFace(
      context,
      gpuTexture,
      2,
      pixelFormat,
      pixelDatatype,
      size,
      preMultiplyAlpha,
      flipY,
      initialized,
    );
    this._negativeY = new WebGPUCubeMapFace(
      context,
      gpuTexture,
      3,
      pixelFormat,
      pixelDatatype,
      size,
      preMultiplyAlpha,
      flipY,
      initialized,
    );
    this._positiveZ = new WebGPUCubeMapFace(
      context,
      gpuTexture,
      4,
      pixelFormat,
      pixelDatatype,
      size,
      preMultiplyAlpha,
      flipY,
      initialized,
    );
    this._negativeZ = new WebGPUCubeMapFace(
      context,
      gpuTexture,
      5,
      pixelFormat,
      pixelDatatype,
      size,
      preMultiplyAlpha,
      flipY,
      initialized,
    );

    // Upload source data if provided
    if (source) {
      this._uploadFaces(source);
    }
  }

  /**
   * Upload source images/data to all 6 cubemap faces.
   */
  private _uploadFaces(source: CubeMapSource): void {
    type CubeMapFaceSource = CubeMapSource[keyof CubeMapSource];
    const faces: [WebGPUCubeMapFace, CubeMapFaceSource][] = [
      [this._positiveX, source.positiveX],
      [this._negativeX, source.negativeX],
      [this._positiveY, source.positiveY],
      [this._negativeY, source.negativeY],
      [this._positiveZ, source.positiveZ],
      [this._negativeZ, source.negativeZ],
    ];

    for (const [face, faceSource] of faces) {
      if (faceSource) {
        face.copyFrom({ source: faceSource });
      }
    }
  }

  /**
   * Factory method matching CubeMap.create API.
   */
  static create(options: WebGPUCubeMapOptions): WebGPUCubeMap {
    return new WebGPUCubeMap(options);
  }

  /** Face name enum */
  static get FaceName() {
    return FaceName;
  }

  /** Iterator over face names */
  static *faceNames(): Generator<number> {
    yield FaceName.POSITIVEX;
    yield FaceName.NEGATIVEX;
    yield FaceName.POSITIVEY;
    yield FaceName.NEGATIVEY;
    yield FaceName.POSITIVEZ;
    yield FaceName.NEGATIVEZ;
  }

  // --- Face accessors matching CubeMap.js API ---

  get positiveX(): WebGPUCubeMapFace {
    return this._positiveX;
  }
  get negativeX(): WebGPUCubeMapFace {
    return this._negativeX;
  }
  get positiveY(): WebGPUCubeMapFace {
    return this._positiveY;
  }
  get negativeY(): WebGPUCubeMapFace {
    return this._negativeY;
  }
  get positiveZ(): WebGPUCubeMapFace {
    return this._positiveZ;
  }
  get negativeZ(): WebGPUCubeMapFace {
    return this._negativeZ;
  }

  /**
   * Get face by FaceName index.
   */
  getFace(faceName: number): WebGPUCubeMapFace {
    switch (faceName) {
      case 0:
        return this._positiveX;
      case 1:
        return this._negativeX;
      case 2:
        return this._positiveY;
      case 3:
        return this._negativeY;
      case 4:
        return this._positiveZ;
      case 5:
        return this._negativeZ;
      default:
        throw new Error(`Invalid face name: ${faceName}`);
    }
  }

  // --- Texture properties ---

  /** The "cube" dimension texture view for shader sampling */
  get textureView(): GPUTextureView | null {
    return this._gpuTexture?.view ?? null;
  }

  /** The "2d-array" view for rendering to individual faces */
  get arrayView(): GPUTextureView | null {
    return this._gpuTexture?.createArrayView() ?? null;
  }

  /** The underlying GPUTexture */
  get gpuTexture(): GPUTexture | null {
    return this._gpuTexture?.texture ?? null;
  }

  /** Alias for compatibility: the WebGL texture property */
  get _texture(): WebGPUTexture | null {
    return this._gpuTexture;
  }

  get pixelFormat(): number {
    return this._pixelFormat;
  }
  get pixelDatatype(): number {
    return this._pixelDatatype;
  }
  get width(): number {
    return this._size;
  }
  get height(): number {
    return this._size;
  }
  get size(): number {
    return this._size;
  }
  get sizeInBytes(): number {
    return this._sizeInBytes;
  }
  get preMultiplyAlpha(): boolean {
    return this._preMultiplyAlpha;
  }
  get flipY(): boolean {
    return this._flipY;
  }

  get sampler(): CesiumOpaqueSampler | null {
    return this._sampler;
  }
  set sampler(value: CesiumOpaqueSampler | null) {
    this._sampler = value;
  }

  /**
   * Generate mipmaps for the cubemap.
   * Delegates to WebGPUMipmapGenerator.
   */
  generateMipmap(hint?: number): void {
    const texture = this._gpuTexture;
    if (texture) {
      const context = this._context as unknown as {
        enqueueTextureMipGeneration?: (
          texture: GPUTexture,
          format: GPUTextureFormat,
          mipLevelCount: number,
          options: {
            dimension: "cube";
            baseArrayLayer: number;
            arrayLayerCount: number;
          },
        ) => boolean | void;
      } | null;
      if (texture.mipLevelCount <= 1) {
        this._hasMipmap = true;
        return;
      }
      if (typeof context?.enqueueTextureMipGeneration === "function") {
        const accepted = context.enqueueTextureMipGeneration(
          texture.texture,
          texture.format,
          texture.mipLevelCount,
          {
            dimension: "cube",
            baseArrayLayer: 0,
            arrayLayerCount: 6,
          },
        );
        // The canonical queue returns false when the device is unavailable.
        // Undefined preserves compatibility with older void-returning hosts.
        if (accepted !== false) {
          this._hasMipmap = true;
        }
      } else {
        // Standalone/legacy contexts retain the wrapper's immediate-submit
        // fallback. Live WebGPU scene contexts always take the frame-owned
        // queue above.
        texture.generateMipmaps();
        this._hasMipmap = true;
      }
    }
  }

  isDestroyed(): boolean {
    return this._destroyed;
  }

  destroy(): void {
    const texture = this._gpuTexture;
    const context = this._context as unknown as {
      cancelTextureMipGeneration?: (texture: GPUTexture) => void;
    } | null;
    // Detach first so a throwing native destroy cannot leave a logically live
    // cube that retries cancellation/destruction or exposes dead views.
    this._gpuTexture = null;
    this._context = null;
    this._destroyed = true;
    if (texture) {
      const cancellationContext = context as {
        cancelTextureMipGeneration?: (texture: GPUTexture) => void;
      } | null;
      try {
        cancellationContext?.cancelTextureMipGeneration?.(texture.texture);
      } catch {
        // Queue bookkeeping must never strand native retirement.
      }
      texture.destroy();
    }
  }
}

export default WebGPUCubeMap;
export { FaceName };
