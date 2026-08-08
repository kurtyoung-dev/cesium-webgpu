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
| `C16-00` | Standards + tooling: fork comment style doc (Documentation/Contributors addendum), ast-grep/regex lint guard wired into lint-staged + CI, comment-only-diff verifier tool + spec, `DEV_NOTES` format definition, worker-prompt standard text | M | PENDING |
| `C16-01` | Attribution & license batch — **scope expanded by maintainer 2026-08-10**: (a) resolve all 20 `needs-license-review` flags (mulberry32 LICENSE entry or replacement; naga-wasm ThirdParty coverage; SSGI notice; glTF sample-viewer determination; asset provenance notices for Tycho-2/LROC/Natural Earth); (b) add `Reference:` blocks to all 43 `needs-citation` files; (c) **PACKAGING LEGALITY**: every required license/notice must ship in the DISTRIBUTED artifacts, not only the repo — audit and extend `ThirdParty.json`/`ThirdParty.extra.json` (Cesium's generator for the shipped Third-Party section), verify the npm package files and `Build/**` bundles carry the notices, and prove it with a build-output check; (d) **README CREDITS**: a References & Credits section at the BOTTOM of `README.md` listing every code/technique/data reference with a link to the author's repository where one exists (paper/dataset link otherwise), generated from the audit's 76-file attribution census and kept in sync by the C16-00 tooling | L | PENDING — **schedule first after C16-00; legally load-bearing** |
| `C16-02` | Upstream v1.144 sync (57 commits: release, screenspace camera controllers, vector-terrain polygons, FBO cache fix, MVT types, CZML validation) per the CLAUDE.md sync procedure; then cached audit-workflow re-run to refresh the file list | M | PENDING — before any rewrite shard |
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
| `C16-20` | Final gate: cached audit workflow re-run expecting **0 violation blocks**; `build-docs` clean end-to-end; WebGPU parity report re-score refresh (the 2026-07-01 report is stale); CLAUDE.md + README index updates | M | PENDING |

## Audit baseline (2026-08-10, workflow `wf_c6df8ba5-f04`)

6,450 violation blocks / 556 files (A 5,527 · B 158 · C 525 · D 88 · E 103 ·
F 39 · G 10); 76 attribution files (43 cite, 20 license-review, 13 ok).
Shard→subsystem sizing for C16-03..12 derives from the per-shard `worstFiles`
lists in the workflow journal; re-shard freely at dispatch as long as the
final gate is zero.
