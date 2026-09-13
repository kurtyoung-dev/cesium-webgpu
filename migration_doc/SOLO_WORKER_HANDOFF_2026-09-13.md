# Solo-worker handoff — Campaign 13 v2 dispatch pack

**Date:** 2026-09-13. **Written for a worker who has never seen this repository**, and for the seat dispatching one.

**What this is.** The dispatch pack for the Campaign 13 v2 rows that a *solo* worker can execute — one worker, one clone, one row, one sitting, with no Opus lead standing over the work. It carries the five things no individual row can carry for itself: the dispatch procedure, the solo-safety rubric, the worker profiles, the roster with its worker assignments, and the sequencing between rows.

**Authority.** This page is a **procedure**, not a status authority. Row-level authority stays [`QUEUE_2026-07-23_CAMPAIGN13.md`](QUEUE_2026-07-23_CAMPAIGN13.md) §1; campaign-level authority stays [`CAMPAIGN_STATE.md`](CAMPAIGN_STATE.md); the row **text** — premises, deliverable, acceptance, stop conditions, forbidden actions, packet — is [`CAMPAIGN_13_V2_SOLO_ROWS_2026-09-12.md`](CAMPAIGN_13_V2_SOLO_ROWS_2026-09-12.md) §3, the companion this page ships beside. Where this page and the companion disagree about a row's **wording**, the companion governs. Where they disagree about **who** does the work or **when**, §2.3 below governs: those rulings are dated later and were made to settle the companion's open items.

**Measurement base.** `9f3723b0b32be87348553c3535893acdec37aeb3` (Batch 1481). Every number in every row is pinned to that commit. Figures measured on 2026-09-13 for this page say so and name what was read; every other figure is attributed to the pass that measured it.

**Landing marker.** This page lands with the companion and deliberately carries no landing-marker placeholder of its own — the companion's line 3 holds the only one in the patch, which is what the seat's whole-patch stamp step greps for (rubric addition 23).

## 0. What you are, and are not, allowed to do

You are a **solo lane**: one named worker, one named clone, one row, one sitting. "Solo" means no lead **during** the work. It does not mean no review — every deliverable still goes through an independent Opus station-3 review and the seat's landing gates (`R-2026-09-10-4`). You never land your own work.

Four rules bind every solo lane whatever the row says:

1. **The seat worktree `F:/Dev/GH/cesium-webgpu` is read-only to you.** You work only in your own clone (`R-2026-09-10-3`; [`WORKER_ISOLATION_AND_BRANCH_HANDOFF.md`](WORKER_ISOLATION_AND_BRANCH_HANDOFF.md) §8e). Never edit, build, serve or write git state there — not even to "check something quickly".
2. **No git writes.** Read-only git, plus `git add -N` when a new file must appear in the patch. No commit, push, checkout, stash, reset, clean, branch or merge, in any repository.
3. **Scratch space is one directory:** `<os.tmpdir()>/cesium-lane/<your lane name>/`, taken through `Tools/lib/lane-tmp.mjs` (`mkLaneTmp(prefix, { laneName })` or `withLaneTmp(prefix, fn)`, which removes the directory in a `finally`). Nothing scratch is ever written into the clone root, and the root is removed when you finish.
4. **Never improvise.** If a premise disagrees with the tree, that is a finding — report it. A row that cannot be executed as written is never a licence to redesign it.

**S8 — the STOP conditions, verbatim from the rubric:**

> **S8 — STOP conditions enumerated:** a premise disagrees with the tree; a spec goes red for a reason outside the row; a file outside the list must change; a value is missing. Stop and report; never improvise.

**S9 — the forbidden actions, verbatim:**

> **S9 — forbidden actions enumerated:** git writes; builds; rewriting any file over 100 lines; inventing values; touching `migration_doc/archive`; moving or repointing files; editing a file a live lane owns.

Your row's own **Stop** and **Forbidden** paragraphs are *additional* to these two. They never relax them.

Two engineering rules from `CLAUDE.md` bind you as hard as the rubric does: **Principle 11** — never rewrite a file over 100 lines; use targeted, text-anchored replacements. **Principle 12** — reach for `node` / `npx` first; a shell is for the cases where Node genuinely cannot do the job, and your row says so when that is true.

## 1. Dispatching a solo worker, step by step

