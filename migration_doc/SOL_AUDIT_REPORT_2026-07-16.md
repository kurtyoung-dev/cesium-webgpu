# AUDIT SYNTHESIS — "GPT 5.6 Sol" Uncommitted Work (2026-07-12..16)

**Subject:** 246 modified + 77 untracked files on top of HEAD `a54cc06` (dirty tree = audit subject).
**Safety snapshot:** branch `sol-backup-2026-07-16` (`22f4994d`) — untouched.
**Standard:** Fork Architecture Charter (CLAUDE.md) + Sol's own stated rules (feature-preservation invariant, claim-boundary discipline).
**Coverage note:** This synthesis consolidates the cohort reviewer payloads received (cohorts A through I; cohort I arrived truncated mid-entry — its headline finding was independently re-verified against the working tree during synthesis). Panel-verdict text was not received verbatim in the synthesis payload; the C9 verdict below is grounded in the cohort-level verdicts and ledger-truth checks, which were unanimous in direction.

---

## 1. Overall Assessment

**Verdict: SOUND — approve with a short mandatory fix list before resuming Campaign 9.**

Sol's four days produced high-quality, correctness-first engineering with unusually honest evidence discipline. Every cohort reviewer independently reached SOUND (three with reservations), and — critically — the Campaign-9 ledger survived adversarial truth-checking in every cohort: claims reproduce from code and on-disk artifacts, statuses are conservatively marked PARTIAL/PAUSED, and the two discrepancies found run in the *safe* direction (implemented-with-specs work that was never ledgered). Sol even recorded an honestly-FAILING oracle (the C9-02B depth-plane horizon oracle) rather than claiming acceptance — rare and commendable.

**The strongest work** is architectural: the ClipSpaceConvention refactor (kills the `Matrix4._depthRangeType` process-global), per-context GraphicsCapabilities (kills the `ContextLimits` global), the 40-bit shader-module cache key (closes the bit>=24 aliasing hazard by construction), the GPUSortKeys canonical-distance repack (closes a real RTE-class precision bug AND an inverted-layer-ordering bug), the pooled-device lifecycle hardening, and the merged group-2 bind-group cache. These are genuine multi-context correctness fixes the fork has needed, with strong new spec coverage (~20+ focused spec files).

**Charter compliance is clean where it matters most:** zero RTE violations (the sort repack *strengthens* RTE discipline), zero TypeScript `any`, zero ShaderDefine reordering, canonical source paths respected everywhere, Scene files stay backend-agnostic (TAA jitter actually moved *out* of Scene), and JSDoc preserved. Violations found are policy-level, not mechanical: FAR-003 default-offs (plan-sanctioned, but the OIT gate is user-visible and unratified), explicit-`webgpu` no longer falling back to WebGL, `loadKTX2`/sync-`new Scene()` signature breaks, three new modules authored in JS rather than TS, and load-bearing doc drift on the removed `setDepthRangeType` mechanism.

**Sol introduced a small number of real defects** — the worst being: (1) the pick-pass depth-plane draw makes visible point primitives unpickable at default settings (disclosed, fix queued but regression left live); (2) an incomplete three-site point-shadow clip-space migration that breaks globe point-light shadow receive on WebGPU (verified: `GlobeTerrain.wgsl:2766` still remaps `0.5z+0.5` against a cast pass now writing raw `[0,1]`); (3) an undisclosed sync-pick semantics change that returns empty results during any cursor motion; (4) a Color-type polyline batching regression (N draws where 1 sufficed); (5) a latent uniform-ring flush hazard in `readPixelsAsync`. All are cheaply fixable.

**Sol did NOT introduce the scary-sounding broad-suite failures.** The Renderer 20 / DataSources 10 / Scene 47 failures, the HDR pick-format fleet drift, the depth-plane log-depth contract mismatch, `DataSourceCollection.contains()` calling a nonexistent method (traced to pre-Sol codemod `39f5341e64`), the KMZ URI fallthrough, `destroyObject` ES6 gaps, and Resource URL semantics are all **pre-existing** defects Sol found, root-caused, and honestly queued — verified by empty `git diff HEAD` on the relevant files.

