# migration_doc/ — Index (LIVE vs ARCHIVED)

_Last reorganized 2026-05-30 (HEAD `de9d82abe2`, Batch 186). A multi-agent audit of all 45 docs against the live code corrected the Batch 179–185 status drift across the trackers and archived ~21 completed/superseded snapshots. **Trust this index for LIVE/ARCHIVED placement; trust the doc's own banner for its currency** (DOC_FITNESS_AUDIT_2026-09-04.md G-06 found rows that were stale where the target doc's own banner was right)._

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
evidence remains in `archive/FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md` (archived 2026-09-03;
current premise check lives in
[`ARCHITECTURE_REVIEW_2026-09-02.md`](ARCHITECTURE_REVIEW_2026-09-02.md) §3.15/§4 R5 and
`audits/2026-09-02_old_review_validity/FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.verified.md`);
cloud evidence is in `CLOUD_ARCHITECTURE_AUDIT_2026-07-23.md`._

_2026-07-31 local/committed/staged audit: see
[`LOCAL_CHANGE_AUDIT_2026-07-31.md`](archive/LOCAL_CHANGE_AUDIT_2026-07-31.md)
(archived 2026-09-03 — REMOVE-AFTER-MIGRATION per
[`ARCHITECTURE_REVIEW_2026-09-02.md`](ARCHITECTURE_REVIEW_2026-09-02.md); its findings are migrated
there and the file/batch/artifact list it fed is inlined at
[`WEBGPU_DEBUGGING_LOG.md`](WEBGPU_DEBUGGING_LOG.md):16478).
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
[`LOCAL_CHANGE_AUDIT_2026-07-31.md`](archive/LOCAL_CHANGE_AUDIT_2026-07-31.md) (archived). Gates at the
tip: `tsc` clean, `gulp build` green, Node contracts 195/195. **LANDED is not
COMPLETE** — no C11/C12 row was promoted, and the browser/Karma/timing gates stay
open._

_2026-08-02 index currency sweep (Batch 819 docs audit): the index below again covers the full
`migration_doc/` tree — ~45 previously unindexed docs were classified and added (the 2026
consolidation canonical set, the Campaign 3–7 queues and dashboards, campaign execution guides,
research dossiers and evidence packages, machine-readable JSON sidecars, and the pre-reorg
`archive/` tail). Index-only change: no file was moved, renamed, or archived — the maintainer's
2026-06-30 archival HOLD on the canonical-vs-legacy doc set stands._

_2026-08-09 handover-readiness pass: the campaign set was audited for cold-start takeover
([`HANDOVER_AUDIT_2026-08-09.md`](HANDOVER_AUDIT_2026-08-09.md)). Two new documents landed from it
and are now successor first reads:
[`ORCHESTRATION_HANDBOOK.md`](ORCHESTRATION_HANDBOOK.md) (operating procedure, previously
session-memory-only) and [`CAMPAIGN_STATE.md`](CAMPAIGN_STATE.md) (tracked mirror of the gitignored
`CLAUDE.md` orientation block, including the GitHub quiet-hours HARD rule). The same pass added the
dispatch schedule, the ruling authority, the licence-determination register and the `DEV_NOTES_*`
family to the tables below — the index that says "trust this index" had been omitting them._

