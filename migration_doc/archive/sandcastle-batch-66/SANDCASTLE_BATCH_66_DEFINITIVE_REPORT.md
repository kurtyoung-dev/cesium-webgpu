> **ARCHIVED 2026-05-30** — historical point-in-time snapshot, superseded. NOT a live tracker. Live successors + index: `migration_doc/README.md`. Still-open items were lifted to `DEFERRED_WORK.md` (see its "Carried-forward on archive" section).

# Sandcastle Batch 66 DEFINITIVE Test Report

**Run date:** 2026-04-25 19:20 UTC
**Runner:** [`Tools/visual-regression/sandcastle-batch-66-final-runner.mjs`](../Tools/visual-regression/sandcastle-batch-66-final-runner.mjs) (unmodified — Task B reused the existing runner)
**Build:** `Build/CesiumUnminified` rebuilt at 19:18 UTC via `node scripts/run-build-no-tsc.mjs`. Rebuild picks up:
- **NEW-1 fix** — `packages/engine/Source/Renderer/ShaderStruct.js` empty-body filler (`float _empty;` when no fields). Sibling fix to F2 (the `ShaderFunction` empty-body lift). Verified present in `Build/CesiumUnminified/Cesium.js:99637`.
- **F2 fix** (still in place from prior session).
- All renderer changes through Batch 66.

**Server:** `node server.js --port 8080 --production` (already running on 8080).
**Browser:** Edge (`channel: msedge`) headless, `--enable-unsafe-webgpu --enable-features=Vulkan --use-vulkan`.
**Report data:** `Tools/visual-regression/screenshots/sandcastle-batch-66-final/report.json`
**Screenshots:** `Tools/visual-regression/screenshots/sandcastle-batch-66-final/*.png`

---

## TL;DR

For the **first time ever**, all 7 WebGPU demos actually ran on the WebGPU backend (`rendererType: "webgpu"` confirmed via `synthetic-from-widget` probe in every result). Switching the demos to `Viewer.createAsync(...)` was the prerequisite to exercise any of the renderer code shipped in Batches 48-66.

That visibility immediately surfaced **three real engine bugs** (NEW-3-A / NEW-3-B / NEW-3-C) that the WebGL fallback masked. Per task constraint ("Don't fix engine bugs if a demo surfaces one — log them"), these are logged below for follow-up sessions, not fixed in this pass.

| Result   | Batch 65 | Batch 66 (intermediate) | Batch 66 FINAL | **DEFINITIVE** |
| -------- | -------- | ----------------------- | -------------- | -------------- |
| **PASS** | 1        | 3                       | 4              | **0**          |
| **FAIL** | 6        | 4                       | 3              | **7**          |
| Backend  | WebGL    | WebGL                   | WebGL          | **WebGPU**     |

The PASS regression from 4 → 0 is **not a regression in shipped code** — it is the discovery that none of the prior PASS results actually exercised WebGPU. The four prior "PASS"es were the WebGL fallback rendering successfully. The DEFINITIVE run is the first honest measurement of the WebGPU code path under these demos.

---

## Task A — Demo conversions (NEW-2 closure)

All 7 demos converted from sync `new Cesium.Viewer(container, opts)` to `await Cesium.Viewer.createAsync(container, opts)`:

| Demo                                              | Line       | Status |
| ------------------------------------------------- | ---------- | ------ |
| `Apps/Sandcastle/gallery/WebGPU Edge Visibility.html`             | 116 | DONE |
| `Apps/Sandcastle/gallery/WebGPU Edge Feature ID.html`             | 105 | DONE |
| `Apps/Sandcastle/gallery/WebGPU Model Pick.html`                  | 82  | DONE |
| `Apps/Sandcastle/gallery/WebGPU Voxel Pick.html`                  | 78  | DONE |
| `Apps/Sandcastle/gallery/WebGPU Point Light Shadows.html`         | 78  | DONE |
| `Apps/Sandcastle/gallery/WebGPU Many Imagery Layers.html`         | 111 | DONE |
| `Apps/Sandcastle/gallery/WebGPU Translucent Classification.html`  | 76  | DONE |

Each demo's `window.startup` is already `async function (Cesium) { ... }` so `await` is in scope. `contextOptions: { renderer: "webgpu" }` was already present and is preserved. No demo creates a separate `CesiumWidget` — Viewer is the only construction site per file. Pattern follows [`Apps/CesiumViewer/CesiumViewer.js:89-98`](../Apps/CesiumViewer/CesiumViewer.js).

---

## Task B — Definitive runner results

### 1. WebGPU Edge Visibility — FAIL (NEW-3-A)

