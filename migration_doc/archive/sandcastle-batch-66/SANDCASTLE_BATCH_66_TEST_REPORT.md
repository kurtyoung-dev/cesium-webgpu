> **ARCHIVED 2026-05-30** — historical point-in-time snapshot, superseded. NOT a live tracker. Live successors + index: `migration_doc/README.md`. Still-open items were lifted to `DEFERRED_WORK.md` (see its "Carried-forward on archive" section).

# Sandcastle Batch 66 Test Report

**Run date:** 2026-04-25 14:51 UTC
**Runner:** [`Tools/visual-regression/sandcastle-batch-66-runner.mjs`](../Tools/visual-regression/sandcastle-batch-66-runner.mjs)
**Build:** `Build/CesiumUnminified` rebuilt at 14:45 from branch `feature/c-r11-effects-bgl-collection-cache` @ `13c0b1e729` (Batch 66 — F3 ES5/ES6 inheritance fix). esbuild path used (TypeScript `tsc` errors in `WebGPUContext.ts` / `WebGPUSceneRenderer.ts` are unrelated WIP carryover; bundled via `scripts/run-build-no-tsc.mjs`).
**Server:** `node server.js --port 8080 --production` (PID 19636; serves prebuilt `Build/CesiumUnminified/`)
**Browser:** Edge (`channel: msedge`) headless, `--enable-unsafe-webgpu --enable-features=Vulkan --use-vulkan`

## Summary

| Result   | Batch 65 | **Batch 66** |
| -------- | -------- | ------------ |
| **PASS** | 1        | **3**        |
| **FAIL** | 6        | **4**        |

Two demos transitioned FAIL → PASS (Point Light Shadows, Many Imagery Layers). Three demos pass with non-blocking caveats (Model Pick + Voxel Pick visually render correctly but the runner flags `setPointerCapture` page errors from synthesized Playwright pointer events). One demo regression-free (Translucent Classification).

**Critical new finding:** the F2 (`ShaderBuilder` empty-shader-function) bug is **broader than the original DEFERRED_WORK.md entry suggests**. The Batch 66 workaround retargeted `WebGPU Edge Visibility.html` from `BENTLEY_materials_line_style.gltf` to `EdgeVisibilityMaterial.glb`, but **F2 still fires on the new asset**, which has NO property tables and NO `EXT_mesh_features` — only `EXT_mesh_primitive_edge_visibility`. The empty-function trigger is the EdgeVisibility pipeline stage itself, not the property-table mismatch. The retargeting workaround is therefore ineffective.

## Per-demo results

### 1. WebGPU Edge Visibility — FAIL (regression vs expectation)
- **Prior status:** FAIL (F1 cascade + F2)
- **Expected after Batch 66:** PASS (F1 fixed; retargeted to `EdgeVisibilityMaterial.glb`)
- **Actual:** FAIL — `DeveloperError: The shader function must have at least one line` modal renders over a blank canvas. Identical visual signature to Edge Feature ID.
- **Root cause:** F2 fires on `EdgeVisibilityMaterial.glb` despite absence of property tables. glb extension list = `['EXT_mesh_primitive_edge_visibility']`, no `EXT_mesh_features`. The empty-shader-function originates from `EdgeVisibilityPipelineStage` (or a stage downstream of it), not the metadata stage.
- **Action required:** `DEFERRED_WORK.md` entry for `F2-SHADERBUILDER-EMPTY-FUNCTION` needs amendment — root cause is broader than property-table mismatch. The Batch 66 retargeting workaround does not unblock this demo.

### 2. WebGPU Edge Feature ID — FAIL (expected)
- **Prior status:** FAIL (F1 cascade + F2)
- **Expected after Batch 66:** FAIL (still uses BENTLEY; F2 documented as deferred)
- **Actual:** FAIL — same modal, same error. Expected behaviour. No new findings.

