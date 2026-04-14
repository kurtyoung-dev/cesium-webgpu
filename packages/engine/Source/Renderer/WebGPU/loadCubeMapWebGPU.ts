/**
 * Asynchronously loads six images and creates a WebGPU cube map texture.
 *
 * Returns a promise that resolves to a WebGPUTexture (cubemap) once all
 * six face images are loaded and uploaded.
 *
 * @private
 */

import defined from "../../Core/defined.js";
import DeveloperError from "../../Core/DeveloperError.js";
import Resource from "../../Core/Resource.js";
import { WebGPUTexture } from "./WebGPUTexture.js";
import { WebGPUMipmapGenerator } from "./WebGPUMipmapGenerator.js";

/**
 * Face order for cube maps:
 * Index 0 = +X (right), 1 = -X (left), 2 = +Y (top),
 * 3 = -Y (bottom), 4 = +Z (front), 5 = -Z (back)
 */
const FACE_NAMES = [
  "positiveX",
  "negativeX",
  "positiveY",
  "negativeY",
  "positiveZ",
  "negativeZ",
] as const;

export interface CubeMapUrls {
  positiveX: string | Resource;
  negativeX: string | Resource;
  positiveY: string | Resource;
  negativeY: string | Resource;
  positiveZ: string | Resource;
  negativeZ: string | Resource;
}

export interface LoadCubeMapOptions {
  /** Skip color space conversion (equivalent to UNPACK_COLORSPACE_CONVERSION_WEBGL = NONE) */
  skipColorSpaceConversion?: boolean;
  /** Whether to generate mipmaps after loading all faces */
  generateMipmaps?: boolean;
  /** Flip Y axis on load (default: false — cubemaps typically don't flip) */
  flipY?: boolean;
}

/**
 * Loads an image from a URL and returns RGBA pixel data via OffscreenCanvas/Canvas.
 * Used as fallback when direct GPU upload is not possible (e.g., cross-layout extraction).
 */
async function loadImageAsRGBA(
  url: string | Resource,
  skipColorSpaceConversion: boolean,
  flipY: boolean,
): Promise<{ data: Uint8Array; width: number; height: number }> {
  const bitmap = await loadImageBitmap(url, skipColorSpaceConversion, flipY);
  const width = bitmap.width;
  const height = bitmap.height;

  // Draw to offscreen canvas to extract RGBA data
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const imageData = ctx.getImageData(0, 0, width, height);
  return {
    data: new Uint8Array(imageData.data.buffer),
    width,
    height,
  };
}

/**
 * Loads an image as an ImageBitmap for direct GPU upload via copyExternalImageToTexture.
 * This avoids the OffscreenCanvas → getImageData() intermediate step.
 */
async function loadImageBitmap(
  url: string | Resource,
  skipColorSpaceConversion: boolean,
  flipY: boolean,
): Promise<ImageBitmap> {
  const urlString = typeof url === "string" ? url : url.url;
  const response = await fetch(urlString);
  const blob = await response.blob();

  const options: ImageBitmapOptions = {};
  if (skipColorSpaceConversion) {
    options.colorSpaceConversion = "none";
  }
  if (flipY) {
    options.imageOrientation = "flipY";
  }

  return createImageBitmap(blob, options);
}

/**
 * Loads six face images and creates a WebGPU cubemap texture.
 *
 * @param {GPUDevice} device - The WebGPU device
 * @param {CubeMapUrls} urls - Object with positiveX/negativeX/.../negativeZ URLs
 * @param {LoadCubeMapOptions} [options] - Loading options
 * @returns {Promise<WebGPUTexture>} The loaded cubemap texture
 *
 * @example
 * const cubemap = await loadCubeMapWebGPU(device, {
 *   positiveX: 'skybox_px.png',
 *   negativeX: 'skybox_nx.png',
 *   positiveY: 'skybox_py.png',
 *   negativeY: 'skybox_ny.png',
 *   positiveZ: 'skybox_pz.png',
 *   negativeZ: 'skybox_nz.png',
 * });
 */
