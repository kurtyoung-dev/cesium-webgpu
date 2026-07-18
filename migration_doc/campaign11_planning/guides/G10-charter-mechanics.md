# Campaign-11 Cluster Guide G10 — Gated-tail / arch-seed dossiers + THE CAMPAIGN OPERATING CHARTER

**Register:** `CANDIDATE_REGISTER.md` §19 (`gated-reversed-z`, 3 items) + §22 (`arch-seeds`, 4 items) +
the four curated cross-cluster next-campaign seeds (§14 seeds 2/3/7 + §22). · **Register sweep HEAD:**
`aef553d592` (Batch 698).
**This guide verified against HEAD:** `9204647535` (Batch 701, `main`, 2026-07-18). Working tree at
authoring time: `main` ONLY (no safety/feature/worktree branches), 0 unpushed commits
(`git log origin/main..main` empty). A C10 worker is editing engine files concurrently — every line
anchor below is a **hint; the symbol + shape is the anchor** — re-grep before acting. This guide
touches NO engine code; it is the campaign's operating manual.

**House rules carried over verbatim in spirit (CLAUDE.md — do not weaken):** no feature
removed / hidden / default-disabled / bypassed / visually degraded for a metric (safety containment is
correctness work, not a perf win); rule-3 conservatism (unknown demand keeps the conservative
behavior); probe-first (Principle 8 — never ask the user to re-verify what a probe can verify); one
concern per slice; perf evidence = moving-altitude clean+API lanes only (idle-soak/FPS INVALID);
premise-verify-first on EVERY item; no absolute planetary ECEF `f32` before camera subtraction (incl.
previous frames + GPU culling data); Edge/Chromium only for browser automation (Playwright Firefox
has no WebGPU); ledger discipline (a missing ledger update is a landing defect); Branch Transparency
(surface branch state proactively); push/commit as **kurtyoung-dev**.

**Why this guide is the load-bearing one.** `_PLANNING_STATUS.md` names it "the highest-value missing
piece." G1–G9 tell a worker HOW to execute one cluster. G10 tells a **fresh Opus or Sol** how to
BE the campaign — prepare work, dispatch it, review returned diffs, land them, survive a
session-limit kill, and (if needed) hand the whole thing to an autonomous engine script. Read Part B
before you dispatch a single brief.

---

# PART A — Gated-tail + arch-seed dossiers (shorter form)

These are NOT openable inside a normal C11 wave. Each carries an explicit gate. They are recorded so
the C11-00B intake (Part B §6) and the `C10-30`/C11 measured checkpoint can point at them, and so no
worker re-scopes them from scratch. **The reversed-Z decision chain is CARRIED, not re-litigated** —
the C10-13 spike verdict (once it exists) redirects this whole cluster; nothing here re-opens the
spike's design.

## A1. `C10-13-REVERSED-Z-EARLYZ-SPIKE` — the measurement gate (gated tail, openable) — P1, S, perf/tooling

**Decision chain (carry, do not re-scope).** Reversed-Z and the pick-fleet log-depth conversion
(`NEW-WEBGPU-PICK-FLEET-LOG-DEPTH`, owned by `C10-11`) pull the **same 71-file producer surface in
opposite directions**: log-depth adds `@builtin(frag_depth)` log encoding to every producer; reversed-Z
would DELETE all of it in favor of `depth32float` + `greater-equal` + infinite-far. Doing both is
wasted work in one direction. The spike is the cheap evidence gate that decides which direction the
fork commits to.

**What it is (measurement-only; nothing lands on `main` but a report).** Compile ONE probe scene
(horizon-oblique globe + dense tiles — the weak-FPS view where early-Z matters) with `defines=0`
hyperbolic `//>>else` branches PLUS reversed-Z infinite-far + `depth32float` + `greater-equal`, and
measure the fragment-invocation / `gpuPassCost` delta vs the default log-depth path across the 71
producers. GO threshold = **≥20–30% fragment-work reduction** on weak-FPS views (register §15.6).

**The mandatory record (this is the load-bearing output).** The spike's GO/NO-GO MUST be written into
**BOTH** `NEW-WEBGPU-PICK-FLEET-LOG-DEPTH` **and** the FAR-707 brief **and** `DEFERRED_WORK.md`
**before** the pick fleet's log-depth conversion is treated as permanent. If the spike is GO, the fork
should convert the pick fleet directly to reversed-Z `f32` and knowingly skip/undo the `C10-11`
log-depth conversion; if NO-GO, log-depth is the permanent pick-depth contract and reversed-Z is
retired. **Openable only after** the `C10-30`/C11 measured checkpoint verdict AND fresh maintainer
sign-off.

**Intake note.** At C11 launch, read the live C10 ledger: `C10-13` may already have run (it is
"NOT STARTED, gated" at the register sweep). If it ran, its verdict is a C11-00B intake fact and this
dossier is closed to a record; if not, C11 inherits it as an openable gated-tail item.

**Model tier + effort:** **fable**, S — diagnostic/measurement judgment (build the spike scene, read
`gpuPassCost`, write the verdict), zero production code.

## A2. `C10-GT-REVERSED-Z-SLICE-B` — the all-or-nothing convert (DEFERRED — do not schedule) — P2, XL, perf

**Do not schedule.** This is the full reversed-Z landing behind a single `_reversedZEnabled` master
switch (OFF = byte-identical). Recorded here so nobody re-derives its scope.

**Openable ONLY after all of:** (1) `C10-01` landed — frustum-count parity claim carved out (DONE,
Batch 693); (2) `C10-13` spike returns **GO** (≥20–30% fragment-work reduction on weak-FPS views);
(3) the pick-fleet reconciliation decision is **recorded** (GO ⇒ pick fleet converts directly to
reversed-Z `f32`, the `C10-11` log-depth conversion skipped/undone knowingly); (4) a **written
`depth32float-stencil8` fallback story covering every supported adapter tier** — any tier left behind
is a forbidden dual permanent architecture = automatic NO-GO; (5) the `C10-30`/C11 checkpoint verdict
+ fresh maintainer sign-off.

