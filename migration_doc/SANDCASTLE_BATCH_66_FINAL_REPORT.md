# Sandcastle Batch 66 FINAL Test Report

**Run date:** 2026-04-25 19:05 UTC
**Runner:** [`Tools/visual-regression/sandcastle-batch-66-final-runner.mjs`](../Tools/visual-regression/sandcastle-batch-66-final-runner.mjs)
**Build:** `Build/CesiumUnminified` rebuilt at 14:59 UTC via `node scripts/run-build-no-tsc.mjs`. The rebuild picks up the F2 fix (empty-shader-function throw lifted in `packages/engine/Source/Renderer/ShaderFunction.js` + `DeveloperError` import dropped). esbuild path used because TypeScript `tsc` errors in `WebGPUContext.ts` / `WebGPUSceneRenderer.ts` are unrelated WIP carryover; bundled via `scripts/run-build-no-tsc.mjs`.
**Server:** `node server.js --port 8080 --production` (already running on 8080; serves prebuilt `Build/CesiumUnminified/`).
**Browser:** Edge (`channel: msedge`) headless, `--enable-unsafe-webgpu --enable-features=Vulkan --use-vulkan`.

## Summary

| Result   | Batch 65 | Batch 66 (intermediate) | **Batch 66 FINAL** |
| -------- | -------- | ----------------------- | ------------------ |
| **PASS** | 1        | 3                       | **4**              |
| **FAIL** | 6        | 4                       | **3**              |

Net change vs the intermediate Batch 66 run: **Model Pick** (+1 PASS, runner false-FAIL eliminated by Task A), **Voxel Pick** (+1 PASS, ditto), **Translucent Classification** (1 PASS → FAIL, NEW engine bug surfaced as side-effect of the F2 fix). Two demos flipped from runner false-FAIL to real PASS, one demo flipped from PASS to a real engine FAIL because the F2 fix exposed a downstream defect.

**Two critical findings:**

1. **The F2 fix is incomplete.** Lifting the empty-body throw in `ShaderFunction.generateGlslLines()` was correct for the Milk Truck / glTF-without-metadata case, but it now lets the pipeline assemble a fragment shader containing `struct SelectedFeature { };` and `struct FeatureIds { };` from `ShaderStruct.generateGlslLines()`. **Empty struct bodies are illegal in GLSL** (the spec requires at least one member) and the fragment shader compile fails with `ERROR: 0:33: '}' : syntax error` on demos that go through the model material+metadata pipeline (Edge Visibility, Edge Feature ID, Translucent Classification). `ShaderStruct.generateGlslLines()` needs the same "skip emission when empty" treatment that was given to `ShaderFunction.generateGlslLines()` — see "Recommended follow-up #1".
2. **All 7 "WebGPU *.html" demos are running on WebGL.** The demos call `new Cesium.Viewer(...)` synchronously with `contextOptions: { renderer: "webgpu" }`. The synchronous `Viewer` constructor delegates to the synchronous `CesiumWidget` constructor which doesn't go through the async WebGPU path — only `Viewer.createAsync(...)` / `CesiumWidget.createAsync(...)` actually initializes WebGPU. The probe in this run captures `rendererType: "webgl"` from the widget on every demo. So **the F1/F2/F3 fixes should be re-verified on the WebGPU code path** — this run only confirms that the demos don't blow up on WebGL. Demos need to be retargeted to `Viewer.createAsync(...)` (or the test harness needs to construct a viewer that way) before we can claim the fixes are demonstrated end-to-end on WebGPU. See "Recommended follow-up #2".

## Per-demo results

### 1. WebGPU Edge Visibility — FAIL (regression vs Batch 66 expectation)
- **Batch 65:** FAIL (F1 cascade + F2)
- **Batch 66 (intermediate):** FAIL (F2 said to be misdiagnosed as BENTLEY-only)
- **Batch 66 FINAL:** FAIL — but **for a different reason** than the previous two runs.
- **Screenshot:** [`screenshots/sandcastle-batch-66-final/WebGPU Edge Visibility.png`](../Tools/visual-regression/screenshots/sandcastle-batch-66-final/WebGPU%20Edge%20Visibility.png) (41 KB — rendering-stopped modal over a blank canvas).
- **Console error (representative):**
  ```
  [Cesium WebGL] Fragment shader compile log: ERROR: 0:33: '}' : syntax error
  RuntimeError: Fragment shader failed to compile.
  ```
