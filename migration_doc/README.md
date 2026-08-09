# migration_doc/ — Index (LIVE vs ARCHIVED)

_Last reorganized 2026-05-30 (HEAD `de9d82abe2`, Batch 186). A multi-agent audit of all 45 docs against the live code corrected the Batch 179–185 status drift across the trackers and archived ~21 completed/superseded snapshots. **Trust this index** over any individual doc's self-description._

_Currency sweep 2026-06-15 (Batch 303): indexed six docs added since the reorg — `CAMPAIGN_ROADMAP_2026-06.md` (now the active per-workflow stage source), `LARGE_DYNAMIC_OBJECTS_DESIGN.md`, `PLAN_2DCV_MORPH_BATCHES.md`, `audits/2026-06-11_ULTRA_REVIEW.md`, `FORK_DRIFT_ANALYSIS_2026-06-11.md`, `RESEARCH_TAKRAM_GEOSPATIAL_VISUALS.md`._

_2026-07-15 remediation update: Campaign 9 was explicitly launched by the maintainer. Campaign 8 is
frozen historical evidence; its open IDs transferred unchanged and its completed slices remain
regression gates._

_2026-07-25 historical handoff: see
[`HANDOFF_2026-07-25_TO_SOL.md`](HANDOFF_2026-07-25_TO_SOL.md) for the
Batch-767 execution snapshot, worktree inventory, and queued maintainer
decisions. Its clean-tree/discard procedure and four-unlanded-lanes statement
are superseded; use the 2026-07-26 audit and live campaign queues for current
execution state._

_2026-07-26 continuation audit: see
[`CLAUDE_PROGRESS_AUDIT_2026-07-26.md`](CLAUDE_PROGRESS_AUDIT_2026-07-26.md)
for the landed Batches 745–768 review, in-flight changeset readiness, confirmed
regressions, campaign reconciliation, and verified continuation order._

_2026-07-28 execution update: Campaign 13 remains the current cloud execution queue. Campaign 11
remains open and its targeted W1 performance lane has resumed (`C11-180` PARTIAL, `C11-181`
IMPLEMENTED / VERIFIED / LANDED — both landed as Batch 773 on 2026-08-01, neither complete);
its broader certification remains held. Its cloud/weather IDs transferred to Campaign 13
without being renamed or double-scheduled. **Campaign 12 LAUNCHED 2026-07-23** and is executing. The current non-cloud performance
evidence remains in `FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md`; cloud evidence is in
`CLOUD_ARCHITECTURE_AUDIT_2026-07-23.md`._

_2026-07-31 local/committed/staged audit: see
[`LOCAL_CHANGE_AUDIT_2026-07-31.md`](LOCAL_CHANGE_AUDIT_2026-07-31.md).
Written when local `main` equalled `origin/main` at Batch 771 with nothing staged
and the dirty tree an intentionally uncommitted multi-lane workspace; **that
changeset landed as Batches 772-781 on 2026-08-01** (`origin/main` =
`3900608bb9`), see its §11 addendum. Canonical
build/type gates and 45/45 performance-harness contracts are green. The
corrected attribution lane proves substantial avoided model work, while an
exact resident pair correctly rejects causal timing because backend-coupled 3D
Tiles readiness differs; `C11-205` owns that evidence seam._

_2026-07-31 Campaign-11 high-value stopping point: see
[`HANDOFF_2026-07-31_CODEX_C11_HIGH_VALUE.md`](HANDOFF_2026-07-31_CODEX_C11_HIGH_VALUE.md)
for the implemented/partial split across C11-60/76/193/194/195/202/205/208,
the new model-readiness/recovery findings, validation state, and restart order.
Its repository-state paragraph is superseded (banner at the top of that doc): the
tree landed as Batches 772-781 on 2026-08-01 and restart-order item 1 was executed
at landing; items 2-7 and every open exit gate remain valid._

_2026-08-01 landing + orchestrator review: the 2026-07-31 Codex changeset landed as
**Batches 772-781** (`3900608bb9`) with eight confirmed defects fixed pre-landing —
recorded as the `C11-REVIEW-2026-08-01` entry in
[`WEBGPU_DEBUGGING_LOG.md`](WEBGPU_DEBUGGING_LOG.md) and §11 of
[`LOCAL_CHANGE_AUDIT_2026-07-31.md`](LOCAL_CHANGE_AUDIT_2026-07-31.md). Gates at the
tip: `tsc` clean, `gulp build` green, Node contracts 195/195. **LANDED is not
COMPLETE** — no C11/C12 row was promoted, and the browser/Karma/timing gates stay
open._

_2026-08-02 index currency sweep (Batch 819 docs audit): the index below again covers the full
`migration_doc/` tree — ~45 previously unindexed docs were classified and added (the 2026
consolidation canonical set, the Campaign 3–7 queues and dashboards, campaign execution guides,
research dossiers and evidence packages, machine-readable JSON sidecars, and the pre-reorg
`archive/` tail). Index-only change: no file was moved, renamed, or archived — the maintainer's
2026-06-30 archival HOLD on the canonical-vs-legacy doc set stands._

> **Convention:** docs under `archive/` are historical point-in-time snapshots — do **not** read them as live to-do lists. Their still-open items were lifted into `DEFERRED_WORK.md` ("Carried-forward on archive"). The audit that produced this layout is recorded in `_DOC_AUDIT_PLAN.md`.

---

## LIVE — load-bearing trackers (keep current)

