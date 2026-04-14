/**
 * WebGPU sampler wrapper that maps CesiumJS Sampler concepts to GPUSampler.
 *
 * CesiumJS Sampler.js uses WebGL enums (TextureWrap, TextureMinificationFilter, etc.).
 * This class converts those to WebGPU GPUSamplerDescriptor and caches the result
 * on the context's sampler cache.
 *
 * @private
 */

// CesiumJS WebGL texture enums
// TextureWrap: CLAMP_TO_EDGE=0x812F, REPEAT=0x2901, MIRRORED_REPEAT=0x8370
// TextureMinificationFilter: NEAREST=0x2600, LINEAR=0x2601,
//   NEAREST_MIPMAP_NEAREST=0x2700, LINEAR_MIPMAP_NEAREST=0x2701,
//   NEAREST_MIPMAP_LINEAR=0x2702, LINEAR_MIPMAP_LINEAR=0x2703
// TextureMagnificationFilter: NEAREST=0x2600, LINEAR=0x2601

const GL_CLAMP_TO_EDGE = 0x812f;
const GL_REPEAT = 0x2901;
const GL_MIRRORED_REPEAT = 0x8370;

const GL_NEAREST = 0x2600;
const GL_LINEAR = 0x2601;
const GL_NEAREST_MIPMAP_NEAREST = 0x2700;
const GL_LINEAR_MIPMAP_NEAREST = 0x2701;
const GL_NEAREST_MIPMAP_LINEAR = 0x2702;
const GL_LINEAR_MIPMAP_LINEAR = 0x2703;

/**
 * Converts a CesiumJS TextureWrap enum to a WebGPU address mode.
 */
function toAddressMode(wrap: number): GPUAddressMode {
  switch (wrap) {
    case GL_REPEAT:
      return "repeat";
    case GL_MIRRORED_REPEAT:
      return "mirror-repeat";
    case GL_CLAMP_TO_EDGE:
    default:
      return "clamp-to-edge";
  }
}

/**
 * Converts a CesiumJS TextureMinificationFilter to WebGPU min filter + mipmap filter.
 */
function toMinFilter(filter: number): {
  minFilter: GPUFilterMode;
  mipmapFilter: GPUMipmapFilterMode;
} {
  switch (filter) {
    case GL_NEAREST:
      return { minFilter: "nearest", mipmapFilter: "nearest" };
    case GL_LINEAR:
      return { minFilter: "linear", mipmapFilter: "nearest" };
    case GL_NEAREST_MIPMAP_NEAREST:
      return { minFilter: "nearest", mipmapFilter: "nearest" };
    case GL_LINEAR_MIPMAP_NEAREST:
      return { minFilter: "linear", mipmapFilter: "nearest" };
    case GL_NEAREST_MIPMAP_LINEAR:
      return { minFilter: "nearest", mipmapFilter: "linear" };
    case GL_LINEAR_MIPMAP_LINEAR:
      return { minFilter: "linear", mipmapFilter: "linear" };
    default:
      return { minFilter: "linear", mipmapFilter: "linear" };
  }
}

/**
 * Converts a CesiumJS TextureMagnificationFilter to WebGPU mag filter.
 */
function toMagFilter(filter: number): GPUFilterMode {
  switch (filter) {
    case GL_NEAREST:
      return "nearest";
    case GL_LINEAR:
    default:
      return "linear";
  }
}

/**
 * Whether a minification filter uses mipmaps.
 */
function usesMipmaps(minFilter: number): boolean {
  return (
    minFilter === GL_NEAREST_MIPMAP_NEAREST ||
    minFilter === GL_LINEAR_MIPMAP_NEAREST ||
    minFilter === GL_NEAREST_MIPMAP_LINEAR ||
    minFilter === GL_LINEAR_MIPMAP_LINEAR
  );
}

export interface WebGPUSamplerOptions {
  /** CesiumJS TextureWrap enum for U/S direction */
  wrapS?: number;
  /** CesiumJS TextureWrap enum for V/T direction */
  wrapT?: number;
  /** CesiumJS TextureWrap enum for W/R direction (3D textures) */
  wrapR?: number;
  /** CesiumJS TextureMinificationFilter enum */
  minificationFilter?: number;
  /** CesiumJS TextureMagnificationFilter enum */
  magnificationFilter?: number;
  /** Maximum anisotropy (1.0 = no anisotropy) */
  maximumAnisotropy?: number;
  /** Optional compare function for depth/shadow samplers */
  compareFunction?: GPUCompareFunction;
  /** Optional label for debugging */
  label?: string;
}

class WebGPUSampler {
  private _descriptor: GPUSamplerDescriptor;
  private _gpuSampler: GPUSampler | null = null;
  private _cacheKey: string;
  private _usesMipmaps: boolean;