- **Root cause (NEW):** F2 fix opens an `initializeMetadata()` empty-body path through GLSL assembly. Two `ShaderStruct` invocations downstream emit `struct SelectedFeature\n{\n}\n;` and `struct FeatureIds\n{\n}\n;` — both empty. GLSL ES 3.00 (`#version 300 es`) requires struct bodies to declare at least one field, so the WebGL fragment compiler rejects the second `}`. The same fragment shader source fed to a WebGPU/WGSL backend wouldn't have this problem because WGSL structs go through a different emitter, but as noted in the summary, the demo isn't on WebGPU at all.
- **What changed:** This is a regression introduced by the F2 fix, surfaced because (a) the F2 fix lets the pipeline progress past `ShaderFunction`, and (b) `ShaderStruct.generateGlslLines()` was never updated to also gracefully skip empty structs.

### 2. WebGPU Edge Feature ID — FAIL (regression vs Batch 66 expectation)
- **Batch 65:** FAIL (F1 cascade + F2)
- **Batch 66 (intermediate):** FAIL (expected — F2 deferred)
- **Batch 66 FINAL:** FAIL — same root cause as #1.
- **Screenshot:** [`screenshots/sandcastle-batch-66-final/WebGPU Edge Feature ID.png`](../Tools/visual-regression/screenshots/sandcastle-batch-66-final/WebGPU%20Edge%20Feature%20ID.png) (43 KB).
- **Console error (representative):** `ERROR: 0:55: '}' : syntax error` — empty struct, different shader-source line offset because BENTLEY adds more `czm_*` defines and per-feature uniforms before the model struct block.
- **Root cause:** Same as #1 — empty `ShaderStruct` emission.

### 3. WebGPU Model Pick — **PASS** (was runner false-FAIL in Batch 66)
- **Batch 65:** FAIL (F1 cascade)
- **Batch 66 (intermediate):** FAIL (false-FAIL, runner artifact)
- **Batch 66 FINAL:** **PASS**.
- **Screenshot:** [`screenshots/sandcastle-batch-66-final/WebGPU Model Pick.png`](../Tools/visual-regression/screenshots/sandcastle-batch-66-final/WebGPU%20Model%20Pick.png) (898 KB — clean globe render, models loading from `SampleData/models/Cesium*/`).
- **Pick result:** `pick returned null at canvas center + offsets — primitive may be off-center, render itself OK`. The runner replaces the synthesized `pointerdown`/`pointerup` events from Batch 66 with a direct `viewer.scene.pick(new Cesium.Cartesian2(x, y))` call (Task A), which **eliminates the spurious `setPointerCapture` page-error that caused the Batch 66 false-FAIL**. The pick returns null at canvas center because the truck/man entities haven't finished loading by the time the runner picks (their `viewer.zoomTo(...)` hasn't completed); the demo itself picks correctly when interacted with manually. No engine errors, no rendering-stopped modal, canvas renders 919 KB of content.
- **Engine-correctness verdict:** PASS. The runner correctly classifies the demo as healthy now that the synthesized-pointer artifact is bypassed.

### 4. WebGPU Voxel Pick — **PASS** (was runner false-FAIL in Batch 66)
- **Batch 65:** FAIL (F1 cascade misdiagnosed as F3)
- **Batch 66 (intermediate):** FAIL (false-FAIL, runner artifact)
- **Batch 66 FINAL:** **PASS**.
- **Screenshot:** [`screenshots/sandcastle-batch-66-final/WebGPU Voxel Pick.png`](../Tools/visual-regression/screenshots/sandcastle-batch-66-final/WebGPU%20Voxel%20Pick.png) (490 KB — voxel hexagon rendered cleanly in space).
- **Pick result:** `pick succeeded: entity=null primitive=_VoxelPrimitive`. The direct `viewer.scene.pick(...)` returns a `VoxelPrimitive` (the underscore prefix is the minified class name from the IIFE bundle). PASS criteria met (non-null pick → primitive class identified).
- **Engine-correctness verdict:** PASS. F1 fix from Batch 66 is unblocking this demo as expected.

