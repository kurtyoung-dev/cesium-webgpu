/**
 * @module WebGLStubShader
 *
 * **Proton-style WebGL→WebGPU shader / parameter / extension translation.**
 *
 * The classic WebGL compile/link workflow has no equivalent in WebGPU
 * (which uses prebuilt `GPUShaderModule`s + `GPURenderPipeline`s), so the
 * shader-program family of methods stay as opaque placeholders.
 * Everything else in this module — `getParameter`, `getExtension`,
 * `readPixels` — does as much real translation as the WebGPU surface
 * allows so that legacy feature-detection paths see plausible answers
 * instead of zeros.
 *
 * Notes on the things this module CANNOT translate fully:
 *
 * - **GLSL → WGSL** would require a runtime transpiler (Naga / Tint).
 *   We deliberately don't ship one; new code should provide WGSL via
 *   `RenderCommand` instead.
 * - **Synchronous `readPixels`** — WebGPU only exposes async readback
 *   via `mapAsync`. Code paths that need it should migrate to the
 *   `WebGPUPickFramebuffer` async API.
 *
 * @see WebGLCompatibilityStub
 */

/// <reference types="@webgpu/types" />

import type { WebGLStubState, LogUsageFn } from "./WebGLStubTypes.js";

// WebGL type constant for FLOAT (returned by get*Active*)
const GL_FLOAT = 0x1406;

// ============================================================================
// WebGL parameter constants — values getParameter() can be asked about.
// We answer the ones with a meaningful WebGPU equivalent and fall through
// to 0 for the rest. Listing them as named constants makes the switch
// readable and easy to extend.
// ============================================================================
const GL_VENDOR = 0x1f00;
const GL_RENDERER = 0x1f01;
const GL_VERSION = 0x1f02;
const GL_SHADING_LANGUAGE_VERSION = 0x8b8c;

const GL_MAX_TEXTURE_SIZE = 0x0d33;
const GL_MAX_CUBE_MAP_TEXTURE_SIZE = 0x851c;
const GL_MAX_3D_TEXTURE_SIZE = 0x8073;
const GL_MAX_RENDERBUFFER_SIZE = 0x84e8;
const GL_MAX_VIEWPORT_DIMS = 0x0d3a;
const GL_MAX_TEXTURE_IMAGE_UNITS = 0x8872;
const GL_MAX_VERTEX_TEXTURE_IMAGE_UNITS = 0x8b4c;
const GL_MAX_COMBINED_TEXTURE_IMAGE_UNITS = 0x8b4d;
const GL_MAX_VERTEX_ATTRIBS = 0x8869;
const GL_MAX_VARYING_VECTORS = 0x8dfc;
const GL_MAX_VERTEX_UNIFORM_VECTORS = 0x8dfb;
const GL_MAX_FRAGMENT_UNIFORM_VECTORS = 0x8dfd;
const GL_MAX_COLOR_ATTACHMENTS = 0x8cdf;
const GL_MAX_DRAW_BUFFERS = 0x8824;
const GL_MAX_SAMPLES = 0x8d57;
const GL_MAX_ELEMENT_INDEX = 0x8d6b;
const GL_MAX_ARRAY_TEXTURE_LAYERS = 0x88ff;
const GL_ALIASED_LINE_WIDTH_RANGE = 0x846e;
const GL_ALIASED_POINT_SIZE_RANGE = 0x846d;
const GL_SUBPIXEL_BITS = 0x0d50;
const GL_DEPTH_BITS = 0x0d56;
const GL_STENCIL_BITS = 0x0d57;
const GL_RED_BITS = 0x0d52;
const GL_GREEN_BITS = 0x0d53;
const GL_BLUE_BITS = 0x0d54;
const GL_ALPHA_BITS = 0x0d55;
const GL_SAMPLE_BUFFERS = 0x80a8;
const GL_SAMPLES = 0x80a9;
const GL_PACK_ALIGNMENT = 0x0d05;
const GL_UNPACK_ALIGNMENT = 0x0cf5;

