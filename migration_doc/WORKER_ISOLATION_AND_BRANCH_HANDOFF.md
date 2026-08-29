# Worker isolation and the branch-based handoff

**Date:** 2026-08-17 · **Status:** operating procedure — proposed. Six decisions in §9 need a
maintainer ruling before first dispatch. **Read this before creating any worker branch, worktree, or
clone**, whether you are the orchestrator, a Claude worker, or a Codex worker.

**Audience:** all three. The orchestrator owns §4–§6. Workers own §5 steps 6–7 and §7. Codex workers
additionally own §8.

---

## 1. Why this exists

The previous handoff was **patch-based**: a worker exported `git diff --cached --binary`, the
orchestrator applied it into a chronically dirty main tree, then committed. That flow produced the
worst defect in the project's history.

Commits `cb0f77cbe1` (Batch 1039) and `7c959b68c1` (Batch 1041) carry detailed bodies claiming
executed code, spec and gate work, over trees containing **only two markdown files each**. The
mechanism is now proven: the worker's full patch (`sol-9-capture.patch`, 9 files) sat on disk beside
a doc-only staging patch (`sol9-stage.patch`, 2 files, both markdown). The orchestrator applied the
staging subset and committed the worker's full body. `cb0f77cbe1`'s numstat matches the doc-only
patch line-for-line while the worker's 456/-63 code half was severed at the first `migration_doc`
boundary.

**A branch-based handoff removes the subset.** With no patch there is nothing to mis-apply: a branch
either carries the commits or it does not, and `git diff main...<branch>` is the complete, reviewable
truth.

A third instance of the same *class* landed on 2026-08-17 — a tracked `package.json` routing through
an **untracked** launcher, taking `npm run verify-tooling-catalog` offline in every clone. The branch
flow does **not** catch that for free (§6.2).

---

## 2. Clones, not worktrees — for anything that commits

**This reverses an earlier recommendation in this session.** Worktrees were proposed because they
share the object store and are near-free on disk. They are disqualified for sandboxed workers on
security grounds.

A linked worktree's `.git` is a **file**, not a directory, containing
`gitdir: F:/Dev/GH/cesium-webgpu/.git/worktrees/<name>`. Every ref, index and reflog write a worker
makes therefore lands **under the orchestrator's `.git`**. Codex's sandbox is NTFS-ACL and
path-based, so it can only either block the worker's commits entirely or hand it `refs/heads/main`,
`.git/index`, `.git/config` and `.git/hooks`. There is no middle setting.

A clone's `.git` is a real directory the worker owns outright.

**Worktrees remain fine for the orchestrator's own non-sandboxed trees** — but as *siblings* with
their own `npm install`. In-repo `.claude/worktrees/*` silently binds `@cesium/engine` to the main
tree's `node_modules`, so a worker "testing its own copy" is testing **main's engine**. Sibling
directories fail loudly instead (`/f/Dev/GH/node_modules` is empty).

### Per role

| Role | Isolation | Cost | Verdict |
|---|---|---|---|
| **Reviewer** (read-only) | none needed — `git diff main...<branch>` and `git show <branch>:<path>` from main | **zero** | default; use this unless a gate must execute |
| **Reviewer running offline gates** | `git clone --no-hardlinks` + copied `_review/` artifacts | ~1.75 GB (1.28 GiB pack + 226 MB checkout); 181 GB free | fine |
| **Spec-running executor** | same clone, plain `node --test` | as above, **no `npm install`** | fine |
| **Probe-running executor** | — | ~920 MB `node_modules` + 229 MB build + exclusive port 8080 + GPU-backed Edge, per worker | **refuse** (§9.6) |

**Do not run `npm install` in a worker clone.** The three `test-*` scripts import only `node:`
builtins. `npm install` fires `prepare` → husky + `playwright install --with-deps`, which is a large,
slow, network-dependent side effect a worker does not need.

`Tools/visual-regression/output` (4.0 GB) is gitignored and reaches **no clone**. Evidence must be
copied explicitly into `<clone>/_review/` with a SHA-256 manifest — **never symlinked**, which is
both a confinement hole and a drift channel.

---

## 3. Squash-only landing — this is load-bearing, not stylistic

**Never `git merge --no-ff` a worker branch.** Two verified rule-skip holes make a true merge enforce
*less* than the patch flow it replaces:

- merge commits skip landing rules (a)–(c) entirely — `Tools/landing-rules.mjs:452-463`;
- non-agent authors skip **every** rule — `:445-451`, proven live by 57 scope-skipped upstream
  commits in the Batch 958 range.

Squash-landing also solves the quiet-hours problem structurally: the orchestrator authors the commit
at landing time, so worker dates are discarded entirely.

Assertion: `git rev-list --count --merges <remoteSha>..<localSha>` must be **0** unless the push is a
declared upstream sync.

---

## 4. Rebase — known issues, drawbacks, and special handling

Squash-only landing means the orchestrator never rebases. But a **worker** will want to rebase its
own branch onto a moving main, and that is where the danger lives.

### 4.1 The core hazard

