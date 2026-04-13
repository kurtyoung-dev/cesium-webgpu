# CesiumJS WebGPU Migration -- Remaining Work Backlog

**Last Updated:** April 13, 2026 (Session 28: Option B completion + TypeScript clean build)
**Purpose:** Single source of truth for ALL remaining work — active bugs, fork tech debt, parity gaps, sorting/picking enhancements, ES6 modernization, upstream issues, dormant compute shaders, and modern WebGPU feature integrations. Items resolved through April 2026 have been moved to `WEBGPU_MIGRATION_STATUS.md`.

> **For architecture, completed work, bug fix history, current state, and the Phase 0 / Phase 1 / Renderer Threading / Phase 5 progress sections, see `WEBGPU_MIGRATION_STATUS.md`.**

---

## 2026-04-13 — Session 28 follow-ups

Session 28 completed the Option B material UBO split and achieved a clean TypeScript build (0 errors from both `tsc --noEmit` and `npx gulp build`). See `NEXT_SESSION_HANDOFF.md` § "What landed in Session 28" for details.

### Completed (moved to WEBGPU_MIGRATION_STATUS.md)

- ~~Option B Material UBO Split~~ — all shaders + WebGPUPolylineRenderer refactored
- ~~TypeScript build errors (202 → 0)~~ — cesium-js-types.d.ts rewrite, WebGPUContext fixes, esbuild async fixes
- ~~CLAUDE.md `any` ban rule~~ — added

### New follow-ups

- **TS-DEBT-1** — **Refactor WebGPUContext public underscore fields to use getters**. 30+ external access sites should call `context.device` not `context._device`. Mechanical search-and-replace. Effort: ~2 hours.
- **TS-DEBT-2** — **Add `getGPUBuffer()` helper** to eliminate `'buffer' in vb` narrowing at every vertexBuffer/indexBuffer access site. Effort: ~30 min.
- **TS-DEBT-3** — **Remaining `: any` annotations** (268 across 40 WebGPU .ts files). Now safe to fix incrementally since build is clean. Effort: ~2-3 hours.
- **TS-DEBT-4** — **Remaining `as any` casts** (33 across 10 WebGPU .ts files). Same incremental approach. Effort: ~1 hour.
- **ES6-VAR** — **`var` → `const`/`let` codemod** (~196 files). Mechanical. Effort: ~2-3 hours.
- **ES6-INDEXOF** — **`.indexOf()` → `.includes()` codemod** (~57 files). Codemod already exists. Effort: ~30 min.
- **ES6-ASYNC-AUDIT** — **Full async method audit** from ES6 class codemod. Fixed 15+ that caused esbuild errors, but more may exist without causing build failures. Effort: ~1 hour.
- **OPTION-B-BILLBOARD** — **WebGPUBillboardRenderer.js bind group split**. Still uses old monolithic pattern. Lower priority. Effort: ~2 hours.
- **OPTION-B-VISUAL** — **Visual smoke test of all 25 material types**. Zero runtime testing on Option B changes. Must verify before shipping. Effort: ~2 hours with Playwright.

---

## 2026-04-12 — Phase 5 + HDR follow-ups

The 2026-04-12 session landed WGF-4 (RTE assertions), WGF-1 (hardware clip-distances), WGF-3 (shader-f16 tonemapping), the HDR pipeline fix, auto-exposure compute, OPEN-5 fog fix, and OPEN-1 sky atmosphere guard. See `WEBGPU_MIGRATION_STATUS.md` § "Recent Progress (2026-04-12)".

### New follow-ups

- **WGF-1-EXPAND** — **Extend clip-distances to remaining shaders**. Today only the globe terrain pipeline has the hardware clip-distances variant. The 3 Primitive shaders (`PrimitiveBasicColor`, `PrimitivePhongColor`, `PrimitivePhongTexturedColor`) have the struct update but no vertex-side clip distance output. Models (`ModelPBRComplete.wgsl`) don't have clipping plane support at all yet. Effort: ~2 days per shader family. Trigger: when clipping planes are used on non-globe geometry.
- **WGF-1-INTERSECTION** — **Intersection-mode clipping with hardware clip distances**. The hardware `@builtin(clip_distances)` builtin is purely union semantics (any slot < 0 clips). Intersection mode (clip only when ALL planes clip) requires a different approach — likely a fragment-side check against all 8 clip distances passed as varyings. Effort: ~1 day. Trigger: a user reports intersection-mode clipping broken with `useHardwareClipDistances = true` (currently gated to union-only).
- **WGF-3-EXPAND** — **Extend shader-f16 to remaining post-process stages**. Today only `Tonemapping_f16.wgsl` exists. Candidates: ColorGrading, FXAA, BrightPass, GaussianBlur1D, BloomComposite. Each needs a hand-tuned f16 variant file + visual-diff validation against the f32 reference. Defer SkyAtmosphere/GroundAtmosphere (too close to f16 denormal range). Effort: ~0.5 day per shader. Trigger: profiler shows post-process as a bottleneck on mobile/laptop.
- **WGF-4-EXPAND** — **RTE assertions in remaining 5 camera packers**. Today assertions are in 3 of 8 packers (BufferPrimitiveRenderer, GlobeSurfaceRenderer, UniformGroupManager). Missing: CloudRenderer, EllipsoidPrimitiveRenderer, GaussianSplatRenderer, PointCloudRenderer, VoxelRenderer. Effort: ~1 hour. Trigger: any time someone touches those files.
- **HDR-DISPLAY** — **HDR display output (canvas HDR)**. Both WebGL and WebGPU currently tonemap to SDR before the canvas blit. Chrome supports `GPUCanvasConfiguration.colorSpace: "display-p3"` and the CSS `color-gamut` media query. When a wide-gamut / HDR display is detected, the final blit could skip tonemapping and output linear HDR directly. Effort: ~2 days research + implementation. Trigger: user with an HDR monitor requests it.
- **AUTO-EXPOSURE-TUNE** — **Auto-exposure adaptation rate tuning**. The default `adaptationRate = 1/(60×1.5) ≈ 0.011` matches WebGL's formula but may feel too slow or too fast depending on the scene. Expose `scene.autoExposureAdaptationRate` as a tunable. Effort: ~1 hour. Trigger: visual testing reveals the adaptation is perceptibly wrong.
- **OPEN-1-DIAGNOSE** — **Sky atmosphere shader/format diagnosis**. The try/catch + latch prevents infinite retry, but the actual compile failure needs browser-based debugging. Connect via Playwright, enable `useWebGPU`, check for shader compile errors in the console. Effort: ~1 hour. Trigger: next visual smoke-test session.

### Updates to existing backlog items

- **WORKER-5** — now also tracks `useHardwareClipDistances` + `useShaderF16` feature flag replication (implemented via `MSG_SET_FEATURE_FLAGS` in this session).
- **TAA design doc** — updated with HDR pipeline interaction note and f16 non-concern note.
- **CSM design doc** — updated with 240-byte EffectsUniforms struct constraint note.
- **FORK-19b (Jasmine spec coverage)** — add specs for `WebGPUAutoExposure` (luminance reduction math, temporal smoothing, readback), `WebGPUClipDistancePrecompute` (dPrime round-trip, finite sentinel), `WebGPURTEAssertions` (tolerance thresholds).

---

## 2026-04-11 — Items added/impacted by the Renderer Threading sweep

The 2026-04-11 sweep landed live FPS measurement, per-renderer worker
scaffolding, the Scene/CreditDisplay headless mode, the maxFps runtime
cap, and the worker-renderers test page. See
`WEBGPU_MIGRATION_STATUS.md` § "Recent Progress (2026-04-11)" for the
full inventory and `OPTION_B_SCENE_IN_WORKER.md` for the design + the
9-13 week roadmap to a fully-worker-hosted Scene. The items below are
**new follow-ups** carved out during the sweep, plus updates to
existing backlog items that this work changes.

