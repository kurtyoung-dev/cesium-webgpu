import buildModuleUrl from "../Core/buildModuleUrl.js";

/**
 * Resolves the absolute URL of the wasm-bindgen glue module
 * (`ThirdParty/Workers/cesium_wasm.js`) that ships next to the compiled
 * `cesium_wasm_bg.wasm` binary, so every `Wasm*Bridge` can dynamic-`import()`
 * it consistently across ALL build outputs.
 *
 * Why this exists (NEW-WASM-BRIDGE-BUNDLE-LOAD):
 *
 * In the BUNDLED build, a hard-coded relative specifier inside a bridge source
 * file resolves relative to the EMITTED bundle, not the source file:
 *
 *   - The 5 bridges that kept `"../../ThirdParty/Workers/cesium_wasm.js"`
 *     external (via `webpackIgnore`) had `../../` resolve to `/Build/ThirdParty`
 *     (the glue actually lives at `/Build/<variant>/ThirdParty/Workers/`) → 404.
 *   - The 2 bridges (Cull/Sort) that imported a bare `"../ThirdParty/..."`
 *     got their glue INLINED by esbuild, and the inlined glue's
 *     `new URL("cesium_wasm_bg.wasm", import.meta.url)` then resolved to the
 *     bundle root (`/Build/<variant>/cesium_wasm_bg.wasm`) → binary 404.
 *
 * In BOTH shapes the WASM kernel never loaded and every bridge silently fell
 * back to its byte-identical JS twin, leaving the entire engine WASM path dark
 * in production (RTE, Cull, Sort, Heightmap, Matrix, PointCloud, QuantizedMesh).
 *
 * `buildModuleUrl` is the canonical Cesium base-URL resolver (the same one
 * `TaskProcessor` uses for its worker + `wasmBinaryFile` paths). It returns an
 * absolute URL anchored at the Cesium base URL in EVERY format:
 *
 *   - ESM bundle  → relative to `index.js`'s `import.meta.url`
 *   - IIFE bundle → relative to the `Cesium.js` `<script>` location
 *                   (a bare relative `import()` in a classic script would
 *                   resolve against the document base URL — wrong dir)
 *   - `CESIUM_BASE_URL` override is honored in all formats
 *
 * Because the glue is then fetched as its own module file, ITS `import.meta.url`
 * is the glue's real on-disk URL, so the sibling
 * `new URL("cesium_wasm_bg.wasm", import.meta.url)` inside the glue also
 * resolves to the correct co-located binary. One resolver fixes both the glue
 * 404 and the binary 404 for all seven bridges, in all three output formats.
 *
 * The returned specifier still ends in `ThirdParty/Workers/cesium_wasm.js`, so
 * the standalone node harness (`Tools/wasm-subrange-loader.mjs`, which matches
 * on that suffix) keeps redirecting it to the canonical glue under raw node.
 *
 * @private
 * @returns {string} Absolute URL of the wasm-bindgen glue module.
 */
function resolveWasmGlueUrl() {
  return buildModuleUrl("ThirdParty/Workers/cesium_wasm.js");
}

export default resolveWasmGlueUrl;