**A badly-resolved rebase conflict silently drops code — the exact failure class this whole design
exists to eliminate.** There is live proof in the tree: `migration_doc/QUEUE_2026-07-23_CAMPAIGN13.md.rej`,
a hunk that failed to apply on 2026-08-14 and that **nobody noticed for three days**. It is the
mechanical cause of the C13-41 status split across five authorities. Rebase produces the same
artifacts by the same mechanism.

Adopting branches and then rebasing carelessly re-imports the defect through the back door.

### 4.2 Rewritten SHAs invalidate citations

This project cites commit hashes everywhere — queue rows, `DEFERRED_WORK`, disposition ledgers,
artifact provenance. A rebase changes **every** SHA on the branch.

> **RULE: never cite a SHA from an unlanded branch.** Cite the branch name plus the tip at handoff
> time, and re-report the tip after any rebase.

### 4.3 Dates split

Rebase preserves **author** date and resets **committer** date. Quiet hours exist precisely because
commits carry visible timestamps, so this matters — and the current guard has a hole (§6.4). Under
squash-only landing the point is mostly moot, which is a further argument for it.

### 4.4 Line endings

B1048 was a live example: a `\n`-literal mutant was a silent no-op on a CRLF checkout and a green
probe read 56/57. A worker clone with different `core.autocrlf` produces spurious rebase conflicts
and can commit pure line-ending churn.

> **RULE: a worker clone must not change `core.autocrlf` or `.gitattributes` handling.**

### 4.5 `git rerere` cuts both ways

It replays a previous resolution automatically — including a previously **wrong** one. Do not enable
it in worker clones.

### 4.6 Special handling — the rules

1. **Rebase only inside the worker's own clone, and only before handoff.** Once the orchestrator has
   fetched the tip (§5 step 8), the branch is frozen. A rebase after that point invalidates the
   fetched tip, the review, and the validation manifest together.
2. **Prefer `git merge main` over `git rebase main`** inside the worker clone when the worker only
   needs to catch up. It is not landing that history — the squash discards it — so linear history on
   the branch buys nothing and rebase costs conflict risk.
3. **After any rebase or merge, assert the tree is conflict-clean.** No `.rej`, no `.orig`, no
   `<<<<<<<` / `=======` / `>>>>>>>` markers anywhere. This one cheap check would have caught the
   stale `.rej` three days ago.
4. **Re-run the full spec set after any rebase** and re-record the exit codes. A rebase is a
   re-derivation of the work, not a no-op, and its result is unproven until re-measured.
5. **Re-report the tip SHA** after any rebase, and re-run the handoff report (§5 step 7).
6. **Never rebase a branch another agent has based work on.** Single-owner branches make this mostly
   moot; the lease in §5 step 2 is what keeps it that way.

---

## 5. The handoff procedure

Every step names the assertion that proves it happened. *A step without an assertion is a wish* —
the patch flow failed precisely because nothing asserted that the staged set matched the claimed set.

| # | Actor | Action | Assertion |
|---|---|---|---|
| **0** | orchestrator | **Capacity preflight** — `node Tools/codex-preflight.mjs` | exits **0 READY**. On **1 EXHAUSTED** do not dispatch; the output carries the server's reset time. (On 2026-08-17 this reported `resets Aug 19th, 2026 11:31 PM`.) |
| 1 | orchestrator | Branch inventory and disclosure to the maintainer | `npm run verify-branch-inventory` exits 0, or its output is pasted verbatim into the dispatch message (CLAUDE.md branch-transparency obligation 1) |
| 2 | orchestrator | Declare the **path lease** in `migration_doc/branches/<agent>--<row>-<slug>.md`: declared path set, base SHA, reap-when date, disk budget | the declared set intersects neither any other OPEN lease nor `git status --porcelain` on main (140 dirty paths today). Empty intersection required or the dispatch is **refused** |
| 3 | orchestrator | `git branch sol/<row>-<slug>-b<sha10>-<yyyy-mm-dd> main`, then `git clone --no-hardlinks --branch <branch> <main> <clone>` | `git check-ref-format --branch` exits 0; in the clone `.git` is a **directory** (`test -d`); `rev-parse HEAD` equals the tip; `status --porcelain` empty |
| 4 | orchestrator | Provision governance + evidence: confirm `AGENTS.md` and `.agents/skills/**` present; copy artifacts to `<clone>/_review/` with a SHA-256 manifest | `AGENTS.md`'s four routed paths resolve **in the clone**; the reviewer rehashes every `_review/` file on arrival and halts on mismatch |
| 5 | orchestrator | Scope the Codex sandbox to this clone only; confirm the blanket `f:\dev\gh` trust entry is gone | the sandbox log's processed-write-root count equals the declared roots, and the banked escape-probe result shows writes to `<main>/.git` refused (§10.1) |
| 6 | **worker** | Work inside the lease. Commit on the branch. **No push, no `npm install`, no build, no browser** | `git status --porcelain` in the clone is **EMPTY** at handoff — this is the untracked-file catcher, and it is only assertable *because* the clone is clean |
| 7 | **worker** | File a mechanical handoff report: branch, 40-hex tip, base, `git diff --stat main...HEAD`, verbatim `status --porcelain`, and every `node --test` exit code | every claim in the narrative names a path that appears in the reported `diff --stat` |
| 8 | orchestrator | `git fetch <clone> <branch>:<branch>`, then `git merge-tree --write-tree main <tip>` (computes the merge as objects, no index or worktree side effects) | fetched tip equals the reported tip; `merge-tree` exits 0 (verified: git 2.55.0.windows.3 returns a tree OID even with 140 dirty paths) |
| 9 | orchestrator | **Clean-clone smoke**: clone the tip alone into a temp dir, run `Tools/verify-tracked-references.mjs` plus every npm script the landing claim names | every command exits 0, codes recorded into the §1.7 validation manifest. **This is the only step that catches the untracked-dependency class** |
| 10 | orchestrator | Read `git diff main...<branch>` **in full**; reconcile against the report. Never review the body in isolation | every path cited in the narrative appears in `diff --name-only main...<branch>`, and every path in that list is inside the lease. Anything outside the lease **blocks** |
| 11 | orchestrator | In the landing clone, after 19:00 ET: `git merge --squash <branch>` then `git commit`. **No `git add` between merge and commit** | `Tools/verify-landing-content.mjs` proves staged set === branch diff set; `date` outside quiet hours; `npm run verify-landing -- --last 1` green (**an explicit range is required** — a bare invocation currently verifies 0 commits) |
| 12 | orchestrator | Push from the landing tree; tag `safety-worker-<row>-<sha10>` at the branch tip; close the ledger row to REAPED | `git rev-list --count --merges` is 0; the tag resolves; `verify-branch-inventory` exits 0 |