1. **Clone, never a worktree.** From `F:/Dev/GH`: `git clone --no-hardlinks F:/Dev/GH/cesium-webgpu F:/Dev/GH/cesium-lane-<name>-<yyyymmdd>`. A worktree's `.git` is a file pointing back into the seat's `.git`, so a sandboxed worker cannot be given commit rights safely ([`WORKER_ISOLATION_AND_BRANCH_HANDOFF.md`](WORKER_ISOLATION_AND_BRANCH_HANDOFF.md) §8). Names are Tolkien characters, unique per lane, assigned **by the seat at dispatch**; the lane name is the lane's identity in the Agent description, the clone directory, the packet, the ledger and every status line.
2. **Provision it.** From the seat: `node Tools/provision-worker-clone.mjs <clone-path>` (exit 0 required — it refuses when a routed authority is unreachable, so a worker cannot be dispatched into a tree that cannot brief it). Then, **in the clone**, record `git log -1 --format='%h %s'` and `git status --short`. The provisioner leaves tracked governance files modified: today that is `migration_doc/MAINTAINER_RULINGS_2026-08-17.md`, CRLF-only, with an empty `git diff --numstat`. **Record those paths and exclude them from your patch.** (`DX-82` in §4 exists to remove this step.)
3. **Confirm the base.** `git rev-parse HEAD` must print `9f3723b0b32be87348553c3535893acdec37aeb3` (R-HANDOFF-5). If the seat's main has moved, the seat either pins the clone to that commit explicitly or re-derives the row's anchors before dispatch — you do not re-derive them yourself.
4. **Open the lane's ledger row at dispatch** (rubric addition 14): clone path, base commit, patch path, freeze md5, packet path, reviewer, verdict. A clone with no ledger row is not a lane.
5. **The brief is the row.** The row's eleven fields in companion §3 *are* the brief: worker, class/size, estimate, runner home, owned files, verified premises, deliverable, acceptance, stop, forbidden, packet. The dispatch message adds the worker-specific additions from §2.2 that apply, names the Sonnet fallback for a Gemini lane (R-HANDOFF-2), and says which words are byte-verbatim from a named `file:line` and which are the worker's own prose (addition 2).
6. **The channel depends on the worker.** **Sonnet** and **Astra** are dispatched as Agents with the model passed **explicitly** on every call — an omitted model silently inherits the seat's. **Gemini** is dispatched **only** through the `agy` CLI wrapper, as a **foreground** Bash call with the brief as `--print` input, never as an Agent ([`ORCHESTRATION_HANDBOOK.md`](ORCHESTRATION_HANDBOOK.md):72, [`WORKER_ISOLATION_AND_BRANCH_HANDOFF.md`](WORKER_ISOLATION_AND_BRANCH_HANDOFF.md):686, `R-2026-09-10-4` at [`MAINTAINER_RULINGS_2026-09-10.md`](MAINTAINER_RULINGS_2026-09-10.md):48). The wrapper script is the seat's own untracked scratch file — named by role here, deliberately not cited as a tracked path. Its flags are Go-style `--flag=value`; `GEMINI.md` is not auto-loaded in print mode, which is why the wrapper prepends the rules; it asserts HEAD/branches/stash unchanged and exits 4 otherwise.
7. **Take your scratch root first.** `mkLaneTmp("<row>-", { laneName: "<your lane name>" })` gives you `<os.tmpdir()>/cesium-lane/<lane>/<row>-XXXXXX`. Every inertness script, mutant copy and `.out` file a row asks for lives there. Where a row writes `<lane-tmp>` or `$LANE_TMP`, that is what it means.
8. **Run every acceptance command from the clone root, in the foreground.** An `ENOENT` on a repo-relative path is a wrong-cwd error, not a finding. **Never read an exit code through a pipe** — `$?` after `cmd | tail` is `tail`'s, and reports 0 over a genuinely failing guard; redirect to a file in your scratch root and `grep` the file. No background launches and no idle waits: every command runs in the foreground with its exit code read immediately (addition 5). Paste stdout **verbatim** into the packet, with the measured value beside the expected one.
9. **Freeze in the same sitting** (addition 15). Three artefacts, in `_lane-out/` inside your clone: the patch `git diff HEAD --binary --no-renames -- . ':(exclude)<each provisioner path>'` → `_lane-out/<lane>.patch`; its md5 → `_lane-out/FREEZE_<LANE>.md5` (two lines: `<md5>  _lane-out/<lane>.patch` and the base sha); the packet → `_lane-out/LANDING_PACKET_<LANE>.md`, with the headings your row's **Packet** paragraph names, in that order. A fix round that regenerates the patch **deletes or renames the superseded FREEZE file** (addition 16) — a stale one beside a current one is a landing hazard.
10. **Return under 200 words**, in this shape: row id; clone path and base sha; **each acceptance command with its exit code and measured-vs-expected value**; whether anything stopped you and at which stop condition; the three artefact paths plus the patch md5; the patch's path set (`git diff --name-only`), stated to match the row's owned files exactly; and what you could **not** do. Claims your packet does not evidence do not belong in the return message.
11. **The seat reviews and lands.** The lane never commits, never pushes, never merges, and never applies its own patch anywhere (§6).
12. **Close out.** Repatriate any visual evidence into the main repo's gitignored `Tools/visual-regression/output/`, preserving the probe's own subdirectory layout, **before** the clone is reset or deleted; then sweep your lane temp root (`Tools/lib/lane-tmp.mjs`, `Tools/temp-hygiene.mjs`). Evidence that dies with a clone reset is a handoff defect.

## 2. The rubric, its evidence-based additions, and the seat's rulings

### 2.1 The solo-safety rubric, S1–S10, verbatim

Transcribed byte-verbatim from the companion §1, 2026-09-13. A row is **SOLO-NOW** only if **all ten** hold.

