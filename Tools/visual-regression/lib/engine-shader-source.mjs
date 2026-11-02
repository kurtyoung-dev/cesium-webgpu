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

// The two source characters a template literal uses to join its modules (a
// backslash followed by `n`), as they appear in the renderer's text.
const ESCAPED_NEWLINE = String.fromCharCode(92, 110);

/**
 * The WGSL text a renderer's template constant composes: the modules it joins,
 * each read from the `.wgsl` behind the generated module the renderer imports,
 * joined with newlines in the template's order. Unpreprocessed: the result
 * still carries its `//>>ifdef` blocks, so a caller hands it to the engine's
 * `preprocess` for the variant it wants.
 *
 * The constant must be a template literal of `${Module}` placeholders joined
 * by newline escapes and nothing else (whole modules only), and every name
 * must be imported as `import X from "../../Shaders/<path>.js"`; anything else
 * throws, because a template that adds text of its own is a composition this
 * reader would silently misstate.
 *
 * @param {string} rendererPath Path of the renderer below `packages/engine/Source`, e.g. `Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts`.
 * @param {string} constantName The template constant, e.g. `PROCEDURAL_CLOUDS_SOURCE`.
 * @param {(relativePath: string) => string} [read] Reads one file below `packages/engine/Source` (the renderer and each module); defaults to the checkout holding this module. Pass another reader to compose from another tree.
 * @returns {string} LF-normalised composed source.
 */
export function composeRendererTemplate(
  rendererPath,
  constantName,
  read = (relativePath) => readEngineShader(relativePath),
) {
  const lf = (text) => text.replace(/\r\n/g, "\n");
  const renderer = lf(read(rendererPath));
  const escapedName = constantName.replace(/[$()*+.?[\\\]^{|}]/g, "\\$&");
  const template = renderer.match(
    new RegExp(`const ${escapedName}(?::[^=]+)? = \`([^\`]*)\`;`),
  );
  if (!template) {
    throw new Error(
      `composeRendererTemplate: ${rendererPath} has no template constant ${constantName}`,
    );
  }
  const names = [...template[1].matchAll(/\$\{(\w+)\}/g)].map((m) => m[1]);
  if (
    names.length === 0 ||
    template[1] !== names.map((name) => `\${${name}}`).join(ESCAPED_NEWLINE)
  ) {
    throw new Error(
      `composeRendererTemplate: ${constantName} must join whole modules with a backslash-n escape only`,
    );
  }
  return names
    .map((name) => {
      const imported = renderer.match(
        new RegExp(
          `import ${name} from "\\.\\./\\.\\./(Shaders/[\\w/]+)\\.js";`,
        ),
      );
      if (!imported) {
        throw new Error(
          `composeRendererTemplate: ${rendererPath} does not import ${name} as a Shaders/ module`,
        );
      }
      return lf(read(`${imported[1]}.wgsl`));
    })
    .join("\n");
}
