# Tiered orchestration playbook — reference execution 2026-08-21

The reusable recipe for the three-tier orchestration pattern (PATTERN v3), written
from the day it ran end-to-end: seven worker packages built, reviewed, fix-rounded,
extracted, and staged as Batches 1108-1120 with every defect caught before landing.
When the maintainer asks for "tiered orchestration," this is what to repeat.

Authorities this playbook points at (it restates none of them):
[CODEX_SOL_OPERATING_BRIEF.md](CODEX_SOL_OPERATING_BRIEF.md) (worker rules 1-11),
[WORKER_ISOLATION_AND_BRANCH_HANDOFF.md](WORKER_ISOLATION_AND_BRANCH_HANDOFF.md)
(clones, landings, capacity preflight),
[EXECUTOR_LANE_CHARTER_2026-08-14.md](EXECUTOR_LANE_CHARTER_2026-08-14.md)
(precedence, lane disjointness), and
[ORCHESTRATION_HANDBOOK.md](ORCHESTRATION_HANDBOOK.md).

## 1. The three tiers

| Tier | Who | Does | Never does |
| --- | --- | --- | --- |
| Orchestrator | Fable session | Briefs work packages, verifies premises (Principle 10), dispatches, applies enumerated-mechanical review edits, extracts to main, certifies gates in main, lands and pushes | Builds worker deliverables itself; trusts a brief or an audit finding without re-reading the cited code |
| Workers | Codex Sol via relay agents (Opus subagents for judgement/cross-file shapes) | Builds one bounded deliverable per dispatch in an isolated clone; runs its own verification | git writes, browsers, gulp builds, work outside the named file scope |
| Reviewers | Opus 5 subagents (station 3) | Independent review of every worker deliverable before extraction; mutation/adversarial verification; byte-pins | Editing the deliverable; git writes; reviewing its own authorship |

Split work by SHAPE, not quality: Sol gets bounded single-deliverable packages;
Opus subagents get judgement-heavy or cross-file work. The orchestrator is the only
git writer. All reviews are initial-reviewed by Opus; the orchestrator final-reviews
the REPORT (spot-verifying claims), not the whole diff.

## 2. Wave planning (before any dispatch)

1. Enumerate open work from the campaign queues; group into like-task batches.
2. COLLISION CHECK, non-negotiable: for every file a package would touch, run
   `git status --porcelain <path>` in main. A package touching any file that is
   dirty in main under a held lane is BLOCKED until that lane lands - dispatching
   anyway guarantees an extraction conflict. When engine lanes block everything,
   dispatch zero-collision doc/tool singles instead (license vetting, queue-truth
   passes, governance docs ran this way).
3. One clone per package. Reset discipline before reuse:
   evidence repatriation first (copy probe PNGs/reports to main
   `Tools/visual-regression/output/`, certification artifacts to the immutable
   evidence store), then verify extracted files byte-match main (`cmp` each), then
   `git checkout -- . && git clean -fd`, then confirm `git status --porcelain`
   is empty and the tip matches main's.
4. Never dispatch into a clone that might still have a live worker session
   (brief rule 10). Quiescence is proven, not assumed - see section 5.

## 3. The relay dispatch template

Workers are driven by a background claude agent whose ONLY job is one codex call
plus independent verification. The template that ran all of today's dispatches:

- Load the schema first: ToolSearch "select:mcp__codex__codex".
- Call once: `cwd` = the clone root, `sandbox` = "workspace-write",
  `approval-policy` = "never", `prompt` = the brief verbatim.
- The brief itself always contains: the exact file scope ("touch nothing else"),
  the no-git/no-browser/no-build prohibitions, the verification commands the worker
  must run before declaring done, and the honesty rules relevant to the deliverable.
- Timeout playbook, verbatim in every relay prompt: "If the MCP call times out with
  a transport error after ~30 minutes, do NOT retry or re-dispatch - the codex
  session survives on disk. Report the timeout and last state, then stop; use a
  strict quiescence watch before any post-timeout verification."
