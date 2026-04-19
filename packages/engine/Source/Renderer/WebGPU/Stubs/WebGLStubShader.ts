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

/** Return type for WebGL's `gl.getParameter()` — varies by parameter. */
type GLParameterValue = string | number | Int32Array | Float32Array | null;

/** Stub shader object produced by `gl.createShader()`. */
interface StubShader {
  _type: number;
  _isWebGPU: boolean;
  _glslSource: string | null;
  _wgsl: string | null;
  _wgslReady: Promise<string | null> | null;
  _wgslError: string | null;
  /** Reflection metadata from the translator, when available. */
  _reflection: import("../WebGPUShaderTranslator.js").ShaderReflection | null;
}

/**
 * Stub program object produced by `gl.createProgram()`. Holds the
 * attached shaders, the translated WGSL (once linkProgram runs and
 * both shaders have resolved), and a lazily-created GPUShaderModule
 * that downstream pipeline builders can bind. `linkProgram` is
 * idempotent — calling it multiple times is a no-op after the first
 * successful link.
 */
interface StubProgram {
  _isWebGPU: boolean;
  /** Attached shaders, by stage. Set by `attachShader`. */
  _attachedVertex: StubShader | null;
  _attachedFragment: StubShader | null;
  /**
   * Promise that resolves when linkProgram has produced the pair of
   * shader modules. Resolves to null when the translator isn't
   * available OR one of the shaders failed to compile — callers bind
   * the legacy placeholder path in that case.
   *
   * The pair is intentional: WebGPU render pipelines take a separate
   * vertex + fragment module, and concatenating two naga-generated
   * GLSL modules would collide on both having `fn main`. We keep
   * them separate so pipeline builders can bind each to the
   * corresponding pipeline stage.
   */
  _linkReady: Promise<WebGPUStubProgramModules | null> | null;
  /** Resolved modules once linkReady completes. */
  _programModules: WebGPUStubProgramModules | null;
  /** Link status: true = successful, false = failed, null = not yet linked. */
  _linkStatus: boolean | null;
  /** Human-readable link error message for `gl.getProgramInfoLog`. */
  _linkError: string | null;
}

/**
 * Vertex + fragment module pair produced by `gl.linkProgram()`. Each
 * module has its own entry point (the one naga wrote for that stage,
 * conventionally "main"). Downstream pipeline builders feed one into
 * `vertex.module` + `entryPoint` and the other into `fragment.module`
 * + `entryPoint`.
 */
export interface WebGPUStubProgramModules {
  vertex: GPUShaderModule;
  vertexEntryPoint: string;
  fragment: GPUShaderModule;
  fragmentEntryPoint: string;
  /** Reflection from each stage's translator run (may be empty). */
  vertexReflection: import("../WebGPUShaderTranslator.js").ShaderReflection;
  fragmentReflection: import("../WebGPUShaderTranslator.js").ShaderReflection;
}

/**
 * WebGL extension stub — a tag object returned from `getExtension()`. Every
 * field is either a numeric constant (e.g. TEXTURE_MAX_ANISOTROPY_EXT) or
 * a zero-arg method (e.g. loseContext). The index signature covers both
 * cases without using `any` / `unknown` / bare `object`.
 */
interface ExtensionStub {
  readonly [key: string]: number | (() => void);
}

// WebGL type constant for FLOAT (returned by get*Active*)
const GL_FLOAT = 0x1406;

/**
 * Fallback reflection for translators that don't produce one. Keeps
 * downstream pipeline builders from branching on null and lets them
 * use the entry-point name in a uniform way.
 */
