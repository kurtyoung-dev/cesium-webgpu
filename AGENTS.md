# Repository agent governance

**Part one is normative and self-contained: the technical rules below bind every change you make
to this fork's code, and you do not need another document to obey them.** Part two routes —
campaign status, authorization and landing discipline live in tracked documents, and this file
only says which one answers what. If two sources conflict on a governed question, the routed
document wins over this summary.

---

## Part one — fork rules that bind your code

These are the rules a change is rejected for breaking. `CLAUDE.md` carries the fuller
architectural treatment of several of them; where it does, it agrees with what is here.
(`.clinerules` used to hold that fuller treatment; as of 2026-09-05 its body is a pointer
to `CLAUDE.md`, which is the tracked rules authority.)

### 1. 64-bit precision / RTE — all rendering paths

- **NEVER** put a single `position: vec3<f32>` in a vertex buffer. Always `positionHigh` +
  `positionLow`.
- **NEVER** compute `mvp * vec4(position, 1.0)`. Always
  `mvpRelativeToEye * translateRelativeToEye(...)`.
- **NEVER** add `posHigh + posLow` directly. Always subtract the camera first.
- Uniform buffers carry `encodedCameraHigh`, `encodedCameraLow` and `mvpRelativeToEye`. Every
  renderer's `CameraUniforms` struct carries `previousViewProjection: mat4x4<f32>` at the tail
  (TAA, CSM and motion-vector passes read it); the JS pack writes column-major identity on the
  first frame.

### 2. `ShaderDefine` is add-only

`ShaderDefine` in `packages/engine/Source/Renderer/WebGPU/WebGPUShaderDefines.ts` is the
authoritative name/bit table, one bit per entry.

- **Never reorder, renumber or remove an entry**, even when its last consumer disappears.
  Reordering silently aliases cached shader modules; removal breaks any pipeline still holding
  the bit. Deprecated entries stay, marked by comment.
- `ShaderSourceId` follows the same rule. Source ID 0 is reserved.
- To add a bit: append it; document what it gates and which shaders consume it; in each
  consuming shader add `//>>ifdef FLAG_NAME` / `//>>else` / `//>>endif`, keeping the `//>>else`
  branch as the historical code path; route module creation through the preprocessor or the
  shader-module cache so the directives resolve. Unknown flag names throw at preprocess time.

### 3. Debug pragmas — both directions

The build strips `//>>includeStart('debug', pragmas.debug);` … `//>>includeEnd('debug');` from
production builds, in `.js` **and** `.ts`. The rule applies engine-wide, but the CI guard
(`npm run lint-debug-pragmas`, `Tools/lint-debug-pragmas.mjs`) only scans
`packages/engine/Source/Renderer/WebGPU` (277 files) — a violation elsewhere in the engine is
not caught mechanically.

- **WRAP:** per-frame and per-tile diagnostics; init-time informational messages; informational
  `console.log` / `console.warn`; and any log whose arguments do work — interpolation,
  `.toFixed()`, object stringification — even if nobody reads the output.
- **NEVER WRAP:** `console.error` for a real bug producing broken output (null blit target,
  index-buffer overflow, command-buffer invalidation, device lost); shader-compile and
  pipeline-creation failures; recovery-retry exhaustion; loop and re-entry sentinels. Real
  errors must always reach the console — that is how bugs get reported.

When a diagnostic has many call sites, put the throttle in a predicate whose body is
pragma-stripped, so it returns `false` in production and the call sites become removable dead
code.

### 4. Comment standard

Comments under `packages/engine/Source` and `packages/widgets/Source` — code, WGSL, GLSL and
shipped assets — must be seamless with upstream. **A comment describes what the code does and
the constraints it obeys; it never describes the work that produced it.** No batch numbers,
campaign or tracker IDs, row IDs, or dates: that history belongs in commit messages and
`migration_doc/**`, which these rules do not touch. The reviewer's test is the seamlessness
test — someone diffing a fork file against upstream must not be able to tell which comments are
ours by their voice. Comments must also stay JSDoc-clean for `npm run build-docs`, and derived
code must be attributed. Full rules:
[`Documentation/Contributors/CodingGuide/ForkCommentStandard.md`](Documentation/Contributors/CodingGuide/ForkCommentStandard.md).
This is enforced mechanically by `Tools/c16/comment-marker-guard.mjs` in lint-staged and in CI
(non-strict in both places): a violation is a **blocking error** only on a path listed in
`Tools/c16/comment-marker-cleanlist.txt` (859 of 2,204 in-scope files, ~39% — measured via
`npm run verify-comment-cleanlist`) or when run with `--strict`; elsewhere it is a **warning**
that does not block the commit. Adding a path to the clean list is what makes the guard
blocking for it.

Also: preserve existing JSDoc when modernizing; do not add new JSDoc that was not there; do not
add boilerplate restating what the code obviously does. Do add comments explaining non-obvious
_why_.

