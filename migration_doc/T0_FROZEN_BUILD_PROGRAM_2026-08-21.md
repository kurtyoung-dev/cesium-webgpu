# T0 frozen-build acceptance program — 2026-08-21

**What ran.** The portfolio's pre-registered frozen-build order (C11-13 → C11-90 → C18-V2 →
C11-146) executed on ONE clean build (base `35256a3e5c`-era tip, later refreshed only for
doc/spec commits that touch no engine source), served as the built artifact
(`--production`, per ruling R-2026-08-21-5), one Edge job at a time, under the maintainer's
"keep going" step-5 dispatch confirmation. Logs and artifacts are banked under
`cesium-webgpu-backups/` (t0-* logs) and the clone's `output/performance/` run-unique set.
First-red law observed throughout: every red banked with classification; no gate widened.

## C11-13 — P0 voxel-inside-camera battery

- **Physical Edge waypoint probe: PASS, exit 0, failures empty, firstRed null** (first run
  green; recorded explicitly that no first-red artifact exists for it).
- **Focused Karma: 10/10** on real Edge (`EdgeHeadlessCI`; the suite grew from the
  pre-registered 6 — more coverage, all green). One operator flag-error along the way is
  its own record: `--webgpu` with a filter excluding every lane suite made the fail-closed
  ledger correctly refuse a green.
- **Offline static gates: 47/47 at tip after Batch 1091** (four pre-existing reds
  diagnosed by ref-table discrimination as CRLF-latent mutants plus one stale anchor,
  repaired with re-proven bites; the fourth red was an engine finding — see below).
- **Ten-probe preservation battery: 8/10 green.** Two reds, both classified with owners:
  - `probe-voxel-cell-pick` (row 4): off-geometry pixels read `[255,255,255,255]` on
    WebGPU where cleared is expected — the stale-pick-bytes defect whose fix
    (`pickClearValue` + clear-on-zero-frustums) exists UNLANDED in lane G. The 2026-08-12
    acceptance green was tree-contaminated by that same dirt.
  - `probe-voxel-megatexture` (row 7): the entire LRU/eviction/reupload mechanism matches
    its pre-registered numbers exactly (serials 1→3, generations 1→9, eviction 16, exact
    A-set re-request) but the A1-vs-A2 pixel identity fails at 99.55% mismatch — capture/
    readiness-shaped (even black pixels differ), discriminator owed.
- **Engine finding (Batch 1091):** the selected-voxel-owner dispatch consumer was never
  landed; lane G's `skippedWrongVoxelOwner` census IS that consumer (proven by the
  committed-tip red / dirty-tree green discrimination). Landing lane G closes the spec
  red, its two siblings, and battery row 4.

## C11-90 — glTF primitive-restart browser gate

- Offline contracts **66/66**.
- First probe run: **exception tier, banked** — the harness passed `HeadingPitchRoll.ZERO`,
  a static that has never existed; tonight was the first run to reach the line (both
  banked prior runs died earlier). Repaired in Batch 1088.
- Re-run: **PASS, failures empty** — topology and shape authorities met on both backends,
  recovery lane green (viewer recreate on both backends), zero error lanes.

## C18-V2 — capture-and-diff certifying scenes

- Policy spec 21/21.
- **All three scenes now hold reviewed, promoted baselines** (Batches 1089/1090/1092):
  voxel-box-procedural **0.49%** (first honest value for a deliberately-UNMEASURED
  expectation), pointcloud-timedynamic-edl **0.55%** (expectation met; sensitivity floor
  carried), gsplat-sh-unit-cube **0.40%** (C15-G8-derived expectation met). Every PNG pair
  eyeballed by the orchestrator before promotion; promotion ran the full four-flag gate
  from a clean clone, one scene per landing as the stability gate demands.
- The gsplat scene's two first-run reds were REAL and correctly fail-closed; diagnosis:
  **ENVIRONMENT** — the clone's build lacked the untracked ThirdParty WASM binaries
  (`gulp prepare` never ran), stalling both backends' splat pipelines identically at
  TEXTURE_PENDING on a 404. Provisioning now prevents the trap (Batch 1092). The same
  hole silently breaks Draco — recorded for the C18-P lane.
- **Remaining owed on the row: the per-scene non-vacuity mutations.**

## C11-146 — settle-window attribution route run

- **The metric fires and the real lags are recorded** — the row's substantive acceptance:
  both legs `firstCompleteFrame.detected=true`, `stableFrames=3`, `traceTruncated=false`,
  `agreesWithTrace=true`; WebGL first-complete frame 23 at ~252.6 ms after setup, WebGPU
  frame 7 at ~1409.1 ms; `settleAttribution.available=true` with an 879.5 ms window.
- The run itself is **red (exit 1), banked as the row's first red**, on two harness-tier
  gates: (1) console-error gates tripped by Chromium sandboxed `about:blank` iframe noise
  (8 entries WebGL / 2 WebGPU, identical text — locate the iframe and fix its sandbox
  attribute rather than filtering the message); (2) the assessor's provenance check
  compares absolute path STRINGS, which is not clone-portable — the file identities
  already carry sha256, so identity should bind to content hashes. Both repairs are filed
  instrument work; the metric evidence stands, and the row is NOT declared green.

## Cross-cutting records

- The 2026-08-12 C11-13 acceptance and the 2026-08-12 pick-lifecycle landing were both
  partially tree-contaminated: greens measured in a worktree carrying lane G's (and the
  spec landing omitted lane G's engine half entirely — three committed-main spec reds
  masked since then). The dirty-lane register's lane G entry carries the linkage; lane G's
  landing is the highest-leverage single integration remaining.
- Machine-lane environment notes: Karma on Edge 151 requires `EdgeHeadlessCI` (the default
  `Chrome` launcher fix is authored, in review); Karma runs in a clone execute the MAIN
  tree's engine through the node_modules junction (documented in the worker isolation
  guide); clone builds require the `gulp prepare` ThirdParty step (now provisioned).
