/**
 * @module WebGPUShaderTranslator
 *
 * Pluggable runtime GLSL→WGSL shader translation for the
 * WebGL-compatibility code path. Closes the loop on the Proton-style
 * stub: previously `gl.shaderSource(shader, glslText)` accepted the
 * GLSL but never produced a usable `GPUShaderModule`, so compat-path
 * consumers had no way to actually render. This module defines the
 * interface any translator must satisfy and a module-level registry
 * that callers can plug into at bootstrap:
 *
 *   import { registerShaderTranslator } from "@cesium/engine";
 *   import { NagaWasmTranslator } from "my-naga-wasm-adapter";
 *   await NagaWasmTranslator.load();
 *   registerShaderTranslator(new NagaWasmTranslator());
 *
 * Once registered, any `gl.compileShader()` on a WebGL-stub-produced
 * shader object will invoke the translator asynchronously, cache the
 * resulting WGSL + reflection on the shader, and a subsequent
 * `gl.linkProgram()` + downstream pipeline build will see a real
 * `GPUShaderModule`.
 *
 * ## Why pluggable, not baked-in
 *
 * The two viable translators (Naga and Slang) both ship as WebAssembly
 * in rapidly-evolving npm packages. Hard-coding a specific build would
 * pin CesiumJS to a version that will be stale in 6 months. A
 * registry lets users pick the translator that matches their target
 * browsers / bundle budget:
 *
 *   - `naga-wasm` (via `@gfx-rs/naga-wasm` when it stabilizes, or a
 *     vendored build) — ~1-2 MB, production-tested GLSL frontend.
 *   - `slang-wasm` — ~5-8 MB, Khronos-backed authoring language, less
 *     strong on runtime GLSL input but covers HLSL / MSL etc.
 *   - Custom minimal — app-specific subset translators.
 *
 * The registry also documents which translator is active at runtime
 * for diagnostics (`getActiveShaderTranslator()?.describe()`).
 *
 * ## Architecture integration
 *
 *   - **WebGLStubShader** consumes this via `compileShader` /
 *     `getShaderInfoLog`. Returns a Promise that `linkProgram` awaits.
 *   - **Pipeline creation** via `extractPipelineStateFromStub` +
 *     `getCompiledShaderForProgram` produces the shader+state pair
 *     a `WebGPURenderPipelineCache.getOrCreatePipeline` call needs.
 *   - **Multi-context**: the registry is module-global because WebGPU
 *     devices can share the same WASM module; per-device caches hang
 *     off individual translator implementations if they need them.
 *
 * @see WebGLCompatibilityStub (consumer nexus)
 * @see WebGLStubPipelineExtractor (state extractor for pipeline building)
 */

/// <reference types="@webgpu/types" />

/** WebGL shader stage passed to the translator. */
export type ShaderStage = "vertex" | "fragment" | "compute";

/**
 * Reflection metadata a translator produces for a successfully
 * compiled shader. Mirrors the parts of Naga's `ModuleInfo` / Slang's
 * JSON reflection that map directly to WebGPU bind-group + vertex
 * input construction — enough for a downstream pipeline builder to
 * produce correct `GPUBindGroupLayout` entries and
 * `GPUVertexBufferLayout` descriptors without the caller having to
 * know the source GLSL's uniform layout.
 */
export interface ShaderReflection {
  /** Entry point name (e.g. "main" for GLSL, "vertexMain" for WGSL) */
  entryPoint: string;
  /** Shader stage */
  stage: ShaderStage;
  /**
   * Uniform buffer bindings. Each entry describes one `uniform` block
   * in the source (GLSL) or `var<uniform>` (WGSL).
   */
  uniformBuffers: Array<{
    group: number;
    binding: number;
    /** Name (for debug + user-visible errors) */
    name: string;
    /** Total buffer size in bytes, std140 / std430 aligned */
    sizeBytes: number;
    /** Per-member layout (name, type, byte offset) */
    members: Array<{
      name: string;
      type: string;
      offset: number;
      sizeBytes: number;
    }>;
  }>;
  /**
   * Texture bindings (sampled textures, storage textures, samplers).
   */
  textures: Array<{
    group: number;
    binding: number;
    name: string;
    viewDimension: GPUTextureViewDimension;
    sampleType:
      | "float"
      | "unfilterable-float"
      | "depth"
      | "sint"
      | "uint";
    multisampled: boolean;
  }>;
  samplers: Array<{
    group: number;
    binding: number;
    name: string;
    type: GPUSamplerBindingType;
  }>;
  /**
   * Vertex attributes (stage === "vertex" only). Produced from GLSL
   * `layout(location = N) in` declarations or the WGSL vertex
   * function parameters.
   */
  attributes: Array<{
    location: number;
    name: string;
    format: GPUVertexFormat;
  }>;
  /** Color attachment outputs (stage === "fragment" only). */
  fragmentOutputs?: Array<{
    location: number;
    name: string;
    type: string;
  }>;
}

/**
 * Result of a successful translation.
 */
export interface TranslatedShader {
  /** WGSL source, ready to pass to `device.createShaderModule`. */
  wgsl: string;
  /** Reflection metadata, usable by pipeline builders. */
  reflection: ShaderReflection;
  /** Optional warnings the translator produced (non-fatal). */
  warnings?: string[];
}

