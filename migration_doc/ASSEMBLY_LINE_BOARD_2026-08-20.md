# Assembly-Line Orchestration Board — 2026-08-20

**Status:** LIVE. Opened at `main` = `4abfabedad`, Thursday 2026-08-20 17:00 ET.

This board is the running state of one orchestration session: Opus 5 as
orchestrator, Codex Sol 5.6 as implementation workers, separate Claude agents as
reviewers and testers. It is **not** a status authority for any campaign row —
the owning campaign queue remains the sole authority for status, dependencies and
completion. This board records only *where a work package sits on the line*.

Dispatch mechanics and worker rules live in
[`WORKER_ISOLATION_AND_BRANCH_HANDOFF.md`](WORKER_ISOLATION_AND_BRANCH_HANDOFF.md)
§8a–§8c. The brief-writing principle is `CLAUDE.md` Principle 10.

---

## 1. The line

A work package moves through five stations. It may only move **forward one
station at a time**, and a failure at any station sends it back to station 1
with the finding attached as the new brief — never sideways, and never onward
with a known defect.

| # | Station | Owner | What it establishes | What it cannot establish |
| --- | --- | --- | --- | --- |
| 1 | **Build** | Codex Sol worker, isolated clone | An implementation and its spec exist | Anything about correctness |
| 2 | **Mechanical** | Orchestrator, `verify-worker-handoff.mjs` | Lease honoured, no git writes, no conflict artifacts, headers present, **the spec actually runs** | Whether the spec *means* anything |
| 3 | **Test** | A different agent, different model family | The premise is real, the spec is non-vacuous under an inertness mutation, conventions hold | Integration against other in-flight lanes |
| 4 | **Integrate** | Orchestrator | The diff is correct, matches fork pattern, merges cleanly with sibling lanes *by performing the merge* | — |
| 5 | **Land** | Orchestrator only | Committed and pushed after quiet hours | — |

**Station 2 is cheap and total; station 3 is expensive and is where real defects
surface.** A green station 2 means "ready for review", never "correct" — the tool
prints exactly that. On the previous run station 2 passed all four Sol lanes and
station 3 sent two of them back.

**Why a different family at station 3.** Opus reviewing Sol caught two false
diagnoses, a vacuous spec, and a broken public contract that mechanical validation
passed clean. A model reviewing its own family shares its blind spots; the whole
value of the station is that it does not.

---

## 2. Standing rules for this session

1. **Workers never run a git write.** No commit, branch, stash, checkout or reset.
   Work stays as uncommitted worktree state; only the orchestrator lands it.
2. **Workers never launch a browser or a build** (the `build-ts` gate in WP-3 is a
   named exception, granted in its brief). The machine lane is orchestrator-only,
   one Edge at a time.
3. **One deliverable per dispatch.** Three deliverables in one brief produced code
   that did not run; the same worker given one produced a mutation-verified
   predicate. The split is scope, not capability.
4. **Every brief states a premise the orchestrator verified against current source
   at brief-writing time.** An audit finding or a queue row is a lead, not a
   premise. Briefs say so explicitly and invite the worker to refute them.
5. **A soft deadline sits inside the hard kill** — stop at 20 minutes and write the
   report regardless of state. A hard kill with no reporting window gives a worker
   a stricter deadline than we allow our own probes.
6. **Never de-score a measured red** without a maintainer ruling.

---

## 3. Package ledger

Premise column records what the orchestrator verified *before* dispatch, per rule 4.

| WP | Row | Worker | Premise check | Station | Outcome |
| --- | --- | --- | --- | --- | --- |
| WP-1 | `C16-06a` | Sol | **VERIFIED** — `Tools/c16/` held no anchor-sweep tool | **4** | Spec 5/5. Three detection branches each proven load-bearing by an inertness mutation (A→3/2, B→4/1, C→4/1), restore byte-identical. Run against the real `ground-fog-band.spec.mjs` it finds the Class C `indexOf` locator the C16-07 shard found by hand. |
| WP-2 | `C16-05a` | Sol | **VERIFIED** — box pair-header with `Batch NN` at doc lines 105–128 | **4** | 0 markers introduced, 11 removed; comment-only-diff 0 violations. **The brief was wrong** and the worker caught it — see §6. |
| WP-3 | `C16-02c` | Sol | **VERIFIED but MIS-MEASURED** — see §5 | 3 | All 11 briefed errors resolved; a previously-hidden set of 11 `TS7005`/`TS2488` now surfaces. Honest remainder recorded below. |
| WP-4 | picking `api-docs` | Sol | central claim re-derived and **CONFIRMED** | **4** | Async MostDetailed is genuinely unresolvable on WebGPU — the producer is unimplemented, not gated twice (see §5). Blocker fixed: the spec was named `*Spec.js`, which `scripts/build.js:622` sweeps into the Karma SpecList and esbuild then fails to bundle, taking the whole engine suite down; renamed to `.mjs`. The spec asserts JSDoc prose, so it is recorded as source-text only, not counted as behavioural coverage. |
| WP-5 | picking `drillpick` | Sol | fix sound, matches fork pattern | **4** | Pragma removal correct under the CLAUDE.md permanent-log rule. Vacuous spec **replaced**; the replacement goes red under an inertness mutation (4→3) where the old one stayed green. |
| WP-6 | picking `pickcache` | — | **REFUTED** — see §5 | back to 1 | Salvage is roughly one line. |
| WP-7 | picking `writeback` | — | superseded by a maintainer ruling | back to 1 | Redesigning against the `R-2026-08-17-11` freshness contract. |
| WP-8 | C16 fleet reader | Sol | allowlist reconciled exactly with an independent count | 4 | Held for a later landing unit. |

