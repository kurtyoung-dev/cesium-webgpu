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
