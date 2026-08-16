# `scripts/archive/` — spent build-side codemods

Build-side one-shot transforms whose output already ships in the tree. Moved by `git mv` rather
than deleted (maintainer ruling **M1** option B, 2026-08-16) so `git log --follow` keeps their
history and the recipe stays available; the codemod is idempotent and re-running it from its new
path (`node scripts/archive/<name>.mjs`) is a no-op on already-transformed sources. Status comes
from the census in [`migration_doc/TOOLING_CATALOG.md`](../../migration_doc/TOOLING_CATALOG.md).

| File                             | Former path                              | Catalog status         | Successor / conclusion banked where                                                                                                                                               |
| -------------------------------- | ---------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codemod-split-material-ubo.mjs` | `scripts/codemod-split-material-ubo.mjs` | INVESTIGATION_ARTIFACT | The shipped `CameraUniforms`/`MaterialUniforms` split with separate bind groups; only inbound reference is the dated `migration_doc/audits/2026-06-11_ULTRA_REVIEW_findings.json` |

Nothing else under `scripts/` moved — `run-build-no-tsc.mjs`, `patchEslintSeatbelt.mjs` and the
`scripts/__tests__/` spec set are all live.