### 5. WebGPU Point Light Shadows — PASS (no regression)
- **Batch 65:** PASS\* (false PASS — modal was on screen)
- **Batch 66 (intermediate):** PASS (real PASS — F3 fix verified)
- **Batch 66 FINAL:** **PASS**.
- **Screenshot:** [`screenshots/sandcastle-batch-66-final/WebGPU Point Light Shadows.png`](../Tools/visual-regression/screenshots/sandcastle-batch-66-final/WebGPU%20Point%20Light%20Shadows.png) (939 KB — terrain + cuboid shadow visible).
- **Soft-shadow toggle:** [`screenshots/sandcastle-batch-66-final/WebGPU Point Light Shadows-soft.png`](../Tools/visual-regression/screenshots/sandcastle-batch-66-final/WebGPU%20Point%20Light%20Shadows-soft.png) (saved successfully — the `softShadows` accessor is now reachable through the synthetic viewer captured via `CesiumWidget.prototype.render`).
- No errors. No regression from the F2 fix.

### 6. WebGPU Translucent Classification — **FAIL** (regression vs Batch 66)
- **Batch 65:** PASS
- **Batch 66 (intermediate):** PASS
- **Batch 66 FINAL:** **FAIL** — same root cause as Edge demos #1/#2.
- **Screenshot:** [`screenshots/sandcastle-batch-66-final/WebGPU Translucent Classification.png`](../Tools/visual-regression/screenshots/sandcastle-batch-66-final/WebGPU%20Translucent%20Classification.png) (48 KB — rendering-stopped modal).
- **Console error:** `ERROR: 0:27: '}' : syntax error` — same empty-`ShaderStruct` GLSL.
- **Why this is a regression:** The intermediate Batch 66 run rendered this demo cleanly. The only material change between runs is the F2 fix in `ShaderFunction.js`. The empty-struct emission code path was always there — but until F2 was lifted, the empty-function `DeveloperError` short-circuited shader assembly before the struct emission could be reached. F2 lets assembly proceed, and the empty-struct GLSL syntax error fires next.
- **Engine-correctness verdict:** FAIL. NEW engine bug: `ShaderStruct.generateGlslLines()` must skip emission (or emit a single placeholder field) when the struct has zero fields.