**Landing tree.** Main carries 140 dirty paths, so `git merge --squash` there aborts on any
overlapping path (B1041 overlapped 5 of 5). Land in a separate clean clone with hooks pinned:

```
git clone --no-hardlinks F:/Dev/GH/cesium-webgpu F:/Dev/GH/cesium-landing
git -C F:/Dev/GH/cesium-landing config core.hooksPath F:/Dev/GH/cesium-webgpu/.husky/_
```

A clone gets no hooks by default (`core.hooksPath` is local config; `.husky/_` is gitignored).
Pinning to main's absolute shim directory makes the guard fire without any `npm install`.

---

## 6. Guards — what each one catches

> ⚠ **STATUS CORRECTION (2026-08-18).** Of the guards below, **`Tools/verify-landing-content.mjs`,
> `Tools/verify-tracked-references.mjs` and `Tools/verify-branch-inventory.mjs` are PROPOSED — DOES
> NOT EXIST YET.** None is on disk. §5's assertion column above names them as though they were
> available; it is describing the *intended* procedure, not one that can be executed today.
>
> This document asserted tooling that does not exist — the same defect class it was written to
> prevent (a claim describing code that is not there), authored by the orchestrator. Recorded rather
> than quietly fixed, because the pattern matters more than the instance.
>
> Per `R-2026-08-17-19`, **`verify-landing-content.mjs` (staged-set equality) is built first**; the
> other two are deferred, not cancelled. Until each exists, its assertion is performed by the
> orchestrator by hand and that fact is stated in the landing note — a manual check is weaker than a
> mechanical one and must not be recorded as though it were the same thing.



### 6.1 Staged-set equality — *the* successor to the failed mechanism
`set(git diff --cached --name-only)` must equal `set(git diff --name-only main...<branch>)` after
`git merge --squash`, with **no `git add` in between**; and every path named in the commit body must
be in that set. **New: `Tools/verify-landing-content.mjs`.**

### 6.2 Tracked-reference resolution
For every `node <path>` in `package.json` scripts and every relative import in changed
`.mjs`/`.cjs`/`.js`, assert `git cat-file -e <tree>:<path>` **against the candidate tree, not the
disk**. Prototyped read-only: 0 missing at `HEAD`, exactly **1** missing against the working tree
(`Tools/generate-tooling-catalog-launcher.cjs`). **New: `Tools/verify-tracked-references.mjs`**,
wired into both the clean-clone smoke and the pre-push hook.

### 6.3 Clean-clone smoke
Catches 6.2 dynamically, plus dependencies a static scan misses (concatenated paths, config-read
paths, dynamic import) — and an index-certified-but-uncommitted file, since
`generate-tooling-catalog.spec.mjs` certifies via `readTrackedFiles` over **index** blobs, not HEAD.

### 6.4 Commit-timestamp quiet hours — **a live hole in the existing guard**
`Tools/pre-push-guard.mjs:184` omits `includeCommitQuietHours: true`, so
`checkCommitQuietHours` (`landing-rules.mjs:382-394`, which tests **both** author and committer
dates) **never runs at push**. Line 177 checks only `new Date()` — the push instant. A commit stamped
11:00 Monday pushes cleanly at 20:00. **24 such commits are already permanent ancestors of main**, and
`EXECUTOR_LANE_CHARTER_2026-08-14.md:342` already *claims* the hook does this. One-line fix; see §9.3.

### 6.5 Squash-only
Asserts `git rev-list --count --merges` is 0. Closes the two rule-skip holes in §3 at once.

### 6.6 Worker-tree cleanliness
The handoff report must carry verbatim `git status --porcelain` and it must be empty. Catches an
un-`add`-ed file at source — the launcher shape, inside the new flow.