  constructor(options: WebGPUSamplerOptions = {}) {
    const wrapS = options.wrapS ?? GL_CLAMP_TO_EDGE;
    const wrapT = options.wrapT ?? GL_CLAMP_TO_EDGE;
    const wrapR = options.wrapR ?? GL_CLAMP_TO_EDGE;
    const minFilter = options.minificationFilter ?? GL_LINEAR;
    const magFilter = options.magnificationFilter ?? GL_LINEAR;
    const maxAnisotropy = options.maximumAnisotropy ?? 1.0;

    const { minFilter: gpuMin, mipmapFilter } = toMinFilter(minFilter);
    const gpuMag = toMagFilter(magFilter);

    this._usesMipmaps = usesMipmaps(minFilter);

    const descriptor: GPUSamplerDescriptor = {
      addressModeU: toAddressMode(wrapS),
      addressModeV: toAddressMode(wrapT),
      addressModeW: toAddressMode(wrapR),
      minFilter: gpuMin,
      magFilter: gpuMag,
      mipmapFilter: mipmapFilter,
      maxAnisotropy: Math.max(1, Math.floor(maxAnisotropy)),
    };

    if (options.compareFunction) {
      descriptor.compare = options.compareFunction;
    }

    if (options.label) {
      descriptor.label = options.label;
    }

    this._descriptor = descriptor;
    this._cacheKey = WebGPUSampler.computeCacheKey(descriptor);
  }

  /**
   * The WebGPU sampler descriptor.
   */
  get descriptor(): GPUSamplerDescriptor {
    return this._descriptor;
  }

  /**
   * The cache key for deduplication in the context's sampler cache.
   */
  get cacheKey(): string {
    return this._cacheKey;
  }

  /**
   * Whether this sampler configuration uses mipmaps.
   */
  get usesMipmaps(): boolean {
    return this._usesMipmaps;
  }

  /**
   * Gets the GPUSampler, creating it on the device if needed.
   * Uses the context's sampler cache for deduplication.
   */
  getOrCreate(device: GPUDevice): GPUSampler {
    if (this._gpuSampler) {
      return this._gpuSampler;
    }
    this._gpuSampler = device.createSampler(this._descriptor);
    return this._gpuSampler;
  }

  /**
   * Gets the GPUSampler from the context's sampler cache.
   * This is the preferred way to get a sampler — avoids duplicates.
   */
  getOrCreateCached(context: CesiumGraphicsContext): GPUSampler | null {
    if (typeof context.getOrCreateSampler === "function") {
      const sampler = context.getOrCreateSampler(this._descriptor);
      this._gpuSampler = sampler;
      return sampler;
    }
    // Fallback: create directly on device
    const device = context.device || context._device;
    if (device) {
      return this.getOrCreate(device);
    }
    return null;
  }

  /**
   * Creates a WebGPUSampler from a CesiumJS Sampler.js instance.
   */
  static fromCesiumSampler(cesiumSampler: {
    wrapS?: number;
    wrapT?: number;
    wrapR?: number;
    minificationFilter?: number;
    magnificationFilter?: number;
    maximumAnisotropy?: number;
  }): WebGPUSampler {
    return new WebGPUSampler({
      wrapS: cesiumSampler.wrapS,
      wrapT: cesiumSampler.wrapT,
      wrapR: cesiumSampler.wrapR,
      minificationFilter: cesiumSampler.minificationFilter,
      magnificationFilter: cesiumSampler.magnificationFilter,
      maximumAnisotropy: cesiumSampler.maximumAnisotropy,
    });
  }

  /**
   * Creates a depth comparison sampler for shadow mapping.
   */
  static createDepthComparisonSampler(
    compareFunction: GPUCompareFunction = "less",
  ): WebGPUSampler {
    return new WebGPUSampler({
      minificationFilter: GL_LINEAR,
      magnificationFilter: GL_LINEAR,
      compareFunction: compareFunction,
      label: "DepthComparisonSampler",
    });
  }

  /**
   * Creates a nearest-neighbor sampler (no filtering).
   */
  static createNearest(): WebGPUSampler {
    return new WebGPUSampler({
      minificationFilter: GL_NEAREST,
      magnificationFilter: GL_NEAREST,
      label: "NearestSampler",
    });
  }

  /**
   * Creates a linear filtering sampler with mipmaps.
   */
  static createLinearMipmap(): WebGPUSampler {
    return new WebGPUSampler({
      minificationFilter: GL_LINEAR_MIPMAP_LINEAR,
      magnificationFilter: GL_LINEAR,
      label: "LinearMipmapSampler",
    });
  }

  /**
   * Creates a repeat-wrap sampler with linear filtering.
   */
  static createRepeatLinear(): WebGPUSampler {
    return new WebGPUSampler({
      wrapS: GL_REPEAT,
      wrapT: GL_REPEAT,
      minificationFilter: GL_LINEAR_MIPMAP_LINEAR,
      magnificationFilter: GL_LINEAR,
      label: "RepeatLinearSampler",
    });
  }

  /**
   * Computes a cache key from a GPUSamplerDescriptor.
   */
  static computeCacheKey(descriptor: GPUSamplerDescriptor): string {
    return `${descriptor.addressModeU ?? "clamp-to-edge"}:${descriptor.addressModeV ?? "clamp-to-edge"}:${descriptor.addressModeW ?? "clamp-to-edge"}:${descriptor.minFilter ?? "nearest"}:${descriptor.magFilter ?? "nearest"}:${descriptor.mipmapFilter ?? "nearest"}:${descriptor.maxAnisotropy ?? 1}:${descriptor.compare ?? "none"}`;
  }

  /**
   * Checks if two WebGPUSamplers are equivalent.
   */
  static equals(
    left: WebGPUSampler | undefined,
    right: WebGPUSampler | undefined,
  ): boolean {
    if (left === right) return true;
    if (!left || !right) return false;
    return left._cacheKey === right._cacheKey;
  }
}

export default WebGPUSampler;