### 5. Backend agnosticism

- Scene code must **not** import from `Renderer/WebGPU/` and must **not** branch on `isWebGPU`.
- Backend-specific code lives in feature renderers reached through
  `context.getFeatureRenderer(FeatureRendererKey.X)`, with the WebGL path as the default
  fallback below it.
- Shared scene-level logic runs **before** any backend branch point.
- Extension and external code may read `context.rendererType` / `context.isWebGPU`, but should
  not branch on it.
- A new renderer-agnostic feature is implemented for **both** backends; a new shader feature
  needs both WGSL and GLSL unless that is architecturally impossible. Adding a property to
  `DrawCommand` means adding it to `WebGPUDrawCommand` too, and the reverse.

### 6. Where files live

Root `Source/` is **build output**. Never create or edit a file there.

| Content      | Edit here                                |
| ------------ | ---------------------------------------- |
| Engine code  | `packages/engine/Source/`                |
| WGSL shaders | `packages/engine/Source/Shaders/WebGPU/` |
| GLSL shaders | `packages/engine/Source/Shaders/`        |
| Widget code  | `packages/widgets/Source/`               |

Always create new files under `packages/*/Source/`.

### 7. Conduct as a worker

- **Workers never run git writes** — no `commit`, `stash`, `checkout`, `restore`, `reset`,
  `clean`. The orchestrator fetches your branch and commits from its own tree.
- One deliverable per dispatch. Write incrementally; do not hold a whole deliverable unsaved.
- Do not run builds or browsers unless your dispatch authorizes it.
- If you **observe** an unexpected change in the tree, **report it**. Never restore, revert or
  clean it — the change may be another lane's live work.
- A visually verifiable fix must be proven by an automated probe, never by asking the maintainer
  to look. If the work needs a probe you are not authorized to run, say so plainly and stop. Do
  not substitute a request for the maintainer to verify by eye, and do not claim a fix you have
  not observed.
- If you cite `file:line`, read those lines first. An audit finding or a queue row is a lead,
  not a premise; findings age and code moves.
- **Never rewrite files > 100 lines for code insertions/updates.** If the goal is to insert new
  code, append documentation, or modify existing logic, **ALWAYS** use targeted chunk replacements
  (`replace_file_content`). Never attempt a full-file rewrite (`write_to_file` with overwrite) on
  files longer than 100 lines.
- **Execution preference: node commands first.** Always prefer `node` / `npx` over platform shells
  (PowerShell, cmd, bash builtins) for script execution, tool verification, and diagnostics. Fall
  back to shells only when native shell wrapping is strictly unavoidable.
- **Clean up after yourself before you return.** Take scratch space through
  `Tools/lib/lane-tmp.mjs` (`withLaneTmp` removes the directory in a `finally` — on return, on
  throw, and on rejection) rather than `mkdtempSync(os.tmpdir())`, and remove everything you
  created outside your clone and its `_lane-out/` — lane temp root, downloaded bundles, runner
  profiles, mutant copies — saying in your reply what you removed. Check the Temp ROOT, not just your
  lane's namespace, and never write a backup straight to `%TEMP%` — `_lane-out/` is for that.
  Repatriate anything of value first; the durable places are `_lane-out/`,
  `Tools/visual-regression/output/` and the worker archive. Rule and measurement:
  [`migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md` §8i](migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md).

### 8. Operating notes for Codex — observed on this fork, 2026-09-06 → 09-10

These are normative, drawn from the seat's return audit of the September 6–9 sessions
(`migration_doc/audits/` and the seat record). They bind Codex sessions (Astra) in addition to §7.

#### Guards — what went wrong and the rule that prevents it

1. **Never work in the seat worktree.** `F:/Dev/GH/cesium-webgpu` is the landing seat; every agent,
   Codex included, works in an assigned clone (`F:/Dev/GH/cesium-astra-<yyyymmdd>` or a lane clone)
   whose `_lane-out/` holds its outputs. Three days of engine, tooling and archive work accumulated
   as uncommitted state in the seat and survived a `.git/index` truncation only by luck. A clone's
   loss costs a re-clone; the seat's loss costs the trunk.
2. **Every reviewed unit becomes a patch the same day.** Work is handed to the seat as
   `_lane-out/<name>.patch` (`git diff HEAD --binary --no-renames`) plus a packet, per unit, not as a
   dirty tree with a narrative. Uncommitted work older than one session is a handoff defect, not a
   checkpoint.
