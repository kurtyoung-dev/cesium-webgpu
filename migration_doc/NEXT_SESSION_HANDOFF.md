# Next Session Handoff — 2026-04-09

**Purpose:** Self-contained context for the next session after a context compaction. Read this file first; it has every code pointer, design reference, and concrete next step needed to continue without re-discovering anything.

**Current branch:** `main`
**Last commit:** `38096a555a` — WebGPU work sweep: FORK-* cleanup, compute dispatchers, WASM per-bridge slots
**Working tree:** ~75 modified files, all from the 2026-04-09 sweep. **Nothing committed yet** — the next session should decide whether to commit/squash before continuing.
**`tsc --noEmit`:** clean.

---

## What landed in the 2026-04-09 sweep (3 nested sessions)

Three sessions back-to-back closed Phase 6 audit, Phases 1-3 of the remediation order, and laid Phases 4-5 design + cheap visible wins. Full detail in [WEBGPU_MIGRATION_STATUS.md](WEBGPU_MIGRATION_STATUS.md) under the three "Phase X sweep (completed 2026-04-09)" sections.

### Key surfaces that now exist (you'll use these heavily next session)

| Surface | Where | Use case |
|---|---|---|
| `Scene.getDebugSnapshot()` | [Scene.js:1438+](packages/engine/Source/Scene/Scene.js#L1438) | Aggregated read of every subsystem's state — snapshot mode, VPT, renderer (bundle/fog/HiZ/sortKeys/capabilities), moon, debug toggles |
| `Scene.logDebugSnapshot()` | [Scene.js:1529+](packages/engine/Source/Scene/Scene.js#L1529) | Pretty-prints the snapshot via `console.groupCollapsed` |
| `Scene.beginPerformanceTrace(label, {frames})` | [Scene.js](packages/engine/Source/Scene/Scene.js) | Per-frame trace recording with CSV / JSON exporters |
| `Scene.endPerformanceTrace()` | [Scene.js](packages/engine/Source/Scene/Scene.js) | Returns `{label, summary, samples}` |
| `scene.performanceTracker` | [PerformanceTracker.js](packages/engine/Source/Services/PerformanceTracker.js) | `.toCSV()` / `.toJSON()` / `.logToConsole()` |
| `GraphicsContext.getRendererStatistics()` | [GraphicsContext.ts](packages/engine/Source/Renderer/GraphicsContext.ts) | Abstract concrete (default `{}`); WebGPUContext overrides with bundle/perf/timestamps/indirectDraw/fog/hiZOcclusion/gpuSortKeys/capabilities |
| `WebGPUContext.getRendererStatistics()` | [WebGPUContext.ts:3106+](packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts#L3106) | Capability snapshot under `.capabilities` (hasShaderF16, hasDualSourceBlending, hasClipDistances, etc.) |
| `scene.debugShowImageryProbe = true` | [Scene.js](packages/engine/Source/Scene/Scene.js) | BUG-11 probe — dumps next 4 tile updates with full payload; rising-edge latch reset |
| `scene.snapshotMode.enabled = true` + `autoEnterIdleFrames = N` | [SnapshotModeService.js](packages/engine/Source/Services/SnapshotModeService.js) | FAST-mode-on-idle preset |

### Dispatchers that exist but aren't fully wired into consumers

| Dispatcher | Built? | Wired? | Where | Next step |
|---|---|---|---|---|
| `WebGPUPointCloudSortDispatcher` | ✅ | ❌ | [WebGPUPointCloudSortDispatcher.ts](packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudSortDispatcher.ts) | One-line consumer swap in `WasmPointCloudBridge.sortByDistance` |
| `WebGPUHiZOcclusionDispatcher` | ✅ | ✅ FR registered, OcclusionCulling.initialize() wired | [WebGPUHiZOcclusionDispatcher.ts](packages/engine/Source/Renderer/WebGPU/WebGPUHiZOcclusionDispatcher.ts) | ViewportExecutor needs to call `dispatchGPU()` + `scheduleReadback()` (~50 LOC) |
| `WebGPUGPUSortKeysDispatcher` | ✅ | ❌ FR registered only | [WebGPUGPUSortKeysDispatcher.ts](packages/engine/Source/Renderer/WebGPU/WebGPUGPUSortKeysDispatcher.ts) | RenderScheduler integration: SOA buffers + sort pass + reorder commands |

### Color grading shipped end-to-end

- WGSL: [ColorGrading.wgsl](packages/engine/Source/Shaders/WebGPU/PostProcess/ColorGrading.wgsl)
- Pipeline integration: [WebGPUPostProcessPipeline.ts](packages/engine/Source/Renderer/WebGPU/WebGPUPostProcessPipeline.ts) — `addColorGrading(device, format, config)` / `updateColorGradingUniforms(config)` / `setColorGradingScalar(idx, val)`
- Stage order: after `Tonemap`, before `Custom stages`, before `FXAA`
- Spec: [WebGPUColorGradingSpec.js](packages/engine/Specs/Renderer/WebGPU/WebGPUColorGradingSpec.js)

---

## Pending work — concrete next steps in priority order

### 1. ViewportExecutor wiring for HiZ occlusion (~50 LOC, 0.5 day)

**Why first:** Closes the Phase 3 occlusion path end-to-end. Everything else is built; only the per-frame consumer call is missing.

**Files:**
- [ViewportExecutor.js:392-406](packages/engine/Source/Scene/ViewportExecutor.js#L392-L406) — current call site for `occlusionCulling.beginFrame()` + `testCommands()`
- [OcclusionCulling.js](packages/engine/Source/Scene/OcclusionCulling.js) — has the new `dispatchGPU(encoder, depthTextureView, params)` and `scheduleReadback()` methods waiting

**What to do:**
1. After `executeCommands(scene, passState)` runs (so the depth attachment exists), call `occlusionCulling.dispatchGPU(encoder, depthView, { viewProjection, screenWidth, screenHeight, nearPlane, farPlane })`
2. At end of frame, call `occlusionCulling.scheduleReadback()` — this is fire-and-forget; the promise updates `_soaLayout.visibility` for next frame's `testCommands()`
3. The depth texture view comes from the WebGPU scene framebuffer — find it via `scene._sceneFramebuffer.depthTexture` or similar (check `WebGPUSceneRenderer.ts` for the canonical accessor)
4. Verify the auto-disable logic in `OcclusionCulling.testCommands` (line 287-293) actually fires when `occlusionRate < minOcclusionBenefit`

**Acceptance:**
- `scene.renderScheduler.occlusionCulling.enabled = true` causes `Scene.getDebugSnapshot().renderer.hiZOcclusion.hiZBuilds` to increment per frame
- After ~5 frames, `occlusionDispatches` and `successfulReadbacks` should both be > 0
- Visual: a building near the camera occluding distant terrain should reduce the visible draw count by 20%+

**Risk:** the depth texture view might not be in the right state (e.g., still bound as RENDER_ATTACHMENT). May need to add a transition step or use a separate `COPY_SRC` clone of the depth.

---

### 2. Visual smoke test session (1-2 hours, requires browser)

**Why:** Three sessions of fixes are now waiting for in-browser confirmation. The central debug surface + perf tracker + visual regression CI are all built but never validated against a live scene.

**What to validate:**
1. **BUG-11 imagery probe** — `scene.debugShowImageryProbe = true`, capture the 4-tile dump, verify `texCoordsRect` / `transScale` / texture dimensions look correct
2. **Snapshot mode FAST preset** — `scene.requestRenderMode = true; scene.snapshotMode.enabled = true; scene.snapshotMode.autoEnterIdleFrames = 120;` then `scene.beginPerformanceTrace("idle-snapshot", {frames: 600});` → wait 10s → `scene.endPerformanceTrace();` → confirm `summary.snapshotFrozenRatio > 0.5` and `summary.cpuMs.avg` drops compared to a no-snapshot baseline
3. **Color grading** — `pipeline.addColorGrading(device, format)` then `pipeline.updateColorGradingUniforms({ saturation: 0.0 })` → scene goes grayscale; `{ temperature: 0.5 }` → scene warms; `{ contrast: 1.5 }` → scene gains contrast
4. **Stars/skybox (BUG-1)** — verify `[WebGPU] Frustum X: ENVIRONMENT=N` console messages, then confirm starfield renders behind globe
5. **Shadow casting** — model + terrain scene, confirm shadow on terrain. The new `p12` variant should auto-trigger for stride-12 model commands
6. **2D / Columbus View (BUG-3)** — switch scene mode toggle, confirm flat/columbus projections render

**Documentation outputs:**
- Update `WEBGPU_MIGRATION_BACKLOG.md` "Visual Verification Backlog" with pass/fail per item
- Capture any new bugs into `WEBGPU_DEBUGGING_LOG.md`

**Tools at your disposal:**
- `Scene.logDebugSnapshot()` for one-shot diagnostic dumps
- `scene.performanceTracker.toCSV()` for perf data export
- `Tools/visual-regression/capture-and-diff.mjs` for cross-backend pixel diffing
- The MCP playwright tools (browser_navigate / browser_evaluate / browser_take_screenshot) if you want me to drive the browser

---

### 3. PointCloudSort consumer integration (1 day)

**Why:** Smallest remaining Phase 3 item. The dispatcher is built and spec'd; only a one-line consumer swap is left.

**Files:**
- [WasmPointCloudBridge.js:279](packages/engine/Source/Scene/WasmPointCloudBridge.js#L279) — current `sortByDistance` JS fallback
- [WebGPUPointCloudSortDispatcher.ts](packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudSortDispatcher.ts) — built dispatcher

**What to do:**
1. Add a `getOrCreateSortDispatcher()` getter to `WebGPUContext` that lazily instantiates the dispatcher (matches the bundle manager pattern)
2. In `WasmPointCloudBridge.sortByDistance()`, branch on `context.performanceManager.shouldUseGPUPointCloud(count)` → `dispatcher.sort(encoder, distSq, count)` else fall through to existing JS path
3. The trick: the JS path returns sorted indices to the CPU side, but the GPU dispatcher leaves them on the GPU. **Decision needed:** for the integration to be useful, the consumer must already be GPU-side (feeding into a draw indirect). If not, we're paying readback cost. **Recommendation:** wire the dispatcher but gate on a `useGPUSort` flag that defaults to false; flip on only when a real GPU-side consumer exists

**Acceptance:**
- `scene.getDebugSnapshot().renderer.pointCloudSort.sortsDispatched > 0` when a point cloud is visible AND `useGPUSort = true`

---

### 4. WGF-4 Camera UBO migration (~1 day, biggest Phase 5 win)

**Why:** Standard layout UBOs save ~20% memory + reduce per-frame `queue.writeBuffer` cost. Camera UBO is the biggest single UBO.

**Design:** [PHASE_5_MODERN_WEBGPU_DESIGN.md](migration_doc/PHASE_5_MODERN_WEBGPU_DESIGN.md) — see the WGF-4 section

**Files:**
- `packages/engine/Source/Renderer/WebGPU/WebGPUCameraUniforms.ts` (or wherever the camera UBO struct lives — check via grep)
- `packages/engine/Source/Shaders/WebGPU/chunks/csm_camera*.wgsl` — receive-side struct definitions

**What to do:**
1. Audit the camera UBO struct in WGSL — count the explicit `_pad0` / `_pad1` fields
2. Drop them from the struct
3. Update the JS packer to skip the corresponding offsets (no zero writes to gone fields)
4. Add a debug-build runtime assertion: `assert(packer.lastWrittenOffset === expectedSize)` to catch off-by-one
5. Verify `device.limits.minUniformBufferOffsetAlignment` (typically 256) — round up the new struct size if necessary
6. Run `npx tsc --noEmit` + visual smoke test

**Risk:** silent off-by-one — a JS packer that still writes to the old offset scribbles into the next field. The runtime assertion is the mitigation. **Always test the visual output after each UBO migration; don't batch.**

**Acceptance:**
- Camera UBO size shrinks by N bytes (record the N in the commit message)
- Visual diff against baseline scene shows zero pixel difference

---

### 5. TAA implementation (~3 days)

**Design:** [TAA_DESIGN.md](migration_doc/TAA_DESIGN.md) — fully concrete, ready to execute

**Files to add:**
- `Source/Shaders/WebGPU/PostProcess/TAA.wgsl` — full-screen fragment pass
- `Source/Renderer/WebGPU/WebGPUTAAEffect.ts` — `PostProcessEffect` implementation

**4-step plan from the design doc:**
1. Plumbing pass (~0.5 day) — add `previousViewProjection` to `UniformState`, jitter offset in `Camera.update()`, `Scene.taaEnabled` toggle
2. Motion vector texture (~1 day) — RG16F render target, MRT slot in GLOBE/PRIMITIVE pipelines
3. TAA shader + dispatcher (~1 day) — write `TAA.wgsl` (history sample + reprojection + neighborhood clamp + blend), `WebGPUTAAEffect` implementing `PostProcessEffect`, wire into `WebGPUPostProcessPipeline.execute()` after ColorGrading
4. Spec coverage + status doc (~0.5 day) — Halton sequence helper specs, reprojection math specs, migration status entry

**Critical risks (from the design doc):**
- Quantized terrain motion vectors blocked on `SHADOW-LAYOUT-QUANTIZED` — fall back to FXAA on quantized tiles
- Snapshot mode interaction — must zero the jitter offset when `scene.snapshotMode.isFrozen === true`
- MSAA incompatibility — TAA disables MSAA when active

---

### 6. CSM implementation (~4 days)

**Design:** [CSM_DESIGN.md](migration_doc/CSM_DESIGN.md) — fully concrete, ready to execute

**Files to add:**
- `Source/Shaders/WebGPU/Shadow/ShadowCastCSM.wgsl` — replacement for current cast shader, parameterized over cascade index
- `Source/Shaders/WebGPU/Shadow/ShadowReceiveCSM.wgsl` — fragment-side cascade selection chunk
- `Source/Renderer/WebGPU/WebGPUCSMRenderer.ts` — cascade-aware shadow renderer

**5-step plan from the design doc:**
1. CSM data structures + Scene API (~0.5 day) — `CascadedShadowMap` class, `Scene.useCascadedShadowMaps` toggle
2. Cast pipeline reuse (~0.5 day) — existing `WebGPUShadowMapRenderer` per-layout cache stays; loop over 4 cascades with different VP UBOs
3. Cast pass infrastructure (~1 day) — texture array, frustum-fitting math, texel snap stabilization
4. Receive-side cascade selection (~1.5 days) — `selectCascade` / `sampleCascade` / `blendCascade` chunk, terrain + primitive shader updates
5. Spec coverage + status doc (~0.5 day)

**Critical risks (from the design doc):**
- Texel snap precision under RTE 64-bit — do the snap in eye-space, not raw world space
- Memory cost (4 × 2048² × depth32float = 64 MB) — expose `Scene.cascadeShadowMapResolution` tunable
- Snapshot mode interaction — `WebGPUCSMRenderer` registers as a freezable

---

### 7. Phase 5 remaining WGFs (after WGF-4)

In design-doc priority order ([PHASE_5_MODERN_WEBGPU_DESIGN.md](migration_doc/PHASE_5_MODERN_WEBGPU_DESIGN.md)):

1. **WGF-1 `clip-distances`** — 1-2 days, small contained shader-only change
2. **WGF-3 `shader-f16` for color grading + bloom + tonemap + FXAA** — 2-3 days, requires shader variant per-feature
3. **WGF-2 `dual-source-blending`** — 2-3 days, only if a translucent-heavy scene shows up
4. **WGF-5 `multi-draw-indirect`** — 3-4 days, only if a point cloud / batched scene shows up

The first two (~3-5 days total) are high-leverage and low-risk. The remaining are scene-dependent.

---

### 8. Lower-priority follow-ups (still in the backlog)

From [WEBGPU_MIGRATION_BACKLOG.md](migration_doc/WEBGPU_MIGRATION_BACKLOG.md):

- **NEW-9** — file an upstream PR against `CesiumGS/quantized-mesh` to formally reserve extension ID `0x05` before water Phase 1 ships
- **SHADOW-LAYOUT-QUANTIZED** — quantized terrain stride-8/12 cast variants (2-3 days, blocked on a real consumer)
- **Render bundle env-pass executor full integration** — collect bundles from a frustum's command list and submit a single `executeBundles([...])` per pass (~1 day)
- **Producer-format adapter real-data validation** — Phase 0.5 carry-over (half session)
- **C4/C12 wording fixes** in `WATER_RENDERING_DESIGN.md` (30 minutes)
- **FORK-19b** — broader spec coverage expansion (4-6 days, can be done incrementally)
- **HiZ + OcclusionTest activation** — done (the dispatcher ships); the ViewportExecutor wiring is item #1 above
- **GPUSortKeys consumer integration in RenderScheduler** — ~400-500 LOC, only matters at >50K commands per frame
- **ES6 modernization** — ~400-600 hours total under the 10-line touch rule
- **Console noise reduction** — route `console.warn/error` through `context.log()`
- **Test page consolidation** — FORK-20/21/22

---

## Architectural reminders (from CLAUDE.md)

- **Backend agnosticism**: Scene code MUST NOT import from `Renderer/WebGPU/`. Use `context.getFeatureRenderer(FeatureRendererKey.XXX)` for backend dispatch.
- **64-bit RTE precision**: never use a single `position: vec3<f32>` in vertex buffers. Always `positionHigh` + `positionLow` and the `mvpRelativeToEye` path.
- **Monorepo file placement**: edit `packages/engine/Source/`, never the root `Source/` build output.
- **No JSDoc bloat**: don't add new JSDoc that wasn't there before; preserve existing JSDoc when modernizing.
- **No backwards-compat hacks**: rename/remove cleanly. Don't leave `// removed` comments or unused `_var` shims.

## Testing reminders

- `npx tsc --noEmit` after every meaningful change. Currently clean.
- Pure-CPU specs land in `packages/engine/Specs/` and run via `gulp test`. They follow the same backend-neutral discipline as the source.
- Tests that need a real `GPUDevice` go in `Specs/Renderer/WebGPU/` and run in the browser via the karma harness.
- The visual regression workflow at `.github/workflows/visual-regression.yml` is **manual trigger only** (workflow_dispatch) because GitHub-hosted Linux runners don't ship a WebGPU adapter. Promote to `pull_request` once a self-hosted runner is available.

---

## Modified file inventory (75 files, all uncommitted)

The bulk are from this 2026-04-09 sweep across three sessions. **Decision needed before next session**: commit/squash now (clean working tree) vs continue and squash later.

**New files (10 from the most recent session):**

```
.github/workflows/visual-regression.yml
migration_doc/CSM_DESIGN.md
migration_doc/PHASE_5_MODERN_WEBGPU_DESIGN.md
migration_doc/SESSION_2026-04-08_RESEARCH_REPORT.md
migration_doc/SNAPSHOT_MODE_SPIKE_2026-04-09.md
migration_doc/TAA_DESIGN.md
migration_doc/NEXT_SESSION_HANDOFF.md   (this file)
packages/engine/Source/Renderer/WebGPU/WebGPUGPUSortKeysDispatcher.ts
packages/engine/Source/Renderer/WebGPU/WebGPUHiZOcclusionDispatcher.ts
packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudSortDispatcher.ts
packages/engine/Source/Services/PerformanceTracker.js
packages/engine/Source/Shaders/WebGPU/PostProcess/ColorGrading.wgsl
```

**Earlier-session new files (already in working tree):**

```
packages/engine/Source/Scene/AtmosphericConditions.js
packages/engine/Source/Scene/Cesium3DTilesInvalidationFeed.js
packages/engine/Source/Scene/Cesium3DTilesInvalidationFeedAdapter.js
packages/engine/Source/Scene/GlobeWater.js
packages/engine/Source/Scene/MoonLight.js
packages/engine/Source/Scene/ProducerListenerAdapter.js
packages/engine/Source/Scene/TilePathEncoding.js
packages/engine/Source/Scene/TilePathResolver.js
packages/engine/Source/Services/  (SnapshotModeService.js, VisualPerformanceTargetService.js)
packages/engine/Source/ThirdParty/Workers/cesium_wasm.{d.ts,js}
packages/engine/Source/ThirdParty/Workers/cesium_wasm_bg.wasm
packages/engine/Specs/Data/  (3D Tiles invalidation feed fixtures)
```

**Specs added this session:**

```
packages/engine/Specs/Renderer/WebGPU/WebGPUColorGradingSpec.js
packages/engine/Specs/Renderer/WebGPU/WebGPUGPUSortKeysDispatcherSpec.js
packages/engine/Specs/Renderer/WebGPU/WebGPUHiZOcclusionDispatcherSpec.js
packages/engine/Specs/Renderer/WebGPU/WebGPUMoonSnapshotSpec.js
packages/engine/Specs/Renderer/WebGPU/WebGPUPointCloudSortDispatcherSpec.js
packages/engine/Specs/Renderer/WebGPU/WebGPURenderBundleManagerStatsSpec.js
packages/engine/Specs/Renderer/WebGPU/WebGPUVolumetricFogSnapshotSpec.js
packages/engine/Specs/Scene/SceneSnapshotWiringSpec.js
packages/engine/Specs/Services/PerformanceTrackerSpec.js
packages/engine/Specs/Services/SnapshotModeServiceSpec.js
packages/engine/Specs/Services/VisualPerformanceTargetServiceSpec.js
```

---

## Quick recipe: how to start the next session

```
1. Read this file (NEXT_SESSION_HANDOFF.md) — full picture.
2. Read the relevant design doc for the chosen task:
   - HiZ wiring     → use the existing dispatcher entry points
   - Visual smoke   → use Scene.logDebugSnapshot() + performanceTracker
   - WGF-4 Camera   → PHASE_5_MODERN_WEBGPU_DESIGN.md §WGF-4
   - TAA            → TAA_DESIGN.md
   - CSM            → CSM_DESIGN.md
3. `npx tsc --noEmit` baseline (should be clean — exit=0).
4. Use TodoWrite to track the chosen task's sub-steps.
5. After every meaningful change: `npx tsc --noEmit`.
6. Update WEBGPU_MIGRATION_STATUS.md when the task lands.
```

## Quick recipe: how to test this session's work in a browser

```js
// In dev tools console after loading a scene:

// 1. Snapshot the current state
viewer.scene.logDebugSnapshot();

// 2. Test snapshot mode FAST preset
viewer.scene.requestRenderMode = true;
viewer.scene.snapshotMode.enabled = true;
viewer.scene.snapshotMode.autoEnterIdleFrames = 120;
// ... wait 2 seconds ...
viewer.scene.logDebugSnapshot();
// Expect: snapshotMode.isFrozen = true, renderer.bundleManager.frozen = true,
//         renderer.volumetricFog.updatesSkippedFrozen rising every frame

// 3. Test color grading
const fr = viewer.scene.context.getFeatureRenderer(/*POST_PROCESS*/);
// (not yet a feature renderer — call directly via WebGPUSceneRenderer's pipeline)
// Or use Scene.colorGrading getter once that's wired

// 4. Capture a perf trace
viewer.scene.beginPerformanceTrace("smoke-test", { frames: 300 });
// ... 5 seconds of orbit ...
const result = viewer.scene.endPerformanceTrace();
console.log(viewer.scene.performanceTracker.toCSV(result));
// Copy CSV → spreadsheet for diffing later

// 5. BUG-11 imagery probe
viewer.scene.debugShowImageryProbe = true;
// Console will dump 4 tile updates with full payload
```

---

## Files referenced by this handoff

**Design docs (read these before starting their tasks):**
- [TAA_DESIGN.md](migration_doc/TAA_DESIGN.md)
- [CSM_DESIGN.md](migration_doc/CSM_DESIGN.md)
- [PHASE_5_MODERN_WEBGPU_DESIGN.md](migration_doc/PHASE_5_MODERN_WEBGPU_DESIGN.md)

**Status docs:**
- [WEBGPU_MIGRATION_STATUS.md](migration_doc/WEBGPU_MIGRATION_STATUS.md) — full session-by-session history
- [WEBGPU_MIGRATION_BACKLOG.md](migration_doc/WEBGPU_MIGRATION_BACKLOG.md) — remaining work

**Project rules:**
- [CLAUDE.md](CLAUDE.md) — backend agnosticism, RTE precision, file placement, ES6 modernization rule

**Key code surfaces (for the central debug API):**
- [Scene.js getDebugSnapshot()](packages/engine/Source/Scene/Scene.js)
- [PerformanceTracker.js](packages/engine/Source/Services/PerformanceTracker.js)
- [WebGPUContext.ts getRendererStatistics()](packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts)
- [SnapshotModeService.js](packages/engine/Source/Services/SnapshotModeService.js)
- [VisualPerformanceTargetService.js](packages/engine/Source/Services/VisualPerformanceTargetService.js)

**Built-but-unwired dispatchers:**
- [WebGPUHiZOcclusionDispatcher.ts](packages/engine/Source/Renderer/WebGPU/WebGPUHiZOcclusionDispatcher.ts)
- [WebGPUGPUSortKeysDispatcher.ts](packages/engine/Source/Renderer/WebGPU/WebGPUGPUSortKeysDispatcher.ts)
- [WebGPUPointCloudSortDispatcher.ts](packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudSortDispatcher.ts)

**Consumer wiring sites:**
- [OcclusionCulling.js](packages/engine/Source/Scene/OcclusionCulling.js) — has new `dispatchGPU()` + `scheduleReadback()` waiting for ViewportExecutor calls
- [ViewportExecutor.js:392-406](packages/engine/Source/Scene/ViewportExecutor.js#L392-L406) — needs ~50 LOC to call them
- [WasmPointCloudBridge.js:279](packages/engine/Source/Scene/WasmPointCloudBridge.js#L279) — needs the GPU sort branch
