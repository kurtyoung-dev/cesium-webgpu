/**
 * The one reader through which specs open an engine shader.
 * @purpose Resolves and reads engine shader sources (packages/engine/Source/Shaders/**) for specs, so a move or decomposition of a shader changes one module instead of every spec that reads it.
 * @status ACTIVE
 *
 * Forty-odd specs used to join their own path to
 * `Shaders/WebGPU/Globe/GlobeTerrain.wgsl` and read it from disk; one
 * restructuring of that file broke five of them at once. This module is a
 * leaf on purpose: it imports nothing from the engine, so a spec that only
 * reads shader text does not also depend on the engine preprocessor loading
 * (`wgsl-variant.mjs` re-exports `readEngineShader` for the specs that do).
 *
 * `eol: "lf"` (the default) normalizes CRLF, which is what Windows checkouts
 * carry under `core.autocrlf`; `eol: "native"` returns the bytes on disk, for
 * the specs whose assertions were written against the raw file.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path of `packages/engine/Source` in the checkout that holds this module. */
export const ENGINE_SOURCE_ROOT = path.resolve(
  here,
  "../../../packages/engine/Source",
);

/**
 * Absolute path of one engine shader, for callers that hand a path to another
 * tool (naga, a mutant copy) rather than reading the text themselves.
 * @param {string} relativePath Path below `packages/engine/Source`, e.g. `Shaders/WebGPU/Globe/GlobeTerrain.wgsl`.
 * @returns {string}
 */
export function engineShaderPath(relativePath) {
  const resolved = path.resolve(ENGINE_SOURCE_ROOT, relativePath);
  const relative = path.relative(ENGINE_SOURCE_ROOT, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `engineShaderPath: ${relativePath} resolves outside packages/engine/Source`,
    );
  }
  return resolved;
}

/**
 * Read one engine shader.
 * @param {string} relativePath Path below `packages/engine/Source`.
 * @param {{ eol?: "lf" | "native" }} [options]
 * @returns {string}
 */
export function readEngineShader(relativePath, { eol = "lf" } = {}) {
  if (eol !== "lf" && eol !== "native") {
    throw new Error(`readEngineShader: unknown eol mode ${String(eol)}`);
  }
  const text = fs.readFileSync(engineShaderPath(relativePath), "utf8");
  return eol === "lf" ? text.replace(/\r\n/g, "\n") : text;
}