- **rendererType:** `webgpu` (via `synthetic-from-widget`)
- **Screenshot:** [`WebGPU Edge Visibility.png`](../Tools/visual-regression/screenshots/sandcastle-batch-66-final/WebGPU%20Edge%20Visibility.png) — 36 KB, rendering-stopped modal over partial canvas.
- **Root cause (NEW-3-A):** `ReferenceError: scene is not defined` thrown from `WebGPUSceneRenderer._ensureResources` ([`packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts:725-727`](../packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts)). The Batch 44 edge-FBO addition references `scene._enableEdgeVisibility` but the function only destructures `{ context }` from the config — `scene` is not in scope. Ironically the empty-edge-flag check itself crashes before any edge resource is even allocated. This is the dominant blocker — 5 of 7 demos hit it on frame 1.
- **History:**
  - Batch 65: FAIL (cascading WebGL F1 errors)
  - Batch 66 intermediate: FAIL (ShaderFunction empty-body)
  - Batch 66 FINAL: FAIL (ShaderStruct empty-body — running on WebGL fallback)
  - **DEFINITIVE: FAIL** (NEW-3-A in WebGPU `_ensureResources`)
- **Closed by:** NEW-1 (ShaderStruct fix lets the pipeline progress past struct emission), NEW-2 (demo now actually on WebGPU). **Blocked by:** NEW-3-A.

### 2. WebGPU Edge Feature ID — FAIL (NEW-3-A)

- **rendererType:** `webgpu` (via `synthetic-from-widget`)
- **Screenshot:** [`WebGPU Edge Feature ID.png`](../Tools/visual-regression/screenshots/sandcastle-batch-66-final/WebGPU%20Edge%20Feature%20ID.png) — 35 KB.
- **Root cause:** Same NEW-3-A `scene is not defined` in `_ensureResources`.
- **History:** Same trajectory as Edge Visibility.
- **Closed by:** NEW-1, NEW-2. **Blocked by:** NEW-3-A.

### 3. WebGPU Model Pick — FAIL (NEW-3-A + pick null)

- **rendererType:** `webgpu` (via `synthetic-from-widget`)
- **Screenshot:** [`WebGPU Model Pick.png`](../Tools/visual-regression/screenshots/sandcastle-batch-66-final/WebGPU%20Model%20Pick.png) — 34 KB.
- **Root cause:** NEW-3-A render-loop crash (same as above). Pick at canvas-center returned `null` — but that is downstream of the render-loop crash; primitives never finished initializing because the render loop stopped on frame 1.
- **History:**
  - Batch 65: FAIL
  - Batch 66 intermediate / FINAL: PASS (false PASS — was on WebGL fallback)
  - **DEFINITIVE: FAIL** (real WebGPU bug surfaced)
- **Closed by:** NEW-1, NEW-2. **Blocked by:** NEW-3-A.

### 4. WebGPU Voxel Pick — FAIL (NEW-3-C, then NEW-3-A masked)

- **rendererType:** `webgpu` (via `synthetic-from-widget`)
- **Screenshot:** [`WebGPU Voxel Pick.png`](../Tools/visual-regression/screenshots/sandcastle-batch-66-final/WebGPU%20Voxel%20Pick.png) — 37 KB.
- **Root cause (NEW-3-C):** `RuntimeError: The GL context does not support a 3D texture large enough to contain a tile with the given dimensions` thrown from `Megatexture.get3DTextureDimension` ([`Build/CesiumUnminified/index.js:312077`](../Build/CesiumUnminified/index.js)). `Megatexture` (Voxels feature) is hard-coded to read WebGL `GL` capability constants and assumes a `WebGL2RenderingContext`. On WebGPU the cap-query path returns `undefined` / wrong type, so the dimension validation throws unconditionally. The voxel feature was never WebGPU-ported.
- **History:**
  - Batch 65: FAIL
  - Batch 66 intermediate / FINAL: PASS (false PASS — was on WebGL fallback, where `Megatexture` works)
  - **DEFINITIVE: FAIL** (WebGPU has never had `Megatexture` ported)
- **Closed by:** NEW-1, NEW-2. **Blocked by:** NEW-3-C (and NEW-3-A would hit on subsequent frames anyway).

### 5. WebGPU Point Light Shadows — FAIL (NEW-3-B)