- **S1 — class.** Tools, docs, fixtures, data or spec repair. **No engine-semantic change** under `packages/engine/Source` (Renderer, Shaders, Scene logic). A docstring-only edit in an engine file is allowed **only** when the exact replacement text is given in the row.
- **S2 — machine-checkable acceptance.** A command plus its expected output. No "measure and decide", no visual judgement.
- **S3 — every value supplied.** Nothing is left as "the row decides and records why". No `[unverified]` input on the critical path.
- **S4 — sole ownership.** Every file the row touches is named and owned by nobody else. Live lanes at dispatch: **L1 Durin** (harness readiness, probe runtime, `C13-42b`), **L2 Telchar** (fleet governance, runner homes, quarantine runner, fleet-contract remediation), **L6 Yavanna** (cloud instruments, fixtures, HDR rule, scenes), **L8 Eönwë** (queue ID table, gate rewrite, N34 API sweep, wave-end gate + `capture-and-diff` served base), **Oromë** (WebGPU offscreen pick-depth readback, sample-height, typings preflight for sandcastle-smoke). Deferred engine lanes: **L3 Ulmo** (`C13-N10` resolver), **L4 Manwë** (N21/N20/N11 WGSL), **L5 Ossë** (N22 weather field), **L7 Tulkas** (N06 cost). A `package.json` edit is allowed only as **one add-only script-line entry whose exact text is given**.
- **S5 — premises verified at the tree at dispatch time**, and quoted in the row.
- **S6 — proof needs no browser and no gulp build** (Gemini), or is a fully scripted browser run with the exact command (Astra only).
- **S7 — size S or M**, one packet, one sitting. Gemini: under ~45 minutes of wall time with no long idle waits — two Gemini runs died on transport errors on 2026-09-12.
- **S8 — STOP conditions enumerated:** a premise disagrees with the tree; a spec goes red for a reason outside the row; a file outside the list must change; a value is missing. Stop and report; never improvise.
- **S9 — forbidden actions enumerated:** git writes; builds; rewriting any file over 100 lines; inventing values; touching `migration_doc/archive`; moving or repointing files; editing a file a live lane owns.
- **S10 — review is unchanged.** Landing still goes through the seat's station-3 review and landing gates. "Solo" means no lead **during** the work, not no review.

**Classes.** **SOLO-NOW** — all ten hold. **SOLO-AFTER-TEMPLATE** — all ten hold once an Opus lead has done a first instance that can be copied. **NOT-SOLO** — state which S-item fails.

**Two clauses of that text are superseded and must be read with their corrections.** S4 names the live lanes as of 2026-09-12 (L1 Durin, L2 Telchar, L6 Yavanna, L8 Eönwë): all four landed as Batches 1478-1481 and their clones are archived, so S4 is discharged against the clones that exist at dispatch — §5.3 gives the measured list. S7 sets the Gemini ceiling at "under ~45 minutes": **R-HANDOFF-1** lowers it to 30 minutes of foreground work with no idle waits.

### 2.2 The twenty-three evidence-based additions, verbatim

Transcribed byte-verbatim from the companion §1.1, 2026-09-13, with one scope note: addition 23's closing parenthetical describes **the companion's** file, whose line 3 carries the placeholder. This page carries no placeholder token at all, so the whole-patch count the addition prescribes stays 1.

Gemini:

1. Every column of every row the lane writes is pre-filled by the brief, or the brief names the exact placeholder (`—`) and the note that explains it; the brief carries a column-by-column source table per deliverable. *Basis: `REVIEW_CALMACIL.md` F1/F5 — 74 rows of `Pri`/`Class` and nine `Parity: both` invented where the plan defined no such column.*
2. Each row states which words are **byte-verbatim from `<file>:<lines>`** and which are the worker's own prose. *Gemini's verbatim work measured 12/12 rulings and 65/65 rows exact; its free-text judgement produced F6 and F7.*
3. A documentation correction names its **rendered** form: strike or rewrite the false clause in visible text, then the dated marker. An HTML comment is never the whole correction; a patch whose only change at a correction site is a comment is a review blocker. *Basis: F2.*
4. Every filename the lane writes resolves to a tracked path or to a file landing in the same patch. Before freeze the lane greps its own patch for the scratchpad directory name and the untracked source filenames and reports the counts (expected 0). *Basis: F3 (twelve `Basis:` lines), F4 (two never-landed companions).*
5. **No background waits.** No long-running background commands, no idle "waiting for the task to complete" turns; every command runs in the foreground with its exit code read immediately. *Basis: both 2026-09-12 transport deaths occurred while "root agent idle; waiting for … background task(s)", with eight consecutive pause lines before the error.*
6. Cap one `agy` call at **30 minutes** and size the brief to fit. Longest successful run measured 35 min 51 s; split anything larger into two briefs with a checkpoint file between them.
7. **One transport failure ends the Gemini lane.** The brief names the Sonnet fallback worker and its handover-header brief path before dispatch. *Basis: the seat's own lesson — "fall back to Sonnet after ONE transport failure, not two"; Ulbar (Sonnet) delivered all seven fixes in ~45 minutes after the two deaths.*
8. The brief enumerates the files the lane may touch; the reviewer diffs the patch path set against that list, and any rename, id change or edit in a file the lane was only meant to **cite** is an automatic FIX. *Basis: the Saeros lane renamed a tracked ledger id (`DEFERRED_WORK.md:16406`).*
9. **Gemini amends, it does not rewrite.** Where a section rewrite is authorised, the brief lists the facts that must survive (quoted from `git show HEAD:<file>`) and the reviewer diffs old against new specifically for dropped facts. *Basis: F6.*
10. In any ledger row, observation and interpretation are **separate sentences**; a brief that narrows a symptom says "keep the measurement, add the interpretation". *Basis: F7.*
11. **Budget the fix round** rather than treating it as an exception: five of the last seven Gemini lanes returned LAND-WITH-FIXES (Salgant 12, Thror 15, Ciryandil/Tar-Meneldur 8; only Girion landed clean). Schedule reviewer + fix round + confirm for every Gemini batch, per `R-2026-09-10-4`'s mandatory station-3 review.
12. The packet reports any gate that is **vacuous** over the touched paths, with the count of files actually checked, not just the exit code. *Basis: `LANDING_PACKET_CIRYANDIL.md:35` did this correctly for prettier; `.markdownlintignore` and `.prettierignore` make lint vacuous for `migration_doc`.*

