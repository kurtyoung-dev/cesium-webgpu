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

## What REMAINS (Fable hit its usage limit mid-authoring)

1. **Guides G8, G9, G10 — NOT WRITTEN** (their author agents died on credit
   exhaustion). Re-runnable from the authoring workflow cache
   (`wf_3c2df40b-079`, resumeFromRunId) — G1–G7 replay instantly, only G8/G9/G10 run:
   - **G8** shadows-lighting + atmosphere-sky + water + the defaults-parity flip
     candidates (enhanced-ocean #1, night-lights, AutoExposure, background-color,
     the OIT flip as a conditional dossier — NOW RESOLVED to NO-GO by Batch 700).
   - **G9** test-infra + build-boot (the C8 upstream-contract-gate certification lane
     is the intended C11 exit gate; Karma Edge-launcher flakiness fix-first).
   - **G10** gated-tail dossiers + **the CAMPAIGN OPERATING CHARTER** — the
     load-bearing takeover manual (dispatch-review-land loop, review standards,
     salvage playbook, model-tier table, C11-00B launch intake, engine-script
     fallback) so Opus or Sol can assume the orchestrator seat cold. **Highest-value
     missing piece.**
2. **Phase 3 — ASSEMBLY (orchestrator/me, not a worker):** author the canonical
   **C11 ID table FIRST** (the C10 numbering-collision lesson — assign every register
   item its C11-xx number before composing any guide prose), then
   `QUEUE_2026-07-16→_CAMPAIGN11.md` (§1 rules inherited verbatim, §2 any rulings,
   §3 gates, §3.2 ledger seeded, §4 C11-00B intake, §5 waves, §6 gated tail) +
   `CAMPAIGN11_EXECUTION_GUIDE.md` composed from G1–G10 with a canonical-ID
   reconciliation note.
3. **C11-00B intake at launch** must absorb the still-open C10 fallout: the C10-30
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
