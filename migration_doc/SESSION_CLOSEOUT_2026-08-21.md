# Session Closeout — 2026-08-21 evening (Batches 1129–1137, tiered orchestration)

Maintainer directive at ~23:45 ET: stop feeding workers new work; close out everything
in flight. This note is the resumable record of that closeout. Queue rows and the ledger
remain the status authorities; this file only tells the next session where things stand
and what is owed.

## Landed this evening (all pushed to `origin/main`)

| Batch | Commit | What |
| --- | --- | --- |
| 1129 | `0442e1eede` | C15-G9 fix round 1 — D2 reset witness compares a nine-field scene-state subset; every field behaviourally pinned |
| 1130 | `8ebe8059f8` | Licence vetting register re-baselined to Apache-2.0 (R-2026-08-21-23); 0 verdicts softened on baseline grounds; residual "MIT repo" statements corrected |
| 1131 | `1c2161c8de` | SOL-4 refresh-cost lane on GPU timestamps, protocol v2 — declared a LOWER BOUND (1 of 44 passes timed); zero differential at undeclared resolution INVALID |
| 1132 | `adf1920703` | C15-G9 run-2 diagnosis recorded; `NEW-WEBGPU-GSPLAT-CONTROL-ASSET-INTERMITTENT-NONRENDER` filed; the WebGPU cube-control half of run 2's D1 PASS withdrawn as vacuous |
| 1133 | `83677632c8` | C11-62 — SceneOctree dirty-revision rebuild skip, clauses (a) and (c); probe case-E lane authored (not run); watchdog added, grandfather row retired |
| 1134 | `4a89b794ed` | C12-33 moon-mip instrument repair 1 — catalog starfield disabled with a read-back witness; stray-pixel precondition; design metric bit-identical; custody hash unchanged |
| 1135 | `c9f8477dd7` | C15-G9 fix round 2 — D3 framing/coverage separation, D4 settle-memo reset, D5/D1 coverage trichotomy, WebGPU pipeline-readiness witness |
| 1136 | `e2615ef8e2` | SOL-4 round 2 — all refresh compute passes labelled; lane protocol v3 over a declared pass set; `NEW-MOON-NOT-PICKABLE-ENVIRONMENT-PASS-GATE` filed |
| 1137 | _(this note)_ | Session closeout record |
| 1138 | _pending_ | C12-33 moon-mip instrument repair 2 — the readiness cascade. Sol finished building in `cesium-worker-moonmip` (5 files: probe, two specs, and the F4 engine publication of Moon texture dimensions on both backends) but its station-3 review had not run at closeout; the clone's diff is snapshotted at `cesium-webgpu-backups/cesium-worker-moonmip-inflight-2026-08-22T0020/`. Next session: Opus review → extract → root + engine tsc → land → retire the clone. |

Every batch followed PATTERN v3: Sol built in an isolated clone, an Opus subagent ran the
station-3 review (full or delta), the orchestrator applied the enumerated edits, extracted
by pathspec, ran the hook gates plus root **and** engine-project `tsc` in main, and landed.

## Machine lane OWED (nothing below was run; all need an attestable bundle first)

Engine files changed in Batches 1133 and 1136 (and 1138 when it lands the Moon-dimension
publication), so `Build/CesiumUnminified` is stale relative to tip. Before any Edge run:
`npx gulp buildCesiumDual && npx gulp build`, then restart the `--serve-built` server on
:8080 and confirm the provenance gate passes.

1. **C12-33 moon-mip ten-run set** — `Tools/visual-regression/output/c12-33/ten-run-set.ps1`
   (detached pwsh; ~6 minutes once the readiness pre-position lands, not 2.5 h — the first
   set burned 60 s per run waiting at the launch camera). Both control modes are needed
   for the paired design; `force-lod0` has never been reachable before 1138.
2. **C15-G9 re-run** — `probe-gsplat-frame-variance.mjs`, both backends. Expect D3/D4/D5 to
   score (or name `subject-not-rendered` if the WebGPU control cube blanks again — that is
   the engine defect candidate, not a harness defect). Still no mechanism claim.
3. **SOL-4 commissioning run** — `probe-eclipse-cloud-response.mjs` under protocol v3.
   Treat as instrument commissioning, not acceptance; a `droppedPassCount` INVALID means
   the profiler's 128-pass-per-frame budget, fixable by raising the budget.
4. **C11-62 clause (b)** — `probe-scheduler-octree-demand.mjs` case E, the >200-command
   parity lane; then the moving-route measurement on a sphere-only fixture. The reviewers
   expect the scan-vs-insert cost to be close at N≈200; do not assume a win.

## Worker clones

Eight clones retired under the new closeout rule (reconfirm unused → harvest → confirm
nothing left → delete junction-first): api-docs, buildts, c16anchor, c16lockstep,
drillpick, pickcache, s5fix, writeback, plus reader and w4 after their landings. The
`buildts` harvest banked five C18 wave-V capture reports into
`Tools/visual-regression/output/**/*.tip-1101-2026-08-21.json` and a closeout patch under
`cesium-webgpu-backups/cesium-worker-buildts-closeout-2026-08-21/`. Several emptied clone
roots (`cesium-worker-reader`, `-s5fix`, `-writeback`, `-w4`) remain as zero-entry
directories pinned by stale shell handles — `rmdir` them after the next restart.
`cesium-worker-moonmip` is the only clone with content at write time (see 1138); do not delete it before that landing.

## Open items that are NOT scheduled

- `NEW-WEBGPU-GSPLAT-CONTROL-ASSET-INTERMITTENT-NONRENDER` — which silent-skip site fires
  (pending pipeline vs zero splat count) needs the G9 re-run's new readiness witness.
- `NEW-MOON-NOT-PICKABLE-ENVIRONMENT-PASS-GATE` — upstream gate; both backends; filed only.
- C11-62 review notes: 2D split-viewport alternation makes every octree build dirty;
  non-sphere bounding volumes disable reuse; `containment.octree.builtThisFrame` over-claims
  on reuse frames.
- SOL-4 lane: `scope: "whole-refresh"` excludes two encoder-level copies and the optional
  scene-capture render pass, inert at defaults; the protocol note names them.
- G9: the D2 structural reason still names no field (round-3 item if a third round ever
  opens); the WebGPU readiness witness is point-in-time.

## Governance carried

Rulings R-2026-08-21-13..24 were executed or stamped where their work landed; the
provisional amendment batch stays provisional (R-21); G3 (R-13) is a maintainer manual
session; the sixteen-cell moon-mip ratio design (R-15) waits on a pre-registered `r`.
Two playbook lessons were banked: workers cannot move a clone's tip, and briefs that cite
gitignored run evidence must ship it into the clone first.