**Scope of record (guide-level; XL, all-or-nothing landing):** retire 71 producer `.wgsl` `LOG_DEPTH`
surfaces; flip 140 `depthCompare` sites across 47 files + `clearValue` 1→0 behind the single master
switch; re-linearize 42 `_logDepthEncodeNearFar` JS sites + ~14 depth-consumer families; **delete the
RGBA8 depth-pack ecosystem** (`WebGPUGlobeDepth` / `WebGPUPickDepth` → `r32float`/direct depth — the
unowned prize is 2–3 fullscreen pack passes/frame, a `gated-reversed-z`-only win that no other cluster
can claim); TAA `previousViewProjection` carries the flip; 2D/CV/ortho carved out (reversed-Z can
never help those modes); RTE high/low untouched. Precision is resolved (~2 cm @ 350 km).

**Trap:** if `C10-13` is GO and this ever activates, the RGBA8 pack ecosystem that `S7-2`/`S2-5`
(cluster `attachment-topology`) optimize is slated for DELETION — those slices are still worth landing
near-term (small diff, real win) but the orchestrator must sequence them BEFORE any reversed-Z
commitment and mark them superseded-by-design there.

**Model tier + effort:** **opus/sol** (well-specified once the gate opens; the brief will contain the
answer), XL — multi-batch epic, not a single slice. Not for C11 unless the gate chain completes.

## A3. `C10-03R-MSAA-DEFAULT-FLIP-RESERVE` — reserve lever (CONDITIONAL NOT TRIGGERED) — P3, S, perf

**Not ratified; reserve lever only.** Backend-conditional WebGPU default `msaaSamples` 4→1 (one line
at `Scene.js:488`/bridge; WebGL untouched; user opt-in preserved). **MSAA-4 default is visual policy
(CLAUDE.md Rule 1)** — any slice that flips it without recorded sign-off is reverted on sight.

**Pull ONLY on** a `C10-30`/C11 checkpoint **MISS** WITH **bandwidth-attributed evidence** (GPU-timestamp +
counter data implicating attachment traffic, NOT CPU) AND **fresh maintainer sign-off recorded in the
ledger**. Then: the one-line flip + release note + visual-policy gate probe + moving-altitude
on/off/restored. This is a metric-driven visual-default change — it is the single most tightly-gated
lever in the campaign; treat the sign-off protocol as mandatory, mirroring the C10 ruling of record
(§2 (c)).

**Model tier + effort:** **opus**, S — mechanical once triggered, but the trigger is a maintainer
gate, not an engineering decision.

## A4. Arch-seed — `S1-6` frame-delta retained-commandList tier (NEXT-CAMPAIGN seed) — P1, XL, perf

**Openable only after:** C9-11/C9-17 retained packets exist to be reused (incl. `C9-17` Slice D), and
a benchmark lane that can see the win. **This is the register's contradiction #3:** without a reuse
tier between "skip whole frame" and "recompute everything," backend wins cannot deliver ≥2× at p95 on
CPU-bound hosts — there is a **~4–5 ms avg / 8–10 ms p95 command-count-independent shared-frontend
floor on BOTH backends** (a 2 m camera move re-runs tile selection, environment, height plumbing, PVS,
preload, ephemeris exactly like a content mutation). Build a frame-delta classification (cameraDelta
tier × contentRevision tier) so a tiny camera move reuses last frame's command graph.

**Why it is a seed, not a slice:** `C10-10`'s true shadow-caster revision-maintenance and the `S1-1`
WebGL-lane globe derived-command regen both wait on this. It is a multi-batch architecture arc.
**Model tier:** **opus/sol** for execution once the retained packets exist; the design decision
(delta classification taxonomy) is a **fable**-shaped diagnostic first. Effort XL.

## A5. Arch-seed — Worker-renderer productization (NEXT-CAMPAIGN seed, strategic HIGH) — P2, XL, infra

**Openable only after:** a benchmark-lane quantification (add a worker lane to the moving-altitude
route). A complete render-in-worker OffscreenCanvas stack ALREADY EXISTS (`RendererWorker.js` 774 LOC +
`WorkerSceneHost.js` 835 LOC + protocol) with only a test page as consumer — it is the **ONLY shipped
mechanism that structurally raises the main-thread CPU ceiling** (every other lever chips at work
below that ceiling). Add the worker lane, prove the delta, then productize opt-in
`Viewer({useWorkerRenderer:true})`. Either way exercise it in CI/probes — API drift grows until it is.

