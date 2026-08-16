# `Tools/visual-regression/archive/` — retired probes, diff tools and scratch runners

This directory holds visual-regression tooling that the 2026-08-15 library census
([`migration_doc/TOOLING_CATALOG.md`](../../../migration_doc/TOOLING_CATALOG.md)) classified as
`BROKEN_STALE`, `LIKELY_SUPERSEDED` or `INVESTIGATION_ARTIFACT` with HIGH confidence, moved here
under maintainer ruling **M1 (option B) / M3 (archive subdir)** on 2026-08-16. Nothing was deleted:
each file arrived by `git mv`, so `git log --follow <path>` still walks its whole history and the
source text stays greppable — the census recorded twice that this repo re-learns lessons from
retired investigation probes (the polar-artifact class recurred, the bring-up readback probes were
wanted again during device-loss work), and a deletion destroys exactly that. Being archived is a
statement about _status_, not about _runnability_: a file here still runs from its new path, e.g.
`node Tools/visual-regression/archive/probe-globe-timing.mjs` — but the `BROKEN_STALE` rows will run
and report nothing, because the engine hooks they read (`__dbg*` globals, `__FORCE_CONE`,
`_globeImageryCache`, the classifier `TEMP DIAG` encoding) were verified absent from
`packages/engine/Source` at census time. The two files that resolve an output directory from
`import.meta.url` (`probe-cloud-cone-equal.mjs`, `sandcastle-batch-66-runner.mjs`) now write into
`archive/output/` rather than the live `output/`. `probe-fleet-contract.spec.mjs` scans the flat
`Tools/visual-regression/` directory only (a non-recursive `readdirSync` filtered on `probe-*.mjs`),
so archived probes leave its fleet; their rows were removed from
`lib/probe-fleet-contract-allowlist.mjs` in the same change, as the C3 ratchet requires.