### 6.7 Branch-inventory detector — six assertions
(1) every `refs/heads` ref except `main` has a ledger row; (2) every OPEN row is inside its age budget
(WARN 7d / FAIL 14d); (3) every registered worktree has a row; (4) **every directory matching the
worktree grammar that is not registered is flagged**; (5) `git branch --merged main` yields only
`main`; (6) every REAPED row names a tag that resolves.

Scope to `refs/heads` only — **Codex writes refs under `refs/codex/`**. Assertion (4) fires *today*
on five unregistered `.claude/worktrees/*` directories that `git branch -a`, `git worktree list` and
`git status` (`.gitignore:56`) all miss. Run at three moments: dispatch, reap, session start.

### 6.8 Body-claim path binding
Reject any landing whose body cites a file absent from the branch diff, or any branch that touched a
path outside its lease. The commit message is otherwise unconstrained by the diff — even with no
patch subset, a body can still describe work the tree does not contain.

---

## 7. Rules for workers (Claude and Codex alike)

1. Work only inside your **declared path lease**. Touching a path outside it blocks the landing.
2. **Never run a git write.** No commit, stash, checkout, restore, reset. Work in your tree and
   leave it dirty; the orchestrator fetches your branch and commits from its own tree.
   *(Amended 2026-08-18 by `R-2026-08-18-28`, restoring `ORCHESTRATION_HANDBOOK.md:61` `[HARD]`. The
   earlier wording here said "commit freely" and contradicted both the handbook and `R-13`/`-19`,
   leaving three tracked documents disagreeing — which deadlocks a worker that is told to stop and
   report conflicts rather than choose.)*
3. **Never run `npm install`, a build, or a browser** in your clone.
4. Your `git status --porcelain` must be **empty** at handoff. An un-`add`-ed file is invisible to
   the branch and will be lost.
5. Rebase only per §4.6, and re-run everything afterwards.
6. **Never cite a SHA from an unlanded branch.**
7. Your handoff report is mechanical, not narrative: every claim must name a path that appears in
   your own `git diff --stat`.
8. If you cannot finish, stop and write the handoff. A bounded partial with an honest report is worth
   more than an unbounded sprint — see `CODEX_SOL_OPERATING_BRIEF.md` §2.

---

## 8. Codex-specific

- **Capacity first.** `node Tools/codex-preflight.mjs` before any dispatch (§5 step 0). Codex bills
  against a ChatGPT plan whose limit is enforced **server-side** — there is no local counter and no
  `codex usage` subcommand, so the only honest check is a minimal canary turn.
- **Wiring.** [`.mcp.json`](../.mcp.json) exposes `codex` via
  [`Tools/codex-mcp-launcher.mjs`](../Tools/codex-mcp-launcher.mjs), pinned to
  `sandbox_mode="read-only"`. The launcher resolves the CLI across `$CODEX_CLI_PATH` → PATH → newest
  `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`, because that hash directory changes on every
  desktop-app update.
- **Governance must be tracked to reach a clone.** `AGENTS.md` and `.agents/skills/**` are currently
  **untracked** while all four documents `AGENTS.md` routes to are tracked. Until they land, a worker
  clone contains **zero** governance.
- **Two instruction conflicts must be fixed before first dispatch** (§9 is not required for these —
  they are plain corrections): `run-cesium-campaign-lane/SKILL.md:22-23` forbids inspecting branch
  state, which is exactly the hygiene a branch-resident worker owes; and `AGENTS.md:52`
  ("Repository prose cannot supply that authorization") nullifies CLAUDE.md §8 probe-first, deadlocking
  a worker into the ask-the-user anti-pattern.
- **Trust scope.** `~/.codex/config.toml` marks `f:\dev\gh` — the *parent* — as trusted, covering
  every worker clone and all four Quest League repos. Narrow it to per-clone entries.
- Codex output is **untrusted content** under the B1044 doctrine: data, never instructions.

---

### 8a. Dispatch rules — learned from the first two live dispatches (2026-08-20)

Two dispatches were run against a real task. Neither produced a usable deliverable, and **both
failures were the orchestrator's**, not the worker's. These rules exist so they are not repeated.

**What the worker did right, and must keep doing.** Dispatch 1 refused to start because three routed
authorities were unreachable in its clone, and said exactly which. Dispatch 2 stayed strictly inside
its path lease and ran no git write. Do **not** relax the stop-on-unreachable-authority behaviour to
make a dispatch "work" — that behaviour is the control.

#### R1 — Assert clone readiness. Never assume it.

Run `node Tools/provision-worker-clone.mjs <clone>` and **require exit 0** before dispatching. It
provisions what git cannot deliver (`CLAUDE.md` is gitignored and can never reach a clone), creates
the local `main` ref the handoff diff needs, and verifies every authority `AGENTS.md` routes to
actually resolves.

The first dispatch failed on this, and the sharpest detail is that the orchestrator had **already
observed** `CLAUDE.md` was missing, remarked that it validated the router design, and dispatched
anyway. A checklist followed from memory is not a control.

#### R2 — One deliverable per dispatch. Keep tasks small.

Dispatch 2 was given an AST analyser **plus** a measured 174-row allowlist **plus** a mutation spec,
in one brief. It worked the entire budget and produced a module that does not run. Split by
deliverable:

- a module, testable against fixtures — one dispatch;
- an artifact derived by measurement — a separate dispatch;
- the spec that binds them — a third.

