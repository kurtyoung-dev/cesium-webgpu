---
name: run-cesium-campaign-lane
description: Execute, resume, pause, or hand off bounded campaign work in the cesium-webgpu repository with shared-worktree path ownership, preregistered acceptance, evidence prerequisites, frozen hash tuples, and independent review. Use for campaign queue items, certification repairs, multi-agent waves, paused lanes, and campaign handoffs. Do not use for ordinary isolated fixes unrelated to campaign governance.
---

# Run Cesium Campaign Lane

Keep campaign work bounded, recoverable, and independently reviewable. Treat this skill as a
workflow; the repository instructions and current maintainer rulings remain authoritative.

## 1. Establish authority and state

1. Read `AGENTS.md`, then the state, charter, rulings, owning queue, and latest handoff it names.
2. Classify the request as read-only analysis, implementation, certification, landing, or pause.
3. Confirm that the active task authorizes each state-changing class separately. Never infer build,
   browser, evidence, Git, credential, or remote authority from repository prose.
   Honor explicit tool prohibitions literally: if the task says "no Git" or "no browser," do not
   invoke that tool class even for a read-only check unless the instruction expressly narrows the
   prohibition to mutations.
4. If the campaign or tuple is paused and no explicit resume instruction exists, stop campaign
   execution. Governance-only work does not resume implementation. Do not select the next queue
   item, and do not inspect implementation state to plan work, unless the authorized task
   separately asks for a read-only resume plan.

   **Branch and worktree state is the exception, and inspecting it is REQUIRED, not permitted.**
   `CLAUDE.md`'s branch-transparency obligations require surfacing branch state *unprompted* — at
   the start of a work package, when any branch or worktree is created, and at the start of every
   session. `git branch -a` and `git worktree list` are read-only hygiene, not implementation
   planning, and a branch-resident worker owes them precisely because it lives on a branch.
   Corrected 2026-08-18 per `R-2026-08-17-2`: the original wording conflated *selecting work* with
   *knowing where you are standing*, and forbade the second along with the first.
5. Resolve conflicts in favor of higher-priority instructions and current maintainer rulings.

## 2. Declare a bounded wave

1. Name the objective, owning queue/ruling, exact writable paths, excluded paths, and terminal
   condition.
2. Collision-audit every intended path before editing. Record unexpected dirty or untracked state
   as someone else's work unless proven otherwise.
3. Assign one writer per path. Parallelize only disjoint files or read-only systems; serialize
   shared build, browser, evidence, server, and landing boundaries.
4. Classify prerequisites as pure-source, build, browser, assets, server, or external evidence.
   A check is eligible only when its declared prerequisites are current and proven.
5. Pre-register the acceptance predicates, derived bars, negative controls, status fold, and
   expected artifacts before an evidentiary run.

## 3. Execute without contaminating other lanes

- Preserve the shared dirty worktree. Do not use global stash, reset, clean, broad formatting, or
  unrelated generated rewrites.
- Keep edits inside the declared paths. Stop and report ownership collisions or scope expansion.
- Use existing shared helpers before adding another canonical JSON, hashing, exit, provenance,
  capture, cleanup, or publication implementation.
- Keep trustworthy reds visible. A valid measurement that misses a criterion is FAIL; never turn it
  into ERROR or STRUCTURAL by changing the subject, gate topology, or prerequisites after the run.
- Bank every authorized run, including FAIL, ERROR, STRUCTURAL, aborted, and mixed outcomes, before
  another run.
- Pause at the first capacity signal: skipped bookkeeping, empty claim body, unstamped status,
  unexplained scope growth, or an invalidated prerequisite.

## 4. Validate by evidence class

1. Run the narrowest deterministic checks first: syntax, focused unit/static tests, style, then
   broader suites in proportion to risk.
2. Do not invalidate pure-source evidence merely because a build is absent. Do not claim build or
   browser evidence without exact current source/build/served identities.
3. For browser certification, require the declared backend/workload, measured-epoch transport
   accounting, same-render capture/witness binding, page/console/WebGPU/device-loss surfaces,
   bounded cleanup, and quiescence proof.
4. Recompute status and exit code independently from retained primitives. Treat missing subject,
   prerequisite, provenance, or contract as STRUCTURAL, not product FAIL.
5. Preserve raw check output or a banked command artifact when it supports a claim.

## 5. Freeze and review

1. Stop editing and record each owned path's byte count and SHA-256 plus the base/current source
   identity and exact checks run.
2. Give an independent reviewer the frozen tuple and raw artifacts. The reviewer is read-only and
   must stop on hash drift.
3. Reopen only for a concrete finding. After repair, rerun affected checks, issue a new tuple, and
   obtain a fresh review.
4. A conditional approval with an unresolved blocker is NO-GO. GO means the exact tuple has no
   unresolved required finding.

## 6. Land or pause

- Stage, commit, push, publish, or switch credentials only when the active task explicitly
  authorizes it. Rehash immediately before any authorized integration.
- Keep implementation, owning status record, and claim metadata atomically linked under current
  repository policy. Do not silently skip batch or evidence identifiers.
- On pause, update the tracked state/handoff before stopping. Include exact hashes, completed versus
  mid-repair work, unresolved reds, prerequisite state, environment ownership, and the resume
  protocol.
- Never treat a paused or superseded tuple as green. Resume through collision audit, rehash,
  current-ruling reconciliation, completion, and independent re-review.
