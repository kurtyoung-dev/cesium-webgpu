/**
 * ONE place for "what WGSL does a pipeline actually compile".
 * @purpose Exposes the engine's real WGSL preprocessor and define registry so specs validate the exact variant text pipelines compile, not raw ifdef source.
 * @status ACTIVE
 *
 * C13-10 gave three cloud shaders (`ProceduralClouds.wgsl`,
 * `CloudReconstructionAttachments.wgsl`, `CloudTemporalResolve.wgsl`) their
 * first `//>>ifdef` variants. A shader with a variant is DELIBERATELY not
 * valid WGSL as raw text — both branches are present at once — so every spec
 * that handed a raw `.wgsl` file to naga started failing for a reason that has
 * nothing to do with the shader being wrong.
 *
 * The fix that would have been quietly wrong is a per-spec regex that strips
 * directive blocks: seven approximations of the preprocessor, drifting
 * independently from the real one. This module instead exposes the ENGINE's
 * own `preprocess`, so a spec validates the exact text
 * `device.createShaderModule` receives.
 *
 * `defaultVariant(source)` is the form every pipeline compiled at
 * `definesHi = 0` sees, which for the cloud lane is every pipeline except the
 * two C13-10 opt-in ones.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { enableEngineTsResolution } from "./engine-ts-resolver.mjs";
import {
  ENGINE_SOURCE_ROOT as engineSource,
  readEngineShader,
} from "./engine-shader-source.mjs";

enableEngineTsResolution();

const engineModule = (relativePath) =>
  pathToFileURL(path.join(engineSource, relativePath)).href;

const { preprocess } = await import(
  engineModule("Renderer/WebGPU/WebGPUShaderPreprocessor.ts")
);
/** The whole define registry, so a spec can reach a resolver without a second loader. */
export const shaderDefines = await import(
  engineModule("Renderer/WebGPU/WebGPUShaderDefines.ts")
);
const { ShaderDefine, ShaderDefineHi } = shaderDefines;

export { preprocess, ShaderDefine, ShaderDefineHi };

// The reader lives in a leaf module so text-only specs need not load the
// engine preprocessor; it is re-exported here for the specs that use both.
export { readEngineShader };

/**
 * The WGSL a pipeline compiled with NO defines actually receives: directive
 * lines removed, every `//>>ifdef` block reduced to its `//>>else`.
 *
 * Byte-identical to the raw file for any shader that carries no directives, so
 * it is safe to wrap a validation in it unconditionally.
 */
export function defaultVariant(source) {
  return preprocess(source, 0, 0);
}

/** The WGSL a pipeline compiled with `definesHi` receives. */
export function hiVariant(source, definesHi) {
  return preprocess(source, 0, definesHi);
}

/** Blank- and comment-line-stripped source: the text a compiler acts on. */
export function codeOnlyLines(source) {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("//"));
}

/** Code lines present in the `definesHi` variant and absent from the default. */
export function variantOnlyLines(source, definesHi) {
  const base = new Set(codeOnlyLines(defaultVariant(source)));
  return codeOnlyLines(hiVariant(source, definesHi)).filter(
    (line) => !base.has(line),
  );
}
