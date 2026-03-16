/**
 * WebGPU texture atlas for efficiently packing multiple images into a single
 * GPU texture. Used by BillboardCollection and LabelCollection.
 *
 * Unlike the WebGL TextureAtlas which uses gl.copyTexImage2D for resizing,
 * this implementation uses GPU-side copies via command encoder for
 * better performance.
 *
 * Images are packed using a bin-packing algorithm (shelf or maxrects)
 * and texture coordinates are tracked per-image. The atlas dynamically
 * resizes (power-of-two) when more space is needed.
 *
 * @private
 */

import defined from "../../Core/defined.js";
import DeveloperError from "../../Core/DeveloperError.js";
import destroyObject from "../../Core/destroyObject.js";
import createGuid from "../../Core/createGuid.js";
import CesiumMath from "../../Core/Math.js";
import BoundingRectangle from "../../Core/BoundingRectangle.js";
import Cartesian2 from "../../Core/Cartesian2.js";
import { WebGPUTexture } from "./WebGPUTexture.js";
import { gpuData } from "./webgpuTypeHelpers.js";

const DEFAULT_INITIAL_SIZE = 16;
const DEFAULT_BORDER_WIDTH = 1;

/**
 * Region in the atlas for a single image.
 */
export interface AtlasRegion {
  /** Normalized U coordinate (0-1) */
  x: number;
  /** Normalized V coordinate (0-1) */
  y: number;
  /** Normalized width (0-1) */
  width: number;
  /** Normalized height (0-1) */
  height: number;
}

/**
 * Internal node for the atlas packing tree (binary tree bin packing).
 */
interface PackNode {
  x: number;
  y: number;
  width: number;
  height: number;
  left: PackNode | null;
  right: PackNode | null;
  imageId: string | null;
}

export interface WebGPUTextureAtlasOptions {
  /** GPU device */
  device: GPUDevice;
  /** Initial atlas dimensions (will be power-of-two) */
  initialSize?: number;
  /** Border pixels between images to prevent bleeding */
  borderWidthInPixels?: number;
  /** Texture format */
  format?: GPUTextureFormat;
  /** Debug label */
  label?: string;
}

class WebGPUTextureAtlas {
  private _device: GPUDevice;
  private _texture: WebGPUTexture | null;
  private _textureSize: number;
  private _borderWidth: number;
  private _format: GPUTextureFormat;
  private _label: string;
  private _root: PackNode;
  private _regions: Map<string, AtlasRegion>;
  private _imageOrder: string[];
  private _guid: string;
  private _isDestroyed: boolean;