Astra:

13. **Astra never works in the seat.** One named clone per lane, stated in the brief and in the packet; `F:/Dev/GH/cesium-webgpu` is read-only to it. *Basis: `R-2026-09-10-3`; `ORCHESTRATION_HANDBOOK.md:76-80`; `WORKER_ISOLATION_AND_BRANCH_HANDOFF.md:689-693`; `AGENTS.md:148-152`.*
14. **One row per clone in the lane ledger, opened at dispatch:** clone path, base commit, patch path, freeze md5, packet path, reviewer, verdict. A clone with no row is not a lane. *Basis: the 2026-09-06…09 window produced four work groups and no such row for any of them.*
15. **Freeze before anything else:** every reviewable unit becomes `<lane>.patch` (`git diff HEAD --binary --no-renames`) plus a FREEZE md5 and a packet the same day, per unit — never a dirty tree with a narrative. *Basis: `AGENTS.md:153-157`; `RETURN_AUDIT` F1.*
16. *(both)* A **superseded freeze file is deleted or renamed** when a fix round regenerates the patch; a stale `FREEZE_*.md5` beside a current one is a landing hazard. *Basis: `REVIEW_CALMACIL.md` fix-round residual (a).*
17. Any change to shared runtime, a coordination mechanism, or a required field is staged **optional-with-default**, and the lane runs the full contract and fleet runners before freeze and reports their counts. A newly required descriptor field is a fleet-wide breaking change. *Basis: `RETURN_AUDIT` F3; `DEFERRED_WORK.md:76-84`, `:114-118`.*
18. A behavioural narrowing that reaches past the named feature, and any default flip, are **separate hunks, separately reviewed**; a default flip additionally needs a non-refused capture at ≥1280×720 plus a frame-cost number before it is proposed. *Basis: `RETURN_AUDIT` F2, F16; `R-2026-09-10-6`.*
19. Every spec gets its **npm runner home in the same batch**, and the packet quotes `node Tools/spec-runner-census.mjs` for the specs it adds. *Basis: `RETURN_AUDIT` F10; `R-2026-08-29-1`.*
20. An apparatus that **refuses every run is a ruling request filed the same session**, with source review continuing in parallel; a blocked capture is never re-run as a work queue. *Basis: `AGENTS.md:158-162`; `RETURN_AUDIT` F13 (six runs, `verdicts: []`).*
21. **Standing maintainer holds are re-read at lane start** and named in the packet; any document move or deletion under the 2026-06-30 archival hold is an automatic block, and the lane gates `verify-readme-index.mjs` with the change staged. *Basis: `AGENTS.md:163-165`; `RETURN_AUDIT` F5, F19.*
22. **No dependency mutation outside an owned clone and none in a served clone**; every install command is captured with its exit code, and manifest, lock and installed tree are reconciled in one reviewed batch. *Basis: `AGENTS.md:171-175`; `RETURN_AUDIT` F4.*
23. *(both)* **Placeholder discipline at landing:** the stamp step greps the **whole patch** for the placeholder token, never a named-file list. *Basis: the 2026-09-12 seat miss — eleven `Executed:` lines still carrying the unstamped batch placeholder survived Batch 1476 and needed Batch 1477. (This sentence deliberately does not reproduce the placeholder token, so the only literal occurrence in this file is the one at :3 that the seat stamps.)*

### 2.3 Seat rulings, 2026-09-13

These settle the items the companion left open. They are dated later than the companion and govern where the two disagree about **who** works a row or **when**.

- **R-HANDOFF-1 — the Gemini wall-time cap is 30 minutes of foreground work with no idle waits.** Inzilbeth's measured cap wins over S7's "about 45". A Gemini row that cannot fit is split by the seat **before** dispatch, with a checkpoint file between the two briefs. After R-HANDOFF-4 and R-HANDOFF-9 exactly one row in this set goes to Gemini and it is estimated at 15 minutes, so the cap binds nothing here — it binds the next set.
- **R-HANDOFF-2 — every Gemini lane names its Sonnet fallback at dispatch.** After **one** transport death the fallback takes the row, in the same clone, with the same brief; the packet records the handover. Not two deaths — one.
- **R-HANDOFF-3 — a row marked `worker: either` is dispatched to Sonnet**, unless the row is docs-only, in which case Gemini; the seat writes the choice into the dispatch message. Applied here: the three `either` rows are `C13-N08b-A2`, `C13-N08b-A4` (spec-code repair) and `C13-N58` (measurement). None is docs-only, so **all three are Sonnet**.
- **R-HANDOFF-4 — where the fix pass and the worker reader disagreed on the worker, the worker reader's (Namo's) assignment governs.** The six, with both values:

