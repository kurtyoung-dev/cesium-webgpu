# CLAUDE.md — CesiumJS WebGPU Project Rules

This file is the fork's one rules file for every agent — Claude, Codex, Gemini and Cline alike (see "Rules Files and Routing"). Task-specific rules live in on-demand skills (see "On-demand Skills"): they bind exactly as this file does, and work their task covers starts by reading them.

## Load by role

| You are                                           | Also read, before your first action        |
| ------------------------------------------------- | ------------------------------------------ |
| the seat (talks to the maintainer, lands on main) | `/seat-duties`                             |
| a lane lead, a reviewer or an Edge executor       | `/worker-rules`; your brief names the rest |
| a worker or scout in a clone                      | your brief and `/worker-rules`             |
| Codex, Gemini or Cline                            | your pointer file, then the row that fits  |

Any agent in a provisioned clone reads `<clone>/_review/context-capsule.md` first when it exists.

## Active Remediation Campaign — see CAMPAIGN_STATE.md

Campaign status lives in [`CAMPAIGN_STATE.md`](migration_doc/CAMPAIGN_STATE.md) (`R-2026-09-02-14`); read its §0 first (Read limit 45). This section is a pointer, not a mirror — do not restate campaign facts here; edit `CAMPAIGN_STATE.md` instead, in the same commit as any campaign-level change.

## Core Principles

### 1. Preserve Existing Functionality

- WebGL rendering must continue to work correctly — **never break existing WebGL behavior**; all existing APIs must continue to work as expected, backward compatibility with existing CesiumJS applications must be maintained, and all existing tests must continue to pass
- Upstream WebGL files **may be modified** when it improves overall architecture — the goal is preserving _functionality_, not preserving _code as-is_

### 2. Backend Agnosticism (Three.js + PlayCanvas Hybrid)

- Scene code must be **backend-agnostic** — it should NOT import from `Renderer/WebGPU/` or check `isWebGPU`
- All backend-specific code lives in **Feature Renderers** accessed through `GraphicsContext`
- External/extension code CAN query context type via getters (`context.rendererType`, `context.isWebGPU`) but should NOT branch on it
- The `GraphicsContext` architecture: `/engine-code-standards`.

### 3. Multi-Context Support

- Every `GraphicsContext` instance has a **unique ID** (`context.id`) and its own `rendererType`
- Error logs MUST include context ID: `[CesiumJS:webgpu:ctx-a3f7] Pipeline creation failed`
- Registry, per-`View` contexts, device sharing: `/engine-code-standards`.

### 4. WebGL2 Targeting

- Our fork targets **WebGL2 only** — we do NOT actively maintain WebGL1 fallback paths

### 5. WebGL/WebGPU Feature Parity — CRITICAL

When implementing features for **either** backend, check whether the same improvement should also be applied to the **other** backend.

- **New renderer-agnostic features** MUST be implemented for **both** backends simultaneously
- **New shader features** need both WGSL and GLSL implementations (unless architecturally impossible in WebGL)
- **When adding a property to `DrawCommand`**, also add it to `WebGPUDrawCommand` (and vice versa) — including the options interface, `clone()`, and any sorting/dispatch logic
- Before calling a feature or fix complete, run the parity checklist in `/engine-code-standards`.

### 6. Feature Inventory — Scope the Impact of Every Change — CRITICAL

**Before scoping the impact of any change**, cross-reference the affected subsystem(s) in [`FEATURE_INVENTORY.md`](migration_doc/FEATURE_INVENTORY.md), and update it when a feature ships or starts, as `/engine-code-standards` says. **Don't let the inventory go stale** — it's load-bearing for impact analysis.

### 7. "Dead" Code Audit — Cross-Reference Architecture Docs Before Removing — CRITICAL

**Before deleting any code that appears unused**, run the four checks and read what is NOT proof of deadness in `/engine-code-standards`. **When in doubt, leave the scaffolding in place.**

### 8. Verify Rendering Fixes via Playwright — DO NOT ask the user to verify visual output — CRITICAL

If a fix is visually verifiable (renders a globe, sky, tiles, post-process effects, picking, etc.), the verification must be done via an automated Playwright probe BEFORE the fix is claimed to work — not by asking the user to reload and inspect.

Before you start fixing a rendering bug, write or run probe code, or claim a visual fix works, read `/probe-kit` (workflow, anti-patterns, kit-first order).

### 9. Surface Missing/Deferred Functionality as Immediate Next Work — CRITICAL

When investigating a bug, if the root cause turns out to be **unfinished, missing, or explicitly-deferred functionality** (not a regression in working code), do not paper over it — surface it as the next concrete work item.