---

## 2. Consolidated Ratings Table (worst-first)

| # | Implementation | Rating | One-liner |
|---|---|---|---|
| 1 | Point-shadow clip-space receive migration (ModelPBRComplete + csm chunk + ShadowMap.js scaleBias) | **2** | Coherent where applied but MISSED the third receive site — `GlobeTerrain.wgsl:2766` still remaps `0.5z+0.5` against raw-`[0,1]` cast depth, breaking globe point-light shadows on WebGPU. |
| 2 | Polyline exact-material-identity grouping + 60-frame retirement grace | **3** | Fixes real Glow/Dash first-material UBO aliasing, but degrades N default ColorType polylines from 1 batched draw to N groups/UBOs/draws — the Color shader is per-instance and needs no identity split. |
| 3 | FAR-003 unsafe-defaults containment (GPU cull / HiZ / sort / tile-indirect / OIT fail-closed) + getContainmentStats | **4** | Disciplined, plan-sanctioned, truthfully diagnosed containment — but the OIT default-off is user-visible (MRT OIT → sorted alpha) with no visual probe, no public re-enable hook, and no maintainer ratification. |
| 4 | Per-frustum pick-pass rewrite + classification packed-depth checkpoints | **4** | WebGL-mirroring per-slice passes, classification finally executes in pick, leak-proof try/finally — but ships with the depth-plane log-depth defect live and silently skips legacy pick commands. |
| 5 | Depth-plane pick pipeline parity + multi-frustum uniform ring (C9-02A/B) | **4** | Fixes a real queue-ordering uniform hazard; acceptance honestly paused behind the truthfully-failing horizon oracle. |
| 6 | HDR pick format authority (`context.pickPipelineFormat`) + decode-gate widening | **4** | Correct single authority; only DepthPlane + PointPrimitive migrated — the fleet closure is honestly queued, not claimed. |
| 7 | Hover latest-wins two-slot scheduler (Picking.pickHoverAsync) | **4** | Fixes hover starvation; minor publish-order inconsistency and a doc-conformant-but-silent result-shape change. |
| 8 | Device lifecycle hardening (create rollback, terminal loss, refcounted validation wrapper, effects-cache leases, destroy drains) | **4** | Systematically closes pooled-device multi-context hazards; docked for complexity risk + shared-device log attribution. |
| 9 | Timestamp profiler unique-sample accounting + ring-buffer coalesced flush + perf-manager gates | **4** | Evidence-integrity contract done right, 25 spec cases; ring-flush invariant holds only by call-graph inspection (and readPixelsAsync violates it — see P0). |
| 10 | Terrain camera/tile UB ring staging (FAR-303 prep slice) | **4** | Well-designed dirty-page staging, correct endFrame ordering; introduced the readPixelsAsync flush gap. |
| 11 | Globe pick-pass restructure (always-contribute depth, isWebGPUDrawCommand tag, pick-frame-gated derived command) | **4** | Restores classification picking over terrain, WebGL parity, artifact-backed. |
| 12 | C9-01 opt-in logical counters + lifetime-consistent destroy | **4** | Clean opt-in instrumentation with a real cache-retry fix; runtime-gated (not pragma-stripped) diagnostics + a new globalThis handshake. |
| 13 | Multi-context imagery/KTX2 hygiene (Request.ktx2TranscodeTargets chain) | **4** | Coherent end-to-end; `loadKTX2` release hard-throw is an unannounced API break for external callers. |
| 14 | GraphicsCapabilities per-context limits (+ real upstream ETC2 typo fix) | **4** | Kills the last-context-wins global; `ContextLimits` left exported-but-permanently-zero. |
| 15 | Feature-renderer readiness state machine with generation tokens | **4** | Kills stale-generation self-install; `failed` is now terminal per generation — transient chunk fetch failure permanently disables a feature. |
| 16 | ContextFactory attempt-plan + RendererBuildCapabilities + staged diagnostics | **4** | Testable policy/mechanism split; explicit-`webgpu` hard-fail reverses shipped fallback behavior without charter amendment. |
| 17 | CommandOrdering canonical module + collections wiring + CPU/GPU sorter unification | **4** | Closes the WebGPU sortLayer/sortPriority parity hole with one backend-neutral contract; minor silent clamping of public fields. |
| 18 | Scene transactional construction / createAsync transaction / field-based destroy drain (FAR-102/103) | **4** | Fixes a historical leak class, +293 spec lines; empty-catch teardown swallowing and a documented sync-constructor breaking change. |
| 19 | C9-06 celestial extinction exact-scalar cache + StarField zero-gate | **4** | Provably complete cache key; the `fr.prepare` warm-keep hook is unwired on both backends (dusk cold-start) and Moon is unmigrated. |
| 20 | MaterialUniformBuffer facade→mirror rework + per-consumer version cursors | **4** | Fixes in-place-mutation loss and dirty-flag starvation while restoring the upstream stable-uniform-object contract; per-access sync walks on a hot path. |
| 21 | Metadata descriptor cache + negative cache + ModelPrimitiveGeometry memoization + feature-ID allocation reduction | **4** | Sound invalidation semantics, negative-path premise independently proven; ~900 lines of manual signature capture that needs the queued revision token. |
| 22 | DataSourceDisplay transactional construction rollback (FAR-103) | **4** | Correct reverse-order, identity-guarded unwind with strong failure-injection specs; silent catch{} and EntityCluster private-field reach. |
| 23 | Merged group-2 instance bind-group cache | **5** | Identity-keyed, GC-correct, first-frame default reuse, 6-case spec + live zero-creation probe; no correctness gap found. |
| 24 | WebGPUPickFramebuffer staging + readback-region rework | **5** | Request-owned buffers, sequence guards, edge clipping — fixes real races; the one blemish (sync exact-region gate) is listed as P0 #3. |
| 25 | FAR-106 atmosphere fog LUT world-position fix | **5** | One-line, provably correct; camera-independent fog direction bug killed. |
| 26 | ClipSpaceConvention refactor (Matrix4 + 4 frusta, kills the depth-range global) | **5** | Textbook multi-context architecture with per-convention caches and excellent specs; only doc drift remains. |
| 27 | Shader-module cache 40-bit full-define-identity key + pipeline-cache de-salting | **5** | Bijective, fail-loud, closes the high-bit aliasing hazard by construction; all salt consumers reconciled. |
| 28 | GPUSortKeys canonical-distance + 8-bit-layer repack | **5** | Fixes an inverted public-layer-ordering bug AND an Earth-scale f32 precision bug; uploads the CPU's canonical f64 distance — exactly the charter's RTE rule. |

