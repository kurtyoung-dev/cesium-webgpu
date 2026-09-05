# CAMPAIGN_STATE — the campaign-status authority

**Authority as of 2026-09-02; supersedes the CLAUDE.md campaign section.** Ruled by
`R-2026-09-02-14` (`MAINTAINER_RULINGS_2026-09-02.md`): CLAUDE.md's "Active Remediation
Campaign" block reduces to a pointer at this file, and this tracked document — not the
gitignored one — is the **sole campaign-status authority** from here on (§1 below). This file
keeps its other original role too: `CLAUDE.md` is gitignored with no git history
(`.gitignore:6`), so its GitHub-quiet-hours and branch-transparency HARD rules are mirrored here
as they were by the 2026-08-09 handover audit (`HANDOVER_AUDIT_2026-08-09.md` FIX 1) — those two
rules are unaffected by this wave's ruling and stay in §2/§3, now fully restated (not merely
mirrored) in [`ORCHESTRATION_HANDBOOK.md`](ORCHESTRATION_HANDBOOK.md) §3 as well; on any
disagreement between the two, the fuller, more recently touched copy wins and the other is
stale.

**Precedence for §1, stated once because every block below relies on it:** a campaign's own
queue document (`QUEUE_*_CAMPAIGN*.md`) is the **row-level** authority — task status,
acceptance, dependencies. This file is the **campaign-level** authority — launched-or-not,
critical path, holds, governing ruling. Dispatch/priority boards
([`CAMPAIGN_PORTFOLIO_QUEUE.md`](CAMPAIGN_PORTFOLIO_QUEUE.md),
[`QUEUE_2026-08-29_RESEARCH_DISPATCH.md`](QUEUE_2026-08-29_RESEARCH_DISPATCH.md)) are sequencing
views only, refreshed on their own cadence and known to drift (see the corrections appendix). On
any conflict: queue row wins over this file, this file wins over a dispatch board. Above all of
them: a maintainer ruling in `MAINTAINER_RULINGS_*.md` outranks this file on a live dispute
(`DEFERRED_WORK.md:8872` — "the precedence is: maintainer rulings, then queue rows, then
CLAUDE.md/`CAMPAIGN_STATE.md`, then this file").

**Portfolio shape:** eight reserved campaign identities, C11–C18, one of which (C15) contains two
independently governed lanes (Aurora, GSPLAT). C14 and C15-Aurora are held; C17 is proposed and
unlaunched; the rest are executing or closing out (`CAMPAIGN_PORTFOLIO_QUEUE.md` §0).
[`CLOSEOUT_PLAN_2026-08-07.md`](CLOSEOUT_PLAN_2026-08-07.md) is that grouping's superseded
predecessor — a 2026-08-07 snapshot, substantially executed, kept only for history; on any status
conflict `CAMPAIGN_PORTFOLIO_QUEUE.md` and the row-level queues win.

---

## 1. Campaign status

### C11 — Parity, correctness-reds, and scale architecture

**Launched.** Open; governed by its own recorded wave order (`QUEUE_2026-07-18_CAMPAIGN11.md`).
**Critical path:** the `C11-137` C8-upstream-contract certification gate, ratified as the
campaign's dead-last exit gate — the deterministic focused/unit lane is the close bar, the full
real-scene suite is a recorded follow-up, not a close-blocker (queue §"EXIT GATE — `C11-137`").
**Hold:** `C11-137` certification is HELD by maintainer ruling (2026-07-23) until the W2–W8 body
executes. `C11-180` (WebGL async shader lifecycle) is PARTIAL — core + bounded fog-companion
scheduling landed, broader structural first-use variants remain (queue row `C11-180`). `C11-181`
(globe shader variant eviction/reference correctness) is **COMPLETE** — administrative close
2026-08-09, close authority `DEFERRED_WORK.md`, landed Batch 1063 `21c9489185`, 2026-08-20 (queue
row `C11-181`, line 2123) — see the corrections appendix; the prior CLAUDE.md text called this row
open and was wrong. The C11-163 CELESTIAL-WATER-REFLECTION epic is ARMED (`R-2026-08-28-10`), its
4 sub-decisions resolved (`R-2026-08-28-11`); slice 1 landed Batch 1271 (2026-08-29); slices 2/3
(star splat, S5a shadow map) remain open. Cloud/weather rows live in Campaign 13;
`C11-79/80/115-impl/160/161/175/176a/b/c` transferred to Campaign 12, IDs retained as aliases.

### C12 — Celestial appearance

**Launched** 2026-07-23 (`QUEUE_2026-07-19_CAMPAIGN12.md`). **Exit gate is MAXIMAL**
(`R-2026-08-10-1`): C12 stays open until every `C12-29` slice lands, including S3. **Critical
path:** `C12-29` S3 (canonically owned by `C13-41`, C13's queue) plus S5's final seven-lane
certification matrix. S3 was recorded COMPLETE/EDGE-VERIFIED 2026-08-12, then **VACATED** —
`R-2026-08-14-1` restored its `shadowContrastInvariant`/`refreshCostMeasured` gates and
`R-2026-08-17-7` flipped its machine-readable state `closed` → `reopened` (queue row `C12-29`,
"S3 CLOSURE VACATED"). **Latest ruling** `R-2026-09-02-5`: fund the S3 exit-condition-2
exposure-sweep discriminator first (Sonnet instrument + Opus review, then Edge); Option C of
`R-2026-08-10-1` (re-file S3/S4 as C13 rows, close C12, unblock C14, release the R4 aurora hold)
is the fallback if that sweep stays red. S4 is COMPLETE/EDGE VERIFIED (2026-08-12). `C12-33`
(Moon mip/LOD) is certified (20 Edge runs, 2026-08-24) with two residual maintainer debts (a
banking-schema gap, an unsigned countersign) — not machine work. **G1** (skybox fade) stays RED
at close by ruling, carried to proposed-C17 as `CLT-D10` (`R-2026-08-21-14`). **G3** (star-asset
upgrade): `R-2026-09-02-7` answers the queue's open `Q-77` — chroma/dust criteria are unreachable
by any bundled variant, so G3's red is by construction; the 4096-px skybox tier ships as an
opt-in externally-fetched asset via the resolution-policy seam, gated on a licence determination,
not installed as a bundled asset. Gates M-06..M-10 close under that ruling.

### C13 — Planetary volumetric clouds, RTE, weather realism

**Launched / executing** since 2026-07-23 (`QUEUE_2026-07-23_CAMPAIGN13.md`). Gate B (planetary
correctness) CLOSED 2026-08-07 (Batch 866). Gates A, C, D remain open (`DEFERRED_WORK.md`
"RULING-2026-08-06", ruling R2). **Critical path:** `C13-41` (C12-29 S3's canonical owner) —
REOPENED by `R-2026-08-14-1`; its restored exit condition is the SOL-4 banked refresh cost plus
the 1.0496 `shadowContrastInvariant` mechanism (queue row `C13-41`). This is also C14's
transitive blocker (see C14 below). Execution stays orchestrator-only: `R-2026-08-24-3` narrows,
without replacing, the 2026-07-24 Option-B ruling — Codex Sol may build bounded C13
instrument/harness work under an Opus lead with separate Opus review; engine-semantic changes
stay Opus-authored.

### C14 — Dynamic ocean & wind

**Not launched.** Ratified identity, ratified plan (`OCEAN_DYNAMICS_PLAN_2026-07-24.md`).
**Hold:** `R1` (`DEFERRED_WORK.md` "RULING-2026-08-06") binds the O5 "done" bar pragmatically to
C12 complete + C13 Gate B green; Gate B closed at Batch 866, so the sole remaining bar is **C12
completion** — which is transitively `C13-41` (see C12/C13 above). C11-137 certification and the
rest of C11/C13 do **not** gate C14 (`R2`).

### C15 — Aurora + Space Weather (two independently governed lanes)

**Aurora (`C15-01..08`): planned, research-verified, implementation not started.** `C15-00` is
complete (R4 endpoint spot-check executed 2026-08-06, queue §2a). `C15-01..08` are **HELD** by
`R4` until C12 closes; the queue document is explicitly not a launch ruling for these rows
(`QUEUE_2026-08-02_CAMPAIGN15.md` status block).

**GSPLAT (`C15-G0..G8`, §6, ruling R6, 2026-08-06): ACTIVE, not under the R4 hold.** `G0` scoping
COMPLETE (Batch 863); `G1`–`G5` LANDED (Batches 868–895: harness → scene-logic extraction → first
real WebGPU splat pixels → WASM radix sort → spherical harmonics); `G6` PARTIAL (mechanism fixed
Batch 888/889, the row's own written multi-frustum exit gate has not executed); `G7` **ran for the
first time 2026-09-02** (Éowyn, first Edge job of the wave, `R-2026-09-02-1`/`-25`) —
STRUCTURAL/exit 3, two WebGPU reds filed as follow-on rows `C15-G7a`/`C15-G7b` (queue row
`C15-G7`); `G8` (terminal parity gate) PENDING, blocked on `G6`+`G7` closing. `G9` (tower
frame-variance mechanism) is **CLOSED as NOT REPRODUCED** (`R-2026-08-24-5`) — its harness stays
armed and unblocks G8's tower leg.

### C16 — Comment remediation & attribution

**Launched** by maintainer directive 2026-08-10 (`QUEUE_2026-08-10_CAMPAIGN16.md`). Audit
baseline: 6,450 violation blocks / 556 files (workflow `wf_c6df8ba5-f04`, HISTORICAL). Scope:
`packages/engine/Source`, `packages/widgets/Source` — comments become seamless with upstream (no
batch/campaign/tracker IDs; those live in commit messages and `migration_doc/**` only),
JSDoc-clean. **Shards `C16-09`..`C16-12` are all PARTIAL**, each with landed sub-shards and a
shrinking tail (queue ledger has per-shard detail). The three-way file hold on
`WebGPUPointCloudRenderer.ts`/`WebGPUBufferPointRenderer.ts` was released 2026-09-02
(`R-2026-09-02-4`); a same-day sub-shard took both to zero. **`C16-20`** (final gate) is PENDING
but certifiable in-repo from checked-in instruments (census=0, string-literal scan, build-docs,
this file's own update — see queue row `C16-20` for the full precondition list, which names a
CLAUDE.md/CAMPAIGN_STATE.md/README update as one of its own legs — this document discharges
that leg for C16-20). `C16-R1` (embedded-WGSL/string-literal blind spot) and `C16-R2` (`FORK-NN`
id class) are both ruled and landed.

### C17 — Celestial Light Transport (proposed)

**Not launched.** Holds the C17 identity by ruling (`R-2026-08-10-7`, "CLT epic renumbers to
proposed C17"); plan is `CELESTIAL_LIGHT_TRANSPORT_PLAN_2026-08-07.md`. Carries C12's G1
shell-extent question as `CLT-D10` (see C12 above). `CLT-B3` is a locally complete, authorized
bug-fix unit with landing + terminator-specific browser acceptance owed, tracked independently
of the full epic's launch state.

### C18 — Voxel, point cloud & splat modernization

**Launched** by maintainer directive 2026-08-09 (`QUEUE_2026-08-09_CAMPAIGN18.md`). Four waves:
**V** (verification honesty) — `V1` DONE, `V2` IN FLIGHT (browser closure open), `V3` PENDING.
**P** (point-cloud correctness) — `P1`/`P3`/`P4` PENDING, `P2`/`P5` IN FLIGHT. **A** (additive
adoption) — `A1..A6` PENDING, self-contained/dispatchable now. **S** (splat rows) — GATED
post-`C15-G8` (queue §4, ownership row); the sole exception is `C18-S0` (gsplat licence vetting),
DONE and ungated. C18 owns no C11/C15 row (`C11-13`, `C11-86`, `C11-100`, `C11-108`, the C11 W7
voxel cluster, and FORK-41 stay tracked where they are — queue §5).

### Wave DX — organisation, decomposition, tooling (not a numbered campaign)

Maintainer-directed wave inside
[`QUEUE_2026-08-29_RESEARCH_DISPATCH.md`](QUEUE_2026-08-29_RESEARCH_DISPATCH.md) (`DX-01`..
`DX-30`). Scope: probe-fleet runtime consolidation, decomposition of the eleven >1,000-line
WebGPU files, spec-home assignment, anti-re-accretion tooling, and this doc-truth sweep
(`DX-22`/`DX-23`/`DX-24`). Dispatch order (queue §"Dispatch order"): `DX-19` → `DX-20` → `DX-14`
→ `DX-01` → `DX-12` → `DX-13` → `DX-02` → `DX-06` → `DX-16..18` → `DX-07..09` → `DX-03/04` →
`DX-10` → `DX-21` → **`DX-22`, `DX-23`, `DX-24`** → `DX-27` → `DX-26` → `DX-25`. `DX-19`/`DX-20`
(branch and sibling-repo salvage) are DONE (Batches 1362/1363/1365) and are the current authority
for branch/worktree/sibling-repo state — see §3a below, which this wave's audit superseded.

### Research dispatch queue — design-model perf, Earth-at-Night, meshlets

[`QUEUE_2026-08-29_RESEARCH_DISPATCH.md`](QUEUE_2026-08-29_RESEARCH_DISPATCH.md) is a **dispatch
order, not a status authority** (its own §"Authority"). The live status authority for every `Q-`
id is [`FIX_QUEUE_2026-08-27_AUDIT_FINDINGS.md`](FIX_QUEUE_2026-08-27_AUDIT_FINDINGS.md); the
campaign rows named above stay owned by their own queues. The meshlet/mesh-shading track
(`MS-00..26`) is **HELD** by ratified gate M6 until `C11-168`'s dense-tileset lane is satisfied —
not yet, per `QUEUE_2026-07-18_CAMPAIGN11.md` row `C11-168` ("W1 — PARTIAL / VALID CAUSAL
DEFICIT, ROOT CAUSE OPEN") — and its campaign placement (a Phase-8b wave vs. new Campaign 19 vs.
a C18 wave) awaits maintainer gate **M-16**; nothing about it is launched. Wave 1 of this queue (17 ruling-free/measurement-first rows) is mid-execution; its closure is the manual three-step permitted by `R-2026-09-02-3`. **That three-step ran 2026-09-03/04 (Éowyn, job 2 item 10, banked at `Tools/visual-regression/output/wave-end/2026-09-02/`) and NO STEP WAS GREEN, so the wave is NOT CLOSED under `R-2026-08-29-2`:** (a) variant smoke exit 1 — all three variant bundles absent from the served clone, nothing loaded; (b) the Sandcastle2 sweep exit 1 on both renderers — **0 of 338 certified either side**, because the ungenerated editor typings (`/packages/engine/index.d.ts`, `/packages/widgets/index.d.ts`) 404 on the app origin and the console-error gate fails every demo on that one 404; (c) capture-and-diff exit 1, summary FAIL (3 PASS / 1 FAIL / 6 NON_CERTIFYING), **though its cross-backend parity leg passed 10/10 at max 1.52 %** with `promotionPerformed: false`. The gate re-runs on a tree built with `npx gulp buildAllVariants` **and** the TypeScript-definitions step; until it does, the wave stays open. Two real WebGPU faults surfaced under step (b) and are filed as their own rows (`elevation-band-material`, `frustum-dev`); the baseline incompleteness under step (c) is filed separately. **No row's status is changed by this note.**

**Wave-end gate — batches 1379–1404 (2026-09-04, Éowyn job 3).** Under the same rule
(`R-2026-08-29-2`), distinct from the DX Wave-1 gate above: the wave that closed with Batch 1404
(1379–1404) had its wave-end gate run 2026-09-04 (Éowyn, standing Edge executor, `R-2026-09-02-1`,
job 3), on the pre-merge tree `40341305f4` (Batch 1407), served-tree preflight PASS (disk md5
matches :8080/:8081/:8082/:8094 before and after every leg). Evidence directory:
`Tools/visual-regression/output/wave-end/2026-09-04/` (`SUMMARY.md` + one `README.txt` per leg).
Per step: **(a) variant smoke — GREEN** — `node Tools/variant-smoke-test.mjs` exit 0; dual /
webgl-only / webgpu-only all PASS, 0 console errors each, a rendered frame each. **(b) Sandcastle2
sweep, both renderers — RED (engine)** — both exit 1; **WebGL 332/338 certified** (6 failed: 4
`rendererGate` + 2 external-CORS-only); **WebGPU 323/338 certified** (15 failed: 3 GPU
validation errors — `display-conditions-dev`, `elevation-band-material`, `frustum-dev` — + 11
`rendererGate` + 1 external-CORS-only); the 12 unique `rendererGate` ids are **not yet classified**
harness-vs-engine — `AR-888` owns that measurement, and Éowyn's own leg verdict of "RED (engine)"
above is recorded as the executor's, not ratified here. Zero typings-404s on either renderer (the
2026-09-03 served-tree blocker is resolved). **(c) capture-and-diff — RED (baseline provenance,
not a rendering regression)** — exit 1, summary NON_CERTIFYING (scenes PASS 4 / FAIL 0 /
NON_CERTIFYING 6); **cross-backend parity itself is 10/10 PASS at max 1.484 %**, WebGPU error gate
clean, and the `globe-default` uniform darkening this same gate reported at 91.32 % / 91.22 % on
the job-2 run above is **gone** on this tree (PASS at 0.055 % / 0.011 %, meanLum 101.801/101.736
vs baseline 101.811/101.738); no baseline was refreshed (`promotion.performed=false`). **Per the
ruling's own terms — the wave closes only if all three steps are GREEN — this wave does NOT
close: (a) is green, (b) and (c) are not.** No row's status is changed by this note.

**Architecture-review dispatch view (2026-09-03).**
[`QUEUE_2026-09-03_ARCHITECTURE_REVIEW.md`](QUEUE_2026-09-03_ARCHITECTURE_REVIEW.md) is the dispatch
view for the architecture review — the rows produced from
[`ARCHITECTURE_REVIEW_2026-09-02.md`](ARCHITECTURE_REVIEW_2026-09-02.md) after the 2026-09-03 lens
re-run (its §3 survey blocks, §4 reversals, unowned §3 items, landscape gaps G1–G8, maintainer
decisions, Éowyn measurement rows). **Status authority unchanged:** the campaign queues,
`DEFERRED_WORK.md` and `FIX_QUEUE_2026-08-27_AUDIT_FINDINGS.md` keep every id they own; the new
queue launches, rules, schedules and funds nothing, and its `AR-` ids are add-only.

**Wave P0-1 (Batches 1415–1428): COMPLETE.** All five dispatched rows — `AR-002`, `AR-751`,
`AR-831`/`AR-833`, `AR-832`/`AR-834`, `AR-009` — met their Edge acceptance across Éowyn jobs 6–8
(`Tools/visual-regression/output/wave-p0-1-edge-2026-09-05/`, `-job7/`, `-job8/`); `AR-751` and
`AR-831`/`AR-833` needed a round-2 engine fix and `AR-009` needed two probe-only fix rounds before
their own Edge legs measured green. Row-level detail (root causes, batch numbers, measured numbers)
lives in `QUEUE_2026-09-03_ARCHITECTURE_REVIEW.md`'s own rows, not restated here.

### Upstream sync — CesiumJS 1.145 (not a numbered campaign)

**LANDED.** The fork is synced to CesiumJS 1.145 at merge commit `ffb8161c08`, **Batch 1408**
(parents `40341305f4` fork / `488b114e16` `upstream/main`, merge-base `6d5d8b1f07`), landed
2026-09-04. Verification: **Éowyn job 4, FIT TO FAST-FORWARD** (evidence:
`Tools/visual-regression/output/sync-1145-verification-2026-09-04/`); leg 1b (Sandcastle2 sweep) and
leg 2 (draped-polyline width gate B) remain owed, tracked as `UPSTREAM-SYNC-1.145-06`/`-07` items,
neither a RED against the pre-merge baseline.
[`UPSTREAM_SYNC_PLAN_1.145_2026-09-04.md`](UPSTREAM_SYNC_PLAN_1.145_2026-09-04.md) is the plan that
was executed, built from one aborted dry-run merge (32 conflicted files, 79 conflict hunks, 164
paths); the real merge resolved 33 conflicted files / 80 hunks (one file drifted between the dry run
and the landing). Its rows are the `UPSTREAM-SYNC-1.145-*` family in
[`QUEUE_2026-08-29_RESEARCH_DISPATCH.md`](QUEUE_2026-08-29_RESEARCH_DISPATCH.md), which carry
status — this file does not, and neither does the plan. `-00` through `-05` and `-08` are LANDED,
`-06` is VERIFIED (partial, see above), `-07` (the WGSL parity twins the sync opens) is OPEN with one
item closed (Penlod, Batch 1410, reviewer Gundor). Two maintainer calls the sync surfaced are
recorded as `M-26`/`M-27` in that queue's §8: the CLA-check migration (status quo/Google Sheets kept
in the merge) and extending CLAUDE.md's `ShaderDefine` add-only rule to the WebGL globe shader-set
key. Two procedural facts the plan established and the merge confirmed: the sync is the **one
sanctioned merge commit** against the otherwise squash-only landing rule (verified: exactly two
parents), and CLAUDE.md's sync-procedure `--theirs` default was **wrong for 13 of the 24 conflicted
`.js` files**, which the fork had converted to ES6 classes while upstream is still prototype-based
(plan §3) — worked around in this merge by the new `PORT-INTO-CLASS` class and guarded going forward
by the ES6-shape guard (`-08`, landed); **amending the procedure itself is still open as `AR-D23`.**

### Standing principles that block work (not row-specific)

- **Performance work must not remove, default-disable, bypass, or visually degrade a feature to
  win a metric.** Safety containment is correctness work, not a performance win. (CLAUDE.md Core
  Principle 2/6 area; restated as `SR-1` in `QUEUE_2026-08-29_RESEARCH_DISPATCH.md` §0.2.)
- **Idle-soak FPS is invalid under request-render mode.** Use the Node/Edge moving-altitude
  campaign (`DEBUGGING_GUIDE.md#canonical-moving-altitude-campaign-2026-07-14`) with clean and
  API-instrumented lanes kept separate; do not substitute Python tooling. (Restated as `SR-9` in
  the same §0.2.)

### How to update

The campaign queue documents named above stay the **row-level** authorities. This file is the
**campaign-level** authority. **Update this file in the same commit as any change that flips a
campaign-level fact**: a launch, a hold lifted or applied, a critical-path handoff, or a new
campaign ratified. A row completing inside an already-described critical path does not require an
edit here; the critical path itself changing does.

### Appendix — corrections to the previous CLAUDE.md text

Checked against the authorities above on 2026-09-02:

1. **`C11-181` was described as open; it is COMPLETE.** CLAUDE.md read _"`C11-181` is
   LANDED+VERIFIED but NOT COMPLETE... the queue row is the authority and keeps it open."_ The
   named row (`QUEUE_2026-07-18_CAMPAIGN11.md:2123`) reads **COMPLETE**, administratively closed
   2026-08-09, close authority `DEFERRED_WORK.md` landed Batch 1063 (2026-08-20). This exact
   contradiction was independently found and recorded by a prior audit
   (`AUDIT_2026-08-27_SOL_WAVE_AND_PROJECT_SWEEP.md` §"G-4 — derived orientation docs contradict
   the status authorities") and was never corrected in the tracked mirror. Corrected in the C11
   block above.
2. **The GSPLAT track was described only as "authored" through `C15-G8`.** CLAUDE.md read
   _"`C15-G0` scoping complete (Batch 863), `C15-G1..G8` authored."_ At authoring time (Batch
   ~863) that was accurate; by 2026-09-02 five rows (`G1..G5`) are landed, `G6` is partial, `G7`
   has run once, and `G9` — a row CLAUDE.md never named — is closed. Corrected in the C15 block
   above.
3. **C12's exit-gate framing was accurate but has since gained a superseding ruling.** CLAUDE.md's
   "the remaining C12 blockers are the reopened `C13-41` row, S5 and the recorded exit tail" is
   still true, but `R-2026-09-02-5` (2026-09-02, same day as this refresh) names the concrete
   next step (the exposure-sweep discriminator) and a fallback (Option C). Not a contradiction —
   an update, folded into the C12 block above.
4. **G3's disposition changed from "work not done" to "red by design."** CLAUDE.md's C12 prose
   did not mention G3. `R-2026-09-02-7` answers the C12 queue's open `Q-77`: the chroma/dust
   criteria are unreachable by any bundled star-catalog asset, so G3's red is accepted by
   construction rather than owed further work. Folded into the C12 block above.

---

## 2. GitHub Quiet Hours — HARD RULE (maintainer, 2026-08)

_Mirrored verbatim from `CLAUDE.md`; unaffected by this wave's campaign-status ruling. Also fully
restated in `ORCHESTRATION_HANDBOOK.md` §3._

On WEEKDAYS between 07:00 and 19:00 US Eastern: **no `git commit`, no `git push`, no visible
GitHub activity of any kind.** Commits carry visible timestamps even if pushed later, so do not
commit during the window either — hold work as uncommitted worktree state / exported patches and
land in batches after 19:00 ET. Weekends and 19:00–07:00 are unrestricted. Check `date` before
every commit/push; the machine clock is authoritative. Local-only work (builds, probes, workers,
edits) is unaffected.

> **History note (handover audit FIX 37, 2026-08-09):** in-window weekday commits exist
> prior to the Batch-977 attestation. They are **not precedent** — the rule as written
> governs. Whether a waiver existed is an open maintainer ask.

> **Now enforced mechanically (ruling R-2026-08-14-4, `SOL-D4-HARDENING`):** `.husky/pre-push`
> refuses a push inside the window — Eastern offset resolved from the tz database, never
> hardcoded — and also enforces the `Batch NNNN:` prefix (monotonic), a non-empty body and the
> `Co-Authored-By:` trailer; merge / upstream-sync commits skip the three message rules.
> `npm run verify-landing` is the after-the-fact detector that makes a `--no-verify` bypass
> visible, and additionally checks each commit's own timestamps against the window. Rules and
> specs: `Tools/landing-rules.mjs`, `npm run test-landing-rules`;
> [`EXECUTOR_LANE_CHARTER_2026-08-14.md`](EXECUTOR_LANE_CHARTER_2026-08-14.md) §6.

## 3. Branch Transparency — CRITICAL

_Mirrored verbatim from `CLAUDE.md`; unaffected by this wave's campaign-status ruling. Also fully
restated in `ORCHESTRATION_HANDBOOK.md` §3._

The user's working model is "trunk-only — no long-lived branches." Surface branch state
proactively whenever a work package is being scoped, started, paused, or closed. Do not let safety
branches, worktree branches, or agent branches accumulate silently.

**Always tell the user, unprompted, when:**

1. **Starting a work package** — list any pre-existing local or origin branches besides `main`
   ("Heads-up: `pre-upstream-merge`, `feature/foo` are still around from prior work — want me to
   audit and clean before starting?"). Run `git branch -a` to check; do not assume.
2. **Creating a new branch or worktree** — name it, say why, and commit upfront to a deletion
   plan ("I'll create `safety-pre-batch-69-2026-04-26` as a rollback ref; I'll delete it after
   the batch lands on main and verifies green").
3. **A sub-agent spawns a worktree branch** — surface the branch name in your reply, even if the
   agent ran in the background.
4. **Finishing a work package** — re-list all branches and explicitly ask whether to delete the
   now-redundant safety/feature/worktree branches before declaring the package done.
5. **At the start of every new conversation** if `git branch -a` shows anything besides `main`
   (and its remote tracker), open with a one-liner inventory.

Use git-stash usage conventions when labeling refs (timestamped, descriptive).

> **Mirror note (2026-08-09):** the `CLAUDE.md` original links this last sentence to a
> session-local memory file outside the repository, which no successor can read. The
> convention it points at is restated in
> [`ORCHESTRATION_HANDBOOK.md`](ORCHESTRATION_HANDBOOK.md) §3: never bare `git stash`;
> always `git stash push -m "YYYY-MM-DD_HH:MM_claude_<reason>"`; prefer
> `git show HEAD:<file>` or a worktree over stashing for comparisons; never drop unlabeled
> stashes without maintainer confirmation.

### 3a. Declared out-of-repo worktrees and evidence paths

_Superseded 2026-09-02._ This subsection previously carried a hand-maintained table of worktrees
and clones dated 2026-08-14 (fix SOL-12). That table is now stale: Wave DX's `DX-19` (branch and
worktree salvage audit) and `DX-20` (sibling-repository census) ran 2026-09-02, retiring six
worktrees and nine branch heads and twenty of the twenty-two sibling repositories (~24.5 GB
reclaimed), and refreshed the live inventory into
[`branches/ACTIVE_WORKFLOW_WAVE_2026-08-29.md`](branches/ACTIVE_WORKFLOW_WAVE_2026-08-29.md) —
read that file for current branch/worktree/clone state, not this one. The append-only evidence
library `F:\Dev\GH\cesium-webgpu-visual-evidence` (not a git repository; holds immutable
publications the queues cite by manifest SHA-256) is unaffected by that sweep and stays kept.

⚠ **Still OPEN, and not answered by `DX-19`/`DX-20`** (those audited branches, worktrees and
sibling repositories, not this question): the 2026-08-02 stash decision, and maintainer ask
**R-d** — the disposition of the 2026-08-14 range's quiet-hours, co-author-trailer and
batch-numbering breaches (24/98 commits landed inside the weekday window, 0/98 carry the
trailer, numbering stopped after Batch 1027). See
[`SOL_WEEK_AUDIT_2026-08-14.md`](SOL_WEEK_AUDIT_2026-08-14.md) for the finding; no ruling has
closed it as of 2026-09-02.
