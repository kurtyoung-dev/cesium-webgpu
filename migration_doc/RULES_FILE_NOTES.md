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
