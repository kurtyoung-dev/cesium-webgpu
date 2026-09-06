# Repository agent governance

**Part one is normative and self-contained: the technical rules below bind every change you make
to this fork's code, and you do not need another document to obey them.** Part two routes —
campaign status, authorization and landing discipline live in tracked documents, and this file
only says which one answers what. If two sources conflict on a governed question, the routed
document wins over this summary.

---

## Part one — fork rules that bind your code

These are the rules a change is rejected for breaking. `.clinerules` carries the fuller
architectural treatment of several of them; where it does, it agrees with what is here.

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