Median rating: 4. Distribution: one 2, one 3, twenty 4s, six 5s.

---

## 3. P0 — Must fix before resuming Campaign 9 (Sol-introduced only)

1. **Point picks broken at defaults (log depth + depth plane).** `packages/engine/Source/Renderer/WebGPU/WebGPUSceneRendererPickPass.ts:478`. Sol's own horizon oracle proves front-side point picks return null at 20/500/5000 km. **Fix:** temporarily gate `host._renderDepthPlane(config, "pick")` behind completion of NEW-WEBGPU-DEPTH-PLANE-LOG-DEPTH-CONTRACT (reverting pick behavior to pre-change state), OR land the contract now (log-depth frag-depth path in `PointPrimitivePick.wgsl` + unify DepthPlane encode near/far with `_logDepthEncodeNearFar`). Do not resume other C9 work with this live.

2. **Globe point-light shadows broken on WebGPU (incomplete 3-site migration).** `packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl:2766` — `zAttached = zNdcWebGpu * 0.5 + 0.5` while the cast pass (ShadowMap.js convention-aware scaleBias) now writes raw `[0,1]`; the sibling sites (`ModelPBRComplete.wgsl:1714`, `csm_samplePointShadow.wgsl:44`) were migrated. **Fix:** drop the remap at the globe site to match, then re-verify with a point-shadow probe. (Independently re-verified during synthesis: it is the only remaining `zNdcWebGpu * 0.5` site engine-wide.)

