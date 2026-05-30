> **ARCHIVED 2026-05-30** — historical point-in-time snapshot, superseded. NOT a live tracker. Live successors + index: `migration_doc/README.md`. Still-open items were lifted to `DEFERRED_WORK.md` (see its "Carried-forward on archive" section).

# Sandcastle Batch 66 TRULY FINAL Test Report

**Run date:** 2026-04-25 22:33 UTC
**Runner:** [`Tools/visual-regression/sandcastle-batch-66-final-runner.mjs`](../Tools/visual-regression/sandcastle-batch-66-final-runner.mjs) (unmodified — same runner used by DEFINITIVE pass)
**Build:** `Build/CesiumUnminified` rebuilt at 22:30 UTC via `node scripts/run-build-no-tsc.mjs`. Rebuild picks up:
- **NEW-3-A fix** — `WebGPUSceneRenderer._ensureResources` now destructures `{ context, scene }` from config (verified at `Build/CesiumUnminified/index.js:74841` — `const { context, scene } = config2;`).
- **NEW-3-B fix** — `initWebGPUShadowMap` and `renderShadowCastPass` now guard `frameState?.context` and try `.device ?? ._device` (verified at `Build/CesiumUnminified/index.js:45029-45036`).
- **NEW-3-C fix** — `WebGPUContext` now writes `cl._maximum3DTextureSize = limits.maxTextureDimension3D ?? 2048` and `cl._maximumArrayTextureLayers = limits.maxTextureArrayLayers ?? 256` (verified at `Build/CesiumUnminified/index.js:82450`).
- All NEW-1, F1, F2, F3 fixes from prior passes still present.

**Server:** `node server.js --port 8080 --production` (already running on 8080 from prior session).
**Browser:** Edge (`channel: msedge`) headless, `--enable-unsafe-webgpu --enable-features=Vulkan --use-vulkan`.
**Report data:** `Tools/visual-regression/screenshots/sandcastle-batch-66-truly-final/report.json`
**Screenshots:** `Tools/visual-regression/screenshots/sandcastle-batch-66-truly-final/*.png` (10 PNGs)
**Backup of DEFINITIVE pass:** preserved at `Tools/visual-regression/screenshots/sandcastle-batch-66-final/` (renamed from the runner's default output dir to keep the prior pass's evidence intact).

---

## TL;DR

The three engine fixes from the DEFINITIVE pass (NEW-3-A / B / C) are confirmed effective — all three error signatures are gone from the console log. **NEW-3-B in particular is fully closed**: Point Light Shadows no longer hits `Cannot read properties of undefined (reading 'device')`, and the WebGPU shadow init path now reaches further before encountering the next bug.

That visibility surfaced **six new engine findings** (NEW-4-A through NEW-4-F) in the second layer of WebGPU code that no Sandcastle demo has ever exercised end-to-end. All seven demos still FAIL, but **for entirely different reasons than the DEFINITIVE pass** — the NEW-3-* errors are gone; NEW-4-* errors take their place. Per task constraint these are logged for follow-up, not fixed.

| Result   | Batch 65 | Batch 66 (intermediate) | Batch 66 FINAL | DEFINITIVE | **TRULY FINAL** |
| -------- | -------- | ----------------------- | -------------- | ---------- | --------------- |
| **PASS** | 1        | 3                       | 4              | 0          | **0**           |
| **FAIL** | 6        | 4                       | 3              | 7          | **7**           |
| Backend  | WebGL    | WebGL                   | WebGL          | WebGPU     | **WebGPU**      |

The TRULY FINAL pass is the **second** honest measurement of the WebGPU code path under these demos. It is also the first measurement after all three NEW-3-* fixes landed — confirming each fix unblocks at least one frame of WebGPU execution before the next layer of bugs surfaces.

