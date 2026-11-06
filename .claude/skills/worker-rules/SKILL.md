---
name: worker-rules
description: Worker-rules digest — lease, git, handoff report, briefs, verification, temp cleanup. Read before briefing or reviewing, and as a lane agent before your first action.
---

# Worker rules

<!-- markdownlint-disable-file MD029 -->

Part of the fork's rules: a digest of `migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md` §7, §8a-§8c, §8d (reviewers) and §8i, and it binds exactly as `CLAUDE.md` does. A lead reads it before it briefs, a reviewer before it reviews, and any other lane agent before its first action. The conduct bullets of `CLAUDE.md` "Rules Files and Routing" bind you as well and are not restated here. A change to a rule here and to its source section lands in the same commit.

Also binding, read by section before the act: `ORCHESTRATION_HANDBOOK.md` §1 "Worker constraints [HARD]" and "Subagent hazards [HARD]", lines 69-128 (capture under `_lane-out/`, exit codes, lint and type gates, `SEATBELT_FROZEN`, fetched-tip diffs, claims about your own tree only; the hazards bind whoever dispatches an audit agent or runs a generated script); the worker constraints bind workers, and an Edge executor's browser use is governed by charter §3 and its dispatch; `EXECUTOR_LANE_CHARTER_2026-08-14.md` §4.4-§4.7, lines 327-355 (path scope and stop on overlap, the frozen tuple, reviewer rehash and GO/NO-GO, handoff hazards) and §5, lines 356-365 (ask before de-scoring a red, deleting a guard or destructive cleanup). This skill's routing into the charter by role (a reading path, not a charter rule): a worker or reviewer reads §0-§1 (lines 21-142) with §4.4-§4.7 and §5; an Edge executor adds §3 (lines 194-305) and §4.1-§4.3 (lines 306-326); a lead or records lead reads §0-§5 (lines 21-365); a self-landing executor reads the whole charter.

## Where and what you may touch

1. Work only inside your declared path lease. A path outside it blocks the landing.
2. Never run a git write: no commit, stash, checkout, restore, reset, rebase or merge. Leave the tree dirty; `HEAD` stays at the dispatch base through handoff; the orchestrator commits. If your dispatch grants git writes (a self-landing executor, a lead with git rights), the stash and ref labels and the commit-message rules in `/seat-duties` bind you.
3. Never run `npm install`. Run no build and no browser unless your dispatch authorizes it.

## Starting and stopping

4. If a routed authority is unreachable in your clone, refuse to start and name which one. Never relax this to make a dispatch "work".
5. At the soft deadline, or if you cannot finish, stop and write the handoff whatever the state. An honest bounded partial beats an unbounded sprint.

## The handoff report

6. Report `git status --porcelain -uall` verbatim. Leased paths stay dirty; each untracked file is listed on its own line.
7. Keep the report mechanical: every tracked claim names a path in your own `git diff --stat`, and every untracked claim names its path in the porcelain output.
8. Report the dispatch base as the base, never as a revision you produced. Sign the packet, ledger rows and status lines with the lane name your brief gives (handoff §8e), and name any branch or worktree a sub-agent of yours created.
9. Report final test counts and your own exit codes, captured directly (`timeout` returns 124; a pipe reports its tail). Disclose failures you have already repaired. State which provisioned files are not your work.
10. State the reason for any lease deviation; with a reason it is a finding, not a violation, and a reviewer evaluates it on its merits.
11. If a constraint blocks you, adapt to it (for example, a dependency-free rewrite); never ask to break it.

## Briefs, specs, verification (leads, reviewers, spec authors)

12. Before dispatch, run `node Tools/provision-worker-clone.mjs <clone>` and require exit 0 (`--capsule <targets> [--capsule-role worker|reviewer]` also writes the clone's capsule). Name every agent you dispatch by handoff §8e (the registry is the seat's).
13. Give one deliverable per dispatch. A module, a measured artifact and their spec are three dispatches; a fleet-wide scan is supplied as reference or dispatched alone.
14. Give a soft deadline well inside the hard kill.
15. Read every `file:line` a brief cites at brief time. An audit finding is a lead, not a premise.
16. Give the method, never an answer you already measured.
17. Name the negative control: which inputs must stay green, and why.
18. Brief the observable behaviour to assert, never the implementation shape. A spec written from the brief certifies only the brief.
19. Give every spec an inertness mutant (make the fix unreachable, for example `if (false && …)`), not only a deletion mutant.
20. Before trusting a validator, run it on work you know is good. A violation there is a validator bug until proven otherwise.
21. Verify the worker's claims yourself: run the spec, check the lease, re-derive the count. A reported green is unverified until you execute it. Authors never approve their own work.
22. A reviewer re-derives load-bearing claims and never relays them. A reviewer of a change under `packages/**` checks that the `/engine-code-standards` parity checklist, the four dead-code checks and the inventory moves were run. From reviewer dispatch until the report is on disk and the reviewer has no live background children, the lane's clone is read-only for everyone, the reviewer outside its scratch included, and the reviewer re-hashes the reviewed tuple at the end and reports drift (handoff §8d). A reviewer briefed as the adversarial verifier ends `_lane-out/VERIFY_<Name>.md` with `VERDICT: HOLDS` or `VERDICT: REFUTED (<claim>)` (R-2026-09-11-1, handbook §7).
23. Verification has three tiers: mechanical (`Tools/verify-worker-handoff.mjs`), substantive, and cross-family independent review re-deriving the premises. A green mechanical tier means "ready for review", never "correct".
24. Prove a merge by performing it; disjoint line ranges only screen.

## Temp hygiene and closeout

25. Take scratch space only through `Tools/lib/lane-tmp.mjs` (`withLaneTmp`, or `mkLaneTmp` with your own `finally`/`t.after`), under `<tmpdir>/cesium-lane/<lane>` named by `CESIUM_LANE`. Never use `%TEMP%` directly; a backup goes to `_lane-out/`.
26. Cleanup goes in `finally` or `t.after`, never after the assertions; a killed run is no licence to skip it.
27. Before you return, remove everything you created outside your clone and its `_lane-out/`: the lane temp root, downloaded bundles, Playwright and Karma profiles, mutant copies and served-bundle dumps. Name only your own lane directory, never the `cesium-lane` parent. Your return lists what you removed.
28. Check closeout over the whole Temp root (list it; compare `birthtime >= dispatch`).
29. Three durable places: `_lane-out/`, the main repo's `Tools/visual-regression/output/` (probe layout kept) and `cesium-webgpu-worker-archive`. Repatriate anything of value in your temp space to `_lane-out/` before you return; copying it into the main repo's output folder is the seat's, at closeout. The rest is swept.
30. You may run `node Tools/temp-hygiene.mjs --plan`, which is read-only, and report it. `--bank-evidence` and `--execute` belong to the seat, after a push.
