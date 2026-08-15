# CAMPAIGN_STATE — tracked mirror of the CLAUDE.md orientation block

**What this file is.** `CLAUDE.md` at the repo root is gitignored (`.gitignore:6`) and has
zero git history, so the orientation layer it carries — the Active Remediation Campaign
block, the GitHub quiet-hours HARD rule, and the branch-transparency rule — was recoverable
from **no tracked file**. The 2026-08-09 handover audit
([`HANDOVER_AUDIT_2026-08-09.md`](HANDOVER_AUDIT_2026-08-09.md), FIX 1) recorded that as one
of three takeover blockers: a successor working from a clone, from Cline, or from a fresh
session could not reconstruct the campaign map or the quiet-hours rule at all.

This document is the **tracked mirror** of those three blocks. `CLAUDE.md` remains the
authoritative local rules file and points at this file; where the two disagree, `CLAUDE.md`
wins for rules and the **campaign queue documents win for status** (see
[`ORCHESTRATION_HANDBOOK.md`](ORCHESTRATION_HANDBOOK.md)).

**How to keep it honest.** Any edit to the Active Remediation Campaign block, the quiet-hours
rule, or the branch-transparency rule in `CLAUDE.md` must be mirrored here in the same batch.
Corrections are made in place with dated stamps, preserving the original text.

**Reading order for a successor:** [`ORCHESTRATION_HANDBOOK.md`](ORCHESTRATION_HANDBOOK.md)
first (operating procedure), then this file (campaign map + hard rules), then
[`README.md`](README.md) (doc index), then the open queues' `## 0. RESUME HERE` sections.

---

## 1. Active Remediation Campaign (2026-07-23; block re-verified 2026-08-06 at Batch 836)

_Mirrored verbatim from `CLAUDE.md`. Three corrections applied 2026-08-09 per handover-audit
FIX 4 are marked inline with `⚠ CORRECTED 2026-08-09`; the original text is preserved._