| Doc | Role |
|---|---|
| [`FORK_ARCHITECTURE_REMEDIATION_PLAN_2026-07-13.md`](FORK_ARCHITECTURE_REMEDIATION_PLAN_2026-07-13.md) | Active fork-wide architecture authority and FAR ID definitions. Machine-readable sidecars: [`FORK_ARCHITECTURE_REMEDIATION_LEDGER_2026-07-13.json`](FORK_ARCHITECTURE_REMEDIATION_LEDGER_2026-07-13.json), [`FORK_EXTENSION_TEST_COVERAGE_MATRIX_2026-07-15.json`](FORK_EXTENSION_TEST_COVERAGE_MATRIX_2026-07-15.json), [`VISIBILITY_EXECUTION_OWNERSHIP_MANIFEST_2026-07-15.json`](VISIBILITY_EXECUTION_OWNERSHIP_MANIFEST_2026-07-15.json). |
| [`QUEUE_2026-07-06_CAMPAIGN7.md`](QUEUE_2026-07-06_CAMPAIGN7.md) | **FROZEN** Campaign-7 authoritative queue with recorded closure/disposition table (Batches 635–654); per-item final dispositions live in `DEFERRED_WORK.md`. |
| [`QUEUE_2026-07-15_CAMPAIGN8.md`](QUEUE_2026-07-15_CAMPAIGN8.md) | Frozen historical campaign; open IDs transferred to Campaign 9 and completed slices retained as regression gates. |
| [`FORK_PERFORMANCE_RTE_VISIBILITY_REMEDIATION_PLAN_2026-07-15.md`](FORK_PERFORMANCE_RTE_VISIBILITY_REMEDIATION_PLAN_2026-07-15.md) | Campaign-9 source plan and durable design background; execution status is historical. |
| [`QUEUE_2026-07-15_CAMPAIGN9.md`](QUEUE_2026-07-15_CAMPAIGN9.md) | **Closed green at `C9-30`**; retained as the exact implementation/evidence ledger. |
| [`CAMPAIGN9_OPUS_EXECUTION_GUIDE_2026-07-16.md`](CAMPAIGN9_OPUS_EXECUTION_GUIDE_2026-07-16.md) | Historical Campaign-9 worker guide (Fable → Opus handoff, written at Batch 672); campaign closed. |
| [`QUEUE_2026-07-16_CAMPAIGN10.md`](QUEUE_2026-07-16_CAMPAIGN10.md) | **Closed at `C10-30`** with green mechanics and wall-clock evidence explicitly inconclusive. |
| [`CAMPAIGN10_EXECUTION_GUIDE_2026-07-16.md`](CAMPAIGN10_EXECUTION_GUIDE_2026-07-16.md) | Historical Campaign-10 worker guide (H1–H7 cluster briefs, written at Batch 675); campaign closed. |
| [`QUEUE_2026-07-18_CAMPAIGN11.md`](QUEUE_2026-07-18_CAMPAIGN11.md) | **Open; targeted W1 performance lane resumed 2026-07-28, certification held**; cloud/weather rows transferred to Campaign 13, all other open work remains owned here. |
| [`CAMPAIGN11_EXECUTION_GUIDE.md`](CAMPAIGN11_EXECUTION_GUIDE.md) | Campaign-11 execution guide — composition/index over the 10 cluster guides in `campaign11_planning/guides/`; live while C11 is open. |
| [`campaign11_planning/`](campaign11_planning/_PLANNING_STATUS.md) | Pre-launch C11 planning folder ([`_PLANNING_STATUS.md`](campaign11_planning/_PLANNING_STATUS.md), [`CANDIDATE_REGISTER.md`](campaign11_planning/CANDIDATE_REGISTER.md), `guides/G1–G12`), salvaged Batch 701. Historical intake — the campaign launched 2026-07-18; the queue doc is authoritative. |
| [`QUEUE_2026-07-19_CAMPAIGN12.md`](QUEUE_2026-07-19_CAMPAIGN12.md) | **Launched 2026-07-23 / executing** — celestial appearance. Runs interleaved with C11 and C13 under the orchestrator pattern. |
| [`QUEUE_2026-07-23_CAMPAIGN13.md`](QUEUE_2026-07-23_CAMPAIGN13.md) | **Current live campaign** for planetary volumetric-cloud RTE, temporal reconstruction, weather realism, quality, and performance. |
| [`OCEAN_DYNAMICS_PLAN_2026-07-24.md`](OCEAN_DYNAMICS_PLAN_2026-07-24.md) | **Ratified Campaign 14 planning authority — Dynamic Ocean & Wind.** ~~O5 keeps it blocked until Campaigns 11, 12, and 13 all complete.~~ **SUPERSEDED by R1 (2026-08-06; row corrected 2026-08-07):** O5's "done" binds on a **pragmatic bar — C12 complete + C13 Gate B green** — not on all three campaigns completing. **`C13-GATE-B` closed green at Batch 866, so the remaining C14 gate is C12 completion ONLY.** Ruling text in [`DEFERRED_WORK.md`](DEFERRED_WORK.md) §"2026-08-06 - MAINTAINER RULINGS". |
| [`QUEUE_2026-08-02_CAMPAIGN15.md`](QUEUE_2026-08-02_CAMPAIGN15.md) | **Aurora + Space Weather — planned / research-verified / implementation not started.** `C15-00` is complete; `C15-01..08` require a maintainer launch ruling. |
| [`QUEUE_2026-08-10_CAMPAIGN16.md`](QUEUE_2026-08-10_CAMPAIGN16.md) | **Comment remediation & attribution — live queue and sole status authority for C16.** Plan: [`CAMPAIGN16_COMMENT_REMEDIATION_PLAN_2026-08-10.md`](CAMPAIGN16_COMMENT_REMEDIATION_PLAN_2026-08-10.md). Standard the campaign is gated on: [`Documentation/Contributors/CodingGuide/ForkCommentStandard.md`](../Documentation/Contributors/CodingGuide/ForkCommentStandard.md). |
| [`CAMPAIGN16_COMMENT_REMEDIATION_PLAN_2026-08-10.md`](CAMPAIGN16_COMMENT_REMEDIATION_PLAN_2026-08-10.md) | C16 source plan: the measured audit baseline, the standards targets, the enforcement design, and the license-review scheduling rationale. |
| [`QUEUE_2026-08-09_CAMPAIGN18.md`](QUEUE_2026-08-09_CAMPAIGN18.md) | **Voxel, Point Cloud & Splat Modernization — LAUNCHED by maintainer directive 2026-08-09; live queue and sole status authority for C18.** Waves V (verification honesty) → P (point-cloud correctness) → A (additive adoption) → S (splat rows, **gated post-`C15-G8`**, executing in the C15 G-track lane). Source of truth: [`VOXEL_POINTCLOUD_GSPLAT_AUDIT_2026-08-09.md`](VOXEL_POINTCLOUD_GSPLAT_AUDIT_2026-08-09.md). Its §5 records the ownership boundaries — `C11-13`/`C11-86`/`C11-100`/`C11-108`, the C11 W7 voxel cluster, FORK-41 and `C15-G0..G8` all stay where they are. **Campaign 17 (celestial light transport) remains PROPOSED, not launched.** |
| [`CAMPAIGN_CLOSURE_AUDIT_2026-08-06.md`](CAMPAIGN_CLOSURE_AUDIT_2026-08-06.md) | **HISTORICAL SNAPSHOT at Batch 844** — what stands between here and closing C11 / C12 / C13, every open row classified into five buckets. Produced the four maintainer rulings (R1–R4). **Read its 2026-08-07 addendum first:** its headline "`C13-GATE-B` is 7 probe runs away" is spent (Gate B CLOSED at Batch 866), and its "any red is a real regression" line is REFUTED. *(Indexed 2026-08-07 — it was the only top-level file missing from this table.)* |
| [`LOCAL_CHANGE_AUDIT_2026-07-31.md`](LOCAL_CHANGE_AUDIT_2026-07-31.md) | Current primary-worktree, staged/index, recent-commit, worktree, renderer-architecture, and moving-performance audit. |
| [`CODEX_PROGRESS_AUDIT_2026-08-02.md`](CODEX_PROGRESS_AUDIT_2026-08-02.md) | Post-Batch-818 code review plus current unstaged verification: exact-tuple recovery, snap lifecycle/multi-frustum/cost, Moon lifecycle, cyclic weather tails, honest remaining risks, and next order. |
| [`C12_MOON_TEXTURE_LIFECYCLE_AUDIT_2026-08-02.md`](C12_MOON_TEXTURE_LIFECYCLE_AUDIT_2026-08-02.md) | Canonical C12-35 ownership/lifecycle analysis and final L0-L5 evidence. **Complete / independent GO:** shared decoded sources, backend-local GPU ownership, WebGL parity, diagnostics, Node/Jasmine, and strict real-Edge transport/pixel/teardown certification; C12-33 is unblocked. |
| [`C12_STARFIELD_SEAM_DISPOSITION_2026-08-02.md`](C12_STARFIELD_SEAM_DISPOSITION_2026-08-02.md) | Resolves the Batch-815 catalog/cubemap near-redundancy against existing DR-01: execute C12-11's diffuse-cubemap/resolved-sprite seam; do not remove the catalog or fabricate per-face blur. |
| [`HANDOFF_2026-08-02_CODEX_NEXT_WAVE.md`](HANDOFF_2026-08-02_CODEX_NEXT_WAVE.md) | **Current Codex handoff** (supersedes the 07-31 handoff): progress through Batch 818, corrected Bug 814.1 disposition, C11/C12/C13 remainders, ratified Campaign 14 Dynamic Ocean & Wind status, and the research-verified Campaign 15 Aurora + Space Weather definition/order. |
| [`HANDOFF_2026-07-31_CODEX_C11_HIGH_VALUE.md`](HANDOFF_2026-07-31_CODEX_C11_HIGH_VALUE.md) | Batch-771 stopping-point record (landed as 772-781); superseded as the entry map by the 2026-08-02 handoff, but its per-ID exit-gate analysis still stands. |
| [`WEBGPU_MIGRATION_STATUS.md`](WEBGPU_MIGRATION_STATUS.md) | Single-source migration status + append-only progress log. **Note: batch numbers are non-monotonic — trust dates/hashes.** **Coverage gap (recorded 2026-08-06):** entries jump from 2026-05-30 (Batch 185) to 2026-08-06 (Batches 819-828); everything between was recorded in the dated campaign queues, `WEBGPU_DEBUGGING_LOG.md`, `DEFERRED_WORK.md` and `FEATURE_INVENTORY.md` instead. Read the older sections as history, not as the frontier. |
| [`DEFERRED_WORK.md`](DEFERRED_WORK.md) | Canonical add-only follow-up inventory (NEW-*/C-R*/DP-* IDs). Where open work lives. |
| [`FEATURE_INVENTORY.md`](FEATURE_INVENTORY.md) | Feature catalog (EXISTING/NEW/WIP/FUTURE) across 10 subsystems — impact-analysis index (CLAUDE.md Principle 6). |
| [`WEBGPU_MIGRATION_BACKLOG.md`](WEBGPU_MIGRATION_BACKLOG.md) | Older remaining-work backlog (body stops ~Batch 64); historical — the execution frontier lives in the live campaign queues above. |
| [`WEBGPU_EXECUTION_ROADMAP.md`](WEBGPU_EXECUTION_ROADMAP.md) | 2026-05-29/30 outstanding-work roadmap (log-depth epic spine — since shipped, Batches 248–267); superseded as the execution frontier by the campaign queues, retained for design rationale. |
| [`CAMPAIGN_ROADMAP_2026-06.md`](CAMPAIGN_ROADMAP_2026-06.md) | June-2026 multi-phase execution plan — phase-by-phase walk through `DEFERRED_WORK.md`. Historical: it drove Phases 1–5 (Batches 232–267 era); execution has since moved to the dated campaign queues (C7…C15). |
| [`QUEUE_2026-06-23_CAMPAIGN2.md`](QUEUE_2026-06-23_CAMPAIGN2.md) | Historical 25-batch Campaign-2 queue; no longer the current execution frontier. |
| [`QUEUE_2026-06-22.md`](QUEUE_2026-06-22.md) | Prior 25-batch queue (Batches 355–369 — Tiers 1–3 cleared). Superseded by Campaign 2. |
| [`TIER5-6_EXECUTION_PLANS.md`](TIER5-6_EXECUTION_PLANS.md) | Campaign-2 Tier-5/6 execution plans (2026-06-24 investigation snapshot); historical planning input. |
| [`QUEUE_2026-06-24_CAMPAIGN3_WEATHER.md`](QUEUE_2026-06-24_CAMPAIGN3_WEATHER.md) · [`_PACKED.md`](QUEUE_2026-06-24_CAMPAIGN3_WEATHER_PACKED.md) | Historical Campaign-3 weather queue pair (arc overview + packed per-batch specs); executed. |
| [`QUEUE_2026-06-25_CAMPAIGN3v2_TIERED_CLOUDS.md`](QUEUE_2026-06-25_CAMPAIGN3v2_TIERED_CLOUDS.md) | Historical Campaign-3 v2 tiered-clouds replan; superseded the PACKED queue's cloud batches (W6–W14). |
| [`CAMPAIGN3_PROGRESS.md`](CAMPAIGN3_PROGRESS.md) | Campaign-3 living dashboard, now historical (campaign closed ~Batch 554). |
| [`QUEUE_2026-07-03_CAMPAIGN-NEXT.md`](QUEUE_2026-07-03_CAMPAIGN-NEXT.md) | Historical 25-batch campaign-next queue (Batches 508+), assembled from the Batch-507 canonical docs. |
| [`QUEUE_2026-07-04_CAMPAIGN-3.md`](QUEUE_2026-07-04_CAMPAIGN-3.md) | Historical all-Opus Campaign-3 run queue (launched at Batch 530). |
| [`NEXT_QUEUE_2026-07-04.md`](NEXT_QUEUE_2026-07-04.md) | Historical post-Campaign-3 re-mine queue (HEAD Batch 554) — the Campaign-4 input. |
| [`NEXT_QUEUE_CAMPAIGN5.md`](NEXT_QUEUE_CAMPAIGN5.md) | Historical Campaign-5 queue (assembled 2026-07-05 at Batch 593). |
| [`PARITY_TO_100.md`](PARITY_TO_100.md) | Definitive parity task list that fed the `parity-to-100` workflow engine (Batch 463 baseline); historical — consumed by the 2026-07 parity campaigns. |
| [`WEBGPU_BACKLOG_14_BATCHES_2026-06.md`](WEBGPU_BACKLOG_14_BATCHES_2026-06.md) | Historical synthesis of the 14-batch parallel run against the post-merge parity backlog; landings recorded in `WEBGPU_MIGRATION_STATUS.md`. |
| [`HANDOFF_2026-07-25_TO_SOL.md`](HANDOFF_2026-07-25_TO_SOL.md) | Batch-767 handoff record. **SUPERSEDED banner at top** — do not execute its clean-tree/discard procedure; see [`CLAUDE_PROGRESS_AUDIT_2026-07-26.md`](CLAUDE_PROGRESS_AUDIT_2026-07-26.md). |
| [`NEXT_SESSION_HANDOFF.md`](NEXT_SESSION_HANDOFF.md) | Legacy append-only handoff log whose top entry stops at 2026-05-30 / Batch 185; use the dated 2026-07-26 audit and live campaign queues for current execution. |
| [`WEBGPU_DEBUGGING_LOG.md`](WEBGPU_DEBUGGING_LOG.md) | Chronological bug log (append-only). Search before debugging a new artifact. |

