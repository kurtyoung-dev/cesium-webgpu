# migration_doc/ — Index (LIVE vs ARCHIVED)

_Last reorganized 2026-05-30 (HEAD `de9d82abe2`, Batch 186). A multi-agent audit of all 45 docs against the live code corrected the Batch 179–185 status drift across the trackers and archived ~21 completed/superseded snapshots. **Trust this index** over any individual doc's self-description._

_Currency sweep 2026-06-15 (Batch 303): indexed six docs added since the reorg — `CAMPAIGN_ROADMAP_2026-06.md` (now the active per-workflow stage source), `LARGE_DYNAMIC_OBJECTS_DESIGN.md`, `PLAN_2DCV_MORPH_BATCHES.md`, `audits/2026-06-11_ULTRA_REVIEW.md`, `FORK_DRIFT_ANALYSIS_2026-06-11.md`, `RESEARCH_TAKRAM_GEOSPATIAL_VISUALS.md`._

> **Convention:** docs under `archive/` are historical point-in-time snapshots — do **not** read them as live to-do lists. Their still-open items were lifted into `DEFERRED_WORK.md` ("Carried-forward on archive"). The audit that produced this layout is recorded in `_DOC_AUDIT_PLAN.md`.

---

## LIVE — load-bearing trackers (keep current)

| Doc | Role |
|---|---|
| [`WEBGPU_MIGRATION_STATUS.md`](WEBGPU_MIGRATION_STATUS.md) | Single-source migration status + append-only progress log. **Note: batch numbers are non-monotonic — trust dates/hashes.** |
| [`DEFERRED_WORK.md`](DEFERRED_WORK.md) | Canonical add-only follow-up inventory (NEW-*/C-R*/DP-* IDs). Where open work lives. |
| [`FEATURE_INVENTORY.md`](FEATURE_INVENTORY.md) | Feature catalog (EXISTING/NEW/WIP/FUTURE) across 10 subsystems — impact-analysis index (CLAUDE.md Principle 6). |
| [`WEBGPU_MIGRATION_BACKLOG.md`](WEBGPU_MIGRATION_BACKLOG.md) | Older remaining-work backlog (body stops ~Batch 64; see EXECUTION_ROADMAP for the current frontier). |
| [`WEBGPU_EXECUTION_ROADMAP.md`](WEBGPU_EXECUTION_ROADMAP.md) | Current outstanding-work roadmap + critical path (log-depth epic spine). |
| [`CAMPAIGN_ROADMAP_2026-06.md`](CAMPAIGN_ROADMAP_2026-06.md) | **Active multi-phase execution plan** (June 2026 onward) — phase-by-phase walk through `DEFERRED_WORK.md`; the current per-workflow stage source. Phases 1–5 DONE; 9–11 in flight. |
| [`NEXT_SESSION_HANDOFF.md`](NEXT_SESSION_HANDOFF.md) | Append-only session handoff log; top section is the latest. |
| [`WEBGPU_DEBUGGING_LOG.md`](WEBGPU_DEBUGGING_LOG.md) | Chronological bug log (append-only). Search before debugging a new artifact. |

## LIVE — reference & guides (keep in sync with code)

| Doc | Role |
|---|---|
| [`DEBUGGING_GUIDE.md`](DEBUGGING_GUIDE.md) | Single entry point for debugging tools + probes + CesiumDebug commands. |
| [`FEATURE_RENDERER_ONBOARDING.md`](FEATURE_RENDERER_ONBOARDING.md) | Step-by-step guide to adding a new WebGPU Feature Renderer (key, eager/lazy registration, lifecycle, Scene access, compat exemption). |
| [`IMAGERY_PROJECTION.md`](IMAGERY_PROJECTION.md) | Single source of truth for imagery-layer projection (WebGL + WebGPU). |
| [`SHADER_PAIRS_LOCKSTEP.md`](SHADER_PAIRS_LOCKSTEP.md) | WGSL/GLSL shader-pair parity contract. |

## LIVE — design specs (forward-looking; some partially shipped)

