# Migration-Doc Audit & Cleanup Plan

**Generated:** 2026-05-30 · **Repo HEAD:** `88b111e49c` (Batch 185 — flat textured-material GroundPrimitive classification fix, packExtents wrapper-chain walk) · **Source:** consolidation of 45 per-file audit verdicts.

> Conventions: **KEEP** = leave in active `migration_doc/`; **UPDATE** = edit in place (still load-bearing); **ARCHIVE** = move to `migration_doc/archive/` (preserve history, mark superseded); **DELETE** = only where truly redundant (we prefer archive everywhere). An `archive/` dir already exists (holds prior completed plans + deprecated docs); an `audits/` dir holds the 2026-04-30 trio.

---

## 1. Executive summary

The migration-doc set is **broadly healthy but has a single dominant drift vector**: HEAD advanced through Batches 179–185 *after* most status/handoff docs were last refreshed, so seven load-bearing trackers all carry the same three stale claims:

1. **`NEW-WEBGPU-BUFFERPOLYGON-WGSL-IMPORT`** framed as an active/recommended-next compile bug — **RESOLVED in Batch 180** (`3667945dae`; `#import` now resolved at the preprocessor layer via `BUFFER_WGSL_CHUNKS`).
2. **Flat textured-material GroundPrimitive classification (Stripe/Checkerboard/Grid)** framed as "still flat, blocked on globe depth precision" — **SHIPPED in Batch 185** (`88b111e49c`; `packExtents` wrapper-chain walk at `WebGPUGroundPrimitiveRenderer.js:313`). The real root cause was a 1-hop-too-deep inner-`_primitive` lookup writing `materialMeta.x=0`, **not** depth precision.
3. **Renderer-wide log-depth epic** framed as un-started/foundational — **IN PROGRESS**, Slices 0/1/2a shipped (Batches 181/182/183).

The single most important *content* gap: **`NEW-GROUNDPRIM-CLASSIFIER-RECON-PRECISION`** (the genuine far-corner reconstruction-precision follow-up that survives Batch 185) currently exists in **exactly one file** — `WEBGPU_DEBUGGING_LOG.md` (verified: `grep -rln RECON-PRECISION migration_doc/` returns only that file). It must be propagated into the live trackers (DEFERRED_WORK, FEATURE_INVENTORY §C.4, BACKLOG, EXECUTION_ROADMAP).

Structurally, the set is **bloated with completed/superseded artifacts**: six same-day SANDCASTLE_BATCH_66 reports (all blockers resolved), four 2026-04-16 PRINCIPAL_ENGINEER_REVIEW snapshots, ~10 fully-executed `BATCH_*_PLAN_*` docs, and three dated point-in-time audits — ~22 files that should be archived, shrinking the active surface by roughly half.

**Net plan:** apply ~7 status-doc correction passes (all converging on the same 3 facts + 1 new tracker), archive ~22 completed/superseded docs into existing/new archive folders, and add a `migration_doc/README.md` index so the live-vs-historical split is legible.

---

## 2. Redundancy clusters to archive/merge

### Cluster A — SANDCASTLE_BATCH_66 reports (six files, one 2026-04-25 session)

All six are point-in-time test snapshots from a single day; every blocker they logged (F2/NEW-1/NEW-2/NEW-3-A·B·C/NEW-4-A·B·C·D·E·F/NEW-5-A) has since been **fixed and is tracked authoritatively** in `DEFERRED_WORK.md` (≈2519–2532, 2963–2967) and `WEBGPU_DEBUGGING_LOG.md`.

- **KEEP (canonical):** `SANDCASTLE_BATCH_66_TRULY_FINAL_REPORT.md` — most complete, and `DEFERRED_WORK.md:2519` already cites it as canonical.
- **ARCHIVE:** `SANDCASTLE_BATCH_66_TEST_REPORT.md`, `_FINAL_REPORT.md`, `_DEFINITIVE_REPORT.md`, `_END_OF_SESSION_REPORT.md` → `migration_doc/archive/sandcastle-batch-66/`.
- **ARCHIVE (after confirming canonical kept):** the TRULY_FINAL one too, into the same subfolder — none of the six is live; keeping one in `archive/` (not active root) is sufficient. Evidence artifacts under `Tools/visual-regression/screenshots/sandcastle-batch-66-*/` stay as-is.
- **Pre-archive guard:** confirm the only still-open finding referenced (NEW-4-E voxel WGSL was FIXED Batch 68; NEW-GROUNDPRIM-CLASSIFIER-RECON-PRECISION is unrelated/separate) is in `DEFERRED_WORK.md`. Nothing else to lift.

### Cluster B — PRINCIPAL_ENGINEER_REVIEW 2026-04-16 series (four files)

Dated audit snapshots; the C-R*/H-R*/M-R*/DP-*/B-* finding IDs they originate are referenced by 9 sibling docs (incl. live `DEFERRED_WORK.md`, 54 hits). **They are the ID-definition source**, so they cannot simply be deleted, but they should not be read as live to-do lists.