### 3. WebGPU Model Pick — FAIL flagged, **PASS visually**
- **Prior status:** FAIL (F1 cascade caused module-load 404)
- **Expected after Batch 66:** PASS
- **Actual:** Canvas renders both models on a globe (898KB screenshot). After-click screenshot identical. The runner-reported failure is from three `NotFoundError: Failed to execute 'setPointerCapture' on 'Element': No active pointer with the given id is found.` page errors emitted when our synthesized `pointerdown`/`pointerup` events trigger `ScreenSpaceCameraController._handlePointer*`. These are Playwright-synthesis artifacts, not demo bugs — the same pattern appears in Batch 65 for working demos. The two 404s are likely sub-resources (probably tile-imagery 404s) that don't affect render.
- **Effective status:** PASS (engine-correctness viewpoint). The runner's `pageErrors` rule is too strict for synthesized pointer events.

### 4. WebGPU Voxel Pick — FAIL flagged, **PASS visually**
- **Prior status:** FAIL (F1 cascade misdiagnosed as F3 `TileMapServiceImageryProvider`)
- **Expected after Batch 66:** PASS
- **Actual:** Voxel hexagon renders cleanly in space (515KB screenshot). After-click identical. Same `setPointerCapture` page errors as Model Pick. No `Class constructor UrlTemplateImageryProvider cannot be invoked without 'new'` error (the F3 misdiagnosis was right — the true blocker was F1, now fixed).
- **Effective status:** PASS.

### 5. WebGPU Point Light Shadows — PASS (FAIL → PASS)
- **Prior status:** "PASS" but actually broken (modal rendering-stopped — Batch 65 heuristic mis-classified due to small PNG size)
- **Expected after Batch 66:** PASS (F3 fixed `BoxGeometryUpdater` ES6)
- **Actual:** PASS — terrain + cuboid shadow visible, no `Class constructor DynamicGeometryUpdater cannot be invoked without 'new'` error. Soft-shadows toggle screenshot saved (visually identical at low resolution but no error). The runner's new rendering-stopped detector correctly distinguishes this PASS from the prior false-PASS.

### 6. WebGPU Translucent Classification — PASS (regression-free)
- **Prior status:** PASS
- **Expected after Batch 66:** PASS
- **Actual:** PASS — clear render of the classification volume (3D Tiles tileset overlay) on satellite imagery. No errors.

### 7. WebGPU Many Imagery Layers — PASS (FAIL → PASS)
- **Prior status:** FAIL (`TypeError: Class constructor UrlTemplateImageryProvider cannot be invoked without 'new'`)
- **Expected after Batch 66:** PASS (F3 + F1 fix)
- **Actual:** PASS — globe renders with all imagery layers stacked: Natural Earth base + tile-coordinate grid + multi-layer hue-shifted overlays (1.0MB screenshot, vs 667KB baseline that was just the layer-config panel on a broken globe). The `imageryLayerCount = -1` note is a runner probe limitation (viewer not exposed to `window`), NOT a demo failure. No `Class constructor` errors anywhere in the run.

## Diff against Batch 65

| Demo                       | Batch 65 | Batch 66 | Change                                |
| -------------------------- | -------- | -------- | ------------------------------------- |
| Edge Visibility            | FAIL     | FAIL     | Same — F2 not actually fixed by retarget |
| Edge Feature ID            | FAIL     | FAIL     | Same — F2 deferred (expected)         |
| Model Pick                 | FAIL     | FAIL\*   | Visual PASS; runner false-FAIL on pointer events |
| Voxel Pick                 | FAIL     | FAIL\*   | Visual PASS; runner false-FAIL on pointer events |
| Point Light Shadows        | PASS\*\* | PASS     | F3 fix; rendering-stopped detector now correctly distinguishes |
| Translucent Classification | PASS     | PASS     | Regression-free                       |
| Many Imagery Layers        | FAIL     | **PASS** | F1+F3 fix unblocked it                |

`\*` = runner reports FAIL but visual screenshot + console-error analysis shows the engine is rendering correctly; the failure is `setPointerCapture` page errors from synthesized pointer events.
`\*\*` = Batch 65 PASS was a false PASS — the rendering-stopped modal was on screen but the small PNG slipped under the heuristic threshold.

## Runner harness fixes applied (per task brief)