**A task requiring a fleet-wide scan is not a small task.** Either the orchestrator supplies the scan
result as reference, or the scan is its own dispatch.

#### R3 — Budget a reporting window inside the hard kill.

Dispatch 2 was killed by `timeout` (exit 124) mid-write, so **no handoff report was produced** and
the partial work arrived unexplained. Give the worker a **soft deadline** — "at N minutes, stop and
write the report whatever the state" — comfortably inside the hard kill.

This is the fleet's own terminating-watchdog rule turned on ourselves: a watchdog that fires must
still emit a verdict. A hard kill with no reporting window gives the worker a stricter deadline than
we permit our own probes.

#### R4 — Give the method, withhold the answer.

Where the orchestrator has already measured something the worker must derive, **do not put the number
in the brief.** Supply the method and require the worker to measure. The orchestrator then holds an
independent check the worker could not have fitted to. (Batch-767 doctrine: a discriminator must not
be built from the primitive it discriminates.)

#### R5 — Name the negative control in the brief.

State which inputs must stay **green**, and why. For the reader rule these were four probes performing
legitimate frozen-PNG decodes, two of which carry banked acceptance evidence. A rule that reds them
would invalidate certifications — and naming them is what separates a real predicate from a keyword
grep.

#### R6 — Verify the worker's claims yourself. Always.

Run the spec, check the lease, re-derive the count. Charter §4.6 forbids the author approving its own
work, and a handoff report is the author's account. In dispatch 2 the report never existed and the
spec failed on first execution — a reviewer trusting a summary would have banked a broken deliverable.

#### R7 — Record the exit code, and read it correctly.

`timeout` returns **124** on kill. A compound shell line reports the *last* command's status, so
`node … ; echo $?` after a pipe reports the pipe's tail, not the worker. This misread happened three
times in one session, twice reporting success where the real code was 1 or 3. Capture the worker's
own exit code directly.

---

### 8b. Validation — the rules measured against three live dispatches (2026-08-20)

The §8a rules are not proposals; they were derived from two failed dispatches and then **tested by a
third**. Recorded here because a rule set that has never been exercised is a guess.

| | Dispatch 1 | Dispatch 2 | Slice 1 (rules applied) |
|---|---|---|---|
| Worker exit | refused to start | **124** — hard-killed | **0** |
| Handoff report | precise refusal | **none** | complete |
| Deliverable | none | crashed on first run | **6/6, mutation-verified** |
| Path-lease compliance | — | clean | clean |
| Git writes | none | none | none |

**What each rule bought, concretely.**

- **R1 (assert readiness)** turned dispatch 1's silent under-briefing into an exit-1 refusal *before*
  a worker is spawned. `provision-worker-clone.mjs` reproduced all four blockers on the broken clone.
- **R2 (one deliverable)** is the whole difference between dispatch 2 and slice 1. The same worker,
  the same model, the same rule: given an analyser **plus** a measured artifact **plus** a spec it
  produced code that did not run; given the analyser alone it produced a working, non-vacuous one.
- **R3 (reporting window)** converted exit 124 into exit 0 with a full report. Soft deadline 20 min
  inside a 30 min hard kill.
- **R6 (verify yourself)** was load-bearing even on the successful run: the worker's report listed
  its *initial* failure honestly but left the **final** test counts blank. The 6/6 came from the
  orchestrator executing the spec, not from reading the summary.

**Worker behaviours worth preserving — do not "fix" these.**

1. **It stops when governance is unreachable.** Dispatch 1 did no work and named the three missing
   authorities. That refusal is the control; relaxing it to make a dispatch "succeed" would remove
   the only thing standing between a worker and an under-briefed run.
2. **It discloses failures it has already repaired.** Slice 1 reported "Initial run: 0 passed,
   1 failed — `acorn` was unavailable" rather than presenting only the green end state.
3. **It adapts to a constraint instead of asking to break it.** With `npm install` forbidden and
   `acorn` therefore unavailable, it rewrote the predicate to be **dependency-free** — zero imports.
4. **It volunteers provenance distinctions.** It stated unprompted that the provisioned governance
   was not its work, and reasoned correctly about why `CLAUDE.md` did not appear in its own porcelain.

**The standing gap.** Final test counts were omitted from the report while the initial failure was
included. Treat every worker-reported green as unverified until executed. R6 is not ceremony.

---

### 8c. Brief-writing and verification rules — learned from the seven-worker picking run (2026-08-20)

§8a fixed dispatch *mechanics*. This section fixes what goes *into* a brief and what "verified"
means. It comes from a seven-worker run — four Codex Sol, three Opus — reviewed cross-family.

The workers performed well. **Every defect below is the orchestrator's.**

#### R8 — The brief is a claim. Verify the defect before you brief the fix.

**Three of four Sol briefs asserted a symptom the code does not exhibit.** The worst: a brief stated
the `pickPosition` cache "latches forever" under `requestRenderMode`. It does not —
`tryAndCatchError(this, prePassesUpdate)` sits at `Scene.js:4752`, **outside** the `if (shouldRender)`
gate at `:4768`, so `_pickPositionCacheDirty` is set every frame and a memoized `undefined` survives
exactly one frame.

