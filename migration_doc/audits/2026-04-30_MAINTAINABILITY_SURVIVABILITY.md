# Maintainability, Survivability & Integration Audit

**Date:** 2026-04-30  **Branch:** main @ 92e9a5d5c2 (Batch 116)
**Method:** code-verified — claims grounded in file paths and line numbers; doc claims cross-checked against actual source.

---

## Executive summary

The fork's lifecycle backbone is in good shape. `GraphicsContext` abstract base + `ContextRegistry` + `ContextFactory` + `WebGPUDeviceLossRecovery` (extracted to its own 331-line module) give it the multi-instance / multi-backend / device-recoverable architecture that survives in real Chromium-app contexts. Module-level docstrings are unusually comprehensive — every load-bearing renderer file I read had real explanations of what's shipped vs. deferred. The two material risks for "future-you reading this in a month" are **scale-of-file** (4 files over 2000 lines, 18 over 1000) and **silent failure modes** (a handful of placeholders that look like real renderers — most notoriously `WebGPUSSREffect.ts` whose normal G-buffer is fed `undefined` at the call site — and one stale docstring on `WebGPUVolumetricFogRenderer.ts` that materially understates what's actually implemented). The compliance with the project's own CLAUDE.md rules is genuine, not paper: TypeScript `any` ban has only **2 real uses** in the entire WebGPU directory, pragma-wrapped logging is consistently applied, and the backend-agnosticism rule is honored everywhere except 15 transitional `Scene/` branches that are all justifiable as in-flight migrations.

---

## Doc inaccuracies surfaced during verification

These hurt the "future-you reads this in a month" test more than any structural issue, because they actively mislead:

| Source | Claim | Reality |
|---|---|---|
| `WebGPUVolumetricFogRenderer.ts:11–18` docstring | "Phase 5a contract — no visual change. Compute kernels are placeholders that clear textures to zero." | `VolumetricFog.wgsl:1` says **"Phase 5b real kernels (height fog + sun/moon scattering + front-to-back integration)"** and the file ships 485 lines of real implementation including HG scattering, sun shadow sampling, FBM noise. **The renderer-side doc is materially stale** and is exactly the failure mode CLAUDE.md "Dead Code Audit" warned us about (paragraph from the *opposite* direction — here a real implementation is mistakenly described as scaffolding). |
| `cesium-webgpu/CLAUDE.md` "Dead Code Audit" example using VolumetricFog | Cites VolumetricFog as the canonical "kernels are placeholders" case | The example needs to be replaced. `WebGPUTranslucentTileClassification` Batch 47 composite scaffolding is still a valid example. |
| Prior session summaries' "Six orphaned `Model<Extension>Stage.wgsl` files" | Implies 6 separate KHR-extension shader files exist on disk | **None exist.** `ls Source/Shaders/WebGPU/Model/` shows 7 stage files (`Atmosphere`, `CPUStyling`, `Color`, `PBRComplete`, `PointCloudStyling`, `Silhouette`, `Splitter`) — none for KHR extensions. KHR support lives *inside* `ModelPBRComplete.wgsl` as bit-flagged paths (`FLAG_HAS_CLEARCOAT/SPECULAR_EXT/ANISOTROPY/IRIDESCENCE/SHEEN/VOLUME/TRANSMISSION` bits 19–25). |

These are the only material doc inaccuracies; everything else verified.

---

## 1. Code readability (1-month-later test)

**Rating: B+**

What works (verified by reading 12+ representative files):

- Every WebGPU renderer file I sampled has a real module-level docstring explaining what it owns. `WebGPUDeviceLossRecovery.ts:1–12` is exemplary; `WebGPUVolumetricFogRenderer.ts:1–43` has a thorough one *that is wrong*; `WebGPUTAAEffect.ts:1–17` is a clean and accurate compact summary; `WebGPUSSREffect.ts:1–16` documents toggles and configuration knobs.
- Inline comments explain *why*, not *what*. The TAA params UBO layout at `WebGPUTAAEffect.ts:36–48` documents byte offsets and the rationale for each field with line-by-line precision.
- Batch numbers are referenced at every load-bearing site (`Batch 47`, `Batch 110`, `C-R8-EDGE-FBO`, `NEW-4-A`); `migration_doc/WEBGPU_DEBUGGING_LOG.md` (4560 lines) and `migration_doc/DEFERRED_WORK.md` (534 lines) cross-reference them.
- TypeScript types document interfaces well: `DeviceLossRecoveryHost`, `DeviceLostCallback`, `DeviceLossState` enum, `SSRCache`, `PostProcessEffect`. The interface-shape contract is greppable and explicit.

Best examples (templates for new files):

- [WebGPUDeviceLossRecovery.ts](../../packages/engine/Source/Renderer/WebGPU/WebGPUDeviceLossRecovery.ts) — 331 lines, single responsibility, every public method has a JSDoc, the state-machine type is exported, the `dispose()` race-handling is explicit.
- [WebGPUTAAEffect.ts](../../packages/engine/Source/Renderer/WebGPU/WebGPUTAAEffect.ts) — 656 lines, the byte-offset UBO comment is the kind of artifact that saves a future debug session.
- [FeatureRendererKey.js](../../packages/engine/Source/Renderer/FeatureRendererKey.js) — 167 lines, every enum slot has a comment explaining what it owns.

Worst examples (will be hard to navigate next month):

- [WebGPUContext.ts](../../packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts) at 4363 lines — central nervous system; everyone reads it; the absolute size penalizes IDE navigation.
- [WebGPUGlobeSurfaceRenderer.ts](../../packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts) at 3933 lines — mixes 4 concerns (tile pipeline cache, tile uniform packing, debug-fragment-mode probe, clip-distances variant).
- [WebGPUSceneRenderer.ts](../../packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts) at 3626 lines.
- [WebGPUGroundPolylineRenderer.js](../../packages/engine/Source/Renderer/WebGPU/WebGPUGroundPolylineRenderer.js) at 2752 lines — JavaScript not TypeScript, sits at the awkward intersection of a still-broken VS extrusion bug and a working color/depth path.

**Patterns that will confuse future-you:**

- "Allocated but unwritten" textures and "no-op render passes" are *intentional scaffolding* per CLAUDE.md "Dead Code Audit" rule. The rule depends on writers actually putting "Phase 5a contract — no visual change" in the docstring. **VolumetricFog shows the failure mode in reverse:** the kernels were filled in but the docstring wasn't updated, so future-you would see "no-op kernels" in the file's own docstring and disbelieve the actual WGSL. Mitigation: a periodic drift-check that compares `*.ts` docstrings against companion `*.wgsl` headers.
- Public underscore-prefixed fields (`context._device`, `context._adapter`, `context._ssrCache`) are a deliberate convention but mean external code can write to them without the compiler complaining. Documented.
- Same-file diagnostic latches (`_execDebugLogged`, `_globePassRPLogged`, `_diagTileCount`, `_postInitDebugLogged`, etc., concentrated in `WebGPUSceneRenderer.ts` and `WebGPUGlobeSurfaceRenderer.ts`) — each is correct in isolation; collectively they're additional state that nobody resets. They're stripped in prod via pragmas, so runtime cost is zero — but the code-reading cost is real.

---

## 2. Failure modes

| Failure | Severity | Verified state | What's missing |
|---|---|---|---|
| **Device lost (driver crash, OS sleep)** | 5 | `WebGPUDeviceLossRecovery.ts:139–211` — exponential backoff, max 3 attempts, full re-init via the `DeviceLossRecoveryHost` interface (`_setAdapter`, `_setDevice`, `_initializeContextLimits`, `_reconfigureCanvas`, `_initializeDefaultTextures`, `_clearAllCaches`). 3-state machine `HEALTHY/RECOVERING/FATAL`. `dispose()` correctly handles destroy-during-recovery race. Verified by reading the file. | Per-object caches (`model._webgpuCache`, etc.) not on the cache-clear walk per `C-R12-PER-OBJECT-CACHES`. They get reaped next-frame because owning renderers destroy + recreate, but a future cache that doesn't churn will use a stale handle. |
| **OOM** | 4 | `WebGPUGlobeSurfaceRenderer.ts:2577–2581` documents BUG-9 — per-tile fresh `device.createBuffer` was giving Device-Lost-(OOM). Fixed by ring-buffer suballocation. | No `pushErrorScope("out-of-memory")` use — only `validation` scopes (verified). A real OOM during render comes back as a device-lost event and follows that path. No app-side "memory pressure" callback to graceful-degrade LOD. |
| **Shader compile failure** | 4 | `WebGPUContext.ts:1523–1527` logs the shader compile message with context ID; `WebGPUShaderModule.ts` has 4 `console.error` sites. | No auto-fallback to a "magenta error" placeholder shader. A compile failure on a hot-path shader yields a render hole. |
| **Pipeline create failure** | 4 | Three `pushErrorScope("validation") / popErrorScope().then(err => console.error(...))` sites verified: `WebGPUGlobeSurfaceRenderer.ts:628–637 + 713–718`, `WebGPUPostProcessPipeline.ts:1093–1094`, `WebGPURenderBundleManager.ts:403–412`. `WebGPUPostProcessPipeline.ts:1069–1094` (f16 → f32 fallback) is the **only** auto-fallback path. | "Auto-fallback to a known-good pipeline variant" pattern is implemented for f16 only. |
| **Lost canvas (tab background, monitor disconnect)** | 3 | Same path as device-lost on Chromium; `WebGPUDeviceLossRecovery._reconfigureCanvas()` re-configures the swap-chain. | No explicit `visibilitychange` handler — Chromium silently drops the swap-chain so this is mostly moot. |
| **WebGPU not available (Firefox release, Safari < 18, blocked GPU)** | 3 | `ContextFactory.ts` checks `isWebGPUSupported()` (`typeof navigator !== "undefined" && "gpu" in navigator`) and falls back to WebGL with `console.warn`. `setGlobalDefaultRenderer()` lets variant entry barrels override. | The detection only checks for `navigator.gpu` presence. There's no "request adapter, see if it returns null, then fall back" path at the factory level — that responsibility falls on `WebGPUContext.create()` which throws and caller catches. Apps using `renderer: 'auto'` get correct behavior; apps using `renderer: 'webgpu'` do NOT auto-fall-back if `requestAdapter` returns null at runtime. |
| **GPU validation errors (silent post-init)** | 3 | One-time per-frame error scope at `WebGPUSceneRenderer.ts:2083–2099` catches first-frame validation regressions on the globe pass. | Per-frame validation scope is not a permanent diagnostic; it ships off after the first frame. A regression introduced mid-session (e.g. format mismatch from an HDR toggle without bumping `_scenePipelineFormatGeneration`) is silent until reload. |
| **SSR samples uninitialized normal placeholder** | 3 | Verified at `WebGPUSceneRenderer.ts:2774` (`undefined, // normalTextureView — uses placeholder`) and `WebGPUSSREffect.ts:158–162` (fallback to `ensureNormalTexture` when no view passed). The placeholder is allocated but nothing writes to it. **SSR ships rendering noise, not reflections** — and there is no console warning. | Phase-8a Foundation (FEAT-GAP-01) — normal G-buffer + depth prepass. |
| **Indirect-draw count overflow / index buffer overflow** | 3 | CLAUDE.md says new subsystems "SHOULD add" guards. Spot-check: `WebGPUSceneRenderer.ts:1028–1038`, `:1077–1091`, `:1106–1129` have re-entry / null-FB / first-frame state diagnostics. Some renderers do, some don't. | Not enforced by lint or compile-time check. |

---

## 3. Embeddability (using as a library inside a larger app)

**Multi-instance safety: Strong.** `ContextRegistry.ts` is a `Map<string, RegistrableContext>` keyed by per-context `createGuid()` IDs. `WebGPUContext` declares `_id: string` per-instance. Two viewers / one tab / one device pool: `WebGPUDevicePool.acquireDevice()` ref-counts a single `GPUDevice` across canvases (Strategy B); `releaseDevice()` destroys when refCount hits 0. The architectural intent is multi-context-friendly and the implementation matches.

**Global state pollution: Minimal.** Verified by `Grep`:

- `globalThis|window\.` writes outside debug-helper code: 3 hits across 138 WebGPU files (`WebGPUContext.ts:1010` is a comment, `WebGPUSkyAtmosphereRenderer.js:632` is a once-per-tab debug-log latch, `WebGPUTimestampProfiler.ts:353` is a comment). The sky-atmosphere latch (`globalScope.__skyAtmoDiagLogged`) is the only real pollution and it's a tiny one.
- `_globalDefaultRenderer` in `RendererType.ts` is the one process-wide singleton with explicit setter/getter, used by build-variant entry barrels. Multi-Viewer apps that mix backends in one tab cannot have both barrels set different defaults — but each `Viewer` passes `contextOptions.renderer` explicitly, bypassing the global. **Risk: low if you always pass `renderer:` explicitly; medium if you rely on the default.**

**Module side effects:** Variant entry barrels (`Source/Cesium.js`, `Source/CesiumWebGLOnly.js`, `Source/CesiumWebGPUOnly.js`) call `setGlobalDefaultRenderer()` at module init. The root `package.json` declares these as side-effectful so bundlers don't tree-shake. This is the **only** side-effect-on-import in the renderer surface.

---

## 4. Browser portability

**Chrome / Edge (Chromium):** First-class. WebGPU enabled by default since Chromium 113. Visual regression baseline runs Edge.

**Firefox:** Firefox release ships WebGPU as of Firefox 141 (gated in earlier releases). **Playwright's bundled Firefox is *Nightly* and has WebGPU disabled** per CLAUDE.md. Practical impact: there is no Firefox CI; all Firefox compatibility is anecdotal.

**Safari Tech Preview:** No automated coverage. No file in `packages/engine/Source/Renderer/WebGPU/` references Safari, WebKit, or attempts to detect it. The optional-feature probe at `WebGPUDevicePool.ts:272–296` does run `adapter.features.has(f)` checks for `float32-filterable`, `rg11b10ufloat-renderable`, BC/ETC2/ASTC compression — feature gates are *technically* correct on Safari, but no Safari-specific bug workarounds exist.

**Feature detection coverage:**

- `RendererType.ts` — `navigator.gpu` presence check.
- `WebGPUContext.ts:1622–1624, 1650–1663` — runtime feature flags update from `_enabledFeatures` set.
- `useHardwareClipDistances` and `useShaderF16` are explicitly *opt-in even when granted* (rationale at `WebGPUContext.ts:1627–1647`) — right safety posture given some adapters report support but trip on specific operators.
- No `userAgent` sniffing anywhere in `Renderer/WebGPU/` (good).

**Compatibility-mode plumbing exists:** `featureLevel: "core" | "compatibility"` on `WebGPUContextOptions`. Verifying that compat-mode actually downgrades feature requests at adapter request time is a follow-up.

---

## 5. Electron / Chromium-app risks

The fork has no Electron-specific code paths. Risks:

- **GPU sandbox.** Electron / Chromium with `--disable-gpu-sandbox` can break adapter discovery. There's no diagnostic surfacing this — adapter request returns null and `_createWebGPUContext` throws. Apps see a generic "WebGPU is not supported" error.
- **Multi-process IPC.** Renderer process owns the GPUDevice. Cesium does not need to round-trip through IPC. Safe.
- **`file://` URLs.** WebGPU works on `file://` in Chromium. Cross-origin imagery requires CORS — Cesium-general issue, not WebGPU-specific.
- **Off-main-thread rendering.** `OffscreenContextSupport.ts` is plumbed for OffscreenCanvas in worker. Path is opt-in via `useOffscreenCanvas: true`. Works in Electron.
- **Windowed-vs-fullscreen device-lost.** Electron's GPU process restart fires `device.lost`. The recovery path re-requests adapter and device. **No recorded test exists for this scenario.**
- **HDR tonemapping in Electron.** HDR canvas is a Chromium feature behind a flag. The pipeline format generation counter (`_scenePipelineFormatGeneration`) handles runtime HDR-toggle correctly, so this should "just work" on Chromium-with-HDR-flag.

---

## 6. Compliance with stated CLAUDE.md rules

**TypeScript `any` ban: Excellent.** `Grep` for `as any|: any\b` in `Renderer/WebGPU/*.ts` returned **2 real uses across 1 file**, plus 9 hits that are comments documenting the ban or how to avoid `any`:

- Real uses: `WebGPUShaderCache.ts:396, 398` — annotating debug-only `wgslSource` and `shaderName` fields on a wrapped `GPUShaderModule` for browser DevTools. Architectural justification is clear.
- Comment hits: `WebGPUSceneRenderer.ts:93–94` and `:642` are explicit explanations of how to avoid `as any` patterns; `webgpuTypeHelpers.ts` is an entire module dedicated to type-safe alternatives; `cesium-js-types.d.ts:11` is a comment explaining how to update the types when `as any` would otherwise be needed.

That is effectively zero. The ban is being enforced, not paid lip service.

> Note: an earlier draft of this audit reported "5 real uses." That count included comments. Actual real `as any` casts: **2**.

**Pragma-wrapped logs: Compliant.** `Grep` for `console.log` / `console.warn` returned 83 occurrences across 28 files; pragma-wrapped blocks (`//>>includeStart('debug',...)`) appear in 67 sites across 58 files. Sampling: `WebGPUSceneRenderer.ts:1028–1038, 1076–1092, 1102–1129` all pragma-wrapped. Real errors are *intentionally* permanent (e.g., `WebGPUSceneRenderer.ts:1190` `console.error` for null FB target, `:2090` validation-scope catch). Compliance is real, not on-paper.

**Files >1000 lines: 18 files** (verified by `wc -l`). Top offenders ranked:

| File | Lines |
|---|---|
| WebGPUContext.ts | 4363 |
| WebGPUGlobeSurfaceRenderer.ts | 3933 |
| WebGPUSceneRenderer.ts | 3626 |
| WebGPUGroundPolylineRenderer.js | 2752 |
| WebGPUPrimitiveCommands.js | 2456 |
| WebGPUModelRenderer.js | 2296 |
| GraphicsContext.ts | 1783 |
| WebGPUBufferPrimitiveRenderer.ts | 1657 |
| WebGPUPostProcessEffects.ts | 1487 |
| WebGPUEffectsBindGroup.js | 1471 |
| WebGPUShadowMapRenderer.js | 1463 |
| WebGPUCSMRenderer.ts | 1375 |
| WebGPUVolumetricFogRenderer.ts | 1352 |
| WebGPUPolylineRenderer.js | 1308 |
| WebGPUPostProcessPipeline.ts | 1200 |
| WebGPUEnvironmentRenderer.js | 1199 |
| WebGPUModelPipelineCache.js | 1138 |
| WebGPUPointCloudRenderer.ts | 1111 |
| WebGPUBillboardRenderer.js | 1044 |
| WebGPUPointPrimitiveRenderer.js | 1040 |

**Backend-agnostic scene code: Strong compliance.** `Grep` results:

- `from "../Renderer/WebGPU/"` in `Source/Scene/*.js`: **zero hits**. Module-level import boundary is clean.
- `if (context.isWebGPU)` / `if (context.rendererType === "webgpu")` in `Source/Scene/`: **15 real branches across 11 files** (excluding the legitimate getter at `Scene.js:2066`, debug-only sites at `CesiumDebug.js`/`SceneDebug.js`, and comments/legacy at `Scene.js:2060/4634`, `EdgeVisibilityPipelineStage.js:69`).
- `getFeatureRenderer(` in `Source/Scene/`: **38 files**. The FR pattern is the dominant integration point.

The 15 branches are all justifiable as transitional (Vector3DTile family is the newest, depth-sample classifier family) or backend-specific FB orchestration. None look like accidental violations.

---

## 7. Top 10 highest-risk maintainability issues

1. **`WebGPUContext.ts` at 4363 lines** is the central nervous system; everyone reads it. Decomposing the WebGL-compat stub install + ContextLimits init + default-texture lifecycle into companion files would drop ~600–800 lines.
2. **`WebGPUGlobeSurfaceRenderer.ts` at 3933 lines** mixes 4 concerns. High split value because they don't share state much.
3. **`WebGPUGroundPolylineRenderer.js` (2752 LOC, JavaScript)** has a known but currently unfixed VS extrusion bug. **The file itself has no docstring pointer to ADR-2026-04-28** that explains the architectural pivot. A future-you reading this file in a month will see "stencil 2-pass, looks done" and miss the silent black-output bug.
4. **`WebGPUVolumetricFogRenderer.ts` docstring is materially stale** (says "no visual change" while the kernels are actually filled in). This is the inverse failure of the dead-code-audit rule and wastes future-debugging time in the worst direction.
5. **Per-object cache walk on device-loss recovery (`C-R12-PER-OBJECT-CACHES`)** is the one known correctness gap in the device-loss path. Belt-and-suspenders today.
6. **Single global default renderer (`_globalDefaultRenderer`)** is one shared variable across the process. Mixed-backend split-screen apps that don't pass `contextOptions.renderer` explicitly behave unpredictably.
7. **No auto-fallback for failed pipeline creation** (except f16 → f32 in tonemapping). A model with a failed PBR pipeline render-holes silently. Three.js's "magenta error material" pattern would be a small lift and a big debugging win.
8. **No Firefox / Safari CI.** Firefox release ships WebGPU; Safari Tech Preview ships WebGPU. Visual regression runs Edge only. A real Safari user finding a bug today would not surface until manual testing.
9. **Diagnostic logs gated by per-instance `_xxxLogged` booleans, not a global throttle** — concentrated in `WebGPUSceneRenderer.ts` and `WebGPUGlobeSurfaceRenderer.ts`. Pragma-stripped from prod, but the code-reading cost is real.
10. **The `_scenePipelineFormatGeneration` invalidation contract is manual.** Verified: 23 files reference it. One missed reader = stale pipeline + format-mismatch validation warning. No compile-time check that a new renderer is in the readers list.

---

## 8. Recommended near-term fixes (high ROI, low effort)

1. **Fix the VolumetricFog docstring drift.** Replace `WebGPUVolumetricFogRenderer.ts:11–18` "Phase 5a contract — no visual change..." with the actual Phase 5b/5c/5d state. 30-second edit. Highest single-file ROI for future readers.
2. **Add a 2-line ADR-link comment to `WebGPUGroundPolylineRenderer.js`** pointing at `migration_doc/DEFERRED_WORK.md` ADR-2026-04-28 + the known VS extrusion bug. Prevents a future-you from confidently optimizing code that has a known black-output bug.
3. **Surface the SSR placeholder fact** with a console warning when `scene.screenSpaceReflections = true` is enabled and no normal G-buffer is wired. Currently silent, which means users get noise and have no idea why.
4. **Add an "auto-fallback to magenta error pipeline" path** for shader/pipeline creation failures. Infrastructure exists; needs `_createErrorPipeline()` returning a flat-magenta quad fallback when `getOrCreatePipeline` async-rejects.
5. **Wire a `LogThrottle` helper** that unifies the ~12 ad-hoc `_xxxLogged` booleans + `_lastLogTime` patterns. The pragma-stripped predicate pattern at CLAUDE.md:432–447 is the right shape; centralize it.
6. **Add a `pushErrorScope("validation")` wrapper** that runs a scope around every render pass when `frameState.debug` is set, not just first-frame. Catches format-mismatch regressions immediately.
7. **Add Firefox + Safari smoke run** to `Tools/visual-regression/`. Even once-a-week manual run with `playwright install firefox` (release Firefox, not bundled Nightly) and a Safari Tech Preview check would catch worst portability regressions.
8. **Document the `_scenePipelineFormatGeneration` contract** with a sentinel: declare an abstract `recompileForSceneFormat(generation: number): void` on a `WebGPUFormatAwareRenderer` interface. Makes the contract greppable; a future renderer that doesn't implement it fails compilation.
9. **Decompose `WebGPUContext.ts`** by extracting the WebGL-compat stub install (~100+ lines, currently inlined) into `WebGPUContext.attachWebGLCompatStub.ts`. 1-hour mechanical move, drops the central file by a measurable chunk.
10. **For multi-Viewer Electron embedding, document the `setGlobalDefaultRenderer` caveat** in the README/CHANGELOG. One-line doc fix prevents silent default-renderer mismatches.
11. **Add a docstring-vs-WGSL drift check** to CI — periodically grep `*.ts` files for "Phase Xa" or "no visual change" and verify the companion `*.wgsl` headers agree. Caught the VolumetricFog drift here; will catch the next one automatically.

---

## Closing note

The fork is in unusually good shape for "60% parity, batch-N-of-NN" port. The architectural decisions (abstract base class, FR registry, device pool, pipeline-format generation, Naga-aware preprocessor, build-variant alias plugin) are right. Main residual risks are **scale-of-file** (not architecture) and **doc drift on the most opaque pieces** (placeholder vs. real). A future-you reading this code in a month will be helped by docstrings and `migration_doc/` cross-references, but slowed by the ~3000-line core files and tripped up by the VolumetricFog-shaped doc drift. The drift is the bigger long-term risk because it survives every git operation.