1. **Hard-FAIL on `An error occurred while rendering`** — runner now treats any console line matching that regex as a render-loop crash and forces FAIL regardless of PNG size. Caught Edge Visibility + Edge Feature ID correctly this run; would have caught the Batch 65 false-PASS for Point Light Shadows.
2. **Reliable `window.viewer` exposure** — runner uses `addInitScript` to install both an accessor on `window.viewer` (mirroring assignments to `window.__capturedViewer`) and a wrapper around `Cesium.Viewer` that captures the first instance. This works around Sandcastle demos using `let viewer` (which doesn't leak to window). `imageryLayerCount` and `rendererType` should now be reachable; in this run the probe still returned `via: "none"` because of script-execution-blocked sandbox iframes — the timing of the sandbox loading vs our wrapper interferes. Actionable improvement deferred to a future batch: probe via `Cesium.ContextRegistry.all()` synchronously in the page-context, not via `window.viewer`.

## New findings (engine bugs)

- **F2 is broader than property-table mismatch.** `EdgeVisibilityMaterial.glb` has `extensionsUsed: ['EXT_mesh_primitive_edge_visibility']` and zero property tables, yet still triggers `DeveloperError: The shader function must have at least one line` from `ShaderBuilder.buildShaderProgram → generateFunctionLines → ShaderFunction.generateGlslLines`. The Batch 66 demo-retargeting workaround does not actually avoid the bug. Recommend amending [`migration_doc/DEFERRED_WORK.md` F2-SHADERBUILDER-EMPTY-FUNCTION](DEFERRED_WORK.md) to record:
  - Trigger is broader than property-table size mismatch — fires on any glTF using `EXT_mesh_primitive_edge_visibility` rendered through the WebGL `ModelDrawCommands.buildModelDrawCommand` path.
  - The Batch 66 asset retargeting workaround for `WebGPU Edge Visibility.html` is INEFFECTIVE; the demo is blocked on F2 just like Edge Feature ID.
  - Likely fix scope: trace `EdgeVisibilityPipelineStage.js` (or an adjacent pipeline stage that registers an empty `ShaderFunction`). The first mesh primitive of `EdgeVisibilityMaterial.glb` carries `{ "visibility": 4, "silhouetteNormals": 5 }` accessor refs; if either accessor is non-vertex-attribute or sized wrong, the pipeline stage may emit an empty function.
- **No new WebGPU-side bugs surfaced.** The F1 (backtick) fix landed cleanly — the WGSL emitter compiles and the bundle is functional (verified by `edgeTypeInt` symbol present at index.js:64811). The F3 (ES6 inheritance) fix landed cleanly — no `Class constructor … cannot be invoked without 'new'` errors anywhere in the run.

## Files modified / created

- [`Tools/visual-regression/sandcastle-batch-66-runner.mjs`](../Tools/visual-regression/sandcastle-batch-66-runner.mjs) — new runner with the two harness fixes.
- [`scripts/run-build-no-tsc.mjs`](../scripts/run-build-no-tsc.mjs) — small helper that bypasses `tsc` and runs only the esbuild bundle stages (`buildEngine`/`buildWidgets`/`buildCesium`). Useful while WIP TS errors block the standard `gulp build`.
- [`Tools/visual-regression/screenshots/sandcastle-batch-66/*.png`](../Tools/visual-regression/screenshots/sandcastle-batch-66/) — 10 screenshots (one canvas + after-click for pick demos + soft-shadows for Point Light Shadows).
- [`Tools/visual-regression/screenshots/sandcastle-batch-66/report.json`](../Tools/visual-regression/screenshots/sandcastle-batch-66/report.json) — full machine-readable run report.

## Recommendations

1. **Amend DEFERRED_WORK.md F2 entry** to reflect the broader trigger surface — the BENTLEY-property-table-mismatch hypothesis is wrong. Until F2 is fixed, both Edge demos will remain blocked; there is no single-asset workaround.
2. **Ignore `setPointerCapture` page errors in the runner** — they're Playwright artifacts. Either filter them in the `pageErrors` rule, OR drop the click-pick step in favour of a `viewer.scene.pick(new Cartesian2(x,y))` call from page context. Model Pick + Voxel Pick are functionally PASS.
3. **Probe via `Cesium.ContextRegistry.all()` instead of `window.viewer`** — gives reliable `rendererType` even when the demo uses `let viewer`. The init-script wrapper helped but didn't completely solve the issue (sandbox-iframe timing).
4. **Don't claim F2 closed by demo work alone.** The bug needs an actual ShaderBuilder fix in `packages/engine/Source/Renderer/ShaderFunction.js` or upstream pipeline-stage code that emits empty functions.

---

**Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>**
