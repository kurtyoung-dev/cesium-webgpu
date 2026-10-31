---
name: build-and-variants
description: Build, test and variant rules — build commands, WebGPU-only and WebGL-only bundles, compat exemptions, smoke test, visual regression, Edge Playwright. Read before building or testing.
---

# Build & Test Commands

Part of the fork's rules: moved here from `CLAUDE.md` (see its "On-demand Skills" section) so it loads only when needed, and it binds exactly as `CLAUDE.md` does.

```bash
npx gulp build              # Full build (includes WGSL compilation)
npx gulp buildRelease        # Production build (minified + unminified)
npm run tsc-engine           # Engine TypeScript type checking (packages/engine)
npx tsc --noEmit             # Root tsconfig only (scripts/*.js); says nothing about the engine
npm run build-wasm           # WASM release build
npm run build-wasm-debug     # WASM debug build
npm run restart              # Rebuild + restart dev server (user-preferred over raw gulp)
npm test                     # Run Jasmine test suite
```

## Build Variants (Tree-Shaking)

Three bundle variants are available to reduce download size when only one backend is needed:

```bash
npx gulp buildCesiumDual          # Both backends, WebGPU-first default (historical Build/Cesium)
npx gulp buildCesiumWebGPUOnly    # WebGPU only — GLSL shaders aliased to empty stubs
npx gulp buildCesiumWebGLOnly     # WebGL only — WebGPU renderer aliased to empty stubs
npx gulp buildAllVariants         # All three side-by-side (engine+widgets built once)
```

**Output directories:**

- `Build/Cesium{Unminified}` — dual (default, backwards-compatible)
- `Build/CesiumWebGPU{Unminified}` — WebGPU-only (GLSL shaders → empty stubs)
- `Build/CesiumWebGL{Unminified}` — WebGL-only (WebGPU renderer + WGSL → empty stubs)

**Measured sizes:** see [`BUILD_AND_VARIANTS.md`](../../../migration_doc/BUILD_AND_VARIANTS.md) §2
("Build Variants" → "Measured sizes") for the variant-size table. That section is itself
pinned to Batch 506 and flagged `status: verify — STALE` there, with a
`npx gulp buildAllVariants` re-measure recipe. Do not restate absolute MB figures here;
they go stale exactly as the table that used to sit in this spot did.

The webgl-only drop is larger because it strips the entire `Source/Renderer/WebGPU/` directory plus every WGSL shader string module. The webgpu-only drop is smaller because it only strips the GLSL shader-string leaves — the WebGL backend classes (`Context`, `ShaderProgram`, `Texture`, etc., all under `Source/Renderer/`) still get pulled in by Scene files' static imports. See [`BUILD_AND_VARIANTS.md`](../../../migration_doc/BUILD_AND_VARIANTS.md) §2 for current file/LOC/shader counts and the re-measure recipe; do not restate absolute counts here.

**How the variant wiring works:**

- The variant alias plugin (`scripts/bundleVariantPlugin.js`) intercepts import resolution via esbuild's `onResolve` hook. In `webgpu-only` builds, every `Source/Shaders/*.js` path (except `Source/Shaders/WebGPU/`) is redirected to `scripts/stubs/emptyShader.js` (a `export default ""`). In `webgl-only` builds, files under `Source/Renderer/WebGPU/**` and `Source/Shaders/WebGPU/**` are redirected to `scripts/stubs/emptyModule.js` (a Proxy that throws on any non-introspection access).
- Scene files do NOT need modification — their static `import GlobeFS from '../Shaders/GlobeFS.js'` imports resolve to the stub, and the WebGPU feature renderer pattern ensures the WebGL code path that would consume `GlobeFS` is never reached when the WebGPU backend is active.
- The dual build enables ESM code splitting so `await import("./WebGPU/WebGPUContext.js")` in `ContextFactory` stays dynamic — WebGPU code lands in a separate `chunks/WebGPUContext-*.js` chunk and only downloads when `renderer: 'webgpu'` (or `AUTO` resolving to WebGPU) is picked.
- The IIFE (`Cesium.js`) and CJS (`index.cjs`) formats don't support code splitting, so their WebGPU code is inlined regardless of variant — the alias plugin is what actually shrinks them.

**Compat-surface exemption list (CRITICAL for future renderer work):**

Some files under `Source/Renderer/WebGPU/` are **backend-neutral** — they're consumable from webgl-only builds even though they live in the WebGPU directory. These are listed in `WEBGPU_COMPAT_EXEMPTIONS` in `scripts/bundleVariantPlugin.js` and are NOT redirected to empty stubs. Read the list at the source — `scripts/bundleVariantPlugin.js:276-286` (5 entries as of 2026-09-05; applied by `isWebGPUFile` at `:296` via the loop at `:310`) — rather than trusting a prose copy.

**When adding a new file under `Source/Renderer/WebGPU/`** that exports a backend-neutral API (e.g., an extended shader translator, a new pluggable registry), add its path to `WEBGPU_COMPAT_EXEMPTIONS`. The file's runtime code paths must be safe to execute in a webgl-only bundle (lazy-load any WebGPU deps, don't throw at module load).

**Runtime default renderer:** controlled by `setGlobalDefaultRenderer()` in `RendererType.ts`. Each variant's entry barrel (`Source/Cesium.js`, `Source/CesiumWebGLOnly.js`, `Source/CesiumWebGPUOnly.js` — generated by `createCesiumJs(variant)`) calls this at module init so the `AUTO` renderer selection picks the right backend by default. Users can still override per-`Viewer` via `contextOptions.renderer`.

**Side-effects declaration (CRITICAL):** The root `package.json` declares `"./Source/Cesium*.js"` as side-effectful so bundlers don't tree-shake the `setGlobalDefaultRenderer()` call out of the variant entry barrels. Never remove that line without replacing it with a different mechanism for the default-renderer hint.

**Smoke test:** `node Tools/variant-smoke-test.mjs` loads each variant's `index.html`/`Cesium.js` in Playwright, asserts no console errors, and verifies a frame renders. Run it after any change that touches the variant plugin, the exemption list, or the entry-barrel generation.

## Visual Regression Testing

```bash
node Tools/visual-regression/capture-and-diff.mjs              # Run all scenes
node Tools/visual-regression/capture-and-diff.mjs --update      # Save new baselines
node Tools/visual-regression/capture-and-diff.mjs --scene globe-default --headed
```

Captures WebGL vs WebGPU canvases from the split-screen page, pixel-diffs them, outputs PNG diffs + JSON report. Uses Edge by default. Zero external deps. See `Tools/visual-regression/README.md`.

## Playwright / Browser Testing

- **Use Edge (Chromium), NOT Firefox** — Playwright's Firefox (Nightly) does NOT have WebGPU enabled; release Firefox does but Playwright bundles Nightly
- WebGPU viewer URL: `http://localhost:8080/Apps/CesiumViewer/index.html?renderer=webgpu`
- Split-screen URL: `http://localhost:8080/Apps/WebGPUTest/split-screen-comparison.html`
- `window.viewer` is exposed on the CesiumViewer page for console debugging
- `window.webglViewer` / `window.webgpuViewer` are exposed on the split-screen page
- Use `viewer.scene.getDebugSnapshot()` and `viewer.scene.logDebugSnapshot()` for diagnostics
- The WebGPU renderer REQUIRES the post-process pipeline to blit the scene framebuffer to the canvas — `usePostProcess` must always be true for WebGPU (unlike WebGL which can render directly to the canvas)