function _emptyReflection(
  stage: import("../WebGPUShaderTranslator.js").ShaderStage,
): import("../WebGPUShaderTranslator.js").ShaderReflection {
  return {
    entryPoint: "main",
    stage,
    uniformBuffers: [],
    textures: [],
    samplers: [],
    attributes: [],
  };
}

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
function getDeviceParameter(
  state: WebGLStubState,
  param: number,
): GLParameterValue {
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
    case GL_MAX_VARYING_VECTORS: // consumer pins an older @webgpu/types version. Vars and // fallback so the code still compiles cleanly if a downstream // 0.1.83, so the new name is always present, but we keep the // than per scalar component). The package.json floor pins us to // maxInterStageShaderVariables (one entry per vec4 slot rather // @webgpu/types ≥0.1.79 renamed maxInterStageShaderComponents →
    // components produce equivalent vec4 counts after the division
    // below, so the math stays correct under either name.
    {
      // Version-bridged read: new @webgpu/types (≥0.1.83) always has
      // `maxInterStageShaderVariables`; older versions have only
      // `maxInterStageShaderComponents`. `Reflect.get` lets us query
      // either name without widening the surrounding types.
      const slots =
        (Reflect.get(limits, "maxInterStageShaderVariables") as
          | number
          | undefined) ??
        (Reflect.get(limits, "maxInterStageShaderComponents") as
          | number
          | undefined) ??
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
const EXTENSION_STUBS: Record<string, () => ExtensionStub> = {
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
export function createShaderStubs(state: WebGLStubState, logUsage: LogUsageFn) {
  return {
    // ==== Shader methods ═══════════════════════════════════════════════
    //
    // Compilation goes through the pluggable translator registry
    // (`getActiveShaderTranslator`). If a translator is registered —
    // typically the NagaShaderTranslator after `naga-wasm` loads —
    // GLSL compiles to real WGSL. If not, `compileShader` records a
    // clear error that `getShaderInfoLog` returns. Either way the
    // WebGL-shape contract is preserved: sync creation, async
    // completion observable via `shader._wgslReady`.
    //
    // Linking combines attached shaders into a single WGSL module,
    // creates a `GPUShaderModule`, and caches it on the program.
    // Downstream pipeline builders read `program._shaderModule`
    // (via `getCompiledShaderForProgram` below).

    createShader: (type: number): StubShader => ({
      _type: type,
      _isWebGPU: true,
      _glslSource: null,
      _wgsl: null,
      _wgslReady: null,
      _wgslError: null,
      _reflection: null,
    }),
    deleteShader: () => {},
    shaderSource: (shader: StubShader | null, source: string) => {
      if (shader) shader._glslSource = source ?? null;
    },
    compileShader: (shader: StubShader | null) => {
      if (!shader || typeof shader._glslSource !== "string") return;
      // GL_VERTEX_SHADER = 0x8B31, GL_FRAGMENT_SHADER = 0x8B30
      const stage =
        shader._type === 0x8b31
          ? "vertex"
          : shader._type === 0x8b30
            ? "fragment"
            : "compute";

      shader._wgslReady = (async () => {
        // Dynamic import to keep the translator registry out of the
        // leaf stub dependency graph — the stub works with or
        // without a translator registered.
        const tmod = await import("../WebGPUShaderTranslator.js");
        const translator = tmod.getActiveShaderTranslator();
        if (!translator || !translator.supports.includes("glsl")) {
          shader._wgslError =
            "No GLSL translator registered. Register one via " +
            "`registerShaderTranslator(new NagaShaderTranslator())` " +
            "after building `packages/wasm-naga` (see that crate's README), " +
            "or author shaders in WGSL via `RenderCommand` and bypass the " +
            "compat stub.";
          return null;
        }

        // ── Preprocessor pass (Cesium builtins, #include resolution, etc.) ──
        //
        // When a ShaderPreprocessor is registered — typically by the
        // app at boot, wiring in Cesium's `ShaderSource` — we run the
        // user's GLSL through it before handing it to the translator.
        // This is how consumers bridge the gap between Cesium-style
        // shader fragments (which reference `czm_*` builtins defined
        // elsewhere) and what the translator actually needs: complete,
        // self-contained source. Registration is opt-in; when nothing
        // is registered we pass the source straight through.
        const preprocessor = tmod.getActiveShaderPreprocessor();
        let preparedSource = shader._glslSource!;
        if (preprocessor && preprocessor.supports.includes("glsl")) {
          try {
            const result = preprocessor.preprocess(
              preparedSource,
              stage as import("../WebGPUShaderTranslator.js").ShaderStage,
              "glsl",
            );
            if (typeof result === "string" && result.length > 0) {
              preparedSource = result;
            } else {
              // A preprocessor that returns empty is considered a
              // config error — rejecting here means the user gets a
              // clear diagnostic instead of a silent empty-shader
              // failure later.
              shader._wgslError = `Shader preprocessor '${preprocessor.name}' returned empty output`;
              return null;
            }
          } catch (e) {
            shader._wgslError =
              `Shader preprocessor '${preprocessor.name}' threw: ` +
              `${(e as Error).message ?? String(e)}`;
            return null;
          }
        }

        try {
          const result = await translator.translate(
            preparedSource,
            stage as import("../WebGPUShaderTranslator.js").ShaderStage,
            "glsl",
          );
          shader._wgsl = result.wgsl;
          shader._reflection = result.reflection;
          shader._wgslError = null;
          return result.wgsl;
        } catch (e) {
          let msg = (e as Error).message ?? String(e);
          // Nudge: if the error mentions czm_* symbols, the user
          // almost certainly needs to register a Cesium preprocessor.
          // The translator error alone doesn't hint at this, so we
          // surface the remediation.
          if (/\bczm_[a-zA-Z0-9_]+/.test(msg) && !preprocessor) {
            msg +=
              "\n\nHint: the source references `czm_*` Cesium builtins but " +
              "no preprocessor is registered. Register one that combines " +
              "the source with Cesium's ShaderSource builtins via " +
              "`registerShaderPreprocessor(…)` — see the docblock on " +
              "WebGPUShaderTranslator.ts.";
          }
          shader._wgslError = msg;
          return null;
        }
      })();
    },
    getShaderParameter: () => true,
    getShaderInfoLog: (shader: StubShader | null) => shader?._wgslError ?? "",

    createProgram: (): StubProgram => ({
      _isWebGPU: true,
      _attachedVertex: null,
      _attachedFragment: null,
      _linkReady: null,
      _programModules: null,
      _linkStatus: null,
      _linkError: null,
    }),
    deleteProgram: () => {},
    attachShader: (program: StubProgram | null, shader: StubShader | null) => {
      if (!program || !shader) return;
      if (shader._type === 0x8b31) program._attachedVertex = shader;
      else if (shader._type === 0x8b30) program._attachedFragment = shader;
    },
    bindAttribLocation: () => {},
    /**
     * Combine the two attached shaders into a single WGSL module.
     * We await each shader's `_wgslReady` promise, splice the two
     * sources into one (vertex + fragment entry points live in the
     * same module), then `device.createShaderModule` if we have a
     * GPUDevice on the state. Asynchronous — consumers poll via
     * `getProgramParameter(GL_LINK_STATUS)` or await
     * `program._linkReady`.
     */
    linkProgram: (program: StubProgram | null) => {
      if (!program) return;
      if (program._linkReady) return; // idempotent
      const vs = program._attachedVertex;
      const fs = program._attachedFragment;
      if (!vs || !fs) {
        program._linkError =
          "linkProgram: vertex and fragment shader must both be attached before linking.";
        program._linkStatus = false;
        return;
      }
      program._linkReady = (async () => {
        try {
          // Kick off (or join) each shader's compile
          if (!vs._wgslReady && typeof vs._glslSource === "string") {
            // Caller forgot compileShader — let's not be strict; emit
            // a link error that matches WebGL's diagnostic style.
            program._linkError = "linkProgram: vertex shader was not compiled.";
            program._linkStatus = false;
            return null;
          }
          if (!fs._wgslReady && typeof fs._glslSource === "string") {
            program._linkError =
              "linkProgram: fragment shader was not compiled.";
            program._linkStatus = false;
            return null;
          }
          const [vsWgsl, fsWgsl] = await Promise.all([
            vs._wgslReady,
            fs._wgslReady,
          ]);
          if (!vsWgsl || !fsWgsl) {
            program._linkError =
              "linkProgram: one of the attached shaders failed to translate. " +
              `vertex: ${vs._wgslError || "ok"}; fragment: ${fs._wgslError || "ok"}`;
            program._linkStatus = false;
            return null;
          }
          if (!state.device) {
            program._linkError =
              "linkProgram: no GPUDevice available — cannot create shader module.";
            program._linkStatus = false;
            return null;
          }
          // Two separate shader modules — WebGPU render pipelines
          // expect distinct vertex + fragment modules anyway, and
          // concatenating naga-translated GLSL would produce two
          // `fn main` functions which would conflict. Entry points
          // come from the translator's reflection (naga emits the
          // original GLSL function name, typically "main").
          const vertexModule = state.device.createShaderModule({
            label: "WebGL-compat program (vertex)",
            code: vsWgsl,
          });
          const fragmentModule = state.device.createShaderModule({
            label: "WebGL-compat program (fragment)",
            code: fsWgsl,
          });
          const modules: WebGPUStubProgramModules = {
            vertex: vertexModule,
            vertexEntryPoint: vs._reflection?.entryPoint ?? "main",
            fragment: fragmentModule,
            fragmentEntryPoint: fs._reflection?.entryPoint ?? "main",
            vertexReflection: vs._reflection ?? _emptyReflection("vertex"),
            fragmentReflection: fs._reflection ?? _emptyReflection("fragment"),
          };
          program._programModules = modules;
          program._linkStatus = true;
          return modules;
        } catch (e) {
          program._linkError = (e as Error).message ?? String(e);
          program._linkStatus = false;
          return null;
        }
      })();
    },
    getProgramParameter: (program: StubProgram | null, pname: number) => {
      // GL_LINK_STATUS = 0x8B82
      if (pname === 0x8b82) {
        // WebGL semantics: returns false until link completes. We
        // return the cached status (null → treat as "not linked yet",
        // equivalent to false).
        return program?._linkStatus === true;
      }
      return true;
    },
    getProgramInfoLog: (program: StubProgram | null) =>
      program?._linkError ?? "",
    useProgram: () => {},

    getActiveUniform: (
      _program: StubProgram | null,
      index: number,
    ): { name: string; size: number; type: number } => ({
      name: `uniform_${index}`,
      size: 1,
      type: GL_FLOAT,
    }),

    getActiveAttrib: (
      _program: StubProgram | null,
      index: number,
    ): { name: string; size: number; type: number } => ({
      name: `attrib_${index}`,
      size: 1,
      type: GL_FLOAT,
    }),

    getUniformLocation: (
      _program: StubProgram | null,
      name: string,
    ): { _name: string; _isWebGPU: boolean } => ({
      _name: name,
      _isWebGPU: true,
    }),

    getAttribLocation: (_program: StubProgram | null, name: string): number => {
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

    getParameter: (param: number): GLParameterValue =>
      getDeviceParameter(state, param),

    getExtension: (name: string): ExtensionStub | null => {
      const factory = EXTENSION_STUBS[name];
      return factory ? factory() : null;
    },

    getSupportedExtensions: (): string[] => Object.keys(EXTENSION_STUBS),

    // ==== Framebuffer blitting & read pixels ====
    //
    // Real implementations now:
    //   blitFramebuffer → commandEncoder.copyTextureToTexture between
    //     the bound READ + DRAW framebuffers' color attachments. Honors
    //     the src/dst rectangles. Doesn't implement mask filtering
    //     (GL_COLOR_BUFFER_BIT / DEPTH_BUFFER_BIT / STENCIL_BUFFER_BIT)
    //     — we always copy color, skip depth/stencil because WebGPU
    //     has no universal cross-format copy for depth attachments.
    //
    //   readPixels → still returns null (sync API can't work against
    //     WebGPU's async mapAsync). Real readback goes through
    //     `readPixelsAsync` which follows WebGL's shape but returns a
    //     Promise — callers who care migrate one-by-one. The
    //     WebGPUPickFramebuffer async API remains the blessed path for
    //     picking.
    blitFramebuffer: (
      srcX0: number,
      srcY0: number,
      srcX1: number,
      srcY1: number,
      dstX0: number,
      dstY0: number,
      dstX1: number,
      dstY1: number,
      _mask: number,
      _filter: number,
    ) => {
      if (!state.device || !state.currentCommandEncoder) return;
      // copyTextureToTexture can only be recorded outside a render pass.
      // If the stub consumer called blitFramebuffer while a render pass
      // is open — unusual but legal in WebGL — skip with a one-time
      // warning rather than corrupt the command stream.
      if (state.currentRenderPassEncoder) {
        logUsage(
          "blitFramebuffer",
          "called while a render pass is open; WebGPU requires encoder-level copies outside a pass — skipping",
        );
        return;
      }
      const srcFbo = state.boundReadFramebuffer;
      const dstFbo = state.boundDrawFramebuffer;
      if (!srcFbo || !dstFbo) return;
      const srcAttachment = srcFbo._colorAttachment;
      const dstAttachment = dstFbo._colorAttachment;
      if (!srcAttachment || !dstAttachment) return;
      const srcTex =
        // StubTextureWrapper uses _webgpuTexture.texture; StubRenderbuffer uses _texture
        (srcAttachment as { _webgpuTexture?: { texture: GPUTexture } })
          ._webgpuTexture?.texture ||
        (srcAttachment as { _texture?: GPUTexture })._texture;
      const dstTex =
        (dstAttachment as { _webgpuTexture?: { texture: GPUTexture } })
          ._webgpuTexture?.texture ||
        (dstAttachment as { _texture?: GPUTexture })._texture;
      if (!srcTex || !dstTex) return;

      // WebGL's blit supports flipped axes when dst and src rectangles
      // have inverted orientation. WebGPU's copyTextureToTexture does
      // not — it always copies in +X/+Y direction. We only handle the
      // canonical non-flipped case; a flipped blit gets clamped to the
      // absolute extent and emits a diagnostic once.
      const width = Math.abs(srcX1 - srcX0);
      const height = Math.abs(srcY1 - srcY0);
      if (width === 0 || height === 0) return;
      if (srcX0 > srcX1 || srcY0 > srcY1 || dstX0 > dstX1 || dstY0 > dstY1) {
        logUsage(
          "blitFramebuffer",
          "flipped blit requested — WebGPU copyTextureToTexture can't flip; using unflipped extent",
        );
      }

      try {
        state.currentCommandEncoder.copyTextureToTexture(
          {
            texture: srcTex,
            origin: { x: Math.min(srcX0, srcX1), y: Math.min(srcY0, srcY1) },
          },
          {
            texture: dstTex,
            origin: { x: Math.min(dstX0, dstX1), y: Math.min(dstY0, dstY1) },
          },
          { width, height, depthOrArrayLayers: 1 },
        );
      } catch (err) {
        logUsage(
          "blitFramebuffer",
          `copyTextureToTexture failed: ${(err as Error).message}`,
        );
      }
    },

    readPixels: (): null => null,

    /**
     * Async readback of a framebuffer's color attachment. Not part of
     * the classic WebGL API (hence the distinct name) — callers that
     * genuinely need pixel data migrate from `readPixels` to this.
     *
     * Mirrors WebGL's `readPixels(x, y, width, height, format, type,
     * pixels)` shape so a migration is mostly mechanical: wrap the
     * surrounding code in an async function and `await` the result.
     * The output typed array is filled in place when the Promise
     * resolves, matching the WebGL expectation that `pixels` is an
     * out parameter.
     *
     * Only handles `format = GL_RGBA (0x1908)` + `type =
     * GL_UNSIGNED_BYTE (0x1401)` today — the combination Cesium's
     * pick framebuffer uses. Additional format/type combos are a
     * one-line extension of the switch below if the need arises.
     */
    readPixelsAsync: async (
      x: number,
      y: number,
      width: number,
      height: number,
      format: number,
      type: number,
      pixels: Uint8Array | Uint8ClampedArray,
    ): Promise<boolean> => {
      if (!state.device) return false;
      const srcFbo = state.boundReadFramebuffer || state.boundFramebuffer;
      const srcAttachment = srcFbo?._colorAttachment;
      if (!srcAttachment) return false;
      const srcTex =
        (srcAttachment as { _webgpuTexture?: { texture: GPUTexture } })
          ._webgpuTexture?.texture ||
        (srcAttachment as { _texture?: GPUTexture })._texture;
      if (!srcTex) return false;
      if (
        format !== 0x1908 /* GL_RGBA */ ||
        type !== 0x1401 /* UNSIGNED_BYTE */
      ) {
        logUsage(
          "readPixelsAsync",
          `unsupported format/type combo ${format.toString(16)}/${type.toString(16)} — only RGBA+UNSIGNED_BYTE today`,
        );
        return false;
      }
      const bytesPerPixel = 4;
      // WebGPU requires bytesPerRow to be a multiple of 256 for
      // buffer-texture copies. We pad the destination stride and
      // compact back into the caller's tight array after map.
      const bytesPerRow = Math.ceil((width * bytesPerPixel) / 256) * 256;
      const totalBytes = bytesPerRow * height;

      const readback = state.device.createBuffer({
        label: "readPixelsAsync staging",
        size: totalBytes,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      try {
        // Dedicated encoder so we don't interact with any pending
        // frame-level encoder the scene renderer owns. The readback
        // buffer is only mapped after this submit completes.
        const encoder = state.device.createCommandEncoder({
          label: "readPixelsAsync dedicated",
        });
        encoder.copyTextureToBuffer(
          { texture: srcTex, origin: { x, y } },
          { buffer: readback, bytesPerRow, rowsPerImage: height },
          { width, height, depthOrArrayLayers: 1 },
        );
        state.device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const mapped = new Uint8Array(readback.getMappedRange());
        // Compact the 256-aligned rows back into the caller's tight
        // output array at `width * bytesPerPixel` stride.
        const tightRow = width * bytesPerPixel;
        for (let row = 0; row < height; row++) {
          pixels.set(
            mapped.subarray(row * bytesPerRow, row * bytesPerRow + tightRow),
            row * tightRow,
          );
        }
        readback.unmap();
        return true;
      } finally {
        readback.destroy();
      }
    },
  };
}