### New follow-ups

- **WORKER-1** — **Phase 1 of Option B (worker Scene functional baseline)**. The headless Scene constructor + CreditDisplay worker-safety landed as part of this sweep. The next layer is verifying that `Scene.render()` actually completes a frame against an OffscreenCanvas without hitting another DOM dependency we missed. Likely candidates: the `Camera` constructor reading `canvas.clientWidth/clientHeight`, the `ScreenSpaceCameraController` calling `addEventListener` on the canvas, `loadImage()` paths using `new Image()` (need `createImageBitmap` instead). Effort: ~1 week. **Trigger**: any time someone wants real per-renderer FPS comparison via the worker test page. See `OPTION_B_SCENE_IN_WORKER.md` §§1-2.
- **WORKER-2** — **Soft-reset (Tier 2) host trigger**. The protocol message `MSG_RESET` and the worker-side handler are in place but no host-side method emits the message — Tier 2 of the 3-tier crash recovery is reserved for future use. When a need appears (e.g., a recoverable engine error that doesn't need a full canvas swap), add `host.softReset(reason)` and wire it to a host-detectable error class. Effort: ~half day. **Trigger**: a real soft-reset use case showing up in the bug log.
- **WORKER-3** — **Shadow state expansion**. Today the worker host's shadow state covers `lastView`, `requestRenderMode`, and `maxFps`. To make the worker path useful for actual scenes, the shadow state needs to record entity adds/removes, imagery/terrain providers, post-process stages, and any other host-side commands so a hard restart can replay them into the new worker. The protocol message constants for these (`MSG_ADD_ENTITY`, `MSG_REMOVE_ENTITY`, `MSG_SET_IMAGERY_LAYER`, `MSG_SET_TERRAIN`) already exist; the shadow recording + replay paths are stubs. Effort: ~2-3 weeks for the entity / primitive surface alone (each Cesium type needs a serializer pair — Cartesian3, Color, Property, Material, etc.). See `OPTION_B_SCENE_IN_WORKER.md` §3.2.
- **WORKER-4** — **WorkerScreenSpaceEventHandler**. `ScreenSpaceEventHandler` calls `addEventListener("mousedown", ...)` on its target canvas; OffscreenCanvas has no event interface even on Chromium. Worker camera control today is impossible. The fix is a `WorkerScreenSpaceEventHandler` that exposes the same `setInputAction(callback, type, modifier)` API but receives synthetic events from the host via `MSG_INPUT_EVENT` (already a defined message; today the worker handler logs and discards). Modifier-key tracking and double-click detection logic moves into the host's input forwarder. Effort: ~1-2 days. **Trigger**: WORKER-1 lands and the next obvious use case is "click on an entity in a worker pane".
- **WORKER-5** — **`maxFps` integration with Snapshot Mode**. `SnapshotModeService` already provides freeze/thaw lifecycle hooks. When a freezable subsystem is in the worker, the natural pattern is `host.setMaxFps(-1)` on freeze and `host.setMaxFps(null)` on thaw — pause the worker's render loop instead of just skipping its bundle reuploads. Effort: ~half day. **Trigger**: when a real worker-hosted scene lands and we want it to participate in snapshot mode.
- **WORKER-6** — **Per-frame postMessage cost audit**. The current host↔worker hot path uses `postMessage` for stats (one message every 125 ms, ~600 bytes, transferable Float32Array for the frame-time slice). For animation-heavy use cases (entity updates, hover picking) we might want to batch updates per frame (`MSG_BATCH_UPDATE`) or use object pools on both sides. This is the kind of optimization that should ONLY happen when measurements show it matters — the FPS counter use case is fine as-is. **Effort**: 1-2 days when needed. **Trigger**: animation-heavy scene profiling shows the postMessage cost on a flame graph.
- **WORKER-7** — **Naga-wasm in the worker**. The host application can now run multiple workers with their own engine chunks; the engine chunk includes `WebGPUNagaTranspiler` for runtime GLSL→WGSL transpilation. **Verify** that naga-wasm initialization works inside the worker context (it's just `WebAssembly.instantiateStreaming` against a wasm URL, but the URL resolution needs to be checked). Effort: ~half day spike. **Trigger**: the first user-supplied GLSL shader hits the worker path.
- **WORKER-8** — **Cross-browser worker render loop on Firefox/Safari**. The current `setTimeout(1000/60)` fallback in `RendererWorker.js` runs at ~60 Hz with sub-millisecond jitter on browsers where `requestAnimationFrame` isn't available in DedicatedWorker (Firefox, Safari as of 2026). On a 144 Hz display these workers won't ride the higher refresh rate. The canonical fix is for the main thread to post a `MSG_TICK` message on its own rAF — but that creates a hard coupling that defeats the worker isolation. **Decision**: leave as-is until a real Firefox/Safari user complains. Document in `OPTION_B_SCENE_IN_WORKER.md` §5.
- **WORKER-9** — **Visual regression for the worker test page**. The existing visual regression workflow targets `Apps/WebGPUTest/split-screen-comparison.html`. Once WORKER-1 lands and the worker panes actually render, add `worker-renderers.html` as a second baseline target — gives us cross-browser regression coverage for the worker path AND a way to detect FPS regressions over time (e.g., new shader features that drop the average below 55 fps). Effort: ~1 day. **Trigger**: WORKER-1 landed.

### Updates to existing backlog items

- **FORK-19b (Jasmine spec coverage)** — needs to grow to cover the new Services layer too. Add specs for: `PerformanceTracker.recordFrame` / `getLiveStats` / percentile math, `FpsOverlay` rendering against a mock data source (jsdom Canvas), `WorkerSceneHost` heartbeat + crash recovery + shadow replay (mocking `Worker`), `RendererWorker` headless Scene init path. Estimated +1 day on top of the existing FORK-19b estimate.
- **Performance benchmarking (Tier 4 #4.4)** — the worker hosts + per-renderer FPS overlays unblock real apples-to-apples WebGL-vs-WebGPU comparisons that were previously impossible because both renderers shared the main-thread JS pump. The benchmark task should now be: open `worker-renderers.html`, spawn one WebGL pane and one WebGPU pane, capture the 60s rolling stats from each FPS overlay's `getLiveStats()`, export. Measurable wins to verify: render bundles (50-80% CPU), GPU culler (5-20× for >50K objects), AtmosphereLUT consumer (fragment ray-march elimination), PointCloudLOD subgroups (2-4× on dense scenes).
- **Snapshot Mode Phases A-D** — the `maxFps` cap with mode `-1` (paused) is the natural worker-side hook. Phase A's bundle manager freeze flag remains main-thread, but a worker-hosted Scene's freezable can additionally call `host.setMaxFps(-1)` on freeze for full power saving instead of just skipping bundle reuploads. WORKER-5 above tracks the wiring.
- **OPTION_B_SCENE_IN_WORKER.md** — full design doc with the 9-13 week roadmap. Phase 1 of that doc (the headless Scene constructor + CreditDisplay) is done as part of this sweep. Phases 2-7 are the backlog items above (WORKER-1 through WORKER-9) plus the per-subsystem worker-safe variants the Option B doc inventories.

---

## 2026-04-09 — Items added by Phase 0 / Phase 1.1 / 1.2 work

These follow-ups were carved out during Phase 0 + Phase 1.2 implementation. None are blocking; each is captured here so they don't get lost.

- **NEW-9** — File an upstream PR against [`CesiumGS/quantized-mesh`](https://github.com/CesiumGS/quantized-mesh) to formally reserve **extension ID `0x05`** for the water classification extension. Phase 0.6 verification confirmed the ID is currently unassigned and the wire format is documented in `WATER_RENDERING_DESIGN.md §9.1`. **Must happen before water Phase 1 ships** to avoid racing another extension proposal. Effort: ~2 hours (PR draft + review).
- ~~**EllipsoidPrimitive feature renderer consolidation**~~ — ✅ **Resolved 2026-04-09 (Phase 1.x consolidation).** Extracted the Moon's bounding-cube + base uniform pack into `Renderer/WebGPU/WebGPUEllipsoidRenderer.ts`. Created the `csm_intersectEllipsoid.wgsl` chunk. Refactored `WebGPUEnvironmentRenderer.js` Moon path to use the shared helpers; file shrunk by ~140 lines. New 11-spec `WebGPUEllipsoidRendererSpec.js` covers the base packer end-to-end. See `WEBGPU_MIGRATION_STATUS.md` § "Phase 1.x consolidation". Stretch follow-up: migrate the orphan `WebGPUEllipsoidPrimitiveRenderer.ts` from its current screen-space-quad approach to use the bounding-cube path — ~1-2 days, deferred until that renderer gets a real consumer.
- **Render bundle env-pass executor full integration** — Phase 1.2c v2 wires `WebGPUDrawCommand.bundle` so any individual command can replay a `GPURenderBundle`. Future enhancement: collect bundles from a frustum's command list and submit a single `passEncoder.executeBundles([...])` call per pass, eliminating per-command CPU overhead entirely. Effort: ~1 day. Trigger: when a second renderer registers bundles (sky atmosphere, sun) so the batch path has at least 2 entries to amortize over.
- **Snapshot mode Phases A-D** — Per `SNAPSHOT_MODE_SPIKE_2026-04-09.md`. Phase 1.2c v2 already wires the moon as the first freezable consumer, but the broader work (bundle manager freeze flag, camera-delta auto-thaw, `markSnapshotDirty` event hooks, GPU memory pressure handling) is still pending. Effort: ~3 days. Trigger: after Phase 1.3 lands more bundle-eligible content. **2026-04-11 update**: when a worker-hosted Scene becomes a freezable, `host.setMaxFps(-1)` is the natural full-power-saving hook (pauses the worker render loop entirely instead of just skipping bundle reuploads). Tracked as **WORKER-5** in the 2026-04-11 section above.
- **C4 / C12 wording fixes** in `WATER_RENDERING_DESIGN.md` §4.5 / §10 / DP5 — Phase 0.6 verification found three small refinements: (1) parent encloses child *content* not child *volumes*, (2) `EXT_:_NAME` collision-disambiguation pattern available if ever needed, (3) describe `EXT_mesh_features` + `EXT_structural_metadata` as **paired** (feature IDs + property tables) rather than alternatives. Doc-only edits, ~30 minutes; do during water Phase 1.
- **Producer-format adapter real-data validation** — Phase 0.5 smoke-tested `ProducerListenerAdapter` against the real `listener_invalidations_25.2.txt` fixture (16 sets, 1116 entries, all 8 layers detected correctly). Still needs an end-to-end test with a real `Cesium3DTileset` consuming the feed and validating that the zero-flicker swap fires correctly for each entry. Effort: ~half session. Trigger: when a real producer + consumer pair is available to test against.
- **Volumetric fog spellcheck dictionary entry** — multiple `migration_doc/*.md` files reference "froxel" (frustum-voxel) which the editor's spellcheck flags. Add to project dictionary. Trivial.

---

## Table of Contents

0. [2026-04-11 — Renderer Threading sweep follow-ups (WORKER-1 to WORKER-9)](#2026-04-11--items-addedimpacted-by-the-renderer-threading-sweep)
1. [Active Bugs](#1-active-bugs)
2. [Tier 4: Testing, Performance & Quality](#2-tier-4-testing-performance--quality)
3. [Sorting System Remaining](#3-sorting-system-remaining)
4. [Picking System Remaining](#4-picking-system-remaining)
5. [Fork-Specific Tech Debt](#5-fork-specific-tech-debt)
6. [WebGL/WebGPU Feature Parity Gaps](#6-webglwebgpu-feature-parity-gaps)
7. [Dormant Compute Shaders](#7-dormant-compute-shaders)
8. [Modern WebGPU Feature Integrations (WGF)](#8-modern-webgpu-feature-integrations-wgf)
9. [Missing Visual Features (Industry Comparison)](#9-missing-visual-features-industry-comparison)
10. [WASM Expansion Opportunities](#10-wasm-expansion-opportunities)
11. [Performance Roadmap](#11-performance-roadmap)
12. [ES6 Modernization Backlog](#12-es6-modernization-backlog)
13. [Upstream Issues (Unaddressed)](#13-upstream-issues-unaddressed)
14. [Priority Remediation Order](#14-priority-remediation-order)

---

## 1. Active Bugs

| # | Bug | Severity | Status | Notes |
|---|-----|----------|--------|-------|
| **BUG-3** | **2D mode renders as sphere** | MEDIUM | **Likely Resolved (S18) — needs visual verification** | Globe terrain shader scene-mode branching landed in Session 18 (MORPHING/COLUMBUS_VIEW/SCENE2D/SCENE3D + planar position helpers). Camera UBO extended with `tileRectangle`, `southAndNorthLatitude`, `southMercatorYAndOneOverHeight`, `sceneMode`, `morphTime`, `useWebMercator`. **Action**: visual smoke test in 2D and Columbus View modes. |
| **BUG-5** | **"size is zero" at startup** | LOW | Intermittent | `Math.max(size, 4)` guards exist but edge cases remain. Hard to repro. |
| **BUG-6** | **Fill tile edge-case errors** | LOW | Mostly Fixed (S15) | Stride mismatch skip handles most cases; rare residuals. |
| **SHADOW-LAYOUT** | **Per-layout shadow cast pipelines** | MEDIUM | **Mostly resolved (2026-04-09)** | S25 added the stride safety net; the per-layout pipeline cache (`cache.castPipelines` Map keyed on variant name) and the public `registerShadowCastVariant(key, variant)` API are now in `WebGPUShadowMapRenderer.js`. Two ship variants: `rte24` (canonical RTE primitive, stride 24) and `p12` (single-vec3 stride 12, covers non-RTE models / debug primitives). Spec coverage: variant registry, stride inference, warn-once dedupe, and explicit `_shadowCastLayout` override (`Specs/Renderer/WebGPU/WebGPUShadowMapRendererSpec.js`, 11 specs). **Remaining**: quantized terrain variants (stride 8 + 12 with f16/u16 formats) — these need de-quantization in the cast shader and access to per-tile rectangle/height-scale uniforms, which is a meaningfully larger refactor. Tracked separately under **SHADOW-LAYOUT-QUANTIZED** below. |
| **SHADOW-LAYOUT-QUANTIZED** | Quantized terrain shadow cast variants | MEDIUM | New (carved out 2026-04-09) | Quantized terrain tiles use stride-8 (u16) and stride-12 (f16) vertex formats with per-tile rectangle + height-scale uniforms. Adding shadow cast variants for these requires the cast shader to de-quantize via the same uniform pack the surface shader uses, and the shadow uniform buffer needs to grow to carry tileRectangle / minMaxHeight. Estimated 2-3 days. Trigger: when quantized terrain shadow casting is requested by a real scene. Workaround today: terrain doesn't cast shadows (the safety-net stride filter skips it). |
| **BUG-11** | **Imagery layer textures bind but don't render** | HIGH | **Needs visual env** (instrumentation landed 2026-04-09) | Per-tile diagnostic logs at `WebGPUGlobeSurfaceRenderer.ts:802` show `hasImage=true hasWebGPUTex=true` but no visible imagery. **Code-level audit (S26) ruled out**: bind-group sample-type mismatch, std140 alignment drift, day/night alpha argument swap, stale uniform leakage. **Top runtime suspects**: (A) reprojection clear alpha=0 collapsing `tex.a * effectiveAlpha` to zero; (B) `tileImagery.textureCoordinateRectangle` initialized to (0,0,0,0) instead of undefined — `texCoordsAlpha` mask returns 0 for every fragment; (C) stale view in `_imageryTextureCache` after underlying GPUTexture recreated. **Instrumentation landed 2026-04-09**: (1) reprojection clear alpha changed `0 → 1` in `WebGPUImageryReprojection.ts` (defensive — closes hypothesis A); (2) new `scene.debugShowImageryProbe` toggle exposes the existing first-4-tile diagnostic on demand with rising-edge latch reset, so the operator can re-sample without restarting; (3) `Scene.getDebugSnapshot().debugToggles.debugShowImageryProbe` reflects the current state. **Probe checklist for the visual session**: set `scene.debugShowImageryProbe = true`, capture the 4-tile dump with `texCoordsRect` / `transScale`, toggle `scene.debugShowTerrainLOD = true` to confirm geometry rasterizes, then narrow to B / C if A is still in play. |
| **BUG-1** | **Stars/skybox not visible** | HIGH | **Fixed (S16) — still needs visual confirmation** | `panoramaCommandList` accumulation bug fixed; injection path in `SceneRenderer.js` confirmed sound by code audit. Has not been confirmed visually since the fix landed. |
| **BUG-7** | **Shadow cast pipeline** | MEDIUM | **Fixed + Limitation (see SHADOW-LAYOUT)** | Command collection, point light guard, bias path all fixed in S16. Stride filter added S25. |

### Visual Verification Backlog (in-browser confirmation needed)

These features have been *fixed in code* across Sessions 16-18 but never had a final visual smoke test. Each is one short manual session away from being closed:

1. **Stars/skybox** (BUG-1) — verify `[WebGPU] Frustum X: ENVIRONMENT=N` console messages show env commands present, then confirm starfield renders behind globe.
2. **Shadow casting** — open a model+terrain scene, confirm shadow on terrain.
3. **2D / Columbus View** (BUG-3) — switch scene mode toggle, confirm flat/columbus projections render without artifacts.
4. **Render bundle performance** — frame-time measurement with ≥8 globe tiles to confirm 50-80% CPU drop.
5. **Advanced renderers** — CloudCollection, VoxelPrimitive, GaussianSplat, PointCloud, EllipsoidPrimitive — all built with full shaders, none have been verified rendering end-to-end.

---

## 2. Tier 4: Testing, Performance & Quality

| # | Item | Effort | Status |
|---|------|--------|--------|
| 4.1 | **Expand Jasmine spec coverage** (FORK-19b) | 5-7 days | 10 spec files exist (Buffer, DrawCommand, ImageUpload, PrimitiveIndexUtils, RingBufferAllocator, ShadowMapRenderer, SubgroupUtils, Texture, ContextFactory, GraphicsContext, NagaTranspiler). Coverage is thin — 105+ WebGPU files, only ~50 tests total. Target: at least one spec per FR + per major utility module. **2026-04-11 update**: also add specs for the new Services layer — `PerformanceTracker` live histogram + percentile math, `FpsOverlay` rendering against a mock data source (jsdom Canvas), `WorkerSceneHost` heartbeat + crash recovery + shadow replay (mocking `Worker`), `RendererWorker` headless init path. ~+1 day on the original estimate. |
| 4.2 | **Automated visual regression (pixel-diff CI)** | ~~3-4 days~~ **CI workflow landed 2026-04-09** | `Tools/visual-regression/` scaffolding + `.github/workflows/visual-regression.yml` (workflow_dispatch trigger, threshold input, baseline `--update` toggle, artifact upload). Currently manual-trigger only because GitHub-hosted Linux runners don't ship a WebGPU adapter without extra setup; promote to `pull_request` trigger once that lands. **Remaining**: capture the initial baseline corpus + tune per-scene tolerance. **2026-04-11 update**: see WORKER-9 for the follow-up to add `worker-renderers.html` as a second baseline target once the worker Scene actually renders. |
| 4.3 | **Browser compatibility testing** | 3-5 days | Safari, Firefox WebGPU support. Edge tested; need cross-browser smoke + capability fingerprinting for the WGF features. **2026-04-11 update**: also verify the worker render loop fallback (`setTimeout(1000/60)` instead of `requestAnimationFrame`) works correctly on Firefox + Safari workers — see WORKER-8. |
| 4.4 | **Performance benchmarking** | 2-3 days | WebGL vs WebGPU vs WebGPU-compat comparison. Need fixed-camera scene + frame-time logging + report generation. Measurable wins to verify: render bundles (50-80% CPU), GPU culler (5-20× for >50K objects), AtmosphereLUT consumer (fragment ray-march elimination), PointCloudLOD subgroups (2-4× on dense scenes). **2026-04-11 update**: this task is now substantially easier — `worker-renderers.html` provides the side-by-side comparison harness and `WorkerSceneHost.getLiveStats()` returns the rolling 60s avg + 1% lows + 1% highs as a structured object ready for export. The benchmark workflow becomes: open the page, spawn one WebGL + one WebGPU pane, run a fixed camera path, capture each pane's `host.getLiveStats()` snapshot, export to CSV. WORKER-1 (Phase 1 of Option B) is the prerequisite — without it the worker panes don't render. |
| 4.6 | **Indirect drawing for 3D Tiles — production activation** | 2-3 days | Infrastructure built (`WebGPUIndirectDrawManager.ts`); opt-in fast path landed S26 via `executeBatchIndirect()` + `context.useIndirectDrawForTiles` flag. **Remaining**: identify a tile renderer with homogeneous pipeline+bind-group runs of ≥2 commands and flip the flag on for it. Most tile commands have unique per-tile bind groups so the win lives mainly in tightly-instanced point cloud / batched-table tile sets. |
| 4.8 | **Console noise reduction** | 1 day | ~12 `console.warn/error` calls in standalone modules should route through `context.log(level, ...)` for per-context prefixing. |

### Compute Engine Hardening (CS-* items from COMPREHENSIVE_AUDIT_2026_03_31)

| ID | Issue | Severity | Status |
|----|-------|----------|--------|
| **CS-1** | 4 dormant compute shaders need consumer wiring (HiZ, OcclusionTest, PointCloudSort, GPUSortKeys) | 🟡 Medium | Documented in §7. Activation tied to consumer system testing. |
| **CS-6** | `WebGPUPerformanceManager.dispatchCompute()` caches pipelines by task string but doesn't validate bind group compatibility | 🟡 Medium | Add bind group layout validation on dispatch path. |

---

## 3. Sorting System Remaining

| ID | Item | Effort | Status |
|----|------|--------|--------|
| **SORT-8** | Unit tests for sorting (30+ files) | 3-5 days | Not started. Tied to FORK-19b spec expansion. |
| **SORT-12** | OcclusionCulling GPU resources | Tied to testing | GPU resources still stub; conservative "assume visible" fallback active. Wire when Hi-Z compute shader activates (§7). |

---

## 4. Picking System Remaining

| # | Item | Effort | Status |
|---|------|--------|--------|
| 6.1 | **WGSL depth-to-color blit shader** for main scene depth readback | 1-2 days | Globe depth blit done (FORK-34); main scene depth blit still pending. |
| 6.2 | **Pick layer filtering** (bitmask to skip unpickable objects) | 1-2 days | Not started |
| 6.3 | **Octree pick acceleration** (pre-filter via octree) | 1-2 days | Not started; tied to SORT octree opt-in |
| 6.4 | **GPU multi-hit** (WebGPU only — storage buffer linked list) | 3-5 days | Future |
| 6.5 | **Rectangle selection** | 2-3 days | Future |
| 6.6 | **Pick priority** (`entity.pickPriority`) | 1-2 days | Future |
| 6.7 | **CPU hybrid pick** (geometric ray intersection) | 3-5 days | Future |

---

## 5. Fork-Specific Tech Debt

Items introduced by our WebGPU additions. 38 of 51 resolved through April 2026 (Session 27); 13 remaining.

### Remaining Items (Priority Order)

| ID | Issue | Severity | Effort |
|----|-------|----------|--------|
| **FORK-19b** | Expand WebGPU spec coverage (10 files, ~50 tests for 105+ source files) | HIGH | 4-6 days |
| **FORK-41** | 4 of 12 compute shaders awaiting activation (HiZ, OcclusionTest, PointCloudSort, GPUSortKeys) | MEDIUM | Per shader, 2-4 days each |
| **FORK-45** | Single global WASM arena shared across bridges | MEDIUM | 1 day | All 7 bridges share one `Mutex<Vec<u8>>` arena. Works today because bridges run sequentially, but a parallel-frame future would corrupt it. Per-bridge arena slots needed. |
| ~~**FORK-11**~~ | ~~`webgpuTypeHelpers.ts` has limited adoption~~ — **RESOLVED (Session 27)**: `cesium-js-types.d.ts` now provides the broader ambient type coverage that `webgpuTypeHelpers.ts` was trying to fill piecemeal. | ~~MEDIUM~~ | -- |
| **FORK-9** | `: any` casts in WebGPU TypeScript — was ~11 targeted, originally 66; reduced to ~32 via `cesium-js-types.d.ts` ambient type approach. Remaining casts are in complex call sites needing per-file refactoring. | MEDIUM | ~32 remain |
| **FORK-16** | WGSL preprocessor test page reimplements preprocessor | MEDIUM | 0.5 day | Test page has its own preprocessor; should consume the production `WGSLShaderPreprocessor`. |
| **FORK-20** | 29 test pages use 3 different module loading patterns | MEDIUM | 1 day | Standardize on a single import pattern across `Apps/WebGPUTest/`. |
| **FORK-21** | Test pages contain hardcoded inline WGSL shaders | MEDIUM | 0.5 day | Move to shared `.wgsl` files or import from production locations. |
| **FORK-22** | Several test pages are raw WebGPU demos | MEDIUM | 0.5 day | Refactor to use the production renderer where it exists, so the test page validates the real path. |
| **FORK-23** | No automated visual regression testing | MEDIUM | 2-3 days | See item 4.2 above. |
| ~~**FORK-4**~~ | ~~`WebGLCompatibilityStub.ts` maintenance~~ — **RESOLVED / Overhauled (Session 27)**: Proton-style texture, shader, and stencil translation layers added. The stub now handles full texture format mapping, shader compatibility shims, and stencil op translation rather than being a thin pass-through. Naga-wasm (Phase 6) remains the long-term retirement path for shader-related stubs. | ~~MEDIUM~~ | -- |
| **FORK-29** | Slang cross-compilation unused in production | LOW | -- | Slang infrastructure is still in the tree but no production shaders use it. Decision: remove or commit to it (blocked on naga-wasm spike outcome). |
| **FORK-30** | `@webgpu/types` pinned to `^0.1.69` | LOW | -- | Newer versions renamed `maxInterStageShaderComponents` → `maxInterStageShaderVariables` (handled in S26 with cast). Bump pin once we're confident in the new API surface. |

### Resolved Items (38 of 51) — For Reference

FORK-1 (device loss), FORK-2 (unused imports), FORK-3 (redundant shader loading), **FORK-4 (WebGLCompatibilityStub overhauled Session 27 — Proton-style texture/shader/stencil translation)**, FORK-5 (Phase D 28/28), FORK-6 (isWebGPU checks reduced), FORK-7 (depthRangeZeroToOne), **FORK-8 (zero `isWebGPUDrawCommand` references remain in `packages/engine/Source/Scene/` — verified 2026-04-09 audit follow-up; backlog entry was stale and referred to a line removed during S16 cleanup)**, FORK-10 (ts-expect-error), **FORK-11 (webgpuTypeHelpers limited adoption — superseded by `cesium-js-types.d.ts` ambient declarations, Session 27)**, FORK-12 (context-aware logging), FORK-13 (no debug logging), FORK-14 (CameraUniforms drift), FORK-15 (transitive struct deps), FORK-17 (mipmap stub now dispatches `WebGPUMipmapGenerator`; stub logs proper guidance), FORK-18 (DepthPlane implemented), FORK-19 (10+ spec files now exist: WebGPURingBufferAllocatorSpec, WebGPUShadowMapRendererSpec, WebGPUColorGradingSpec, etc. — rescoped as FORK-19b above), FORK-24 (Primitive.js cleanup), FORK-25 (7 renderers wired), FORK-26 (COUNT auto-computed), FORK-27 (abstract methods verified), FORK-28 (25/25 materials), FORK-31 (sorting integration complete), FORK-32+33 (multi-light scene.lights), FORK-34 (pick scene depth blit complete), FORK-35 (pick ID consolidated), FORK-36 (convenience pick APIs), FORK-37 (WASM destroy+free_buffer), FORK-38 (WASM version check), FORK-39 (SIMD detection), FORK-40 (all bridges destroy), FORK-42 (compute try/catch), FORK-43 (workgroup validation), FORK-44 (CPU fallback sort/LOD), FORK-46 (Rust OOM handling), NEW-1 (DynamicEnvironmentMapManager sync readPixels — non-issue, FR intercepts).

---

## 6. WebGL/WebGPU Feature Parity Gaps

### GLSL Backport Analysis — No Backports Needed

All WGSL shaders fall into three categories:

| Category | Count | Details |
|----------|-------|---------|
| **Ports of existing GLSL** | 12+ | Tonemapping, Atmosphere, SSAO, Bloom, DoF, Edge, Silhouette, IBL (3), FXAA |
| **Compute-only (impossible in WebGL)** | 8 | FrustumCull, HiZ, OcclusionTest, AtmosphereLUT, PointCloudSort/LOD, GPUSortKeys, WeatherParticles |
| **WebGPU-only enhancements** | 7+ | SSR, ProceduralClouds, DeferredGBuffer/Lighting, enhanced ocean, enhanced night, terminator glow |

### New Upstream GLSL — WGSL Forward-Ports Needed (Low Priority)

| GLSL Shader | Feature | WGSL Status |
|---|---|---|
| `computeTextureTransform.glsl` | `KHR_texture_transform` | **Done** (`csm_computeTextureTransform.wgsl`) |
| `ConstantLodStageFS/VS.glsl` | Distance-based constant LOD | Low priority — wire when constant-LOD extension support added to WebGPU model path |
| `EdgeVisibilityStageVS.glsl` | Edge visibility (glTF ext) | Low priority — wire when edge visibility WebGPU path added |

### Phase 2 Feature Completion (medium priority)

| # | Feature | Effort | WebGL? | Notes |
|---|---------|--------|--------|-------|
| 7 | **Built-in shader cache** | 1-2 days | Already works | Marked "not yet implemented" in `WebGPUShaderCache`. The cache infrastructure exists but doesn't pre-populate at init. |
| 8 | ~~**Deferred G-Buffer renderer**~~ | ~~5-7 days~~ | **Decision closed 2026-04-09** | The `DEFERRED_GBUFFER` FR key was already removed from `FeatureRendererKey.js` earlier in the session. The `DeferredGBuffer.wgsl` + `DeferredLighting.wgsl` reference shaders stay in the tree as documentation of the intended architecture — if a future "clustered forward" effort outgrows the current multi-light brute force, they can be picked up again. No FR key, no dispatcher, no consumer wire: the decision is "keep the reference shaders, skip the full implementation until a real many-lights scene justifies it". Tracked in STATUS as resolved. |
| -- | **General particle system** | 2-3 days | Already works | `ParticleSystem`/`ParticleEmitter` already auto-route through `BillboardCollection` (confirmed S20). No-op closure. |

---

## 7. Dormant Compute Shaders

Per the WIRING_AUDIT analysis, all dormant compute shaders have working fallbacks. They are performance optimizations to be wired when their consumer systems need them.

| Shader | Fallback | Activation Trigger | Effort | Status |
|--------|----------|-------------------|--------|--------|
| `HiZPyramid.wgsl` | Conservative "assume visible" stub in `OcclusionCulling.js` | Wire into `ViewportExecutor` with Hi-Z occlusion (Phase 3) | 3-4 days | **WGSL complete + dispatcher exists** in `WebGPUPerformanceManager.dispatchHiZPyramid()`. `OcclusionCulling.initialize()` is an API stub (deferred to "full WebGPU integration phase"). **Needs**: populate `OcclusionCulling.initialize()` to allocate the Hi-Z mip pyramid texture + wire `testCommands()` to call the dispatcher. ~200-300 LOC. |
| `OcclusionTest.wgsl` | Same as HiZPyramid | Wire alongside HiZ | (combined with above) | **WGSL complete + dispatcher exists** in `WebGPUPerformanceManager.dispatchOcclusionTest()`. Shares the same `OcclusionCulling` shell — activates with HiZ. |
| `PointCloudSort.wgsl` | Unsorted rendering works; `WasmPointCloudBridge.sortByDistance()` available | Wire when point cloud visible | ~~2-3 days~~ **Dispatcher landed 2026-04-09** | New `WebGPUPointCloudSortDispatcher` (`Renderer/WebGPU/WebGPUPointCloudSortDispatcher.ts`) self-contained sort wrapper: owns the SortParams UBO + sortKeys + indices buffers, handles power-of-two padding (sentinel keys sort to back), encodes the local phase (`localBitonicSort`) and the (k, j) global merge loop (`globalBitonicMerge`) into a single `sort(encoder, distSq, count)` call. Diagnostic counters via `getStatistics()`. Spec coverage of the pure-JS helpers (`nextPow2`, `floatToSortableUint`, ordering preservation) — 11 specs. **Remaining**: consumer integration in the point cloud collection path (one-line `if (perfMgr.shouldUseGPUPointCloud(N)) sortDispatcher.sort(...) else wasmBridge.sortByDistance(...)`). |
| `GPUSortKeys.wgsl` | JS multi-level comparators in Scene.js (always active) | Wire when >50K commands per frame | 2-3 days | **WGSL complete + dispatcher exists** in `WebGPUPerformanceManager.dispatchGPUSortKeys()`. **Most incomplete**: needs SOA buffers for command metadata (centerX/Y/Z, layer, priority, materialId) allocated in Scene + a bind group factory + integration into RenderScheduler's sort pipeline. ~400-500 LOC. Lowest priority unless a real scene exceeds 50K commands. |

**Already activated** (see STATUS): PolygonSignedDistance, BrdfLutGenerate, IrradianceConvolution, RadiancePrefilter, FrustumCull (with subgroup variant), AtmosphereLUT (dispatch + consumer wired S26), PointCloudLOD (subgroup dispatcher S26), WeatherParticles (compute + render S18).

---

## 8. Modern WebGPU Feature Integrations (WGF)

| # | Feature | WebGPU API | CesiumJS Impact | Effort | Status |
|---|---------|-----------|-----------------|--------|--------|
| **WGF-3** | **WGSL `texture_and_sampler_let`** | Assign texture/sampler to `let` variables | Cleaner shader code, prepares for future bindless textures | 0.5-1 day | **No work needed** (S21 audit) — sampler-as-let pattern already used in `sampleImagery()`. |
| **WGF-4** | **Uniform Buffer Standard Layout** (`uniform_buffer_standard_layout`) | Removes std140 padding requirements | Smaller uniform buffers (camera, tile, effects). Currently we manually pad with `_pad0`, `_pad1`. Standard layout eliminates ~20% of UBO waste. | 1-2 days | Not started |
| **WGF-7** | **Enhanced Texture Formats** (Tier 1 & 2 storage textures) | Broader storage usage on rgba16float, rg32float; Tier 2 read-write storage | Compute shader outputs (atmosphere LUT, SDF, Hi-Z buffer) can use richer formats; read-write enables single-pass algorithms | 1-2 days | **No immediate work needed** (S21 audit) — current 8 storage-write shaders already use the right format for their kernel output. Wire when a new compute shader needs the richer format. |

**Already landed** (see STATUS Section 2): WGF-1 Subgroups (FrustumCull `mainSubgroups` + PointCloudLOD `computeMainSubgroups` + dispatcher), WGF-2 Transient Attachments (`WebGPUFramebufferManager` reads `TRANSIENT_ATTACHMENT` flag with feature detection + `storeOp: "discard"`), WGF-5 Texture Component Swizzle (S21: dynamic vector subscript replaces if-else chain), WGF-6 Primitive Index (`csm_primitiveIndex.wgsl` chunk + `WebGPUPrimitiveIndexUtils.ts` + production wiring through `Scene.debugShowTriangulation`), WGF-8 EXIF/Orientation Image Upload (S21: `WebGPUImageUpload.ts` + `createTextureFromImageAsync()`).

### WebGPU API Features Detected But Not Used

| Feature | Status | Opportunity |
|---------|--------|-------------|
| `shader-f16` | Detected, unused | Half-precision math in shaders → 2× bandwidth, 2× ALU on supported GPUs |
| `dual-source-blending` | Detected, unused | True OIT without MRT — single-pass weighted blended OIT |
| `indirect-first-instance` | Detected, unused | GPU-driven rendering with per-instance data indexing |
| `bgra8unorm-storage` | Detected, unused | Direct compute write to swap chain format |
| `clip-distances` | Detected, unused | Hardware clipping planes (vs fragment discard) — better perf |
| `timestamp-query` | Wired in profiler | Currently infra-only; enable for automated perf regression tests |
| `float32-filterable` | Used for depth | Could also be used for HDR texture sampling |

### WebGPU Features Not Yet Detected/Requested

| Feature | Status | Opportunity |
|---------|--------|-------------|
| `chromium-experimental-multi-draw-indirect` | Not detected | Single API call for N draw commands — massive CPU reduction. Pairs with `WebGPUIndirectDrawManager`. |
| `chromium-experimental-read-write-storage-texture` | Not detected | Read-write textures in compute (in-place image processing) |
| `chromium-experimental-unorm16-texture-formats` | Not detected | 16-bit normalized textures for compact terrain height data |
| `GPUExternalTexture` | Not used | Zero-copy video texture import (video draping on terrain) |

---

## 9. Missing Visual Features (Industry Comparison)

These features are standard in Babylon.js / Three.js / PlayCanvas / Filament / Bevy and would close visual quality gaps. None are blocking, all are additive.

### Critical Missing — Available in ALL Major WebGPU Engines

| Feature | Industry Status | Our Status | Impact | Effort |
|---------|----------------|------------|--------|--------|
| **Temporal Anti-Aliasing (TAA)** | All engines | ❌ Missing (FXAA only) | Far superior to FXAA for moving scenes | 3-4 days |
| **Cascaded Shadow Maps (CSM)** | All engines | ❌ Missing | Efficient shadow rendering for large outdoor scenes | 4-5 days |
| **Motion Blur** | Babylon, Three.js, PlayCanvas | ❌ Missing | Cinematic quality for camera/object movement | 2-3 days |

### Important Missing — Available in Most WebGPU Engines

| Feature | Industry | Our Status | Impact | Effort |
|---------|----------|------------|--------|--------|
| **Volumetric Lighting/Fog** | Babylon, Three.js, Unreal | ❌ Missing | God rays, volumetric clouds, atmospheric scattering | 4-5 days |
| **Color Grading / LUT** | Babylon, Three.js | ❌ Missing | Film-quality color correction | 1-2 days |
| **Contact Shadows** | Babylon, Three.js | ❌ Missing | Small-scale ground contact shadows | 2-3 days |
| **Subsurface Scattering (SSS)** | Babylon, Filament | ❌ Missing | Realistic skin, foliage, marble rendering | 3-4 days |
| **GPU Particle System (general)** | Babylon, Three.js, PlayCanvas | ⚠️ Weather only | Compute-based particles — fire, smoke beyond weather | 3-5 days |
| **Clustered/Tiled Deferred Lighting** | Standard | ❌ Missing | Efficient many-lights (our multi-light is brute force) | 4-5 days |
| **Light Probes / SH Lighting** | Standard | ❌ Missing | Pre-baked indirect lighting | 3-4 days |
| **Parallax Occlusion Mapping** | Standard | ❌ Missing | Depth on flat surfaces without extra geometry | 2-3 days |

### Nice to Have — Cutting-Edge

| Feature | Status | Notes |
|---------|--------|-------|
| **Ray Tracing** | Not in WebGPU spec yet | Coming in future spec revisions |
| **Mesh Shaders** | Not in WebGPU spec yet | Google has proposals |
| **Variable Rate Shading (VRS)** | Not in WebGPU spec | Available in DirectX 12/Vulkan |
| **Procedural Sky / Dynamic Clouds** | Babylon, Unreal | We have static atmosphere only; volumetric clouds would integrate with `ProceduralClouds.wgsl` |
| **Ocean FFT** | Three.js, Unreal | We have multi-octave wave normals; FFT would be a quality bump |
| **Terrain Tessellation (GPU)** | Native engines via tess shaders | WebGPU has no tessellation stage — use compute + indirect |

### CesiumJS-Specific Missing Features

| Feature | Why Important | Effort | Priority |
|---------|---------------|--------|----------|
| **Procedural textures for globe** | Cloud layers, aurora — future CesiumJS feature | 3-5 days | Low |
| **Terrain blend/splat mapping** | Multi-texture terrain at close range | 3-5 days | Low |
| **Vector tile rendering** | Upstream #2132 — largest open request. Buffer primitives done, full vector tile path remaining | 5-10 days | Low |

### Weather Effects Not Yet Implemented

`WeatherParticles.wgsl` covers rain/snow/fog/hail GPU particle simulation + render pass (S18). Open weather features:

| Effect | Approach | Effort | Priority |
|--------|----------|--------|----------|
| **Volumetric Fog** | Ray-march compute shader | 4-5 days | Medium |
| **Volumetric Clouds** | Noise-based ray march on sky hemisphere | 5-7 days | Medium |
| **God Rays** | Radial blur post-process from sun position | 2-3 days | Medium |
| **Wet Surfaces** | PBR roughness reduction + darkening when raining | 1-2 days | Low |
| **Aurora Borealis** | Procedural shader on sky dome (noise + curtain function) | 2-3 days | Low |
| **Sandstorm/Dust** | GPU particles + distance fog tinting | 2-3 days | Low |
| **Lightning** | Custom ray + bloom | 2-3 days | Low |

#### CesiumJS-Specific Weather Considerations
1. **Planetary scale** — weather must be geographically zoned, not screen-space
2. **Altitude-aware** — snow above freezing, rain below; cumulus ~2000m, cirrus ~8000m
3. **Time-of-day integration** — weather interacts with day/night cycle
4. **Terrain interaction** — particles collide with actual terrain elevation
5. **Performance at globe scale** — fade out at orbital zoom levels
6. **Data-driven** — future integration with weather APIs (OpenWeatherMap, NOAA)

---

## 10. WASM Expansion Opportunities

| Target | Current Approach | WASM Benefit | Estimated Speedup | Effort |
|--------|-----------------|-------------|-------------------|--------|
| **glTF decode** | JS in `GltfLoader.js` | SIMD accessor decode, mesh optimization | 2-4× for large models | 3-5 days |
| **Batch transform update** | JS per-entity `Matrix4.multiply` | SIMD f32x4 batch multiply | 3-5× for >1K entities | 2-3 days (partially done in `matrix_batch.rs`) |
| **Terrain mesh stitching** | JS in `TerrainMesh.js` | SIMD edge matching, skirt generation | 2-3× | 2-3 days |
| **Quadtree traversal** | JS in `QuadtreePrimitive.js` | Batch tile selection with SOA layout | 2-3× for deep quadtrees | 3-4 days |
| **3D Tiles traversal** | JS in `Cesium3DTilesetTraversal.js` | Batch bounding volume tests | 3-5× for large tilesets | 4-5 days |
| **KTX2 super-decompression** | WASM `basis_transcoder` exists | Add ASTC/ETC2 → BC transcode for WebGPU | 1.5-2× memory savings | 2-3 days |

---

## 11. Performance Roadmap

### Architecture-Level Performance (Built or Wired — see STATUS for activation status)

| Opportunity | Current State | Expected Benefit | Effort |
|------------|--------------|------------------|--------|
| **Bind group caching** | Recreated frequently | Cache by content hash → 50% fewer creations | 2-3 days |
| **Texture atlas consolidation** | Separate textures per billboard/point | Single atlas → 30-50% fewer draw calls | 3-4 days |
| **Command buffer reuse** | New encoder per frame | Double-buffer encoders | 1-2 days |
| **Multi-draw indirect** | Individual `drawIndirect()` calls | Single `multiDrawIndirect()` (Chromium experimental) | 1-2 days |

### Shipped Infrastructure (Session 27)

| Item | Status | Integration |
| ---- | ------ | ----------- |
| **MaterialUniformBuffer** | Shipped — `MaterialUniformBuffer.js`, Float32Array backing, auto-layout, dirty tracking | Wired into `Material.js` via `MaterialHelpers.js`; WebGPU fast path in `WebGPUPrimitiveCommands.js` |

### Material UBO Architecture (Option B) — IN PROGRESS

**Status:** Shader split complete (49 files), renderer partially refactored, NOT yet functional end-to-end.

| Sub-task | Status | Effort |
| --- | --- | --- |
| MaterialUniformBuffer.js (Float32Array + alignment + facade) | **Done** | — |
| WGSL shader struct split (49 shaders) | **Done** | — |
| Field name alignment (WGSL ↔ JS fabric) | **Partially done** | ~1 day |
| WebGPUPrimitiveCommands.js renderer refactor | **Done** | — |
| WebGPUPolylineRenderer.js renderer refactor | Not started | ~0.5 day |
| WebGPUBillboardRenderer.js renderer refactor | Not started | ~0.5 day |
| Texture binding group shift | Not started | ~0.5 day |
| Effects bind group shift | Not started | ~0.5 day |
| .js shader wrapper regeneration | Not started | 5 min (gulp build) |
| Visual verification all 25 material types | Not started | ~1 day |
| **Total remaining** | | **~3-4 days** |

**Architecture reference:** WebGPUModelRenderer.js already uses separate material UBO (group 1, 320 bytes). The primitive/polyline/billboard refactor follows the same pattern.

**Key risk:** Field name mismatches between WGSL MaterialUniforms and JS fabric templates cause silent data corruption. Each material type's shader struct must be verified against its Material.js fabric definition.

### New Compute Shader Opportunities

| Target | Benefit | Workgroup Pattern | Effort |
|--------|---------|-------------------|--------|
| **Terrain LOD selection** | GPU-side tile visibility + LOD decision | 1D dispatch over tile array | 2-3 days |
| **3D Tile GPU culling** | Bounding volume hierarchy test on GPU | Hierarchical dispatch | 3-4 days |
| **General particle simulation** | Fire, smoke, custom particles via compute | Update + emit + compact pattern | 3-5 days |
| **Ocean FFT** | Realistic water simulation | 2D FFT butterfly dispatches | 4-5 days |
| **Gaussian Splat sort** | Real-time depth sorting for splats | Radix sort on GPU (similar to PointCloudSort) | 2-3 days |

---

## 12. ES6 Modernization Backlog

~595 files total in scope. ~499 completed (424 via jscodeshift codemod in Session 27 + prior ~75 manual). ~96 files remain.

### Completed (~499 files)

| Directory | Status |
|-----------|--------|
| **Renderer (29/29)** | All JS files converted |
| **Scene high-priority (24+)** | All WebGPU-blocking files converted |
| **DataSources high-priority (8)** | All sorting-related files converted |
| **Appearance classes (4)** | All appearance files converted |
| **Bulk codemod (424 files — Session 27)** | jscodeshift codemod applied: `var`→`const`/`let`, prototype inheritance→ES6 class, `Object.defineProperties`→getters/setters, string concat→template literals |

### Session 27 dependency cleanup (completed)

- **urijs removed** — replaced with native `URL` API across 12 files (0 urijs imports remaining in `packages/engine/Source/`)
- **karma-ie-launcher removed** — IE-specific test runner dependency dropped from devDependencies
- **.indexOf() → .includes()** — complete sweep, 0 remaining instances in engine source
- **InfoBox.js XSS fix** — DOMPurify integration for user-supplied HTML content

### Remaining (~96 files — complex patterns)

These files were skipped by the codemod due to patterns requiring manual judgment:

- **Method alias patterns** (~20 files): `Foo.prototype.bar = Foo.prototype.baz` aliases that become static methods or need refactoring
- **Multi-class files** (~15 files): files exporting more than one constructor — need splitting or restructuring
- **Partial conversions** (~30 files): files where the codemod detected ambiguous inheritance chains (mixins, dynamic prototype assignment)
- **Performance-critical math** (~16 files): Cartesian2/3/4, Matrix2/3/4, Quaternion, BoundingSphere — audit against upstream v1.139 before re-doing; some already ported upstream
- **urijs in Specs** (~8 files in `Specs/`): test files still importing urijs — low priority, does not affect production build

**Rule:** Never modernize files you're not otherwise touching. Always modernize if making >10 lines of changes.

---

## 13. Upstream Issues (Unaddressed)

42 open upstream issues that our fork has NOT addressed. Top priorities:

### Camera & Navigation (7 issues)
Camera boundary/constraints (#4802), Follow-camera (#5241), Mouse wheel zoom jumpy (#4537), Scroll zoom high refresh (#12187), KML flyTo underground (#4327), Touch controls (#4363), computeViewRectangle 2D/CV (#4346)

### Entity & DataSource (7 issues)
Picking priority overlapping entities (#1592), CLAMP_TO_GROUND billboard (#4776), Dynamic boxes tracking (#5164), Scene ready event (#4422), Custom PositionProperty (#9491), Clamped polygons mobile (#9702), WMS GetFeatureInfo position (#9363)

### Rendering & Graphics (6 issues)
Blinking entity shader update (#12532), Fit texture coords (#4164), Material difference 2D (#9853), Animated billboards (#2319), disableDepthTestDistance picking (#6840), Extruded geometry terrain (#4743)

### Other Categories
Memory Leaks (6), 2D/Columbus View (4), 3D Tiles (5), Terrain & Imagery (3), Model/glTF & Build (4), Legacy Code Debt (5)

---

## 14. Priority Remediation Order — Path to WebGL Parity

> **Updated April 8, 2026.** All Tier 1-3 work is complete (see STATUS sections 2-3). Focus now: visual verification, expand testing, activate remaining dormant compute shaders, close visual feature gaps.

### Phase 1: Visual Verification & Bug Closure (1-2 weeks)

1. **Visual smoke test all S16/S17/S18 fixes** — Stars/skybox, shadow casting, render bundle perf, advanced renderers (Cloud/Voxel/GaussianSplat/PointCloud/Ellipsoid), 2D/Columbus View modes
2. **BUG-11 imagery** — Use the probe checklist in §1 (existing diag logs first, then alpha/texCoordsRect/cache hypotheses)
3. **SHADOW-LAYOUT** — Per-vertex-layout shadow cast pipeline cache (1-2 days)
4. **BUG-5/6 edge cases** — Reproduce + close
5. **FORK-8** — Last residual `isWebGPUDrawCommand` check in Scene.js

### Phase 2: Testing & Quality (4-5 weeks)

6. **FORK-19b** — Expand Jasmine spec coverage to 1 spec per FR + per major utility (~50 → ~150 tests)
7. **Visual regression CI** — Activate `Tools/visual-regression/` with baseline corpus + tolerance config
8. **Browser compatibility** — Safari, Firefox WebGPU testing matrix
9. **Performance benchmarking** — Fixed-camera scenes + frame-time logging; verify the perf wins from S16/S17/S26 (render bundles, GPU culler, atmosphere LUT, point cloud subgroups)

### Phase 3: Dormant Compute Shader Activation (2-3 weeks)

10. **HiZ + OcclusionTest** — Wire into ViewportExecutor for occlusion culling
11. **PointCloudSort** — Wire when point cloud collection visible (depth sort for translucent points)
12. **GPUSortKeys** — Wire when scene exceeds 50K commands (replace JS comparators on the hot path)

### Phase 4: Visual Quality Closure (4-6 weeks)

13. **TAA** — Temporal anti-aliasing as WGSL post-process
14. **CSM** — Cascaded shadow maps for outdoor scenes
15. **Volumetric fog/lighting** — God rays, scattering
16. **Color grading** — LUT-based color correction
17. **Subsurface scattering** — Skin/foliage rendering
18. **Clustered lighting** — Efficient many-lights for urban scenes
19. **Vector tile rendering** — Build on top of Buffer Primitive renderers
20. ~~Deferred G-Buffer — closed 2026-04-09 (FR key removed; reference shaders kept)~~

### Phase 5: Modern WebGPU Feature Adoption (2-3 weeks)

21. **WGF-4 Standard Layout UBOs** — Remove manual std140 padding, ~20% UBO size reduction
22. **`shader-f16`** — Wire half-precision math in selected fragment shaders for 2× bandwidth/ALU
23. **`dual-source-blending`** — Single-pass weighted blended OIT
24. **`clip-distances`** — Hardware clipping planes (vs fragment discard) for clipping perf
25. **`chromium-experimental-multi-draw-indirect`** — Pair with `WebGPUIndirectDrawManager` for single-call N-draw rendering

### Phase 6: Naga-wasm Spike Productionization (1 week, optional)

26. **Naga-wasm bind-set remapping** — Naga emits raw `@group/@binding` from GLSL `layout(binding=...)`; need a layout reflection step
27. **Vertex attribute location remapping** — Stride/format normalization between source GLSL and consumer pipelines
28. **Specialization-constant injection** — Map GLSL `#define`s to WGSL pipeline-overridable constants
29. **Replace WebGL stub for shaders Naga handles** — Incremental retirement of `WebGLCompatibilityStub.ts`

### Phase 7: Long-Tail Cleanup (Ongoing)

30. **ES6 modernization** — Continue under the "10-line touch rule"
31. **Console noise reduction** (4.8) — Route bare `console.warn/error` through `context.log()`
32. **Test page consolidation** (FORK-20/21/22) — Standardize loading patterns + share shaders
33. **Upstream sync** — Periodic sync with `CesiumGS/cesium` main
34. **Upstream issue triage** — Pick off the 42 open issues most relevant to WebGPU users

---

*This backlog supersedes all previous versions. For per-session bug fix detail, completed work, and architecture, see `WEBGPU_MIGRATION_STATUS.md`. The legacy `WIRING_AUDIT_2026_04_02.md`, `COMPREHENSIVE_AUDIT_2026_03_31.md`, and `WEBGPU_DEBUGGING_LOG.md` documents are preserved for historical reference but their open items have been pulled forward into this file and STATUS.*