## LIVE — reference & guides (keep in sync with code)

| Doc | Role |
|---|---|
| [`DEBUGGING_GUIDE.md`](DEBUGGING_GUIDE.md) | Single entry point for debugging tools + probes + CesiumDebug commands. |
| [`FEATURE_RENDERER_ONBOARDING.md`](FEATURE_RENDERER_ONBOARDING.md) | Step-by-step guide to adding a new WebGPU Feature Renderer (key, eager/lazy registration, lifecycle, Scene access, compat exemption). |
| [`IMAGERY_PROJECTION.md`](IMAGERY_PROJECTION.md) | Single source of truth for imagery-layer projection (WebGL + WebGPU). |
| [`SHADER_PAIRS_LOCKSTEP.md`](SHADER_PAIRS_LOCKSTEP.md) | WGSL/GLSL shader-pair parity contract. |
| [`DEV_NOTES_FORMAT.md`](DEV_NOTES_FORMAT.md) | Format for the `DEV_NOTES_<SUBSYSTEM>.md` files that hold engineering knowledge relocated out of source comments by Campaign 16 — file + symbol anchor, verbatim text, date moved, and why it was kept. |
| [`CLOUD_COORDINATE_CONTRACT_2026-07-23.md`](CLOUD_COORDINATE_CONTRACT_2026-07-23.md) | **Active contract** — WGS84/RTE coordinate rules for every planetary-cloud producer/consumer (C13-03 complete; Gate B open). Owner: Campaign 13 queue. |

