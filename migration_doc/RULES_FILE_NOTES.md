# Rules File Notes — history and measurements trimmed from CLAUDE.md

**What this is.** Append-only home for the stories, worked examples and dated measurements that the
rules-file diet moved out of `CLAUDE.md` so the rules file every agent loads stays lean. **Nothing here
is a rule**: the rules are [`CLAUDE.md`](../CLAUDE.md) and its on-demand skills under `.claude/skills/`.
Each section names the principle or section it came from; the text is carried verbatim. Append new
sections at the end; never rewrite an old one.

## 1. Principle 7 ("Dead" Code Audit) — the origin story and its inversion

The current disposition of the code in this story is the ledger's
([`DEFERRED_WORK.md`](DEFERRED_WORK.md)), never this anecdote; the near-miss is also catalogued in
[`ISSUES_AND_FIXED_BUGS.md`](ISSUES_AND_FIXED_BUGS.md) and the inversion in
[`CODEX_SOL_OPERATING_BRIEF.md`](CODEX_SOL_OPERATING_BRIEF.md) item 11.

**Origin context:** during the C-R8 audit (2026-04-28), I nearly removed `WebGPUTranslucentTileClassification`'s `_classificationColorTexture`, `composite()`, and `_runTranslucentTileClassificationComposite` because the texture was never written and the composite was a visual no-op. The file's own docstring at lines 11-19 explicitly listed the accumulation target + composite pipeline as Batch 47 deliverables for the unfinished multi-frustum accumulation work. The user caught the mistake before it landed. This rule was added so future sessions don't repeat it.

**The origin story above is HISTORY, not the current disposition of that code.** The
ledger (`DEFERRED_WORK.md`) later CLOSED multi-frustum classification (the
depth-sample approach needs neither accumulation nor composite) and SCHEDULED the
scaffolding's removal as its own cleanup. On 2026-08-21 two workers and the
orchestrator all reconstructed a comment from this origin story instead of the
ledger, inverting a remove-later disposition into a must-not-remove claim. The
principle (check before deleting) stands; the example's FACTS do not - always
re-derive a file's current disposition from the ledger, never from a governance
doc's illustrative anecdote.

## 2. Principle 13 (Context Spine) — the measurements and the audit behind "a pack is a lead"

Measured 2026-10-29 (lane GWIP, HEAD `c7c7bc6d35`): a pack is 3-17 KB and takes about 0.45 s from the CLI, against 82-474 KB for reading `WebGPUShaderDefines.ts`, `Scene.js`, `WebGPUContext.ts` or `GlobeTerrain.wgsl` whole.

The same audit found a 150 m ground rig tagged `orbital`, a registry-key pack anchored on the wrong rows, and a missing target reported without a warning (all three repaired in that lane), and an RTE rule that labelled 57 rule-conformant lines as violations of the RTE rule ("64-Bit Precision & RTE" below), 47 of them the camera's own `encodedCameraHigh + encodedCameraLow` (retuned in that lane: a hazard now needs a shader to project a High+Low sum, giving 0 hazards and 51 review rows at `c7c7bc6d35`).

## 3. The former "Key Reference Files" list

[`README.md`](README.md) is the maintained index; this is the list as it stood in `CLAUDE.md`. The two
sync duties (`DEBUGGING_GUIDE.md`, `IMAGERY_PROJECTION.md`) stay in `CLAUDE.md` as rules.