  constructor(options: WebGPUTextureAtlasOptions) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(options.device)) {
      throw new DeveloperError("options.device is required.");
    }
    //>>includeEnd('debug');

    this._device = options.device;
    this._format = options.format ?? "rgba8unorm";
    this._label = options.label ?? "TextureAtlas";
    this._borderWidth = options.borderWidthInPixels ?? DEFAULT_BORDER_WIDTH;

    // Start with initial size (power of two)
    const initialSize = CesiumMath.nextPowerOfTwo(
      options.initialSize ?? DEFAULT_INITIAL_SIZE,
    );
    this._textureSize = initialSize;

    // Create initial texture
    this._texture = this._createTexture(initialSize);

    // Initialize packing tree
    this._root = this._createNode(0, 0, initialSize, initialSize);

    // Track regions and ordering
    this._regions = new Map();
    this._imageOrder = [];
    this._guid = createGuid();
    this._isDestroyed = false;
  }

  /**
   * A GUID that changes whenever texture coordinates change (e.g., on resize).
   * Consumers should cache this and re-fetch coordinates when it changes.
   */
  get guid(): string {
    return this._guid;
  }

  /**
   * The underlying WebGPU texture.
   */
  get texture(): WebGPUTexture | null {
    return this._texture;
  }

  /**
   * Current atlas texture size (square, power of two).
   */
  get textureSize(): number {
    return this._textureSize;
  }

  /**
   * Number of images in the atlas.
   */
  get numberOfImages(): number {
    return this._regions.size;
  }

  /**
   * Gets the texture coordinates (normalized 0-1) for an image by its ID.
   */
  getRegion(imageId: string): AtlasRegion | undefined {
    return this._regions.get(imageId);
  }

  /**
   * Gets all regions as an array (ordered by insertion).
   */
  getRegions(): AtlasRegion[] {
    return this._imageOrder.map((id) => this._regions.get(id)!);
  }

  /**
   * Adds an image to the atlas from RGBA pixel data.
   *
   * @param {string} imageId - Unique identifier for this image
   * @param {Uint8Array} rgbaData - RGBA pixel data
   * @param {number} width - Image width in pixels
   * @param {number} height - Image height in pixels
   * @returns {AtlasRegion} Normalized texture coordinates for the image
   */
  addImage(
    imageId: string,
    rgbaData: Uint8Array,
    width: number,
    height: number,
  ): AtlasRegion {
    //>>includeStart('debug', pragmas.debug);
    if (this._regions.has(imageId)) {
      throw new DeveloperError(`Image '${imageId}' already in atlas.`);
    }
    //>>includeEnd('debug');

    const border = this._borderWidth;
    const paddedW = width + border * 2;
    const paddedH = height + border * 2;

    // Try to find space in current tree
    let node = this._insertNode(this._root, paddedW, paddedH);

    // If no space, grow the texture and retry
    if (!node) {
      this._grow();
      node = this._insertNode(this._root, paddedW, paddedH);
      if (!node) {
        throw new DeveloperError(
          `Cannot fit image ${width}x${height} into atlas.`,
        );
      }
    }

    node.imageId = imageId;

    // Upload pixel data at the node position (offset by border)
    this._uploadRegion(
      rgbaData,
      width,
      height,
      node.x + border,
      node.y + border,
    );

    // Compute normalized coordinates
    const region: AtlasRegion = {
      x: (node.x + border) / this._textureSize,
      y: (node.y + border) / this._textureSize,
      width: width / this._textureSize,
      height: height / this._textureSize,
    };

    this._regions.set(imageId, region);
    this._imageOrder.push(imageId);

    return region;
  }

  /**
   * Adds an image from an ImageBitmap or HTMLImageElement.
   * Uses `copyExternalImageToTexture()` for zero-copy GPU upload when possible,
   * falling back to OffscreenCanvas extraction for non-ImageBitmap sources.
   *
   * @param {string} imageId - Unique identifier for this image
   * @param {ImageBitmap | HTMLImageElement} image - The image to add
   * @returns {Promise<AtlasRegion>} Normalized texture coordinates
   */
  async addImageElement(
    imageId: string,
    image: ImageBitmap | HTMLImageElement,
  ): Promise<AtlasRegion> {
    //>>includeStart('debug', pragmas.debug);
    if (this._regions.has(imageId)) {
      throw new DeveloperError(`Image '${imageId}' already in atlas.`);
    }
    //>>includeEnd('debug');

    const width = image.width;
    const height = image.height;
    const border = this._borderWidth;
    const paddedW = width + border * 2;
    const paddedH = height + border * 2;

    // Try to find space in current tree
    let node = this._insertNode(this._root, paddedW, paddedH);
    if (!node) {
      this._grow();
      node = this._insertNode(this._root, paddedW, paddedH);
      if (!node) {
        throw new DeveloperError(
          `Cannot fit image ${width}x${height} into atlas.`,
        );
      }
    }
    node.imageId = imageId;

    const destX = node.x + border;
    const destY = node.y + border;

    // Use copyExternalImageToTexture for direct GPU upload (C2 optimization)
    // This avoids the expensive OffscreenCanvas → getImageData() → writeTexture() path
    if (this._texture && image instanceof ImageBitmap) {
      this._device.queue.copyExternalImageToTexture(
        { source: image },
        { texture: this._texture.texture, origin: { x: destX, y: destY } },
        { width, height },
      );
    } else {
      // Fallback: extract RGBA data via OffscreenCanvas for HTMLImageElement
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(image, 0, 0);
      const imageData = ctx.getImageData(0, 0, width, height);
      const rgbaData = new Uint8Array(imageData.data.buffer);
      this._uploadRegion(rgbaData, width, height, destX, destY);
    }

    // Compute normalized coordinates
    const region: AtlasRegion = {
      x: destX / this._textureSize,
      y: destY / this._textureSize,
      width: width / this._textureSize,
      height: height / this._textureSize,
    };

    this._regions.set(imageId, region);
    this._imageOrder.push(imageId);
    return region;
  }

  /**
   * Grows the atlas texture to the next power-of-two size.
   * Copies existing content to the new texture via GPU copy.
   */
  private _grow(): void {
    const oldSize = this._textureSize;
    const newSize = oldSize * 2;

    // Create new texture
    const newTexture = this._createTexture(newSize);

    // Copy old texture to new texture via command encoder
    if (this._texture) {
      const encoder = this._device.createCommandEncoder({
        label: `${this._label}_GrowCopy`,
      });

      encoder.copyTextureToTexture(
        { texture: this._texture.texture },
        { texture: newTexture.texture },
        { width: oldSize, height: oldSize },
      );

      this._device.queue.submit([encoder.finish()]);

      // Destroy old texture
      this._texture.destroy();
    }

    this._texture = newTexture;
    this._textureSize = newSize;

    // Rebuild packing tree with new size
    this._root = this._createNode(0, 0, newSize, newSize);
    this._rebuildTree();

    // Recalculate all regions (coordinates change because texture size changed)
    this._recalculateRegions();

    // Update GUID so consumers know coordinates changed
    this._guid = createGuid();
  }

  /**
   * Rebuilds the packing tree from existing images.
   */
  private _rebuildTree(): void {
    // For simplicity on rebuild, we re-insert all existing images
    // The actual pixel data is already in the texture from the GPU copy
    const border = this._borderWidth;
    const oldRegions = new Map(this._regions);

    for (const [imageId, region] of oldRegions) {
      // Convert back to pixel coordinates
      const pixelX = Math.round(region.x * (this._textureSize / 2));
      const pixelY = Math.round(region.y * (this._textureSize / 2));
      const pixelW = Math.round(region.width * (this._textureSize / 2));
      const pixelH = Math.round(region.height * (this._textureSize / 2));

      const paddedW = pixelW + border * 2;
      const paddedH = pixelH + border * 2;

      const node = this._insertNode(this._root, paddedW, paddedH);
      if (node) {
        node.imageId = imageId;
      }
    }
  }

  /**
   * Recalculates normalized coordinates for all images after resize.
   */
  private _recalculateRegions(): void {
    const size = this._textureSize;
    const border = this._borderWidth;

    this._collectNodes(this._root, (node) => {
      if (node.imageId) {
        const region = this._regions.get(node.imageId);
        if (region) {
          region.x = (node.x + border) / size;
          region.y = (node.y + border) / size;
          // Width/height in pixels haven't changed, but normalization has
          region.width = (node.width - border * 2) / size;
          region.height = (node.height - border * 2) / size;
        }
      }
    });
  }

  /**
   * Traverses all nodes calling callback on each.
   */
  private _collectNodes(
    node: PackNode | null,
    callback: (node: PackNode) => void,
  ): void {
    if (!node) return;
    callback(node);
    this._collectNodes(node.left, callback);
    this._collectNodes(node.right, callback);
  }

  /**
   * Uploads RGBA data to a region of the atlas texture.
   */
  private _uploadRegion(
    data: Uint8Array,
    width: number,
    height: number,
    x: number,
    y: number,
  ): void {
    if (!this._texture) return;

    this._device.queue.writeTexture(
      {
        texture: this._texture.texture,
        origin: { x, y, z: 0 },
      },
      gpuData(data),
      {
        bytesPerRow: width * 4,
        rowsPerImage: height,
      },
      { width, height },
    );
  }

  /**
   * Creates a new atlas texture.
   */
  private _createTexture(size: number): WebGPUTexture {
    return WebGPUTexture.create({
      device: this._device,
      width: size,
      height: size,
      format: this._format,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.RENDER_ATTACHMENT,
      label: `${this._label}_${size}x${size}`,
    });
  }

  /**
   * Creates a pack node.
   */
  private _createNode(
    x: number,
    y: number,
    width: number,
    height: number,
  ): PackNode {
    return {
      x,
      y,
      width,
      height,
      left: null,
      right: null,
      imageId: null,
    };
  }

  /**
   * Binary tree bin-packing insertion.
   * Returns a leaf node that fits the given dimensions, or null.
   */
  private _insertNode(
    node: PackNode | null,
    width: number,
    height: number,
  ): PackNode | null {
    if (!node) return null;

    // If this node has children, try inserting into children
    if (node.left || node.right) {
      const result = this._insertNode(node.left, width, height);
      if (result) return result;
      return this._insertNode(node.right, width, height);
    }

    // If already occupied, can't use
    if (node.imageId !== null) return null;

    // If too small, can't fit
    if (width > node.width || height > node.height) return null;

    // Perfect fit
    if (width === node.width && height === node.height) return node;

    // Split the node
    const dw = node.width - width;
    const dh = node.height - height;

    if (dw > dh) {
      // Split horizontally
      node.left = this._createNode(node.x, node.y, width, node.height);
      node.right = this._createNode(node.x + width, node.y, dw, node.height);
    } else {
      // Split vertically
      node.left = this._createNode(node.x, node.y, node.width, height);
      node.right = this._createNode(node.x, node.y + height, node.width, dh);
    }

    return this._insertNode(node.left, width, height);
  }

  /**
   * Whether the atlas has been destroyed.
   */
  isDestroyed(): boolean {
    return this._isDestroyed;
  }

  /**
   * Destroys the atlas and releases GPU resources.
   */
  destroy(): void {
    if (this._isDestroyed) return;

    if (this._texture) {
      this._texture.destroy();
      this._texture = null;
    }

    this._regions.clear();
    this._imageOrder = [];
    this._isDestroyed = true;
  }
}

export default WebGPUTextureAtlas;
