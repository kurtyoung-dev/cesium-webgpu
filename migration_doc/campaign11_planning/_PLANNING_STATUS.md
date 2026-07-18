# Campaign 11 — Planning Status (WIP, salvaged 2026-07-18)

**This folder is IN-PROGRESS planning, NOT a launched campaign.** Salvaged into the
repo (Batch 701) so the ~2M-token planning sweep survives a session boundary. Sweep
HEAD = `aef553d592` (Batch 698); repo HEAD at salvage = Batch 700 (`b533124568`).

## What is DONE (in this folder)

- **`CANDIDATE_REGISTER.md`** — phase-1 intake COMPLETE. 188 merged candidate items
  (260 raw across 6 source sweeps; 72 dups absorbed) in 22 clusters, priority-tagged
  P0–P3, no existing IDs renamed. 9 P0s. Sources: DEFERRED_WORK, C9 queue (incl.
  never-executed Wave 3–8 item definitions), C10 queue §4/§5/§6, the 69-finding perf
  register, FEATURE_INVENTORY §C/§D, legacy queues (with a stranded-item check), and
  the Batch-656→698 fresh fallout.
- **`guides/G1..G7`** — phase-2 cluster guides COMPLETE (7 of 10; 7,468 lines total),
  each with HEAD-verified anchors, premise-verify-first steps, traps vs the landed
  683–700 work, verification recipes, and per-item model-tier + effort. Coverage:
  - G1 pick + standing-reds (26 items) · G2 terrain-imagery + submit-residency (15)
  - G3 attachment-topology (8) · G4 model-frontend + frame-delta (13)
  - G5 tiles-model-parity + splat (26) · G6 classification-voxel + postfx (22)
  - G7 entity-scale + celestial-env (12)
- **`../DEFAULT_PARITY_MATRIX_2026-07-18.md`** — 22 backend default divergences
  (5 visible-visual), flip-candidate shortlist, runtime-verification plan. Feeds G8.

## Guides — ALL 10 COMPLETE (G8/G9/G10 authored by Opus 2026-07-18, Batch 702)

G1–G10 all present in `guides/`. Cross-cutting findings the assembler MUST honor:
- **enhanced-ocean is NOT a clean flip** (G8): uniform-driven, no `ENHANCED_OCEAN`
  ShaderDefine — a define-gate must be added first; two-part maintainer ask.
- **ShaderDefine registry EXHAUSTED** bits 0–30 (G8/G9): `C10-08b` define-width is a
  HARD prerequisite for any new define bit (blocks several tiles/model items).
- **Premise-drift corrections** (G8/G9): SHADOW-LAYOUT-QUANTIZED likely doc-close;
  C-R10-GLOBE-POINT-LIGHT receive-infra present; C9-14B fog LUT already sampled (only
  the per-fragment ground march ungated); `WebGPUComputePipelineCache` EXISTS
  (re-scope to routing); `WebGPUModelRenderer` already `.ts`. → a cheap
  cluster-reconciliation slice at wave start is recommended.
- Clean GO-now parity wins (G8): AutoExposure demand-gate, canvas-background,
  sun-bloom restore (file tracking rows — currently silent).

## What REMAINS

1. **Phase 3 — ASSEMBLY:** author the canonical
   **C11 ID table FIRST** (the C10 numbering-collision lesson — assign every register
   item its C11-xx number before composing any guide prose), then
   `QUEUE_2026-07-16→_CAMPAIGN11.md` (§1 rules inherited verbatim, §2 any rulings,
   §3 gates, §3.2 ledger seeded, §4 C11-00B intake, §5 waves, §6 gated tail) +
   `CAMPAIGN11_EXECUTION_GUIDE.md` composed from G1–G10 with a canonical-ID
   reconciliation note.
2. **C11-00B intake at launch** must absorb the still-open C10 fallout: the C10-30
   verdict, C10-06/07/08 (boot chain) and C10-11/12 (pick fleet) + C10-13 outcomes,
   and the Batch-700 OIT NO-GO (`NEW-WEBGPU-OIT-TRANSLUCENT-PRIMITIVE-WIRING`).

## Cross-cutting OPEN QUESTIONS for the maintainer (from the guide authors)

- **Maintainer decisions blocking specific briefs:** splat-data-producer build
  placement + offline asset; enhanced-ocean default direction; sunBloom parity
  (wire screen-space vs ratify baked substitute); silhouette translucent
  body-wash-vs-rim; `forceSceneMRT` default-flip sign-off protocol; FAR-107 +
  the high-density-drift repair if it traces to a contained cull path (charter
  forbids feature degradation).
- **Sequencing:** run the pick-family diagnosis (A1) + high-density (B1) in W1 so
  later waves stop paying OFF-oracle costs against known-red gates; the ShaderDefine
  registry is EXHAUSTED (bits 0–30 used) — any new define needs define-width work
  (C10-08b) sequenced first; several register magnitudes are STALE post-C10-01/03
  (verify mechanisms, not counts).
- **Fresh root-cause lead (G5):** the two Batch-699 findings
  (`NEW-WEBGPU-TILE-FEATURE-TRANSLUCENT-COLOR-COMPOSITE` +
  `NEW-WEBGPU-B3DM-TILE-CONTENT-PICK-EMPTY`) plausibly share one cause —
  `FLAG_HAS_FEATURE_ID_ATTRIBUTE` never set for b3dm content — worth one shared
  instrumented diagnosis before slicing either.

## Resume procedure

1. `Workflow({scriptPath: '<session>/workflows/scripts/c11-guide-authoring-wf_3c2df40b-079.js', resumeFromRunId: 'wf_3c2df40b-079'})` to author G8/G9/G10 (G1–G7 cached). Copy the 3 new guides into `guides/`.
2. Assemble phase 3 (canonical ID table → queue doc → execution guide).
3. Present the launch package + the maintainer open-questions list before launching.