/**
 * Look up a WebGL parameter against the active GPUDevice's limits and
 * return a plausible answer. Defaults to 0 for unknown parameters —
 * matching how WebGL implementations behave for unsupported queries.
 */
function getDeviceParameter(state: WebGLStubState, param: number): any {
  const limits = state.device?.limits;

  switch (param) {
    case GL_VENDOR:
      return "WebGPU (Cesium WebGL Compatibility Stub)";
    case GL_RENDERER:
      return "WebGPU";
    case GL_VERSION:
      return "WebGL 2.0 (WebGPU compat)";
    case GL_SHADING_LANGUAGE_VERSION:
      return "WGSL via Cesium compat layer";

    // Texture limits
    case GL_MAX_TEXTURE_SIZE:
    case GL_MAX_CUBE_MAP_TEXTURE_SIZE:
      return limits?.maxTextureDimension2D ?? 8192;
    case GL_MAX_3D_TEXTURE_SIZE:
      return limits?.maxTextureDimension3D ?? 2048;
    case GL_MAX_RENDERBUFFER_SIZE:
      return limits?.maxTextureDimension2D ?? 8192;
    case GL_MAX_ARRAY_TEXTURE_LAYERS:
      return limits?.maxTextureArrayLayers ?? 256;
    case GL_MAX_VIEWPORT_DIMS:
      return new Int32Array([
        limits?.maxTextureDimension2D ?? 8192,
        limits?.maxTextureDimension2D ?? 8192,
      ]);

    // Texture binding slot counts
    case GL_MAX_TEXTURE_IMAGE_UNITS:
    case GL_MAX_VERTEX_TEXTURE_IMAGE_UNITS:
      return limits?.maxSampledTexturesPerShaderStage ?? 16;
    case GL_MAX_COMBINED_TEXTURE_IMAGE_UNITS:
      // WebGL "combined" = vertex + fragment slots. Approximate by 2x.
      return (limits?.maxSampledTexturesPerShaderStage ?? 16) * 2;

    // Vertex attribute / varying / uniform slot counts
    case GL_MAX_VERTEX_ATTRIBS:
      return limits?.maxVertexAttributes ?? 16;
    case GL_MAX_VARYING_VECTORS: // @webgpu/types ≥0.1.79 renamed maxInterStageShaderComponents →
    // maxInterStageShaderVariables (one entry per vec4 slot rather
    // than per scalar component). The package.json floor pins us to
    // 0.1.83, so the new name is always present, but we keep the
    // fallback so the code still compiles cleanly if a downstream
    // consumer pins an older @webgpu/types version. Vars and
    // components produce equivalent vec4 counts after the division
    // below, so the math stays correct under either name.
    {
      const l = limits as unknown as {
        maxInterStageShaderVariables?: number;
        maxInterStageShaderComponents?: number;
      };
      const slots =
        l?.maxInterStageShaderVariables ??
        l?.maxInterStageShaderComponents ??
        60;
      return Math.floor(slots / 4);
    }
    case GL_MAX_VERTEX_UNIFORM_VECTORS:
    case GL_MAX_FRAGMENT_UNIFORM_VECTORS:
      // Each "vector" in WebGL = 16 bytes. Convert WebGPU's
      // maxUniformBufferBindingSize (in bytes) to vec4 count.
      return Math.floor((limits?.maxUniformBufferBindingSize ?? 65536) / 16);

    // Render-target limits
    case GL_MAX_COLOR_ATTACHMENTS:
    case GL_MAX_DRAW_BUFFERS:
      return limits?.maxColorAttachments ?? 8;
    case GL_MAX_SAMPLES:
      return 4; // WebGPU spec mandates 4x MSAA support
    case GL_MAX_ELEMENT_INDEX:
      return 0xffffffff; // u32 max — all WebGPU devices support uint32 indices

    // Pixel pipeline configuration
    case GL_SUBPIXEL_BITS:
      return 4;
    case GL_DEPTH_BITS:
      return 24;
    case GL_STENCIL_BITS:
      return 8;
    case GL_RED_BITS:
    case GL_GREEN_BITS:
    case GL_BLUE_BITS:
    case GL_ALPHA_BITS:
      return 8;
    case GL_SAMPLE_BUFFERS:
      return 1;
    case GL_SAMPLES:
      return 1;
    case GL_PACK_ALIGNMENT:
    case GL_UNPACK_ALIGNMENT:
      return state.pixelStore?.unpackAlignment ?? 4;

    // Misc range queries — supply WebGPU's spec minimums
    case GL_ALIASED_LINE_WIDTH_RANGE:
      return new Float32Array([1, 1]);
    case GL_ALIASED_POINT_SIZE_RANGE:
      return new Float32Array([1, 1024]);

    default:
      return 0;
  }
}