**Required behavior:**

- If a fix is gated on functionality that doesn't exist yet, name the missing piece in the response and add it to the todo list as the next immediate item.
- If it is not tracked in `DEFERRED_WORK.md` or `FEATURE_INVENTORY.md` §C (WIP) / §D (FUTURE), add it.
- Do not silently route around missing functionality with an inline hack at the call site — that creates the kind of partial-implementation debt that Principle 7 ("dead code audit") warns against.
- If the user is blocked by the missing functionality, say so plainly so they can prioritize.

This is the corollary of Principle 7: keep scaffolding in place AND finish the work the scaffolding implies.

### 10. Brief From Verified Premises — CRITICAL

**Before you brief work — for a subagent, or for yourself:**

- **If you cite `file:line`, read those lines now.** An audit finding, a queue row, or a prior
  session's note is a LEAD, not a premise.
- **State the observable behaviour to assert, never the implementation shape.**
- **A spec written from the same brief as the fix is not an independent check.** Independence requires a different source — the behaviour itself, or a different
  reviewer.
- **Mutate for inertness, not just absence.** Make the fix _unreachable_ — `if (false && …)` — and see whether the spec still passes.
  A spec that greps source asserts text shape, not that the branch is live.

Verification has three tiers and each catches a class the others cannot: mechanical checks (does it
run, is it in scope), substantive review (is the code correct), and **independent re-derivation of
the premises**. Only the third catches a false diagnosis. A green mechanical check means "ready for
review", never "correct".

This principle applies whether or not a subagent is involved; dispatch mechanics and evidence: [handoff doc](migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md) §8a–§8c.

### 11. File Editing Discipline: Never Rewrite Files > 100 Lines — CRITICAL

- **NEVER rewrite or overwrite an existing file longer than 100 lines** when the goal is to insert new code, add documentation, or modify existing functionality.
- **ALWAYS use targeted chunk editing (`replace_file_content`)** or surgical insertion. Never replace the entire file content with `write_to_file(Overwrite=true)`.
- Full file rewrites on files > 100 lines are strictly prohibited.

### 12. Command Execution Preference: Node Commands First — CRITICAL

- **ALWAYS prefer `node` / `npx` commands first** for scripts, evaluation, inspection, and tooling (`node script.mjs`, `node -e "..."`, `npx ...`).
- **NEVER use PowerShell (`pwsh`), cmd, or shell builtins unless strictly required** (e.g. for environment variables or platform operations where Node is not viable).

### 13. Context Spine — Scope With It, Verify at HEAD

The context spine (`Tools/query-context.mjs`, MCP server `cesium-context-spine`; [guide](migration_doc/CONTEXT_SPINE_GUIDE.md), whose reader note gives the line ranges) is a preferred first step
for scoping a change. It is not an authority, and it never replaces Principle 10.

- **Prefer a pack to a cold read.** Before reading a multi-thousand-line hotspot whole, run `node Tools/query-context.mjs impact <file|symbol|key>` (MCP `cesium_impact_pack`).
- **A pack is a lead, not a premise.** Re-open every `file:line` it cites at HEAD before you brief or edit,
  and treat its regime tags, rig covers and contract labels as candidates. The spine's contract output is a scoping lead, never a gate; never cite it as one.
- **Rulings** come back ranked by Charter §0.4 (`node Tools/query-context.mjs ruling <id>`, MCP `cesium_query_ledger`); cite the ruling's own file and line, not the pack.
- **Clones.** A worker may run `npm run context-refresh` in its own clone, but never `--bootstrap-graphify`: it downloads from the Python package
  index and installs into the tree, so it is the seat's to run. Provisioning, the capsule and the spine refresh after a landing: `/seat-duties`.

## Proof Bar and Wave-End Gate

**Proof bar by change class (maintainer ruling R-2026-08-29-1):** engine, parity and shader changes keep
the full bar (behaviour spec + inertness mutant + separate review + the named Edge leg). Tools changes
carry a spec only where there is logic worth pinning AND an npm runner home. Docs, comments and demo
text carry review plus one capture where visual - no spec. A spec with no runner home is a review
blocker. Where a probe can measure the feature directly, the probe is the acceptance.
The optional adversarial verifier: `/seat-duties`; the wave-end gate: `/build-and-variants`.

## Probe Kit - Kit First (maintainer rule, 2026-10-08)

When we need probe functionality, we first see if it already exists; if it does not, we create a new modular piece. **Never** a bespoke probe or driver that launches its own browser. The order and guide sync: `/probe-kit`.