3. **Sync `scene.pick()` returns empty during cursor motion (undisclosed).** `packages/engine/Source/Renderer/WebGPU/WebGPUPickFramebuffer.ts:567` — the exact-region cache gate defeats the documented continuous-hover warm-up pattern. **Fix:** decode from the cached region when the current query's center lies inside it (same attachment generation), or fall back to the cached center pixel; at minimum disclose the new semantics in the ledger + cold-pick warning text.

4. **`readPixelsAsync` submits the frame encoder without flushing the staged uniform ring.** `packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts:~2957`. Latent today but a real ordering hazard the FAR-303 staging introduced. **Fix (one line):** `this._uniformAllocator?.flush();` before `encoder.finish()`; audit any other mid-frame finish/submit path.

5. **Color-type polyline batching regression.** `packages/engine/Source/Renderer/WebGPU/WebGPUPolylineRenderer.js:306` — exact-identity grouping splits N default solid-color polylines into N groups/segment-buffers/UBOs/bind-groups/draws for zero correctness gain (Color shader reads per-instance `@location(4)`). **Fix:** key Color-type materials by material TYPE (or packed uniform value); keep exact-identity only for UBO-consuming types (Glow/Dash/Arrow/Outline). Or accelerate FAR-307.

6. **Maintainer ratification gate (decision, not code):** two shipped-behavior reversals must be explicitly ratified or reverted before commit: (a) WebGPU MRT OIT default-off (`_webgpuOITEnabled=false`, `WebGPUSceneRendererEnsureResources.ts:351`) — requires a before/after translucent-intersection visual probe + a `CesiumDebug.webgpuOIT()` toggle + a ledger row naming the owning ID; (b) explicit `renderer:'webgpu'` now throws instead of falling back to WebGL (`RendererType.ts:169`) — either append a WebGL attempt when `buildCapabilities.webgl`, add a `strictRenderer` opt-in, or amend the charter's graceful-fallback language.

---

## 4. P1 — Should fix during the campaign

1. **TAA + custom frustum throws every frame mid-executeCommands** (`WebGPUSceneRenderer.ts:1824`) — fall back to un-jittered `frustum.projectionMatrix` with a one-time pragma-wrapped warn; keep the throw debug-only.
2. **StarField `fr.prepare` hook unwired on both backends** (`Context.js:777`, `WebGPUFeatureRenderers.ts:393`) — dusk cold-start / late star pop-in; wire `prepareWebGLStarField` + a WebGPU prewarm equivalent, add a StarFieldSpec case.
3. **Feature-renderer `failed` state is terminal per generation** (`GraphicsContext.ts:2010`) — add a bounded retry or `retryFeatureRenderer(key)` so one transient chunk-fetch failure can't disable a feature for the session.
4. **`ContextLimits` exported-but-permanently-zero** (`ContextLimits.js`, exported from `packages/engine/index.js:123`) — mirror-populate from the first created context or deprecate loudly; do not leave inert.
5. **Doc drift on removed mechanisms** — update `SHADER_PAIRS_LOCKSTEP.md:260`, `WEBGPU_MIGRATION_STATUS.md` (~1932/2103/2693), and `ARCHITECTURE.md` to describe ClipSpaceConvention + GraphicsCapabilities; fix the stale `GlobeTerrain.wgsl:3292` comment describing the removed `v_positionMC + cameraWC` convention.
6. **Silent teardown catches** — add permanent `console.error` in `Scene.js` `destroySceneResources` cleanup() and `DataSourceDisplay.js` `runConstructionCleanup` (fork logging rule: real errors must reach the console).
7. **Invalid renderer string now throws in all builds** (`RendererType.ts:124`) — restore warn+AUTO in release, keep the throw debug-only.
8. **`loadKTX2` + sync-`new Scene()` breaking changes** — record in CHANGES.md/migration notes (external callers of `Cesium.loadKTX2(url)` and sync `renderer:'auto'` constructors now throw).
9. **Ledger under-claims** — add PARTIAL rows for the implemented-but-unlisted timestamp unique-sample accounting and clustered-lighting zero-work (§3.2 declares unlisted = NOT STARTED; both have specs).
10. **`DataSourceCollection.contains()` one-liner** (pre-existing, item 68) — `return this._dataSources.indexOf(dataSource) !== -1;` + the item-68 spec matrix. Trivially cheap, 100%-broken public API; pull forward.
11. **Non-native pick command silent skip** (`WebGPUSceneRendererPickPass.ts:647`) — pragma-wrapped one-shot warning naming the command owner.
12. **Debug snapshot `containment.renderScheduler.capable` hardcoded `true`** (`Scene.js:~2003`) — derive from `defined(this._renderScheduler)`.
13. **Moon still on uncached extinction integrator** (`Moon.js:183`) — adopt `computeAtmosphereExtinctionCached` (part of closing C9-06).
14. **Ring-allocator invariant undocumented** (`WebGPURingBufferAllocator.ts:340`) — document the single-producer/no-mixed-writes rule at `allocate()`; effects-cache frameNumber `?? 0` fallback needs a debug assert or slot cap.
15. **Shared-device log attribution** (`WebGPUContext.ts:2334`) — join all leased context IDs instead of an arbitrary one.
16. **New JS-not-TS modules** (`CommandOrdering.js`, `WebGPUMaterialUploadState.js`, `WebGPUModelMetadataCache.js`, `WebGPUEffectsStateCache.js`) — convert or add co-located `.d.ts` in a follow-up batch.
17. **PNTS typedArray retention cost** (`PntsLoader.js:441`) — record in FEATURE_INVENTORY/DEFERRED_WORK alongside the GltfLoader entry; fold into FAR-204/NEW-PICK-ID-OWNERSHIP-MODEL.