// ============================================================================
// Extension stubs — return non-null objects for extensions whose features
// are part of WebGPU core (so feature-detection passes) and null for the
// rest (so callers fall back to safe paths).
// ============================================================================
//
// Each entry's shape mirrors the WebGL extension object the caller would
// otherwise inspect. Most are tag objects with no methods; a few define
// the constants their original API exposed (e.g.
// EXT_texture_filter_anisotropic).
const EXTENSION_STUBS: Record<string, () => any> = {
  // Always-on in WebGPU core:
  OES_texture_float: () => ({}),
  OES_texture_half_float: () => ({}),
  OES_texture_float_linear: () => ({}),
  OES_texture_half_float_linear: () => ({}),
  OES_element_index_uint: () => ({}),
  OES_standard_derivatives: () => ({}),
  EXT_frag_depth: () => ({}),
  EXT_shader_texture_lod: () => ({}),
  WEBGL_depth_texture: () => ({}),
  EXT_color_buffer_float: () => ({}),
  EXT_color_buffer_half_float: () => ({}),
  EXT_float_blend: () => ({}),
  ANGLE_instanced_arrays: () => ({
    drawArraysInstancedANGLE: () => {},
    drawElementsInstancedANGLE: () => {},
    vertexAttribDivisorANGLE: () => {},
  }),
  EXT_texture_filter_anisotropic: () => ({
    TEXTURE_MAX_ANISOTROPY_EXT: 0x84fe,
    MAX_TEXTURE_MAX_ANISOTROPY_EXT: 0x84ff,
  }),
  WEBGL_lose_context: () => ({
    loseContext: () => {},
    restoreContext: () => {},
  }),
  // Compressed-texture extensions are gated on the corresponding WebGPU
  // feature flags. We always return a stub object — the actual format
  // availability is enforced when the texture is created.
  WEBGL_compressed_texture_s3tc: () => ({
    COMPRESSED_RGB_S3TC_DXT1_EXT: 0x83f0,
    COMPRESSED_RGBA_S3TC_DXT1_EXT: 0x83f1,
    COMPRESSED_RGBA_S3TC_DXT3_EXT: 0x83f2,
    COMPRESSED_RGBA_S3TC_DXT5_EXT: 0x83f3,
  }),
  WEBGL_compressed_texture_etc: () => ({}),
  WEBGL_compressed_texture_astc: () => ({}),
  WEBGL_compressed_texture_pvrtc: () => ({}),
};

/**
 * Creates shader, parameter query, and miscellaneous stub methods.
 *
 * @param state - Shared mutable state from WebGPUContext (for getParameter)
 * @param _logUsage - Debug logging function (unused — shader ops are silent)
 * @returns Object containing all shader/misc stub methods
 */