async function loadCubeMapWebGPU(
  device: GPUDevice,
  urls: CubeMapUrls,
  options?: LoadCubeMapOptions,
): Promise<WebGPUTexture> {
  //>>includeStart('debug', pragmas.debug);
  if (!defined(device)) {
    throw new DeveloperError("device is required.");
  }
  if (!defined(urls)) {
    throw new DeveloperError("urls is required.");
  }
  for (const face of FACE_NAMES) {
    if (!defined(urls[face])) {
      throw new DeveloperError(`urls.${face} is required.`);
    }
  }
  //>>includeEnd('debug');

  const skipColorSpaceConversion = options?.skipColorSpaceConversion ?? false;
  const generateMipmaps = options?.generateMipmaps ?? false;
  const flipY = options?.flipY ?? false;

  // Load all 6 faces in parallel
  const facePromises = FACE_NAMES.map((face) =>
    loadImageAsRGBA(urls[face], skipColorSpaceConversion, flipY),
  );

  const faceResults = await Promise.all(facePromises);

  // Validate all faces are the same size
  const size = faceResults[0].width;
  for (let i = 0; i < 6; i++) {
    if (faceResults[i].width !== size || faceResults[i].height !== size) {
      throw new DeveloperError(
        `Cubemap face ${FACE_NAMES[i]} has dimensions ` +
          `${faceResults[i].width}x${faceResults[i].height}, ` +
          `expected ${size}x${size}.`,
      );
    }
  }

  // Calculate mip levels
  const mipLevelCount = generateMipmaps ? Math.floor(Math.log2(size)) + 1 : 1;

  // Create cubemap texture
  const cubemap = WebGPUTexture.createCubeMap(
    device,
    size,
    "rgba8unorm",
    mipLevelCount,
    "LoadedCubeMap",
  );

  // Upload each face
  for (let faceIndex = 0; faceIndex < 6; faceIndex++) {
    cubemap.write(faceResults[faceIndex].data, size, size, faceIndex, 0);
  }

  // Generate mipmaps if requested
  if (generateMipmaps && mipLevelCount > 1) {
    const generator = new WebGPUMipmapGenerator(device);
    cubemap.generateMipmaps(generator);
    generator.destroy();
  }

  return cubemap;
}

/**
 * Loads a cubemap from a single cross/strip image.
 * Supports horizontal cross layout:
 * ```
 *        [+Y]
 *  [-X]  [+Z]  [+X]  [-Z]
 *        [-Y]
 * ```
 *
 * @param {GPUDevice} device - The WebGPU device
 * @param {string | Resource} url - URL of the cross layout image
 * @param {LoadCubeMapOptions} [options] - Loading options
 * @returns {Promise<WebGPUTexture>} The loaded cubemap texture
 */
async function loadCubeMapFromCross(
  device: GPUDevice,
  url: string | Resource,
  options?: LoadCubeMapOptions,
): Promise<WebGPUTexture> {
  const skipColorSpaceConversion = options?.skipColorSpaceConversion ?? false;
  const generateMipmaps = options?.generateMipmaps ?? false;

  const { data, width, height } = await loadImageAsRGBA(
    url,
    skipColorSpaceConversion,
    false,
  );

  // Horizontal cross: 4 columns, 3 rows
  const faceSize = Math.floor(width / 4);

  // Face positions in the cross layout (column, row)
  const facePositions: [number, number][] = [
    [2, 1], // +X (right)
    [0, 1], // -X (left)
    [1, 0], // +Y (top)
    [1, 2], // -Y (bottom)
    [1, 1], // +Z (front)
    [3, 1], // -Z (back)
  ];

  const mipLevelCount = generateMipmaps
    ? Math.floor(Math.log2(faceSize)) + 1
    : 1;

  const cubemap = WebGPUTexture.createCubeMap(
    device,
    faceSize,
    "rgba8unorm",
    mipLevelCount,
    "CrossCubeMap",
  );

  // Extract and upload each face
  for (let i = 0; i < 6; i++) {
    const [col, row] = facePositions[i];
    const faceData = extractFaceFromCross(data, width, faceSize, col, row);
    cubemap.write(faceData, faceSize, faceSize, i, 0);
  }

  if (generateMipmaps && mipLevelCount > 1) {
    const generator = new WebGPUMipmapGenerator(device);
    cubemap.generateMipmaps(generator);
    generator.destroy();
  }

  return cubemap;
}

/**
 * Extracts a face from a cross layout image.
 */
function extractFaceFromCross(
  data: Uint8Array,
  fullWidth: number,
  faceSize: number,
  col: number,
  row: number,
): Uint8Array {
  const faceData = new Uint8Array(faceSize * faceSize * 4);
  const srcBytesPerRow = fullWidth * 4;
  const dstBytesPerRow = faceSize * 4;
  const startX = col * faceSize;
  const startY = row * faceSize;

  for (let y = 0; y < faceSize; y++) {
    const srcOffset = (startY + y) * srcBytesPerRow + startX * 4;
    const dstOffset = y * dstBytesPerRow;
    faceData.set(
      data.subarray(srcOffset, srcOffset + dstBytesPerRow),
      dstOffset,
    );
  }

  return faceData;
}

export default loadCubeMapWebGPU;
export { loadCubeMapWebGPU, loadCubeMapFromCross };
