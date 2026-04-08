/**
 * @module WebGLStateConverters
 *
 * Pure utility functions that convert WebGL enum constants to their
 * WebGPU equivalents. These are used by both the WebGPUContext (for
 * pipeline state tracking) and the WebGLCompatibilityStub (for state
 * proxy methods).
 *
 * Keeping these as standalone functions avoids duplication and makes
 * them easy to unit-test independently.
 *
 * @see WebGPUContext
 * @see WebGLCompatibilityStub
 */

/// <reference types="@webgpu/types" />

// ============================================================================
// WebGL Blend Factor Constants
// ============================================================================
const GL_ZERO = 0;
const GL_ONE = 1;
const GL_SRC_COLOR = 0x0300;
const GL_ONE_MINUS_SRC_COLOR = 0x0301;
const GL_SRC_ALPHA = 0x0302;
const GL_ONE_MINUS_SRC_ALPHA = 0x0303;
const GL_DST_ALPHA = 0x0304;
const GL_ONE_MINUS_DST_ALPHA = 0x0305;
const GL_DST_COLOR = 0x0306;
const GL_ONE_MINUS_DST_COLOR = 0x0307;
const GL_SRC_ALPHA_SATURATE = 0x0308;
const GL_CONSTANT_COLOR = 0x8001;
const GL_ONE_MINUS_CONSTANT_COLOR = 0x8002;
// const GL_CONSTANT_ALPHA = 0x8003;        // not mapped by WebGPU
// const GL_ONE_MINUS_CONSTANT_ALPHA = 0x8004; // not mapped by WebGPU

// ============================================================================
// WebGL Blend Operation Constants
// ============================================================================
const GL_FUNC_ADD = 0x8006;
const GL_MIN = 0x8007;
const GL_MAX = 0x8008;
const GL_FUNC_SUBTRACT = 0x800a;
const GL_FUNC_REVERSE_SUBTRACT = 0x800b;

// ============================================================================
// WebGL Compare Function Constants
// ============================================================================
const GL_NEVER = 0x0200;
const GL_LESS = 0x0201;
const GL_EQUAL = 0x0202;
const GL_LEQUAL = 0x0203;
const GL_GREATER = 0x0204;
const GL_NOTEQUAL = 0x0205;
const GL_GEQUAL = 0x0206;
const GL_ALWAYS = 0x0207;

// ============================================================================
// Conversion Functions
// ============================================================================

/**
 * Convert a WebGL blend factor constant to the equivalent WebGPU GPUBlendFactor string.
 *
 * @param webglFactor - A WebGL blend factor enum (e.g. `gl.SRC_ALPHA`)
 * @returns The corresponding GPUBlendFactor. Defaults to `"one"` for unrecognised values.
 */
export function webglToWebGPUBlendFactor(webglFactor: number): GPUBlendFactor {
  switch (webglFactor) {
    case GL_ZERO:
      return "zero";
    case GL_ONE:
      return "one";
    case GL_SRC_COLOR:
      return "src";
    case GL_ONE_MINUS_SRC_COLOR:
      return "one-minus-src";
    case GL_DST_COLOR:
      return "dst";
    case GL_ONE_MINUS_DST_COLOR:
      return "one-minus-dst";
    case GL_SRC_ALPHA:
      return "src-alpha";
    case GL_ONE_MINUS_SRC_ALPHA:
      return "one-minus-src-alpha";
    case GL_DST_ALPHA:
      return "dst-alpha";
    case GL_ONE_MINUS_DST_ALPHA:
      return "one-minus-dst-alpha";
    case GL_CONSTANT_COLOR:
      return "constant";
    case GL_ONE_MINUS_CONSTANT_COLOR:
      return "one-minus-constant";
    case GL_SRC_ALPHA_SATURATE:
      return "src-alpha-saturated";
    default:
      return "one";
  }
}

/**
 * Convert a WebGL blend equation constant to the equivalent WebGPU GPUBlendOperation string.
 *
 * @param webglOp - A WebGL blend equation enum (e.g. `gl.FUNC_ADD`)
 * @returns The corresponding GPUBlendOperation. Defaults to `"add"` for unrecognised values.
 */
export function webglToWebGPUBlendOp(webglOp: number): GPUBlendOperation {
  switch (webglOp) {
    case GL_FUNC_ADD:
      return "add";
    case GL_FUNC_SUBTRACT:
      return "subtract";
    case GL_FUNC_REVERSE_SUBTRACT:
      return "reverse-subtract";
    case GL_MIN:
      return "min";
    case GL_MAX:
      return "max";
    default:
      return "add";
  }
}

/**
 * Convert a WebGL depth/stencil comparison function constant to the equivalent
 * WebGPU GPUCompareFunction string.
 *
 * @param webglFunc - A WebGL comparison function enum (e.g. `gl.LEQUAL`)
 * @returns The corresponding GPUCompareFunction. Defaults to `"less"` for unrecognised values.
 */
