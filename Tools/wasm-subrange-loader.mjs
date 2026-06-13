/**
 * ESM resolve hook for wasm-subrange-encode-check.mjs.
 *
 * The canonical WasmRTEBridge.js (packages/engine/Source/Scene/) imports the
 * wasm-bindgen glue via a build-layout-relative specifier
 * ("../../ThirdParty/Workers/cesium_wasm.js") that only resolves once esbuild
 * has bundled the engine. Under raw node that specifier points at a
 * nonexistent path, so we redirect it to the canonical glue that ships next to
 * the .wasm binary in Source/ThirdParty/Workers/.
 *
 * Pure resolution redirect — no transform — so the REAL glue + REAL bridge
 * code under test execute unchanged.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const canonicalGlue = pathToFileURL(
  path.join(
    repoRoot,
    "packages",
    "engine",
    "Source",
    "ThirdParty",
    "Workers",
    "cesium_wasm.js",
  ),
).href;

export async function resolve(specifier, context, nextResolve) {
  if (
    specifier.endsWith("ThirdParty/Workers/cesium_wasm.js") ||
    specifier.endsWith("ThirdParty\\Workers\\cesium_wasm.js")
  ) {
    return { url: canonicalGlue, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

const engineSrc = pathToFileURL(
  path.join(repoRoot, "packages", "engine", "Source") + path.sep,
).href;

/**
 * The engine package has no `"type": "module"`, so node would parse its
 * .js sources (the bridge, WasmFeatureDetection, WasmArenaSlots, the
 * wasm-bindgen glue, …) as CommonJS and choke on their `import`/`export`
 * statements. Force the ESM parser for every engine .js the check pulls in.
 */
export async function load(url, context, nextLoad) {
  if (
    (url === canonicalGlue || url.startsWith(engineSrc)) &&
    url.endsWith(".js")
  ) {
    return nextLoad(url, { ...context, format: "module" });
  }
  return nextLoad(url, context);
}