The brief was written from an audit finding without re-reading the cited code. **If a brief cites
`file:line`, those lines are read at brief-writing time.** An audit finding is a lead, not a premise.

Consequence when this fails: the worker implements the stated symptom faithfully, and the fix
addresses a defect that is not there. Here it also produced a **WebGL GPU-stall regression** on a
backend that had no bug, because removing memoization was justified by the false diagnosis.

#### R9 — A spec written from the brief certifies the brief, not the behaviour.

This is R8's corollary and it is worse, because the spec is supposed to be the independent check.
When the worker writes both the fix and its spec from one brief, **the spec inherits the brief's
error** and reports green over a wrong premise.

Brief the **observable behaviour to assert**, never the implementation shape. "Assert that a second
query at the same pixel re-queries after a completed readback" is checkable against reality.
"Assert the cache no longer stores `undefined`" only checks that the worker did what it was told.

#### R10 — Every spec needs an INERTNESS mutation, not just a deletion mutation.

The `drillPick` spec passed **2/2** with the warning made provably unreachable:

```js
if (false && !context.supportsSynchronousReadback) {   // can never fire, on any backend
```

It asserts the *text shape* of the source, not that the branch is live. A source-grepping spec is
vacuous by default — and this one was written to guard a warning whose entire defect was that it
never reached production.

Deleting code is the easy mutation and most specs survive it. **Make the fix inert instead** —
unreachable, short-circuited, called with arguments that can never satisfy it. That is the mutation
that finds vacuity.

#### R11 — Self-test a validator against known-GOOD work before trusting it.

`Tools/verify-worker-handoff.mjs` reported **four violations on its first run, none real**:

- `git()` trimmed its output, eating the leading space of the first `" M path"` porcelain line, so
  the first modified path lost a character — which then failed lease matching *and* made its spec
  unrunnable, producing three cascading false failures;
- the `@purpose`/`@status` rule was applied to every `Tools/` file when
  `purpose-header-allowlist.mjs:34` scopes it to probes **excluding `.spec.mjs`**;
- the Campaign 16 marker scan read whole files, so a worker inherited blame for pre-existing debt
  (`Scene.js:456` has cited Batch 219 since long before this work). It now scans **added lines only**.

A validator run only against suspect input has no control. Run it against work you already believe
is correct, and treat a violation there as a bug in the validator until proven otherwise.

#### R12 — The reviewer re-derives load-bearing claims. It never relays them.

One Opus lane accused another of causing a red in `webgpu-pick-center-identity.spec.mjs`. The
synthesiser refused to pass it on, rebuilt the spec against `git show HEAD` of the accused file, and
found the identical failure — **a pre-existing red on main**. The orchestrator then re-verified by
swapping HEAD's file in wholesale: same 8/9, restore byte-identical.

Without that, good work would have been reverted chasing a defect that predates it. The accusation
was superficially plausible: the accused lane *had* removed two gate conditions.

#### R13 — Verification is three tiers, and each catches a class the others cannot.

1. **Mechanical** (`verify-worker-handoff.mjs`) — lease, git writes, conflict artifacts, headers,
   comment markers, and *does the spec run*. Cheap, total, and **cannot** tell whether the spec means
   anything.
2. **Substantive** (orchestrator reads the diff) — does it match the brief, is the code correct, does
   it introduce a new defect. Catches scope overrun and obvious errors.
3. **Cross-family independent review** — a different model family re-deriving the premises. This is
   the only tier that caught the false diagnoses, the vacuous spec, and the broken public contract.

Tier 1 passed all four Sol lanes. Tier 3 sent two back. **A green tier 1 means "ready for review",
never "correct"**, and the tool prints exactly that on success.

#### R14 — Disjoint line ranges are not proof of a clean merge.

Three lanes edited `Picking.js`; the orchestrator checked hunk ranges (684–893, 910–929, 1268–1352),
found them disjoint, and called it clean. That is a *textual* argument only. The reviewer separately
checked **semantic** interaction — shared paths, duplicate imports, whether one lane's capability gate
changes when another's cache path runs — and then actually performed the merge (two sequential
`git merge-file` passes, exit 0, zero conflict markers, `node --check` clean).

Prove a merge by performing it. Ranges are a screening step, not a verdict.

#### R15 — A lease deviation with a stated reason is a finding, not a violation.

A lane was leased `…Spec.js` and delivered `…Spec.mjs`. That looks like non-compliance and is
**correct**: `scripts/build.js:622` globs `packages/engine/Specs/**/*Spec.js` into the Karma SpecList,
which esbuild bundles for the browser, so a `node:test` import at a `.js` path breaks the whole engine
spec bundle. Six pre-existing pure-Node specs in that tree already use `.mjs` for this reason.

Evaluate deviations on their merits. The lease encodes the orchestrator's intent, and the
orchestrator is sometimes wrong about the mechanics.

---

## 9. Open decisions — maintainer ruling required

1. **The three sibling worktrees** (R-2026-08-14-7). `cesium-webgpu-cert-s5-*` is clean and detached
   at an ancestor of main — zero-loss. `cesium-webgpu-evidence` holds 29 dirty tracked files plus 11
   untracked probe files **byte-different** from main's own uncommitted copies of the same paths;
   `-evidence-v9` holds 6 files differing from **both** main HEAD and main's working copy — content
   in no commit anywhere. **Recommend:** authorize read-only per-file triage first. Remove nothing
   before it lands. 5.3 GB is not a reason to hurry.