export function webglToWebGPUCompareFunction(
  webglFunc: number,
): GPUCompareFunction {
  switch (webglFunc) {
    case GL_NEVER:
      return "never";
    case GL_LESS:
      return "less";
    case GL_EQUAL:
      return "equal";
    case GL_LEQUAL:
      return "less-equal";
    case GL_GREATER:
      return "greater";
    case GL_NOTEQUAL:
      return "not-equal";
    case GL_GEQUAL:
      return "greater-equal";
    case GL_ALWAYS:
      return "always";
    default:
      return "less";
  }
}

// ============================================================================
// WebGL Texture Format / Type Constants
// ============================================================================
// Internal formats (sized + base) used by texImage2D's `internalformat` arg
const GL_ALPHA = 0x1906;
const GL_RGB = 0x1907;
const GL_RGBA = 0x1908;
const GL_LUMINANCE = 0x1909;
const GL_LUMINANCE_ALPHA = 0x190a;
const GL_DEPTH_COMPONENT = 0x1902;
const GL_DEPTH_STENCIL = 0x84f9;
// Sized internal formats (WebGL2)
const GL_R8 = 0x8229;
const GL_RG8 = 0x822b;
const GL_RGB8 = 0x8051;
const GL_RGBA8 = 0x8058;
const GL_SRGB8 = 0x8c41;
const GL_SRGB8_ALPHA8 = 0x8c43;
const GL_R16F = 0x822d;
const GL_RG16F = 0x822f;
const GL_RGB16F = 0x881b;
const GL_RGBA16F = 0x881a;
const GL_R32F = 0x822e;
const GL_RG32F = 0x8230;
const GL_RGB32F = 0x8815;
const GL_RGBA32F = 0x8814;
const GL_R8UI = 0x8232;
const GL_RG8UI = 0x8238;
const GL_RGBA8UI = 0x8d7c;
const GL_R32UI = 0x8236;
const GL_RG32UI = 0x823c;
const GL_RGBA32UI = 0x8d70;
const GL_DEPTH_COMPONENT16 = 0x81a5;
const GL_DEPTH_COMPONENT24 = 0x81a6;
const GL_DEPTH_COMPONENT32F = 0x8cac;
const GL_DEPTH24_STENCIL8 = 0x88f0;

// Pixel data type (texImage2D `type` arg)
const GL_UNSIGNED_BYTE = 0x1401;
const GL_FLOAT = 0x1406;
const GL_HALF_FLOAT = 0x140b;
const GL_UNSIGNED_SHORT = 0x1403;
const GL_UNSIGNED_INT = 0x1405;

// Filter / wrap constants
const GL_NEAREST = 0x2600;
const GL_LINEAR = 0x2601;
const GL_NEAREST_MIPMAP_NEAREST = 0x2700;
const GL_LINEAR_MIPMAP_NEAREST = 0x2701;
const GL_NEAREST_MIPMAP_LINEAR = 0x2702;
const GL_LINEAR_MIPMAP_LINEAR = 0x2703;

const GL_REPEAT = 0x2901;
const GL_CLAMP_TO_EDGE = 0x812f;
const GL_MIRRORED_REPEAT = 0x8370;

/**
 * Resolve a WebGL `texImage2D(internalformat, format, type)` triple to a
 * `GPUTextureFormat`. Defaults to `"rgba8unorm"` for the unsized base
 * formats since that's by far the dominant CesiumJS upload path.
 *
 * @param internalformat WebGL internal format (sized or base)
 * @param _format WebGL pixel data format — currently unused but kept for
 *   future precision (e.g. distinguishing GL_RG vs GL_RGBA when caller
 *   passes a base internal format)
 * @param type WebGL pixel data type (UNSIGNED_BYTE, FLOAT, HALF_FLOAT, …)
 */
