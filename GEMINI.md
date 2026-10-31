# Antigravity & Gemini Rules — Cesium WebGPU

**Every rule for this fork lives in [`CLAUDE.md`](CLAUDE.md). Read it first, in full, before you do
anything; this file carries only what is specific to Antigravity and Gemini workers**
(R-2026-10-30-M2). That includes the file-editing rule (Principle 11), node-first execution
(Principle 12), the context spine (Principle 13), the engine rules (RTE precision, the add-only
shader define registries, debug pragmas, the fork comment standard) and worker conduct, temp hygiene
and routing ("Rules Files and Routing").

## 1. Where you work, and git [HARD RULE]

- You work only in the clone the seat provisioned for you, never in the seat worktree
  `F:/Dev/GH/cesium-webgpu` (R-2026-10-30-M3).
- Zero git writes — no commit, push, checkout, restore, reset, clean, revert, stash or branch
  operation. Read-only git, plus `git add -N` for patch production, is all you run. Your role, its
  wrapper and the review behind every batch:
  [`WORKER_ISOLATION_AND_BRANCH_HANDOFF.md`](migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md),
  the Gemini tier-3 paragraph after §8e.

## 2. Reply and packet format [HARD RULE]

- Your deliverables are files under `_lane-out/` named by the brief; your reply is a plain-text
  summary under 200 words: facts, exit codes, the patch stat. No chat formatting, no `file://`
  links, no headings in the reply — reviewers read packets, not transcripts.
- A packet states, per claim, the source you verified it against (file:line at this clone's HEAD,
  or a command and its exit code). "Per the brief" is not a source.

## 3. Precision on documentation [HARD RULE]

- `CLAUDE.md` Principle 10 applies to every citation you write. Stale examples that cost a review
  round: a `.glsl:44` that had moved to `:46`,
  a per-cell error count written as per-run, a corroboration written as a proof.
- Before minting any row or id, grep the ledger (`migration_doc/DEFERRED_WORK.md`) and both queues
  for an existing owner; a duplicate row is a defect, a pointer to the owner is the fix.
- Escape `|` inside table cells (`\|`); count the fields; a shifted column breaks every reader.
- When a mechanical rule cannot decide, write UNKNOWN with the reason — never a confident label.
  Prefer the authoritative record (a packet's declared batch, a review's final `VERDICT:` line)
  over a grep heuristic.

## 4. Markdown hygiene [HARD RULE]

- The pre-commit hook runs markdownlint and prettier on root `*.md` and every doc you touch: one
  blank line after every heading and around every list; no lazy continuation lines. Run
  `npx prettier --check <file>` before delivering; a lint failure blocks the seat's commit.

## 5. What you are good at — keep doing it

- Speed and exactness on bounded tasks: byte-faithful copies, runner plumbing, scripts that run
  first time, deliverables exactly where the brief names them.
- Overriding a wrong number in the brief with the verified one and saying so in the packet.
- Staying inside the no-git-write rule: five for five so far. An Opus reviewer stands behind every
  Gemini batch; write for that reviewer.
