/* tslint:disable */
/* eslint-disable */

/**
 * Compile GLSL source to SPIR-V bytes. Used by the asset pipeline to
 * generate platform-neutral intermediate shaders that can then flow back
 * through `spirv_to_wgsl` (runtime) for validation, or be shipped direct
 * to Vulkan-targeted consumers.
 */
export function glsl_to_spv(source: string, stage: string): Uint8Array;

/**
 * Compile GLSL source to WGSL.
 *
 * `stage` must be one of `"vertex"`, `"fragment"`, or `"compute"` — naga's
 * GLSL frontend is stage-aware because GLSL's entry point is always `main`
 * and the builtin variables it sees depend on the pipeline stage.
 *
 * Caveat: naga's GLSL frontend is documented as supporting "GLSL 440+ and
 * Vulkan semantics only." WebGL GLSL ES 3.00 shaders may need a
 * preprocessor pass (precision qualifier rewriting, sampler type
 * normalisation) before feeding them in. The spike's reflection pass
 * will surface the specifics once we run a real Cesium shader through it.
 */
export function glsl_to_wgsl(source: string, stage: string): string;

/**
 * Roundtrip WGSL through naga's `wgsl-in`/`wgsl-out` pipeline. Acts as a
 * light minifier (drops comments, normalises formatting) and a
 * validation gate — anything naga's frontend rejects is rejected here.
 *
 * Useful as a build-time sanity check on hand-written WGSL and on Slang's
 * WGSL output. Not expected to preserve original formatting.
 */
export function normalize_wgsl(source: string): string;

/**
 * Compile a SPIR-V byte buffer to WGSL.
 *
 * Expects the standard SPIR-V magic number (`0x07230203`). No stage
 * parameter is needed — SPIR-V carries its own entry-point metadata.
 */
export function spirv_to_wgsl(bytes: Uint8Array): string;

/**
 * Parse and validate WGSL source. Returns a JSON blob describing the
 * discovered entry points, bindings, and push-constant layout. When
 * validation fails the rejection message is the thrown `Error.message`.
 *
 * Downstream pipeline builders can use the returned JSON to auto-derive
 * `GPUBindGroupLayoutDescriptor`s from the shader's declared bindings —
 * the main reason the spike exists in the first place, since the WebGL
 * stub path doesn't know the WebGPU layouts upfront.
 */
export function validate_wgsl(source: string): string;

/**
 * Emit HLSL (Shader Model 5.0+) from a WGSL source.
 */
export function wgsl_to_hlsl(source: string): string;

/**
 * Emit Metal Shading Language from a WGSL source.
 */
export function wgsl_to_msl(source: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly glsl_to_spv: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly glsl_to_wgsl: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly normalize_wgsl: (a: number, b: number, c: number) => void;
    readonly spirv_to_wgsl: (a: number, b: number, c: number) => void;
    readonly validate_wgsl: (a: number, b: number, c: number) => void;
    readonly wgsl_to_hlsl: (a: number, b: number, c: number) => void;
    readonly wgsl_to_msl: (a: number, b: number, c: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