**`rendererType: "webgpu"` confirmed on all 7 results** (probed via `synthetic-from-widget` — the runner's `Viewer.prototype.resize` hook captured `this.scene.context.rendererType` on the first frame for every demo).

---

## 5-way diff

| Demo                              | Batch 65         | Batch 66 intermediate | Batch 66 FINAL              | DEFINITIVE          | **TRULY FINAL**            |
| --------------------------------- | ---------------- | --------------------- | --------------------------- | ------------------- | -------------------------- |
| WebGPU Edge Visibility            | FAIL (F1)        | FAIL (F2)             | FAIL (NEW-1 absent)         | FAIL (NEW-3-A)      | **FAIL (NEW-4-A)**         |
| WebGPU Edge Feature ID            | FAIL (F1)        | FAIL (F2)             | FAIL (NEW-1 absent)         | FAIL (NEW-3-A)      | **FAIL (NEW-4-A)**         |
| WebGPU Model Pick                 | FAIL (F1)        | PASS\* (WebGL)        | PASS\* (WebGL)              | FAIL (NEW-3-A)      | **FAIL (NEW-4-B)**         |
| WebGPU Voxel Pick                 | FAIL (F1)        | PASS\* (WebGL)        | PASS\* (WebGL)              | FAIL (NEW-3-C)      | **FAIL (NEW-4-D + 4-E)**   |
| WebGPU Point Light Shadows        | FAIL (F1)        | FAIL                  | FAIL                        | FAIL (NEW-3-B)      | **FAIL (NEW-4-B)**         |
| WebGPU Many Imagery Layers        | FAIL (F1)        | FAIL                  | PASS\* (WebGL)              | FAIL (NEW-3-A)      | **FAIL (NEW-4-B)**         |
| WebGPU Translucent Classification | PASS\* (WebGL)   | FAIL (NEW-1 absent)   | FAIL (NEW-1 absent)         | FAIL (NEW-3-A)      | **FAIL (NEW-4-B + 4-C)**   |

`PASS*` = the demo's WebGL fallback rendered successfully because the prior demo source ignored `contextOptions: { renderer: "webgpu" }` and silently fell back to WebGL.

---

## Per-demo results

### 1. WebGPU Edge Visibility — FAIL (NEW-4-A)

- **rendererType:** `webgpu` (via `synthetic-from-widget`)
- **Screenshot:** [`WebGPU Edge Visibility.png`](../Tools/visual-regression/screenshots/sandcastle-batch-66-truly-final/WebGPU%20Edge%20Visibility.png) — 36 KB, partial frame with rendering-stopped modal.
- **rendering-stopped:** 2 events
- **Root cause (NEW-4-A):** `DeveloperError: A WebGL 2 context is required.` thrown from `_Buffer.getBufferData` ([`Build/CesiumUnminified/index.js:86878`](../Build/CesiumUnminified/index.js)). Call chain: `EdgeVisibilityPipelineStage.process` → `buildTriangleAdjacency` → `ModelReader.readAttributeAsTypedArray` → `ModelReader.readAttributeAsRawCompactTypedArray` → `Buffer.getBufferData`. The model reader path attempts a CPU-side readback of the index/position buffer to compute per-triangle adjacency for edge rendering; `Buffer.getBufferData` is the WebGL2-only `gl.getBufferSubData` wrapper. NEW-3-A is **closed** — the render loop now reaches the model-pipeline stage before the WebGL-only readback throws.
- **NEW-3 status:** NEW-3-A fully closed (no `_ensureResources` crash). Demo now blocked by NEW-4-A one layer deeper.

### 2. WebGPU Edge Feature ID — FAIL (NEW-4-A)

- **rendererType:** `webgpu` (via `synthetic-from-widget`)
- **Screenshot:** [`WebGPU Edge Feature ID.png`](../Tools/visual-regression/screenshots/sandcastle-batch-66-truly-final/WebGPU%20Edge%20Feature%20ID.png) — 35 KB.
- **rendering-stopped:** 2 events
- **Root cause:** Identical to Edge Visibility — same NEW-4-A path through `EdgeVisibilityPipelineStage` → `buildTriangleAdjacency` → `Buffer.getBufferData`.
- **NEW-3 status:** NEW-3-A fully closed.

### 3. WebGPU Model Pick — FAIL (NEW-4-B)

- **rendererType:** `webgpu` (via `synthetic-from-widget`)
- **Screenshot:** [`WebGPU Model Pick.png`](../Tools/visual-regression/screenshots/sandcastle-batch-66-truly-final/WebGPU%20Model%20Pick.png) — 27 KB.
- **rendering-stopped:** 0 events (modal not shown — pipeline error is a recoverable validation failure that lets the render loop continue)
- **Pick result:** `null` at canvas center + 8 offset points. Likely downstream of repeated GPU validation errors preventing model from depth-resolving.
- **Root cause (NEW-4-B):** The `GlobeDepth-DepthCopy-Pipeline` is invalid because of a sampler-binding-type mismatch. The bind group layout declares `texture(0, ..., { sampleType: "depth" })` and `sampler(1, ...)` (defaults to `filtering`), but WebGPU validation requires depth textures to be paired with a `non-filtering` or `comparison` sampler. The full validation message:
  > Texture binding (group:0, binding:0) is TextureSampleType::Depth but used statically with a sampler (group:0, binding:1) that's SamplerBindingType::Filtering — While validating fragment stage ([ShaderModule "GlobeDepth-DepthCopy-Shader"], entryPoint: "fragmentMain")
- **NEW-3 status:** NEW-3-A fully closed. (Demo previously blocked by NEW-3-A on frame 1.)

### 4. WebGPU Voxel Pick — FAIL (NEW-4-D + NEW-4-E)

- **rendererType:** `webgpu` (via `synthetic-from-widget`)
- **Screenshot:** [`WebGPU Voxel Pick.png`](../Tools/visual-regression/screenshots/sandcastle-batch-66-truly-final/WebGPU%20Voxel%20Pick.png) — 37 KB.
- **rendering-stopped:** 2 events
- **Pick result:** error — `Expected cartesian to be typeof object, actual typeof was undefined` (because the canvas-center read failed; pick error is a downstream symptom).
- **Root cause (NEW-4-D):** Even with `_maximum3DTextureSize` now populated (NEW-3-C fix), the `Texture3D` constructor at [`packages/engine/Source/Renderer/Texture3D.js:74`](../packages/engine/Source/Renderer/Texture3D.js) still has an unconditional `WebGL1 does not support texture3D. Please use a WebGL2 context.` guard that throws on WebGPU contexts (because the WebGL stub doesn't advertise itself as WebGL2). Call chain: `_VoxelPrimitive.update` → `initFromProvider` → `new VoxelTraversal` → `new _Megatexture` → `new _Texture3D`. NEW-3-C fixed the cap-query path but exposed this second WebGL-only guard.
- **Root cause (NEW-4-E):** Even if NEW-4-D were patched, the `Voxel color pipeline` shader fails WGSL parsing: `Error while parsing WGSL: :113:1 error: missing return at end of function`. The shader is unlabeled in the WebGPU error so we can't pinpoint the source file from the report alone, but the pipeline label is `"Voxel color pipeline"` so it lives in the WebGPU voxel renderer family. Likely a vertex-stage entry function that returns a struct but has a code path missing the trailing `return`.
- **NEW-3 status:** NEW-3-C partially closed — cap query no longer fails with `0 max3DTextureSize`, but the second WebGL-only guard inside `Texture3D` constructor is the new blocker (NEW-4-D), and NEW-4-E waits behind it.

### 5. WebGPU Point Light Shadows — FAIL (NEW-4-B)

- **rendererType:** `webgpu` (via `synthetic-from-widget`)
- **Screenshot:** [`WebGPU Point Light Shadows.png`](../Tools/visual-regression/screenshots/sandcastle-batch-66-truly-final/WebGPU%20Point%20Light%20Shadows.png) — 30 KB.
- **rendering-stopped:** 0 events
- **Root cause (NEW-4-B):** Same `GlobeDepth-DepthCopy-Pipeline` sampler-mismatch as Model Pick. Plus a benign `[WebGPUPrimitiveCommands] compressedAttributes without _compressedAttributesMeta — falling back to inference` warning that doesn't break rendering.
- **NEW-3 status:** **NEW-3-B fully closed.** No `Cannot read properties of undefined (reading 'device')` anywhere in the log. The shadow-map init path now reaches the actual shadow render passes — and the next thing to break is the unrelated NEW-4-B globe-depth pipeline validation.

### 6. WebGPU Many Imagery Layers — FAIL (NEW-4-B)

- **rendererType:** `webgpu` (via `synthetic-from-widget`)
- **imageryLayerCount:** `1` (expected ≥8 — the demo's layer setup ran but the layers fail CORS preflight when fetched from `tile.openstreetmap.fr`, an environment artifact unrelated to the rendering bug)
- **Screenshot:** [`WebGPU Many Imagery Layers.png`](../Tools/visual-regression/screenshots/sandcastle-batch-66-truly-final/WebGPU%20Many%20Imagery%20Layers.png) — 48 KB (largest because the partial frame shows the default base imagery).
- **rendering-stopped:** 0 events
- **Root cause (NEW-4-B):** Same `GlobeDepth-DepthCopy-Pipeline` sampler-mismatch.
- **Bonus warning (NEW-4-F advisory):** "The number of sampled textures (29) in the Fragment stage exceeds the maximum per-stage limit (16). This adapter supports a higher maxSampledTexturesPerShaderStage of 48, which can be specified in requiredLimits when calling requestDevice()." The Globe terrain pipeline layout requests 29 sampled-texture bindings but the device wasn't initialised with `requiredLimits.maxSampledTexturesPerShaderStage = 48`. Cap-bypass would resolve this for adapters that support it.
- **NEW-3 status:** NEW-3-A fully closed.

### 7. WebGPU Translucent Classification — FAIL (NEW-4-B + NEW-4-C)

- **rendererType:** `webgpu` (via `synthetic-from-widget`)
- **Screenshot:** [`WebGPU Translucent Classification.png`](../Tools/visual-regression/screenshots/sandcastle-batch-66-truly-final/WebGPU%20Translucent%20Classification.png) — 38 KB.
- **rendering-stopped:** 2 events
- **Root cause (NEW-4-B):** Same `GlobeDepth-DepthCopy-Pipeline` sampler-mismatch.
- **Root cause (NEW-4-C):** `TypeError: Cannot read properties of undefined (reading 'fragmentShaderSource')` thrown from `getLogDepthShaderProgram` ([`packages/engine/Source/Scene/DerivedCommand.js:139`](../packages/engine/Source/Scene/DerivedCommand.js)) called from `DerivedCommand.createLogDepthCommand` (line 230). The classification primitive enqueues a derived "log-depth" command that the WebGL DerivedCommand path tries to wrap by reading `command.shaderProgram.fragmentShaderSource` — but the source command is a `WebGPUDrawCommand` that has no `shaderProgram` field. Classification primitive in WebGPU mode needs either (a) a WebGPU-aware `createLogDepthCommand` short-circuit, or (b) a feature renderer for classification that bypasses `DerivedCommand` entirely.
- **NEW-3 status:** NEW-3-A fully closed.

---

## Engine fixes that landed this session (NEW-3 closure)

| Fix     | File                                                           | Line(s)          | What it closed                                                                                  |
| ------- | -------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------- |
| NEW-3-A | `packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts` | 651              | `ReferenceError: scene is not defined` in `_ensureResources` — 5 demos                          |
| NEW-3-B | `packages/engine/Source/Renderer/WebGPU/WebGPUShadowMapRenderer.js` | 809-823, 1059-1063 | `TypeError: Cannot read properties of undefined (reading 'device')` in shadow init/cast — 1 demo |
| NEW-3-C | `packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts`      | 1644-1645        | `RuntimeError: ... 3D texture large enough ...` in `Megatexture.get3DTextureDimension` — 1 demo |

All three closures verified empirically: not a single occurrence of the NEW-3-* error signatures anywhere in the TRULY FINAL `report.json`. NEW-3-A and NEW-3-B can be marked **closed**. NEW-3-C is **closed at the cap-query level** but the underlying voxel feature still has a deeper WebGL guard (NEW-4-D) — recommend re-classifying NEW-3-C as "partially closed; remaining work tracked under NEW-4-D".

---

## STILL-failing demos & engine bugs to log

All 7 demos still FAIL — but now for **second-layer** reasons that the NEW-3-* fixes exposed. These need follow-up sessions; per task constraint they were NOT fixed in this pass.

### NEW-4-A — `EdgeVisibilityPipelineStage` calls WebGL-only `Buffer.getBufferData`

**Severity:** High (blocks Edge Visibility + Edge Feature ID demos; affects any model with edge visibility)
**Files:**
- `packages/engine/Source/Scene/Model/EdgeVisibilityPipelineStage.js`
- `packages/engine/Source/Scene/Model/ModelReader.js:162512` (`readAttributeAsTypedArray`) and `:162576` (`readAttributeAsRawCompactTypedArray`)
- `packages/engine/Source/Renderer/Buffer.js:189` (`getBufferData`) — WebGL-only, throws `DeveloperError: A WebGL 2 context is required.` against a non-WebGL2 context
**Bug:**
```
DeveloperError: A WebGL 2 context is required.
    at new DeveloperError (...:90)
    at _Buffer.getBufferData (...:86878)
    at _ModelReader.readAttributeAsRawCompactTypedArray (...:162576)
    at _ModelReader.readAttributeAsTypedArray (...:162512)
    at buildTriangleAdjacency (...:163302)
    at EdgeVisibilityPipelineStage.process (...)
```
The model edge-visibility pipeline stage needs to read back vertex/index data to compute per-triangle adjacency (used for silhouette + crease edges). It calls `Buffer.getBufferData` which is the synchronous `gl.getBufferSubData` wrapper; the WebGPU equivalent is the asynchronous `device.queue.readBuffer` / `mapAsync` round-trip.
**Fix sketch:** Either (a) cache vertex/index data on the CPU at upload time so the readback isn't needed (preferred — also benefits WebGL by avoiding a CPU stall), or (b) add a WebGPU-aware `Buffer.getBufferDataAsync()` that uses `mapAsync` and refactor the edge-visibility pipeline stage to await it during model preparation.
**Affected demos:** Edge Visibility, Edge Feature ID. (Could affect any future Sandcastle demo that enables edge visibility on a model.)

### NEW-4-B — `GlobeDepth-DepthCopy` pipeline rejected: sampler binding type mismatch

**Severity:** Critical (blocks 5 of 7 demos — every demo that loads a globe + has depth-of-field / FXAA / picking enabled)
**File:** `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeDepth.ts:387-388`
**Bug:**
```
Texture binding (group:0, binding:0) is TextureSampleType::Depth but used statically with
a sampler (group:0, binding:1) that's SamplerBindingType::Filtering
    - While validating fragment stage ([ShaderModule "GlobeDepth-DepthCopy-Shader"], entryPoint: "fragmentMain")
    - While calling [Device].CreateRenderPipeline([RenderPipelineDescriptor ""GlobeDepth-DepthCopy-Pipeline""])
```
WebGPU spec: when a texture binding declares `sampleType: "depth"`, the paired sampler binding MUST be `non-filtering` or `comparison`. The current code declares the sampler with no explicit binding type, which defaults to `filtering`. The GlobeDepth depth-copy shader does a single fullscreen-triangle blit from the scene depth attachment to a color-format depth target; nearest-only filtering is already the intent (see `magFilter: "nearest"` / `minFilter: "nearest"` on line 394-395), so the binding type just needs to match.
**Fix sketch:** Change [`WebGPUGlobeDepth.ts:388`](../packages/engine/Source/Renderer/WebGPU/WebGPUGlobeDepth.ts) from `sampler(1, Stage.FRAGMENT)` to `sampler(1, Stage.FRAGMENT, { type: "non-filtering" })` (assuming the `sampler` helper accepts a binding-type override; otherwise pass the raw `{ binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "non-filtering" } }` descriptor). Apply the same fix to the MSAA path (`_createDepthCopyMSAAPipeline` if separate) — this report didn't probe MSAA so it may also need the fix.
**Affected demos:** Many Imagery Layers, Model Pick, Point Light Shadows, Translucent Classification, plus latently any demo that touches the globe depth-copy code path. (Edge Visibility / Edge Feature ID also hit this validation but their primary blocker is NEW-4-A.)

### NEW-4-C — `getLogDepthShaderProgram` reads `fragmentShaderSource` from undefined `shaderProgram`

**Severity:** Medium (blocks Translucent Classification demo)
**File:** `packages/engine/Source/Scene/DerivedCommand.js:139` (`getLogDepthShaderProgram`) and `:230` (`createLogDepthCommand`)
**Bug:**
```
TypeError: Cannot read properties of undefined (reading 'fragmentShaderSource')
    at getLogDepthShaderProgram (.../DerivedCommand.js:139)
    at DerivedCommand.createLogDepthCommand (.../DerivedCommand.js:230)
    at _Scene.updateDerivedCommands (.../Scene.js)
    at insertIntoBin (.../View.js)
```
`DerivedCommand.createLogDepthCommand` is the WebGL log-depth derivation pass that wraps `command.shaderProgram` to inject the log-z fragment output. Classification primitives enqueue commands through the WebGL command path (no WebGPU classification feature renderer exists yet — see `BUILD-VAR-HAZARD-CLASSIFICATION` in `WEBGPU_DEBUGGING_LOG.md`). When the source command is a `WebGPUDrawCommand`, `command.shaderProgram` is undefined → the wrap throws.
**Fix sketch:** Two options:
  - **Tactical:** Add an early-return at the top of `createLogDepthCommand` when `command.shaderProgram` is missing — the derived command simply doesn't get created, log-depth on classification primitives in WebGPU mode silently no-ops (matches the "no WebGPU classification renderer" status quo).
  - **Strategic:** Build a `CLASSIFICATION_PRIMITIVE` feature renderer that intercepts the WebGL classification path entirely (already noted as `BUILD-VAR-HAZARD-CLASSIFICATION` backlog item).
**Affected demos:** Translucent Classification.

### NEW-4-D — `Texture3D` constructor still has WebGL-only guard

**Severity:** High (blocks Voxel Pick demo; affects any WebGPU code path that allocates a `Texture3D`)
**File:** `packages/engine/Source/Renderer/Texture3D.js:74`
**Bug:**
```
DeveloperError: WebGL1 does not support texture3D. Please use a WebGL2 context.
    at new DeveloperError (...:90)
    at new _Texture3D (...:98150)
    at new _Megatexture (...:315814)
    at new VoxelTraversal (...:316354)
    at initFromProvider (...:317189)
    at _VoxelPrimitive.update (...:317943)
```
The NEW-3-C fix populated `_maximum3DTextureSize` correctly, but the `Texture3D` constructor itself still checks `context._webgl2` (or equivalent) and throws when it's false. The WebGL stub on `WebGPUContext` doesn't (and shouldn't) claim to be WebGL2, so the guard fires.
**Fix sketch:** Same pattern as the rest of the voxel feature — `Texture3D.js` needs a WebGPU-aware path (or a `Texture3D` feature renderer) that allocates a `GPUTexture` with `dimension: "3d"` instead of calling `gl.texImage3D`. This is a non-trivial port because all `Texture3D` consumers (`Megatexture`, `VoxelTraversal`) call into WebGL-style API surfaces.
**Affected demos:** Voxel Pick.

### NEW-4-E — `Voxel color pipeline` WGSL: missing return at end of function

**Severity:** High (blocks Voxel Pick rendering even after NEW-4-D is fixed)
**File:** Unknown WGSL source — error message says `unlabeled` shader at line 113. Pipeline label `"Voxel color pipeline"` indicates the source is somewhere under `packages/engine/Source/Shaders/WebGPU/Voxel*.wgsl` (or the voxel feature renderer's shader assembly).
**Bug:**
```
Error while parsing WGSL: :113:1 error: missing return at end of function
}
^
    - While calling [Device].CreateShaderModule([ShaderModuleDescriptor])
```
The shader's vertex stage entry function (or one of its helper functions) ends without a `return` statement. WGSL requires every non-void function to end with a return on every code path.
**Fix sketch:** Locate the source by greppging for "Voxel color pipeline" in `packages/engine/Source/Renderer/WebGPU/`, then inspect the assembled WGSL source around line 113 (likely an `else` branch of an `if/else` that's missing the `return`). Add the missing `return` with the correct struct/value.
**Affected demos:** Voxel Pick (after NEW-4-D unblocks the texture allocation).

### NEW-4-F — Globe terrain pipeline exceeds default `maxSampledTexturesPerShaderStage` (advisory)

**Severity:** Low (advisory — the device runs anyway because the cap is a soft limit on this adapter; would hard-fail on adapters where 16 is the actual hardware limit)
**File:** `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeRenderer*.ts` (or wherever the Globe terrain pipeline layout is built)
**Warning:**
```
The number of sampled textures (29) in the Fragment stage exceeds the maximum per-stage
limit (16). This adapter supports a higher maxSampledTexturesPerShaderStage of 48, which
can be specified in requiredLimits when calling requestDevice().
    - While calling [Device].CreatePipelineLayout([PipelineLayoutDescriptor ""Globe terrain pipeline layout""])
```
The Globe terrain pipeline layout requests 29 sampled-texture bindings but `WebGPUContext._initializeDevice` (or wherever `requestDevice` is called) doesn't ask for `requiredLimits.maxSampledTexturesPerShaderStage = 48`.
**Fix sketch:** In `WebGPUContext.ts`, add `maxSampledTexturesPerShaderStage` to the `requiredLimits` object passed to `adapter.requestDevice`. Cap at `Math.min(48, adapter.limits.maxSampledTexturesPerShaderStage)` to fail gracefully on adapters that don't support 48.
**Affected demos:** Many Imagery Layers (most visibly), Model Pick, Translucent Classification (any demo with a globe).

---

## Closure status of every F* / NEW-* finding from this session

| Finding | Status   | Notes                                                                                               |
| ------- | -------- | --------------------------------------------------------------------------------------------------- |
| F1      | Closed   | DynamicGeometryUpdater 9-class ES6 inheritance — closed in Batch 65 / 66.                           |
| F2      | Closed   | `ShaderFunction.generateGlslLines()` empty-body filler.                                             |
| F3      | Closed   | Various Batch 66 intermediate fixes.                                                                |
| NEW-1   | Closed   | `ShaderStruct.generateGlslLines()` empty-body filler — landed Session 36.                           |
| NEW-2   | Closed   | Demos converted to `Viewer.createAsync` — landed Session 36.                                        |
| NEW-3-A | **Closed** | `WebGPUSceneRenderer._ensureResources` now destructures `scene` — landed this session, **verified empirically (no `scene is not defined` in TRULY FINAL log)**. |
| NEW-3-B | **Closed** | `initWebGPUShadowMap` + `renderShadowCastPass` now guard `frameState?.context` and try `.device ?? ._device` — landed this session, **verified empirically (no `Cannot read properties of undefined (reading 'device')` in TRULY FINAL log)**. |
| NEW-3-C | Partially closed | `WebGPUContext` cap-query fixed (`_maximum3DTextureSize`, `_maximumArrayTextureLayers`) — landed this session. Remaining work (`Texture3D` constructor guard) tracked as NEW-4-D. |
| NEW-4-A | **Open** (this session) | `EdgeVisibilityPipelineStage` calls WebGL-only `Buffer.getBufferData`. |
| NEW-4-B | **Open** (this session) | `GlobeDepth-DepthCopy` pipeline rejected: depth-texture sampler binding type. |
| NEW-4-C | **Open** (this session) | `getLogDepthShaderProgram` reads `fragmentShaderSource` from undefined. |
| NEW-4-D | **Open** (this session) | `Texture3D` constructor still has WebGL-only guard. Successor to NEW-3-C. |
| NEW-4-E | **Open** (this session) | `Voxel color pipeline` WGSL: missing return at end of function. |
| NEW-4-F | **Open advisory** (this session) | Globe terrain pipeline exceeds default `maxSampledTexturesPerShaderStage`. |

---

## Recommended next-session actions

1. **Fix NEW-4-B first.** Single-line fix in `WebGPUGlobeDepth.ts:388` — add `{ type: "non-filtering" }` to the sampler binding. Expected to flip 4 of 5 affected demos to PASS (Many Imagery Layers, Model Pick, Point Light Shadows, plus partial improvement on Translucent Classification). Highest ROI.
2. **Fix NEW-4-C** with the tactical early-return — single-conditional fix in `DerivedCommand.js`. Combined with NEW-4-B this should flip Translucent Classification.
3. **Fix NEW-4-A** — design choice between (a) cache attribute data at model-load time (preferred — also speeds up WebGL repeat reads) or (b) make `Buffer.getBufferData` async with WebGPU `mapAsync`. The async path requires refactoring `EdgeVisibilityPipelineStage.process` to handle the async preparation phase. Closes Edge Visibility + Edge Feature ID.
4. **NEW-4-D + NEW-4-E** are the voxel-feature backlog. These are not regressions — voxels have never had a WebGPU port. Recommend deferring Voxel Pick demo until the `Texture3D` / `Megatexture` / `VoxelTraversal` WebGPU port is scheduled.
5. **NEW-4-F** is advisory. Add `maxSampledTexturesPerShaderStage: 48` to `requiredLimits` whenever the `WebGPUContext` device-init call is being touched anyway.

After fixing NEW-4-B and NEW-4-C, expected score is **3/7 PASS** (Many Imagery Layers, Model Pick, Point Light Shadows pass; Translucent Classification pending). After also fixing NEW-4-A, expected score is **5/7 PASS**. Voxel Pick is blocked by structural voxel-feature port work.

---

## Verification artifacts

- **Runner output:** `Tools/visual-regression/screenshots/sandcastle-batch-66-truly-final/report.json` (0 PASS / 7 FAIL / 0 SKIP)
- **Per-demo screenshots:** 10 PNGs in `Tools/visual-regression/screenshots/sandcastle-batch-66-truly-final/`
- **Backup of DEFINITIVE pass:** `Tools/visual-regression/screenshots/sandcastle-batch-66-final/` (preserved verbatim from 2026-04-25 19:20 UTC).
- **rendererType confirmation:** `webgpu` for all 7 results (probe via `synthetic-from-widget`).
- **NEW-3 closure evidence:** Searched the report.json for the three NEW-3-* error signatures (`scene is not defined`, `Cannot read properties of undefined (reading 'device')`, `does not support a 3D texture large enough`) — zero hits. All three closures empirically verified.