3. **Governance files need a lease and a ruling.** `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, the queue
   decision rows and `MAINTAINER_RULINGS_*.md` are edited only when the seat has leased the edit,
   and a rule is never softened to "an open ruling" without first checking the rulings record
   (the queue's `AR-D*` rows and every `MAINTAINER_RULINGS_*.md`, tracked or handed over). Numbered
   principles are appended, never inserted mid-list; a duplicate heading number is a review blocker.
4. **A spec without an npm runner home is a review blocker** (R-2026-08-29-1), including in your
   own landings: add the spec to the right `test-*` script in the same batch.
5. **An instrument that refuses every run is a ruling request, not a work queue.** When an
   apparatus cannot produce a verdict under its current constraint (a response cap, a missing
   fixture), file the ruling request in the same session and keep measuring by source review in
   parallel — the two product defects this wave found came from reading code, not from the capture
   apparatus that consumed most of the effort.
6. **No dependency mutation outside an owned clone**, and none in a served or shared clone. A bare
   `npm install` in the served clone put a registry `@cesium/engine` under `packages/node_modules`
   and broke the widgets bundle. Every install command is captured with its exit code, and the
   lock, manifest and installed tree are reconciled in one reviewed batch.
7. **Archival and doc moves are maintainer-held** (hold of 2026-06-30) until lifted in writing;
   moving files without the hold lifted leaves the tree half-landed and the index guard red.

#### Keep doing — what was right and is now expected

- Records that are literal and checkable: byte counts and SHA-256s that verify (every one the
  audit tested) and paths that resolve (ten of eleven named artifacts at the stated path). Keep
  hashing what you hand over.
- Ruling requests instead of assumptions; red evidence kept red and named as red; the same
  reviewer-independence you applied to your own dependency work.
- Recovery discipline: dry run, approval, byte-verified backups, a packet — the index recovery is
  the model for any repair of shared state.
- Source review first. Lead with reading the shader and the renderer; build apparatus to confirm
  what the reading predicts, not to discover it.

---

## Part two — where governed questions are answered

**Do not begin campaign work, and do not commit, build, run a browser, publish evidence, or
change external state, until you have read the documents that govern that act.** Reading a
router is not the same as being briefed.

**Precedence.** The binding order, tie-break included, lives in one tracked place:
[`migration_doc/EXECUTOR_LANE_CHARTER_2026-08-14.md`](migration_doc/EXECUTOR_LANE_CHARTER_2026-08-14.md)
**§0.4 [HARD]**. This file deliberately does not restate it. If two sources conflict and §0.4
does not decide, stop and report the conflict rather than choosing.

| You need                                                                                                     | Read                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Verdict vocabulary and exit codes (`PASS` 0 / `FAIL` 1 / `ERROR` 2 / `STRUCTURAL` 3)                         | Charter §1 status table; the frozen table is `Tools/visual-regression/lib/verdict-exit-gate.mjs`                                                                                                                                                                                            |
| That a measured red is never de-scored, demoted or quarantined                                               | Charter §1.1 `[HARD]`; escalation route in §5                                                                                                                                                                                                                                               |
| Evidence prerequisites, the clean validation manifest, banking a citation                                    | Charter §1.7 `[HARD]`                                                                                                                                                                                                                                                                       |
| Capacity, pausing, freezing, and the handoff you owe                                                         | Charter §4                                                                                                                                                                                                                                                                                  |
| Whether the campaign is paused or resumed **right now**                                                      | [`CAMPAIGN_STATE.md`](migration_doc/CAMPAIGN_STATE.md) — the **sole campaign-status authority** (`R-2026-09-02-14`). On a live dispute a maintainer ruling in `migration_doc/MAINTAINER_RULINGS_*.md` still outranks it — **newest file wins, newest ruling within it** — check there first |
| Branch, clone, path-lease and rebase rules; the handoff report you owe                                       | [`migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md`](migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md)                                                                                                                                                                              |
| **Your dispatch rules as a worker** — clone readiness, reporting window, negative controls, lease deviations | The same document, §8a–§8c                                                                                                                                                                                                                                                                  |
| Who may commit, and how                                                                                      | `R-2026-08-18-28` and the charter's landing discipline (§2). Part one §7 states the worker half                                                                                                                                                                                             |
| Orchestration pattern; untrusted-content doctrine                                                            | [`migration_doc/ORCHESTRATION_HANDBOOK.md`](migration_doc/ORCHESTRATION_HANDBOOK.md)                                                                                                                                                                                                        |
| Git identity and authentication                                                                              | `ORCHESTRATION_HANDBOOK.md` §3 (operating detail); charter §2.6 governs identity-switching restraint                                                                                                                                                                                        |
| How your predecessor performed, and what to focus on                                                         | [`migration_doc/CODEX_SOL_OPERATING_BRIEF.md`](migration_doc/CODEX_SOL_OPERATING_BRIEF.md) — coaching, not rules                                                                                                                                                                            |

## Workflows

- [`run-cesium-campaign-lane`](.agents/skills/run-cesium-campaign-lane/SKILL.md) — authorized
  campaign execution, resume, pause, handoff.
- [`audit-cesium-certification`](.agents/skills/audit-cesium-certification/SKILL.md) —
  independent read-only certification or evidence review. **Do not combine reviewer and
  repair-author roles in one pass** (charter §4.6).

Skills organize work. They do not grant authority.
