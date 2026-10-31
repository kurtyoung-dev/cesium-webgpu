# Repository agent governance — Codex

**Every rule for this fork lives in [`CLAUDE.md`](CLAUDE.md). Read it first, in full, before you
do anything; this file carries only what is specific to Codex** (R-2026-10-30-M2). `CLAUDE.md`
binds your code (RTE precision, the add-only shader define registries, debug pragmas, the fork
comment standard, backend agnosticism, file placement, the probe kit, the context spine) and your
conduct: its "Rules Files and Routing" section says where agents work, what binds every worker, and
which tracked document answers each governed question. Precedence between sources is
`EXECUTOR_LANE_CHARTER_2026-08-14.md` §0.4; this file grants no state-changing authority.

## Codex specifics

- **Your clone, never the seat.** Codex works in its assigned clone (`F:/Dev/GH/cesium-astra-<yyyymmdd>`
  or a lane clone) and hands over through its `_lane-out/`; it never works in the seat worktree
  `F:/Dev/GH/cesium-webgpu` (R-2026-10-30-M3). Three days of engine, tooling and archive work once accumulated as
  uncommitted state in the seat and survived a `.git/index` truncation only by luck.
- **Wiring, capacity preflight and trust scope:**
  [`WORKER_ISOLATION_AND_BRANCH_HANDOFF.md`](migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md) §8.
- **Context spine** (`CLAUDE.md` Principle 13): for Codex its MCP server is named
  `cesium_context_spine`. Registering it is the seat's to run, once the seat lifts its "not yet"
  (E2); Codex does not run `codex-mcp-config.mjs --install` itself.

## On-demand rule files

`CLAUDE.md` keeps its task-specific rules in skill files that Claude Code loads on demand. They bind
you as fully as `CLAUDE.md` does: read the matching file before the work it covers (`CLAUDE.md`,
"On-demand Skills", says when).

- [`.claude/skills/wgsl-shader-pipeline/SKILL.md`](.claude/skills/wgsl-shader-pipeline/SKILL.md) — WGSL shader defines, the `//>>ifdef` preprocessor, the module cache, adding a define bit, pipeline-key aliasing.
- [`.claude/skills/build-and-variants/SKILL.md`](.claude/skills/build-and-variants/SKILL.md) — build and test commands, bundle variants, compat exemptions, smoke test, visual regression, Playwright / Edge.
- [`.claude/skills/logging-pragmas/SKILL.md`](.claude/skills/logging-pragmas/SKILL.md) — engine logs: what takes a debug pragma, what stays permanent, sentinels for new subsystems.
- [`.claude/skills/upstream-sync/SKILL.md`](.claude/skills/upstream-sync/SKILL.md) — merging CesiumGS `upstream/main` into the fork.
- [`.claude/skills/wasm-strategy/SKILL.md`](.claude/skills/wasm-strategy/SKILL.md) — WASM bridges, fallbacks, loading, memory, toolchains, threading.
- [`.claude/skills/debug-console/SKILL.md`](.claude/skills/debug-console/SKILL.md) — `CesiumDebug` console commands; recording a fixed bug.

## Keep doing — observed on this fork, 2026-09-06 → 09-10

Drawn from the seat's return audit of the September 6–9 sessions (`migration_doc/audits/` and the
seat record).

- Records that are literal and checkable: byte counts and SHA-256s that verify (every one the
  audit tested) and paths that resolve (ten of eleven named artifacts at the stated path). Keep
  hashing what you hand over.
- Ruling requests instead of assumptions; red evidence kept red and named as red; the same
  reviewer-independence you applied to your own dependency work.
- Recovery discipline: dry run, approval, byte-verified backups, a packet — the index recovery is
  the model for any repair of shared state.
- Source review first. Lead with reading the shader and the renderer; build apparatus to confirm
  what the reading predicts, not to discover it.

## Workflows

- [`run-cesium-campaign-lane`](.agents/skills/run-cesium-campaign-lane/SKILL.md) — authorized
  campaign execution, resume, pause, handoff.
- [`audit-cesium-certification`](.agents/skills/audit-cesium-certification/SKILL.md) —
  independent read-only certification or evidence review. **Do not combine reviewer and
  repair-author roles in one pass** (charter §4.6).

Skills organize work. They do not grant authority.