## LIVE — 2026 consolidation canonical set (review-in-progress)

Seven "canonical docs" drafted in the 2026 consolidation (~Batches 455–507). Each folds in several
legacy docs, but the maintainer **HELD archival/repointing on 2026-06-30** — the legacy set stands
alongside these, stays indexed above/below, and the newest dated evidence wins on any disagreement.

| Doc | Role |
|---|---|
| [`FORK_OVERVIEW.md`](FORK_OVERVIEW.md) | Master capability catalog — what the fork is, every improvement beyond upstream, ship-status of each (statuses re-verified at Batch 506). |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Explanatory architecture reference (folds `WEBGPU_CONTEXT_DECOMPOSITION_PLAN.md` + the CLAUDE.md architecture sections; CLAUDE.md remains the authoritative rules file). Verified ~Batch 455. |
| [`BUILD_AND_VARIANTS.md`](BUILD_AND_VARIANTS.md) | Operational reference for building the fork + the dual/webgl-only/webgpu-only variants (verified at Batch 506). |
| [`FEATURE_GUIDE_AND_DEMOS.md`](FEATURE_GUIDE_AND_DEMOS.md) | User-facing "how do I turn this on / which demo shows it" guide across the fork's feature surface. |
| [`ISSUES_AND_FIXED_BUGS.md`](ISSUES_AND_FIXED_BUGS.md) | Issues & fixed-bugs register (summarizes — does **not** replace — `WEBGPU_DEBUGGING_LOG.md`; C-R\*/H-R\*/M-R\* ID definitions stay in the RENDERER_DEEP review). |
| [`ROADMAP_AND_DEFERRED_WORK.md`](ROADMAP_AND_DEFERRED_WORK.md) | Consolidated roadmap/deferred register; carries the 2026-07-13 FAR priority-override banner. `DEFERRED_WORK.md` remains the canonical add-only inventory. |
| [`RESEARCH_AND_PENDING_TOPICS.md`](RESEARCH_AND_PENDING_TOPICS.md) | Forward research register (folds `FUTURE_RESEARCH_2026_05_01.md` and others in scope; those stay indexed until the HOLD is lifted). |