**Trap:** this is the one seed whose payoff can exceed every in-cluster slice combined on CPU-bound
hosts, precisely because it moves the ceiling instead of the floor. Do not let it rot for another
campaign uncharacterized. **Model tier:** benchmark lane = **fable** (tooling/judgment); productization
= **opus/sol** (well-specified). Effort XL (the seed's own S5-3 row estimates L for just the lane).

## A6. Arch-seed — Entity-at-scale arc (S10 umbrella) (NEXT-CAMPAIGN seed) — P1, XL, perf

**Openable only after:** the **10k-entity benchmark lane exists** (register §14 seed 3 prerequisite —
"build the lane first"). Every S10 finding is invisible to today's gates because no campaign scene
contains entities. The arc: the Entity/DataSource per-entity per-frame cost does not scale (dynamic
lane is O(N × 10–35 megamorphic Property reads)/frame with no dirty-tracking on BOTH backends; 10k
dynamic = 3–15 ms CPU floor; `cluster.enabled` routes EVERY entity to the legacy O(N) lane by
construction; `GeometryUpdaterSet` mints 10–11 updaters + ~13 Events per entity even with no
geometry). Concrete findings = the `S10-1..S10-9` rows in cluster `entity-scale`.

**Why it is a seed:** deliberately not opened in C10; it is a whole C11-or-later arc (visualizer
batching, property-evaluation memoization, incremental declutter, GPU projection). **The lane is the
gate** — a cheap **fable**/tooling prerequisite; the S10 slices are **opus/sol** execution after. Effort XL.

## A7. Arch-seed — Geometry-residency dedupe (NEXT-CAMPAIGN seed) — P1, L, perf

**Openable only after:** a typedArray-release policy that preserves documented readers (edge
visibility, 2D, picking) is written — release before that is silent visual corruption. ALL model/tile
geometry is resident **3×** today (loader-uploaded stub `GPUBuffer`s the FR never binds + force-retained
CPU typedArrays + the FR's second unbudgeted in-render-loop GPU upload): ~500 MB tile geometry →
~1 GB GPU + ~500 MB JS heap, crossing the bus twice. Target: a single canonical GPU copy (FR adopts
the stub buffers OR a budgeted content-processing build) + typedArray release after build. Subsystem-
distinct from `C9-15` terrain residency (different owners). GPU-dedupe scope is effectively NEW.

**Model tier:** **opus/sol** (well-specified once the release policy is written); the release-policy
audit is **fable**-shaped. Effort L.

**Remaining seed inventory (recorded, not dossiered):** `S5-2` WASM acceleration consume-or-retire
(5/7 bridges dead, ~1,535 LOC — Principle-7 per-bridge disposition, no silent deletion);
`NEW-VEGETATION-SYSTEM` (FUTURE, design complete, zero code, V1 cutline pinned B653);
`C10-08b` model define-width expansion (unblocks the 6–7 parked model-shader specialization axes);
`FAR-200` private-submit-timeline consolidation. All FUTURE/seed — surfaced so the checkpoint verdict
can point at them, none C11-schedulable without their gate.

---

# PART B — THE CAMPAIGN 11 OPERATING CHARTER (takeover manual)

Written so a fresh **Opus OR Sol** can take over COMPLETELY — as a worker OR as the ORCHESTRATOR
itself. If you are reading this cold, you are (or are about to be) the orchestrator seat. Start at §8,
then come back and read §1–§7 before dispatching anything.

## B1. The operating model

Campaign 11 runs in **ORCHESTRATOR mode** (the same model C10 launched under, 2026-07-18), NOT the
autonomous engine-script mode. The engine script (`§7`) is the fallback if the human-driven main loop
must go dark.

- **The orchestrator (Fable, the main loop) = work-preparer + acceptance-reviewer.** It prepares each
  brief, dispatches a model-matched worker, reviews the returned diff, and **lands** it. The
  orchestrator is the ONLY actor that commits, pushes, and flips ledger rows.
- **Workers are model-matched and NEVER commit.** A worker implements against a prepared brief, builds,
  runs the acceptance probe, reads the PNGs, proves the off-gate, runs standing regression probes,
  and RETURNS a diff + evidence — on a **dirty tree** (the leave-dirty contract, §2). It does not
  `git add`, `git commit`, or `git push`. If it cannot finish, it reverts to a clean tree and returns
  an honest-partial/blocked report (optionally leaving one `DEFERRED_WORK.md` finding).
- **Model matching (the tier table is §5):** **fable** for diagnostic / ambiguous / bisect work where
  "the agent must FIND the answer"; **opus / sol** for well-specified execution where "the brief
  contains the answer." Audits on shader-math or byte-identity-critical slices may pin a
  `fable` auditor even on an opus task.
- **Separation of duties is the safety property.** The worker changes code; a distinct adversarial
  reviewer (a fresh agent or the orchestrator itself) verifies it against the ACTUAL `git diff`; the
  orchestrator lands only on a GO. No single agent both writes and blesses its own work. (This mirrors
  the engine's IMPL → AUDIT → LAND separation, §7.)

**Why this model and not the engine script:** the maintainer directs the campaign live; the
orchestrator can re-sequence waves, escalate a blocked premise, and fold in maintainer rulings between
slices. The engine script trades that adaptivity for unattended throughput — use it only when the
human loop is unavailable (§7).

## B2. The dispatch → review → land loop, in full

### B2.1 Preparing a brief (before dispatch)

A brief is prepared by the orchestrator and MUST carry, in this order:

1. **Premise-verify-first, as step 0 of the worker's task.** The brief tells the worker to confirm the
   defect/opportunity still reproduces at execution HEAD **before** implementing. Register magnitudes
   are stale (many predate `C10-01`/`C10-03` — the register says so explicitly); a "fix" for a bug
   that no longer exists is a revert. If the premise is stale, the worker files a regression probe +
   doc reconcile and returns `premiseStale=true` rather than inventing work.
2. **`file:symbol` anchors, never bare line numbers.** Line numbers are hints ("re-grep every
   symbol"). Give the worker the symbol, the shape, and the cluster-guide section (G1–G9) that owns
   the item. Cross-reference `FEATURE_INVENTORY.md` for the affected subsystem coupling BEFORE the
   worker writes code (CLAUDE.md Principle 6).
3. **Acceptance oracles — the probe(s) that prove it, named up front.** Every slice lands on its own
   oracle. Correctness/parity slices land on a semantic+visual probe regardless of timing.
   Perf slices additionally carry an on/off/restored moving-altitude clean+API oracle. The banner
   rule (§B2.4) is stated in the brief so the worker knows a truthful miss is a VALID COMPLETE result.
4. **A machine-safety block (§3), verbatim in every brief.** ONE Edge at a time; kill orphan
   `msedge`; 5-min probe watchdog; skim any generated script for unbounded loops before running;
   dev server on `:8080`; moving-altitude route is the only valid perf evidence.
5. **The leave-dirty contract (§B2.2).** The worker returns a dirty tree; it does not commit. It
   states exactly which files it changed and which it left untouched.
6. **The standing rulings + kill-switch requirement.** No feature degradation for a metric; unknown
   demand stays conservative; OFF-path byte-identical with a named kill switch; the ledger-row
   mandate (the worker drafts the row text; the orchestrator commits it WITH the code, §B2.5).

### B2.2 The leave-dirty contract

The worker's deliverable is a **verified, uncommitted diff**. It runs `npx eslint` + `npx tsc
--noEmit` + `npx gulp build`, runs the acceptance probe and READS the output PNGs, proves the
off-gate (OFF build byte-identical, or an honest justification for GO+non-byte-identical on an
unconditional parity fix — §B2.3), and runs the standing regression battery. It then STOPS with the
tree dirty and reports. **It never stages, commits, or pushes.** If it cannot land honestly, it
`git checkout`s its changes back to a clean tree, and returns `blocked=true` with a `blockReason`
(and optionally a single `DEFERRED_WORK.md` durable-blocker record as the only leave-behind). Clean
tree on failure is a hard requirement — the next slice must launch clean.

### B2.3 Reviewing a returned diff

The orchestrator (or a dispatched adversarial reviewer) verifies against the ACTUAL `git diff`, not
the worker's prose:

- **Spot-read the risky hunks.** Shader-math changes, depth-compare/blend-state changes, cache-key
  changes, RTE packing, pipeline-topology changes — read these lines. A worker's summary can be
  optimistic; the diff cannot lie.
- **Verify oracles STRENGTHEN, never weaken.** A probe that now passes because its threshold was
  loosened, its ROI shrunk to avoid the artifact, or its assertion deleted is a NO-GO. An acceptance
  probe that passes WITHOUT reaching the new code is a NO-GO (the engine's `onParity=false` check).
- **Confirm no feature degradation.** Cross-check the change did not remove / hide / default-disable /
  visually weaken any feature to move a metric (CLAUDE.md Rule 1). Unknown demand must still keep the
  conservative path (Rule 3). If the diff deletes "dead" scaffolding, apply Principle 7 (cross-
  reference the file docstring + `DEFERRED_WORK.md` + batch comment before accepting the deletion).
- **OFF byte-identity.** The OFF/kill-switch path must be byte-identical (pixel/module evidence). The
  documented exception: an **unconditional parity bug-fix** (no toggle exists; the default-path change
  IS the fix) may be GO with `offByteIdentical=false` PROVIDED all UNRELATED paths are proven unchanged
  and the fix is genuinely justified. Do not use this exemption to smuggle a behavior change.
- **Honest-partial is acceptable.** A truthful miss with green mechanics — correctness oracles pass,
  the structure changed as designed, the perf number is honestly below the banner bar — is a VALID,
  COMPLETE result. Record the honest number; claim no banner. A BLOCKED premise (the defect doesn't
  reproduce, or the work is gated on missing functionality) is also a valid outcome — surface the
  missing piece as the next work item (Principle 9), do not paper over it with an inline hack.

### B2.4 The reject-with-findings loop

On a NO-GO or GO-WITH-FIXES-with-unresolved-blockers, the orchestrator does NOT silently re-implement
the work itself. It **`SendMessage`s back to the SAME worker** (preserving that worker's context) with
a precise fix spec: what failed, which oracle, the exact hunk, and the acceptance bar for the retry.
Scope the fix message — no scope creep. Re-review the returned diff the same way. Escalate to the
maintainer only if the blocker is a design/ruling decision (a maintainer open question, §"OPEN
QUESTIONS"), not an execution defect.

**Trust the verdict, not the sub-flags.** When an adversarial reviewer returns GO, do not veto it on a
boolean sub-flag (`offByteIdentical=false`, `webgpuExceedsAcceptable`, `onParity`) — those are the
reviewer's INPUTS, not your veto. The only hard stops are `noRegression === false` and an unresolved
GO-WITH-FIXES blocker. (Four false reverts in prior campaigns came from vetoing a GO on a sub-flag.)
A dead reviewer agent (null return) is RETRIED ONCE, never treated as a NO-GO — a dead review must
never revert probe-verified work (the B18 lesson).

### B2.5 Landing (the orchestrator's exclusive act)

Only the orchestrator commits, and only on a GO. The landing sequence:

1. `gh auth switch --user kurtyoung-dev` (a **403 on push = wrong active `gh` account** → re-switch +
   retry, never ask the user; this fork must commit/push as kurtyoung-dev, not KurtTrottr).
2. **Stage EXACTLY the task files** — source + `.wgsl` + the acceptance probe + doc reconcile + the
   ledger-row edit. NEVER stage generated shader `.js`, scratch/debug files, or
   `Tools/visual-regression/output/`.
3. **Batch number N = (highest `Batch NNN` in `git log --oneline -10`) + 1** — monotonic from git log,
   never reset, never guessed.
4. Commit message: `Batch N: <TASK-ID> — <what/why>` with the probe evidence + off-gate result inline,
   ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. **NEVER `--no-verify`** — fix
   a hook failure (lint-staged OOM on big commits → serialize with `--concurrent 1`, revert after),
   never bypass it.
5. `git push origin main`; confirm clean `git status` and `git log origin/main..main` empty.
6. **The ledger row flips WITH the code, IN the same commit** — status (COMPLETE / PARTIAL-PAUSED /
   BLOCKED / DEFERRED) + the evidence (probe names, PRE→POST numbers, banner claim or honest miss,
   rollback boundary). A landed slice whose ledger row is not updated in the same commit is a landing
   defect. This is what makes the campaign resumable and auditable.

**Batch discipline note:** the C10 ledger rows read "COMPLETE (impl+verify; pending orchestrator land)"
for slices that HAVE since landed (`C10-01` Batch 693, `C10-03` Batch 697, `C10-02` Batch 699) —
that phrase is the worker-returns-dirty state before the orchestrator lands. Trust `git log`, not the
queue doc's last-saved row text.

## B3. Machine-safety rules (verbatim into every brief)

The 2026-07-06 VSCode crash (a background WebGPU/Edge probe spiked resources) is why these are
non-negotiable. Machine = **32 GB RAM**.

- **ONE Edge at a time.** Never run two probes, or two perf lanes, concurrently. Serialize. If a probe
  hangs, kill orphan `msedge` processes before the next launch.
- **5-minute probe watchdog.** Any probe that has not produced output in ~5 minutes is killed and
  investigated, not left spinning.
- **Skim every generated script / agent probe for unbounded loops BEFORE running it** — `while (true)`,
  unbounded recursion, `Date.now()`/`Math.random()` spin loops, uncapped retry. A background probe
  with an unbounded loop can crash the machine. `node --check` every generated artifact first.
- **Dev server on `:8080`.** `curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/Apps/CesiumViewer/index.html`
  → 200; `node server.js` (background) from repo root if down. Probes use
  `PROBE_BASE=http://localhost:8080`.
- **The moving multi-altitude camera track is the ONLY valid perf evidence.** Idle-soak / FPS is
  INVALID under request-render mode (CLAUDE.md campaign header). Runner:
  `Tools/visual-regression/run-performance-campaign.mjs --workload moving-camera-altitude-track-3d
  --repetitions 5 --renderer both`; clean lane is the verdict lane; `--api-instrumentation` is a
  separate attribution lane and is NOT timing evidence; never `--reuse-browser` for a checkpoint;
  fresh Edge process per run; offline boot. Do NOT edit the workload/track/runner to "help" a
  measurement — that silently forks the protocol from the anchor.
- **Edge/Chromium only** (Playwright Firefox has no WebGPU). Do not substitute Python tooling for the
  camera campaign.

## B4. The salvage playbook (on a session-limit / credit kill)

When a session dies mid-slice (Fable "out of usage credits" / session-limit, or an orchestrator
process is killed), work is at risk in three places: unpushed commits, a dirty worktree, and
scratchpad-only artifacts. Recover in this order.

### B4.1 The plumbing-snapshot pattern (worktree untouched)

To capture the exact current state (staged + unstaged) as a recoverable ref WITHOUT moving `HEAD` or
disturbing the worktree — this is precisely what the Batch-701 planning salvage used:

```
git add -A
TREE=$(git write-tree)                                   # write the index as a tree object
SNAP=$(git commit-tree "$TREE" -p HEAD -m "salvage snapshot: <taskid> <UTC>")
git branch salvage-<taskid>-<YYYY-MM-DD> "$SNAP"         # a real ref you can return to
git reset                                                # mixed: un-stage; WORKTREE FILES UNTOUCHED
```

The worktree is untouched at every step; you now have a `salvage-*` branch holding the full snapshot
and a still-dirty tree to keep working from or to clean. **Surface the branch name to the maintainer
immediately** (Branch Transparency) and commit to a deletion plan (delete after the work lands on
`main` and verifies green, pending user approval — e.g. `sol-backup-2026-07-16` awaited user deletion
approval; never delete a backup branch yourself).

### B4.2 Salvage abandoned WIP, clean for the next slice

- `git log --oneline -15` → highest landed batch + which task IDs landed. `git log origin/main..main`
  → **unpushed commits are invisible debt — resolve them FIRST** (push as kurtyoung-dev).
- `git status --porcelain` → attribute every dirty file to a task via the ledger + `DEFERRED_WORK.md` +
  file content. Copy orphan WIP (files + `git diff > salvage.diff`) to the scratchpad under
  `salvage-<taskid>-wip/` (precedent: `salvage-lake-wip/`), THEN `git checkout -- <files>` + delete
  stray untracked task files. Verify `git status` clean + `npx tsc --noEmit` green.
- Lost source is recoverable from `Build/CesiumUnminified` (it is the built copy of the tree) if an
  audit/verify subagent `git restore`d uncommitted work — snapshot/commit before any broad audit.

### B4.3 Copy scratchpad artifacts into the repo before they die

The scratchpad is **session-specific and isolated** — a ~2M-token planning sweep, a set of authored
guides, or a salvage diff living only there VANISHES at the session boundary. **This very planning
folder is the precedent:** Batch 701 (`C11-PLANNING-SALVAGE`) copied the in-progress Campaign-11
planning sweep out of the scratchpad and into `migration_doc/campaign11_planning/` as a doc-only WIP
commit precisely so it would survive Fable hitting its usage limit mid-authoring. If you produce
durable planning/authoring output in the scratchpad, land it (doc-only, clearly marked WIP) before
the session can end.

### B4.4 Workflow resume semantics (if an engine run was mid-flight)

If a `Workflow` engine run (§7) was driving the campaign when the kill happened, it resumes by
`resumeFromRunId` — the harness replays cached agent calls whose **`(prompt, opts)` identity is
byte-identical** and runs live only from the first uncached call. Therefore: **edit ONLY unfinished
task entries** (flip them to a live model, or add a one-line salvage pointer to a single brief). A
completed task's brief/model/effort/whitespace must stay byte-identical or the harness re-runs
already-landed work on a tree where it is already landed. **NEVER edit the CHARTER string, the
prompt-builder functions, or the schemas** — the CHARTER is embedded in every prompt, so any edit
invalidates EVERY cache including completed tasks. (The authoring workflow `wf_3c2df40b-079` replays
G1–G7 from cache and runs only G8/G9/G10 for exactly this reason; the C9 resume run was
`wf_f6cb6b3b-927`.)

## B5. The model-tier decision table

The dispatch decision is: does the brief contain the answer, or must the agent find it?

| Item class | Model | Rationale |
| --- | --- | --- |
| Well-specified execution against a landed cluster guide (mechanical port, gate wiring, cache-key widening, revision-skip) | **opus / sol** | The brief contains the answer; the agent executes. |
| Diagnostic / root-cause / bisect (a defect with no known cause; "which batch turned this red?") | **fable** | The agent must FIND the answer; diagnostic reasoning shape. |
| Ambiguous premise / stale-magnitude verify-first (is the register row still real at HEAD?) | **fable** | Judgment + investigation, not execution. |
| Shader math / RTE packing / depth-encode / byte-identity-critical | **opus/sol** to implement, **`auditModel: 'fable'`** to review | Adversarial numeric scrutiny on the review pass. |
| Measurement-only checkpoints + evidence-gathering probes (spike verdicts, payoff probes, benchmark lanes) | **fable** | Output is a verdict + artifacts, zero engine code; judgment task. |
| Structural-correctness / parity that lands on its own oracle regardless of timing (pick fleet, frustum-count parity) | **opus/sol** | Deterministic bar; the oracle decides. |
| Multi-batch epic / arch-seed (S1-6, S10 arc, geometry-residency) once its gate opens | **opus/sol** for the slices, **fable** for the upfront design taxonomy | Design = find-the-answer; slices = execute. |

Pin the tier in the brief. Audits default to the task's model; override to `fable` on shader-math /
byte-identity slices.

## B6. The C11-00B launch intake procedure

Run ONCE, at C11 launch, BEFORE the first slice. It converts everything still open when C10 closes
into owned C11 intake rows so nothing falls through the seam (the load-bearing bridge, exactly as
`C10-00B` was for C9→C10). **Re-sweep the LIVE C10 ledger** (`QUEUE_2026-07-16_CAMPAIGN10.md` §3.2) at
kickoff — the register sweep was HEAD `aef553d592` (Batch 698); the C10 tree has moved. Absorb, as
seeded ledger rows:

1. **The `C10-30` measured checkpoint verdict.** If C10-30 ran and MISSED, its per-stage attribution
   REORDERS C11 waves (the stage carrying the most unrecovered cost names the highest C11 lever) and
   is the trigger input for the reserve levers (`C10-03R`, `A3`) and the gated tail. If it PASSED
   (or never ran and C11 re-runs it), record the anchor: the C9-30 clean-r5 artifact
   (`campaign9-c9-30-checkpoint-clean-r5-2026-07-17.json`, WebGPU 5.20 / WebGL 5.31 ms whole-route
   CPU p95) — never re-derive a fresh baseline on the new tree; the Gate-A `B8015811…` fallback is
   WebGL 5.50 / WebGPU 7.51 ms. Target unchanged: **≥10% whole-route + ≥15% near-ground (seg 5+6)
   WebGPU CPU-p95 vs anchor OR >3× noise.**
2. **The boot chain `C10-06` / `C10-07` / `C10-08`.** `C10-06` outcome determines whether the `S8-4`
   FR-lazify rider is absorbed or becomes the standalone `build-boot` remainder; `C10-07` interacts
   with `S8-5`/`S3-7` module granularity (sequence after); `C10-08` gates `C10-08b` define-width
   expansion (the ShaderDefine registry is EXHAUSTED, bits 0–30 — any new define needs define-width
   work sequenced FIRST) and touches `TILE-ARCH-SHADER-STRATEGY`.
3. **The pick fleet `C10-11` / `C10-12` + the 5 W4 riders.** `C10-11` owns
   `NEW-WEBGPU-PICK-FLEET-LOG-DEPTH`; `C10-12` closes `C9-02B` + audits `P0-1` + flips
   `PICK_DEPTH_PLANE_ENABLED`. C11 picks up only what W4 leaves (the buffer-primitive-pick-dispatch,
   async-pick-readiness, compute-instance-pick-mirror, collection-2DCV-key, MSAA-flip-transition
   riders — each on its own oracle, no metric). **Verify the `C10-11` outcome AND its `C10-13`
   reversed-Z reconciliation record before treating the log-depth conversion permanent** (A1).
4. **The `C10-13` reversed-Z spike outcome.** Its GO/NO-GO redirects the entire `gated-reversed-z`
   cluster (A1/A2) and the pick fleet (same 71-file surface, opposite directions).
5. **The Batch-700 OIT NO-GO.** `M-OIT-COVERAGE-AND-FLIP-EVIDENCE` verdict = NO-GO (flip nothing).
   WebGPU MRT-OIT is unreachable for standard translucency: the accumulation path needs a
   `Pass.TRANSLUCENT` command carrying `_shaderCode`/`_oitPipeline`, but the only `_shaderCode`
   producers are Gaussian splats + the opaque globe, so `hasOITPipelines` is always false and the
   composite line has never executed. The real prerequisite is `NEW-WEBGPU-OIT-TRANSLUCENT-PRIMITIVE-
   WIRING` (wire translucent-primitive OIT pipeline variants) + the two live FAR-003 adjacencies
   (`NEW-WEBGPU-OIT-DEFERRED-SPLAT-CANVAS-RESUME`, `NEW-WEBGPU-OIT-MSAA-RESOLVE-ORDERING`). Also intake
   the pre-existing Batch-699 finding `NEW-WEBGPU-CUSTOMSHADER-TRANSLUCENCYMODE-ALPHA-UNDERAPPLIED`.
   Standing doc: `OIT_DEFAULT_FLIP_EVIDENCE_2026-07-18.md`. **The MRT-OIT default-off remains RATIFIED
   FAR-003 containment** (re-enable owner = FAR-003/T7; inactive until post-Gate-F stop/go) — do NOT
   flip it for a metric.
6. **The defaults-parity runtime-verification pass results.** `DEFAULT_PARITY_MATRIX_2026-07-18.md`
   catalogs 22 backend default divergences (5 visible-visual) feeding G8 — enhanced-ocean #1,
   night-lights, AutoExposure, background-color, the OIT flip (now NO-GO). Its runtime-verification
   plan results are C11-00B facts; each flip candidate that survives verification becomes a seeded row
   with the maintainer sign-off protocol attached (a default-visual flip is CLAUDE.md Rule 1 policy).
7. **The two Batch-699 findings that plausibly share one cause** (from `_PLANNING_STATUS`):
   `NEW-WEBGPU-TILE-FEATURE-TRANSLUCENT-COLOR-COMPOSITE` + `NEW-WEBGPU-B3DM-TILE-CONTENT-PICK-EMPTY` —
   `FLAG_HAS_FEATURE_ID_ATTRIBUTE` never set for b3dm content. Intake as ONE shared instrumented
   diagnosis before slicing either.

**Output of C11-00B:** the seeded §3.2 ledger + a one-paragraph launch note ("C10 landed X/N; fallout
intaken as M rows; C10-30 verdict = pass|iterate; C11 wave order adjusted by <attribution>") presented
to the maintainer BEFORE the first slice, with a `git branch -a` inventory. Resolve any
LAND-INCOMPLETE unpushed commits first; launch on a clean tree (`tsc` green).

## B7. The ENGINE-SCRIPT FALLBACK (if orchestration must go fully autonomous)

If the human-driven main loop must go dark (no maintainer at the wheel for an extended run), fork the
×5-hardened engine — `.claude/workflows/campaign-9-resume.js` (untracked by design; `.claude/` is not
committed, the queue doc is the durable record) — into a `campaign-11.js`. This is `C10-00`'s
deferred artifact, re-instantiated for C11.

**The five hardening properties (keep BYTE-IDENTICAL — never remove one):**

1. **`safeAgent` catch-to-null** (`campaign-9-resume.js:266`): every awaited `agent()` is wrapped in
   `.catch(→ log → null)`. A subagent that completes WITHOUT calling StructuredOutput makes `agent()`
   THROW, which killed a whole prior run (C7 resume-2 crash). Null degrades into existing handling.
   Never add a bare `await agent(...)` outside this wrapper.
2. **Audit-retry-on-death** (`:317`): a dead (null) audit is retried ONCE (the B18 lesson) — a dead
   audit must NEVER revert probe-verified work.
3. **`offByteIdentical` GO-escape** (`:198`, `:329`): the harness ACCEPTS a GO with
   `offByteIdentical=false` for an unconditional parity bug-fix (no toggle exists; the default-path
   change IS the fix) when all unrelated paths are proven unchanged. Do not let this become a
   behavior-change loophole.
4. **Trust-the-GO gate** (`:332–341`): `pass = audit && verdict !== 'NO-GO' && noRegression !== false
   && !(GO-WITH-FIXES with unresolved blockers)`. The boolean sub-flags are the auditor's inputs, not
   the engine's veto (four false reverts came from vetoing GO on a sub-flag).
5. **Substrate marker** (`:339`): `t.substrate` is retained as a no-op marker for task clarity — a
   prereq-substrate task returns `onParity=false` acceptably; keep the marker.

**Fork steps:**

1. Copy `campaign-9-resume.js` → `campaign-11.js`. **On a FRESH launch (not a resume), the CHARTER
   string IS editable** — there is no cache to preserve, so FIX the stale sentence in it: the
   module-cache key masks defines to **24 bits** is WRONG (the 40-bit full-define key landed Batch
   658; the key is `((defines >>> 0) * 0x100) + sourceId`). (Contrast §B4.4: on a *resume* you must
   NOT touch CHARTER because it would nuke every cache. The distinction is fresh-fork vs resume.)
2. Replace `meta`; splice the C11 `TASKS` array (wave order = the C11 queue §5), each brief carrying
   the CLAUDE.md hard-rules block + the queue/register/cluster-guide pointers + the promotion rule +
   the ledger mandate + verify-premise-first + the machine-safety block (§3). Keep `RESEARCH = []`
   (`:239`) unless C11 runs live research lanes.
3. Keep the schemas, all five prompt builders (impl/audit/fix/revert/land), `safeAgent`, and the
   per-task loop (budget guard `budget.remaining() < 100000` → `NOT-RUN-BUDGET`; dep-skip →
   `SKIPPED-DEP`; IMPL → AUDIT → optional FIX → re-AUDIT → LAND-or-REVERT) **byte-identical**.
4. Assign `model: 'opus'` (or `'sol'`) to every task with a landed cluster guide; `auditModel: 'fable'`
   on shader-math tasks (per §5). Batch numbering stays with the LAND agent (monotonic from `git log`,
   no reset).

**Validate before running (the forbidden-pattern scan — non-negotiable):**

- `node --check .claude/workflows/campaign-11.js`.
- Grep the script for **`while (true)`**, **`Date.now(`**, **`Math.random(`** (nondeterminism in
  scheduling), **unbounded recursion**, and any new **bare `await agent(`** not going through
  `safeAgent`. The shipped engine is clean on all of these; your diff must keep it so (the
  machine-crash-risk rule).
- **DAG validation:** every `deps` id exists, no cycle, the wave chain is intact.
- Diff-vs-pristine (keep a pre-edit copy in the scratchpad; the file is untracked): confirm the ONLY
  changes are `meta` + `TASKS` + context-doc pointers (+ the one-time CHARTER 24→40-bit fix on a fresh
  fork). Then launch via the Workflow harness with a NEW run id (a resume uses `resumeFromRunId`; a
  fresh campaign does not).

## B8. How to assume the orchestrator seat COLD (first-session checklist)

A fresh Opus or Sol taking the seat, in order:

1. **Read, in this order:** `_PLANNING_STATUS.md` (current resume state + what remains) → **this
   charter (G10)** → `CANDIDATE_REGISTER.md` (the 188-item / 22-cluster scope + the UNKNOWNS/standing-
   policy tail) → the relevant cluster guides G1–G9 for the wave you are about to run.
2. **Branch inventory (Branch Transparency, unprompted):** `git branch -a`. At authoring time this is
   `main` ONLY (+ remote trackers + the upstream branch pile) — report it as a one-liner. If anything
   besides `main` and its tracker appears (a `salvage-*`, `sol-backup-*`, feature, or worktree
   branch), open with an inventory and ask whether to audit/clean before starting. Never delete a
   backup branch yourself.
3. **Confirm HEAD + 0 unpushed:** `git log --oneline -3` (expect Batch 701 `9204647535` or later) +
   `git log origin/main..main` (expect empty). A dirty tree or unpushed commit = a slice was in flight
   or LAND-INCOMPLETE — run the salvage playbook (§4) FIRST.
4. **Run C11-00B (§6)** if C11 has not launched — seed the ledger from the live C10 fallout; present
   the launch note + branch inventory to the maintainer before the first slice.
5. **Pick up the wave order** from the C11 queue §5 (or, if phase-3 assembly is not done, from
   `_PLANNING_STATUS` "What REMAINS"). Recommended W1 sequencing (from the guide authors): run the
   pick-family diagnosis (A1) + the high-density-spheres drift diagnosis (B1) in W1 so later waves
   stop paying OFF-oracle costs against known-red gates; sequence any define-width work (`C10-08b`)
   before any new-define slice (registry EXHAUSTED). Do NOT rank items by the register's stale
   magnitudes — several are stale post-`C10-01`/`C10-03`; verify mechanisms, not counts.
6. **The canonical-ID-table-FIRST rule (phase-3 assembly).** If you are assembling the C11 queue +
   execution guide (not yet done — `_PLANNING_STATUS` phase 3), author the **canonical C11 ID table
   FIRST**: assign every register item its `C11-xx` number BEFORE composing any queue/guide prose.
   This is the C10 numbering-collision lesson (the register's W8 rows were proposed as `C9-40…49`,
   collided with in-flight C9 rows, and had to be renumbered `C10-01…10` ordinally). **NEVER invent a
   `C11-xx` number ad hoc while writing prose — the orchestrator assigns them all at once in the table,
   then prose references the table.** Then compose `QUEUE_2026-07-16→_CAMPAIGN11.md` (§1 rules
   inherited verbatim, §2 rulings, §3 gates, §3.2 ledger seeded, §4 C11-00B intake, §5 waves, §6 gated
   tail) + `CAMPAIGN11_EXECUTION_GUIDE.md` composed from G1–G10 with a canonical-ID reconciliation note.

---

## OPEN QUESTIONS for the maintainer / next orchestrator

1. **Maintainer decisions blocking specific briefs (from the guide authors, carry into C11-00B):**
   splat-data-producer build placement (WebGPU branch in `GaussianSplatPrimitive.update` pre-FR-return
   vs inside the FR) + the offline `.spz`/glTF-splat asset (or a faithful synthetic builder);
   enhanced-ocean default direction; sunBloom parity (wire screen-space vs ratify the baked
   substitute); model-silhouette translucent body-wash-vs-rim (replicate WebGL's OIT-stencil artifact
   for byte-parity, or ratify WebGPU's documented rim-only intent); the `forceSceneMRT` default-flip
   sign-off protocol (does the maintainer want an explicit recorded sign-off like the `C10-03R`
   reserve-lever protocol, or does the DW-recorded phasing count as standing approval?); FAR-107 +
   the high-density-drift repair IF it traces to a contained cull path (the charter forbids feature
   degradation, so a "fix" that disables a contained path is not allowed).
2. **Gated-tail activation ordering.** The reversed-Z chain (A1→A2) and the pick-fleet log-depth
   conversion pull the same 71-file surface opposite ways. The orchestrator must NOT let the pick
   fleet's log-depth conversion be treated as permanent until the `C10-13` spike GO/NO-GO is recorded
   in all three sinks (`NEW-WEBGPU-PICK-FLEET-LOG-DEPTH`, the FAR-707 brief, `DEFERRED_WORK.md`). Which
   direction the fork commits to is a maintainer sign-off, not an engineering default.
3. **Phase-3 assembly is not done.** This guide (G10) plus G8/G9 complete phase-2; the canonical C11
   ID table, the queue doc, and the execution guide (phase-3) remain (`_PLANNING_STATUS`). Whoever
   assembles them owns the canonical-ID-table-FIRST rule (§B8.6) — that is the single most important
   sequencing constraint for the assembly step, and getting it wrong reproduces the C10 numbering
   collision. Also unresolved: whether C11 launches in orchestrator mode (default) or forks the engine
   script (§7) for an unattended run — a maintainer call that depends on whether a human will be at
   the wheel.

**Anchors verified at HEAD `9204647535` (Batch 701):** branch inventory (`main` only, 0 unpushed);
engine-script hardening line anchors (`safeAgent:266`, `audit-retry:317`, `offByteIdentical
GO-escape:198/329`, `trust-verdict:332–341`, `substrate:339`, `budget:276`, `SKIPPED-DEP:279`,
`RESEARCH=[]:239`); the C10 queue §2 MSAA ruling, §3 gates, §3.2 ledger (incl. the Batch-700 OIT NO-GO
row), §5 waves, §6 gated tail; register §19 (gated-reversed-z) + §22 (arch-seeds) + the UNKNOWNS /
standing-policy tail. Line numbers are hints; symbols are the anchors.