## Engine Code Standards — Non-negotiables (full rules: /engine-code-standards)

Any change under `packages/**` starts by reading `/engine-code-standards`.

- **RTE:** vertex buffers carry `positionHigh` + `positionLow`, never a single `position: vec3<f32>`; never `mvp * vec4(position, 1.0)`, always `mvpRelativeToEye * translateRelativeToEye(...)`; `CameraUniforms` ends with `previousViewProjection` (DP-H41).
- **Placement:** edit `packages/engine/Source/` and `packages/widgets/Source/`; NEVER create or edit files in root `Source/` (build output).
- **Language:** prefer TypeScript for new code; `any` is banned as a variable, parameter or return type in `.ts` and `.d.ts` alike (except third-party interop where the upstream type is genuinely `any`).
- **Comments:** the fork comment standard — comments under `packages/engine/Source` and `packages/widgets/Source` describe what the code does, never the work that produced it (no batch numbers, row ids or dates); `Documentation/Contributors/CodingGuide/ForkCommentStandard.md`.
- **Size:** files over ~1,000 lines are decomposed when touched functionally (not performance-critical math classes or pure data); the main class keeps its file and name; record it in `migration_doc/ES6_MODERNIZATION_STATUS.md`.

## GitHub Quiet Hours — HARD RULE (maintainer, 2026-08)

On WEEKDAYS between 07:00 and 19:00 US Eastern: **no `git commit`, no
`git push`, no visible GitHub activity of any kind.** Commits carry visible
timestamps even if pushed later, so do not commit during the window either —
hold work as uncommitted worktree state / exported patches and land in
batches after 19:00 ET. Weekends and 19:00–07:00 are unrestricted. Check
`date` before every commit/push; the machine clock is authoritative.
Local-only work (builds, probes, workers, edits) is unaffected. Record a
blocked landing as a "LANDING WINDOW OPENS 19:00 ET" todo and carry on with
non-git work.

Enforcement (the pre-push guard, the commit-message rules and their specs): `/seat-duties`.

## Branch Transparency — CRITICAL

Workers get **clones, not worktrees**, landings are **squash-only**, and every dispatch begins with a capacity preflight ([handoff doc](migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md)).

The user's working model is "trunk-only — no long-lived branches." Surface branch state proactively whenever a work package is being scoped, started, paused, or closed. Do not let safety branches, worktree branches, or agent branches accumulate silently.

Before you start a work package, create a branch or worktree, dispatch a lane or finish a package, and at the start of a conversation, read "Branch transparency" in `/seat-duties`: its duties bind every agent that works on a branch (R-2026-08-17-2), and its naming rule every agent that dispatches.

## Evidence Repatriation - CRITICAL (maintainer rule, 2026-08-21)

When finishing out a local branch, worker clone, or worktree, copy any high-quality visual evidence it produced (probe PNGs, pixel-diff images, capture reports) into the main repo's gitignored `Tools/visual-regression/output/`, preserving the probe's own subdirectory layout, BEFORE resetting or deleting the clone. Certification-grade artifacts additionally bank in `f:/Dev/GH/cesium-webgpu-visual-evidence` (immutable). Evidence
that dies with a clone reset is a handoff defect.

Everything NOT repatriated is swept: agents and sub-agents clean up after themselves once a task is completely finished and pushed - the lane temp root, downloaded bundles, runner profiles and mutant copies. Scratch space is taken through `Tools/lib/lane-tmp.mjs` (one
sweepable root per lane). A worker may run `node Tools/temp-hygiene.mjs --plan` (read-only) and report it; `--execute` is the
seat's.

## Rules Files and Routing — One Source (R-2026-10-30-M2)

**This file is the one rules file for every agent on the fork.** `AGENTS.md` (Codex), `GEMINI.md` (Gemini) and `.clinerules` (Cline) are pointers carrying only what is specific to their agent. A rule that binds
every agent is written here once; where an agent file or a `migration_doc` page restates one, replace
the restatement with a pointer here.

**Where agents work (R-2026-10-30-M3).** An LLM that does not hold the seat works in its own clone,
never in the seat worktree `F:/Dev/GH/cesium-webgpu`, unless the maintainer says otherwise; only the
seat lands on main. The maintainer may hand the seat to another LLM, and the others adapt and clean
up after the handover.

**Conduct that binds every worker.** The worker rules are
[`WORKER_ISOLATION_AND_BRANCH_HANDOFF.md`](migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md) §7
(path lease; no git writes; never `npm install`; no build or browser unless the dispatch authorizes
it; a mechanical handoff report), §8a-§8c (one deliverable per dispatch, negative controls, verifying
claims) and §8i (temp hygiene). In addition:

- Write a deliverable to disk incrementally; never hold a whole deliverable unsaved.
- If you **observe** an unexpected change in the tree, **report it**; never restore, revert or clean
  it — it may be another lane's live work.
- If the work needs a probe you are not authorized to run, say so plainly and stop (Principle 8:
  never substitute a request for the maintainer to verify by eye).
- Every reviewed unit becomes `_lane-out/<name>.patch` (`git diff HEAD --binary --no-renames`) plus a
  packet the same day. Uncommitted work older than one session is a handoff defect, not a checkpoint.
- No dependency mutation outside an owned clone, and none in a served or shared clone. Every install
  command is captured with its exit code, and the lock, manifest and installed tree are reconciled in
  one reviewed batch.
- An instrument that refuses every run is a ruling request, not a work queue: file the request in the
  same session (charter §1.1) and keep measuring by source review in parallel.
- Governance files (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.clinerules`, `.claude/skills/**`, `.claude/agents/**`, the queue decision rows and
  `MAINTAINER_RULINGS_*.md`) are edited only under a seat lease, and a rule is never softened to "an
  open ruling" without first checking the rulings record (the queue's `AR-D*` rows and every
  `MAINTAINER_RULINGS_*.md`). Numbered principles are appended, never inserted mid-list; a duplicate
  heading number is a review blocker.
- Archival and doc moves are maintainer-held (hold of 2026-06-30) until lifted in writing.

**Where governed questions are answered.** Do not begin campaign work, and do not commit, build, run a
browser, publish evidence or change external state, until you have read the document that governs
that act. Reading a router is not the same as being briefed.

- Precedence between sources, tie-break included: [Charter](migration_doc/EXECUTOR_LANE_CHARTER_2026-08-14.md) §0.4 `[HARD]`; if it does not decide, stop and report the conflict.
- Verdicts and exit codes: Charter §1.
- That a measured red is never de-scored, demoted or quarantined: Charter §1.1 `[HARD]`; escalation route in §5.
- Evidence prerequisites, the clean validation manifest, banking a citation: Charter §1.7 `[HARD]`.
- Capacity, pausing, freezing, the handoff you owe: Charter §4.
- Whether the campaign is paused or resumed **right now**: `CAMPAIGN_STATE.md` §0; a maintainer ruling in `MAINTAINER_RULINGS_*.md` outranks it — newest file wins, newest ruling within it.
- Branch, clone, lease, rebase and handoff rules: `/worker-rules`; procedure in the handoff doc.
- Who may commit, and how: `R-2026-08-18-28` and Charter §2.
- Orchestration, untrusted content, git identity: [`ORCHESTRATION_HANDBOOK.md`](migration_doc/ORCHESTRATION_HANDBOOK.md) (§3 identity; Charter §2.6 restraint).
- Symbols, seams, rulings, contracts, rigs: Principle 13.
- Which doc answers a question: [`migration_doc/README.md`](migration_doc/README.md) indexes every migration doc; start there, and trust it over any single doc's self-description.

## On-demand Skills

Each is `.claude/skills/<name>/SKILL.md`: Claude Code invokes `/<name>`; other agents, and agent types without `Skill`, read the file. They bind exactly as this file does, and **the work a skill covers starts by reading it**.

- `/seat-duties` — the seat: at conversation start, before every landing, before closing a wave or a work package; every agent: see "Branch Transparency".
- `/worker-rules` — before briefing or reviewing a lane; a lane agent before its first action.
- `/engine-code-standards` — before making or reviewing any change under `packages/**`, before deleting code that looks unused, when a feature ships.
- `/probe-kit` — before fixing a rendering bug, writing or running probe code, or claiming a visual fix works.
- `/wgsl-shader-pipeline` — before adding or changing a WGSL shader variant, a `ShaderDefine*` or `ShaderSourceId` entry, an `//>>ifdef` block, or shader-module / pipeline-cache keying.
- `/build-and-variants` — before building, testing, running visual regression or Playwright / Edge, touching the variant plugin, entry barrels or `sideEffects`, or adding a file under `Renderer/WebGPU/`.
- `/logging-pragmas` — before adding or changing a log or debug pragma in engine code, and when creating a new renderer / pipeline subsystem (its permanent sentinels).
- `/upstream-sync` — before merging CesiumGS `upstream/main`.
- `/wasm-strategy` — before WASM module, bridge or toolchain work.
- `/debug-console` — when debugging with `CesiumDebug`, fixing a bug, or adding a CesiumDebug command, a probe or a debug mode.