/**
 * Interface every translator implementation must satisfy.
 */
export interface ShaderTranslator {
  /**
   * Human-readable name (e.g. "naga-wasm 22.1.0"). Logged at
   * registration time and returned from `describe()` for diagnostics.
   */
  readonly name: string;

  /**
   * Which source languages this translator accepts. The WebGL stub
   * always requests "glsl"; other entry points (e.g. a direct call
   * from app code) may request WGSL passthrough / Slang / etc.
   */
  readonly supports: ReadonlyArray<"glsl" | "wgsl" | "slang">;

  /**
   * Translate `source` (in `language`) to WGSL. Must be safe to call
   * concurrently — translators that wrap a single-threaded WASM
   * module are expected to serialize internally or document
   * otherwise.
   *
   * Throws with a message suitable for `gl.getShaderInfoLog()` on
   * compile failure.
   */
  translate(
    source: string,
    stage: ShaderStage,
    language: "glsl" | "wgsl" | "slang",
  ): Promise<TranslatedShader>;

  /**
   * Optional diagnostic summary (version, bundle size, supported
   * GLSL profile). Shown by `CesiumDebug.pipelineStatus()` et al.
   */
  describe?(): string;
}

// ─── Registry ───────────────────────────────────────────────────────────

let _activeTranslator: ShaderTranslator | null = null;
const _registrationListeners: Set<(t: ShaderTranslator | null) => void> =
  new Set();

/**
 * Register a shader translator as the active implementation. At most
 * one translator is active at a time — subsequent registrations
 * replace the previous one. Pass `null` to clear (uncommon, primarily
 * for tests).
 *
 * Registration notifies any subscribers (see
 * `subscribeToShaderTranslatorChange`), so lazy WebGL-stub consumers
 * that deferred compilation because no translator was available can
 * retry.
 */
export function registerShaderTranslator(
  translator: ShaderTranslator | null,
): void {
  _activeTranslator = translator;
  for (const listener of _registrationListeners) {
    try {
      listener(translator);
    } catch (_e) {
      // Never let a subscriber error propagate — we don't want a
      // misbehaving listener to block other consumers.
    }
  }
}

/**
 * Read the currently-registered translator, if any.
 */
export function getActiveShaderTranslator(): ShaderTranslator | null {
  return _activeTranslator;
}

/**
 * Subscribe to translator-registration events. Returns an
 * unsubscriber. Fires immediately once with the current translator
 * (or null) so subscribers don't need a separate initial-state probe.
 */
export function subscribeToShaderTranslatorChange(
  listener: (translator: ShaderTranslator | null) => void,
): () => void {
  _registrationListeners.add(listener);
  // Fire once with the current state.
  try {
    listener(_activeTranslator);
  } catch (_e) {
    // Swallow — same rationale as registerShaderTranslator.
  }
  return () => {
    _registrationListeners.delete(listener);
  };
}

// ─── Built-in translators ────────────────────────────────────────────────

/**
 * Trivial WGSL passthrough translator. Accepts WGSL and returns it
 * unchanged. Useful when callers want to participate in the stub's
 * shader pipeline (for uniform location reflection, caching) but are
 * already authoring WGSL — no WASM needed.
 *
 * Not registered by default; users opt in:
 *
 *   registerShaderTranslator(new WGSLPassthroughTranslator());
 */
export class WGSLPassthroughTranslator implements ShaderTranslator {
  readonly name = "WGSL-passthrough";
  readonly supports: ReadonlyArray<"glsl" | "wgsl" | "slang"> = ["wgsl"];

  async translate(
    source: string,
    stage: ShaderStage,
    language: "glsl" | "wgsl" | "slang",
  ): Promise<TranslatedShader> {
    if (language !== "wgsl") {
      throw new Error(
        `WGSLPassthroughTranslator cannot translate "${language}" — register a naga-wasm adapter for GLSL support.`,
      );
    }
    // Reflection isn't meaningful for passthrough — downstream
    // consumers that need it should route through a real translator.
    // We return the bare minimum so the shape is consistent.
    return {
      wgsl: source,
      reflection: {
        entryPoint:
          stage === "vertex"
            ? "vertexMain"
            : stage === "fragment"
              ? "fragmentMain"
              : "computeMain",
        stage,
        uniformBuffers: [],
        textures: [],
        samplers: [],
        attributes: [],
      },
    };
  }

  describe(): string {
    return "WGSL passthrough (no translation; use for WGSL-only compat paths)";
  }
}

/**
 * Descriptive stub to register when you want the WebGL stub's
 * `compileShader` to fail with a specific human-readable message
 * instead of silently returning the placeholder. Useful for apps
 * that know they don't support GLSL and want clearer errors for
 * their users.
 */
export class NotSupportedTranslator implements ShaderTranslator {
  readonly name: string;
  readonly supports: ReadonlyArray<"glsl" | "wgsl" | "slang"> = [];
  private readonly _message: string;

  constructor(message = "GLSL shader translation not available in this build") {
    this.name = "NotSupported";
    this._message = message;
  }

  async translate(): Promise<TranslatedShader> {
    throw new Error(this._message);
  }

  describe(): string {
    return `NotSupported — ${this._message}`;
  }
}
