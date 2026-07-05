import { existsSync, readFileSync } from "node:fs";
import { URL, fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

// Node ESM customization hooks for the NodeJS smoke-screen tests
// (Specs/test.mjs and the per-package packages/*/Specs/test.mjs).
//
// This fork authors many Scene/Renderer modules in TypeScript but references
// them from sibling `.js` files with `.js` specifiers — the convention that
// `moduleResolution: "bundler"` (and esbuild) expect: the specifier names the
// *emitted* file, and the bundler infers the `.ts` source. The production
// `gulp build` does exactly this via an esbuild resolve plugin, so browsers
// and bundler consumers never see the mismatch.
//
// Plain Node does NOT do bundler-style `.js`->`.ts` inference, and its
// built-in TypeScript support (amaro type-stripping) cannot lower `enum` or
// elide un-annotated type-only imports (e.g. `import { GraphicsContextOptions }`
// where that symbol is a type). So loading the un-bundled `@cesium/engine`
// barrel under bare Node fails with ERR_MODULE_NOT_FOUND on the first
// TS-backed re-export.
//
// These hooks teach Node the same two things the build already does:
//   1. resolve: when a relative `.js` specifier resolves to nothing but a
//      sibling `.ts` exists, use the `.ts`.
//   2. load: transpile `.ts` sources with esbuild (which lowers `enum` and
//      elides type-only imports), exactly mirroring the build.
//
// This changes NO published export surface — it only lets the smoke tests
// exercise the un-bundled TypeScript source the way a bundler would. It is
// scoped to the smoke tests (registered from within each test.mjs) and is
// never part of the shipped package (Specs/ is npmignored).
//
// See migration_doc row C4-CI-NODE20-ESM-TS-BARREL.

/**
 * @param {string} specifier
 * @param {{ parentURL?: string }} context
 * @param {Function} nextResolve
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const isRelative =
      specifier.startsWith("./") || specifier.startsWith("../");
    if (
      error?.code === "ERR_MODULE_NOT_FOUND" &&
      isRelative &&
      specifier.endsWith(".js") &&
      context.parentURL
    ) {
      const tsURL = new URL(
        specifier.replace(/\.js$/, ".ts"),
        context.parentURL,
      );
      if (existsSync(fileURLToPath(tsURL))) {
        return { url: tsURL.href, format: "cesium-ts", shortCircuit: true };
      }
    }
    throw error;
  }
}

/**
 * @param {string} url
 * @param {{ format?: string }} context
 * @param {Function} nextLoad
 */
export async function load(url, context, nextLoad) {
  if (
    context.format === "cesium-ts" ||
    (url.startsWith("file:") && url.endsWith(".ts"))
  ) {
    const filename = fileURLToPath(url);
    const { code } = transformSync(readFileSync(filename, "utf8"), {
      loader: "ts",
      format: "esm",
      target: "es2022",
      sourcefile: filename,
    });
    return { format: "module", source: code, shortCircuit: true };
  }
  return nextLoad(url, context);
}