---

## 5. Campaign 9 Verdict

**SOUND TO RESUME — with the amendments below applied first.**

Grounds: (a) every cohort's ledger-truth check passed, with errors running toward under-claiming; (b) honest-negative evidence exists (failing C9-02B oracle recorded as failing); (c) the pre-existing/introduced defect boundary was maintained with discipline (found regressions queued as items 65/67/68/70, NEW-WEBGPU-HDR-PICK-FORMAT-CLOSURE, NEW-WEBGPU-DEPTH-PLANE-LOG-DEPTH-CONTRACT, NEW-WEBGPU-POINT-BLENDOPTION-SYNC, NEW-COLLECTION-PICK-2DCV-PIPELINE-KEY-PARITY, item 69 bulk-cluster, item 72 broad-suite gate — all verified untouched-at-HEAD where claimed); (d) FAR-003/FAR-101/FAR-102/FAR-103/FAR-104/FAR-106/FAR-303/FAR-309/FAR-204 claims all reproduce from code/artifacts. The plan's weakness is sequencing, not substance: it left two live default-path regressions (P0 #1, #2) behind while execution moved to C9-06, and it under-specifies ratification for user-visible policy flips.

---

## 6. Campaign 9 Queue Amendments (apply to QUEUE_2026-07-15_CAMPAIGN9.md before resuming)

1. **Promote NEW-WEBGPU-DEPTH-PLANE-LOG-DEPTH-CONTRACT to blocking/immediate** (currently NOT STARTED while a live default-path pick regression exists), or add an explicit interim task to gate the pick depth-plane draw; acceptance = the 20/500/5000 km horizon oracle passes.
2. **Add a new immediate item: complete the point-shadow clip-space migration** at `GlobeTerrain.wgsl` `globeSamplePointShadow` (third receive site), acceptance = point-shadow probe on globe terrain.
3. **Add a new item: sync-pick region-drift semantics** — fix or explicitly disclose the exact-region cache gate's moving-cursor behavior (currently in no ledger row).
4. **Add a new item: Color-type polyline grouping-by-type** (interim fix), cross-linked to FAR-307's persistent material table.
5. **Add PARTIAL rows for implemented-but-unlisted work:** NEW-GPU-TIMESTAMP-UNIQUE-SAMPLE-ACCOUNTING (Wave-0 item 5; 25 spec cases) and C9-16 core (clustered disabled-path zero-work + transition-frame zero-write), each citing spec evidence.
6. **Add a containment-ownership row per FAR-003 default flip** (cull/HiZ/sort/tile-indirect/OIT/RenderScheduler/gpuCullingHint): owning ID, re-enable path, and — for OIT specifically — a `CesiumDebug.webgpuOIT()` toggle + before/after translucent-intersection probe as acceptance. Note the RenderScheduler containment under FAR-003's row (currently only discoverable from the plan text/code comment).
7. **Add a policy-ratification task:** explicit-`webgpu` hard-fail vs charter graceful-fallback language; also the invalid-renderer-string throw. Outcome = charter amendment or behavior restore.
8. **Add a feature-renderer failed-state retry item** (bounded retry / public retry API).
9. **Add a ContextLimits disposition item** (mirror-populate vs loud deprecation) per FAR-104's own cleanup note.
10. **Add a doc-sync task:** SHADER_PAIRS_LOCKSTEP.md, WEBGPU_MIGRATION_STATUS.md, ARCHITECTURE.md → ClipSpaceConvention/GraphicsCapabilities; `GlobeTerrain.wgsl:3292` comment.
11. **Pull item 68 (`contains()`) forward** as a quick-win with its acceptance matrix.
12. **Add breaking-change notes task:** `loadKTX2` required-targets signature, sync `new Scene()` renderer policy, `pickHoverAsync` result shape — CHANGES.md/migration notes.
13. **Add to item 72 (broad-suite gate):** triage the Renderer 20 failures against the GraphicsCapabilities/ContextLimits migration FIRST (highest blast-radius suspect), then attribute remaining Renderer/DataSources/Scene failures pre-existing vs tree.
14. **Extend C9-06 acceptance** to include the `fr.prepare` wiring (both backends) and Moon migration, per the code's own dead-letter comments.
15. **Record the PNTS retention cost** under FAR-204/NEW-PICK-ID-OWNERSHIP-MODEL.

---

## 7. Commit Strategy (landing 323 uncommitted files safely)

**Verify first, on the whole tree, before any commit:**
1. `npx tsc --noEmit` (zero-error gate).
2. `npx gulp build` + `node Tools/variant-smoke-test.mjs` (the variant plugin/exemptions were not flagged, but the ContextFactory/entry-barrel changes touch that machinery).
3. Targeted spec suites for the new/changed specs (Renderer WebGPU*, Matrix4/frustum, ContextFactory, GraphicsContext, Scene, DataSourceDisplay, Material*, CommandOrdering) via `gulp test --includeName` with `CHROME_BIN`→Edge.
4. Broad suites once, to pin the pre-existing failure counts (Renderer 20 / DataSources 10 / Scene 47) as the baseline — any delta after landing is attributable.
5. Key probes: pick matrix (C9-02A artifact re-run), depth-plane horizon oracle (expected to pass only after P0 #1), model instance-bind-group probe, polyline material probe, saved-view visual regression.

**Apply the P0 code fixes in-tree BEFORE partitioning commits** (they're small; landing known-broken defaults then fixing forward wastes a bisect range). P0 #6 is a maintainer decision — get it before the FAR-003 commit.

**Partition into ~14 logical commits in dependency order** (each buildable; `lint-staged` with `--concurrent 1` on the big ones per the OOM memory):
1. **Shared-core foundations:** ClipSpaceConvention + GraphicsCapabilities (+.d.ts), Matrix4 + 4 frusta, Context.js, UniformState, SceneTransforms, ShadowMap convention (+ the GlobeTerrain P0 #2 fix — cast/receive must land atomically), + their specs.
2. **KTX2/imagery threading:** loadKTX2, Request, ImageryLayer(Helpers), ImageryProvider, Imagery, SupportedImageFormats, MaterialHelpers keys + CHANGES note.
3. **Shader-module cache 40-bit key + WebGPUModelPipelineCache de-salting** (must be one commit — the de-salt is only safe with the widening) + CLAUDE.md key-encoding doc edit.
4. **CommandOrdering module + DrawCommand/WebGPUDrawCommand + collections wiring + GPUSortKeys WGSL/dispatcher/producer repack** (atomic: WGSL bindings + SOA + UBO pack are mutually dependent).
5. **Device lifecycle hardening** + effects-cache leases + their specs.
6. **FAR-003 containment defaults** + getContainmentStats + WebGPUUnsafeDefaultsSpec (after ratification; include the OIT toggle + probe evidence).
7. **Timestamp profiler + ring allocator + perf-manager gates** (include P0 #4 flush fix).
8. **Picking:** WebGPUPickFramebuffer (with P0 #3 fix), pick-pass rewrite (with P0 #1 gate), DepthPlane C9-02A/B, Picking.js hover scheduler, pickPipelineFormat consumers, specs + probes + oracle artifacts.
9. **Terrain/globe:** FAR-106 fog fix (+stale-comment fix), globe pick restructure, C9-01 counters, camera/tile UB staging consumers.
10. **Model cohort:** bind-group cache, metadata cache, ModelPrimitiveGeometry, feature-ID, PntsLoader/Classification retention, specs + probe.
11. **Collections:** polyline grouping (with P0 #5 fix), MaterialUniformBuffer + WebGPUMaterialUploadState + Material, blend/label propagation, specs.
12. **Scene lifecycle:** transactional construction/createAsync/destroy, ContextFactory/RendererType/RendererBuildCapabilities, C9-06 extinction cache + Sun/StarField, SceneSpec.
13. **DataSources:** DataSourceDisplay rollback + specs + MaterialPropertySpec.
14. **Tools/probes/docs:** visual-regression probes, gulpfile/eslint.seatbelt, migration_doc updates + amended C9 ledger + this audit's amendments.

After the final commit: re-run tsc + build + variant smoke + the targeted suites; confirm broad-suite failure counts did not grow beyond the pinned pre-existing baseline; keep `sol-backup-2026-07-16` until green, then ask the maintainer before deleting (branch-transparency rule).

---

## 8. Resume Plan (picking up where Sol left off — C9-06 in progress)

1. **Day 0 — maintainer decisions:** ratify or revert (a) OIT default-off, (b) explicit-`webgpu` hard-fail. Both block commit partitioning.
2. **Day 0 — apply P0 fixes 1-5** in-tree (all are bounded: one gate, one WGSL line, one cache-region fallback, one flush line, one grouping key change) + probe verification for #1 (horizon oracle) and #2 (point-shadow probe).
3. **Amend QUEUE_2026-07-15_CAMPAIGN9.md** per §6 (15 amendments), including the two under-claimed PARTIAL rows.
4. **Verify + land** per §7 commit strategy; pin pre-existing broad-suite failure baseline before, confirm no growth after.
5. **Close C9-06** (the in-progress item): wire `fr.prepare` on both backends, migrate Moon to the cached integrator, certify acceptance (both renderers, mutation, restore) — most of the implementation + specs + probe already exist; this is a finishing slice, not a build.
6. **Next queue order after C9-06:** NEW-WEBGPU-DEPTH-PLANE-LOG-DEPTH-CONTRACT (unblocks C9-02B acceptance — re-run the three-altitude oracle to close it) → NEW-WEBGPU-HDR-PICK-FORMAT-CLOSURE (stamp `pickPipelineFormat` in `buildPickPipelineDescriptor`, run the SDR/HDR/MSAA matrix) → item 68 `contains()` quick-win → C9-07 (premise audit already done, implementation NOT STARTED, ledger accurate) → resume the ledger's declared wave order.
7. **Broad-suite attribution lane (parallel):** triage Renderer 20 against the GraphicsCapabilities/ContextLimits migration first, then DataSources 10 (items 67/68/70 cover the known causes), then Scene 47 — feeding item 72's gate.

---

## Appendix A — Per-Cohort Verdicts

| Cohort | Files | Verdict | Sol-introduced worst | Pre-existing found (queued) |
|---|---|---|---|---|
| A renderer-core | 33 | SOUND | P2 TAA custom-frustum throw; P2 OIT gate unratified | Central HDR pick derivation; point-pick log-depth |
| B picking | 27 | SOUND w/ 1 live disclosed P1 + 1 undisclosed P2 | P1 depth-plane pick over-occlusion; P2 sync exact-region gate | Scene-side plane/point log-depth; HDR fleet; async pick readiness |
| C terrain-globe | 21 | SOUND | P2 readPixelsAsync flush gap | (none implicated) |
| D model | 19 | SOUND (cleanest cohort; no P0/P1) | P3s only | Pick-ID double-tax (queued #50/#56) |
| E collections | 26 | SOUND w/ 1 material reservation | P1 ColorType polyline grouping regression | blendOption sync; 2D/CV pick keys; polyline HDR pick; bulk-cluster (item 69, Batch 335 era) |
| F shared-core | 29 | SOUND w/ reservations (4 follow-ups) | P2 explicit-webgpu no-fallback | destroyObject ES6 (item 65); Resource URL (item 67); + fixed upstream ETC2 typo |
| G datasources | 9 | SOUND | P3s only (silent catch, private-field reach) | contains() (item 68, codemod 39f5341e64); KMZ URI (item 70) |
| H scene-shared | 19 | SOUND w/ minor defects | P2 StarField prepare unwired | Moon extinction uncached |
| I shaders-wgsl | (truncated) | Partial payload; 2 impl. verified 5/5, 1 verified 2/5 | **P0-class**: GlobeTerrain point-shadow receive unmigrated (re-verified in tree during synthesis) | — |

## Appendix B — Per-Doc / Ledger Verdicts

- **QUEUE_2026-07-15_CAMPAIGN9.md (C9 ledger):** TRUTHFUL. C9-05 COMPLETE verified; C9-07 NOT-STARTED verified; C9-02A/B PARTIAL/PAUSED verified including the honestly-failing oracle; C9-06 conservatively IN PROGRESS (code ahead of claim). Two under-claims (timestamp accounting, clustered zero-work) violate the update-the-ledger rule in the safe direction. One omission: no row for the sync-pick semantics change.
- **FORK_ARCHITECTURE_REMEDIATION_PLAN/LEDGER (FAR-*):** FAR-003/101/102/103/104/106/303/309/204 all reproduce from code + artifacts; "remaining" caveats honest. FAR-307's "grouping/lifetime churn bounded" oversells the ColorType default case. 384-case Edge matrix counts not re-runnable under read-only audit; consistent with artifacts.
- **Evidence artifacts (Tools/visual-regression/output/…):** C9-01 counters independently reproduce the ledger numbers exactly (41,224 tile calls; 173.0 MiB; 115.1 MiB); C9-02A matrix pass and C9-02B oracle fail artifacts exist on disk and match claims.
- **Live architecture docs:** DRIFTED — SHADER_PAIRS_LOCKSTEP.md, WEBGPU_MIGRATION_STATUS.md, ARCHITECTURE.md still describe removed `setDepthRangeType`; per CLAUDE.md this drift is itself a bug (P1 #5).
- **CLAUDE.md:** correctly updated for the 40-bit module-cache key encoding.

## Appendix C — Charter Scorecard

| Charter rule | Result |
|---|---|
| 1. Scene backend-agnostic | PASS (TAA jitter moved out of Scene; feature-detection seams only) |
| 2. RTE 64-bit everywhere | PASS — strengthened (GPU sort now consumes canonical f64 distance) |
| 3. ShaderDefine add-only | PASS (JSDoc-only diffs; de-salt safe via same-tree key widening) |
| 4. No TypeScript `any` | PASS (`unknown` + `as unknown as` throughout) |
| 5. Feature preservation | CONDITIONAL — FAR-003 default-offs plan-sanctioned but OIT flip unratified/unprobed; two live default-path regressions (P0 #1, #2); depth-plane pick regression disclosed but left active |
| 6. JSDoc + pragma discipline | MOSTLY PASS — silent teardown catches and runtime-gated C9-01 counters are soft deviations |
| 7. Canonical source paths | PASS |
| 8. WebGL2 keeps working / parity both ways | PASS (WebGL paths preserved; ETC2 typo fix improves WebGL; ClipSpace legacy getters WEBGL-convention) |
| 9. Probe-first verification | MOSTLY PASS — Edge/Node artifacts for most slices; MISSING for the OIT-off visual delta and the sync-pick semantics change |
| TS-preferred for new code | SOFT FAIL — 4 new modules in JS |
| Graceful WebGL fallback | FAIL pending ratification — explicit-`webgpu` now hard-fails |
