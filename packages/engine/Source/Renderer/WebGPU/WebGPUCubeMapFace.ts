/**
 * WebGPU equivalent of CubeMapFace.js.
 *
 * Represents a single face of a WebGPU cubemap texture. In WebGL, each face
 * is a separate `gl.TEXTURE_CUBE_MAP_POSITIVE_X` etc. target. In WebGPU,
 * cubemaps are 2D textures with `depthOrArrayLayers: 6`, and each face is
 * accessed via a layer view (array layer index 0-5).
 *
 * Face index mapping (same as WebGL):
 *   0 = +X, 1 = -X, 2 = +Y, 3 = -Y, 4 = +Z, 5 = -Z
 *
 * @private
 */

import { WebGPUTexture } from "./WebGPUTexture.js";
import { cesiumFormatToWebGPU, bytesPerPixel } from "./WebGPUTexture3D.js";

class WebGPUCubeMapFace {
  private _context: CesiumGraphicsContext;
  private _parentTexture: WebGPUTexture | null;
  private _faceIndex: number;
  private _pixelFormat: number;
  private _pixelDatatype: number;
  private _size: number;
  private _preMultiplyAlpha: boolean;
  private _flipY: boolean;
  private _initialized: boolean;
  private _layerView: GPUTextureView | null;

  constructor(
    context: CesiumGraphicsContext,
    parentTexture: WebGPUTexture | null,
    faceIndex: number,
    pixelFormat: number,
    pixelDatatype: number,
    size: number,
    preMultiplyAlpha: boolean,
    flipY: boolean,
    initialized: boolean,
  ) {
    this._context = context;
    this._parentTexture = parentTexture;
    this._faceIndex = faceIndex;
    this._pixelFormat = pixelFormat;
    this._pixelDatatype = pixelDatatype;
    this._size = size;
    this._preMultiplyAlpha = preMultiplyAlpha;
    this._flipY = flipY;
    this._initialized = initialized;
    this._layerView = null;
  }

  get pixelFormat(): number {
    return this._pixelFormat;
  }

  get pixelDatatype(): number {
    return this._pixelDatatype;
  }

  get size(): number {
    return this._size;
  }

  get faceIndex(): number {
    return this._faceIndex;
  }

  /**
   * Get a 2D texture view for this specific face.
   * Used when rendering to a single face (e.g., environment map generation).
   */
  get textureView(): GPUTextureView {
    if (!this._layerView && this._parentTexture) {
      this._layerView = this._parentTexture.createLayerView(this._faceIndex, 0);
    }
    return this._layerView!;
  }

  /**
   * The underlying WebGL target face constant (for compatibility).
   * In WebGPU this returns the face index instead.
   */
  get _target(): number {
    return this._faceIndex;
  }

  /**
   * Copy pixel data from a source to this cube face.
   * Matches `CubeMapFace.prototype.copyFrom`.
   *
   * @param options - Source data with optional offsets
   */
  copyFrom(options: {
    source?:
      | ImageBitmap
      | HTMLCanvasElement
      | HTMLImageElement
      | {
          width: number;
          height: number;
          arrayBufferView: ArrayBufferView;
        };
    xOffset?: number;
    yOffset?: number;
    skipColorSpaceConversion?: boolean;
  }): void {
    const { source, xOffset = 0, yOffset = 0 } = options;
    if (!source) return;

    const device = this._context._device;
    if (!device || !this._parentTexture) return;

    const gpuTexture = this._parentTexture.texture;
    if (!gpuTexture) return;

    // ImageBitmap / HTMLCanvasElement / HTMLImageElement path
    if (
      source instanceof ImageBitmap ||
      (typeof HTMLCanvasElement !== "undefined" &&
        source instanceof HTMLCanvasElement) ||
      (typeof HTMLImageElement !== "undefined" &&
        source instanceof HTMLImageElement)
    ) {
      device.queue.copyExternalImageToTexture(
        { source: source as ImageBitmap },
        {
          texture: gpuTexture,
          origin: {
            x: xOffset,
            y: yOffset,
            z: this._faceIndex,
          },
        },
        {
          width: (source as ImageBitmap).width ?? this._size,
          height: (source as ImageBitmap).height ?? this._size,
        },
      );
      this._initialized = true;
      return;
    }

    // ArrayBufferView path
    const bufferSource = source as {
      width: number;
      height: number;
      arrayBufferView: ArrayBufferView;
    };
    if (bufferSource.arrayBufferView) {
      const webgpuFormat = cesiumFormatToWebGPU(
        this._pixelFormat,
        this._pixelDatatype,
      );
      const bpp = bytesPerPixel(webgpuFormat);
      const bytesPerRow = bufferSource.width * bpp;

      device.queue.writeTexture(
        {
          texture: gpuTexture,
          mipLevel: 0,
          origin: {
            x: xOffset,
            y: yOffset,
            z: this._faceIndex,
          },
        },
        bufferSource.arrayBufferView,
        {
          bytesPerRow: bytesPerRow,
          rowsPerImage: bufferSource.height,
        },
        {
          width: bufferSource.width,
          height: bufferSource.height,
        },
      );
      this._initialized = true;
    }
  }
}

export default WebGPUCubeMapFace;