_2026-09-02 index currency sweep (DX-23, lane Erendis): a fresh census of `migration_doc/**` against
this file's own links found 293 tracked `.md` files (292 besides this README) against 157
hyperlinked targets — 136 not yet hyperlinked, split between docs already covered by an existing
aggregate/prose mention (the `archive/` directory rows, the `campaign11_planning/guides/` line, and
two backtick-only mentions) and 88 genuinely unindexed documents, 29 of them the `branches/**`
lane-record family that had no index section at all. This pass adds the "Lane records" section below,
hyperlinks every one of those 88 documents into its nearest-fitting existing section (never inventing
a description — each new row's text is that document's own first heading), and turns the two
backtick-only mentions into real rows. No existing file was moved, archived, or reworded. **Note on
the prior claim:** the row that dispatched this sweep cited "123 unindexed"; re-deriving the count
directly against the tree on 2026-09-02 gives 88 (or 136 under the stricter "must be a markdown
hyperlink" reading) — neither matches 123, so treat that figure as stale rather than re-citing it.
**Index verified complete against `migration_doc/**` on 2026-09-02: 293 documents, 0 unindexed**
(every file is now either hyperlinked directly or named inside a hyperlinked family/aggregate row).
The literal re-run (walk `migration_doc/**/*.md`, diff against this file's markdown link targets)
reports 45 not-hyperlinked, not 0 — that is expected, not decay: 17 `archive/*.md` files are named
by full path in the pre-existing ARCHIVED table, `archive/deprecated/_archive/README.md` sits under
that table's `archive/deprecated/` row, and 27 more are covered by four pre-existing directory-
aggregate rows — `archive/batch-plans/` (8), `archive/principal-review-2026-04-16/` (2),
`archive/sandcastle-batch-66/` (5), and `campaign11_planning/guides/` (12). 17 + 1 + 27 = 45; anything
the literal re-run reports beyond that 45-file allowlist is genuinely unindexed and should be treated
as index decay.

_2026-09-03 archival pass (lane Elendur): seven REMOVE-AFTER-MIGRATION reviews `git mv`'d into
`archive/` — `LOCAL_CHANGE_AUDIT_2026-07-31.md`, `audits/2026-04-30_ARCHITECTURE_PERFORMANCE.md`,
`_FORK_FEATURE_INVENTORY.md`, `_MAINTAINABILITY_SURVIVABILITY.md`, `AUDIT_2026_05_02.md`,
`FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md`, and `PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md`
(rejoining its two 2026-04-16 siblings) — with their findings and id tables migrated into the new
[`ARCHITECTURE_REVIEW_2026-09-02.md`](ARCHITECTURE_REVIEW_2026-09-02.md) and the underlying
[`audits/2026-09-02_old_review_validity/`](audits/2026-09-02_old_review_validity/SUMMARY.md) validity
bank (both new this pass). The three KEEP-PART documents (`PRINCIPAL_ENGINEER_REVIEW_PER_FEATURE_2026_04_16.md`,
`FORK_VS_UPSTREAM_WEBGPU_ARCHITECTURE_AUDIT_2026-07-13.md`, `audits/2026-06-11_ULTRA_REVIEW.md`) stayed
in place, each now marked "(retained: holds live content — see the 2026-09-02 review)" in its row below.
No file was deleted; every archived path stays readable at its new location, and the ARCHIVED table
below carries a repoint row for each. **Re-derived census (own script, not the 2026-09-02 methodology
— it checks directory-aggregate coverage more strictly, so its "not covered" figure is not comparable
1:1 to the 293/0 claim above):** `migration_doc/**/*.md` now totals **310 files (309 besides this
README)** — up from 292 on 2026-09-02, the +17 being four new documents (the review, its plan, the
landscape audit and the phase-1 register) plus the twelve-file validity bank (+12); the seven moved files net zero; and `C18_P3_PNTS_MODEL_ATTENUATION_DESIGN_2026-09-02.md` (+1, Batch 1402, indexed below). Of those 309, 247 resolve
through a direct markdown link and a further 235 are named in backtick-only prose (the sets overlap);
52 files this script cannot place under either resolve only through the pre-existing directory-
aggregate convention (`archive/batch-plans/`, `archive/principal-review-2026-04-16/` — now 3 files,
`archive/sandcastle-batch-66/`, `campaign11_planning/guides/`, the pre-2026-09-02 `archive/` root
tail, `archive/audits-2026-04-30/`, and 10 of the validity bank's 12 files under one directory
mention) — the same allowlist shape the 2026-09-02 sweep documented, sized for the files this pass
added or moved. Treat this paragraph, not the 293/0 claim above, as current._

> **Convention:** docs under `archive/` are historical point-in-time snapshots — do **not** read them as live to-do lists. Their still-open items were lifted into `DEFERRED_WORK.md` ("Carried-forward on archive"). The audit that produced this layout is recorded in `_DOC_AUDIT_PLAN.md`.

---

## START HERE — successor orientation

| Doc | Role |
|---|---|
| [`../AGENTS.md`](../AGENTS.md) | **AUTOMATIC CODEX ENTRY POINT.** Concise repository authority, status semantics, pause/freeze rules, shared-worktree safety, and evidence prerequisites. It routes to the tracked sources below and grants no state-changing authority. |
| [`ORCHESTRATION_HANDBOOK.md`](ORCHESTRATION_HANDBOOK.md) | **READ FIRST.** The operating procedure for running this repo: orchestrator/worker contract, per-batch landing procedure and gates, identity + quiet hours, add-only registries, ledger discipline, the evidence-ordering convention, the full verification/instrument doctrine, worker-brief boilerplate, session cadence, environment traps. Procedure only — **queue rows remain the sole status authorities** (full precedence order: charter §0.4). |
| [`WORKER_ISOLATION_AND_BRANCH_HANDOFF.md`](WORKER_ISOLATION_AND_BRANCH_HANDOFF.md) | **Worker isolation + branch handoff — operating procedure (proposed).** Clones not worktrees and why; squash-only landing; the 13-step handoff with a mechanical assertion per step; eight guards; rebase hazards and special handling; six open maintainer decisions. Supersedes the handbook's patch-export flow for worker handoffs. |
| [`CAMPAIGN_STATE.md`](CAMPAIGN_STATE.md) | **READ SECOND.** Tracked campaign-status authority (landed `R-2026-09-02-14`, `MAINTAINER_RULINGS_2026-09-02.md`): the CLAUDE.md "Active Remediation Campaign" section is now a pointer to this file, not the other way around — see `CAMPAIGN_STATE.md:1-3`. Pause/resume authority is the ruling series (`R-2026-08-17-0` recorded the resume); this file also carries the campaign map, quiet-hours rule, and branch-transparency state, mirrored from the gitignored `CLAUDE.md` per `CAMPAIGN_STATE.md:1-13`. |
| [`EXECUTOR_LANE_CHARTER_2026-08-14.md`](EXECUTOR_LANE_CHARTER_2026-08-14.md) | **BINDING EXECUTOR RULES.** Evidence integrity, landing discipline, probe lifecycle, multi-agent ownership, pause/freeze protocol, escalation, and an honest enforcement matrix. |
| [`MAINTAINER_RULINGS_2026-08-14.md`](MAINTAINER_RULINGS_2026-08-14.md) | Current decision authority for the Sol-audit packet, including G3 `>=2700` versus the separate 4096 upgrade, Moon shimmer-envelope scope, compliance hardening, and paused-file reassignment. |
| [`MAINTAINER_RULINGS_2026-08-17.md`](MAINTAINER_RULINGS_2026-08-17.md) | **Current rulings.** Pause/resume recorded as authority; quiet-hours guard fix; governance files tracked; **FAR-107 AMENDED to admit a proof-carrying serve** (unblocks the picking architecture); the `034c7f74d0` ellipsoid loosenings dispositioned; three-layer claim-vs-tree enforcement; C13-41 closure vacated+annotated+swept; catalog split; `refreshCostMeasured` FAIL-capability ordered then amended by `R-2026-08-18-27` (budget-backed predicate only after SOL-4 lands); verifier reports both violation totals. |
| [`MAINTAINER_RULINGS_2026-08-21.md`](MAINTAINER_RULINGS_2026-08-21.md) | **Current rulings.** The `R-2026-08-21-1..7` PROVISIONAL batch: the eleven 2026-08-18 packet recommendations adopted as written for an honest trial — picking §10 answers, weather capture doctrine, C16-R1 widened, dev-server attestation scope, dual-light pre-ruling, branch cleanup. Provisional, not final judgements. |
| [`DECISION_PACKET_2026-08-18.md`](DECISION_PACKET_2026-08-18.md) | The eleven argued amendment decisions (A1-A3, B1-B5, C1-C3) behind the 2026-08-21 provisional batch: evidence with file:line, options, recommendations with stated costs, the mutual-conflict table, and residuals. Evidence authority; authorizes nothing. |
| [`RULING_AUDIT_2026-08-18.md`](RULING_AUDIT_2026-08-18.md) | *(Indexed 2026-09-02, DX-23.)* Ruling audit — 2026-08-18 (per its own heading; feeds the decision packet above). |
| [`DIRTY_LANES_2026-08-21.md`](DIRTY_LANES_2026-08-21.md) | Register of the working tree's in-flight dirty lanes (F-P + strays): each lane's files, status, gates, and ruling dispositions, updated as lanes land. |
| [`RULING_REQUESTS_2026-08-21.md`](RULING_REQUESTS_2026-08-21.md) | *(Indexed 2026-09-02, DX-23.)* Ruling requests — 2026-08-21 (per its own heading; same-dated companion to the dirty-lanes register above). |
| [`MAINTAINER_RULINGS_2026-08-24.md`](MAINTAINER_RULINGS_2026-08-24.md) | *(Indexed 2026-09-02, DX-23.)* Maintainer rulings — 2026-08-24 (per its own heading). |
| [`MAINTAINER_RULINGS_2026-08-28.md`](MAINTAINER_RULINGS_2026-08-28.md) | *(Indexed 2026-09-02, DX-23.)* Maintainer rulings — 2026-08-28 (per its own heading). |
| [`MAINTAINER_RULINGS_2026-09-02.md`](MAINTAINER_RULINGS_2026-09-02.md) | **Current rulings** — Maintainer rulings, 2026-09-02 sitting (`R-2026-09-02-1…-25`); named in CLAUDE.md as governing the next wave (Edge hold narrowed to Q-152, Wave 1 manual-three-step close, C12-29 S3 discriminator, Rust supervisor rename to `chelate`, campaign status moving into `CAMPAIGN_STATE.md`). *(Indexed 2026-09-02, DX-23.)* |
| [`DECISION_PACKET_2026-08-17.md`](DECISION_PACKET_2026-08-17.md) | **Twelve argued decisions — since ruled (`R-2026-08-17-15..-25`); evidence record.** Charter house-scale/push-identity/precedence, five picking decisions, the moon-mip goal question, the weather capture-doctrine's value, 3D Tiles vocabulary adoption, and the two branch-flow remainders. Each carries evidence with `file:line`, options with pros and cons, and a recommendation stating its own cost. Ruling order matters — see the preface. |
| [`CODEX_SOL_OPERATING_BRIEF.md`](CODEX_SOL_OPERATING_BRIEF.md) | Dated coaching and assignment context. It is not a rule source; follow the state, charter, and rulings when prose drifts. |
| [`HANDOVER_AUDIT_2026-08-09.md`](HANDOVER_AUDIT_2026-08-09.md) | The seven-lane cold-start takeover audit that produced the two documents above: per-campaign verdicts, the dependency-ordered fix list, the handbook draft, the RESUME-HERE recommendation, and **four open maintainer asks** (quiet-hours history, CLT-D10 blocking C12's G1, the C11-79 / C12-31 in-gate calls, branch/stash inventory). Evidence authority for the fix batch; not a status authority. |

---

## LIVE — load-bearing trackers (keep current)

| Doc | Role |
|---|---|
| [`MAINTAINER_RULINGS_2026-08-10.md`](MAINTAINER_RULINGS_2026-08-10.md) | **The standing ruling authority** — `R-2026-08-10-1..7` (maximal C12 gate incl. `C12-29` S3 / `C13-41`; §5 limb band re-ratified disc-only; WebGL sun-bloom mirrored; 4096 star re-bake ordered; in-repo STBN generation; v1.144 sync; the confirmation cluster incl. CLT → proposed C17 and `C12-32` → C14 W1). Every alternative option is preserved with its revisit trigger. **Dating:** the rulings landed 2026-08-08; the `2026-08-10` label is retained for ruling-ID stability — order rulings and stamps by **batch number**, not printed date. |
| [`CAMPAIGN_PORTFOLIO_QUEUE.md`](CAMPAIGN_PORTFOLIO_QUEUE.md) | **Current feature-priority dispatch view** across the eight reserved campaigns / nine practical workstreams. Non-authoritative: it selects bounded next slices, enforces integration/browser/WIP limits, and exposes held launch queues; campaign queue rows remain the sole status authorities. |
| [`CLOSEOUT_PLAN_2026-08-07.md`](CLOSEOUT_PLAN_2026-08-07.md) | **Dispatch schedule** for closing C11/C12/C13/C15-gsplat, Lanes A–E. ⚠ **Snapshot of 2026-08-07, substantially executed and superseded in part** (G2 discharged, G4 CLOSED at Batch 984, Lane E's owed-run order is stale) — read its header banner and §3 addendum first. **Grouping only: on any status conflict the queue row wins.** |
| [`LICENSE_DETERMINATIONS_2026-08-10.md`](LICENSE_DETERMINATIONS_2026-08-10.md) | Numbered `L-xx` licence determinations claimed by the batch that derives from a source — the C16 attribution register. **All 23 determinations closed at Batches 965/966**; the reference pre-registration tables in the campaign queues feed it. |
| [`DEV_NOTES_celestial.md`](DEV_NOTES_celestial.md) · [`_clouds`](DEV_NOTES_clouds.md) · [`_globe`](DEV_NOTES_globe.md) · [`_model_pbr`](DEV_NOTES_model_pbr.md) · [`_postprocess`](DEV_NOTES_postprocess.md) · [`_renderer_infra`](DEV_NOTES_renderer_infra.md) · [`_lighting_compute`](DEV_NOTES_lighting_compute.md) · [`_picking`](DEV_NOTES_picking.md) · [`_points_compute`](DEV_NOTES_points_compute.md) · [`_primitive_wgsl`](DEV_NOTES_primitive_wgsl.md) · [`_primitives_classification`](DEV_NOTES_primitives_classification.md) · [`_scene_architecture`](DEV_NOTES_scene_architecture.md) · [`_string_literals`](DEV_NOTES_string_literals.md) · [`_voxel_splat`](DEV_NOTES_voxel_splat.md) | **The DEV_NOTES family** — engineering knowledge relocated verbatim out of source comments by Campaign 16, with file + symbol anchors. Load-bearing: when a C16 shard strips a rationale from `packages/*/Source`, the fact lives here and nowhere else. Format contract: [`DEV_NOTES_FORMAT.md`](DEV_NOTES_FORMAT.md). *(Eight more family members indexed 2026-09-02, DX-23 — they existed on disk but had no row.)* |
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
| [`C18_P3_PNTS_MODEL_ATTENUATION_DESIGN_2026-09-02.md`](C18_P3_PNTS_MODEL_ATTENUATION_DESIGN_2026-09-02.md) | `C18-P3` diagnosis + design (lane Leofa, Batch 1402): the PNTS model-path attenuation / `pointSize` premise is CONFIRMED and traced to its mechanism; the fix does not fit one lane, so the design, the probe and the verdict spec land ahead of it. The C18 queue row remains the status authority. |
| [`QUEUE_2026-08-29_RESEARCH_DISPATCH.md`](QUEUE_2026-08-29_RESEARCH_DISPATCH.md) | **Dispatch order for the two 2026-08-29 research tasks (AEC design-model performance; Earth at Night fork-vs-upstream) plus the meshlet / mesh-shading track (written against the ratified Phase-8b wave placement; Campaign 19 is the alternative under gate M-16; nothing launched).** Dispatch view only: the live ledger [`FIX_QUEUE_2026-08-27_AUDIT_FINDINGS.md`](FIX_QUEUE_2026-08-27_AUDIT_FINDINGS.md) stays the status authority for Q- ids; campaign numbering stays add-only; every maintainer gate is listed in its section 8. Authored by the Glorfindel workflow, critiqued by Thranduil, corrected by Elendil (Batch 1300). |
| [`QUEUE_2026-09-03_ARCHITECTURE_REVIEW.md`](QUEUE_2026-09-03_ARCHITECTURE_REVIEW.md) | **Architecture-review dispatch queue (2026-09-03, lane Eärendur):** one prioritised row per CONFIRMED/CORRECTED finding of the 2026-09-03 lens re-run (appended to [`ARCHITECTURE_REVIEW_2026-09-02.md`](ARCHITECTURE_REVIEW_2026-09-02.md) §3 as the "2026-09-03 survey" blocks and §3.17), the five §4 reversals, every §3 item marked unowned, the landscape HIGH gaps G1–G8 as pointer rows, the maintainer decisions (§5.3 ids, four ADRs stand/change/retire) and the runtime measurements (Éowyn). Priority by one rule (P0 record-vs-code or default-path correctness; P1 reachable parity gap or named-campaign blocker; P2 debt taxing named work; P3 drift/hygiene/typing). **Dispatch view only** — no status authority changes; the dedup pass has run, so every `owned-by` cell names an exact id, `PARTIAL: <id>` or `NEW`. **Folded 2026-09-04 (lane Belegorn):** +141 rows from continuation batches L1 / L2 / L3 and the Éowyn runtime leg. §6 now marks every measurement **RAN with its number or NOT RUN with the instrument the receipt names** (4 RAN of 37; the 33 unrun collapse into ten instrument families, which is what the queue dispatches). §9 carries the amendments the fold owes to rows it does not own — including three 2026-09-03 rows that schedule work the L1 re-derivation refuted. **Row counts recount often — this index goes stale between recounts; trust the queue's own bolded total at `:48` over any number copied here** (measured 2026-09-05: total 385 — P0 57, P1 129, DEFECT 125, GAP 30 — already one recount past the 381 this row previously quoted, per `DOC_FITNESS_AUDIT_2026-09-04.md` G-06). |
| [`UPSTREAM_SYNC_PLAN_1.145_2026-09-04.md`](UPSTREAM_SYNC_PLAN_1.145_2026-09-04.md) | **LANDED, not a plan — this row previously said "358 commits behind" and no merge commit; both are now false (G-06/G-25, `DOC_FITNESS_AUDIT_2026-09-04.md`).** The fork is synced to CesiumJS 1.145 at merge commit `ffb8161c08`, Batch 1408 (parents `40341305f4` fork / `488b114e16` upstream/main; `git merge-base --is-ancestor 488b114e16 HEAD` exits 0; `package.json` version `1.145.0`); see `CAMPAIGN_STATE.md:203` for the landed record and its two owed verification legs. This document is retained as the **historical dry-run record** the landing was built from: the conflict census, four cluster analyses with a resolution per hunk, the toolchain + Playwright-bump survey, and **two findings that outlived the sync** — CLAUDE.md's sync-procedure `--theirs` default was wrong for the 13 conflicted `.js` files the fork has converted to ES6 classes (§3), and a merge-time break spanned the conflict boundary (`AutomaticUniforms.js` auto-merged while its backing `UniformState.js` conflicted, §5.4). Status lives in the `UPSTREAM-SYNC-1.145-*` rows of [`QUEUE_2026-08-29_RESEARCH_DISPATCH.md`](QUEUE_2026-08-29_RESEARCH_DISPATCH.md), not here. Lane U 2026-09-04: lead Nolondil, workers Tar-Ardamin / Tar-Vanimelde / Tar-Telperien / Tar-Surion / Hallacar, reviewer Anardil. |
| [`FIX_QUEUE_2026-08-27_AUDIT_FINDINGS.md`](FIX_QUEUE_2026-08-27_AUDIT_FINDINGS.md) | **The live ledger — status authority for every Q- id.** "Fix queue — every finding from the 2026-08-27 audit evening" (its own heading). Not referenced from `CLAUDE.md` (`grep -c FIX_QUEUE CLAUDE.md` = 0, G-06); referenced from the research-dispatch row above. Had no row of its own until this pass gave it one. *(Indexed 2026-09-02, DX-23 — previously only a backtick mention inside another row.)* |
| [`Q94_SANDCASTLE2_WEBGPU_SCOPING_2026-08-29.md`](Q94_SANDCASTLE2_WEBGPU_SCOPING_2026-08-29.md) | *(Indexed 2026-09-02, DX-23.)* Q-94 scoping memo — "the Sandcastle gallery cannot run on WebGPU" (per its own heading); a Q-id scoping input to the fix queue above. |
| [`QUEUE_2026-08-28_VISUAL_WAVE.md`](QUEUE_2026-08-28_VISUAL_WAVE.md) | *(Indexed 2026-09-02, DX-23.)* "QUEUE 2026-08-28 — VISUAL WAVE (Night-Earth epic armed; three lanes staged)" (per its own heading). |
| [`DX15_TRANSLUCENT_CLASSIFICATION_COMPOSITE_SCAFFOLD_REMOVAL_PREREGISTRATION_2026-08-30.md`](DX15_TRANSLUCENT_CLASSIFICATION_COMPOSITE_SCAFFOLD_REMOVAL_PREREGISTRATION_2026-08-30.md) | *(Indexed 2026-09-02, DX-23.)* DX-15 translucent-classification composite-scaffold removal preregistration (per its own heading) — the scheduled-removal disposition CLAUDE.md Principle 7 points at, for the scaffolding its own origin story describes. **Status: PREREGISTRATION / NO-GO** — the `C11-107` / G6 Q2d Principle-7 sign-off to retire the scaffold is still owed; it authorizes nothing. |
| [`CODEX_HANDOFF_2026-09-01.md`](CODEX_HANDOFF_2026-09-01.md) | *(Indexed 2026-09-02, DX-23.)* Codex three-day cutoff handoff — 2026-09-01 (per its own heading); newest of the CODEX_HANDOFF_* family, supersedes the 2026-08-31 handoff below as the entry point. |
| [`CODEX_HANDOFF_2026-08-31.md`](CODEX_HANDOFF_2026-08-31.md) | **Frozen successor handoff through the 2026-08-31 19:01:18 ET cutoff:** exact main/branch/worktree/dirty inventories; repaired `.agents` sandbox protection; the reviewed runner-census tuple; held reusable-tooling carriers; Windows-only Rust developer validation with formal certification still NO-GO; and choice-free Rust, Q-152, Edge, guard/history, and no-push resume boundaries. This record does not replace live queues or grant execution, landing, browser, certification, or push authority. |
| [`CODEX_PAUSE_HANDOFF_2026-08-31.md`](CODEX_PAUSE_HANDOFF_2026-08-31.md) | *(Indexed 2026-09-02, DX-23.)* Codex pause handoff — 2026-08-31 (per its own heading); distinct same-day document from the cutoff handoff above. |
| [`CODEX_HANDOFF_2026-08-30.md`](CODEX_HANDOFF_2026-08-30.md) | **Exact rolling 24-hour Codex handoff ending 2026-08-30 18:18:07 ET, plus an explicitly separated post-cutoff addendum:** local/remote commit boundaries, concurrent worktrees and clones, measured reds and launcher errors, Rust non-certification and security holds, resume gates, source/review traceability, and the no-push boundary. This documentation record does not replace live queues or grant execution/landing authority. |
| [`CODEX_HANDOFF_2026-08-29.md`](CODEX_HANDOFF_2026-08-29.md) | **Seat handoff to Codex (2026-08-29, Batch 1320 state):** the project in one screen, the reading order of current authorities, what is READY TO LAND (six banked engine batches held only by the maintainer's port-8080 hold, with the exact landing runbook), what is HELD and what releases it, the open decision sheet, the Codex operating rules learned today, where every artifact lives, and the pitfalls. Supersede with a dated successor when the state moves. |
| [`CAMPAIGN_CLOSURE_AUDIT_2026-08-06.md`](CAMPAIGN_CLOSURE_AUDIT_2026-08-06.md) | **HISTORICAL SNAPSHOT at Batch 844** — what stands between here and closing C11 / C12 / C13, every open row classified into five buckets. Produced the four maintainer rulings (R1–R4). **Read its 2026-08-07 addendum first:** its headline "`C13-GATE-B` is 7 probe runs away" is spent (Gate B CLOSED at Batch 866), and its "any red is a real regression" line is REFUTED. *(Indexed 2026-08-07 — it was the only top-level file missing from this table.)* |
| [`ASSEMBLY_LINE_BOARD_2026-08-20.md`](ASSEMBLY_LINE_BOARD_2026-08-20.md) | *(Indexed 2026-09-02, DX-23.)* Assembly-Line Orchestration Board — 2026-08-20 (per its own heading). |
| [`CAMPAIGN_PROGRESS_2026-08-21.md`](CAMPAIGN_PROGRESS_2026-08-21.md) | *(Indexed 2026-09-02, DX-23.)* Campaign progress — 2026-08-21, audited at tip `233086ffc5`, Batch 1107 (per its own heading). |
| [`C11_PREMISE_DISPOSITIONS_2026-08-21.md`](C11_PREMISE_DISPOSITIONS_2026-08-21.md) | *(Indexed 2026-09-02, DX-23.)* Campaign 11 premise dispositions — 2026-08-21 (per its own heading). |
| [`C12_EXIT_EVIDENCE_INDEX_2026-08-21.md`](C12_EXIT_EVIDENCE_INDEX_2026-08-21.md) | *(Indexed 2026-09-02, DX-23.)* Campaign 12 exit-tail evidence index — 2026-08-21 (per its own heading). |
| [`SESSION_CLOSEOUT_2026-08-21.md`](SESSION_CLOSEOUT_2026-08-21.md) | *(Indexed 2026-09-02, DX-23.)* Session Closeout — 2026-08-21 evening, Batches 1129–1137, tiered orchestration (per its own heading). |
| [`T0_FROZEN_BUILD_PROGRAM_2026-08-21.md`](T0_FROZEN_BUILD_PROGRAM_2026-08-21.md) | *(Indexed 2026-09-02, DX-23.)* T0 frozen-build acceptance program — 2026-08-21 (per its own heading). |
| [`TIERED_ORCHESTRATION_PLAYBOOK_2026-08-21.md`](TIERED_ORCHESTRATION_PLAYBOOK_2026-08-21.md) | *(Indexed 2026-09-02, DX-23.)* Tiered orchestration playbook — reference execution 2026-08-21 (per its own heading). |
| [`SOL_CONTINUATION_BRIEF_2026-08-24.md`](SOL_CONTINUATION_BRIEF_2026-08-24.md) | *(Indexed 2026-09-02, DX-23.)* Sol continuation brief — 2026-08-24 (per its own heading). |
| [`CODEX_PROGRESS_AUDIT_2026-08-02.md`](CODEX_PROGRESS_AUDIT_2026-08-02.md) | Post-Batch-818 code review plus current unstaged verification: exact-tuple recovery, snap lifecycle/multi-frustum/cost, Moon lifecycle, cyclic weather tails, honest remaining risks, and next order. |
| [`C12_MOON_TEXTURE_LIFECYCLE_AUDIT_2026-08-02.md`](C12_MOON_TEXTURE_LIFECYCLE_AUDIT_2026-08-02.md) | Canonical C12-35 ownership/lifecycle analysis and final L0-L5 evidence. **Complete / independent GO:** shared decoded sources, backend-local GPU ownership, WebGL parity, diagnostics, Node/Jasmine, and strict real-Edge transport/pixel/teardown certification; C12-33 is unblocked. |
| [`C12_STARFIELD_SEAM_DISPOSITION_2026-08-02.md`](C12_STARFIELD_SEAM_DISPOSITION_2026-08-02.md) | Resolves the Batch-815 catalog/cubemap near-redundancy against existing DR-01: execute C12-11's diffuse-cubemap/resolved-sprite seam; do not remove the catalog or fabricate per-face blur. |
| [`HANDOFF_2026-08-14_CODEX_PAUSE.md`](HANDOFF_2026-08-14_CODEX_PAUSE.md) | *(Indexed 2026-09-02, DX-23.)* Campaign handoff — 2026-08-14 pause (per its own heading); superseded as the entry point by the newer CODEX_HANDOFF_* rows above. |
| [`HANDOFF_2026-08-10_CODEX_USAGE_STOP.md`](HANDOFF_2026-08-10_CODEX_USAGE_STOP.md) | *(Indexed 2026-09-02, DX-23.)* Handoff 2026-08-10 — Codex usage stop (per its own heading); superseded as the entry point by the newer CODEX_HANDOFF_* rows above. |
| [`HANDOFF_2026-08-02_CODEX_NEXT_WAVE.md`](HANDOFF_2026-08-02_CODEX_NEXT_WAVE.md) | **Current Codex handoff** (supersedes the 07-31 handoff): progress through Batch 818, corrected Bug 814.1 disposition, C11/C12/C13 remainders, ratified Campaign 14 Dynamic Ocean & Wind status, and the research-verified Campaign 15 Aurora + Space Weather definition/order. |
| [`HANDOFF_2026-07-31_CODEX_C11_HIGH_VALUE.md`](HANDOFF_2026-07-31_CODEX_C11_HIGH_VALUE.md) | Batch-771 stopping-point record (landed as 772-781); superseded as the entry map by the 2026-08-02 handoff, but its per-ID exit-gate analysis still stands. |
| [`WEBGPU_MIGRATION_STATUS.md`](WEBGPU_MIGRATION_STATUS.md) | Single-source migration status + append-only progress log. **Note: batch numbers are non-monotonic — trust dates/hashes.** **Coverage gap (recorded 2026-08-06):** entries jump from 2026-05-30 (Batch 185) to 2026-08-06 (Batches 819-828); everything between was recorded in the dated campaign queues, `WEBGPU_DEBUGGING_LOG.md`, `DEFERRED_WORK.md` and `FEATURE_INVENTORY.md` instead. Read the older sections as history, not as the frontier. |
| [`DEFERRED_WORK.md`](DEFERRED_WORK.md) | Canonical add-only follow-up inventory (NEW-*/C-R*/DP-* IDs). Where open work lives. |
| [`FEATURE_INVENTORY.md`](FEATURE_INVENTORY.md) | Feature catalog (EXISTING/NEW/WIP/FUTURE) across eleven subsystems (`FORK_OVERVIEW.md:62`; `CLAUDE.md:79-89` lists eleven despite `:77` saying "10") — impact-analysis index (CLAUDE.md Principle 6). |
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
| [`NEXT_SESSION_HANDOFF.md`](NEXT_SESSION_HANDOFF.md) | Append-only handoff log. Its top entry (`:1`) is 2026-08-24 / Batches 1138+; the 2026-05-30 / Batch-185 entry this row used to point to is the file's fourth section and is self-marked "(Archived)" at `:140`. Use the live campaign queues for current execution. |
| [`WEBGPU_DEBUGGING_LOG.md`](WEBGPU_DEBUGGING_LOG.md) | Chronological bug log (append-only). Search before debugging a new artifact. |

## LIVE — Lane records (`branches/**`)

*(New section, 2026-09-02, DX-23 — the directory existed with 29 files and no index section.)*

**What a lane record is.** When a dispatched worker lane (or a review of one) freezes, its packet is
banked as a durable Markdown record under `branches/`, alongside the git history — a record of what
a lane found, built, or reviewed, kept even after its clone is retired. **Lane records are evidence,
not status.** The campaign queue docs (`QUEUE_2026-*_CAMPAIGN*.md`) and the live ledger
[`FIX_QUEUE_2026-08-27_AUDIT_FINDINGS.md`](FIX_QUEUE_2026-08-27_AUDIT_FINDINGS.md) remain the sole
status authorities for whether a row is open, landed, or closed — a lane record documents one lane's
work product at freeze time and does not by itself change a queue row's status.

**Naming convention.** A worker's own record is `branches/<lane-name>--<topic>.md` (the Tolkien lane
name, per CLAUDE.md's worker-naming rule, then its topic in kebab-case). An independent review of
that lane's work is `branches/reviews/<reviewer-name>--<topic>-review.md`, using the reviewer's own
lane name. Three files depart from this convention and are noted as such below: `ACTIVE_WORKFLOW_WAVE_2026-08-29.md`
(a root-orchestrator wave snapshot, not tied to one lane) and `DX19_BRANCH_WORKTREE_SALVAGE_AUDIT_2026-09-02.md`
/ `DX20_SIBLING_REPOSITORY_CENSUS_2026-09-02.md` (dispatch-row-id names for the Celegorm/Nienor
read-only audit lanes rather than `celegorm--...`/`nienor--...`).

Grouped by month (by each file's first-commit date; every row's Role is that file's own first
heading, not an invented summary):

### 2026-08

| Doc | Role |
|---|---|
| [`branches/ACTIVE_WORKFLOW_WAVE_2026-08-29.md`](branches/ACTIVE_WORKFLOW_WAVE_2026-08-29.md) | Active workflow wave — reset-safety snapshot. *(Naming exception — see above.)* |
| [`branches/faramir--handoff-verifier-explicit-lease.md`](branches/faramir--handoff-verifier-explicit-lease.md) | Faramir — worker-handoff verifier explicit-lease repair. |
| [`branches/maedhros--q152-child-result-contract.md`](branches/maedhros--q152-child-result-contract.md) | Maedhros — Q-152 typed child-result contract lease. |
| [`branches/theoden--dx-handoff-procedure-drift.md`](branches/theoden--dx-handoff-procedure-drift.md) | Théoden — worker handoff procedure drift lease. |
| [`branches/tuor--q-152-wave-end-gate-repair.md`](branches/tuor--q-152-wave-end-gate-repair.md) | Tuor — Q-152 wave-end gate repair lease. |
| [`branches/beren--q152-wave-end-mutant-eol.md`](branches/beren--q152-wave-end-mutant-eol.md) | Beren — Q-152 wave-end mutant EOL harness repair. |
| [`branches/elros--q141-pick-during-pipeline-readiness.md`](branches/elros--q141-pick-during-pipeline-readiness.md) | Elros — Q-141 pick emission during color-pipeline readiness. |
| [`branches/gandalf--watch-build-scheduler-race-audit.md`](branches/gandalf--watch-build-scheduler-race-audit.md) | Gandalf — watch-build scheduler race audit. |
| [`branches/maglor--research-queue-encoding-normalization.md`](branches/maglor--research-queue-encoding-normalization.md) | Maglor - research queue encoding normalization. |
| [`branches/reviews/aragorn--handoff-verifier-review.md`](branches/reviews/aragorn--handoff-verifier-review.md) | Aragorn independent review — worker-handoff verifier. |
| [`branches/reviews/beregond--handoff-procedure-destination-review.md`](branches/reviews/beregond--handoff-procedure-destination-review.md) | Beregond destination-materialization review — Théoden handoff procedure. |
| [`branches/reviews/beregond--handoff-procedure-review.md`](branches/reviews/beregond--handoff-procedure-review.md) | Beregond independent review — Théoden worker-handoff procedure correction. |
| [`branches/reviews/curufin--q152-child-result-contract-review.md`](branches/reviews/curufin--q152-child-result-contract-review.md) | Q-152 H0 Wave-Child Result Contract — Independent Terminal Review (reviewer: Curufin). |
| [`branches/reviews/faramir--q152-wave-end-mutant-eol-review.md`](branches/reviews/faramir--q152-wave-end-mutant-eol-review.md) | Faramir review — Q-152 mutant EOL harness repair. |
| [`branches/reviews/glorfindel--q141-pick-during-pipeline-readiness-review.md`](branches/reviews/glorfindel--q141-pick-during-pipeline-readiness-review.md) | Glorfindel independent review — Q-141 pick during color-pipeline readiness. |
| [`branches/reviews/haleth--handoff-procedure-destination-review.md`](branches/reviews/haleth--handoff-procedure-destination-review.md) | Haleth destination-materialization re-close — Théoden procedure. |
| [`branches/reviews/haleth--handoff-procedure-review.md`](branches/reviews/haleth--handoff-procedure-review.md) | Haleth independent review — Théoden worker-handoff procedure. |
| [`branches/reviews/imrahil--batch-1331-bookkeeping-review.md`](branches/reviews/imrahil--batch-1331-bookkeeping-review.md) | Imrahil independent bookkeeping review — Batch 1331 final. |
| [`branches/reviews/nimrodel--q152-destination-provenance-review.md`](branches/reviews/nimrodel--q152-destination-provenance-review.md) | Q-152 Destination Materialization Provenance Review (reviewer: Nimrodel). |
| [`branches/reviews/nimrodel--q152-provenance-review.md`](branches/reviews/nimrodel--q152-provenance-review.md) | Q-152 Provenance and Fail-Closed Safety Review (reviewer: Nimrodel). |
| [`branches/reviews/turgon--q152-destination-materialization-review.md`](branches/reviews/turgon--q152-destination-materialization-review.md) | Turgon Q-152 Destination-Materialization Review. |
| [`branches/reviews/turgon--q152-fail-closed-review.md`](branches/reviews/turgon--q152-fail-closed-review.md) | Q-152 Fail-Closed Safety Landing Review (reviewer: Turgon). |

### 2026-09

| Doc | Role |
|---|---|
| [`branches/aegnor--q130-phase-a-source-fleet-cleanliness.md`](branches/aegnor--q130-phase-a-source-fleet-cleanliness.md) | Aegnor — Q130 Phase A WGSL source-fleet cleanliness. |
| [`branches/arwen--feature-renderer-ci-strict-gate.md`](branches/arwen--feature-renderer-ci-strict-gate.md) | Arwen - strict FeatureRenderer audit CI gate. |
| [`branches/faramir--q130-standalone-wgsl-generator-authority-removal.md`](branches/faramir--q130-standalone-wgsl-generator-authority-removal.md) | Faramir — Q130 standalone-WGSL generator-authority removal. |
| [`branches/reviews/denethor--rust-process-supervisor-supply-chain-review.md`](branches/reviews/denethor--rust-process-supervisor-supply-chain-review.md) | Denethor independent review — Rust process-supervisor supply chain. |
| [`branches/reviews/finrod--q130-phase-a-source-fleet-cleanliness-review.md`](branches/reviews/finrod--q130-phase-a-source-fleet-cleanliness-review.md) | Finrod (Q130) — independent durable review of Q130 Phase A source-fleet cleanliness. |
| [`branches/DX19_BRANCH_WORKTREE_SALVAGE_AUDIT_2026-09-02.md`](branches/DX19_BRANCH_WORKTREE_SALVAGE_AUDIT_2026-09-02.md) | DX-19 — branch and worktree salvage audit. *(Naming exception — see above.)* |
| [`branches/DX20_SIBLING_REPOSITORY_CENSUS_2026-09-02.md`](branches/DX20_SIBLING_REPOSITORY_CENSUS_2026-09-02.md) | DX-20 — sibling-repository census (2026-09-02). *(Naming exception — see above.)* |

## LIVE — reference & guides (keep in sync with code)

| Doc | Role |
|---|---|
| [`DEBUGGING_GUIDE.md`](DEBUGGING_GUIDE.md) | Single entry point for debugging tools + probes + CesiumDebug commands. |
| [`FEATURE_RENDERER_ONBOARDING.md`](FEATURE_RENDERER_ONBOARDING.md) | Step-by-step guide to adding a new WebGPU Feature Renderer (key, eager/lazy registration, lifecycle, Scene access, compat exemption). |
| [`IMAGERY_PROJECTION.md`](IMAGERY_PROJECTION.md) | Single source of truth for imagery-layer projection (WebGL + WebGPU). |
| [`SHADER_PAIRS_LOCKSTEP.md`](SHADER_PAIRS_LOCKSTEP.md) | WGSL/GLSL shader-pair parity contract. |
| [`DEV_NOTES_FORMAT.md`](DEV_NOTES_FORMAT.md) | Format for the `DEV_NOTES_<SUBSYSTEM>.md` files that hold engineering knowledge relocated out of source comments by Campaign 16 — file + symbol anchor, verbatim text, date moved, and why it was kept. |
| [`CLOUD_COORDINATE_CONTRACT_2026-07-23.md`](CLOUD_COORDINATE_CONTRACT_2026-07-23.md) | **Active contract** — WGS84/RTE coordinate rules for every planetary-cloud producer/consumer (C13-03 complete; Gate B open). Owner: Campaign 13 queue. |
| [`TOOLING_CATALOG.md`](TOOLING_CATALOG.md) | *(Indexed 2026-09-02, DX-23.)* Tooling Catalog — the `.mjs` library census (per its own heading); keep in sync whenever a `Tools/**` script family changes. |
| [`CHELATE.md`](CHELATE.md) | Where the Rust process supervisor now lives and its status: relocated out of this repository to `F:/Dev/GH/chelate` by `R-2026-09-02-13`; NO-GO on certification/Q-152 integration until the certification row is funded. Nothing in this repository invokes it. *(Indexed 2026-09-05, `DOC_FITNESS_AUDIT_2026-09-04.md` G-06 — previously zero README mentions.)* |

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
| [`CELESTIAL_LIGHT_TRANSPORT_PLAN_2026-08-07.md`](CELESTIAL_LIGHT_TRANSPORT_PLAN_2026-08-07.md) | "Celestial Light Transport & Eye Adaptation — Research + Queue" (per its own heading). The proposed-C17 planning source; Campaign 17 itself remains PROPOSED, not launched (CLAUDE.md). *(Indexed 2026-09-02, DX-23 — previously only a backtick mention inside an unrelated row.)* |
| [`C17_CELESTIAL_LIGHT_TRANSPORT_SCOPE_2026-08-28.md`](C17_CELESTIAL_LIGHT_TRANSPORT_SCOPE_2026-08-28.md) | *(Indexed 2026-09-02, DX-23.)* "Campaign 17 (Celestial Light Transport & Eye Adaptation) — Scope Refresh" (per its own heading); companion scope update to the plan above, same proposed-not-launched status. |
| [`RUST_PROCESS_SUPERVISOR_V1_BEHAVIORAL_HARDENING_PREREGISTRATION_2026-08-30.md`](RUST_PROCESS_SUPERVISOR_V1_BEHAVIORAL_HARDENING_PREREGISTRATION_2026-08-30.md) · [`_CARGO_LOCK_REFRESH`](RUST_PROCESS_SUPERVISOR_CARGO_LOCK_REFRESH_PREREGISTRATION_2026-08-30.md) · [`_SUPPLY_CHAIN_DURABLE_INVERSE`](RUST_PROCESS_SUPERVISOR_SUPPLY_CHAIN_DURABLE_INVERSE_PREREGISTRATION_2026-08-30.md) | *(Indexed 2026-09-02, DX-23.)* Three same-day preregistrations for the `Tools/process-super*` Rust supervisor — V1 behavioral hardening, an offline Cargo.lock refresh, and a durable supply-chain inverse (per each file's own heading). Ties to the CLAUDE.md 2026-09-02 ruling line "the Rust supervisor relocates, is audited without shrinking, and is named **chelate**." |

## LIVE — audits & reviews (frozen baselines, still referenced)

| [`DOC_FITNESS_AUDIT_2026-09-04.md`](DOC_FITNESS_AUDIT_2026-09-04.md) | **Current documentation-fitness authority** (measured `b964e0da30`, Batch 1424): five independent lenses judge the doc set for fitness for purpose, not prose quality; §3 is the gap table (each `G-` id file:line cited, refuted findings listed separately), §4 is the 30-card documentation programme (WRITE/MERGE/ARCHIVE/GUARDS) that drove documentation wave D1, §5 the ten open maintainer decisions (D1-D10). Row added by wave D1 lane 2 (Ragnir) — this file was banked into `migration_doc/` by lane 1 (Algund); reconcile if a duplicate row lands from that packet. |
| [`ARCHITECTURE_REVIEW_2026-09-02.md`](ARCHITECTURE_REVIEW_2026-09-02.md) | **Current architecture-review authority.** Migrates the live findings of the ten 2026-04-16 through 2026-07-31 reviews (§3, by subsystem), the C-R\*/H-R\*/M-R\*/L-R\* and A.\*/B.\*/C.\*/D.\* id appendices (§5), five reversals of items previously believed closed (§4), and the merged inbound-reference repoint table. Supersedes the seven REMOVE-AFTER-MIGRATION documents now under `archive/` and narrows the three retained KEEP-PART documents to their still-undigested blocks. **Folded 2026-09-04 (lane Belegorn):** each §3 subsystem carries a dated **2026-09-04 continuation** sub-block from batches L1 and L2; `R17` is **retired** (refuted on an exhaustive negative) and `R16` **scoped from four items to two**; §7.1 is replaced — the never-re-derived closed set is **375, not 383**, and it has now been re-derived (365 stand, 10 reversed, 0 unadjudicated), with a further sweep of the 110 ledger-only-evidence closures; §7.2's six unfinished lens scopes are **two** (tiles, globe); §7.5 records that the runtime leg partly ran. `C-R14` is marked **discharged**, so §5.3 names two undefined ids, not three. |
| [`ARCHITECTURE_REVIEW_PLAN_2026-09-02.md`](ARCHITECTURE_REVIEW_PLAN_2026-09-02.md) | The plan the 2026-09-02 review ran under: why now (1,907 engine commits since the 2026-07-13 FAR audit), the eighteen lenses, the rules each lens is measured against (FAR §2 invariants + ADR-1..ADR-8), and the survival bar. **Sixteen of the eighteen lenses have not run** — this document is the specification for that outstanding pass. |
| [`RENDERER_LANDSCAPE_AUDIT_2026-09-02.md`](RENDERER_LANDSCAPE_AUDIT_2026-09-02.md) | External-comparison audit — three.js `WebGPURenderer`/TSL, luma.gl 9 / deck.gl 9, the WebGPU platform, CesiumJS upstream and the geospatial field, plus (revision 2026-09-03) PlayCanvas, Babylon.js and Bevy / wgpu / naga — with a per-claim census appendix: 177 claims verified at source (171 kept, 2 refuted, 4 split; every vote, URL and quote listed), 158 of the kept claims mapped against the fork at `file:line` (159 statuses in all, one on a split claim). Its ranked HIGH gaps (G1-G10) are reproduced at [`ARCHITECTURE_REVIEW_2026-09-02.md`](ARCHITECTURE_REVIEW_2026-09-02.md) §6.2; its MEDIUM list, "what NOT to copy" section and claim census are here only. The census was re-derived from the verification re-run on 2026-09-03 (lane Erchirion); its rows are ranked leads with named demonstrating targets, not adjudicated findings. |
| [`audits/2026-09-02_ARCHITECTURE_REVIEW_PHASE1.md`](audits/2026-09-02_ARCHITECTURE_REVIEW_PHASE1.md) | **PARTIAL AND UNRELIABLE — do not cite as a premise.** Phase-1 internal synthesis from two of eighteen lenses; four of its anchors were re-derived false at HEAD (two overstate a defect, two are unverified claims of health) and it carries that list as a banner. Tracked for provenance and because its geometry-primitive teardown finding is real. Disposition at [`ARCHITECTURE_REVIEW_2026-09-02.md`](ARCHITECTURE_REVIEW_2026-09-02.md) §6.1. |
| [`audits/2026-09-02_old_review_validity/`](audits/2026-09-02_old_review_validity/SUMMARY.md) (12 docs: `SUMMARY.md`, `INBOUND_REFERENCES.md`, `INDEX.json`, `judgements.raw.json`, and a `.judgement.json` + `.verified.md` pair per retired review) | **The validity bank feeding the review above.** Every closed item from all ten reviews keeps its id, title, claim, status and evidence line here even after the source document is archived or (for the three KEEP-PART docs) trimmed — this is the permanent record `ARCHITECTURE_REVIEW_2026-09-02.md` §7.1 points to for the closed set. **The 375 of those no verifier had reached were re-derived on 2026-09-04** (batch L3): 365 stand, 10 reversed. The earlier figure of 383 counted spot-checks rather than items — second readers had covered 65, not 57. |

| Doc | Role |
|---|---|
| [`SOL_WEEK_AUDIT_2026-08-14.md`](SOL_WEEK_AUDIT_2026-08-14.md) | Six-lane read-only audit of the Codex Sol 5.6 range `cff0b76a2f..034c7f74d0`: 22 ranked findings, dependency-ordered fix queue, and the decision packet that produced the 2026-08-14 rulings. Claims apply only to its stated audited/recomputed coverage. |
| [`PICK_DURING_MOTION_INVESTIGATION_2026-08-14.md`](PICK_DURING_MOTION_INVESTIGATION_2026-08-14.md) | R-2026-08-14-3 investigation of record: gate archaeology, reprojection physics, bounded identity-plateau design, staged fix plan, and acceptance plan. No quick fix lands ahead of the investigation decision. |
| [`PICKING_ARCHITECTURE_STATE_2026-08-17.md`](PICKING_ARCHITECTURE_STATE_2026-08-17.md) | **Picking state of record + readiness/freshness design.** What picking is today across both backends, the eight outstanding issues (P-1..P-8), what is shipped-but-unconsumed, six corrections to prior belief, the staged S0-S7 plan, and six open maintainer decisions. Supersedes ad-hoc pick notes; pairs with the pick-during-motion investigation. |
| [`CODEX_DISAGREEMENTS_WITH_FABLE_REVIEW_2026-08-16.md`](CODEX_DISAGREEMENTS_WITH_FABLE_REVIEW_2026-08-16.md) | *(Indexed 2026-09-02, DX-23.)* Codex disagreements and reconciliation with the Fable review — 2026-08-16 (per its own heading). |
| [`ENGINE_PROMOTION_AUDIT_2026-08-16.md`](ENGINE_PROMOTION_AUDIT_2026-08-16.md) | *(Indexed 2026-09-02, DX-23.)* Engine-Promotion Audit — logic in Tools that belongs in the engine — 2026-08-16 (per its own heading). |
| [`CODEX_FABLE_OPUS_CHANGE_AUDIT_2026-08-17.md`](CODEX_FABLE_OPUS_CHANGE_AUDIT_2026-08-17.md) | *(Indexed 2026-09-02, DX-23.)* Codex audit of the Fable/Opus orchestration range (per its own heading). |
| [`CLAUDE_PROGRESS_AUDIT_2026-07-26.md`](CLAUDE_PROGRESS_AUDIT_2026-07-26.md) | Current continuation audit for Batches 745–768 plus the Batch-769/770/S5 reconciliation: landed-change review, parked-lane readiness, confirmed regressions, campaign truth, verification, and next priorities. |
| [`CLOUD_ARCHITECTURE_AUDIT_2026-07-23.md`](CLOUD_ARCHITECTURE_AUDIT_2026-07-23.md) | **Current cloud evidence authority**: WGS84/RTE, temporal reconstruction, weather wrapping/bounds, regional variation, deterministic formation randomization, quality, lifecycle, and Takram comparison. |
| [`VOXEL_POINTCLOUD_GSPLAT_AUDIT_2026-08-09.md`](VOXEL_POINTCLOUD_GSPLAT_AUDIT_2026-08-09.md) | **Current parity + adoption evidence authority for voxels, point clouds and Gaussian splats** (maintainer ask 2026-08-09; 20-agent read-only workflow, every in-repo claim file:line cited). Per-subsystem parity tables with an explicit `code` / `probe(stale)` / `fresh` verification level, 10 ranked gaps, 10 ranked adoption candidates with acceptance criteria, and a recommended sequence. **Launched [`QUEUE_2026-08-09_CAMPAIGN18.md`](QUEUE_2026-08-09_CAMPAIGN18.md)**; the five defect rows it surfaced are filed in [`DEFERRED_WORK.md`](DEFERRED_WORK.md). |
| [`REFERENCE_VISUALS_CATALOG_2026-08-09.md`](REFERENCE_VISUALS_CATALOG_2026-08-09.md) | **Current license-vetted external-reference catalog** (maintainer ask 2026-08-09; 21-agent web workflow, 14 LICENSE files fetched and read verbatim). ~50 projects across atmosphere/celestial, planet/space, weather/cloud, water/ocean, bathymetry/terrain and environment effects, each with ecosystem, licence verdict (USABLE / FILE-COPYLEFT / STUDY-ONLY / UNKNOWN), a **✔ verbatim-read vs △ repo-declared** marker, and the fork row it guides — plus an honest gaps section (notably **zero vetted gsplat references**). Its §4 process recommendation seeded the "Reference pre-registration (2026-08-09)" tables now carried in `OCEAN_DYNAMICS_PLAN_2026-07-24.md`, `QUEUE_2026-08-02_CAMPAIGN15.md`, `CELESTIAL_LIGHT_TRANSPORT_PLAN_2026-08-07.md` and `WEATHER_DATA_INGEST_ROADMAP.md`. |
| [`SIGGRAPH_2026_SCOUT_2026-08-09.md`](SIGGRAPH_2026_SCOUT_2026-08-09.md) | SIGGRAPH/HPG 2026 sweep: 5 usable items (GPS sort-free splats BSD-3, RaDe-GS math, Apache volume course, Gabor Fields, Smolder), verified negative results (no sky/ocean/shadow/OIT competition), Inria-trap confirmations, pre-registration recommendations. *(Was a stray bullet inside this table until 2026-08-09.)* |
| [`GSPLAT_REFERENCE_VETTING_2026-08-09.md`](GSPLAT_REFERENCE_VETTING_2026-08-09.md) | **Current licence authority for the Gaussian-splat ecosystem** — the `C18-S0` pass that closed the reference catalog's §3 "zero vetted gsplat candidates" gap. 20 projects, licence artifacts fetched and transcribed literally (✔ verbatim-read / ◐ partial / △ declared-only), an Inria provenance-chain verdict per candidate, honest gaps, and a recommendation per Wave-S row. **Headline: `autonomousvision/mip-splatting` and `r4dl/StopThePop` both carry the Inria/MPII research-only "Gaussian-Splatting License" byte-for-byte**, so `C18-S2` is clean-room-from-paper mandatory and three of Wave S's four rows need no external reference. Feeds the pre-registration tables in [`QUEUE_2026-08-09_CAMPAIGN18.md`](QUEUE_2026-08-09_CAMPAIGN18.md) §6 and [`QUEUE_2026-08-02_CAMPAIGN15.md`](QUEUE_2026-08-02_CAMPAIGN15.md) §2b. **Pre-registrations, not determinations** — numbered `L-xx` entries stay in [`LICENSE_DETERMINATIONS_2026-08-10.md`](LICENSE_DETERMINATIONS_2026-08-10.md), claimed by the batch that derives. |
| [`GSPLAT_MESH_RIG_RESEARCH_2026-08-09.md`](GSPLAT_MESH_RIG_RESEARCH_2026-08-09.md) | *(Indexed 2026-09-02, DX-23.)* "Gsplat Mesh / Rig / Relight — Standards Research (FINAL, 2026-08-09)" (per its own heading); same-day companion to the licence vetting row above. |
| [`LICENSE_VETTING_AURORA_OCEAN_2026-08-21.md`](LICENSE_VETTING_AURORA_OCEAN_2026-08-21.md) | *(Indexed 2026-09-02, DX-23.)* "License Vetting — Aurora, Ocean, Wind, and Space Weather" (per its own heading); same family as the two licence-authority rows above, later date. |
| [`audits/2026-06-11_ULTRA_REVIEW.md`](audits/2026-06-11_ULTRA_REVIEW.md) (+ `_findings.json`) | **Most-recent deep multi-agent review** (53 agents, 195 confirmed findings, HEAD `f6fd367827`). Per-finding sidecar JSON is the machine-readable index. Source of the A-* findings driving the current campaign phases. **(Retained: holds live content — see the 2026-09-02 review.** The `A<n>.<m>`/`B<n>` id-to-title index for its ~175 already-closed findings has no other home; `ARCHITECTURE_REVIEW_2026-09-02.md` §5.2 migrates only the 60 still-open items.) |
| [`FORK_DRIFT_ANALYSIS_2026-06-11.md`](FORK_DRIFT_ANALYSIS_2026-06-11.md) | Fork-vs-upstream drift analysis + sync decision (2026-06-11). |
| [`RESEARCH_TAKRAM_GEOSPATIAL_VISUALS.md`](RESEARCH_TAKRAM_GEOSPATIAL_VISUALS.md) | Research input — celestial/atmosphere visual-fidelity study (Takram `three-geospatial`); to fold into the campaign roadmap. Not yet scheduled. |
| [`PRINCIPAL_ENGINEER_REVIEW_PER_FEATURE_2026_04_16.md`](PRINCIPAL_ENGINEER_REVIEW_PER_FEATURE_2026_04_16.md) | Per-feature review with FIXED/DEFERRED annotations (exec summary = 2026-04-16 baseline). **(Retained: holds live content — see the 2026-09-02 review.** It is the sole id-to-title definition source for `B-<n>`/`C-P<n>`/`H-P<n>`/`M-P<n>`/`L-P<n>`; `M-P*` and `L-P*` have no taxonomy row anywhere else. Its 16 live items migrated to `ARCHITECTURE_REVIEW_2026-09-02.md` §3.) |
| [`FUTURE_RESEARCH_2026_05_01.md`](FUTURE_RESEARCH_2026_05_01.md) | Forward-looking R-1..R-7 research triage. |
| [`UPSTREAM_MERGE_2026-06_CHANGELOG.md`](UPSTREAM_MERGE_2026-06_CHANGELOG.md) | v1.142 upstream-merge conflict-resolution record + regression targets (2026-06-17). Frozen record. |
| [`WEBGPU_PARITY_AUDIT_2026-06.md`](WEBGPU_PARITY_AUDIT_2026-06.md) | Post-merge v1.141–1.143 parity audit — source of the 14-batch backlog run. Historical. |
| [`WEBGPU_PARITY_REPORT_2026-06-30.md`](WEBGPU_PARITY_REPORT_2026-06-30.md) | Parity snapshot at Batch 458. **SUPERSEDED by** [`WEBGPU_PARITY_REPORT_2026-07-01.md`](WEBGPU_PARITY_REPORT_2026-07-01.md) (its own banner says so). |
| [`WEBGPU_PARITY_REPORT_2026-07-01.md`](WEBGPU_PARITY_REPORT_2026-07-01.md) | Parity snapshot at Batch 480 (post-parity-sprint); the §6 list drove `PARITY_TO_100.md` and the 2026-07 campaign queues. Point-in-time. |
| [`FORK_VS_UPSTREAM_WEBGPU_ARCHITECTURE_AUDIT_2026-07-13.md`](FORK_VS_UPSTREAM_WEBGPU_ARCHITECTURE_AUDIT_2026-07-13.md) | The fork-vs-upstream architecture audit that launched the FAR remediation plan. Frozen evidence baseline. **(Retained: holds live content — see the 2026-09-02 review.** Its lines 565-588 "Allocation ownership … Maximum safe sharing boundary" block — the scope-by-scope sharing table no judgement item covers — has no other home; reproduced in part at `ARCHITECTURE_REVIEW_2026-09-02.md` §3.11.) |
| [`CURRENT_RENDERING_FUNCTIONALITY_BASELINE_2026-07-13.md`](CURRENT_RENDERING_FUNCTIONALITY_BASELINE_2026-07-13.md) | Phase-0 characterization anchor: what the fork could do before the remediation fixes began. |
| [`FAR_200_SUBMISSION_AUTHORITY_ADOPTION_2026-07-13.md`](FAR_200_SUBMISSION_AUTHORITY_ADOPTION_2026-07-13.md) | FAR-200 submission-authority adoption inventory (`SubmissionSerialAuthority` shadow-infrastructure boundary). |
| [`FORK_PERFORMANCE_AUDIT_AND_FIX_RESULTS_2026-07-14.md`](FORK_PERFORMANCE_AUDIT_AND_FIX_RESULTS_2026-07-14.md) | First measured hot-path tranche record (2026-07-14/15). Performance authority passed to `archive/FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md` (archived 2026-09-03; current premise check in `ARCHITECTURE_REVIEW_2026-09-02.md` §3.15/§4 R5). |
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
| [`3D_TILES_PATCH_EXTENSION_DESIGN_2026-08-11.md`](3D_TILES_PATCH_EXTENSION_DESIGN_2026-08-11.md) | *(Indexed 2026-09-02, DX-23.)* "3D Tiles Patch and Invalidation Extension — Working Design and Research Tracker" (per its own heading) — the design-tracker anchor for the family below. Audits: [`_AUDIT_2026-08-16`](3D_TILES_PATCH_EXTENSION_AUDIT_2026-08-16.md) ("Heavy Design Audit"), [`_REAUDIT_2026-08-16`](3D_TILES_PATCH_EXTENSION_REAUDIT_2026-08-16.md) ("Closing-Gate Re-Audit"). P0a preregistration trail: [`_P0A_PREREGISTRATION`](3D_TILES_PATCH_EXTENSION_P0A_PREREGISTRATION_2026-08-26.md), [`_P0A_REPAIR_PREREGISTRATION`](3D_TILES_PATCH_EXTENSION_P0A_REPAIR_PREREGISTRATION_2026-08-26.md), [`_P0A_R2_BOUNDED_CARRIER_PREREGISTRATION`](3D_TILES_PATCH_EXTENSION_P0A_R2_BOUNDED_CARRIER_PREREGISTRATION_2026-08-26.md), [`_P0A_RESULT`](3D_TILES_PATCH_EXTENSION_P0A_RESULT_2026-08-26.md) ("P0a-R2 result"). P0b-core preregistration trail (R1–R8, each its own round): [`_P0B_CORE_PREREGISTRATION`](3D_TILES_PATCH_EXTENSION_P0B_CORE_PREREGISTRATION_2026-08-26.md), [`_R1`](3D_TILES_PATCH_EXTENSION_P0B_CORE_R1_PREREGISTRATION_2026-08-26.md), [`_R2_ACYCLIC_AUTHORITY`](3D_TILES_PATCH_EXTENSION_P0B_CORE_R2_ACYCLIC_AUTHORITY_PREREGISTRATION_2026-08-26.md), [`_R3_TRACKED_PARSER_PROVENANCE`](3D_TILES_PATCH_EXTENSION_P0B_CORE_R3_TRACKED_PARSER_PROVENANCE_PREREGISTRATION_2026-08-26.md), [`_R4_SEPARATED_PARSER_PROVENANCE`](3D_TILES_PATCH_EXTENSION_P0B_CORE_R4_SEPARATED_PARSER_PROVENANCE_PREREGISTRATION_2026-08-26.md), [`_R5_SPLIT_PACKAGE_TREE`](3D_TILES_PATCH_EXTENSION_P0B_CORE_R5_SPLIT_PACKAGE_TREE_PREREGISTRATION_2026-08-26.md), [`_R6_SNAPSHOT_FIXTURE_SPLIT`](3D_TILES_PATCH_EXTENSION_P0B_CORE_R6_SNAPSHOT_FIXTURE_SPLIT_PREREGISTRATION_2026-08-27.md), [`_R7_OBSERVATION_HARNESS_SPLIT`](3D_TILES_PATCH_EXTENSION_P0B_CORE_R7_OBSERVATION_HARNESS_SPLIT_PREREGISTRATION_2026-08-27.md), [`_R8_ADJUDICATOR_CAP_CORRECTION`](3D_TILES_PATCH_EXTENSION_P0B_CORE_R8_ADJUDICATOR_CAP_CORRECTION_PREREGISTRATION_2026-08-27.md), [`_RESULT`](3D_TILES_PATCH_EXTENSION_P0B_CORE_RESULT_2026-08-26.md) ("P0b-core result"). Seventeen files total, none previously indexed. |
| [`SOL_CODEBASE_GOVERNANCE_AND_CAMPAIGN_AUDIT_2026-08-26.md`](SOL_CODEBASE_GOVERNANCE_AND_CAMPAIGN_AUDIT_2026-08-26.md) | *(Indexed 2026-09-02, DX-23.)* Sol codebase, governance, and campaign audit — 2026-08-26 (per its own heading). |
| [`AUDIT_2026-08-27_SOL_WAVE_AND_PROJECT_SWEEP.md`](AUDIT_2026-08-27_SOL_WAVE_AND_PROJECT_SWEEP.md) | *(Indexed 2026-09-02, DX-23.)* Audit — the 2026-08-26/27 Sol wave, plus a project-wide sweep (per its own heading). |
| [`C12_38_SUN_DISC_DAWN_PROBE_EXPECTATION_2026-08-27.md`](C12_38_SUN_DISC_DAWN_PROBE_EXPECTATION_2026-08-27.md) | *(Indexed 2026-09-02, DX-23.)* Sun-disc dawn probe expectation — 2026-08-27 (per its own heading); a `C12-38` gate artifact. |
| [`C14_READINESS_REVIEW_2026-08-28.md`](C14_READINESS_REVIEW_2026-08-28.md) | *(Indexed 2026-09-02, DX-23.)* "Campaign 14 (Dynamic Ocean & Wind) — Readiness Review" (per its own heading); companion to the ratified `OCEAN_DYNAMICS_PLAN_2026-07-24.md` planning authority above. |
| [`_DOC_AUDIT_PLAN.md`](_DOC_AUDIT_PLAN.md) | Record of the 2026-05-30 doc audit + cleanup plan (this reorg). |

---

## ARCHIVED — historical snapshots (under `archive/`; not live)

| Path | Superseded by |
|---|---|
| `archive/sandcastle-batch-66/` (5 reports) | All Batch-66 Sandcastle blockers fixed; status in `DEFERRED_WORK.md` + `WEBGPU_DEBUGGING_LOG.md`. |
| `archive/principal-review-2026-04-16/` (build/lifecycle + data-pipeline pillars, plus `PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md`, archived 2026-09-03) | Findings live in `DEFERRED_WORK.md`; the RENDERER_DEEP pillar's C-R\*/H-R\*/M-R\*/L-R\* id table is transcribed at [`ARCHITECTURE_REVIEW_2026-09-02.md`](ARCHITECTURE_REVIEW_2026-09-02.md) §5.1. The PER_FEATURE pillar stayed active (see LIVE — audits & reviews). |
| `archive/audits-2026-04-30/` (3 docs: `2026-04-30_ARCHITECTURE_PERFORMANCE.md`, `_FORK_FEATURE_INVENTORY.md`, `_MAINTAINABILITY_SURVIVABILITY.md`; archived 2026-09-03) | Findings migrated into [`ARCHITECTURE_REVIEW_2026-09-02.md`](ARCHITECTURE_REVIEW_2026-09-02.md) §3 (per-subsystem) and §3.11 (survivability — the `ARCHITECTURE.md:969-974` repoint target). |
| `archive/AUDIT_2026_05_02.md` (archived 2026-09-03) | **id-definition source** for `A.<n>`/`B.<n>`/`C.<n>`/`D.<n>`; the one-line-per-id table is at [`ARCHITECTURE_REVIEW_2026-09-02.md`](ARCHITECTURE_REVIEW_2026-09-02.md) §5.2. Live findings (incl. B.11, C.6) migrated into §3. |
| `archive/FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md` (archived 2026-09-03) | Second-pass action record; the `F5-*` id register, the eleven principles, and its still-open items are at [`ARCHITECTURE_REVIEW_2026-09-02.md`](ARCHITECTURE_REVIEW_2026-09-02.md) §3.15 and §4 R5. |
| `archive/LOCAL_CHANGE_AUDIT_2026-07-31.md` (archived 2026-09-03) | Findings migrated into [`ARCHITECTURE_REVIEW_2026-09-02.md`](ARCHITECTURE_REVIEW_2026-09-02.md) §3; its §11 addendum and file/batch/artifact list are inlined at `WEBGPU_DEBUGGING_LOG.md:16478`. |
| `archive/batch-plans/` (8 BATCH_*_PLAN, all SHIPPED) | `WEBGPU_CONTEXT_DECOMPOSITION_PLAN.md` + inline code comments. |
| `archive/COMPREHENSIVE_AUDIT_2026_03_31.md` | `FEATURE_INVENTORY.md`, `DEFERRED_WORK.md`, the 2026-04-30 audit trio (now itself archived at `archive/audits-2026-04-30/`, see row above). |
| `archive/WIRING_AUDIT_2026_04_02.md` | `audits/2026-04-30_*`, now itself archived at `archive/audits-2026-04-30/` (see row above) — current wiring reference is `ARCHITECTURE_REVIEW_2026-09-02.md`. |
| `archive/SNAPSHOT_MODE_SPIKE_2026-04-09.md` | Shipped (`SnapshotModeService.js`); `FEATURE_INVENTORY.md`. |
| `archive/OVERSIGHT_AUDIT_2026_04_25.md` | Rolled up in `WEBGPU_MIGRATION_STATUS.md`. |
| `archive/REVIEW_FIX_PROGRESS.md` | Closed Batch 1–66 campaign; open items lifted to `DEFERRED_WORK.md`. |
| `archive/SESSION_2026-04-08_RESEARCH_REPORT.md` | Self-declared non-living; superseded by the trackers. |
| `archive/` March-2026 snapshots (11 docs: `COMPREHENSIVE_CODE_REVIEW`, `RESEARCH_FINDINGS`, `RENDERER_CONTEXT_REFACTOR`, `PICKING_ANALYSIS`, `SORTING_ARCHITECTURE_ANALYSIS`, `SORTING_IMPLEMENTATION_PLAN`, `SORTING_REVIEW_AND_TECH_DEBT`, `SCENE_DECOMPOSITION_PLAN`, `MIGRATION_STATUS_ARCHIVE`, `ES6_MODERNIZATION_BACKLOG`, `UPSTREAM_ISSUES_AND_TECH_DEBT`) | The live trackers: `WEBGPU_MIGRATION_STATUS.md`, `ES6_MODERNIZATION_STATUS.md`, `DEFERRED_WORK.md`, `FEATURE_INVENTORY.md`, `WEBGPU_DEBUGGING_LOG.md`; picking/sorting findings also summarized in `ISSUES_AND_FIXED_BUGS.md`. |
| `archive/deprecated/` | Older deprecated docs + archived source snapshots (pre-existing). |