- `.clinerules` — the fork's original Cline rules file. **It is no longer a rules authority**: as of this batch its body is a pointer to this file, which is the tracked rules authority. Precedence between the tracked governance documents is set by `EXECUTOR_LANE_CHARTER_2026-08-14.md` §0.4, not here.
- `migration_doc/WEBGPU_MIGRATION_STATUS.md` — Overall migration progress (historical for the coverage gap 2026-05-30 → 2026-08-06 per `README.md:214`; batch numbers are non-monotonic — trust dates/hashes)
- `migration_doc/WEBGPU_MIGRATION_BACKLOG.md` — Historical (body stops ~Batch 64 per `README.md:217`); the execution frontier is the live campaign queues, not this file
- `migration_doc/WEBGPU_DEBUGGING_LOG.md` — Chronological bug log (search before debugging a new artifact)
- `migration_doc/DEBUGGING_GUIDE.md` — **Single entry point for debugging tools + procedures.** Decision tree, CesiumDebug command catalog, probe inventory, WGSL pragma patterns. **MUST be kept in sync whenever you add a new CesiumDebug command, probe, or globe-fragment debug mode.** A guide that drifts becomes worse than no guide.
- `migration_doc/README.md` — **Index of all migration docs (LIVE vs ARCHIVED).** Start here; trust it over any single doc's self-description.
- `migration_doc/ARCHITECTURE_REVIEW_2026-09-02.md` — Current feature-renderer / wiring / architecture / maintainability review (the 2026-04-30 audit trio it supersedes moved to `migration_doc/archive/audits-2026-04-30/` on 2026-09-03, Batch 1403; findings migrated into its §3 and §3.11)
- `migration_doc/IMAGERY_PROJECTION.md` — Single source of truth for imagery-layer projection across WebGL + WebGPU. **MUST be kept in sync whenever you touch any file in the projection chain** (`*ImageryReprojection*`, `GlobeFS.glsl`, `GlobeTerrain.wgsl`, `WebGPUGlobeSurfaceTextures.ts`, `WebGPUGlobeSurfaceTileUB.ts`, `WebGPUGlobeSurfaceCameraUB.ts`, `ImageryLayer.js`, `ImageryLayerHelpers.js`). A drift between this doc and code is a worse bug than the projection bug itself.
- `packages/engine/Source/Renderer/WebGPU/` — All WebGPU renderer code (for a file count see [`BUILD_AND_VARIANTS.md`](BUILD_AND_VARIANTS.md) §2 for a dated measurement and re-measure recipe; do not quote an absolute here — "83+" was stale by 3.3x against the 271/277 measured 2026-09-05)
- `packages/engine/Source/Shaders/WebGPU/` — All WGSL shaders (for a shader-module count see [`BUILD_AND_VARIANTS.md`](BUILD_AND_VARIANTS.md) §2; "67+" was stale by 4.8x against the 324 measured 2026-09-05)
- `Tools/query-context.mjs` & `Tools/context-spine/` — Zero-dependency SQLite (`FTS5` + `R*Tree`) + Graphify `--code-only` context spine, spatial/GIS validation graph, and `cesium-context-spine` stdio MCP server (`npm run context-impact`, `npm run spatial-rag`, `npm run spatial-contracts`, `npm run context-refresh`, `npm run context-graphify`, `npm run test-context-spine`; full guide: [`migration_doc/CONTEXT_SPINE_GUIDE.md`](CONTEXT_SPINE_GUIDE.md))

## 4. Dated measurements

From Principle 6 (Feature Inventory), the bucket counts as they stood:

- **EXISTING** — 308 features inherited from upstream Cesium (globe, imagery, 3D Tiles, glTF Models, geometry primitives, collections, entities, datasources, particles, post-processing, camera, picking, time, materials, shadows, widgets — see [migration_doc/FEATURE_INVENTORY.md §A](FEATURE_INVENTORY.md#a-existing--upstream-cesium-features-inherited-by-the-fork) for the full list).
- **NEW** — 353 fork-added features (the entire WebGPU renderer + abstractions + tooling — see [§B](FEATURE_INVENTORY.md#b-new--fork-specific-additions)). Each tagged `(SHIPPED)`, `(SCAFFOLDED)`, or `(EXPERIMENTAL)`.
- **WIP** — 117 partially-shipped features with known gaps (see [§C](FEATURE_INVENTORY.md#c-wip--work-in-progress)).
- **FUTURE / DEFERRED** — 156 explicitly punted, gated, or research-stage items (see [§D](FEATURE_INVENTORY.md#d-future--deferred)).

Counts measured 2026-09-05 by counting top-level `-` bullet lines in each section's line range in `FEATURE_INVENTORY.md`. They drift as the inventory grows — re-measure rather than trust these absolutes indefinitely. The §C figure includes 15 struck-through entries already marked resolved but not yet migrated to §B, so the true open-WIP count is lower.

From "64-Bit Precision & RTE": Measured 2026-09-06: 57 of 72 shaders declare `previousViewProjection` mid-struct; bringing them to the rule is the AR-D12 enforcement lane (ruling D4, 2026-09-05).

## 5. The engine code standards move (2026-10-31)

Ruled by the maintainer on 2026-10-31 ("Yes Middle Path.", on `DX-RULES-DIET-2`): seven engine-code sections of
`CLAUDE.md` moved verbatim into the on-demand skill
[`.claude/skills/engine-code-standards/SKILL.md`](../.claude/skills/engine-code-standards/SKILL.md): "Architecture
Patterns" (its five subsections), "64-Bit Precision & RTE", "Monorepo Architecture — File Placement Rules", "File Size &
Code Organization", "Preferred Tech Stack", "ES6+ Modernization — Incremental Upgrade Rule" and "Comment & JSDoc Rules".
The one change inside the moved text is its single relative link (`ForkCommentStandard.md`), re-rooted to resolve from the
skill directory.

Measured at the move with `node Tools/rules-file-diet-check.mjs` (tokens are bytes / 4): the moved range was 10,954 B as
git stores it (LF; 11,085 B in a CRLF worktree). The core went from 42,907 to 33,682 B in git (43,445 to 34,104 B CRLF;
538 to 422 lines; about 10.7K to 8.4K tokens by LF bytes). The skill file is 11,365 B LF (body 11,152 B as the guard counts it, description 186 B). Of
what the core gained, the five-line summary section is 1,278 B (CRLF), the Principle 13 landing-hook sentence that
replaced the bare `npm run context-refresh` one adds 393 B, and the skill's bullet in "On-demand Skills" 71 B; the 33 KB
target was missed by about that margin.

Why five lines stay in the core: every agent loads the core, but a skill loads only when invoked, so the rules whose
breach is silent and costly keep a restatement every session sees: RTE (a single-precision position renders with jitter
no spec flags), file placement (an edit in the root `Source/` build output is overwritten without error), the language
rule (TypeScript preferred for new code, the `any` ban), the fork comment standard (enforced at landing, after the work is written)
and file size (a decomposition owed when a file is touched). Each line is a summary or a pointer; the full rule is the
skill, which binds exactly as `CLAUDE.md` does, and the core routes any change under `packages/**` to it.

## 6. The pointer files' history (moved out of AGENTS.md, GEMINI.md and .clinerules)

Moved by the context-load diet that followed Batch 1665, so each pointer file carries only what is specific to its agent. Verbatim.

### AGENTS.md "Codex specifics": the anecdote behind "Your clone, never the seat"

> Three days of engine, tooling and archive work once accumulated as
>   uncommitted state in the seat and survived a `.git/index` truncation only by luck.

### GEMINI.md section 3: the examples behind "Precision on documentation"

> Stale examples that cost a review
>   round: a `.glsl:44` that had moved to `:46`,
>   a per-cell error count written as per-run, a corroboration written as a proof.

### .clinerules "What this file was"

#### What this file was

From 2026-03 to 2026-09 this was the fork's rules file: Cline reads `.clinerules`
automatically, so the project's architecture rules were written here first. Its
last substantive commit was `b5b486a9a9` on **2026-03-31**. Everything the fork
learned after that date — Principles 5 through 10, the WGSL define/preprocessor/
module-cache contract, the pipeline-key aliasing fold, build variants, the
Playwright verification rule, the proof bar and wave-end gate, GitHub quiet
hours, branch transparency and evidence repatriation — was written into
`CLAUDE.md` and never back-ported here. Following this file's frozen text would
have produced work that fails review.

### .clinerules "What happened to this file's content"

#### What happened to this file's content

Every rule that was live only here was carried into the matching section of
`CLAUDE.md` in the same batch (some of those sections are now the on-demand files above) — the view-level context architecture and
context-registry diagnostics, the parity checklist and its non-goals, the scene
logic extractor's shared/backend-specific split, the feature-renderer
registration recipe, the capability-query rule, the RTE reuse rules, the monorepo
build-output and recovery rules, the file-decomposition rules, the RxJS /
service-worker / Slang preferences, the fuller ES6 pattern list and class-
conversion JSDoc mechanics, the WASM toolchain and threading rules, and the
upstream-sync prerequisites, two-parent recovery and post-sync tasks.

Ruling D11 (2026-09-05) additionally carried §2d's `context.log()` rule into the
Logging & Debug Pragmas section of `CLAUDE.md` (now `.claude/skills/logging-pragmas/SKILL.md`) as a **preference** rather than the
MUST it was here: where a context is in hand, prefer `context.log(level, message)` so
the context id reaches the message. `console.error` for a real error is unchanged.

Rules that were **not** carried, and why:

- **Cline tool-use safety rules** (`replace_in_file` / `write_to_file` sizing and
  task granularity) — specific to Cline's tool surface, which other agents do not
  have. Preserved in this file's git history.
- **"Default to the WebGL renderer unless specified"** — no longer true. The
  default is set per build variant by `setGlobalDefaultRenderer()` in
  `RendererType.ts`; the dual build defaults to WebGPU-first.
- **"Commit with `--no-verify`" in the sync procedure** — retracted; hooks are
  not bypassed.
- **"Show a loading state during async WebGPU initialization" / `LoadingOverlay`**
  — the component no longer exists anywhere in the tree.
- **"Document parity gaps in `UPSTREAM_ISSUES_AND_TECH_DEBT.md`"** — that file is
  archived; gaps now go to `DEFERRED_WORK.md` and `FEATURE_INVENTORY.md` §C.
- **Generic bullets** on documentation, development workflow, migration strategy
  and testing — superseded by the proof bar (R-2026-08-29-1) and the wave-end
  gate (R-2026-08-29-2) in `CLAUDE.md`.
- **Transcribed inventories** (context capability lists, WASM module tables, RTE
  reference paths, the WebGPU file-count block) — deliberately replaced by
  pointers at the code. Absolute counts transcribed into prose are what the same
  batch had to correct in `CLAUDE.md`; re-transcribing them here would recreate
  the defect.

## 7. Rationale, dates and examples trimmed from CLAUDE.md (the context-load diet)

Each line is text this diet removed from `CLAUDE.md`, verbatim, with its old line number at Batch 1667. None of it is the only home of a rule: every obligation of that file kept a home in `CLAUDE.md` or a skill (the lane's `RULE_PRESERVATION.md`). Principle 13's spine-maintenance sentences (landing hook, `context-graphify`, provisioning refresh) moved verbatim to `/seat-duties` and also duplicate `CONTEXT_SPINE_GUIDE.md` §5 and §7; the context-refresh timing at old line 200 is kept here only as history.

- Old line 3: Claude Code loads it automatically into every conversation;
- Old line 28: (e.g., `Context.js` ES6 class conversion + `extends GraphicsContext`)
- Old line 57: This reduces maintenance from 3 rendering paths to 2 (WebGL2 + WebGPU)
- Old line 134: ("this bug needs X, which is deferred — build X next?")
- Old line 136: This is the corollary of Principle 7: keep scaffolding in place AND finish the work the scaffolding implies.
- Old line 140: An unverified premise does not stay contained. It propagates into the fix **and** into the test that was supposed to catch it (the 2026-08-20 evidence: `WORKER_ISOLATION_AND_BRANCH_HANDOFF.md` §8c, R8).
- Old line 146: Findings age; code moves.
- Old line 147: Behaviour is checkable against reality; a shape only checks that the instruction was followed.
- Old line 149: It inherits the brief's errors.
- Old line 152: Deleting code is the easy mutation and most specs survive it.
- Old line 171: Entered on 2026-09-10 by maintainer decision.
- Old line 177: Ensures deterministic cross-platform execution without shell quoting, escaping, or expansion discrepancies across Windows and POSIX systems.
- Old line 188: : a pack is a few KB against tens to hundreds of KB for the file.
- Old line 190: (the audit that found them wrong is in [`RULES_FILE_NOTES.md`](RULES_FILE_NOTES.md) §2)
- Old line 200: (3.3-3.9 s with nothing changed)
- Old line 290: (a sandboxed worker cannot safely be given commit rights in a worktree)
- Old line 291: (merge commits skip landing rules)
