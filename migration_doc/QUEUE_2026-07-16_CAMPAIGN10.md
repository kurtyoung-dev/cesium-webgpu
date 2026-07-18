# Campaign 10 — Performance Architecture Closure and Campaign-9 Fallout

Prepared: 2026-07-16

Status: **LAUNCHED 2026-07-18 (orchestrator mode)**

Launch authority: **given** — the standing maintainer directive (2026-07-17: "finish Campaign 9 and
then move onto campaign 10"), exercised after Campaign 9 CLOSED green at Batch 691 (`C9-30` VERDICT
PROMOTE) and after the `C10-00B` fallout-intake sweep reconciled the tree (Batch 692). Operating
model: ORCHESTRATOR — the main loop prepares briefs, dispatches model-matched workers (who never
commit), reviews every diff, and lands; the autonomous engine (`C10-00`) stays DEFERRED while this
mode runs. Live status: §3.2.

Source plan:
[Performance Architecture Deep Dive](PERF_ARCH_DEEP_DIVE_2026-07-16.md) (the 69-finding "W8"
register) + the Campaign-9 fallout the running Wave-2 slice leaves behind
([QUEUE_2026-07-15_CAMPAIGN9.md](QUEUE_2026-07-15_CAMPAIGN9.md) §3.2).

> **Execution guidance:**
> [CAMPAIGN10_EXECUTION_GUIDE_2026-07-16.md](CAMPAIGN10_EXECUTION_GUIDE_2026-07-16.md) carries the
> engine/handoff mechanics, the fallout-intake procedure, per-task implementation walkthroughs,
> verified code anchors, traps, and verification recipes. Workers read their task's guide section
> (H1–H7) before implementing. Line anchors are hints — the tree moves; re-grep every symbol.

Campaign 9 is frozen as historical evidence when C10 launches; every open C9 ID transfers here as a
fallout-intake row (§4). This queue does not repeat closed work and does not silently activate its
gated tail (§6).

---

## 1. Outcome and campaign rules

Close the default-path performance architecture the W8 register mapped — collapse the 3D
environment-command frustum floor, contain MSAA/attachment boundary bytes, kill redundant
command/upload economics, cut boot/compile TTFF, and land the pick-fleet log-depth correctness that
Campaign 9 left blocked — while preserving the complete WebGL/WebGPU feature and API surface and
without regressing WebGL.

Rules (**inherited verbatim from Campaign 9 §1 — do not weaken**):

1. Never remove, hide, default-disable, bypass, or visually weaken a feature for a metric. Safety
   containment is correctness work, not a performance win.
2. Follow the WebGL globe architecture: WebGL and WebGPU consume the same backend-neutral
   `QuadtreePrimitive`/`GlobeSurfaceTileProvider` selected tiles. Never replace terrain quadtree,
   3D Tiles traversal, or voxel octree with the optional general `SceneOctree`; optimize their
   post-selection work and give non-PVS effects explicit owners.
3. Unknown attachment demand keeps MRT; unknown bounds execute the effect; unknown serial retains the
   resource; uncertain GPU visibility uses the correct fallback. Unknown demand stays conservative —
   never guess a skip.
4. No absolute planetary ECEF `f32` reconstruction before camera subtraction, including previous
   frames and GPU culling/LOD data.
5. Node/Playwright and Microsoft Edge only for browser automation. The moving multi-altitude camera
   track is mandatory; idle soak/FPS is not performance evidence.
6. Land one concern per slice. Roll back the optimization, never the feature. Tests and counters remain.

**Perf promotion rule (Campaign 9 §12.6, inherited verbatim).** An individual slice may raise a
promoted-optimization banner only when, versus its on/off/restored oracle on the moving-altitude
route, it improves a **named unsaturated stage p95 by ≥5%** OR exceeds **3× the measured run-to-run
noise**, with no route-segment p99 regression and no WebGL regression beyond the predeclared budget.
**A truthful miss with green mechanics (correctness oracles pass, structure changed as designed) is a
VALID, COMPLETE result** — record the honest number in the ledger and claim no banner. Structural
correctness/parity slices (the pick fleet, the frustum-count collapse to WebGL parity) land on their
own oracle regardless of the timing delta.

---

## 2. MSAA ruling of record (maintainer, 2026-07-16)

The MSAA boundary-bytes work (`C10-03`) is governed by an explicit maintainer ruling. It is recorded
here so no worker re-litigates it:

- **(b) Resolve-elision — RATIFIED, implement unconditionally.** Eager per-segment MSAA color
  resolve is replaced by demand-driven "resolve-on-consume": scene-FB segments open without a resolve
  target and a zero-draw resolve pass fires only before a consumer that reads resolved color. This is
  redundancy elimination and lands independent of the ≥5%/>3×-noise promotion bar (it still ships
  on/off/restored evidence).
- **(d) Auto `msaaSamples = 1` when TAA is enabled — RATIFIED** as redundancy elimination. The
  forcing mechanism **already exists in-tree** (Batch 234, `WebGPUSceneRenderer.ts:1402-1411`); this
  is verification + a visual gate probe, NOT new plumbing. `scene.msaaSamples` is never mutated;
  TAA-off restores the user value via drift detection.
- **(c) Default `msaaSamples` 4→1 flip — EXPLICITLY NOT RATIFIED. Reserve lever only** (`C10-03R`).
  It may be pulled ONLY if the `C10-30` default-path checkpoint misses target WITH
  bandwidth-attributed evidence (GPU-timestamp + counter data implicating attachment traffic, not
  CPU) AND a fresh maintainer sign-off is recorded in this ledger. Do not flip `Scene.js:488` in any
  slice without both. MSAA-4 default is visual policy (Rule 1).

---

## 3. Gates

Adapted (lighter) from the Campaign-9 A–G set to the four gates this campaign actually needs:

| Gate | Required to pass | Stops promotion when |
| --- | --- | --- |
| A — launch seal / attribution | Fresh C10 launch seal on one clean hash; exact source/build identity; clean + API lanes on the moving-altitude route; deterministic offline boot; known-error ledger. The comparison anchor is the recorded `C9-30` clean-r5 artifact (or Gate-A `B8015811…` = WebGL 5.50 / WebGPU 7.51 ms as a labelled fallback if `C9-30` never ran). | A route is incomplete, rendering pauses, hashes differ, clean/instrumented data mix, or device errors are unexplained. |
| B — bounded correctness / feature preservation | Every slice's own semantic + visual oracle green; the pick-fleet WebGL-parity matrix; frustum-count/env-pixel parity; byte-identical off-paths and kill switches. The Source-(c) standing reds (bare-globe interior, high-density drift, pickPosition convergence) tracked and pre-attributed. | A public result, feature, mode, depth/history contract, or visual is weakened; a standing red turns a NEW red. |
| C — default hot path | Per-slice on/off/restored evidence on the moving-altitude clean + API lanes; ≥5% named-stage p95 or >3× noise for any banner; no route-segment p99 regression; no WebGL regression beyond the predeclared budget. | Improvement is within noise, a route segment regresses, or an unknown consumer is skipped. |
| D — measured checkpoint (`C10-30`) | The W5 tranche checkpoint on one rebuilt hash vs the `C9-30`/Gate-A anchor: ≥10% whole-route + ≥15% near-ground WebGPU CPU-p95 OR >3× noise; feature-loss gate green; honest per-stage attribution + promote/iterate verdict recorded. | A lane is absent, historical evidence is overwritten, the anchor is re-derived on the new tree, or a new visual red appears. |

R0/R1 infra, counters, probes, and structural-correctness slices may land before Gate B. The gated
tail (§6) is not activated by any of these gates alone — it additionally requires the `C10-30`
verdict AND fresh maintainer sign-off.

### 3.1 Finding → task coverage

| W8 register finding | Campaign 10 owner |
| --- | --- |
| S7-1 2-frusta env floor on every default 3D WebGPU frame | `C10-01` (anchor) |
| S11-1 phantom all-discard TRANSLUCENT twin per batch-table primitive | `C10-02` |
| S4-1/S4-2 eager per-segment MSAA resolve + boundary-bytes ceiling | `C10-03` (+ `C10-03R` reserve) |
| S6-1/S11-2 synchronous main-thread splat comparator sort | `C10-04` |
| S3-1 model material textures mip-0-locked (sample-bandwidth ~100×) | `C10-05` |
| S8-1/S8-2 serial boot waterfall + never-wired prewarm | `C10-06` |
| S8-3 132 sync `createRenderPipeline`, model/PP fully synchronous | `C10-07` |
| S3-4/S3-5 runtime-flag model uber-shader (worst-path occupancy) | `C10-08` |
| S6-2 full CPU re-upload of static instance arrays every TAA frame | `C10-09` |
| S1-2 second full-commandList sweep per shadow map per frame | `C10-10` |
| S7-3 pick FBO uniformly hyperbolic; far-field indiscriminable (C9 fallout) | `C10-11` → `C10-12` |
| S7-3/§15 reversed-Z early-Z ceiling on 71 log-depth producers | `C10-13` spike → `C10-GT` (gated) |
| §14 next-campaign seeds | §6 seed list |