2. **How main's checkout advances.** (i) *Recommended*: land in a separate clean clone, enforce path
   leases, let dirty main fast-forward only when disjoint. (ii) *Maintainer-gated*: move main's
   checkout off the dirty tree via `git branch wip/shared-tree` + `git symbolic-ref HEAD` (ref-only,
   never checkout/switch/reset). **(ii) must never be agent-initiated.**
3. **Fix the guard or the charter?** §6.4. Recommend fixing the code — one line, defense in depth
   behind the squash rule — but it is a change to a landing guard under an active ruling.
4. **Worker commit identity.** Pinning workers to `cesium-webgpu-agent` keeps rules (a)–(c) active but
   erases the audit distinction the branch flow creates; extending `AGENT_AUTHOR_NAME`
   (`landing-rules.mjs:34`) to a set preserves attribution but is a guard-semantics change requiring
   its spec extended in the same commit. Under squash-only this reduces to what the `Worker-Branch:`
   and `Co-Authored-By:` trailers must carry.
5. **Salvage disposition.** `sol-9-capture.patch` is the **only extant copy** of B1039's 456 added
   lines (`CURRENT_FRAME_READ_BEGIN` greps empty in both HEAD and the worktree) and it sits in a
   volatile scratch directory. Land or bundle it before further design work. B1041 is a different
   question — its subject matter was partly re-implemented overnight, so it is an *adjudication
   between two implementations*, and Charter §4.6 forbids the overnight author approving it.
6. **Is a sandboxed probe-running worker lane authorized at all?** **Recommend NO.** ~1.2 GB of
   installed deps + a built variant + exclusive port 8080 + GPU-backed Edge per worker, WebGPU adapter
   acquisition under a low-privilege sandbox user unverified, and prior background probe runs already
   implicated in a machine-level crash. Probes stay orchestrator-serialized; workers request them and
   receive artifacts.

---

## 10. Unverified — what this design still assumes

1. **Codex's effective write roots cannot be enumerated read-only.**
   `~/.codex/.sandbox/setup_marker.json` records `"write_roots": []` and the log reports only a count.
   Settle with a four-step escape experiment on a *scratch* worktree and clone: `git commit
   --allow-empty`; append to `<main>/.git/description`; write `<main>/.git/hooks/post-commit`;
   `git --git-dir=<main>/.git update-ref refs/heads/zz-probe HEAD`. **Bank the result before any
   dispatch.** Until then the worktree disqualification rests on the `.git`-file indirection alone —
   which is independently verified.
2. **What `[windows] sandbox = "elevated"` actually grants** is Codex-side and invisible to
   repo-readable state. Same experiment.
3. **Whether a low-privilege sandbox user can obtain a WebGPU adapter** is unverified — one reason §9.6
   recommends refusing the probe lane.
4. **Whether a pinned `core.hooksPath` fires the guard from a landing clone** is inferred from reading
   `.husky/_/h` and `.husky/pre-push:27-34`, not executed. Settle with a deliberate negative test:
   push a malformed subject from the landing clone to a scratch remote and require refusal.
5. **`git merge --squash` authorship/date behaviour** is asserted from documentation, not run.
   Settle in a throwaway clone with `git log -1 --format='%an %aI %cI'`.
6. **Whether dirty main can fast-forward after a landing** has never been exercised. B1041's paths
   overlapped main's dirty set **5 of 5**, so the path-lease mechanism is the load-bearing assumption
   in §9.2(i).

---

## 11. Cross-references

- [`ORCHESTRATION_HANDBOOK.md`](ORCHESTRATION_HANDBOOK.md) — the patch-export/selective-staging
  procedure this document **supersedes** for worker handoffs.
- [`EXECUTOR_LANE_CHARTER_2026-08-14.md`](EXECUTOR_LANE_CHARTER_2026-08-14.md) — binding rules;
  §1.7 validation manifest, §4 pause protocol, §4.6 non-author review.
- [`CODEX_SOL_OPERATING_BRIEF.md`](CODEX_SOL_OPERATING_BRIEF.md) — who to assign to what, and why.
- [`MAINTAINER_RULINGS_2026-08-14.md`](MAINTAINER_RULINGS_2026-08-14.md) — R-2026-08-14-7 governs
  §9.1.
- [`CAMPAIGN_STATE.md`](CAMPAIGN_STATE.md) — the three sibling worktrees are inventoried there with
  "Decision owed" recorded against them.

## Machine-lane caveat: clone Karma executes the MAIN tree engine (2026-08-21)

Worker clones link `node_modules` (and `packages/sandcastle/node_modules`) from the main tree by junction, and `node_modules/@cesium/engine` is itself a link back into the MAIN repo `packages/engine`. The combined Karma lane bundles the engine IIFE through that link, so a Karma run inside a clone executes the MAIN tree engine sources, not the clone edits - a clone-side engine fix is invisible to that suite, and was proven so with a runtime function-identity probe. Spec files bundle from the clone and ARE the clone own. Consequence for acceptance runs: a clone Karma run certifies main engine + clone specs; to test a clone engine edit under Karma, either land it first or repoint the engine link for the run and restore it after.

