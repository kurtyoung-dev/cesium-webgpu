# `Tools/archive/` — spent one-shot codemods

Every file here is a one-time source transform that has already been applied; its product is
in-tree and guarded by shipped specs and probes, which is what supersedes a codemod. They were
moved by `git mv` rather than deleted (maintainer ruling **M1** option B, 2026-08-16) so
`git log --follow` still reaches their history and the transform recipe stays greppable the next
time a shader family needs the same mechanical edit. All of them are idempotent — each skips files
that already carry the construct it adds — so re-running one from its new path
(`node Tools/archive/<name>.mjs`) is safe and normally a no-op. Status and rationale per file come
from the census in [`migration_doc/TOOLING_CATALOG.md`](../../migration_doc/TOOLING_CATALOG.md).

| File                               | Former path                              | Catalog status         | Successor / conclusion banked where                                                                                                                              |
| ---------------------------------- | ---------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apply-logdepth-flatbasic.mjs`     | `Tools/apply-logdepth-flatbasic.mjs`     | INVESTIGATION_ARTIFACT | Shipped `Mat*Flat`/`Basic` WGSL carrying `v_logDepth`; guarded by `mat-logdepth-encode-stash.spec.mjs` and the `probe-logdepth-*` gates                          |
| `apply-logdepth-matlit.mjs`        | `Tools/apply-logdepth-matlit.mjs`        | INVESTIGATION_ARTIFACT | Shipped `Mat*Lit` WGSL; same guards as the flat/basic sibling                                                                                                    |
| `apply-logdepth-pbr.mjs`           | `Tools/apply-logdepth-pbr.mjs`           | INVESTIGATION_ARTIFACT | Shipped `PrimitivePBRSimple`/`PrimitivePBRTextured` WGSL; same guards                                                                                            |
| `batch-117-wrap-returns.mjs`       | `Tools/batch-117-wrap-returns.mjs`       | INVESTIGATION_ARTIFACT | Shipped `GlobeTerrain.wgsl` `makeFragOutput` MRT returns; narrative in `CAMPAIGN9_OPUS_EXECUTION_GUIDE_2026-07-16.md`                                            |
| `batch-121-wrap-lit-shaders.mjs`   | `Tools/batch-121-wrap-lit-shaders.mjs`   | INVESTIGATION_ARTIFACT | Shipped `FragOutput` G-buffer slot 1 across the 19 `Mat*Lit` + 2 Phong shaders; see `DEV_NOTES_globe.md` (a hand edit to one shader will not match its siblings) |
| `wire-flat-shaders-aerial-lut.mjs` | `Tools/wire-flat-shaders-aerial-lut.mjs` | INVESTIGATION_ARTIFACT | Shipped aerial-perspective LUT wiring in the Flat primitive shaders; verified by `probe-aerial-lut-primitive.mjs`, narrative in `WEBGPU_DEBUGGING_LOG.md`        |
| `wire-globe-mrt-normal.mjs`        | `Tools/wire-globe-mrt-normal.mjs`        | INVESTIGATION_ARTIFACT | Shipped the 2-attachment `GlobeTerrain.wgsl` output; verified by `probe-normalmap-gbuffer.mjs` / `probe-litmat-mrt.mjs`                                          |

Nothing else under `Tools/` moved. In particular the bake tools, gate libs, runners and the
`Tools/moon-albedo-bake/work/` scratch set stayed where they were — the `work/` files are
gitignored, so relocating them is a tracking decision for the maintainer, not a `git mv`.
