/**
 * Utility functions for texture operations in the WebGPU renderer:
 * default texture initialization, texture copy operations, and
 * texture creation from image sources.
 *
 * Extracted from WebGPUContext to keep the main context file focused on
 * frame lifecycle and rendering.
 *
 * @see WebGPUContext
 * @see WebGPUTexture
 * @module WebGPUTextureUtilities
 */

/// <reference types="@webgpu/types" />

import { WebGPUTexture } from "./WebGPUTexture.js";

// ============================================================================
// Types
// ============================================================================

/**
 * The set of default textures created during context initialization.
 */
export interface DefaultTextures {
  /** 1×1 white RGBA texture */
  defaultTexture: WebGPUTexture;
  /** 1×1 black RGBA texture (emissive placeholder) */
  defaultEmissiveTexture: WebGPUTexture;
  /** 1×1 (128,128,255) normal-map placeholder (tangent-space "up") */
  defaultNormalTexture: WebGPUTexture;
  /** 1×1 white cubemap (all 6 faces) */
  defaultCubeMap: WebGPUTexture;
}

// ============================================================================
// Default Texture Initialization
// ============================================================================

/**
 * Create the standard set of default textures that CesiumJS expects.
 * These are tiny 1×1 placeholders used when actual textures are not yet loaded.
 *
 * @param device - The GPU device
 * @returns The four default textures
 */
export function createDefaultTextures(device: GPUDevice): DefaultTextures {
  // 1×1 white
  const whiteData = new Uint8Array([255, 255, 255, 255]);
  const defaultTexture = WebGPUTexture.create2D(
    device,
    1,
    1,
    "rgba8unorm",
    1,
    "Default White Texture",
  );
  defaultTexture.write(whiteData, 1, 1);

  // 1×1 black
  const blackData = new Uint8Array([0, 0, 0, 255]);
  const defaultEmissiveTexture = WebGPUTexture.create2D(
    device,
    1,
    1,
    "rgba8unorm",
    1,
    "Default Emissive Texture",
  );
  defaultEmissiveTexture.write(blackData, 1, 1);

  // 1×1 normal (tangent-space up = (0.5, 0.5, 1.0) → (128, 128, 255))
  const normalData = new Uint8Array([128, 128, 255, 255]);
  const defaultNormalTexture = WebGPUTexture.create2D(
    device,
    1,
    1,
    "rgba8unorm",
    1,
    "Default Normal Texture",
  );
  defaultNormalTexture.write(normalData, 1, 1);

  // 1×1 cubemap — all faces white
  const defaultCubeMap = WebGPUTexture.createCubeMap(
    device,
    1,
    "rgba8unorm",
    1,
    "Default Cube Map",
  );
  for (let face = 0; face < 6; face++) {
    defaultCubeMap.write(whiteData, 1, 1, face);
  }

  return {
    defaultTexture,
    defaultEmissiveTexture,
    defaultNormalTexture,
    defaultCubeMap,
  };
}

// ============================================================================
// Texture Copy Operations
// ============================================================================

/**
 * Copy a region (or all) of one texture to another.
 * Must be called while a command encoder is active (between beginFrame/endFrame).
 *
 * @param encoder - Active GPUCommandEncoder
 * @param source - Source texture
 * @param destination - Destination texture
 * @param sourceOrigin - Source origin (default: {x:0, y:0, z:0})
 * @param destinationOrigin - Destination origin (default: {x:0, y:0, z:0})
 * @param copySize - Region size (default: full source dimensions)
 */
export function copyTexture(
  encoder: GPUCommandEncoder,
  source: GPUTexture,
  destination: GPUTexture,
  sourceOrigin?: GPUOrigin3D,
  destinationOrigin?: GPUOrigin3D,
  copySize?: GPUExtent3D,
): void {
  const srcOrigin = sourceOrigin ?? { x: 0, y: 0, z: 0 };
  const dstOrigin = destinationOrigin ?? { x: 0, y: 0, z: 0 };
  const size = copySize ?? {
    width: source.width,
    height: source.height,
    depthOrArrayLayers: 1,
  };

  encoder.copyTextureToTexture(
    { texture: source, origin: srcOrigin },
    { texture: destination, origin: dstOrigin },
    size,
  );
}

/**
 * Convenience wrapper: copy a rectangular region between two textures.
 *
 * @param encoder - Active GPUCommandEncoder
 * @param source - Source texture
 * @param destination - Destination texture
 * @param srcX - Source X
 * @param srcY - Source Y
 * @param dstX - Destination X
 * @param dstY - Destination Y
 * @param width - Copy width
 * @param height - Copy height
 */