| Doc | Role |
|---|---|
| [`CSM_DESIGN.md`](CSM_DESIGN.md) · [`TAA_DESIGN.md`](TAA_DESIGN.md) | CSM / TAA slice plans (Slice 1+ shipped; later slices pending). |
| [`SLICE_5D_PLAN_CLUSTERED_LIGHTING.md`](SLICE_5D_PLAN_CLUSTERED_LIGHTING.md) | Clustered lighting + Lit-Mat shaders (shipped Batches 154–158). |
| [`WATER_RENDERING_DESIGN.md`](WATER_RENDERING_DESIGN.md) | Globe water (Phase 0.3 shipped; Phases 1–9 unbuilt). |
| [`CELESTIAL_ATMOSPHERE_DESIGN.md`](CELESTIAL_ATMOSPHERE_DESIGN.md) | Sky/atmosphere (Phase 4 shipped). |
| [`PHASE_5_MODERN_WEBGPU_DESIGN.md`](PHASE_5_MODERN_WEBGPU_DESIGN.md) | WGF-* modern-WebGPU features (clip-distances, f16, OIT — OIT is MRT-fallback-only). |
| [`PHASE_8_GPU_RESIDENT_TILES_DESIGN.md`](PHASE_8_GPU_RESIDENT_TILES_DESIGN.md) · [`PHASE_8_SHADER_STRATEGY.md`](PHASE_8_SHADER_STRATEGY.md) | Phase-8 GPU-resident tiles + shader-variant strategy (8a partly shipped; 8b unbuilt). |
| [`WEBGPU_CONTEXT_DECOMPOSITION_PLAN.md`](WEBGPU_CONTEXT_DECOMPOSITION_PLAN.md) | Decomposition roll-up (candidates #1–#6 shipped; SceneRenderer residual remains). |
| [`OPTION_B_SCENE_IN_WORKER.md`](OPTION_B_SCENE_IN_WORKER.md) | Scene-in-worker spike (headless Scene construction now attempted). |
| [`VEGETATION_SYSTEM_DESIGN.md`](VEGETATION_SYSTEM_DESIGN.md) | Planetary vegetation deep-dive: feasibility + gap analysis + 4-stage LOD (mesh→impostor→merged-clump→terrain-albedo) + foliage PBR, globe+3D-Tiles, WebGPU-first/WebGL2-fallback. Unbuilt (investigation). |
| [`LARGE_DYNAMIC_OBJECTS_DESIGN.md`](LARGE_DYNAMIC_OBJECTS_DESIGN.md) | Large dynamic-object roadmap (flat-buffer + WASM RTE encode); roadmap Phase 2 core shipped Batches 270–273, dirty-consume shipped for billboards + labels. |
| [`PLAN_2DCV_MORPH_BATCHES.md`](PLAN_2DCV_MORPH_BATCHES.md) | 2D / Columbus-View / morph parity batch plan (roadmap Phase 3); per-frustum camera-UB + projected-frame RTE + morph blend for collections. Forward-looking. |
| [`ES6_MODERNIZATION_STATUS.md`](ES6_MODERNIZATION_STATUS.md) | ES6/ES2022 modernization status: what remains (Object.defineProperties long tail; Core/Scene/DataSources JS↔TS bifurcation) + ES2022 opportunities. |

## LIVE — audits & reviews (frozen baselines, still referenced)

| Doc | Role |
|---|---|
| [`audits/2026-04-30_ARCHITECTURE_PERFORMANCE.md`](audits/2026-04-30_ARCHITECTURE_PERFORMANCE.md) · [`_FORK_FEATURE_INVENTORY.md`](audits/2026-04-30_FORK_FEATURE_INVENTORY.md) · [`_MAINTAINABILITY_SURVIVABILITY.md`](audits/2026-04-30_MAINTAINABILITY_SURVIVABILITY.md) | **Live wiring/feature/maintainability audit trio** (supersedes the archived 2026-04-02 WIRING_AUDIT). |
| [`audits/2026-06-11_ULTRA_REVIEW.md`](audits/2026-06-11_ULTRA_REVIEW.md) (+ `_findings.json`) | **Most-recent deep multi-agent review** (53 agents, 195 confirmed findings, HEAD `f6fd367827`). Per-finding sidecar JSON is the machine-readable index. Source of the A-* findings driving the current campaign phases. |
| [`FORK_DRIFT_ANALYSIS_2026-06-11.md`](FORK_DRIFT_ANALYSIS_2026-06-11.md) | Fork-vs-upstream drift analysis + sync decision (2026-06-11). |
| [`RESEARCH_TAKRAM_GEOSPATIAL_VISUALS.md`](RESEARCH_TAKRAM_GEOSPATIAL_VISUALS.md) | Research input — celestial/atmosphere visual-fidelity study (Takram `three-geospatial`); to fold into the campaign roadmap. Not yet scheduled. |
| [`AUDIT_2026_05_02.md`](AUDIT_2026_05_02.md) | Most-recent diffable audit baseline. |
| [`PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md`](PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md) | **ID-definition source** for C-R*/H-R*/M-R* findings (54 inbound refs). Per-finding annotations are authoritative; the exec summary is the 2026-04-16 baseline. |
| [`PRINCIPAL_ENGINEER_REVIEW_PER_FEATURE_2026_04_16.md`](PRINCIPAL_ENGINEER_REVIEW_PER_FEATURE_2026_04_16.md) | Per-feature review with FIXED/DEFERRED annotations (exec summary = 2026-04-16 baseline). |
| [`FUTURE_RESEARCH_2026_05_01.md`](FUTURE_RESEARCH_2026_05_01.md) | Forward-looking R-1..R-7 research triage. |
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
| `archive/deprecated/` | Older deprecated docs (pre-existing). |