## LIVE — design specs (forward-looking; some partially shipped)

| Doc | Role |
|---|---|
| [`CSM_DESIGN.md`](CSM_DESIGN.md) · [`TAA_DESIGN.md`](TAA_DESIGN.md) | CSM / TAA slice plans (Slice 1+ shipped; later slices pending). |
| [`SLICE_5D_PLAN_CLUSTERED_LIGHTING.md`](SLICE_5D_PLAN_CLUSTERED_LIGHTING.md) | Clustered lighting + Lit-Mat shaders (shipped Batches 154–158). |
| [`WATER_RENDERING_DESIGN.md`](WATER_RENDERING_DESIGN.md) | Globe water (Phase 0.3 shipped; Phases 1–9 unbuilt). |
| [`CELESTIAL_ATMOSPHERE_DESIGN.md`](CELESTIAL_ATMOSPHERE_DESIGN.md) | Sky/atmosphere (Phase 4 shipped). |
| [`ATMOSPHERIC_EFFECTS_ROADMAP.md`](ATMOSPHERIC_EFFECTS_ROADMAP.md) | Atmospheric effects A–E shipped; Phase F Aurora + Space Weather is research-verified under Campaign 15 and not yet implemented. |
| [`PHASE_5_MODERN_WEBGPU_DESIGN.md`](PHASE_5_MODERN_WEBGPU_DESIGN.md) | WGF-* modern-WebGPU features (clip-distances, f16, OIT — OIT is MRT-fallback-only). |
| [`PHASE_8_GPU_RESIDENT_TILES_DESIGN.md`](PHASE_8_GPU_RESIDENT_TILES_DESIGN.md) · [`PHASE_8_SHADER_STRATEGY.md`](PHASE_8_SHADER_STRATEGY.md) | Phase-8 GPU-resident tiles + shader-variant strategy (8a partly shipped; 8b unbuilt). |
| [`WEBGPU_CONTEXT_DECOMPOSITION_PLAN.md`](WEBGPU_CONTEXT_DECOMPOSITION_PLAN.md) | Decomposition roll-up (candidates #1–#6 shipped; SceneRenderer residual remains). |
| [`OPTION_B_SCENE_IN_WORKER.md`](OPTION_B_SCENE_IN_WORKER.md) | Scene-in-worker spike (headless Scene construction now attempted). |
| [`VEGETATION_SYSTEM_DESIGN.md`](VEGETATION_SYSTEM_DESIGN.md) | Planetary vegetation deep-dive: feasibility + gap analysis + 4-stage LOD (mesh→impostor→merged-clump→terrain-albedo) + foliage PBR, globe+3D-Tiles, WebGPU-first/WebGL2-fallback. Unbuilt (investigation). |
| [`LARGE_DYNAMIC_OBJECTS_DESIGN.md`](LARGE_DYNAMIC_OBJECTS_DESIGN.md) | Large dynamic-object roadmap (flat-buffer + WASM RTE encode); roadmap Phase 2 core shipped Batches 270–273, dirty-consume shipped for billboards + labels. |
| [`PLAN_2DCV_MORPH_BATCHES.md`](PLAN_2DCV_MORPH_BATCHES.md) | 2D / Columbus-View / morph parity batch plan (roadmap Phase 3); per-frustum camera-UB + projected-frame RTE + morph blend for collections. Forward-looking. |
| [`ES6_MODERNIZATION_STATUS.md`](ES6_MODERNIZATION_STATUS.md) | ES6/ES2022 modernization status: what remains (Object.defineProperties long tail; Core/Scene/DataSources JS↔TS bifurcation) + ES2022 opportunities. |
| [`ATMOSPHERE_CLOUD_IMPROVEMENT_PLAN.md`](ATMOSPHERE_CLOUD_IMPROVEMENT_PLAN.md) | Forward quality roadmap for sky/cloud/fog/reflections (2026-06-28); companion to `ATMOSPHERIC_EFFECTS_ROADMAP.md`. Predates Campaign 13 — cloud evidence authority is now `CLOUD_ARCHITECTURE_AUDIT_2026-07-23.md`. |
| [`C2-25_SCENE_CAPTURE_DESIGN.md`](C2-25_SCENE_CAPTURE_DESIGN.md) | Dynamic scene-content environment-map capture design. Epic **COMPLETE** (DEFERRED_WORK Batch-451 note); retained as the as-built record. |
| [`CLOUD_UNIFICATION_DESIGN.md`](CLOUD_UNIFICATION_DESIGN.md) | **SHIPPED (Batches 617–625)** as-built design of record: volumetric clouds driven THROUGH `CloudCollection` (`renderMode` BILLBOARD/VOLUMETRIC; `globe.showProceduralClouds` removed). |
| [`CLOUD_RENDERING_STRATEGY.md`](CLOUD_RENDERING_STRATEGY.md) | 2026-06-25 cloud-rendering-technique strategy at the architectural fork; historical — resolved by Campaign 3 v2 + cloud unification, and cloud work now runs under Campaign 13. |
| [`CLOUD_TAXONOMY_ROADMAP.md`](CLOUD_TAXONOMY_ROADMAP.md) | Beyond-the-11-genera cloud-taxonomy roadmap (mammatus, asperitas, etc. as density-shaping add-ons). Forward-looking. |
| [`DP-H46_METADATA_DESIGN.md`](DP-H46_METADATA_DESIGN.md) | Structural-metadata-in-shader + pickMetadata epic design. **CLOSED** — DP-H46a–f shipped (Batches 454–463). |
| [`VEGETATION_V1_SCOPE_LOCK.md`](VEGETATION_V1_SCOPE_LOCK.md) | V1 cutline + open-decision gate for `VEGETATION-V1-CORE` (doc-only; V1 unbuilt). Pins the scope the design doc left open. |
| [`WEATHER_DATA_INGEST_ROADMAP.md`](WEATHER_DATA_INGEST_ROADMAP.md) | Real-weather → cloud-renderer ingest roadmap (C2-16 seam); P0–P3-CORE shipped (Batches 410–424), later phases open. |
| [`WEATHER_RECREATION_ROADMAP.md`](WEATHER_RECREATION_ROADMAP.md) | Weather-recreation roadmap (historical storms/forecasts on the globe) — the weather-_data_ axis companion to the cloud-rendering docs. |
| [`OCEAN_DATUM_PROBE_DESIGN_2026-07-24.md`](OCEAN_DATUM_PROBE_DESIGN_2026-07-24.md) | Ocean-lid vertical-datum probe design + reading guide. Its "NOT RUN" self-status is superseded: the probe ran at Batch 759 — verdict **GEOID** (+ the ~101.6 m FFT-patch datum defect confirmed); results recorded in `DEFERRED_WORK.md` (C6-FFT-OCEAN-TIDE-DATUM) and `OCEAN_DYNAMICS_PLAN_2026-07-24.md`. |

## LIVE — audits & reviews (frozen baselines, still referenced)

| Doc | Role |
|---|---|
| [`FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md`](FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md) | **Current fork-progress/performance audit and second-pass action authority** for Batches through 731; includes current r6 evidence, confirmed defects, rejected shortcuts, and feature-preserving gates. |
| [`CLAUDE_PROGRESS_AUDIT_2026-07-26.md`](CLAUDE_PROGRESS_AUDIT_2026-07-26.md) | Current continuation audit for Batches 745–768 plus the Batch-769/770/S5 reconciliation: landed-change review, parked-lane readiness, confirmed regressions, campaign truth, verification, and next priorities. |
| [`CLOUD_ARCHITECTURE_AUDIT_2026-07-23.md`](CLOUD_ARCHITECTURE_AUDIT_2026-07-23.md) | **Current cloud evidence authority**: WGS84/RTE, temporal reconstruction, weather wrapping/bounds, regional variation, deterministic formation randomization, quality, lifecycle, and Takram comparison. |
| [`VOXEL_POINTCLOUD_GSPLAT_AUDIT_2026-08-09.md`](VOXEL_POINTCLOUD_GSPLAT_AUDIT_2026-08-09.md) | **Current parity + adoption evidence authority for voxels, point clouds and Gaussian splats** (maintainer ask 2026-08-09; 20-agent read-only workflow, every in-repo claim file:line cited). Per-subsystem parity tables with an explicit `code` / `probe(stale)` / `fresh` verification level, 10 ranked gaps, 10 ranked adoption candidates with acceptance criteria, and a recommended sequence. **Launched [`QUEUE_2026-08-09_CAMPAIGN18.md`](QUEUE_2026-08-09_CAMPAIGN18.md)**; the five defect rows it surfaced are filed in [`DEFERRED_WORK.md`](DEFERRED_WORK.md). |
| [`REFERENCE_VISUALS_CATALOG_2026-08-09.md`](REFERENCE_VISUALS_CATALOG_2026-08-09.md) | **Current license-vetted external-reference catalog** (maintainer ask 2026-08-09; 21-agent web workflow, 14 LICENSE files fetched and read verbatim). ~50 projects across atmosphere/celestial, planet/space, weather/cloud, water/ocean, bathymetry/terrain and environment effects, each with ecosystem, licence verdict (USABLE / FILE-COPYLEFT / STUDY-ONLY / UNKNOWN), a **✔ verbatim-read vs △ repo-declared** marker, and the fork row it guides — plus an honest gaps section (notably **zero vetted gsplat references**). Its §4 process recommendation seeded the "Reference pre-registration (2026-08-09)" tables now carried in `OCEAN_DYNAMICS_PLAN_2026-07-24.md`, `QUEUE_2026-08-02_CAMPAIGN15.md`, `CELESTIAL_LIGHT_TRANSPORT_PLAN_2026-08-07.md` and `WEATHER_DATA_INGEST_ROADMAP.md`. |
- [SIGGRAPH_2026_SCOUT_2026-08-09.md](SIGGRAPH_2026_SCOUT_2026-08-09.md) — LIVE — SIGGRAPH/HPG 2026 sweep: 5 usable items (GPS sort-free splats BSD-3, RaDe-GS math, Apache volume course, Gabor Fields, Smolder), verified negative results (no sky/ocean/shadow/OIT competition), Inria-trap confirmations, pre-registration recommendations.
| [`GSPLAT_REFERENCE_VETTING_2026-08-09.md`](GSPLAT_REFERENCE_VETTING_2026-08-09.md) | **Current licence authority for the Gaussian-splat ecosystem** — the `C18-S0` pass that closed the reference catalog's §3 "zero vetted gsplat candidates" gap. 20 projects, licence artifacts fetched and transcribed literally (✔ verbatim-read / ◐ partial / △ declared-only), an Inria provenance-chain verdict per candidate, honest gaps, and a recommendation per Wave-S row. **Headline: `autonomousvision/mip-splatting` and `r4dl/StopThePop` both carry the Inria/MPII research-only "Gaussian-Splatting License" byte-for-byte**, so `C18-S2` is clean-room-from-paper mandatory and three of Wave S's four rows need no external reference. Feeds the pre-registration tables in [`QUEUE_2026-08-09_CAMPAIGN18.md`](QUEUE_2026-08-09_CAMPAIGN18.md) §6 and [`QUEUE_2026-08-02_CAMPAIGN15.md`](QUEUE_2026-08-02_CAMPAIGN15.md) §2b. **Pre-registrations, not determinations** — numbered `L-xx` entries stay in [`LICENSE_DETERMINATIONS_2026-08-10.md`](LICENSE_DETERMINATIONS_2026-08-10.md), claimed by the batch that derives. |
| [`audits/2026-04-30_ARCHITECTURE_PERFORMANCE.md`](audits/2026-04-30_ARCHITECTURE_PERFORMANCE.md) · [`_FORK_FEATURE_INVENTORY.md`](audits/2026-04-30_FORK_FEATURE_INVENTORY.md) · [`_MAINTAINABILITY_SURVIVABILITY.md`](audits/2026-04-30_MAINTAINABILITY_SURVIVABILITY.md) | **Live wiring/feature/maintainability audit trio** (supersedes the archived 2026-04-02 WIRING_AUDIT). |
| [`audits/2026-06-11_ULTRA_REVIEW.md`](audits/2026-06-11_ULTRA_REVIEW.md) (+ `_findings.json`) | **Most-recent deep multi-agent review** (53 agents, 195 confirmed findings, HEAD `f6fd367827`). Per-finding sidecar JSON is the machine-readable index. Source of the A-* findings driving the current campaign phases. |
| [`FORK_DRIFT_ANALYSIS_2026-06-11.md`](FORK_DRIFT_ANALYSIS_2026-06-11.md) | Fork-vs-upstream drift analysis + sync decision (2026-06-11). |
| [`RESEARCH_TAKRAM_GEOSPATIAL_VISUALS.md`](RESEARCH_TAKRAM_GEOSPATIAL_VISUALS.md) | Research input — celestial/atmosphere visual-fidelity study (Takram `three-geospatial`); to fold into the campaign roadmap. Not yet scheduled. |
| [`AUDIT_2026_05_02.md`](AUDIT_2026_05_02.md) | Most-recent diffable audit baseline. |
| [`PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md`](PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md) | **ID-definition source** for C-R*/H-R*/M-R* findings (54 inbound refs). Per-finding annotations are authoritative; the exec summary is the 2026-04-16 baseline. |
| [`PRINCIPAL_ENGINEER_REVIEW_PER_FEATURE_2026_04_16.md`](PRINCIPAL_ENGINEER_REVIEW_PER_FEATURE_2026_04_16.md) | Per-feature review with FIXED/DEFERRED annotations (exec summary = 2026-04-16 baseline). |
| [`FUTURE_RESEARCH_2026_05_01.md`](FUTURE_RESEARCH_2026_05_01.md) | Forward-looking R-1..R-7 research triage. |
| [`UPSTREAM_MERGE_2026-06_CHANGELOG.md`](UPSTREAM_MERGE_2026-06_CHANGELOG.md) | v1.142 upstream-merge conflict-resolution record + regression targets (2026-06-17). Frozen record. |
| [`WEBGPU_PARITY_AUDIT_2026-06.md`](WEBGPU_PARITY_AUDIT_2026-06.md) | Post-merge v1.141–1.143 parity audit — source of the 14-batch backlog run. Historical. |
| [`WEBGPU_PARITY_REPORT_2026-06-30.md`](WEBGPU_PARITY_REPORT_2026-06-30.md) | Parity snapshot at Batch 458. **SUPERSEDED by** [`WEBGPU_PARITY_REPORT_2026-07-01.md`](WEBGPU_PARITY_REPORT_2026-07-01.md) (its own banner says so). |
| [`WEBGPU_PARITY_REPORT_2026-07-01.md`](WEBGPU_PARITY_REPORT_2026-07-01.md) | Parity snapshot at Batch 480 (post-parity-sprint); the §6 list drove `PARITY_TO_100.md` and the 2026-07 campaign queues. Point-in-time. |
| [`FORK_VS_UPSTREAM_WEBGPU_ARCHITECTURE_AUDIT_2026-07-13.md`](FORK_VS_UPSTREAM_WEBGPU_ARCHITECTURE_AUDIT_2026-07-13.md) | The fork-vs-upstream architecture audit that launched the FAR remediation plan. Frozen evidence baseline. |
| [`CURRENT_RENDERING_FUNCTIONALITY_BASELINE_2026-07-13.md`](CURRENT_RENDERING_FUNCTIONALITY_BASELINE_2026-07-13.md) | Phase-0 characterization anchor: what the fork could do before the remediation fixes began. |
| [`FAR_200_SUBMISSION_AUTHORITY_ADOPTION_2026-07-13.md`](FAR_200_SUBMISSION_AUTHORITY_ADOPTION_2026-07-13.md) | FAR-200 submission-authority adoption inventory (`SubmissionSerialAuthority` shadow-infrastructure boundary). |
| [`FORK_PERFORMANCE_AUDIT_AND_FIX_RESULTS_2026-07-14.md`](FORK_PERFORMANCE_AUDIT_AND_FIX_RESULTS_2026-07-14.md) | First measured hot-path tranche record (2026-07-14/15). Performance authority has since passed to `FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md`. |
| [`FORK_PERFORMANCE_WEEKLY_CHANGE_DEFENSE_2026-07-15.md`](FORK_PERFORMANCE_WEEKLY_CHANGE_DEFENSE_2026-07-15.md) | Exact-current performance/correctness checkpoint for the Campaign-8 tranche. Frozen checkpoint. |
| [`PERF_ARCH_DEEP_DIVE_2026-07-16.md`](PERF_ARCH_DEEP_DIVE_2026-07-16.md) | Independent S1–S11 performance/architecture finding register, deduped against the Campaign-9 backlog. Frozen. |
| [`SOL_AUDIT_REPORT_2026-07-16.md`](SOL_AUDIT_REPORT_2026-07-16.md) | Audit synthesis of Sol's uncommitted 2026-07-12..16 working tree (246 modified + 77 untracked files). Frozen. |
| [`SOL_C13_REVIEW_2026-07-23.md`](SOL_C13_REVIEW_2026-07-23.md) | Orchestrator review of Sol's C13 Batches 732–736 + the C13-37 takeover brief (referenced from CLAUDE.md). |
| [`DEFAULT_PARITY_MATRIX_2026-07-18.md`](DEFAULT_PARITY_MATRIX_2026-07-18.md) | Static sweep of deliberate WebGL-vs-WebGPU default divergences (22 rows + verified-parity appendix); the runtime-diff pass is still pending. |
| [`OIT_DEFAULT_FLIP_EVIDENCE_2026-07-18.md`](OIT_DEFAULT_FLIP_EVIDENCE_2026-07-18.md) | Evidence package: **NO-GO** on defaulting WebGPU MRT-OIT on (path architecturally unreachable for standard translucents at Batch 699). |
| [`REVERSED_Z_MEASUREMENT_SPIKE_2026-07-19.md`](REVERSED_Z_MEASUREMENT_SPIKE_2026-07-19.md) | `C11-GT-01` measurement spike — verdict **STAY-LOG-DEPTH**; the log-depth pick fleet is cleared to keep growing. |
| [`CLOUD_LOD_RESEARCH_2026-07-05.md`](CLOUD_LOD_RESEARCH_2026-07-05.md) | Research — cloud LOD / "smart cloud" feature comparison vs the three.js/Babylon/AAA ecosystem. |
| [`THREEJS_TECH_MINE_2026-07-05.md`](THREEJS_TECH_MINE_2026-07-05.md) | Research — license-checked technique mine from the three.js/WebGPU ecosystem; fed Campaigns 6/7. |
| [`RESEARCH_REGISTER_2026-07-06.md`](RESEARCH_REGISTER_2026-07-06.md) | Index of the 10 Campaign-7 read-only research lanes (license verdicts + which rows each lane informs). |
| [`R-2A_CROSS_SOURCE_ATTRIBUTE_AUDIT.md`](R-2A_CROSS_SOURCE_ATTRIBUTE_AUDIT.md) | R-2a GPU cross-source attribute-join scoping audit (doc-only, plan state). |
| [`CELESTIAL_APPEARANCE_RESEARCH_2026-07-19.md`](CELESTIAL_APPEARANCE_RESEARCH_2026-07-19.md) | **Source of truth for Campaign 12** (celestial appearance) — 8-lane adversarially-verified research; §1 fixed in Batch 722, §2–§7 are C12 input. |
| [`CELESTIAL_WATER_REFLECTION_RESEARCH.md`](CELESTIAL_WATER_REFLECTION_RESEARCH.md) | Research dossier for the `C11-163` celestial-water-reflection epic (Tier-4/gated, NOT STARTED; 4 sub-decisions deferred to scheduling). |
| [`ECLIPSE_EFFECTS_RESEARCH_2026-07-24.md`](ECLIPSE_EFFECTS_RESEARCH_2026-07-24.md) | `C12-29` gate artifact (Batch 749): eclipse-effects research + slice plan; slices executing under C12/C13. |
| [`TIDES_FEASIBILITY_2026-07-24.md`](TIDES_FEASIBILITY_2026-07-24.md) | Tides feasibility report + maintainer rulings (§5a) and implementation record (§5c — datum anchor Batch 763, harmonic stack Batch 767); open lineage lives in `DEFERRED_WORK.md` (C6-FFT-OCEAN-TIDE-\*). |
| [`MESHLETS_RESEARCH_2026-07-24.md`](MESHLETS_RESEARCH_2026-07-24.md) | Meshlets/virtualized-geometry research seed for WebGPU + 3D Tiles (Batch 753); research-only, not scheduled. |
| [`_DOC_AUDIT_PLAN.md`](_DOC_AUDIT_PLAN.md) | Record of the 2026-05-30 doc audit + cleanup plan (this reorg). |

---

## ARCHIVED — historical snapshots (under `archive/`; not live)

| Path | Superseded by |
|---|---|
| `archive/sandcastle-batch-66/` (5 reports) | All Batch-66 Sandcastle blockers fixed; status in `DEFERRED_WORK.md` + `WEBGPU_DEBUGGING_LOG.md`. |
| `archive/principal-review-2026-04-16/` (build/lifecycle + data-pipeline pillars) | Findings live in `DEFERRED_WORK.md`; the two annotated review pillars (RENDERER_DEEP, PER_FEATURE) stayed active. |
| `archive/batch-plans/` (8 BATCH_*_PLAN, all SHIPPED) | `WEBGPU_CONTEXT_DECOMPOSITION_PLAN.md` + inline code comments. |
| `archive/COMPREHENSIVE_AUDIT_2026_03_31.md` | `FEATURE_INVENTORY.md`, `DEFERRED_WORK.md`, the 2026-04-30 audit trio. |
| `archive/WIRING_AUDIT_2026_04_02.md` | `audits/2026-04-30_*` (now the live wiring reference). |
| `archive/SNAPSHOT_MODE_SPIKE_2026-04-09.md` | Shipped (`SnapshotModeService.js`); `FEATURE_INVENTORY.md`. |
| `archive/OVERSIGHT_AUDIT_2026_04_25.md` | Rolled up in `WEBGPU_MIGRATION_STATUS.md`. |
| `archive/REVIEW_FIX_PROGRESS.md` | Closed Batch 1–66 campaign; open items lifted to `DEFERRED_WORK.md`. |
| `archive/SESSION_2026-04-08_RESEARCH_REPORT.md` | Self-declared non-living; superseded by the trackers. |
| `archive/` March-2026 snapshots (11 docs: `COMPREHENSIVE_CODE_REVIEW`, `RESEARCH_FINDINGS`, `RENDERER_CONTEXT_REFACTOR`, `PICKING_ANALYSIS`, `SORTING_ARCHITECTURE_ANALYSIS`, `SORTING_IMPLEMENTATION_PLAN`, `SORTING_REVIEW_AND_TECH_DEBT`, `SCENE_DECOMPOSITION_PLAN`, `MIGRATION_STATUS_ARCHIVE`, `ES6_MODERNIZATION_BACKLOG`, `UPSTREAM_ISSUES_AND_TECH_DEBT`) | The live trackers: `WEBGPU_MIGRATION_STATUS.md`, `ES6_MODERNIZATION_STATUS.md`, `DEFERRED_WORK.md`, `FEATURE_INVENTORY.md`, `WEBGPU_DEBUGGING_LOG.md`; picking/sorting findings also summarized in `ISSUES_AND_FIXED_BUGS.md`. |
| `archive/deprecated/` | Older deprecated docs + archived source snapshots (pre-existing). |
