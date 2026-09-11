# Antigravity & Gemini Rules — Cesium WebGPU

## 1. File Editing Discipline: Never Rewrite Files > 100 Lines [HARD RULE]

- **NEVER rewrite or overwrite an existing file longer than 100 lines** when the goal is to insert new code, add documentation, or modify existing functionality.
- **ALWAYS use targeted chunk editing (`replace_file_content`)** or surgical insertion. Never replace the entire file content with `write_to_file(Overwrite=true)`.
- Full file rewrites on files > 100 lines are strictly prohibited to prevent accidental code omissions, large diff bloat, context exhaustion, and regression risks.

## 2. Git Safety & Destructive Command Prohibition [HARD RULE]

- **NEVER execute potentially destructive git commands** (`reset`, `restore`, `checkout`, `clean`, `revert`, `branch -D`, `stash drop`).
- **NEVER execute remote push operations** (`git push`).
- All git writes, branch switching, and push events are handled personally by the user. Antigravity and subagents run only read-only status, inspection, and diff queries.

## 3. Worker Governance & Precision Standards

- All code must adhere to `AGENTS.md` Part One:
  - 64-bit RTE emulated precision on all rendering paths (`positionHigh` + `positionLow`, `mvpRelativeToEye`).
  - Add-only `ShaderDefine` registry (never reorder or delete bits).
  - Debug pragma wrapping (`stripPragmaPlugin`) for all non-critical logs.
  - Upstream-seamless fork comment standard (no tracker, batch, or agent IDs in engine code).

## 4. Execution Preference: Node Commands First [HARD RULE]

- **ALWAYS prefer `node` / `npx` commands first** for scripts, evaluation, inspection, and tooling (`node script.mjs`, `node -e "..."`, `npx ...`).
- **NEVER use PowerShell (`pwsh`), cmd, or shell builtins unless strictly required** (e.g. for environment variables or platform operations where Node is not viable).
- This ensures cross-platform consistency, avoids shell escaping and interpolation bugs, and guarantees deterministic execution across Windows, Linux, and macOS.

Tracked as of this batch; the pyramid's worker rules and naming live in `WORKER_ISOLATION_AND_BRANCH_HANDOFF.md`; Gemini workers never run git write commands (see §2).