export function copyTextureRegion(
  encoder: GPUCommandEncoder,
  source: GPUTexture,
  destination: GPUTexture,
  srcX: number,
  srcY: number,
  dstX: number,
  dstY: number,
  width: number,
  height: number,
): void {
  copyTexture(
    encoder,
    source,
    destination,
    { x: srcX, y: srcY, z: 0 },
    { x: dstX, y: dstY, z: 0 },
    { width, height, depthOrArrayLayers: 1 },
  );
}

// ============================================================================
// Texture Creation from Image
// ============================================================================

/**
 * Create a WebGPUTexture from an image source and upload its pixels.
 *
 * @param device - The GPU device
 * @param source - Image source (ImageBitmap, HTMLImageElement, HTMLCanvasElement)
 * @param format - Texture format (default: 'rgba8unorm')
 * @param generateMipmaps - Whether to allocate mip levels (default: false)
 * @returns The created texture, or null if device is unavailable
 */
export function createTextureFromImage(
  device: GPUDevice,
  source: ImageBitmap | HTMLImageElement | HTMLCanvasElement,
  format: GPUTextureFormat = "rgba8unorm",
  generateMipmaps: boolean = false,
): WebGPUTexture {
  const width =
    "width" in source ? source.width : (source as HTMLCanvasElement).width;
  const height =
    "height" in source ? source.height : (source as HTMLCanvasElement).height;
  const mipLevelCount = generateMipmaps
    ? Math.floor(Math.log2(Math.max(width, height))) + 1
    : 1;

  const texture = WebGPUTexture.create2D(
    device,
    width,
    height,
    format,
    mipLevelCount,
    "Texture from Image",
  );

  device.queue.copyExternalImageToTexture(
    { source: source as ImageBitmap },
    { texture: texture.texture },
    { width, height },
  );

  return texture;
}

// ============================================================================
// Pixel Readback
// ============================================================================

/**
 * Create a PBO (Pixel Buffer Object) for async pixel readback.
 * Copies from the given source texture into a MAP_READ buffer.
 *
 * The render pass must be ended before calling this (the function does NOT
 * end the pass — the caller is responsible).
 *
 * @param device - The GPU device
 * @param encoder - Active GPUCommandEncoder
 * @param sourceTexture - The texture to read from
 * @param x - Region X origin
 * @param y - Region Y origin
 * @param width - Region width
 * @param height - Region height
 * @returns PBO handle with mapAsync() for deferred readback
 */
export function createPixelReadbackPBO(
  device: GPUDevice,
  encoder: GPUCommandEncoder,
  sourceTexture: GPUTexture,
  x: number,
  y: number,
  width: number,
  height: number,
): {
  buffer: GPUBuffer;
  width: number;
  height: number;
  bytesPerRow: number;
  mapAsync: () => Promise<Uint8Array>;
  destroy: () => void;
} {
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const bufferSize = bytesPerRow * height;

  const readbackBuffer = device.createBuffer({
    size: bufferSize,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    label: "Pixel Readback Buffer",
  });

  encoder.copyTextureToBuffer(
    { texture: sourceTexture, origin: { x, y, z: 0 } },
    { buffer: readbackBuffer, bytesPerRow },
    { width, height, depthOrArrayLayers: 1 },
  );

  return {
    buffer: readbackBuffer,
    width,
    height,
    bytesPerRow,
    mapAsync: async () => {
      // H-P5 — `mapAsync` can reject when the device is lost or the
      // buffer was destroyed while the submit was still in flight.
      // Catch the rejection so the async caller sees a clean `null`
      // instead of an unhandled promise rejection, and always release
      // the buffer so we don't leak GPU memory on the failure path.
      try {
        await readbackBuffer.mapAsync(GPUMapMode.READ);
        const arrayBuffer = readbackBuffer.getMappedRange();
        const data = new Uint8Array(arrayBuffer.slice(0));
        readbackBuffer.unmap();
        readbackBuffer.destroy();
        return data;
      } catch (e) {
        try {
          readbackBuffer.destroy();
        } catch {
          // Already destroyed or device lost — swallow.
        }
        return null;
      }
    },
    destroy: () => {
      readbackBuffer.destroy();
    },
  };
}

export default {
  createDefaultTextures,
  copyTexture,
  copyTextureRegion,
  createTextureFromImage,
  createPixelReadbackPBO,
};