---

## 4. Backup and landing protocol

**Quiet hours are in force until 19:00 ET.** A commit carries a visible timestamp
even when pushed later, so nothing is committed during the window — not as a
convenience, as a rule.

Completed work therefore waits as uncommitted state, which is not durable: a clone
is a scratch directory that the next dispatch may reprovision or delete.
`Tools/backup-worker-deliverables.mjs` exports each clone's authored work as a
patch bundle plus verbatim copies of untracked files, and **verifies each bundle by
replaying it onto the recorded base**. A patch nobody replayed is a backup that
only looks like one.

Current bundle: `f:/Dev/GH/cesium-webgpu-backups/deliverables-2026-08-20T21-28-18`
— refreshed after every orchestrator edit, all `OK`, all proven to replay. The clones are expendable.

Landing, after 19:00 ET, is orchestrator-only and squash-only: a merge commit skips
the landing rules entirely, and a non-agent author skips every rule.

---

## 5. Premises refuted at this session's station 3 or by the orchestrator

Recorded because a refuted premise is a result, and because these rows will
otherwise be re-dispatched by a future session reading the queue.

**`C16-08a` — REFUTED, not dispatched.** The row alleges two disagreeing
"does this model have spherical harmonics" signals, with a silent ambient shift
when the shader takes an analytic SH branch against zeroed coefficients. The
shader does not have that branch. `iblHasSH` occurs exactly twice in
`ModelPBRComplete.wgsl`: the struct field at line 327, and a comment at line 3422
stating that gating on it would introduce a code path the GLSL side lacks. The
live gate is `sh.control.w > 0.5` at line 3312, and `control.w` lives *inside the
SH buffer*, so it travels with whichever buffer is bound and cannot disagree with
it. The described failure is structurally impossible.

What is actually true is smaller and different: `WebGPUModelRenderer.ts:2561`
packs `data[15]` every frame into a uniform slot nothing reads. That is a
Principle 7 question — deliberate scaffolding or dead slot — and the comment at
3422 suggests the non-wiring was a considered decision. It needs a ruling, not a
worker.

**`C16-02c` — the row was right and the ORCHESTRATOR's measurement was wrong.**
The brief told the worker "the queue claims 21, the tree produces 11, trust the
run." The run was captured through `tail -30`, which showed only the last 11 of
the errors. The row's 21 was accurate: 11 unresolvable-name/namespace errors plus
~10 `TS7005`/`TS2488` errors the truncation hid. Same class as misreading an exit
code through a pipe — a filtered capture treated as the whole. The worker resolved
all 11 it was given; the remainder is real, not a regression.

That remainder is **not** a JSDoc defect. `Matrix2.js:1096` is correctly formed;
`tsd-jsdoc` misparses the second line of a multi-line `@example` and emits
`export var matrix, [undefined]: number;`. The affected files are upstream
Cesium's, so "reword the example" trades a types error for an upstream-sync
conflict. It needs a decision, not a worker.

**`Picking.js:1329` — NOT a fork defect.** An earlier review flagged the
`undefined` writeback as a bug worth filing. Re-derivation against
`Scene.js:5658-5660` shows it is upstream's *documented contract*. What IS real
and was missed: `Picking.js:1324` passes `cartesians[i]` as the `result`
out-param, so the clone mutates the caller's object mid-flight and aliased inputs
overwrite each other. Fixable with no observable change.

**"Two independent gates" — one condition stated twice.** Recorded because the
orchestrator relayed it. `useGlobeDepthFramebuffer` *is* `!picking`
(`WebGPUContext.ts:4943`), and the skipped update block
(`WebGPUSceneRendererFrustumLoop.ts:710-723`) re-tests the same term. There is no
second gate to fix, and a reviewer who repeats the phrase without re-deriving it
inherits the error.