| Row | Fix pass said | Worker reader (Namo) said | Governs |
| --- | --- | --- | --- |
| `C13-N08b-A1` | Gemini | Sonnet tier-3 | **Sonnet** |
| `C13-N08b-A3` | Gemini | Sonnet tier-3 | **Sonnet** |
| `C13-N08b-A5` | Gemini | Sonnet tier-3 | **Sonnet** |
| `C13-N08b-C` | Gemini | Sonnet tier-3, replacement assertion spelled out | moot — demoted by R-HANDOFF-8 |
| `C13-N59` | Gemini | Sonnet tier-3 | **Sonnet** — this overrides the critic's §6.3(5) suggestion to leave Gemini on it |
| `GODRAY-SUN-USABILITY-RANGE-CONTRACT-RED` | Gemini | Sonnet tier-3 (Opus reviewer at station 3) | **Sonnet** |

  `DX-83` is **not** one of the six: both passes put Gemini on it ("shortest docs task in the set; Sonnet on one transport death"), and it stays Gemini.

- **R-HANDOFF-5 — every solo clone is created from `9f3723b0b32be87348553c3535893acdec37aeb3` (Batch 1481).** Every number in every row is pinned to it. If main has moved when the seat dispatches, the seat either re-derives the row's anchors or pins the clone to 1481 explicitly, and says which in the dispatch message.
- **R-HANDOFF-6 — runner-baseline rows measure their baseline in their OWN clone, at base.** The quarantine set, and any row whose STOP condition names a pass/fail count, records the measured baseline in the packet. **A baseline that differs from the row's expected count because a sibling landed is NOT a stop** — the worker records both numbers and continues; the seat reconciles at landing. This overrides the literal STOP wording in `C13-N08b-A1` through `-A5` and `-B`, which were each written correct-in-isolation at 1481 (see §5).
- **R-HANDOFF-7 — `DX-84` is Sonnet, not Astra.** Namo's condition was "Astra only if the row is later widened to kill", and the row forbids every kill path, so the condition is not met. Its `package.json` reconciliation is three-way — the two live holders plus the row — and is the seat's at landing.
- **R-HANDOFF-8 — `C13-N08b-C` is DEMOTED to NOT-SOLO.** It requires the worker to **author** an assertion the renderer does not contain, inside a 5,570-line engine file; supplying the replacement block verbatim does not convert authorship into transcription. The companion's §3.11 is now a pointer, its failing item is listed in the companion's §5, and this adjudicates the critic's §6.3(2). To promote it: an Opus lead writes and reviews the replacement block once.
- **R-HANDOFF-9 — the four spec-repair rows the fix pass assigned to Gemini are re-assigned to Sonnet**, because they are tools **code** (anchored-regex mutants in `.spec.mjs` files), under the seat's post-transport-death rule that keeps Gemini to short bounded **docs** tasks. Both values, by id: `C13-N08b-A1` Gemini → **Sonnet**; `C13-N08b-A3` Gemini → **Sonnet**; `C13-N08b-A5` Gemini → **Sonnet**; `GODRAY-SUN-USABILITY-RANGE-CONTRACT-RED` Gemini → **Sonnet**. This adjudicates the critic's §6.3(3) and reaches the same four assignments as R-HANDOFF-4 by a second, independent route.
- **R-HANDOFF-10 — `DX-84` is SOLO-AFTER-TEMPLATE, worker Sonnet.** The template is the seat's own 2026-09-12 orphan-kill procedure: parent-dead `msedge` processes found with `wmic process get ProcessId,ParentProcessId,CommandLine`, with a `tasklist` fallback, and a kill issued **only** on positive evidence that the parent is gone. The reason it needs a template at all is that Windows parent-process enumeration has no Principle-12-clean primitive yet — no Node API returns a parent pid. The template supplies the *judgement* (what counts as positive evidence of parent-death, and why a shell is admissible here); the row's own enumeration command stays the measured `Get-CimInstance Win32_Process … | ConvertTo-Csv` form in companion §3.12, and the tool this row ships stays **report-only** — no kill flag, no `taskkill`, no `process.kill`. This adjudicates the critic's §6.3(4).
- **R-HANDOFF-11 — `C13-N01` stage 2 and `C13-42a-2` appear in both the companion's §4 and §5 by design**, because a template makes each of them solo and nothing does today. The promoting conditions: **`C13-N01` stage 2** becomes SOLO-NOW *per family* once an Opus lead has routed **one** probe family end to end with its verdicts proven byte-identical before and after, and the `GOVERNANCE_SNAPSHOT` counters corrected from 60/0 to **61/1** in the same batch. **`C13-42a-2`** becomes SOLO-NOW *per family* once an Opus lead has done one family **and** the seat has ruled in writing how `workBudgetMs` is derived — the prescribed receipt records no work duration, only `options.timeoutMs` — with the plan's and the ledger's "18" re-stamped to **19**.

## 3. The three workers

The long form, with every citation, is companion §2.1 (Gemini) and §2.2 (Astra). What follows is what a dispatcher needs.

### 3.1 Gemini 3.8 Flash High (tier 3, via the `agy` wrapper)