export function createShaderStubs(
  state: WebGLStubState,
  _logUsage: LogUsageFn,
): Record<string, any> {
  return {
    // ==== Shader methods (placeholders — WebGPU uses shader modules) ====

    // Each stub shader carries its captured GLSL source + a pending
    // transpile promise. The promise is created on `compileShader` and
    // resolved (asynchronously) by `WebGPUNagaTranspiler.transpileGLSL`.
    // Consumers that need the WGSL await `shader._wgslReady` before
    // creating a `GPUShaderModule`.
    createShader: (type: number) => ({
      _type: type,
      _isWebGPU: true,
      _glslSource: null as string | null,
      _wgsl: null as string | null,
      _wgslReady: null as Promise<string | null> | null,
      _wgslError: null as string | null,
    }),
    deleteShader: () => {},
    shaderSource: (shader: any, source: string) => {
      if (shader) shader._glslSource = source ?? null;
    },
    // Spike: kick off lazy GLSL→WGSL transpilation via naga-wasm. The
    // call is fire-and-forget — `compileShader` returns immediately to
    // match the WebGL contract. Consumers that need the WGSL must
    // `await shader._wgslReady` before passing it to a real WebGPU
    // shader module. When `naga-wasm` isn't installed the promise
    // resolves to `null` and the legacy placeholder path runs.
    compileShader: (shader: any) => {
      if (!shader || typeof shader._glslSource !== "string") return;
      // Late-bind the import so the stub module stays leaf-loaded — we
      // don't want WebGLStubShader to pull the transpiler chunk into
      // every WebGL build, only when compileShader actually fires.
      shader._wgslReady = (async () => {
        try {
          const mod = await import("../WebGPUNagaTranspiler.js");
          // Stage detection: GL_VERTEX_SHADER = 0x8B31, GL_FRAGMENT_SHADER = 0x8B30
          const stage =
            shader._type === 0x8b31
              ? "vertex"
              : shader._type === 0x8b30
                ? "fragment"
                : "compute";
          const result = await mod.transpileGLSL(shader._glslSource, stage);
          shader._wgsl = result.wgsl;
          shader._wgslError = result.error ?? null;
          return result.wgsl;
        } catch (e) {
          shader._wgslError = (e as Error).message;
          return null;
        }
      })();
    },
    getShaderParameter: () => true,
    getShaderInfoLog: (shader: any) => shader?._wgslError ?? "",
    createProgram: () => ({ _isWebGPU: true }),
    deleteProgram: () => {},
    attachShader: () => {},
    bindAttribLocation: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => "",
    useProgram: () => {},

    getActiveUniform: (
      _program: any,
      index: number,
    ): { name: string; size: number; type: number } => ({
      name: `uniform_${index}`,
      size: 1,
      type: GL_FLOAT,
    }),

    getActiveAttrib: (
      _program: any,
      index: number,
    ): { name: string; size: number; type: number } => ({
      name: `attrib_${index}`,
      size: 1,
      type: GL_FLOAT,
    }),

    getUniformLocation: (
      _program: any,
      name: string,
    ): { _name: string; _isWebGPU: boolean } => ({
      _name: name,
      _isWebGPU: true,
    }),

    getAttribLocation: (_program: any, name: string): number => {
      const locationMap: Record<string, number> = {
        position: 0,
        normal: 1,
        texCoord: 2,
        color: 3,
        tangent: 4,
        bitangent: 5,
      };
      return locationMap[name] ?? -1;
    },

    // ==== Parameter queries — answer from device.limits when possible ====

    getParameter: (param: number): any => getDeviceParameter(state, param),

    getExtension: (name: string): any | null => {
      const factory = EXTENSION_STUBS[name];
      return factory ? factory() : null;
    },

    getSupportedExtensions: (): string[] => Object.keys(EXTENSION_STUBS),

    // ==== Framebuffer blitting & read pixels ====

    // Real `gl.blitFramebuffer()` would translate into a WebGPU
    // copyTextureToTexture between the bound source and destination
    // framebuffers. We don't currently track which framebuffer is bound
    // to READ vs DRAW separately — Cesium uses MSAA resolves via render
    // passes, not blitFramebuffer — so this remains a no-op.
    blitFramebuffer: () => {},

    // Synchronous readPixels has no WebGPU equivalent. Code that needs
    // pixel readback should use the WebGPUPickFramebuffer async API.
    // Returning null preserves the existing fallback behavior.
    readPixels: (): null => null,
  };
}