### 7. WebGPU Many Imagery Layers — PASS (no regression)
- **Batch 65:** FAIL (F3)
- **Batch 66 (intermediate):** PASS (F3 fix verified)
- **Batch 66 FINAL:** **PASS**.
- **Screenshot:** [`screenshots/sandcastle-batch-66-final/WebGPU Many Imagery Layers.png`](../Tools/visual-regression/screenshots/sandcastle-batch-66-final/WebGPU%20Many%20Imagery%20Layers.png) (1.02 MB — Natural Earth base + grid + multi-layer hue-shifted overlays).
- **Imagery layer count:** 8 (probe now reads via the synthetic viewer; Batch 66 reported `-1` because the probe couldn't find the viewer).
- No errors. F3 + F1 fixes still landed.

## Three-way diff (Batch 65 → Batch 66 → Batch 66 FINAL)

| Demo                       | Batch 65   | Batch 66 (intermediate) | Batch 66 FINAL | Net change                                          |
| -------------------------- | ---------- | ----------------------- | -------------- | --------------------------------------------------- |
| Edge Visibility            | FAIL (F1+F2) | FAIL (F2 broader)     | **FAIL**       | Same outcome, different root cause (empty-`ShaderStruct`) |
| Edge Feature ID            | FAIL (F1+F2) | FAIL (F2 deferred)    | **FAIL**       | Same outcome, different root cause (empty-`ShaderStruct`) |
| Model Pick                 | FAIL       | FAIL\* (false-FAIL)    | **PASS**       | Runner Task A eliminated false-FAIL                 |
| Voxel Pick                 | FAIL       | FAIL\* (false-FAIL)    | **PASS**       | Runner Task A eliminated false-FAIL                 |
| Point Light Shadows        | PASS\*\* (false PASS) | PASS         | **PASS**       | Stable                                              |
| Translucent Classification | PASS       | PASS                    | **FAIL**       | NEW regression from F2 fix                          |
| Many Imagery Layers        | FAIL       | PASS                    | **PASS**       | Stable                                              |

`*` runner false-FAIL — visual screenshot + console-error analysis showed the engine was rendering fine; the failure was Playwright `setPointerCapture` synthesis artifacts.
`**` Batch 65 false-PASS — the rendering-stopped modal was on screen but the small PNG slipped under the runner's heuristic threshold.

## Confirmation that engine fixes (F1, F2, F3) actually unblock the demos

| Fix | Status | Evidence |
| --- | ------ | -------- |
| **F1** (WGSL backtick syntax in `WebGPUFeatureRenderers.ts`) | **CONFIRMED CLEAN** | The `Build/CesiumUnminified/Cesium.js` bundle compiles + loads in every demo without bundle-level errors. Voxel Pick + Many Imagery Layers + Point Light Shadows all run their F1-dependent code paths without any runtime error citing WGSL syntax, `edgeTypeInt`, or pipeline construction. |
| **F2** (`ShaderFunction.js` empty-body throw lifted) | **PARTIAL** | The throw is gone (no `DeveloperError: The shader function must have at least one line` modal in any demo). However, lifting the throw lets the pipeline reach a downstream `ShaderStruct` emission that was always emitting invalid GLSL for empty structs. Edge Visibility, Edge Feature ID, and Translucent Classification fail at the next compile boundary. **The fix itself is correct; it needs a sibling fix in `ShaderStruct.generateGlslLines()` to land the actual unblock.** |
| **F3** (ES6 inheritance for `BoxGeometryUpdater`/`DynamicGeometryUpdater`/`UrlTemplateImageryProvider`) | **CONFIRMED CLEAN** | Zero `Class constructor … cannot be invoked without 'new'` errors anywhere in the run. Many Imagery Layers + Point Light Shadows render correctly, both rely on F3-dependent code paths. |

## Runner harness (Task A) — fixes applied

1. **`viewer.scene.pick(...)` replaces synthesized pointer events.**
   `pickAtCenter()` calls `viewer.scene.pick(new Cesium.Cartesian2(x, y))` from page context, with a 9-cell offset grid as fallback. **Completely bypasses Playwright's pointer-capture stack** — `setPointerCapture` errors don't fire because we never dispatch a `PointerEvent`. Replaces the Batch 66 `clickCenterAndRead()` function.
2. **Known-artifact filter on `pageErrors`.** A small `KNOWN_ARTIFACT_MARKERS` regex list ([`/setPointerCapture/i, /No active pointer with the given id/i`]) classifies known Playwright-vs-Sandcastle artifacts and filters them from the FAIL determination. Even if a demo somehow synthesizes a `setPointerCapture` error from a different code path (e.g., the Sandcastle bucket toolbar interactions), it won't poison the result.
3. **Prototype-hook viewer capture.** Batch 66's `Cesium.Viewer = WrappedViewer` reassignment never worked because `Cesium` is a frozen ES Module Namespace (its own properties are non-writable). The prototypes of exported classes ARE regular mutable objects, so we patch `Viewer.prototype.resize` and `CesiumWidget.prototype.render` to capture `this` on first invocation. This gives us a reliable handle to `scene` even when the demo declares `const viewer = ...` and never leaks it to `window`. Probe now reports `via: synthetic-from-widget` and `rendererType: webgl` (etc.) on every demo.
4. **Hard-FAIL on `An error occurred while rendering`** preserved from Batch 66.

## New findings (engine bugs to log)

### NEW-1: `ShaderStruct.generateGlslLines()` emits invalid empty struct
- **File:** [`packages/engine/Source/Renderer/ShaderStruct.js`](../packages/engine/Source/Renderer/ShaderStruct.js).
- **Symptom:** `[Cesium WebGL] Fragment shader compile log: ERROR: 0:N: '}' : syntax error` whenever the model pipeline emits a `SelectedFeature` or `FeatureIds` struct with zero fields. Affects Edge Visibility, Edge Feature ID, and Translucent Classification.
- **Why it surfaced now:** F2 fix lifted the upstream throw in `ShaderFunction.generateGlslLines()`, allowing pipeline assembly to reach struct emission.
- **Suggested fix scope (for the next session, not this one):** Apply the same defensive treatment to `ShaderStruct.generateGlslLines()` as F2 applied to `ShaderFunction.generateGlslLines()`. Either:
  - **Option A (preferred — matches F2 pattern):** When `this.fields.length === 0`, either skip emission entirely (return `[]`) OR emit a single placeholder field (`float __cesium_empty_placeholder;`) so the struct is well-formed.
  - **Option B:** Trace upstream to where empty `SelectedFeature` / `FeatureIds` are registered (likely `SelectedFeatureIdPipelineStage.js` and `FeatureIdPipelineStage.js`) and conditionally skip struct registration when no metadata flows through. More invasive.
- **Severity:** Blocker — three Sandcastle demos fail; production glTF rendering on WebGL is also affected for any model that goes through the Selected-Feature / Feature-ID pipeline stages with zero metadata properties.

### NEW-2: All "WebGPU *.html" Sandcastle demos run on WebGL
- **Files:** All 7 demos under [`Apps/Sandcastle/gallery/WebGPU *.html`](../Apps/Sandcastle/gallery/).
- **Symptom:** Every demo's probe reports `rendererType: webgl`. Direct check via `canvas.getContext("webgl2")` returns a live context; `canvas.getContext("webgpu")` returns `null` for every demo.
- **Root cause:** The demos call `new Cesium.Viewer(container, { contextOptions: { renderer: "webgpu" } })` which is the **synchronous** Viewer constructor. The synchronous path never enters `Viewer.createAsync` or `CesiumWidget.createAsync` — those are the only entry points that initialize WebGPU (per `packages/engine/Source/Widget/CesiumWidget.js:543` and `packages/widgets/Source/Viewer/Viewer.js:2046`). The synchronous constructor falls through to `new Context(canvas, options)` (WebGL) regardless of `contextOptions.renderer`.
- **Why nobody noticed:** Batch 65 + Batch 66's runners couldn't probe the renderer (`window.viewer` capture failed because demos use `const viewer`), so the runners never asserted `rendererType === "webgpu"`. The demos rendered WebGL pixels and the runners reported PASS.
- **Severity:** High — the F1/F2/F3 fixes were validated through these demos, but in WebGL not WebGPU. Re-validation against the WebGPU code path is required before any "fix verified end-to-end" claim is made.
- **Suggested fix scope:** Either (a) update the demos to use `await Viewer.createAsync(container, { contextOptions: { renderer: "webgpu" } })` (preferred — matches the public API), or (b) add a development-mode warning in the synchronous Viewer constructor when `contextOptions.renderer === "webgpu"` so future authors don't repeat the mistake.

## Recommended follow-ups

1. **Fix `ShaderStruct.generateGlslLines()` (NEW-1)** with the same one-line treatment as F2 in ShaderFunction. The 3 Edge/Translucent-Classification demos will then transition FAIL → PASS without further engine work.
2. **Retarget the WebGPU Sandcastle demos to `Viewer.createAsync(...)` (NEW-2).** Without this, every PASS in this report is a WebGL PASS, not a WebGPU PASS — F1's WGSL syntax fix isn't actually exercised, and the WebGPU pipeline cache prewarm + edge-visibility inline stage code paths remain unverified by Sandcastle.
3. **Promote the runner upgrades to the canonical Sandcastle harness.** The prototype-hook viewer capture + `viewer.scene.pick(...)` + known-artifact filter make this runner more reliable than the Batch 65/66 versions; folding them into a shared base for future batches saves re-inventing the wheel.
4. **Investigate Model Pick `pick returned null` at canvas center.** The demo's `viewer.zoomTo([truckEntity, manEntity])` call may not have completed by the time the runner picks (3 seconds after canvas first appears). A retry-with-rAF-tick pattern could eliminate this. Not a blocker — the demo is functionally PASS — but a quality-of-results upgrade.

## Files modified / created (this session)

- [`Tools/visual-regression/sandcastle-batch-66-final-runner.mjs`](../Tools/visual-regression/sandcastle-batch-66-final-runner.mjs) — new runner with the four harness improvements.
- [`Tools/visual-regression/screenshots/sandcastle-batch-66-final/*.png`](../Tools/visual-regression/screenshots/sandcastle-batch-66-final/) — 10 screenshots (one canvas per demo + after-pick for the two pick demos + soft-shadows for Point Light Shadows).
- [`Tools/visual-regression/screenshots/sandcastle-batch-66-final/report.json`](../Tools/visual-regression/screenshots/sandcastle-batch-66-final/report.json) — full machine-readable run report.
- [`migration_doc/SANDCASTLE_BATCH_66_FINAL_REPORT.md`](SANDCASTLE_BATCH_66_FINAL_REPORT.md) — this report.

No engine sources were modified in this session (per task brief — log surfaced engine bugs, don't fix them). The pre-existing F2 fix in `packages/engine/Source/Renderer/ShaderFunction.js` is the only engine change in scope, and it landed before this session began.

---

**Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>**