- **KEEP + UPDATE annotations:** `PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md` (originates C-R*/H-R*/M-R* IDs, 54 inbound hits — most load-bearing as a definition) and `PRINCIPAL_ENGINEER_REVIEW_PER_FEATURE_2026_04_16.md` (carries inline FIXED/DEFERRED annotations that have themselves drifted). Apply the targeted annotation corrections in §3.
- **ARCHIVE:** `PRINCIPAL_ENGINEER_REVIEW_2026_04_16.md` (build/lifecycle pillar — stale-superseded, body un-annotated, majority of findings closed) and `PRINCIPAL_ENGINEER_REVIEW_DATA_PIPELINE_2026_04_16.md` (annotated only through Batch 25; ~160 batches behind) → `migration_doc/archive/principal-review-2026-04-16/`.
- **Pre-archive guard (both archived docs):** lift still-open items into the live backlog first — from the build/lifecycle pillar: `@private→@internal` sweep on `WGSLShaderPreprocessor.ts` (5 tags remain), §3c per-frame view/bindgroup caching, §3d device-loss promise ownership, §5b bundleVariantPlugin spec, §5c spec backfill, §6c `@webgpu/types` pinning, §6e pragma-strip lint, §6h `FEATURE_RENDERER_ONBOARDING.md`; from the data-pipeline pillar: DP-H7 geodesic subdivision, DP-H18 depthFailAppearance, DP-C7/C8/C9 glTF sampler/sRGB/TEXCOORD_1, DP-H35–37, DP-H44–48, named FOLLOW-UPs (DP-H19-SHADER-DECODE, DP-H25-SHADOW-CAST, DP-H41-ALL-RENDERERS). Confirm each is present in `DEFERRED_WORK.md` before the move.
- **Conflict to resolve while annotating:** the data-pipeline doc's DP-C3 fix annotation cites `WebGPUGlobeSurfaceRenderer.ts:1908-1909`, but the packing moved to `WebGPUGlobeSurfaceTileUB.ts:79`; and its imagery coverage matrix still marks hue/gamma/splitDirection "∅ not packed" though they are now packed (`WebGPUGlobeSurfaceTileUB.ts:289/296/303`). Fix the citation + matrix in a single annotation edit *before* archiving so the archived snapshot isn't actively misleading.

### Cluster C — completed BATCH_*_PLAN_* decomposition plans (eight files)

All fully executed and shipped; each self-describes "Status: Plan only. No code changes yet." (now false). They are the rationale-of-record for shipped refactors (host-interface-per-slice, split-by-collection patterns) and are cross-cited by inline code comments + the parent decomposition plan — **archive, don't delete.**

- **ARCHIVE → `migration_doc/archive/batch-plans/`:** `BATCH_129_PLAN_WEBGL_STUB_EXTRACTION.md` (shipped `eeda10621f`), `BATCH_130_PLAN_DEVICE_INVALIDATION_BUS.md`, `BATCH_131_PLAN_RESOURCE_CACHE_REGISTRY.md` (shipped `c89eff3f63`), `BATCH_132_PLAN_FEATURE_FLAGS.md`, `BATCH_133_PLAN_PICK_PASS_EXTRACTION.md`, `BATCH_138_PLAN_EXECUTE_COMMANDS_SLICE_PLAN.md`, `BATCH_145_PLAN_GLOBE_SURFACE_DECOMPOSITION.md` (shipped `540b05294b`), `BATCH_155_PLAN_BUFFER_PRIMITIVE_DECOMPOSITION.md`.
- **On archive:** prepend a one-line `STATUS: SHIPPED (Batch NNN, commit …)` banner to each so they're not mistaken for live work.
- **Dependent live doc — UPDATE, do NOT archive:** `WEBGPU_CONTEXT_DECOMPOSITION_PLAN.md` is the parent roll-up and still lists candidates #1–#6 as "remaining future work" though all shipped (Batches 129–132 + statistics + enum-removal). See §3 for its rewrite; it stays active as the single decomposition status view but must be corrected (its header line counts are also *inverted* — both files GREW post-extraction).

### Cluster D — dated point-in-time audits / research / spikes (five files)

Superseded snapshots whose roadmaps are largely executed; the live successors are `FEATURE_INVENTORY.md`, `DEFERRED_WORK.md`, and `audits/2026-04-30_*`.

