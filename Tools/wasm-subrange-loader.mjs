/**
 * Shared WASM sub-range harness for wasm-subrange-encode-check.mjs and
 * wasm-encode-benchmark.mjs: the ESM resolve hook, the fetch shim, and the
 * on-disk locations of the glue and the binary.
 * @purpose ESM resolve hook redirecting WasmRTEBridge's build-layout wasm-glue specifier to the on-disk glue, plus the file-URL fetch shim and the glue/wasm path helpers, so the wasm Node checks and the benchmark run the real bridge.
 * @status ACTIVE
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
 *
 * This module is installed with `module.register()`, which evaluates it on
 * the loader thread as well as importing it on the main thread: the two
 * realms do not share state. Anything added here must stay stateless, or be
 * prepared to be initialised twice.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

/**
 * Shim globalThis.fetch so the wasm-bindgen glue's `fetch(URL)` resolves the
 * .wasm bytes from disk. Node 20 ships a global fetch (undici) that does not
 * support file:// URLs, hence the shim; only the cesium wasm URL is
 * intercepted. The glue's __wbg_load path awaits the module first and then
 * checks `instanceof Response`; resolving to a real Response built from the
 * bytes is the simplest value whose arrayBuffer() yields them.
 *
 * @param {Uint8Array} wasmBytes The .wasm bytes to serve.
 * @param {string} unexpectedFetchContext Named in the error thrown for any other URL
 *   when no real fetch exists to fall through to.
 * @returns {() => void} Restores the original global fetch.
 */
export function installWasmFetchShim(wasmBytes, unexpectedFetchContext) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url =
      typeof input === "string" ? input : (input?.href ?? String(input));
    if (url.includes("cesium_wasm_bg.wasm")) {
      return new Response(wasmBytes, {
        headers: { "Content-Type": "application/wasm" },
      });
    }
    if (realFetch) {
      return realFetch(input);
    }
    throw new Error(`Unexpected fetch in ${unexpectedFetchContext}: ${url}`);
  };
  return () => {
    globalThis.fetch = realFetch;
  };
}

export function f32BytesEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  const ua = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const ub = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < ua.length; i++) {
    if (ua[i] !== ub[i]) {
      return false;
    }
  }
  return true;
}

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