- After codex returns or times out + quiescence: the relay runs read-only
  independent verification (git status footprint, the deliverable's own gates) and
  reports. The relay never edits files.

The 1800s MCP idle timeout fired on roughly half of today's dispatches and lost the
worker's final self-report every time; the sessions always survived and completed on
disk. The relay's independent verification is therefore not optional - it is the
only reliable record of what the worker produced.

## 4. Station-3 review templates by deliverable type

Every review runs in a fresh Opus subagent with: no git writes, no browsers,
mutations only in a scratchpad mirror (or byte-exact-restored clone edits with
sha256 before/after proof), and a restored-state proof at the end. Verdicts are
LAND / LAND-WITH-EDITS (exact edits) / HOLD, findings numbered with severity.

**Comment-only shard (C16 class):** comment-only-diff zero code deltas; marker
guard zero on scope + self-test; cleanlist/grandfather ratchet direction; DEV_NOTES
quotes byte-verified against `git show HEAD:` by a verifier first proven on a
deliberately corrupted quote; LEDGER-TRUTH pass - every rewritten comment asserting
feature state re-derived from DEFERRED_WORK.md and the owning queue (the W2-A
fabrication was caught exactly here); spec-anchor mutation controls bite non-prefix.

**Code-touching literal lane (R1 class):** blank every comment span and string span
on both sides and require sha-identical code-token residue per file; for
pipeline-feeding WGSL template literals, compare comment-stripped literal residue
byte-for-byte; shipped warning strings stay actionable and truthful (verify
capability claims against the actual engine - a false "not available on this
backend" claim was caught here); dedupe identifiers and trigger logic unchanged.

**Instrument/probe package:** row-gate fidelity clause by clause against the queue
row's written gate; extract-and-execute (no hand-copied predicates); counter-not-
inference where the row demands it; mutation teeth >= 4 per gate including one
inertness form (`if (false && ...)`), applied to real files and restored byte-exact;
bar single-representation with no widening path, proven by a bar-widening mutation;
fleet contract substance (watchdogs, write-once evidence, canonical fused-snapshot
capture, shared exit-code table); no premature verdict language; anti-vacuity
controls asserted, not narrated. If the worker may still be live, the review's
first duty is to detect it (mtime/size sampling) and HOLD - a review of a moving
buffer certifies bytes that no longer exist.

**Doc deliverable:** independent clean-room re-enumeration of the source material
(coverage); quote-fidelity sweep (machine-extract quoted fragments, verify verbatim
against sources); internal-arithmetic checks (every count the doc states about
itself); consistency with sibling authority docs; honesty markers (no claim without
quotable evidence).

## 5. Quiescence and timers

Triple-cycle quiescence before declaring a worker done or dispatching a completion
round: sample the deliverable files' size+mtime every ~175s and require 3
consecutive unchanged cycles (a single stability window proved too lenient twice -
workers paused and resumed writing). Bounded watcher scripts only, with a hard
iteration cap. Reference implementation (session-scratch, re-create as needed):
a node script that snapshots `statSync` size:mtimeMs per file, counts consecutive
quiet cycles, runs the deliverable's spec at the quiesced state, and exits with a
distinct code on timeout. For wall-clock waits (quiet-hours landing windows), a
bounded clock-watcher background process whose completion notification wakes the
orchestrator - never an unbounded sleep loop.

## 6. Fix rounds

- Substantive findings go back to the SAME Sol session's clone as a fix-round
  dispatch (only after proven quiescence), with the reviewer's findings restated
  as exact numbered instructions and the mandatory re-verification list.
- Enumerated-mechanical edits with reviewer-supplied replacement text may be
  applied by the orchestrator directly - in the clone, followed by re-running the
  full gate set in the clone AND in main after extraction.
- Anything that changes banked DEV_NOTES content re-banks it in the same round.
- After a fix round, the reviewer re-checks only deltas (resume the same review
  agent - it keeps its context) unless the deliverable was rewritten wholesale.

## 7. Extraction and certification

1. Collision re-check at extraction time (files may have gone dirty since dispatch).
2. Copy wholesale ONLY files clean in main; hand-merge shared files hunk by hunk
   and verify the diff shows exactly the expected hunks.
3. Byte-pinned deliverables (reviewer-supplied sha256) must match the pins exactly
   after copy - re-hash in main.
4. Merged ledgers (cleanlists, allowlists) are unioned by script, then the owning
   guard re-run in main; landing-order hazards (a ledger row landing before its
   file) get an explicit split procedure in the landing script.
5. Re-run every gate IN MAIN, never trust clone-only green: specs, tsc, prettier,
   the relevant guard fleet. Mixed line endings are the recurring trap - workers
   write LF into CRLF files; anchor edits on exact bytes, use per-anchor EOL
   fallback, and let prettier/git normalize at commit.
6. Reset the clone per section 2's discipline. Then script the landing batch:
   file list, gates to re-run at landing, and the full commit message drafted in
   advance.

## 8. Landing

Quiet hours are absolute (no commit/push weekdays 07:00-19:00 ET; machine clock
authoritative). Batches land in scripted order with explicit pathspecs - never
`git add -A` - each gated by its own re-run, each pushed before the next. Documents
that cite other batches land after the batches they cite. The tooling catalog is
regenerated after commits that add census-visible files.

## 9. Failure modes this pattern caught today (why the tiers exist)

- A worker fabricated a docstring from a governance anecdote instead of the ledger;
  the Opus review's ledger-truth pass caught it (and the orchestrator's own
  spot-check had NOT - it matched expected words instead of re-deriving).
- The repo's own pre-commit prettier hook would have broken a landed probe's
  canonical capture block on first commit; the review proved it by running prettier.
- A review ran against a live edit buffer; the HOLD-on-motion duty caught it, and
  the settled state differed materially from the sampled one.
- An audit misattributed a fix to the wrong batch; the verification agent's git
  re-derivation corrected it before the queue was stamped.
- A deliverable's headline finding was inverted by a false baseline premise the
  whole doc set shared; the review checked the premise against the repo instead of
  the task statement.

Every one of these would have shipped under single-tier execution.

## 10. Restart safety

Before any machine restart mid-campaign: refresh the dirty-state backup
(`git diff --binary` patch, verified with `git apply --reverse --check`, plus all
untracked files), copy the landing script and drafted messages out of the session
scratchpad into the backup folder, and update the memory resume line to the durable
paths. Worktree dirt survives reboots; session timers and scratchpads do not.

## 11. Lessons from the first landing run (2026-08-21 evening, Batches 1108-1120)

Thirteen batches landed; one scripted package did not, and the reasons generalize:

- **Every instrument review must run eslint and `prettier --check`** on the deliverable,
  not only its specs and mutations. The repository's pre-commit hook is the first
  lint gate a worker-authored probe meets, and a review that skipped lint certified a
  package the hook then refused. The sibling review that did run lint caught the
  equivalent defect before landing.
- **Specs must normalize line endings when they read source text** for anchors
  (`.replace(/\r\n/g, "\n")`). This repository runs `autocrlf=true`, so every Windows
  checkout is CRLF and a multi-line `\n` anchor finds nothing - a spec that is green
  on the worker's LF files is red on the next checkout. Portability is proven by
  running the spec on an LF and a CRLF copy.
- **Shared files are staged per hunk, never whole**, when another held lane owns hunks
  in the same file: `git diff -U0 <file>` → keep the wanted `@@` hunk(s) → `git apply
  --cached --unidiff-zero <hunk-patch>`, then assert `git diff --cached -U0` shows
  exactly those hunks before committing. Tested dry with `--check` before the window.
- **The after-the-fact landing verifier runs the marker guard in strict mode, which is
  grandfather-blind**, while the live commit-time guard honors the grandfather ledger.
  A range verification can therefore report findings that pre-date the range; classify
  each finding against the pre-range blob before recording anything (every one of
  tonight's 65 was present verbatim before the first landed commit).
- **Stop-on-failure in landing chains.** A batch whose commit fails must not be followed
  by the next batch's `git add` - the failed batch's files stay staged and poison every
  later attempt. Chain batches with an explicit failure exit, and reset the index before
  retrying.
- **Batch numbers are commit order.** When a scripted batch is pulled, renumber the
  batches behind it and fix every pending doc stamp that cites the old number before
  committing, so that "order by batch number" stays true.
- **A swapped bundle is not refreshed by `npx gulp build`.** After an interleaved A/B
  campaign leaves a substituted bundle in `Build/`, the incremental build reports success
  without rewriting it - two "rebuilds" produced byte-identical output whose embedded
  `sourcesContent` still carried pre-landing text, and the provenance gate of every
  certification probe went STRUCTURAL. Restore with `npx gulp clean && npx gulp buildCesiumDual` - the default
  `build` task writes no `Build/CesiumUnminified` at all and `buildRelease` emits it
  without the `index.js.map` the provenance gate attests - then prove the served
  identity changed, the served status is 200 (a missing artifact serves a 404 body that
  still hashes), and the embedded sources match disk before any machine-lane run.
- **The engine-project TypeScript check is a landing gate; the root one is not enough.**
  `npx tsc --noEmit` at the repository root passed all day while
  `tsc --project packages/engine/tsconfig.json` - the step `gulp build` actually runs -
  failed on a property a landed one-liner used without declaring it on the ambient
  `CesiumScene` type. Every build after that landing aborted at the tsc step, which
  masqueraded as "the bundle did not refresh". Reviews and landing pre-flights run BOTH
  checks; a fix-forward lands the missing declaration, never a history rewrite.

### 4a. Admissibility checks every station-3 review runs (added after the G9 harness landing)

The harness reviews verified behavior and never verified admissibility; the repository
hook then refused a LAND-verdict deliverable. Every review of a code deliverable now
ends with these, run read-only and reported with the verdict:

- **Run the repository's own pre-commit gate** (`npx eslint --quiet` and
  `npx prettier --check` over the deliverable's files). The hook is a transformer, not a
  checker - `prettier --write` mutates files at commit - so when `--check` is not clean,
  apply the reformat to a mirror and **re-run the deliverable's suite on the post-gate
  bytes**; anchors that move under reflow are a defect of the deliverable.
- **Run any source-text-anchored suite under both line-ending conventions** (convert a
  mirror to CRLF, run, restore byte-exact). Untracked deliverables never met
  `autocrlf`, so the CRLF failure is unreachable until the first post-commit checkout;
  the review must simulate that checkout.
- **Name text-anchored assertions as a declared fragility class:** a spec that matches
  source text must normalize everything it does not intend to pin and read raw bytes
  only where identity is the subject. A spec whose anchors throw at module scope does
  not merely fail on the wrong checkout - it removes tests.
- **Verify the instrument before publishing a surprising result:** re-derive any
  headline number by a second independent method; a review is itself a measurement.