**STATUS UPDATE (2026-08-21, lane P slice 0 landing).** `Tools/verify-tracked-references.mjs` now EXISTS and is tracked: section 5 row 9's assertion is mechanical (run it in the clean-clone smoke, or as `--rev <tip>` against the candidate commit; exits 0 clean / 1 violations / 2 error / 3 structural from the shared exit table). Its worktree mode deliberately sweeps launch targets in the full `package.json`/`.mcp.json` plus relative imports in every changed file, so in a dirty tree it reports other in-flight lanes' untracked modules - until the tree is clean, invoke it only against a candidate tree (`--rev` or a clean clone), per the adopted A2 disposition (scoped first, whole-tree walk when clean). `Tools/verify-landing-content.mjs` and `Tools/verify-branch-inventory.mjs` remain PROPOSED - NOT ON DISK; section 5 rows 1 and 11 describe intended procedure, and their assertions continue to be performed by hand and recorded as manual in landing notes. When staged-set equality is built, it lands as a regression anchor against a future path-list staging mechanic, not as a live landing-defect detector - under whole-tree `git add -A` it is green by construction.

**EVIDENCE REPATRIATION (maintainer rule, 2026-08-21).** Before a worker clone,
worktree, or local branch is reset, retired, or deleted, the orchestrator copies any
high-quality visual evidence it produced - probe PNGs, pixel-diff images, capture
reports - into the main repo's gitignored Tools/visual-regression/output/ folder,
preserving the probe's own subdirectory layout. Certification-grade artifacts
additionally bank in the immutable cesium-webgpu-visual-evidence repository as
before. A clone reset that discards unrepatriated evidence is a handoff defect.

### 8d. A lane under review is read-only for everyone (added 2026-08-29)

Three times on the night of 2026-08-28/29 a lane's worktree was written while its station-3
reviewer was still measuring it: once by the lead waking on a late verifier result (CW2), once by
the lead fixing a defect the reviewer's own probe surfaced (SC2), and once by the lead applying
fixes the seat relayed after the reviewer's FIRST stop notification while the reviewer's background
job was still finishing and its report was not yet on disk (Q-62). Every case was benign by
content; none was benign by process - a review that certifies bytes which no longer exist is
worse than no review, and nothing in the workflow would have caught a write to the fixed line.

Rules:

- From reviewer dispatch until (a) the reviewer's report file exists on disk and (b) the reviewer
  reports no live background children, the lane's clone is READ-ONLY for the lead, for the seat,
  and for the reviewer outside its declared scratch directory.
- The seat relays review fixes to the lead only after (a) and (b); the lead acknowledges the
  freeze explicitly before any reviewer is dispatched.
- Every reviewer re-hashes the reviewed tuple set at the END of its pass and reports any drift as
  a finding; the seat re-hashes every deliverable file against the reviewed tuple before landing.
- Retirement of a clone waits for the same two conditions (see 8c and the 2026-08-29 water-clone
  incident): a clone is quiescent only when the lane AND every reviewer that entered it have no
  live children; test with a root rename before rm.

### 8e. Worker naming - every agent is a Tolkien character (maintainer directive, 2026-08-29)

The maintainer tracks a dozen concurrent lanes by name; row ids and agent ids are not
memorable, a character is. From 2026-08-29 every dispatched worker, reviewer, executor and
scoping agent carries a unique name from Tolkien's legendarium, and that name IS the lane's
identity everywhere it appears:

- the Agent description prefix (`Samwise: lane INSTR4 - Q-127/129/133`);
- the clone directory (`F:/Dev/GH/cesium-lane-samwise`);
- the packet filename (`_lane-out/LANDING_PACKET_SAMWISE.md`) and review filename;
- every ledger row (`| Samwise (INSTR4) | ... |`) and every status line to the maintainer.

Rules: a name belongs to one lane for its whole life (dispatch -> review -> landing ->
retirement); a resumed agent keeps its name; a new lane never reuses a name already in the
registry, even after retirement, so the ledger stays unambiguous. Names are drawn by role so
the name also signals the tier: Opus lane leads from the Men and Elves of the West (Aragorn,
Faramir, Boromir, Eomer, Theoden, Beregond, Glorfindel, Elendil, Gil-galad, Beren, Turin, ...);
Opus station-3 reviewers from the wise (Elrond, Galadriel, Cirdan, Celeborn, Thranduil,
Erestor); Edge executors from the keen-eyed and the Company (Legolas, Eowyn, Gwaihir, Bard,
Beorn, Radagast, Thorin, Balin, Dwalin, Gimli, Gloin, Oin, Bifur, Bofur, Bombur, Dain); Sonnet
bounded workers from the Shire (Samwise, Frodo, Merry, Pippin, Bilbo, Fredegar, Folco, Hamfast,
Rosie, Barliman, Tom Bombadil, Goldberry, Farmer Maggot); read-only scoping and drainage agents
from Fangorn (Treebeard, Quickbeam, Bregalad). The Fable orchestrator seat is Gandalf. The
authoritative registry of used names lives in the seat's memory file
`feedback_tolkien_worker_names.md` and is checked before every dispatch; when a pool runs dry
it is extended from the same legendarium, never from another author.