**Use it for:** short, bounded, fully-specified **docs** work — verbatim transcription, structured-row placement, set-identity checks. Measured strengths: 65/65 ids set-identical across three files, 56/56 structured fields exact, 12/12 rulings byte-verbatim; zero git writes across every observed run; honest packets that volunteer their own vacuous gates.
**Do not use it for:** free-prose judgement, spec/tools code, engine or shader work, station-3 review, or any browser leg — excluded by directive and by `R-2026-09-10-4`.
**Measured limits:** successful wall clocks 8 min 31 s, 10 min 26 s, 11 min 6 s, 35 min 51 s; **two transport deaths on 2026-09-12**, both while idling on a background task, producing zero edits. Cap 30 minutes (R-HANDOFF-1); one death ends the lane (R-HANDOFF-2).
**Failure modes to brief against:** it fills a field the source leaves empty (74 invented `Pri`/`Class` cells, nine invented `Parity: both`); it lands a correction as a non-rendering HTML comment; it cites filenames that never land; it drops load-bearing facts in an authorised rewrite; it merges a measurement with its interpretation; it edits a file it was only meant to cite. Budget a reviewer, a fix round and a confirm for every Gemini batch — five of the last seven Gemini lanes returned LAND-WITH-FIXES.

### 3.2 Sonnet (tier 3, dispatched as an Agent with the model passed explicitly)

**Use it for:** bounded single-deliverable work with the judgement pre-made — spec and tools code repair, anchored-regex edits with mutants, measurement rows, provisioner and script changes. It is the default solo worker in this set: after §2.3, **eleven** of the twelve dispatchable rows are Sonnet's — every row except `DX-83`.
**Measured record:** Ulbar (Sonnet) delivered all seven fixes of a fix round in ~45 minutes immediately after the two Gemini transport deaths on the same round. It is the standing fallback behind every Gemini lane (R-HANDOFF-2).
**Honest limit of this profile:** the record contains **no** adversarial post-mortem of a Sonnet lane comparable to the Gemini and Astra reviews above, so its failure modes are not characterised here. Treat that as missing evidence, not as a clean record: the mandatory independent Opus station-3 review (`R-2026-09-10-4`) applies to Sonnet exactly as it applies to the other two, and the model is passed explicitly on every dispatch — an omitted model silently inherits the seat's.

### 3.3 Astra (tier 3, in a named clone, never the seat)

**Use it for:** deep engine work of architectural value, landing records that verify literally, disciplined recovery of shared state. Its prepared-frame cloud lifecycle and its probe runtime were both adopted into HEAD.
**Do not use it for:** anything in the seat worktree (`R-2026-09-10-3`); shared runtime or coordination mechanisms; work whose scope must stay inside its stated boundary; anything needing a browser capture (it refuses or declines them); dependency mutation outside an owned clone; governance edits.
**Measured limits:** an unsupervised 2026-09-06→09 window produced 72 modified / 34 deleted / 146 untracked files with an **empty index and nothing committed**; a required new descriptor field turned a green CI-registered spec into 0/5 across the fleet; 232 spec files were left with runner NONE; a 34-document archive move breached a standing maintainer hold. It builds successfully **and bakes a dirty tree into the served bytes**.
**If it is dispatched at all:** one named clone, stated in the brief and in the packet; the reviewable unit is frozen the same sitting, not at the end of the week; and the seat re-reads the standing holds at lane start.

## 4. The roster

**Eleven rows are SOLO-NOW** and one more is SOLO-AFTER-TEMPLATE with its template already in hand (`DX-84`, R-HANDOFF-10) — twelve dispatchable rows. The thirteenth drafted row, `C13-N08b-C`, is NOT-SOLO (R-HANDOFF-8). Estimates, runner homes and owned files are the companion's, re-stated here for dispatch; the row text governs.

