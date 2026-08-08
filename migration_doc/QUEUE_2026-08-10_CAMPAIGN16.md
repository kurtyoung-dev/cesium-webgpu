# Campaign 16 Queue — Comment Remediation & Attribution (2026-08-10)

**Live execution queue and sole status authority for C16.** Launched by
maintainer directive 2026-08-10. Plan:
[CAMPAIGN16_COMMENT_REMEDIATION_PLAN_2026-08-10.md](CAMPAIGN16_COMMENT_REMEDIATION_PLAN_2026-08-10.md).
Update this ledger at every completion, pause, block, or deferral.

**Scope:** `packages/engine/Source`, `packages/widgets/Source` (code +
shaders + shipped assets). **Exempt:** `migration_doc/**`, `Tools/**`,
commit messages, ledgers — dev history lives there by design.

**Binding gates for every batch:** comment-only-diff verifier byte-identical
(except C16-01/02, which change code/assets and carry normal gates);
lint-guard green on touched files; `npm run build-docs` clean when exported
API is touched; prettier/eslint; knowledge extraction to
`DEV_NOTES_<subsystem>.md` lands IN THE SAME BATCH as the rewrite it covers.

## Rows

| ID | Work | Size | Status |
| --- | --- | --- | --- |
| `C16-00` | Standards + tooling | M | **LANDED — Batch 960 (2026-08-10, CO-34).** `ForkCommentStandard.md` (the one rule, seamlessness test, banned-vocabulary table keyed by lint rule id, worker boilerplate in Appendix A); marker guard `Tools/c16/comment-marker-guard.mjs` (14 self-testing rules, shared JS/TS/WGSL/GLSL comment tokenizer, warn→strict RATCHET via `comment-marker-cleanlist.txt` seeded with 7 measured-clean dirs, exit 0/1/2/3, `--verify-cleanlist` asserts both halves of honesty) wired into lint-staged + 4 npm scripts; comment-only-diff verifier `Tools/c16/comment-only-diff.mjs` (canonical-form strip, catches one-char code mutations incl. pragma/ifdef/license-banner/eslint-directive deletions; 2,156/2,156 corpus rewrites accepted, 2,156/2,156 mutations caught); `DEV_NOTES_FORMAT.md`. **Guard census on the post-sync tree: 503 files / 8,604 marker occurrences** (the audit’s 556 spans categories A–G; the guard owns A + glyph-E — B/C/D are review-enforced by design, sampled zero-false-positive). ast-grep deliberately NOT used (no WGSL/GLSL grammar = 43% of flagged files; all-or-nothing CI severity; static globs can’t ratchet) — promoting an `error`-severity ast-grep rule at C16-20 is the recorded follow-up. **Collateral fix: latent lint-staged/markdownlint bug** — markdownlint-cli ignores `.markdownlintignore` for explicitly-named paths, so any staged `migration_doc/*.md` failed the hook; generalized the existing carve-out into `isMarkdownlintExempt` mirroring the ignore file, spec-pinned. |
| `C16-01` | Attribution & license batch — **scope expanded by maintainer 2026-08-10**: (a) resolve all 20 `needs-license-review` flags (mulberry32 LICENSE entry or replacement; naga-wasm ThirdParty coverage; SSGI notice; glTF sample-viewer determination; asset provenance notices for Tycho-2/LROC/Natural Earth); (b) add `Reference:` blocks to all 43 `needs-citation` files; (c) **PACKAGING LEGALITY**: every required license/notice must ship in the DISTRIBUTED artifacts, not only the repo — audit and extend `ThirdParty.json`/`ThirdParty.extra.json` (Cesium's generator for the shipped Third-Party section), verify the npm package files and `Build/**` bundles carry the notices, and prove it with a build-output check; (d) **README CREDITS**: a References & Credits section at the BOTTOM of `README.md` listing every code/technique/data reference with a link to the author's repository where one exists (paper/dataset link otherwise), generated from the audit's 76-file attribution census and kept in sync by the C16-00 tooling | L | **LANDED — Batch 963 (2026-08-10, CO-38).** 20 determinations in `LICENSE_DETERMINATIONS_2026-08-10.md` (L-16 was a LIVE PACKAGING DEFECT: the LTC notice-required entry was absent from the npm tarball's only license file — now mirrored; L-03 split three ways with only the iridescence block copied-shape; census correction: the true split was 32/20/24 not 43/20/13). 31 citation files (+246 lines), comment-only-diff green, 0 markers added. 14 new LICENSE sections mirrored to the engine package; ThirdParty.extra.json + build-third-party clean; `verify-packaged-notices` 103/103 wired into test-c16. README References & Credits landed. Instrument fix: comment-only-diff was CRLF-blind inside multi-line string literals. **TWO NEEDS-MAINTAINER:** L-01 mulberry32 (provenance unestablishable offline; replacement = code batch, filed) and L-23 (the WGSL minifier strips @license banners from shipped bundles). |
| `C16-02` | Upstream v1.144 sync (57 commits: release, screenspace camera controllers, vector-terrain polygons, FBO cache fix, MVT types, CZML validation) per the CLAUDE.md sync procedure; then cached audit-workflow re-run to refresh the file list | M | **DONE — Batch 958 (the v1.144 merge, all gates green).** Cached audit re-run for the census refresh still owed. |
| `C16-03` | Rewrite shard: procedural clouds (renderer + WGSL + observability — the largest marker cluster) | L | PENDING |
| `C16-04` | Rewrite shard: celestial — sun/moon/stars/eclipse (SolarDiscModel, SunHaloAppearance, Sun/Moon, StarField, EclipseState family) | L | PENDING |
| `C16-05` | Rewrite shard: globe & imagery (GlobeTerrain.wgsl, surface textures/UBs, lighting fade, tunables) | M | PENDING |
| `C16-06` | Rewrite shard: renderer infrastructure (pipeline/bind-group/shader caches, defines/preprocessor, context, timestamp accounting) | L | PENDING |
| `C16-07` | Rewrite shard: post-process & effects (PP chain, SSR/SSGI/AO/TAA/bloom/fog, framebuffer orchestration) | M | PENDING |
| `C16-08` | Rewrite shard: model/PBR/IBL (Model WGSL, BRDF chunks, SH, KHR extensions) | M | PENDING |
| `C16-09` | Rewrite shard: collections + primitives + picking (billboard/label/point/polyline/buffer*, pick plumbing) | M | PENDING |
| `C16-10` | Rewrite shard: splats, points, compute (gaussian splats, EDL, sorts, culling, flow field) | M | PENDING |
| `C16-11` | Rewrite shard: scene/architecture residue (Scene files, FeatureRenderer seams, CesiumDebug JSDoc pass) | M | PENDING |
| `C16-12` | Rewrite shard: long tail — every remaining flagged file to zero | M | PENDING |
| `C16-02b` | **BUILD-DOCS BASELINE RED (filed at C16-01 landing):** `npm run build-docs` fails with 45 jsdoc `--pedantic` errors — TypeScript-style inline object types in 6 fork files (MetadataWGSLPipelineStage, MVTDataProvider, renderBufferPointCollection, WebGLMoonTextureLifecycle, VisualPerformanceTargetService, OceanSurfacePrimitive). The C16 binding gate "build-docs clean" is unmeetable until this lands; fix the 6 files first, then the gate binds. | S | PENDING — **blocks the gate, schedule before C16-03** |
| `C16-20` | Final gate: cached audit workflow re-run expecting **0 violation blocks**; `build-docs` clean end-to-end; WebGPU parity report re-score refresh (the 2026-07-01 report is stale); CLAUDE.md + README index updates | M | PENDING |

## Audit baseline (2026-08-10, workflow `wf_c6df8ba5-f04`)

6,450 violation blocks / 556 files (A 5,527 · B 158 · C 525 · D 88 · E 103 ·
F 39 · G 10); 76 attribution files (43 cite, 20 license-review, 13 ok).
Shard→subsystem sizing for C16-03..12 derives from the per-shard `worstFiles`
lists in the workflow journal; re-shard freely at dispatch as long as the
final gate is zero.
