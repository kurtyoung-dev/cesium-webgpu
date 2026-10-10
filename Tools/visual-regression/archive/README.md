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

Later arrivals come under ruling **R-2026-09-17-11**, the probe-kit harvest's retirement rule
(`PROBE_KIT_PLAN_2026-09-17.md` §4.2: ARCHIVE means MOVED, never deleted). That rule adds one status
to the three above: `PROMOTED`, a probe whose checks now run as a spec or standing gate, named in its
row, with its conclusion banked in `WEBGPU_DEBUGGING_LOG.md` before the move.

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
| `probe-weather-time.mjs`         | `Tools/visual-regression/probe-weather-time.mjs`         | PROMOTED               | `weather-provider-time-model.spec.mjs` runs its nine checks in Node on the real `WeatherProvider`; the probe launched Edge only to import the bundle                     |
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

## Probe-kit harvest, c11 family (DX-108)

Moved under `R-2026-09-17-11` (archive means moved; deletion is a later, separate positive-list
batch). The file still runs from its new path:
`node Tools/visual-regression/archive/probe-c11-209-effects-placeholder-startup.mjs`, with its
relative imports rewritten for the deeper directory. Its outputs resolve from the working
directory, so they still land in the live `output/performance/`.

| File                                            | Former path                                                             | Status             | Successor / conclusion banked where                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------- | ----------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `probe-c11-209-effects-placeholder-startup.mjs` | `Tools/visual-regression/probe-c11-209-effects-placeholder-startup.mjs` | ARCHIVED-CANDIDATE | Row `C11-209` is COMPLETE (Batch 1026). The pass (run `81b6febc…`, 17/17) and its conclusion are in `WEBGPU_DEBUGGING_LOG.md` under "C11-209" and "Probe-kit harvest, c11 family". The visibility arithmetic is `lib/metrics/c11-frame-nonvacuity.mjs`, and the visibility capture now removes the viewer's widgets first and refuses on leftovers (the banked pass predates this); the page is rig `c11-viewer-offline-webgpu`; the provenance policy and its spec now point here |

## Probe-kit harvest, cloud family (round 1)

Ten INVESTIGATION probes of the cloud family were moved here by `git mv` under `R-2026-09-17-11` (ARCHIVE means
moved; deletion is a later, separate, positive-list batch), each flipped to `@status ARCHIVED-CANDIDATE` in the same
change, which is what takes them out of the live fleet wherever they sit (`fleetExemption`, `ARCHIVED`). Their one
cross-directory import (`../lib/webgpu-error-gate.mjs`) was repointed to `../../lib/`, so each still runs from its
new path; their output paths are working-directory relative and still write under the live `output/`. Nine of
the ten were a two-build A/B run by hand with `git stash` (`u1-scaffold` compared two renders inside one run); each
scene is now a rig, and its conclusion — with the numbers its
landing batch recorded — is banked in `migration_doc/WEBGPU_DEBUGGING_LOG.md` under the harvest's own heading.

| File                              | Landed    | Rig(s)                                                                | Conclusion, as its batch recorded it                                                          |
| --------------------------------- | --------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `probe-cloud-depth-occlusion.mjs` | Batch 409 | `cloud-depth-occlusion-thick-shell`                                   | Stash A/B of the far-side shell read as PNGs; the single-run gate was a smoke test by design  |
| `probe-cloud-halfres-parity.mjs`  | Batch 432 | `cloud-cinematic-default-1200m`                                       | Full-res default tier byte-identical: decoded diff 0 of 3,145,728 channels                    |
| `probe-cloud-lighting.mjs`        | Batch 401 | `cloud-underside-noon-cov060`                                         | Mean delta 0.0005, interior p50 delta 0.0009, W1 0.283 and W2 0.382 preserved                 |
| `probe-cloud-lut-parity.mjs`      | Batch 434 | `cloud-cinematic-legacy-lut-modes-1200m`                              | Default heuristic/constant path byte-identical, MD5 `899959ee` twice                          |
| `probe-cloud-noisebake.mjs`       | Batch 398 | `cloud-underside-noon-cov055`                                         | Mean-abs luma 0.0000, max 0 over 351,350 cloud pixels; bake ran                               |
| `probe-cloud-remap.mjs`           | Batch 400 | `cloud-underside-noon-cov040`, `cloud-underside-noon-cov085`          | Cloud-pixel ratio 1.04 at coverage 0.40 and 0.99 at 0.85, mean luma delta 0.003               |
| `probe-cloud-shadows-parity.mjs`  | Batch 437 | `cloud-shadows-parity-terrain`, `cloud-shadows-parity-aerial`, `-fog` | Terrain, aerial and fog paths each 0 of 745,472 pixels changed with cloud shadows off         |
| `probe-cloud-tier-resolver.mjs`   | Batch 397 | `cloud-underside-noon-cov055`                                         | Mean-abs luma 0.0000, max 0 over 351,350 cloud pixels; no uniform lane shifted                |
| `probe-cloud-u1-scaffold.mjs`     | Batch 617 | `cloud-billboard-u1-scaffold`                                         | API scaffold present; unused, billboard render unchanged on both backends (no numbers banked) |
| `probe-cloud-u2-config.mjs`       | Batch 618 | `cloud-u2-config-deterministic`                                       | Config indirection byte-identical on WebGPU, ON and OFF cloud paths                           |

**A re-run of six of these does not reproduce their scene.** `-lighting`, `-lut-parity`, `-noisebake`, `-remap`,
`-shadows-parity` and `-tier-resolver` set their cloud dials inside `if ("cloudCoverage" in g)`-shaped guards on
the globe, which have been false since Batch 622 moved the dials off it; their banked conclusions predate that
batch. Staging the rig instead of running the archived file is the faithful re-run, with one exception:
`-shadows-parity`, whose three `cloud-shadows-parity-*` rigs `cloudRigStagePayload` refuses (`dial enableVolumetric is
neither a scene dial ...`), so its faithful re-run waits on the kit stager (`DX-104`; the stager-vocabulary defect, `H-10` in the landing packet).

**Five of these are in a network-globe inventory.** `-depth-occlusion`, `-lighting`, `-noisebake`, `-remap` and
`-tier-resolver` are listed in `migration_doc/DEFERRED_WORK.md` §5 (`C13-WEATHER-PROBE-FLEET-SHAPE-SWEEP`), which
classes their pages as network-fed: their non-zero figures are not determinism-grade evidence until triaged,
and the zero-difference identities (`-noisebake`, `-tier-resolver`) are unaffected.

`probe-cloud-cone-parity.mjs` and `probe-cloud-noisecore.mjs` are the cloud family's two INVESTIGATION probes this
round deliberately left live: both are named as technique exemplars (the stash-based A/B recipe), the first by
`DX-05` and the second in "Deliberately not here" above.