export function webglToWebGPUTextureFormat(
  internalformat: number,
  _format: number,
  type: number,
): GPUTextureFormat {
  // Sized formats are unambiguous — return them directly.
  switch (internalformat) {
    case GL_R8:
      return "r8unorm";
    case GL_RG8:
      return "rg8unorm";
    case GL_RGB8:
    case GL_RGBA8:
      return "rgba8unorm";
    case GL_SRGB8:
    case GL_SRGB8_ALPHA8:
      return "rgba8unorm-srgb";
    case GL_R16F:
      return "r16float";
    case GL_RG16F:
      return "rg16float";
    case GL_RGB16F:
    case GL_RGBA16F:
      return "rgba16float";
    case GL_R32F:
      return "r32float";
    case GL_RG32F:
      return "rg32float";
    case GL_RGB32F:
    case GL_RGBA32F:
      return "rgba32float";
    case GL_R8UI:
      return "r8uint";
    case GL_RG8UI:
      return "rg8uint";
    case GL_RGBA8UI:
      return "rgba8uint";
    case GL_R32UI:
      return "r32uint";
    case GL_RG32UI:
      return "rg32uint";
    case GL_RGBA32UI:
      return "rgba32uint";
    case GL_DEPTH_COMPONENT16:
      return "depth16unorm";
    case GL_DEPTH_COMPONENT24:
      return "depth24plus";
    case GL_DEPTH_COMPONENT32F:
      return "depth32float";
    case GL_DEPTH24_STENCIL8:
      return "depth24plus-stencil8";
  }
  // Base unsized formats — pick precision from the type arg.
  if (
    internalformat === GL_DEPTH_COMPONENT ||
    internalformat === GL_DEPTH_STENCIL
  ) {
    return internalformat === GL_DEPTH_STENCIL
      ? "depth24plus-stencil8"
      : "depth24plus";
  }
  if (internalformat === GL_ALPHA || internalformat === GL_LUMINANCE) {
    // No 1-channel grayscale in WebGPU base formats — promote to r8.
    return "r8unorm";
  }
  if (internalformat === GL_LUMINANCE_ALPHA) {
    return "rg8unorm";
  }
  // GL_RGB / GL_RGBA: derive from type.
  switch (type) {
    case GL_FLOAT:
      return "rgba32float";
    case GL_HALF_FLOAT:
      return "rgba16float";
    case GL_UNSIGNED_SHORT:
    case GL_UNSIGNED_INT:
      return "rgba8unorm"; // Cesium uses these for index buffers, not textures
    case GL_UNSIGNED_BYTE:
    default:
      return "rgba8unorm";
  }
}

/**
 * Number of bytes per texel for a given GPUTextureFormat — used by the
 * stub when packing CPU data into the queue.writeTexture call.
 */
export function bytesPerTexel(format: GPUTextureFormat): number {
  switch (format) {
    case "r8unorm":
    case "r8uint":
    case "r8sint":
    case "r8snorm":
      return 1;
    case "rg8unorm":
    case "rg8uint":
    case "rg8sint":
    case "rg8snorm":
    case "r16float":
    case "r16uint":
    case "r16sint":
    case "depth16unorm":
      return 2;
    case "rgba8unorm":
    case "rgba8unorm-srgb":
    case "rgba8uint":
    case "rgba8sint":
    case "rgba8snorm":
    case "bgra8unorm":
    case "bgra8unorm-srgb":
    case "rg16float":
    case "rg16uint":
    case "rg16sint":
    case "r32float":
    case "r32uint":
    case "r32sint":
    case "depth24plus":
    case "depth32float":
      return 4;
    case "rgba16float":
    case "rgba16uint":
    case "rgba16sint":
    case "rg32float":
    case "rg32uint":
    case "rg32sint":
      return 8;
    case "rgba32float":
    case "rgba32uint":
    case "rgba32sint":
      return 16;
    default:
      return 4;
  }
}

/**
 * Map a WebGL min or mag filter constant to a `GPUFilterMode`.
 * Mipmap modes collapse to their non-mipmap equivalent — the mipmap
 * filter is selected separately via `mipmapFilterFromGL`.
 */
export function webglFilterToWebGPU(glFilter: number): GPUFilterMode {
  switch (glFilter) {
    case GL_NEAREST:
    case GL_NEAREST_MIPMAP_NEAREST:
    case GL_NEAREST_MIPMAP_LINEAR:
      return "nearest";
    case GL_LINEAR:
    case GL_LINEAR_MIPMAP_NEAREST:
    case GL_LINEAR_MIPMAP_LINEAR:
    default:
      return "linear";
  }
}

/**
 * Map a WebGL min filter constant to its `GPUMipmapFilterMode`.
 * Non-mipmap filters return "nearest" (single-mip sampling).
 */
export function webglMipmapFilterToWebGPU(
  glFilter: number,
): GPUMipmapFilterMode {
  switch (glFilter) {
    case GL_NEAREST_MIPMAP_LINEAR:
    case GL_LINEAR_MIPMAP_LINEAR:
      return "linear";
    case GL_NEAREST_MIPMAP_NEAREST:
    case GL_LINEAR_MIPMAP_NEAREST:
    default:
      return "nearest";
  }
}

/**
 * Map a WebGL wrap mode (TEXTURE_WRAP_S/T/R) to a `GPUAddressMode`.
 */
export function webglWrapToWebGPU(glWrap: number): GPUAddressMode {
  switch (glWrap) {
    case GL_REPEAT:
      return "repeat";
    case GL_MIRRORED_REPEAT:
      return "mirror-repeat";
    case GL_CLAMP_TO_EDGE:
    default:
      return "clamp-to-edge";
  }
}