- **ARCHIVE → `migration_doc/archive/`:**
  - `COMPREHENSIVE_AUDIT_2026_03_31.md` — ~90% executed (Bloom/DoF/SSAO/IBL/CSM-cast/TAA/Ground-Atmosphere all now SHIPPED). Banner → FEATURE_INVENTORY + DEFERRED_WORK + the three 2026-04-30 audits. Repoint its single inbound ref in `WEBGPU_MIGRATION_BACKLOG.md`.
  - `WIRING_AUDIT_2026_04_02.md` — superseded by the 2026-04-30 audit trio. **Caveat:** it is named in `CLAUDE.md` Key Reference Files; update that line to point at `audits/2026-04-30_*` before/with the move. Its grossly-stale upstream-divergence counts (claims 0-behind; actual ~284 behind) and 28/36 feature-renderer counts (actual 47–48) are why it must not stay active.
  - `SNAPSHOT_MODE_SPIKE_2026-04-09.md` — entire phased plan (A–D) shipped (`SnapshotModeService.js`, `WebGPURenderBundleManager` freeze/thaw). Banner → FEATURE_INVENTORY:397 + BACKLOG WORKER-5 + CSM Slice 4.
  - `SESSION_2026-04-08_RESEARCH_REPORT.md` — explicitly self-declares "not maintained as a living document." **KEEP-as-is is acceptable** (already delegates forward), but **prefer moving to `archive/`** to declutter the active surface; do NOT reconcile its point-in-time bundle sizes / divergence counts.
  - `OVERSIGHT_AUDIT_2026_04_25.md` — every finding resolved (C-R5 4→16 layers, C-R11 cache, etc.); rollup already in `WEBGPU_MIGRATION_STATUS.md:715`. Cross-referenced by 4 docs, so archive (don't delete) to preserve link targets; add "SUPERSEDED" banner.
- **KEEP (active, but is itself a frozen snapshot by design):** `AUDIT_2026_05_02.md` — self-declares as a diffable baseline; only the C.2/Tier-5 gpuCull/HiZ "pending" rows are stale (resolved Batches 209–211). Optional one-line back-ref; not required. Leave in active root as the most-recent audit baseline.

### Cluster E — Phase-8 design docs (overlap each other)

- **KEEP + UPDATE both:** `PHASE_8_GPU_RESIDENT_TILES_DESIGN.md` (major-drift — Phase 8a foundation largely SHIPPED, but Phase 8b TileStoreGPU/DOD stack genuinely unbuilt and has no successor doc → keep) and `PHASE_8_SHADER_STRATEGY.md` (major-drift — KHR BRDFs no longer "silently dropped"; shipped impl diverged from the ~20-family table to a basic/full split). See §3 for both. Neither archives — the unbuilt Phase 8b/8e synthesis and the still-relevant variant strategy are live.

---

## 3. Status-doc corrections (consolidated, deduped, conflicts resolved)

> **Shared correction set (apply the matching subset to every doc below):**
> - **S1** `NEW-WEBGPU-BUFFERPOLYGON-WGSL-IMPORT` → **RESOLVED Batch 180** (`3667945dae`; preprocessor resolves bare `#import` from `BUFFER_WGSL_CHUNKS`; 593 device errors → 0 on sample-us-states).
> - **S2** Flat textured-material GroundPrimitive classification (Color/Stripe/Checkerboard/Grid) → **SHIPPED Batch 185** (`88b111e49c`; `packExtents` wrapper-chain walk, `WebGPUGroundPrimitiveRenderer.js:313/328`). Root cause = inner-`_primitive` lookup depth, NOT depth precision.
> - **S3** Add **`NEW-GROUNDPRIM-CLASSIFIER-RECON-PRECISION`** (far-corner reconstruction-precision; the legitimately log-depth-gated residual) — currently only in `WEBGPU_DEBUGGING_LOG.md`.
> - **S4** Renderer-wide log-depth epic → **IN PROGRESS**: Slices 0/1/2a SHIPPED (Batches 181/182/183 — define bit + master switch + lane helper inert infra, `csm_*LogDepth` chunk reconciliation, globe `@builtin(frag_depth)` flag-gated producer).

### 3.1 `WEBGPU_MIGRATION_STATUS.md` (UPDATE) — load-bearing single-source status

- Add a new top **"Recent Progress (Batches 179–185)"** section; keep all reference sections (architecture, render-pass coverage, WASM matrix, stats) and the append-only chronological log.
- Apply **S1, S2, S3, S4**. Flip the three HEAD roadblocks (BufferPolygon "active compile bug", "Stripe/Checker/Grid flat", "log-depth not started") to resolved/in-progress.
- Record **Batch 184** (Dawn/Tint uniform `vec4 .zw` past-byte-512 aliasing fix; classifier U-struct reorder) — currently unrecorded.
- Fix feature-renderer count: **"36 of 37 / all 36 registered" → 48 registered** (`WebGPUFeatureRenderers.ts` has 48 `registerFeatureRenderer()` calls; `FeatureRendererKey.js` declares 50 keys).
- Re-state the **~93% parity** banner given BufferPolygon + flat-classification closed.
- **Keep** the non-monotonic-batch-number warning already in HEAD (correct + load-bearing).

### 3.2 `DEFERRED_WORK.md` (UPDATE) — canonical add-only follow-up inventory

- **S2:** Mark `NEW-GROUNDPRIM-TEXTURED-MATERIALS` **RESOLVED-in-Batch-185**; strike its "render flat / blocked on depth precision" framing.
- **S3:** Add `NEW-GROUNDPRIM-CLASSIFIER-RECON-PRECISION` as the open residual (this is its canonical home; it is currently missing).
- **S4 / depth-precision reconciliation:** Downgrade `NEW-WEBGPU-GLOBE-CLASSIFY-DEPTH-PRECISION` approach-(A) from "foundational / not started / multi-week" → **"producer shipped (GlobeTerrain.wgsl writes log `frag_depth` under LOG_DEPTH, Batches 182/183), consumer-reverse + classifier wiring remain."**
- **Conflict — disambiguate the duplicate "Batch 185" label:** git Batch 185 is the packExtents fix, but line ~2112 also attributes `C-R7-SHADER-MODULE-DEDUP` closure to "Batch 185 (2026-05-06)". Renumber/relabel one so the two don't collide.
- **Freshness:** bump `Last Updated: 2026-05-02` (body already cites work through Batch 185).
- **Forward-dated entries — re-verify:** the cluster of RESOLVED entries citing Batches **186–230** (188/190/192/193/197/199/204/208/209/210/211/219/220/221/224/225/228/230) are FUTURE relative to HEAD=185. Re-verify against code or re-mark as open; do not let aspirational/forward-dated "RESOLVED" claims stand unaudited. (Note: `AUDIT_2026_05_02.md` cites Batches 209–211 as landed for gpuCull/HiZ — cross-check that specific pair, but treat the broader 186–230 band skeptically.)

### 3.3 `FEATURE_INVENTORY.md` (UPDATE) — load-bearing impact-analysis index (CLAUDE.md Principle 6)

- **S2 (biggest single drift):** §B.3 line 506 GroundPrimitive entry still says textured rendering BLOCKED / "only flat Color renders" → rewrite to "flat textured materials (Color/Stripe/Checkerboard/Grid) SHIPPED Batch 185 all-modes."
- **S3:** Add `NEW-GROUNDPRIM-CLASSIFIER-RECON-PRECISION` to **§C.4** (Classification WIP).
- **Append-only counter refresh (single consistent pass):** FeatureRendererKey "45 numeric slots" (line 415) → **48** (highest `CONTACT_SHADOWS:48`, `COUNT:49`); ShaderSourceId "29 as of Batch 164" (line 440) → **33**; re-count CsmBuiltins "97 WGSL helper functions" (line 476).
- **Freshness:** `Last refreshed: 2026-05-02` (line 3) → at least **2026-05-07** (body already cites Batch 192–205 entries + a 2026-05-07 audit note in §B.8). Resolve the internal inconsistency where §B.3 reflects ~Batch 174 reality while §B.8 reflects ~Batch 205 reality — sync §B.3 forward.
- **Sibling drift to flag:** §932 (FEAT-SURVEY-40) still says "Lit Mat shaders pending Batch 154+" — they shipped (Batches 154–158); fix.
- **Phase-5 reconciliation:** WGF-1 clip-distances and WGF-3 shader-f16 are SHIPPED-partial (globe / tonemapping); ensure the WGF-* tracking entries (§C/§D, ~807–810) read SHIPPED with WGF-1-EXPAND / WGF-3-EXPAND for the remainder.
- **Conflict — WGF-2 dual-source OIT:** FEATURE_INVENTORY:592 claims **SHIPPED**, but code (`WebGPUOIT.ts`) shows only the MRT composite fallback (dual-source path is a docstring aspiration, no `blend_src`/`src1`). `PHASE_5_MODERN_WEBGPU_DESIGN.md` says "never wired." **Resolve toward code:** mark WGF-2 as MRT-fallback-only / dual-source NOT wired in both docs.

### 3.4 `WEBGPU_MIGRATION_BACKLOG.md` (UPDATE) — major-drift, "single source of truth for remaining work"

- **Reclassify BUG-11** (§1, line ~494): backlog describes catastrophic "no globe primitive ever rasterizes / canvas BLACK / depth uniformly 1.0", but `WEBGPU_DEBUGGING_LOG.md:3982` re-scopes BUG-11 to the narrow **"Imagery tile gaps (dark patches)"**, and the globe demonstrably rasterizes. Rewrite to the narrow symptom / mark the catastrophic framing superseded.
- **S2 + S3:** Add the Batch 185 GroundPrimitive textured-material classification (SHIPPED) and the open `NEW-GROUNDPRIM-CLASSIFIER-RECON-PRECISION` follow-up (missing here).
- **S4:** Add the active log-depth epic (Batches 181–183) and cross-link `WEBGPU_EXECUTION_ROADMAP.md` (never referenced though this doc claims SoT for remaining work).
- **Re-evaluate §14** "All Tier 1-3 work is complete / focus now: visual verification" (April-8 framing) — 120+ subsequent feature batches contradict it.
- **Freshness:** header "Last Updated April 25, 2026" / body stops at Session 37 / Batch 64; HEAD is Batch 185 — ~120 batches unrepresented. Bump + add a "see WEBGPU_EXECUTION_ROADMAP.md for current frontier" pointer.

### 3.5 `NEXT_SESSION_HANDOFF.md` (UPDATE) — append-only handoff log; refresh TOP section only

- Refresh the top section (currently dated 2026-05-28 / Batches 167–178) to **Batch 185**, then archive it below per the established append pattern. **Do NOT touch** the archived 2026-04-27/04-25/04-20/04-19/04-16 sections.
- Point "Recommended next steps" at the new authoritative `WEBGPU_EXECUTION_ROADMAP.md` rather than re-enumerating.
- Apply **S1** (strike RECOMMENDED-NEXT #1 / roadblock #3 BufferPolygon as RESOLVED Batch 180, `DEFERRED_WORK.md:764`), **S2** (roadblock #1 textured-classifier FIXED Batch 185), **S4** (log-depth epic IN PROGRESS).
- Optional: the ~600 lines of pre-Batch-72 ES6-modernization plan (~822–968) are deeply stale; candidate to split to `ES6_MODERNIZATION_BACKLOG.md` (already exists in `archive/`) only if length becomes a problem.

### 3.6 `WEBGPU_EXECUTION_ROADMAP.md` (UPDATE) — live planning artifact (committed `fdd5b8f1a8`)

> Note: the initial git-status `??` snapshot was stale; this doc is committed and unmodified at HEAD.

- **Rewrite Executive Summary §1 + critical-path ASCII diagram:** they assert Slice 3a is "built but uncommitted in the working tree" (false — committed) and that Stripe/Checker/Grid are gated behind the Slice-4 master-switch flip (false — **S2** decoupled them in Batch 185 via packExtents). The "startup-flip payoff probe" framed as the de-risking first move (§1, §5 action 1, decisions 2/5/8) is **moot** for Stripe/Checker/Grid.
- Update §2 rows `NEW-GROUNDPRIM-TEXTURED-MATERIALS` (no longer blocked) and "log-depth Slice 3a validate" (committed).
- **S3:** Add `NEW-GROUNDPRIM-CLASSIFIER-RECON-PRECISION` as the genuine residual replacing the "textured materials blocked on the flip" framing — this is the legitimately log-depth-gated remainder (plus the Image material type-4 BGL-extension case).
- **Keep** the still-accurate plumbing audits (GroundPolyline:532 reverse-log gap, Billboard pick:613 `depthWriteEnabled:true`, GBuffer:244/260 no-preprocess, AO:445–446 hardcoded near/far) — all re-verified.
- **Coupled fix:** this doc and `DEFERRED_WORK.md:882–903` carry the *same* superseded "blocked on log-depth precision" framing for textured materials — fix both in one pass for consistency.

### 3.7 `REVIEW_FIX_PROGRESS.md` (ARCHIVE — see §2/§5; correction notes here for completeness)

This is a closed campaign log (Batches 1–66, ended 2026-04-25). **Archive** with a "FROZEN at Batch 66" banner; before archiving, lift any still-open FOLLOW-UP IDs from its "Deferred critical findings" index (lines 3051–3086) into `DEFERRED_WORK.md` — specifically verify DP-H19-SHADER-DECODE, C-P11-LOGDEPTH (now the in-flight epic, not untouched-deferred), and DP-H44/45/46 pick gaps are tracked. Its header "Last updated 2026-04-18 (through Batch 27)" is even internally stale vs its own Batch 66 body. Do **not** treat as a live tracker.

### 3.8 Principal-review annotation corrections (the two KEPT review docs)

**`PRINCIPAL_ENGINEER_REVIEW_PER_FEATURE_2026_04_16.md` (UPDATE annotations):**
- B-2 CSM "literal placeholder / identity matrix" → **FIXED** (`WebGPUCSMRenderer.ts:433` real cascade fit).
- B-5 InvertClassification "no draw command / simple post-process" → **FIXED** (two-pass stencil-gated composite, Batch 39).
- C-P9 NearFarScalar/DistanceDisplayCondition family "DEFERRED, imported by zero shaders" → **FIXED/SHIPPED** (`BillboardCollection.wgsl czm_nearFarScalar:117` + vertex locations 6–9; PointPrimitiveColor + Polyline family).
- B-9 GroundPrimitive: note the Batch 185 packExtents path made Stripe/Checker/Grid render, but the **stencil-op half remains genuinely open** (`depthFailOp:'keep'` at :1210/:1216, not DECREMENT/INCREMENT_WRAP); reference `NEW-GROUNDPRIM-CLASSIFIER-RECON-PRECISION`.
- Add a one-line banner: "Findings carry per-finding status annotations; the Executive summary reflects the 2026-04-16 baseline, not current state."

**`PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md` (UPDATE — origin of C-R*/H-R*/M-R* IDs, 54 inbound hits):**
- C-R4 (lines 101–130): change "DEFERRED" → **PARTIALLY FIXED**. SHIPPED: KHR_texture_transform (`ModelPBRComplete.wgsl:130-150,1550-1583`), KHR_materials_clearcoat (:162-169,336-345), multi-UV/texCoord1 (:629,660,749), model pick `fragmentPickMain` (:2914). STILL OPEN: model log depth, silhouette, atmosphere/fog (the 6 orphaned `Model*Stage.wgsl` files still exist — M-R13 hygiene concern is live).
- Add a top banner: "Executive summary reflects the 2026-04-16 baseline; per-finding annotations are authoritative for current state."

### 3.9 `WEBGPU_CONTEXT_DECOMPOSITION_PLAN.md` (UPDATE — parent roll-up, keep active)

- Fix inverted header line counts: WebGPUContext `4354 → 5178`, WebGPUSceneRenderer `3626 → 4016` — **both GREW** (feature growth outpaced extraction; the <1000-LOC goal is *further* off). Call this out explicitly.
- Rewrite "Already extracted" (currently 1 module) to list all 6: `WebGPUContextLimitsInit.ts` (now 104 LOC), `WebGPUDeviceInvalidationBus.ts`, `WebGPUFeatureFlags.ts`, `WebGPUFrameStatistics.ts`, `WebGPUResourceCacheRegistry.ts`, `WebGPUContextWebGLStubInit.ts`.
- Mark candidates #1–#6 **DONE** with batch numbers (129/130/131/132 + statistics + enum-removal). Mark "Pick path" (line 122) DONE (Batch 133). Re-scope "remaining" to the genuinely-unfinished SceneRenderer residual (core still 4016 LOC despite 11 `WebGPUSceneRenderer*.ts` split files + `WebGPUPostProcessPipeline.ts`).

### 3.10 Smaller design-doc fixes (UPDATE, low urgency)

- `CSM_DESIGN.md`: EffectsUniforms size 240B/272B → **480B** (`WebGPUEffectsBindGroup.js:198`); `ShadowCastCSM.wgsl` was never created (cast reuses `ShadowMap.wgsl`; only `ShadowReceiveCSM.wgsl` exists); note `renderCastPass` moved to `WebGPUCSMCastPass.ts` (Batch 159); fix line-69 spec path → `Specs/Renderer/WebGPU/`.
- `TAA_DESIGN.md`: header "Slices 2-4 pending" → "Slice 1 + 2a SHIPPED; 2b/3/4 pending"; tail "Spec coverage delta" references nonexistent `WebGPUTAAEffectSpec.js` (real file: `WebGPUTAASkyAndTeleportSpec.js`).
- `SLICE_5D_PLAN_CLUSTERED_LIGHTING.md`: flip body markers — Batch 153 "→ PENDING" → SHIPPED; lines 252-254 past-tense; "Batch 154+ Lit Mat shaders" → SHIPPED (154–158).
- `SHADER_PAIRS_LOCKSTEP.md`: header "Status: Drafting" → "Phases 1–3 shipped; Phase 4 + Naga-verifier outstanding"; resolve `2026-05-XX` placeholder dates → `2026-05-18`.
- `CELESTIAL_ATMOSPHERE_DESIGN.md`: delete/mark-DONE the stale §6 "Remaining work (estimated 1 session)" block (Phase 4 shipped Batch 29); renumber the duplicate `## 13` heading → §14.
- `WATER_RENDERING_DESIGN.md`: reconcile `scene.water.*` → `scene.globe.water.*` (code: `Globe.js:560`/`GlobeWater.js`); mark Phase 0/0.3 DONE (`GlobeWater.js` shipped); add a status banner (Phase 0.3 landed, Phases 1–9 unbuilt).
- `IMAGERY_PROJECTION.md`: reconcile the frozen "Remaining issue (Batch 61)" / Batch-66 "polar pixel residual / probe in flight" tails against `WEBGPU_DEBUGGING_LOG.md` + `DEFERRED_WORK.md:2946` (probe work continued through Batch 70+); core technical content verified accurate — do NOT restructure.
- `DEBUGGING_GUIDE.md`: line 256 `probe-classifier-textured-materials.mjs` row — drop "BLOCKED on globe depth precision", note Batch 185 fix + `NEW-GROUNDPRIM-CLASSIFIER-RECON-PRECISION` residual; line 259 Vector3DTile note — drop "BufferPolygon currently broken", reflect RESOLVED Batch 180; optionally refresh "90+ scripts" → 195.
- `OPTION_B_SCENE_IN_WORKER.md`: §7 blocker narrative is superseded — headless Scene construction now attempted (`RendererWorker.js:138-175`); the `typeof document` early-throw it describes no longer exists. Add a dated note + re-verify the current first-failure point.
- `PHASE_8_GPU_RESIDENT_TILES_DESIGN.md` / `PHASE_8_SHADER_STRATEGY.md`: see §2 Cluster E — strike the "KHR silently dropped" / "3-bit-key / 6-variant" / "~20-family table" premises; add "What actually shipped" reconciliation; fix bit-budget ("15 of 24 / 9 remain" → "16 allocated bits 0-15, 8 remain") and shader LOC (`ModelPBRComplete.wgsl` 2943 → 3102).

---

## 4. Load-bearing docs verified accurate — leave alone

- **`WEBGPU_DEBUGGING_LOG.md`** (KEEP-AS-IS) — canonical append-only log; all 6 sampled factual claims verified; the top "Batches 105-115b" reverted-MRT arc is **chronological-by-design** (resolved by the doc's own Batch 116-118 entries; code confirms `_mrtMode = true`). Optional touch-ups only: extend the TOC (currently indexes Sessions 1–26, misses Batch 67–184 bulk); the `NEW-GROUNDPRIM-CLASSIFIER-RECON-PRECISION` token propagation is tracked in §3 (it's the source, others are the destinations). **Do NOT prune historical entries.**
- **`AUDIT_2026_05_02.md`** (KEEP) — self-declared diffable snapshot; bulk of A/B/C resolution claims verified; only C.2/Tier-5 stale (optional back-ref).
- **`FUTURE_RESEARCH_2026_05_01.md`** (KEEP-AS-IS) — forward-looking R-1..R-7 triage; all "not present today" claims correct; only trivial line-anchor drift (`supportsBasis` 2340→2650; `GltfLoaderUtil.js` 49→55) — opportunistic only.
- **`SHADER_PAIRS_LOCKSTEP.md`**, **`CSM_DESIGN.md`**, **`TAA_DESIGN.md`**, **`SLICE_5D_PLAN_CLUSTERED_LIGHTING.md`**, **`CELESTIAL_ATMOSPHERE_DESIGN.md`**, **`WATER_RENDERING_DESIGN.md`**, **`IMAGERY_PROJECTION.md`** — core content accurate; only the small in-place fixes in §3.10 (status lines, stale tails, namespace reconciliation). All KEEP (not archive).
- **`DEBUGGING_GUIDE.md`** (KEEP) — self-maintaining reference per CLAUDE.md; only the two probe-row corrections in §3.10.

---

## 5. Organization plan — structural moves

### New archive subfolders (under existing `migration_doc/archive/`)
- `archive/sandcastle-batch-66/` ← all 6 SANDCASTLE_BATCH_66_*.md (Cluster A)
- `archive/principal-review-2026-04-16/` ← the 2 archived PRINCIPAL_ENGINEER_REVIEW pillars (build/lifecycle + data-pipeline) (Cluster B). The 2 kept-and-annotated review docs stay in active root.
- `archive/batch-plans/` ← all 8 completed BATCH_*_PLAN_*.md (Cluster C)
- `archive/` (root) ← `COMPREHENSIVE_AUDIT_2026_03_31.md`, `WIRING_AUDIT_2026_04_02.md`, `SNAPSHOT_MODE_SPIKE_2026-04-09.md`, `OVERSIGHT_AUDIT_2026_04_25.md`, `REVIEW_FIX_PROGRESS.md`, and (preferred) `SESSION_2026-04-08_RESEARCH_REPORT.md` (Cluster D)

### Banners
Each archived doc gets a one-line top banner: `> ARCHIVED <date> — superseded by <live successor(s)>. Historical record; do not treat as live.` Completed plans get `> STATUS: SHIPPED (Batch NNN, commit …).`

### New `migration_doc/README.md` index
Add a short index splitting **LIVE / load-bearing** (WEBGPU_MIGRATION_STATUS, DEFERRED_WORK, FEATURE_INVENTORY, WEBGPU_MIGRATION_BACKLOG, NEXT_SESSION_HANDOFF, WEBGPU_EXECUTION_ROADMAP, WEBGPU_DEBUGGING_LOG, DEBUGGING_GUIDE, IMAGERY_PROJECTION, the design specs, AUDIT_2026_05_02, FUTURE_RESEARCH_2026_05_01) from **HISTORICAL / archived** (with a one-line pointer to where each was superseded). This makes the live-vs-frozen distinction legible and stops future sessions from trusting stale snapshots.

### CLAUDE.md sync (required, not optional)
- Key Reference Files line for `WIRING_AUDIT_2026_04_02.md` → repoint to `audits/2026-04-30_*` as the live wiring reference (the doc is being archived).
- Verify the other Key Reference Files entries (DEBUGGING_GUIDE, IMAGERY_PROJECTION, WEBGPU_DEBUGGING_LOG) still resolve (they stay active — no change).

### Merges
None recommended beyond the cluster consolidations — the active docs have distinct mandates (the Appendix in DEFERRED_WORK already delegates bug-tracker narratives to WEBGPU_DEBUGGING_LOG; respect that boundary rather than merging).

---

## 6. Prioritized action list (ordered, most impactful first)

**Tier 1 — correct the load-bearing trackers (the Batch 179–185 drift; highest reader-impact):**

1. **`DEFERRED_WORK.md`** — apply §3.2: add `NEW-GROUNDPRIM-CLASSIFIER-RECON-PRECISION` (its canonical home), mark `NEW-GROUNDPRIM-TEXTURED-MATERIALS` RESOLVED-Batch-185, downgrade `NEW-WEBGPU-GLOBE-CLASSIFY-DEPTH-PRECISION` (A) to producer-shipped, disambiguate the duplicate "Batch 185" label, re-verify the 186–230 forward-dated RESOLVED cluster, bump Last-Updated.
2. **`FEATURE_INVENTORY.md`** — apply §3.3: rewrite §B.3 line 506 (S2), add §C.4 RECON-PRECISION (S3), refresh the 3 counters (45→48 / 29→33 / re-count CsmBuiltins), bump refresh date, fix WGF-* status + the WGF-2 OIT conflict, fix the §932 Lit-Mat note.
3. **`WEBGPU_MIGRATION_STATUS.md`** — apply §3.1: add "Recent Progress (Batches 179–185)", flip the 3 HEAD roadblocks (S1/S2/S4), record Batch 184, fix feature-renderer count (→48).
4. **`WEBGPU_EXECUTION_ROADMAP.md`** — apply §3.6: rewrite Exec Summary + critical-path (S2 decouples the flip), add RECON-PRECISION (S3), keep the verified plumbing audits. (Fix in the same pass as DEFERRED_WORK:882–903 to keep the two consistent.)
5. **`WEBGPU_MIGRATION_BACKLOG.md`** — apply §3.4: reclassify BUG-11 to the narrow imagery-gap symptom, add S2/S3/S4 + EXECUTION_ROADMAP cross-link, re-evaluate §14, bump header.
6. **`NEXT_SESSION_HANDOFF.md`** — apply §3.5: refresh + archive the top section to Batch 185, point at EXECUTION_ROADMAP, strike BufferPolygon (S1), update roadblock #1 (S2/S4).

**Tier 2 — propagate the one new tracker & resolve conflicts:**

7. Confirm `NEW-GROUNDPRIM-CLASSIFIER-RECON-PRECISION` now appears in DEFERRED_WORK + FEATURE_INVENTORY + BACKLOG + EXECUTION_ROADMAP + DEBUGGING_GUIDE (it was in WEBGPU_DEBUGGING_LOG.md only). Resolve the **WGF-2 OIT** SHIPPED-vs-unwired conflict toward code (MRT-fallback-only) in both FEATURE_INVENTORY and PHASE_5_MODERN_WEBGPU_DESIGN.
8. **`WEBGPU_CONTEXT_DECOMPOSITION_PLAN.md`** — apply §3.9: fix inverted line counts, mark candidates #1–#6 + Pick DONE, list all 6 extracted modules, re-scope remaining.
9. Annotate the **2 kept principal-review docs** (PER_FEATURE, RENDERER_DEEP) per §3.8 (B-2/B-5/C-P9/C-R4 → FIXED/PARTIAL; add baseline banners).

**Tier 3 — small design-doc fixes (§3.10):** CSM_DESIGN, TAA_DESIGN, SLICE_5D, SHADER_PAIRS_LOCKSTEP, CELESTIAL_ATMOSPHERE, WATER_RENDERING, IMAGERY_PROJECTION, DEBUGGING_GUIDE, OPTION_B_SCENE_IN_WORKER, PHASE_8_GPU_RESIDENT_TILES, PHASE_8_SHADER_STRATEGY.

**Tier 4 — redundancy archival (do the pre-archive lifts FIRST):**

10. Lift still-open items from `REVIEW_FIX_PROGRESS.md`, `PRINCIPAL_ENGINEER_REVIEW_2026_04_16.md`, `PRINCIPAL_ENGINEER_REVIEW_DATA_PIPELINE_2026_04_16.md` into DEFERRED_WORK (§2 Cluster B/§3.7 lists); fix DP-C3 citation + imagery matrix in the data-pipeline doc before moving.
11. Create archive subfolders (§5) and move: 6 SANDCASTLE_66 → `archive/sandcastle-batch-66/`; 2 review pillars → `archive/principal-review-2026-04-16/`; 8 BATCH_*_PLAN → `archive/batch-plans/`; the 6 dated audits/spike/research/REVIEW_FIX_PROGRESS → `archive/`. Add banners to each.

**Tier 5 — organization:**

12. Write `migration_doc/README.md` index (LIVE vs ARCHIVED split, §5).
13. Update `CLAUDE.md` Key Reference Files: repoint `WIRING_AUDIT_2026_04_02.md` → `audits/2026-04-30_*`.
14. Optional polish: extend `WEBGPU_DEBUGGING_LOG.md` TOC with Batch 67–184 anchors; add the optional `AUDIT_2026_05_02.md` C.2/Tier-5 back-ref.

**Cross-cutting guardrail (CLAUDE.md Principle 7):** none of the archived docs' scaffolding-bearing claims justify *code* removal — this is a doc-hygiene pass only. When a doc says a texture/method "looks dead," that stays in the doc as historical context; do not act on it as a deletion mandate.