| Row | What it does | Worker | Gemini fallback | Est. | Runner home | Anchors need refresh? |
| --- | --- | --- | --- | --- | --- | --- |
| `C13-N08b-A1` | `cloud-coverage-response.spec.mjs` A1 — re-anchor the three coverage gates onto the hoisted threshold local | Sonnet | — | 35 min | `test-cloud-c13-quarantine` (`package.json:208`) | **Yes** — cites `ProceduralClouds.wgsl:1286-1287`, held uncommitted by L4 |
| `C13-N08b-A2` | `cloud-ibl-revision.spec.mjs` B1 — the predicate and the commit now live in two named functions | Sonnet (was `either`) | — | 50 min | same (`:208`) | No — cites `WebGPUDynamicEnvironmentMapManager.ts`, held by no live lane |
| `C13-N08b-A3` | `cloud-march-emission.spec.mjs` E1/E2/E4 — indentation, a re-wrap, a widened signature | Sonnet | — | 45 min | same (`:208`) | **Yes** — cites `WebGPUProceduralCloudRenderer.ts`, held by L3 and L5 |
| `C13-N08b-A4` | `cloud-observability-counters.spec.mjs` D3/D9 — the reset moved into `beginCloudFrameAttempt` | Sonnet (was `either`) | — | 50 min | same (`:208`) | **Yes** — same renderer |
| `C13-N08b-A5` | `eclipse-cloud-ibl-response.spec.mjs` D1 — both eclipse mutant literals are two spaces short | Sonnet | — | 35 min | same (`:208`) | **Yes** — same renderer; its anchor abuts an L3 deletion |
| `C13-N08b-B` | `cloud-reconstruction-attachments.spec.mjs` — four drifted anchors, F1a/F1b left red by design | Sonnet | — | 75 min | same (`:208`) | **Yes** — same renderer |
| `C13-N58` | Execute the mask-order and cloud-primary-ray specs in an owned clone; convert Frór's caveat from argued to measured | Sonnet (was `either`) | — | 20 min | none added — both specs already in `test-cloud-c13` (`:207`) | n/a — the row changes no tracked file |
| `DX-82` | The provisioner stops leaving a clone's tracked governance files modified | Sonnet | — | 80 min | `test-landing-rules` (`:168`) | No — `Tools/` only |
| `DX-83` | Point the three bare `PROGRESS_THRAIN.md` citations at the archived copy | **Gemini** | **Yes — the seat names a Sonnet lane at dispatch** | 15 min | none — docs; the three Node doc gates are the bar | No |
| `C13-N59` | Bank Tilion's wave-1 launch-seal report as a tracked evidence doc and index it | Sonnet (was Gemini) | — | 30 min | none — docs | No |
| `GODRAY-SUN-USABILITY-RANGE-CONTRACT-RED` | Re-point the Batch-1471 god-ray anchors and add the one inertness control the repair needs | Sonnet (was Gemini) | — | 45 min | `test-cloud-c13` (`:207`) | No — cites `WebGPUGodRayEffect.ts`, held by no live lane |
| `DX-84` *(SOLO-AFTER-TEMPLATE)* | A report-only preflight listing parent-dead `msedge`/`playwright` trees and free memory | Sonnet | — | 55 min | `test-tools-lib` (`:170`) + the one add-only append the row gives verbatim | No — but see the `:167`/`:170` hunk hazard in §5 |

**Two roster notes.** `C13-N58`'s own expected values (24/24 and 5/5) were already produced read-only at the seat, so the critic reports it **discharged**; the seat decides whether to dispatch it for an independent re-derivation or simply bank the receipts. And `DX-83` is the only Gemini lane in the set, which is why it is the only row with a fallback column filled.

### The five demoted rows, and what unblocks each

These are **seat work**, not discard. Each was demoted with measured evidence, and each names the condition that promotes it.

| Row | Why it is not solo | Unblock condition |
| --- | --- | --- |
| `C13-N01` stage 2 (fleet routing) | S3 — the per-family routing shape is precisely what is undecided; S4 — 61 probe files plus the governance module, the contract spec and the allowlist | One Opus-led, reviewed family routed end to end, verdicts byte-identical before and after, and `GOVERNANCE_SNAPSHOT` corrected 60/0 → 61/1 in the same batch (R-HANDOFF-11) |
| `C13-42a-2` (migrate legacy probes onto the lifecycle) | S3/S2 — `workBudgetMs` cannot be pre-filled: the prescribed receipt records no work duration, only `options.timeoutMs`; S6 — 9 of the 19 probes have no receipt on this machine | One Opus-led family **plus** a written seat ruling on the budget derivation, and the plan's and ledger's "18" re-stamped to 19 (R-HANDOFF-11) |
| `C13-N33` | S3/S4 on 100 % of the remainder, and the solo-able part no longer exists — Batch 1476 landed five of the seven corrections in place; the residual belongs to `C13-N10`'s owner, to L8, and to a contended `DEFERRED_WORK.md` | The seat reconciles the **two live ownership registries** that disagree about who owns `C13-N10` (plan `:890-894` names L1 Halbarad / L2 Bregolas / L3 Elendur / L4 Baragund / L5 Marhwini; the dispatch roster names Durin / Telchar / Ulmo / Manwë / Ossë), then re-scopes the ledger row |
| `NEW-C13V2-PLAN-INPLACE-CORRECTIONS` | S5 by construction — drafted at `beb08423b3`, and Batch 1480 rewrote `lib/cloud-tour-fixtures.mjs`, the exact file its corrections measure from; as drafted it would have written **new** measured-false clauses under a dated "corrected" marker | One fresh measurement of `cloud-tour-fixtures.mjs` at dispatch HEAD confirming 15 `stations: [` blocks / 44 fixture `regime:` lines / ground 10, inside-deck 8, above-deck 22, orbital 4. **The repairs are already applied in the draft**, so re-promotion needs no re-draft |
| `NEW-TEST-CLOUD-C13-BUILD-PREFLIGHT` | S3 blocking (three spec assertions with no home; its own acceptance reads "CANNOT BE PRE-FILLED", which fails S2 too), S4 secondary | **Both**: the seat names the spec-home file, **and** `package.json` is free of Manwë and Oromë. Everything else is pre-filled |

`C13-N08b-C` joins them as of R-HANDOFF-8, promoted by an Opus lead writing and reviewing the 57-line replacement block once.

## 5. Sequencing — what must land first, and what collides

Six facts. The first three are structural; the last three were measured at the tree for this page on 2026-09-13.