- **Close-out mode (2026-08-07, Batch 899; dispatch view superseded 2026-08-11):** [CLOSEOUT_PLAN_2026-08-07.md](CLOSEOUT_PLAN_2026-08-07.md) is the historical C11/C12/C13/C15-gsplat grouping. [`CAMPAIGN_PORTFOLIO_QUEUE.md`](CAMPAIGN_PORTFOLIO_QUEUE.md) is the current feature-priority dispatch view for C11–C18 and the split C15 lanes. Both are grouping only — campaign queue docs remain the sole status authorities. Critical path: C12 completion (R1/R4); `C13-41` / C12-29 S3 and S4 are COMPLETE / EDGE VERIFIED as of 2026-08-12, so the remaining C12 blockers are S5 and the recorded exit tail.
- [Cloud Architecture Audit](CLOUD_ARCHITECTURE_AUDIT_2026-07-23.md) is the evidence authority for the planetary-cloud correctness, temporal, weather, quality, and performance findings confirmed at Batch 731.
- [Campaign 13 Queue](QUEUE_2026-07-23_CAMPAIGN13.md) was explicitly launched by the maintainer on 2026-07-23 and is a **live execution queue**. Update its live status ledger whenever a task completes, pauses while execution moves on, blocks, or is deferred. **Executor change 2026-07-23:** Sol 5.6 ran out of capacity; the orchestrator took over its in-flight C13-37 tree. Sol's Batches 732-736 were review-accepted; the takeover brief is [SOL_C13_REVIEW_2026-07-23.md](SOL_C13_REVIEW_2026-07-23.md). ~~Do NOT run the new cloud probes until their watchdogs land.~~ **⚠ CORRECTED 2026-08-09 (FIX 4): this clause is DISCHARGED and is deleted from the live rule set.** The cloud probes have run continuously since — `C13-41`'s probe alone has six recorded Edge runs (Batches 908–931) — and probe watchdogs are now a fleet-wide contract with a ratcheted allowlist landed at Batch 928 (`5aec156b93`). The handover audit attributes the original discharge to Batch 743 (`47a940eed9`, the Sol-handoff batch).
- [Campaign 11 Queue](QUEUE_2026-07-18_CAMPAIGN11.md) is **open; its targeted W1 performance lane resumed 2026-07-28** while the broader body remains governed by its recorded wave order. `C11-180` is PARTIAL (WebGL async shader lifecycle + bounded final-program/fog-companion scheduling landed; broader structural first-use variants remain), and `C11-181` is LANDED+VERIFIED but NOT COMPLETE (globe shader replacement/reference correctness; the queue row is the authority and keeps it open). **Certification is HELD by maintainer ruling 2026-07-23** — the W2–W8 body executes before any C11-137 certification. Cloud/weather rows live in Campaign 13; `C11-79/80/115-impl/160/161/175/176a/b/c` transferred to Campaign 12 (LD-1/LD-2), IDs retained as aliases.
- [Campaign 12 Queue](QUEUE_2026-07-19_CAMPAIGN12.md) (celestial appearance) was **LAUNCHED 2026-07-23** (LD-1/LD-2 answered, §6g). All three campaigns run under the **orchestrator pattern**: the orchestrator dispatches model-matched Opus/Fable subagents, reviews every diff, and lands commits; workers never commit.
- **Campaign numbering — do not renumber, and do not read either of these as launched.** **Campaign 14 = Dynamic Ocean & Wind** owns that identity by ratified plan ([OCEAN_DYNAMICS_PLAN_2026-07-24.md](OCEAN_DYNAMICS_PLAN_2026-07-24.md)); maintainer ruling **O5** originally held it until Campaigns 11, 12 **and** 13 were all done — **SUPERSEDED by ruling R1 (2026-08-06, `DEFERRED_WORK.md` RULING-2026-08-06): C14 unblocks on a pragmatic bar of C12 complete + C13 Gate B green. Gate B CLOSED at Batch 866 (2026-08-07), so the remaining C14 bar is C12 completion only.** C11-137 certification remains HELD and C11/C13 remain honestly open (R2). **Campaign 15 = Aurora + Space Weather** ([QUEUE_2026-08-02_CAMPAIGN15.md](QUEUE_2026-08-02_CAMPAIGN15.md), authored 2026-08-02 at Batch 819) is **PLANNED / RESEARCH-VERIFIED / AURORA IMPLEMENTATION NOT STARTED** — `C15-00` is complete (R4 spot-check executed Batch 856), `C15-01..08` are pending and held until C12 closes (R4), and the queue is explicitly **not a maintainer launch ruling** for the aurora rows. The queue document also carries the **GSPLAT track (§6, ruling R6, 2026-08-06)** — Gaussian-splats-on-WebGPU, a separate maintainer-queued lane NOT under the R4 hold; ~~`C15-G0` scoping complete (Batch 863), `C15-G1..G8` authored.~~ **⚠ CORRECTED 2026-08-09 (FIX 4): `C15-G0` scoping complete (Batch 863); `C15-G1`–`C15-G5` LANDED (Batches 868–895); `C15-G6` PARTIAL (mechanism fixed at Batch 888, its written multi-frustum exit gate has not executed); `C15-G7`/`C15-G8` PENDING.** The Phase-F seed stays `EPIC-AURORA-SPACE-WEATHER` in `DEFERRED_WORK.md`.
- **Campaign 16 = Comment Remediation & Attribution** ([QUEUE_2026-08-10_CAMPAIGN16.md](QUEUE_2026-08-10_CAMPAIGN16.md), **LAUNCHED by maintainer directive 2026-08-10**): audit baseline 6,450 violation blocks / 556 files; all comments in `packages/*/Source` must become seamless with upstream (no batch/campaign/tracker IDs — those live in commit messages and `migration_doc/**` only), JSDoc-clean for `npm run build-docs`, with derived code attributed and license-reviewed. The celestial-light-transport epic renumbers to **proposed C17**. **Effective immediately for ALL new code:** write comments to the C16 standard; the C16-00 lint guard will enforce it.
- [Fable 5 Progress and Recommended-Action Audit](FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md) remains the current fork-performance authority outside the cloud campaign.
- Performance work must not remove, default-disable, bypass, or visually degrade a feature merely to improve a metric. Safety containment is correctness work, not a performance win.
- Idle-soak FPS is invalid under request-render mode. Use the Node/Edge moving-altitude campaign in [DEBUGGING_GUIDE.md](DEBUGGING_GUIDE.md#canonical-moving-altitude-campaign-2026-07-14), with clean and API-instrumented lanes kept separate. Do not substitute Python tooling.

### 1a. Standing consequence of `R-2026-08-10-1` (appended 2026-08-09, FIX 4)

Ruling [`R-2026-08-10-1`](MAINTAINER_RULINGS_2026-08-10.md) chose the **maximal C12 exit
gate**: C12 stays open until every `C12-29` slice lands, **including S3** (clouds + IBL
eclipse response), which is canonically owned by `C13-41`. Two consequences bind the
campaign map above:

1. **C14 remains blocked on C12 completion.** `C13-41` / C12-29 S3 is now
   COMPLETE / EDGE VERIFIED and no longer contributes an open dependency.
2. `C12-29` S4 is COMPLETE / EDGE VERIFIED. S5 verification (umbra vs. NASA
   shapefiles) is the remaining active C12-29 critical-path queue work, not a
   deferral.

The documented fallback (Option A — narrow the gate to S1/S2/S4/S6 and transfer S3 formally
to C13-41) is preserved in the ruling document with its revisit trigger.

---

## 2. GitHub Quiet Hours — HARD RULE (maintainer, 2026-08)

_Mirrored verbatim from `CLAUDE.md`. This rule existed in no tracked file before 2026-08-09._

On WEEKDAYS between 07:00 and 19:00 US Eastern: **no `git commit`, no
`git push`, no visible GitHub activity of any kind.** Commits carry visible
timestamps even if pushed later, so do not commit during the window either —
hold work as uncommitted worktree state / exported patches and land in
batches after 19:00 ET. Weekends and 19:00–07:00 are unrestricted. Check
`date` before every commit/push; the machine clock is authoritative.
Local-only work (builds, probes, workers, edits) is unaffected.

> **History note (handover audit FIX 37, 2026-08-09):** in-window weekday commits exist
> prior to the Batch-977 attestation. They are **not precedent** — the rule as written
> governs. Whether a waiver existed is an open maintainer ask.

## 3. Branch Transparency — CRITICAL

_Mirrored verbatim from `CLAUDE.md`._

The user's working model is "trunk-only — no long-lived branches." Surface branch state proactively whenever a work package is being scoped, started, paused, or closed. Do not let safety branches, worktree branches, or agent branches accumulate silently.

**Always tell the user, unprompted, when:**

1. **Starting a work package** — list any pre-existing local or origin branches besides `main` ("Heads-up: `pre-upstream-merge`, `feature/foo` are still around from prior work — want me to audit and clean before starting?"). Run `git branch -a` to check; do not assume.
2. **Creating a new branch or worktree** — name it, say why, and commit upfront to a deletion plan ("I'll create `safety-pre-batch-69-2026-04-26` as a rollback ref; I'll delete it after the batch lands on main and verifies green").
3. **A sub-agent spawns a worktree branch** — surface the branch name in your reply, even if the agent ran in the background.
4. **Finishing a work package** — re-list all branches and explicitly ask whether to delete the now-redundant safety/feature/worktree branches before declaring the package done.
5. **At the start of every new conversation** if `git branch -a` shows anything besides `main` (and its remote tracker), open with a one-liner inventory.

Use git-stash usage conventions when labeling refs (timestamped, descriptive).

> **Mirror note (2026-08-09):** the `CLAUDE.md` original links this last sentence to a
> session-local memory file outside the repository, which no successor can read. The
> convention it points at is restated in
> [`ORCHESTRATION_HANDBOOK.md`](ORCHESTRATION_HANDBOOK.md) §3: never bare `git stash`;
> always `git stash push -m "YYYY-MM-DD_HH:MM_claude_<reason>"`; prefer
> `git show HEAD:<file>` or a worktree over stashing for comparisons; never drop unlabeled
> stashes without maintainer confirmation.

### 3a. Declared out-of-repo worktrees and evidence paths (added 2026-08-14, fix SOL-12)

_Added by the fix queue of [`SOL_WEEK_AUDIT_2026-08-14.md`](SOL_WEEK_AUDIT_2026-08-14.md).
Rule 2 of §3 requires every worktree to be surfaced when it is created. Three sibling
worktrees and one out-of-repo evidence library accumulated across the 2026-08-11 → 08-14
range **without ever being declared in a tracked file**, so a successor reading only this
repository would not know they exist — and would not know that the load-bearing visual
evidence for C12-29 S5, C12-37 and C13-41 lives outside it. Declaring them here is a
statement of fact, **not** an approval to keep them; §3 rule 4 still requires an explicit
delete-or-keep decision at the end of the work package._

| Path | Kind | State at 2026-08-14 | Disposition |
| --- | --- | --- | --- |
| `F:\Dev\GH\cesium-webgpu` | primary worktree | branch `main` | keep |
| `F:\Dev\GH\cesium-webgpu-cert-s5-3cbb82885fc7` | git worktree, **detached** at `034c7f74d0` | The clean certification tree. Its directory name pins `3cbb82885f` but its HEAD was advanced to `034c7f74d0`; the name is stale, the HEAD is authoritative. Reported tracked-clean at the pause. | Decision owed. Keep only while the C12 certification tail is live. |
| `F:\Dev\GH\cesium-webgpu-evidence` | git worktree, **detached** at `f38acf65f6` | The evidence-publication tree. Every C12-37 and early-S5 publication in the library records `worktreeLabel: "cesium-webgpu-evidence"` and `dirty: true` — see finding S18: **all 30 banked publications were produced from dirty worktrees**, so "landing-equivalent" rests entirely on per-file source hashes, which are enforced by nothing. | Decision owed. |
| `F:\Dev\GH\cesium-webgpu-evidence-v9` | git worktree, **detached** at `99abefdc26` | The later S5 evidence tree (custom-ellipsoid v9 era). | Decision owed. |
| `F:\Dev\GH\cesium-webgpu-visual-evidence` | **not a git repository** — an append-only content-addressed library (`runs/`, `objects/`, `legacy/`, `.claims/`, `.incoming/`) | Holds the immutable publications the queues cite by manifest SHA-256: 15 C12-29 S5 runs (1 PASS), 4 C12-37 runs (3 FAIL / 1 PASS), the C13-41 and C11-13 runs. **It is outside version control entirely.** | Keep. It is load-bearing evidence; back it up rather than deleting it, and note that nothing in git guarantees its contents. |
| `F:\Dev\GH\cesium-webgpu-backups` | plain directory, not a worktree | Pre-existing. | Out of scope of this stamp. |
| `.claude/worktrees/agent-*` | three locked agent worktrees on `worktree-agent-*` branches | Harness-created, inside the repo and gitignored. | Transient; they should not outlive their agents. |

Also undeclared and worth stating: the exported landing patches and per-run server logs
under `/.tmp/` (now gitignored, fix SOL-12) are **not** a backup of anything — they
duplicate commits already on `main` and will drift.

⚠ Open from the same audit and **not** resolved by this stamp: the 2026-08-02 stash
decision, and maintainer ask **R-d** — the disposition of the range's quiet-hours,
co-author-trailer and batch-numbering breaches (24/98 commits landed inside the weekday
window, 0/98 carry the trailer, and numbering stopped after Batch 1027). The compliance
mechanism was this very file, in-repo and current throughout.

---

## 4. Close-out mode pointer

[`CLOSEOUT_PLAN_2026-08-07.md`](CLOSEOUT_PLAN_2026-08-07.md) is the dispatch schedule for
closing C11/C12/C13/C15-gsplat. It is a **snapshot of 2026-08-07 and substantially
executed** — read its header banner first, and on any status conflict the queue row wins.
The critical path it records is C12 completion, which under `R-2026-08-10-1` now includes
`C13-41`.
