// engine-ts-transform.mjs — compile one engine TypeScript file to JavaScript in memory, for a spec's module `load` hook.
// @purpose Transpile engine TypeScript source to ES module JavaScript through esbuild (the compiler the shipped build uses), so a spec's load hook can run files that hold syntax Node's strip-only type stripping cannot erase, on every Node version.
// @status ACTIVE
//
// WHY THIS EXISTS. Five specs register a module `load` hook that turns an
// engine `.ts` file into runnable JavaScript, because the files they load hold
// syntax a plain type strip cannot erase (a `const enum`, for one). Each called
// `stripTypeScriptTypes(source, { mode: "transform" })` from `node:module`, and
// Node v26.13.1 removed that mode (`options.mode must be one of: 'strip'`), so
// all five went red at once. This is the one shared replacement; the five specs
// no longer carry their own call.
//
// WHAT IT DOES. `transformEngineTypeScript(source, file)` runs esbuild's
// synchronous `transformSync` with the `ts` loader, ES module output and the
// build's own target (`es2020`, `defaultESBuildOptions()` in `scripts/build.js`),
// and returns the JavaScript text. It reads no file, resolves nothing and
// touches no disk: the caller hands it the (possibly mutated) source text and
// keeps its own resolve hook, shader-module stand-ins and `?mutant=` handling.
// The result does not depend on the Node version, only on the installed esbuild.
//
// WHAT IT DOES NOT DO. It is a single-file transform, not a bundle. The shipped
// build bundles, so esbuild there inlines a `const enum` member used in another
// module as a literal; a single-file transform instead keeps a `const enum` as
// an ordinary enum object, exported by its own module and read through the
// import at run time. The values are the same, so behaviour a spec observes is
// the same; only the emitted text differs. An import used only as a type is
// dropped and a side-effect import is kept, as in the build (no
// `verbatimModuleSyntax`). Source maps are off: the caller gives no map to Node.
// Class fields use define semantics, esbuild's default with no tsconfig; that
// matches the build only while the engine tsconfig's target is ES2022 or later.

import { transformSync } from "esbuild";

/**
 * Compile engine TypeScript to ES module JavaScript.
 *
 * @param {string} source The TypeScript text, with any mutation already applied.
 * @param {string} [file] The file path or URL, used only to name errors.
 * @returns {string} The JavaScript text.
 * @throws {Error} When the source does not parse as TypeScript.
 */
export function transformEngineTypeScript(source, file = "<engine-source>") {
  return transformSync(source, {
    loader: "ts",
    format: "esm",
    target: "es2020",
    sourcefile: file,
    sourcemap: false,
    legalComments: "inline",
  }).code;
}