| File                             | Former path                                              | Catalog status         | Successor / conclusion banked where                                                                                                                                      |
| -------------------------------- | -------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `diff-fog-ms.mjs`                | `Tools/visual-regression/diff-fog-ms.mjs`                | LIKELY_SUPERSEDED      | `diff-two-pngs.mjs` — same canvas-decode diff plus bottom-crop and a zero-drift exit code                                                                                |
| `diff-multideck.mjs`             | `Tools/visual-regression/diff-multideck.mjs`             | LIKELY_SUPERSEDED      | `diff-two-pngs.mjs` — threshold-0 diff is that tool's default contract                                                                                                   |
| `probe-cloud-cone-equal.mjs`     | `Tools/visual-regression/probe-cloud-cone-equal.mjs`     | BROKEN_STALE           | No successor needed — `__FORCE_CONE`/`__CONE_ISOLATE` are gone from the engine, so the A/B flip is inert; the B436 equal-quality verdict is in that batch's landing      |
| `probe-cloud-cone-perf.mjs`      | `Tools/visual-regression/probe-cloud-cone-perf.mjs`      | BROKEN_STALE           | Same hook removal as `-cone-equal`; the cost verdict is in the B436 landing                                                                                              |
| `probe-dp46a-metadata.mjs`       | `Tools/visual-regression/probe-dp46a-metadata.mjs`       | LIKELY_SUPERSEDED      | `probe-dp46b-metadata.mjs` re-proves the same gradient and off-parity through the real generated-WGSL path; DP-H46 epic closed                                           |
| `probe-globe-tile-trace.mjs`     | `Tools/visual-regression/probe-globe-tile-trace.mjs`     | BROKEN_STALE           | All five `__dbgGlobeTileTrace*` globals absent from engine source; null-guarded reads mean it runs and reports nothing                                                   |
| `probe-globe-timing.mjs`         | `Tools/visual-regression/probe-globe-timing.mjs`         | BROKEN_STALE           | Neither the `[GLOBE-PIPELINE]` log tag nor `__dbgResolveGlobe`/`__dbgSelectPipeline` exist; captures 0 messages by construction                                          |
| `probe-gpu-tex.mjs`              | `Tools/visual-regression/probe-gpu-tex.mjs`              | LIKELY_SUPERSEDED      | `probe-imagery-tex.mjs` reads the authoritative realized-texture fields; this one never reached the per-device renderer instance                                         |
| `probe-imagery-format.mjs`       | `Tools/visual-regression/probe-imagery-format.mjs`       | BROKEN_STALE           | `ctx._globeImageryCache` is gone — it always reports `no-cache`; realized formats are read by `probe-imagery-tex.mjs`                                                    |
| `probe-logdepth-diag.mjs`        | `Tools/visual-regression/probe-logdepth-diag.mjs`        | BROKEN_STALE           | The classifier `TEMP DIAG` RGB encoding no longer exists, so its decode readings are meaningless; the log-depth chain findings are in `WEBGPU_DEBUGGING_LOG.md`          |
| `probe-tonemap.mjs`              | `Tools/visual-regression/probe-tonemap.mjs`              | BROKEN_STALE           | Targets the legacy `Apps/Sandcastle` gallery, which is not served — the page hangs; use `probe-gamma-chain.mjs` for the tonemap/gamma chain                              |
| `probe-trace-counts.mjs`         | `Tools/visual-regression/probe-trace-counts.mjs`         | BROKEN_STALE           | No `__dbgDrawCounts` instrumentation exists under `packages/`, so nothing increments the counters it reads; `probe-cmd-pushes.mjs` / `probe-pass-counts.mjs` remain live |
| `quick-screenshot.mjs`           | `Tools/visual-regression/quick-screenshot.mjs`           | INVESTIGATION_ARTIFACT | Ad-hoc two-backend capture helper, no docstring and no inbound refs; `probe-saved-view.mjs` is the capture template to copy                                              |
| `sandcastle-batch-66-runner.mjs` | `Tools/visual-regression/sandcastle-batch-66-runner.mjs` | LIKELY_SUPERSEDED      | `sandcastle-batch-66-final-runner.mjs` (post-F1/F2/F3 rerun); reports live in `migration_doc/archive/sandcastle-batch-66/`                                               |
| `split-screen-debug.mjs`         | `Tools/visual-regression/split-screen-debug.mjs`         | INVESTIGATION_ARTIFACT | Split-screen bring-up era diagnostic; conclusions in `WEBGPU_DEBUGGING_LOG.md`, sibling of the still-live `probe-webgpu-grey.mjs`                                        |
| `temp-pbr.mjs`                   | `Tools/visual-regression/temp-pbr.mjs`                   | INVESTIGATION_ARTIFACT | The KTX2-cubemap question is banked in `DEFERRED_WORK.md` and `WEBGPU_DEBUGGING_LOG.md`; `cross-backend-sandcastle-runner.mjs` covers the demo                           |

## Deliberately not here

`probe-logdepth-zfight.mjs` (DELIBERATE_RED_FLAG — a standing flag, untouchable), the
`HELD_FOR_D8` files, `sky-band-compare.mjs` (UNKNOWN), the M5 technique exemplars
(`probe-cloud-noisecore.mjs` for the stash-based A/B recipe, `canvas-black-readback.mjs` for raw
GPU readback), the three LOW-confidence supersession candidates
(`probe-bufferpolygon-2dcv.mjs`, `probe-bufferpoint-positiondatatype.mjs`,
`probe-classifier-textured-materials.mjs`), and the whole MED-confidence set, which the M1 ruling
keeps tombstoned in the catalog rather than moved. `probe-polyline-geodesic.mjs` was on the HIGH
list but stayed live: the C11 planning guide `G7-entity-scale.md` names it in two forward-looking
polyline verification recipes.

`archive/output-scratch/` is reserved for the three gitignored one-off scripts still sitting in
`Tools/visual-regression/output/` (`co41-loading-check.mjs`, `sunbloom-flip-diag.mjs`,
`viewer-smoke.mjs`). They are untracked by design, so moving them is a tracking decision rather
than a `git mv`, and it was left to the maintainer.
