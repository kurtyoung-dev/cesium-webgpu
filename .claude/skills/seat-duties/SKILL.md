---
name: seat-duties
description: Seat duties — landing, quiet-hours enforcement, evidence sweep, spine refresh; its branch-reporting and naming rules bind every agent. Read at conversation start and before landing.
---

# Seat Duties

Part of the fork's rules: moved here from `CLAUDE.md` so it loads only for the seat, the session that talks to the maintainer and lands on main, and it binds exactly as `CLAUDE.md` does. The seat reads it at the start of every conversation, before every landing, and before closing a wave or a work package. "Branch transparency" below binds every agent that works on a branch (R-2026-08-17-2), and its naming rule every agent that dispatches: `CLAUDE.md` "Branch Transparency" says when to read it.

## Campaign state

Campaign status (which campaigns are launched, their critical paths, current holds, and the
ruling that governs each) lives in the tracked
[`migration_doc/CAMPAIGN_STATE.md`](../../../migration_doc/CAMPAIGN_STATE.md), which is the **sole
campaign-status authority** (`R-2026-09-02-14`).
The `QUEUE_*_CAMPAIGN*.md` documents remain the row-level authorities. The GitHub quiet-hours and branch-transparency
HARD rules live only in `CLAUDE.md` and this skill; `CAMPAIGN_STATE.md` §2-§3 and
`ORCHESTRATION_HANDBOOK.md` §3 point there rather than restating them. The same-commit rule is `CLAUDE.md`'s ("Active Remediation Campaign"); it covers §0 too (the file's "How to update").

## Branch transparency

The obligations below still apply in full. The handoff doc they cite is
[`WORKER_ISOLATION_AND_BRANCH_HANDOFF.md`](../../../migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md).

**Worker naming (maintainer directive 2026-08-29):** every dispatched worker, reviewer, executor
and scoping agent is named after a Tolkien character, uniquely, and that name is the lane's
identity in the Agent description, the clone directory, the packet, the ledger and every status
line. The Fable seat is Gandalf. Convention: §8e of the handoff doc above; the registry and role
pools are the seat's memory `feedback_tolkien_worker_names.md`.

**Always tell the user, unprompted, when:**

1. **Starting a work package** — list any pre-existing local or origin branches besides `main` and offer to audit and clean them first. Run `git branch -a` to check; do not assume.
2. **Creating a new branch or worktree** — name it, say why, and commit upfront to a deletion plan (when it is deleted, and after what lands green).
3. **A sub-agent spawns a worktree branch** — surface the branch name in your reply, even if the agent ran in the background.
4. **Finishing a work package** — re-list all branches and explicitly ask whether to delete the now-redundant safety/feature/worktree branches before declaring the package done.
5. **At the start of every new conversation** if `git branch -a` shows anything besides `main` (and its remote tracker), open with a one-liner inventory.

Label refs and stashes by the git-stash convention in [`ORCHESTRATION_HANDBOOK.md`](../../../migration_doc/ORCHESTRATION_HANDBOOK.md) §3 (timestamped, descriptive; never a bare `git stash`).

## Landing

The quiet-hours rule itself is in `CLAUDE.md` ("GitHub Quiet Hours"); its enforcement:

Enforced mechanically (R-2026-08-14-4): `.husky/pre-push`
(`Tools/pre-push-guard.mjs`) refuses a push made inside the window and any
outgoing commit dated inside it, and also enforces the monotonic `Batch NNNN:`
prefix, a non-empty body and the `Co-Authored-By:` trailer (merge and
upstream-sync commits skip the message rules). It has no bypass flag;
`npm run verify-landing` makes a `--no-verify` push visible. In-window commits
from before the Batch-977 attestation are not precedent. Rules and specs:
`Tools/landing-rules.mjs`, `npm run test-landing-rules`, charter §6.

An optional second, adversarial Opus verifier (R-2026-09-11-1, `ORCHESTRATION_HANDBOOK.md` §7) may be added by the seat for
batches flagged as important; it is briefed to refute the packet, and a REFUTED verdict returns the lane before landing.

**Shared files at landing.** Every family edits the rig census in `rig-registry.spec.mjs`, `RIG_TAGS` and the
shrink-only `lib/*-allowlist.mjs` files; the seat rebases a frozen lane patch's hunks on those files onto the tip with
`Tools/landing/rebase-shared.mjs` instead of resolving the conflicts by hand.

The counterpart of `CLAUDE.md`'s Evidence Repatriation rule is that everything NOT repatriated is swept: agents and
sub-agents clean up after themselves once a task is completely finished and
pushed - the lane temp root, downloaded bundles, runner profiles and mutant
copies - and the seat runs `node Tools/temp-hygiene.mjs --plan` / `--execute`
after a push.
Procedure: [`WORKER_ISOLATION_AND_BRANCH_HANDOFF.md` §8i](../../../migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md) (the seat's sweep after a push).

After a landing:

- Refresh the seat's DB after a landing
  with `node Tools/landing/post-landing-spine.mjs` (the landing hook: it refreshes the spine and, when the
  landing touched the engine or the spine, imports Graphify incrementally; `npm run context-graphify` is that
  incremental import and works while the MCP server is up, a full `context-build` refuses while it holds the
  DB).
- Run `node Tools/temp-hygiene.mjs --plan`, then `--execute`, after the push (above).

## Wave-end gate

Before closing a wave, confirm its wave-end gate ran and was banked: the rule (R-2026-08-29-2) is in `/build-and-variants` "Wave-end gate", beside the commands the Edge executor runs.

## Clones and the context spine

`node Tools/provision-worker-clone.mjs <clone>` seeds the spine DB and `.mcp.json`;
  `--capsule <targets> [--capsule-role worker|reviewer]` also writes `<clone>/_review/context-capsule.md`;
  in a provisioned clone, read that capsule first when it exists.
Provisioning refreshes a seeded DB to the clone's HEAD (`--no-spine-refresh` skips it).
A clone cut before `worker-rules`, `probe-kit` and `seat-duties` existed lacks them, and an agent reading skills from its clone then has no route: before dispatching into an older clone, check that `<clone>/.claude/skills/worker-rules/SKILL.md` exists, and sync the clone if it does not.
