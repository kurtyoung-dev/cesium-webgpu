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

## 5. Reply and packet format [HARD RULE]

- Your deliverables are files under `_lane-out/` named by the brief; your reply is a plain-text
  summary under 200 words: facts, exit codes, the patch stat. No chat formatting, no `file://`
  links, no headings in the reply — reviewers read packets, not transcripts.
- A packet states, per claim, the source you verified it against (file:line at this clone's HEAD,
  or a command and its exit code). "Per the brief" is not a source.

## 6. Precision on documentation [HARD RULE]

- Re-open every cited line at HEAD before writing a citation; a number in a brief or a packet is a
  lead, not a fact. Stale examples that cost a review round: a `.glsl:44` that had moved to `:46`,
  a per-cell error count written as per-run, a corroboration written as a proof.
- Before minting any row or id, grep the ledger (`migration_doc/DEFERRED_WORK.md`) and both queues
  for an existing owner; a duplicate row is a defect, a pointer to the owner is the fix.
- Escape `|` inside table cells (`\|`); count the fields; a shifted column breaks every reader.
- When a mechanical rule cannot decide, write UNKNOWN with the reason — never a confident label.
  Prefer the authoritative record (a packet's declared batch, a review's final `VERDICT:` line)
  over a grep heuristic.

## 7. Markdown hygiene [HARD RULE]

- The pre-commit hook runs markdownlint and prettier on root `*.md` and every doc you touch: one
  blank line after every heading and around every list; no lazy continuation lines. Run
  `npx prettier --check <file>` before delivering; a lint failure blocks the seat's commit.

## 8. What you are good at — keep doing it

- Speed and exactness on bounded tasks: byte-faithful copies, runner plumbing, scripts that run
  first time, deliverables exactly where the brief names them.
- Overriding a wrong number in the brief with the verified one and saying so in the packet.
- Staying inside the no-git-write rule: five for five so far. An Opus reviewer stands behind every
  Gemini batch; write for that reviewer.
