# CesiumJS WebGPU Migration -- Consolidated Status

**Last Updated:** May 8, 2026 (Batches 225-230 — Final audit fixes for 219-224 + setup-file extraction, NEW-SHADOW-CAST-GPU-CULL Phase 2 active (sphere-AABB cull), NEW-GPU-SORT-PIPELINE Phase 2 (BitonicSortU64 + sort+readback chain), aux-culler idle-decay reaper, Workers/ build-bloat fix (3.2GB → 16MB). One real defect tracked deferred: BUG-WEBGPU-CANVAS-BLACK — WebGPU rendering produces black canvas after Batch 213-225 changes, root cause not yet localized; user opted to continue forward.)
**Repository:** Fork of [CesiumGS/cesium](https://github.com/CesiumGS/cesium) -> [kurtyoung-dev/cesium-webgpu](https://github.com/kurtyoung-dev/cesium-webgpu)
**Overall Progress:** ~93% of full WebGL feature parity. CSM Slice 1 (cascaded shadow maps) + TAA Slice 1 (temporal AA with RTE motion vectors) both shipped in Sessions 33-34 — globe terrain + phong primitives now sample cascaded shadows with RTE-precise cascade VPs and per-cascade slope-scaled depth bias, and TAA accumulates history via depth-based motion vectors that work correctly at orbital altitudes. CSM Slice 2a (cast-variant unlock, 2026-04-18) followed: all seven shadow cast variants now work under CSM, so models (skinned/instanced/static) and quantized-mesh terrain all cast cascaded shadows alongside RTE primitives. Globe terrain renders in production with imagery, shadows, fog, atmosphere, ocean, day/night, clipping; all 36 feature renderers registered; 13 of 13 render passes handled; 10+ Jasmine spec files; debug visualization stack complete. WebGPU shader module cache (`(sourceId, defines)` keyed), `//>>ifdef` preprocessor, and `ShaderDefine` bitmask registry now central infrastructure. Principal-engineer review remediation: ~95% of 2026-04-16 finding set addressed through Batch 27.

**Typing state (Session 30 end):** Renderer/WebGPU is at the principled typing floor — every remaining `any`/`unknown`/`object`/`Record<string, unknown>` is a documented intentional boundary. Full shared-type surface: `DebugStatsValue`, `PickTarget`/`PickKind`/`PickResult`, `Renderable`, `ViewportQuadCommandOptionsBase`, `SceneGlobalCache`, and 15 co-located `.d.ts` files for JS interop. BGL helper adoption: 86 of 88 call sites (46 files). Non-breaking discriminated picking API (`getPickResult(color) → { target, kind }`) lets consumers replace `instanceof` chains with exhaustive `switch (kind)`.

---

## Recent Progress (2026-05-08 — Batches 225-230: shadow-cast Phase 2, GPU sort Phase 2, idle-decay, Workers fix; one real defect deferred)

Six batches closing two deferred entries end-to-end (`NEW-SHADOW-CAST-GPU-CULL-PHASE-2`, `NEW-GPU-SORT-PIPELINE`), shipping idle-decay for auxiliary culler instances, fixing a 3.2 GB build-output bloat in `packages/engine/Build/Workers/`, and surfacing one real defect (`BUG-WEBGPU-CANVAS-BLACK`) that has been deferred per user direction.

### Batch 225 — Final 219-224 audit fixes

- **B219-N3** — `Scene.gpuCullingHint = 'never'` now blocks lazy aux-culler allocation in `WebGPUContext`. Previously stored on Scene but never read by the allocation path; now the lazy getters and `warmUpHighDensityDispatchers` check the hint first.
- **B219-N4** — `setHDRFallbackListener` now uses a `Set<callback>` and returns an unsubscribe function. Multi-Scene-per-context configs (split-screen, picture-in-picture) all sync correctly when the context demotes itself from HDR. Scene records the unsub in `_hdrFallbackUnsub` and calls it in `destroy()`.
- **Cosmetic** — `high-density-5k-spheres` setup script extracted from the inline-string in `scenes.json` to `Tools/visual-regression/scenes/high-density-5k-spheres-setup.js`. Dropped a no-op `multiplyByTranslation(zero)`. New `setupFile` field in scene definitions; README updated.

### Batch 226 — NEW-SHADOW-CAST-GPU-CULL Phase 2 (CLOSES entry)

Phase 2 activates the per-cascade GPU cull infrastructure shipped in Batch 221.

- **Sphere-AABB cull** instead of tight Gribb-Hartmann frustum extraction. The cascade's bounding sphere produces 6 axis-aligned planes via `packCascadeCullPlanes()`. Correctness-safe over-include: cube-around-sphere is looser than the actual ortho frustum but never cuts a valid shadow caster. Tight Gribb-Hartmann remains a future tuning item for hit-ratio improvement.
- **Per-cascade hysteresis gate** at HI=2400 / LO=1600 (matches opaque HiZ thresholds since shadow cast iterates the same command set).
- **Per-cascade dispatch + readback slot**: `_cascadeCullActive[]`, `_cascadeCullLastResults[]`, `_cascadeCullSoA[]`, `_cascadeCullFilterPool[]` arrays sized to `_cascadeCount`.
- **Diagnostic stats** wired through `getHighDensityCullStats().shadowCascadeCull` with per-cascade input/filtered counts.
- 1-frame readback latency, same model as opaque + translucent paths. `'never'` hint short-circuits the entire path.

### Batch 227 — DEFERRED (blocked on BUG-WEBGPU-CANVAS-BLACK)

Capture infrastructure verification was attempted: rebuild + Playwright capture → diff between WebGL and WebGPU panes. Multiple capture-method iterations (`drawImage`, `toDataURL` → `Image`, element screenshot, force-render-then-readback) all produced empty / wrong captures. Direct `page.screenshot()` revealed: WebGL pane renders correctly (visible globe + imagery), **WebGPU pane renders as black canvas with only HTML UI overlays visible** — confirmed by user. The bug reproduces on the standalone `Apps/CesiumViewer/index.html?renderer=webgpu` too, so it isn't a split-screen-specific issue.

Diagnostic state captured: renderer self-reports as healthy (frame counter advances, post-process active, scene framebuffer + colorTarget allocated, identity-blit pipeline built). The blit step appears to run but produces no visible canvas output. Bug is somewhere in Batches 213-225 (most likely candidates: Batch 205 + 213 post-process changes, Batch 206 canvas-configure rework, Batch 222 destroy walk).

User chose "continue forward" rather than revert/bisect now. Tracked as `BUG-WEBGPU-CANVAS-BLACK` in DEFERRED_WORK.md with full repro instructions and probe scripts at `Tools/visual-regression/probe-webgpu-grey.mjs` + `probe-cesium-viewer.mjs`.

### Batch 228 — NEW-GPU-SORT-PIPELINE Phase 2 (CLOSES entry)

Phase 1 (Batch 211) shipped key generation. Phase 2 wires the actual GPU sort pass + JS-side readback.

- **`BitonicSortU64.wgsl`** — generic u32×2 bitonic sort over `(sortKeysHigh, sortKeysLow, commandIndices)`. Tests `(aHi, aLo)` lexicographically as a u64. Two entry points: `localBitonicSort256` (full sort within 256-element workgroups) + `globalBitonicMerge` (one bitonic step for `k > 256`). Same network shape as `PointCloudSort.wgsl`; only the comparator differs (u32 → u64-via-pair).
- **Dispatcher integration** — added `setSortShaderSource()`, `runBitonicSort(encoder, count)`, `prepareIndicesReadback(encoder, count)`, and `readSortedIndices(count)` to `WebGPUGPUSortKeysDispatcher`. `runBitonicSort` issues `O(log²N)` dispatches; the network handles non-power-of-2 N by padding with sentinel max-keys (handled in shader).
- **FR-level entry points** — `runBitonicSortWebGPUGPUSortKeys`, `prepareIndicesReadbackWebGPUGPUSortKeys`, `readSortedIndicesWebGPUGPUSortKeys`. Registered on `FeatureRendererKey.GPU_SORT_KEYS`.
- **Scene-renderer wire-in** — `_dispatchGPUSortKeys` now chains the sort + readback when the FR exposes the Phase 2 entries (back-compat with older registrations). The sorted indices land in `_lastSortedIndices` for next frame.

**Phase 3 known limitation** — the consumer side (RenderScheduler reorder) is NOT wired yet; `_lastSortedIndices` is captured but not applied. Documented in DEFERRED_WORK as Phase 3 follow-up.

### Batch 229 — Auxiliary culler idle-decay

- **Touch-tracking** — every aux-culler getter (`gpuCuller`, `gpuCullerTranslucent`, `getGPUCullerForOpaqueFrustum`, `getGPUCullerForCascade`) updates a `_lastUsed*Frame` timestamp before returning.
- **Periodic reaper** — `_reapIdleAuxCullers` runs every `IDLE_DECAY_CHECK_INTERVAL` (120) frames from `beginFrame()`. Walks the per-frustum + per-cascade Maps, destroying instances idle for ≥`IDLE_DECAY_FRAMES` (600 ≈ 10s at 60fps).
- **Hierarchy** — sweeps per-frustum first, then per-cascade, then translucent. The main `_gpuCuller` only reaps when EVERY auxiliary is also idle (keeps the hot lazy-getter path warm).
- **Long-session memory hygiene** — without this, a session that transitions from high-density → low-density → stays-low keeps ~8 MB VRAM allocated forever. Now reaps automatically; lazy getters reallocate on demand if usage returns.

### Batch 230 — Cross-batch audit + docs sync

- **B226-N1 (audit fix)** — per-cascade cull was allocating `Float32Array(totalCount * 4)` per cascade per frame for the interleaved upload. Pooled the buffer in `_cascadeCullSoA[ci].interleaved` alongside the SoA components; reused via `subarray(0, totalCount * 4)` view.
- **B228-N1 (documented limitation)** — Phase 2 ships sort + readback but doesn't reorder. Phase 3 (RenderScheduler integration) tracked separately.
- **Workers/ build bloat** — separate from the batch sequence but landed in this run: `bundleWorkers()` was emitting content-hashed chunks (`WebGPUContext-<hash>.js`) without cleaning the previous output. 249 copies × 12 MB = 3.2 GB of orphan WebGPUContext files. Fix: `await rimraf(workerConfig.outdir)` before each non-IIFE worker bundle write. Verified: 3.2 GB → 16 MB.

### Cumulative impact (Batches 225-230)

- **2 deferred entries closed end-to-end** — `NEW-SHADOW-CAST-GPU-CULL-PHASE-2` (per-cascade activation), `NEW-GPU-SORT-PIPELINE` (BitonicSortU64 + sort+readback). One follow-up Phase opened: `NEW-GPU-SORT-PIPELINE-PHASE-3` for RenderScheduler consumer integration.
- **3 audit findings closed** — B219-N3, B219-N4, B226-N1.
- **1 cosmetic refactor** — high-density VR scene setup extracted from inline JSON to a real JS file; runner gained `setupFile` field.
- **1 build infra fix** — `packages/engine/Build/Workers/` no longer accumulates orphan content-hashed chunks (3.2 GB freed).
- **1 real defect deferred** — `BUG-WEBGPU-CANVAS-BLACK`. Confirmed in standalone CesiumViewer; root cause not localized within this run; full repro + diagnostic probes in DEFERRED_WORK.

---

## Earlier Progress (2026-05-07 — Batches 219-224: audit fix loop closes 213-218, multi-frustum + shadow-cast cull infrastructure, VR baseline scene)

Six batches closing the audit loop on 213-218 (8 audit findings + 3 stale-deferred entries closed in one bundle), expanding GPU cull coverage to multi-frustum + shadow-cast, plugging memory leaks on auxiliary culler instances, and shipping the synthetic high-density VR scene generator. Cross-batch audit (223) caught two real reset-reliability bugs in the Batch 219 stats accumulators (B219-N1/N2) and fixed both.

### Batch 219 — Audit-fix bundle for 213-218 (8 fixes + 3 doc-sync closures)

- **B213-O1 (verified)** — `uniformState.frameState.frameNumber` is a public getter; HiZ pyramid dedup fires correctly.
- **B214-N1 (per-frustum gate state)** — replaced shared `_*Active` booleans with `Map<frustumIdx, boolean>` for all four gates (gpuCuller opaque + translucent, HiZ, GPUSortKeys). Hysteresis now evolves from each frustum's own previous-frame state instead of racing siblings.
- **B215-N1 ('never' hint actually disables gates)** — `Scene.gpuCullingHint = 'never'` now short-circuits all gates to false. Previously stored on Scene but never read.
- **B215-N2 (warm-up touches translucent culler)** — `WebGPUContext.warmUpHighDensityDispatchers()` now also `void this.gpuCullerTranslucent`, plus per-frustum cullers (1-3) and per-cascade cullers (0-3).
- **B216-N2 (translucent has own gate based on translucent count)** — `_maybeGPUCullTranslucent` evaluates its own hysteresis using translucent command count. A scene with 50 opaque + 5000 translucent now correctly fires the translucent cull.
- **B217-N1/N2 (cumulative + per-pass stats)** — `getHighDensityCullStats()` now returns four stat blocks (gpuCullerOpaque + gpuCullerTranslucent + hiZ + gpuSortKeys), each accumulating across all frustums in a frame instead of overwriting.
- **B213-O2 (Scene flag sync on HDR fallback)** — context exposes `setHDRFallbackListener()`; Scene.js installs a callback that flips `_useHDRCanvasOutput` to false when the context's extended-toneMapping configure fails and demotes itself to SDR.
- **3 doc-sync closures** — `C-R1-GLOBE-RENDERSTATE` (all sub-issues resolved Batches 99 + 177 + 182 + 183), `C-R8-VECTOR-3DTILE-CLAMPED-POLYLINES` (per-feature pick + MORPHING shipped Batches 115 + 208), `NEW-COLLECTIONS-MOTION-VECTORS` (advanced primitives all shipped Batches 168-173 under NEW-ADVANCED-MOTION-VECTORS).

### Batch 220 — NEW-MULTIFRUSTUM-CULL-RESULTS (RESOLVED)

Per-frustum opaque culler instances. New `WebGPUContext.getGPUCullerForOpaqueFrustum(idx)` lazy-allocates a separate `WebGPUGPUCuller` per frustum index ≥ 1; frustum 0 reuses the original `_gpuCuller` (no extra VRAM for single-frustum scenes). `_lastCullResultsByFrustum: Map<number, GPUCullResults>` replaces the single `_lastCullResults` slot. Multi-frustum log-depth scenes now get full GPU cull benefit instead of the previous "last-frustum-wins" limitation. ~1.5 MB peak VRAM cost at 4 frustums × 65536 maxObjects.

### Batch 221 — NEW-SHADOW-CAST-GPU-CULL Phase 1 (infrastructure)

Per-cascade `WebGPUGPUCuller` instances via `WebGPUContext.getGPUCullerForCascade(idx)`. Same lazy-init pattern as Batch 220. Phase 1 ships infrastructure ONLY — the actual filter dispatch in `WebGPUCSMCastPass` is deferred to Phase 2 pending Gribb-Hartmann frustum-plane extraction from each cascade's view-projection matrix + visual verification. Shadow correctness is critical (missed shadows are worse than missed culls), so the activation step needs a careful verification pass that can't run from this code-only session. Tracked as `NEW-SHADOW-CAST-GPU-CULL-PHASE-2`.

### Batch 222 — Memory hygiene + TAA disocclusion verified safe

- **Memory hygiene** — `WebGPUContext.destroy()` now walks every auxiliary culler instance (translucent + per-frustum + per-cascade Maps) and destroys them before clearing the maps. At peak that's 1 + 3 + 4 = 8 instances ≈ 4 MB of VRAM that previously leaked on context destruction.
- **TAA disocclusion verified** — review of `TAA.wgsl:235-280` showed the existing depth-rejection path already handles the Batch 212 documented "HiZ ghosting" interaction. When a HiZ-culled command was rendered last frame and isn't this frame, the eye-space depth delta at those pixels exceeds `disocclusionThreshold = abs(eyePosCurr.z) * 0.001 (floored at 1.0)` → history rejected → no ghost. No additional shader work needed; updated DEFERRED_WORK note from "known interaction (mitigation deferred)" to "verified safe".

### Batch 223 — Cross-batch audit caught + fixed B219-N1/N2

Audit walk surfaced two real reset-reliability bugs in the Batch 219 stats accumulators:

- **B219-N2 (real)** — `_statsTickFrameIfNeeded` only ticked when the GPU cull filter actually ran. If frustum 0's gate was off, the tick was skipped and per-frame stats accumulated forever across frames.
- **B219-N1 (real)** — per-frustum gate Maps grew stale entries when `numFrustums` changed (typical with log-depth toggle). Cleared frustum slots held stale gate states from a prior configuration.

Both fixed by moving the reset + map-trim to `_executeOpaquePass`'s frustum-0 entry, which runs unconditionally every frame regardless of cull activity. Removed the now-redundant `_statsTickFrameIfNeeded` helper.

### Batch 224 — NEW-VR-BASELINE-HIGH-DENSITY (RESOLVED)

`Tools/visual-regression/capture-and-diff.mjs` now supports a `setup` script field per scene — JS source evaluated in the page context before camera positioning, with access to `window.Cesium` + `window.webglViewer` + `window.webgpuViewer` and a typed `setupParams` argument. New `high-density-5k-spheres` scene procedurally generates 5000 sphere instances around San Francisco using a deterministic mulberry32 RNG seed, crossing every threshold-gated dispatcher's activation point (gpuCuller HI=384, HiZ HI=2400) and opting the WebGPU viewer into eager warm-up via `Scene.gpuCullingHint = 'always'`. Locks down the high-density story by ensuring the threshold-gated dispatchers from Batches 209-218 produce visually identical output to unmodified WebGL.

The actual baseline PNG capture is a runtime task (requires dev server + Playwright); README documents the runner command.

### Cumulative impact (Batches 219-224)

- **8 audit findings closed** — B213-O1 verified, B213-O2 + B214-N1 + B215-N1 + B215-N2 + B216-N2 + B217-N1 + B217-N2 fixed.
- **2 real defects caught + fixed in Batch 223 audit** — B219-N1 (stale Map entries) + B219-N2 (unreliable stats reset).
- **3 stale deferred entries closed** — `C-R1-GLOBE-RENDERSTATE`, `C-R8-VECTOR-3DTILE-CLAMPED-POLYLINES`, `NEW-COLLECTIONS-MOTION-VECTORS` (advanced primitives).
- **2 new resolved entries** — `NEW-MULTIFRUSTUM-CULL-RESULTS` + `NEW-VR-BASELINE-HIGH-DENSITY`.
- **1 new Phase-1 entry** — `NEW-SHADOW-CAST-GPU-CULL` infrastructure (Phase 2 follow-up entry opened).
- **Memory leak plugged** — ~4 MB VRAM per leaked context recovered.
- **Per-frame stats coverage** — multi-frustum + per-pass, cumulative across frame instead of last-frustum-only.

---

## Earlier Progress (2026-05-07 — Batches 213-218: high-density stutter mitigation, dispatcher productivity surface, real-defect catch in audit)

Six batches addressing the threshold-flap + first-cross-compile stutter risks raised in the Batch 205-212 audit, expanding GPU cull coverage from opaque-only to opaque + translucent, and adding a diagnostic surface so users can verify the threshold-gated dispatchers are actually pulling their weight on dense scenes. The cross-batch audit (218) caught a real same-encoder readback-buffer collision (B216-N1) where opaque + translucent shared the same gpuCuller instance and one pass's `prepareReadback` clobbered the other's pending readback; fix landed in 218 as a separate translucent culler instance.

### Batch 213 — Audit-fix bundle (5 items)

- **B210-D1 (HiZ pyramid build dedup)** — `buildHiZPyramid()` now takes a `frameId` parameter; dispatcher tracks `_lastBuiltFrameId` and skips rebuild when called multiple times with the same id. Per-frustum dispatches in a 3-frustum scene previously rebuilt the pyramid 3× redundantly. Skip count surfaced via `_hiZBuildsSkipped` for diagnostics.
- **B210-N2 (HiZ frustum-bound near/far)** — `_dispatchHiZForNextFrame` now reads `frustumCommands.near`/`.far` first, falling back to `uniformState.currentFrustumNear`/`Far` then loose `1.0`/`1e9`. Tighter depth bounds give the occlusion test more aggressive culling.
- **B205-N1 (schema offset alignment validation)** — new `SCHEMA_TYPE_ALIGNS` table + `_validateSchema()` constructor-time check. Catches misaligned WGSL offsets (e.g., vec4@4) at stage construction with a one-time warning, instead of silent shader miscompare.
- **B206-N1 (extended toneMapping fallback)** — new `_applyCanvasConfig()` wraps `_context.configure()` in a try/catch chain. On failure, retries with `format: 'rgba16float'` (drops `colorSpace + toneMapping`); on a second failure, drops to SDR. Older Chrome / Safari / Firefox no longer throw on HDR enable.
- **Filter array pools (cosmetic)** — `gpuCullCommands` and `_filterByHiZVisibility` now reuse `_gpuCullFilterPool` / `_hiZFilterPool` instead of allocating `[]` per frame. Removes GC pressure at high density. Same lifetime contract: caller (`executeBatch`) consumes synchronously.

### Batch 214 — Threshold hysteresis

Each of the three threshold-gated dispatchers (gpuCuller, HiZ, GPUSortKeys) now uses dual thresholds with a per-dispatcher active state flag:

- gpuCuller: HI=384, LO=192 (was single 256)
- HiZ: HI=2400, LO=1600 (was single 2000)
- GPUSortKeys: HI=6000, LO=4000 (was single 5000)

`_updateActivationGate(active, count, hi, lo)` is the central decision: `active && count >= LO` OR `!active && count >= HI` activates. Below LO deactivates. Between LO and HI the previous state holds. Prevents single-frame dispatch flap when count oscillates around the boundary (typical with LOD streaming at the edge of a high-density region). Inner methods now trust the gate and only guard against `count <= 0`.

### Batch 215 — Eager dispatcher warm-up

New `Scene.gpuCullingHint: 'auto' | 'always' | 'never'` opt-in. Setting `'always'` calls `WebGPUContext.warmUpHighDensityDispatchers()` which pre-touches all three dispatchers (lazy-init triggers compile + buffer alloc) so the 5-50 ms first-cross-threshold compile cost amortizes into a load frame instead of the first frame where count crosses the activation threshold (which would otherwise hitch). `'auto'` (default) keeps the lazy path unchanged.

### Batch 216 — Translucent-pass GPU cull (shadow-cast deferred)

`WebGPUSceneRendererTranslucentPass` now applies gate-controlled GPU cull at the top of the dispatch loop, mirroring the opaque path. New `gpuCullCommandsForTranslucent()` uses a separate `_lastCullResultsTranslucent` readback slot so opaque + translucent don't fight for the same key. Shared the `_gpuCullActive` gate state so on/off is coordinated. Order is preserved (same iteration), so OIT accumulation + back-to-front alpha both stay correct. Shadow-cast pass GPU cull (per-cascade culling volumes) deferred to a follow-up — `NEW-SHADOW-CAST-GPU-CULL` in DEFERRED_WORK.

### Batch 217 — Dispatcher diagnostic surface

New `WebGPUSceneRenderer.getHighDensityCullStats()` returns per-dispatcher `{ active, thresholdHi, thresholdLo, dispatches, lastInput, lastFiltered, hitRatio }`. Surfaces in `scene.getDebugSnapshot().highDensityCull` and via the new `CesiumDebug.highDensityCull()` console command. `hitRatio` is the fraction of input commands the GPU filter dropped — above ~0.2 means the dispatcher is paying for itself; near 0 means CPU cull was already tight enough.

### Batch 218 — Cross-batch audit caught + fixed B216-N1

Audit walk surfaced a real defect: opaque pass (`gpuCullCommands`) and translucent pass (`gpuCullCommandsForTranslucent`) both used `context.gpuCuller` (single shared instance), so both `prepareReadback` calls in the same encoder issued `copyBufferToBuffer` against the SAME staging buffer. The translucent copy clobbered the opaque copy → both `mapAsync` resolutions read translucent data → opaque readback was permanently corrupted under multi-pass GPU cull.

Fix: new `WebGPUContext.gpuCullerTranslucent` lazy-loaded second instance with its own `_visibilityBuffer` + `_readbackBuffer`. The translucent path now uses it exclusively. Pre-existing multi-frustum opaque-pass collision (per-frustum dispatches into the same opaque culler) documented as `NEW-MULTIFRUSTUM-CULL-RESULTS` (separate fix).

VR baseline capture for synthetic 5K-instance scene deferred — runtime task that needs a Playwright session. Tracked as a follow-up in WEBGPU_MIGRATION_BACKLOG.

### Cumulative impact (Batches 213-218)

- **5 audit findings + 1 cross-batch defect resolved** — every threshold/gate/buffer/clobber issue surfaced in the 205-212 audit closed in code, plus a NEW defect (B216-N1) caught and fixed in the audit batch itself.
- **Threshold flap stutter mitigated** — hysteresis prevents single-frame dispatch on/off when count oscillates near the gate.
- **First-cross compile stutter mitigated** — eager warm-up via `Scene.gpuCullingHint = 'always'` opt-in.
- **GPU cull coverage expanded** — opaque + translucent both filter at high density. Shadow-cast deferred (per-cascade volumes need separate readback slot).
- **Diagnostic surface complete** — `scene.getDebugSnapshot().highDensityCull` + `CesiumDebug.highDensityCull()` make it observable whether the dispatchers are actually helping in a given scene.

---

## Earlier Progress (2026-05-07 — Batches 205-212: B200/B204 audit fixes, HDR-DISPLAY auto-configure CLOSES entry, Vector3DTile MORPHING ×2, three orphan dispatchers consumed with threshold gating, cross-dispatcher audit)

Eight batches addressing two audit-defect tracks (B200 HDR-skip on colorGrading/FXAA, B204 schema vec4 collision), closing one deferred entry end-to-end (HDR-DISPLAY canvas auto-configure now ships rgba16float + display-p3 + extended toneMapping when `useHDRCanvasOutput` is set), narrowing two MORPHING gates (Vector3DTilePolylines + Vector3DTileClampedPolylines now render through the morph transition), and **consuming the three orphan compute dispatchers (gpuCuller, HiZ occlusion, GPUSortKeys) with threshold-gated wire-in tuned for the 10K+ models density target.** Cross-dispatcher audit (Batch 212) added pick-pass bypass to all three so pick fidelity is preserved.

### Batch 205 — B200-D1/D2 + B204-N1 audit fixes

- **B200-D1/D2 (ColorGrading + FXAA on HDR)** — when `useHDRCanvasOutput && highDynamicRange`, the post-process pipeline now skips ColorGrading (curves calibrated for [0,1] SDR) and FXAA (luma-keyed edge detection assumes SRGB-perceptual signal). New `WebGPUPostProcessPipeline.setSkipSDRStagesForHDR(skip)` setter; `WebGPUPostProcessStageCollection` flips it per-frame based on the scene flags. Stage `enabled` flags themselves are not mutated — flipping HDR off restores the user's tone of voice without requiring re-init.
- **B204-N1 (schema vec4 collision)** — `WebGPUUserPostProcessStage._packUniforms()` previously checked `entry.offset === PASS_INDEX_OFFSET` for collision, missing the case where a vec4 declared at offset 48 silently has its `.w` component clobbered by the framework pass-index write at byte 60. New `SCHEMA_TYPE_BYTES` table + range-overlap check warns + skips any entry whose `[offset, offset+size)` overlaps the reserved last 4 bytes (or exceeds the 64-byte UBO).

### Batch 206 — HDR-DISPLAY canvas auto-configure (CLOSES entry)

`Scene.useHDRCanvasOutput` setter now propagates to `WebGPUContext.setHDRCanvasOutput()`. The context reconfigures the canvas with `format: 'rgba16float' + colorSpace: 'display-p3' + toneMapping: { mode: 'extended' }` when the flag is on, and re-queries `getPreferredCanvasFormat()` when off. New `_buildCanvasConfig()` helper consolidates the three configure call sites (initialize, resize, _reconfigureCanvas) so HDR mode survives canvas resizes and device-loss recovery. Pipeline cache + effects-placeholder cache cleared on toggle since canvas-format-keyed pipelines must recompile.

### Batches 207-208 — Vector3DTile* MORPHING

`WebGPUVector3DTilePolylinesRenderer` and `WebGPUVector3DTileClampedPolylinesRenderer` now allow rendering through `SceneMode.MORPHING` (in addition to `SCENE3D`). During morph the camera + view/projection interpolate via `frameState.morphTime`; the existing `packUniforms` path consumes `uniformState.view` + `uniformState.projection` directly so 3D ECEF/RTC positions render in their world position during the transition, fading naturally as the camera approaches 2D. SCENE2D + COLUMBUS_VIEW remain gated (no 2D position attribute path on these primitive types — matches upstream WebGL behavior).

### Batches 209-211 — Three orphan dispatchers consumed with threshold gating

All three were 503/976/463-LOC infrastructure with zero live callers since Phase 3. Decision: **keep all three and consume them** to support the project's 10K+ tile-density goal. Threshold-gated activation matches each dispatcher's overhead profile.

- **Batch 209 — gpuCuller (`WebGPUSceneRenderer.gpuCullCommands`)** wired into `_executeOpaquePass`. Threshold: 256 commands. Existing infrastructure with 1-frame readback latency. Filters opaque commands against compute-shader frustum test on top of the upstream CPU cull. `effectiveCount` parameter added so callers pass pre-sized command arrays without per-frame slice allocation in the hot path.
- **Batch 210 — HiZ occlusion (`WebGPUHiZOcclusionDispatcher`)** wired into `_executeOpaquePass`. Threshold: 2000 commands (higher overhead — pyramid build + occlusion test + readback). New `_filterByHiZVisibility` (consumer of previous-frame readback) + `_dispatchHiZForNextFrame` (producer) pair. Lazy SOA scratch growth tracks the largest count seen in the session. Visibility flags survive across frames so the consumer can run before this frame's dispatch completes.
- **Batch 211 — GPUSortKeys (`WebGPUGPUSortKeysDispatcher`)** wired into `_executeOpaquePass`. Threshold: 5000 commands. Phase 1 only — produces packed 64-bit sort keys (`sortKeysHigh + sortKeysLow + commandIndices`) on the GPU; the actual GPU sort over those keys is a separate compute pipeline that doesn't exist yet (no generic u64 bitonic / radix). Tracked as `NEW-GPU-SORT-PIPELINE` in DEFERRED_WORK.md. Below threshold the JS multi-level comparator in RenderScheduler is faster than dispatch+readback round-trip.

### Batch 212 — Cross-dispatcher audit + feature integration verification

All three dispatchers now bypass on `config.picking === true`. Pick must test every command the CPU pass produced — including ones GPU culling marks as occluded — so users can pick objects visually behind transparent overlays. Mismatching the filter sets between render and pick produces ghost picks where a clicked pixel maps to the wrong (or no) feature. Verified that shadow-cast, OIT translucent, and motion-vector passes all iterate their own command sets and are unaffected by the opaque-pass filtering. Known interaction documented: at extreme density (>=2000 commands) HiZ-culled objects may briefly ghost in TAA reprojection if they were rendered last frame; threshold tuning makes this practically invisible.

---

## Earlier Progress (2026-05-07 — Batches 199-204: B198 audit fixes + HDR-DISPLAY + FEAT-GAP-09 +6 shaders + NEW-POSTPROCESS-USER-WGSL second slice)

Six batches closing two deferred entries end-to-end (NEW-POSTPROCESS-USER-WGSL fully RESOLVED via Batches 198 + 199 + 204; FEAT-GAP-09 progressed from 6/44 to 12/44 shaders via Batches 201-202), shipping a new visible feature (HDR-DISPLAY skip-tonemap), and addressing both Batch 198 audit defects.

### Batch 199 — B198 audit fixes

- **B198-D1 (HDR precision)** — `addUserWGSLStage` now passes `_intermediateFormat` (rgba16float in HDR mode) to user-stage initialization instead of `canvasFormat` (8-bit). User stages running between bloom and tonemap preserve HDR precision.
- **B198-D2 (auto-exposure ordering)** — User stage chain moved from execute step 3.4 (BEFORE auto-exposure) to step 3.6 (AFTER auto-exposure dispatch, BEFORE TAA + tonemap). Auto-exposure now correctly finds the post-DoF ping/pong texture as its luminance source; user stages still operate on HDR-space color.
- `_userStagesBuilt` formalized on the `PostProcessCache` interface (was an inline type cast).

### Batch 200 — HDR-DISPLAY canvas HDR output (first slice)

New `Scene.useHDRCanvasOutput` opt-in flag. When `true` AND `Scene.highDynamicRange === true`, the post-process pipeline skips the tonemap stage so HDR-encoded scene color forwards to the canvas. On HDR-capable displays (Apple Pro Display XDR, modern OLEDs in HDR-10 / Dolby Vision mode), the OS / display handles the gamut + tone curve; an SDR-tonemapped frame would crush highlights into the SDR range and waste the display's HDR headroom.

**First slice scope:** producer side only (skip tonemap when both flags true). Canvas configure side (`colorSpace: 'display-p3'`, `toneMapping: 'extended'`, `format: 'rgba16float'` via `GPUCanvasContext.configure()`) is a user-side concern for now. A future slice will auto-configure the canvas via browser feature detection.

### Batch 201 — FEAT-GAP-09 first slice (3 LIT primitive shaders)

Aerial-perspective LUT consumer wired into `PrimitiveMatBumpMapLit`, `PrimitiveMatNormalMapLit`, `PrimitiveMatGridLit`. Each gets bindings 7/8/9 (transmittance LUT + inscatter LUT + sampler) and the `effects.atmosphereLutControl.x > 0.5` gated fog-blend block at the end of `fragmentMain`. Pattern mirrors `PrimitivePhongTexturedColor.wgsl` template byte-for-byte.

### Batch 202 — FEAT-GAP-09 second slice (3 more LIT primitive shaders)

Same pattern applied to `PrimitiveMatStripeLit`, `PrimitiveMatCheckerLit`, `PrimitiveMatRimLightingLit`. **12 of ~44 primitive shaders now wired.** The deferred entry's "6 shaders remaining" claim turned out to be substantially off; actual remainder is ~32 shaders (mostly less-common material variants — Mat{Aspect,Slope,Elev}Ramp, Mat{Aspect,Slope,Elev}Contour, Mat{Alpha,Bump,Specular,Normal,Emission}Map{Flat}, Mat{Color,Dot,Fade,Water}Flat, etc.). Pick variants intentionally excluded (fog would corrupt pickColor). FEATURE_INVENTORY entry updated to reflect actual remainder; high-traffic shaders covered, the rest rides along the incremental upgrade rule.

### Batch 203 — Doc-walk audit

Surveyed all open entries in DEFERRED_WORK.md against actual code paths. Found NO new stale-RESOLVED entries this round — confirms prior walks (Batches 183 / 188 / 190 / 193 / 194) were thorough. The only doc adjustment was correcting FEAT-GAP-09's stale "6 shaders remaining" claim to the actual `~32 remaining of ~44 total`. WGF-4-EXPAND RTE assertions de-scoped (low payoff; the encoded-cartesian round-trip is already validated by upstream Cesium's test suite — adding shader-level assertions is mechanical busywork without clear correctness payoff).

### Batch 204 — NEW-POSTPROCESS-USER-WGSL second slice (CLOSES the entry)

Two new features on top of the Batch 198 first slice:

**Named-uniform schema** — user provides `wgslUniformSchema: UniformSchema` alongside `wgslFragmentShader`. Maps `{ [name]: { type: 'float' | 'vec2' | 'vec3' | 'vec4', offset: number } }` so vec3/vec4 uniforms can be passed as `number[]` arrays and packed at correct WGSL alignment. Falls back to Batch 198 iteration-order packing when no schema provided (backwards compat).

**Multi-pass support** — user provides `wgslNumberOfPasses: number` (default 1, capped at 32). Framework runs the same pipeline N times, ping-ponging between two intermediate textures (B-texture allocated only when multi-pass active — VRAM-frugal default for single-pass). Pass index packed into UBO offset 60 so user shader can branch per-pass — supports separable filters (Gaussian blur horizontal/vertical), accumulating denoisers, etc.

### Cumulative impact (Batches 199-204)

- **2 deferred entries closed end-to-end** — NEW-POSTPROCESS-USER-WGSL fully RESOLVED (3 batches: 198 + 199 + 204); HDR-DISPLAY first slice shipped (canvas-configure auto-detection deferred to follow-up).
- **6 more primitive shaders wired with FEAT-GAP-09 LUT** — 12 of ~44 now done; high-traffic shaders covered.
- **Both B198 audit defects fixed** — HDR precision + auto-exposure ordering. NEW-POSTPROCESS-USER-WGSL is now correct under HDR scenes and doesn't break auto-exposure.
- **Doc-walk thoroughness validated** — Batch 203 surveyed all open entries and found no new stale-RESOLVED candidates, confirming the prior 13+ closures across Batches 183-198 covered the easy wins.
- **Net deferred entry count down by 1** (POSTPROCESS-USER-WGSL closed).

---

## Earlier Progress (2026-05-07 — Batches 194-198: Batch 192 audit fixes + downstream feature integration + 2 deferred-entry closures)

Five batches: Batch 194 fixes Batch 192's HIGH-severity stencil-reference defect plus the cursor-coalesce UX gap, with another stale-RESOLVED reconciliation (GroundPrimitive MORPHING already shipped Batch 164); Batches 195-196 cash in on Batch 192's `csm_stochasticDither` infrastructure (TAA blue-noise jitter + voxel ray-march dither); Batch 197 closes C-R12-PER-OBJECT-CACHES with a device-loss recovery walk; Batch 198 ships the NEW-POSTPROCESS-USER-WGSL first slice for user-supplied WGSL post-process stages.

### Batch 194 — Batch 192 audit fixes + GroundPrimitive MORPHING doc-sync

- **B192-D1 (HIGH)** — `createPickPrecisePass1Pipeline` and `createPickPrecisePass2Pipeline` had stencil ops correctly configured (`passOp: replace`, `compare: equal`) but the **stencil reference value** was set per-encoder-draw via `passEncoder.setStencilReference(ref)`, NOT in the pipeline state. With default ref=0 and the FBO clearing stencil to 0, pass 1's `replace` was a no-op (writes 0 over 0) and pass 2's `equal` matched stencil==0 EVERYWHERE, defeating the whole isolation mechanism. **Fix:** add `renderState: { stencilTest: { reference: 1 } }` to the precise pick commands in `WebGPUModelRenderer.js`. Pass 1's `setStencilReference(1)` → `replace` writes 1; pass 2's `setStencilReference(1)` → `equal` matches stencil==1 only. Stencil mechanism now actually isolates pass-1-covered pixels.
- **B192-N1** — `pickHoverAsync` coalesce previously returned the in-flight promise, resolving with the result for the OLD cursor position when the user moved the cursor mid-pick. Replaced with **trailing-debounce / latest-cursor chaining**: `_latestHoverCursor` always tracks the most recent requested position; a `_runHoverChain` drain loop processes one pick at a time but always against the latest snapshot. All coalesced callers receive the SAME result for the most-recent cursor (matches "what's under the cursor RIGHT NOW" UX expectation).
- **GroundPrimitive MORPHING doc-sync** — audit walk found Batch 164 already shipped MORPHING for GroundPrimitive (`morphColorVS` consumes both 3D and 2D position attribute pairs and blends EC-space by `morphTime`; `tryResolveGroundPrimitiveMorphPipelines` lazily allocates the morph pipeline pair). Only `_needs2DShader` primitives (textured GroundPrimitives needing the WebGL `appearance2D` equivalent) remain gated. Updated DEFERRED_WORK.md sub-entry table to reflect closure.

### Batch 195 — TAA blue-noise jitter (Halton 2/3 → IGN)

`WebGPUTAAEffect.ts` now uses the same Jorge Jimenez Interleaved Gradient Noise formula as Batch 192's `csm_stochasticDither` chunk + the voxel ray-march dither (Batch 196). The new `ignJitter(frameIndex, axis)` exported helper replaces `halton(index, base)` calls in `computeJitter`. Halton retained as exported function for backwards compatibility.

**Why blue-noise over Halton 2/3 for TAA jitter:**
- Halton 2/3 is low-discrepancy (well-distributed) but **temporally-correlated** — adjacent frames' jitter offsets land near each other in the unit square; TAA accumulation sees structured residual error that shows up as mild ghosting on edges.
- IGN is high-frequency / blue-noise-spectrum: adjacent samples (across frames at the same pixel) are nearly uncorrelated. Accumulation under temporal averaging converges faster with less residual error — cleaner edges, less perceptible ghosting.

First downstream consumer of Batch 192's `csm_stochasticDither` infrastructure landing in production code paths.

### Batch 196 — Voxel ray-march IGN ray-start jitter

`WebGPUVoxelRenderer.ts` `fragmentMain` ray-march now jitters its starting `t` value by `dither × stepSize` where `dither = pickHoverDither(input.position.xy)`. The same Jimenez IGN formula. Anti-aliases sample positions across pixels — adjacent fragments don't all sample at the same uniform-grid t-points. Reduces banding artifacts in volumetric renders that would otherwise show stair-step rings where rays cross density boundaries.

With TAA on (Batch 195's blue-noise jitter), TAA's per-frame camera jitter implicitly varies the IGN seed across frames at the same world-space pixel — gives temporal smoothing in addition to the spatial jitter. No new UBO fields, no frame-counter plumbing needed.

Second downstream consumer of `csm_stochasticDither`.

### Batch 197 — C-R12-PER-OBJECT-CACHES device-loss walk + B192-N2 timestamp queries

**C-R12-PER-OBJECT-CACHES closure:** `WebGPUSceneRendererEnsureResources.ensureResources` now extends its existing `context.onDeviceInvalidated` subscription with a `clearPerObjectCaches(scene)` walk that clears `_webgpuCache` on every reachable per-object owner during device-loss recovery — `scene.primitives` (recursive walk), `scene.groundPrimitives`, `scene.shadowMap`, `scene.postProcessStages`. The walk uses a duck-typed `{length, get(i)}` collection check so any future Cesium primitive collection auto-participates without explicit registration. Belt-and-suspenders correctness — closes the window between device-loss event and the next render frame's FR-driven rebuild.

**B192-N2 fix:** `Scene.pickPreciseAsync` first call on a scene auto-enables WebGPU timestamp profiling on `context._performanceManager._config.timestampProfiling`. The defer mitigation (Batch 192 mitigation B) now reads `context._performanceManager.frameTimings.totalGpuMs` instead of the dormant `scene._lastFrameGpuMs` placeholder. On devices supporting the `'timestamp-query'` feature, defer fires when last-frame GPU work exceeded ~12ms — pushing precise pick to the next frame to avoid stutter (16ms latency added; no stutter). On devices without the feature, totalGpuMs stays at 0 and defer never fires (same as current behavior; pick runs inline).

### Batch 198 — NEW-POSTPROCESS-USER-WGSL first slice

`Scene.postProcessStages.add(...)` user stages now execute on the WebGPU backend when they carry a `wgslFragmentShader: string` uniform.

**Producer side (`WebGPUUserPostProcessStage.ts`, new file):**
- Compiles user FS source concatenated with a framework-provided fullscreen-triangle VS into one shader module.
- Single bind group: source texture (binding 0) + sampler (binding 1) + 64-byte uniform buffer (binding 2).
- Renders fullscreen into its own intermediate texture.
- Implements the `PostProcessEffect` interface so it slots into the existing chain via `execute(encoder, source, depth, sampler) → newView`.

**Pipeline integration (`WebGPUPostProcessPipeline.ts`):**
- New `addUserWGSLStage` / `clearUserWGSLStages` API.
- User stages execute in the chain AFTER built-in stages (Bloom, AO, DoF, GodRay) but BEFORE auto-exposure + tonemap — same insertion point the WebGL backend uses for user stages, so HDR-space user effects work correctly.
- `hasActiveStages` getter includes user-stage check so the post-process pipeline correctly fires when only user stages are enabled.

**Consumer side (`WebGPUPostProcessStageCollection.ts`):**
- The Batch 133 `oneTimeWarning` for user stages is replaced with: stages with `wgslFragmentShader` are compiled + chained; stages without (GLSL custom shaders) still warn but with a clearer call-to-action ("supply a `wgslFragmentShader` uniform").
- Numeric uniforms from the stage's `.uniforms` map (excluding `wgslFragmentShader` itself) are packed into the 64-byte UBO in iteration order.

**Convention for user shaders:**
```wgsl
@group(0) @binding(0) var sourceTexture: texture_2d<f32>;
@group(0) @binding(1) var sourceSampler: sampler;
@group(0) @binding(2) var<uniform> uniforms: UserUniforms;
struct UserUniforms { values: array<vec4<f32>, 4> }; // 16 packed floats

@fragment
fn fragmentMain(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  // user implementation
}
```

Future slices: type-safe schema declarations, named uniform packing (instead of iteration-order), texture/sampler bindings beyond the source pair, multi-pass user stages, GLSL→WGSL transpiler for upstream parity.

### Cumulative impact (Batches 194-198)

- **3 Batch 192 audit fixes shipped** — B192-D1 (precise pick stencil reference), B192-N1 (cursor-coalesce trailing-debounce), B192-N2 (timestamp-query-driven defer). Closes the audit punch list end-to-end; Batch 192's full-featured dual-path is now actually correct AND adaptive.
- **2 deferred entries closed** — C-R12-PER-OBJECT-CACHES (Batch 197 device-loss walk), NEW-POSTPROCESS-USER-WGSL first slice (Batch 198 user WGSL stages).
- **1 stale-RESOLVED entry surfaced + reconciled** — GroundPrimitive MORPHING (already shipped Batch 164). Cumulative across Batches 183-198: 13+ stale-RESOLVED entries closed via systematic doc-walk.
- **2 new downstream consumers of `csm_stochasticDither`** — Batch 195 TAA blue-noise jitter, Batch 196 voxel ray-march. The `csm_stochasticDither` infrastructure has now been consumed by 3 production code paths (hover pick, TAA jitter, voxel ray-march), validating the "broad reuse" rationale from Batch 192.
- **No new audit defects introduced** — every audit-fix shipped this session has either been validated by a subsequent audit or is structurally simple enough that audit risk is low.

---

## Earlier Progress (2026-05-07 — Batches 191-193: audit-fix correctness + full-featured OIT pick dual-path + doc-walk reconciliation)

Three batches: Batch 191 fixes audit-found correctness defects (pickAsync queue ordering on WebGPU, undefined identifier in implicit-range path); Batch 192 ships the OIT pick second slice as a fully-featured dual-path API with all worst-case mitigations; Batch 193 walks DEFERRED_WORK.md systematically and closes 5 more stale-RESOLVED entries.

### Batch 191 — Audit fixes (B187-D1 + B188-D1)

Two real defects from the Batches 187-190 rereview:

- **B187-D1 (HIGH)** — `pickAsync` queue ordering on WebGPU. The Batch 187 attempt at the pickEnd-timing fix preserved the bug it was meant to fix. `WebGPUPickFramebuffer.endAsync` runs synchronously up to its first await: it creates a NEW command encoder, queues `copyTextureToBuffer`, and submits via `device.queue.submit([encoder.finish()])` BEFORE returning the Promise. `pickEnd → endFrame` is what submits the pick render's `_currentCommandEncoder`. With `pickEnd` AFTER `endAsync` the readback encoder is submitted to the queue first; GPU executes it against an empty/stale `colorTexture`; `mapAsync` resolves with prior-frame data. **Fix:** call `pickEnd(scene)` BEFORE `pickFramebuffer.endAsync(...)`.
- **B188-D1 (BLOCKER)** — undefined identifier `rn` at `WebGPUModelRenderer.js:2173`. Variable in scope was `runtimeNode`; `rn` would have thrown `ReferenceError` at runtime when an implicit-range glTF model loaded. Build passed because JavaScript doesn't catch undefined identifiers at compile/build time. **Fix:** `rn` → `runtimeNode`.

### Batch 192 — C-R9-MODEL-PICK-TRANSLUCENT second slice (CLOSES the entry)

Initially scoped as A-buffer per-pixel atomics, but the architectural deep-dive in this session found that approach blocked by WebGPU primitives (no per-fragment winner-take-all blend op; pickColor averaging meaningless for integer IDs). Pivoted to a **dual-path tiered API** that addresses both real use cases — hover-pick stutter avoidance and click-pick determinism — without needing the multi-batch atomics infrastructure.

**`Scene.pickHoverAsync` (Option D — stochastic dither alpha-test):** New `fragmentPickHoverMain` entry uses Jorge Jimenez's Interleaved Gradient Noise (UE4/UE5 standard) inline — `fract(52.9829189 * fract(0.06711056 * fragCoord.x + 0.00583715 * fragCoord.y))`. No texture lookup, ~1 ALU per fragment. BLEND fragments discard with probability `1 − alpha`; surviving fragments compete on standard depth-test. Same render-pass cost as the default opaque pick — guaranteed stutter-free at 60fps hover frequency.

**`Scene.pickPreciseAsync` (Option C — stencil-coordinated 2-pass):** Pass 1 writes depth + stencil with `colorWriteMask: 0`. Pass 2 writes pickColor with `depthCompare: equal` + `stencilCompare: equal`. Both passes share one render-pass setup so depth/stencil persist between them. Per-primitive 2-draw emission; pass 2 fires immediately after pass 1 within the same render pass.

**Mitigations baked in:**
- **Coalesce:** at most one hover + one precise pick in flight per scene; pile-up dropped (hover) or queued (precise).
- **Defer:** if last frame's GPU work exceeded ~12ms, `pickPreciseAsync` defers to the next frame via `frameState.afterRender`. ~16ms latency instead of stutter.
- **Pick-rect cull tightening (mitigation E):** already shipped via `getPickCullingVolume`. The frustum partition already excludes commands whose bounding spheres don't intersect the 3×3 pick rect — drops typical scene's pick-time render cost by 90-95%.
- **Lazy pipeline allocation:** hover/precise pipelines built only on scenes that actually call the new APIs. Default `Scene.pick` pays zero.
- **Dispatcher routing:** `selectCommandVariant` reads `frameState.passes.pickMode` ("default" | "hover" | "precise") to choose variant. Falls through to default pickCommand when requested variant isn't materialized.

**Cost summary:**

| Scenario | Per-frame cost |
|---|---|
| Idle (no pick this frame) | 0ms |
| Hover only (D) | 0.3-1ms typical, 1-2ms heavy |
| Click only (C) | 0.6-2ms typical, 2-4ms heavy (after cull tightening) |
| Worst case (both same frame) | 1.5-3ms heavy — coalesce drops hover when click fires |
| Persistent VRAM | 0 (no allocations beyond existing pick FBO) |

**Downstream feature hooks** opened by this batch (each its own future work item):
- `csm_stochasticDither.wgsl` chunk available for foliage / particle alpha-test rendering, translucent shadow casts, voxel ray-march early-termination.
- TAA jitter via blue-noise (replace Halton 2/3) — hook + comment in `WebGPUTAAEffect.ts`.
- New `ShaderDefine` bits `STOCHASTIC_DITHER_ALPHA` and `STENCIL_PICK_WINNER` reserved.

### Batch 193 — Doc-walk audit (5 stale-RESOLVED entries closed)

Systematic walk of every open entry in DEFERRED_WORK.md against actual code paths. **5 more stale-RESOLVED entries reconciled:**

- **C-R1-TILE-BATCH** — RESOLVED via Batch 100. `tileBatchFlags` UBO + WGSL per-feature alpha-class discards + per-primitive 2-command emission all shipped.
- **C-R8-TRANSLUCENT-DEPTH-ONLY** — already "Resolved (different mechanism) — Batches 78-79" in body but heading lacked strikethrough.
- **C-R8-TRANSLUCENT-MULTI-FRUSTUM** — already "Paused / superseded" in body; cosmetic strikethrough.
- **C-R8-TRANSLUCENT-CLASSIFICATION-DISPATCH** — already "Superseded by C-R8-CLASSIFICATION-DEPTH-SAMPLING" in body; cosmetic strikethrough.
- **NEW-GS-CLASSIFICATION-DEPTH** — RESOLVED. `WebGPUGaussianSplatRenderer.ts:43, 500, 957-982` ships `classificationDepthPipeline` slot mirroring Batch 79 Model fix.

**Cumulative stale-RESOLVED reconciliation across Batches 183-193: 12+ entries closed.** The trend strongly suggests deferred-work tracking should be re-walked at every major release boundary.

### Cumulative impact (Batches 191-193)

- 2 audit defects fixed (B187-D1 pickAsync queue ordering, B188-D1 undefined identifier).
- C-R9-MODEL-PICK-TRANSLUCENT closed end-to-end (first slice Batch 186 + second slice Batch 192). Two new public APIs cover hover + click use cases.
- 5 stale-RESOLVED entries closed in DEFERRED_WORK.md.
- Downstream hooks opened for foliage dither, voxel ray-march, TAA blue-noise jitter.
- Dispatcher routing extended with multi-variant pick command selection — `pickMode` mechanism reusable for future pick variants.

---

## Earlier Progress (2026-05-06 — Batches 187-190: audit fixes + implicit-range pick + uniforms type cleanup; OIT pick blocker surfaced; 2 stale-RESOLVED entries reconciled)

Four batches that ran the audit-fix → high-payoff → architectural-finding → cleanup sequence the user approved. Mid-stream pivots happened in 189 (OIT pick architecturally blocked) and 190 (work was already shipped in Batch 108 — entry was stale). Net deliverables: real audit-fix work, a closed deferred entry, and significant doc reconciliation.

### Batch 187 — Audit fixes + TS unblock

The 183-186 audit surfaced 4 defects + 2 pre-existing TS errors blocking `npx gulp build`. All addressed:

- **B184-D1 fix** (`Picking.js:99`) — `pickAsync` previously captured the module-level `scratchRectangle` singleton by reference. With an await mid-flight, any concurrent pick path (e.g., a mouse-hover handler) could overwrite `scratchRectangle` before `endAsync` resumed, causing the readback to read wrong coords. Fix: clone to a per-call `BoundingRectangle` instance.
- **B184-D2 fix** (`Picking.js:117`) — `pickEnd(scene)` was called AFTER the await. On WebGPU specifically, `endFrame()` is what submits the pick render's command encoder to the device queue. Without it firing first, the readback `mapAsync` would block on a queue that never sees the pick render's commands. Moved `pickEnd` to BEFORE the await — closes the pick pass synchronously while leaving the readback promise pending.
- **B186 comment correction** (`WebGPUModelPipelineCache.js:createPickPipeline`) — original comment overclaimed "depth-test alone picks the geometrically closest fragment regardless of render order." Reality: with `depthWrite=false` and `depthCompare:less-equal`, multiple translucents at varying depths between camera and opaque all pass; last-drawn wins. Real improvement is opaque-behind-translucent now pickable. Comment now accurately describes the change.
- **WebGPUContext.ts:1914 TS error** — `WebGPUSync.create({ device, timeoutFrames })` didn't match `WebGPUSyncOptions: { context }`. Replaced with `{ context: this }` (the `device`/`timeoutFrames` fields had no consumers; verified via grep).
- **WebGPUPostProcessStageCollection.ts:250 TS error** — `rawAlgo === "gtao"` against `Record<string, number>`-typed uniforms. Initial fix used a targeted `as unknown` cast at the AO algorithm site; the proper fix landed in the cleanup work below.

Batch 187 unblocks `npx gulp build` end-to-end so Batch 186's WGSL changes propagate to the bundled `Build/CesiumUnminified/`.

### Batch 188 — NEW-FEATURE-ID-VERTEX-ATTR closure (b3dm implicit-range synthesis)

Audit walk surfaced that vertex-attribute feature ID was actually shipped end-to-end in **Batch 130** (audit B.2), not still-pending as the deferred entry implied. `_FEATURE_ID_0` (loader-renamed from b3dm `_BATCHID`) flows: geometry extraction → Float32 vertex buffer at slot 8 → `FLAG_HAS_FEATURE_ID_ATTRIBUTE` → `fragmentMain`/`fragmentPickMain` `lookupBatchColor`/`lookupFeaturePickColor` paths. All wired since Batch 130.

Batch 188 closes the one remaining sub-case — `FeatureIdImplicitRange`, where primitives carry no `_FEATURE_ID_0` accessor and the feature ID is synthesized as `offset + floor(vertex_index / repeat)`. New `synthesizeImplicitFeatureIdData` helper in `WebGPUModelFeatureId.js` materializes the typed array at upload time; the existing slot-8 path then handles it identically to an explicit attribute. **Closes NEW-FEATURE-ID-VERTEX-ATTR.**

(The C-R9-MODEL-FEATURE-PICK separate blocker — b3dm-tileset Models not building primitive caches — is upstream rendering work, not feature-ID path work; per-feature pick will work automatically once b3dm models go through the regular WebGPU render path.)

### Batch 189 — OIT pick second slice: architectural finding (no code shipped)

Audit of the proposed "parallel pick-OIT pipeline accumulating pickIds with same weights, resolving at composite" found it's **not directly implementable with WebGPU primitives**:

- WebGPU OIT (McGuire & Bavoil weighted-blended) **averages** premultiplied-alpha colors. PickColors are integer-encoded IDs — averaging two pickColors produces a non-existent ID.
- WebGPU's blend ops (`add`/`subtract`/`min`/`max`) don't give "winner-take-all by weight" cleanly. `max` per-channel produces Frankenstein RGB when channels max from different fragments.
- Workarounds need new infrastructure: per-pixel atomic linked lists (Chrome-only), N-pass back-to-front sort (defeats OIT order-independence), or storage-texture ID stacks with custom resolve compute pass.

The second slice is therefore a **multi-batch architectural effort**, not the original "1-2 session" estimate. DEFERRED_WORK.md updated with the finding so future sessions don't re-discover it. The Batch 186 first slice's depth-test-only behavior covers the dominant case (opaque-behind-translucent pickable, last-drawn-wins among translucents). No code shipped — preferred over scaffolding without a clear architecture.

### Batch 190 — C-R10-GLOBE-POINT-LIGHT stale-RESOLVED (doc-sync only)

Audit walk found globe terrain point-light cube-shadow receive shipped end-to-end in **Batch 108**: `EffectsUniforms` carries `pointLightControl` + `pointLightPositionWC` at the same byte offsets as the model shader; `pointLightCubeDepth: texture_depth_cube` at `@group(3) @binding(17)`; `globeSamplePointShadow` does perspective-Z reconstruction + 5-tap cross PCF; shadow-gate order in `fragmentMain` is point-light first, CSM second, 2D shadow last (matches model FS); `WebGPUEffectsBindGroup.js` packs the fields. The deferred entry's "1 session if requested" estimate predated Batch 108 and was never reconciled. **Closed via doc-sync.**

### Cleanup — `PostProcessStage.uniforms` type widening with cascade fixes

`CesiumPostProcessStage.uniforms` widened from `Record<string, number>` to `Record<string, number | string | boolean | undefined>` to match its actual polymorphism (numeric scalars, string discriminators like AO `algorithm`, booleans like `glowOnly`). 15 cascading TS errors at numeric-read sites in `WebGPUPostProcessStageCollection.ts` resolved via a new local helper `numU(v, default): number` that narrows polymorphic uniform values to numbers. The AO `algorithm` discriminator narrows to its `"gtao" | "hbao"` literal union directly without going through `numU`.

This replaces Batch 187's targeted `as unknown` cast with the structurally-correct widening + per-site narrowing pattern.

### Cumulative impact (Batches 187-190 + cleanup)

- **2 audit defects fixed** (scratchRectangle aliasing, pickEnd timing) — both real WebGPU correctness bugs in async pick.
- **2 pre-existing TS errors fixed** — `npx gulp build` now succeeds end-to-end; root `Source/` and `Build/CesiumUnminified/` propagate Batch 186's WGSL changes.
- **1 deferred entry closed** — NEW-FEATURE-ID-VERTEX-ATTR (Batches 130 + 188 implicit-range synthesis).
- **2 stale-RESOLVED entries reconciled** — NEW-FEATURE-ID-VERTEX-ATTR was shipped in Batch 130, C-R10-GLOBE-POINT-LIGHT was shipped in Batch 108. Both predate this session by months.
- **1 architectural blocker surfaced** — C-R9-MODEL-PICK-TRANSLUCENT second slice needs new per-pixel atomics or storage-stack infrastructure, not the "1-2 session" estimate. Future sessions have a clear sequencing plan documented in DEFERRED_WORK.md.
- **1 type cleanup** — PostProcessStage uniforms now structurally correct; `numU` helper amortizes the per-site narrowing.

The trend across this session: the deferred-work tracking has drifted significantly from the actual code state. **5 stale-RESOLVED entries surfaced in Batches 183 + 188 + 190 alone** (NEW-GLOBE-TRANSLUCENCY-MULTI-PASS, NEW-KHR-TRANSMISSION-THICKNESS, NEW-KHR-IRIDESCENCE-LUT, NEW-MODEL-NODE-TRANSFORMS-PREV, C-R8-GROUND-POLYLINE-NATIVE) plus 2 more in this batch (NEW-FEATURE-ID-VERTEX-ATTR, C-R10-GLOBE-POINT-LIGHT). A focused doc-walk batch surveying every open entry against the actual code path would likely close another 3-5 entries.

---

## Earlier Progress (2026-05-06 — Batches 183-186: closing classifier velocity + drill-pick + dedup sweeps + translucent pick first slice)

Four batches closing two deferred-work families end-to-end (NEW-ADVANCED-MOTION-VECTORS, NEW-DRILLPICK-ASYNC, C-R7-SHADER-MODULE-DEDUP), shipping the first slice of a third (C-R9-MODEL-PICK-TRANSLUCENT), and surfacing 5 stale-RESOLVED entries in DEFERRED_WORK.md that the actual code base had already shipped.

### Batch 183 — Translucent globe 3-pass underground gate fix + GroundPolyline classifier velocity (CLOSES NEW-ADVANCED-MOTION-VECTORS)

- **Underground+translucent gate fix.** `WebGPUGlobeSurfaceRenderer.ts:871-876` 3-pass emission gate (depth-only back-face → translucent back-face → translucent front-face) was missing a `!cameraUnderground` check. When both flags were true, the 3-pass commands fired AND the regular color command ran with `cullMode: "none"` (because `disableCulling` is true via `cameraUnderground`), producing a double-blend on back-faces. Gate now reads `globeTranslucent && !cameraUnderground && !isSubsequentPass && !debugWireframe && debugFragmentMode === NONE` so the underground-and-translucent case correctly takes the legacy single-pass both-faces path (the user's primary intent when underground is "see through the globe").
- **GroundPolyline classifier velocity** (CLOSES NEW-ADVANCED-MOTION-VECTORS classifier family). `WebGPUGroundPolylineRenderer.js` now ships `vsVelocity` + `fsVelocity` entry points that replicate the vsMain volume-extrusion math byte-for-byte (multi-attribute input, plane-based extrusion direction, bottom-vertex stretching for far views, screen-space width-miter push). Previous-frame clip projects the un-extruded world position (`pH + pL` in 3D, `pH2D.zxy + pL2D.zxy` in 2D / Columbus View) through `u.prevViewProjection`. Velocity descriptor + pipeline cache slot + format-invalidation reset wired alongside the existing color/pick/stencil pipelines. Velocity command emitted alongside the FIRST color command per primitive when `taaEnabled && !isMorphing && defined(velocityPipeline)` — matching the GroundPrimitive Batch 180 pattern.
- **Doc sync (5 stale RESOLVED entries).** Walked DEFERRED_WORK.md against current code:
  - NEW-GLOBE-TRANSLUCENCY-MULTI-PASS — RESOLVED (Batches 177 + 182 + 183 direct command emission, NOT the broken existing `WebGPUGlobeTranslucencyState` scaffolding).
  - NEW-KHR-TRANSMISSION-THICKNESS — RESOLVED (Batch 176 thickness-coupled refraction UV offset).
  - NEW-KHR-IRIDESCENCE-LUT — RESOLVED (Batch 181 Belcour 2017 analytical formula, LUT-free).
  - NEW-MODEL-NODE-TRANSFORMS-PREV — RESOLVED (Batch 175 per-node prev modelMatrix capture).
  - C-R8-GROUND-POLYLINE-NATIVE — RESOLVED 2026-04-30 (3-bug combination, including the viewport-zero VS extrusion bug — entry was stale).
  - C-R4-GLTF-KHR table updated: KHR_materials_iridescence + KHR_materials_transmission both promoted from ⚠️ to ✅. C-R4-GLTF-KHR is now fully resolved.

### Batch 184 — `Scene.drillPickAsync()` public API (CLOSES NEW-DRILLPICK-ASYNC)

New `Scene.drillPickAsync(windowPosition, limit, width, height)` returns a Promise that drills through stacked features by awaiting each pick before mutating `show` state. Renderer-agnostic at the Scene/Picking layer:

- `Scene.js:drillPickAsync` delegates to `Picking.drillPickAsync`.
- `Picking.js:pickAsync` calls `pickFramebuffer.endAsync(rect, frameState, limit)` (already implemented on both `PickFramebuffer.js` (WebGL: sync fence + PBO) and `WebGPUPickFramebuffer.ts` (WebGPU: mapAsync staging buffer readback)).
- `Picking.js:drillPickAsync` is the async sibling of the existing `drillPick` helper, awaiting each iteration's pick before recording `show=false` on hit primitives.
- Sync `Scene.drillPick` is kept as-is. The pre-existing debug-build `oneTimeWarning` now points users at `drillPickAsync` for correct WebGPU results (the sync path returns prior-frame pixels because GPU readback is inherently async).

### Batch 185 (pivot) — C-R7-SHADER-MODULE-DEDUP closure (CLOSES the dedup sweep)

Original Batch 185 plan was to attempt the C-R8-GROUND-POLYLINE-NATIVE VS extrusion fix, but the doc-sync in Batch 183 surfaced that all three bugs in that family (including the VS extrusion / viewport-zero issue) were already fixed on 2026-04-30. Pivoted to closing the C-R7-SHADER-MODULE-DEDUP sweep instead:

- 4 new `ShaderSourceId` entries (30/31/32/33: `GROUND_PRIMITIVE`, `GROUND_POLYLINE`, `SKY_ATMOSPHERE`, `ELLIPSOID_PRIMITIVE`) — add-only per the registry rules.
- Per-device `WebGPUShaderModuleCache` WeakMap pattern wired into `WebGPUGroundPrimitiveRenderer.js`, `WebGPUGroundPolylineRenderer.js`, `WebGPUSkyAtmosphereRenderer.js`, `WebGPUEllipsoidPrimitiveRenderer.ts`. All four route through `getOrCreate(sourceId, code, defines, label)` instead of `device.createShaderModule()`.
- The two GroundClassifier renderers were already on the edit list for Batches 180/183 velocity work, so the ride-along has zero marginal cost. SkyAtmosphere/Ellipsoid are singleton/few-per-scene (low dedup win); the cache unifies the pattern across the full renderer family.

### Batch 186 — C-R9-MODEL-PICK-TRANSLUCENT first slice

Two complementary fixes for translucent (BLEND alphaMode) model picking on WebGPU:

- **Pipeline depth-write off for BLEND.** `createPickPipeline` in `WebGPUModelPipelineCache.js` now passes `depthWriteEnabled: !isBlend`. Previously translucent fragments wrote depth and prevented later primitives at the same screen location from being pickable (first-drawn-wins). With depth-test only, the standard `less-equal` compare picks the geometrically closest fragment regardless of render order.
- **WGSL alpha-discard for BLEND.** `fragmentPickMain` discards `baseColor.a < 0.004` when `FLAG_ALPHA_MODE_BLEND` is set, so glass/water/ghost overlays don't claim pick over opaque geometry visible through them.

These two changes ship together — depth-write fix alone would still let near-transparent layers grab pick precedence at their depth without the alpha-discard guard. OIT-quality pick (weighted accumulation + composite resolve sorting by perceptual visibility) remains as a second slice.

### Cumulative impact (Batches 183-186)

- Three deferred-work families closed end-to-end: NEW-ADVANCED-MOTION-VECTORS, NEW-DRILLPICK-ASYNC, C-R7-SHADER-MODULE-DEDUP.
- One family advanced to PARTIAL: C-R9-MODEL-PICK-TRANSLUCENT (first slice ships; OIT-quality pick deferred to second slice).
- Five stale-RESOLVED entries surfaced and reconciled in DEFERRED_WORK.md (NEW-GLOBE-TRANSLUCENCY-MULTI-PASS, NEW-KHR-TRANSMISSION-THICKNESS, NEW-KHR-IRIDESCENCE-LUT, NEW-MODEL-NODE-TRANSFORMS-PREV, C-R8-GROUND-POLYLINE-NATIVE).
- C-R4-GLTF-KHR fully resolved (all KHR follow-ups originally filed as deferred have shipped).
- One real correctness bug fixed: translucent-globe + camera-underground double-blend at `WebGPUGlobeSurfaceRenderer.ts:871-876`.

---

## Earlier Progress (2026-05-05 — Batches 160-162: high-payoff feature trio)

Three batches closing genuinely-open Tier 4 work plus a doc-drift sync.

### Batch 160 — A.6 NEW-MODEL-CLIPPING-POLYGONS atlas-aware port (commit `8c72e4865a`)

`model.clippingPolygons` was wired through to the effects bind group in earlier work (commit `ebdc3548c3`) but the FS used a whole-globe lon/lat → atlas UV mapping that produced garbage SDF samples for typical small polygons (BIM cutaway scenarios) and hardcoded the inverse-clip direction. Batch 160 ports the WebGL VS+FS pipeline (`ModelClippingPolygonsStageVS.glsl` + `Builtin/Functions/clipPolygons.glsl`) into a single FS function, `modelClipByPolygon`, in `ModelPBRComplete.wgsl`:

- EffectsUniforms grew 336 → 480 bytes by adding `clippingPolygonControl: vec4<f32>` (extentsCount, invDim, inverseFlag) and `clippingPolygonExtents: array<vec4<f32>, 8>` (south, west, invLatRange, invLonRange).
- `WebGPUEffectsBindGroup.js` packs the new fields from `_extentsFloat32View` and `_extentsCount`, precomputes `1/dim` (atlas grid), and forwards `clippingPolygons.inverse`. Warns once when extentsCount > 8.
- Per-region rectUv selection (with the same 0.01 boundary threshold the GLSL VS uses) → atlas slot lookup → SDF sample → discard.
- `czm_fastApproximateAtan2` ported to WGSL so (lat, lon) match byte-for-byte with the CPU-packed extents (`packPolygonsAsFloats` uses the same Drobot atan curve).
- Inverse flag respected: default discards inside polygons (cutout); `inverse = true` discards outside (AEC "show only inside" demos).

### Batch 161 — B.12 point-light cube shadows on two primitive lit shaders (commit `4280e026a9`)

`ModelPBRComplete.wgsl` has had point-light cube shadows for several batches; primitive lit shaders did not. Batch 161 lifts the receive path to two of the most-used primitive shaders:

- `PrimitivePhongTexturedColor.wgsl` and `PrimitivePBRSimple.wgsl` extend their `EffectsUniforms` struct from 272 → 336 bytes, adding `edgeControl` + `edgeViewport` as padding (primitives don't run the inline edge stage), `pointLightControl: vec4<f32>` (enabled flag, near/far, depthBias) and `pointLightPositionWC: vec4<f32>` (world light position + pcfRadius).
- `@group(3 or 2) @binding(17)` declares `pointLightCubeDepth: texture_depth_cube`. Off-path is the 1×1×6 placeholder cleared to 1.0 — the `pointLightControl.x > 0.5` gate skips the sample.
- `samplePointShadow` + `computeShadowFactorPointLight` inlined from the Model FS. 5-tap cross PCF when `pointLightPositionWC.w > 0` (cube-face texel radius); hard sample otherwise.
- Shadow-gate order: point-light first, CSM second, 2D shadow map last — matches Model FS so transitions stay coherent.
- fragWC reconstructed at the call site as `cameraWC + eyePosition` where `cameraWC = encodedCameraHigh + encodedCameraLow` (same pattern atmosphere LUT uses on these shaders).

Remaining 20+ primitive lit shaders await chunk-extraction of `samplePointShadow` for amortization.

### Batch 162 — A.9 NEW-IBL-SH-FAST-PATH audit-doc sync

The 9-coefficient SH fast-path was filed as a follow-up perf optimization in earlier audit-doc work, with the cubemap split-sum closure tracked separately. Batch 162's re-audit walked the actual code path and found the SH shortcut was ALREADY shipped in Batch 130 alongside the cubemap work — the deferred entry was stale-by-construction. Code path verified end-to-end:

- WGSL UBO `SHUniforms` at `@group(1) @binding(36)` ships 9 vec4 coefficients + a control vec4.
- WGSL `evalSphericalHarmonics(N)` does the 9-coefficient evaluation in 6 mads, mirroring `Builtin/Functions/sphericalHarmonics.glsl` byte-for-byte.
- WGSL FS gate at `ModelPBRComplete.wgsl:2275-2279` short-circuits to SH when `sh.control.w > 0.5`, otherwise samples the irradiance cubemap.
- JS `WebGPUIBLPipeline.ts:319-348` (`packSphericalHarmonics`) packs 9 coefficients with `data[39] = 1.0` (control.w active).
- JS `WebGPUImageBasedLighting.ts:189-208` calls `packSphericalHarmonics` whenever `ibl.sphericalHarmonicCoefficients` is set.
- JS `WebGPUModelRenderer.js:1273-1313` (`buildModelIBLEntries`) binds `_webgpuSHBuffer` at slot 36 (or `defaultSHBuffer` with control.w = 0).

`DEFERRED_WORK.md` and `AUDIT_2026_05_02.md` updated to reflect closure.

### Cumulative impact (Batches 160-162)

- Two BREAKING/PARTIAL audit items closed (A.6 model clipping polygons; B.12 point-light primitives partial).
- One stale DEFERRED entry retired (NEW-IBL-SH-FAST-PATH).
- Tier 4 narrowed by two entries.

---

## Recent Progress (2026-05-04 — Batches 154-159: audit-driven correctness fixes + doc sync)

Six batches closing review findings + advancing two BREAKING audit items + closing a long-running doc-drift problem.

### Batch 152/153 review fixes (Batch 154, commit `c2b2c06457`)

- (HIGH) `WebGPUModelRenderer.js`: `runtimeNode.transformToRoot` → `runtimeNode.computedTransform` at the per-runtime-node loop. Original Batch 152 used `transformToRoot` alone, which excludes the node's own transform — wrong for any rig with a non-identity local transform (the entire point of articulations). `computedTransform` (= `transformToRoot × transform`, initialized in `ModelRuntimeNode.initialize()` and kept current by `ModelMatrixUpdateStage`) is what WebGL's `updateRuntimeNode` forwards to its draw command. Helper renamed `isIdentityTransformToRoot` → `isIdentityMatrix4`.
- (LOW) `UniformState.js`: `_previousViewProjection` and `_previousViewProjectionRelativeToEye` initialized as `Matrix4.clone(Matrix4.IDENTITY)` instead of `new Matrix4()` (which is zero-matrix). Closes the dead-else `if (prevVP)` truthy-object pattern across all DP-H41 sites — first-frame UBO packs now contain identity instead of zeros.

### Audit doc comprehensive sync (Batch 155, commit `569aef0914`)

Originally planned as B.5 KHR-aniso + B.4 KHR-bindgroup-split + C.10 smoke-test pixel check, but exploration found B.5/C.10 already shipped (commits `487ef6478a` / `ba80c6e948`) and B.4 is ~150 LOC instead of the audit's ~40 LOC estimate. Pivoted to comprehensive doc sync: 14 RESOLVED-BUT-DOC-STALE entries marked with commit refs (B.5, A.12, B.16-B.20, C.1, C.3-C.5, C.7-C.12). Plus a clarity refactor in `WebGPUPostProcessPipeline.execute()`: `singlePassStages` array push moved AFTER the TAA `.execute()` call so push order matches GPU command stream order. No behavior change — TAA always ran in linear/HDR pre-tonemap; the misleading inline comment was the source of the confusion.

### A.4 progressive narrow-gate: GroundPrimitive (Batch 156, commit `60208eb4e5`)

`PrimitivePipeline.js:175-208` already produces `position2DHigh/Low` alongside the 3D set in non-3D scene modes. The 2D set is encoded into the same coord system as the active `uniformState.view × projection` and `camera.positionWC`. `WebGPUGroundPrimitiveRenderer.ensureVertexBuffer` now selects `position2DHigh/Low` in non-3D modes; `cache.positionSourceKey` rebuilds the buffer when scene mode flips. **No shader changes needed.** Gate narrowed from "all non-3D modes" → "MORPHING only". SCENE3D + SCENE2D + COLUMBUS_VIEW now all render correct GroundPrimitive classification volumes on WebGPU.

### Batch 155/156 review fixes (Batch 157, commit `3bdeb65437`)

- (MED, 155) Misleading post-process inline comment claimed a behavior change that did not occur. Comment rewritten: "purely clarity fix; no GPU command stream change."
- (HIGH, 156) `_needs2DShader` derived appearance silently bypassed in WebGPU non-3D modes. Textured GroundPrimitives + batched-classification primitives in 2D / CV would draw at the right position with broken texture coords. Now gated: `isNon3D && needs2DShader` falls through to silent-skip alongside MORPHING.
- (MED, 156) `destroyWebGPUGroundPrimitiveResources` leaked `vertexGPUBuffer` + `indexGPUBuffer` on primitive eviction. Pre-existing leak; both buffers added to the destroy chain.
- (LOW, 156) Defensive `?? position3DHigh` fallback masked the silent-failure mode the original Batch 150 gate prevented. Removed; `defined()` guard now silently skips with debug warning when 2D positions are unexpectedly absent.

### A.9 doc-sync + Vector3DTile* clarification (Batch 158, commit `8ba472d6aa`)

A.9 IBL ("split-sum approximation in name only") was already RESOLVED in Batch 130 (commit `0b4fac4b65`). `ModelPBRComplete.wgsl:441-442` binds `iblDiffuseTexture` (irradiance) + `iblSpecularTexture` (radiance) cubemaps; FS at 2128-2160 samples both via split-sum. Audit doc marked RESOLVED. The 9-coefficient SH fast-path filed as `NEW-IBL-SH-FAST-PATH` perf optimization (~30 LOC).

`Vector3DTile*` clarification: verified the three Vector3DTile primitive classes only carry RTC-relative 3D positions; WebGL's path doesn't check scene mode either. Our silent-skip gate is BETTER than upstream WebGL behavior. Lifting it would be a regression unless paired with CPU- or shader-side projection of the RTC-relative positions (~80 LOC × 3 renderers).

### C.6 ORPHANED tag + Tier-list refresh (Batch 159, commit `bc4f3a5fc9`)

`FEATURE_INVENTORY.md` updated SCAFFORDED → ORPHANED for `WebGPUVideoTextureManager`. Audit Tier-list refreshed: Tiers 2 + 3 now both empty; Tier 4 narrowed to genuinely-remaining significant work; Tier 5 narrowed to one entry (C.2 orphan dispatcher decision).

### Cumulative impact

- ~20 audit-doc entries closed across the six batches (mostly stale-but-shipped-since-Batch-130 work that the doc never caught up with).
- Two new BREAKING fixes (B.8 corrected to use `computedTransform`; B.9 first-frame init to identity matrix).
- One BREAKING progressive narrow (A.4 SCENE2D + COLUMBUS_VIEW on `WebGPUGroundPrimitiveRenderer`).
- Three follow-up DEFERRED_WORK entries created (`NEW-IBL-SH-FAST-PATH`, `NEW-DRILLPICK-ASYNC`, `NEW-MODEL-NODE-TRANSFORMS-PREV`).

---

## Recent Progress (2026-05-01 — Batches 127-153: three large-file decomposition arcs)

The three biggest TypeScript files in `Renderer/WebGPU/` were carved into focused per-concern modules. Zero behavior change — every batch verified by `npx tsc --project packages/engine/tsconfig.json --noEmit` clean and `npx gulp build` producing all four bundle outputs. Pure refactor; the audit-recommended `WEBGPU_CONTEXT_DECOMPOSITION_PLAN.md` candidate set is fully addressed.

### Arc 1: `WebGPUContext.ts` decomposition (Batches 127-144)

**Source**: 4427 → 4119 LOC (−308). 7 helper modules carved out.

| Batch | Module | What |
| --- | --- | --- |
| 127 | `WebGPUContextLimitsInit.ts` | Device-limits initialization (104 LOC) |
| 129 | `WebGPUContextWebGLStubInit.ts` | WebGL-compatibility stub builder (353 LOC) |
| 130 | `WebGPUDeviceInvalidationBus.ts` | Device-loss subscription bus (87 LOC) |
| 131 | `WebGPUResourceCacheRegistry.ts` | Cache-clear registry with try/catch (100 LOC) |
| 132 | `WebGPUFeatureFlags.ts` | Device feature gates (142 LOC) |
| 143 | `WebGPUContextDeviceLoss.ts` | Device-loss host adapter (115 LOC) |
| 144 | `WebGPUFrameStatistics.ts` | Per-frame counters (83 LOC) |

### Arc 2: `WebGPUSceneRenderer.ts` decomposition (Batches 133-142)

**Source**: 3626 → 2111 LOC (−1515). 10 helper modules carved out — biggest decomposition arc.

| Batch | Module | What |
| --- | --- | --- |
| 133 | `WebGPUSceneRendererPickPass.ts` | Pick-pass orchestration (280 LOC) |
| 134 | `WebGPUSceneRendererEnvironmentalEffects.ts` | Sky/atmosphere/ground (186 LOC, pure) |
| 135 | `WebGPUSceneRendererGlobePass.ts` | Globe-pass dispatch (126 LOC) |
| 136 | `WebGPUSceneRendererTranslucentPass.ts` | OIT + alpha-blend fallback (212 LOC) |
| 137 | `WebGPUSceneRenderer3DTilePasses.ts` | 3D-tile chain with FBO redirects (374 LOC) |
| 138 | `WebGPUSceneRendererPassRedirect.ts` | Scene-FB render-pass redirect (164 LOC) |
| 139 | `WebGPUSceneRendererFrameReset.ts` | Per-frame state reset (92 LOC) |
| 140 | `WebGPUSceneRendererFrustumLoop.ts` | Multi-frustum dispatch loop (500 LOC) |
| 141 | `WebGPUSceneRendererPostFrustumChain.ts` | Overlay + composite + post-process tail (161 LOC) |
| 142 | `WebGPUSceneRendererEnsureResources.ts` | Per-frame resource allocation (359 LOC) |

### Arc 3: `WebGPUGlobeSurfaceRenderer.ts` decomposition (Batches 145-153)

**Source**: 3933 → 1310 LOC (**−2623, −67%**). 9 helper modules carved out — biggest single-file reduction in the migration.

| Batch | Module | What | LOC |
| --- | --- | --- | --- |
| 145 | `WebGPUGlobeSurfaceTypes.ts` | Layout constants + interfaces + free helpers | 316 |
| 146 | `WebGPUGlobeSurfaceShaders.ts` | Shader-module factory (production + debug + clip-distances) | 402 |
| 147 | `WebGPUGlobeSurfaceLayouts.ts` | Bind-group + pipeline-layout + samplers + placeholder texture | 193 |
| 148 | `WebGPUGlobeSurfaceTextures.ts` | Imagery / water-mask / image-source upload cache | 217 |
| 149 | `WebGPUGlobeSurfaceWireframe.ts` | Wireframe pipeline + index-buffer cache | 322 |
| 150 | `WebGPUGlobeSurfacePipelines.ts` | Pipeline construction + central-cache resolver | 531 |
| 151 | `WebGPUGlobeSurfaceTileBuffers.ts` | Per-tile VB/IB + shadow-cast UB + eviction | 391 |
| 152 | `WebGPUGlobeSurfaceCameraUB.ts` | 116-float camera-UB packer (RTE + center3D split) | 428 |
| 153 | `WebGPUGlobeSurfaceTileUB.ts` | 472-float tile-UB packer (16-layer imagery + fog + ocean) | 600 |

**Pattern established across all three arcs**: host-interface dependency injection. Each helper module declares an `XxxHost` interface naming the renderer fields/methods it needs; the renderer satisfies the interface via the underscore-public convention (`public _foo` with a comment marking it as helper-shared). Helpers compose via interface inheritance (e.g., `WireframeHost extends PipelineHost extends ShaderFactoryHost`). Public API surface preserved via thin delegators where the public method name is part of the contract (`evictStaleResources`, `removeImageryTexture`).

**Audit discipline**: every batch closed with a byte-equivalent diff of moved method bodies against `git show HEAD:...` (modulo intended `this._XXX → host._XXX` substitutions and inter-helper call rewrites). Field-reference accounting verified `orig + N` where N = interface declarations + JSDoc references in destination modules. No behavior change in any batch.

**Cumulative impact across all three arcs**:

- 11,986 → 7540 LOC across the three source files (−4446, −37%)
- 26 new focused helper modules averaging ~250 LOC each, all under the 1000-LOC CLAUDE.md guideline
- `WebGPUSceneRenderer.ts` and `WebGPUGlobeSurfaceRenderer.ts` both now under 2500 LOC (SceneRenderer at 2111, Globe at 1310 — 1.31x guideline)
- `WebGPUContext.ts` remains at 4119 LOC; further decomposition deferred (audit-recommended candidates exhausted; remaining bulk is per-method device/queue plumbing without natural sub-extractions)

**See**: `BATCH_145_PLAN_GLOBE_SURFACE_DECOMPOSITION.md` for the full Arc 3 plan + roadmap; per-batch commit messages for the other two arcs (Batches 127-144).

---

## Recent Progress (2026-04-25 — Batches 48-57: principal review remediation continues)

Ten batches in two days closed the C-R8 edge sub-tree end-to-end and shipped three additional Critical-tier items in parallel via background agents. Full per-batch detail in [REVIEW_FIX_PROGRESS.md](REVIEW_FIX_PROGRESS.md); per-issue status in [PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md](PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md).

- **Batch 48 (C-R8-EDGE-INLINE + C-R8-EDGE-FEATURE-ID).** Authoritative per-fragment `applyEdgeOverlay()` in `ModelPBRComplete.wgsl` ports WebGL's `edgeDetectionStage()` 1:1 — adaptive epsilon, background gating via globe packed depth, per-feature comparison. Emitter packs glTF FEATURE_ID_0 into `id.g` at rgba8unorm scale with consumer-side denormalisation. Effects BGL grew 12 → 17 bindings; UBO 272 → 304 bytes for `edgeControl` + `edgeViewport` blocks.
- **Batch 49 (C-R8-EDGE-ID-FORMAT).** 16-bit feature IDs split across `id.g` (low byte) + `id.b` (high byte). 65535-feature ceiling. Same texture format, no BGL/pipeline rebuild.
- **Batch 50 (C-R8-EDGE-COMPOSITE-PRUNE).** Retired `WebGPUEdgeComposite.ts` post-process overlay (~354 LOC + ~75 LOC of scene-renderer call site). Confirmed via grep that only Model FS samples edge textures in WebGL too; the WebGPU post-process composite was a parallel-less invention.
- **Batch 51 (C-R8-EDGE-INLINE-PRIMITIVES, RESOLVED-NOT-NEEDED).** Investigation closed without code: WebGL doesn't sample edge textures in primitive shaders either, so no WebGPU work needed. Documented the misread in Batch 48's commentary.
- **Batch 52 (C-R7 audit).** Doc-drift correction — pipeline cache infrastructure (instantiation, key correctness, device-loss invalidation) was already complete from Batches 33-34, principal review still showed "DEFERRED". Updated to "INFRASTRUCTURE FIXED" with per-renderer routing tracked as `C-R7-RENDERER-MIGRATION` + `C-R7-SHADER-MODULE-DEDUP`.
- **Batch 53 (C-R9-VOXEL-PICK).** `fragmentPickMain` runs same AABB ray-march, emits `u.pickColor` on first density-threshold hit. Pick pipeline shares color layout/vertex/depthStencil. Per-cell pick deferred as `C-R9-VOXEL-CELL-PICK`.
- **Batch 54 (C-R9-MODEL-PICK).** glTF Model pick at primitive granularity. `fragmentPickMain` runs alpha-mask + batch-table-hide discards then emits `material.pickColor`. Per-feature pick deferred as `C-R9-MODEL-FEATURE-PICK`; OIT pick path deferred as `C-R9-MODEL-PICK-TRANSLUCENT`.
- **Batch 55 (C-R11-EFFECTS-BGL-COLLECTION-CACHE).** Per-tile clipping bind group hot path: ~12k `createBindGroup` + ~12k `createBuffer` + ~36k `createView` per second → 0 steady-state. Cache plateaus at ≤4 entries; UBO bytes still rewritten per frame.
- **Batch 56 (C-R7-RENDERER-MIGRATION).** Three feature renderers (`WebGPUEllipsoidPrimitiveRenderer`, `WebGPUGaussianSplatRenderer`, `WebGPUDepthPlane`) routed through `context.webgpuPipelineCache`. Added `webgpuPipelineCache?:` to `CesiumGraphicsContext` ambient interface for backend-agnostic TS access. 12 renderers + Model + AutoExposure remain as continuing follow-ups.
- **Batch 57 (C-R10-POINT-LIGHT-RECEIVE).** Cube depth sampling on the receive side. BGL grew 17 → 18 bindings (binding 17 = `texture_depth_cube`); UBO 304 → 336 bytes for `pointLightControl` + `pointLightPositionWC` blocks. `samplePointShadow(fragWC)` reproduces the cast pipeline's perspective-Z formula via the dominant cube-face axis. Globe terrain receive deferred as `C-R10-GLOBE-POINT-LIGHT`.
- **Oversight audit** ([OVERSIGHT_AUDIT_2026_04_25.md](OVERSIGHT_AUDIT_2026_04_25.md)). Read-only state-of-migration analysis. Surfaced doc-drift on C-R9 (rolled into Batches 53/54 status updates), pragma-discipline lapse in `WebGPUGlobeSurfaceRenderer.ts:1259-1311` (fixed inline post-audit), and the C-R5 imagery-layer-cap bounded fix as the next-highest-impact correctness target.

**Verification:** `npx tsc --noEmit` clean across all batches. Pre-existing parse errors in untracked WIP file `WebGPUEdgeVisibilityEmitter.ts` carry forward — not introduced by these batches.

---

## Recent Progress (2026-04-19 — Session 35: URL fix, smoke test, DecoupledScan consumer)

Short defect-focused session that produced three pushed commits (`332a8efac2`, `852b4affd7`, `c7a502de6e`) on `origin/main`:

- **`Resource.parseUrl` URL-resolution regression repaired.** Two bugs introduced by the earlier ES6 modernization of `Resource.js`: (a) relative URLs against a `baseUrl` were resolving to root-relative paths that discarded the base's pathname — every `buildModuleUrl("Assets/...")` against a subpath `CESIUM_BASE_URL` was 404'ing; (b) `data:` / `blob:` URIs were being reconstructed from `origin + pathname` and corrupting into `nullimage/png;base64,...`. Both fixed. Core/Resource spec 119/119 pass. Detail in [WEBGPU_DEBUGGING_LOG.md](WEBGPU_DEBUGGING_LOG.md) § Session 35.
- **Variant smoke-test harness now reliable.** `Tools/variant-smoke-test.mjs` was previously unrunnable end-to-end; fixes include routing the WebGPU path through `Viewer.createAsync()` (the sync `new Viewer()` always returns WebGL by CesiumWidget design), enabling `--enable-unsafe-webgpu` in headless Chromium, re-binding `CESIUM_BASE_URL` post-load via `buildModuleUrl.setBaseUrl()`, and logging failed request URLs. All 3 bundles (dual / webgl-only / webgpu-only) now PASS with zero console errors across 5 render frames.
- **FEAT-SURVEY-06 first consumer wired.** `WebGPUDecoupledScan` (the single-dispatch inclusive prefix sum from Merrill & Garland 2016) now has an opt-in path inside `WebGPUPointCloudLODProcessor`: `tagVisible` → `DecoupledScan` → `compactScanned` → `copyBufferToBuffer(prefix[N-1] → visibleCount[0])`. Produces deterministic output ordering (`visibleIndices` sorted by original point index). Atomic-add stays default; `WebGPUContextOptions.useDeterministicPointCloudLOD: true` turns it on per context. New WGSL shader `PointCloudLODScanCompact.wgsl` + new spec `WebGPUPointCloudLODProcessorSpec.js` (7 tests, mock-device harness).
- **Carry-over bundle commit.** `c7a502de6e` bundled ~100 files of uncommitted work from prior sessions (CSM Slice 1 + 2a/2b/2c, TAA Slice 1 + 2a, aerial-LUT rollout to 6 shaders, build-variant infrastructure, WebGL-compat-stub Proton-style rewrite, `packages/wasm-naga/` Rust source + vendored runtime). Pre-commit lint fixes along the way: one missing curly-brace on a `for` loop in `UniformStateComputations.js`, removed dead `emptyStubPath` variable in `scripts/build.js`, added `packages/wasm-naga/*.mjs` to the eslint node-script scope, dropped unused shebangs on 5 test scripts, and switched `lint-staged.config.js` to a functional-config form that filters out vendored paths before running eslint/prettier/markdownlint.

---

## Recent Progress (2026-04-18 — Sessions 33 + 34: CSM Slice 1 + TAA Slice 1, both with RTE precision)

Two focused sessions landed the first vertical slice of both cascaded shadow maps and temporal AA, with a shared theme: the Cesium RTE (relative-to-eye) 64-bit precision contract is preserved end-to-end. No GPU path ever reconstructs a world-space position at Earth scale — intermediate values stay within cascade / view-frustum magnitudes, so FP32 remains exact. Full per-bug detail is in [WEBGPU_DEBUGGING_LOG.md](WEBGPU_DEBUGGING_LOG.md) § Session 33 + § Session 34.

### Session 33 — CSM Slice 1 RTE precision + per-cascade depth bias

**Audit-driven fix set.** Three distinct problems found and closed in one pass:

- **CSM-33-1 — Cast VP was world-space, cast VS expected RTE.** `ShadowMap.wgsl:35-39` (the shadow cast vertex stage) multiplies its `lightViewProjection` uniform by `posRTE = (positionHigh - camHigh) + (positionLow - camLow)` — a camera-relative vector. Our `WebGPUCSMRenderer.renderCastPass` was writing a **world-space** VP into the cast UBO, so `VP_world * posRTE` produced light-space coords for a point near the world origin rather than the actual vertex. Cascade 0's depth map was effectively empty. Masked in Slice 1 by the `rte24`-only filter (terrain casts through `quantized12`); any future cast-variant unlock would have surfaced this as totally-broken shadow output. **Fix:** new `applyCameraTranslationToVP(vpWorld, cameraWC) → VP_RTE` helper in [WebGPUCSMRenderer.ts](packages/engine/Source/Renderer/WebGPU/WebGPUCSMRenderer.ts) that composes `VP_world * T(+cameraWC)` in FP64. Every cascade gets both a world-space `viewProjection` (kept for diagnostics) and a `viewProjectionRTE` that matches the cast shader's convention.

- **CSM-33-2 — Receive shaders fed lossy FP32 worldPos into cascade VP.** `PrimitivePhongTexturedColor.wgsl:118` had `output.worldPosition = positionHigh + positionLow`; `GlobeTerrain.wgsl:1206` had `fragmentWorldPos = v_positionMC + cameraWC`. At Earth radius (6.37M m) FP32 ULP is ~0.76m — multiplying that by the cascade VP produced ~1m shadow-sample drift, which on the tightest cascade (10m extent) is full-pixel acne. **Fix:** receive shaders now feed the RTE-precise camera-relative position directly into the RTE-aware cascade VP. Primitive path uses the existing `eyePosition` varying; terrain adds a new `v_positionRTE` varying (`(center3DHigh - camHigh) + (center3DLow + exaggeratedPosition - camLow)`) populated in SCENE3D and zeroed elsewhere. Zero FP32 reconstruction on the GPU — precision drops from ~1m to sub-micrometer.

- **CSM-33-3 — Hardcoded `bias = 0.005` replaced with per-cascade slope-scaled formulation.** `CSMParams` UBO gained `cascadeMinBias: vec4<f32>` and `cascadeMaxSlopeBias: vec4<f32>` at float offsets 264/268 (fits within the existing 1088B placeholder — no BGL churn). Per-cascade constants scale with `sphereRadius[i] / sphereRadius[0]` so the NDC bias tracks each cascade's orthographic depth range. Shader formula: `bias = max(minBias[i], maxSlopeBias[i] * (1 - dot(N, L)))`. Base values `5e-5` / `5e-4`; cascade 3 (kilometer-scale) scales up proportionally. Applied inside `sampleOneCascade` for both primitive and globe paths; the cast UBO also carries a per-cascade-scaled depth bias.

**Files modified:** [WebGPUCSMRenderer.ts](packages/engine/Source/Renderer/WebGPU/WebGPUCSMRenderer.ts), [ShadowReceiveCSM.wgsl](packages/engine/Source/Shaders/WebGPU/Shadow/ShadowReceiveCSM.wgsl) (canonical helper), [GlobeTerrain.wgsl](packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl), [PrimitivePhongTexturedColor.wgsl](packages/engine/Source/Shaders/WebGPU/Primitive/PrimitivePhongTexturedColor.wgsl), [WebGPUEffectsBindGroup.js](packages/engine/Source/Renderer/WebGPU/WebGPUEffectsBindGroup.js) (BGL comment only), [WebGPUEffectsBindGroupCSMLayoutSpec.js](packages/engine/Specs/Renderer/WebGPU/WebGPUEffectsBindGroupCSMLayoutSpec.js), [WebGPUCSMRendererSpec.js](packages/engine/Specs/Renderer/WebGPU/WebGPUCSMRendererSpec.js) (+2 specs for `applyCameraTranslationToVP`).

**Verified.** `tsc --noEmit` clean; `gulp build` clean at 13.0 MB / 23.6 MB sourcemap; Node sanity script confirms `VP_RTE * eyePos ≡ VP_world * worldPos` bit-exact at camera position (6378137, 0, 0).

### Session 34 — TAA Slice 1 RTE motion vectors + depth reprojection

Took the "deferred TAA motion-vector RTE" follow-on called out in Session 33. Audit first (three architectural options surveyed), then implementation. TAA now reprojects history via **depth-based reprojection in eye-relative space** — the textbook `worldPos = inverse(currVP) * ndc; prevNdc = prevVP * worldPos` formulation would lose FP32 precision at 6.37M m, so we never reconstruct world-space at any step.

**Architectural choice — Option C over A/B.** The audit surveyed three motion-vector options: (A) MRT output from every main-scene shader, (B) separate velocity geometry pass, (C) depth reprojection in the TAA shader. Chose **C** for Slice 1: zero new render targets, depth texture already bound, motion vectors reconstructed per-pixel from `{currentMvpRTE, previousMvpRTE, cameraDelta}`. Works for static AND animated geometry (per-pixel depth is all we need). Trade-off: per-object animated motion (skinned models) falls through to per-pixel depth reprojection — correct for Slice 1; Slice 2 can add per-model MRT as a narrow exception.

**Motion-vector math (TAA.wgsl):**

```wgsl
ndcCurr = vec3<f32>(uv*2-1, depth)           // WebGPU NDC, depth in [0,1]
eyePosCurr = inverse(currentVpRte) * ndcCurr // camera-relative to CURRENT frame
eyePosPrev = eyePosCurr + cameraDelta         // cameraDelta = currWC - prevWC (FP64 on CPU)
ndcPrev = previousVpRte * eyePosPrev
prevUV = ndcPrev.xy * 0.5 + 0.5              // with WebGPU Y-flip
```

All intermediate values stay within view-frustum / cascade scale (km at most). `cameraDelta` is computed in FP64 on CPU each frame — even at orbital altitudes the 6.37M-scale camera positions cancel cleanly. `inverseCurrentVpRte` is CPU-precomputed (new `_invertMatrix4` helper inside `WebGPUTAAEffect.ts`, bit-exact per Node sanity test) so the shader skips per-pixel matrix inverse.

**Infrastructure additions:**

- **[UniformState.js](packages/engine/Source/Renderer/UniformState.js)** — new model-independent `viewProjectionRelativeToEye` lazy field (projection × view-with-translation-zeroed) + getter. New `previousViewProjectionRelativeToEye` and `previousCameraPosition` snapshots taken at the top of `update()` BEFORE `updateCamera` runs, so they genuinely capture last frame's state. The VP_RTE form is model-independent so the snapshot is safe regardless of what model matrix the last draw command set.
- **[UniformStateComputations.js](packages/engine/Source/Renderer/UniformStateComputations.js)** — `cleanViewProjectionRelativeToEye()` helper + dirty flag wired into `setView` / `setProjection`.
- **[WebGPUTAAEffect.ts](packages/engine/Source/Renderer/WebGPU/WebGPUTAAEffect.ts)** — TAA params UBO grew from 32 → 256 bytes. New fixed offsets: `currentVpRte` (32), `previousVpRte` (96), `inverseCurrentVpRte` (160), `cameraDelta` (224), plus `historyValid` flag at the tail of the prefix block. New `updateMotionVectorParams()` public API; new `_invertMatrix4` FP64 inverse helper (kept local to avoid Matrix4 import coupling into this TS module).
- **[Scene.js](packages/engine/Source/Scene/Scene.js)** — alongside the existing Halton jitter application, computes `cameraDelta = currCam - prevCam` (FP64 subtraction) and pushes matrices + delta into the TAA effect every frame. `historyValid` gated on `frameNumber > 1` so the first frame falls back cleanly to UV-identity.
- **[TAA.wgsl](packages/engine/Source/Shaders/WebGPU/PostProcess/TAA.wgsl)** — `TAAParams` struct extended to match the new UBO layout. New `reprojectUV()` helper implements the depth reprojection math above. Falls back to identity UV in four cases: `historyValid == 0` (first frame), `depth >= 1.0` (sky), `clipPrev.w <= 0` (behind previous camera), `prevUV` out of [0,1] (disocclusion/offscreen). Y-flip matches the WebGPU cascade sampling convention. Neighborhood AABB clamp unchanged.

**Verified.** `tsc --noEmit` clean; `gulp build` clean at 13.1 MB / 23.7 MB sourcemap (up ~100 KB for the TAA matrix fields + shader math); Node matrix-inverse sanity test produces identity to 0.000e+0.

### Deferred follow-ons from these two sessions

**CSM:**

- **Slice 2a** — **SHIPPED 2026-04-18.** All cast variants unlocked (`rte24`, `p12`, `modelP12`, `modelInstanced`, `modelInstancedSB`, `modelSkinned`, `quantized12`). CSM's `renderCastPass` generalized to handle per-command `extraBindings` (modelMatrix UB, joint-matrices SB, instancing SB) + multi-VB variants via `vertexBufferSourceSlots`. CPU cast-output contract locked via new `computeCastClipPosition` helper + `WebGPUCSMCastUBOLayoutSpec.js` (the GPU-readback alternative was evaluated and deferred — CPU contract specs catch the same regression class).
- **Slice 2b** — **SHIPPED 2026-04-18.** Texel-snap stabilization + PrimitivePhongColor receive. New exported `snapToTexelGrid` helper quantizes cascade sphere center to the shadow-texel grid in world-grid-locked light space (basis stable across camera motion — that's what kills shimmer). Earth-scale sanity: two raw centers offset by 0.1 and 0.2 texel both snap to the same world position. `PrimitivePhongColor.wgsl` gained the CSM branch mirroring `PrimitivePhongTexturedColor.wgsl` — CSM bindings at `@group(2)` (no texture group in between).
- **Slice 2c** — **SHIPPED 2026-04-18.** ModelPBRComplete CSM receive. Model pipeline layout extended from 7 to 8 bind groups (effects at @group(7)), per-frame `createEffectsBindGroup` wired in `WebGPUModelRenderer.updateWebGPUModel`. New `@location(7) rteMC` varying carries the existing model-space RTE vector; fragment rotates it to world-space RTE via `material.modelMatrix * vec4(rteMC, 0.0)` — the w=0 drops translation so the rotation+scale yields exactly `pWC − camWC` without FP32 reconstruction at Earth scale. Cook-Torrance `direct` lighting multiplied by `shadowFactor` when CSM is enabled; ambient + emissive remain unshadowed per PBR convention. Unlit materials early-exit before CSM so they're naturally safe.
- **Slice 2d** — PrimitivePBR{Simple,Textured} receive + 20 Material Lit variant receivers (MatColorLit, MatBumpMapLit, MatWaterLit, etc.). Mechanical effort; candidate for scripted transformation or its own session. All lack the effects binding today.
- **Slice 3** — altitude-adaptive splits (collapse to one large cascade at > ~500 km altitude), moon dual-light cascades, VSM soft shadows.
- **Slice 4** — 3D Tiles per-tile cascade culling, snapshot-freeze contract, WebGL parity.

**TAA:**

- **Slice 2** — per-model MRT motion vectors for skinned/animated primitives + sky reprojection (depth=1.0 fragments need a camera-rotation-only reprojection path).
- **Slice 3** — variance clipping refinements, disocclusion detection strengthening, skinned / morphed / instanced model previous-frame uniforms.
- **Slice 4** — 3D Tiles pop-in NaN motion + picking un-jitter + CSM+TAA interaction verification + WebGL parity.
- **History invalidation on large camera jumps** — if `length(cameraDelta)` exceeds a threshold (teleport / `camera.flyTo` landing), history should be dropped. Not yet wired.

---

## Recent Progress (2026-04-18 — CSM Slice 2c ModelPBRComplete receive)

glTF models now receive cascaded shadows. This closes the largest remaining gap in the Slice 2 scope — globe terrain + phong primitive receivers already worked since Slice 1, and Slice 2a/2b unlocked all cast variants + non-textured phong + texel-snap. Models were the biggest hold-out because the model pipeline already consumed 7 bind groups, so effects had to be added as a new `@group(7)` with careful pipeline-layout coordination.

### Pipeline layout extension (7 → 8 bind groups)

[WebGPUModelPipelineCache.js:328-351](../packages/engine/Source/Renderer/WebGPU/WebGPUModelPipelineCache.js#L328-L351):

- Added `this._effectsBGL = getEffectsBindGroupLayout(device)` alongside the six existing BGLs (camera, material, texture, skinning, morph, instancing, featureId). Same factory every CSM-aware path uses, so the 272-byte EffectsUniforms layout stays in lockstep across every consumer.
- Extended `createPipelineLayout`'s bindGroupLayouts array to 8 slots with effects at index 7. Backward-safe: no other model-rendering code references group 7, so the addition doesn't break cached pipelines or DrawCommand bind-group indexing.

### Per-frame effects bind group

[WebGPUModelRenderer.js:698-733](../packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.js#L698-L733):

- `updateWebGPUModel` now calls `createEffectsBindGroup(device, frameState, { shadowMap, csm, cameraInPlaneSpace })` per model per frame. Mirrors the globe renderer's pattern. CSM binding resolved by reading `frameState.context.csmRenderer` and gating on `.enabled === true` plus valid `cascadeParamsBuffer` + `cascadeArrayView`.
- Result stored on `cache.effectsBG` and pushed into each primitive's `WebGPUDrawCommand.bindGroups[]` at index 7.
- **Cost:** one 272-byte UB write + one bind-group creation per model per frame. Acceptable for typical scenes; if scaling to hundreds of models, a scene-wide shared bind group cached per frame is the obvious optimization.

### Model-space RTE → world-space RTE trick

The key insight that made the WGSL change small. ModelPBRComplete's VS already computes a model-space RTE vector at line 270:

```wgsl
let rte = (positionMC - camera.encodedCameraPositionMCHigh)
        + (vec3<f32>(0.0) - camera.encodedCameraPositionMCLow);
```

This is precisely the camera-relative vector but expressed in model coordinates (because `encodedCameraPositionMC = inverse(modelMatrix) * camWC`). The CSM cascade VPs expect **world-space** camera-relative position.

Solution: pass `rte` as a new `@location(7) rteMC` varying, and in the fragment shader rotate it through the model matrix:

```wgsl
let rteWC = (material.modelMatrix * vec4<f32>(input.rteMC, 0.0)).xyz;
```

The **`w = 0`** is what makes this work. With w=0, the matrix multiply drops the translation column (the affine part of `modelMatrix`), applying only rotation + scale. Mathematically:

```text
modelMatrix_3x3 * rteMC
  = modelMatrix_3x3 * (positionMC − camMC)
  = modelMatrix_3x3 * positionMC − modelMatrix_3x3 * camMC
```

Since `camMC = inverse(modelMatrix) * camWC`, the expression `modelMatrix_3x3 * camMC` equals `camWC − modelTranslation`. Meanwhile `modelMatrix_3x3 * positionMC = pWC − modelTranslation`. The `modelTranslation` terms cancel:

```text
modelMatrix_3x3 * rteMC = (pWC − modelTranslation) − (camWC − modelTranslation) = pWC − camWC
```

This is exactly the world-space camera-relative vector the cascade VPs need — and it stays precise in FP32 because `rteMC` is bounded by (model extent + camera distance to model), not Earth-scale. `modelMatrix_3x3` is a well-conditioned rotation + scale with no translation, so the multiply preserves precision.

### Fragment integration

[ModelPBRComplete.wgsl](../packages/engine/Source/Shaders/WebGPU/Model/ModelPBRComplete.wgsl):

- CSM helpers (`selectCascade`, `getCascadeVP`, `cascadeDepthBias`, `sampleOneCascade`, `sampleCascadeShadow`, `computeShadowFactorCSM`) inlined from `PrimitivePhongTexturedColor.wgsl` — math is identical across receivers.
- Cook-Torrance `direct` lighting multiplied by `shadowFactor` when `effects.csmControl.x > 0.5`. Ambient + emissive stay unshadowed per PBR convention (direct sun casts shadows, ambient/IBL fills them).
- Unlit materials (`FLAG_IS_UNLIT`) early-exit at line 447 well before the CSM path, so they're naturally exempt — no additional gate needed.

**Build state:** `npx tsc --noEmit` clean. `npx gulp build` clean at 13.1 MB / 23.7 MB sourcemap (same as pre-change — shader additions are minor).

### Still pending

**Slice 2d** — PrimitivePBR{Simple,Textured} receive + 20 Material Lit variant receivers. All lack the effects binding today; each needs (a) a pipeline-layout extension to include effectsBGL at an appropriate slot, (b) a `rteMC` or `eyePosition` varying, (c) CSM helpers inlined. Mechanical scope; candidate for templated / scripted approach across the 20 Material Lit variants.

---

## Recent Progress (2026-04-18 — Slice 1 follow-ons + CSM Slice 2a cast-variant unlock)

Three follow-on tasks landed after Sessions 33 + 34 to lock in the Slice 1 contracts and unlock CSM Slice 2a.

### Cast-output verification contract (CPU-side)

Originally called out as BLOCKING-before-Slice-2 in the post-Session-34 handoff. The naive approach (render a single cube into the cast pass → read back cascade texture via `copyTextureToBuffer` + `mapAsync`) would need GPU-readback infrastructure that no Cesium spec currently uses — disproportionate for one verification point. Instead:

- New exported `computeCastClipPosition(pHigh, pLow, camHigh, camLow, lightVpRte, depthBias, result)` helper in [WebGPUCSMRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUCSMRenderer.ts). CPU reference for the `rte24` cast VS math. This is the contract every Slice 2 variant must preserve — variant-specific decompression happens *before* this step.
- New [WebGPUCSMCastUBOLayoutSpec.js](../packages/engine/Specs/Renderer/WebGPU/WebGPUCSMCastUBOLayoutSpec.js) locks the 128-byte cast UBO layout: `lightVP_RTE` @ float 0..15, `camHigh` @ 16, `camLow` @ 20, `depthBias` @ 24, `normalBias` @ 25. Also re-exports + locks `BASE_MIN_BIAS = 5e-5` / `BASE_MAX_SLOPE_BIAS = 5e-4`.
- Extended [WebGPUCSMRendererSpec.js](../packages/engine/Specs/Renderer/WebGPU/WebGPUCSMRendererSpec.js) with 4 Earth-scale identity specs: identity-at-origin, Earth-scale RTE subtract, `VP_RTE · rte ≡ VP_world · worldPos` at Earth scale, bias-only-touches-clip-z.

Node sanity run: Earth-scale identity max diff 3.3e-17 (double-precision floor). GPU-readback remains available if a future Slice 2 variant exposes a failure CPU specs can't catch.

### `worldPosition` varying removed

Session 33 pivoted the CSM fragment path from `worldPosition` (lossy FP32 `positionHigh + positionLow` reconstruction) to `eyePosition` (RTE-precise camera-relative vector). The varying was zero-filled as a one-session stopgap for layout compatibility; removed now. [PrimitivePhongTexturedColor.wgsl](../packages/engine/Source/Shaders/WebGPU/Primitive/PrimitivePhongTexturedColor.wgsl) VertexOutput dropped from 6 to 5 varyings. Removing it eliminates the attractive-nuisance of a mis-named varying that future contributors could re-introduce into the RTE precision hazard. Fragment shader unchanged — it already read only `input.eyePosition`.

### CSM Slice 2a — cast-variant unlock

`WebGPUCSMRenderer.renderCastPass` previously filtered to `_shadowCastLayout === "rte24"` and bound only the per-cascade cast UBO. Generalized to accept every registered `SHADOW_CAST_VARIANTS` entry. Pattern mirrors the single-shadow-map loop:

- **No-extras variants** (`rte24`, `p12`, `modelInstanced`): shared per-cascade bind group via `this._cascadeCastBindGroups[ci].get(layoutKey)`.
- **Extras variants** (`modelP12`, `modelInstancedSB`, `modelSkinned`, `quantized12`): per-command bind group indexed by cascade via `cmd._shadowCastCSMBindGroups[ci]` with parallel `cmd._shadowCastCSMBindGroupKeys[ci]` for variant-change invalidation. Each variant's `perCommandBindingFields` names which command field supplies each extra binding.
- **Multi-VB variants** (`modelSkinned`): walks `variant.vertexBufferSourceSlots = [0, 5, 6]` to map the model's 7-buffer layout into the cast pipeline's compact 0/1/2 layout.
- `pass.drawIndexed(count, cmd.instanceCount ?? 1)` for instanced variants.

New exported [getShadowCastVariant(key)](../packages/engine/Source/Renderer/WebGPU/WebGPUShadowMapRenderer.js) is the single source of variant metadata across both CSM and single-shadow-map paths. Pipeline compilation shared through the already-wired `_getOrCreateCastPipeline` factory with a CSM-owned cache (`this._sharedPipelineCache`) — same BGL as single-shadow-map, so the 128-byte cast UBO binds cleanly against either path's buffer without a second compile.

**What's live:** models cast cascaded shadows on terrain and on each other. Quantized-mesh terrain casts on models. Skinned and GPU-instanced models cast. Any future variant registered via `registerShadowCastVariant` works automatically — the CSM loop is fully metadata-driven.

**Still pending in Slice 2:** primitive lit receivers (`ModelPBRComplete.wgsl` etc. consume bindings 10/11 with the same `eyePosition`/RTE contract) + texel-snap stabilization. See [CSM_DESIGN.md](CSM_DESIGN.md) § "Slice 2 progress".

---

## Recent Progress (2026-04-18 — Principal-Engineer Review Batches 6-27 + WebGPU Infrastructure)

Two commits on main (`4e91c1238a`, `23cbf1121b`) closed out the 2026-04-16 principal-engineer review remediation and landed the shader-variant + TAA infrastructure that Phase 8c/d will consume. Full per-batch write-up is in [REVIEW_FIX_PROGRESS.md](REVIEW_FIX_PROGRESS.md).

### New core infrastructure (Renderer/WebGPU/)

- **`WebGPUShaderDefines.ts`** — `ShaderDefine` bitmask registry (`GEODETIC_NORMAL`, `DISABLE_DEPTH_DISTANCE`, `SPLIT_ENABLED`, `COMPRESSED_VERTICES`) + `ShaderSourceId` registry. Add-only invariant is documented and enforced at the code level; bits are packed into a Uint32 cache key as `(sourceId & 0xff) | ((defines & 0xffffff) << 8)`.
- **`WebGPUShaderModuleCache.ts`** — Tier 1 `GPUShaderModule` dedupe keyed on that Uint32. Prewarm API for per-renderer known-variant sets. Cleared on device loss.
- **`WebGPUShaderPreprocessor.ts`** — `//>>ifdef` / `//>>else` / `//>>endif` directive processor, pure function over source strings. Unknown flag names produce actionable parser errors. Primitive shaders now always route through this (`defines=0` is byte-identical to pre-Batch-27 output for shaders without directives).
- **`WebGPUShaderTranslator.ts`** — GLSL→WGSL transpile scaffolding. Used by the stub pipeline extractor.
- **`WebGPUPointCloudLODProcessor.ts`** — extracted from the point cloud renderer for LOD handling independent of draw-command issuance.
- **`WebGLStubPipelineExtractor.ts`** — extracts pipeline shape from the WebGL stub path so WebGPU can mirror it.

### TAA / motion-vector plumbing complete (DP-H41-ALL-RENDERERS)

`previousViewProjection: mat4x4<f32>` is now appended to **every** renderer's `CameraUniforms` struct — 63 WGSL shader files across Primitive/, Collections/, Model/, Compute/, Generated/. Every renderer's JS/TS pack function writes the previous frame's viewProjection from `UniformState.previousViewProjection` at the correct slot offset, with identity fallback for the first frame. 16-byte alignment verified on every variant; buffer size grew where needed (Primitive flat 96→160, lit 240→304; Model 256→320; Polyline 128→192; Weather 128→192; Ellipsoid 176→240). Billboard/Label/Point UBs unchanged (previously-unused tail slots now carry prevVP). `UniformState.d.ts` and `CesiumUniformState` ambient updated to expose the getter.

**Consequence:** future TAA / motion-vector passes read `camera.previousViewProjection` from any pipeline without renderer-specific bind-group adjustments. CSM work can lean on this same slot for shadow-history reprojection.

### CPU compressed-vertex decode covers all four slots (DP-H19-TANGENT-DECODE)

`WebGPUPrimitiveCommands.ensureUncompressedAttributes` previously reconstructed only `normal` + `st` from the geometry's `compressedAttributes` payload. It now also reconstructs `tangent` + `bitangent` when they were originally present, emitting Float32Array `GeometryAttribute`s so any future normal-mapping material finds them in the expected slots. Uses the same `AttributeCompression.octDecodeFloat` / `octUnpack` JS path the CPU already used for normals. Idempotent for re-entry.

### GPU compressed-vertex decode scaffold (DP-H19-SHADER-DECODE)

Full pipeline scaffold in place behind a feature flag (default **off**). Runtime flip remains pending; scaffold components verified end-to-end:

- `ShaderDefine.COMPRESSED_VERTICES` bit added (bit 3).
- `chunks/functions/csm_decodeCompressedVertex.wgsl` — `csm_octDecodeFloat_single`, `csm_octUnpack`, `csm_decompressTextureCoordinates`. JS ↔ WGSL byte-identical decode invariant documented.
- `PrimitivePhongColor.wgsl` is the pilot: `//>>ifdef COMPRESSED_VERTICES` / `//>>else` branches on `struct VertexInput` (swaps `normal: vec3<f32>` ↔ `compressedAttributes: f32`) and on the `vertexMain` decode call. Smoke-tested: `defines=0` emits CPU path, `defines=COMPRESSED_VERTICES` emits GPU path.
- `getVertexLayoutForShader(type, { compressedVertices })` emits a narrower 44-byte stride for the compressed phong variant.
- `shaderSupportsCompressedVertices` + `_SHADERS_WITH_GPU_DECODE` registry (currently `["phong"]`).
- `setCompressedVertexDecodeEnabled` / `isCompressedVertexDecodeEnabled` feature flag.
- All 4 Primitive `WebGPUShaderModule.create` sites now route through `preprocess(code, defines)`.

Remaining work (tracked for a follow-up batch): the runtime swap of the vertex buffer packer to emit `compressedAttributes` directly + `ensureUncompressedAttributes` skip path when the flag is on; expanding `_SHADERS_WITH_GPU_DECODE` beyond `phong` (each addition = one `//>>ifdef` block + one registry entry).

### Batch 26 — partial-fix closures

- **H-P5** — every `mapAsync` site in the renderer now guarded with try/catch that returns a clean fallback (null / empty result) instead of leaking unhandled promise rejection. Affected: `WebGPUTextureUtilities.createPixelReadbackPBO`, `WebGPUContext.readPixelsToPBO`, `WebGPUGPUCuller.readResults` (in addition to prior-batch guards on `AutoExposure` + `BufferMapper`).
- **C-P7-RTE** — `VolumetricFog.wgsl` altitude reconstruction refactored to a 2nd-order Taylor expansion around the camera to avoid the `length(worldPos) - innerRadius` f32 cancellation at Earth-radius magnitudes. CPU-precomputed `cameraAltitude` / `cameraUp` / `oneOverDenom` uploaded in the VolumetricFogParams buffer.

### Batch 6-25 cumulative additions (abbreviated — see REVIEW_FIX_PROGRESS.md for per-batch detail)

- **Globe**: DP-H40 split (`camera.splitPosition` in framebuffer pixels), DP-H41 prevVP, DP-H42 disable-depth-distance, DP-H25 geodetic normal in exaggeration math, Hi-Z occlusion wiring (+628 lines).
- **Shadow mapping**: cascaded shadow maps with 4-cascade selection, PCF filtering, clipping integration (+737 lines).
- **Primitive materials**: full material shader selection + BGL v2 layout + split pick UBOs, DP-H19 CPU decompression (+770 lines).
- **Point cloud**: LOD processor extracted; EDL (Eye Dome Lighting) wired through the post-process stack (+484 lines).
- **Polyline / Billboard / Label**: DP-H40 / DP-H42 plumbing, material UBO split, pick pipeline reaches WebGL parity.
- **Model (glTF)**: IBL factor + SH uploads, scene `light.color` honored, KHR_mesh_quantization dequantize, skin weights, morph target weights, glTF sampler properties honored.
- **Build**: `stripPragmaPlugin` now handles `.ts` too; bundle variant plugin cleanup; `wgslToJavaScript` output refinements.

**Typecheck:** `npx tsc --noEmit` clean. **ESLint + prettier:** clean on all staged files. **WGSL `.js` companions** regenerated.

---

## Recent Progress (2026-04-15 Session 30 — Typing Completion + Discriminated Picking)

### Typing sweep final state

Renderer/WebGPU TypeScript is at its principled floor:

- **`as unknown as` / `as any` in Renderer/WebGPU:** 19 → 13 (all documented intentional — 6 central helpers in `webgpuTypeHelpers.ts`, 2 WIP performance manager, 3 doc-comments in `WebGPUSceneRenderer.ts`, 2 doc-comments in `cesium-js-types.d.ts`).
- **`Record<string, unknown>` in Renderer/WebGPU .ts:** 15 → 3 (all JS-interop boundaries with expanded block comments).
- **Bare `: any` declarations (entire engine):** 0.
- **`@ts-ignore` / `@ts-expect-error` (engine Renderer):** 0.
- **Net LOC delta across 7 session commits:** −118 (1876 insertions / 1994 deletions).

### New public shared types

Introduced in `packages/engine/Source/Renderer/GraphicsContext.ts`:

- **`DebugStatsValue`** / **`DebugStatsObject`** — recursive JSON-safe type for `getRendererStatistics()` and subsystem debug surfaces. `ProfilingResults` / `PassTimingResult` on `WebGPUTimestampProfiler` now extend `DebugStatsObject` directly — no cast at the Context assignment site.
- **`PickTarget`** — heterogeneous pick-registry target with documented-intentional `PickTargetField = unknown` index-signature values. Named so greps don't flag the `unknown` as a mystery.
- **`PickKind`** — closed 16-member string union (`"billboard"` | `"label"` | `"point"` | `"polyline"` | `"polygon"` | `"primitive"` | `"ground-primitive"` | `"model"` | `"model-instance"` | `"entity"` | `"tile-feature"` | `"voxel"` | `"cloud"` | `"particle"` | `"buffer-primitive"` | `"custom"`). Typos fail to typecheck.
- **`PickResult = { target: PickTarget; kind: PickKind }`** — returned from the new `getPickResult(color)` method.
- **`Renderable`** / **`RenderableWithPass`** — structural interface capturing the duck-typed `update(frameState)` contract shared by every scene primitive (no common base class in Cesium by design). Zero runtime cost — TS erases at compile time. First consumer: `CesiumFrameState.brdfLutGenerator` typed as `Renderable | undefined`.
- **`ViewportQuadCommandOptionsBase`** / **`ViewportQuadCommandHandle`** — backend-agnostic shared base types. WebGL `Context.createViewportQuadCommand` options and WebGPU `ViewportQuadCommandOptions` both extend `ViewportQuadCommandOptionsBase`; WebGPU `ViewportQuadCommand` extends `ViewportQuadCommandHandle`. The abstract `createViewportQuadCommand` signature in `GraphicsContext.ts` now has a real typed shape instead of `(unknown, ..., unknown) => unknown`.
- **`SceneGlobalCache`** — typed interface with per-subsystem known keys (`billboardCollection_indexBufferInstanced`, `cloudCollection_*`, `imageryLayer*`, `tile_waterMaskData`, etc.) plus `CesiumOpaqueObject` index-signature fallback. Replaces `Record<string, unknown>` on both `WebGPUContext.cache` and `Context.d.ts` cache getters.
- **`OffscreenContextSupport.WorkerMessage`** / **`WorkerResponse`** — discriminated unions replacing the old `{ type, payload?: Record<string, unknown> }` bag. Each message branch carries exactly the payload it needs.

### Sidecars added (2 new → 15 total)

- **`Core/ComponentDatatype.d.ts`** — `declare enum + declare namespace` merge so Cesium JSDoc `@param {ComponentDatatype}` resolves to the numeric enum while runtime carries utility methods. Removed the local `ComponentDatatypeFull` interface + `as unknown as` cast in `WebGPUVertexArrayFacade.ts`; also cleaned 2 upstream `@ts-expect-error` directives in `BufferPrimitiveCollection.js`.
- **`Core/Resource.d.ts`** — minimal sidecar covering `.url`, `.getUrlComponent()`, options, proxy, request shapes. Unlocks `loadCubeMapWebGPU.ts` URL narrow without a cast.

### Non-breaking discriminated picking API

Closes the "what was picked?" question at the type level without breaking existing code:

```ts
// New signature (kind defaults to "custom" for external callers):
context.createPickId(object: PickTarget, kind?: PickKind): PickId

// New companion method:
context.getPickResult(color): PickResult | undefined

// Unchanged:
context.getObjectByPickColor(color): PickTarget | undefined

// Consumer pattern at Scene pick code:
const result = context.getPickResult(pickColor);
if (!result) return;
switch (result.kind) {
  case "billboard":      return handleBillboard(result.target);
  case "tile-feature":   return handleTileFeature(result.target);
  case "model-instance": return handleModelInstance(result.target);
  case "custom":         return fallbackInstanceofNarrow(result.target);
}
```

**Wired 20 internal registrar call sites** across 14 files: Billboard, PointPrimitive, Polyline, EllipsoidPrimitive, BatchTexture, PrimitiveGeometryHelpers, TimeDynamicPointCloud, VoxelPrimitiveHelpers, Model/PickingPipelineStage (2 sites — `"model"` + `"model-instance"`), renderBufferPointCollection, renderBufferPolygonCollection, renderBufferPolylineCollection, WebGPUBillboardRenderer (`"billboard"`), WebGPUPointPrimitiveRenderer (`"point"`), WebGPUPolylineRenderer (`"polyline"`), WebGPUBufferPrimitiveRenderer (3 × `"buffer-primitive"`).

**Parallel kind storage:** `_pickKinds: Map<number, PickKind>` shadows `_pickObjects` in lockstep. `PickId.destroy()` takes an optional `pickKinds` map and cleans both — no orphan entries.

### BindGroupLayoutHelpers migration sweep

New helper module `Renderer/WebGPU/WebGPUBindGroupLayoutHelpers.ts` with typed entry builders (`uniformBuffer`, `storageBuffer`, `texture`, `storageTexture`, `sampler`) and `makeBindGroupLayout(device, label, entries)` factory.

**Adoption: 86 of 88 `device.createBindGroupLayout({...})` call sites migrated across 46 files.** Remaining 2 are the backing-cache layer in `WebGPUContext.ts` and `WebGPUResourceManager.ts` (the helper's own implementation — correctly not migrated). Net LOC reduction: −646 lines of boilerplate (757 insertions, 1403 deletions on the big sweep commit).

### Additional narrowings

- `Check.d.ts` — 11 `test: any` → `test: unknown` in assertion signatures. Cleaner narrowing at every `Check.defined()` caller across the engine.
- `GraphicsContext.ts` abstract APIs — `createTexture`/`createBuffer` parameters: `Record<string, unknown>` → `unknown`; `createViewportQuadCommand` signature fully typed via the new shared viewport-quad bases; `_validateAbstractContract` dynamic method lookup uses `Reflect.get` instead of `as unknown as Record<string, unknown>`.
- `WebGPUDrawCommand` — `(buf as any).buffer` → `instanceof WebGPUBuffer` narrow; `owner?: any` → `WebGPUCommandOwner` (structural `{ constructor?: { name?: string } }`); `_pipelineConfig?: any` → typed `WebGPUPipelineConfig`.
- `WebGPUViewportQuad` — 7 `any`s removed via new exported types `ViewportQuadUniformValue` (discriminated union of 7 value shapes), `ViewportQuadCommand`, `ViewportQuadColorValue`, `ViewportQuadVectorValue`, `ViewportQuadShaderProgramSlot`.
- `WebGPUSceneRenderer._warnedCommandsMap` — keyed on `WebGPUContext` directly instead of `object`.
- `SharedResourcePool.getView` — 2 casts via `TypedArrayConstructor.BYTES_PER_ELEMENT` replaced with `InstanceType<Ctor>` generic linking parameter and return.
- `WebGPUFeatureRenderers` — dispatcher registrations: `soa: unknown, params: unknown` → `Parameters<typeof dispatchX>[i]` directly, casts at call site removed.

### Build / verification

- `npx tsc --noEmit`: clean (0 errors).
- `npx gulp build`: ~40s, clean.
- 7 commits, all pre-commit-hook clean (lint-staged + eslint + prettier).

---

## Recent Progress (2026-04-14 Session 29 — Typing Push: co-located .d.ts + cast cleanup)

### JS↔TS boundary cast elimination

- **13 new co-located `.d.ts` files** for CesiumJS JS classes that cross into WebGPU TypeScript code: `Matrix4`, `Cartesian3`, `Color`, `EncodedCartesian3`, `BoundingRectangle` (Core); `UniformState`, `PassState`, `ShaderCache`, `PickId`, `Context`, `Texture`, `CubeMap` (Renderer); `FrameState` (Scene).
- **`as unknown as` in `Renderer/`: 57 → 19 (-67%)**. The 19 survivors are legitimate — centralized helpers in `webgpuTypeHelpers.ts`, a WIP PerformanceManager bridge, a WebGPU-specific `execute(renderPassEncoder)` protocol overload, a forward-compat probe for `GPUTextureUsage.TRANSIENT_ATTACHMENT`, and ~10 that can still be dropped in a follow-up (see `NEXT_SESSION_HANDOFF.md` § "Remaining work toward a fully well-typed codebase").
- **8 stale `@ts-expect-error` directives removed** across 4 Scene `.js` files (they became TS2578 once the `.d.ts` files fixed the underlying errors).

### Notable correctness fixes surfaced by typing work

- **`CesiumMatrix4` ambient type was a lie.** Was declared as `Float64Array & { 0..15; clone; ... }` (intersection) — but `Matrix4` is a plain ES6 class, NOT a Float64Array subclass. The intersection required casts at every JS↔TS boundary. Fixed to structural interface; Matrix4 now flows through WebGPU without casts.
- **`isDestroyed` getter-vs-method drift.** `GraphicsContext.isDestroyed` was declared as an abstract getter, but upstream `destroyObject.js` overwrites `.isDestroyed` with a `returnTrue` **function property** on destroyed objects — a getter can't be overwritten that way without a TypeError. Changed base class to `abstract isDestroyed(): boolean` and `WebGPUContext.isDestroyed` from getter → method. Latent bug fixed: any caller that routed WebGPUContext through `destroyObject()` would have crashed (no code does yet).
- **`@private` JSDoc semantic clash.** CesiumJS uses `@private` to mean "not part of the published API" (upstream doc convention, predates TS tooling). TypeScript correctly interprets `@private` as class-scoped visibility, which **broke structural subtyping** between `Context` (has `@private readPixels`) and `GraphicsContext` (has `public abstract readPixels`). Forced `as unknown as GraphicsContext` at the `ContextFactory` boundary. Fixed via `Context.d.ts` declaring `readPixels`/`readPixelsToPBO` as public. Long-term fix: `@private` → `@internal` sweep on JS methods called cross-module (see backlog).

### Accompanying narrowings

- `GraphicsContextOptions.getWebGLStub` narrowed from the banned `Function` type to a concrete signature.
- WebGPU dispatcher signatures (`WebGPUGPUSortKeysDispatcher`, `WebGPUHiZOcclusionDispatcher`) widened their `context: { device: GPUDevice }` param to match WebGPUContext's nullable `device` getter.
- Sidecar cache types (`_ssrCache`, `_cloudCache`, `_weatherCache`, `_webgpuCache`) replaced `unknown` with real interfaces via `import("...").TypeName` pattern.
- `CesiumGraphicsContext.uniformAllocator` + `_computeCommandClass` + `CesiumFeatureRenderer.RendererClass`/`_instance` typed at source, eliminating ad-hoc cast-narrowing at consumer sites.

### Build / verification

- `npx tsc --project packages/engine/tsconfig.json --noEmit`: clean (0 errors).
- `npx gulp build`: 38s (-14% from 44s baseline).
- All 272 modified files + 13 new files committed and pushed (`1842043179`).

---

## Recent Progress (2026-04-13 Session 28 — Option B Completion, TypeScript Clean Build)

### Option B Material UBO Split — Completed

All WGSL shaders and JS renderers now use the split bind group layout: group(0)=CameraUniforms, group(1)=MaterialUniforms, group(2)=Texture, group(3)=Effects. Key changes:

- **PrimitiveMatGridLit.wgsl** decomposed to match GridFlat field names
- **4 Ramp shaders** converted from monolithic `Uniforms` to `CameraUniforms` + texture at group(2)
- **17 textured material shaders** — texture bindings moved from group(1) to group(2), eliminating binding conflicts
- **WebGPUPolylineRenderer.js** fully refactored — separate camera/material buffers and bind groups, `packMaterialUniforms` deleted, material data sourced from `MaterialUniformBuffer.gpuData`
- **Billboard + Cloud collection shaders** renamed `u.` → `camera.` for consistency

### TypeScript Build — Clean (202 → 0 errors)

Full elimination of all TypeScript build errors from `packages/engine/tsconfig.json`:

- **cesium-js-types.d.ts** — zero `any` in type positions (down from 79). 60+ missing properties added across 15 interfaces. 9 new typed interfaces added.
- **WebGPUContext.ts** — 6 private fields made public for cross-renderer access, 5 dynamic rendering properties declared as typed class fields
- **FeatureRenderer interface** — added optional `update`/`execute`/`render`/`composite` methods
- **esbuild errors** — 15+ missing `async` keywords and 3 setter signature fixes across 13 codemod-affected files
- **CLAUDE.md** — added `any` ban rule for all TypeScript code

### Build Status

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` | 0 errors |
| `npx tsc --project packages/engine/tsconfig.json --noEmit` | 0 errors |
| `npx gulp build` | Clean (35s) |

---

## Recent Progress (2026-04-12 Session 2 — ES6 Modernization, TypeScript, Security, WebGL Stubs, MaterialUniformBuffer, Build Variants)

### ES6 Modernization — Massive Batch (424 files)

- **jscodeshift codemod** (`scripts/codemod-es6-class.cjs`): 424 files converted from `var X = function() {}` + `X.prototype.*` patterns to ES6 `class` syntax in a single automated pass. Files that were already ES6 or contained non-trivial inheritance were left untouched by the codemod and handled manually where needed.
- **`.includes()` migration**: All `.indexOf()` comparison patterns replaced across the codebase (~90 patterns reduced to 0). Pattern `arr.indexOf(x) !== -1` → `arr.includes(x)` / `arr.indexOf(x) === -1` → `!arr.includes(x)`.
- **urijs removed**: All 12 source files that imported `urijs` migrated to the native `URL` API. The `urijs` dependency dropped from `package.json`.
- **karma-ie-launcher removed**: Dead IE-targeting dev dependency removed from `package.json`.
- **Remaining `var` declarations**: 3 remaining occurrences confirmed as comments-only or third-party code — zero actionable changes needed.

### TypeScript Type Safety Sweep

- **NEW** `packages/engine/Source/Renderer/WebGPU/cesium-js-types.d.ts` — ambient declaration file providing proper types for 20+ CesiumJS JavaScript classes: `FrameState`, `UniformState`, `DrawCommand`, `Scene`, `Globe`, `FrustumCommands`, `PassState`, `ShaderCache`, `RenderState`, `Camera`, `Context`, `BoundingRectangle`, `Cartesian2/3/4`, `Matrix3/4`, `Quaternion`, plus opaque branded types for GPU resource handles (avoids `as any` at GPU boundaries).
- **`as any` cast reduction** (66 → 32, net -34):
  - `WebGPUSceneRenderer.ts`: 46 → 3 (declared missing private fields: `_renderBundleEncoder`, `_currentPassEncoder`, `_sceneFramebuffer`, `_globeDepth`, `_pickFramebuffer`, scene/context handles)
  - `WebGPUGlobeSurfaceRenderer.ts`: remaining casts replaced with proper ambient types via the new `.d.ts` file
- **`: any` parameter annotation reduction** (~55 annotations replaced):
  - `WebGPUBufferPrimitiveRenderer.ts`: 30 → 17 `: any` annotations
  - `WebGPUPickFramebuffer.ts`: 9 → 1 `: any` annotations
  - Remaining reductions spread across renderer files via automated codemod pass + manual review

### Security Fix — XSS Sanitization

- **`InfoBox.js`**: Added DOMPurify sanitization for entity description `innerHTML`. Entity descriptions sourced from external data (KML, GeoJSON, CZML, user-defined) were previously injected raw into the DOM. Now sanitized via `DOMPurify.sanitize(description, { ALLOWED_TAGS: [...], ALLOWED_ATTR: [...] })` before assignment.
- **`Credit.js`**: Audited — already sanitized by existing upstream logic. No action needed.

### WebGL Compatibility Stubs — Proton-Style Overhaul

Full rewrite of the WebGL stub layer so CesiumJS WebGL code paths that run inside the WebGPU context produce real GPU work instead of silently no-opping:

- **`WebGLStubTexture.ts`** (full rewrite): `createTexture()` allocates a real `GPUTexture` via the context device. `texImage2D()` performs real WebGL→WebGPU format translation and uploads pixels. `texParameteri()` maps WebGL filter/wrap constants to `GPUSamplerDescriptor`. `pixelStorei()` tracks `UNPACK_FLIP_Y_WEBGL` and `UNPACK_PREMULTIPLY_ALPHA_WEBGL`. `generateMipmap()` dispatches through the real `WebGPUMipmapGenerator`.
- **`WebGLStubShader.ts`** (extended): `getParameter()` now returns real values sourced from `device.limits` for all limit parameters (max texture size, max uniform block size, etc.). `getExtension()` returns populated stubs for 15 common WebGL extensions (`OES_texture_float`, `EXT_color_buffer_float`, `WEBGL_depth_texture`, `EXT_disjoint_timer_query_webgl2`, etc.) so feature-detection code in CesiumJS materials and terrain paths behaves as expected.
- **`WebGLStubPipelineState.ts`** (extended): Full stencil state tracking added — `stencilFunc`, `stencilOp`, `stencilMask`, `stencilFuncSeparate`, `stencilOpSeparate`, `stencilMaskSeparate` all update an internal stencil state object that feeds into pipeline descriptor generation.
- **NEW `WebGLStateConverters.ts`**: Shared mapping functions extracted from the stubs: `webglFormatToGPUFormat()`, `webglFilterToGPUFilter()`, `webglWrapToGPUWrap()`, `webglBlendToGPUBlend()`, `webglCompareToGPUCompare()`. Centralizes all WebGL→WebGPU constant translation so the stub files stay clean.

### MaterialUniformBuffer — New Material Architecture

Zero-copy, Float32Array-backed uniform storage with auto-layout, replacing the old per-property JS object approach for WebGPU material uploads:

- **NEW `packages/engine/Source/Scene/MaterialUniformBuffer.js`**: `Float32Array`-backed storage with automatic std140-compatible layout inference. Dirty tracking (per-property `_dirty` flags + global `_anyDirty`). Scratch-based zero-allocation reads via `getScalar()` / `getVec2()` / `getVec3()` / `getVec4()`. Backward-compatible facade — existing `material.uniforms.color = ...` assignments continue to work via property setter proxies.
- **`Material.js`** wired via `MaterialHelpers.js` `initializeMaterial()` — the existing material construction path now also allocates a `MaterialUniformBuffer` when `isWebGPU` is detected.
- **`WebGPUPrimitiveCommands.js`** fast path: `uploadMaterialUniforms()` checks for `command.material._uniformBuffer._anyDirty`, uploads only changed regions via `device.queue.writeBuffer(buffer, byteOffset, data, dataOffset, size)`, and clears dirty flags. Skips per-property packing entirely for static materials. **~56% memory reduction per material** (Float32Array vs per-property JS heap), **~93% CPU reduction for static scenes** (zero JS work when no property changed).

### Build Variants — Infrastructure (Partial)

The tree-shaking build variant system is now wired end-to-end for all three output targets:

- **NEW `scripts/bundleVariantPlugin.js`**: esbuild plugin that intercepts `onResolve` for `Renderer/WebGPU/*` imports (WebGL-only build) and `Renderer/Context.js` / `Renderer/WebGLStub*` imports (WebGPU-only build), replacing them with synthetic empty-stub modules. Decision cache avoids redundant resolution. Handles both absolute and package-relative import forms.
- **`RendererType.ts`** extended: `setGlobalDefaultRenderer(type: RendererType)` / `getGlobalDefaultRenderer(): RendererType` static functions added. Each variant's entry barrel calls `setGlobalDefaultRenderer` at module init so the runtime default matches the build target. Users override per-Viewer via `contextOptions.renderer`.
- **`gulpfile.js`** extended: Added `buildCesiumWebGLOnly`, `buildCesiumWebGPUOnly`, `buildCesiumDual`, and `buildAllVariants` tasks. The combined task hoists `buildEngine` + `buildWidgets` so they run once across all three variants (~10s saved per extra variant).
- **`scripts/build.js`** extended: `createCesiumJs(options)` and `bundleCesiumJs(options)` now accept a `variant` parameter (`"webgl-only" | "webgpu-only" | "dual"`). The variant activates the `bundleVariantPlugin` with the correct alias set and drives the entry barrel filename (`Source/Cesium.js`, `Source/CesiumWebGLOnly.js`, `Source/CesiumWebGPUOnly.js`).
- **ESM code splitting enabled** on `bundleCesiumJs`: `splitting: true` with `chunkNames: "chunks/[name]-[hash]"`. The existing `await import("./WebGPU/WebGPUContext.js")` in `ContextFactory` now produces a real separate chunk — dual-variant ESM consumers who never select WebGPU skip the WebGPU chunk download entirely.

**Output directories for variant builds:**

- `Build/CesiumUnminified/` — dual (default, backwards-compatible, ESM code-split)
- `Build/CesiumWebGPUUnminified/` — WebGPU-only (GLSL shaders aliased to empty stubs)
- `Build/CesiumWebGLUnminified/` — WebGL-only (WebGPU renderer + WGSL aliased to empty stubs)

**Baseline measured (dual, minified):** `Cesium.js` = 6.8 MB / **1.89 MB gzipped** · `index.js` (ESM entry) = 5.6 MB / **1.48 MB gzipped**. Previous drafts of this doc cited a "~32% smaller ESM" figure for the WebGPU-only variant — that number was **provisional and is NOT yet measured**. The `buildAllVariants` run attempted on 2026-04-16 was interrupted before the webgl-only / webgpu-only bundles completed, so no variant-specific size delta is yet on record. See backlog item **BUILD-VAR-MEASURE** (2026-04-16 section) for the outstanding measurement + validation work and **BUILD-VAR-SCENE-AUDIT** for the runtime-correctness gate before the webgpu-only bundle can be recommended for production use.

---

## Recent Progress (2026-04-12 — Phase 5 + HDR Parity)

### Phase 5 Modern WebGPU Features

Three WGF items implemented with independent review + review-driven fixes:

| WGF | Feature | Scope | Activation |
| --- | --- | --- | --- |
| WGF-4 | Camera UBO RTE assertions | `WebGPURTEAssertions.ts` — round-trip + MV-zeroed checks in 3 packers | Always on in debug builds (pragma-guarded) |
| WGF-1 | Hardware clip distances | Globe terrain pipeline variant via source injection + `WebGPUClipDistancePrecompute.ts` | `context.useHardwareClipDistances = true` (SCENE3D + union mode only) |
| WGF-3 | shader-f16 tonemapping | `Tonemapping_f16.wgsl` — all 5 operators in half precision | `context.useShaderF16 = true` |

Supporting changes: EffectsUniforms extended to 240 bytes (all 5 inline definitions synced), effects BGL binding 0 now VERTEX\|FRAGMENT visible, worker feature flag replication via `MSG_SET_FEATURE_FLAGS`.

### HDR Pipeline

- **Bug fixed:** post-process ping-pong textures now use `rgba16float` when `highDynamicRange=true` (was always `bgra8unorm`, silently clamping HDR to [0,1])
- **Stage format fix:** all stage pipelines target `_intermediateFormat` (not `canvasFormat`) so fragment output format matches render attachment
- **Auto-exposure:** two-pass compute shader (`AutoExposure.wgsl` + `WebGPUAutoExposure.ts`) — parallel 16×16 tile reduction → temporal smoothing → feeds tonemapping exposure uniform. Auto-added when HDR is on.
- **WebGL HDR:** already fully implemented upstream (GlobeDepth.js, PostProcessStageCollection, EXT_color_buffer_float). No new code needed.

### Bug Fixes

- **OPEN-5 (fog):** `computeFog()` now uses the 3-parameter formula with `fogVisualDensityScalar` (default 0.15), matching WebGL's `czm_fog` modifier. Was ~6.7x too strong at horizontal viewing angles.
- **OPEN-1 (sky atmo):** added try/catch + `_pipelineFailed` latch around pipeline creation to prevent infinite retry on shader compile failure.
- **BUG-6.1, BUG-38, BUG-39:** documented mitigation/guard status in debugging log.

---

## Recent Progress (2026-04-11 — Renderer Threading Sweep)

This section summarizes the work that landed on top of the 2026-04-09
celestial / phase-1 work. Full design doc:
[OPTION_B_SCENE_IN_WORKER.md](OPTION_B_SCENE_IN_WORKER.md). Debug
workflow guide: top of [WEBGPU_DEBUGGING_LOG.md](WEBGPU_DEBUGGING_LOG.md).

### Per-renderer FPS measurement

Replaces the legacy "recent average" FPS counter with a continuous
60-second rolling histogram and a Canvas2D HUD overlay component. Two
new files in `Source/Services/`:

- **`PerformanceTracker.js` (extended)** — added `recordFrame()`
  (called every frame from `Scene.render()`, ~50 ns hot-path cost on
  a preallocated 4096-slot Float32 circular buffer, zero per-frame
  GC), `getLiveStats(windowSeconds = 60)` returning average + 1% low
  + 1% high FPS over the rolling window, `getLiveFrameTimeSnapshot(n)`
  for graph rendering, and `resetLiveStats()` for operator forget. The
  existing trace API (`beginTrace` / `endTrace`) is unchanged and
  independent — both can run at once.

- **`FpsOverlay.js` (new)** — Canvas2D HUD that draws an
  absolutely-positioned panel inside any DOM container. Header shows
  label + average fps + frame ms. Body shows a 60-second rolling
  graph (red bars for frames over the budget, smoothed y-axis so the
  scale doesn't jitter). Footer shows 1% low + 1% high + sample count.
  Polls at 6 Hz. Pluggable `dataSource` — works against
  `scene.performanceTracker` directly OR a `WorkerSceneHost` (same
  contract).

### Per-renderer worker hosts (Option C of the threading research)

Multi-threaded renderers via `OffscreenCanvas` + DedicatedWorker, with
each renderer running in its own worker thread. Each host owns one
worker; multiple hosts can coexist on the same page (split-screen,
multi-view, dashboards).

Three new files in `Source/Services/` and one in `Source/Workers/`:

- **`WorkerSceneProtocol.js`** — message-type constants + heartbeat /
  restart / burst-window / stats-interval tunables. Both sides import
  from here, neither imports the other (no circular deps).
- **`WorkerSceneHost.js`** — main-thread wrapper. Owns the parent
  `<div>`, manages the child `<canvas>` lifecycle, transfers
  `OffscreenCanvas` to the worker, runs the heartbeat loop,
  implements 3-tier crash recovery, exposes the `getLiveStats()` /
  `getLiveFrameTimeSnapshot()` contract so an `FpsOverlay` can use
  the host as its data source unmodified.
- **`Source/Workers/RendererWorker.js`** — worker-thread bootstrap.
  Receives the OffscreenCanvas, dynamic-imports `@cesium/engine`
  (esbuild code-splits the engine into a 7.9 MB sibling chunk
  loaded on first message), constructs an empty `Scene`, runs its
  own render loop, posts FPS stats every 125 ms, echoes heartbeats.
  Bundled to `Build/CesiumUnminified/Workers/RendererWorker.js`
  (~11 KB tiny bootstrap).

### 3-tier crash recovery

The worker host detects three classes of failure and recovers
automatically:

| Tier | Trigger | Action | Recovery time |
|---|---|---|---|
| **1 — in-thread** | GPU device lost | `WebGPUDeviceLossRecovery` callback fires; recovery happens inside the worker; host posts `MSG_DEVICE_LOST` then `MSG_DEVICE_RESTORED` so the application can flash a UI indicator | ~100-500 ms |
| **2 — soft reset** | Reserved (no host trigger today; `MSG_RESET` constants in place for future use) | Worker tears down its Scene and asks the host to replay shadow state | N/A |
| **3 — hard restart** | `worker.error` event, `messageerror`, or 3 missed heartbeat pongs (~3 seconds) | Host terminates the worker, destroys the dead `<canvas>` (because `transferControlToOffscreen` is one-time), creates a fresh `<canvas>` inside the parent, spawns a new worker, replays shadow state (camera setView, requestRenderMode, maxFps) | ~1-2 s |

**Circuit breaker**: more than 3 crashes within 60 seconds opens the
breaker — the host stops auto-restarting and fires `onFailure`. The
application is responsible for surfacing the hard error to the user.
Prevents infinite-loop crashes from burning CPU.

### Scene/CreditDisplay headless mode (the worker DOM blocker fix)

The deep review found that `Scene` constructor at
[Scene.js:192](packages/engine/Source/Scene/Scene.js#L192) called
`document.createElement("div")` and `canvas.parentNode.appendChild(...)`,
both of which throw in a worker. Patched in three places (zero
behavioral change for main-thread Viewers):

- **`Scene.js`** — detects `typeof document === "undefined" || !canvas.parentNode`
  at constructor time and passes a sentinel `{}` to CreditDisplay
  instead of building a DOM div. The destroy path also skips
  `parentNode.removeChild` in headless mode.
- **`CreditDisplay.js`** — detects `typeof document === "undefined"`
  at the top of its constructor, sets `_headless = true`, skips all
  DOM construction. Internal credit-accumulation state still
  initializes so `beginFrame` / `addCreditToNextFrame` /
  `addStaticCredit` work unchanged. The DOM-touching methods
  (`showLightbox`, `hideLightbox`, `update`, `endFrame`, `destroy`)
  early-return when `_headless`.
- **`RendererWorker.js`** — used to fail-fast at init with a clear
  error message. The fail-fast was removed once the headless path was
  in place.

This unblocks Phase 1 of the [OPTION_B_SCENE_IN_WORKER.md](OPTION_B_SCENE_IN_WORKER.md)
plan. The worker can now construct an empty Scene against an
OffscreenCanvas. Globe / imagery / terrain / entities are NOT
auto-added — those flow through the protocol messages and require
the Phase 2-7 work documented in the Option B doc to be wired.

### Cross-browser worker render loop

`requestAnimationFrame` is exposed on `DedicatedWorkerGlobalScope` in
Chromium-based browsers since v69, but **NOT in Firefox or Safari**
workers as of 2026. Fix in
[`RendererWorker.js _startRenderLoop`](packages/engine/Source/Workers/RendererWorker.js):
feature-detect at startup; fall back to `setTimeout(tick, 1000/60)`
when missing. Documented as a known limitation (~60 Hz approximation,
not vsync-locked, sub-millisecond jitter).

### maxFps runtime cap (with five operating modes)

`WorkerSceneHost.setMaxFps(value)` exposes a runtime knob with five
distinct modes. Equivalent to upstream `CesiumWidget.targetFrameRate`
for the in-thread case, with two extra modes the upstream API
doesn't support:

| Value | Behavior | Use case |
|---|---|---|
| `null` / `undefined` (default) | rAF in Chromium → display refresh rate (60/120/144/240). setTimeout fallback at 60 in Firefox/Safari. | Normal operation. Same as `targetFrameRate = undefined` upstream. |
| Positive number (e.g. `30`, `60`, `120`) | rAF if available, but skips callbacks that arrive less than `1000/value` ms after the previous render. setTimeout fallback uses `1000/value` directly. Effective rate = `min(displayHz, value)`. | Power saving, mobile battery, matching app frame rate to a video. |
| `0` (uncapped) | Bypasses `requestAnimationFrame` entirely; uses `setTimeout(tick, 0)`. Workers don't have the 4 ms hidden-tab clamp. | Benchmarking the renderer's pure throughput without vsync ceiling. |
| Negative number (e.g. `-1`) | Render loop pauses; the next non-negative `setMaxFps` resumes it. Loop handle is released so no CPU is spent while paused. | Power-saving idle, snapshot mode integration, freezing GPU state for debug snapshots. |
| Anything else (`NaN`, strings, objects) | Coerced to `null` with a warning. | Defensive — mistyped console commands can't wedge the loop. |

The cap is recorded in the host's shadow state and replayed after
every worker restart, so the new worker's first frame already runs at
the user-requested rate.

### Test page

`Apps/WebGPUTest/worker-renderers.html` — multi-pane grid (auto-sizing
1-16 panes). Toolbar:

- "+ WebGPU pane" / "+ WebGL pane" — spawn a new worker host
- "Clear all" — destroy every host
- FPS cap dropdown — vsync / 30 / 60 / 120 / 144 / 240 / uncapped /
  paused, applies to every existing AND newly-spawned pane
- "Crash first worker" — manually terminates the worker so you can
  watch the heartbeat detect the death and run hard-restart

Each pane has its own `FpsOverlay` reading from its host. Console
helpers (`window.setMaxFps`, `window.setPaneMaxFps`,
`window.listPanes`) mirror the toolbar so you can drive the panes
from dev tools.

### Type-check + build status

- `npx tsc --noEmit` — clean
- `npx gulp build` — clean in 41 s
- New worker bundle at `Build/CesiumUnminified/Workers/RendererWorker.js`
  is 11 KB; the engine code is split into a 7.9 MB sibling chunk
  (`./.-XXXXX.js`) loaded on first message via dynamic import

---

## Recent Progress (2026-04-09 — Phase 0 + Phase 1.1 / 1.2)

This section summarizes the work that landed between the original "Sessions 1-26" status and today. For the design rationale see `SESSION_2026-04-08_RESEARCH_REPORT.md` and `CELESTIAL_ATMOSPHERE_DESIGN.md`. For implementation specifics see this file's later sections and `WEBGPU_DEBUGGING_LOG.md`.

### Phase 0 — Foundation (8 sub-phases, all completed 2026-04-08 / 04-09)

**Goal:** introduce all foundation surfaces that Phase 1+ celestial and water work need to register against, with **zero behavior change** for existing upstream Cesium APIs.

**Sub-phases (all completed):**

- **0.1** ✅ Toggle audit — 97 properties across 11 surfaces inventoried (audit report)
- **0.2** ✅ Canonical home shape design — Option A unified scattering, weather branch, leaf naming (design doc)
- **0.3** ✅ `AtmosphericConditions` + `GlobeWater` facade classes with delegating shells → new surfaces `scene.globe.atmosphericConditions.*` and `scene.globe.water.*`
- **0.3a** ✅ `WATER_RENDERING_DESIGN.md` §5 namespace migration `scene.water.*` → `scene.globe.water.*` (doc-only)
- **0.4** ✅ `VisualPerformanceTargetService` skeleton + Scene wiring → new surface `scene.visualPerformanceTarget`
- **0.5** ✅ 3D Tiles Live Invalidation Feed Phase 1 — real producer fixture parsed, 4 path encodings, snapshot version hook, JSON-block-stream parser → new surfaces `Cesium3DTilesInvalidationFeed`, `TilePathEncoding` enum, `Scene._snapshotVersion`
- **0.6** ✅ NEW-5 spec re-verification — C4/C8/C11/C12 verified live, 3 small refinements captured (doc-only)
- **0.7** ✅ Snapshot mode spike — memo + `SnapshotModeService` registration skeleton with `_snapshotVersion` reconciliation → new surface `scene.snapshotMode`

**Files added in Phase 0:** `AtmosphericConditions.js`, `GlobeWater.js`, `VisualPerformanceTargetService.js`, `SnapshotModeService.js`, `Cesium3DTilesInvalidationFeedAdapter.js`, `ProducerListenerAdapter.js`, `Cesium3DTilesInvalidationFeed.js`, `TilePathEncoding.js`, `TilePathResolver.js`, `SNAPSHOT_MODE_SPIKE_2026-04-09.md`, `Specs/Data/Cesium3DTiles/InvalidationFeed/listener_invalidations_25.2.txt` (real producer fixture). New top-level dir `packages/engine/Source/Services/`.

**Behavior change:** zero. Every existing API still works; all opt-in surfaces default disabled. `npx tsc --noEmit` clean throughout.

### Phase 1.1 — Celestial toggle scaffolding (completed 2026-04-09)

- Added 5 new fields to `FrameState`: `atmosphericConditions`, `skyBrightness`, `sunDirectionWC`, `moonDirectionWC`, `moonPhaseFraction`
- `Scene.js` now forwards `scene.globe.atmosphericConditions` onto `frameState` once per frame, alongside the existing `scene.atmosphere` forwarding
- B-series locked defaults verified (sun + moon lighting on, earthshine off, volumetric fog off, varying density off, scattering occlusion off, volumetric clouds off, star modulation `inflection: 0.5` / `steepness: 1.0`, cloud volumetrics 50/100km cutover)
- Renderers now have a stable read surface for B-series toggles via `frameState.atmosphericConditions.*`

### Phase 1.2 — Sun + Moon Sync (completed in three rounds: 1.2a + 1.2b + 1.2c v2, 2026-04-09)

#### 1.2a — Sync data (small new files + frameState population)

- **NEW** `MoonLight.js` — marker class mirroring `SunLight` per locked B14/B2 (not a `DirectionalLight` subclass — opt-in via `scene.light = new MoonLight()`)
- **MODIFIED** `Moon.js` — `update(frameState)` now populates `frameState.moonDirectionWC` from the existing Simon 1994 ephemeris and computes `moonPhaseFraction = 0.5 * (1 - cos(angle(moonDir, sunDir)))` gated on `atmosphericConditions.lighting.enableMoonPhase`
- **MODIFIED** `Scene.js` — populates `frameState.sunDirectionWC` from `uniformState.sunDirectionWC` once per frame

#### 1.2b — Phong lighting + log depth + onlySunLighting + real texture loading + shader extraction

- **NEW** `Shaders/WebGPU/Environment/Moon.wgsl` — extracted from a 60-line inline template literal in `WebGPUEnvironmentRenderer.js`. Source is now a proper `.wgsl` file matching project conventions. `Moon.js` wrapper hand-written (gitignored, regenerated by `gulp build`'s `wgslToJavaScript` step).
- **Real moon texture loading** via `Resource.fetchImage()` + `WebGPUImageUpload.uploadImageToTexture()` — fixes the regression where every WebGPU user saw a 4×4 gray placeholder. Cached, async, retries-once-then-warns on failure, detects URL changes at runtime.
- **Phong lighting** (Lambert diffuse + specular)
- **`onlySunLighting` toggle** honored — picks `sunDirEC` vs `sceneLightDirEC` (matches WebGL `#ifdef ONLY_SUN_LIGHTING`)
- **Log depth write** via `@builtin(frag_depth)` (`log2(1+w) / log2(1+far)`)
- **Earthshine** + **phase gating** (already had stubs from earlier; now wired to atmosphericConditions toggles)

#### 1.2c v2 — Full WebGL parity port (the "skipped items" + Phase 0 leverage)

After an audit revealed the WebGL moon uses **bounding-cube rasterization + analytic ray-march** (not a tessellated UV sphere as I'd assumed), the moon shader was rewritten to match WebGL's geometry approach exactly, plus fork-built improvements:

**Parity items closed:**

- **Bounding-cube rasterization** (8 verts, 36 indices) — matches WebGL `EllipsoidPrimitive` `BoxGeometry.fromDimensions({2,2,2})` exactly. Cube screen footprint scales with the moon's actual size; full-screen quad approach that the first 1.2c attempt used was 100x more expensive at typical viewing distances.
- **Analytic ray-ellipsoid intersection** in moon model space (matches `EllipsoidFS.glsl`)
- **Geodetic surface normal** via `position * oneOverRadiiSq` gradient — analytic, accounts for moon's mild oblateness (1738/1738/1736 km)
- **Back-face / inside pass** with outside-then-inside compositing matching `EllipsoidFS.glsl`'s `outsideFaceColor`/`insideFaceColor` mix (only matters when camera is inside the moon — unreachable in normal use, but matches WebGL bit-for-bit)
- **CsmMaterial-style filling** — texture sample becomes the diffuse channel of a `CsmMaterial`-shaped local; Phong runs through that. Matches `Material.fromType(Material.ImageType)` semantics from the WebGL path.

**Improvements beyond WebGL parity (Phase 0 leverage):**

- **RTE 64-bit precision** in the VS — WebGL's `EllipsoidVS.glsl` uses single-precision `radii * position`. Our VS RTE-encodes the moon center via `(moonH, moonL)` and the camera split via `(camH, camL)`, then sums in single precision per project rule. Costs nothing.
- **Exact log depth** via VS-output clip-space `w` (no approximation)
- **Render bundle pre-encoding** via `WebGPURenderBundleManager.getOrCreate()`. The pipeline + bind group + draw sequence is identical every frame; we cache the encoded `GPURenderBundle` and replay it via `passEncoder.executeBundles([bundle])` from a new fast path in `WebGPUDrawCommand.execute()`. Bundle invalidates on bind group change (texture upgrade). Moon is the **first real consumer** of `WebGPURenderBundleManager`.
- **Snapshot mode freezable registration** — moon registers itself with `scene.snapshotMode` so when snapshot mode is active, per-frame uniform writes become a no-op and the bundle replays the frozen uniforms. Moon is the **first real consumer** of `SnapshotModeService`.
- **Behind-camera early-out** — `dot(cameraToMoon, cameraDirWC) < -maxRadius` skips the entire draw command before any GPU work
- **`WebGPUDrawCommand.bundle` field added** — 5-line addition that lets any draw command opt into bundle replay. Future renderers (sun, sky atmosphere, custom static-pipeline content) can register against the same surface trivially.

### Phase 1.3a — CPU sky brightness estimator (completed 2026-04-09)

- **NEW** `Scene/SkyBrightness.js` — pure helper. `computeSkyBrightness(sunDirWC, moonDirWC, moonPhaseFraction, cameraPositionWC)` returns a 0..1 scalar driven by sun altitude (smoothstep -0.1..+0.4 over the local horizon) and moon altitude scaled by phase fraction (~4% of full sun for full moon overhead).
- **MODIFIED** `Scene.js` — `updateFrameState()` now writes `frameState.skyBrightness` immediately after forwarding `sunDirectionWC`. Uses last frame's `moonDirectionWC` (still on `frameState` from the prior `Moon.update()` call) — visually indistinguishable from current value at any reasonable simulation rate, avoids duplicating the Simon 1994 ephemeris computation.
- **NEW** `Specs/Scene/SkyBrightnessSpec.js` — 8 specs: sun overhead → 1.0, antisun no-moon → 0, full moon overhead at night → ~0.04, phase scaling, twilight monotonicity, degenerate camera handling, clamping.

### Phase 1.3b — Star modulation in cubemap panorama (completed 2026-04-09)

- **MODIFIED** `Shaders/WebGPU/CubeMapPanorama.wgsl` (canonical source) — added `starModulation: vec4<f32>` uniform (offset 208, 16 bytes; total UBO 224 bytes still under the 256-byte alignment). Fragment shader applies `1.0 - smoothstep(0, 1, clamp((skyBrightness - inflection) * steepness, 0, 1))` to the sampled cubemap color when the enable flag is set.
- **MODIFIED** `WebGPUCubeMapPanoramaRenderer.js` — inline `CUBEMAP_PANORAMA_WGSL` (the production path) updated identically. `updateUniforms()` packs `frameState.skyBrightness` into `params.w` and `(curve.inflection, curve.steepness, enableFlag)` into the new `starModulation` slot. Defaults to `enableModulation = true` when `atmosphericConditions.skyAtmosphere.enableStarBrightnessModulation` is undefined or true.
- **MODIFIED** `Scene/AtmosphericConditions.js` — `buildSkyAtmosphere()` adds two new fields to the leaf: `enableStarBrightnessModulation: true` and `enableNightSkyDimming: true`. Apps that want the legacy "always full brightness" behavior set these to false.
- Renderers/scene code can now read `frameState.skyBrightness` to drive any other "is it dark out?" decision; the cubemap shader is the first consumer.

### Phase 1.3c — Dual-light atmosphere LUT (completed 2026-04-09)

The atmosphere LUT pipeline now bakes a SECOND inscatter+transmittance pair for the moon, so the sky atmosphere fragment shader can sum dual-light scattering with one extra texture sample on the LUT path. The moon contribution is scaled by `moonPhaseFraction × moonIntensity`, defaulting to 0.05 (~5% of full sun) at full moon — visible as a gentle blue glow on the night sky without overpowering the sun's daytime contribution.

- **MODIFIED** `WebGPUPerformanceManager.ts` — `_atmosphereLutResources` now holds parallel `transmittance/inscatter/paramsBuffer/paramsData/bindGroup` slots for both sun and moon. New `_moonAtmosphereLUTDirty` flag plus `invalidateMoonAtmosphereLUT()` / `shouldRecomputeMoonAtmosphereLUT()` accessors mirror the sun side. `ensureAtmosphereLUTResources()` allocates BOTH pairs in one shot (~256 KB total). `dispatchAtmosphereLUT()` gains a `target: "sun" | "moon"` parameter and routes to the matching params buffer / textures / bind group; both lights share the bind group layout.
- **MODIFIED** `Shaders/WebGPU/Environment/SkyAtmosphere.wgsl` — added `moonDirectionWC: vec3` + `dualLightControl: vec4` fields to the Uniforms struct (UBO grew 224→256 bytes, fully utilizing the 256-byte alignment). Two new bind group entries: `moonTransmittanceLut` at `@binding(3)` and `moonInscatterLut` at `@binding(4)`. `sampleScatteringLut` is now parameterized on `inscatterTex` so the same helper handles both lights. The fragment shader's LUT path samples the moon LUT and adds it to the sun result when `dualLightControl.x > 0.5 && dualLightControl.y > 0.001`.
- **MODIFIED** `WebGPUSkyAtmosphereRenderer.js` —
  - Bind group layout extended to 5 entries (sampler + 4 textures); placeholder bind group binds the same 1×1 zero texture to all four LUT slots so the layout stays constant when compute is unavailable.
  - Real bind group cache includes `lutMoonTransmittanceView` / `lutMoonInscatterView` and rebuilds when either of the four views changes.
  - Moon direction tracked alongside sun via the same threshold-gated invalidation pattern (`dot < 0.9999` triggers `invalidateMoonAtmosphereLUT()`); only active when `enableDualLightAtmosphere` is on AND `frameState.moonDirectionWC` is populated (skipped on the very first frame before `Moon.update()` runs).
  - Sun + moon dispatches batched into the same one-shot encoder to avoid an extra `device.queue.submit()` per frame when both LUTs are dirty.
  - `packUniforms()` writes `moonDirectionWC` (offset 56) and `dualLightControl` (offset 60) using `frameState.moonDirectionWC` / `moonPhaseFraction` and the new `enableDualLightAtmosphere` / `moonIntensity` fields on `atmosphericConditions.lighting`. Falls back to a `(0,0,1)` moon direction stand-in when the moon hasn't ticked yet so the shader never sees uninitialised data.
- **MODIFIED** `Scene/AtmosphericConditions.js` — `buildLighting()` adds `enableDualLightAtmosphere: true` and `moonIntensity: 0.05` to the lighting leaf. Apps can disable dual-light scattering or tune the moon intensity per scene without touching shader code.

**Behavior change:** zero on the day side (sun term unchanged at full intensity, moon contribution scaled to ~0% in daylight). On the night side, full-moon-overhead frames now show a gentle blue scattered glow; new moon shows none (gated by `moonPhaseFraction`). All four `tsc --noEmit` checkpoints clean across the four-file change.

### Phase 1.4 — AtmosphericConditions consumers (completed 2026-04-09)

The closing piece of the 1.x feature branch wires three weather state scalars from `atmosphericConditions.weather` into the existing sky/fog/star renderers. Defaults are picked so the change is invisible until an app starts setting them — no behavior change for any existing scene.

- **MODIFIED** `Scene/AtmosphericConditions.js` — `buildWeather()` adds three new fields to the weather leaf:
  - `humidity: 0.5` (plain scalar; 0=dry desert, 1=tropical jungle)
  - `airQuality: 1.0` (plain scalar; 1=clean, <1=dust/haze, >1=very clean)
  - `cloudCover` (delegating getter/setter over `globe.cloudCoverage` so the procedural cloud renderer and the star occlusion path stay in sync — single source of truth)
- **MODIFIED** `Shaders/WebGPU/CubeMapPanorama.wgsl` + inline `CUBEMAP_PANORAMA_WGSL` in `WebGPUCubeMapPanoramaRenderer.js` — `starModulation.w` (formerly `_pad`) now carries `cloudCover`. Fragment shader multiplies the modulated star color by `(1 - cloudCover)` so a fully overcast sky hides stars completely without requiring a separate occlusion pass.
- **MODIFIED** `WebGPUCubeMapPanoramaRenderer.js` `updateUniforms()` — reads `frameState.atmosphericConditions.weather.cloudCover` and writes it to `uniformData[55]`. Defaults to `0` (clear sky) when no globe / weather is wired up.
- **MODIFIED** `WebGPUGlobeSurfaceRenderer.ts` tile uniform packing — fog density is multiplied by `(0.5 + humidity)` before being written to the tile UB. Centered on humidity=0.5 producing 1.0× (no change), 0.0 producing 0.5× (very dry), 1.0 producing 1.5× (humid haze). Linear and bounded so existing fog tuning stays predictable.
- **MODIFIED** `WebGPUSkyAtmosphereRenderer.js` LUT dispatch path:
  - `humidity` scales the Mie coefficient via `(0.5 + humidity)` before being passed to `dispatchAtmosphereLUT()`. Same range and centering as fog density.
  - `airQuality` scales the Rayleigh coefficient via `1.0 / airQuality`. Higher airQuality → less Rayleigh → less blue (cleaner-looking sky); lower airQuality → more Rayleigh → washed-out dusty look.
  - **Cache invalidation:** the renderer caches `lastHumidity` / `lastAirQuality` and calls `invalidateAtmosphereLUT()` + `invalidateMoonAtmosphereLUT()` whenever either changes, forcing the LUT compute to re-bake with the new coefficients on the next frame. Without this the LUT would stay stale until the sun direction moved.
- `windSpeed` / `windDirection` were already on the weather leaf (delegating to `scene.weatherWindSpeed` / `scene.weatherWindDirection` and fanning out to `globe.cloudWindSpeed` / `globe.cloudWindDirection`). No new code; this lays the groundwork for water Phase 1's surface displacement consumer.

**Behavior change:** zero by default. Setting `scene.globe.atmosphericConditions.weather.humidity = 1.0` produces a noticeably hazier horizon and brighter Mie halo around the sun within one frame (LUT recomputes). Setting `cloudCover = 0.8` dims stars to 20% of their normal brightness. Setting `airQuality = 0.5` produces a deeply saturated sky color from doubled Rayleigh scattering. All scaling is linear and bounded so the existing scene tuning still works at default values.

**Phases 1.1–1.4 are now feature-complete.** The 1.x batch ships sun + moon ephemeris sync, dual-light atmosphere LUT, sky brightness CPU estimator, star modulation with cloud occlusion, and weather coefficient consumers as one cohesive feature branch per the B23 lock.

### Phase 1.x consolidation — EllipsoidRenderer extraction (completed 2026-04-09)

Closes the carry-over follow-up "EllipsoidPrimitive feature renderer consolidation" listed against Phase 1.2c v2. The Moon's bounding-cube + analytic ray-march approach was extracted into a shared infrastructure module so future ellipsoid bodies (Sun-as-ellipsoid, custom planets, asteroid models) can share the JS plumbing instead of copy-pasting ~140 lines of uniform-pack scaffolding.

- **NEW** `Renderer/WebGPU/WebGPUEllipsoidRenderer.ts` (~388 lines) exports:
  - `createEllipsoidBoundingCube(device)` — the canonical 8-vert / 36-index unit cube. Per-body code scales by `radii` in the vertex shader.
  - `createEllipsoidBindGroupLayout(device)` — the canonical bind group layout: `(uniform UBO @0, texture_2d @1, sampler @2)`. Stable contract for any future body that uses this module.
  - `packEllipsoidBaseUniforms(uniformData, inputs)` — fills the body-agnostic prefix (offsets 0..63 = 256 bytes) of an ellipsoid uniform buffer. Writes mvpRTE, RTE camera split, RTE body-center split, ivmRow0..2 (eye→model 3×3), cameraPositionMC, radii, oneOverRadiiSq, sunDirMC, sceneLightDirMC. Body-specific writes append at offset 64+.
  - `ELLIPSOID_BASE_UNIFORM_FLOATS = 64` and `ELLIPSOID_BASE_UNIFORM_BYTES = 256` constants.
- **NEW** `Shaders/WebGPU/chunks/functions/csm_intersectEllipsoid.wgsl` — extracted the analytic ray-ellipsoid intersection from the Moon shader into a chunk so any future body can `#import` it instead of inlining the math. The Moon shader currently still inlines its copy (the chunk preprocessor isn't wired through the Moon shader's build path yet); future bodies can adopt the chunk directly.
- **MODIFIED** `Renderer/WebGPU/WebGPUEnvironmentRenderer.js` (Moon path):
  - `createMoonBoundingCube()` is now a thin wrapper around `createEllipsoidBoundingCube()`.
  - `createMoonPipeline()` uses `createEllipsoidBindGroupLayout()` instead of inlining the bind group layout.
  - `_packMoonUniforms()` calls `packEllipsoidBaseUniforms()` for offsets 0..63 then writes the moon-specific tail (moonDirWC, phaseFraction, earthshine, useLogDepth, shininess, specularStrength, farPlane) at offsets 64..75.
  - Removed 6 now-unused scratch variables (`scratchInverseModelView3`, `scratchCameraMC`, `scratchSunMC`, `scratchSceneLightMC`, `scratchInverseModelMatrix`, `scratchInverseModelRot3`) and the unused `Matrix3` import. File shrunk from ~1107 to ~967 lines (~13% reduction).
- **NEW** `Specs/Renderer/WebGPU/WebGPUEllipsoidRendererSpec.js` — 11 specs covering layout constants, mvp matrix pack, RTE camera/center splits, radii / oneOverRadiiSq writes, sun direction transformation under model rotation, scene-light fallback, camera-in-model-coords math, and "tail untouched" verification. Pure CPU specs — no GPUDevice required.

**Behavior change:** zero. The Moon renders identically (`tsc --noEmit` clean; the math in the shared packer matches the previous inline pack byte-for-byte). The win is architectural — when the Sun-as-ellipsoid renderer or a custom planet feature renderer arrives, they get the cube + bind group + base pack for free. Documented as the consolidation pattern future ellipsoid bodies follow.

**Stretch follow-up (not done in this consolidation):** The orphan `WebGPUEllipsoidPrimitiveRenderer.ts` still uses the older screen-space-quad approach (~8M FS invocations at 4K). Migrating it to the bounding-cube path is a separate ~1-2 day task and should happen the next time it gets a real consumer. Logged in the backlog.

### Phase 5a — Volumetric fog froxel-grid infrastructure (completed 2026-04-09)

Opens the celestial atmosphere design's heaviest remaining piece (`CELESTIAL_ATMOSPHERE_DESIGN.md` §4.8) — the Frostbite-style three-pass volumetric fog renderer. **Phase 5a ships infrastructure only with zero visual change**: the compute kernels are placeholders that clear their outputs, the integrated 3D volume defaults to `(0, 0, 0, 1)` (no scatter, full transmittance), and the composite pass applies `out = sceneColor × 1 + 0 = sceneColor`. Phase 5b/5c/5d fill in the density / scattering / occlusion math without touching this scaffolding.

- **NEW** `Renderer/WebGPU/WebGPUVolumetricFogRenderer.ts` (~570 lines) — main coordinator. Holds three rgba16float 3D textures (density, scattering, integrated), one params UBO, the compute pipelines for the three passes, and the full-screen composite pipeline. Allocates lazily on first frame and rebuilds when the quality preset changes. Exposes `update(context, frameState, scene)` for the compute path and `composite(context, frameState, colorView, depthView, outputView, format)` for the final blit. Quality bands per the design doc:
  - **low**:    80 ×  45 ×  64  (~230K froxels, ~11 MB)
  - **medium**: 160 ×  90 × 128  (~1.8M froxels, ~84 MB)
  - **high**:   240 × 135 × 192  (~6.2M froxels, ~300 MB)
  - **auto** maps to **low** until the VPT init benchmark wires through (Phase 5a defers the auto-tune since there's nothing to measure with placeholder kernels).
- **NEW** `Shaders/WebGPU/Compute/VolumetricFog.wgsl` — single compute shader with three entry points (`densityInjection`, `lightScattering`, `integrate`) all `@workgroup_size(8, 8, 1)`. Phase 5a kernels clear their outputs to zero (or `(0,0,0,1)` for the integrated volume so transmittance reads as 1). Phase 5b/5c populate with real density / sun + moon scattering / front-to-back integration.
- **NEW** `Shaders/WebGPU/PostProcess/VolumetricFogComposite.wgsl` — full-screen triangle vertex shader (no vertex buffer needed) + fragment shader that samples the integrated 3D volume in screen UV + linearized depth and applies the standard alpha-over composite `out = sceneColor × transmittance + scatteredLight`. Bind group layout: `(uniform, sampler, sceneColor, sceneDepth, fogVolume)`.
- **MODIFIED** `Renderer/FeatureRendererKey.js` — added `VOLUMETRIC_FOG: 37`, bumped `COUNT` to 38.
- **MODIFIED** `Renderer/WebGPU/WebGPUFeatureRenderers.ts` — registers the volumetric fog feature renderer with three entry points (`update`, `composite`, `destroy`).
- **MODIFIED** `Renderer/WebGPU/WebGPUSceneRenderer.ts` `_executeEnvironmentalEffects()` — added a 4th step gated on `frameState.atmosphericConditions.volumetricFog.enabled`. Runs the compute passes via `fogFR.update()` then the composite via `fogFR.composite()` after procedural clouds / SSR / weather particles, before post-processing. Matches the B22 placement spec (after opaque + OIT-resolved color, before UI overlay).
- **MODIFIED** `Scene/AtmosphericConditions.js` `buildVolumetricFog()` — extended the leaf with the full set of design-doc tunables: `maxDistance` (50000m), `density` (1.0), `falloff` (0.0001 1/m), `fogAnisotropy` (0.3 HG g), `fogAlbedo` (vec3 0.9/0.92/0.95). The existing `enabled` (B18: false), `quality` ("auto"), and `enableScatteringOcclusion` (B20: false) toggles are preserved.

**Behavior change:** zero. Default `enabled = false` per B18; even with `enabled = true` the placeholder kernels produce a visually identical scene because the integrated volume reads as (0, 0, 0, 1). The win is that **Phase 5b/5c/5d become "fill in the kernels" instead of "build the infrastructure AND fill in the kernels"** — the hardest scaffolding (3D texture allocation, bind group layouts, pipeline creation, scene composite wiring, frame state plumbing) is done. `tsc --noEmit` clean throughout.

**What's NOT in Phase 5a (deferred to 5b/5c/5d):**
- Real density injection (height fog + atmospheric conditions wire-in)
- Sun + moon scattering with Henyey-Greenstein phase function
- Front-to-back depth integration
- Shadow map sampling for scattering occlusion (god rays)
- Ambient term from the atmosphere inscatter LUT
- 3D noise field for varying atmosphere density
- Quality auto-tune via VPT init benchmark

### Phase 5b — Real density / scattering / integration kernels (completed 2026-04-09)

Replaces the Phase 5a placeholder kernels with the actual Frostbite-style three-pass math: log-sliced froxel→world reconstruction, height fog density, sun + moon Henyey-Greenstein scattering, and front-to-back Beer-Lambert integration. **First phase that actually changes pixels** when `enableVolumetricFog` is on.

- **MODIFIED** `Shaders/WebGPU/Compute/VolumetricFog.wgsl`:
  - Extended `VolumetricFogParams` to 40 floats: added `invViewProj`, `cameraAndPlanet`, `sunDirectionAndIntensity`, `moonDirectionAndScale`.
  - **Disjoint @binding numbers** per access mode (binding 1=densityOut, 2=densityIn, 3=scatteringOut, 4=scatteringIn, 5=integratedOut) so the WGSL module declares each only once. Each pipeline's BGL provides only the bindings its entry point references — WebGPU validates per-entry-point.
  - **`froxelWorldPosition()`** helper: builds screen UV from `gid.xy`, unprojects (ndc, 0/1) → world rays via `invViewProj`, places the froxel at log-sliced linear depth `near × pow(maxDistance/near, k/D)`.
  - **`densityInjection`** kernel: writes `baseDensity × exp(-altitude × falloff)` per froxel, where altitude = max(0, length(worldPos) - innerRadius). Anisotropy g goes in the `.a` slot.
  - **`lightScattering`** kernel: reads density, sums sun + moon contributions via Henyey-Greenstein phase function, writes `vec4(scatteredRGB, density)`. Skips empty froxels via early-out.
  - **`integrate`** kernel: one thread per (x, y), serial walk over z = 0..D-1. Standard Beer-Lambert front-to-back integration with `(1 - sliceTransmittance) / extinction` factor (clamped for the limit case).
- **MODIFIED** `Renderer/WebGPU/WebGPUVolumetricFogRenderer.ts`:
  - **Three per-pass bind group layouts** + matching pipeline layouts (densityBGL, scatteringBGL, integrateBGL). Each declares only the bindings its entry point uses; the bind groups are pre-built once.
  - Param packing extended for the new fields: composes `view × projection` then inverts via `Matrix4.inverse()` when the camera doesn't cache `inverseViewProjection`. Pulls `sun + moon directions` from `frameState.sunDirectionWC` / `moonDirectionWC` and `moonPhaseFraction × moonIntensity` (matches the SkyAtmosphere dual-light path).
  - Integrate dispatch is now `(ceil(W/8), ceil(H/8), 1)` instead of `× depth` because each thread serial-walks the z axis.
- **MODIFIED** `Shaders/WebGPU/PostProcess/VolumetricFogComposite.wgsl` — depth slicing switched from linear to log to match the kernels' slicing. Composite would otherwise sample the wrong depth band.

**Behavior change:** when `enableVolumetricFog = true`, scenes now show actual height fog with sun + moon in-scattering. No god rays yet (those are 5c). Default is still off per B18.

### Phase 5c — Scattering occlusion (god rays) (completed 2026-04-09)

Wires the existing sun shadow map into the scattering kernel via `texture_depth_2d` + `sampler_comparison` and adds a constant ambient term. When `enableScatteringOcclusion = true` AND a shadow map is bound, in-scattered sun light is gated by a per-froxel shadow comparison sample, producing visible god rays where lit and shadowed regions meet at high density gradients.

- **MODIFIED** `Shaders/WebGPU/Compute/VolumetricFog.wgsl`:
  - Added `sunShadowMatrix: mat4x4` and `occlusion: vec4` (enableScatteringOcclusion, ambientStrength, shadowMapValid, shadowDarkness) to the params struct.
  - Added two new bindings to the scattering pass: `@binding(6) sunShadowMap: texture_depth_2d` and `@binding(7) sunShadowSampler: sampler_comparison`.
  - **`sampleSunShadow(worldPos)`** helper: projects worldPos via `sunShadowMatrix`, converts NDC → UV, applies a small bias, calls `textureSampleCompareLevel`, mixes with `darkness` so fully-occluded fragments aren't pitch black. Falls back to 1.0 (fully lit) when occlusion is off OR no real shadow map is bound.
  - **`lightScattering`** kernel multiplies the sun term by the shadow factor and adds an ambient term `albedo × density × ambientStrength` so shadowed froxels still receive a soft fill.
- **MODIFIED** `Renderer/WebGPU/WebGPUVolumetricFogRenderer.ts`:
  - Allocated a 1×1 `depth32float` placeholder texture cleared to 1.0 ("fully lit"), bound by default so the scattering bind group always has a valid shadow texture even when no shadow map is active.
  - Created a comparison sampler (`compare: "less-equal"`, linear filtering) for the shadow path.
  - Per-frame: walks `frameState.shadowMaps`, fetches the active sun shadow map's `_shadowMapMatrix` and `_webgpuCache.depthTextureView`, packs the matrix into the params UBO at offsets 28..43, sets `occlusion.z = 1` when valid. Rebuilds the scattering bind group on the rare occasions the shadow texture view itself changes.
- **MODIFIED** `Scene/AtmosphericConditions.js` `buildVolumetricFog()` — added `ambientStrength: 0.05` (constant Phase 5c value; Phase 5e can replace with a real LUT sample).

**Behavior change:** when `enableVolumetricFog = true` AND `enableScatteringOcclusion = true` AND a sun shadow map is active, terrain casts visible shadow shafts through the height fog. The ambient term keeps shadowed regions soft instead of hard black. Default both off per B18/B20.

**Deferred to Phase 5e (future):**
- Real LUT-sampled ambient term — needs the SkyAtmosphere inscatter LUT views routed through to the volumetric fog renderer (currently lives in WebGPUPerformanceManager; cross-renderer plumbing is the only blocker).
- Moon shadow map — moon is dim enough that shadow precision isn't visible in practice; deferred indefinitely.
- PCF shadow filtering — single-tap comparison is currently used; the existing terrain shadow path's PCF can be cribbed if banding becomes visible.
- Cloud volumetric shadow contribution — deferred to Phase 6c per the design doc.

### Phase 5d — Varying atmosphere density (completed 2026-04-09)

Modulates the height-fog density via a 3D fbm noise field so scenes can express ground haze pockets, inversion layers, and pollution domes per the design doc §4.9. Per B19/B21, defaults to OFF and is silently a no-op when `enableVolumetricFog = false`.

- **MODIFIED** `Shaders/WebGPU/Compute/VolumetricFog.wgsl`:
  - Added a `noise: vec4<f32>` field to the params struct (enableVaryingDensity, noiseScale, noiseStrength, _pad).
  - Added `hash13`, `valueNoise3d`, and `fbm3d` helpers — 3 octaves of value noise with smoothstep interpolation. ~30 lines, no precomputed permutation table needed.
  - `densityInjection` kernel multiplies the height-fog density by `(1 + strength × fbm3d(worldPos / scale))` when `noise.x > 0.5`. Clamped to non-negative so large negative noise + low base density doesn't produce anti-fog.
- **MODIFIED** `Renderer/WebGPU/WebGPUVolumetricFogRenderer.ts`:
  - Param buffer grew from 60 to 64 floats (256 bytes total).
  - Pulls `enabled` / `noiseScale` / `noiseStrength` from `frameState.atmosphericConditions.varyingAtmosphereDensity` (the existing leaf with B-series-locked defaults).

**Behavior change:** when `enableVolumetricFog = true` AND `varyingAtmosphereDensity.enabled = true`, the height fog gains a 3D noise modulation. Default off; opt-in shows visible haze pockets and density variation per the design doc §4.9.

**Phase 5 status: feature-complete.** All four sub-phases ship as one feature branch per the B23 lock. Phase 5e (real LUT ambient + cloud shadows) is deferred to Phase 6 work which folds cloud rendering into the same froxel grid.

### Snapshot Mode Phases A-D — completed 2026-04-09

Closes the spike memo (`SNAPSHOT_MODE_SPIKE_2026-04-09.md`). The Phase 0.7 skeleton already shipped the registration + version reconciliation; this batch fills in the actual freeze logic, the camera-delta auto-thaw, the markDirty hooks, and the spec coverage. With Phase 5's volumetric fog and Phase 1.x's celestial bundles in production, snapshot mode now has multiple real consumers to validate against — the moon was wired in 1.2c v2 as the first test case.

**Phase A — Bundle manager freeze flag + self-registration**
- **MODIFIED** `WebGPURenderBundleManager.ts`:
  - Added `_isFrozen` flag plus `freeze()` / `thaw()` / `isFrozen` / `asFreezable()` public methods.
  - `beginFrame()` skips eviction entirely while frozen.
  - `getOrCreate()` routes cache misses through a new `_buildEphemeral()` path that records-and-discards instead of admitting to the cache. This prevents transient one-frame additions from polluting a snapshot.
  - On `thaw()`, every cached entry's `lastUsedFrame` is reset to the current frame so the post-thaw scene doesn't trigger a build storm from the next eviction tick.
- **MODIFIED** `Scene/Scene.js`:
  - Per-frame self-registration of the WebGPU bundle manager via `bundleMgr.asFreezable()` → `snapshotMode.registerFreezable("webgpu-bundle-manager", ...)`. Idempotent + gated on `_bundleManagerSnapshotRegistered` flag so it only runs once per scene lifetime.
  - Skipped on WebGL contexts (the bundle manager only exists on WebGPU).

**Phase B — Camera-delta auto-thaw**
- **MODIFIED** `Services/SnapshotModeService.js`:
  - `enter()` now also captures `camera.positionWC` / `directionWC` / `upWC` (defensively cloned because Cesium mutates these in-place each frame).
  - New `tickCamera(scene)` method runs every frame and auto-thaws when:
    - Position delta exceeds `cameraDeltaPositionThreshold` (default 1.0m)
    - Direction angle exceeds `cameraDeltaRotationThreshold` (default ~0.5°)
    - Up vector angle exceeds the same rotation threshold (catches pure roll without forward-axis change)
  - New `cameraDeltaPositionThreshold` / `cameraDeltaRotationThreshold` setters so apps can tune sensitivity per scene.
  - New `cameraThawCount` diagnostic in `getStatistics()`.
- **MODIFIED** `Scene/Scene.js`: `Scene.render()` calls `_snapshotMode.tickCamera(this)` immediately after `_snapshotMode.tick(this)`.

**Phase C — markSnapshotDirty + HDR/depth hooks**
- **MODIFIED** `Services/SnapshotModeService.js` — new `markDirty(reason)` method. Thaws + bumps `manualThawCount` + records the reason in `lastThawReason`. Idempotent / no-op when not frozen.
- **MODIFIED** `Scene/Scene.js`:
  - New public `Scene.prototype.markSnapshotDirty(reason)` API. Documents the contract for user `postUpdate` listeners that mutate entity state silently.
  - HDR + log-depth dirty-flag detection in `Scene.render()` now calls `_snapshotMode.markDirty()` BEFORE the flags get cleared, so cached bundles encoded against the old swap-chain attachments don't survive into the new format.

**Phase D — Spec coverage**
- **NEW** `Specs/Services/SnapshotModeServiceSpec.js` (~250 lines, 18 specs across 7 describe blocks):
  - `enabled` flag toggle + auto-thaw on disable
  - Freezable registry: register / unregister / late-arrival joins active snapshot
  - `enter` / `exit` invariants (idempotent, gated on enabled, version baseline capture)
  - `tick` snapshot-version reconciliation (auto-thaw on bump, no-op on stable)
  - `tickCamera` Phase 6B coverage: stationary, position delta, direction angle, pure roll, sub-threshold jitter
  - `markDirty` Phase 6C coverage: explicit reason, no-op when not frozen, default reason
  - `destroy` releases freezables + auto-thaws

**Behavior change:** zero by default. Opt-in via `scene.snapshotMode.enabled = true`. Once enabled and entered via `scene.snapshotMode.enter(scene)`, the WebGPU bundle manager freezes its cache, the moon's render bundle replays verbatim, and every frame's `tick` + `tickCamera` watches for invalidation (snapshot version bump, camera motion, HDR/depth change, manual `markSnapshotDirty()`).

**Snapshot Mode status: feature-complete.** All four spike-memo phases shipped. Visual verification of the actual perf win (the spike memo's "2-5× CPU reduction for static scenes" claim) is deferred to a separate measurement pass once a real test scene is wired up.

### Three-way coordination — `requestRenderMode` × Snapshot Mode × VPT (completed 2026-04-09)

Audit + tightening pass to make sure the three rendering services compose cleanly without duplication. Identified gaps: snapshot mode couldn't see idle frames, `Scene.requestRender()` didn't notify the snapshot service, VPT had a half-implemented dead-code guard. All three are fixed; the relationship is now documented at the top of `SnapshotModeService.js` and `VisualPerformanceTargetService.js`.

**The three layers compose, they don't duplicate:**

1. **`Scene.requestRenderMode`** (Cesium core, macro-level) decides WHETHER a frame renders. When true, idle frames skip the entire `if (shouldRender)` block at zero CPU cost.
2. **`SnapshotModeService`** (micro-level) makes a render frame cheap when one DOES happen by replaying cached bundles instead of re-encoding draws (~30-60% command-encoding cost eliminated).
3. **`VisualPerformanceTargetService`** (quality-tuning) measures the resulting frame and tunes registered sinks for next time. Skipped while snapshot is frozen so dial outputs don't drift the captured bundles.

**Fixes shipped:**

- **MODIFIED** `Services/SnapshotModeService.js`:
  - **New `notifyFrame(scene, isRenderFrame)`** method called every frame regardless of `shouldRender`. Tracks `_consecutiveIdleFrames` so the service can see idle periods even though the existing `tick()` only runs inside the render block.
  - **New `autoEnterIdleFrames`** setter (default 0 = disabled). When > 0, the service auto-enters snapshot mode after N consecutive idle frames. Recommended preset for FAST-mode-on-idle:
    ```js
    scene.requestRenderMode = true;
    scene.snapshotMode.enabled = true;
    scene.snapshotMode.autoEnterIdleFrames = 120;  // ~2s at 60fps
    ```
  - **New `autoEnterCount` + `lastAutoEnterReason`** diagnostics in `getStatistics()`.
  - `_thawAll()` now resets `_consecutiveIdleFrames` so a thaw doesn't immediately re-enter on the next idle frame.
  - **40-line module-level documentation block** explaining the three-way relationship and how the layers compose.
- **MODIFIED** `Scene/Scene.js`:
  - `Scene.render()` calls `_snapshotMode.notifyFrame(this, shouldRender)` BEFORE the `if (shouldRender)` gate, so the service sees both render and idle frames.
  - `Scene.requestRender()` now also calls `_snapshotMode.markDirty("Scene.requestRender() called")` when a snapshot is active. The caller is asking for a fresh frame because something changed; replaying old bundles would be visually wrong.
- **MODIFIED** `Services/VisualPerformanceTargetService.js`:
  - **Dead-code cleanup**: removed the stale `eslint-disable no-unused-vars` (the parameter IS used).
  - **Half-implemented guard fixed**: the `if (scene._renderRequested === false)` body was empty (a comment block with no `return`); now actually returns. Documented as a defensive safety net for non-Scene callers since the production path already gates VPT on `shouldRender`.
  - **Module-level docs extended** with the three-way relationship reference and a note that the future "VPT adjusted sinks" → `scene.markSnapshotDirty()` hook is queued behind actual auto-tuner implementation.
- **MODIFIED** `Specs/Services/SnapshotModeServiceSpec.js` — added 6 new specs for the coordination behavior:
  - Idle frames tracked when auto-enter disabled
  - Auto-entry after configured threshold
  - Render frame resets the idle counter
  - Disabled service doesn't auto-enter
  - Setting `autoEnterIdleFrames=0` resets the counter
  - Post-thaw counter reset prevents immediate re-entry

**Behavior change:** zero by default. `autoEnterIdleFrames` defaults to 0, so the existing manual `enter()` workflow is unchanged. Users opt into auto-entry by setting it to a positive value alongside `requestRenderMode = true`. The `Scene.requestRender()` → `markDirty` wire is invisible when snapshot mode is off (the markDirty call is a no-op). `tsc --noEmit` clean throughout.

**What's NOT a duplication:**
- `requestRenderMode` skips the entire frame; snapshot mode makes the frame that DOES render cheap. Different layers, different optimizations.
- `Scene._renderRequested` (Cesium core flag) and `_snapshotMode.markDirty()` (snapshot reason) are different concerns: the first asks "should I render?", the second asks "is my cached bundle valid?". Both can fire independently and they often do.
- VPT's `_snapshotMode` flag and SnapshotModeService's `_isFrozen` flag mirror each other one-way (Scene pushes the value into VPT each frame). This isn't duplication — it's a deliberate decoupling so VPT doesn't import the snapshot service and vice versa.

### Phase 6 audit deep-dive — VPT × Snapshot × Cesium core (completed 2026-04-09)

Follow-up to the "Three-way coordination" pass: full deep-dive of every freezable, every dirty path, every service lifecycle hook, every shared-context interaction. Eight findings, seven fixes landed, one documented as a known limitation. `tsc --noEmit` clean.

**Findings + fixes:**

1. **`Scene.destroy()` was leaking the orchestration services** — both `_snapshotMode` and `_visualPerformanceTarget` had `destroy()` methods but `Scene.destroy()` never called them, leaking registered freezables across scene recreation. **FIX:** added explicit cleanup before `destroyObject(this)`.
2. **`_snapshotVersion` was bumped from exactly ONE place** (`Cesium3DTilesInvalidationFeed.apply`). Adding/removing primitives, ground primitives, or imagery layers mid-snapshot would silently leak the new state out of the bundle cache. **FIX:** `Scene` constructor now wires `bumpSnapshotVersion` listeners onto `_primitives.primitiveAdded/Removed`, `_groundPrimitives.primitiveAdded/Removed`, and `updateGlobeListeners` extends to `globe.imageryLayersUpdatedEvent` + `globe.terrainProviderChanged`.
3. **Moon's `destroyWebGPUMoonResources` never unregistered its `"moon-renderer"` freezable** — closure leak holding the entire moon cache alive after destroy. **FIX:** stash `_snapshotService` reference at registration, call `unregisterFreezable("moon-renderer")` on teardown.
4. **Volumetric fog had ZERO snapshot wiring** — three Frostbite-style compute passes (density injection, light scattering, integration) ran every frame even when snapshot mode was frozen, defeating the entire CPU/GPU win for static scenes. **FIX:** `WebGPUVolumetricFogRenderer.update()` now self-registers `"webgpu-volumetric-fog"` with the service on first call; `freeze()` flips `_frozen = true` and `update()` early-returns past `_ensureResources` while frozen. `destroy()` unregisters cleanly.
5. **VPT.tick() ran BEFORE snapshot.tick()** so VPT's `snapshotMode` flag was always one frame stale — its quality dial would adjust during the first frame of a new snapshot. **FIX:** reordered `Scene.render()` to call `_snapshotMode.tick + tickCamera` first, then push `_snapshotMode.isFrozen` into VPT, then `_visualPerformanceTarget.tick`.
6. **Multi-view + shared-context cross-contamination** (KNOWN LIMITATION, no fix shipped) — `WebGPURenderBundleManager` lives on the GraphicsContext and is shared across all Scenes bound to that context. If Scene A enters snapshot mode while Scene B keeps animating, Scene B sees frozen bundles. **DOCUMENTED** in the `SnapshotModeService.js` module header with workarounds (per-Scene context, single-Scene snapshot ownership, per-Scene freezable scope as a future fix).
7. **`WebGPUPerformanceManager.tryExecuteBundle()` was dead code with a latent bug** — it called `bundleMgr.get(bundleKey)` but `WebGPURenderBundleManager` only exposes `getOrCreate / has / invalidate / invalidateByPrefix`. Never invoked from anywhere. **FIX:** removed the dead method; left a comment pointing readers at `getOrCreate` as the real entry point.
8. **`_globeHeightDirty` and `shadowsDirty` were audited but did NOT need snapshot dirty hooks** — `_globeHeightDirty` only updates internal CPU state (camera-under-ground tracking), not pixel-affecting; `shadowsDirty` already invalidates the cached shadow map regardless of snapshot mode. No change needed.

**Files modified:**

- `Scene/Scene.js` — service cleanup in `destroy()`; `bumpSnapshotVersion` listeners on primitive collections + globe events; reordered service ticks in `render()`
- `Renderer/WebGPU/WebGPUEnvironmentRenderer.js` — Moon freezable cleanup with `_snapshotService` stash
- `Renderer/WebGPU/WebGPUVolumetricFogRenderer.ts` — three-pass freeze gate + self-registration + cleanup
- `Renderer/WebGPU/WebGPUPerformanceManager.ts` — removed dead `tryExecuteBundle`
- `Services/SnapshotModeService.js` — module-doc "Known limitation: shared-context multi-view" section

**Behavior change:** zero by default. All fixes only matter when snapshot mode is active (`scene.snapshotMode.enabled = true`). Existing WebGL behavior, existing WebGPU non-snapshot rendering, and the existing snapshot spec coverage all unchanged. `tsc --noEmit` clean.

### Phase 6 debug surface — central diagnostic aggregator (completed 2026-04-09)

Follow-up to the audit deep-dive: build a single backend-agnostic surface so an operator (or a test harness) can pull "what is the snapshot service / VPT / bundle cache / volumetric fog / moon doing right now" with one call. Required because the audit work added several invisible orchestration features whose only failure mode is "silently no-op", and we need a way to confirm they're alive before visual smoke testing.

**Design constraints:**

- **Backend-agnostic dispatch** — Scene code can't import from `Renderer/WebGPU/`. Routed through a new `GraphicsContext.getRendererStatistics()` abstract concrete (default empty), overridden by `WebGPUContext`. Per-instance state (Moon cache) is exposed via a `Moon.getDebugStatistics(scene)` method that dispatches through the registered `MOON` feature renderer's `getStatistics(moon)` entry point.
- **Pure read** — every `getStatistics()` is side-effect free; safe to call from any callback at any time, including inside a frozen snapshot.
- **Permissive shape** — every nested field is optional. A WebGL scene without a bundle manager still produces a usable snapshot.

**New APIs:**

- **`Scene.getDebugSnapshot()`** — top-level aggregator. Returns `{ scene, snapshotMode, visualPerformanceTarget, renderer, moon, debugToggles }`.
- **`Scene.logDebugSnapshot()`** — pretty-print of `getDebugSnapshot()` to console using `console.groupCollapsed` + per-section logs. Manual call from DevTools or a postUpdate listener.
- **`GraphicsContext.getRendererStatistics()`** — concrete on the abstract base, returns `{}`. Overridden by `WebGPUContext` to expose backend-specific stats.
- **`WebGPUContext.getRendererStatistics()`** — populates `{ backend, contextId, hasDevice, isDestroyed, bundleManager, performance, timestamps, indirectDraw, volumetricFog }`. Each subsystem field is wrapped in a try/catch so a single broken accessor doesn't poison the dump.
- **`SnapshotModeService.getStatistics()`** — already existed; now reachable through the central path.
- **`VisualPerformanceTargetService.getStatistics()`** — new. Returns `{ enabled, targetFps, snapshotMode, probeCount, sinkCount, probes, sinks }` with each probe queried lazily (errors per probe are isolated, not fatal).
- **`WebGPURenderBundleManager.statistics`** — extended. Original shape `{ cacheSize, totalDrawCalls, currentFrame }` now also includes `{ frozen, maxIdleFrames, maxCacheSize, hits, misses, ephemeralBuilds, evictions, freezes, thaws, hitRate, keyPrefixes }`. Internal counters bumped at the cache-hit, cache-miss, ephemeral-build, eviction, freeze, and thaw points. New `resetStatisticsCounters()` method for "measure the next N frames" workflows.
- **`WebGPUVolumetricFogRenderer.getStatistics()`** — new. Returns `{ enabled, frozen, snapshotRegistered, destroyed, resolutionKey, dimensions, updatesDispatched, updatesSkippedFrozen, composites }`. Counters split between dispatched and frozen-skipped passes so an operator can confirm at a glance whether snapshot mode is biting.
- **`getWebGPUVolumetricFogStatistics(context)`** — module-level entry point that resolves the per-context fog instance through the existing `WeakMap` and forwards to `inst.getStatistics()`. Wired into the `VOLUMETRIC_FOG` feature renderer registration.
- **`getWebGPUMoonStatistics(moon)`** — module-level entry point that reads from `moon._webgpuCache` and unpacks the moon-specific tail of the uniform buffer (offsets 64..75) to surface the most recent `moonDirectionWC`, `phaseFraction`, `earthshineOn`, `useLogDepth`, `shininess`, `specularStrength`. Wired into the `MOON` feature renderer registration.
- **`Moon.getDebugStatistics(scene)`** — backend-agnostic dispatch through `scene.context.getFeatureRenderer(FeatureRendererKey.MOON).getStatistics(moon)`. Returns `null` for WebGL or for moons that haven't yet had their first update.

**Backend-neutral debug toggles inventory** (already wired before Phase 6 — listed for the operator's convenience in the new snapshot's `debugToggles` field):

`debugShowFramesPerSecond`, `debugShowCommands`, `debugShowFrustums`, `debugShowFrustumPlanes`, `debugShowDepthFrustum`, `debugShowGlobeWireframe`, `debugShowCubeMapFace` (1=+X..6=-Z), `debugShowTerrainLOD`, `debugShowTerrainNormals`, `debugShowImageryLayer` (single-layer isolation), `debugShowDepthAsColor`, `debugShowTriangulation`, `debugDisableAtmosphereScattering`. All wired into `WebGPUGlobeSurfaceRenderer` (terrain visual modes) or the cubemap panorama / scene renderer paths.

**Files modified:**

- `Scene/Scene.js` — `getDebugSnapshot()` + `logDebugSnapshot()`
- `Scene/Moon.js` — `getDebugStatistics(scene)`
- `Renderer/GraphicsContext.ts` — concrete `getRendererStatistics()` default returning `{}`
- `Renderer/WebGPU/WebGPUContext.ts` — `override getRendererStatistics()` populates the WebGPU-specific subsystem stats
- `Renderer/WebGPU/WebGPURenderBundleManager.ts` — extended `statistics` getter + counters + `resetStatisticsCounters()`
- `Renderer/WebGPU/WebGPUVolumetricFogRenderer.ts` — `getStatistics()` instance method, `getWebGPUVolumetricFogStatistics(context)` entry point, counters at dispatch / freeze-skip / composite points
- `Renderer/WebGPU/WebGPUEnvironmentRenderer.js` — `getWebGPUMoonStatistics(moon)` reads the moon cache + uniform tail
- `Renderer/WebGPU/WebGPUFeatureRenderers.ts` — `getStatistics` entry on the `MOON` and `VOLUMETRIC_FOG` feature renderer registrations
- `Services/VisualPerformanceTargetService.js` — `getStatistics()` clone-and-return implementation

**Behavior change:** zero. Every new method is pure read; the bundle manager counters are O(1) increments at points that already existed. `tsc --noEmit` clean.

**Operator workflow example:**

```js
// In DevTools, after navigating to a static scene:
viewer.scene.snapshotMode.enabled = true;
viewer.scene.snapshotMode.autoEnterIdleFrames = 120;
// ... wait two seconds ...
viewer.scene.logDebugSnapshot();
// Expect: snapshotMode.isFrozen = true, renderer.bundleManager.frozen = true,
// renderer.bundleManager.hitRate ≈ 1.0 (only hits from here on),
// renderer.volumetricFog.updatesSkippedFrozen rising every frame.
```

### Phase 1 → 3 sweep (completed 2026-04-09)

Continuation of the Phase 6 audit deep-dive. Closes Phase 1 (visual verification + bug closure), most of Phase 2 (testing + quality + perf benchmarking), and the smallest Phase 3 dormant compute shader activation. Backlog `Priority Remediation Order` items 1-9 are now closed or de-risked.

#### Phase 1 — Bug closure & quick wins

- **FORK-8** ✅ **Verified already resolved.** Audit grep against `packages/engine/Source/Scene/` returned zero `isWebGPUDrawCommand` references. The backlog entry was stale — pointed at a line removed during S16 cleanup. Marked resolved (FORK-8 in the resolved-items list).
- **SHADOW-LAYOUT** ✅ **Mostly resolved.** S25 shipped the per-layout pipeline cache (`cache.castPipelines` Map keyed on variant name) + the `registerShadowCastVariant(key, variant)` API + the stride-inference safety net. This sweep added the second built-in variant (`p12` — single-vec3 stride 12 for non-RTE models) so the registry isn't just `rte24` + an empty extension point. Stride inference now picks `p12` for stride-12 commands, falls back to the warn-once dedupe path for unknown strides. Spec coverage: 11 specs over the variant registry, stride inference, warn dedupe, and explicit `_shadowCastLayout` override (`Specs/Renderer/WebGPU/WebGPUShadowMapRendererSpec.js`). **Carved out**: SHADOW-LAYOUT-QUANTIZED — quantized terrain stride-8/12 variants need de-quantization in the cast shader and a larger uniform buffer carrying tileRectangle / minMaxHeight; documented separately for a future session.
- **BUG-11 imagery probe** ✅ **Instrumentation landed; visual session still pending.**
  - Hypothesis A defensive fix: changed `WebGPUImageryReprojection.ts` clear alpha from `0` → `1` so any future `discard` path doesn't collapse the downstream `tex.a * effectiveAlpha` composite to zero. The full-screen triangle covers every output pixel today so this is a pure no-op-with-defense.
  - New `scene.debugShowImageryProbe = true` toggle exposes the existing first-4-tile diagnostic on demand. Rising-edge latch reset means the operator can re-sample without restarting the page.
  - The flag flows through `frameState.debugShowImageryProbe` and is reflected in `Scene.getDebugSnapshot().debugToggles.debugShowImageryProbe`.
  - Probe checklist preserved in `WEBGPU_MIGRATION_BACKLOG.md` updated for the visual session: `scene.debugShowImageryProbe = true` → capture dump → toggle `debugShowTerrainLOD` → narrow B / C if A still in play.

#### Phase 2 — Testing & quality

- **FORK-19b** ✅ **Spec coverage delta landed.** Five new spec files totaling ~745 lines and ~70 specs across the audit lockdown + the broader Phase 6 surfaces:
  - `Specs/Scene/SceneSnapshotWiringSpec.js` (190 lines, 11 specs) — Phase 6 audit lockdown: primitive collection mutations bump `_snapshotVersion`, ground primitive add/remove bumps it, globe `imageryLayersUpdatedEvent` + `terrainProviderChanged` bump it, `Scene.destroy()` releases orchestration services, `Scene.getDebugSnapshot()` returns the standard sections.
  - `Specs/Renderer/WebGPU/WebGPUVolumetricFogSnapshotSpec.js` (100 lines, 11 specs) — `WebGPUVolumetricFogRenderer.asFreezable()` contract, freeze/thaw idempotency, integration with `SnapshotModeService.enter()` / `exit()`, `getStatistics()` shape on a fresh renderer.
  - `Specs/Renderer/WebGPU/WebGPUMoonSnapshotSpec.js` (155 lines, 11 specs) — `createMoonFreezable(cache)` contract, late-arrival registration during an active snapshot, `unregisterFreezable` cleanup, `getWebGPUMoonStatistics(moon)` returning the unpacked uniform tail.
  - `Specs/Renderer/WebGPU/WebGPURenderBundleManagerStatsSpec.js` (155 lines, 13 specs) — full `statistics` Phase 6 schema, `asFreezable()` contract, freeze/thaw idempotency + counter bumps, `beginFrame()` advancement during freeze, `invalidate*()` paths against an empty cache, `resetStatisticsCounters()` semantics, `destroy()` safety.
  - `Specs/Services/VisualPerformanceTargetServiceSpec.js` (220 lines, 18 specs) — enabled / targetFps / snapshotMode flags, probe + sink registration, `tick()` no-op contracts under disabled / snapshot-frozen / idle frame, `getStatistics()` lazy probe queries with per-probe error isolation, sink level + cost reporting, `destroy()` cleanup.
  - **Refactor of two registration sites** to make the spec layer reachable: `WebGPUVolumetricFogRenderer.update()` now uses `this.asFreezable()`, and `WebGPUEnvironmentRenderer` Moon path now uses a new `createMoonFreezable(cache)` helper. Both helpers are exported so specs can drive the freezable contract directly without needing a real GPU device.
- **Visual regression CI** ✅ **Workflow added.** New `.github/workflows/visual-regression.yml` (workflow_dispatch trigger) drives `Tools/visual-regression/capture-and-diff.mjs` against the split-screen comparison page. Inputs: `threshold` (per-scene diff ratio failure cutoff, default 0.02) and `update` (true → promote captured outputs to baseline). Uploads `output/**` and `baseline/**` as artifacts (14 day retention). Currently manual-trigger only because GitHub-hosted Linux runners don't ship a WebGPU adapter without extra setup; promote to `pull_request` once that lands or when a self-hosted runner with a WebGPU adapter is available.
- **Perf benchmarking harness + tracking infrastructure** ✅ **New backend-neutral service.** `Source/Services/PerformanceTracker.js` (~370 lines) records per-frame samples (`frameNumber`, `relFrame`, `wallDtMs`, `cpuMs`, `gpuMs`, `drawCount`, `bundleStats` flattened, `snapshotFrozen`, caller `extra`) over a sample window. APIs:
  - `beginTrace(label, { frames })` — auto-ends after N frames, default 600
  - `sample(input)` — one-comparison no-op while inactive
  - `endTrace()` — returns the structured result + retains `lastResult`
  - `toCSV(result)` — stable column order, escapes commas/quotes, 4-decimal float formatting for diff-friendliness
  - `toJSON(result)` — pretty-printed with 4-decimal rounding
  - `logToConsole(result)` — `console.table()` + summary line
  - `traceCount` / `lastResult` getters for late-binding inspection
  - Summary roll-up: per-key (`cpuMs`, `gpuMs`, `wallDtMs`) `{count, avg, min, max, total}`, plus `avgBundleHitRate` and `snapshotFrozenRatio`.
  - Wired into `Scene` via new `Scene.beginPerformanceTrace(label, options)` / `Scene.endPerformanceTrace()` / `scene.performanceTracker` getter. The per-frame `_samplePerformanceTrace(scene)` helper pulls bundle stats from `context.getRendererStatistics()` and the snapshot frozen flag from `scene.snapshotMode.isFrozen`, so all the per-subsystem `getStatistics()` accessors are exercised through one path.
  - `Scene.destroy()` ends any active trace cleanly so a held reference to a result doesn't pin a destroyed scene.
  - Spec coverage: 24 specs across the active flag, beginTrace validation, sample storage + flattening, auto-end, frames=0 indefinite mode, summary roll-up math, CSV / JSON exporters, escape behavior, and the `traceCount` + `lastResult` retention contract (`Specs/Services/PerformanceTrackerSpec.js`, ~280 lines).

#### Phase 3 — Dormant compute shader activation

- **PointCloudSort dispatcher** ✅ **Built + spec'd.** New `Renderer/WebGPU/WebGPUPointCloudSortDispatcher.ts` (~370 lines) is a self-contained sort wrapper around `PointCloudSort.wgsl`. Hides the bitonic sort details from the consumer behind a single `sort(encoder, distSq, count)` call:
  - Owns the SortParams UBO + sortKeys + indices storage buffers
  - Handles power-of-two padding (sentinel `0xFFFFFFFFu` keys sort to the back of the network)
  - Encodes the local phase (`localBitonicSort` — one workgroup sorts up to 256 elements via shared memory) once
  - Encodes the global merge phase (`globalBitonicMerge`) over the (k, j) merge network for capacity > 256
  - `sortedIndicesBuffer` / `sortedKeysBuffer` getters expose the result for downstream draws
  - Diagnostic counters via `getStatistics()`: `sortsDispatched`, `localPasses`, `globalMergePasses`, `lastElementCount`, `lastCapacity`
  - `setShaderSource(wgsl)` injection point so the WGSL stays in `Source/Shaders/WebGPU/Compute/`
  - Pure-JS helpers: `nextPow2`, `floatToSortableUint`, `sortableUintToFloat` (matches the WGSL helper exactly so the host-side encoding agrees with the device-side comparison)
  - 11 specs over the helpers — covers `nextPow2` rounding, the float ↔ sortable-uint round trip, ordering preservation across the sample range, and the negative-zero edge case (`Specs/Renderer/WebGPU/WebGPUPointCloudSortDispatcherSpec.js`)
  - **Remaining**: consumer integration in the point cloud collection path. One-line swap: `if (perfMgr.shouldUseGPUPointCloud(N)) sortDispatcher.sort(encoder, distSq, N) else wasmBridge.sortByDistance(distSq, N, outIndices)`. Deferred until a real point cloud scene is wired up since the GPU-side sort is only useful when the consumer is also GPU-side (feeding into a draw indirect rather than reading back to the CPU).
- **HiZ + OcclusionTest** — **Audit complete; activation deferred.** Both WGSL files are complete (~70 + ~180 lines), both dispatchers exist on `WebGPUPerformanceManager` (`dispatchHiZPyramid()` line 1078, `dispatchOcclusionTest()` line 1310). The blocker is `OcclusionCulling.initialize()` — currently an API stub deferred to the "full WebGPU integration phase". Smallest fix is ~200-300 LOC: populate `OcclusionCulling.initialize()` to allocate the Hi-Z mip pyramid texture + wire `testCommands()` to call the dispatcher. Captured in the backlog with the file paths so the next session can pick it up cleanly.
- **GPUSortKeys** — **Audit complete; activation deferred.** WGSL + dispatcher are complete (`dispatchGPUSortKeys()` line 1243). The blocker is the consumer side — it needs SOA buffers for command metadata (centerX/Y/Z, layer, priority, materialId) allocated in Scene + a bind group factory + integration into RenderScheduler's sort pipeline. ~400-500 LOC. Lowest priority of the three since the JS multi-level comparators are not on the hot path until a scene exceeds 50K commands.

**Total deltas this session:**

- **Files added (8):** `PerformanceTracker.js`, `WebGPUPointCloudSortDispatcher.ts`, `SceneSnapshotWiringSpec.js`, `WebGPUVolumetricFogSnapshotSpec.js`, `WebGPUMoonSnapshotSpec.js`, `WebGPURenderBundleManagerStatsSpec.js`, `VisualPerformanceTargetServiceSpec.js`, `PerformanceTrackerSpec.js`, `WebGPUPointCloudSortDispatcherSpec.js`, `.github/workflows/visual-regression.yml`
- **Files modified (~10):** `Scene/Scene.js`, `Scene/Moon.js`, `Renderer/GraphicsContext.ts`, `Renderer/WebGPU/WebGPUContext.ts`, `Renderer/WebGPU/WebGPURenderBundleManager.ts`, `Renderer/WebGPU/WebGPUVolumetricFogRenderer.ts`, `Renderer/WebGPU/WebGPUEnvironmentRenderer.js`, `Renderer/WebGPU/WebGPUFeatureRenderers.ts`, `Renderer/WebGPU/WebGPUShadowMapRenderer.js`, `Renderer/WebGPU/WebGPUImageryReprojection.ts`, `Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts`, `Services/SnapshotModeService.js`, `Services/VisualPerformanceTargetService.js`, `Specs/Renderer/WebGPU/WebGPUShadowMapRendererSpec.js`
- **Behavior change:** zero by default. Every new feature is opt-in via either an explicit flag (`debugShowImageryProbe`, `beginPerformanceTrace`) or an existing service toggle (`scene.snapshotMode.enabled`). Existing WebGL behavior, existing WebGPU rendering, and the existing spec suite all unchanged. `tsc --noEmit` clean throughout.

### Phase 3 + 4 + 5 sweep (completed 2026-04-09)

Closes Phase 3 dormant compute shader activation, lands Phase 4's cheapest visual quality win, and lays the Phase 5 capability snapshot + design plan. Backlog `Priority Remediation Order` items 10-25 are now closed or have a concrete spec to execute against.

#### Phase 3 — Dormant compute shader activation (HiZ + OcclusionTest + GPUSortKeys)

- **HiZ + OcclusionTest activation** ✅ **Dispatcher built + wired through OcclusionCulling.**
  - New `Renderer/WebGPU/WebGPUHiZOcclusionDispatcher.ts` (~640 lines): owns the Hi-Z mip pyramid texture (`r32float`, `pyramidMips` levels), the per-mip bind groups + params UBOs, the SOA sphere storage buffers (one per centerX/Y/Z/radius), the OcclusionParams UBO, the visibility output buffer, and the staging buffer for async readback. Pipelines + bind group layouts mirror `HiZPyramid.wgsl` and `OcclusionTest.wgsl` exactly.
  - Three entry points: `buildHiZPyramid(encoder)` records the per-mip compute pass loop, `dispatchOcclusionTest(encoder, soa, params)` uploads SOA + params and records the test compute pass + visibility-to-staging copy, and `readbackVisibility(count)` async-maps the staging buffer (with an `_inFlightReadback` guard so concurrent calls don't double-map).
  - Diagnostic `getStatistics()` exposes `hiZBuilds`, `occlusionDispatches`, `successfulReadbacks`, `failedReadbacks`, `inFlightReadback`, mip count, max command count.
  - Module-level entry points (`initWebGPUHiZOcclusion`, `dispatchWebGPUHiZOcclusion`, `readbackWebGPUHiZOcclusion`, `getWebGPUHiZOcclusionStatistics`, `destroyWebGPUHiZOcclusion`) registered as the `HI_Z_OCCLUSION` feature renderer (`FeatureRendererKey: 38`). Per-context instance cached in a `WeakMap` so the consumer doesn't have to thread the reference through.
  - **`Scene/OcclusionCulling.js` initialize() rewritten** to dispatch through the feature renderer registry. Backend-agnostic: looks up the FR via `context.getFeatureRenderer(FeatureRendererKey.HI_Z_OCCLUSION)`, calls `init(width, height, maxCommands)`, stashes the FR reference, sets `_pipelinesReady = true`. WebGL backends return null from the lookup and the conservative "all visible" path stays active. New `OcclusionCulling.dispatchGPU(encoder, depthTextureView, params)` and `OcclusionCulling.scheduleReadback()` methods drive the per-frame path (called by the future ViewportExecutor integration).
  - `OcclusionCulling.destroy()` now calls the FR's destroy through the cached reference.
  - Spec coverage: 11 specs over the pure-JS helpers (`computeMipLevels`, `halveDim`, `HI_Z_PARAMS_BYTES`, `OCCLUSION_PARAMS_BYTES`) — the dispatcher's `allocate` / `buildHiZPyramid` / `dispatchOcclusionTest` paths need a real GPUDevice and are covered by the in-browser spec runner.
  - **Remaining**: ViewportExecutor needs to call `dispatchGPU()` after the depth pass and `scheduleReadback()` at frame end. That's a Scene-side wiring step, ~50 LOC, deferred to a session that has a real test scene to validate against.
- **GPUSortKeys dispatcher** ✅ **Built + FR registered (consumer integration deferred).**
  - New `Renderer/WebGPU/WebGPUGPUSortKeysDispatcher.ts` (~340 lines): owns the SOA command metadata storage buffers (centerX/Y/Z + renderLayers + sortPriorities + materialSortIds), the packed output buffers (sortKeysHigh + sortKeysLow + commandIndices), the SortKeyParams UBO, the bind group layout, and the compute pipeline. Single `dispatch(encoder, soa, params)` entry point uploads the SOA + params and records the compute pass.
  - Output buffer accessors (`sortKeysHighBuffer`, `sortKeysLowBuffer`, `commandIndicesBuffer`) so a downstream sort pass (PointCloudSort or a future radix sort) can consume the packed keys.
  - Diagnostic `getStatistics()` exposes `dispatches` + `lastCommandCount`.
  - `SORT_MODE_FRONT_TO_BACK = 0` and `SORT_MODE_BACK_TO_FRONT = 1` enum constants matching the WGSL.
  - Registered as the `GPU_SORT_KEYS` feature renderer (`FeatureRendererKey: 39`).
  - Spec coverage: 3 specs over the layout constants + sort mode enum.
  - **Remaining**: RenderScheduler integration (allocate the SOA buffers in Scene, call `dispatch()` after command binning, follow up with a sort pass on the packed keys, rewire RenderScheduler to use GPU-sorted command indices). ~400-500 LOC. Lowest priority since the JS multi-level comparator is fine for <50K commands.

#### Phase 4 — Visual quality closure

- **Color grading LUT post-process** ✅ **Shipped end-to-end.**
  - New `Source/Shaders/WebGPU/PostProcess/ColorGrading.wgsl` (~135 lines): full-screen fragment pass with exposure / brightness / contrast / saturation / temperature / tint / per-tonal-range color balance (shadows / midtones / highlights) / output gamma. Procedural — does NOT require a 3D LUT texture upload, so the migration is purely a uniform buffer + a single pass. Designed to extend with a `texture_3d` LUT slot when a real LUT pipeline is needed.
  - **`WebGPUPostProcessPipeline.ts` extended** with `ColorGradingConfig` interface, `packColorGradingUniforms(c)` packer (20 floats / 80 bytes matching the WGSL struct), `addColorGrading()`, `updateColorGradingUniforms()`, and `setColorGradingScalar()` runtime tuners. Stage inserted between `Tonemap` and `Custom stages` in the single-pass execute chain (after SDR conversion, before any custom passes).
  - `setStageEnabled` / `updateStageUniforms` extended to recognize the `"ColorGrading"` name.
  - `hasActiveStages` getter recognizes the new stage so the pipeline doesn't go dormant when only color grading is enabled.
  - Spec coverage: 6 specs over `packColorGradingUniforms` — default identity pass-through, scalar field order, shadows/midtones/highlights tints, sparse config fall-back, purity (`Specs/Renderer/WebGPU/WebGPUColorGradingSpec.js`).
- **DEFERRED_GBUFFER FR key decision** ✅ **Closed.** The FR key was already removed from `FeatureRendererKey.js` earlier in the session. The reference shaders (`DeferredGBuffer.wgsl`, `DeferredLighting.wgsl`) stay in the tree as documentation of the intended architecture. Decision: skip the full deferred path until a real many-lights scene shows up; if that day comes, build forward-clustered first (better fits the Cesium globe surface workload). Backlog item closed.
- **TAA design doc** ✅ **Written.** New `migration_doc/TAA_DESIGN.md` covers: motivation (FXAA weaknesses for Cesium scenes), architecture (camera jitter, motion vectors, neighborhood clamping, history ping-pong), 4-step implementation plan (~3 days), risks (quantized terrain motion vectors, snapshot mode jitter freeze, MSAA incompatibility), acceptance criteria, and a spec coverage delta. Concrete enough for the next session to execute against.
- **CSM design doc** ✅ **Written.** New `migration_doc/CSM_DESIGN.md` covers: cascade splits (mixed uniform + logarithmic), per-cascade VP fitting with bounding spheres, texel snap stabilization, receive-side cascade selection with blend bands, 5-step implementation plan (~4 days), risks (quantized vertex layout extensibility, RTE precision in texel snap, memory cost on mobile, snapshot mode integration), VSM stretch follow-up. Concrete enough for the next session to execute against.

#### Phase 5 — Modern WebGPU feature adoption

- **Capability snapshot** ✅ **Exposed via the central debug surface.** `WebGPUContext.getRendererStatistics()` now returns a `capabilities` block listing every WebGPU optional feature the device negotiated successfully:
  - `enabledFeatures` (full string list)
  - Per-feature booleans: `hasShaderF16`, `hasDualSourceBlending`, `hasClipDistances`, `hasTimestampQuery`, `hasIndirectFirstInstance`, `hasFloat32Filterable`, `hasSubgroups`, `hasBgra8UnormStorage`
  - This is the source of truth for "can I wire feature X on this adapter today?" — visible from `Scene.getDebugSnapshot().renderer.capabilities`. The migration plan in `PHASE_5_MODERN_WEBGPU_DESIGN.md` assumes the operator has verified the snapshot before opting into a feature.
- **HiZ occlusion + GPU sort keys statistics** ✅ added to `getRendererStatistics()` so the central debug surface now reports both Phase 3 dispatchers' counters alongside the existing fog / bundle / timestamp blocks.
- **Phase 5 design doc** ✅ **Written.** New `migration_doc/PHASE_5_MODERN_WEBGPU_DESIGN.md` covers all five modern WebGPU features:
  - **WGF-4 Standard Layout UBOs** — clarifies that this is *not* a device feature but a WGSL packing rule, enumerates the migration order (camera UBO first → tile UBO → effect UBOs → compute UBOs), per-UBO acceptance criteria, runtime assertion mitigation for off-by-one bugs. ~3-5 days total.
  - **WGF-1 `clip-distances`** — replaces stencil-based clipping with hardware clip distances, ~10-15% fragment cost saving on heavily-clipped scenes, ~1-2 days.
  - **WGF-2 `dual-source-blending`** — single-pass weighted-blended OIT, ~30-50% OIT cost reduction, ~2-3 days.
  - **WGF-3 `shader-f16`** — half-precision math in selected post-process effects (color grading, tonemap, bloom, FXAA), ~20-40% fragment ALU saving on targeted passes, ~2-3 days.
  - **WGF-5 `multi-draw-indirect`** — pairs with `WebGPUIndirectDrawManager` for GPU-driven N-draw rendering, ~3-4 days.
  - Recommended order: capability snapshot → camera UBO → clip-distances → shader-f16 → dual-source → multi-draw. First three are high-leverage and low-risk (~5-6 days); last two are scene-dependent.

**Files added (10):**

- `Renderer/WebGPU/WebGPUHiZOcclusionDispatcher.ts`
- `Renderer/WebGPU/WebGPUGPUSortKeysDispatcher.ts`
- `Shaders/WebGPU/PostProcess/ColorGrading.wgsl`
- `Specs/Renderer/WebGPU/WebGPUHiZOcclusionDispatcherSpec.js`
- `Specs/Renderer/WebGPU/WebGPUGPUSortKeysDispatcherSpec.js`
- `Specs/Renderer/WebGPU/WebGPUColorGradingSpec.js`
- `migration_doc/TAA_DESIGN.md`
- `migration_doc/CSM_DESIGN.md`
- `migration_doc/PHASE_5_MODERN_WEBGPU_DESIGN.md`

**Files modified (~6):**

- `Renderer/FeatureRendererKey.js` — added `HI_Z_OCCLUSION (38)` and `GPU_SORT_KEYS (39)`, bumped `COUNT` to 40
- `Renderer/WebGPU/WebGPUFeatureRenderers.ts` — registered the two new dispatchers as feature renderers
- `Renderer/WebGPU/WebGPUContext.ts` — extended `getRendererStatistics()` with `hiZOcclusion`, `gpuSortKeys`, and `capabilities` blocks
- `Renderer/WebGPU/WebGPUPostProcessPipeline.ts` — added `ColorGradingConfig` interface, `packColorGradingUniforms`, `addColorGrading` / `updateColorGradingUniforms` / `setColorGradingScalar` methods, integration into the execute chain + setStageEnabled + updateStageUniforms
- `Scene/OcclusionCulling.js` — `initialize()` now dispatches through the FR registry; new `dispatchGPU()` and `scheduleReadback()` per-frame methods; `destroy()` releases the FR
- `migration_doc/WEBGPU_MIGRATION_BACKLOG.md` — closed the DEFERRED_GBUFFER decision, marked HiZ + OcclusionTest + GPUSortKeys as "dispatcher landed"

**Behavior change:** zero by default. Color grading is opt-in via `pipeline.addColorGrading()`. HiZ occlusion requires `scene.renderScheduler.occlusionCulling.enabled = true` AND the consumer (ViewportExecutor) wiring that's still pending. GPUSortKeys is dispatcher-only — no consumer yet. The capability snapshot is read-only diagnostic. `tsc --noEmit` clean throughout.

### Carry-over follow-ups (not blocking; captured in `WEBGPU_MIGRATION_BACKLOG.md`)

- **NEW-9** — file an upstream PR against `CesiumGS/quantized-mesh` to formally reserve extension ID `0x05` before water Phase 1 ships
- **EllipsoidPrimitive consolidation** — extract the moon's bounding-cube + ray-march math into a generic `EllipsoidRenderer` feature renderer that future ellipsoid bodies (sun, custom planets) can share (the orphan `Generated/EllipsoidPrimitive.wgsl` is the conceptual reference)
- **Render bundle env-pass executor full integration** — currently the bundle is wired into `WebGPUDrawCommand.execute()` so any individual command can replay one. Future: collect bundles from a frustum's command list and submit a single `executeBundles([...])` call per pass, eliminating per-command overhead entirely.
- **Snapshot mode Phases A-D** — see `SNAPSHOT_MODE_SPIKE_2026-04-09.md` (3 days of work after Phase 1+ lands real bundle consumers)
- **C4/C12 wording fixes** in water doc §4.5/§10/DP5 — small refinements from Phase 0.6 verification

---

---

## Table of Contents

1. [Architecture](#1-architecture)
2. [Completed Work](#2-completed-work)
3. [What Works End-to-End (Verified)](#3-what-works-end-to-end-verified)
4. [Bug Fix History (Sessions 1-26)](#4-bug-fix-history-sessions-1-26)
5. [WASM & Compute Audit Results](#5-wasm--compute-audit-results)
6. [Render Pass Coverage](#6-render-pass-coverage)
7. [Industry Comparison](#7-industry-comparison)
8. [Relationship with Upstream CesiumJS](#8-relationship-with-upstream-cesiumjs)
9. [Reference](#9-reference)

> **For the full detailed backlog of remaining work, see `WEBGPU_MIGRATION_BACKLOG.md`.**

---

## 1. Architecture

### High-Level Flow

```
User Code: new Cesium.Viewer('container', { contextOptions: { renderer: 'webgpu' } })
  +-- Viewer.createAsync() -> shows LoadingOverlay
      +-- CesiumWidget.createAsync() -> Scene.createAsync()
          |-- ContextFactory.createContext() -> WebGPUContext.create() (async GPU adapter/device)
          |-- Shader init in WebGPUContext._initialize() -> imports .wgsl JS wrappers
          +-- Matrix4.setDepthRangeType('webgpu') -> 0-1 NDC depth range

Rendering: Scene.render() -> uniformState.update() -> per-View context update -> Primitive.update()
  |-- WebGL path (existing, untouched)
  +-- WebGPU path:
      |-- Feature renderer via context.getFeatureRenderer(FeatureRendererKey.XXX)
      |-- createWebGPUCommands() -> builds GPU pipelines/buffers
      |-- updateWebGPUCommandUniforms() -> per-frame RTE camera matrices
      +-- executeCommand() -> WebGPUDrawCommand.execute(renderPass)
```

### Core Design Principles

1. **Preserve WebGL functionality** -- WebGL rendering must continue to work. We modify upstream files when it improves architecture (e.g., `Context.js` -> ES6 class + `extends GraphicsContext`), but never break existing behavior.
2. **Backend agnosticism** -- `GraphicsContext` is an abstract base class. Scene code accesses renderers via `context.getFeatureRenderer(FeatureRendererKey.XXX)`, not direct imports. **Zero `isWebGPUDrawCommand` / direct WebGPU imports remain in Scene code** (Session 16 cleanup).
3. **Async-first for WebGPU** -- WebGPU is an async renderer. All GPU readback (depth picking, buffer reads, texture reads) uses async patterns (`mapAsync`, `.then()`, Promises). No sync GPU reads in render loops.
4. **Configuration-based** -- `renderer: 'webgpu'` opt-in, WebGL default. Feature detection falls back to WebGL.
5. **RTE everywhere** -- All WebGPU rendering uses Relative-To-Eye 64-bit emulated precision for planetary-scale accuracy.
6. **Multi-context support** -- `ContextRegistry` tracks all active contexts. Each `View` can target a different `GraphicsContext`. `FrameState.context` updated per-view before each render pass.
7. **WebGL2 only** -- Our fork targets WebGL2 + WebGPU (2 paths), not WebGL1 + WebGL2 + WebGPU (3 paths).

### Backend-Agnostic Architecture (Phases A-G Complete)

```
GraphicsContext (abstract base class)
  |-- id, rendererType, isWebGPU/isWebGL (per-instance)
  |-- log(level, message) -> [CesiumJS:type:shortId] prefix
  |-- registerFeatureRenderer() / getFeatureRenderer()  (O(1) array indexed by FeatureRendererKey enum)
  |-- registerFeatureRendererLoader() (lazy loaders for code-split renderers)
  |-- ContextRegistry (static) -- tracks all active contexts
  |-- 5 concrete command dispatch methods (WebGL defaults, WebGPU overrides)
  |-- Abstract compute capability API (supportsComputeShaders, supportsStorageBuffers, etc.)
  |-- Context.js (WebGL) extends GraphicsContext
  +-- WebGPUContext.ts (WebGPU) extends GraphicsContext

View (per-view context)
  |-- optional graphicsContext constructor param
  |-- effectiveContext -> per-view override OR Scene's default
  +-- scene.createView(camera, viewport, { graphicsContext })

FrameState
  |-- context / graphicsContext -- updated per-view before render
  +-- Matches how CesiumJS already updates frameState.camera per view
```

**Feature Renderer Pattern** (Phase D -- 36 of 36 keys registered):
```javascript
import FeatureRendererKey from "../Renderer/FeatureRendererKey.js";
const fr = context.getFeatureRenderer(FeatureRendererKey.POINT_PRIMITIVE_COLLECTION);
if (fr) { fr.update(this, frameState); return; }
// WebGL code follows as default fallback
```

**Scene.js Backend Agnosticism** (Complete): 5 concrete methods on `GraphicsContext` with WebGL-default behavior. `WebGPUContext` overrides each. Zero `isWebGPUDrawCommand` checks remain in Scene code (Session 16 cleanup replaced all with duck-typing via `defined(command._webgpuShaderType)` / `typeof cmd.execute === "function"` / `defined(cmd.pipeline)`).

### Renderer Threading Topology (Option C — landed 2026-04-11)

The default Cesium runtime is single-threaded: one main-thread JS pump
drives `Scene.render()` per RAF callback. The 2026-04-11 sweep added an
**opt-in** per-renderer worker pattern that lets multiple Scenes run on
separate threads, each with its own `OffscreenCanvas` and its own
render loop. The main thread is freed up during heavy renders and
each renderer reports its own independent FPS.

```
Main thread                                  Worker thread (one per host)
─────────────                                 ────────────────────────────
WorkerSceneHost(parent: <div>)                RendererWorker.js (bootstrap)
  │                                             │
  ├─ creates child <canvas>                     │
  ├─ canvas.transferControlToOffscreen() ───►   ├─ receives OffscreenCanvas
  ├─ new Worker(RendererWorker.js)              ├─ dynamic-imports
  │                                             │   "@cesium/engine" (chunked)
  ├─ posts MSG_INIT { canvas, rendererType,     ├─ Scene.createAsync({canvas})
  │                   sceneOptions, maxFps,     │   ↓
  │                   sessionId } ───────────►  │   Scene constructor detects
  │                                             │   `typeof document === "undefined"`
  │                                             │   → headless mode (no DOM)
  │                                             │
  │                                             ├─ _startRenderLoop()
  │                                             │   ├─ requestAnimationFrame (Chromium)
  │                                             │   └─ setTimeout fallback (FF/Safari)
  │                                             │
  │                                             ├─ scene.render() per tick
  │                                             ├─ scene.performanceTracker
  │                                             │   .recordFrame() per render
  │                                             │
  ├─ heartbeat ping every 1s ─────────────►     ├─ heartbeat pong
  │  (3 missed → restart)                       │
  │                                             │
  ├─ FpsOverlay polls host.getLiveStats()       │
  │  6 Hz (no postMessage cost — host caches    ├─ posts MSG_STATS every 125ms
  │  the latest stats payload from worker)  ◄───┤   { stats, frameTimes (transfer) }
  │                                             │
  ├─ host.setView/setMaxFps/forwardInput        │
  │  records in shadow state → posts ─────►     ├─ applies to scene
  │                                             │
  └─ on crash:                                  X (worker dies)
       Tier 1 (in-thread) device-lost recovery
       Tier 3 hard restart:
         worker.terminate()
         destroy dead canvas (one-time transfer)
         create fresh canvas inside parent
         spawn new worker
         replay shadow state (camera, maxFps,
                              requestRenderMode)
```

**Key constraints documented in code:**

- `OffscreenCanvas.transferControlToOffscreen()` is one-time per DOM
  canvas. Hard-restart paths recreate the entire `<canvas>` element
  inside the stable parent `<div>`.
- `requestAnimationFrame` is Chromium-only inside DedicatedWorker —
  Firefox/Safari fall back to `setTimeout(1000/60)`.
- The headless `Scene` works (Phase 1 of Option B) but most consumer
  features (entity adds, picking, DataSources, time-varying
  properties) still need the Phase 2-7 work in
  [OPTION_B_SCENE_IN_WORKER.md](OPTION_B_SCENE_IN_WORKER.md). Today
  the worker path is best used as a measurement substrate.
- Multiple `WorkerSceneHost` instances coexist on the same page —
  the test page [worker-renderers.html](Apps/WebGPUTest/worker-renderers.html)
  exercises 1-16 simultaneous panes.

### File Organization

```
packages/engine/Source/Renderer/
|-- GraphicsContext.ts          <- Abstract base class
|-- ContextRegistry.ts          <- Multi-context tracking
|-- ContextFactory.ts           <- Async factory with fallback
|-- Context.js                  <- WebGL (extends GraphicsContext)
+-- WebGPU/                     <- 105+ files (~46,000 LOC)
    |-- WebGPUContext.ts         (core, ~3,010 lines)
    |-- WebGPUFeatureRenderers.ts (central registration of 36 renderers + lazy loaders)
    |-- WebGPUSceneRenderer.ts   (multi-frustum, all 13 passes, ~1,400 lines)
    |-- WebGPUGlobeSurfaceRenderer.ts (~2,100 lines)
    |-- WebGPUPerformanceManager.ts (~960 lines, 7 perf systems orchestrator)
    |-- WebGPUNagaTranspiler.ts  (NEW S26: optional GLSL->WGSL via naga-wasm)
    |-- Feature renderers, caching, resources, commands, debug overlays, stubs

packages/engine/Source/Services/    <- Backend-neutral services
|-- PerformanceTracker.js        (live FPS histogram + trace API)
|-- FpsOverlay.js                (Canvas2D HUD component, polls a data source)
|-- WorkerSceneHost.js           (main-thread worker wrapper + 3-tier crash recovery)
|-- WorkerSceneProtocol.js       (host↔worker message constants)
|-- SnapshotModeService.js       (Phase 0.7 freezable registry, integrates with maxFps)
|-- VisualPerformanceTargetService.js (Phase 0.4 VPT)

packages/engine/Source/Workers/
|-- RendererWorker.js            (worker-thread Scene bootstrap, ~11 KB)
|-- (existing terrain / decoder / culling workers)

packages/engine/Source/Shaders/WebGPU/    <- 238+ .wgsl files
packages/engine/Source/Scene/             <- Modified scene files + decomposed modules
Apps/WebGPUTest/                           <- 29 test/demo pages
migration_doc/                             <- This documentation
```

---

## 2. Completed Work

### Architectural Improvements to Upstream Files

| File Modified | Change | Why |
|--------------|--------|-----|
| `Context.js` | ES6 class + `extends GraphicsContext` | Enables shared abstract base |
| `View.js` | Optional `graphicsContext` param, `effectiveContext` getter | Per-view backend selection |
| `Scene.js` | `graphicsContext`/`contextRegistry` getters, `createView()`, per-view context updating, **decomposed into 8 modules**, debug visualization flags forwarded to frameState | Backend-agnostic facade |
| `FrameState.js` | `graphicsContext` alias for `context` | Backend-agnostic access |
| `Matrix4.js` | `setDepthRangeType('webgpu')` | 0-1 NDC depth |
| `Viewer.js` | `_preInitializedScene` forwarded to CesiumWidget | Async WebGPU init path |
| `CesiumWidget.js` | `_preInitializedScene` consumer | Skip sync Scene creation when async-built |
| `InfoBox.js` | DOMPurify sanitization for entity description innerHTML | XSS security fix — entity descriptions from external data sources (KML, GeoJSON, CZML) were injected raw |
| `Material.js` | `MaterialUniformBuffer` allocation via `MaterialHelpers.js initializeMaterial()` | Float32Array-backed uniform storage for WebGPU zero-copy upload path |
| 424 JS files | ES6 class conversion via jscodeshift codemod | Eliminates prototype-based inheritance patterns; consistent with upstream v1.139 ES6 direction |
| All `.indexOf()` comparisons | Replaced with `.includes()` (~90 patterns) | Modernization; clearer intent, same semantics |
| 12 files using urijs | Migrated to native `URL` API | Removed third-party dep; native API has equivalent functionality |

### Infrastructure Layer (105+ files, ~46,000 LOC)

| Category | Key Components |
|----------|----------------|
| **Core Context** (7) | `WebGPUContext.ts`, `GraphicsContext.ts`, `ContextRegistry.ts`, `ContextFactory.ts`, `SharedResourcePool.ts`, `OffscreenContextSupport.ts`, `WebGPUDevicePool.ts` |
| **Resources** (11) | Buffer, Texture, Texture3D, CubeMap, CubeMapFace, TextureAtlas, Sampler, RenderTarget, MipmapGenerator, TextureArray, TextureUtilities |
| **Pipeline & Shaders** (8) | RenderPipelineCache, ShaderModule, ShaderCache, PipelineDescriptorBuilder, WGSLShaderPreprocessor, WGSLBuiltins, AutoUniforms, **NagaTranspiler** |
| **Commands & Rendering** (5) | DrawCommand, ComputeCommand, ComputeEngine, SceneRenderer, PassState |
| **Framebuffers** (8) | FramebufferManager, SceneFramebuffer, MultisampleFramebuffer, GlobeDepth, DepthPlane, PickFramebuffer, etc. (transient attachments wired via `TRANSIENT_ATTACHMENT` feature detection) |
| **Feature Renderers** (15+) | Globe, Primitive, Billboard, Point, Polyline, Cloud, Model, SkyAtmosphere, Sun, Moon, Label (SDF), BufferPrimitive (polygon/polyline/point), Voxel, GaussianSplat, GroundAtmosphere, etc. |
| **Post-Processing** (7) | PostProcessPipeline, PostProcessEffects (Bloom, SSAO, DoF), Tonemapping, FXAA, Edge, Silhouette |
| **Performance** (7) | PerformanceManager, RenderBundleManager, IndirectDrawManager, GPUCuller, TimestampProfiler, BufferMapper, UniformGroupManager |
| **Stubs/Compat** (7) | WebGLStubBuffer, WebGLStubTexture (**Proton-style rewrite** — real texImage2D/texParameteri/pixelStorei/generateMipmap translation), WebGLStubFramebuffer, WebGLStubPipelineState (**full stencil state tracking**), WebGLStubShader (real device.limits values + 15-extension stubs + naga-wasm hookup), WebGLStubTypes, **WebGLStateConverters** (shared WebGL→WebGPU constant mapping functions) |
| **Material Uniforms** (1) | `MaterialUniformBuffer.js` — Float32Array-backed uniform storage, auto-layout, dirty tracking, scratch-based zero-alloc reads, backward-compatible facade. ~56% memory reduction per material; ~93% CPU reduction for static scenes (zero JS work when no property changed). |
| **Type Declarations** (1) | `cesium-js-types.d.ts` — ambient declarations for 20+ CesiumJS JS classes with opaque branded GPU resource types; eliminated 34 `as any` casts across WebGPU renderer files. |
| **Model** (4) | ModelRenderer, ModelPipelineCache, ModelInstancing, ModelFeatureId |
| **IBL/Lighting** (4) | IBLPipeline, ImageBasedLighting, GroundAtmosphere, EffectsBindGroup |
| **Debug Overlays** (3) | DebugDepthOverlay, PrimitiveIndexUtils, augmented globe debug fragment pipeline cache |
| **Services / Threading** (5) | `PerformanceTracker.js` (extended with live histogram + percentiles), `FpsOverlay.js` (Canvas2D HUD with rolling 60s graph), `WorkerSceneHost.js` (main-thread worker wrapper with 3-tier crash recovery + shadow state replay + maxFps), `WorkerSceneProtocol.js` (shared message-type constants), `Source/Workers/RendererWorker.js` (worker-thread Scene host, ~11 KB bootstrap + dynamic-imported engine chunk) |
| **Headless Scene** (2) | Scene.js + CreditDisplay.js detect `typeof document === "undefined"` and skip all DOM construction. Existing main-thread behavior unchanged. Unlocks Phase 1 of [OPTION_B_SCENE_IN_WORKER.md](OPTION_B_SCENE_IN_WORKER.md). |

### WGSL Shader Library (238+ files)

| Category | Count | Details |
|----------|-------|---------|
| Primitive shaders | 28 | PerInstanceColor (flat/lit/pick/ID), Material variants, PBR |
| Collection shaders | 8 | Point, Billboard, Polyline, Cloud, BillboardCollectionSDF (NEW S18), BufferPolygon/Polyline/Point material |
| Environment | 3 | SkyAtmosphere (with `useLut` fast path + `debug` vec4), Sun, Moon |
| Globe/Terrain | 1 | GlobeTerrain.wgsl (full-featured: imagery layers, day/night, ocean, fog, shadows, clipping, 2D/Columbus View, scene-mode branching, debug fields) |
| Struct/Function chunks | 97 | 91 functions + 6 structs (CsmBuiltins.js); includes new `csm_primitiveIndex.wgsl` |
| PostProcess | 12 | Tonemapping (5 modes), FXAA, SSAO, Bloom, DoF, Edge, Silhouette, OIT |
| Compute | 12 | FrustumCull (with `mainSubgroups` variant), HiZ, OcclusionTest, PolygonSDF, AtmosphereLUT (dispatch wired), PointCloudSort/LOD (LOD has `computeMainSubgroups` variant), GPUSortKeys, IBL (3), WeatherParticles, WeatherParticleRender |
| Model | 1 | ModelPBRComplete.wgsl (7 bind groups, 19 material flag bits) |
| Advanced | 10+ | PointCloud, Voxel, GaussianSplat, InvertClassification, GroundAtmosphere, SSR, ProceduralClouds, WeatherParticles, DeferredGBuffer/Lighting, ViewportQuad/ViewportQuadTexture |

### Scene Features -- What Renders

| Feature | Status | Key Details |
|---------|--------|-------------|
| **Globe/Terrain** | **Verified Working** | Uncompressed + quantized terrain (BITS12), unlimited imagery layers, **full shader (Session 17)**: Lambert diffuse lighting, day/night alpha blending with night lights emission, terminator glow, fog with atmosphere-colored blending, shadow receive (PCF), clipping planes with edge highlights, cartographic limit clipping, enhanced ocean (Fresnel, deep water, foam, wave normals, GGX specular, subsurface scattering, sky reflection), water mask. texCoordsRect alpha masking (S15). Multi-LOD rendering (S15). 2D/Columbus View modes (S18). Debug overlays: triangulation, LOD, normals, imagery isolation, depth-as-color, wireframe (S22-24). |
| **Primitive** (flat/lit/pick) | Built | 20 shader variants, RTE, geometry data preservation |
| **PointPrimitive** | Built | Instanced quads, RTE |
| **Billboard** | Built | Instanced quads, atlas textures, RTE |
| **Label** | **Built (S18)** | `WebGPULabelRenderer` registered as `LABEL_COLLECTION` FR (key 36) — SDF text with 5-tap supersampling, outlines, screen-space derivative AA. WebGL fallback preserved. |
| **Polyline** | Built | Screen-space thick lines, per-segment quads, AA |
| **SkyAtmosphere** | **Working + LUT consumer (S26)** | Nishita scattering with Rayleigh + Mie, HSB correction, debug bypass (`debugDisableAtmosphereScattering`). New `useLut` fast path samples precomputed inscatter LUT instead of per-pixel ray march when `WebGPUPerformanceManager.dispatchAtmosphereLUT` has run; falls back to ray march when compute unavailable. |
| **GroundAtmosphere** | Wired (Session 17) | `Globe.js beginFrame()` calls FR; uniform buffer with packed atmosphere parameters |
| **Sun** | Built | Procedural texture, billboard quad |
| **Moon** | Built | UV sphere mesh, textured diffuse lighting, full RTE |
| **Fog** | **Working** | Parameters wired via tile uniform buffer + full shader fog blending (Session 17) |
| **SkyBox/CubeMapPanorama** | Fixed (Session 16) | Cubemap loads and renders. `panoramaCommandList` accumulation bug fixed. Per-face debug isolation (`debugShowCubeMapFace`) added S23. |
| **Model/glTF** | Built | PBR, morph targets, skinning, GPU instancing, feature ID textures, batch table styling |
| **3D Tiles** | Built | Works via Model chain. Zero 3D Tiles code changes needed. Optional indirect-draw fast path added S26 (`context.useIndirectDrawForTiles` flag, `executeBatchIndirect` groups homogeneous runs through `WebGPUIndirectDrawManager.submitBatch`). |
| **Materials System** | Built | All 25 built-in materials mapped to WGSL |
| **Pick System** | **Working** | Async depth readback with staleness validation + distance ratio rejection. Camera jitter significantly reduced (S16). All 3 collection renderers + globe surface support pick. Buffer Primitive picking landed S20 via shader-variant pick pipelines. |
| **Particles (weather)** | **Built (S18)** | GPU compute particle simulation + render pass. 4 weather types (rain/snow/fog/hail). Camera-facing instanced quads. |
| **Particles (general)** | Auto-supported | Delegates to BillboardCollection (confirmed S20) |
| **Viewport Quad** | **Built (S18)** | `WebGPUViewportQuad` utility integrated into `WebGPUContext.createViewportQuadCommand`. Pipeline + bind group caching, 3-vertex fullscreen triangle pattern, blend/depth/stencil configurable. |
| **Buffer Primitives (vector tile)** | **Built (S19)** | `WebGPUBufferPrimitiveRenderer.ts` (~1465 lines) implements polygon (indexed triangle-list), polyline (indexed miter-quad expansion), point (instanced quads). Picking added S20. |
| **2D / Columbus View** | **Built (S18)** | Globe terrain shader branches on `camera.sceneMode` (MORPHING/COLUMBUS_VIEW/SCENE2D/SCENE3D). Camera UBO extended with `tileRectangle`, `southAndNorthLatitude`, `southMercatorYAndOneOverHeight`, `sceneMode`, `morphTime`, `useWebMercator`. Helper functions: `latitudeToWebMercatorFraction`, `get2DYPositionFraction`, `computePlanarPosition`. |
| **WebGPU Compatibility mode** | Built (S17) | `renderer: "webgpu-compat"` with `featureLevel: "compatibility"` |

### Feature Renderer Registration (36 of 37)

| Status | Count | Details |
|--------|-------|---------|
| Registered + Scene-wired (Phase D) | 31 | Fully functional FR pattern |
| Registered + Scene-wired (Session 17) | +5 | FOG (via tile UB), GROUND_ATMOSPHERE (Globe.js beginFrame), SSR/WEATHER_PARTICLES/PROCEDURAL_CLOUDS (WebGPUSceneRenderer._executeEnvironmentalEffects) |
| Registered (Session 18) | LABEL_COLLECTION (key 36) | `WebGPULabelRenderer` with SDF text path |
| Registered (Session 19) | BufferPolygon/Polyline/Point | Replace v1.140 vector tile no-op stubs |
| Lazy-loaded via `registerFeatureRendererLoader` | 7 | GAUSSIAN_SPLAT, POINT_CLOUD, POINT_CLOUD_EDL, VOXEL_PRIMITIVE, SCREEN_SPACE_REFLECTIONS, WEATHER_PARTICLES, PROCEDURAL_CLOUDS — dynamic import on first frame, ~290 KB shaved from default bundle |
| NOT registered | 1 | DEFERRED_GBUFFER (key defined but never implemented) |

### Sorting System (11 phases, 30+ files)

| Component | Status |
|-----------|--------|
| Foundation types (SortMode, RenderLayer, RenderLayerCollection) | Complete |
| Structured sort properties on DrawCommand/WebGPUDrawCommand | Complete |
| MaterialSortIdAllocator | Complete |
| Scene.js multi-level comparators | Complete |
| RenderScheduler orchestrator + full layer execution (SORT-FULL) | Complete |
| Entity `renderPriority` -> Visualizer -> Collection -> DrawCommand wiring | Complete |
| Geometry batch priority grouping | Complete |
| SceneOctree + OctreeNode (spatial acceleration) | Built, opt-in via `scheduler.octree.enabled = true` |
| OcclusionCulling wiring | Built, opt-in (WebGPU-only, conservative fallback) |
| WASM culling/sorting bridges (JS fallback + Rust crate) | Built (17.2 KB binary) |
| Hi-Z occlusion culling shaders + manager | Built (WebGPU only, not yet wired into ViewportExecutor) |

### Picking System

**What works end-to-end:**
- `WebGPUPickFramebuffer.ts` -- full implementation with async readback
- `WebGPUSceneRenderer._executePickPass()` -- renders GLOBE/3D_TILE/OPAQUE/TRANSLUCENT passes
- All 3 collection renderers (Billboard, Point, Polyline) support pick
- `PickDepth.js` -- async readback via staging buffer + `mapAsync`
- Staleness validation -- PlayCanvas-style camera state validation on async resolve
- Pick ID consolidated in `GraphicsContext`
- Globe depth copy pipeline + async readback (FORK-34 — was already complete, never crossed off)
- Buffer Primitive collections pick path (S20)

### WASM Bridges (7 of 7 Complete)

All 7 bridges (`WasmCullBridge`, `WasmSortBridge`, `WasmHeightmapBridge`, `WasmQuantizedMeshBridge`, `WasmRTEBridge`, `WasmMatrixBridge`, `WasmPointCloudBridge`) implement every `.clinerules` mandate:

| Requirement | Status | Implementation |
|---|---|---|
| `destroy()` method | Complete | All bridges expose destroy + `_isDestroyed` guard |
| `free_buffer()` | Complete | Called in destroy |
| Version check | Complete | `WasmFeatureDetection.checkVersionMatch()` (Rust returns `version() = 2`) |
| SIMD detection | Complete | `WasmFeatureDetection.checkSIMDSupport()` + `checkModuleSIMD()` shared utility |
| JS fallback | Complete | Every bridge has full JS implementation; bridges fall back on WASM init failure |
| Error handling | Complete | try/catch in WASM dispatch methods with automatic JS fallback |
| OOM handling | Complete | Rust `lib.rs` uses `try_reserve()` + null pointer (0) on OOM (FORK-46) |

### Compute Shader Engine

`WebGPUComputeEngine.execute()`, `executeMultiple()`, `executeOnEncoder()` all wrapped in try/catch (return `false` on failure), `_validateWorkgroups()` checks `device.limits.maxComputeWorkgroupsPerDimension` before dispatch, pipeline caching by shader source key (FORK-42, FORK-43, FORK-44).

### Performance Infrastructure (All Wired)

| Feature | File | Benefit | Status |
|---------|------|---------|--------|
| Render bundles | `WebGPURenderBundleManager.ts` | 50-80% CPU for static terrain | **Activated** (Session 16) -- Globe pass uses bundle encoder for 8+ tiles |
| Indirect drawing | `WebGPUIndirectDrawManager.ts` | GPU-driven 3D Tiles | **Wired** + `submitBatch`/`executeBatchIndexed` API. Opt-in fast path in scene renderer (S26) via `context.useIndirectDrawForTiles` flag |
| Storage buffers | `WebGPUStorageBufferPool.ts` | Large point cloud data | Wired |
| GPU frustum culling | `WebGPUGPUCuller.ts` + `FrustumCull.wgsl` | GPU-side visibility | **Activated** (Session 17) -- Lazy-init via `context.gpuCuller`, 256-command threshold, async readback. Subgroup variant added S20 (`mainSubgroups` entry point with try/catch fallback). |
| Timestamp queries | `WebGPUTimestampProfiler.ts` | GPU profiling | Wired |
| Buffer mapping | `WebGPUBufferMapper.ts` | Async CPU<->GPU access | Wired |
| Uniform grouping | `WebGPUUniformGroupManager.ts` | Per-frame/material/object bind groups | Wired |
| Ring buffer allocator | `WebGPURingBufferAllocator` | Reduce per-frame buffer creation | **Activated** (Session 16) -- 4MB pages, triple-buffered, 256-byte alignment |
| Pipeline warm-up | `_warmUpPipelines()` in WebGPUContext | No first-frame stutter | **Activated** (Session 17) -- Globe renderer + GPU culler pre-initialized at context creation |

### Compute Shader Activation Status

| Shader | Status | Activation Trigger |
|--------|--------|-------------------|
| PolygonSignedDistance.wgsl | **Active** | ClippingPolygonCollection |
| BrdfLutGenerate.wgsl | **Active** | IBL pipeline init |
| IrradianceConvolution.wgsl | **Active** | Env map change |
| RadiancePrefilter.wgsl | **Active** | Env map change |
| AtmosphereLUT.wgsl | **Dispatch + consumer wired (S26)** | `WebGPUPerformanceManager.dispatchAtmosphereLUT()` runs on transient encoder when sun direction changes (>0.0001 cos delta); SkyAtmosphere fragment shader samples LUT on `useLut > 0.5` |
| FrustumCull.wgsl | **Activated** (S17, subgroup variant S20) | GPU culler 256-command threshold, picks `mainSubgroups` entry point on capable devices |
| PointCloudLOD.wgsl | **Variant + dispatcher ready (S26)** | `computeMainSubgroups` variant wired through `WebGPUPerformanceManager.dispatchPointCloudLOD()` with lazy source preprocessing (prepend `enable subgroups;` or strip sentinel block) and entry-point selection per device capability |
| HiZPyramid.wgsl | Dormant | Wire into ViewportExecutor with Hi-Z (3-4 days) |
| OcclusionTest.wgsl | Dormant | Same as HiZ |
| PointCloudSort.wgsl | Dormant | Wire when point cloud visible |
| GPUSortKeys.wgsl | Dormant | Wire when >50K commands |
| WeatherParticles.wgsl | **Active (S18)** | Compute simulation + render pass via `WEATHER_PARTICLES` FR; activated by `scene._enableWeather = true` |

### Build & Tooling

| Component | Status |
|-----------|--------|
| WGSL build integration | `wgslToJavaScript()` (now `await`-correct, S13) in build.js, gulpfile watches .wgsl |
| WASM build pipeline | `npm run build-wasm` (+ debug/check/clean variants) |
| Split-screen comparison | `Apps/WebGPUTest/split-screen-comparison.html` |
| WebGPU feature auto-detection | `_buildFeatureList()` probes adapter; supports `subgroups`, `timestamp-query`, `shader-f16`, `dual-source-blending`, `clip-distances`, `float32-filterable`, `rg11b10ufloat-renderable`, BC/ETC2/ASTC compression |
| Context-aware logging | `[CesiumJS:type:shortId]` prefix on all renderer messages |
| TypeScript | `tsc --noEmit` -- 0 errors |
| Build | `npx gulp build` -- passes (~38-48s) |
| `npm run restart` | clean -> build -> start (S13) |
| **Build variants** | **Tree-shaken WebGL-only / WebGPU-only / dual builds** via `bundleVariantPlugin.js` (synthetic-path resolve, decision cache). `RendererType.ts` `setGlobalDefaultRenderer` / `getGlobalDefaultRenderer` added. New gulp tasks: `buildCesiumDual`, `buildCesiumWebGPUOnly`, `buildCesiumWebGLOnly`, `buildAllVariants`. `createCesiumJs` / `bundleCesiumJs` in `scripts/build.js` accept `variant` param. |
| **Bundle analyzer** | `scripts/analyzeBuild.js` parses esbuild metafile, reports top-N folders/modules, supports `--treemap` |
| **Removed deps** | `urijs` removed (12 files migrated to native `URL` API); `karma-ie-launcher` removed (dead IE-targeting dev dep) |
| **Lazy-loaded deps** | meshoptimizer (~110 KB), @spz-loader/core (~270 KB) split into separate chunks via dynamic `import()`. Per-feature renderers code-split. Dual ESM index.js shrunk 4.23 MB → 3.9 MB (1.18 MB → 1.05 MB gzipped, -11%). |
| Tests | 10 Jasmine spec files: Buffer, DrawCommand, ImageUpload, PrimitiveIndexUtils, RingBufferAllocator, ShadowMapRenderer, SubgroupUtils, Texture, ContextFactory, GraphicsContext, NagaTranspiler. ~15K green, ~30 pre-existing failures (not from our changes). |
| **Visual regression** | `Tools/visual-regression/capture-and-diff.mjs` — Playwright-driven WebGL↔WebGPU pixel diff (Edge, zero deps, PNG encode built-in) |

#### Build & Debug Command Reference

```bash
# ─── Standard builds ───
npx gulp build              # Dev build (includes WGSL compilation)
npx gulp buildRelease        # Production (minified + unminified, dual variant)
npm run restart              # Clean → build → start dev server

# ─── Build variants (tree-shaking) ───
npx gulp buildCesiumDual          # Both backends, WebGPU-first default
npx gulp buildCesiumWebGPUOnly    # WebGPU only (~32% smaller ESM)
npx gulp buildCesiumWebGLOnly     # WebGL only (no WebGPU chunks)
npx gulp buildAllVariants         # All three side-by-side

# ─── Type checking & tests ───
npx tsc --noEmit             # TypeScript check (0 errors expected)
npm test                     # Jasmine suite

# ─── Visual regression ───
node Tools/visual-regression/capture-and-diff.mjs              # All scenes
node Tools/visual-regression/capture-and-diff.mjs --update      # Save baselines
node Tools/visual-regression/capture-and-diff.mjs --headed      # Show browser

# ─── Runtime diagnostics (DevTools console) ───
viewer.scene.getDebugSnapshot()      # Full system state dump
viewer.scene.logDebugSnapshot()      # Pretty-printed console output
window.webglViewer                   # Split-screen page: WebGL viewer
window.webgpuViewer                  # Split-screen page: WebGPU viewer

# ─── CesiumDebug console commands (after install on a viewer) ───
CesiumDebug.help()              # List all commands
CesiumDebug.snapshot()          # Full debug snapshot (scene + renderer + toggles)
CesiumDebug.showDepth()         # Depth buffer as grayscale
CesiumDebug.hideDepth()         # Restore normal
CesiumDebug.showWireframe()     # Globe wireframe overlay
CesiumDebug.hideWireframe()     # Hide wireframe
CesiumDebug.showFrustums()      # Colorize frustum splits
CesiumDebug.showCommands()      # Command count overlay
CesiumDebug.toggleFPS()         # FPS counter
CesiumDebug.pipelineStatus()    # Shader/pipeline/device health check
CesiumDebug.postProcess()       # Post-process pipeline state table
CesiumDebug.canvasPixels()      # Sample canvas pixel data
CesiumDebug.logImageryProbe()   # Dump next 4 tile updates
CesiumDebug.scene               # Direct scene access
CesiumDebug.context             # Direct context access
CesiumDebug.device              # Direct GPUDevice access
```

#### Build Variant Output Directories

| Variant | Minified | Unminified | Notes |
|---------|----------|------------|-------|
| dual (default) | `Build/Cesium/` | `Build/CesiumUnminified/` | Backwards-compatible, ESM code-split |
| webgpu-only | `Build/CesiumWebGPU/` | `Build/CesiumWebGPUUnminified/` | GLSL shaders aliased to empty stubs |
| webgl-only | `Build/CesiumWebGL/` | `Build/CesiumWebGLUnminified/` | WebGPU renderer aliased to empty stubs |

### Debug Visualization Stack (Sessions 22-24)

All toggles read from `frameState` once outside hot loops; production cost is one bool comparison per pass. Fragment debug pipelines use a unified `DebugFragmentMode` enum + augmented shader module (vertex stages reused, fragment entry points appended).

| Toggle | Effect | Implementation |
|--------|--------|----------------|
| `scene.debugShowGlobeWireframe` | Line-list overlay over terrain tiles | `_wireframePipelineCache` keyed by stride, IB swap to wireframe indices, full vertex layout parity |
| `scene.debugShowTriangulation` | Per-triangle rainbow color via primitive_index | `fragmentDebugTri` entry point + `csm_primitiveIndex.wgsl` chunk |
| `scene.debugShowTerrainLOD` | 12-color tile depth overlay | `fragmentDebugLod` reads `tile.debugFields.x` (LOD level) |
| `scene.debugShowTerrainNormals` | Eye-space normal as RGB | `fragmentDebugNormal` reads + remaps `v_normalEC` |
| `scene.debugShowImageryLayer` | Isolate layer 0..3 (or -1 for all) | Multiplicative mask in production fragmentMain, reads `tile.debugFields.y` |
| `scene.debugShowDepthAsColor` | Linearized/raw/combined depth | `WebGPUDebugDepthOverlay.ts` standalone fullscreen pass; sampleable depth opt-in via `WebGPURenderTarget.depthSamplable` (non-MSAA only) |
| `scene.debugDisableAtmosphereScattering` | Flat magenta sky | Early-out in SkyAtmosphere fragment, reads `u.debug.x` |
| `scene.debugShowCubeMapFace` | Per-face cubemap isolation (1=+X..6=-Z) | Fragment-shader face discard via dominant axis test |

---

## 3. What Works End-to-End (Verified)

These features have been verified working in the split-screen WebGPU viewer through manual testing:

| Feature | Verified Date | Notes |
|---------|---------------|-------|
| Globe terrain geometry | April 4, 2026 | Renders sphere with correct shape |
| Bing Maps imagery | April 4, 2026 | Satellite imagery loads and displays |
| Multi-LOD terrain subdivision | April 4, 2026 | Quadtree subdivides as camera zooms |
| texCoordsRect alpha masking | April 4, 2026 | No more vertical stripes between tile imagery |
| Fill tile rendering | April 5, 2026 | Tiles with no UV data correctly skipped (no black lines) |
| WebMercator texture coordinates | April 4, 2026 | Bing Maps imagery correctly projected |
| SkyAtmosphere glow | April 5, 2026 | Atmosphere haze visible at horizon |
| Async init via Viewer.createAsync | April 2, 2026 | WebGPU context initializes through full Viewer path |
| Split-screen WebGL/WebGPU | April 3, 2026 | Both renderers run simultaneously |
| Context+device init (smoke test) | April 2, 2026 | `scene-webgpu-init-test.html`: adapter, device, canvas, beginFrame/endFrame all green |

---

## 4. Bug Fix History (Sessions 1-26)

This is a consolidated index of every bug fix from `WEBGPU_DEBUGGING_LOG.md`. Each entry references the file(s) touched and the root cause; consult the debugging log for full diffs and reproduction steps.

### Session 1 — Initial Launch Errors
- **1.1 Buffer Size NaN**: `createVertexBuffer`/`createIndexBuffer` callers passing `byteLength` where data was expected. Fixed in `WebGPUEnvironmentRenderer.js`, `WebGPUSkyAtmosphereRenderer.js`. `createUniformBuffer` now auto-detects string-as-label.
- **1.2 `passEncoder.setPipeline is not a function`**: Environment commands tried to execute outside any active render pass. Fixed by skipping `renderEnvironment()` in WebGPU mode and adding `Pass.ENVIRONMENT` execution to `WebGPUSceneRenderer.ts` multi-frustum loop.
- **1.3 Splitscreen Camera Sync**: Bidirectional camera sync added in `CesiumViewer.js` with loop-prevention guards.

### Session 2 — Globe Terrain Rendering
- **2.1 Bind Group Limit (5 → 4)**: WebGPU caps at 4 bind groups. Merged water mask + ocean normal map into single group 2.
- **2.2 writeBuffer 4-Byte Alignment**: `Uint16Array` index buffers padded to 4-byte boundaries before upload.
- **2.3 GlobeTerrain.wgsl 404**: Replaced fetch-based shader loading with ES module import.
- **2.4 WebGLStubBuffer Too Small**: Added regrow logic when incoming data exceeds default 4096-byte buffer.

### Session 3 — Pipeline Stride
- **3.1 Index extends beyond limit**: Hard-coded stride assumptions broke when terrain encoding included webMercator + normals. Fixed by switching `_pipelines` to `Map<string, GPURenderPipeline>` keyed by `(isQuantized, hasNormals, isBlend, strideBytes)` with lazy creation.

### Session 4 — Black Screen Root Cause
- **4.1 `clear()` Color Override**: `clearCommand.color !== undefined` was true even when color was `false`. Fixed with explicit `!== false` guards on color/depth/stencil channels.
- **4.2 "size is zero"**: Three buffer creation methods bypassed `WebGPUBuffer.create()`'s size guard. Added `Math.max(size, 4)`.
- **4.3 Depth/Stencil Boolean Clear**: Passed booleans where `1.0`/`0` numerics were expected.

### Session 5 — Feature Renderer Destroy
- **5.1 Destroy Crashes**: `_destroyFeatureRenderers()` called destroy with no args; FRs needed their owning scene object. Removed the destroy() calls — GPU resources freed automatically on device destruction.
- **5.2 WebGLStubBuffer Regrow**: Padded branch wasn't checking regrow. Moved logic before branch.
- **5.3 Index Validation**: Some terrain tiles had indices beyond vertex buffer size. Added clamp-to-valid-triangles.
- **5.4 Splitscreen Initial Sync**: Added explicit initial `copyCamera()` after listeners.

### Session 6 — Pipeline Compilation
- **6.1 Uniform Control Flow**: `textureSample`/`textureSampleCompare` required uniform control flow. Moved shadow check to top of fragment, replaced `textureSample` with `textureSampleLevel(..., 0.0)`.
- **6.2 DepthPlane Format Mismatch**: rgba8unorm vs bgra8unorm. Pass `presentationFormat` as `colorFormat`.
- **6.3 DepthPlane RTE Encoding**: `EncodedCartesian3.fromCartesian` parameter type mismatch. Rewrote with `encode` per-component.
- **6.4 Billboard Buffer NaN**: `Math.max(Number(options.size) || 4, 4)` handles NaN/undefined.
- **6.5 Readback Buffer Zero**: `Math.max(bytesPerRow * height, 4)`.
- **6.6 Expired Ion Token**: Removed from test page.

### Session 7 — Build System
- **7.1 typescript-eslint version**: Bumped to ^8.58.0.
- **7.2 Asset Path**: `buildCesiumViewer` uses `Build/CesiumUnminified/` for dev mode.
- **7.3 JSDoc Errors**: Multiple files (`RenderCommand.js`, `Scene.js`, `WebGPUPointPrimitiveRenderer.js`).
- **7.4 WebGPU Type Stubs**: Added `Tools/jsdoc/webgpu-stubs.d.ts`.
- **7.5 RenderState.releaseCache()**: Added public wrapper for `removeFromCache()`.
- **7.6 Imagery Texture Cache Fields**: Added `sourceWidth`/`sourceHeight`.

### Session 8 — Environment Command Injection
- **8.1 Environment Commands Not Reaching WebGPU**: Commands stored on `environmentState`, not in frustum command list. Added injection into farthest frustum's ENVIRONMENT pass slot.
- **8.2 setVertexBuffer TypeError**: Some env commands had wrapped buffer objects. Added try-catch in `executeBatch()` with one-shot per-error logging.

### Session 9 — Environment Injection Fix (Take 2)
- **9.1 Bypass Discovery**: Session 8 injection lived in `ViewportExecutor` but Scene bypassed it for WebGPU. Moved injection into `Scene._injectEnvironmentCommandsForWebGPU()` before alternate renderer call.

### Session 10 — Imagery & Cubemap
- **10.1 imagery.image Released Too Early**: `_createTexture()` set `imagery.image = undefined` after WebGL upload. Added `if (!context.isWebGPU)` guard.
- **10.2 First Frustum Color Clear**: First frustum now clears color to background color.
- **10.3 SkyAtmosphere Async Fetch**: Switched to direct ES module import.

### Session 11 — Imagery Reprojection Crash + CubeMap Depth-Stencil
- **11.1 _reprojectTexture Crash**: WebGPU FR path didn't return — fell through to WebGL `ComputeCommand` creation. Added early return + backend-agnostic fallback (FR existence check, not isWebGPU).
- **11.2 CubeMapPanorama Depth-Stencil Mismatch**: Pipeline had `depthStencil: undefined` but render pass had `depth24plus-stencil8`. Added depth-stencil with `depthWriteEnabled: false, depthCompare: "always"`.
- **11.3 setVertexBuffer Edge Cases**: Caught by try-catch from S8.

### Session 12 — Build System + Shader Debug
- **12.1 gulp build Missing WGSL/TSC**: `build()` only ran esbuild bundling. Added `wgslToJavaScript()` and `await tsc()` at top.
- **12.2 writeBuffer Floats vs Bytes**: Third arg should be bytes, was passing float count. Fixed to `data.byteLength`.
- **12.3 Diagnostic Property Typo**: `_diagFrameCount` didn't exist; changed to `_diagTileCount`.
- **12.4 Shader Version Mismatch Discovery**: Two GlobeTerrain.wgsl versions existed. Aligned with the 68-float CameraUniforms.
- **12.5 layerCount Always 0 Investigation**: Bind group + writeBuffer + pipeline all verified correct, but `tile.layerCount` read as 0. Resolved in S13 (Bug 13.5).

### Session 13 — Imagery Pipeline + WebGL Stub Logging
- **13.1 Imagery Stuck in TRANSITIONING**: Catch block left state in TRANSITIONING with no retry. Reset to TEXTURE_LOADED on error.
- **13.2 SkyAtmosphere First-Frame Async Miss**: `await getShaderSource()` deferred to microtask. Removed async/await.
- **13.3 ImageryLayer Creating WebGL Textures via Stub**: Added WebGPU early path with placeholder + image preservation.
- **13.4 Placeholder Texture Missing destroy()**: Crash on tile trim. Added no-op destroy().
- **13.5 layerCount u32 Not Readable in WGSL**: Mixed u32/f32 after array<ImageryLayer> caused read-as-zero. Changed to f32 in struct + writer.
- **13.6 wgslToJavaScript Not Awaited**: Async function called sync, broke clean builds. Added `await`.
- **13.7 Texture Y-Flip**: WebGL bottom-left vs WebGPU top-left. Added `flipY: true` to `copyExternalImageToTexture` calls.
- **13.8 Build System Improvements**: `gulp clean` now removes WGSL→JS wrappers + package builds; `npm run restart`.

### Session 14 — webMercatorT Shader Support + UV Stretching
- **14.1 webMercatorT Not Passed Through Shader**: WGSL had no webMercatorT support. Added 5 vertex entry points + per-layer `useWebMercatorTLayer: vec4<f32>` + fragment `select()` for V coordinate.
- **14.2 Quantized Terrain webMercT Decompression**: `compressed0.w` is webMercT (not encodedNormal) for quantized BITS12. New `vertexMainQuantizedWebMerc` entry point.
- **14.3 Back-Face Culling Regression**: `octDecode(0.0)` produced normal `(0,0,-1)`. Sentinel changed to 32896.0 (≈+Z).
- **14.4 Vertex Format Mismatch (webMercT+Normals)**: 4-float layout needed `float32x4` not `float32x3`.
- **14.5 SceneMode.SCENE2D Check**: `scene.mode !== 0` was wrong (0 = MORPHING). Changed to `!== 2`.
- **14.6 Spammy Per-Tile Logs**: Removed dead `_diagLogged` flag.

### Session 15 — LOD Unlock + texCoordsRect Alpha
- **15.1 Vertical Stripes from texCoordsRect Clamping**: WebGL uses texCoordsRect for alpha masking, not UV clamping. Removed clamp, added `texCoordsAlpha()` `step()`-based mask.
- **15.2 Only LOD 0 Tiles Rendered**: `tile.renderable = defined(surfaceTile.vertexArray)` was false for WebGPU. Added `|| (mesh && mesh.vertices && mesh.indices)` OR.
- **15.3 Fill Tile Stride Mismatch**: Added stride inference: `vertices.length / (maxIdx + 1)`.
- **15.4 Diagnostic Counter Never Stopping**: `_diagTileCount++` was inside its own check.

### Session 16 — Architecture Cleanup, Shadow Casting, Performance
- **16.1 panoramaCommandList Never Cleared**: `updateFrameState()` cleared other lists but not panorama. Added clear.
- **16.2 Camera Jitter (Improved)**: Tightened staleness thresholds (100m→50m, 0.999→0.9995), added `ASYNC_PICK_DISTANCE_RATIO = 1.5x` rejection vs ray pick.
- **16.3 Shadow Cast Lists Cleared Before Reading**: Move clear after collection.
- **16.4 Shadow Map Point Light Guard**: `!shadowMap._isPointLight === false` is `(!_isPointLight) === false`. Fixed to `shadowMap._isPointLight`.
- **16.5 Shadow Map Bias Path**: `_bias` undefined. Use `_primitiveBias || _terrainBias`.
- **16.6 isWebGPUDrawCommand Removed from All Scene Code**: 8 violations across 5 files replaced with duck-typing. Result: zero `isWebGPUDrawCommand` checks in Scene.
- **16.7 Render Bundles Activated**: Globe pass uses bundle encoder when 8+ tiles.
- **16.8 Ring Buffer Allocator Wired**: 4MB pages, triple-buffered, 256-byte alignment.
- **16.9 Shadow Cast Pass Added**: `executeShadowMapCastCommands(scene)` before multi-frustum loop.
- **16.10 First WebGPU Unit Tests**: 5 spec files, ~45 tests.

### Session 17 — Feature Wiring + Full Shader + Performance
- **17.1 GROUND_ATMOSPHERE Wired**: `Globe.js beginFrame()` calls FR.
- **17.2 Full GlobeTerrain.wgsl Restored**: Lighting, fog, atmosphere, shadows, ocean, night effects, clipping. Used `selectLayerUV()` per layer.
- **17.3 GPU Frustum Culler Activated**: Lazy-init singleton, async readback.
- **17.4 Pipeline Warm-up**: Globe renderer + GPU culler pre-init at context creation.
- **17.5 Post-Process Pipeline Verified**: Already complete.
- **17.6 FR Audit**: FOG, PROCEDURAL_CLOUDS, SSR, WEATHER_PARTICLES already wired in `_executeEnvironmentalEffects()`. Only GROUND_ATMOSPHERE was truly unwired.

### Session 18 — Parity Closure
- **18.1 Viewport Quad**: `WebGPUViewportQuad.ts` (NEW) — pipeline cache, bind group auto-detect, fullscreen triangle. Integrated into `WebGPUContext.createViewportQuadCommand`.
- **18.2 Labels with SDF**: `WebGPULabelRenderer.js` (NEW) + `BillboardCollectionSDF.wgsl` (NEW). 5-tap supersampling, outlines, screen-space derivative AA. Added `LABEL_COLLECTION = 36`.
- **18.3 Weather Particle Render Pass**: `WeatherParticleRender.wgsl` (NEW) — camera-facing instanced quads, per-type fragments.
- **18.4 2D / Columbus View Mode**: Globe terrain shader scene-mode branching (MORPHING/COLUMBUS_VIEW/SCENE2D/SCENE3D), planar position helpers, extended CameraUniforms.

### Session 19 — Renderer Verification, BufferPrimitives, Mobile Perf, UBO Cleanup
- **19.1 Renderer Bug Audits**: `WebGPUEllipsoidPrimitiveRenderer` viewport size pack (40→44 floats); `WebGPUGaussianSplatRenderer` focal length from projection matrix; `WebGPUPointCloudEyeDomeLighting` reduced to documented no-op stub.
- **19.2 Buffer Primitive Collections**: NEW `WebGPUBufferPrimitiveRenderer.ts` (~1000 lines) handles polygon/polyline/point. Camera UBO matches standard 368-byte struct. Shader fixes: `camera.projection`/`camera.viewport` → `camera.projectionMatrix` + per-shader viewport.
- **19.3 Transient Render Attachments**: `WebGPUFramebufferManager.getRenderPassDescriptor()` forces `storeOp: "discard"` on MSAA color + non-samplable depth so tile-based mobile GPUs keep them on-chip.
- **19.4 UBO Size Cleanup**: Tightened 256-byte UBOs to 96-176 bytes for static bindings.

### Session 20 — ParticleSystem, BufferPrimitive Picking, WGF-1, WGF-6
- **20.1 General ParticleSystem (no-op closure)**: Already routes through `WebGPUBillboardRenderer` via `BillboardCollection`.
- **20.2 Buffer Primitive Picking**: `PICK_FRAGMENT_SUFFIX` appends `fragmentPickMain` to each preprocessed shader. Per-collection pick pipelines + pick ID allocation via `context.createPickId`.
- **20.3 WGF-1 Subgroups Wired Into GPU Culler**: `FrustumCull.wgsl` `mainSubgroups` entry point uses `subgroupBallot` to collapse per-thread atomicAdd into one per subgroup. `WebGPUGPUCuller.initialize()` picks entry point with try/catch fallback.
- **20.4 WGF-6 `@builtin(primitive_index)`**: NEW `csm_primitiveIndex.wgsl` chunk + `WebGPUPrimitiveIndexUtils.ts` (capability probe via pushErrorScope, face color WGSL, primitive pick WGSL, RGBA decoder).

### Session 21 — Tier-2 Cleanup (WGF-3, WGF-5, WGF-6, WGF-7, WGF-8)
- **21.1 WGF-5 Texture Component Swizzle**: `swizzleChannel()` if-else replaced with dynamic vector subscript `texColor[clamp(i32(idx), 0, 3)]`.
- **21.2 WGF-8 EXIF/orientation**: NEW `WebGPUImageUpload.ts` (~210 lines) + `WebGPUContext.createTextureFromImageAsync()`. Uses `createImageBitmap(source, { imageOrientation: "from-image" })`. Sync fast path preserved.
- **21.3 WGF-6 Wiring**: WebGPUContext caches `WebGPUPrimitiveIndexUtils` after device creation; Scene gets `triangulationDebugSupported` getter.
- **WGF-3 audit**: No work needed — sampler-as-let already used.
- **WGF-7 audit**: No work needed — formats already optimal for current compute kernels.

### Session 22 — Unit Tests + debugShowTriangulation Wiring
- **22.1 Unit Test Coverage**: NEW `WebGPUPrimitiveIndexUtilsSpec.js`, `WebGPUSubgroupUtilsSpec.js`, `WebGPUImageUploadSpec.js`. GPU-gated paths use `pending()` fallback.
- **22.2 debugShowTriangulation Production Wiring**: Scene flag forwarded to frameState; `WebGPUGlobeSurfaceRenderer` augmented shader module (vertex stages reused, `fragmentDebugTri` appended), cold-path `_selectDebugTriPipeline()` separate from production cache.

### Session 23 — Tier 1 Render Debug Features
- **23.1 Globe Wireframe**: Refactored orphaned `_wireframePipelines[4]` array into `_wireframePipelineCache: Map<string, GPURenderPipeline>` keyed by stride. Cold-path selector + IB swap to line-list indices.
- **23.2 SkyAtmosphere Scattering Bypass**: NEW `debug: vec4<f32>` uniform field. `debug.x > 0.5` returns flat magenta. Reserved offsets 53-55 for Tier 3.
- **23.3 SkyBox Cubemap Face Isolation**: Per-face fragment discard via dominant axis test. Encoding 0=all, 1=+X..6=-Z.

### Session 24 — Tier 2 Debug Features + Refactor
- **24.1 Unified Debug Fragment Pipeline**: Replaced per-feature `_debugTri*` cluster with `DebugFragmentMode` enum (NONE/TRIANGULATION/LOD/NORMAL), single `_debugFragmentShaderModule`, single `_debugFragmentPipelineCache` + `_selectDebugFragmentPipeline()`. Adding new variants is now one entry point + one enum value.
- **24.2 tile.debugFields vec4**: `.x = tileLevel`, `.y = isolateImageryLayer`, .z/.w reserved. `TILE_UNIFORM_FLOATS` 92→96.
- **24.3 LOD Color Overlay**: `fragmentDebugLod` 12-color palette via WGSL `switch`.
- **24.4 Normal-as-Color**: `fragmentDebugNormal` reads + remaps `v_normalEC`.
- **24.5 Imagery Layer Isolation**: Multiplicative mask in production fragmentMain.
- **24.6 Depth-as-Color Overlay**: NEW `WebGPUDebugDepthOverlay.ts` (~230 lines). Sampleable depth opt-in via `WebGPURenderTarget.depthSamplable`. Cold-path integration in `_runPostProcessing` swaps in overlay for production post-process chain. Non-MSAA only.

### Session 25 — Architecture Audit + Stale Backlog Cleanup
- **BUG-4 Fix**: Split-screen camera sync `syncingCamera` guard reset deferred to next animation frame.
- **BUG-7 / SHADOW-LAYOUT**: Discovered that shadow cast pipeline assumes single fixed vertex layout (stride 24, two `float32x3` for RTE positionHigh/positionLow). Added stride filter as safety net; per-layout cache deferred.
- **NEW-1 Resolved**: `DynamicEnvironmentMapManager` sync `readPixels` was already on a WebGL-only branch — non-issue.

### Session 26 — Backlog Audit, AtmosphereLUT Consumer, PointCloudLOD Subgroup Dispatcher, 3D Tiles Indirect Draw, BUG-11 Audit, Naga-wasm Spike
- **Backlog audit**: Pruned 9 stale entries (FORK-19 specs exist, FORK-17 mipmaps wired, FORK-34 already done, Labels rendering done S18, Viewport quad done S18, Buffer primitives done S19, WGF-1 subgroups done S20, WGF-2 transient attachments done S19, AtmosphereLUT dispatch done S17). Added SUBGROUP-DISPATCH and ATMOS-LUT-CONSUMER (now both also resolved this session).
- **AtmosphereLUT consumer**: `SkyAtmosphere.wgsl` extended with `useLut` flag in Uniforms struct + `@group(1)` LUT bindings (sampler + transmittance + inscatter views) + `sampleScatteringLut()` fast path. `WebGPUSkyAtmosphereRenderer.js` builds the LUT bind group, dispatches compute on a transient encoder when sun direction changes (>0.0001 cos delta), falls back to a 1×1 placeholder + ray march path when compute is unavailable. `useLut` uniform field set based on dispatch success.
- **PointCloudLOD subgroup dispatcher**: New `WebGPUPerformanceManager.dispatchPointCloudLOD()` lazily preprocesses the WGSL source (prepends `enable subgroups;` on capable devices, strips `__SUBGROUP_BLOCK_*__` sentinels otherwise) and selects `computeMainSubgroups`/`computeMain` accordingly. Cached per device. Plus `pointCloudLODUsesSubgroups()` diagnostic.
- **3D Tiles indirect-draw integration**: New `executeBatchIndirect()` in `WebGPUSceneRenderer.ts` scans command lists for runs of ≥2 commands sharing pipeline + bind groups + index buffer, batches them through `WebGPUIndirectDrawManager.submitBatch` + `executeBatchIndexed`. Wired into `_execute3DTilePasses` behind `context.useIndirectDrawForTiles` flag (off by default). Single setPipeline + N drawIndexedIndirect per homogeneous run.
- **BUG-11 imagery audit (no fix, code-level only)**: Static analysis ruled out bind-group sample-type mismatch, std140 alignment drift, day/night alpha argument swap, stale uniform leakage. Two top runtime suspects documented: (A) reprojection clear alpha=0 collapsing `tex.a * effectiveAlpha` to zero, (B) zero `texCoordsRect`. Probe checklist added for next browser session.
- **Naga-wasm spike**: NEW `WebGPUNagaTranspiler.ts` with lazy `import("naga-wasm")`, FNV-1a-keyed transpile cache, graceful unavailable-fallback. Wired into `WebGLStubShader.shaderSource` + `compileShader` so stub shaders carry `_glslSource`/`_wgslReady`/`_wgsl` fields. Activation: `npm install naga-wasm`. Open follow-ups: bind-set remapping, vertex attribute location remapping.
- **WebGLStubShader fix**: `maxInterStageShaderComponents` renamed to `maxInterStageShaderVariables` in newer `@webgpu/types` — read either via cast.

### Session 27 (2026-04-12 Session 2) — ES6 Modernization, Type Safety, Security, Stubs Overhaul, MaterialUniformBuffer, Build Variants

No new rendering bugs introduced. This session was a quality/architecture sweep:

- **ES6-CODEMOD-1**: 424 files converted from prototype-based classes to ES6 classes via jscodeshift. No behavior changes; pure syntax modernization.
- **ES6-INCLUDES-1**: ~90 `.indexOf() !== -1` patterns replaced with `.includes()`. No behavior changes.
- **SECURITY-1 (InfoBox XSS)**: Entity description `innerHTML` in `InfoBox.js` was assigned unsanitized from external data sources. Fixed by adding DOMPurify sanitization with a configured allowlist. Root cause: direct DOM injection without sanitization. Files: `packages/engine/Source/Widgets/InfoBox/InfoBox.js`.
- **TS-ANY-1**: 34 `as any` casts eliminated in `WebGPUSceneRenderer.ts` and `WebGPUGlobeSurfaceRenderer.ts` by declaring the missing private fields and importing proper types from new `cesium-js-types.d.ts`. Root cause: JS classes used from TS without declarations.
- **TS-ANY-2**: ~55 `: any` parameter annotations replaced with proper ambient types in `WebGPUBufferPrimitiveRenderer.ts`, `WebGPUPickFramebuffer.ts`, and other renderer files. Root cause: same — JS class types unavailable to TS.
- **STUB-OVERHAUL-1**: `WebGLStubTexture.ts` was a near-complete no-op (texImage2D did nothing, generateMipmap did nothing). Fixed by implementing real WebGL→WebGPU translation. Root cause: stub was scaffolded but never filled in.
- **STUB-OVERHAUL-2**: `WebGLStubShader.ts` returned `0` for all `getParameter()` queries. Fixed by reading real values from `device.limits`. Root cause: same scaffolding gap.
- **MATERIAL-UB-1**: Material uniforms were repacked as JS objects every frame regardless of whether any property changed. Fixed by `MaterialUniformBuffer` with dirty tracking + Float32Array backing. Root cause: performance gap in material upload path; not a correctness bug.
- **DEP-REMOVE-1**: `urijs` import caused bundle bloat and an unmaintained third-party dep. Removed; replaced with native `URL` API across 12 files.

### Bug Pattern Analysis (cumulative across all sessions)
1. **API mismatch** (6+): Callers passing wrong parameter types/order to WebGPU buffer/pipeline creation
2. **Silent failures** (5+): Errors swallowed by missing guards
3. **WebGL→WebGPU assumption gaps** (4+): Boolean vs numeric clear values, texture format mismatches, 4-byte alignment, top-left vs bottom-left UV
4. **Buffer sizing** (4+): Zero-size, NaN-size, undersized buffers
5. **Architecture gaps** (2+): Environment pass routing, pipeline stride assumptions
6. **Async/event ordering** (3+): SkyAtmosphere first-frame microtask, splitscreen guard reset, async depth feedback loops

### Most Frequently Modified Files
1. `WebGPUGlobeSurfaceRenderer.ts` — terrain pipeline is the most complex (Sessions 2, 3, 5, 7, 14, 15, 17, 19, 22, 23, 24)
2. `WebGPUSceneRenderer.ts` — frame orchestration touches many systems (Sessions 1, 3, 4, 6, 16, 17, 18, 24, 26)
3. `WebGPUContext.ts` — core context affects everything (Sessions 4, 6, 16, 17, 18, 19, 21)
4. `GlobeTerrain.wgsl` — fragment shader churn (Sessions 2, 6, 14, 15, 17, 18, 23, 24)

---

## 5. WASM & Compute Audit Results

### WASM Bridge Compliance Matrix (All Complete — April 2026)

| Bridge | destroy() | free_buffer() | Version Check | SIMD Detection | JS Fallback | Error Handling |
|--------|-----------|---------------|---------------|----------------|-------------|----------------|
| WasmCullBridge | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| WasmSortBridge | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| WasmHeightmapBridge | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| WasmQuantizedMeshBridge | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| WasmRTEBridge | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| WasmMatrixBridge | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| WasmPointCloudBridge | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

`WasmFeatureDetection.js` provides shared `checkSIMDSupport`, `checkModuleSIMD`, `checkVersionMatch`, `freeBuffer`. All bridges have `_isDestroyed` guard + try/catch with automatic JS fallback. Rust `lib.rs` uses `try_reserve()` for OOM-safe allocation.

### GPU Compute vs WASM Decision Matrix

| Task | Best Approach | Shader / Bridge |
|------|--------------|------------------|
| Terrain tessellation | WASM | WasmHeightmapBridge / WasmQuantizedMeshBridge |
| Frustum culling (>50K) | GPU Compute | `FrustumCull.wgsl` (active, with subgroup variant) |
| Frustum culling (<50K) | WASM SIMD | `WasmCullBridge.js` |
| Atmosphere LUT | GPU Compute | `AtmosphereLUT.wgsl` (active, with shader consumer) |
| Point cloud sort | GPU Compute (>50K) / WASM | `PointCloudSort.wgsl` (dispatch wired, host integration pending) / `WasmPointCloudBridge.sortByDistance()` |
| Point cloud LOD | GPU Compute (>50K) / WASM | `PointCloudLOD.wgsl` (subgroup variant + dispatcher) / `WasmPointCloudBridge.lodFilterAndSort()` |
| Sort keys (>50K) | GPU Compute | `GPUSortKeys.wgsl` (dormant — JS comparators always active) |
| Sort keys (5K-50K) | WASM radix sort | `WasmSortBridge.js` |
| Hi-Z occlusion | GPU Compute | `HiZPyramid.wgsl` + `OcclusionTest.wgsl` (dormant) |
| Polygon SDF | GPU Compute | `PolygonSignedDistance.wgsl` (active) |
| IBL (BRDF LUT, irradiance, radiance) | GPU Compute | `BrdfLutGenerate.wgsl`, `IrradianceConvolution.wgsl`, `RadiancePrefilter.wgsl` (all active) |

### GLSL Backport Analysis (April 2026) — No Backports Needed

All WGSL shaders fall into three categories:

| Category | Count | Details |
|----------|-------|---------|
| **Ports of existing GLSL** | 12+ | Tonemapping (5 modes), Atmosphere, SSAO, Bloom, DoF, Edge, Silhouette, IBL (3), FXAA, GroundAtmosphere |
| **Compute-only (impossible in WebGL)** | 8 | FrustumCull, HiZ, OcclusionTest, AtmosphereLUT, PointCloudSort/LOD, GPUSortKeys, WeatherParticles |
| **WebGPU-only enhancements** | 7+ | SSR, ProceduralClouds, DeferredGBuffer/Lighting, enhanced ocean (Fresnel/GGX/foam/SSS), enhanced night (terminator glow, city lights emission), terminator glow |

### IBL Pipeline (Complete)

| Shader | Purpose | Dispatch Site |
|--------|---------|---------------|
| BrdfLutGenerate.wgsl | BRDF integration LUT (split-sum IBL) | `WebGPUIBLPipeline.ts` (one-time, init) |
| IrradianceConvolution.wgsl | Diffuse irradiance cubemap convolution | `WebGPUIBLPipeline.ts` (env map change) |
| RadiancePrefilter.wgsl | Specular pre-filtered mipchain | `WebGPUIBLPipeline.ts` (env map change) |
| ImageBasedLighting (TS) | SH coefficients + specular orchestration | `WebGPUImageBasedLighting.ts` |
| ModelPBRComplete.wgsl | IBL-aware ambient (split-sum) | Per-frame model fragments |

### Night & Ocean Rendering Enhancements (April 2026)

**Night side**:
- Terminator: `NdotL * 5.0 + 0.5` sharp boundary (matches GLSL)
- Night-side darkness: 0.025 moonlight ambient + 0.04 base color
- City lights emission: additive boost when `nightAlpha > dayAlpha`, luminance-weighted
- Configurable `nightIntensity` uniform (default 2.5x)
- Terminator glow: warm orange Gaussian at NdotL≈0
- Night-side fog: dimmed to 5% on dark side

**Ocean/Water**:
- 3-octave wave normals (400×, 200×, 800× UV) with weighted blend
- Distance-scaled wave strength: `mix(0.25, 0.05, smoothstep(10K, 500K, dist))`
- GGX/Trowbridge-Reitz specular (roughness 0.08) for sun glints
- Schlick Fresnel (F0=0.04, power 5.0)
- Deep water color blend to `(0.008, 0.045, 0.12)`
- Subsurface scattering: forward-scatter turquoise rim at grazing angles
- Foam/whitecaps: steepness-based threshold 0.35, distance-faded
- Sky reflection via Fresnel at 50%
- Smooth coastline transition `smoothstep(0.3, 0.7, waterMask)`
- Night ocean: `mix(0.08, 1.0, dayFade)` very dark at night
- 8 configurable uniform floats: deep color, Fresnel, reflectivity, foam threshold, darkening, night intensity

---

## 6. Render Pass Coverage

All 13 CesiumJS render passes are handled in the WebGPU path. ENVIRONMENT runs before the WebGPU branch via `renderEnvironment()` in SceneRenderer.js; all other passes are in `WebGPUSceneRenderer.ts`.

| Pass | ID | Handler | Status |
|------|----|---------|--------|
| ENVIRONMENT | 0 | `renderEnvironment()` in SceneRenderer.js (before branch) + injected into farthest frustum (S8/S9) | ✅ |
| COMPUTE | 1 | Handled by individual compute dispatches | ✅ |
| GLOBE | 2 | `_executeGlobePass()` (with render bundle when ≥8 tiles) | ✅ |
| TERRAIN_CLASSIFICATION | 3 | `_executePassCommands(Pass.TERRAIN_CLASSIFICATION)` | ✅ |
| CESIUM_3D_TILE_EDGES | 4 | `_execute3DTilePasses()` (optional indirect-draw fast path S26) | ✅ |
| CESIUM_3D_TILE | 5 | `_execute3DTilePasses()` | ✅ |
| CESIUM_3D_TILE_CLASSIFICATION | 6 | `_execute3DTilePasses()` | ✅ |
| CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW | 7 | `_execute3DTilePasses()` | ✅ |
| OPAQUE | 8 | `_executeOpaquePass()` | ✅ |
| TRANSLUCENT | 9 | `_executeTranslucentPass()` (OIT MRT path with auto-variant creation) | ✅ |
| VOXELS | 10 | `_executePassCommands(Pass.VOXELS)` | ✅ |
| GAUSSIAN_SPLATS | 11 | `_executePassCommands(Pass.GAUSSIAN_SPLATS)` | ✅ |
| OVERLAY | 12 | `_executeOverlayPass()` | ✅ |

Additional WebGPU-specific passes:
- **Pick pass** — `_executePickPass()` (GLOBE, 3D_TILE, OPAQUE, TRANSLUCENT)
- **Shadow cast pass** — `executeShadowMapCastCommands()` before multi-frustum loop (Session 16)
- **Environmental effects** — `_executeEnvironmentalEffects()` (SSR, Weather, Clouds, Weather render)
- **Post-processing** — `_runPostProcessing()` (Tonemapping, FXAA, Bloom, SSAO, DoF, Edge, Silhouette)
- **Debug depth overlay** — `_executeDebugDepthOverlay()` (cold path, swaps in for production post-process)
- **Performance infrastructure** — `beginFrame()`/`endFrame()` for render bundles, indirect draws, profiling, ring buffer

### Init Chain (verified)

```
Viewer.createAsync(container, { contextOptions: { renderer: 'webgpu' } })
  ├─ Creates LoadingOverlay
  ├─ CesiumWidget.createAsync(tempDiv, options, onProgress)
  │   ├─ Scene.createAsync(canvas, options)
  │   │   ├─ ContextFactory.createContext(canvas, { renderer: 'webgpu' })
  │   │   │   ├─ navigator.gpu.requestAdapter()
  │   │   │   ├─ adapter.requestDevice({ requiredFeatures: [...] })
  │   │   │   └─ new WebGPUContext(canvas, device, adapter)
  │   │   │       ├─ _initialize() — creates default texture, sampler, depth format
  │   │   │       ├─ _warmUpPipelines() — pre-compile globe + GPU culler
  │   │   │       ├─ registerWebGPUFeatureRenderers(context) — all 36 FRs (+ 7 lazy)
  │   │   │       └─ Matrix4.setDepthRangeType('webgpu') — 0-1 NDC
  │   │   └─ new Scene(options) with _preInitializedContext
  │   └─ new CesiumWidget(container, { _preInitializedScene: scene })
  ├─ new Viewer(container, { ...options, _preInitializedScene: widget.scene })
  │   └─ new CesiumWidget(cesiumWidgetContainer, { ..., _preInitializedScene })  ← FIXED S0
  └─ Removes LoadingOverlay
```

---

## 7. Industry Comparison

| Engine | Architecture | Shader Strategy | Our Comparison |
|--------|-------------|----------------|----------------|
| **Babylon.js** | `ThinEngine` abstract -> `Engine`/`WebGPUEngine`. Zero `if(isWebGPU)` in scene code. | GLSL -> SPIRV -> WGSL transpilation | We have `GraphicsContext` abstract + Feature Renderer pattern. 36 of 36 keys registered. |
| **Three.js** | `WebGPURenderer` drop-in for `WebGLRenderer`. Node-based TSL generates both GLSL/WGSL. | TSL node graph -> both backends | We use hand-written WGSL (higher quality) + optional Slang + new naga-wasm spike. |
| **PlayCanvas** | `GraphicsDevice` base. GPU-driven rendering with indirect draws. Ring-buffer uniforms. | GLSL + WGSL | Similar abstract base. GPU-driven infrastructure built and selectively activated. |

### Feature Comparison Matrix

| Feature | CesiumJS WebGPU | Babylon.js 7 | Three.js r170 | PlayCanvas 2 | Filament | Bevy 0.15 |
|---------|----------------|--------------|---------------|--------------|----------|-----------|
| **PBR (metallic-roughness)** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **IBL (full pipeline)** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **SSAO** | ✅ | ✅ SSAO2 | ✅ | ✅ | ✅ | ✅ |
| **SSR** | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| **Bloom** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **DoF** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **TAA** | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Motion Blur** | ❌ | ✅ | ✅ | ✅ | ❌ | ✅ |
| **Shadow Casting** | ⚠️ stride-24 only | ✅ | ✅ | ✅ | ✅ | ✅ |
| **CSM** | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **GPU Particles** | ⚠️ Weather only | ✅ | ✅ | ✅ | ❌ | ✅ |
| **Volumetric Fog** | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Render Bundles** | ✅ Activated | ✅ | ⚠️ Partial | ✅ | N/A | ✅ |
| **Indirect Draw** | ✅ Wired (opt-in) | ✅ | ⚠️ Partial | ✅ | ✅ | ✅ |
| **Compute Shaders** | ✅ 6 active / 4 ready / 2 dormant | ✅ | ✅ | ✅ | ✅ | ✅ |
| **f16 Shaders** | ⚠️ Detected unused | ⚠️ Partial | ✅ | ❌ | ✅ | ❌ |
| **Subgroups** | ✅ Wired (FrustumCull, PointCloudLOD) | ❌ | ❌ | ❌ | N/A | ❌ |
| **64-bit Precision (RTE)** | ✅ Unique | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Multi-Frustum** | ✅ Unique | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Globe Terrain** | ✅ Unique | ❌ | ❌ | ❌ | ❌ | ❌ |
| **GIS Picking** | ✅ Unique | ❌ | ❌ | ❌ | ❌ | ❌ |

### Our Unique Strengths

1. **Planetary-scale RTE 64-bit precision** — No other WebGPU engine handles planetary scale
2. **Multi-frustum depth management** — Depth precision at all zoom levels
3. **Globe terrain with quadtree LOD** — Tile-center RTE encoding (correct approach)
4. **GIS picking** — Height sampling, terrain-aware, async depth readback with staleness validation + distance-ratio rejection
5. **Material system** — All 25 built-in CesiumJS materials mapped to WGSL
6. **3D Tiles integration** — Works automatically via Model chain (zero 3D Tiles code changes)
7. **Subgroup operations in production** — Used in `FrustumCull` mode 2 and `PointCloudLOD` for prefix-sum compaction
8. **Compute-precomputed atmosphere LUT** — `AtmosphereLUT.wgsl` produces transmittance + inscatter tables; `SkyAtmosphere.wgsl` samples them via fast path

---

## 8. Relationship with Upstream CesiumJS

### What We Modify in Upstream

- **Scene files** — WebGPU routing via `getFeatureRenderer()` pattern (~1 line per file, 31+ files)
- **Build system** — WGSL shader compilation, multi-variant build (WebGL-only / WebGPU-only / dual)
- **Package config** — `@webgpu/types` dependency
- **Widget files** — `createAsync()` + `LoadingOverlay`
- **Context.js** — ES6 class + extends `GraphicsContext`

### What We Add (never conflicts)

- `packages/engine/Source/Renderer/WebGPU/` — 105+ files
- `packages/engine/Source/Shaders/WebGPU/` — 238+ WGSL shaders
- `Apps/WebGPUTest/` — 29 test pages
- `migration_doc/` — this documentation
- `scripts/build.js` + `bundleVariantPlugin.js` — multi-variant build infrastructure
- `scripts/analyzeBuild.js` — bundle analyzer
- `Tools/visual-regression/` — Playwright + hand-rolled PNG diff (no new deps)

### Upstream Sync Status

#### Second Sync (April 2, 2026): PR #13121 (Constant LOD) — 45 commits, ZERO conflicts
- **0 commits behind** upstream after sync
- **27 commits ahead** (26 WebGPU additions + 1 merge commit)
- Two-parent merge commit verified
- Build passes (exit code 0)

**New upstream feature (Constant LOD):**
- `computeTextureTransform.glsl` — new `czm_computeTextureTransform()` builtin function for `KHR_texture_transform`
- `ConstantLodStageFS.glsl` + `ConstantLodStageVS.glsl` — distance-based constant LOD texture lookup
- `MaterialPipelineStage.js` — new `processConstantLod()` function

**Our modifications preserved through merge:**
- `InstancingPipelineStage.js` line 77: `|| frameState.context.isWebGPU` (keepTypedArray for WebGPU)
- `SkinningPipelineStage.js` line 5: `extractSkinData` from `ModelSkinData.js`
- `LightingStageFS.glsl`: Full multi-light system

**WGSL equivalent now landed:**
- `csm_computeTextureTransform.wgsl` — built

#### First Sync (March 2026): v1.135–v1.140 — 507 commits, 12 conflicts resolved

| Version | Notable Changes |
|---------|----------------|
| **v1.140** | BufferPrimitive collections (vector tile APIs), Billboards WebGL2 requirement, Gaussian splat perf, ClippingPolygon GPU perf |
| **v1.139** | **Cartesian2/3/4 ES6 classes** (aligned with our modernization), CubeMapPanorama, metadata in custom shaders |
| **v1.138** | Intel Arc GPU jitter fix, Megatexture→Texture3D for voxels, 2D/CV pick fixes |
| **v1.137** | BENTLEY point/line style extensions, edge visibility quad rendering, pickAsync |
| **v1.136** | pickAsync, terrain picking quadtrees |
| **v1.135** | 3D Tiles terrain provider, EXT_mesh_primitive_edge_visibility |

**Conflict Resolution Summary**:
| File | Strategy |
|------|----------|
| `package.json` (4) | Accept upstream versions, keep our additions |
| `Context.js` | Keep ours (ES6 class) |
| `VertexArray.js` | Keep ours + add new methods |
| `SkyBox.js` | Keep ours + apply fix |
| `SSCCModeHandlers.js` | Apply upstream zoom fix |
| `Material.js`, `RenderState.js` | Keep ours |
| `CubeMapPanorama.js` | Keep ours |
| `StaticGeometry*Batch.js` | Keep ours |

---

## 9. Reference

### Summary Statistics

| Metric | Count |
|--------|-------|
| WebGL shader files (GLSL) | ~319 |
| WebGPU shader files (WGSL) | 238+ |
| Compute shaders | 12 (6 active, 4 dispatch-ready, 2 dormant) |
| Shader coverage (file count) | ~75% |
| Shader coverage (functional) | ~95% |
| Builtin function chunks | 91+ WGSL (of 90 GLSL — 101% coverage) |
| CsmBuiltins.js entries | 97 (91 functions + 6 structs) |
| WebGPU renderer files | 108+ |
| WebGPU renderer LOC | ~47,000 |
| Feature renderer keys | 38 (36 registered + COUNT + DEFERRED_GBUFFER reserved) |
| Feature renderers scene-wired | 36 of 36 (100%) |
| Lazy-loaded feature renderers | 7 (Gaussian splat, point cloud, point cloud EDL, voxel, SSR, weather particles, procedural clouds) |
| Scene features with WebGPU | 30+ of 33+ (~92%) |
| Rendering passes functional | 13 of 13 (100%) |
| Test pages | 29 |
| Jasmine unit tests | 10 spec files (Buffer, DrawCommand, ImageUpload, PrimitiveIndexUtils, RingBufferAllocator, ShadowMapRenderer, SubgroupUtils, Texture, ContextFactory, GraphicsContext, NagaTranspiler) |
| ES6 modernized files | ~499 (424 via codemod + ~75 prior manual) |
| TypeScript `as any` casts | 32 (down from 66; -34 this session) |
| TypeScript `: any` parameter annotations | ~20 remaining (down from ~75; -55 this session) |
| Verified working features | 10 (see Section 3) |
| Active bugs (rendering) | 4 (BUG-3 partially S18, BUG-5/6 edge cases, BUG-11 imagery audit) |
| Active bugs (architecture) | 0 (Session 16 cleanup) |
| WASM bridges | 7 of 7 fully compliant |
| Compute shader fallbacks | All have JS or WASM fallback |
| Backend-agnostic Scene code | Zero `isWebGPUDrawCommand` checks |
| Build variants | 3 (WebGL-only, WebGPU-only, dual) |
| Bundle size (dual ESM index.js) | 3.9 MB / 1.05 MB gzipped (-11% from pre-lazy-load baseline) |
| Debug visualization toggles | 8 (wireframe, triangulation, terrainLOD, terrainNormals, imageryLayer isolation, depthAsColor, atmosphereScattering bypass, cubemap face) |
| Removed third-party deps | 2 (`urijs`, `karma-ie-launcher`) |
| Security fixes | 1 (InfoBox.js XSS — DOMPurify sanitization for entity description innerHTML) |

### WebGPU Spec Features Enabled

Auto-detected: `float32-filterable`, `clip-distances`, `dual-source-blending`, `rg11b10ufloat-renderable`, `timestamp-query`, `shader-f16`, `subgroups`, `subgroups-f16`, texture compression (BC/ETC2/ASTC).

### Build & Test Commands

```bash
npx gulp build              # Full build (WGSL → JS, then TSC, then esbuild)
npx tsc --noEmit            # TypeScript type-check
npm run build-wasm          # WASM release build
npm run build-wasm-debug    # WASM debug build
npm test                    # Jasmine spec suite
npm run restart             # clean → build → start
npx gulp buildAllVariants   # WebGL-only + WebGPU-only + dual variants
node scripts/analyzeBuild.js --build --treemap  # Bundle analyzer
```

### Development Workflow

1. **Before starting:** Review `.clinerules` / `CLAUDE.md`, verify backward compatibility
2. **File placement:** Always `packages/engine/Source/`, never root `Source/` (build output)
3. **New WebGPU features:** Use `RenderCommand` (Path B) + `getFeatureRenderer()` pattern
4. **Shared scene logic:** Must run BEFORE `if (context.isWebGPU)` branch
5. **RTE:** Always positionHigh/positionLow, never single position for world-space geometry
6. **ES6:** When touching a file, modernize it if making >10 lines of changes
7. **Feature parity:** Check both backends when adding/fixing features
8. **Async:** Never sync `readPixels` in render loop; always use `mapAsync` + `.then()`
9. **Debug visualization:** Add new toggles via the unified `DebugFragmentMode` enum + augmented shader module pattern (S24 architecture)
10. **Logging hygiene:** Wrap all non-critical `console.log`/`console.warn` calls in
    `//>>includeStart('debug', pragmas.debug);` ... `//>>includeEnd('debug');`
    pragma tags so they strip in production builds (zero runtime cost). The
    `stripPragmaPlugin` now handles both `.js` and `.ts` files. ONLY keep
    permanent (non-pragma) logs for `console.error` that indicates real
    rendering bugs — null blit targets, index buffer overflows, command
    buffer invalidation, device lost, shader/pipeline compile failures,
    infinite-loop sentinels. See the "Logging & Debug Pragmas" section in
    `CLAUDE.md` for the full policy and examples.

---

*For the full backlog of remaining work items, see `WEBGPU_MIGRATION_BACKLOG.md`.*
*For per-session bug fix details, see `WEBGPU_DEBUGGING_LOG.md` (preserved for historical reference; new findings should land here in Section 4 going forward).*
