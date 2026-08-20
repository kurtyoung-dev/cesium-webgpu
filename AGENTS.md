# Repository agent governance — router

**This file routes. It does not rule.** Every operative rule lives in a tracked document below; this
one exists so a Codex-family agent that auto-loads it knows where to look and what order things bind
in. Collapsed to a router on 2026-08-18 per `R-2026-08-17-15`, because a router with no rules cannot
contradict a rule — and the rule blocks that used to live here had each drifted out of agreement with
their tracked homes.

## Before you act

**Do not begin campaign work, and do not commit, build, run a browser, publish evidence, or change
external state, until you have read the binding documents below.** If you cannot read them, stop and
say so. Reading a router is not the same as being briefed.

## Precedence

1. System, developer, user, and current-task instructions, in that order.
2. [`migration_doc/MAINTAINER_RULINGS_2026-08-17.md`](migration_doc/MAINTAINER_RULINGS_2026-08-17.md)
   and its dated predecessors — the add-only ruling series. **A later ruling supersedes an earlier
   one; rulings supersede every document below.**
3. [`migration_doc/EXECUTOR_LANE_CHARTER_2026-08-14.md`](migration_doc/EXECUTOR_LANE_CHARTER_2026-08-14.md)
   — binding executor rules. §0 states the full precedence order in detail.
4. [`CLAUDE.md`](CLAUDE.md) — the fork's architecture principles and operating rules.
5. Everything else, including this file.

The narrowest authorized scope wins. If two sources conflict, stop and report the conflict rather
than choosing.

## Where each rule actually lives

| You need                                                                                                                                                                                                                  | Read                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Verdict vocabulary and exit codes (`PASS` 0 / `FAIL` 1 / `ERROR` 2 / `STRUCTURAL` 3)                                                                                                                                      | Charter §1 status table; the frozen table is `Tools/visual-regression/lib/verdict-exit-gate.mjs`                                                                                                                                                                   |
| That a measured red is never de-scored, demoted or quarantined                                                                                                                                                            | Charter §1.1 `[HARD]`; escalation route in §5                                                                                                                                                                                                                      |
| Evidence prerequisites, the clean validation manifest, banking a citation                                                                                                                                                 | Charter §1.7 `[HARD]`                                                                                                                                                                                                                                              |
| Capacity, pausing, freezing, and the handoff you owe                                                                                                                                                                      | Charter §4                                                                                                                                                                                                                                                         |
| Whether the campaign is paused or resumed **right now**                                                                                                                                                                   | The **ruling series** (item 2 above). [`migration_doc/CAMPAIGN_STATE.md`](migration_doc/CAMPAIGN_STATE.md) mirrors it and is **not** the source                                                                                                                    |
| Branch, clone, path-lease and rebase rules; the handoff report you owe                                                                                                                                                    | [`migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md`](migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md)                                                                                                                                                     |
| **Your dispatch rules as a worker** — clone readiness, one deliverable per dispatch, the reporting window you owe, negative controls, and why a lease deviation with a stated reason is a finding rather than a violation | [`migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md`](migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md) sections 8a-8c                                                                                                                                      |
| Who may commit, and how                                                                                                                                                                                                   | `R-2026-08-18-28`. **Workers NEVER run git writes** — no commit, stash, checkout, restore, reset. The orchestrator fetches your branch and commits from its own tree. This restores `ORCHESTRATION_HANDBOOK.md:61` `[HARD]` and supersedes `R-2026-08-17-13`/`-19` |
| Orchestration pattern; untrusted-content doctrine                                                                                                                                                                         | [`migration_doc/ORCHESTRATION_HANDBOOK.md`](migration_doc/ORCHESTRATION_HANDBOOK.md)                                                                                                                                                                               |
| Git identity, authentication, quiet hours                                                                                                                                                                                 | `ORCHESTRATION_HANDBOOK.md` §3 — named by charter §2.6 as the authority                                                                                                                                                                                            |
| How your predecessor performed, and what to focus on                                                                                                                                                                      | [`migration_doc/CODEX_SOL_OPERATING_BRIEF.md`](migration_doc/CODEX_SOL_OPERATING_BRIEF.md) — coaching, not rules                                                                                                                                                   |

## Verifying rendering work

`CLAUDE.md` §8 requires that a visually verifiable fix be proven by an automated probe **rather than
by asking the maintainer to look**. That principle is in force for authorized work. It does not by
itself authorize running a browser: whether _this_ task may run one is answered by the charter and
your current instructions. **If the work needs a probe and you are not authorized to run one, say
that plainly and stop** — do not substitute a request for the maintainer to verify by eye, and do not
claim a fix you have not observed.

## Workflows

- [`run-cesium-campaign-lane`](.agents/skills/run-cesium-campaign-lane/SKILL.md) — authorized
  campaign execution, resume, pause, handoff.
- [`audit-cesium-certification`](.agents/skills/audit-cesium-certification/SKILL.md) — independent
  read-only certification or evidence review. **Do not combine reviewer and repair-author roles in
  one pass** (charter §4.6).

Skills organize work. They do not grant authority.