- **rendererType:** `webgpu` (via `synthetic-from-widget`)
- **Screenshot:** [`WebGPU Point Light Shadows.png`](../Tools/visual-regression/screenshots/sandcastle-batch-66-final/WebGPU%20Point%20Light%20Shadows.png) — 38 KB.
- **Root cause (NEW-3-B):** `TypeError: Cannot read properties of undefined (reading 'device')` thrown from `initWebGPUShadowMap` ([`Build/CesiumUnminified/index.js:46929`](../Build/CesiumUnminified/index.js)) called by `ShadowMap.update`. The shadow-map WebGPU init helper is reaching into something (likely `context.device` or `frameState.context.device`) that's not yet populated at the call site. This is distinct from NEW-3-A — NEW-3-B fires before `_ensureResources` because shadows update earlier in the frame.
- **History:**
  - Batch 65 / 66 intermediate / FINAL: FAIL or false PASS (always WebGL fallback)
  - **DEFINITIVE: FAIL** (real WebGPU bug surfaced — first time the WebGPU shadow path was actually exercised)
- **Closed by:** NEW-1, NEW-2. **Blocked by:** NEW-3-B.

### 6. WebGPU Many Imagery Layers — FAIL (NEW-3-A)

- **rendererType:** `webgpu` (via `synthetic-from-widget`)
- **imageryLayerCount:** `1` (expected ≥8 — the demo's layer setup never ran because render loop crashed on frame 1)
- **Screenshot:** [`WebGPU Many Imagery Layers.png`](../Tools/visual-regression/screenshots/sandcastle-batch-66-final/WebGPU%20Many%20Imagery%20Layers.png) — 53 KB (largest because the partial frame shows the default base layer).
- **Root cause:** NEW-3-A.
- **History:** Same trajectory as Edge Visibility.
- **Closed by:** NEW-1, NEW-2. **Blocked by:** NEW-3-A.

### 7. WebGPU Translucent Classification — FAIL (NEW-3-A)

- **rendererType:** `webgpu` (via `synthetic-from-widget`)
- **Screenshot:** [`WebGPU Translucent Classification.png`](../Tools/visual-regression/screenshots/sandcastle-batch-66-final/WebGPU%20Translucent%20Classification.png) — 32 KB.
- **Root cause:** NEW-3-A.
- **History:**
  - Batch 65 / 66 intermediate: FAIL
  - Batch 66 FINAL: FAIL (NEW-1's predecessor was suspected here)
  - **DEFINITIVE: FAIL** (NEW-3-A — WebGPU path entered for first time)
- **Closed by:** NEW-1, NEW-2. **Blocked by:** NEW-3-A.

---

## 4-way diff

| Demo                              | Batch 65 | Batch 66 intermediate | Batch 66 FINAL    | **DEFINITIVE**                  |
| --------------------------------- | -------- | --------------------- | ----------------- | ------------------------------- |
| WebGPU Edge Visibility            | FAIL (F1)        | FAIL (F2)         | FAIL (NEW-1 absent)         | **FAIL (NEW-3-A)**       |
| WebGPU Edge Feature ID            | FAIL (F1)        | FAIL (F2)         | FAIL (NEW-1 absent)         | **FAIL (NEW-3-A)**       |
| WebGPU Model Pick                 | FAIL (F1)        | PASS\* (WebGL)    | PASS\* (WebGL)              | **FAIL (NEW-3-A)**       |
| WebGPU Voxel Pick                 | FAIL (F1)        | PASS\* (WebGL)    | PASS\* (WebGL)              | **FAIL (NEW-3-C)**       |
| WebGPU Point Light Shadows        | FAIL (F1)        | FAIL              | FAIL                        | **FAIL (NEW-3-B)**       |
| WebGPU Many Imagery Layers        | FAIL (F1)        | FAIL              | PASS\* (WebGL)              | **FAIL (NEW-3-A)**       |
| WebGPU Translucent Classification | PASS\* (WebGL)   | FAIL (NEW-1 absent) | FAIL (NEW-1 absent)       | **FAIL (NEW-3-A)**       |

`PASS*` = the demo's WebGL fallback rendered successfully because `new Cesium.Viewer(...)` ignored `contextOptions: { renderer: "webgpu" }` and silently fell back to WebGL.

---

## Engine fixes that closed previously-failing demos

| Fix    | Where                                                      | What it closed                                                                              |
| ------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| F1     | DynamicGeometryUpdater 9-class ES5/ES6 inheritance         | Batch 65 cascade (all 7 demos)                                                              |
| F2     | `ShaderFunction.generateGlslLines()` empty-body filler     | Empty `initializeMetadata()` no longer throws during GLSL assembly                          |
| F3     | Various Batch 66 intermediate fixes                        | Already documented in `SANDCASTLE_BATCH_66_FINAL_REPORT.md`                                 |
| NEW-1  | `ShaderStruct.generateGlslLines()` empty-body filler       | Empty `SelectedFeature` / `FeatureIds` structs no longer produce illegal GLSL `struct X { };` |
| NEW-2  | All 7 `WebGPU *.html` demos: sync → `Viewer.createAsync`   | Demos now actually use the WebGPU backend (`rendererType: "webgpu"` confirmed)              |

---

## STILL-failing demos & engine bugs to log

All 7 demos still FAIL — but now for **real** reasons that were previously hidden by the WebGL fallback. These need follow-up sessions; per task constraint they were NOT fixed in this pass.

### NEW-3-A — `WebGPUSceneRenderer._ensureResources` references undeclared `scene`

**Severity:** Critical (5 of 7 demos blocked)
**File:** `packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts:725-727`
**Bug:**

```typescript
private _ensureResources(config: WebGPURenderFrameConfig): void {
  const { context } = config;       // <-- only `context` destructured
  // ...
  const enableEdgeVisibility = !!(
    scene as unknown as { _enableEdgeVisibility?: boolean }     // <-- scene not in scope
  )._enableEdgeVisibility;
```

The caller `executeCommands(config)` does destructure `scene` from `config` (line 862). The Batch 44 edge-FBO addition copied that idiom into `_ensureResources` without adding `scene` to the destructure. Crashes immediately on frame 1 of every WebGPU scene that has an edge-capable model or that touches `_ensureResources` (which is most of them).

**Fix sketch:** change the destructure on line 651 to `const { scene, context } = config;` (and fold the `scene` ref out of the cast since `scene` is already typed in the config interface).

**Affected demos:** Edge Visibility, Edge Feature ID, Model Pick, Many Imagery Layers, Translucent Classification (also masks NEW-3-* in Voxel Pick after frame 1 if NEW-3-C is fixed).

### NEW-3-B — `initWebGPUShadowMap` reads `device` from undefined

**Severity:** High (Point Light Shadows demo blocked)
**File:** `Build/CesiumUnminified/index.js:46929` (TS source: search for `initWebGPUShadowMap`)
**Bug:**
```
TypeError: Cannot read properties of undefined (reading 'device')
    at Object.initWebGPUShadowMap [as init]
    at ShadowMap.update
```

The shadow-map WebGPU init helper accesses `.device` on something that's still `undefined` at the call site. Likely `frameState.context._device` vs `frameState.context.device` mismatch, or the shadow map is being initialized before the context's device handshake completes. Fires on frame 1 before `_ensureResources`, so this demo never even reaches NEW-3-A.

**Affected demos:** Point Light Shadows.

### NEW-3-C — `Megatexture.get3DTextureDimension` is WebGL-only

**Severity:** High (Voxel Pick demo blocked, all voxel features unusable on WebGPU)
**File:** `Build/CesiumUnminified/index.js:312077` (TS source: `packages/engine/Source/Scene/Megatexture.js`)
**Bug:**
```
RuntimeError: The GL context does not support a 3D texture large enough
to contain a tile with the given dimensions.
```

`Megatexture.get3DTextureDimension` queries `MAX_3D_TEXTURE_SIZE` etc. directly from a WebGL2RenderingContext object. The WebGPU context exposes equivalent limits via `device.limits.maxTextureDimension3D` but the megatexture code was never adapted. This is consistent with `migration_doc/WEBGPU_MIGRATION_BACKLOG.md` — voxels were not on the Batch 48-66 scope.

**Fix sketch:** route the cap query through `GraphicsContext.maximum3DTextureSize` (or equivalent abstract) and have `WebGPUContext` answer with `device.limits.maxTextureDimension3D`.

**Affected demos:** Voxel Pick.

---

## Recommended next-session actions

1. **Fix NEW-3-A** (1-line fix). Re-run runner. Expect 5 demos to flip to PASS or to surface the next layer of WebGPU-only bugs.
2. **Fix NEW-3-B** in `initWebGPUShadowMap`. Re-run Point Light Shadows. (May surface follow-up shadow-map bugs since this code path has never been exercised.)
3. **Add `Megatexture` to backlog** as a voxel-feature port task; deprioritize Voxel Pick demo until the port lands. NEW-3-C is in scope of an existing-but-unscheduled backlog item, not a regression.
4. After NEW-3-A is fixed, the previously-"PASS" demos (Model Pick, Voxel Pick minus NEW-3-C, Many Imagery Layers) will reveal whatever the next layer of WebGPU-specific defects looks like — these will be the first honest WebGPU regression measurements for those features.

---

## Verification artifacts

- **Runner output:** `Tools/visual-regression/screenshots/sandcastle-batch-66-final/report.json` (0 PASS / 7 FAIL / 0 SKIP)
- **Per-demo screenshots:** 10 PNGs in `Tools/visual-regression/screenshots/sandcastle-batch-66-final/`
- **rendererType confirmation:** `webgpu` for all 7 results (probe via `synthetic-from-widget` — the runner's `Viewer.prototype.resize` hook captured `this.scene.context.rendererType` on the first frame for every demo).