1. **Seven rows share one runner baseline, and their expected counts contradict each other.** `C13-N08b-A1`…`-A5` and `-B` all run `npm run test-cloud-c13-quarantine`. Each expects 150/135/15 at base; A1 expects 150/136/14 after, B expects 150/139/11 after. Each is right **in its own clone at 1481** and wrong the moment a sibling lands. **R-HANDOFF-6 governs:** measure in your own clone, record both numbers, continue; the second lane never stops on a sibling's success. The seat reconciles the arithmetic at landing.
2. **The live engine lanes move every renderer line number these rows cite.** L3 Ulmo and L5 Ossë both hold uncommitted `WebGPUProceduralCloudRenderer.ts`; L4 Manwë holds `ProceduralClouds.wgsl`. Five rows anchor into those files (§4's "anchors need refresh" column). The rows' regexes are **content**-anchored and survive; the cited line numbers do not. So either the spec rows land **first**, or their anchors are re-derived at dispatch — S5 requires the re-derivation either way.
3. **S4 is discharged against the tree, not against a roster.** L1, L2, L6 and L8 all landed as Batches 1478-1481 and their clones are archived, so every S4 rejection of the form "L1 owns the probe runtime" is void. Measured 2026-09-13: the live lane clones are `cesium-lane-{manwe,orome,osse,ulmo}-20260912` (plus `before-ar001-20260905`, `sync-1145-20260904`, and the companion's own). Re-take the sweep with `git status --porcelain` over those clones at dispatch.
4. **`package.json` is held by four live clones, and two of them hold the same key.** Measured 2026-09-13, each a 1-insertion/1-deletion edit: **ulmo** `test-cloud-c13`, **manwe** `test-cloud-c13`, **osse** `test-visual-regression-node`, **orome** `test-sandcastle`. Two consequences. (a) The companion's §6.2(4) figure — "manwe, orome, osse; ulmo has none" — is superseded: `test-cloud-c13` at `:207` now has **two** uncommitted holders, which is the seat's to union. (b) `test-tools-lib` at `:170` is **free**, so `DX-84`'s append contends with nobody on its own key; but `test-sandcastle` sits at `:167`, three lines above, so a default three-line-context hunk for `:170` carries Oromë's changed line as context and the two patches cannot both be applied blind. The row names the hazard and does **not** solve it; the seat sequences the two landings. Note also that Oromë's clone is based at `bab1ff6e21` (Batch 1476), not 1481 — measured 2026-09-13 — so its line numbers are not a 1481 clone's.
5. **`probe-cloud-density-domain.mjs:990` is mid-correction by L3.** It pins `evidence.uniformFloatCount === 168` while the value it mirrors is 172 at HEAD, and L3 Ulmo holds the uncommitted correction to **176** in the same batch that adds `CLOUD_TIER_LIGHTING_FLOATS` to `CLOUD_UNIFORM_FLOATS` — re-measured for this page in L3's clone on 2026-09-13 (`-  evidence.uniformFloatCount === 168` / `+  evidence.uniformFloatCount === 176`). **Any row touching that probe waits for L3**; writing 172 hours before L3 writes 176 is guaranteed rework. None of the twelve dispatchable rows touches it — this is a boundary, not a blocker.
6. **`cloud-genus-morphology.spec.mjs` is dirty in two live clones at once.** Measured 2026-09-13: ` M` in both `cesium-lane-ulmo-20260912` (L3) and `cesium-lane-manwe-20260912` (L4), while the record assigns that file to L3's batch alone. The seat unions the two at landing. **No solo row may touch that spec until both lanes land** — one defect, one owner, and today that file has two.

## 6. What the seat does at landing

1. **Reviews.** An independent Opus station-3 reviewer stands behind every deliverable (`R-2026-09-10-4`), separate from whoever produced it, and diffs the patch's path set against the row's owned files — any rename, id change, or edit in a file the lane was only meant to **cite** is an automatic FIX (addition 8). For a row whose assertions pin engine behaviour (`C13-N08b-A2`, `-A4`, `-B`, `GODRAY-…-RED`), the seat may add the adversarial Opus verifier of `R-2026-09-11-1`, briefed to **refute** the packet; a REFUTED verdict returns the lane before landing.
2. **Unions what the lanes could not.** The quarantine-runner arithmetic across the six specs (§5.1); the `package.json` script lines, per key, across every holder (§5.4); and `cloud-genus-morphology.spec.mjs` across L3 and L4 (§5.6).
3. **Regenerates what a lane is forbidden to touch.** `migration_doc/TOOLING_CATALOG.md` for `DX-84`'s two new files — its `rows added 2` red is **expected** and is the seat's step, not the lane's defect — together with the five pre-existing freshness rows from Batches 1479-1481.
4. **Writes the record the rows disclose but may not edit.** The `### DX-82` / `### DX-83` / `### DX-84` sections owed in `QUEUE_2026-08-29_RESEARCH_DISPATCH.md`, the DX queue's own home; the ledger rows and counts each row's packet lists under "owed"; and the four plan sites `C13-N59` reports stale.
5. **Stamps the placeholder by grepping the WHOLE patch**, never a named-file list (addition 23) — the miss that cost a follow-up batch on 2026-09-12.
6. **Lands inside the window.** No commit and no push on weekdays between 07:00 and 19:00 US Eastern; commits carry visible timestamps even when pushed later, so work is held as worktree state or exported patches until the window opens. The tracked pre-push guard has no override.
7. **Closes out the clone.** Evidence repatriated into `Tools/visual-regression/output/` before any reset, the lane ledger row completed with its verdict, the clone retired, and `node Tools/temp-hygiene.mjs --plan` / `--execute` run after the push.