### 3.2 Live execution status

Every task/gate not listed as started is **NOT STARTED**. Status vocabulary is identical to
Campaign 9 §3.2: **IN PROGRESS · COMPLETE · PARTIAL / PAUSED · BLOCKED · DEFERRED · CONDITIONAL NOT
TRIGGERED**. Every C10 task brief mandates: update your row here (add it if missing) with status +
evidence, INCLUDED in your landed files. A missing ledger update is a landing defect. `C10-00B`
pre-populates the C9-fallout intake rows (§4) into this ledger at intake time so nothing falls
through the seam.

| Task or gate | Status | Updated | Evidence / next action |
| --- | --- | --- | --- |
| Campaign 10 | **LAUNCHED (orchestrator mode)** | 2026-07-18 | Campaign 9 CLOSED green at Batch 691 (`C9-30` VERDICT: PROMOTE — WebGPU whole-route CPU p95 −30.8%, near-ground −42%/−41%, WebGPU/WebGL ratio 1.37→0.98). Launch per the standing maintainer directive (2026-07-17: "finish Campaign 9 and then move onto campaign 10"). Operating model: ORCHESTRATOR (main loop = work-preparer + acceptance-reviewer; model-matched Opus/Fable workers; workers never commit — orchestrator reviews each diff and lands). Wave order stands (checkpoint PASSED — no attribution reorder). |
| Gate A | **COMPLETE (launch seal)** | 2026-07-18 | Anchor = the recorded `C9-30` clean-r5 artifact (`campaign9-c9-30-checkpoint-clean-r5-2026-07-17.json`; bundle sha `5B2B323F…AD38`): WebGPU 5.20 ms / WebGL 5.31 ms whole-route CPU p95 medians are the C10 reference. |
| Gate B | **NOT STARTED** | 2026-07-16 | — |
| Gate C | **NOT STARTED** | 2026-07-16 | — |
| Gate D (`C10-30`) | **NOT STARTED** | 2026-07-16 | Anchor = recorded `C9-30` clean-r5 artifact or Gate-A fallback. |
| `C10-00-ENGINE-HANDOFF-AND-SCRIPT-GEN` | **DEFERRED — orchestrator mode active** | 2026-07-18 | The autonomous engine script is not needed while the maintainer-directed orchestrator operating model runs C10 (main loop dispatches + reviews). Queue/ledger discipline unchanged. Fork `campaign-9-resume.js` → `campaign-10.js` only if the campaign reverts to engine mode. |
| `C10-00B-C9-FALLOUT-INTAKE-SWEEP` | **COMPLETE (Batch 692)** | 2026-07-18 | Four-source sweep executed at C9 closure: **(a)** run journal `wf_f6cb6b3b-927` — every non-landed outcome was resolved by the orchestrated finish (Batches 683–691): C9-12A landed+hardened (685+686), C9-17 A+B landed (687/688, Slice D → §4), C9-12 BLOCKED → §4, C9-30 COMPLETE/PROMOTE (691). **(b)** C9 §3.2 non-COMPLETE rows → §4 seeds (pre-populated Batch 689; extended this batch with C9-30 outcomes). **(c)** working tree CLEAN at launch (`tsc` green, Batch 691 pushed). **(d)** `C9-30` PASSED → wave order stands unchanged. Launch note: C9 landed 19 batches + 9 orchestrated finish/close batches; fallout intaken below; branch inventory = `main` only. |
| `C10-01-ENV-COMMAND-FRUSTUM-BINNING` | **COMPLETE (impl+verify; pending orchestrator land)** | 2026-07-18 | Anchor. Guide H1. BV-less `Pass.ENVIRONMENT` near/far exclusion + sky-only fallback in `View.createPotentiallyVisibleSet` (`View.js`: `sawEnvironmentNoBV` local, pass-keyed else branch, pre-`updateFrustums` `near>far` restore); `frustums.count` added to `Scene.getDebugSnapshot`; new `probe-frustum-count-3d.mjs`. JS-only, zero shader/pipeline change. **PRE:** WebGPU `numberOfFrustums`=2 at 18,000 km/500 km/300 m (env binned `[3,3]` into both frusta); WebGL=1. **POST:** WebGPU=1===WebGL at all three (globe bins 6/36/147 match WebGL); sky-only leg WebGPU=2 unchanged (fallback, star field renders); PNGs read — atmosphere limb + sun + stars + moon identical. Gates: `tsc`/eslint/`gulp build` clean; capture-and-diff globe-default crossBackend 0.46% (band 0.43–0.77%) + repaired historical lane green 0.01% both backends, 5 other globe scenes 0.46–0.75% (high-density-5k-spheres 8.62% = pre-attributed standing red `NEW-HIGH-DENSITY-SPHERES-CROSS-BACKEND-DRIFT`, spheres are BV'd OPAQUE so untouched by this change); camera-track 9/9 both backends max 0.079% zero errors; celestial battery green (extinction-cache, sun-stars-extinction PARITY match=true, moon-atmosphere, atmosphere-orbit 0.42%, atmo-moon-438 errs=0, diag-stars); 2D/CV safe (2d-frustum-bins `noBV=0` in SCENE2D → change is a no-op there; 2d-cv-modes + model-scene-modes GATE PASS all modes); pick — point-pick + billboard-pick PASS, `probe-pickposition-webgpu` FAIL is pre-existing standing red `NEW-WEBGPU-PICKPOSITION-CONVERGENCE-REGRESSION` **confirmed via OFF-oracle** (fails identically with fix neutralized). WebGL invariant: Trap-4 verified (no WebGL/shared path pushes `Pass.ENVIRONMENT` into `frameState.commandList`; `CubeMapPanorama` uses `panoramaCommandList`), Multifrustum/FrustumCommands specs build only BV'd OPAQUE / pure data — never reach the new branch (Karma+Edge launcher env-broken this session; not executed). Perf spot (clean lane, 2 reps): WebGPU CPU-p95 4.85 ms (vs 5.20 ref, ~−6.7%), WebGL 5.36 ms (vs 5.31, flat/noise) — characterization only, C10-30 owns the measured claim; **structural frustum parity is the landing bar and is met**. Rollback: single revert; probe + `frustums.count` telemetry survive. |
| `C10-02-TILES-STYLE-COMMAND-ECONOMICS` | **NOT STARTED** | 2026-07-16 | Guide H2. |
| `C10-03-MSAA-BOUNDARY-BYTES` | **COMPLETE (impl+verify; pending orchestrator land)** | 2026-07-18 | Guide H3. Ruling §2 (b)+(d). Demand-driven scene-COLOR MSAA resolve ("resolve-on-consume"): `WebGPURenderTarget.getColorAttachments(clearValues?, {resolve})` (default true, byte-identical for unmigrated callers) + new `createColorResolvePassDescriptor()` zero-draw resolve pass; the three scene-FB open sites (`PassRedirect.setupSceneFramebufferRenderPass`, `_resumeScenePass`, `_clearDepthStencil`) pass `resolve:false`; new `WebGPUSceneRenderer._ensureSceneColorResolved(context)` fires before every resolved-color consumer (refraction capture, OIT composite, invert-class composite, BV-debug, **pre-post-process ALWAYS**). Staleness = one context flag `_sceneColorResolvePending` set at the single `beginRenderPass(target==="scene-framebuffer")` hook (leans on C9-07 `_activePassTarget`; NOT the guide's 12-site fallback) + resets at frame/pick begin + FB recreate. Registry: `resolvedSceneColor` observe-only demand in `computeAttachmentDemand.other` + `sceneColorResolveOpens` actual counter in `getAttachmentDemandStats` (C9-09 record↔actual model). Default-on kill switch `_sceneColorResolveElisionEnabled` (revert-boundary safety + identical-build A/B oracle). **PRE→POST (probe-msaa-resolve-elision, bucketed beginRenderPass counter, per-frame):** scene-COLOR resolves eager **9 → demand exactly 1** (`sceneColorResolveOpens===1`); **slot-1 G-buffer resolves PRESERVED/unchanged** (out of scope, `buildMrtSlot1Attachment` untouched); MSAA1 = **0** both paths + byte-identical A/B; `recordMatchesActual` green. **Byte-identity:** capture-and-diff globe-default historicalWebgpu **0.01%** (clean-tree PRE/POST) + crossBackend **0.46%** (band 0.43–0.77) + probe-demand-canvas-pass empty-scene **byte-identical to pre-change (0 px)**. **Part (d):** Batch-234 TAA→samples-1 forcing INTACT (`WebGPUSceneRenderer.ts:1402-1411`, `scene.msaaSamples` never mutated); gate probe asserts effective `context._msaaSamples===1` under `taaEnabled` + restore→4 on off; `probe-taa-jitter` GATE PASS. **Gate net all green:** probe-attachment-demand-registry (every recordMatchesActual), probe-demand-canvas-pass 24/24 both backends, probe-scheduler-octree-demand, probe-diag-demand-gates, probe-frustum-count-3d PARITY, probe-point-pick-webgpu, probe-collections-regression. Consumer scenarios (HDR toggle, resize, invertClassification) 0 device errors. **Perf (moving-altitude, 2 reps):** clean WebGL 5.30 ms (flat vs 5.31 anchor — no regression), WebGPU 5.40 ms (+0.20 vs 5.20 anchor, within run-to-run noise); API lane confirms `SceneFramebuffer-Color_demand_resolve` = 1/frame across all route segments, route completes 0 errors. **Bandwidth (analytical, cited not measured):** ~8 elided eager resolves × 41.5 MB ≈ **~330 MB/frame @1080p** (S4-2); slot-1 rows omitted from S4-2 so its boundary figure is understated. **Banner: NONE claimed** — ruling (b) lands independent of the ≥5%/>3×-noise bar; CPU-p95-flat is the honest expected result for a GPU-bandwidth elision (VALID COMPLETE per §1 promotion rule). tsc+gulp build clean (engine `.ts` not eslinted by flat config). Option (c) `Scene.js:488` default UNTOUCHED (I8). Single-commit revert boundary. **Observation (surfaced, not claimed as fix):** the CesiumViewer offline default-camera exhibits an INTERMITTENT black-globe interior (ledgered `NEW-WEBGPU-PICKPOSITION-CONVERGENCE-REGRESSION`) that flips between shipped/eager randomly per session — unrelated to this slice (capture-and-diff on the split-screen substrate is clean 0.01%/0.46%). |
| `C10-03R-MSAA-DEFAULT-FLIP-RESERVE` | **CONDITIONAL NOT TRIGGERED** | 2026-07-16 | Reserve lever; needs checkpoint-miss + sign-off. |
| `C10-04-SPLAT-ASYNC-SORT` | **BLOCKED (premise-broken; producer gap)** | 2026-07-18 | Guide H4 STOP-AND-BLOCK #1 verdict = **CONFIRMED BLOCK**. The WebGPU splat FR has **no production data producer**, so the synchronous main-thread comparator sort this slice targets (`WebGPUGaussianSplatRenderer.maybeSortSplats`) **never runs in production** — the slice's perf premise (a costly default-path splat-sort hitch) is unverifiable because no production scene reaches the path. **Phase-0 trace (2026-07-18):** `GaussianSplat3DTileContent.fromGltf` builds a real `GaussianSplatPrimitive`, but `GaussianSplatPrimitive.update()` returns at `:1197` after `fr.update(this,frameState)` when the WebGPU FR is ready; the WebGL data-commit (`commitSnapshot:407`/`GaussianSplatTextureGenerator`/`buildGSplatDrawCommand:1967`) runs only in the continuation AFTER that return, so under WebGPU it never fires. The FR reads only `primitive._splatData \|\| primitive._renderResources?.splatBuffer` (`WebGPUGaussianSplatRenderer.ts:1231`); `git grep '_splatData ='` = 0 production hits (excl. `_splatDataGeneration`), `git grep '_renderResources ='` = 0, `_renderResources` never referenced in the primitive → `splatData===undefined` → `cache.splatBuffer` null / `splatCount` 0 → `maybeSortSplats` returns at `count===0`. Only `probe-splat-sort.mjs` exercises it (synthetic 3-splat `_splatData` on a fake primitive). Confirms Batch 288 (`WEBGPU_DEBUGGING_LOG.md:894` "never actually drew — no `_splatData` producer wired") + C10-09 (`:60` "production `_splatData` has no JS producer — C10-04 territory"). **Do NOT build the async-sort worker/GPU machinery** — it would optimize a path no production scene reaches (the "unverifiable async-sort machinery" the STOP-AND-BLOCK forbids). **Smallest unblock:** land **NEW-WEBGPU-SPLAT-DATA-PRODUCER** first (DEFERRED_WORK, filed 2026-07-18) — the WebGPU analog of `commitSnapshot`/`buildGSplatDrawCommand` that packs the loaded glTF/SPZ snapshot into the interleaved 16-float `_splatData` record + exposes model-space positions; THEN C10-04 (async sort) has a real, drivable workload (a `.spz`/glTF-splat tileset). **Synthetic-harness note (honest):** `probe-splat-sort.mjs`'s synthetic-injection path IS the exact `maybeSortSplats`/`sortedIndexBuffer` code path and CAN be scaled to 100k–1M splats to drive the comparator + measure the main-thread hitch PRE/POST and prove a settle-to-identical-order oracle — so the async rewrite is *correctness-verifiable* on a probe-only workload, but it CANNOT claim a default-hot-path promotion banner (no production consumer), so building it now is premature per Rule 1/§1.6. Escalated to maintainer (Principle 9). Valid honest block (C9-12 precedent). |
| `C10-05-MODEL-TEXTURE-MIP-CHAIN` | **NOT STARTED** | 2026-07-16 | Guide H4. |
| `C10-06-TTFF-BOOT-CONCURRENCY-AND-PREWARM` | **NOT STARTED** | 2026-07-16 | Guide H5. |
| `C10-07-ASYNC-MODEL-PIPELINES` | **NOT STARTED** | 2026-07-16 | Guide H5. Deps `C10-06`. |
| `C10-08-MODEL-SHADER-SPECIALIZATION-AXES` | **NOT STARTED** | 2026-07-16 | Guide H5. Deps `C10-07`. Bit register nearly full. |
| `C10-09-VELOCITY-PREV-BUFFER-GPU-COPY` | **COMPLETE (impl+verify; pending orchestrator land)** | 2026-07-18 | R1. Guide H2. Revision-skip + GPU self-copy for the TAA prev-instance-buffer identity case in the three renderers that CPU-re-uploaded static instance arrays every TAA frame. **Files/symbols:** `WebGPUPointCloudRenderer.ts` (default `attachPointCloudVelocityCommand` + LOD `attachLODPointCloudVelocityCommand`; cache `instanceDataRevision`/`prevBufferRevision`/`lodPrevBufferRevision`; bump at the single rebuild content-write; **added `COPY_SRC`** to `buildInstanceBuffer` usage), `WebGPUGaussianSplatRenderer.ts` (`attachSplatVelocityCommand`; `instanceDataRevision`/`prevBufferRevision`; bump at splat rebuild; `splatBuffer` already had `COPY_SRC`), `WebGPUCloudRenderer.ts` (`attachCloudVelocityCommand`; `instanceDataRevision`/`prevBufferRevision`; bump at rebuild = count-change OR property-edit dirty gate; **added `COPY_SRC`**). Three-branch upload: identity (`prevData===currData`) → one-time `copyBufferToBuffer(instanceBuffer→prevBuffer)` when `prevBufferRevision!==instanceDataRevision` then SKIP; animated distinct-array → `writeBuffer(prevSrc)` unchanged; first-frame/count-change seed → GPU copy unchanged. T-4 realloc reset of the resident marker in every prev-buffer grow branch. Private mid-frame submit left alone (FAR-200 separate). **COPY_SRC note:** point/cloud instanceBuffers lacked `COPY_SRC`, so the *pre-existing* seed `copyBufferToBuffer(instanceBuffer→prev)` was latent-broken (never exercised — seed only hit on first-TAA-frame/count-change, TAA defaults off); the identity-seed now hits it reliably, so `COPY_SRC` is a required enabling flag (splat already had it). Zero shader/pipeline/RTE/layout change. **PRE (new `probe-c10-09-prev-buffer-upload.mjs`, API-instrumented `writeBuffer`/`copyBufferToBuffer` by buffer label, single render/frame):** static CloudCollection under TAA = **1 writeBuffer/frame to "Cloud prev instances" = 15,300 B/frame**; frozen TimeDynamicPointCloud under TAA = **1 writeBuffer/frame to "PointCloud prev instances" = 40,000 B/frame**; both `isIdentity=true`, 0 copies. **POST:** both = **0 writeBuffer/frame** at settled (seed fired once during warmup, before the window); cache shows `instanceDataRevision===prevBufferRevision` (matched → skip); 0 console/device errors; clouds render identically (bright px 174629→174749). **Mutation exactness (cloud):** edit one cloud position → mutation frame = 1 `writeBuffer` (animated branch — captures the edit's true velocity, correct), next frame = 1 `copyBufferToBuffer` identity re-seed, then 0/0 forever (bounded per edit, no per-frame re-upload). **INV-3 byte-identical:** static geometry velocity = 0 in both PRE and POST by construction (prev bytes ≡ curr `instanceBuffer` bytes — identity-seed copies the same bytes `writeBuffer(prevSrc=instanceData)` would upload); velocity output unchanged. Gates: `tsc --noEmit` clean; eslint clean (3 `.ts`); `gulp build` clean (51 s). Probes: `probe-taa-jitter` GATE PASS; `probe-taa-model-skinned-velocity` PASS (skinned animation velocity streaks intact, PNG read); `probe-timedynamic-pointcloud-load` PASS (animated PointCloud non-identity path still captures motion, INV-2); `probe-splat-sort` PASS (T-5: sort writes `sortedIndexBuffer`, untouched by prev-buffer change); `probe-cloud-property-edit` PASS (rebuild+dirty gate not regressed by the revision bump); `probe-model-instance-bg-cache` settled green (merged-instance/material bg creates 0/0, geometry revision fast-path 240/240, identitiesStable); `capture-and-diff globe-default` crossBackend 0.46% (band 0.43–0.77%, globe path untouched). Splat velocity leg not driven live (no offline `.spz`/`.splat` asset; production `_splatData` has no JS producer per guide/C10-04) — verified by code-inspection parity with the two live-verified sites (structurally identical three-branch) + `probe-splat-sort` no-regression. **Perf (honest):** named-stage prev-buffer upload on/off oracle (PRE build=off / POST build=on) = **100% elimination** (15.3–40 KB/frame → 0) on TAA+instanced-content scenes; the default moving-altitude route is a **structural no-op** (no point/splat/cloud primitives + TAA defaults off), so whole-route CPU-p95 delta = 0 by construction; the dramatic 1M-splat 64 MB/frame CPU win (S6 F2) needs an offline asset unavailable here. **Banner: NOT CLAIMED** — whole-route CPU-p95 bar not clearable on the achievable-offline workload (eliminated `writeBuffer` is µs-scale for small clouds); named-stage bandwidth elimination is the structural win that lands the slice (promotion rule: truthful miss + green mechanics = VALID COMPLETE). Rollback: each renderer independently revertable (three-branch restructure + revision fields + COPY_SRC per file). |
| `C10-10-SHADOW-CAST-SINGLE-SWEEP` | **COMPLETE (impl+verify; pending orchestrator land)** | 2026-07-18 | R1. Guide H2. Folded shadow cast-candidate collection into the single PVS walk, eliminating the second full-`commandList` sweep per shadow map per frame. **Files/symbols:** `View.js` (module `isShadowedPass[]` lookup; `this._shadowCasters` persistent sublist reset by length each PVS; per-command `isCaster = shadowsEnabled && castShadows===true && isShadowedPass[pass]` collection in `createPotentiallyVisibleSet` — camera-INVISIBLE casters get `updateDerivedCommands` at collection (INV-2/T-1, their only build site) + push BEFORE the camera-cull `continue` (INV-1); camera-VISIBLE + no-BV casters push-only (T-2/T-4, `insertIntoBin` builds their derived cmd); publish `shadowState.casterCommands=shadowCasters` in the `shadowsEnabled` block, `=undefined` when off (T-5)); `SceneRenderer.js` (`insertShadowCastCommands(scene, casters, shadowMap)` now iterates the sublist doing ONLY light/cascade `isVisible` — dropped the full-`commandList` scan, per-command `updateDerivedCommands`, per-call `shadowedPasses` literal, `.includes`; `executeShadowMapCastCommands` reads `shadowState.casterCommands` + `!defined` guard); `FrameState.js` (`shadowState.casterCommands` slot + typedef). Backend-agnostic (Scene/View, above the split); output `passes[].commandList` + `derivedCommands.shadows` byte-identical, only *how* casters are gathered changed. **PRE (baseline B694, new `probe-c10-10-shadow-single-sweep.mjs`):** shadowed CSM scene N(commandList)=17-18, K(casters)=2, maps=1, cascades=4, `camInvisCasters=1` (off-camera box camera-culled) — old code re-walks N×maps commands with N×maps `updateDerivedCommands` + N `.includes` + N light-`isVisible` per frame. **POST:** `setEqual=true` all 3 cells (folded caster set === old full-`commandList`-scan candidate set, by object reference); `camInvisInSublist===camInvisCasters===1` (INV-1 off-camera caster preserved); WebGPU-CSM `castDispatches=292`, umbra byte-identical PRE↔POST (WebGPU-CSM 25192, WebGPU-single 876, WebGL 28485); **scene-ROI pixel diff PRE↔POST = 0** (sharp decode; only the bottom credits DOM strip y696-717 differs across page loads), PNGs read — wall casts identical shadow both backends; 0 device errors. Gates: eslint (3 JS) + `tsc --noEmit` + `gulp build` clean (51 s). Shadow probes: `probe-csm-cast-dispatch` PASS (CSM cast 292, single-map + WebGL ref cast, 0 err), `probe-csm-soft-shadow` PASS (PCF soft-edge + WebGL parity ballpark 1.24×, 0 err); `probe-contact-shadows` N/A (screen-space `WebGPUContactShadowsEffect`, does not touch `insertShadowCastCommands`). Regression: `probe-frustum-count-3d` PASS (WebGPU=WebGL=1 at 18000/500km/300m, sky-only fallback=2 — **C10-01 preserved byte-for-byte**), capture-and-diff globe-default crossBackend 0.43% (band 0.43-0.77) + historical 0.05%/0.01%, `probe-camera-track` 9/9 PASS meanDiff 0.017% maxDiff 0.08% 0 errors both backends. **Default no-shadow route: structural no-op** (collection guarded on `shadowsEnabled`; `executeShadowMapCastCommands` returns before the sublist when shadows off) → whole-route CPU-p95 delta = 0 by construction (INV-5). **Perf (honest, temp in-build on/off/restored A/B oracle, removed before final):** named-stage cast-BUILD CPU (candidate collection, excl. GPU dispatch) on WebGPU CSM caster-grid — N=294/K=256: OLD mean 0.143 ms vs NEW 0.145 ms (flat, sub-resolution); N=1194/K=1156: OLD mean 0.573 ms vs NEW 0.560 ms (**2.2% mean**), p95 within one 0.1 ms `performance.now()` quantum. **Banner: NOT CLAIMED** — <5% p95 / <3× noise on achievable offline scenes (these grids have K≈N + static casters, so the eliminated redundant `updateDerivedCommands` is a cheap dirty-check early-return; the dramatic win needs N≫K with re-dirtying globe/tile casters (T-2) unavailable offline, exactly as the queue predicted "default benchmark has no casters"). Truthful miss + green mechanics (setEqual, byte-identical output, INV-1, all gates) = VALID COMPLETE. **Follow-up (Principle 9):** true revision-maintained sublist blocked on S1-6 retained-commandList (next-campaign seed); global-scope `isShadowedPass` also usable if a future path needs the pass test. Rollback: two files revert together (`View.js` collection + `SceneRenderer.js` iterate); probe survives. |
| `C10-11-PICK-FLEET-LOG-DEPTH` | **NOT STARTED** | 2026-07-16 | Guide H6. Closes C9 fallout `NEW-WEBGPU-PICK-FLEET-LOG-DEPTH`. |
| `C10-12-PICK-DEPTH-PLANE-GATE-FLIP` | **NOT STARTED** | 2026-07-16 | Guide H6. Deps `C10-11`. Closes `C9-02B` + audits `P0-1`. |
| `C10-13-REVERSED-Z-EARLYZ-SPIKE` | **NOT STARTED** | 2026-07-16 | Guide H1 gated-tail dossier, Gate 2. Measurement-only; gates `C10-GT`. |
| `C10-30-DEFAULT-PATH-PERFORMANCE-CHECKPOINT` | **NOT STARTED** | 2026-07-16 | Guide H7 Part D. W5 gate. |
| `C10-GT-REVERSED-Z-SLICE-B` | **DEFERRED** | 2026-07-16 | Gated tail; do not schedule. Guide H1 dossier. |

---

## 4. Campaign-9 fallout intake

Run the **C9-FALLOUT INTAKE procedure** (`C10-00B`) ONCE, at the moment the running Campaign-9
Wave-2 slice completes or is halted, BEFORE launching C10. It is the load-bearing bridge: it converts
everything C9 left unfinished into owned C10 intake rows so nothing falls through the seam. Sweep
**four sources** (full procedure: guide H7 Part C):

- **(a) C9 run journal** (`results[]` of run `wf_f6cb6b3b-927`): intake every
  BLOCKED / FAILED / REVERTED / SKIPPED-DEP / **LAND-INCOMPLETE**. Resolve any unpushed/unstaged
  commits FIRST (`git log origin/main..main`, `git status`) — that is invisible debt.
- **(b) C9 §3.2 ledger** (`QUEUE_2026-07-15_CAMPAIGN9.md`, top-to-bottom): every non-COMPLETE row is
  a fallout candidate. Known standing candidates seeded below.
- **(c) uncommitted working tree** (`git status --porcelain`): leave WIP C9 still owns; salvage +
  clean WIP C9 abandoned (salvage playbook, guide H7 Part B) so C10 launches on a clean tree
  (`npx tsc --noEmit` green).
- **(d) the `C9-30` checkpoint verdict**: if C9's own checkpoint ran and MISSED, its per-stage
  attribution reorders C10 waves (the stage carrying the most unrecovered cost names the highest
  C10 lever). If it PASSED, C10 is pure follow-through and the wave order below stands.

Each hit becomes one §3.2 row (status NOT STARTED) with an evidence pointer and a wave/seed
disposition. Seeded known fallout (re-verify at intake — C9 is running):

| Fallout item | Source | Disposition |
| --- | --- | --- |
| `NEW-WEBGPU-PICK-FLEET-LOG-DEPTH` (NOT STARTED — the ~14-entry fleet prerequisite; compute-instance is already converted and serves as the reference pattern) | (b) | **W4 → owned by `C10-11`** |
| `NEW-WEBGPU-DEPTH-PLANE-LOG-DEPTH-CONTRACT` (PARTIAL/PAUSED — scene half landed Batch 673, pick half re-blocked) | (b) | **W4 → its closure + `C9-02B` closure ride `C10-12`** |
| `C9-02B-DEPTH-PLANE-MULTIFRUSTUM-UNIFORM-RING` (PARTIAL/PAUSED — acceptance blocked behind the fleet) | (b) | **closes under `C10-12`** |
| `NEW-WEBGPU-HDR-PICK-FORMAT-CLOSURE` residue (`…BUFFER-PRIMITIVE-PICK-DISPATCH-PARITY`, `…SCENE-PASS-MSAA-FLIP-TRANSITION`, `…COMPUTE-INSTANCE-PICK-INDEX-MIRROR`, `…ASYNC-PICK-PIPELINE-READINESS-CONTRACT`, `NEW-COLLECTION-PICK-2DCV-PIPELINE-KEY-PARITY`) | (b) | **W4 correctness riders** (own oracle, no metric) |
| `NEW-WEBGPU-PICKPOSITION-CONVERGENCE-REGRESSION` + bare-globe black-interior bimodal (standing gate red, predates campaign) | (b) | **correctness row; gates `C10-30` feature-loss check.** Highest-attention. |
| `NEW-HIGH-DENSITY-SPHERES-CROSS-BACKEND-DRIFT` (standing visual-gate red; re-confirmed 8.62% at C9-30 close-out, unchanged) | (b) | **correctness row; gates `C10-30`.** Its baselines are additionally DEGENERATE (fully black); `--update` promotion auto-blocked 2026-07-18 because the backends disagree — repair the drift FIRST, then recapture. |
| WebGL near-ground seg5 p99 GC-tail noise (65.8→70.6 ms at C9-30, un-optimized backend, no WebGL code changes — likely allocation/GC pressure) | (d) | **next-campaign seed** unless a C10 task touches the shared scene path; note-only for `C10-30` noise budgeting. |
| `NEW-WEBGPU-CELESTIAL-RETAINED-RESOURCES`, `NEW-WEBGPU-STARFIELD-SINGLE-SUBMISSION` (WebGPU-only per-frame celestial waste C9-06 deferred) | (b) | **W1 cheap-rider candidates** |
| `NEW-WEBGPU-DEBUG-DEPTH-PLANE-GATE-PARITY`, `NEW-WEBGPU-POINT-BLENDOPTION-SYNC` (small parity gaps) | (b) | cheap correctness intake |
| `NEW-WORKSPACE-SPEC-BUNDLE-FRESHNESS` (stale-spec Karma trap) | (b) | tooling row; workaround (explicit `npm run build --workspace @cesium/engine` before focused test) copied into every C10 brief running Jasmine |
| `C9-08` octree-persistence, `C9-16` enabled-multi-frustum evidence (deferred remainders) | (b) | seeds unless a C10 task needs them |
| **C9 run-outcome sweep placeholder** — whatever `results[]` reports at C9-slice completion (BLOCKED/FAILED/REVERTED/SKIPPED-DEP/LAND-INCOMPLETE), plus any dirty-tree WIP | (a)/(c) | **filled at intake time by `C10-00B`; wave/seed per dependency** |
| `C9-17` **Slice D** — settled `WebGPUDrawCommand`/frontend reuse (+ renderer-side implicit-FID change-gate spec). Slices A+B+C landed Batches 687/688 (group-1 creates 320→0; geometry validation O(1) 240/240 fast-path); D is the STOP-gated riskiest slice, explicitly not attempted in C9 close-out (orchestrator ruling 2026-07-17) | (b) | **seed unless `C10-30`/C9-30 attribution names model-frontend allocation; guide G9 (C9 guide) invariant 5 + STOP condition carry over** |
| `NEW-WEBGPU-OCEANNORMAL-PER-CALL-REUPLOAD` — pre-existing ~37/frame `Globe oceanNormal` re-upload + mip-enqueue storm (`_createWaterOceanMaterialBindGroupInner`, no cache guard; 20,155 jobs/540 frames measured during Batch-685 reconciliation; on any water-mask-terrain scene) | (b) | **W1 cheap-rider candidate — cache guard with clear on/off oracle (job-count counter)** |
| `C9-12-TERRAIN-STATIC-DYNAMIC-UPLOAD-SPLIT` remainder — VALID BLOCK (Batch 683 row): option A = WGSL group-0 View/TileDynamic/TileStatic split + persistent static slab (~12× staging reduction, ~115 MiB/route), needs coordinated WGSL+packer+bind-group-cache redesign | (b) | **seed — dedicated multi-batch slice family; do not open inside a C10 wave** |
| **Streamed-imagery never-shared prompt-retire lane** — Batch-686 F2a path (unique per-tile `ImageBitmap` realizations retire promptly at zero refs) has NO probe route that exercises it (GridImagery shares; verification is review+types only). Needs a real-imagery direct-upload lane asserting bounded `zeroRefBytes` + prompt retirement counters | (b) | **tooling/verification row — pairs with the `C10-30` feature-loss check** |

**Output:** the seeded §3.2 ledger + a one-paragraph launch note ("C9 landed X/N; fallout intaken as
M rows; C9-30 verdict = pass|iterate; C10 wave order adjusted by <attribution>") presented to the
maintainer before launch, with a `git branch -a` inventory.

---

## 5. Waves and queue rows

Waves are executed **strictly sequentially inside the engine loop** — "wave" is a planning grouping,
not concurrency. Order within a wave is `TASKS` array order. `C10-00`/`C10-00B` run before W1 as
infra/gate setup. Rationale (guide H7 Part A): land the risk-free structural ×2 anchor first, then
cheap high-leverage riders with no dep on it, then the bandwidth family, then the internally-ordered
boot/compile chain, then the pick-fleet correctness, then measure.

**Wave-8 (register) → Campaign-10 ID mapping.** The register's §13 proposed the W8 rows as
`C9-40…C9-49`; those numbers collided with in-flight C9 rows, so C10 renumbers them `C10-01…C10-10`
ordinally. Pick-fleet (`C10-11`/`C10-12`) is C9 fallout, not a W8 row; reversed-Z (`C10-13`/`C10-GT`)
is register §15.

| Register W8 row | Proposed C9 ID | Campaign-10 ID | Guide |
| --- | --- | --- | --- |
| W8-1 ENV-COMMAND-FRUSTUM-BINNING | C9-40 (verified) | `C10-01` | H1 |
| W8-2 TILES-STYLE-COMMAND-ECONOMICS | C9-41 (C9-34 proposed owner) | `C10-02` | H2 |
| W8-3 MSAA-BOUNDARY-BYTES-CONTAINMENT | C9-42 (verified) | `C10-03` | H3 |
| W8-4 SPLAT-ASYNC-SORT | C9-43 (verified) | `C10-04` | H4 |
| W8-5 MODEL-TEXTURE-MIP-CHAIN | C9-44 (verified) | `C10-05` | H4 |
| W8-6 TTFF-BOOT-CONCURRENCY-AND-PREWARM | C9-45 | `C10-06` | H5 |
| W8-7 ASYNC-MODEL-PIPELINES | C9-46 | `C10-07` | H5 |
| W8-8 MODEL-SHADER-SPECIALIZATION-AXES | C9-47 | `C10-08` | H5 |
| W8-9 VELOCITY-PREV-BUFFER-GPU-COPY | C9-48 (C9-38 proposed owner) | `C10-09` | H2 |
| W8-10 SHADOW-CAST-SINGLE-SWEEP | C9-49 (NEW owner) | `C10-10` | H2 |

### Infra / gate rows (run before W1; `C10-30` at W5)

| ID | Pri | Effort | Work / acceptance |
| --- | --- | --- | --- |
| `C10-00-ENGINE-HANDOFF-AND-SCRIPT-GEN` | R0 / infra | S | Fork `.claude/workflows/campaign-9-resume.js` → `campaign-10.js`: CHARTER (fix the stale 24-bit-mask sentence → 40-bit, safe on a fresh launch), schemas, all five prompt builders, `safeAgent`, and the per-task loop BYTE-IDENTICAL; replace `meta`, splice the C10 `TASKS` (wave order below, each brief carrying the C9 hard-rules block + this queue/register/cluster-guide pointers + the promotion rule + ledger mandate + verify-premise-first), keep `RESEARCH=[]`. Assign `model:'opus'` to every task with a landed cluster guide; consider `auditModel:'fable'` on shader-math tasks (`C10-01`, `C10-11`). Create this queue doc (mirror C9 §1/§3/§3.2). Accept: `node --check` passes; forbidden-pattern scan clean (`while(true)`/`Date.now(`/`Math.random(`/unbounded recursion/bare `await agent(`); DAG validated (every `deps` id exists, no cycle, wave chain intact); diff-vs-pristine shows ONLY meta/TASKS/context-docs changes; batch numbering left to the land agent (monotonic from git log, no reset). |
| `C10-00B-C9-FALLOUT-INTAKE-SWEEP` | R0 / gate | S | At C9-slice completion, sweep the four sources (§4) and produce the seeded §3.2 ledger + launch note. Resolve any LAND-INCOMPLETE unpushed commits FIRST; salvage + clean abandoned WIP so C10 launches on a clean tree (`tsc` green); if `C9-30` missed, apply its per-stage attribution to the wave order. Accept: every fallout item has a §3.2 row (status + evidence + wave/seed disposition); tree clean at launch; launch note presented to the maintainer with branch inventory. |
| `C10-30-DEFAULT-PATH-PERFORMANCE-CHECKPOINT` | R0 / gate (W5) | M | Measurement-only. Rebuild one hash (`npx gulp build`, clean tree). Predeclare the anchor (**the recorded `C9-30` clean-r5 artifact**, or Gate-A `B8015811…` = WebGL 5.50 / WebGPU 7.51 ms as a labelled fallback if `C9-30` never ran — **never re-derive a fresh baseline on the new tree**) + WebGL budget + noise rule in the §3.2 row. Run clean then API lane, `--workload moving-camera-altitude-track-3d --repetitions 5 --renderer both`, fresh process, offline boot, new artifact names (`campaign10-c10-30-checkpoint-{clean,api}-r5-<DATE>.json`, never overwrite). Accept/PASS: both artifacts same `runtimeBundle.sha256`, `result:"pass"`, 10/10 runs `quality:"clean"`, all 8 segments ≥30 samples, 0 page/device errors, 0 externalRequests, both aggregates `stable:true`; combined tranche ≥10% whole-route + ≥15% near-ground (seg 5+6) WebGPU CPU-p95 vs anchor OR >3× noise, no route-segment p99 regression either backend, no WebGL regression past budget, feature-loss gate green (standing reds pre-attributed, NO new red). A truthful ≥10%/≥15% MISS with all mechanics green = VALID COMPLETE = record "iterate" verdict + per-stage attribution + gated-tail recommendation. Ledger the verdict + numbers + artifact names; commit doc-only; never stage `Tools/visual-regression/output/`. |

### Wave 1 — anchor + cheap high-leverage riders

| ID | Pri | Effort | Work / acceptance |
| --- | --- | --- | --- |
| `C10-01-ENV-COMMAND-FRUSTUM-BINNING` | P0 (campaign anchor) | M | Stop BV-less `Pass.ENVIRONMENT` commands (FIVE push sites: SkyAtmosphere shell `WebGPUSkyAtmosphereRenderer.js:1354` + fullscreen `:1333`, Sun `WebGPUEnvironmentRenderer.js:621`, Moon `:1119`, StarField `WebGPUStarFieldRenderer.ts:626`) from widening near/far in `View.createPotentiallyVisibleSet` (View.js:292-298): pass-keyed exclusion + sky-only fallback (`near > far && sawEnvironmentNoBV` → camera-range window) before `updateFrustums` (View.js:320); env commands still bin and execute once in the farthest frustum; Batch-247 dedupe byte-untouched; `numFrustums` added to `getDebugSnapshot`. JS-only, zero shader changes. Accept: new `probe-frustum-count-3d.mjs` shows WebGPU `numberOfFrustums === 1 === WebGL` at 18,000 km/500 km/300 m with sun/moon/stars/atmosphere pixels intact and sky-only leg unchanged (PNGs read); capture-and-diff battery + `probe-2d-cv-modes` + `probe-2d-frustum-bins` + pick probes green; Karma Multifrustum/FrustumCommands green; moving-altitude clean lane ≥5 counterbalanced reps OFF/ON/RESTORED vs Gate-A anchor, delta honest (banner only if ≥5% named-stage p95 or >3× noise; **structural frustum parity is the landing bar regardless**). Rollback: single revert; probe + telemetry survive. |
| `C10-09-VELOCITY-PREV-BUFFER-GPU-COPY` | R1 | M | Revision-skip + GPU self-copy for the TAA prev-instance-buffer identity case in the three renderers that CPU-re-upload static instance arrays every frame: PointCloud (`WebGPUPointCloudRenderer.ts:1736-1761`, default + LOD path), Gaussian splat (`WebGPUGaussianSplatRenderer.ts:1644-1665`), Cloud (`WebGPUCloudRenderer.ts:1421-1442`). Identity case (`prevInstanceData === instanceData`) seeds `prevInstanceBuffer` ONCE via `copyBufferToBuffer` then skips while `instanceDataRevision` is unchanged; animated distinct-array path unchanged; seed/count-change GPU-copy unchanged. Add `instanceDataRevision`/`prevBufferRevision`, bump at every content-write site, reset on realloc. Leave the private mid-frame submit alone (FAR-200 is a separate concern). Accept: static point/splat + TAA lane shows prev-buffer upload bytes/frame → 0 after seed (API instrumentation); velocity texture byte-identical (PNGs); animated `probe-timedynamic-pointcloud-load` still captures motion; moving-altitude on/off/restored, promote if ≥5% named-stage p95 or >3× noise. Each renderer independently revertable. |
| `C10-10-SHADOW-CAST-SINGLE-SWEEP` | R1 | M | Fold shadow cast-candidate collection into the single PVS sweep: collect a per-frame caster sublist (`castShadows` in a shadowed pass, camera-visible OR camera-invisible-but-light-visible) during `View.createPotentiallyVisibleSet`, publish via `frameState.shadowState.casterCommands`; rewrite `SceneRenderer.insertShadowCastCommands` (`:782-824`) to iterate the sublist + do only light/cascade culling — no second full-`commandList` scan, no per-command `updateDerivedCommands`, no per-call `shadowedPasses` alloc/`.includes`. **INV-1 (critical): off-camera casters preserved** (collect BEFORE the camera-cull `continue`); **INV-2**: camera-INVISIBLE casters get `updateDerivedCommands` at collection time (their only build site). Backend-agnostic; guarded on `shadowsEnabled`. Accept: CSM scene with a caster leaving the frustum but still shadowing visible ground — WebGPU + WebGL shadow output pixel-identical before/after (PNGs — failure mode is a shadow popping out); off-camera casters still in `passes[].commandList`; default no-shadow route zero new cost; moving-altitude CSM+dense workload on/off/restored, honest-partial valid if below bar (default benchmark has no casters). Two files revert together. |
| `C10-04-SPLAT-ASYNC-SORT` | R2 | M | Replace the synchronous main-thread comparator sort in `WebGPUGaussianSplatRenderer.maybeSortSplats` (`:906-987`, `Array.prototype.sort` `:974`, per-sort `Float64Array(count)` `:963`) with the shipped `GaussianSplatSorter.radixSortIndexes` WASM worker (the exact WebGL asset), consumed one-frame-stale into `sortedIndexBuffer`, filling the unused `sortRequestPending` scaffolding. **STOP-AND-BLOCK first:** trace the production `_splatData`/`_splatCount` producer (probe injects it; no JS assignment found — block if none exists). Feed a fresh transferred `Float32Array` positions copy + `view*modelMatrix`; reject results by (data-generation, request-id) tag; adopt the full WebGL cadence (≥3-frame interval AND position Δ≥1.0 OR angle Δ≥0.5°), not angle-only. Accept: `probe-splat-sort.mjs` all-green (back-to-front order still consumed, pick unchanged); continuous-orbit ≥1M-splat lane shows the periodic multi-hundred-ms main-thread hitches eliminated (off/on/restored, report p99 + max-long-task, sort on a worker thread); no comparator sort remains; no WGSL/buffer/bind-group change. Do NOT wire `WebGPUGPUSortKeysDispatcher` or touch velocity prev-buffers (`C10-09`). |

### Wave 2 — bandwidth

| ID | Pri | Effort | Work / acceptance |
| --- | --- | --- | --- |
| `C10-03-MSAA-BOUNDARY-BYTES` | P1 | M | Demand-driven MSAA color resolve for the scene FB (ruling §2 (b)+(d)): `getColorAttachments` gains a `resolve` option (default true), the three scene-FB open sites (`PassRedirect.ts:143`, `_resumeScenePass`, `_clearDepthStencil`) pass false, a context dirty flag keyed on C9-07's `_activePassTarget==="scene-framebuffer"`, and a zero-draw load/store/resolveTarget ensure pass runs before every resolved-color consumer (refraction capture, OIT composite, invert-class composite, BV debug, pre-post-process ALWAYS, debug/readback). Reuse C9-09 attachment-demand registry if it landed; else local flag marked fold-in. Accept: scene-COLOR resolve-bearing passes/frame 10→exactly 1 on default globe (in-page `beginRenderPass` counter BUCKETED per attachment — MRT slot-1 G-buffer resolves are out of scope and stay unchanged; raw unbucketed counts read ~20→~11; JSON artifact), MSAA1 = 0 and byte-identical, default MSAA4 canvas byte-identical pre/post (0 px, frozen clock), HDR/resize/invert/transmission scenarios 0 device errors, capture-and-diff at C9-07 baseline status, moving-altitude clean+API both backends all 8 segments on/off/restored (CPU p95 flat; GPU delta honest vs noise), analytical ~330 MB/frame @1080p elision accounting cited. PLUS part (d) verification: Batch-234 TAA→samples-1 forcing intact (`WebGPUSceneRenderer.ts:1402-1411`), gate probe asserts effective 1 under `taaEnabled` + restore-on-off, `probe-taa-jitter` GATE PASS; flip-frame validation errors stash-attributed to `NEW-WEBGPU-SCENE-PASS-MSAA-FLIP-TRANSITION` if pre-existing. No WGSL/ShaderDefine/pipeline changes; single-commit revert boundary. |
| `C10-05-MODEL-TEXTURE-MIP-CHAIN` | R2 | M | Give glTF/3D-Tiles model material textures a real mip chain AND make the shader sample it (both prongs, same batch). Shader (`ModelPBRComplete.wgsl`): hoist `dpdx/dpdy(texCoord0/1)` at `fragmentMain` entry (`:2356`, before any non-uniform discard) and convert the ~30 **material** `textureSampleLevel(...,0.0)` sites (baseColor/normal/MR/specular/emissive/occlusion/clearcoat/sheen/transmission) to `textureSampleGrad` (Batch-57 pattern `GlobeTerrain.wgsl:3138-3151`); leave ALL data-lookup samples (batch/featureId/featurePick/edge/globeDepth/SDF/clipping) at LOD 0. Allocation: **trace which path real model textures take** — stub (`WebGPUModelRenderer.ts:1958` → `WebGLStubTexture.ts:289`, gated on `wantsMipmaps`) vs fallback (`:1985`, `mipLevelCount=1`) — allocate a full chain on the LIVE path; run `WebGPUMipmapGenerator` at upload through `ResourcePlan`/FAR-200 frame-owned submit (C9-12A precedent, NO private draw-path submit). Skip KTX2/compressed/pre-mipped (STOP-AND-BLOCK #2). Accept: magnified-texel close-up model probes byte-identical (`probe-model-pbr-ibl-parity`, `probe-model-color`); `probe-mipmap-check`/`probe-mip-debug` confirm a chain exists; distant city-tileset lane loses shimmer + matches WebGL trilinear (PNGs); `gpuPassCost` model-draw GPU p95 drops on the distant lane (off/on/restored, the ~100× sample-bandwidth win); +33% VRAM on newly-mipped uncompressed textures acknowledged, no residency budget (C9-15/FAR-200-S3) blown. |
| `C10-02-TILES-STYLE-COMMAND-ECONOMICS` | R2 | M | Port the WebGL translucent-command economics onto the WebGPU model FR: emit the `Pass.TRANSLUCENT` twin only when the applied style mixes opacity, and suppress the opaque primary in the `ALL_TRANSLUCENT` case. Read `model.styleCommandsNeeded` fresh each frame (`StyleCommandsNeeded`, `ModelDrawCommand.js:135-160` is the gate to mirror); gate the dual-emission block (`WebGPUModelRenderer.ts:5966`) on `emitTranslucentTwin`; gate the primary push on `!suppressOpaquePrimary`. **INV-6 conservative:** `undefined` → emit twin (today's behavior). Do NOT touch the batch-texture force-create (`WebGPUModelFeatureId.js:287-297`) — separate slice. Verify `BatchTexture.translucentFeaturesLength` is maintained on the WebGPU path (T-3, highest-risk premise) before claiming INV-2. Accept: unstyled b3dm/photogrammetry tileset — tile-content translucent command count → 0, total command count ~halves, split-screen pixel-unchanged; subset-translucent style → twin reappears + correct semi-transparency (pixel-compare WebGL); all-translucent → only translucent emits (or PARTIAL residual opaque draw, still correct, named as follow-up); `drillPick` feature still resolves; moving-altitude tileset workload on/off/restored, promote if ≥5% p95 or >3× noise. Single-file revert (+ import). |

### Wave 3 — boot / compile chain (land in order; hard dependency)

| ID | Pri | Effort | Work / acceptance |
| --- | --- | --- | --- |
| `C10-06-TTFF-BOOT-CONCURRENCY-AND-PREWARM` | P1 | M | Three independently-committable sub-steps. (A) Kill the cheap serializers: delete the two dead awaits (`WebGPUContext.ts:1108-1113`, both no-op `initPrimitiveShaders`/`initCollectionShaders`), hoist the inline `WebGPUPrimitiveIndexUtils` import (`:1065`) off the critical path. (B) Adapter/chunk concurrency: prefetch `requestAdapter` (RendererType.ts adapter-prefetch cache preferred, else `Promise.all` in `ContextFactory.createWebGPU`) threaded into `WebGPUDevicePool.acquireDevice` as an optional `prefetchedAdapter`, conservative fallback on mismatch. (C) Real prewarm, fire-and-forget at init: `warmUpGlobeRenderer(context)` (the 2-variant GlobeTerrain prewarm the lazy `:858-865` path defers to frame 1) + wire `WebGPURenderPipelineCache.preloadBatch` for the deterministic set (globe depth, depth plane, PP identity/tonemap/FXAA, auto-exposure compute, sky atmosphere) via the same descriptor factories (INV-06-3 cache-key identity). Never await prewarm (catch-drop). Optional S8-4 lazify rider LAST/separate. Accept: TTFF oracle (C9-30 stack, deterministic-offline-boot or moving-altitude `--renderer both -r5` clean) — `rendererReady→firstFrame` WebGPU delta shrinks from **9.1×/+146 ms** by ≥5% named-stage p95, on/off/restored; cache-hit oracle (`pipelineStatus()` shows deterministic set as hits not created on frame 1 — T-06-a); byte-identical globe/sky/depth (PNGs); viewer boots WebGPU+WebGL 0 errors. |
| `C10-07-ASYNC-MODEL-PIPELINES` | P1 | M | **Deps `C10-06`.** Propagate the globe async pipeline pattern (`resolveGlobePipelineEntry`, `WebGPUGlobeSurfacePipelines.ts:586-621`) to the model + PP paths (132 sync `createRenderPipeline` vs 5 async today). Model `getPipeline` (`WebGPUModelPipelineCache.ts:3056`) → central-async resolve with tolerate-one-frame null-skip; **verify the draw executor SKIPS on null pipeline** (T-07-a, patch if absent). Keep the sync escape hatch ONLY for must-render passes (capture precedent) + pick (Step 2a, correctness). Preserve the C2-22 magenta-error-swap + `_errorSwapGeneration` (INV-07-3). PP stages async through the central cache; HDR toggle → **build-new-then-destroy-old** (INV-07-5, no black-flash blit gap). Prewarm the model variant matrix at resources-ready. Accept: no sync `createRenderPipeline` on the model/PP draw path (`pipelineStatus()`); model renders within ≤1 frame of first appearance (PNG, no magenta); moving-altitude tileset API lane p99 tile/model-arrival spikes drop vs baseline; HDR-toggle no black flash; C2-22 forced-error still swaps magenta; warm-cache `capture-and-diff` byte-identical. |
| `C10-08-MODEL-SHADER-SPECIALIZATION-AXES` | R2 | M | **Deps `C10-07`.** Add-only specialization of the runtime-flag model uber-shader. **STOP-AND-BLOCK #0: the `ShaderDefine` register is nearly FULL** (bits 0-30 occupied, `WebGPUShaderDefines.ts`; bit 31 is the sign-bit hazard, material-mask bits ≤ bit 28 for `computeKey`'s `md<<3`). Audit the bit budget FIRST. Honest deliverable: promote the highest-separation axis that fits as a render-mode bit (**shadow mode**, rank 1) in the one free slot, proving the mechanism + banking the occupancy win, AND surface the define-width expansion (Uint32→wider) as the immediate next work item (`C10-08b` follow-on) for the remaining 6-7 axes. Wrap CSM/point-shadow blocks (`ModelPBRComplete.wgsl:1585-1615/1690+`) in `//>>ifdef`; set the bit in `effectiveDefines` (`:2510-2519`) via a sticky per-primitive flag; `//>>else` = today's code (byte-identical at `defines=0`). Accept: per-variant `capture-and-diff` byte-clean vs runtime-flag output (PNGs); `defines=0` byte-identical to the original monolith; pipeline count bounded (≤2× per binary axis) + stable across frames (`pipelineStatus()`); moving-altitude base-material-heavy lane ≥5% model-fill p95 or >3× noise (honest miss valid); `C10-07` p99 oracle still green. New bit stays even on revert (add-only). |

### Wave 4 — pick fleet (correctness; own oracle, no metric)

| ID | Pri | Effort | Work / acceptance |
| --- | --- | --- | --- |
| `C10-11-PICK-FLEET-LOG-DEPTH` | P0 | XL | Convert the ENTIRE native WebGPU pick producer fleet to write log `frag_depth` against the full-frustum `_logDepthEncodeNearFar` encode (INV-1/2/3), mirroring the Batch-673 scene half. **Cohort A** (shared-module entries reusing the color module via `buildPickPipelineDescriptor`: globe `fragmentPickMain`, model `fragmentPick{Main,HoverMain,MetadataMain}`, voxel `fragmentPickVoxelMain`, compute-instance, + confirmed A families) = pick FragOutput gains `//>>ifdef LOG_DEPTH @builtin(frag_depth)` + `csm_writeLogDepth` + near discard, reusing the color varying/factor (mostly zero JS). **Cohort B** (9 dedicated pick modules: 3 collection + 6 primitive) = add `v_logDepth` varying in vertex, `frag_depth` in fragment, OR-in the `LOG_DEPTH` define at the pick pipeline build site, pack log lanes into the pick camera UB. **INV-2 all-or-nothing** on the shared pick FBO; kill switch = `_logDepthWriteEnabled`. Cross-link the FAR-707 reversed-Z convert-back surface in both work items; do NOT land with reversed-Z. Accept: every per-family pick probe matches its WebGL control at 20/500/5,000 km (probe list in H6); `probe-collections-far-camera` + `probe-logdepth-globe` stay green; no `frag_depth`-factor-zero over-occlusion (verify lane 51 non-zero per family); broad pick suite green. Feature-preservation (INV-5): no family disabled/degraded. One commit (whole fleet). |
| `C10-12-PICK-DEPTH-PLANE-GATE-FLIP` | P0 | M | **Deps `C10-11` (all family probes green).** Flip `PICK_DEPTH_PLANE_ENABLED=true` (`WebGPUSceneRendererPickPass.ts:69`); re-run `probe-depth-plane-horizon-oracle.mjs` — all three altitudes × three phases (`normal`/`diagnostic-skip`/`restored` = on/off/restored oracle) pass with zero `failures[]`; back marker occluded in `normal`, pickable in `diagnostic-skip`, re-occluded in `restored`. Tighten the oracle to count only below-limb marker pixels (mask the sprite-above-limb residual: 538 px @20 km, 70 px @500 km) + re-baseline JSON. Close `C9-02B` + `NEW-WEBGPU-DEPTH-PLANE-LOG-DEPTH-CONTRACT` + audit `P0-1`; move `NEW-WEBGPU-PICK-FLEET-LOG-DEPTH` out of DEFERRED_WORK; log to `WEBGPU_DEBUGGING_LOG.md`. Rollback = flip constant false (fleet stays log-encoded, harmless). |

### Wave 5 — measured checkpoint

`C10-30-DEFAULT-PATH-PERFORMANCE-CHECKPOINT` (row in the infra/gate table above). R0/gate. Decides
which gated-tail items get pulled.

---

## 6. Gated tail (do NOT auto-run)

Activated ONLY by the `C10-30` verdict AND fresh maintainer sign-off. Not scheduled by the engine.

| ID | Status | Gate to open |
| --- | --- | --- |
| `C10-13-REVERSED-Z-EARLYZ-SPIKE` | measurement-only, openable | Cheap FAR-707 evidence gate (register §15.6): one probe scene (horizon-oblique globe + dense tiles) compiled with `defines=0` hyperbolic `//>>else` branches + reversed-Z infinite-far + `depth32float` + `greater-equal`; measure fragment-invocation/`gpuPassCost` delta vs default log-depth. **MUST record its GO/NO-GO in BOTH `NEW-WEBGPU-PICK-FLEET-LOG-DEPTH` and the FAR-707 brief + DEFERRED_WORK before the pick fleet's log-depth conversion is treated as permanent** — the two streams pull the same 71-file producer surface in opposite directions. Nothing from the spike lands on main except the report. |
| `C10-GT-REVERSED-Z-SLICE-B` | **DEFERRED — do not schedule** | Openable ONLY after: `C10-01` landed (frustum-count claim carved out); `C10-13` spike GO (≥20-30% fragment-work reduction on weak-FPS views); pick-fleet reconciliation decision recorded (GO ⇒ pick fleet converts directly to reversed-Z f32, `C10-11` log-depth conversion skipped/undone knowingly); written `depth32float-stencil8` fallback story covering every supported adapter tier (any tier left behind = forbidden dual permanent architecture = NO-GO). Scope of record (guide H1 dossier): 71 producer `.wgsl` LOG_DEPTH surfaces retired; 140 `depthCompare` sites/47 files flipped + clearValue 1→0 behind a single `_reversedZEnabled` master switch (OFF = byte-identical); 42 `_logDepthEncodeNearFar` JS sites + ~14 depth-consumer families re-linearized; RGBA8 pack ecosystem (`WebGPUGlobeDepth`/`PickDepth`) deleted for r32float/direct depth (un-owned prize: 2-3 fullscreen pack passes/frame); TAA `previousViewProjection` carries the flip; 2D/CV/ortho carved out; RTE high/low untouched. All-or-nothing landing. |
| `C10-03R-MSAA-DEFAULT-FLIP-RESERVE` | **CONDITIONAL NOT TRIGGERED** | Reserve lever (ruling §2 (c)). Pull ONLY on a `C10-30` miss WITH bandwidth-attributed evidence AND fresh maintainer sign-off recorded here. Then: backend-conditional WebGPU default `msaaSamples` 4→1 (one line at `Scene.js:488`/bridge, WebGL untouched, user opt-in preserved) + release note + visual-policy gate probe + moving-altitude on/off/restored. Any slice found flipping the default without the recorded sign-off is reverted on sight. |

**Next-campaign seeds** (register §14 — NOT C10 tasks; recorded so the `C10-30` verdict can point at
them): S1 frame-delta retained-commandList tier (true shadow-caster revision-maintenance depends on
it); entity-at-scale arc (S10); worker-renderer productization; geometry-residency dedupe;
model define-width expansion (`C10-08b`, unblocks the remaining 6-7 specialization axes); FAR-200
private-submit-timeline consolidation (`C10-09`/`C10-05` mip blit leave it alone).

---

## 7. Pointers

- **Execution guide (per-task walkthroughs + engine mechanics + fallout intake):**
  [CAMPAIGN10_EXECUTION_GUIDE_2026-07-16.md](CAMPAIGN10_EXECUTION_GUIDE_2026-07-16.md).
- **Register (69 findings):** [PERF_ARCH_DEEP_DIVE_2026-07-16.md](PERF_ARCH_DEEP_DIVE_2026-07-16.md)
  — §13 proposed rows, §14 seeds, §15 reversed-Z verdict, §16 TTFF budget, §17 contradicted
  assumptions. Raw strata: `scratchpad/perfdive/S1…S11-*.md`.
- **C9 queue / ledger (fallout source + gate/vocab exemplar):**
  [QUEUE_2026-07-15_CAMPAIGN9.md](QUEUE_2026-07-15_CAMPAIGN9.md) §1/§3/§3.2.
- **C9 execution guide (format + engine-handoff + C9-30 protocol exemplar):**
  [CAMPAIGN9_OPUS_EXECUTION_GUIDE_2026-07-16.md](CAMPAIGN9_OPUS_EXECUTION_GUIDE_2026-07-16.md) §G10.
- **Engine base (fork target):** `.claude/workflows/campaign-9-resume.js` (untracked) → `campaign-10.js`.
- **Runner / workload:** `Tools/visual-regression/run-performance-campaign.mjs`;
  `performance-workloads.json` (`moving-camera-altitude-track-3d`, 8 segments, near-ground idx 5+6).
