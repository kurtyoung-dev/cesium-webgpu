# Campaign 9 — Opus Execution Guide (Fable → Opus Handoff)

**Written 2026-07-16 at HEAD `ea6332d0aa` (Batch 672).** Landed at writing time: Batch 670
`C9-06-CELESTIAL-CLOSE`, Batch 671 `C9-CONTAINS-PARITY` (`NEW-DATASOURCECOLLECTION-CONTAINS-PARITY`),
Batch 672 `C9-HDR-PICK-FORMAT-CLOSURE`. The working tree was DIRTY at writing time (an engine task
was in flight); expect higher batch numbers and more ledger rows by the time you read this.

**Purpose.** This guide hands the remaining Campaign 9 work
(`migration_doc/QUEUE_2026-07-15_CAMPAIGN9.md`) from Fable to Opus workers. Fable capacity is a
known exhaustion risk (C7 precedent); when the campaign engine's session flips to Opus, the worker
picking up any task should be able to execute from this guide plus the queue plus the charter with
NO campaign memory. Every task cluster below was researched against the live post-Batch-672 tree:
line anchors were re-verified on 2026-07-16, stale doc anchors were corrected inline, and each
section carries its own invariants, walkthrough, traps, verification recipe, and rollback boundary.

**How to use it.** Sections are self-contained; read ONLY the section for your task (plus G10 if
you are resuming the workflow engine). Line numbers are hints — the tree moves daily under the
concurrent campaign; re-verify every anchor by symbol grep before editing. The engine-handoff
section (G10) comes first because it governs everything else: if you are here because Fable ran
out, execute G10 Part B before any task work.

**Cluster → task map** (engine execution order runs DEPTHPLANE → BROAD-SUITE → C9-07 → C9-08 →
C9-09 → C9-10 → C9-13 → C9-11 → C9-12 → C9-12A → C9-14 → C9-16 → C9-17 → C9-18 → C9-30; clusters
group related tasks, so read the section that owns your task ID):

| Section | Task IDs |
| --- | --- |
| [G10](#g10) | C9-30-PERF-CHECKPOINT protocol + campaign-9-resume.js engine handoff / resume procedure |
| [G1](#g1) | NEW-WEBGPU-DEPTH-PLANE-LOG-DEPTH-CONTRACT remainder + NEW-WEBGPU-PICK-FLEET-LOG-DEPTH + C9-02B closure |
| [G2](#g2) | C9-BROAD-SUITE-TRIAGE remainder: items 64/65/67/70/71 + item 72 gate (C8-SHARED-UPSTREAM-CONTRACT-GATE) |
| [G3](#g3) | C9-07-DEMAND-OPEN-CANVAS-PASS (FAR-405-C0) |
| [G4](#g4) | C9-08-SCHEDULER-OCTREE-DEMAND-AND-PERSISTENCE + C9-18-HOTPATH-DIAGNOSTIC-DEMAND-GATES |
| [G5](#g5) | C9-09-ATTACHMENT-DEMAND-REGISTRY (FAR-401-C0) + C9-10-CONSUMER-DRIVEN-MRT (FAR-403-C0) |
| [G6](#g6) | C9-11-RETAINED-TERRAIN-DESCRIPTORS (FAR-309) + C9-12-TERRAIN-STATIC-DYNAMIC-UPLOAD-SPLIT (FAR-303) |
| [G7](#g7) | C9-12A-IMAGERY-SOURCE-REALIZATION-DEDUP-AND-MIP-PREP |
| [G8](#g8) | C9-13 NEW-GLOBE-EFFECTS-PER-VIEW-PREPARED-HANDLE + C9-14-GROUND-ATMOSPHERE-STAGE-OWNERSHIP |
| [G9](#g9) | C9-16-CLUSTERED-LIGHT-ZERO-WORK-CONTRACT + C9-17-MODEL-SETTLED-FRONTEND-REVISIONS |

A consolidated [traps index](#traps-index) closes the guide — every section's traps, one line each.

---

## QUICK START (Opus worker, cold start — 15 lines)

1. Read `CLAUDE.md` (repo root) in full — the charter is binding: never weaken a feature for a metric; probe-first visual verification; backend agnosticism; RTE precision rules.
2. Read `migration_doc/QUEUE_2026-07-15_CAMPAIGN9.md` — §1 rules, §3 gates, §3.2 live ledger (unlisted = NOT STARTED), the Wave tables with your task's acceptance text.
3. Read THIS guide's section for your task before opening any source file; re-verify every line anchor by symbol grep — the tree moves under the concurrent campaign.
4. Read `migration_doc/SOL_AUDIT_REPORT_2026-07-16.md` — pre-existing-vs-introduced boundaries, P0/P1 lists, queue amendments; Sol landed as Batches 656–669, resume work lands 670+.
5. Resuming the campaign ENGINE after Fable exhaustion? Follow [G10 Part B](#g10) EXACTLY: salvage orphan WIP to the scratchpad, flip only unfinished tasks to `model: 'opus'`, keep completed task entries byte-identical (cache replay), resume with `resumeFromRunId: 'wf_f6cb6b3b-927'`.
6. First commands, always: `git log --oneline -15` + `git status --short` + `git branch -a` — attribute every dirty file to a task before touching anything; never `git add -A`, never bare `git stash`, never revert files you did not author.
7. Ledger discipline: update the §3.2 row (IN PROGRESS / COMPLETE / PARTIAL-PAUSED / BLOCKED / DEFERRED) in the SAME commit as the work — a missing ledger update is a landing defect; an engine revert without a ledger row is invisible debt.
8. Build gates before any probe: `npx tsc --noEmit` then `npx gulp build`; dev server `node server.js` (probes) / `node server.js --production` (perf lanes); edit `packages/engine/Source/**` only, never root `Source/` (build output).
9. Karma specs: ~~`npm run build --workspace @cesium/engine` FIRST (spec-bundle freshness trap, queue item 4A)~~ **— STRUCK 2026-08-07 (C11-132 landed; `gulp test` now verifies the served bundle itself and fails naming the drifted files). Do NOT copy this workaround forward.** `$env:CHROME_BIN` → Edge binary, focused runs via `--includeName`; a trailing "Chrome failed" line after SUCCESS is a launcher artifact — trust the exit code.
10. Probes: Playwright Edge only (`channel: "msedge"`), never Firefox (no WebGPU); read the output PNGs yourself (Principle 8); scan generated scripts for unbounded loops before running.
11. Performance evidence: moving-altitude route only (idle-soak FPS is INVALID); clean and `--api-instrumentation` lanes never mixed; ≥5 counterbalanced reps for blocking timing claims; comparison anchor = Gate-A r5 (WebGL 5.50 / WebGPU 7.51 ms CPU p95); never overwrite historical artifacts.
12. One concern per slice; roll back the optimization, never the feature; tests and counters survive rollback.
13. Unknown consumers/inputs get the conservative fallback — never guess, never silently route around missing functionality; surface it as the next work item (Principle 9).
14. Land as kurtyoung-dev (`gh auth switch` on 403); batch number = highest `Batch NNN` in `git log --oneline -10` + 1; never `--no-verify`; lint-staged OOM → `--concurrent 1`.
15. When blocked or honest-partial: say so in the ledger row with the failing oracle named — a truthful miss with green mechanics is a VALID, COMPLETE result.

---

<a id="g10"></a>

## G10 — C9-30-PERF-CHECKPOINT protocol + ENGINE HANDOFF MECHANICS

### C9-30-PERF-CHECKPOINT + CAMPAIGN-9 ENGINE HANDOFF

This section has two halves. **Part A** is the C9-30 measurement protocol, written so you can
execute it verbatim. **Part B** is how the Campaign-9 workflow engine works and the EXACT
procedure for resuming it after Fable capacity runs out. Every file/line anchor below was
re-verified against the live tree at HEAD `ea6332d0aa` (Batch 672, 2026-07-16). The tree was
DIRTY at guide-writing time (an engine task was in flight) — expect batch numbers > 672 and more
ledger rows by the time you read this. Re-verify anchors that matter before acting on them.

---

## PART A — C9-30-DEFAULT-PATH-PERFORMANCE-CHECKPOINT (Wave-2 gate, queue item 35)

### Architecture today (post-Sol, verified)

**What C9-30 is:** a measurement-only gate. Zero renderer changes. You rebuild ONE hash, run the
moving-altitude camera campaign in two separate lanes (clean + API-instrumented), compare against
the recorded Gate-A medians, and write an honest promote/iterate verdict for the whole Wave-2
tranche (C9-05/06/07/08/09/10/11/12/12A/13/14/16/17/18). A missed target is a truthful result,
not a failure — the offGate in the engine task literally says so.

**The measurement stack (all verified live):**

- **Runner:** `Tools/visual-regression/run-performance-campaign.mjs` (3,009 lines).
  - CLI usage block at L50–69. Key flags: `--workload ID` (repeatable), `--repetitions N`,
    `--renderer webgl|webgpu|both` (default both), `--output FILE`,
    `--api-instrumentation`, `--gpu-timestamps`, `--reuse-browser`, `--headed`.
  - Clean lane is the DEFAULT: `apiInstrumentation: false`, `gpuTimestamps: false` (options
    struct L72–86; the comment at L81–83 states the contract: "Cross-backend CPU comparisons
    must not instrument only the WebGPU leg. Timestamp profiling is an explicit, separate
    characterization lane.").
  - **Fresh Edge process per run is the default** — a new `chromium.launch({channel:
    manifest.protocol.browser})` per repetition (L2961–2979); the report records
    `browserIsolation: "fresh-process-per-run"` (L2920–2922). `--reuse-browser` is a
    cross-run stress mode only — NEVER use it for the checkpoint.
  - Records source identity automatically: git commit, branch, `dirty` flag, and the
    sha256 + byteLength of `Build/CesiumUnminified/Cesium.js` (L2850–2856, L2895–2904).
  - Counterbalancing: `buildCounterbalancedSchedule(renderers, repetitions)` at L2877,
    implemented in `Tools/visual-regression/lib/performance-campaign-utils.mjs` L107–118 —
    odd repetitions run `[webgl, webgpu]`, even repetitions run `[webgpu, webgl]`. You get
    this automatically by passing `--renderer both` (or omitting it); do NOT run the two
    backends as separate invocations, that defeats counterbalancing.
  - Output: writes the JSON report to `--output` and echoes it; `process.exitCode = 1` if
    `report.result !== "pass"` (L3004–3008).

- **Workload manifest:** `Tools/visual-regression/performance-workloads.json`
  (`id: fork-remediation-phase0-v1`, schemaVersion 1). Protocol block (L7–18): browser
  `msedge`, viewport 1280×720@1, `fixedClock: 2026-06-21T08:00:00Z`, warmup 120 frames,
  600 measured frames, settle 30 stable frames / 45 s timeout, default repetitions 6.
  The authoritative workload is **`moving-camera-altitude-track-3d`** (L39–48): action
  `camera-track`, trackId `orbit-to-ground-global-v1`, `measuredSeconds: 20` (duration-mode
  measurement). The moving-pick variant is `moving-pick-camera-altitude-track-3d` (L50–59) —
  NOT required for C9-30 unless a Wave-2 slice touched pick (C9-07 touches pick mini-frames;
  see decision points below).

- **The route:** `Tools/visual-regression/lib/globe-camera-track.mjs` — 9 waypoints → **8
  segments**, 18,000 km down to 300 m: `orbit-globe-pacific(18,000,000 m) → orbit-americas(6,000,000)
  → descend-sierra(900,000) → descend-sf-coast(300,000) → low-oblique-sf(60,000) → city-sf(12,000)
  → near-ground-sf(2,500) → ground-sf(300) → orbit-himalaya(2,500,000)`. Track duration 20 s.
  **"Near-ground" for the ≥15% target = segments index 5 and 6**, named
  `city-sf->near-ground-sf` and `near-ground-sf->ground-sf` in
  `run.trackMetrics.segments[].name`. (On Gate-A these were the most expensive WebGPU
  segments: p95 ≈ 8.96 / 8.63 ms on a sampled run.)

- **Deterministic offline boot:** `buildPerformanceViewerUrl` in
  `Tools/visual-regression/lib/performance-viewer-url.mjs` appends `renderer=<x>&offline=true`
  to the manifest `baseUrl` (`http://localhost:8080/Apps/CesiumViewer/index.html`). The viewer
  side handles it in `Apps/CesiumViewer/CesiumViewerStartupOptions.js` (L18:
  `endUserOptions.offline === "true"`): no base-layer picker, zero bootstrap imagery layers,
  default ellipsoid terrain. The runner asserts this boot contract per run (no external
  network; every cross-origin request is recorded in `externalRequests` and fails the lane).
  Certified by ledger row `NEW-PERF-DETERMINISTIC-VIEWER-BOOT` (COMPLETE).

- **Quality/stability gates (in `lib/performance-campaign-utils.mjs`):**
  - `assessPerformanceRunQuality` (L384–484): a run is invalid for CPU aggregation unless
    the track produced aligned, full-route, all-8-segment evidence with ≥30 samples per
    segment (`minTrackSegmentSamples`); long-task occupancy >25% coinciding with timestamp
    backpressure marks main-thread contamination and invalidates the run.
  - `assessPerformanceRunStability` (L486–529): across repetitions, CPU-p95 max/min ratio
    > 2.00 → unstable → `report.result = "fail"`; duration-mode frame-count max/min ratio
    > 1.5 also fails.

- **Gate-A baseline (the comparison anchor — verified by parsing the artifact):**
  - Artifacts on disk (gitignored — `git check-ignore` confirms; the ledger row + commit
    message carry the numbers, the JSON stays machine-local):
    - `Tools/visual-regression/output/performance/campaign9-gate-a-smoke-2026-07-15.json`
    - `Tools/visual-regression/output/performance/campaign9-gate-a-clean-r5-2026-07-15.json`
    - `Tools/visual-regression/output/performance/campaign9-gate-a-api-r5-2026-07-15.json`
  - Clean r5 medians (`aggregates["<renderer>:moving-camera-altitude-track-3d"].cpuP95AcrossRuns`):
    **WebGL p50 = 5.50 ms (min 5.10, max 5.50); WebGPU p50 = 7.51 ms (min 7.20, max 9.40)**.
    10 runs, 5 counterbalanced repetitions, fresh-process, no instrumentation, Edge
    150.0.4078.65, `result: "pass"`, all runs quality `"clean"`.
  - Gate-A source identity: commit `a54cc06`, `dirty: true`, bundle sha256
    `B8015811ACC0567663C6898386DC74AD94424363B22DA2A1759DF54AC666C11E` (this is the "B8015811"
    bundle the queue refers to). Yes — Gate-A was measured on Sol's dirty pre-landing tree;
    the comparison basis is the RECORDED ARTIFACT, not a re-derivation.
  - Known nonfatal noise: Gate-A runs carried a handful of `consoleErrors` (blocked
    external-request diagnostics — the recorded known-error ledger). `pageErrors` and
    `deviceErrors` were 0 and must stay 0. Do not fail your checkpoint on consoleErrors that
    match the same known-error class; DO fail on any new class.

- **API-lane reference values (from Gate-A api-r5, for sanity-checking your instrumented lane):**
  median WebGPU per frame ≈ 14.41 passes, 1.43 submits, 4.85 bind groups, 10.03 writes /
  112.9 KB, 1.84 buffers / 5.60 KB. Wave-2 slices (C9-07 pass demand-open, C9-11 retained
  descriptors, C9-12 upload split, C9-12A imagery dedup) are supposed to move exactly these
  counters; your per-slice attribution comes from here.

### Target design + invariants

1. **One hash.** Rebuild once (`npx gulp build`), then run BOTH lanes on that identical
   `Build/CesiumUnminified/Cesium.js`. Every artifact's `source.runtimeBundle.sha256` must be
   equal across lanes, and equal to what you record in the ledger. Ideally `source.dirty ===
   false` (C9-30 is measurement-only; the tree should be clean when you start).
2. **Two lanes, never mixed.** Lane 1 = clean (no flags). Lane 2 = `--api-instrumentation`.
   Only Lane 1 timings support the promotion verdict. Lane 2 exists for attribution
   (which slice moved which counter). `--gpu-timestamps` is a third, optional lane; if run,
   it is characterization only, never mixed into the CPU comparison.
3. **r5 + r5 counterbalanced.** `--repetitions 5` with `--renderer both` (default) gives 5
   repetitions × 2 renderers = 10 runs per lane, order-alternating per repetition. This is the
   queue §12.5 minimum ("At least five order-counterbalanced route repetitions support blocking
   performance claims").
4. **Fresh process per run; offline boot; moving route only.** Never `--reuse-browser`; never
   idle-soak/FPS (C9 rule 5 — request-render idle soak is INVALID evidence); never a
   credentialed/streaming boot.
5. **Promotion rule (queue §12.6 / Wave-2 item 35, QUEUE_2026-07-15_CAMPAIGN9.md L210 +
   L346–348):** the combined Wave-2 tranche passes when, versus Gate-A:
   - WebGPU whole-route CPU-p95 median improves **≥10%** (target ≤ 6.76 ms vs 7.51), AND
   - WebGPU near-ground CPU-p95 (segments 5+6) improves **≥15%**,
   - OR the improvement exceeds **3× measured noise** (see the noise definition below);
   - AND no route-segment **p99** regresses beyond noise on either backend;
   - AND no feature loss (visual/parity probes green);
   - AND no WebGL regression beyond the predeclared workload budget.
6. **Noise definition (declare it BEFORE looking at the deltas):** noise for a metric = the
   (max − min) spread of that metric across the 5 quality-valid clean runs of the same
   backend/lane at the checkpoint, cross-checked against the Gate-A spread (WebGPU Gate-A
   spread was 2.20 ms — wide; the near-ground segments are where the signal is). If your
   measured spread is wider than the claimed improvement, the claim fails regardless of the
   medians — say so.
7. **WebGL budget must be predeclared.** No numeric budget is pinned in the queue. Before
   running, write into the ledger row the budget you will hold WebGL to (recommended: WebGL
   whole-route cpuP95 median must stay within max(5%, its own measured noise) of 5.50 ms).
   Declaring it after seeing the data is the exact "massaged lane" the brief forbids.
8. **Never overwrite historical artifacts.** New artifacts get NEW names (Gate G fails when
   "historical evidence is overwritten"). Naming pattern (follow the existing convention):
   `campaign9-c9-30-checkpoint-clean-r5-<YYYY-MM-DD>.json` and
   `campaign9-c9-30-checkpoint-api-r5-<YYYY-MM-DD>.json` under
   `Tools/visual-regression/output/performance/`.
9. **Honest-miss reporting is a REQUIRED deliverable, not a fallback.** If the target is
   missed: report the actual deltas, attribute per-stage where the remaining cost lives
   (per-segment p95/p99 + API-lane counter deltas + the C9-01 logical counters if you run the
   instrumented lane with them), name which Wave-2 slices did/did not land, and write the
   iterate verdict. Do not re-run lanes hunting for a better number; do not drop "outlier"
   runs by hand (the quality/stability machinery is the only legitimate excluder).

### Implementation walkthrough

Step 0 — Preconditions.
- `git status` must be clean (if not: STOP — an engine task is in flight or left WIP; see
  Part B salvage). `git log --oneline -3` to record HEAD.
- Dev server up: `curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/Apps/CesiumViewer/index.html`
  → 200. If down: `node server.js` (background) from the repo root.
- Count which Wave-2 tasks actually LANDED (git log grep for `C9-07|C9-08|C9-09|C9-10|C9-11|
  C9-12|C9-12A|C9-13|C9-14|C9-16|C9-17|C9-18` batch commits + ledger §3.2). The verdict must
  name the landed set — a checkpoint over a partial tranche is still valid, but the report
  must say which levers were in the build.

Step 1 — Rebuild one hash.
```
npx gulp build          # ~1 min; compiles WGSL → JS shader modules + Build/CesiumUnminified
```
Record `git rev-parse HEAD`; the runner captures the bundle sha automatically.

Step 2 — Predeclare (ledger edit first). In `migration_doc/QUEUE_2026-07-15_CAMPAIGN9.md`
§3.2, set row `C9-30-DEFAULT-PATH-PERFORMANCE-CHECKPOINT` to **IN PROGRESS** with: the HEAD
hash, the WebGL budget declaration, and the noise rule (invariants 6–7).

Step 3 — Clean lane (the verdict lane). Expect ~15–25 min (10 runs × (boot + 20 s route)).
```
node Tools/visual-regression/run-performance-campaign.mjs ^
  --workload moving-camera-altitude-track-3d ^
  --repetitions 5 ^
  --output Tools/visual-regression/output/performance/campaign9-c9-30-checkpoint-clean-r5-<DATE>.json
```
(No `--renderer` → both, counterbalanced. No instrumentation flags → clean. PowerShell: one
line or backtick continuations; the `^` above is cmd-style — just put it on one line.)

Step 4 — Instrumented lane (attribution lane), same bundle, separate invocation:
```
node Tools/visual-regression/run-performance-campaign.mjs ^
  --workload moving-camera-altitude-track-3d ^
  --repetitions 5 --api-instrumentation ^
  --output Tools/visual-regression/output/performance/campaign9-c9-30-checkpoint-api-r5-<DATE>.json
```

Step 5 — Analyze. Read the JSON artifacts yourself (the exit code alone is not the analysis).
Extraction recipe (adapt; run with `node -e` or a scratchpad script — put scratch scripts in
the scratchpad, NOT the repo):
```js
const fs = require("fs");
const r = JSON.parse(fs.readFileSync("<clean artifact>", "utf8"));
// 1. Global gates
//    r.result === "pass"; every run: run.result === "pass" && run.quality.status === "clean";
//    run.pageErrors.length === 0 && run.deviceErrors.length === 0;
//    both aggregates stable === true.
// 2. Whole-route medians
//    r.aggregates["webgpu:moving-camera-altitude-track-3d"].cpuP95AcrossRuns  → p50/min/max
//    r.aggregates["webgl:moving-camera-altitude-track-3d"].cpuP95AcrossRuns
// 3. Per-segment medians (the runner does NOT aggregate segments — compute across runs):
const med = a => { const s=[...a].sort((x,y)=>x-y); return s.length%2 ? s[(s.length-1)/2] : (s[s.length/2-1]+s[s.length/2])/2; };
for (const backend of ["webgl","webgpu"]) {
  const runs = r.runs.filter(x=>x.renderer===backend && x.result==="pass" && x.quality.validForCpuAggregation!==false);
  for (let seg=0; seg<8; seg++) {
    const p95s = runs.map(x=>x.trackMetrics.segments[seg].cpuMs.p95);
    const p99s = runs.map(x=>x.trackMetrics.segments[seg].cpuMs.p99);
    console.log(backend, runs[0].trackMetrics.segments[seg].name,
      "p95med", med(p95s).toFixed(2), "p99med", med(p99s).toFixed(2),
      "spread", (Math.max(...p95s)-Math.min(...p95s)).toFixed(2));
  }
}
```
- Whole-route delta: `(7.51 − newWebgpuP50) / 7.51`.
- Near-ground delta: compute segment-5 and segment-6 p95 medians now vs the same segments in
  `campaign9-gate-a-clean-r5-2026-07-15.json` (parse the Gate-A artifact with the identical
  recipe — do NOT eyeball a single run).
- Segment-p99 regression check: every segment, both backends, new p99 median must not exceed
  Gate-A p99 median by more than that segment's measured noise.
- API-lane attribution: diff `run.apiCounters` medians (passes begun, submits, writeBuffer
  calls/bytes, buffers/textures created, bind groups) vs the Gate-A api-r5 values above, and
  name which Wave-2 slice owns each delta.

Step 6 — Feature-loss gate. Run the standing visual gates on the SAME build:
`node Tools/visual-regression/capture-and-diff.mjs --scene globe-default` (plus any probes the
landed Wave-2 slices name as their regression gates in their ledger rows). Any new visual
regression = the checkpoint FAILS regardless of timing wins, and the offending slice — the
optimization, never the feature — is the rollback candidate.

Step 7 — Record + land.
- Update the §3.2 row `C9-30-DEFAULT-PATH-PERFORMANCE-CHECKPOINT` to **COMPLETE** with: hash,
  both artifact filenames, whole-route + near-ground deltas with noise, per-segment p99
  verdict, WebGL budget verdict, the per-slice attribution table, and the promote/iterate
  verdict. This ledger edit IS the durable evidence (artifacts are gitignored).
- Commit ONLY the ledger/doc edits (+ any scratch-free analysis notes if you put them in
  migration_doc). NEVER stage `Tools/visual-regression/output/` (gitignored anyway, and the
  land prompt forbids it). Batch-numbered commit per Part B land rules.

**Decision points:**
- If the clean lane reports `result: "fail"` from *stability* (cpu p95 max/min > 2.0): do not
  hand-prune runs. Check for machine contamination (other browsers, builds running), fix the
  environment, re-run the WHOLE lane, and keep the failed artifact under a `-attempt1` name.
- If a route segment shows `sampleCount < 30`: the machine was too slow that run — the quality
  gate already invalidated it; if >1 run per backend is invalidated, re-run the lane; if it
  reproduces, STOP and mark the checkpoint BLOCKED (machine state), do not report timings.
- If `externalRequests` is non-empty on any run: the offline boot contract broke (a Wave-2
  change touched the viewer boot?) — STOP, this is a correctness finding; file it in the
  ledger and fix before measuring.
- If Gate-A artifacts are missing from disk: STOP and mark BLOCKED — the comparison basis is
  gone; do not substitute a re-measured "baseline" on the new tree (that measures nothing).
- If C9-07 (pick mini-frames) landed, ALSO run one `moving-pick-camera-altitude-track-3d`
  clean r5 pair and confirm no hover-pick p95 regression vs
  `moving-pick-exact-current-clean-2026-07-15.json` (same medians recipe;
  `pickMetrics.combinedCpuMs.p95` is the reader the aggregator uses).

### Traps for the unwary

1. **Running backends in separate invocations kills counterbalancing.** One invocation,
   `--renderer both` (default). The schedule alternates order per repetition automatically.
2. **`--api-instrumentation` numbers are NOT timing evidence.** The wrappers add observer
   overhead to hot API calls (runner comment L992–994). Never quote an instrumented p95 as
   the campaign delta; never compare a clean lane to an instrumented lane.
3. **`--gpu-timestamps` contaminates cross-backend CPU comparison** (only the WebGPU leg gets
   instrumented). It is off by default; leave it off for the verdict lanes.
4. **`--reuse-browser` leaks WebGPU resources across repetitions** — the runner's own comment
   (L276–280) documents severe CPU stalls contaminating following repetitions in the same
   process. Fresh process is the default; don't "optimize" the runtime.
5. **Aggregates hide segments.** `report.aggregates` only carries whole-route cpuP95; the
   ≥15% near-ground target and the p99-regression rule REQUIRE per-run
   `trackMetrics.segments` medians computed across runs (recipe above).
6. **The 7.08 ms C9-05 number is NOT the baseline.** The ledger explicitly says the single
   post-C9-05 clean r1 (7.08 ms) "is not used as a campaign-level timing claim". The
   comparison anchor is Gate-A r5: WebGL 5.50 / WebGPU 7.51.
7. **consoleErrors ≠ pageErrors.** Gate-A carried known nonfatal blocked-external-request
   console diagnostics. Fail on pageErrors/deviceErrors (must be 0) and on NEW console-error
   classes only.
8. **Idle workloads prove nothing.** `settled-static-3d` is a no-work diagnostic; the manifest
   says so. The moving-altitude track is the only valid promotion evidence (C9 rule 5,
   CLAUDE.md campaign header).
9. **Do not edit `performance-workloads.json`, the track, or the runner** to "help" the
   measurement — that silently forks the protocol from Gate-A and voids the comparison. If a
   runner bug blocks you, fix it as its own slice with its own ledger row FIRST, then re-run
   Gate-A-equivalence reasoning explicitly in the ledger.
10. **Dirty tree = wrong hash.** If `source.dirty: true` appears in your artifact and you
    didn't expect it, an engine task left WIP — the measurement is attributable to an unknown
    diff. Clean first (Part B salvage), rebuild, re-run.
11. **Machine load.** Close other Edge instances/builds; the stability gate (>2.0 ratio) will
    catch gross contamination but a quietly-inflated-but-stable lane still lies. 32 GB RAM
    machine; the lanes are safe, but don't run both lanes concurrently — serialize them.

### Verification recipe

PASS =
- both artifacts exist with the new names, same `runtimeBundle.sha256`, `result: "pass"`;
- 10/10 runs per lane `quality.status === "clean"`, all 8 segments covered, route completed,
  ≥30 samples/segment, 0 pageErrors, 0 deviceErrors, 0 externalRequests;
- both aggregates `stable: true`;
- the promotion arithmetic (invariant 5) computed from medians-across-runs, with the noise
  spread reported next to every claimed delta;
- standing visual gates green on the same build;
- ledger row updated with the verdict + numbers + artifact names, committed and pushed.

A truthful FAIL of the ≥10%/≥15% target with all of the above mechanics green is a VALID,
COMPLETE C9-30 — record verdict "iterate" with the per-stage attribution of remaining cost
(expected next levers per the queue: C9-11 if unlanded is THE lever; then C9-12A, C9-07).

### Rollback boundary

C9-30 itself changes no renderer code — there is nothing to roll back except doc edits.
If the checkpoint FAILS its gates because a Wave-2 slice regressed a segment p99 / WebGL /
a feature: the rollback unit is that INDIVIDUAL slice's optimization commit (revert the batch
commit), never the feature it touched and never the whole tranche. Re-run the clean lane after
any revert to re-establish the tranche number. Queue rule 6 (§1): "Roll back the optimization,
never the feature. Tests and counters remain."

---

## PART B — ENGINE HANDOFF MECHANICS (campaign-9-resume.js)

### Architecture today (verified against the live script)

**Script:** `f:\Dev\GH\cesium-webgpu\.claude\workflows\campaign-9-resume.js` (362 lines,
UNTRACKED BY DESIGN — `.claude/` is not committed; the queue doc is the durable record).
Runs under the Claude-Code Workflow harness as run **`wf_f6cb6b3b-927`** (launched 2026-07-16,
task `wbe4oirq8`) — this is the run you resume, NOT a fresh launch.

**Shape (L1–17):** `meta` header; `REPO` const; a `CHARTER` string (fork hard rules + context
docs + CLEAN-TREE CONTRACT + build commands) prepended to EVERY agent prompt. Note: the meta
description mentions research lanes but `const RESEARCH = []` is EMPTY (L239) — the lane pump
(L252–260) is a structural no-op in this campaign. Also note the CHARTER (L13) still says the
module-cache key "masks defines to 24 bits" — that statement is STALE post-Sol (the 40-bit
full-define key landed Batch 658) but you must NOT fix it (see cache-replay trap below).

**18 sequential tasks (L20–155), in order:**
`C9-06-CELESTIAL-CLOSE`(opus) → `C9-DEPTHPLANE-LOGDEPTH-CONTRACT` → `C9-CONTAINS-PARITY`(opus)
→ `C9-HDR-PICK-FORMAT-CLOSURE` → `C9-BROAD-SUITE-TRIAGE` → `C9-07-DEMAND-OPEN-CANVAS` →
`C9-08-SCHEDULER-OCTREE-DEMAND`(opus) → `C9-09-ATTACHMENT-DEMAND-REGISTRY` →
`C9-10-CONSUMER-DRIVEN-MRT`(deps:[C9-09]) → `C9-13-GLOBE-EFFECTS-HANDLE`(opus) →
`C9-11-RETAINED-TERRAIN-DESCRIPTORS` → `C9-12-TERRAIN-UPLOAD-SPLIT`(opus, deps:[C9-11]) →
`C9-12A-IMAGERY-DEDUP-MIP-PREP` → `C9-14-GROUND-ATMOSPHERE-STAGE`(opus) →
`C9-16-CLUSTERED-ZERO-WORK-CERT`(opus) → `C9-17-MODEL-SETTLED-FRONTEND` →
`C9-18-DIAG-DEMAND-GATES`(opus) → `C9-30-PERF-CHECKPOINT`.
Tasks WITHOUT a `model:` field inherit the session model (Fable): DEPTHPLANE, HDR-PICK,
BROAD-SUITE, C9-07, C9-09, C9-10, C9-11, C9-12A, C9-17, C9-30. Model tiering comment at
L296–299: opus for scoped/mechanical tasks where "the brief contains the answer"; session
model for diagnostic/novel work where "the agent must FIND the answer".

**Per-task loop (L275–359), strictly sequential (tasks share main + the build + :8080):**
1. Budget guard: stop cleanly if `budget.remaining() < 100000` (L276) → status `NOT-RUN-BUDGET`.
2. Dep skip: unlanded deps → `SKIPPED-DEP` (L277–281).
3. **IMPL** agent (`implPrompt`, L184–194): verify-premise-first (step 0 — stale premise →
   regression probe + doc reconcile + `premiseStale=true`), implement, eslint+tsc, gulp build,
   run the acceptance probe and READ the PNGs, prove the off-gate, run standing regression
   probes. DO NOT commit. If blocked: revert to clean tree, `blocked=true` (+ optionally a
   DEFERRED_WORK.md finding as the only leave-behind). Returns `IMPL_SCHEMA` (L158–167:
   id/implemented/blocked/premiseStale/blockReason/changedFiles/summary/probeResult/
   probePngRead/offGateResult/treeCleanIfFailed).
4. **AUDIT** agent (`auditPrompt`, L195–203): adversarial, verifies against the ACTUAL
   `git diff`; checks (a) OFF byte-identity — with the documented exception that an
   unconditional parity bug-fix may be GO with `offByteIdentical=false`; (b) ON parity — a
   probe that passes without reaching the new code is NO-GO; (c) no regression. Returns
   `AUDIT_SCHEMA` (L168–175: verdict GO/GO-WITH-FIXES/NO-GO + boolean sub-flags + blockers +
   rationale). **A dead audit agent (null) is retried ONCE (L312–318, the B18 lesson) — a
   dead audit must never revert probe-verified work.**
5. GO-WITH-FIXES → one **FIX** agent pass (`fixPrompt`, L204–208, no scope creep) → re-audit
   (L319–327).
6. **Pass rule (L332–341, hard-won: FOUR false reverts came from vetoing GO with sub-flags):**
   `pass = audit && verdict !== 'NO-GO' && noRegression !== false && !(GO-WITH-FIXES with
   unresolved blockers)`. TRUST THE AUDITOR'S VERDICT; the sub-flags are its inputs, not
   your veto.
7. Fail → **REVERT** agent (`revertPrompt`, L209–213, always `model:'opus'`): git checkout all
   task changes, keep only a DEFERRED_WORK.md durable-blocker record, verify clean tree + tsc.
8. Pass → **LAND** agent (`landPrompt`, L214–220): `gh auth switch --user kurtyoung-dev`
   (403 on push = wrong active gh account → re-switch + retry, never ask); stage EXACTLY the
   task files (source + .wgsl + acceptance probe + doc reconcile; NEVER generated shader .js,
   scratch/debug files, or `Tools/visual-regression/output`); **batch number N = (highest
   `Batch NNN` in `git log --oneline -10`) + 1**; commit message
   `Batch N: <TASK-ID> — <what/why>` with probe evidence + off-gate, ending
   `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; NEVER `--no-verify`;
   `git push origin main`; confirm clean status. Returns `LAND_SCHEMA` (L176–182).

**Hardening #5 — `safeAgent` (L262–269):** every awaited `agent()` is wrapped in
`.catch(→ log → null)`. Origin: a subagent that completes WITHOUT calling StructuredOutput
makes `agent()` THROW, which killed an entire prior run (C7 resume-2 crash). Null results
degrade into the existing handling (audit retry / FAILED status / revert). If you ever edit
the engine, never remove this wrapper and never add a new bare `await agent(...)`.

**Ledger contract:** every task brief mandates updating its row(s) in
`migration_doc/QUEUE_2026-07-15_CAMPAIGN9.md` §3.2 (add the row if missing), INCLUDED in the
landed files. Statuses: IN PROGRESS / COMPLETE / PARTIAL-PAUSED / BLOCKED / DEFERRED /
CONDITIONAL NOT TRIGGERED. Unlisted = NOT STARTED. This ledger is what makes the run
resumable and auditable — treat a missing ledger update as a landing defect.

**State at guide-writing time (re-verify with `git log` + the ledger):** landed = Batch 670
(C9-06-CELESTIAL-CLOSE), 671 (C9-CONTAINS-PARITY), 672 (C9-HDR-PICK-FORMAT-CLOSURE).
C9-DEPTHPLANE-LOGDEPTH-CONTRACT ended honest-partial: its ledger row says the SCENE half is
in-tree and verified but the pick half is re-blocked behind fleet-scale
`NEW-WEBGPU-PICK-FLEET-LOG-DEPTH`; the working tree was dirty with `WebGPUDepthPlane.ts`,
`WebGPUSceneRendererPickPass.ts`, the horizon-oracle probe, plus broad-suite files
(`destroyObject.js` + new `destroyObjectSpec.js`, `PolylineGeometryUpdater.js`,
`VoxelBoundsCollection.js`) — i.e. a task (likely C9-BROAD-SUITE-TRIAGE) was IN FLIGHT.
Expect the picture to have moved.

### The EXACT Fable-exhaustion resume procedure

Trigger: the Workflow run dies with Fable "out of usage credits" / session-limit errors (the
C7 precedent: impl agents start returning nulls or the run stops scheduling). The session gets
switched to Opus; you (Opus) then do this, in order:

**Step 1 — Audit git state and salvage orphan WIP (the salvage playbook).**
- `git log --oneline -15` → note the highest landed batch and which task IDs landed.
- `git status --porcelain` → if dirty, a task died mid-flight. Attribute every dirty file to a
  task using the ledger §3.2 + DEFERRED_WORK.md + the file's content.
- Salvage: copy the orphan WIP (files + a `git diff > salvage.diff`) to the scratchpad under
  `salvage-<taskid>-wip/` (precedent: `salvage-lake-wip/` 2026-07-10). Then CLEAN the tree:
  `git checkout -- <files>` and delete stray untracked task files (keep genuinely-new spec/
  probe files in the salvage copy). Verify `git status` clean + `npx tsc --noEmit` passes.
- Add a one-line salvage pointer to THAT task's `brief` string in the script ("prior attempt
  WIP salvaged to <scratchpad path> — reuse after verifying"). Brief edits only invalidate
  that one task's cache, which is exactly what you want: it re-runs.
- Branch transparency (CLAUDE.md): run `git branch -a`; report anything besides main
  (`sol-backup-2026-07-16` may still exist pending user deletion approval — do not delete it
  yourself).

**Step 2 — Edit the script: flip ONLY unfinished tasks to Opus.**
- Determine the completed set = tasks whose batches are in `git log` (status LANDED). Tasks
  that ended BLOCKED/REVERTED/FAILED are NOT completed (they'll re-run or stay failed —
  re-running a blocked task is acceptable and often desired).
- For every task in `TASKS` whose id is NOT in the completed set and which lacks a `model`
  field, add `model: 'opus',` (matching the existing style, e.g. L23). Do the same for any
  `auditModel: 'fable'` on unfinished tasks (none exist in this script today — all audits
  inherit `t.auditModel || t.model`, L309).
- **Completed task entries must stay BYTE-IDENTICAL** — the harness replays cached agent
  calls only when prompt AND opts are identical. Touching a completed task's brief, model,
  effort, or even whitespace forces a LIVE re-run of already-landed work: it would try to
  re-implement C9-06 etc. on a tree where it's already landed. (C7 precedent: three cached
  'fable' lines were deliberately left alone "so their cache replays without a Fable call".)
- **NEVER edit `CHARTER`, the prompt-builder functions, or the schemas** — CHARTER text is
  embedded in every prompt, so any edit invalidates EVERY cache including completed tasks.
  This is why the stale 24-bit-mask sentence in CHARTER stays: harmless (it prescribes extra
  caution that is merely unnecessary post-Batch-658), whereas fixing it nukes the cache.

**Step 3 — Validate the edited script before resuming.**
- `node --check .claude/workflows/campaign-9-resume.js`
- Forbidden-pattern scan (the feedback_review_scripts_for_loops rule): grep the script for
  `while (true)`, `Date.now(`, `Math.random(` (nondeterminism in scheduling), unbounded
  recursion, and any new bare `await agent(` not going through `safeAgent`. The shipped
  script is clean on all of these — your diff must keep it so.
- Diff review: `git diff` doesn't cover it (untracked) — keep a copy of the pre-edit script
  in the scratchpad and diff against it; confirm the ONLY changes are `model: 'opus'`
  insertions on unfinished tasks + at most one salvage-pointer sentence in one brief.

**Step 4 — Resume the run.**
- Launch via the Workflow harness with **`resumeFromRunId: 'wf_f6cb6b3b-927'`** pointing at
  `.claude/workflows/campaign-9-resume.js`. (Precedent: C7 was resumed 3× with the same
  resumeFromRunId, `wf_0279af79-f1d`; each resume replayed cached completed agents and
  continued live from the first uncached call.)
- Preconditions before launch: dev server :8080 up (`node server.js` if not), tree clean,
  `npx tsc --noEmit` green, Docker/other heavy processes not competing (probes launch Edge).
- Watch the first minutes of the log: completed tasks should replay instantly from cache
  (log lines appear without multi-minute agent latency). If a completed task starts a LIVE
  impl agent, STOP THE RUN immediately — you broke cache identity in Step 2; restore the
  byte-identical entry and re-resume.

**Step 5 — Ledger discipline during/after the resume.**
- The engine's agents update §3.2 themselves when landing; YOUR obligations are the
  boundaries: record the resume event (date, run id, which tasks flipped to opus) in the
  ledger's Campaign-9 row or the memory file, and on completion re-verify every task in
  `results[]` has a truthful §3.2 row (statuses BLOCKED/REVERTED especially — an engine
  revert without a ledger row is invisible debt).
- On run completion: present results to the maintainer, reconcile docs, list branches, and
  surface any `LAND-INCOMPLETE` statuses (work committed-but-unpushed or unstaged) for
  manual review FIRST — check `git status` and `git log origin/main..main`.

### Known engine lessons (apply them, don't rediscover them)

1. **lint-staged OOM / merge interplay:** big commits OOM-kill the pre-commit hook —
   serialize with `--concurrent 1` (NOT `--concurrency`) in the hook locally, revert after.
   During a MERGE specifically use `--concurrent 1 --no-stash` (its stash mechanism fails
   with MERGE_HEAD). Never `--no-verify`.
2. **Workspace spec-bundle freshness (ledger row `NEW-WORKSPACE-SPEC-BUNDLE-FRESHNESS`, queue
   item 4A):** ~~`gulp test --workspace engine` serves `packages/engine/Build/Specs` but does
   NOT rebuild it — ALWAYS run `npm run build --workspace @cesium/engine` first, or a new/
   changed spec silently doesn't execute.~~ **UPDATE 2026-08-07 — CLOSED as `C11-132`.** The
   workspace lane now builds the workspace, and `gulp test` verifies the served bundle's
   spec-source digest before starting Karma: it rebuilds only the spec bundle on drift, or
   fails naming the added / removed / content-changed specs. The manual pre-build is no
   longer required and should not be copied into new briefs. Focused runs:
   `gulp test --workspace engine --browsers=EdgeHeadlessCI --includeName "<pattern>"`.
3. **Karma shutdown-disconnect artifact:** a trailing "Chrome failed"/disconnect line AFTER
   `TOTAL: ... SUCCESS` (exit 0) is a known wrapper artifact, not a test failure (recorded in
   ledger row 68/item 139 and the C9-CONTAINS-PARITY probe note). Judge by the
   SUCCESS/FAILED totals and exit code.
4. **Audit agents must not git-restore your work:** parallel general-purpose audit/verify
   subagents have full Bash and have previously `git restore`d uncommitted files. The engine's
   own auditors are prompt-constrained, but if YOU spawn extra audit help: snapshot/commit
   first, prefer read-only Explore agents, and remember lost source can be recovered from
   `Build/CesiumUnminified` (it's the built copy of the tree).
5. **Dead-audit ≠ failed audit (B18):** already encoded in the engine (one retry); if you
   operate manually, never revert probe-verified work because an audit process died.
6. **Trust-the-verdict (B3/B12):** do not veto a GO using the boolean sub-flags; only
   `noRegression === false` and unresolved GO-WITH-FIXES blockers are hard stops.
7. **Edge only for probes** — Playwright Firefox has no WebGPU. `PROBE_BASE=http://localhost:8080`.
8. **Python/scratch generators:** never `\'` inside single-quoted strings in generated
   Python (C7 lesson); `node --check` every generated artifact before running it.

### Pointers

- Engine: `f:\Dev\GH\cesium-webgpu\.claude\workflows\campaign-9-resume.js` (untracked; run id
  `wf_f6cb6b3b-927`, task `wbe4oirq8`). Memory: `C:\Users\Kurt\.claude\projects\
  f--Dev-GH-cesium-webgpu\memory\project_campaign9_running.md` (resume state),
  `project_campaign7_armed.md` (salvage playbook + resume precedents, hardening history).
- Queue/ledger: `migration_doc/QUEUE_2026-07-15_CAMPAIGN9.md` — §1 rules (L22–35), §3 gates
  (Gate C = default hot path, L52), §3.2 live ledger (L94–139+), Wave-2 table item 35 = C9-30
  (L210), §12 landing/performance requirements (L334–348).
- Source plan: `migration_doc/FORK_PERFORMANCE_RTE_VISIBILITY_REMEDIATION_PLAN_2026-07-15.md`
  (performance-evidence rules around L250; architecture-to-converge-on §4).
- Audit: `migration_doc/SOL_AUDIT_REPORT_2026-07-16.md` (P0 fixes §3, P1 list §4, queue
  amendments §6, landing partition §7). Sol landed as Batches 656–669; resume tasks land 670+.
- Runner: `Tools/visual-regression/run-performance-campaign.mjs`; utils
  `Tools/visual-regression/lib/performance-campaign-utils.mjs`; route
  `Tools/visual-regression/lib/globe-camera-track.mjs`; URL builder
  `Tools/visual-regression/lib/performance-viewer-url.mjs`; manifest
  `Tools/visual-regression/performance-workloads.json`; offline boot
  `Apps/CesiumViewer/CesiumViewerStartupOptions.js` (L18).
- Gate-A artifacts (on-disk only, gitignored):
  `Tools/visual-regression/output/performance/campaign9-gate-a-{smoke,clean-r5,api-r5}-2026-07-15.json`
  (clean medians WebGL 5.50 / WebGPU 7.51 ms CPU p95; bundle `B8015811…C11E`, Edge 150.0.4078.65).
- Debug/procedures: `migration_doc/DEBUGGING_GUIDE.md` (probe inventory, moving-altitude
  campaign canon); `migration_doc/DEFERRED_WORK.md` (per-ID design notes).

---

<a id="g1"></a>

## G1 — Depth-Plane Pick-Gate Remainder

### NEW-WEBGPU-DEPTH-PLANE-LOG-DEPTH-CONTRACT (remainder) + NEW-WEBGPU-PICK-FLEET-LOG-DEPTH + the floating uncommitted scene-half partial

**Task IDs (Campaign 9 ledger, `migration_doc/QUEUE_2026-07-15_CAMPAIGN9.md` §3.2):**

- `NEW-WEBGPU-DEPTH-PLANE-LOG-DEPTH-CONTRACT` — row at queue line ~129, status **PARTIAL / PAUSED** (scene half done, pick half re-blocked).
- `NEW-WEBGPU-PICK-FLEET-LOG-DEPTH` — row at queue line ~130, status **NOT STARTED**. This is the actual work.
- `C9-02B-DEPTH-PLANE-MULTIFRUSTUM-UNIFORM-RING` — row at queue line ~116, acceptance paused behind the two rows above. Closing the pick half closes C9-02B and Sol-audit **P0-1** (`migration_doc/SOL_AUDIT_REPORT_2026-07-16.md` line 65).

**One-sentence goal:** convert every WebGPU pick-pass depth producer to logarithmic `@builtin(frag_depth)` using the single full-frustum encode (`uniformState._logDepthEncodeNearFar`), then flip `PICK_DEPTH_PLANE_ENABLED` to `true` in `WebGPUSceneRendererPickPass.ts` and prove it with the three-altitude horizon oracle.

All line numbers below were verified against the live tree on 2026-07-16, post-Batch-672 (`ea6332d0aa`), WITH the uncommitted partial applied (see "The floating partial" — it shifts `WebGPUSceneRendererPickPass.ts` by +10 lines and `WebGPUDepthPlane.ts` by +19 lines relative to HEAD). If the partial has been committed by the time you read this, the working-tree numbers are the live numbers.

---

### Architecture today (post-Sol, verified 2026-07-16)

#### The scene depth contract (works)

The WebGPU **scene** pass renders with logarithmic depth by default (`WebGPUContext.ts:458` — `public _logDepthWriteEnabled: boolean = true`; predicate `isWebGPULogDepthActive` in `packages/engine/Source/Renderer/WebGPU/WebGPULogDepth.ts:75-80` requires `context._logDepthWriteEnabled && frameState.useLogDepth`).

Every scene log-depth producer encodes against **one frame-constant frustum pair**: the full camera frustum stashed on `uniformState._logDepthEncodeNearFar`. Publication sites:

- `packages/engine/Source/Renderer/WebGPU/WebGPUSceneRendererFrustumState.ts:16-34` — `publishLogDepthEncodeNearFar(scene, uniformState)` reads `scene.camera.frustum.near/far` (the PERSISTENT camera, far ~1e7-1e10 — NOT the per-slice `frameState.camera` copy) into a lazily-allocated `Float32Array(2)`.
- Called by the scene frustum loop at `WebGPUSceneRendererFrustumLoop.ts:169` (before any slice remap) and by the pick mini-frame at `WebGPUSceneRendererPickPass.ts:341` (WT; HEAD 331).
- Also written at scene-update time by the globe camera-UB pack: `WebGPUGlobeSurfaceCameraUB.ts:998-1004`.

Consumers recompute the factor from the same pair (`1 / log2(far - near + 1)`) — the canonical JS pattern is `WebGPUPointPrimitiveRenderer.js:884-926` (packs `logDepth` vec4 into floats 44-47 of the collection camera UB), and the canonical WGSL pattern is `PointPrimitiveColor.wgsl:56-70` (`csm_vertexLogDepth` / `csm_updatePositionDepth` / `csm_writeLogDepth`) + VS at 276-284 + FS `FragOutput.@builtin(frag_depth)` at 292-348.

#### The pick contract (the defect)

The pick mini-frame (`renderForPick` in `packages/engine/Source/Renderer/WebGPU/WebGPUSceneRendererPickPass.ts`) mirrors WebGL: one render pass per far-to-near frustum slice, ID color cleared once then loaded, depth/stencil cleared per slice (comment at WT L350-355). But **every native pick producer writes plain hyperbolic rasterizer z**, baked at UPDATE time against the full camera projection:

- `GlobeTerrain.wgsl` (`packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl`) — `fragmentPickMain` at **L3061**, with the deliberate-design note at **L3044-3060** that explicitly says it writes STANDARD depth "so the pick FBO depth stays consistent with the model / primitive pick pipelines". That note documents the uniformly-hyperbolic contract you are about to replace.
- `ModelPBRComplete.wgsl` — `fragmentPickHoverMain` **L3730**, `fragmentPickMain` **L3793**, `fragmentPickMetadataMain` ~L3940-3960: all return bare `@location(0) vec4<f32>`, no `frag_depth`, while the color entry writes `csm_writeLogDepth(input.v_logDepth, camera.logDepthFactor)` at L2424 (and silhouette L2517, translucent L2554, wireframe-ish L3680, velocity L4063).
- `Collections/PointPrimitivePick.wgsl` (221 lines) — its `CameraUniforms` (L13-27) STOPS at `previousViewProjection`; it has **no `logDepth` lane, no LOG_DEPTH ifdef, no frag_depth**. Same for `BillboardCollectionPick.wgsl` and `PolylineCollectionPick.wgsl`.
- The six `Primitive/PrimitivePick*.wgsl` files, the ground/vector-tile/ellipsoid/splat/voxel/buffer renderers — audit each (Phase 1 below).

Because native pick UBs bake at update time, the per-slice `_updateFrustumUniforms` remap inside the pick loop reaches only draw-time `uniformState` consumers (the depth plane is the sole such consumer). This is FINE for a log conversion (the log encode is frame-constant), and it is exactly why a per-slice hyperbolic scheme can never be made consistent.

#### The depth plane itself (`packages/engine/Source/Renderer/WebGPU/WebGPUDepthPlane.ts`)

- Shader is generated by `makeDepthPlaneWGSL(logDepth)` at L58; the log variant writes `frag_depth = log2(max(v_logDepth,1e-9)) * logDepthParams.z` (L124-130) with the vertex clip-z clamp at L101-110.
- `initialize()` at L416 (params incl. `useLogDepth` L422, `pickColorFormat` L423) creates **one shader module shared by the scene pipeline AND the pick pipeline** — the pick descriptor (`C9-02A`, L524-539) differs only in attachments (single target `pickColorFormat`, `writeMask: 0`, single-sample, `depth24plus-stencil8`, `less-equal`). So when scene log depth is on, **the pick depth-plane pipeline is ALREADY the log variant.** Do not create a hyperbolic pick variant (instrumented run 1b proved it mismatches the update-time bake).
- `update(frameState, device)` at L734 packs mvpRTE + encoded camera + the log lane. **The floating partial (L784-826) makes the log lane prefer `_logDepthEncodeNearFar` with the factor recomputed from the same pair; `currentFrustum` only as pre-stash fallback.** This is the landed-scene-half fix.
- Wiring: `ensureDepthPlane` (`WebGPUSceneRendererEnsureResources.ts:105-160`) rebuilds the plane on any identity drift including `_logDepth !== desiredLogDepth`; `WebGPUSceneRenderer.ts:2419` `_beginDepthPlanePass` reserves the uniform ring; `WebGPUSceneRenderer.ts:2448` `_renderDepthPlane(config, passKind)` calls `update()` then `execute(renderPass, passKind)` (pipeline select by passKind at `WebGPUDepthPlane.ts:836`). Scene call: `WebGPUSceneRendererFrustumLoop.ts:327`. Pick call: `WebGPUSceneRendererPickPass.ts:496-498` (WT; HEAD 486-488), gated:

```ts
if (PICK_DEPTH_PLANE_ENABLED && config.useDepthPlane) {
  host._renderDepthPlane(config, "pick");
}
```

- The gate constant: `const PICK_DEPTH_PLANE_ENABLED = false;` at `WebGPUSceneRendererPickPass.ts:69` (WT; HEAD 59), with the 2026-07-16 contract-finding comment above it (part of the floating partial).

#### Why the gate is off — the proven blocker (do not re-litigate; two instrumented runs already proved this)

From `migration_doc/DEFERRED_WORK.md` L5229-5271 (**NOTE: this entry is part of the floating UNCOMMITTED diff** — if `grep -n "NEW-WEBGPU-PICK-FLEET-LOG-DEPTH" migration_doc/DEFERRED_WORK.md` finds nothing, restore it from Phase 0):

1. **Run 1 (log plane pick, hyperbolic fleet):** the plane's log frag_depth (~0.4-0.8) over-occluded EVERY hyperbolic pick (~0.999+) over the whole globe disk — even the visible FRONT control returned null at 20/500/5,000 km.
2. **Run 1b (hyperbolic per-slice plane pick):** mismatched the update-time bake the same way.
3. **Consistent hyperbolic everywhere cannot pass:** with near ≈ 1 m / far ≈ 5e8 m the plane-vs-marker separation at 5,000 km is Δz ≈ 1.7e-8 — below one f32 ulp at z≈1.0 (6e-8) — and `less-equal` ties pass, so the beyond-horizon marker stays pickable. **Hyperbolic pick depth is mathematically dead at planetary far-field. Only log works.** (WebGL parity: upstream's LOG_DEPTH wrapper covers every derived pick shader, so the WebGL pick FBO is already log.)
4. **Partial conversion breaks defaults:** a log producer (z~0.5 far-field) always beats a hyperbolic producer (z~0.999) in the shared pick depth buffer — converted points would pick THROUGH unconverted models; the log plane would over-occlude every unconverted cohort. The fleet must move together.

#### The floating uncommitted partial — exactly what it contains

`git status` (2026-07-16) shows these files modified for THIS concern (there are also unrelated concurrent-work files — see Traps #1):

| File | Content of the floating change |
| --- | --- |
| `packages/engine/Source/Renderer/WebGPU/WebGPUDepthPlane.ts` | **The scene-half fix** (the only runtime-behavior change): `update()` log-lane pack rewritten to prefer `_logDepthEncodeNearFar` (recomputing factor from that exact pair) with `currentFrustum` as pre-stash fallback, plus the long contract comment. Net: `-9/+28` lines around L781-826. |
| `packages/engine/Source/Renderer/WebGPU/WebGPUSceneRendererPickPass.ts` | Comment-only: +10 lines of "2026-07-16 contract finding" JSDoc above `PICK_DEPTH_PLANE_ENABLED` documenting the fleet blocker. No behavior change. |
| `Tools/visual-regression/probe-depth-plane-horizon-oracle.mjs` | +34 lines after the per-altitude in-page evaluate: captures `campaign9-c9-02b-horizon-{label}-plane-{on,off}.png` per altitude via `scene.debugSkipDepthPlane` A/B (CLAUDE.md Principle 8 read-the-PNG evidence). No assertion change. |
| `migration_doc/DEFERRED_WORK.md` | +46 lines: the whole `NEW-WEBGPU-PICK-FLEET-LOG-DEPTH` analysis entry (L5229-5271). |
| `migration_doc/WEBGPU_DEBUGGING_LOG.md` | +14 lines: the scene-half debugging-log entry (symptom/root-cause/fix/verification/pick-half-not-fixed) at end of file (~L13156+). |

The Campaign-9 queue ledger (`QUEUE_2026-07-15_CAMPAIGN9.md`) is **committed clean at HEAD** and already describes the scene half as LANDED — i.e., the ledger is ahead of git. The code partial was verified (`npx tsc` + `npx gulp build` clean; regression probes green; oracle scene assertions pass at 500 km/5,000 km) but never committed. **Landing it is your Phase 0.**

The exact scene-half hunk, in case it must be re-derived (this replaces the pre-existing block that read `const ldNear = usLog.currentFrustum?.x ?? 0.0; const ldFar = usLog.currentFrustum?.y ?? 0.0; let ldFactor = ...; if (!(ldFactor > 0.0) && ldFar > ldNear) { ... }`):

```ts
const usLog = uniformState as unknown as {
  currentFrustum?: { x: number; y: number };
  oneOverLog2FarDepthFromNearPlusOne?: number;
  _logDepthEncodeNearFar?: Float32Array | null;
};
const ldEncode = usLog._logDepthEncodeNearFar;
let ldNear = usLog.currentFrustum?.x ?? 0.0;
let ldFar = usLog.currentFrustum?.y ?? 0.0;
let ldFactor =
  typeof usLog.oneOverLog2FarDepthFromNearPlusOne === "number"
    ? usLog.oneOverLog2FarDepthFromNearPlusOne
    : 0.0;
if (ldEncode && ldEncode[1] > ldEncode[0]) {
  ldNear = ldEncode[0];
  ldFar = ldEncode[1];
  const log2Far = Math.log2(ldFar - ldNear + 1.0);
  ldFactor = log2Far > 0.0 ? 1.0 / log2Far : 0.0;
} else if (!(ldFactor > 0.0) && ldFar > ldNear) {
  const log2Far = Math.log2(ldFar - ldNear + 1.0);
  ldFactor = log2Far > 0.0 ? 1.0 / log2Far : 0.0;
}
uniformScratch[24] = ldNear;
uniformScratch[25] = ldFar;
uniformScratch[26] = ldFactor;
uniformScratch[27] = 0.0;
```

#### Current oracle baseline (honest failing state, artifact on disk)

`Tools/visual-regression/output/performance/campaign9-c9-02b-depth-plane-horizon-oracle-2026-07-16.json` — 14 failures, ALL expected while the gate is off:

- `{near,middle,far}/{normal,restored}: actual scene and pick depth-plane draws were not both observed` (6) — pick draw count is 0 because the gate is false.
- `{near,middle,far}/{normal,restored}: beyond-horizon marker was pickable` (6) — no pick plane, so the hidden marker still picks.
- `near/{normal,restored}: back marker leaked through (538 magenta pixels)` (2) — **NOT a defect**: the read PNGs (`campaign9-c9-02b-horizon-near-plane-{on,off}.png`) prove this is the screen-space sprite quad extending ABOVE the horizon line where neither plane nor globe covers pixels; WebGL geometry is identical. Scene occlusion passes at middle (70 px vs 1,416 plane-off) and far (0 px).

---

### Target design + invariants

1. **One encode, fleet-wide.** Every pick-pass fragment that contributes depth writes logarithmic `@builtin(frag_depth)` computed as `log2(depthFromNearPlusOne) * oneOverLog2FarDepthFromNearPlusOne`, where near/far come from `uniformState._logDepthEncodeNearFar` (full persistent-camera frustum) and the factor is recomputed from that exact pair. Never mix stash near/far with the per-slice `uniformState.oneOverLog2FarDepthFromNearPlusOne` factor.
2. **Same curve as scene.** The pick encode must be byte-identical in formula to the scene encode (the `csm_vertexLogDepth`/`csm_writeLogDepth` contract). The depth plane's shared shader module guarantees the plane side; the fleet conversion guarantees the producer side.
3. **Vertex clip-z clamp.** Every converted vertex stage applies `csm_updatePositionDepth` (`coords.z = clamp(coords.z/coords.w, 0.0, 1.0) * coords.w`) so far geometry is not hardware-clipped before the FS writes depth. Guard `w <= 0` the way `PointPrimitiveColor.wgsl:276-284` does (`v_logDepth = 1.0` when `w <= 0.0`).
4. **Update-time bake is correct.** Because the encode is frame-constant, pick UBs packed at update time carry the right scalars. Do NOT add per-slice repacking to pick producers and do NOT change the per-slice pass/clear structure of `renderForPick` (WT L350-575) — it mirrors WebGL and stays.
5. **Gated by the same activity predicate as scene.** Log pick depth is active iff `isWebGPULogDepthActive(context, frameState)` — exactly when scene log depth is active. When log depth is OFF (kill switch or orthographic 2D), pick producers keep plain rasterizer z and the plane keeps its non-ld variant; behavior must be byte-identical to today in that mode (the LOG_DEPTH `//>>else` branch is the historical path).
6. **Pipeline identity carries the flag.** Wherever a pick pipeline/shader-module cache key exists, the LOG_DEPTH define bit must key it (collections already do: pick defines mirror color defines — `WebGPUPointPrimitiveRenderer.js:1342` `pickDefines = cache.currentDefines`). Runtime flips of the kill switch must rebuild through the normal keyed-miss path, not mutate live pipelines.
7. **All-or-nothing landing.** The fleet conversion + WGSL changes land as ONE coherent batch (or a tightly-sequenced pair with the gate flip LAST); no intermediate commit may leave some default-path pick producers log and others hyperbolic (Invariant follows from blocker proof #4). The gate flip itself is a separate final one-line change verified by the oracle.
8. **No feature weakening.** Campaign rule 1/6: never default-disable log depth, the depth plane, `useDepthPlane`, or picking to make a gate pass. Rollback = flip the gate constant back to `false`, never revert the scene-half encode fix.
9. **Docs stay in lockstep.** The `GlobeTerrain.wgsl:3044-3060` design note (which documents the OLD "standard depth for consistency" contract) MUST be rewritten when the fleet converts; `DEFERRED_WORK.md`, the queue ledger, and `WEBGPU_DEBUGGING_LOG.md` are updated in the landing batch.
10. **WebGL untouched.** This is a WebGPU-only pick-FBO change; zero GLSL/WebGL modifications. WebGL is the parity oracle, not a patient.

---

### Implementation walkthrough

#### Phase 0 — reconcile tree state, land the floating scene-half partial

1. `git log --oneline -15` and `git status --short`. Determine which of the five files above still float.
   - **If the partial is already committed** (search: `git log -S "_logDepthEncodeNearFar" --oneline -- packages/engine/Source/Renderer/WebGPU/WebGPUDepthPlane.ts` returns a post-`ea6332d0aa` commit): skip to Phase 1.
   - **If the files float exactly as described**: proceed to land them.
   - **If `WebGPUDepthPlane.ts` no longer contains the `_logDepthEncodeNearFar` block** (someone reverted/clobbered it — see memory note `feedback_audit_subagent_git_revert.md`): re-apply the hunk from "The floating partial" above and re-derive the DEFERRED_WORK/debug-log entries from this guide.
2. **Do NOT commit unrelated floating files.** As of writing, `packages/engine/Source/Core/destroyObject.js`, `packages/engine/Specs/Core/destroyObjectSpec.js`, `packages/engine/Source/DataSources/PolylineGeometryUpdater.js`, `packages/engine/Source/Scene/VoxelBoundsCollection.js`, and `Apps/CesiumViewer/CesiumViewer.js` + assorted probe/doc files also float — they belong to other concurrent Campaign-9 work. Stage ONLY the five files of this concern, by explicit path.
3. Re-verify before committing: `npx tsc --noEmit` and `npx gulp build` must be clean; then run the three regression probes (recipe below) and the horizon oracle; confirm the oracle failure list matches the 14-failure baseline above (scene assertions green at middle/far; only gate-off pick failures + the 538-px near sprite artifact).
4. Commit as its own batch (message pattern: `Batch NNN: C9 NEW-WEBGPU-DEPTH-PLANE-LOG-DEPTH-CONTRACT scene half — depth plane encodes against the full-frustum _logDepthEncodeNearFar stash`). Follow branch-transparency rules (trunk-only; announce state). If push is denied, retry to surface the approval prompt (memory: `feedback_push_to_main_in_auto_mode.md`); push as kurtyoung-dev.

#### Phase 1 — audit the fleet (read-only, ~half a day)

Build a cohort table BEFORE editing anything. The pick-producer fleet is exactly the set Batch 672 just migrated to `context.pickPipelineFormat` (grep `pickPipelineFormat|buildPickPipelineDescriptor` under `packages/engine/Source/Renderer/WebGPU/`):

| Cohort | Renderer (JS/TS) | Pick shader / entry | Camera-UB log lane today? |
| --- | --- | --- | --- |
| PointPrimitive | `WebGPUPointPrimitiveRenderer.js` (pick pipeline L1329-1398; pick bind group SHARES the color 256-byte UB at L1379-1386) | `Collections/PointPrimitivePick.wgsl` | **Packed but not declared** — floats 44-47 already carry logDepth (pack at L884-926); the pick struct just doesn't declare/read them |
| Billboard (+Label glyph route) | `WebGPUBillboardRenderer.js` | `Collections/BillboardCollectionPick.wgsl` | Same shared-UB pattern — verify |
| Polyline | `WebGPUPolylineRenderer.js` | `Collections/PolylineCollectionPick.wgsl` | Verify |
| Globe | `WebGPUGlobeSurfaceRenderer.ts` / `WebGPUGlobeSurfacePipelines.ts` (PipelineHost `_pickFormat`) | `Globe/GlobeTerrain.wgsl` `fragmentPickMain` L3061 | YES — `camera.logDepth` L156; varying `@location(12) v_logDepth` L679 reaches the pick FS via `input` |
| Model (5 pick variants: default/hover/precisePass1/precisePass2/metadata — `WebGPUModelPipelineCache.ts` `_pickFormat`) | `WebGPUModelPipelineCache.ts` + `WebGPUModelFeatureId.js` | `Model/ModelPBRComplete.wgsl` `fragmentPickMain` L3793, `fragmentPickHoverMain` L3730, `fragmentPickMetadataMain` ~L3945 | YES — `camera.logDepthFactor` + `input.v_logDepth` already exist (color writes at L2424) |
| Generic Primitive | `WebGPUPrimitiveCommands.ts` (both pick pipelines) | `Primitive/PrimitivePick{Basic,BasicTextured,MatFlat,MatLit,Phong,PhongTextured}.wgsl` | Audit each |
| GroundPrimitive | `WebGPUGroundPrimitiveRenderer.js` (`dsPickFS` ×2: depthSamplePick + morphPick) | inline/module WGSL | Audit |
| GroundPolyline | `WebGPUGroundPolylineRenderer.js` (`pickFS`, `pickFSMorph`) | module WGSL | Audit |
| Vector3DTile ×3 | `WebGPUVector3DTile{Primitive,Polylines,ClampedPolylines}Renderer.js` | `pickFS` entries | Audit — these renderers already reference `_logDepthEncodeNearFar` (grep hit), so the lane may exist |
| Ellipsoid | `WebGPUEllipsoidPrimitiveRenderer.ts` | pick entry in its WGSL | Audit (`probe-ellipsoidprim-logdepth.mjs` covers the color side) |
| GaussianSplat | `WebGPUGaussianSplatRenderer.ts` | pick entry | Audit — splats may already write custom frag_depth |
| Voxel (object + cell pick) | `WebGPUVoxelRenderer.ts` | `fragmentPickVoxelMain` | **Ray-marchers often already write frag_depth** — if so, this is an encode CHANGE, not an addition |
| Point cloud / classification / BufferPoint/Polyline/Polygon | `WebGPUBufferPointRenderer.ts` etc. (all consult `isWebGPULogDepthActive` already) | material WGSL pick variants | Audit; note buffer pick draws currently never land at all (`NEW-WEBGPU-BUFFER-PRIMITIVE-PICK-DISPATCH-PARITY`) — convert the shader anyway, but you cannot VERIFY buffer pick depth until that item lands; record that boundary honestly |
| ComputeInstance | `Compute/ComputeInstanceRender.wgsl` (`fragmentPickMain`) | offscreen instanced pick | Audit; note `probe-compute-instance-pick.mjs` is ALREADY failing pre-existing (`NEW-WEBGPU-COMPUTE-INSTANCE-PICK-INDEX-MIRROR`) — do not chase its swap failure as your regression |

For each cohort record: (a) current pick depth behavior (raster z? custom frag_depth?), (b) whether the pick bind group binds a UB that already carries the encode scalars, (c) whether the pick pipeline/module key carries LOG_DEPTH, (d) whether the pick vertex stage is the shared color VS (then clip-z clamp already applies) or a dedicated pick VS.

**Decision point:** if you find a cohort whose pick draw shares the COLOR pipeline entirely (no separate pick fragment), it already writes log depth — mark "no change", verify only. If you find a producer whose pick UB CANNOT reach the encode scalars without a layout change that would also change the color path, STOP and record it in DEFERRED_WORK before proceeding — do not improvise a second encode source.

#### Phase 2 — convert (the template, by example)

**PointPrimitive (canonical collection template — Billboard/Polyline are the same moves):**

1. In `Collections/PointPrimitivePick.wgsl`:
   - Append to `CameraUniforms` (after `previousViewProjection`): `logDepth: vec4<f32>,` — this matches floats 44-47 that `packUniforms` ALREADY writes into the shared buffer (`WebGPUPointPrimitiveRenderer.js:921-926`); the pick bind group binds that same buffer (L1383). No JS pack change needed.
   - Copy the `//>>ifdef LOG_DEPTH` blocks from `PointPrimitiveColor.wgsl` verbatim: the three `csm_*` helper functions (color L56-70), the `@location(...) v_logDepth: f32` varying (next free location in the pick `VertexOutput`), the VS tail (`w <= 0` guard + `csm_vertexLogDepth` + `csm_updatePositionDepth`, color L276-284), and a `FragOutput` struct with `@builtin(frag_depth) depth: f32` written via `csm_writeLogDepth(input.v_logDepth, camera.logDepth.z)` (color L292-348). Keep the `//>>else` branch as today's code so `defines=0` is byte-identical.
2. No renderer change: `pickDefines = cache.currentDefines` (L1342) already includes `ShaderDefine.LOG_DEPTH` when active (`computePointDefinesForFrame` L695-703), and the pick module goes through `moduleCache.getOrCreate(ShaderSourceId.POINT_PRIMITIVE_PICK, source, pickDefines, ...)` (L1355-1360) which runs the preprocessor. The new ifdef blocks resolve automatically.

**Model:** change the three pick entries' return type from bare `@location(0) vec4<f32>` to a small struct `{ @location(0) color: vec4<f32>, @builtin(frag_depth) depth: f32 }` writing `csm_writeLogDepth(input.v_logDepth, camera.logDepthFactor)` — under the model's existing log-depth conditional convention (check how fragmentMain guards it; mirror exactly). The vertex side already clamps (shared VS). Verify all five `WebGPUModelPipelineCache` pick variants pick up the same module.

**Globe:** `fragmentPickMain` (L3061) gets the same struct-return treatment using `input.v_logDepth` (varying L679) and `camera.logDepth.z`. **Rewrite the L3044-3060 design note** to describe the new contract (log pick depth, fleet-wide encode, reference `NEW-WEBGPU-PICK-FLEET-LOG-DEPTH`).

**Primitives / ground / vector-tile / etc.:** per your Phase-1 table. Where a `pickFS` is derived from the color pipeline via `buildPickPipelineDescriptor` (`WebGPUPickCommandHelpers.ts:331-421` — it swaps the fragment entry point and stamps the single pick target), the pick entry lives in the SAME module as the color entry, so the camera UB and varyings are already bound — only the entry function changes.

**Depth plane:** NO shader change (Invariant 2 / Trap 4).

**If a cohort already writes custom frag_depth (voxel ray-march, possibly splat):** replace its encode with the `_logDepthEncodeNearFar` curve ONLY in the pick entry; leave the scene entry alone unless it already uses the same helper (it should — scene is already contract-conformant).

Build gates after conversion: `npx tsc --noEmit`, `npx gulp build`, then the FULL pick regression sweep (recipe below) — all must be green BEFORE the gate flip, because the fleet conversion alone must not change any pick RESULT (depth ordering among producers is preserved when everyone moves to the same monotonic curve; only plane-vs-fleet comparability is new).

#### Phase 3 — flip the gate

1. `WebGPUSceneRendererPickPass.ts:69` (WT): `const PICK_DEPTH_PLANE_ENABLED = true;`
2. Rewrite the JSDoc above it: the blocker is resolved; keep a one-paragraph history pointing at `NEW-WEBGPU-PICK-FLEET-LOG-DEPTH` and the oracle artifact.
3. Rebuild, rerun the horizon oracle. Expected: all pick assertions green at 20/500/5,000 km (front control picks `depth-plane-front` in every phase; back marker NOT pickable in normal/restored; pickable in diagnostic-skip; `depthPlaneDraws.scene ≥ 1 AND .pick ≥ 1` in normal/restored, both 0 in skip).

#### Phase 4 — the 20 km scene residual (decision point)

If, after the flip, the ONLY remaining oracle failure is `near/*: back marker leaked through (~538 magenta pixels)`:

1. Read `campaign9-c9-02b-horizon-near-plane-{on,off}.png` YOURSELF (Principle 8). Confirm the magenta pixels sit ABOVE the horizon line (sprite quad extending past the limb where neither plane nor globe renders).
2. If confirmed: revise `validateAltitude` (probe L139-155) to count only below-limb magenta pixels (the probe knows the horizon geometry — it computes `horizonAngle` at L335). Before landing the revision, capture the SAME scene on WebGL (`renderer=webgl`) and verify the sprite extends above the limb identically — the oracle change must be justified by WebGL parity, not convenience.
3. If NOT confirmed (magenta below the limb): the plane geometry or encode is actually wrong at low altitude — STOP, do not touch the oracle, debug the plane (compare `computeDepthQuadCorners` output vs WebGL `DepthPlane.js`).

#### Phase 5 — docs + ledger closure (same batch as the flip or immediately after)

- `QUEUE_2026-07-15_CAMPAIGN9.md` §3.2: `NEW-WEBGPU-PICK-FLEET-LOG-DEPTH` → COMPLETE (evidence inline), `NEW-WEBGPU-DEPTH-PLANE-LOG-DEPTH-CONTRACT` → COMPLETE, `C9-02B-DEPTH-PLANE-MULTIFRUSTUM-UNIFORM-RING` → COMPLETE (acceptance = passing oracle artifact), note audit P0-1 closed.
- `DEFERRED_WORK.md`: close/annotate the `NEW-WEBGPU-PICK-FLEET-LOG-DEPTH` entry (do not delete the analysis — append the resolution).
- `WEBGPU_DEBUGGING_LOG.md`: one entry for the fleet conversion + flip (Session.Bug format, files, root cause, fix, verification).
- `FEATURE_INVENTORY.md` §C: if pick-over-depth-plane is tracked as WIP, move/retag it.

---

### Traps for the unwary

1. **The working tree is SHARED with a running campaign.** Never `git add -A`, never `git stash` (memory: `feedback_git_stash.md`), never revert files you didn't author. Stage by explicit path. Before any broad probe/audit run, verify your uncommitted work is committed first (memory: `feedback_audit_subagent_git_revert.md`).
2. **The ledger already says "scene half LANDED" but the code floats.** Don't be confused into thinking the encode fix is committed — check the file content, not the ledger. Conversely, don't re-implement it if it IS committed.
3. **Never mix encode sources.** Stash near/far + recomputed factor, together, always. Using the stash near/far with the live `uniformState.oneOverLog2FarDepthFromNearPlusOne` factor produces a subtly wrong curve that passes at some altitudes and fails at others — this exact mismatch was the Sol scene defect.
4. **Do not build a hyperbolic pick variant of the depth plane** and do not "fix" the over-occlusion by giving the plane a different encode than the fleet. Both dead ends are already instrumented-proven (runs 1 and 1b). The plane's pick pipeline must keep sharing the scene shader module.
5. **Do not convert a subset and land it.** A lone log producer picks through every hyperbolic producer at defaults. The intermediate states live only in your working tree.
6. **`less-equal` ties are not a rejection mechanism.** At 5,000 km the hyperbolic Δz is sub-ulp and ties PASS. If you catch yourself reasoning "the plane is slightly nearer so it wins" — in f32 it isn't.
7. **The clip-z clamp is not optional.** Without `csm_updatePositionDepth` the far marker's quad is clipped by the hardware near/far clip before your frag_depth ever runs, and the symptom (marker vanishes) looks deceptively like success.
8. **ShaderDefine registry is add-only.** `LOG_DEPTH` already exists — use it. Do NOT add a new define bit for "pick log depth"; pick and color activity must stay in lockstep by design. Never renumber (`WebGPUShaderDefines.ts` rules in CLAUDE.md).
9. **Uniform struct extension must match byte offsets.** The collection pick structs are a PREFIX view of the shared 256-byte buffer. `logDepth` goes at floats 44-47 — i.e., immediately after `previousViewProjection` — matching the color struct. Adding it anywhere else silently reads garbage (WGSL has no layout assert).
10. **`debugSkipDepthPlane` has a known WebGPU parity gap** (`NEW-WEBGPU-DEBUG-DEPTH-PLANE-GATE-PARITY`, queue item 79): `WebGPUContext.ts:3615-3618` recomputes `environmentState.useDepthPlane` WITHOUT the `debugSkipDepthPlane !== true` term that `Scene.js:3744-3751` applies. The oracle's skip phase currently works (skip-phase draws = 0 in the recorded artifact), but if you ever see nonzero `depthPlaneDraws` in the diagnostic-skip phase, THIS is why — fix item 79 as its own slice first, don't fold it in silently.
11. **Known-failing gates that are NOT yours:** `probe-compute-instance-pick.mjs` (index mirror swap, pre-existing, has its own row), buffer-primitive pickAsync returning undefined (`NEW-WEBGPU-BUFFER-PRIMITIVE-PICK-DISPATCH-PARITY`), MSAA-flip transition race (`NEW-WEBGPU-SCENE-PASS-MSAA-FLIP-TRANSITION`), cold async-pipeline false miss (`NEW-WEBGPU-ASYNC-PICK-PIPELINE-READINESS-CONTRACT`). Reproduce-before / reproduce-after; do not claim or chase them.
12. **HDR interplay:** Batch 672 made `context.pickPipelineFormat` the single pick attachment authority and pick derivation THROWS without `options.pickFormat`. Your WGSL edits touch the same modules — after conversion, re-run `probe-hdr-pick-format-closure.mjs` to prove you didn't disturb the format closure.
13. **The oracle asserts `logDepth.depthPlaneVariant`** (probe L86-88) — the plane must be the `[ld]` module. If `ensureDepthPlane` identity churn ever recreates it non-ld while log is active, that assertion catches it; don't weaken it.
14. **Playwright = Edge only** (`channel: "msedge"`); Firefox has no WebGPU. Probes are the acceptance mechanism — never ask the user to eyeball (Principle 8). Scan any new/modified probe for unbounded loops before running (memory: `feedback_review_scripts_for_loops.md`); the oracle's internal loops are bounded (180/120 frame caps).
15. **Karma may not launch in a sandboxed session** (seen in C9-06: "browser launch blocked"). If `gulp test` can't run, say so and lean on the probe suite + `npx tsc` + build; don't skip silently.
16. **Comment/doc drift is itself a bug** per CLAUDE.md: the `GlobeTerrain.wgsl` pick note, the gate JSDoc, `IMAGERY_PROJECTION.md`-style lockstep applies here to `DEBUGGING_GUIDE.md` only if you add a new probe/command (you likely won't — the oracle exists).

---

### Verification recipe

Prereqs: `npx gulp build` (dev server via `npm run restart` if a live viewer is needed; probes boot their own pages). All probes run from repo root with Node; they use Edge.

**Phase-0 baseline + Phase-2 fleet regression sweep (gate still false):**

```
npx tsc --noEmit                                                # must be clean
npx gulp build                                                  # must be clean
node Tools/visual-regression/probe-point-pick-webgpu.mjs        # PASS
node Tools/visual-regression/probe-collections-far-camera.mjs   # PASS (includes below-ground occlusion negative control)
node Tools/visual-regression/probe-logdepth-globe.mjs           # clean
node Tools/visual-regression/probe-depth-plane-horizon-oracle.mjs
#   -> expect EXACTLY the 14 baseline failures listed above (gate-off pick failures + 538px near sprite)
```

After the fleet conversion (still gate-off), additionally:

```
node Tools/visual-regression/probe-pick-basic.mjs
node Tools/visual-regression/probe-billboard-pick.mjs
node Tools/visual-regression/probe-polyline-appearance-pick.mjs
node Tools/visual-regression/probe-globe-pick-h44.mjs
node Tools/visual-regression/probe-standalone-model-pick.mjs
node Tools/visual-regression/probe-pickmodel-instanced.mjs
node Tools/visual-regression/probe-voxel-pick.mjs
node Tools/visual-regression/probe-voxel-cell-pick.mjs
node Tools/visual-regression/probe-pick-multifrustum.mjs
node Tools/visual-regression/probe-pick-metadata.mjs
node Tools/visual-regression/probe-depth-plane-pick-matrix.mjs      # C9-02A matrix — SDR/HDR/MSAA/resize/invalidate
node Tools/visual-regression/probe-hdr-pick-format-closure.mjs      # Batch-672 gate — 8 families green all phases
node Tools/visual-regression/probe-pickposition-webgpu.mjs          # pickPosition reads scene depth, must be untouched
```

Every one of these must match its pre-change result (green, or the documented pre-existing failure — record both runs).

**Phase-3 acceptance (gate true):** `node Tools/visual-regression/probe-depth-plane-horizon-oracle.mjs`

PASS means the process exits with an empty `failures` array in `Tools/visual-regression/output/performance/campaign9-c9-02b-depth-plane-horizon-oracle-2026-07-16.json` (the probe writes `pass`/`failures` into the report; it also asserts renderer=webgpu, deterministic ellipsoid terrain, 3 altitude results). Semantically, per `validateAltitude` (probe L63-161), at EACH of 20 km / 500 km / 5,000 km:

- geometry sanity: front control before the horizon + LOS clear; back marker beyond horizon + LOS blocked; both on-canvas;
- pipelines: scene + pick depth-plane pipelines ready; log depth active; plane is the `[ld]` variant; point color+pick pipelines prewarmed (front pick returns `depth-plane-front` during skip-warmup);
- `useDepthPlane` follows true → false → true across normal/diagnosticSkip/restored;
- draws: normal + restored each observe ≥1 scene AND ≥1 pick plane draw; skip observes 0 + 0;
- pick: front control picks `depth-plane-front` in ALL three phases; back marker (`depth-plane-back`) NOT pickable in normal, pickable in skip, not pickable in restored;
- scene readback: front lime ≥ 24 px in all phases; back magenta ≥ 24 px in skip; back magenta in normal/restored ≤ max(4, 10% of skip) — the "no leak" bound;
- zero GPU validation errors in every phase.

Then read the six `campaign9-c9-02b-horizon-*-plane-{on,off}.png` yourself and confirm plane-on hides the below-limb marker with no new artifact.

**Final:** rerun the fleet regression sweep once more with the gate on (the plane now occludes in pick — the sweep proves visible-object picking survived), plus `npx tsc`, `npx gulp build`. If a moving-route lane is demanded for the closing evidence, use the Node/Edge moving-altitude campaign per `DEBUGGING_GUIDE.md` (idle-soak FPS is invalid evidence).

### Rollback boundary

- **Gate fails after the flip:** revert exactly one line — `PICK_DEPTH_PLANE_ENABLED` back to `false` (`WebGPUSceneRendererPickPass.ts:69` WT). This restores today's default behavior (visible picks work; beyond-horizon markers stay wrongly pickable — the documented open defect). Update the gate comment + ledger honestly (PARTIAL, with the new failure evidence).
- **Fleet conversion causes pick regressions that can't be fixed forward quickly:** revert the fleet batch as a unit (it's one commit by Invariant 7). Never leave a half-converted fleet on main.
- **NEVER revert:** the scene-half encode fix in `WebGPUDepthPlane.ts` (it fixes real scene occlusion, independently verified), the C9-02A pick-pipeline parity work, the C9-02B uniform ring, or the Batch-672 pick-format authority. Never disable `logarithmicDepthBuffer`, `useDepthPlane`, or the depth-plane feature itself to make a metric or gate pass (campaign rule 1/6: roll back the optimization, never the feature).
- The horizon oracle and its artifacts stay in the tree regardless of outcome — a truthfully-failing oracle is the campaign's regression gate.

### Pointers

**Source (canonical `packages/engine/Source/`, never root `Source/`):**

- `Renderer/WebGPU/WebGPUSceneRendererPickPass.ts` — gate L69 (WT), gated draw L496-498, stash publish L341, per-slice pass structure L350-575
- `Renderer/WebGPU/WebGPUDepthPlane.ts` — WGSL gen L58-139, initialize L416, pick descriptor L524-539, beginPass L637, update+encode L734-827, execute L832
- `Renderer/WebGPU/WebGPUSceneRenderer.ts` — `_beginDepthPlanePass` L2419, `_renderDepthPlane` L2448
- `Renderer/WebGPU/WebGPUSceneRendererFrustumLoop.ts` — L169 (stash), L327 (scene plane draw)
- `Renderer/WebGPU/WebGPUSceneRendererFrustumState.ts` — L16-34
- `Renderer/WebGPU/WebGPUSceneRendererEnsureResources.ts` — `ensureDepthPlane` L105-160
- `Renderer/WebGPU/WebGPULogDepth.ts` — predicate L75-80, `packCameraLogDepthLanes` L94+
- `Renderer/WebGPU/WebGPUGlobeSurfaceCameraUB.ts` — stash write L998-1004
- `Renderer/WebGPU/WebGPUPointPrimitiveRenderer.js` — defines L695-703, pack L884-926, pick pipeline L1329-1398
- `Renderer/WebGPU/WebGPUPickCommandHelpers.ts` — `buildPickPipelineDescriptor` L331-421
- `Shaders/WebGPU/Collections/PointPrimitive{Color,Pick}.wgsl`, `Shaders/WebGPU/Globe/GlobeTerrain.wgsl` (pick L3044-3061, varying L679), `Shaders/WebGPU/Model/ModelPBRComplete.wgsl` (pick L3730/L3793/~L3945)
- `Renderer/WebGPU/WebGPUContext.ts` — `_logDepthWriteEnabled` L458, useDepthPlane overwrite L3615-3618 (item 79)
- `Scene/Scene.js` — `debugSkipDepthPlane` L956 / L3744-3751; `Scene/SceneRenderer.js` — config assembly L457-473

**Specs/docs:** `migration_doc/QUEUE_2026-07-15_CAMPAIGN9.md` (§1 rules, §3.2 rows ~116/129/130/131); `migration_doc/DEFERRED_WORK.md` L5229-5271 (floating); `migration_doc/SOL_AUDIT_REPORT_2026-07-16.md` (P0-1 at L65, sequencing at L111/L167); `migration_doc/WEBGPU_DEBUGGING_LOG.md` tail entry (floating); `migration_doc/FORK_PERFORMANCE_RTE_VISIBILITY_REMEDIATION_PLAN_2026-07-15.md` (campaign architecture; depth-plane work is carried via the C9-02 family rather than a named plan section).

**Probes/artifacts:** `Tools/visual-regression/probe-depth-plane-horizon-oracle.mjs` (altitudes L43-47, validateAltitude L63-161, draw counting L513-515, floating PNG capture L706-736); output dir `Tools/visual-regression/output/performance/` — `campaign9-c9-02b-depth-plane-horizon-oracle-2026-07-16.json` + six `campaign9-c9-02b-horizon-*-plane-{on,off}.png`; `probe-depth-plane-pick-matrix.mjs` (C9-02A artifact `campaign9-c9-02a-depth-plane-pick-matrix-2026-07-16.json`); `probe-hdr-pick-format-closure.mjs` (Batch-672 gate + its `PRECHANGE-BASELINE` artifact under `Tools/visual-regression/output/hdr-pick-closure/`).

---

<a id="g2"></a>

## G2 — Broad-Suite Remainder

### C9-BROAD-SUITE-TRIAGE remainder — item 64 (`NEW-SCENE-BROAD-SUITE-FAILURE-CLOSURE`, C8 item 30) + items 65/67/70/71 + item 72 gate (`C8-SHARED-UPSTREAM-CONTRACT-GATE`)

**Written 2026-07-16 against the live tree at HEAD `ea6332d0aa` (Batch 672) with an active dirty
working tree** (a Campaign-9 worker is executing concurrently — see "Architecture today" step 0).
Every file/line anchor below was re-verified against this tree, not copied from older docs.

**Task IDs and where they live** (all in `migration_doc/QUEUE_2026-07-15_CAMPAIGN9.md`, Wave 5, §9
unless noted):

| Item | ID | One-line scope |
| --- | --- | --- |
| 64 | `NEW-SCENE-BROAD-SUITE-FAILURE-CLOSURE` | Close the Scene run's 47 failures + `afterAll` across six clusters, no exclusions/weakened assertions/timeout inflation. Cluster enumeration lives in the FROZEN C8 queue, item 30 (`migration_doc/QUEUE_2026-07-15_CAMPAIGN8.md` §4 row 30). |
| 65 | `NEW-DESTROYOBJECT-ES6-LIFECYCLE-PARITY` | `destroyObject` must discover ES6 prototype methods; second destroy cannot repeat native teardown. **IN FLIGHT — verify before touching (see below).** |
| 67 | `NEW-RESOURCE-URL-SEMANTIC-PARITY` | Replace the partial WHATWG URL reconstruction in `Resource.parseUrl` with an explicit upstream-compatible contract. |
| 70 | `NEW-KMZ-ARCHIVE-URI-RESOLUTION-PARITY` | Restore embedded BalloonStyle + nested NetworkLink resolution inside KMZ archives; archive entries never fall through to HTTP; traversal rejected. |
| 71 | `NEW-POLYLINE-UPDATER-CONSTANT-API-PARITY` | Restore 4 ES6-conversion-dropped read-only descriptors on `PolylineGeometryUpdater`. **IN FLIGHT — verify before touching.** |
| 72 | `C8-SHARED-UPSTREAM-CONTRACT-GATE` | Broad Renderer/DataSources/Scene/Widgets + complete engine run, exact counts, green; triage Renderer-20 against the GraphicsCapabilities/ContextLimits migration FIRST. |
| 4A (Wave 0) | `NEW-WORKSPACE-SPEC-BUNDLE-FRESHNESS` | The test-command trap that will eat you alive if you skip the build sequence below. |

Item 68 (`NEW-DATASOURCECOLLECTION-CONTAINS-PARITY`) is **COMPLETE** (Batch 671, `dd8654552f`) — do
NOT redo it. Its ledger row is also your template for how these API-only slices get verified and
recorded.

---

#### Architecture today (post-Sol, verified 2026-07-16)

**Step 0 — reconcile with the concurrent worker before doing ANYTHING.** At writing time the working
tree has UNCOMMITTED in-flight work on exactly this cluster:

- `packages/engine/Source/Core/destroyObject.js` — full item-65 implementation (prototype-chain walk,
  descriptor inspection, getter-safe, statics-safe; lines 34–98).
- `packages/engine/Specs/Core/destroyObjectSpec.js` — NEW, 7 cases (untracked).
- `packages/engine/Source/DataSources/PolylineGeometryUpdater.js` — full item-71 implementation
  (adds `outlineEnabled`→false, `hasConstantOutline`→true, `outlineColorProperty`→undefined at
  ~L473–501 and `isClosed`→false at ~L545–554).
- `packages/engine/Source/Scene/VoxelBoundsCollection.js` — the item-30 "VoxelBounds missed
  `maximumTextureSize` argument" one-line fix at L232–236.
- Unrelated to you: `WebGPUDepthPlane.ts` / `WebGPUSceneRendererPickPass.ts` /
  `probe-depth-plane-horizon-oracle.mjs` / `DEFERRED_WORK.md` / `WEBGPU_DEBUGGING_LOG.md`
  (the depth-plane log-depth scene-half — a different task; do not commit, revert, or stage these).

So: run `git log --oneline -30` and `git status --short`, and read the §3.2 ledger in
`QUEUE_2026-07-15_CAMPAIGN9.md`. For each of 65/71/VoxelBounds:

- If it landed in a batch commit → it is DONE; your remainder shrinks. Confirm its ledger row exists.
- If it is still uncommitted in the tree → it belongs to the other worker's slice. **Do not rewrite
  it, do not `git restore` it** (see memory: audit subagents have reverted uncommitted work before —
  that is a catastrophic failure mode). If the other worker is gone and you are told to inherit the
  tree, review the diff against the acceptance text in this guide and land it as its own slice.
- If neither (file back at HEAD state and no batch) → implement per the walkthrough below.

**The pinned broad-suite baseline** (C8 queue §8.1): at source anchor `a54cc06` + Sol's dirty tree,
bundle SHA-256 `B8015811ACC0567663C6898386DC74AD94424363B22DA2A1759DF54AC666C11E`:

- Renderer: 2,493 pass / **20 fail** ("R20")
- DataSources: 1,824 pass / **10 fail** ("DS10")
- Scene: 5,704 executed / **47 fail** plus one `afterAll` ("S47")
- Full engine run: **aborts** at 4,620/17,455 with 7 failures (network/Ion teardown — owned by
  Wave-0 item 8, `NEW-FULL-SUITE-OFFLINE-DEPENDENCY-ISOLATION`)
- Widgets 429/429 and fork-focused broad WebGPU 1,505/1,505 pass.

**Critical caveat:** that baseline predates Batches 656–672 landing AND the in-flight fixes. It is
your *attribution reference*, not your current-count prediction. Known deltas already banked:
item 68 (`contains`) fixed some DS failures; the 10 Renderer "lifecycle" failures are item 65's
target; item 71 targets DS PolylineGeometryUpdater/GeometryVisualizer/static-batch failures;
VoxelBounds targets part of S47. **Your first action after the build sequence is to RE-PIN: run the
three broad suites once on the clean current tree and record exact counts + failing spec names
before changing anything.** The discipline forever after is ZERO NEW FAILURES: any spec failing that
was not failing in your re-pinned run is attributable to your change and blocks your slice.

**What Sol did NOT break** (audit `migration_doc/SOL_AUDIT_REPORT_2026-07-16.md` §1): R20/DS10/S47,
the Resource URL semantics, KMZ fallthrough, and destroyObject gaps are all PRE-EXISTING defects
(mostly from the pre-Sol ES6/urijs-removal codemods, e.g. `39f5341e64`) that Sol found and queued.
Verified by empty `git diff HEAD` on the relevant files during the audit.

**The single highest-blast-radius suspect for the non-lifecycle half of R20** (audit amendment 13,
now baked into item 72's queue row): the per-context `GraphicsCapabilities` migration.
`ContextLimits` is still exported (`packages/engine/index.js:10` — note: the audit said `:123`;
the live tree says line 10) but is **permanently zero** since limits moved to per-context
`GraphicsCapabilities` (`packages/engine/Source/Renderer/GraphicsCapabilities.js` + `.d.ts`).
Product code paths or spec fixtures still reading `ContextLimits.maximumTextureSize` get 0 and fail
or silently no-op. Only two specs still import it
(`packages/engine/Specs/Renderer/WebGPU/WebGPUContextLimitsInitSpec.js`,
`WebGPUDeviceLossRecoverySpec.js`) but Renderer failures may come from product-side reads. Its
disposition (mirror-populate vs loud deprecation) is a SEPARATE item — Wave 5 item 82
(`NEW-CONTEXTLIMITS-LEGACY-DISPOSITION`); do not solve it inside item 72, just attribute.

---

#### Target design + invariants

Numbered invariants an implementation MUST satisfy (queue §1 rules + item rows, restated
concretely):

1. **No exclusions, no weakened assertions, no timeout inflation** — ever. A fixture change must
   make the fixture represent *real renderer-neutral state*, after which the ORIGINAL assertion
   passes. If the real assertion exposes a real product bug, fix the product or queue the bug
   (CLAUDE.md Principle 9); never edit the expectation to match broken output.
2. **Zero new failures vs your re-pinned baseline** after every slice. Fixed clusters may only
   *reduce* counts.
3. **One concern per slice.** Item 65, item 67, item 70, item 71, and each item-30 cluster are
   separate landings with separate focused specs. Do not omnibus them.
4. **WebGL2 default paths keep their native fast paths.** The WebGL1 async-pick fix must not route
   WebGL2 through the slow path (invariant: WebGL2 keeps PBO+fence, WebGPU keeps its native
   readback; WebGL1 gets a Promise-wrapped sync read).
5. **GLSL300 output must be byte-identical** after the GLSL100 additional-light fix (same generated
   source for WebGL2), or at minimum semantically identical with shader-cache keys unchanged.
6. **`Resource` public URL semantics match upstream** for: authority spelling, credentials,
   default/non-default ports, protocol-relative (`//host/x`), bare-relative (`Assets/x`),
   root-relative, `file:`, opaque/custom schemes (`s3://…`), `data:`, `blob:`, path case, query
   split/merge, and fragment. The oracle is upstream behavior
   (`git show upstream/main:packages/engine/Source/Core/Resource.js` — upstream still uses urijs),
   exercised through the Core/Resource + CzmlDataSource suites. Fixing only the two hostname-case
   expectations is explicitly rejected by the item text.
7. **A KMZ archive entry that exists in the archive is NEVER fetched over HTTP**, regardless of
   `./`, `../`, backslashes, encoding, or nesting depth. Paths that escape the archive root are
   rejected (no `uriResolver` hit AND no accidental sourceResource-derived fetch of an
   outside-archive path — upstream behavior is the fallthrough resolves against the KMZ's own URL;
   preserve that for genuinely-external links only).
8. **Archive keys are case-sensitive and stored raw** (zip entry filenames). Normalization happens
   on the *lookup* side (dot-segment removal, backslash→slash, decode of percent-escapes to match
   raw keys), not by mutating stored keys.
9. **destroyObject contract** (item 65): every own + prototype-chain data-property function
   (excluding `constructor`, `isDestroyed`, and anything on `Object.prototype`) becomes the
   destroyed-thrower; accessors are never invoked; statics never touched; `isDestroyed()` → true;
   a second `destroy()` hits the replaced method and CANNOT re-run native teardown. Destroy-time
   only — zero render-hot-path work.
10. **PolylineGeometryUpdater descriptors** (item 71): `isClosed`→`false`,
    `outlineEnabled`→`false`, `hasConstantOutline`→`true`, `outlineColorProperty`→`undefined`,
    all read-only getters, zero renderer behavior change.
11. **Item 72 reports exact counts** — pass/fail/unexecuted per suite, bundle/source hash, browser —
    and does not substitute fork-focused suites for the shared upstream ones. If the complete engine
    run still aborts because Wave-0 item 8 hasn't landed, the gate row is **PARTIAL/BLOCKED on item
    8 by name** — never report an aborted run as a pass, never "fix" it locally with timeout/retry
    hacks.

---

#### The build-then-test sequence (workspace-spec-bundle-freshness trap) — READ FIRST

`gulp test --workspace engine` WITHOUT `--production` runs `buildCesium({iife:true})` which rebuilds
the ROOT `Build/Specs/*`, but the Karma `files` list for a workspace run serves the PACKAGE-LOCAL
bundle `packages/engine/Build/Specs/{karma-main.js,SpecList.js}` (verified: `gulpfile.js` `test()`
at L963; workspace files block at ~L1012–1045). The package bundle is ONLY rebuilt by the engine
workspace build. Consequence: **a brand-new or edited spec under `packages/engine/Specs/` silently
does not execute** — you get a green run that never ran your test. This is queue item 4A; until it
lands, the mandatory sequence is:

```powershell
# 1. Rebuild the exact bundle Karma serves (also regenerates packages/engine/Build/Specs/SpecList.js)
npm run build --workspace @cesium/engine

# 2. Point the Chrome launcher at Edge (Chrome is not installed; Edge is Chromium)
$env:CHROME_BIN = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"

# 3. Focused run — note --production (skips the useless root rebuild that masks staleness)
npx gulp test --workspace engine --production --browsers=EdgeHeadlessCI --includeName "Core/Resource"
```

- `--includeName` values are Jasmine-grep substrings of the `describe` name, e.g.
  `"Core/destroyObject"`, `"DataSources/KmlDataSource"`, `"Scene/Model/pickModel"`. A trailing
  `Spec`/`.js` is stripped automatically. Broad suites: `--includeName "Renderer/"`,
  `"DataSources/"`, `"Scene/"`, `"Widgets/"` (Widgets suite lives in the widgets workspace —
  `--workspace widgets`).
- **Freshness sentinel** for any NEW spec file: temporarily insert one deliberately failing
  `expect`, confirm the run goes red, remove it. If it stays green your bundle is stale — redo
  step 1.
- The trailing `Chrome failed to start` / "Chrome failed" line AFTER a `SUCCESS` summary is a known
  launcher-wrapper artifact (documented in the item-68 ledger row and in `Specs/karma.conf.cjs`
  L8–24, which also auto-cleans stale `karma-edge-*` profiles). **The exit code is the truth.**
- EdgeHeadlessCI launcher: `Specs/karma.conf.cjs` L112+ (base "Chrome", `--headless=new`,
  no `--disable-gpu` so real-GPUDevice WebGPU specs can run).
- If you choose to LAND item 4A itself (it's Wave 0, small): make the workspace branch of `test()`
  build/await `packages/<ws>/Build/Specs` instead of the root bundle, and add the sentinel spec
  proving a changed package spec executes. That obsoletes this manual sequence — record it in the
  ledger.

---

#### Implementation walkthrough

Work order (dependency-shaped, cheapest attribution first):

##### W0. Re-pin the baseline

After `npm run build --workspace @cesium/engine`, run each broad suite once and save the console
output (exact counts + every failing spec full name) to
`Tools/visual-regression/output/performance/campaign9-item72-repin-<date>.txt` or similar. Commands:

```powershell
npx gulp test --workspace engine --production --browsers=EdgeHeadlessCI --includeName "Renderer/" --suppressPassed
npx gulp test --workspace engine --production --browsers=EdgeHeadlessCI --includeName "DataSources/" --suppressPassed
npx gulp test --workspace engine --production --browsers=EdgeHeadlessCI --includeName "Scene/" --suppressPassed
```

Cluster every failure into: (a) covered by an item below, (b) GraphicsCapabilities/ContextLimits
suspect, (c) network/Ion (item 8's), (d) unknown. For (d): attribute pre-existing-vs-tree by
checking whether the spec fails at the pinned B8015811 description and/or on a stash of your
changes. Unknown-and-new = STOP, investigate before proceeding.

##### W1. Item 65 — destroyObject (verify-or-land, likely already done)

Decision point: if `packages/engine/Source/Core/destroyObject.js` at your HEAD already contains the
prototype-chain walk (look for `Object.getPrototypeOf` + `Object.getOwnPropertyDescriptor` — the
old broken version is a bare `for (const key in object)` loop), the implementation is landed;
your job reduces to running the Renderer broad suite and confirming the **10 lifecycle failures**
(the destroyObject half of R20) now pass, plus the focused `Core/destroyObject` spec.

If you must implement it yourself, the design already validated in-tree (lines 34–98 of the
in-flight file):

1. `processed = new Set(["isDestroyed", "constructor"])` — skipping `constructor` keeps class
   statics unreachable/unmodified.
2. Walk `current = object; current !== null && current !== Object.prototype;
   current = Object.getPrototypeOf(current)`.
3. For each `Object.getOwnPropertyNames(current)` name not yet processed: mark processed
   (nearest-to-instance descriptor wins, matching JS property lookup), take
   `Object.getOwnPropertyDescriptor(current, key)`, and **only** act when
   `typeof descriptor.value === "function"` — this skips accessors WITHOUT invoking getters.
4. Non-configurable own data property: assign `object[key] = throwOnDestroyed` only if writable;
   otherwise skip (cannot be replaced — document, don't throw).
5. Otherwise `Object.defineProperty(object, key, { value: throwOnDestroyed, writable: true,
   configurable: true, enumerable: own ? own.enumerable : false })` — shadowed prototype methods
   stay non-enumerable so `for...in` consumers see no new keys.
6. `isDestroyed` last, → `returnTrue`.
7. `throwOnDestroyed` body stays pragma-wrapped (`//>>includeStart('debug'…`) — in release it's an
   empty function, which is exactly what makes a second `destroy()` a harmless no-op instead of a
   repeated native teardown. Do NOT "fix" the pragma to always-throw.

##### W2. Item 71 — PolylineGeometryUpdater descriptors (verify-or-land, likely already done)

Same decision point as W1. If absent at HEAD: add the four read-only getters exactly as invariant
10 (the class is at `packages/engine/Source/DataSources/PolylineGeometryUpdater.js`; put
`outlineEnabled`/`hasConstantOutline`/`outlineColorProperty` near `depthFailMaterialProperty`
~L470, `isClosed` near `isDynamic` ~L542, matching the in-flight diff). These exist because
`GeometryVisualizer` and the static-geometry batches interrogate every updater through one
interface; polylines legitimately answer false/true/undefined. Focused suites:
`--includeName "DataSources/PolylineGeometryUpdater"`, then `"DataSources/GeometryVisualizer"` and
the static-batch suites in the DataSources broad run.

##### W3. Item 30 cluster (a) — WebGL1 async-pick routing

Anchors (all verified live):

- `packages/engine/Source/Scene/PickFramebuffer.js` — `endAsync()` at ~L68–120 unconditionally does
  `context.readPixelsToPBO(...)` (L83) + `Sync.create({context})` (L91).
- `packages/engine/Source/Renderer/Sync.js:28` — constructor throws `DeveloperError` when
  `!context._webgl2`. WebGL1 therefore cannot async-pick at all; Scene/Model `pickAsync` specs that
  run under `requestWebgl1: true` (present in `packages/engine/Specs/Scene/Model/ModelSpec.js`,
  `pickModelSpec.js`, `SceneSpec.js`, +12 more) fail.
- `Context.js` has a public `get webgl2()` (L864). `readPixelsToPBO` is `Context.js:1384`.
- Result decoding is shared: `pickObjectsFromPixels(context, pixels, width, height, limit)` at
  `PickFramebuffer.js:197` — the sync `end()` (L124+) already uses it with `context.readPixels`.

Fix shape (acceptance text: "WebGL1 uses Promise-wrapped sync reads without PBO/fence while
WebGL2/WebGPU retain native paths"): at the top of `endAsync`, branch:

```js
if (!context.webgl2) {
  // WebGL1: no PBO/fence. Resolve on the next afterRender tick with a
  // synchronous read — same result contract, no GPU-stall avoidance claimed.
  return new Promise((resolve) => {
    frameState.afterRender.push(() => resolve(this.end(screenSpaceRectangle, limit)));
  });
}
```

Decision points: (i) confirm the exact failing spec names from your W0 re-pin before coding — if no
S47 failure matches this cluster anymore (someone landed it), close as already-fixed with evidence;
(ii) `this.end()` reads from `this._fb.framebuffer` state — confirm the framebuffer is still bound
and alive on the afterRender tick in the failing specs (it is for the pick mini-frame flow; if you
find a spec where it is destroyed first, resolve the read immediately/synchronously instead and note
it); (iii) do NOT touch `WebGPUPickFramebuffer.ts` — WebGPU has its own native path and its own
open items (73/74). The fork is WebGL2-first, but this WebGL1 lane is queue-mandated because
upstream Scene specs exercise it — the queue text overrides the "WebGL2 only" charter note here.

##### W4. Item 30 cluster (b) — GLSL100 additional-light generation

Verified root cause: `packages/engine/Source/Shaders/Model/LightingStageFS.glsl` defines
`czm_lightData czm_unpackLight(int index)` at L59–78, which computes `int base = 1 + index * 4;`
and indexes the uniform array `czm_lightsData[base]` (the vec4[33] automatic uniform —
`AutomaticUniforms.js` ~L1379). In GLSL ES **1.00** fragment shaders, uniform-array subscripts must
be *constant-index-expressions*; a **function parameter does not qualify** (a conforming for-loop
index does — GLSL ES 1.00 Appendix A). So any GLSL100 compile of a `LIGHTING_PBR && HAS_NORMALS`
model shader fails. On `#version 300 es` (WebGL2 default) it's legal, which is why only the
WebGL1-lane specs fail.

Fix shape preserving byte/semantic identity on GLSL300: move the indexing into the caller's loop
(`computePbrLighting`, L148–156) where `i` IS a valid constant-index-expression:

```glsl
for (int i = 0; i < 8; i++) {
    if (i >= additionalLightCount) { break; }
    int base = 1 + i * 4;
    czm_lightData light = czm_unpackLightVec4(
        czm_lightsData[base], czm_lightsData[base + 1],
        czm_lightsData[base + 2], czm_lightsData[base + 3]);
    ...
}
```

i.e. change `czm_unpackLight(int)` into `czm_unpackLightVec4(vec4,vec4,vec4,vec4)` (pure struct
packing, no array access inside the function). Both are defined inside LightingStageFS.glsl itself
(NOT in `Shaders/Builtin/Functions/` — don't go hunting there; `czm_computeAttenuation` /
`czm_computeSpotCone` / the `czm_lightData` struct ARE builtins and are fine).

`base + i*4` with loop index `i` is a constant-index-expression; `base` derived from it via
`int base = 1 + i*4` also qualifies (it's formed only from constants and the loop index). If an
ANGLE/driver in the spec run still rejects it, fall back to full manual unroll of the 8 iterations
behind `#if __VERSION__ == 100` — but try the loop-index form first; it keeps one code path.

The queue's acceptance also names "**ray/sample/clamp**" GLSL100 variants. Those are OTHER generated
functions with the same defect class (non-constant indexing / GLSL300-only constructs) — likely in
voxel or generated model shaders. Do not guess: take the exact failing spec names from W0, extract
the shader compile error text (Karma prints translated-shader errors), and fix each offending
generated function the same way. If a cluster member's failure text is NOT a GLSL100 compile error,
STOP and re-attribute — do not force this fix shape onto it.

Regression guard: after the change run the WGSL/GLSL-adjacent focused suites AND one WebGL2 model
probe (e.g. `node Tools/visual-regression/capture-and-diff.mjs --scene <model scene>`) to prove
WebGL2 output unchanged; the shader is shared by every PBR model draw.

##### W5. Item 30 cluster (c) — VoxelBounds maximumTextureSize

Verified: `packages/engine/Source/Scene/VoxelBoundsCollection.js` `update()` call site at L232–236
historically called `computeTextureResolution(pixelsNeeded, textureResolutionScratch)` while the
function signature (L446) is `(pixelsNeeded, maximumTextureSize, result)` — the scratch Cartesian2
landed in `maximumTextureSize` and `result` was undefined → `Math.min(number, Cartesian2)` = NaN →
broken texture allocation. The static `VoxelBoundsCollection.getTextureResolution` (L466–487)
already passes `context.limits.maximumTextureSize` correctly — only the instance `update()` site was
wrong. The in-flight fix inserts `frameState.context.limits.maximumTextureSize` as the second
argument. If not landed at your HEAD, apply exactly that. Note `context.limits` here is the
per-context GraphicsCapabilities object — correct post-Sol source; do NOT use the `ContextLimits`
module (permanently zero). Focused suite: the voxel render/pick + per-context limit specs named in
your W0 failures (`--includeName "Scene/Voxel"`).

##### W6. Item 30 cluster (d) — CubeMapPanorama validation parity

Verified: `packages/engine/Source/Scene/CubeMapPanorama.js` `update()` — the WebGPU delegation
(`context.getFeatureRenderer(FeatureRendererKey.CUBE_MAP_PANORAMA)` → `return fr.update(...)`) sits
at ~L179–183, BEFORE the sources dirty-check + debug validation block at L185–212. On a WebGPU
context the `this.sources` validation (six faces present, all same type) never runs → "panorama
validation matches across backends" fails.

Fix shape (Scene Logic Extractor pattern — CLAUDE.md "shared scene-level logic MUST run BEFORE the
`if (context.isWebGPU)` branch point"): hoist ONLY the pragma-wrapped validation so it executes on
both paths, gated by the same "sources changed" condition, WITHOUT moving the `_sources` assignment
(each backend path manages its own dirty state):

```js
//>>includeStart('debug', pragmas.debug);
if (this._sources !== this.sources) { /* Check.defined + the two DeveloperError checks */ }
//>>includeEnd('debug');
const fr = context.getFeatureRenderer(FeatureRendererKey.CUBE_MAP_PANORAMA);
if (fr) { return fr.update(this, frameState, useHdr); }
```

Decision point: first read `WebGPUCubeMapPanoramaRenderer.js`'s `update` — if it performs its own
equivalent validation, the spec may be failing on error-message text instead; match the exact
upstream DeveloperError messages in the hoisted block (they're quoted at L197 and L208) and remove
any duplicate WebGPU-side validation rather than double-throwing. Confirm which spec asserts this
(`packages/engine/Specs/Scene/CubeMapPanoramaSpec.js`) and reproduce before/after.

##### W7. Item 30 clusters (e)+(f) — renderer-neutral fixtures + irradiance semantic oracle

These are triage-shaped; no pre-verified single anchor exists.

(e) **Fixtures**: S47 members where terrain/globe/camera specs fail inside FIXTURE code (mock
contexts/scenes missing post-Sol contract members: per-context `limits`/GraphicsCapabilities,
`getFeatureRenderer`, clip-space convention getters). Acceptance: "terrain/globe/camera tests
execute their real assertions through shared renderer-neutral fixtures". Procedure per failure:
read the stack, if it dies before the first `expect`, extend the SHARED fixture
(`Specs/createScene.js`, `Specs/createContext.js`, or the mock in question) with the real
renderer-neutral member (mirror what `Context.js` exposes — e.g. `limits` must be a
GraphicsCapabilities-shaped object, `getFeatureRenderer` may return undefined for WebGL mocks).
Never stub a member to make an assertion vacuous.

(f) **Environment-map/irradiance oracle**:
`packages/engine/Specs/Scene/DynamicEnvironmentMapManagerSpec.js` (24 cases) — several assertions
are already semantic (blueness ratio at L508/L599, L0 max-channel at L766), but the S47 members in
this cluster still assert brittle exact numerics that differ legitimately across
drivers/fork-rendering. Acceptance: "irradiance checks use finite energy/chromaticity/directional
reconstruction". Convert failing exact-value expectations into: (1) all SH coefficients finite;
(2) L0 energy within a physical band; (3) chromaticity ratios (e.g. blue-sky dominance) with
EPSILON1-class tolerance; (4) directional reconstruction (evaluate SH toward known bright direction
> toward dark direction). **Product math is untouchable in this slice** — if the semantic oracle
itself fails, you have found a real product defect: queue it (new ledger row), don't tweak
constants.

##### W8. Item 67 — Resource URL semantic parity

Verified current state: `packages/engine/Source/Core/Resource.js` `parseUrl()` L175–244.
`data:`/`blob:` are stored verbatim (L179–189, fine). Everything else goes through
`new URL(...)` and is reconstructed as `parsed.origin + parsed.pathname` when the input had a
scheme or a baseUrl (L226/L230). The WHATWG-reconstruction defects to close (this IS the contract —
enumerate them in your spec):

1. **Host-case canonicalization**: `origin` lowercases the authored hostname
   (`HTTP://Test.COM/x` → `http://test.com/x`). Upstream (urijs `.toString()`) round-trips what the
   test expects. Two known DataSources expectations fail on exactly this — but per the item text you
   must close the whole contract, not just these two.
2. **Credentials dropped**: `https://user:pass@host/x` → origin excludes userinfo → credentials
   silently deleted from `resource.url`.
3. **Default-port drop / port normalization**: `https://host:443/x` → `https://host/x`;
   `http://host:0080/x` → normalized. Upstream preserves authored form.
4. **`file:` corruption**: `new URL("file:///C:/data/x").origin` is the literal string `"null"` →
   `_url` becomes `"null/C:/data/x"`.
5. **Opaque/custom-scheme corruption**: `s3://bucket/key`, `tms://…` — non-special schemes get
   `origin === "null"` and non-hierarchical pathname handling → corrupted reconstruction.
6. **Path normalization drift**: WHATWG resolves dot-segments and re-percent-encodes; upstream keeps
   the authored path bytes (case is kept by both, but encoding/dot-segments differ).
7. **Fragment loss**: the reconstruction drops `#fragment` and `getUrlComponent` never restores it.

Fix shape (recommended; urijs is REMOVED from the fork — `packages/engine/Source/ThirdParty/` has
no Uri.js — do NOT re-vendor it without maintainer sign-off):

- For inputs with a scheme and no baseUrl: **stop reconstructing entirely.** Scan for the first
  `?` or `#` (already done at L239 for the no-base branch); everything before it is `_url`
  VERBATIM; parse the query substring with the existing `parseQueryString`; decide fragment
  handling by upstream oracle (check `git show upstream/main:packages/engine/Source/Core/Resource.js
  parseUrl` — upstream strips query into `_queryParameters` and keeps the rest via urijs toString).
  This single change fixes defects 1–7 for absolute URLs because nothing is ever rebuilt from
  WHATWG components.
- For relative inputs WITH baseUrl (the `getDerivedResource` path): resolution genuinely needs
  base-URL math. Keep `new URL(url, getAbsoluteUri(baseUrl))` for hierarchical http(s)/file bases
  (this branch already preserves base pathname — the L190–196 comment documents why), but
  re-serialize as `protocol + '//' + (username[:password]@)? host (:port)? + pathname` from the URL
  components INCLUDING userinfo/port, or better: only use URL for the *path merge* and keep the
  base's authority substring verbatim. For non-hierarchical bases (`s3:`, `file:` on exotic forms)
  where `new URL` throws or corrupts, do RFC-3986 §5.3 merge manually (base up to last `/` +
  relative, then dot-segment removal).
- Do NOT touch `getAbsoluteUri.js` / `getBaseUri.js` in this slice unless a failing spec names
  them — they have their own semantics and their `new URL` use resolves (doesn't reconstruct), which
  is the safe half.

Focused suites: `--includeName "Core/Resource"` (large), then `"DataSources/CzmlDataSource"` (CZML
resolves relative asset URIs through Resource), then the DataSources broad run. There is also
`Tools/upstream-regression-check.mjs` and the comment at Resource.js L233–238 recording the two
cases the LAST attempt regressed (protocol-relative authority loss; bare-relative re-rooting) —
those are your negative controls; keep them green.

##### W9. Item 70 — KMZ archive URI resolution

Verified current state, `packages/engine/Source/DataSources/KmlDataSource.js`:

- Archive keys: `uriResolver[entry.filename] = dataUri` (L407, raw zip paths, e.g.
  `files/image.png`); `uriResolver.keys = Object.keys(uriResolver)` (L3338).
- `embedDataUris` (L410–434): normalizes the html attribute value via
  `new URL(value, "https://placeholder.invalid/./").pathname` → ALWAYS leading-slash +
  percent-encoded (`/files/image.png`, space→`%20`) → `keys.indexOf(uri)` never matches raw keys →
  BalloonStyle embedded assets never swapped to data URIs → `applyBasePath` (L436+) then rewrites
  them to HTTP URLs = the "existing entries fall through to HTTP" defect.
  Upstream reference (fetchable: `git show upstream/main:packages/engine/Source/DataSources/KmlDataSource.js`):
  `new Uri(value).absoluteTo(new Uri("."))` → relative normalization, NO leading slash, no
  re-encoding.
- `resolveHref` (L618–657): direct `uriResolver[href]` lookup (after backslash→slash, L626) has no
  dot-segment normalization, so `./files/x.png` misses; the nested-KML fallback
  `new URL(href, baseUrl).href` (L637) either THROWS when `baseUrl` is a relative path (upstream
  passes the nested KML's RELATIVE in-archive path as sourceUri — see processNetworkLink
  L3013–3025: `newSourceUri = href` stays the original relative path for data-URI hits) — falling
  back to the raw href and missing — or produces an absolute `http://…` string that can never match
  a raw archive key. Upstream: `new Uri(href).absoluteTo(new Uri(sourceResource.getUrlComponent()))`
  → `docs/inner.kml` + `images/img.png` = `docs/images/img.png`, matching the raw key.

Fix shape: write ONE shared helper (module-scope in KmlDataSource.js, or `Core/` if you find a
second consumer) — `resolveArchivePath(base, ref)` implementing RFC 3986 §5.2.3 merge + §5.2.4
`remove_dot_segments` on RELATIVE paths: backslash→slash, strip `./`, resolve `../` against the
base's directory, no leading slash ever, percent-DECODE the ref to match raw zip keys
(`%20` → space), and **return undefined (reject) when `..` would escape above the archive root** —
that is the traversal-security acceptance. Then:

- `embedDataUris`: `uri = resolveArchivePath("", value)` (root-relative within archive).
- `resolveHref`: first try `resolveArchivePath("", href)`; if miss and the sourceResource URL is an
  in-archive relative path, try `resolveArchivePath(dirOf(sourceResource.getUrlComponent()), href)`;
  only after BOTH miss fall through to `sourceResource.getDerivedResource` (external HTTP). An
  archive-relative path that normalizes to an existing key must never reach getDerivedResource.
- Preserve the case-sensitivity of keys (invariant 8) — no `.toLowerCase()` anywhere.
- Check the nested NetworkLink flow (L3013–3025) end-to-end with `Specs/Data/KML/multilevel.kmz`;
  `backslash.kmz` covers the Windows-path case; also `simple.kmz`.

Focused suite: `--includeName "DataSources/KmlDataSource"` — the acceptance is the COMPLETE KML
suite passing, not just the KMZ cases.

##### W10. Item 72 — the shared upstream contract gate (run LAST)

Only after W1–W9 (and the other guide-clusters' product fixes, if you own them) are landed:

1. Fresh build: `npm run build --workspace @cesium/engine` (+ `npx gulp build` for the root bundle
   used by any probe verification), record source commit + bundle hash (SHA-256 of
   `Build/CesiumUnminified/Cesium.js` — mirror how §8.1 recorded B8015811).
2. Run Renderer, DataSources, Scene broad suites (workspace engine) and Widgets
   (`--workspace widgets`), each once, recording exact executed/pass/fail counts and every failing
   name.
3. Triage order per the queue row: FIRST check every remaining Renderer failure against the
   GraphicsCapabilities/ContextLimits migration (grep the failing spec + its product path for
   `ContextLimits` / `.limits.` reads); THEN attribute the rest pre-existing-vs-tree against the
   pinned + re-pinned baselines.
4. The "complete engine run" leg: currently aborts (network/Ion `afterAll`). If Wave-0 item 8 has
   landed by then, run it and record; if not, the gate row goes **PARTIAL — blocked on item 8** with
   the three per-suite legs' evidence attached. Do not inflate timeouts to force completion.
5. Gate is green only when: every product cluster above is closed, zero unexplained failures remain,
   and no assertion was weakened. Record the artifact paths + counts in the §3.2 ledger row for
   `C8-SHARED-UPSTREAM-CONTRACT-GATE`, and update `NEW-SCENE-BROAD-SUITE-FAILURE-CLOSURE` (item 64)
   in the same edit.

---

#### Traps for the unwary

1. **The stale-spec-bundle trap** (item 4A): a green focused run proves nothing unless you rebuilt
   `packages/engine/Build/Specs` first. Use the sentinel-failure trick on every new spec file.
2. **Do not clobber the concurrent worker.** Uncommitted `destroyObject.js` /
   `PolylineGeometryUpdater.js` / `VoxelBoundsCollection.js` / depth-plane files belong to an
   in-flight slice. Never `git restore`, never `git stash` (memory rule: no bare stash), never
   commit someone else's half-finished depth-plane work into your slice.
3. **Baseline drift**: the R20/DS10/S47 numbers were pinned on Sol's PRE-landing dirty tree. Batches
   656–672 + in-flight fixes have changed the real counts. Re-pin (W0) or you will misattribute.
4. **"Chrome failed to start" after SUCCESS is not a failure** — launcher-wrapper artifact; trust
   the exit code. Conversely, a run that executes ZERO specs fails nonzero by design
   (strict Karma config in gulpfile) — don't "fix" that.
5. **destroyObject pragma semantics**: the destroyed-method throw only exists in debug builds;
   specs run unminified (debug pragmas live). Don't make it throw in release; don't assert throws
   in a release-bundle run (`--release`).
6. **destroyObject fleet blast radius**: every `destroy()` in the engine funnels through it,
   including per-tile GPU wrapper teardown on terrain flights. If the strict allocation-tax or
   moving-route lanes regress after landing, the prototype walk is the suspect — the fix is a
   per-prototype WeakMap name cache, but do NOT add it speculatively (one concern per slice).
7. **GLSL100 fix must not perturb GLSL300**: the shader source string feeds shader-cache keys.
   Changing `czm_unpackLight`'s signature changes bytes for BOTH versions — that's fine (cache keys
   follow source), but verify a WebGL2 model still renders identically (probe or capture-and-diff)
   and don't rename the czm_-prefixed function to a non-czm name (ShaderSource czm_ scanning).
8. **GLSL ES 1.00 Appendix A subtlety**: loop-index indexing is only legal when the loop meets the
   Appendix A form (init/condition/increment on constants). `for (int i = 0; i < 8; i++)` with an
   internal `break` qualifies; refactoring it to `i < additionalLightCount` would NOT (non-constant
   bound). Keep the constant bound + break shape.
9. **WebGL1 async pick**: don't route WebGL2 through the Promise-wrapped sync read "for simplicity"
   — that deletes the PBO/fence fast path (feature-preservation rule). And don't try to make WebGL1
   truly async with extensions — acceptance explicitly says Promise-wrapped sync read.
10. **Resource: do not reconstruct what you can preserve.** Every defect in item 67 comes from
    rebuilding a URL out of WHATWG components. The verbatim-slice approach (keep everything before
    the first `?`/`#`) is strictly safer. Also: the L233–238 comment records the exact two
    regressions (protocol-relative, bare-relative) a previous "improvement" caused — they are your
    negative controls.
11. **Resource: `getUrlComponent` does brace-template restoration** (`%7B`→`{`, L265) — templated
    URLs (`{s}.tile.example.com/{z}/{x}/{y}`) must keep working; add a template case to your spec.
12. **KMZ keys are raw and case-sensitive**: normalize the LOOKUP, never the stored keys; decode
    percent-escapes on the lookup side only. Rejecting root-escape (`../../x`) must not also reject
    legitimate deep `../` that stays inside the archive.
13. **KMZ: don't "fix" the HTTP fallthrough by removing it** — genuinely-external absolute hrefs in
    a KMZ must still resolve via `getDerivedResource`. The invariant is only: existing-entry lookups
    never LOSE to normalization and then hit HTTP.
14. **Semantic-oracle discipline (env-map cluster)**: converting exact numerics to semantic checks
    is test work; if the semantic check fails, that's a product bug — queue it, don't tune the
    tolerance until green (that's a weakened assertion, rule 1).
15. **CubeMapPanorama hoist**: validation is pragma-wrapped debug-only — keep it that way; hoisting
    it OUT of the pragma block adds release-path cost and violates the pragma rules.
16. **Item 72 is not "run and hope"**: the queue row hard-codes triage ORDER (GraphicsCapabilities/
    ContextLimits first). Skipping that and bisecting random Renderer failures wastes the budget.
17. **The `afterAll` and full-run abort are item 8's property** — if you find yourself adding
    network mocks/timeouts to Scene specs to stop the abort, stop; that's Wave-0 item 8
    (`NEW-FULL-SUITE-OFFLINE-DEPENDENCY-ISOLATION`), a separate slice.
18. **Ledger duty**: §3.2 says unlisted = NOT STARTED. Every slice you start/land/block gets a row
    edit in `QUEUE_2026-07-15_CAMPAIGN9.md` in the SAME commit. The audit dinged Sol for
    under-claiming; don't repeat it in either direction.
19. **lint-staged OOM**: these slices touch big files (KmlDataSource.js is ~4k lines). If the
    pre-commit hook OOMs, serialize with `--concurrent 1` (memory note), never `--no-verify`.
20. **Commit as kurtyoung-dev** (memory note); 403 on push = wrong active gh account.

---

#### Verification recipe

Per-slice (all from repo root, PowerShell):

```powershell
# Always first
npx tsc --noEmit                                   # zero errors
npm run build --workspace @cesium/engine           # refresh served spec bundle
$env:CHROME_BIN = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"

# Focused oracle per slice (choose the matching one)
npx gulp test --workspace engine --production --browsers=EdgeHeadlessCI --includeName "Core/destroyObject"
npx gulp test --workspace engine --production --browsers=EdgeHeadlessCI --includeName "DataSources/PolylineGeometryUpdater"
npx gulp test --workspace engine --production --browsers=EdgeHeadlessCI --includeName "Core/Resource"
npx gulp test --workspace engine --production --browsers=EdgeHeadlessCI --includeName "DataSources/CzmlDataSource"
npx gulp test --workspace engine --production --browsers=EdgeHeadlessCI --includeName "DataSources/KmlDataSource"
npx gulp test --workspace engine --production --browsers=EdgeHeadlessCI --includeName "Scene/CubeMapPanorama"
npx gulp test --workspace engine --production --browsers=EdgeHeadlessCI --includeName "Scene/Model/pickModel"
npx gulp test --workspace engine --production --browsers=EdgeHeadlessCI --includeName "Scene/DynamicEnvironmentMapManager"

# Affected broad suite after each landing (zero-new-failures check vs W0 re-pin)
npx gulp test --workspace engine --production --browsers=EdgeHeadlessCI --includeName "Renderer/" --suppressPassed
npx gulp test --workspace engine --production --browsers=EdgeHeadlessCI --includeName "DataSources/" --suppressPassed
npx gulp test --workspace engine --production --browsers=EdgeHeadlessCI --includeName "Scene/" --suppressPassed
```

Pass criteria: focused suite fully green (with the sentinel trick proving execution for new specs);
the affected broad suite's failure set = (re-pinned set) minus (the cluster you fixed), nothing
added; `npx tsc --noEmit` and `npx gulp build` clean. For the GLSL100 slice additionally:
`npx gulp build` then one WebGL2 model visual check
(`node Tools/visual-regression/capture-and-diff.mjs --scene <a model scene>` or an existing model
probe) proving no WebGL2 delta — read the PNGs yourself (CLAUDE.md Principle 8). For item 72: the
four suite runs + counts + hash recorded as an artifact under
`Tools/visual-regression/output/performance/` (naming pattern:
`campaign9-item72-shared-suite-gate-<date>.json/txt`), ledger rows updated.

No browser probes are needed for items 65/67/70/71 (API-level; the Jasmine suites in real Edge ARE
the physical lane). Rendering-adjacent slices (GLSL100, CubeMapPanorama) get the probe check above.

---

#### Rollback boundary

These are correctness/test slices, not optimizations, so the rollback unit is the individual slice
commit — never the feature:

- If a slice's broad-suite check shows NEW failures you cannot attribute within the slice, revert
  THAT slice's commit (one concern per slice makes this clean) and re-land after root-causing. The
  focused spec you wrote SURVIVES the rollback (tests and counters remain — queue rule 6) — mark it
  `xit` ONLY if the product fix is reverted with it, with a ledger row saying so.
- Never roll back by weakening the assertion, excluding the spec, or inflating a timeout — that is
  the failure mode this whole cluster exists to close (rule 1).
- For item 67 specifically: if the verbatim-preserve rewrite regresses the two recorded negative
  controls (protocol-relative / bare-relative, Resource.js L233–238 comment) or
  ArcGisMapServerImageryProviderSpec, revert the slice; do NOT ship a partial contract that fixes
  hostname-case but re-breaks relative resolution.
- For the GLSL100 slice: if WebGL2 visual parity fails, revert the shader change entirely (do not
  try to gate it with a runtime branch — one source, both versions).
- Item 72 has no rollback: it is evidence-only. A red gate blocks promotion (Gate G dependency) and
  produces queued fixes; it never causes engine reverts by itself.
- The in-flight depth-plane files in the working tree are OUTSIDE your boundary entirely — never
  include them in a revert or a landing.

---

#### Pointers

**Queues / plans / ledger**
- `migration_doc/QUEUE_2026-07-15_CAMPAIGN9.md` — §1 rules; §3.2 live ledger (your update duty);
  Wave 0 item 4A (freshness); Wave 5 items 64/65/67/70/71/72; item 68 row = evidence-format
  template.
- `migration_doc/QUEUE_2026-07-15_CAMPAIGN8.md` — FROZEN; §4 item 30 (the authoritative Scene-47
  cluster enumeration + acceptance), items 32/34/35/37/38/39/40 (the C8-numbered twins of
  65/67/68/70/71/72 + offline isolation); §8.1 pinned baseline (R20/DS10/S47, bundle `B8015811…`).
- `migration_doc/SOL_AUDIT_REPORT_2026-07-16.md` — §1/§5 (pre-existing vs introduced boundary),
  §6 amendments 11/13 (item-68 pull-forward; item-72 triage order), §8 step 7 (broad-suite
  attribution lane), Appendix A cohorts F/G (where items 65/67/68/70 were found).
- `migration_doc/FORK_PERFORMANCE_RTE_VISIBILITY_REMEDIATION_PLAN_2026-07-15.md` — §3 invariants,
  §8 rollback discipline, WS1 ("broad upstream contract failures run in parallel and must all be
  green by final certification").
- `migration_doc/FORK_PERFORMANCE_WEEKLY_CHANGE_DEFENSE_2026-07-15.md` — how the pinned counts were
  produced.

**Source anchors (all verified on this tree)**
- `packages/engine/Source/Core/destroyObject.js` L34–98 (in-flight walk) +
  `packages/engine/Specs/Core/destroyObjectSpec.js` (untracked, 7 cases).
- `packages/engine/Source/DataSources/PolylineGeometryUpdater.js` ~L470–554 (in-flight getters).
- `packages/engine/Source/Scene/VoxelBoundsCollection.js` L232–236 (in-flight fix), L446
  (`computeTextureResolution` signature), L466–487 (already-correct static site).
- `packages/engine/Source/Scene/PickFramebuffer.js` L68–120 (`endAsync`), L197
  (`pickObjectsFromPixels`); `packages/engine/Source/Renderer/Sync.js` L28 (WebGL2 throw);
  `packages/engine/Source/Renderer/Context.js` L864 (`get webgl2`), L1384 (`readPixelsToPBO`).
- `packages/engine/Source/Shaders/Model/LightingStageFS.glsl` L59–78 (`czm_unpackLight`),
  L148–156 (additional-light loop); `packages/engine/Source/Renderer/AutomaticUniforms.js` ~L1355
  (`czm_lightCount`), ~L1379 (`czm_lightsData[33]`).
- `packages/engine/Source/Scene/CubeMapPanorama.js` L179–183 (fr delegation), L185–212 (validation
  to hoist).
- `packages/engine/Source/Core/Resource.js` L175–244 (`parseUrl`), L233–238 (negative-control
  comment), L254–285 (`getUrlComponent` incl. brace restoration);
  `packages/engine/Source/Core/getAbsoluteUri.js` / `getBaseUri.js` (adjacent, out of scope).
- `packages/engine/Source/DataSources/KmlDataSource.js` L403–408 (`loadDataUriFromZip` raw keys),
  L410–434 (`embedDataUris`), L618–657 (`resolveHref`), L2174–2188 (BalloonStyle rewrite loop),
  L3013–3025 (nested NetworkLink), L3286–3345 (`loadKmz`), L3338 (`uriResolver.keys`).
- `packages/engine/index.js` L10 (`ContextLimits` export — permanently-zero module;
  disposition = Wave 5 item 82, not yours).
- `gulpfile.js` L963–1100 (`test()` — the workspace files/proxies block is the freshness defect);
  `Specs/karma.conf.cjs` L8–24 + L112+ (EdgeHeadlessCI contract);
  `packages/engine/package.json` `build` script.

**Upstream semantic oracles** (remote `upstream` = CesiumGS/cesium, already configured):
`git show upstream/main:packages/engine/Source/Core/Resource.js` and
`git show upstream/main:packages/engine/Source/DataSources/KmlDataSource.js` (upstream still on
urijs — behavior reference only; urijs is removed from the fork, do not re-vendor).

**Fixtures / specs**
- `Specs/Data/KML/{simple,multilevel,backslash,empty,duplicateNamespace}.kmz`.
- `packages/engine/Specs/DataSources/KmlDataSourceSpec.js`, `.../CzmlDataSourceSpec.js`,
  `packages/engine/Specs/Core/ResourceSpec.js` (via `--includeName "Core/Resource"`),
  `packages/engine/Specs/Scene/DynamicEnvironmentMapManagerSpec.js`,
  `packages/engine/Specs/Scene/CubeMapPanoramaSpec.js`; `requestWebgl1` lanes in
  `packages/engine/Specs/Scene/Model/{ModelSpec,pickModelSpec}.js`, `SceneSpec.js` (15 files total).

**Evidence artifact convention**: JSON/txt under `Tools/visual-regression/output/performance/`
named `campaign9-<item>-<lane>-<date>.json` (see the existing
`campaign9-gate-a-*-2026-07-15.json` files there for shape).

---

<a id="g3"></a>

## G3 — Canvas Pass Cluster

### C9-07-DEMAND-OPEN-CANVAS-PASS / FAR-405-C0 — Demand-open the default canvas render pass

All line anchors below were verified against HEAD `ea6332d0aa` (Batch 672, 2026-07-16). If the
tree has moved past that commit, re-verify every anchor with `git log --oneline -3 -- <file>`
before editing; the symbols named here are stable enough to re-find with Grep.

Queue references: task row = `QUEUE_2026-07-15_CAMPAIGN9.md` §6 Wave 2 item 24 (line 198);
live-status ledger row = §3.2 line 126 (`C9-07-DEMAND-OPEN-CANVAS-PASS` — **NOT STARTED**,
premise audit complete); campaign rules = §1 lines 22–35 (esp. rule 1 "never weaken a feature
for a metric", rule 3 "unknown consumers get the conservative fallback", rule 6 "one concern
per slice; roll back the optimization, never the feature"); Gate C = §3 line 52 (demand-open
pass is explicitly a Gate-C hot-path item; "an unknown consumer is skipped" is a stop
condition). FAR-405 spec: `migration_doc/FORK_ARCHITECTURE_REMEDIATION_PLAN_2026-07-13.md:759`
("Pass merging, load/store policy, and transient resources") — C0 is only the bounded
"stop opening a pass nobody draws into" slice, NOT the frame-graph pass-merging work, which
stays gated (see `QUEUE_2026-07-15_CAMPAIGN8.md:146`).

#### The verified premise (do not re-derive, but do re-measure)

The exact C9-05 API lane (1,125 measured frames, moving-altitude route) recorded:

```
runs[0].apiCounters.labels.delta.webgpuRenderPassesBegun["Scene Main Render Pass"]  = 2250
runs[0].apiCounters.labels.delta.webgpuEmptyRenderPasses["Scene Main Render Pass"] = 2250
```

Artifact: `Tools/visual-regression/output/performance/campaign9-c9-05-tpdf-zero-work-api-webgpu-r1-2026-07-15.json`.
Every single "Scene Main Render Pass" (the canvas swap-chain pass) open on the default route is
empty — exactly 2 per frame:

1. **The `beginFrame` open** — `WebGPUContext.beginFrame()` unconditionally calls
   `this._beginDefaultRenderPass()` (`WebGPUContext.ts:1808`), and the very next thing the
   scene renderer does is end it and redirect to the scene framebuffer
   (`WebGPUSceneRendererPassRedirect.ts:139`).
2. **The post-process tail open** — `WebGPUSceneRenderer._runPostProcessing` ends with an
   unconditional `context.resumeDefaultRenderPass?.()` (`WebGPUSceneRenderer.ts:3200`), which
   re-opens the canvas pass; on the default route nothing ever draws into it before
   `context.endFrame()` ends it (`WebGPUContext.ts:2177-2180`).

Total passes/frame on that route was 14.41 (C9-00 seal); removing 2 empty canvas passes/frame
is the target.

---

#### Architecture today (post-Sol, verified)

##### Frame skeleton (normal render frame)

`Scene.js` (backend-agnostic driver):

- `Scene.js:5762` — `context.beginFrame()`
- `Scene.js:5778-5784` — `scene._alternateSceneRenderer.prepareFrame(...)` (WebGPU scene FB
  recreate/HDR/MSAA generation bump; opens NO pass — verified `WebGPUSceneRenderer.ts:1359-1468`)
- `Scene.js:5786` — `scene.updateEnvironment()`
- `Scene.js:5943` — `scene.updateAndExecuteCommands(passState, backgroundColor)`
  - `Scene.js:3604-3605` → `FramebufferOrchestrator.js:23-29` →
    `context.updateAndClearFramebuffers(...)` (WebGPU override at `WebGPUContext.ts:3591`)
    which at `WebGPUContext.ts:3754-3756` executes `scene._clearColorCommand` → `context.clear()`
  - then `ViewportExecutor.executeCommandsInViewport` (`ViewportExecutor.js:107-113`):
    `createPotentiallyVisibleSet` → `executeComputeCommands(scene)` →
    `executeShadowMapCastCommands(scene)` → `executeCommands(scene, passState)` → (opt-in)
    Hi-Z occlusion block (`ViewportExecutor.js:468-501`)
- `Scene.js:5944` — `scene.resolveFramebuffers` (WebGPU override is a no-op returning true,
  `WebGPUContext.ts:3772-3777`)
- `Scene.js:5947` — `executeOverlayCommands(scene, passState)` (`SceneRenderer.js:772-780`,
  iterates `scene._overlayCommandList`)
- `Scene.js:5957` — `context.endFrame()`

##### `WebGPUContext.beginFrame()` — `WebGPUContext.ts:1734-1809`

Does, in order: device-unavailable guard (1735-1748); frame-stat reset incl.
`_clearCallsThisFrame` (1750-1755); `_uniformAllocator.beginFrame()` (1757-1760); idle
aux-culler reap (1766-1769); `createCommandEncoder({label:"Scene Frame Command Encoder"})`
(1771-1774); `_performanceManager?.beginTimestampFrame()` (1780); **swap-view acquisition**
`this._context.getCurrentTexture()` + `createView()` → `_currentTextureView` (1783-1784);
`_ensureDepthTexture()` (1787, body 2235-2283 — canvas-sized `"Scene Depth Texture"`
depth24plus-stencil8 with TEXTURE_BINDING, exposing `depthTextureView` + `depthOnlyTextureView`);
`uniformState.viewport` seed (1800-1805); **`this._beginDefaultRenderPass()` (1808) — the pass
this task defers.**

##### `_beginDefaultRenderPass(clear=true)` — `WebGPUContext.ts:1850-1926`

Opens `label:"Scene Main Render Pass"` targeting `_currentTextureView` +
`_depthTextureView`, `loadOp/depthLoadOp/stencilLoadOp = clear ? "clear" : "load"`,
clear values from `_clearColor` / `_clearDepth` / `_clearStencil`. **`_clearColor` is
`(0,0,0,0)` from the constructor (`WebGPUContext.ts:866`) and is never written anywhere else**
(verified by grep — only 755/866/1881-1884 reference it). Debug-build throw if a pass is
already active (1861-1868). Sets full-canvas viewport + scissor (1912-1925).

`resumeDefaultRenderPass()` (`WebGPUContext.ts:2053-2072`) = end current pass +
`_beginDefaultRenderPass(false)` (loadOp:"load" on ALL channels). `endCurrentRenderPass()`
(2037-2042) is a safe no-op without a pass. `beginRenderPass(descriptor)` (1959-1998) is the
generic custom-pass entry. `hasActiveRenderPass` getter (2126-2128) — **no callers anywhere**
(verified; only the GraphicsContext base getter at `GraphicsContext.ts:1712`).

##### `endFrame()` — `WebGPUContext.ts:2160-2229`

Ends any active pass (2177-2180); `_uniformAllocator?.flush()` (2185 — the FAR-303 staging
flush; audit P0-4 also flushes before mid-frame submits); `_performanceManager?.endFrame`
(2190); `finish()` + `queue.submit` (2193-2194); deferred texture destroy drain (2201-2219);
`_uniformAllocator.endFrame()` (2222-2224); clears `_currentCommandEncoder` and
`_currentTextureView` (2227-2228).

##### The redirect — `WebGPUSceneRendererPassRedirect.ts:122-257`

`setupSceneFramebufferRenderPass(host, context, config)` called from
`WebGPUSceneRenderer.executeCommands` at `WebGPUSceneRenderer.ts:1670`. Branch 1 (happy path,
`_sceneFramebuffer?.colorTarget && config.usePostProcess`): `context.endCurrentRenderPass?.()`
(line 139 — this is what makes the beginFrame pass empty), builds scene-FB attachments
(BUG-3 `sceneFbLoad` handling lines 183-201, MRT slot-1 via `buildMrtSlot1Attachment`),
opens `label:"Scene Framebuffer Render Pass"` via `context.beginRenderPass` (202-222).
Branch 2 (`usePostProcess` true, no scene FB): CRITICAL error log, canvas pass stays open and
receives the draws (244-256). Branch 3 (`usePostProcess` false): nothing — canvas pass stays
open and is the draw target. `environmentState.usePostProcess = !picking` unconditionally on
WebGPU (`WebGPUContext.ts:3644`), so branches 2/3 are startup/degenerate paths, not defaults.

##### `executeCommands` shape — `WebGPUSceneRenderer.ts:1484-1703`

Pick early-return at 1534-1551 (pick frames never touch the canvas pass). **`numFrustums === 0`
early-return at 1575-1577** — on a truly empty scene the redirect never runs, the frustum loop
never runs, post-process never runs; today the beginFrame canvas pass (opened with clear) is
the ONLY canvas producer and is what the user sees. Then: perf-manager `beginFrame` balanced
across 2D halves via `!config.sceneFbLoad` (1630-1643); `_dispatchClusteredLighting` (1652);
shadow cast (1656-1660); redirect (1670); `resetPerFrameState` (1674 — no pass interaction,
verified); depth-plane ring reserve + frustum loop (1680-1681); post-frustum chain gated on
`!config.deferComposite` (1694-1702).

##### The post-frustum tail — `WebGPUSceneRendererPostFrustumChain.ts:82-316`

Order: `_executeOverlayPass` (line 89 — the Pass.OVERLAY commands in frustum bucket 0; draws
into the still-open **scene-FB** pass, `WebGPUSceneRenderer.ts:2397-2414` — NOT the canvas);
depth plane (92-94); MSAA depth resolve (108-121); `_executeGBufferProducer` (143; its body
ends with `context.resumeDefaultRenderPass?.()` at `WebGPUSceneRenderer.ts:2652` — only runs
when `useDeferredLighting`); `_runInvertClassificationComposite` (165; tail resume at
`WebGPUSceneRenderer.ts:2764` — only when invertClassification on); `_runVelocityPass` (177);
`_executeBoundingVolumeDebugPass` (185); **`_runPostProcessing` (200)**; post-PP snapshot copy
gated on any env effect enabled (222-285, uses `getCurrentTexture()` + `copyTextureToTexture`);
`_executeEnvironmentalEffects` (305); `context._sceneHasTransmission = false` (315).

##### `_runPostProcessing` — `WebGPUSceneRenderer.ts:3042-3201`

Debug-overlay overrides first (depth 3055-3058, G-buffer 3065-3071, frustum/commands
3081-3088 — each of those methods writes `targetView = context.currentTextureView` through its
own passes and tail-resumes: resumes at 3237, 3278, 3335, 3349, 3391, 3427). Production path:
`context.endCurrentRenderPass?.()` (3106); `sourceView` = scene FB color, `targetView =
context.currentTextureView` (3113); `this._postProcess.execute(encoder, sourceView, targetView,
depthView, sceneColorTexture, motionView, gBufferNormalView)` (3183-3191) — **the PP pipeline
writes the canvas through raw `encoder.beginRenderPass` calls inside
`WebGPUPostProcessPipeline`, NOT through context pass helpers, so the context cannot see that
the canvas was written**; then the unconditional `context.resumeDefaultRenderPass?.()` (3200)
— empty pass #2.

##### `clear()` and its label-inference guard — `WebGPUContext.ts:3209-3367`

`clear(clearCommand, passState)`: loop guard `_clearCallsThisFrame > 50` (3233-3245);
wantColor/Depth/Stencil (3249-3254); **the guard this task must replace**: reads
`_currentRenderPassEncoder?.label` and early-returns when it `startsWith("Scene")`
(3263-3273) — this string test matches BOTH "Scene Main Render Pass" (canvas) and
"Scene Framebuffer Render Pass" (scene FB), and is the "label inference" the queue row bans.
Past the guard it ends the active pass and opens `label:"ClearCommand Render Pass"` targeting
`passState.framebuffer ?? cmd.framebuffer` views, falling back to `_currentTextureView` +
`_depthTextureView` (3287-3302). On today's default frame the background
`scene._clearColorCommand` (executed at `WebGPUContext.ts:3756`) hits the guard while
"Scene Main Render Pass" is active and is a NO-OP — the canvas clear actually comes from
the beginFrame pass's `loadOp:"clear"` with `_clearColor=(0,0,0,0)`.

##### Every consumer of the canvas pass / swap view (the acceptance list, mapped)

| # | Consumer (ledger acceptance term) | Where it consumes | What it actually needs |
|---|---|---|---|
| 1 | Empty-scene background clear | `WebGPUSceneRenderer.ts:1575-1577` early return; beginFrame pass is sole producer | A cleared, presented canvas ((0,0,0,0) + depth 1.0) even when zero commands render |
| 2 | Legacy overlays (`scene._overlayCommandList`) | `Scene.js:5947` → `SceneRenderer.js:772-780` → `command.execute` → for WebGPU commands ultimately `WebGPUContext.executeDrawCommand` (`WebGPUContext.ts:3408-3422`) which **silently returns if no pass is active** | An open canvas pass at overlay time — today provided by the PP tail resume (3200) |
| 3 | Frustum-bucket OVERLAY pass | `WebGPUSceneRenderer.ts:2397-2414` via PostFrustumChain:89 | Scene-FB pass (NOT canvas) — must not be confused with #2 |
| 4 | TAA / post-process blit | `_runPostProcessing` 3106-3200; PP writes `targetView` (3113) via its own encoder passes | Swap view acquired + encoder; needs NO pre-open canvas pass (it ends whatever is active first) |
| 5 | Env effects: weather, procedural clouds, NPR, contact shadows, SSR, volumetric/ground fog | `WebGPUSceneRendererEnvironmentalEffects.ts:174-186` (`outputView = context.currentTextureView`), per-effect `endCurrentRenderPass` + FR execute + `resumeDefaultRenderPass` pairs (202-217, 240-253, 289-295, 345-348, 388, 440-443) | Swap view + eager resume return value (line 388 uses the returned encoder) — keep these sites EAGER |
| 6 | Post-PP snapshot copy | PostFrustumChain 256-285 (`getCurrentTexture()` + copy) | Swap TEXTURE + no active pass; unaffected |
| 7 | Request-render mode | `Scene.js` render cadence; beginFrame/endFrame only run on rendered frames | Every rendered frame must present defined pixels; skipped frames present nothing (no `getCurrentTexture` call) |
| 8 | 2D halves (BUG-3 infinite-scroll wrap) | `ViewportExecutor.js:429-452` sets `_exec2DSceneFbLoad`/`_exec2DDeferComposite`; `WebGPUSceneRenderer.ts:1630-1643,1694` balance perf begin/end; redirect loadOp handling `PassRedirect.ts:183-201` | One beginFrame + one endFrame per frame; first half leaves scene-FB pass open — `endCurrentRenderPass` no-op tolerance must hold |
| 9 | Pick mini-frames | `beginPickFrame` (`WebGPUContext.ts:1826-1841`) — creates encoder only, **never acquires swap view, never opens canvas pass**; shared `endFrame` finishes it (`WebGPUSceneRendererPickPass.ts:326` context) | endFrame must not fabricate a canvas pass when `_currentTextureView === null` |
| 10 | Resize / recovery | `resize()` → `_applyCanvasConfig` (3372-3381); `_ensureDepthTexture` (2235-2283); device-loss guards (1735-1748, 2161-2174) | Keep `_ensureDepthTexture` in beginFrame (depth texture feeds the canvas pass AND `depthOnlyTextureView` consumers) |
| 11 | OIT | `WebGPUSceneRendererTranslucentPass.ts:258-278` — accumulation pass ends, composite into scene color, then `resumeDefaultRenderPass?.()` (273) + deferred splats drawn inline (277) | Do NOT touch in this slice (see Traps #8) |
| 12 | Shadows (cast) | `WebGPUContext.executeShadowMapCastCommands` — `endCurrentRenderPass()` at 3541, cast, `resumeDefaultRenderPass()` at 3581, runs BEFORE the redirect (`WebGPUSceneRenderer.ts:1656` vs 1670) | Behavior-preserving; optional follow-on conversion (Walkthrough step 8) |
| 13 | Clustered lighting | `WebGPUSceneRendererClusteredLighting.ts:183-194` (end + resume-on-no-encoder), 315, 379 (tail resumes); dispatched at `WebGPUSceneRenderer.ts:1652`, also pre-redirect | Same as #12 |
| 14 | Hi-Z occlusion (opt-in) | `ViewportExecutor.js:468-501` — uses `context.depthOnlyTextureView` (the CONTEXT canvas depth texture) + `resumeDefaultRenderPass()` at 498 | Backend-agnostic Scene file — do not touch in this slice |
| 15 | ClearCommands | `WebGPUContext.clear` 3209-3367; background clear via `updateAndClearFramebuffers` 3754-3756; OIT/globe-depth clears pass explicit framebuffers | Explicit-FB clears unaffected; default-FB clear semantics must be preserved exactly (see Invariant 6) |
| 16 | Debug overlays (depth/G-buffer/frustum tint) | `WebGPUSceneRenderer.ts:3210-3441` — write `context.currentTextureView` via own passes, tail resumes at 3237/3278/3335/3349/3391/3427 | Must mark canvas-written so the fallback/first-open logic sees them |
| 17 | Presentation itself | `getCurrentTexture()` at beginFrame 1783 enrolls the canvas for presentation this frame | An acquired-but-never-written swap texture presents ZEROS (WebGPU zero-init) — something must write it every rendered frame |

---

#### Target design + invariants

The safe boundary from the ledger row (line 126), expanded into numbered invariants:

1. **`beginFrame` keeps everything except the pass open.** Stats reset, uniform-allocator
   `beginFrame`, culler reap, command-encoder creation, `beginTimestampFrame`,
   `getCurrentTexture()` + `_currentTextureView`, `_ensureDepthTexture()`, and the
   `uniformState.viewport` seed all stay exactly where they are (`WebGPUContext.ts:1734-1805`).
   Only line 1808 (`this._beginDefaultRenderPass();`) is removed. Swap-view acquisition stays
   eager — the presentation cadence and every `currentTextureView` consumer are unchanged.
2. **Explicit pass-target tracking, never label inference.** New private context state, reset
   in `beginFrame` (and `beginPickFrame`):
   - `_activePassTarget: "default-canvas" | "scene-framebuffer" | "external" | null` —
     maintained by `_beginDefaultRenderPass` ("default-canvas"), by `beginRenderPass`
     ("external" by default; "scene-framebuffer" when the caller declares it), and nulled by
     every `.end()` site (`endCurrentRenderPass`, `endFrame`, `clear`, `_beginDefaultRenderPass`,
     `beginRenderPass` — all the places that write `_currentRenderPassEncoder = null`).
   - Declare the scene-FB target at the three scene-pass open sites:
     `WebGPUSceneRendererPassRedirect.ts:208`, `WebGPUSceneRenderer.ts:1941`
     (`_resumeScenePass`), `WebGPUSceneRenderer.ts:2017` (`_clearDepthStencil`). Do it by adding
     an optional second parameter to `beginRenderPass(descriptor, target?: PassTarget)` — the
     dozens of other `beginRenderPass` callers keep the one-arg form and get "external".
   - Replace the `clear()` guard at `WebGPUContext.ts:3268-3273`: early-return when
     `_activePassTarget === "scene-framebuffer" || _activePassTarget === "default-canvas"`
     (identical outcome to today's `startsWith("Scene")` for all live labels — verified: the
     only live pass labels beginning with "Scene" are exactly those two).
3. **Demand flags.** Two per-frame booleans on the context, reset false in `beginFrame`:
   - `_canvasColorTouchedThisFrame` — set when `_beginDefaultRenderPass` opens (its store
     defines canvas content), when `clear()` targets the canvas color view, and when
     `markCanvasContentWritten()` (new public method) is called.
   - `_canvasDepthTouchedThisFrame` — set when `_beginDefaultRenderPass` opens and when
     `clear()` clears the context depth view.
4. **First-open-clears rule.** `_beginDefaultRenderPass` derives its load ops from the flags
   instead of the `clear` boolean parameter:
   `colorLoadOp = _canvasColorTouchedThisFrame ? "load" : "clear"`;
   `depthLoadOp/stencilLoadOp = _canvasDepthTouchedThisFrame ? "load" : "clear"`.
   This is what keeps bytes identical: today's frame always clears these channels exactly once
   (at beginFrame) and loads thereafter; the new scheme clears each channel exactly once at its
   first actual open, whenever that is. Remove or ignore the `clear` parameter (both current
   callers — beginFrame gone, `resumeDefaultRenderPass:2069` passing `false` — are subsumed).
   **Depth is the load-bearing half**: an untouched `"Scene Depth Texture"` read with
   `depthLoadOp:"load"` yields WebGPU lazy-zero 0.0, not the historical clear value 1.0 —
   depth-tested canvas draws would all fail. Color is benign (`_clearColor` is (0,0,0,0),
   byte-identical to zero-init) but keep the same rule for symmetry and for any future nonzero
   `_clearColor`.
5. **PP and debug overlays mark the canvas written.** Add
   `markCanvasContentWritten(): void` to `WebGPUContext` (sets `_canvasColorTouchedThisFrame`).
   Call it in `_runPostProcessing` immediately after `this._postProcess.execute(...)`
   (`WebGPUSceneRenderer.ts:3191`) and at the end of each debug-overlay execute
   (`_executeDebugDepthOverlay`, `_executeDebugGBufferOverlay`, `_executeDebugFrustumOverlay`)
   after their pass writes. These are the only canvas writers that bypass context pass helpers
   on the render path (env effects always run after PP, so the flag is already set for them).
6. **Deferred background clear.** In `clear()`, when the requested target resolves to the
   canvas (`fb` undefined and `colorView === _currentTextureView`) AND no pass is active AND
   `_canvasColorTouchedThisFrame` is false: return early — the pending first-open clear (or the
   endFrame fallback) delivers the same `(0,0,0,0)`/1.0/0 clear. This reproduces today's
   behavior where the background `_clearColorCommand` is swallowed by the label guard. Do NOT
   copy `cmd.color` into `_clearColor` in this slice — that would change empty-scene bytes from
   transparent black to the scene background color (a real parity improvement vs WebGL, but a
   behavior change; ledger it as a candidate follow-on instead, see Walkthrough step 9).
7. **`_runPostProcessing` tail resume becomes demand-driven.** Delete the unconditional
   `context.resumeDefaultRenderPass?.()` at `WebGPUSceneRenderer.ts:3200`. The downstream
   consumers already self-manage (snapshot copy ends passes; env effects end+resume around
   themselves), except legacy overlay commands — covered by invariant 8.
8. **Lazy open on draw demand.** In `WebGPUContext.executeDrawCommand`
   (`WebGPUContext.ts:3408-3422`): when `command.isWebGPUDrawCommand === true`, there is no
   active pass, an encoder and `_currentTextureView` exist — call `resumeDefaultRenderPass()`
   and execute into it. This is the demand-open for `executeOverlayCommands`
   (`Scene.js:5947`) and preserves today's semantics exactly (today those commands land in the
   PP-tail-resumed canvas pass). Commands that are not WebGPU draw commands keep the silent
   skip.
9. **endFrame present fallback.** In `endFrame()` after ending any active pass
   (`WebGPUContext.ts:2180`) and before `_uniformAllocator?.flush()`: if
   `_currentTextureView !== null && !_canvasColorTouchedThisFrame` → call
   `_beginDefaultRenderPass()` (which clears by invariant 4) and immediately end it. This is
   the deferred empty-scene clear/present: the ONLY frames that pay it are frames where nothing
   else touched the canvas (empty scene, PP missing, exception-truncated frames). Pick
   mini-frames are naturally excluded (`beginPickFrame` never sets `_currentTextureView`).
   Give this open a distinct label (e.g. `"Canvas Demand Clear Pass"`) ONLY if you keep the
   label plumbed through `_beginDefaultRenderPass`; nothing in live code matches the literal
   "Scene Main Render Pass" string (verified — only `WebGPUContext.ts:1876,1907` plus comments),
   so a distinct label is safe and makes the API-lane evidence self-describing. If in doubt,
   keep "Scene Main Render Pass".
10. **No feature may be weakened.** All of: empty-scene visible clear, overlay list draws,
    debug overlays, env effects/weather output, TAA, request-render, 2D halves, pick, OIT,
    shadows, clustered lighting, resize/loss recovery — must be provably unchanged (rule 1 /
    Gate C stop condition). Counters/tests added stay after landing (rule 6).

---

#### Implementation walkthrough

Work in a worktree; one slice, one commit family. All edits in
`packages/engine/Source/Renderer/WebGPU/` (canonical tree — never edit root `Source/`).

**Step 0 — pre-change baseline (mandatory).** Build the current tree (`npx gulp build`) and
run BOTH lanes of the verification recipe below, saving artifacts with a `-PRECHANGE-BASELINE`
suffix (mirror the Batch-672 convention). Also capture the empty-scene PNG (probe below).
Without this you cannot prove byte-identity later. If the API lane does NOT show
`webgpuEmptyRenderPasses["Scene Main Render Pass"] == 2/frame`, **STOP** — the premise moved
(someone else landed C9-07 or refactored beginFrame); re-read the ledger row and mark blocked.

**Step 1 — context state + explicit target tracking.** In `WebGPUContext.ts`:
add `_activePassTarget`, `_canvasColorTouchedThisFrame`, `_canvasDepthTouchedThisFrame`,
`markCanvasContentWritten()`. Reset flags in `beginFrame` (near line 1750-1755) and
`beginPickFrame` (1826-1841). Extend `beginRenderPass` with the optional target parameter
(default "external"); set/clear `_activePassTarget` at every `_currentRenderPassEncoder`
write/null site: 1870-1873, 1903, 1986-1988, 1992, 2038-2041, 2063-2066, 2177-2180,
2829-2831 (the readPixels-area end site), 3276-3279, 3344. Use Grep for
`_currentRenderPassEncoder =` to catch them all — there are also assignment sites inside
`clear()` (3344) and the readPixels helper (2829); any site you miss leaves a stale target and
breaks the clear() guard.

**Step 2 — declare scene-FB target at the three scene-pass opens.**
`WebGPUSceneRendererPassRedirect.ts:208`, `WebGPUSceneRenderer.ts:1941`, `:2017` —
`context.beginRenderPass(passDesc, "scene-framebuffer")`. Then replace the label guard in
`clear()` (3263-3273) with the target check (Invariant 2) and add the deferred-canvas-clear
early return (Invariant 6). Update the comment block — it documents the old label hazard.

**Step 3 — first-open-clears in `_beginDefaultRenderPass`.** Replace the `clear` parameter
logic (1886, 1894, 1897) with flag-derived load ops; set both flags + `_activePassTarget`
after opening. `resumeDefaultRenderPass` (2053-2072) keeps its public signature and simply
calls `_beginDefaultRenderPass()`.

**Step 4 — defer the beginFrame open.** Delete line 1808. Update the beginFrame JSDoc
(1714-1733) — it documents "creates command encoder + default canvas render pass"; rewrite to
"creates command encoder + acquires swap view; the canvas pass opens on first demand".

**Step 5 — endFrame fallback** (Invariant 9). Insert after 2177-2180.

**Step 6 — PP tail + markers.** Delete `WebGPUSceneRenderer.ts:3200`; add
`context.markCanvasContentWritten()` after 3191 (inside the `if (encoder && sourceView &&
targetView)` block only — the warn branch at 3192-3197 writes nothing). Add the marker to the
three debug overlay methods after their passes write `targetView`. LEAVE their tail resumes
(3237, 3278, 3335, 3349, 3391, 3427) in place — they now open a load-load canvas pass exactly
as today (flags are set by then). Optionally convert them to nothing later; not this slice's
route.

**Step 7 — lazy overlay open** (Invariant 8) in `executeDrawCommand` (3408-3422).

**Step 8 — DECISION POINT (optional, only if the API lane still shows empty canvas passes on
shadow/clustered routes and you have time):** the pre-redirect resumes at
`WebGPUContext.ts:3581` (shadow) and `WebGPUSceneRendererClusteredLighting.ts:192/315/379`
still open a canvas pass that the redirect then ends. On the DEFAULT route these never run, so
Gate-C acceptance does not require touching them. If you convert them, each conversion needs
its own enabled-feature probe (shadows on / clustered lights on) proving output-identical
frames. If any probe disagrees, revert that call-site conversion only and note it in the
ledger row. Do NOT touch `ViewportExecutor.js:498` (backend-agnostic Scene file, opt-in
Hi-Z feature) or `WebGPUSceneRendererTranslucentPass.ts:273` (see Traps #8) in this slice.

**Step 9 — surface, don't fix, the two latent findings you will trip over** (Principle 9 —
add rows/notes to the ledger, no code change here):
- `RenderCommand.js:342-347` (`_executeWebGPU`) reads `context._currentRenderPass`, a
  property that does not exist on `WebGPUContext` (it is `_currentRenderPassEncoder`) — the
  immediate-mode RenderCommand overlay path is latently broken independent of this task.
- Empty-scene canvas bytes are `(0,0,0,0)` (context `_clearColor` is never fed
  `scene.backgroundColor`) — WebGL parity gap; candidate follow-on, do not change here.
- `WebGPUSceneRendererTranslucentPass.ts:273-277`: after OIT composite it resumes the
  DEFAULT (canvas) pass and draws deferred splats inline there, mid-frustum-loop; those
  draws are later overwritten by the PP blit. Comment claims "resumed scene pass". Likely a
  latent visibility bug for splats+OIT scenes — needs its own probe before any fix.

**Step 10 — docs.** Update the ledger row (`QUEUE_2026-07-15_CAMPAIGN9.md` §3.2 line 126)
with status + evidence; add a WEBGPU_DEBUGGING_LOG entry if any bug was found/fixed;
note in `migration_doc/FORK_ARCHITECTURE_REMEDIATION_LEDGER_2026-07-13.json` that FAR-405-C0
landed (the ledger key at line 436).

---

#### Traps for the unwary

1. **Depth lazy-zero vs clear-to-1.0.** The single most likely way to "pass the probe, break
   the feature": if the first canvas-pass open of a frame uses `depthLoadOp:"load"` (today's
   `resumeDefaultRenderPass` behavior), an untouched depth texture reads 0.0 and every
   depth-tested canvas draw fails. Historical behavior is depth=1.0 from the beginFrame clear.
   Invariant 4 exists for this; do not "simplify" it away.
2. **PP writes the canvas invisibly.** `WebGPUPostProcessPipeline.execute` uses raw
   `encoder.beginRenderPass` — the context's flags CANNOT be derived from context pass helpers
   alone. Miss the `markCanvasContentWritten()` call and the endFrame fallback will CLEAR THE
   CANVAS AFTER post-process every frame → solid black output that still passes "no validation
   errors". Equally, a first `_beginDefaultRenderPass` open after PP without the marker would
   use `colorLoadOp:"clear"` and wipe the blit.
3. **The debug throw in `_beginDefaultRenderPass` (1861-1868).** The endFrame fallback and the
   lazy overlay open must only run when no pass is active. In debug builds any mistake here
   throws with a useful stack; in release it silently ends the orphan — so test in the
   UNMINIFIED debug build (`Build/CesiumUnminified`, which the dev server and probes use) to
   catch it loudly.
4. **`clear()`'s guard consumed more than the background clear.** Any third-party/scene
   ClearCommand with no framebuffer, arriving while the scene-FB pass is open, is swallowed by
   the guard today. The target-based guard must swallow exactly the same set — that is why the
   guard keeps BOTH "scene-framebuffer" AND "default-canvas" as early-return targets. If you
   only early-return on scene-framebuffer, a mid-frame default-FB ClearCommand would tear down
   the scene pass (the exact all-black failure mode documented at 3263-3267).
5. **Pick frames.** `beginPickFrame` (1826-1841) sets no `_currentTextureView`. The endFrame
   fallback MUST be gated on `_currentTextureView !== null` or every `scene.pick()` submits a
   bogus canvas pass — and worse, `getCurrentTexture()` is not even valid there. Also do not
   reset the canvas flags in `endFrame`; reset them in `beginFrame`/`beginPickFrame` only, so
   a pick mini-frame between render frames cannot corrupt the next render frame's state.
6. **2D wrap halves (BUG-3).** One `beginFrame`/`endFrame` pair spans TWO `executeCommands`
   calls (`ViewportExecutor.js:429-452`, `WebGPUSceneRenderer.ts:1630-1643`). The first half
   leaves the scene-FB pass open on purpose. Your `_activePassTarget` is per-context state and
   survives between the calls — do not reset it anywhere except pass transitions. Run
   `probe-2d-cv-modes.mjs` to prove the wrap still accumulates.
7. **`numFrustums === 0` is not the only empty producer.** Exceptions caught by
   `tryAndCatchError` (`Scene.js:5960-5964`) can truncate a frame after beginFrame; the redirect
   branch-2 error path draws to the canvas directly; `usePostProcess=false` (branch 3) is
   reachable by future callers even though `WebGPUContext.ts:3644` pins it true today. The
   endFrame fallback covers all of these uniformly — do not special-case `numFrustums`.
8. **Do not "fix" the OIT resume at `WebGPUSceneRendererTranslucentPass.ts:273`.** It looks
   obviously wrong (canvas pass mid-frustum-loop) and an expert would itch to redirect it to
   `_resumeScenePass`. That is a behavior change to an enabled feature (deferred Gaussian
   splats under OIT) with its own oracle needs — out of slice, ledger it (Step 9).
9. **Label strings in tooling.** The API lane buckets by pass label
   (`run-performance-campaign.mjs:1126-1155`). If you add a new fallback label, the acceptance
   assertion changes shape (a new label appears on empty-scene workloads only). Historical
   artifacts keyed on "Scene Main Render Pass" remain valid — never rewrite them.
10. **Don't let the redirect's `endCurrentRenderPass` disappear.** `PassRedirect.ts:139` is
    now usually a no-op (no pass open at redirect time) but it is load-bearing for branch-2/
    error frames and for the second 2D half. Leave it.
11. **`_ensureDepthTexture` must stay in beginFrame.** Even with the pass deferred, the depth
    texture backs `depthOnlyTextureView` (Hi-Z at `ViewportExecutor.js:471`) and must track
    canvas size before any consumer runs. Removing it "because the pass is gone" recreates the
    C-R8 class of scaffolding removals (CLAUDE.md Principle 7).
12. **TypeScript `any` ban + pragma rules apply.** New fields/methods need real types; any new
    diagnostic logging goes inside `//>>includeStart('debug', pragmas.debug)` blocks; keep the
    permanent null-target/loop sentinels intact (`_clearCallsThisFrame` etc.).

---

#### Verification recipe

Prereqs: `npx tsc --noEmit` clean; `npx gulp build` clean; local server (`npm run restart` or
`node server.js`); Edge (never Playwright Firefox).

1. **API lane (the acceptance number).**
   `node Tools/visual-regression/run-performance-campaign.mjs --renderer webgpu --workload moving-camera-altitude-track-3d --api-instrumentation --output Tools/visual-regression/output/performance/campaign9-c9-07-demand-canvas-api-webgpu-r1-<date>.json`
   PASS =
   - `runs[*].apiCounters.labels.delta.webgpuRenderPassesBegun["Scene Main Render Pass"]` is 0
     (pre-change: 2,250 per 1,125-frame window) and no new empty-pass label replaces it —
     `webgpuEmptyRenderPasses` delta total drops by ~2×frames vs your Step-0 baseline;
   - total render passes/frame ≈ baseline − 2 (baseline seal: 14.41/frame);
   - all eight altitude segments complete, zero page/device errors (the runner asserts this).
2. **Clean lane (timing, secondary).** Same command without `--api-instrumentation`, plus
   `--renderer both`. Compare WebGPU CPU p95 to the most recent clean reference (C9-05 clean r1:
   7.08 ms; seal: 7.51 ms). Requirement is NO regression; a single r1 improvement is
   characterization, not a campaign-level claim (C9-05 row precedent).
3. **Byte/visual gates.**
   - `node Tools/visual-regression/capture-and-diff.mjs` — full scene suite vs baselines; no
     new mismatches.
   - Write `Tools/visual-regression/probe-demand-canvas-pass.mjs` (template:
     `probe-saved-view.mjs`) covering, in one browser session per case, WebGL vs WebGPU where
     applicable: (a) default globe view; (b) **empty scene** — `new Viewer` with
     `globe:false, skyBox:false, skyAtmosphere:false` and sun/moon hidden, assert canvas pixels
     byte-equal to the Step-0 pre-change capture (expected (0,0,0,0)); (c) **overlay** — a
     scene that pushes a WebGPU overlay command (if no public path exercises
     `_overlayCommandList` on WebGPU, record that as evidence that consumer #2 is vacuously
     safe and rely on the lazy-open unit path); (d) **request-render** —
     `requestRenderMode:true`, assert the canvas retains the last frame between renders and
     updates after `scene.requestRender()`; (e) **resize** mid-run; (f) debug overlays —
     `CesiumDebug.showDepth()`, `showFrustums()` produce non-black output.
   - Existing regression probes (all must PASS both backends where dual):
     `probe-2d-cv-modes.mjs` (2D halves), `probe-taa-jitter.mjs` (TAA),
     `probe-pickposition-webgpu.mjs` + `probe-point-pick-webgpu.mjs` (pick mini-frames),
     `probe-collections-regression.mjs`, and the split-screen page
     (`Apps/WebGPUTest/split-screen-comparison.html`) loads clean.
   - If Step 8 was taken: a shadows-on probe and a clustered-lights-on probe with
     before/after image equality.
4. **Read the PNGs yourself** (CLAUDE.md Principle 8) — especially the empty-scene and
   request-render captures; a black canvas with zero console errors is this task's signature
   failure and only the pixels catch it.
5. **Unit/spec layer.** Add focused specs (Karma via
   `gulp test --workspace engine --browsers=EdgeHeadlessCI --includeName "<spec>"` after
   `npm run build --workspace @cesium/engine` — remember `NEW-WORKSPACE-SPEC-BUNDLE-FRESHNESS`:
   build the exact served bundle first) asserting: first `_beginDefaultRenderPass` of a frame
   clears, subsequent open loads; endFrame fallback fires on untouched canvas and not on pick
   frames; `clear()` target-guard parity.
6. **`node Tools/variant-smoke-test.mjs`** if you touched anything import-shaped (you should
   not have).

Evidence artifact naming: `campaign9-c9-07-demand-canvas-{api,clean}-webgpu-r1-<date>.json`
plus probe PNGs, referenced from the ledger row.

#### Rollback boundary

Roll back the **optimization, never the feature** (rule 6). The revert unit is the whole
demand-open slice: restore `beginFrame`'s unconditional `_beginDefaultRenderPass()` call
(`WebGPUContext.ts:1808`), restore the PP tail resume (`WebGPUSceneRenderer.ts:3200`), and
drop the endFrame fallback + lazy overlay open. Post-process, presentation, overlays, env
effects, pick, OIT, shadows are features — none of them may be disabled, contained, or
"temporarily" skipped to make a gate pass. The explicit pass-target tracking (Invariants 2 /
Steps 1-2) is a correctness cleanup independent of the timing win; if the perf gate fails but
the tracking is green under the full probe set, prefer splitting: land tracking as its own
byte-identical slice, revert only the deferral. Any Step-8 call-site conversion is
independently revertible per site. Keep new specs and counters in-tree regardless of outcome,
and record the failed/partial state honestly in the §3.2 ledger row (vocabulary:
PARTIAL / PAUSED or BLOCKED — never silently drop the row).

#### Pointers

- **Task rows / rules**: `migration_doc/QUEUE_2026-07-15_CAMPAIGN9.md` — §1 rules (22-35),
  Gate C (52), coverage row (76), Wave-2 item 24 (198), live ledger row (126).
- **Plan**: `migration_doc/FORK_PERFORMANCE_RTE_VISIBILITY_REMEDIATION_PLAN_2026-07-15.md`
  — finding 8 (66-68), WS2 "Lazily open the canvas render pass" (174).
- **FAR spec**: `migration_doc/FORK_ARCHITECTURE_REMEDIATION_PLAN_2026-07-13.md:759`
  (FAR-405); ledger JSON key `FORK_ARCHITECTURE_REMEDIATION_LEDGER_2026-07-13.json:436`;
  prior prep evidence `FORK_PERFORMANCE_AUDIT_AND_FIX_RESULTS_2026-07-14.md:147`.
- **Audit**: `migration_doc/SOL_AUDIT_REPORT_2026-07-16.md` — Appendix B confirms the C9-07
  NOT-STARTED status and the queue order (§ item 6, line 167: C9-07 after the pick-format
  closure and the `contains()` quick win — both landed as Batches 671/672).
- **Source (all `packages/engine/Source/`)**: `Renderer/WebGPU/WebGPUContext.ts`
  (beginFrame 1734, _beginDefaultRenderPass 1850, beginPickFrame 1826, resume 2053,
  endFrame 2160, clear 3209, executeDrawCommand 3408, shadow cast 3446-3585,
  updateAndClearFramebuffers 3591); `Renderer/WebGPU/WebGPUSceneRendererPassRedirect.ts`;
  `Renderer/WebGPU/WebGPUSceneRenderer.ts` (executeCommands 1484, _resumeScenePass 1900,
  _clearDepthStencil 1966, overlay pass 2397, _runPostProcessing 3042, debug overlays 3210+);
  `Renderer/WebGPU/WebGPUSceneRendererPostFrustumChain.ts`;
  `Renderer/WebGPU/WebGPUSceneRendererEnvironmentalEffects.ts`;
  `Renderer/WebGPU/WebGPUSceneRendererClusteredLighting.ts`;
  `Renderer/WebGPU/WebGPUSceneRendererTranslucentPass.ts:273`;
  `Scene/Scene.js` (5762/5943/5947/5957, 3604), `Scene/SceneRenderer.js:772`,
  `Scene/ViewportExecutor.js:429-501`, `Scene/FramebufferOrchestrator.js:23`.
- **Probes/lanes**: `Tools/visual-regression/run-performance-campaign.mjs` (API wrappers
  1100-1235: `webgpuRenderPassesBegun`/`webgpuEmptyRenderPasses` by label), workload id
  `moving-camera-altitude-track-3d` in `performance-workloads.json`;
  `capture-and-diff.mjs`; `probe-saved-view.mjs` (template); `probe-2d-cv-modes.mjs`;
  `probe-taa-jitter.mjs`; `probe-pickposition-webgpu.mjs`; `probe-point-pick-webgpu.mjs`;
  `probe-collections-regression.mjs`.
- **Premise artifact**: `Tools/visual-regression/output/performance/campaign9-c9-05-tpdf-zero-work-api-webgpu-r1-2026-07-15.json`
  (`runs[0].apiCounters.labels.delta.*["Scene Main Render Pass"] = 2250`).
- **Debugging**: `migration_doc/DEBUGGING_GUIDE.md` (moving-altitude campaign, CesiumDebug
  catalog — `CesiumDebug.postProcess()`, `canvasPixels()`, `pipelineStatus()` are the fastest
  live checks when the canvas goes black).

---

<a id="g4"></a>

## G4 — C9-08-SCHEDULER-OCTREE-DEMAND-AND-PERSISTENCE + C9-18-HOTPATH-DIAGNOSTIC-DEMAND-GATES

**Queue rows (verify against the live ledger before starting):**
`migration_doc/QUEUE_2026-07-15_CAMPAIGN9.md` line 199 (Wave 2 item 25, C9-08, risk R1/R2) and
line 209 (Wave 2 item 34, C9-18, risk R1). Investigation coverage rows: lines 77–78.
Ledger rules: §3.2 (lines 94–107) — any task not in the ledger is NOT STARTED; you MUST add a
ledger row when you start, and update it when you complete/pause/block.

**Read before touching code:** QUEUE §1 rules (lines 22–36), the plan's architecture section
(`migration_doc/FORK_PERFORMANCE_RTE_VISIBILITY_REMEDIATION_PLAN_2026-07-15.md` §4, esp. §4.1
visibility ownership, and §3 invariants), and `migration_doc/SOL_AUDIT_REPORT_2026-07-16.md`
(item 12 of the ratings table — the C9-01 counters — and Appendix C's "runtime-gated C9-01
counters are soft deviations" note). CLAUDE.md "Logging & Debug Pragmas" section is the
normative standard for C9-18.

**All line anchors below were verified against the post-Batch-672 tree on 2026-07-16.**
Campaign 9 is executing concurrently — RE-VERIFY every anchor with Grep before editing. If a
symbol has moved but exists, update your local notes and continue. If a symbol is GONE
(not renamed — gone), STOP and mark the task BLOCKED in the ledger with what you found.

---

### Architecture today (post-Sol, verified)

#### The scheduler containment state (FAR-003, already landed)

`RenderScheduler` (`packages/engine/Source/Scene/RenderScheduler.js`, 579 lines) is the
fork-added "overarching sort manager". Its **duplicate bin/sort stream is contained off**
(`enabled` defaults `false`, line 31) but **force-reachable** for characterization — this is
deliberate FAR-003 containment, ratified in the plan (see
`FORK_ARCHITECTURE_REMEDIATION_PLAN_2026-07-13.md` lines 440–444: "Extract stable material-ID
assignment from RenderScheduler and disable its unconsumed bin/sort work"; its eventual
retire/adapt disposition is **FAR-504**, line 845 — Wave 6 gated tail, NOT this task).

Construction and per-frame wiring:

- `Scene.js:460` — `this._renderScheduler = new RenderScheduler();` (every Scene, both backends).
- `Scene.js:462-465` — SORT-11: `octree.rootHalfExtent = this._ellipsoid.maximumRadius * 1.1`.
- `Scene.js:471-474` — FAR-003 `setGpuCullingHint("never")` published before first frame.
- `Scene.js:4042` — `this._renderScheduler.beginFrame()` every `Scene.render()` (resets 6 stat
  fields; the bucket reset at `RenderScheduler.js:101-103` is already gated on `enabled`).
- `Scene.js:3203-3205` — public getter `scene.renderScheduler`.
- `Scene.js:2000-2014` — `getDebugSnapshot().containment.renderScheduler` block. NOTE line 2003
  hardcodes `capable: true` — that one-liner is owned by ledger item 87
  (`NEW-DEBUG-SNAPSHOT-RENDERSCHEDULER-CAPABLE`); fix it in this slice ONLY if you also mark
  item 87 complete in the ledger (it is a one-line `defined(this._renderScheduler)` derivation).

#### What zero-work-at-defaults still costs — the exact sites C9-08 must gate

1. **`ViewportExecutor.js:368-383`** (`packages/engine/Source/Scene/ViewportExecutor.js`,
   function `executeCommandsInViewport`). The default (disabled) branch runs
   `scheduler.assignMaterialSortIds(cmdList)` — a **linear walk of the entire commandList on
   every viewport execution of every rendered frame**, calling
   `MaterialSortIdAllocator.ensureMaterialSortId` (`MaterialSortIdAllocator.js:134-138`) per
   command plus a stats increment per command (`RenderScheduler.js:120-130`). This runs again
   for the second half of a 2D wrap split (`execute2DViewportCommands` calls
   `executeCommandsInViewport` twice) and again on pick frames. This is the row-77 "material-sort
   maintenance when no consumer needs it" finding.
2. **`Scene.js:4042`** — `beginFrame()` stat resets every frame (6 scalar writes; negligible but
   part of the claim surface — keep or gate, your call; do not count it as the win).
3. `ViewportExecutor.js:386-410` (octree) and `413-427` (occlusionCulling) are **already gated**
   on their `.enabled` flags — verify, don't re-gate.

#### Who consumes `materialSortId` (the "declared consumer" analysis)

Verified consumers of the ID at runtime:

- **CPU opaque/front-to-back comparator** — `CommandSorter.js:75-93` `frontToBack` calls
  `compareCommandOrdering(a, b, /*compareMaterial=*/true)`
  (`packages/engine/Source/Renderer/CommandOrdering.js:224-252`; material tie-break at 244-248).
  At defaults `frontToBack` is reached ONLY on pick-flavored paths:
  `executeTranslucentCommandsFrontToBack` (`CommandSorter.js:114-131`, used when
  `!frameState.passes.render`, i.e. pick) and the WebGPU pick pass
  (`WebGPUSceneRendererPickPass.ts:563` → `sortCommandsFrontToBack`,
  `WebGPUSceneRenderer.ts:456-470`). The normal render translucent sort (`backToFront`,
  `CommandSorter.js:25-42`) passes `compareMaterial=false` — **it never reads the ID**.
  Critically: with all-zero IDs the material tie-break is `0-0=0` and the comparator falls
  through to distance — **deterministic, and visually/pick-result identical** (pick and opaque
  are depth-tested; grouping by shader is a state-change batching optimization only).
- **GPU sort keys SOA** — `WebGPUSceneRenderer.ts:4330+` `_dispatchGPUSortKeys` packs
  `cmd.materialSortId` into the SOA (line ~4454). Gated upstream by `_gpuSortActive`
  (Batch 214 comment at 4335) and FAR-003-contained at defaults
  (`getContainmentStats()`, `WebGPUSceneRenderer.ts:4557`). When force-enabled, this IS a
  declared consumer.
- **Enabled scheduler itself** — `binCommand` (`RenderScheduler.js:139-166`) calls
  `ensureMaterialSortId` per command anyway, so enabled mode self-serves.
- **`WasmSortBridge.js:145`** reads `command.materialSortId` in `_packKey` — but the bridge has
  **zero importers in Source/** (scaffolding; Principle 7 — do NOT remove it, and do not count
  it as a live consumer).

Conclusion you can rely on: **at true defaults there is no consumer whose output changes when
IDs remain 0.** That is exactly the queue's acceptance shape: "zero material-sort work unless a
declared consumer needs stable IDs."

#### SceneOctree today

`packages/engine/Source/Scene/SceneOctree.js` (+ `OctreeNode.js`). Opt-in
(`scene.renderScheduler.octree.enabled = true`), default off, **rebuilt from scratch every
enabled frame**: `build()` (SceneOctree.js:121-176) does root `clear()` + reinsert of every
eligible command + allocates a fresh `bypassCommands` array per frame. `collectVisible`
(189-213) does hierarchical frustum + horizon culling. Eligibility (`isOctreeEligible`,
298-309) is pass-based: only `Pass.OPAQUE` (8) and `Pass.TRANSLUCENT` (9)
(`OCTREE_ELIGIBLE_PASSES`, line 288). Terrain (`Pass.GLOBE`=2), 3D Tiles
(`CESIUM_3D_TILE*`=4-7,12), voxels (`Pass.VOXELS`=10), splats (11) all bypass — see
`packages/engine/Source/Renderer/Pass.js:17-31`. `ViewportExecutor.js:387-410` consumes it:
when `buildResult.useOctree`, it **replaces `frameState.commandList` in place** with
bypass + octree-visible commands, before `view.createPotentiallyVisibleSet(scene)`.

#### C9-18 subject inventory (verified per-site)

**(a) CPU pass profiler closures — the headline defect.**
`WebGPUCpuPassProfiler` (`packages/engine/Source/Renderer/WebGPU/WebGPUCpuPassProfiler.ts`)
itself short-circuits when disabled (`time()`, lines 86-95: `if (!this._enabled) return fn();`)
— but **every call site allocates the `() => ...` closure before `time()` can decline it**, on
every frame, per frustum, with the profiler disabled (it is constructed disabled,
`WebGPUSceneRenderer.ts:1329-1331`). The nine sites:

| File | Line | Pass name |
|---|---|---|
| `WebGPUSceneRenderer.ts` | 1536 | `"pick"` (every pick mini-frame) |
| `WebGPUSceneRenderer.ts` | 1657 | `"shadow"` |
| `WebGPUSceneRenderer.ts` | 1695 | `"postFrustumChain"` |
| `WebGPUSceneRendererFrustumLoop.ts` | 257 | `"environment"` (frustum 0 only) |
| `WebGPUSceneRendererFrustumLoop.ts` | 269 | `"globe"` (per frustum) |
| `WebGPUSceneRendererFrustumLoop.ts` | 343 | `"3dTiles"` (per frustum; wraps a second, *load-bearing* inner closure — see traps) |
| `WebGPUSceneRendererFrustumLoop.ts` | 395 | `"voxels"` (per frustum) |
| `WebGPUSceneRendererFrustumLoop.ts` | 406 | `"opaque"` (per frustum) |
| `WebGPUSceneRendererFrustumLoop.ts` | 576 | `"translucent"` (per frustum) |

With the standard 2-frustum scene that is ~13-15 closure allocations per rendered frame at
defaults, plus one call-frame indirection each.

**(b) C9-01 logical counters — runtime-gated, evaluate pragmas.**
Pattern (verified): `WebGPUGlobeSurfaceRenderer.ts:319-323` declares
`public _logicalCounters: WebGPUGlobeLogicalCounters | null = null;`; the constructor
(343-355) reads `globalThis.__webgpuGlobeLogicalCounters ?? null` ONCE. Hot sites are
`if (logicalCounters) { counter = (counter ?? 0) + 1; }` blocks at
`WebGPUGlobeSurfaceRenderer.ts:608-611, 741-744, 766-770, 901-904, 1072-1087`;
`WebGPUGlobeSurfaceTextures.ts:143, 281, 299-344…`; `WebGPUGlobeSurfaceTileBuffers.ts` (same
pattern); `GlobeSurfaceTileProviderRendering.js:871, 1092-1094, 1161-1163`. **Disabled cost is
one null test per site — no closures/objects/strings.** The audit (item 12) dinged these as
"runtime-gated (not pragma-stripped)" — a soft deviation from CLAUDE.md's "per-frame/per-tile
diagnostics ALWAYS wrap with pragma tags" rule.

Build facts you need before deciding (verified): the pragma stripper
(`scripts/build.js:69-90`, `stripPragmaPlugin`) only runs when `removePragmas: true`; the dev
builds pass `removePragmas: false` (`scripts/build.js:1693, 1711, 1766`), so
`Build/CesiumUnminified` **retains** pragma blocks. The performance runner
(`Tools/visual-regression/run-performance-campaign.mjs`) loads
`Build/CesiumUnminified/index.js` / `Build/CesiumUnminified/Cesium.js` (lines 1483, 2900), and
installs the counter sink via `addInitScript` **only in the `--api-instrumentation` lane**
(lines 305-320: clean lane sets `globalThis.__webgpuGlobeLogicalCounters = undefined`).
Therefore: pragma-wrapping the counter blocks is **safe for both perf lanes** (they run
unminified where pragmas survive; the runtime null-gate remains the actual clean/instrumented
lane separator) and removes the branches only from minified release builds.

**(c) Already-correct patterns — verify, do not "fix":**
- `WebGPUPerformanceManager.ts:601-660` — Sol's gates: `_profilerActive` guard (line 301,
  checked at 604/617/633/651); `withRenderPassTimestamps` documents and delivers "the disabled
  path performs one guard and returns the exact descriptor object without allocating".
- `WebGPUTimestampProfiler.ts:249-271` — returns `undefined` disabled; allocates only enabled.
- `PerformanceTracker` (`packages/engine/Source/Services/PerformanceTracker.js`) —
  `sample()` early-returns on `!this._active` (190); `recordFrame()` is documented and
  implemented as "two array writes + two increments + one delta" into preallocated buffers
  (397-399) and runs every frame **by design** (live FPS HUD source) — leave it.
- `Scene.js:4027` — `performance.now()` only when `_performanceTracker.active`.
- Render-pass labels are static string literals (e.g. `"Scene Main Render Pass"`,
  `WebGPUContext.ts:1876`) — creation-path template-literal labels (262 occurrences) live in
  pipeline/buffer **creation** code, not per-frame paths. Do not churn them.
- `_diagShouldLog()` pragma-predicates (`WebGPUGlobeSurfaceRenderer.ts`,
  `WebGPUGlobeSurfaceTextures.ts`, `WebGPUGlobeSurfaceCameraUB.ts`,
  `WebGPUGlobeSurfaceTileUB.ts`) — already the CLAUDE.md-endorsed pattern.

---

### Target design + invariants

#### C9-08 invariants

1. **I-1 (default zero work):** With `scheduler.enabled === false`, no GPU-sort-keys demand,
   and no explicitly declared consumer, a rendered frame performs **zero** per-command
   material-ID work: no commandList walk, no `ensureMaterialSortId` calls, no stats increments.
   `stats.materialIdsAssigned` stays 0 (this becomes the probe-visible counter evidence).
2. **I-2 (demand model):** Stable material IDs are produced when — and only when — a *declared
   consumer* exists. Declared consumers, exhaustively: (a) `scheduler.enabled === true`
   (bin/sort stream), (b) the WebGPU GPU-sort-keys producer when its containment mode makes it
   activatable (i.e. NOT `"never"`), (c) an explicit public opt-in
   (`scheduler.declareMaterialSortIdConsumer(name)` / `releaseMaterialSortIdConsumer(name)` or
   an equivalent refcount — pick one shape and document it) for external/embedder code. The
   CPU `frontToBack` comparator is **not** a consumer: with all-zero IDs its output is an
   equivalence-class-identical ordering (material tie-break degenerates to distance; prove
   with a spec, see Verification).
3. **I-3 (no API loss):** `scene.renderScheduler`, `RenderScheduler`'s full API,
   `MaterialSortIdAllocator`, `SceneOctree`, `OcclusionCulling`, and `WasmSortBridge` all
   remain present and force-reachable. This slice is a demand gate, not FAR-504 retirement.
4. **I-4 (late demand correctness):** Declaring demand mid-session starts assignment on the
   next frame and is idempotent. ID *values* may differ from a boot-time-demand session (the
   allocator is first-seen-monotonic) — only grouping semantics are contracted, never specific
   ID values. Never reset the allocator on demand release (IDs stay sticky on commands that
   already have them; `ensureMaterialSortId` only fills zeros — `MaterialSortIdAllocator.js:135`).
5. **I-5 (octree ownership):** `SceneOctree` never owns terrain / 3D Tiles / voxels selection.
   Enforcement stays pass-based (`OCTREE_ELIGIBLE_PASSES` = OPAQUE, TRANSLUCENT only) — do not
   widen it. The octree is a **post-selection conservative filter**, never a traversal
   substitute (plan §4.1; QUEUE §1 rule 2).
6. **I-6 (conservative bounds or bypass):** A command the octree cannot spatially bound
   *conservatively* must go to the bypass list, never be dropped. Concretely: commands whose
   bounding volume is not fully containable under the root's bounds must bypass (see Trap T-5 —
   today they are stored at the root node and can be **wrongly culled** by the root sphere
   test). Unknown bounds ⇒ execute (plan §3 invariant 2).
7. **I-7 (dirty/revision rebuild, enabled mode):** The enabled octree stops full clear+reinsert
   per frame. Rebuild work is keyed on a revision: re-insert only when the eligible command
   set membership or a member's bounding volume changed; reuse the retained tree otherwise.
   A conservative dirt signal is acceptable (e.g. per-frame cheap hash of (count, sum of BV
   center components) or an explicit per-primitive revision); **when in doubt, rebuild** —
   correctness over reuse.
8. **I-8 (no auto-promotion):** The octree stays opt-in. Do NOT wire any automatic
   enable/threshold promotion in this slice; the queue requires it to "beat ordinary PVS
   before auto promotion" — that proof (a measured A/B on the moving route with a dense
   primitive workload) is a *precondition of some future slice*, not this one.
9. **I-9 (containment reporting stays truthful):** `getDebugSnapshot().containment` and the
   FAR-003 spec (`packages/engine/Specs/Scene/RenderSchedulerSpec.js`) must be updated in the
   same commit as the behavior change — the current spec at lines 4-23 asserts IDs ARE
   assigned while disabled, which your change deliberately reverses (see Trap T-1).

#### C9-18 invariants

10. **I-10 (no per-call allocation while disabled):** Disabled CPU/GPU profilers, logical
    counters, performance trackers, and debug-label plumbing allocate **no closures, objects,
    or strings per call** on the render hot path. Boolean/null guards are the allowed cost.
11. **I-11 (enabled exactness):** Enabled diagnostics produce the same numbers as before the
    refactor (same bucket names, same accumulation semantics — per-frustum sub-passes still
    accumulate into one per-frame bucket per name; `WebGPUCpuPassProfiler` doc lines 24-27).
12. **I-12 (lane separation):** Clean and instrumented perf lanes stay separate. The clean lane
    must not read/write any diagnostic global per frame (the once-at-construction
    `globalThis.__webgpuGlobeLogicalCounters` read is the approved handshake). Overhead of
    enabled diagnostics is measured in its own lane, never mixed into clean timings
    (run-performance-campaign.mjs already enforces this; don't break it).
13. **I-13 (pragma rules per CLAUDE.md):** Per-frame/per-tile diagnostic code gets
    `//>>includeStart('debug', pragmas.debug); … //>>includeEnd('debug');` wrapping.
    **Permanent error sentinels are NEVER wrapped or gated**: `console.error` for real defects
    (e.g. `WasmSortBridge.js:231/286` WASM-load/sort failures, loop guards, null-target guards,
    size validations) must keep reaching the console in all builds.
14. **I-14 (byte-identical rendering):** None of C9-18 changes any rendered output, on either
    backend, in any mode. It is allocation/indirection removal only.

---

### Implementation walkthrough

Land as **two separate slices/commits** (queue rule 6: one concern per slice) — C9-08 first or
C9-18 first, either order; they touch disjoint files except the ledger.

#### Slice A — C9-08

**A1. Add the demand surface to `RenderScheduler`** (`RenderScheduler.js`):
a `_materialIdConsumers` refcount (or Set of names) + `get materialSortIdDemand(): boolean`
returning `this.enabled === true || this._materialIdConsumers > 0`. Add
`declareMaterialSortIdConsumer(name)` / `releaseMaterialSortIdConsumer(name)` with JSDoc.
Keep `assignMaterialSortIds` itself unchanged (it's the service; the *call* becomes demand-gated).

**A2. Gate the call site** (`ViewportExecutor.js:368-383`): change the `else` branch to

```js
} else if (scheduler.materialSortIdDemand) {
  scheduler.assignMaterialSortIds(cmdList);
}
```

Decision point: **how does GPU-sort-keys demand reach the Scene-side scheduler?** The producer
lives in the WebGPU renderer (`_gpuSortActive` / containment mode, `WebGPUSceneRenderer.ts`).
Scene code must NOT import from `Renderer/WebGPU/` (charter Principle 2). Options, in order of
preference: (1) whatever code path force-enables GPU sort keys (the CesiumDebug /
containment-toggle surface — find it via `Grep "gpuSortKeys" packages/engine/Source`) also
calls `scene.renderScheduler.declareMaterialSortIdConsumer("webgpu-gpu-sort-keys")`; (2) a
backend-neutral hint on `GraphicsContext` the ViewportExecutor can read. If you cannot find a
clean seam in under an hour, fall back to (1'): have `_dispatchGPUSortKeys`'s enable path set a
flag on the scene it already holds — but keep the declare/release call in **backend-neutral
Scene code reacting to the containment mode**, not an `isWebGPU` branch. If none of these are
possible without violating backend-agnosticism, STOP and mark the task PARTIAL with the demand
surface landed and the GPU-sort wiring documented as the remainder.

**A3. Update the FAR-003 spec** (`packages/engine/Specs/Scene/RenderSchedulerSpec.js`): the
first case ("keeps the dead bucket/sort stream disabled while assigning stable material IDs")
must become "assigns stable material IDs only under declared demand": assert (i) no demand ⇒
`materialIdsAssigned === 0` and command IDs stay 0 after the ViewportExecutor-shaped call
pattern; (ii) `declareMaterialSortIdConsumer` ⇒ assignment resumes and dedupes exactly as the
old spec asserted (reuse its shader-id fixtures); (iii) release ⇒ stops again; (iv) enabled
scheduler unchanged (second spec case stays green). Add a comparator-equivalence case: build
two command lists identical except one has allocator-assigned IDs and one all-zero IDs, sort
both with `frontToBack` from `CommandSorter.js`, assert same *set* order by (layer, sortKey,
priority, distance) — i.e. the visual/pick-relevant order keys are equal even where material
grouping differs. This is the I-2 proof.

**A4. Octree out-of-bounds bypass (I-6 fix)** (`SceneOctree.js`): in `build()`'s loop
(158-167), extend eligibility: a command whose `boundingVolume` cannot be conservatively
tested under the root (e.g. `distance(center, root.center) + radius > rootHalfExtent * √3`,
or simpler: center component magnitude > rootHalfExtent) goes to `bypassCommands`. Write the
check WITHOUT allocating per command. (Verify the hazard first: `OctreeNode.insert` 224-256
keeps unfittable commands at the node, and `collectVisible` 289-302 returns 0 for the whole
subtree when the **root sphere** — radius `halfExtent*√3`, OctreeNode.js:44-49 — is outside
the frustum, dropping commands that live outside the root bounds. If you find this has already
been fixed, skip and note it.)

**A5. Dirty/revision rebuild (I-7)** (`SceneOctree.js`): retain last frame's insertion result;
compute a cheap membership/bounds signature over the eligible set each enabled frame
(no allocation: running count + XOR/sum over `boundingVolume.center.x/y/z` and radius); if
unchanged, skip `clear()` + reinsert and reuse the existing tree + retained bypass array
(reuse one persistent `_bypassScratch` array with explicit length reset instead of `const
bypassCommands = []` per frame — SceneOctree.js:156). If changed ⇒ full rebuild (do NOT try
incremental node moves in this slice). Also reuse: `build()`'s early-disabled path already
avoids allocation — keep it that way.
Decision point: command objects are recreated by some producers each frame (identity churn).
If your signature keys on object identity and it shows 100% rebuild on a static scene, switch
the signature to value-based (count + BV component sums) — that is the intended design.
If value-based still churns every frame on a static scene, the retained-frontend work
(C9-11) hasn't landed for those producers: keep the rebuild (correctness), record measured
rebuild-hit-rate in the ledger row, and mark I-7 PARTIAL with the churn owner named.

**A6. `Scene.js:4042`** — optional: skip `beginFrame()` internals when
`!scheduler.enabled && !scheduler.materialSortIdDemand` (or leave; it's 6 writes). If you touch
it, keep `stats` fields readable (getDebugSnapshot reads `stats.sortCalls`, Scene.js:2006).

**A7. Ledger + docs:** add the C9-08 row to QUEUE §3.2 with evidence; update
`getDebugSnapshot().containment.renderScheduler.fallbackReason` string if its semantics shifted
("contained-dead-command-stream" is still accurate for the bin/sort stream; consider adding
`materialIdDemand` to the snapshot object). Check `migration_doc/DEFERRED_WORK.md` for a
`RenderScheduler` dirty-tracking mention (line ~4626 references scheduler dirty tracking as a
gating pattern for light assignment — do not break that expectation).

#### Slice B — C9-18

**B1. Add closure-free profiler API** (`WebGPUCpuPassProfiler.ts`): add
`beginPass(name: string): void` / `endPass(name: string): void` — `beginPass` early-returns
when disabled, else stamps `this._passStart.set(name, performance.now())` (or a small
open-addressed pair of arrays; a Map set/get per *enabled* call is fine — enabled overhead is
measured separately per I-12); `endPass` early-returns when disabled or no matching begin,
else accumulates into `_frameBuckets` exactly as `time()`'s finally block does (line 92-94).
Keep `time()` for compatibility (it has spec/doc references) but stop using it on the 9 hot
sites.

**B2. Convert the nine call sites** (table above). Shape:

```ts
host._cpuPassProfiler.beginPass("globe");
try {
  host._executeGlobePass(frustumCommands, config);
} finally {
  host._cpuPassProfiler.endPass("globe");
}
```

`try/finally` allocates nothing. IMPORTANT at `WebGPUSceneRendererFrustumLoop.ts:343`: only the
OUTER profiler closure goes away — the inner `() => { … executeUpdateDepth … }` depth-hook
closure is a **load-bearing argument** to `_execute3DTilePasses` and must survive verbatim.
(If you want to hoist that hook too, that is C9-11 territory — out of scope here.)
Decision point: if a call site's wrapped expression *returns a value* that is consumed
(none of the nine do today — verify), keep `time()` there and note it.

**B3. Pragma-wrap the C9-01 counter blocks (I-13):** wrap **each** `if (logicalCounters) {…}` /
`if (counters) {…}` block in `//>>includeStart('debug', pragmas.debug);` /
`//>>includeEnd('debug');` in: `WebGPUGlobeSurfaceRenderer.ts` (constructor handshake block
345-354 AND the hot-site blocks), `WebGPUGlobeSurfaceTextures.ts`,
`WebGPUGlobeSurfaceTileBuffers.ts`, `GlobeSurfaceTileProviderRendering.js` (sites listed in
"Architecture today"). Keep the field declarations (`_logicalCounters`) OUTSIDE pragmas so
types and the interface (`WebGPUGlobeSurfaceTypes.js` `WebGPUGlobeLocalCounters` /
`WebGPUGlobeLogicalCounters`) stay stable; strip only executable statements. The runtime null
gate stays inside the pragma block — it is what separates the clean/instrumented lanes on the
unminified build (I-12). Pre-verified safety: perf lanes load `Build/CesiumUnminified` which
is built with `removePragmas: false`, so the instrumented lane keeps working.
Decision point: if you find a counter site whose surrounding local (`const logicalCounters =
this._logicalCounters;` e.g. `WebGPUGlobeSurfaceRenderer.ts:608`) would become an unused
variable in stripped builds (lint failure on release build lane), move the local INSIDE the
first pragma block of the function or re-read `this._logicalCounters` inside each block.
If the pragma stripper mishandles some TS construct (build error on `buildRelease`), STOP the
pragma sub-step, keep the pure runtime gating (it already satisfies I-10 — one null test, no
allocation), record the stripper limitation in the ledger row, and continue with B1/B2/B4.

**B4. Sweep for stragglers:** grep the WebGPU renderer for other per-call diagnostic
allocation while disabled: `Grep '\.time\('`, `Grep 'getStats\(\)'` in per-frame paths,
`Grep 'JSON.stringify' Renderer/WebGPU` on hot paths, template-literal `label:` inside
per-frame functions (not creation paths). Verified-clean already (do not churn):
`WebGPUPerformanceManager` timestamp gates, `PerformanceTracker`, static pass labels,
`_diagShouldLog` predicates. Anything new you find: fix if it's the same trivial shape,
otherwise ledger it as a named follow-up — do not scope-creep.

**B5. Ledger:** add the C9-18 row to QUEUE §3.2 with the site inventory and evidence.

---

### Traps for the unwary

- **T-1 — The FAR-003 containment spec asserts the OLD behavior.**
  `RenderSchedulerSpec.js:4-23` expects `materialIdsAssigned === 3` with the scheduler
  disabled. If you gate the default path and don't update this spec in the same commit, the
  suite fails and a naive "fix" would be to un-gate — the correct move is the spec rewrite in
  A3. The second spec case ("force-reachable for characterization", lines 25-40) must remain
  green untouched — force-reachability is a FAR-003 containment guarantee.
- **T-2 — Do not retire/trim the scheduler.** `predictSortPosition`, `explainRenderOrder`,
  `getSortOrderDocumentation`, `SceneOctree.collectVisibleSorted`, `OcclusionCulling`, and
  `WasmSortBridge` look dead. They are FAR-504's problem (Wave 6, gated) and Principle-7
  scaffolding. Removing anything here fails review.
- **T-3 — `ensureMaterialSortId` only fills zeros.** Collections stamp
  `materialSortId: collection._commandOrdering.materialSortId` (default 0) on their WebGPU
  packets (e.g. `WebGPUBillboardRenderer.js:1346`), and `applyCommandOrdering`
  (`CommandOrdering.js:158-162`) preserves already-assigned IDs on cached commands. So gating
  assignment cannot corrupt cached commands — but it DOES mean a command that got an ID before
  demand was released keeps it forever. That is by design (I-4); do not "clean up" stale IDs.
- **T-4 — 2D wrap-split and pick frames call `executeCommandsInViewport` multiple times.**
  Your gate must sit inside `executeCommandsInViewport` (as today's call does), NOT in
  `Scene.render()`, or the second 2D half / pick mini-frames diverge from the first.
- **T-5 — Root-sphere drop bug (the reason for A4).** `OctreeNode.insert` keeps
  outside-root-bounds commands **at the root node**, and `collectVisible` culls the whole root
  by its own bounding sphere. A satellite entity at GEO (~42e6 m > rootHalfExtent ≈ 7e6 m)
  disappears when the octree is enabled and the camera looks away from Earth. Fix is bypass at
  build time (I-6), not a bigger root (SORT-11 sizes the root to the ellipsoid on purpose,
  Scene.js:462-465).
- **T-6 — Octree horizon culling is only safe because it is sphere-conservative.** Do not
  "optimize" `isBoundingSphereVisible` usage per-command; upstream never horizon-culls ordinary
  primitives, so any non-conservative change here is a silent feature regression that the
  default (octree-off) baseline will never catch.
- **T-7 — 3D-Tiles-derived TRANSLUCENT commands are octree-eligible today** (styled translucent
  tileset content emits `Pass.TRANSLUCENT`). That is post-selection filtering, not traversal
  ownership — acceptable under I-5 — but it means "never owns 3D Tiles" is enforced by pass
  constants, not by owner checks. Do not add owner-based exclusions in this slice (allocation
  + fragile identity checks); document the boundary in the ledger row instead.
- **T-8 — The octree replaces `frameState.commandList` order** (bypass first, then tree
  order). Order within a pass changes vs. the linear path; `createPotentiallyVisibleSet`
  re-bins by pass and translucent gets re-sorted, so rendering is stable — but a
  dirty/revision reuse path must reproduce the SAME replacement semantics every frame
  (same bypass + visible split), or frame-to-frame flicker appears in equal-depth overlaps.
- **T-9 — Don't break the `time()` accumulation contract** (I-11): multiple begin/end pairs
  with the same name in one frame must ADD (per-frustum accumulation into one bucket,
  `WebGPUCpuPassProfiler.ts:92-94`). A naive `beginPass` that overwrites an in-flight start
  for a re-entered name is fine (passes don't nest same-name), but `endPass` must accumulate
  `+=`, not assign.
- **T-10 — The pick early-return block** (`WebGPUSceneRenderer.ts:1533-1551`) has
  order-sensitive cleanup after the profiler lines (`_sceneHasTransmission` reset, `_scene`
  null). Keep the begin/try/finally strictly around the `_executePickPass(config)` call only.
- **T-11 — Pragma blocks and TypeScript:** `npx tsc --noEmit` type-checks the UNstripped
  source; the stripped output is only produced by the build. A pragma block that declares a
  variable used outside the block will typecheck fine and then break `buildRelease`. Keep each
  pragma block self-contained. Test with `npx gulp buildRelease` at least once (see recipe).
- **T-12 — Do not pragma-wrap or demand-gate error sentinels** (I-13). If a grep hit looks
  like diagnostics but is a `console.error` about broken output (device lost, overflow, null
  target), it stays permanent. When unsure, CLAUDE.md's "When to keep a log permanent" list is
  the tiebreaker.
- **T-13 — Concurrent campaign execution.** Other C9 slices (C9-07 canvas pass, C9-11 retained
  terrain) touch `WebGPUSceneRenderer.ts`/`WebGPUSceneRendererFrustumLoop.ts`. Rebase-verify
  your nine call-site anchors immediately before editing; expect small line drift.
- **T-14 — `binCommand`'s pass fallback** (`RenderScheduler.js:150-152`) reads
  `command._pass ?? command.pass ?? 8` — WebGPU packets expose `pass`, WebGL DrawCommands
  `_pass`. If you touch enabled-mode code, preserve both reads.
- **T-15 — Don't turn `materialSortIdDemand` into a per-command check.** One boolean read per
  viewport execution, outside the loop. The whole point is removing the O(N) walk.

---

### Verification recipe

Environment: Node + Playwright + **Edge** only (never Firefox/Python). Dev server:
`node server.js` (or `npm run restart`). Build first: `npx gulp build`.

1. **Types + lint + build:** `npx tsc --noEmit` (zero errors), `npx eslint` on touched files,
   `npx gulp build`. If B3 (pragmas) landed: also `npx gulp buildRelease` once and grep the
   minified output for a counter name (`grep -c "imageryTextureCacheHits" Build/Cesium/Cesium.js`
   → expect 0) and for a sentinel (`grep -c "WasmSortBridge" Build/Cesium/Cesium.js` → expect >0).
2. **Focused specs** (Karma needs Edge:
   `$env:CHROME_BIN` → Edge binary per `memory/feedback_gulp_test_edge.md`):
   `npx gulp test --workspace engine --browsers=EdgeHeadlessCI --includeName "RenderScheduler"`
   and `--includeName "CommandOrdering"`. Expect the rewritten A3 matrix green.
   NOTE ledger row `NEW-WORKSPACE-SPEC-BUNDLE-FRESHNESS` (QUEUE line 123): the workspace test
   can serve a stale spec bundle — run the explicit engine build first
   (`npm run build --workspace @cesium/engine`) exactly as ledger item 68's evidence did.
3. **Byte-identical default rendering:**
   `node Tools/visual-regression/capture-and-diff.mjs` — mismatch percentages must not move vs.
   your pre-change run (run it once before you start to pin the baseline; the tool compares
   WebGL vs WebGPU per scene, so compare report-to-report).
4. **Pick unaffected (C9-08):** `node Tools/visual-regression/probe-point-pick-webgpu.mjs` and
   `probe-pickposition-webgpu.mjs` — PASS both backends (these exercise the `frontToBack`
   pick-sort path that loses material tie-breaks).
5. **Zero-work evidence (C9-08 acceptance):** instrumented lane
   `node Tools/visual-regression/run-performance-campaign.mjs --workload
   moving-camera-altitude-track-3d --renderer webgpu --api-instrumentation --output
   Tools/visual-regression/output/performance/c9-08-api-r1.json` — plus a browser check:
   open `http://localhost:8080/Apps/CesiumViewer/index.html?renderer=webgpu`, evaluate
   `viewer.scene.renderScheduler.stats.materialIdsAssigned` after several frames → **0**;
   then `viewer.scene.renderScheduler.declareMaterialSortIdConsumer("test")` (or your API),
   render, → grows; release → freezes. Then `viewer.scene.renderScheduler.enabled = true` →
   `stats.sortCalls > 0` and `getDebugSnapshot().containment.renderScheduler.active === true`
   (force-reachability preserved).
6. **Octree enabled-mode oracle (C9-08):** small Playwright probe (new
   `Tools/visual-regression/probe-scene-octree-demand.mjs`, model it on an existing probe):
   ≥250 point/billboard entities (over `minCommandsForOctree=200`) + one entity at
   `Cartesian3.fromDegrees(lon, lat, 40e6)`; screenshot octree-off vs
   `scene.renderScheduler.octree.enabled = true` — identical pixel sets including the
   high-altitude entity from a camera pose where Earth is off-screen (T-5 regression check);
   assert `octree.stats.buildTimeMs` ≈ 0 on static frames after the first (I-7 reuse) and a
   rebuild fires after mutating one entity position. Read the PNGs yourself (charter rule 8).
7. **Profiler exactness (C9-18):** in the viewer console: `CesiumDebug.cpuPassCost(true)`,
   orbit ~5 s, `CesiumDebug.cpuPassCost()` → all nine bucket names present
   (pick appears after a `scene.pick` hover) with plausible ms — compare bucket-name set
   against a pre-change run. `CesiumDebug.gpuPassCost(true/false)` unchanged.
   Disabled-path proof is source-level: `Grep '_cpuPassProfiler.time\(' Renderer/WebGPU` → the
   nine hot sites are gone (only doc comments remain).
8. **Counters still work post-pragma (C9-18/B3):** rerun the step-5 instrumented lane — the
   run must NOT emit its "instrumented WebGPU run did not attach the globe logical-counter
   sink" failure (run-performance-campaign.mjs:2593) and counter families must be nonzero.
   Clean lane sanity: one clean rep, `--workload moving-camera-altitude-track-3d --renderer
   both` — CPU p95 in family with the ledger's current characterization (WebGL ~5.4-5.5 ms /
   WebGPU ~7.1-7.5 ms; single rep = sanity only, NOT a campaign timing claim — say so in the
   ledger row exactly like C9-05 did).
9. **No perf regression claim needed:** these are R1 no-op-gate slices — acceptance is the
   zero-work proof + unchanged output + green suites, not a ≥5% stage win. Do not run 5×
   counterbalanced reps unless you intend to promote a performance claim.
10. **Ledger:** update QUEUE §3.2 rows for C9-08 and C9-18 (status, date, evidence paths,
    artifacts). If you fixed Scene.js:2003 (`capable: true`), mark item 87 complete too.

**Pass:** all of 1-8 green, PNGs personally read, ledger updated.
**Fail:** any probe/spec red after one honest fix attempt → apply Rollback below, set ledger
status PARTIAL/BLOCKED with the exact failing oracle, and stop.

---

### Rollback boundary

Roll back the **optimization, never the feature** (QUEUE §1 rule 6; plan §8):

- C9-08 revert = the ViewportExecutor demand gate + the demand API + octree dirty/reuse +
  out-of-bounds bypass (revert to per-frame `assignMaterialSortIds` + per-frame rebuild).
  NEVER revert-remove: RenderScheduler/SceneOctree/allocator/WasmSortBridge themselves, the
  FAR-003 containment (`enabled=false` default), force-reachability, or `getContainmentStats`.
  Exception inside the revert: if the T-5 out-of-bounds fix (A4) verified green on probe 6, it
  is a **correctness fix**, not an optimization — keep it even when reverting the reuse logic.
- C9-18 revert = restore `time()` closures at the nine sites and/or un-pragma the counter
  blocks. NEVER remove the profilers, the counters, the CesiumDebug commands, or any error
  sentinel. The new begin/end API may stay (unused) — it's additive.
- Instrumentation and the new/updated specs **survive rollback** (queue rule: "Tests and
  counters remain"). If the A3 spec rewrite must be reverted with the gate, restore the old
  spec text verbatim in the same commit.
- Ledger: a rollback is recorded as PARTIAL/PAUSED with the revert commit hash and the failing
  oracle named — never silently deleted.

---

### Pointers

**Source (C9-08):**
`packages/engine/Source/Scene/RenderScheduler.js` (31, 100-130, 139-166, 174-212),
`packages/engine/Source/Scene/MaterialSortIdAllocator.js` (66-138),
`packages/engine/Source/Scene/ViewportExecutor.js` (355-427, 448-501),
`packages/engine/Source/Scene/SceneOctree.js` (121-176, 189-213, 288-309),
`packages/engine/Source/Scene/OctreeNode.js` (44-49, 224-256, 262-273, 289-341),
`packages/engine/Source/Scene/Scene.js` (460-474, 2000-2014, 3203-3205, 4042),
`packages/engine/Source/Scene/CommandSorter.js` (25-42, 75-93, 114-131),
`packages/engine/Source/Renderer/CommandOrdering.js` (40-62, 224-252),
`packages/engine/Source/Renderer/Pass.js` (17-31),
`packages/engine/Source/Scene/WasmSortBridge.js` (136-160 — scaffolding, hands off),
`packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts` (4330-4470 GPU-sort SOA,
4550-4590 getContainmentStats).

**Source (C9-18):**
`packages/engine/Source/Renderer/WebGPU/WebGPUCpuPassProfiler.ts` (57-151),
`packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts` (1329-1331, 1533-1551,
1642-1701, 4900-4917),
`packages/engine/Source/Renderer/WebGPU/WebGPUSceneRendererFrustumLoop.ts` (255-271, 343-378,
395-408, 576),
`packages/engine/Source/Renderer/WebGPU/WebGPUPerformanceManager.ts` (301, 421-475, 601-660 —
reference patterns, already correct),
`packages/engine/Source/Renderer/WebGPU/WebGPUTimestampProfiler.ts` (249-290),
`packages/engine/Source/Services/PerformanceTracker.js` (126-128, 189-195, 397-399 — leave),
counter sites: `WebGPUGlobeSurfaceRenderer.ts` (319-355, 608, 741, 766, 901, 1072),
`WebGPUGlobeSurfaceTextures.ts` (114, 143, 281, 299-344), `WebGPUGlobeSurfaceTileBuffers.ts`,
`GlobeSurfaceTileProviderRendering.js` (871, 1092, 1161),
`scripts/build.js` (69-90, 1693/1711/1766).

**Specs:** `packages/engine/Specs/Scene/RenderSchedulerSpec.js`,
`packages/engine/Specs/Renderer/CommandOrderingSpec.js`.

**Probes / lanes:** `Tools/visual-regression/run-performance-campaign.mjs` (usage 50-69,
handshake 305-320, sink assertion 2593, unminified paths 1483/2900),
`Tools/visual-regression/capture-and-diff.mjs`, `probe-point-pick-webgpu.mjs`,
`probe-pickposition-webgpu.mjs`; new probe to write: `probe-scene-octree-demand.mjs`.

**Docs / ledger:** `migration_doc/QUEUE_2026-07-15_CAMPAIGN9.md` (rows 77-78, 199, 209; §3.2
rules 94-107; §12 landing rules), `migration_doc/FORK_PERFORMANCE_RTE_VISIBILITY_REMEDIATION_PLAN_2026-07-15.md`
(§2 finding 8, §3 invariants, §4.1, §8), `migration_doc/FORK_ARCHITECTURE_REMEDIATION_PLAN_2026-07-13.md`
(lines 440-444 ordering contract; line 845 FAR-504 boundary), `migration_doc/SOL_AUDIT_REPORT_2026-07-16.md`
(ratings item 12; P1 #12 = Scene.js:2003 = ledger item 87), CLAUDE.md "Logging & Debug
Pragmas" + Principle 7 (dead-code audit) + Principle 2 (backend agnosticism — constrains the
GPU-sort demand wiring in A2).

**Related ledger rows you must not collide with:** item 87 (snapshot `capable`), C9-11
(retained terrain descriptors — same WebGPU files), C9-07 (canvas pass — same frustum-loop
file), FAR-504 (scheduler disposition — Wave 6, out of scope), `NEW-WORKSPACE-SPEC-BUNDLE-FRESHNESS`
(test-freshness caveat in the recipe).

---

<a id="g5"></a>

## G5 — C9-09-ATTACHMENT-DEMAND-REGISTRY + C9-10-CONSUMER-DRIVEN-MRT

### C9-09-ATTACHMENT-DEMAND-REGISTRY (`FAR-401-C0`, queue item 26, R2/R3) + C9-10-CONSUMER-DRIVEN-MRT (`FAR-403-C0`, queue item 27, R3)

All anchors below were verified against the live tree at commit `ea6332d0aa` (Batch 672,
2026-07-16, post-Sol-tranche 656-669, post audit-fix batches 670-672). Campaign 9 is running
concurrently — **re-verify every line anchor with the grep commands given inline before
editing**; symbol names are stable, line numbers drift.

Queue rows (verbatim contract, `migration_doc/QUEUE_2026-07-15_CAMPAIGN9.md:200-201`):

- **26 / C9-09**: "One canonical pre-pass demand record covers every attachment consumer and
  feeds both legacy executor and future graph. Unknown consumers require conservative full
  topology."
- **27 / C9-10**: "Cache exact one-target/MRT variants. Default with no consumer reports zero
  normal/G-buffer bytes, MSAA companion bytes, and resolves. Toggle
  deferred/SSR/NPR/contact-shadow/SSGI/debug consumers independently and in combinations;
  preserve HDR/MSAA/resize/loss/TAA/pick/classification. **Never merely set `_mrtMode=false`**."

Parent specs: `migration_doc/FORK_PERFORMANCE_RTE_VISIBILITY_REMEDIATION_PLAN_2026-07-15.md`
§2.3 (the ~80 MiB finding), §3 invariant 2 ("Unknown MRT demand retains the complete
topology"), §4.3 ("A bounded bridge may cache exact one-target and MRT pipeline/pass variants,
but it must not become a second topology authority");
`migration_doc/FORK_ARCHITECTURE_REMEDIATION_PLAN_2026-07-13.md:723-748` (FAR-401 attachment
contract, FAR-403 conditional G-buffer — read its Acceptance + Rollback clauses; the
"capability/active state can force existing MRT mode for comparison" rollback clause is a hard
requirement here).

---

### Architecture today (post-Sol, verified 2026-07-16)

#### The consumerless cost being removed

At 1920×1080 with the default `msaaSamples=4`, the WebGPU backend allocates every frame-lifetime:

- one single-sample `rgba16float` "normal+roughness" G-buffer (~16.6 MiB), plus
- one ×4-multisampled `rgba16float` companion (~66 MiB), and
- auto-resolves the companion into the single-sample texture **at every scene-pass end** —
  and the scene pass is ended/re-opened multiple times per frame (per-frustum depth clears,
  globe-depth copies, 3D-tile depth updates, translucent capture) — with **zero consumers
  enabled by default**. That is the ~80 MiB + resolve-bandwidth finding this pair removes.

#### Where each piece lives (the real map — note it does NOT match older doc sketches)

1. **Topology flag** — `_mrtMode = true` is a **module-scoped** variable in
   `packages/engine/Source/Renderer/WebGPU/WebGPUSceneFBTargetHelpers.ts:71`, with
   `setSceneFBMrtMode()` (line 88) and `isSceneFBMrtMode()` (line 97). It has been
   permanently `true` since Slice 5c-B Phase 2 and **nothing flips it at runtime**. It is NOT
   in `WebGPUSceneRendererEnsureResources.ts` (stale-anchor correction: EnsureResources
   allocates the *scene framebuffer, OIT, edge FBO, globe depth, depth plane, post-process*
   — it never touches the G-buffer or `_mrtMode`).
   Verify: `grep -n "_mrtMode" packages/engine/Source/Renderer/WebGPU/WebGPUSceneFBTargetHelpers.ts`

2. **G-buffer allocation** — `GBufferFramebuffer` class in
   `packages/engine/Source/Scene/GBufferFramebuffer.js` (class at line 46, `update()` at 92,
   texture creation 125-156, `normalRoughnessTexture` getter ~186, `renderAttachmentView`
   ~198, `resolveTargetView` ~212). Single-sample texture usage:
   `STORAGE_BINDING | TEXTURE_BINDING | COPY_DST | RENDER_ATTACHMENT`; MSAA companion:
   `RENDER_ATTACHMENT` only (multisampled storage textures are illegal). Labels:
   `Phase8a_GBuffer_NormalRoughness` / `Phase8a_GBuffer_NormalRoughness_MSAA_x<N>` — these
   labels are your byte-accounting hooks in probes.

3. **The unconditional allocation call site** — `WebGPUContext.updateAndClearFramebuffers`
   override in `packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts:3591` (allocation
   block ~3655-3720; the `view.gBufferFramebuffer.update(...)` call at ~3713). Batch 115b
   deliberately made allocation unconditional ("gate only on `!picking` + view existence")
   so the MRT pass could always bind slot 1. It uses the **effective** sample count
   `this._msaaSamples ?? 1` (Batch 244 — TAA forces 1; see trap 8). This one call site is
   where demand-gating goes.
   Verify: `grep -n "gBufferFramebuffer" packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts`
   Contrast: the **WebGL** path (`packages/engine/Source/Scene/FramebufferOrchestrator.js:148`)
   still gates G-buffer allocation on `frameState.useDeferredLighting === true` — WebGL is
   already demand-driven and must not be touched. The WebGPU override returns `true` and
   skips the orchestrator entirely.

4. **Slot-1 attachment — exactly three scene-pass-open sites**, all funneling through one
   builder `buildMrtSlot1Attachment(scene, loadOp)` in
   `packages/engine/Source/Renderer/WebGPU/WebGPUSceneRendererPassRedirect.ts:56-83`
   (returns `null` when `!isSceneFBMrtMode()` or the G-buffer view is unallocated; spreads
   `resolveTarget: gb.resolveTargetView` when MSAA):
   - initial per-frame open: `setupSceneFramebufferRenderPass`, slot-1 append at
     `WebGPUSceneRendererPassRedirect.ts:191-200` (loadOp `"clear"`, or `"load"` for the
     SCENE2D second wrap half via `config.sceneFbLoad`);
   - `WebGPUSceneRenderer.ts:1928` in `_resumeScenePass` (loadOp `"load"`);
   - `WebGPUSceneRenderer.ts:2007` in `_clearDepthStencil` (per-frustum depth clear,
     loadOp `"load"`).
   Verify: `grep -n "buildMrtSlot1Attachment" packages/engine/Source/Renderer/WebGPU/*.ts`
   Stale-anchor correction: the per-frame **G-buffer resolves happen at these scene-pass
   ends** (WebGPU auto-resolve via `resolveTarget`), NOT in PostFrustumChain. The only
   resolve in `WebGPUSceneRendererPostFrustumChain.ts` is the **depth** MSAA resolve
   (`resolveDepthMSAA`, lines ~96-121) — that one serves AO/DoF/env-effect depth sampling
   and is out of scope here; do not remove it.

5. **Pipeline targets — the choke point.** Every pipeline that draws into the scene
   framebuffer builds its `fragment.targets` through `makeSceneFBTargets(format, options)`
   (`WebGPUSceneFBTargetHelpers.ts:146-182`). In MRT mode it returns
   `[slot0, {format:"rgba16float", writeMask: options.emitsGBuffer ? 0xf : 0}]`; the
   **non-null writeMask-0 placeholder is load-bearing** (a trailing `null` makes the
   validator treat the pipeline as 1-target and reject it against a 2-attachment pass —
   Batch 117 discovery, documented at lines 154-176). 33 files call it — enumerate with:
   `grep -rln "makeSceneFBTargets" packages/engine/Source/Renderer/WebGPU/`
   (billboard, label, point, polyline, buffer* ×3, cloud, computeInstance, cubeMapPanorama,
   depthPlane, derivedCommand, edgeVisibility, ellipsoid, environment(sun/moon/sky),
   flowField, gaussianSplat, groundPolyline, groundPrimitive, model pipeline cache, ocean,
   pointCloud+EDL, pointPrimitive, primitiveCommands, skyAtmosphere, starField,
   vector3DTile ×3, voxel, weather, model ErrorPipeline).

6. **G-buffer emitters (writeMask 0xf / real `@location(1)` writes):**
   - Globe: `WebGPUGlobeSurfacePipelines.ts` — the non-capture branch **hardcodes** a
     2-target array `[{canvasFormat,...}, {format:"rgba16float", writeMask:0xf}]`
     (~lines 497-506); the capture branch is single-target.
   - Model (+ B3DM/I3DM/TILE_GLTF): `WebGPUModelPipelineCache.ts` — `emitsGBuffer: true` at
     lines 927, 1011, 1088, 3167.
   - EllipsoidPrimitive: `WebGPUEllipsoidPrimitiveRenderer.ts:494`.
   - Lit-material geometry primitives: `WebGPUPrimitiveCommands.ts:3000`
     (`emitsGBuffer: isLit || isMaterialLitShader(shaderInfo.type)`).
   Verify: `grep -rn "emitsGBuffer" packages/engine/Source/Renderer/WebGPU/`

7. **Shaders that declare `@location(1) normalRoughness`:**
   - `Shaders/WebGPU/Globe/GlobeTerrain.wgsl` `FragOutput` (~line 3012) + `makeFragOutput`
     (~3030) — **already gated** by `//>>ifdef CAPTURE_MODE` (emits in the `//>>else`
     branch).
   - `Shaders/WebGPU/Model/ModelPBRComplete.wgsl` `FragOutput` (~2343-2355) — same
     `CAPTURE_MODE` gating.
   - `Shaders/WebGPU/Model/ErrorPipeline.wgsl:53` — **unconditional** (trap 7).
   - The entire Lit primitive family — `Shaders/WebGPU/Primitive/PrimitiveMat*Lit.wgsl`
     (~28 files) + `PrimitivePhongColor.wgsl` + `PrimitivePhongTexturedColor.wgsl` —
     **unconditional** (e.g. `PrimitiveMatColorLit.wgsl:289-292`).
   - EllipsoidPrimitive's WGSL (inline/`Primitive/` — locate via
     `grep -rn "normalRoughness" packages/engine/Source/Shaders/WebGPU/ -l`).
   The `CAPTURE_MODE` define is `ShaderDefine` bit 17
   (`WebGPUShaderDefines.ts:409`) and is the **existing, shipped template** for a
   single-target fragment variant (drops `@location(1)` via the preprocessor; on-screen
   `defines=0` output stays byte-identical). C2-25 env-capture (Batch 446) proved this
   whole variant mechanism end-to-end.

8. **Consumers (this is the registry's member list — all verified):**

   | Consumer | Enable flag | Read site | Fallback when G-buffer absent |
   |---|---|---|---|
   | SSR | `scene._enableSSR` | `WebGPUSceneRendererEnvironmentalEffects.ts` ~299-350 → `WebGPUSSREffect.ts` (`hasNormalGBuffer` uniform flag, `warnedNoNormalGBuffer`) | depth-derivative normals (quality loss) |
   | NPR outlines | `scene._enableNPROutlines` | same file ~223-256 | **skips entirely** when view null |
   | Contact shadows | `scene._enableContactShadows` | same file ~259-297 | **skips entirely** when view null |
   | Deferred lighting | `scene.deferredLighting` → `frameState.useDeferredLighting` (`Scene.js:3369`) | gates the compute producer `_executeGBufferProducer` (`WebGPUSceneRenderer.ts:2533`; note line 2544: producer is **skipped while MRT mode is on** — MRT emits are the source of truth) AND gates the AO G-buffer feed (`WebGPUSceneRenderer.ts` ~3163-3190: `gBufferNormalView` passed to `_postProcess.execute` only when `useDeferredLighting`) | AO uses a 1×1 placeholder (`_gBufferPlaceholderView`, `WebGPUAmbientOcclusionEffect.ts:540`) |
   | SSGI | AO effect with `algorithm: "ssgi"` (`WebGPUAmbientOcclusionEffect.ts:65`) — same AO feed as above | same as AO |
   | Debug overlay | `scene.debugShowGBufferNormals` (`CesiumDebug.showGBufferNormals()` sets it **and** `deferredLighting`) | `WebGPUSceneRenderer.ts:3062-3069` → `WebGPUDebugGBufferOverlay` | requires deferredLighting anyway |

   Stale-assumption corrections: **TAA is NOT a G-buffer consumer** (motion vectors come
   from the separate single-target `rg16float` velocity pass, `_runVelocityPass`), and
   **OIT is NOT this MRT** (OIT accum+revealage is its own framebuffer/`WebGPUOIT`,
   FAR-003-contained off by default — `_webgpuOITEnabled=false`, ratified 2026-07-16, owned
   by FAR-404/T7 — do not touch it). **Pick** pipelines are single-target
   `context.pickPipelineFormat` by construction since Batch 672
   (`WebGPUDerivedCommand` PICK derivation throws without `options.pickFormat`) — pick is
   only an *interaction to preserve*, not a demand source. **Classification**
   (Vector3DTile*/GroundPrimitive scene-pass draws) routes through `makeSceneFBTargets`
   and adapts automatically if variants are keyed correctly.

9. **Render bundles bake attachment state.** The Moon bundle builds
   `colorFormats: isSceneFBMrtMode() ? [sceneFormat, rgba16float] : [sceneFormat]` at
   `WebGPUEnvironmentRenderer.js:1070-1076`; the Globe has the same pattern (Batch 117).
   `context.renderBundleManager.invalidateAll()` exists and is already called on scene
   color-format changes (`WebGPUSceneRendererEnsureResources.ts:341-349`).

10. **Derived commands restamp targets** through `makeSceneFBTargets`
    (`WebGPUDerivedCommand.ts:266-282`, `restampSceneFBTargets`) — derived variants
    (velocity/invert-class/etc.) inherit whatever the helper returns at derivation time.

11. **Where MRT-mode is additionally read** (complete list, verify with
    `grep -rn "isSceneFBMrtMode" packages/engine/Source/`):
    `WebGPUSceneRendererPassRedirect.ts:60`, `WebGPUSceneRenderer.ts:2544` (producer skip),
    `WebGPUEnvironmentRenderer.js:1070` (moon bundle), `WebGPUStarFieldRenderer.ts:674`
    (debug stats only).

12. **Ledger status (2026-07-16):** C9-09 and C9-10 are **NOT STARTED** (absent from the
    §3.2 ledger). **Gate B is NOT passed** (Wave-1 items 9-21 / `C8-11-CORRECTNESS-CHECKPOINT`
    are not complete), and the queue's gate table says Gate B "stops": "MRT topology,
    production submit-source migration, ownership, and depth authority changes unless a
    documented amendment is approved" (queue §3), and §3's closing paragraph: "Attachment
    topology ... otherwise wait[s] for Gate B unless an explicit gate amendment records why
    the slice is correctness-independent." See the Implementation walkthrough Step 0
    decision point — this is the single most important process constraint of this cluster.

---

### Target design + invariants

Numbered; each is testable. "Topology" below means the frame's scene-FB attachment shape:
`MRT` (2 color attachments) vs `ONE_TARGET` (1 color attachment).

1. **One authority.** A new module
   `packages/engine/Source/Renderer/WebGPU/WebGPUAttachmentDemandRegistry.ts` computes a
   plain-data, per-frame **demand record** from scene state. It is a *pure function* of
   `(scene flags, force switches)` — no GPU handles, no caches — so device loss/recovery is
   trivially safe. Both the legacy executor (the three pass-open sites, the allocation site,
   the pipeline builders) and the future FAR-400/401 graph (Wave-6 T1) read this record.
   The bounded bridge caches variants but **must not become a second topology authority**
   (plan §4.3) — i.e. no other module may independently decide "am I MRT?".

2. **Demand record contents (v1).** At minimum the G-buffer family:
   `gbufferReaders: { ssr, nprOutlines, contactShadows, deferredLighting, ssgi, debugOverlay }`,
   `gbufferDemanded: boolean` (OR of readers, or forced), `topology: "mrt" | "one-target"`,
   plus counters (below). C9-09's acceptance says the record "covers every attachment
   consumer" — so also *record* (observe-only, no behavior) the other attachment families
   the frame uses: velocity target (taaEnabled), OIT accum/reveal (contained), edge MRT
   (`_enableEdgeVisibility`), refraction capture (`_sceneHasTransmission`), globe depth,
   pick, post-process snapshot. Only the G-buffer family gets *acted on* in C9-10.

3. **Demand rule.** `gbufferDemanded = ssr || nprOutlines || contactShadows ||
   deferredLighting || debugOverlay || ssgiActive || forceSceneMRT`. Any reader ⇒ full MRT
   topology (allocation + emitter pipelines + slot-1 attachment + resolves), preserving
   today's exact enabled behavior including real material normals for SSR/NPR/contact
   shadows. No reader ⇒ ONE_TARGET: **zero** G-buffer texture bytes, **zero** MSAA companion
   bytes, **zero** slot-1 resolves, 1-target pipelines, 1-attachment passes.

4. **Unknown demand is conservative.** Provide a context-level force switch (suggested:
   `context.forceSceneMRT` backed by a `CesiumDebug.attachmentDemand(force?)` toggle, and/or
   a `contextOptions` field). Its default is demand-driven **only after the Gate-B decision
   point clears**; until then it defaults `true` (= today's behavior). Any consumer you
   cannot confidently enumerate ⇒ treat as demanding (campaign rule 3 / plan invariant 2).
   External code reaching into `view.gBufferFramebuffer` directly is exactly such an
   unknown — the force switch is the documented escape hatch, and its existence satisfies
   FAR-403's rollback clause.

5. **Frame-frozen decision.** The record is computed exactly once per frame per context, in
   `WebGPUContext.updateAndClearFramebuffers` (which already runs before any scene pass
   opens and before `ensureResources`), and is immutable for the rest of the frame. All
   three pass-open sites, all pipeline lookups, and the allocation site observe the same
   frozen value. A flag mutated mid-frame takes effect next frame. (This is what prevents
   the pass-vs-pipeline "Attachment state not compatible" class of failure.)

6. **Topology is pipeline identity, not an invalidation event.** Scene-FB pipelines are
   cached **per variant** — both the MRT and the ONE_TARGET pipeline may exist
   simultaneously, keyed by topology alongside the existing keys (scene format generation,
   sample count, defines). Toggling a consumer selects the other cached variant; it does
   not destroy/rebuild in place. This is the queue's literal requirement ("Cache exact
   one-target/MRT variants") and avoids reproducing the known
   `NEW-WEBGPU-SCENE-PASS-MSAA-FLIP-TRANSITION` one-frame-stale race (ledger row).

7. **Shader variants via the preprocessor, add-only.** A new `ShaderDefine` bit (take the
   next free bit in `WebGPUShaderDefines.ts`; NEVER renumber/reuse; document consumers in
   the JSDoc per the CLAUDE.md shader-pipeline rules), suggested name
   `SCENE_SINGLE_TARGET`, drops `@location(1) normalRoughness` from every emitting shader
   exactly the way `CAPTURE_MODE` (bit 17) already does in `GlobeTerrain.wgsl` and
   `ModelPBRComplete.wgsl`. `defines=0` output must remain byte-identical (preprocessor
   `//>>else` branch = historical path) so no cached on-screen module hash churns.

8. **`_mrtMode` becomes a per-frame mirror, never the authority.** Keep
   `setSceneFBMrtMode()` (33 call sites read the module flag transitively via
   `makeSceneFBTargets`) but the ONLY writer is the registry, once per frame per context,
   at the top of `updateAndClearFramebuffers` — before any pipeline build or pass open.
   Frames execute synchronously per context in JS, so per-frame re-stamping is
   multi-context-safe (split-screen pages run two viewers whose demand may differ — see
   trap 15). "Never merely set `_mrtMode=false`" (queue row 27) means: flipping the flag
   without shader variants + pipeline variant keys + allocation gating + bundle keys +
   emitter-pipeline changes is a validation storm plus silent feature removal — the flag
   flip is the *last* wire, not the mechanism.

9. **Deferred-lighting semantics unchanged.** `deferredLighting=true` ⇒ MRT topology ⇒ the
   compute producer stays skipped (`WebGPUSceneRenderer.ts:2544` logic preserved). Never
   substitute the compute producer to avoid MRT — depth-derived normals instead of material
   normals is a visual degradation (campaign rule 1).

10. **Orthogonal to HDR/MSAA/resize/loss.** Variant key includes the existing
    `context._scenePipelineFormatGeneration` and effective `context._msaaSamples` plus the
    topology bit. G-buffer allocation (when demanded) continues to use effective samples.
    Device loss: registry recomputes next frame from scene state; the
    `onDeviceInvalidated` walk (`WebGPUSceneRendererEnsureResources.ts:193-218`) needs no
    change because the registry holds no handles; `View.js` owns G-buffer destroy.

11. **WebGL untouched; public API untouched.** No Scene-layer flag changes semantics. The
    WebGL orchestrator gate (`FramebufferOrchestrator.js:148`) stays as-is.

12. **Transition contract.** Consumer OFF→ON: next frame allocates the G-buffer, selects
    MRT variants, opens 2-attachment passes; first-frame content may be the (0,0,0,1)
    clear sentinel — every consumer already tolerates sentinel/absent input (table above),
    so one warm-up frame is acceptable and must be documented, not hidden. ON→OFF: next
    frame selects ONE_TARGET and destroys the textures (immediate destroy is safe — the
    prior frame's submit already completed by the next `updateAndClearFramebuffers`; if
    you find in-flight usage, defer destroy by one frame and say so in the ledger).
    Off→on→off must return byte-identical default frames (off-gate oracle).

---

### Implementation walkthrough

Recommended slicing (campaign rule 6 — one concern per slice, each independently landable):

#### Step 0 — Preflight + the Gate-B decision point (do this before any code)

1. Read `migration_doc/QUEUE_2026-07-15_CAMPAIGN9.md` §1 rules, rows 26/27, and the §3.2
   ledger **at head** — another lane may have started this work. If a ledger row for
   C9-09/C9-10 exists with status other than NOT STARTED, reconcile before proceeding.
2. Check Gate-B status: search the ledger for `C8-11-CORRECTNESS-CHECKPOINT`.
   - **If Gate B is not COMPLETE and no explicit gate amendment for C9-10 exists**: you may
     land Slices 1-2 below (registry + counters + variant plumbing with
     `forceSceneMRT=true` default — zero behavior change, R2-class), but you must **STOP
     before Slice 3** (the default flip to demand-driven). Either (a) draft a gate
     amendment paragraph in the queue explaining why the topology flip is
     correctness-independent (hard sell — it isn't obviously, since MRT feeds SSR/NPR/
     contact-shadow visuals) and get it recorded per queue §1, or (b) mark the ledger row
     `PARTIAL / PAUSED — Slice 3 Gate-B-blocked` and move on. Do NOT silently flip.
3. `git branch -a` — surface any non-main branches to the user (CLAUDE.md branch
   transparency). Work trunk-only or in a worktree per the active campaign engine's rules.
4. Re-verify every anchor in the "Architecture today" section with the inline greps.

#### Slice 1 — C9-09: registry + counters (observe-only; zero behavior change)

1. Create `packages/engine/Source/Renderer/WebGPU/WebGPUAttachmentDemandRegistry.ts`:
   - `export interface AttachmentDemandRecord { ... }` per invariant 2 (plain data,
     no `any` — the TS `any` ban is absolute in this repo).
   - `export function computeAttachmentDemand(sceneLike, options): AttachmentDemandRecord`
     — pure; reads `scene._enableSSR`, `_enableNPROutlines`, `_enableContactShadows`,
     `scene.deferredLighting` (NOT `frameState.useDeferredLighting` — compute before
     frameState propagation is fine, but simplest is to read the same
     `frameState.useDeferredLighting` the producer reads; pick ONE and document),
     `scene.debugShowGBufferNormals`, AO/SSGI state via
     `scene.postProcessStages?.ambientOcclusion` (SSGI only demands when the AO stage is
     enabled AND algorithm is "ssgi" AND — mirror the existing AO feed gate — deferred
     lighting is on; verify against `WebGPUSceneRenderer.ts` ~3163-3190 before encoding
     this rule), and the force switch.
   - Export focused Node specs (pure-function combination matrix — all 2^6 reader
     combinations map to the right topology; unknown/force cases).
2. Call it once per frame in `WebGPUContext.updateAndClearFramebuffers` (before the
   G-buffer block at ~3689) and stash the frozen record on the context (e.g.
   `context._attachmentDemand`). In this slice the record does **not** yet gate anything.
3. Counters: extend the perf/API-instrumentation surface with per-frame
   `gbufferBytes`, `gbufferMsaaCompanionBytes`, `slot1ResolveCount`, `sceneColorAttachmentCount`,
   `gbufferReaders` bitmask. Cheapest correct wiring: compute bytes from the
   `GBufferFramebuffer` dimensions at the allocation site, count slot-1 appends at the
   three pass-open sites. Expose via a `CesiumDebug.attachmentDemand()` command (and
   register it in `migration_doc/DEBUGGING_GUIDE.md` — the guide MUST be updated with any
   new CesiumDebug command, per CLAUDE.md).
4. Ledger row for C9-09: PARTIAL or COMPLETE per its own acceptance (record + counters +
   both-executor feed). Note in the row that the graph-side consumption is deferred to
   Wave-6 T1 by design.

#### Slice 2 — C9-10 plumbing behind `forceSceneMRT=true` (still zero behavior change)

1. **New define bit** in `WebGPUShaderDefines.ts`: `SCENE_SINGLE_TARGET = 1 << <next free>`
   with full JSDoc (what it gates, consumers list). Add-only; do not touch existing bits.
2. **Shader edits** — wrap every `@location(1) normalRoughness` declaration AND every
   write to it (in `FragOutput` construction helpers). The preprocessor has no OR
   operator; where `CAPTURE_MODE` already gates, nest:
   ```
   //>>ifdef CAPTURE_MODE
   //>>else
   //>>ifdef SCENE_SINGLE_TARGET
   //>>else
     @location(1) normalRoughness: vec4<f32>,
   //>>endif
   //>>endif
   ```
   Files: `GlobeTerrain.wgsl` (FragOutput ~3012 + makeFragOutput ~3030 — nest inside the
   existing blocks), `ModelPBRComplete.wgsl` (~2345 + its makeFragOutput-equivalent write
   sites), `ErrorPipeline.wgsl` (unconditional today — add plain
   `//>>ifdef SCENE_SINGLE_TARGET //>>else ... //>>endif`), all
   `Primitive/PrimitiveMat*Lit.wgsl` + `PrimitivePhong*.wgsl` + the ellipsoid shader.
   **Edit each return-path/struct by hand — do not write an automated patcher** (the
   Batch 116 Sub-C postmortem failure mode; `Tools/batch-117-wrap-returns.mjs` and
   `Tools/batch-121-wrap-lit-shaders.mjs` exist as historical references for the shape of
   the edits, but hand-verify every file). After editing, confirm `defines=0` output is
   byte-identical: `npx gulp build` then diff a couple of generated
   `Source/Shaders/WebGPU/**/*.js` modules against git HEAD's build, or run the shader
   preprocessor spec suite.
3. **Pipeline variants**:
   - `makeSceneFBTargets` / `makeSceneFBTargetsMRT` already branch on the module flag —
     unchanged (the flag becomes registry-mirrored in Slice 3; under `forceSceneMRT=true`
     it stays `true`).
   - Add the topology dimension to pipeline **cache keys** at the emitting/caching choke
     points so both variants can coexist:
     `WebGPUModelPipelineCache.ts` (it already keys HDR/pick/etc. — follow the
     `_pickFormat` precedent from Batch 672), `WebGPUGlobeSurfacePipelines.ts` (append a
     `_1t` name suffix exactly like the existing `_cap_<format>` suffix, and OR
     `SCENE_SINGLE_TARGET` into `defines` on the one-target branch; the one-target branch
     produces `targets: [slot0]`), `WebGPUPrimitiveCommands.ts`,
     `WebGPUEllipsoidPrimitiveRenderer.ts`, and the collection renderers. For renderers
     whose caches are single-slot and hard to key (survey first — many share
     `WebGPUCollectionRendererBase`), fall back to observing a new
     `context._sceneTopologyGeneration` bump — but if you use a generation bump anywhere,
     it must be bumped in `updateAndClearFramebuffers` (frame start, before pipeline
     lookup) and you must add that renderer to the verification matrix, because the
     late-rebuild race is a known live bug class (ledger:
     `NEW-WEBGPU-SCENE-PASS-MSAA-FLIP-TRANSITION`).
   - `WebGPUDerivedCommand.ts` — verify derived-pipeline caches (velocity, invert-class,
     translucent derivatives) key on the restamped target shape; if their keys are
     defines-only, include topology.
4. **Render bundles** — moon/globe bundle keys must include topology
   (`WebGPUEnvironmentRenderer.js:1070`; grep `bundleKey` for construction). v1: also call
   `context.renderBundleManager?.invalidateAll?.()` on any topology transition (same
   pattern as the format-generation site in `WebGPUSceneRendererEnsureResources.ts:346-349`).
5. Everything still runs with `forceSceneMRT=true` default ⇒ the tree is byte-identical at
   defaults. Land with the off-gate proof (see Verification).

#### Slice 3 — flip the default to demand-driven (Gate-B-gated — see Step 0)

1. Registry writes the mirror: at the top of `updateAndClearFramebuffers`, per frame:
   `setSceneFBMrtMode(record.topology === "mrt")`.
2. Gate the G-buffer allocation block (`WebGPUContext.ts` ~3689-3720) on
   `record.gbufferDemanded`; when not demanded and `view.gBufferFramebuffer.framebuffer`
   is truthy, destroy it (`view.gBufferFramebuffer.destroy()` releases textures; the View
   object itself stays — do NOT null the `gBufferFramebuffer` slot, other code
   null-checks the *views*, not the object). Re-check `GBufferFramebuffer.destroy()`
   (lines ~240-255) — it calls `destroyObject`, which poisons the instance; if so,
   construct a fresh `GBufferFramebuffer` on re-demand or add a non-poisoning
   `releaseResources()` method instead. **Decision point:** if `destroy()` poisoning
   can't be cleanly handled, add `releaseResources()` to `GBufferFramebuffer.js` (keeps
   `update()` able to re-allocate) — do not work around it at the call site.
3. `buildMrtSlot1Attachment` — keep as sole slot-1 authority; it already returns null when
   the mirror is false. Add a defensive invariant: if topology is MRT but
   `gb.renderAttachmentView` is null at pass open, `console.error` (permanent sentinel per
   CLAUDE.md logging rules) — that combination means the frame-freeze contract broke.
4. Producer/consumer glue: no changes needed (verified: NPR/contact skip on null view;
   SSR flags absent-G-buffer; AO uses placeholder; producer requires deferred ⇒ MRT).
   BUT check effect bind-group caches that captured the old view (trap 11).
5. Update docs in the same batch: queue §3.2 ledger rows for both IDs,
   `DEBUGGING_GUIDE.md` (new CesiumDebug command + new probe), `DEFERRED_WORK.md`
   (the `NEW-GBUFFER-MRT-*` and `NEW-GBUFFER-CONSUMER-*` entries at ~line 4550+ describe
   the always-on world — annotate them with the demand-driven change),
   `FEATURE_INVENTORY.md` §B/§C as applicable, and the file-top docstrings of
   `WebGPUSceneFBTargetHelpers.ts` + `GBufferFramebuffer.js` (both currently document
   "always allocated / always on" — a doc-code drift here is worse than the bug).

---

### Traps for the unwary

1. **Trailing-null target arrays.** A pipeline whose targets are `[slot0, null]` is
   validated as **1-target** and is INCOMPATIBLE with a 2-attachment pass ("Attachment
   state not compatible", Batch 117). The MRT placeholder must be non-null
   `{format:"rgba16float", writeMask:0}`. Conversely the ONE_TARGET variant must be a
   length-1 array — not `[slot0, null]`.
2. **Shader/pipeline output mismatch is a creation-time error in BOTH directions.**
   `writeMask:0xf` on slot 1 without the shader emitting `@location(1)` → "Color target
   has no corresponding fragment output" (Batch 116/118). A shader emitting `@location(1)`
   against a 1-target pipeline → also a creation error. Shader define, pipeline targets,
   and pass attachments must flip **as one variant**.
3. **Mid-frame divergence.** The three pass-open sites each call
   `buildMrtSlot1Attachment` independently. If the topology source can change mid-frame
   (consumer flag flipped by an event listener during render, or the mirror re-stamped by
   a second context — see trap 15), frustum N's pass has 2 attachments and frustum N+1's
   has 1, while pipelines are fixed → validation failure mid-frame. The frame-frozen
   record + per-frame mirror stamp is the defense; never read `scene._enableSSR` etc.
   directly at pass-open time.
4. **The generation-bump race precedent.** `scene.msaaSamples` runtime flips leave stale
   pipelines bound for 1-2 frames (`NEW-WEBGPU-SCENE-PASS-MSAA-FLIP-TRANSITION`, live
   bug). Topology has the same shape. Variant-cache-and-select (both pipelines cached,
   selected by frozen key) has no such window; invalidate-and-rebuild does. Prefer
   variants everywhere; treat any generation-bump fallback as needing its own transition
   test in the probe matrix.
5. **Render bundles fail at EXECUTION, not creation.** A bundle recorded with
   `colorFormats:[scene, rgba16float]` executed inside a 1-attachment pass errors at
   `executeBundles` time and invalidates the whole command buffer (black canvas). Every
   bundle key must include topology (moon at `WebGPUEnvironmentRenderer.js:1070`; grep
   for other `getOrCreate(bundleKey` sites), plus `invalidateAll()` on transition as belt
   and suspenders.
6. **`resolveTarget` spread.** `buildMrtSlot1Attachment` adds `resolveTarget` only when
   `gb.resolveTargetView` is non-null (MSAA). If you ever get the sample-count wrong the
   error is "the sample count of the attachment does not match" and it kills the whole
   scene pass (the Batch 244 TAA black-canvas incident). The ONLY sample-count authority
   for the G-buffer is `context._msaaSamples` (effective; TAA forces 1 —
   `WebGPUSceneRenderer.ts:1402-1414`), never raw `scene.msaaSamples`.
7. **`ErrorPipeline.wgsl` emits `@location(1)` unconditionally** (line 53). It only
   compiles when a model shader build FAILS, so you will not hit it in happy-path
   probes. Forgetting it means: in one-target mode, a model shader error cascades into a
   second pipeline-creation error and the error-visualization feature silently dies.
   Wrap it with the new define and route its build through `preprocess`.
8. **The depth-only globe pre-pass writes slot 1 on purpose.** In
   `WebGPUGlobeSurfacePipelines.ts` the depth-only back-face variant has
   `colorWriteMask=0` on slot 0 but **0xf on slot 1** (comment at ~480-489: back-face
   normals are real G-buffer data). Don't "fix" that asymmetry while editing — it is
   intentional.
9. **Scaffolding is not dead code (charter §7).** `DeferredGBuffer.wgsl`,
   `DeferredLighting.wgsl`, the compute producer (`GBufferNormalsFromDepth`), the AO
   placeholder texture, and `NEW-GBUFFER-MRT-COMPUTE-PRODUCER-RETIRE` (DEFERRED_WORK
   ~4610) are deliberate partial-implementation scaffolding. This task gates work behind
   demand; it does NOT delete producers, consumers, or WIP deferred-lighting shaders.
   Similarly do not trim `PerformanceManagerContext`-style WIP interfaces encountered
   while typing the registry.
10. **Shader-module cache identity.** Adding `//>>ifdef` blocks must leave `defines=0`
    output byte-identical (the preprocessor guarantees this only if you put the
    historical code in the `//>>else` branch and change nothing outside the blocks).
    Any stray whitespace/comment edit inside a WGSL file changes the source text and
    churns `WebGPUShaderModuleCache` keys for every variant of that source — harmless
    correctness-wise but it invalidates the "no on-screen rebuild" claim; keep diffs
    surgical. Never renumber `ShaderDefine`/`ShaderSourceId` entries.
11. **Stale bind groups holding a destroyed G-buffer view.** Effects cache bind groups
    containing `normalRoughnessTexture` (AO's "AO-Generate-BG-GB",
    `WebGPUAmbientOcclusionEffect.ts:291`; possibly SSR/NPR/contact-shadow caches —
    grep each effect for `createBindGroup` with the normal view). Toggling demand OFF
    destroys the texture; a cached bind group referencing it makes the next enabled
    frame throw "destroyed texture" — the same failure family as the ledgered
    `GlobeDepth-DepthCopy` destroyed-texture follow-on. On ON→OFF transition, invalidate
    those effect caches (each effect already has a device-loss/resize invalidation path
    to hook).
12. **SCENE2D wrap halves.** The second half opens the scene pass with
    `loadOp:"load"` on ALL color attachments including slot 1
    (`WebGPUSceneRendererPassRedirect.ts:183-200`). Preserve the `sceneFbLoad` plumbing
    when touching the slot-1 append; the wrap is easy to break and only visible in
    SCENE2D at the antimeridian.
13. **`debugShowGBufferNormals` implies deferredLighting.** `CesiumDebug.showGBufferNormals()`
    sets both flags (Scene.js ~3372 comment). If the registry treats only
    `debugShowGBufferNormals` without `deferredLighting` as demand, the overlay shows the
    clear sentinel — still count BOTH as readers so a user setting the raw flag manually
    gets a working overlay.
14. **`usePostProcess` is unconditionally true on WebGPU** (the post-process chain is the
    only canvas blit — `WebGPUContext.ts:3641-3646`). Demand-gating applies ONLY to
    slot 1 / the G-buffer. Do not let any "attachment demand" abstraction near the scene
    color/depth targets, globe depth, or the pick FBO in this slice (C9-07 owns the
    canvas pass; FAR-404 owns OIT; FAR-408 owns packed depth).
15. **Multi-context / split-screen.** `_mrtMode` is module-global; two simultaneous
    viewers (the split-screen comparison page, `Apps/WebGPUTest/split-screen-comparison.html`)
    with different demand would re-stamp it to different values. Per-frame re-stamping at
    frame start is safe because JS frames are synchronous and pipelines/passes for a
    frame are built within that frame — but pipeline CACHES are per-renderer/per-scene,
    so cached variants don't cross contexts. Add a split-screen leg to the probe matrix
    (one viewer SSR-on, one default) to prove it. If it proves unsafe, the fallback is
    threading topology through `makeSceneFBTargets` as a parameter (bigger diff — 33
    files — but unambiguous). Error logs must carry the context ID per charter §3.
16. **Async pipeline compilation on first toggle.** Enabling the first consumer compiles
    the entire MRT variant set. Where pipeline creation is async in this codebase, a cold
    variant can false-miss for a frame (precedent: item 74,
    `NEW-WEBGPU-ASYNC-PICK-PIPELINE-READINESS-CONTRACT`). FAR-403 acceptance says
    "prewarms variants": on the OFF→ON transition frame, prewarm the hot set (globe +
    model + lit primitives) via the existing `prewarm`/sync-create paths rather than
    letting draws vanish for a frame. Conversely do NOT eagerly compile both variants of
    everything at startup — that doubles pipeline-compile cost at boot for nothing
    (`NEW-INDIRECT-IDLE-ALLOCATION-CONTAINMENT` precedent: never-requested capabilities
    allocate nothing).
17. **Monorepo rule.** Edit `packages/engine/Source/**` only; root `Source/` is build
    output. WGSL edits require `npx gulp build` (WGSL → `.js` string modules) before
    probes see them.
18. **Do not weaken the pick path.** Batch 672 made `context.pickPipelineFormat` the sole
    pick attachment authority and PICK derivation single-target. Nothing in this cluster
    should touch pick pipelines, and `probe-hdr-pick-format-closure.mjs` must stay green
    as the regression gate for that.

---

### Verification recipe

Environment: Edge (Playwright `channel: "msedge"` — never Firefox), server via
`node server.js` (probes) / `node server.js --production` (perf lanes). Rebuild first:
`npx gulp build && npx tsc --noEmit`. PROBE_BASE default is `:8080` for most probes.

1. **Off-gate (after Slice 2, and after Slice 3 with force-MRT set):** with
   `forceSceneMRT=true`, default scenes must be pixel-identical to the pre-change tree.
   Run the standing baseline sweep:
   `node Tools/visual-regression/capture-and-diff.mjs` — no scene's mismatch may move
   from its recorded baseline.

2. **New acceptance probe — write `Tools/visual-regression/probe-attachment-demand-mrt.mjs`**
   (template: `probe-hdr-pick-format-closure.mjs` for phase-matrix structure +
   `probe-mrt-validation.mjs` for the `device.onuncapturederror` hook, which you MUST
   include — pass/pipeline incompatibilities surface there, not in console.error).
   Matrix, all phases with zero GPU/page errors required:
   - **Phase A default (no consumers):** assert via CDP/init-script hook on
     `device.createTexture` that no texture with label prefix `Phase8a_GBuffer` is
     created; assert scene render passes have `colorAttachments.length === 1` and no
     slot-1 `resolveTarget` (hook `beginRenderPass`); assert canvas non-black and
     pixel-diff vs the pre-change default capture ≈ 0.
   - **Phases B1-B6, each consumer independently:** `scene.deferredLighting=true`;
     `scene._enableSSR=true` (use `probe-ssr-consumer.mjs`'s scene setup); NPR; contact
     shadows; AO with `algorithm:"ssgi"` (+deferred); `CesiumDebug.showGBufferNormals()`.
     Each: G-buffer textures appear with correct sample counts, scene passes have 2
     attachments, the consumer's visual output matches that consumer's pre-change probe
     limits, `CesiumDebug.attachmentDemand()` reports the right reader set.
   - **Phase C combinations:** at least SSR+contact, SSR+NPR+deferred, all-on.
   - **Phase D toggling:** on→off→on per consumer; after final off, re-assert Phase A
     zero-bytes AND pixel-identity with the Phase A capture (off/restored oracle);
     assert no "destroyed texture" errors on the transition frames (trap 11).
   - **Phase E environment churn:** mid-run HDR flip (`scene.highDynamicRange`), MSAA
     4→1→4 (`scene.msaaSamples`), TAA on/off (forces samples 1), viewport resize,
     deterministic device invalidation/recreate — in BOTH topologies. This is where
     traps 4/6 fail if mishandled.
   - **Phase F split-screen:** the split-screen page with one viewer SSR-on and one
     default (trap 15).
   - Write JSON + PNGs to `Tools/visual-regression/output/attachment-demand/` with the
     campaign naming convention `campaign9-c9-09-10-attachment-demand-<...>-2026-MM-DD.json`.
     **Read the PNGs yourself** before claiming pass (charter §8).

3. **Existing probes that must stay green** (consumer-enabled visuals + the emit chain):
   `probe-mrt-validation.mjs`, `probe-gbuffer-enabled.mjs`, `probe-gbuffer-visualize.mjs`,
   `probe-normalmap-gbuffer.mjs`, `probe-model-mrt.mjs`, `probe-litmat-mrt.mjs`,
   `probe-ellipsoid-mrt.mjs`, `probe-ssr-consumer.mjs`, `probe-ssr-tuned.mjs`,
   `probe-ssr-water.mjs`, `probe-npr-outlines.mjs`, `probe-contact-shadows.mjs`,
   `probe-ssgi.mjs`, `probe-hdr-pick-format-closure.mjs` (pick regression gate),
   `Tools/variant-smoke-test.mjs` (bundle variants). NOTE `probe-gbuffer-enabled.mjs`
   asserts "flipping deferredLighting does not change the canvas" — under demand-driven
   topology the flag now changes attachment topology; if its pixel assertion fails
   because of legitimate (sub-threshold) variance, adjust the PROBE with a comment and
   record it in the ledger row — do not weaken the engine to keep an outdated probe
   green, and do not delete the probe's intent (flag must still not VISIBLY change the
   scene).

4. **Performance evidence (required for the R3 promotion claim):** the canonical
   moving-altitude lanes exactly as written in `migration_doc/DEBUGGING_GUIDE.md`
   §"Canonical moving-altitude campaign (2026-07-14)":
   ```powershell
   node Tools/visual-regression/run-performance-campaign.mjs `
     --workload moving-camera-altitude-track-3d --renderer both --repetitions 2 `
     --output Tools/visual-regression/output/performance/c9-10-clean.json
   # separately, --api-instrumentation for the owner/counter lane
   ```
   Clean and API lanes stay separate; never mix their timings. Pass = default lane shows
   0 G-buffer bytes / 0 companion bytes / 0 slot-1 resolves in the counters, and the
   promotion rule (queue §C / plan §7: ≥5% in a named unsaturated p95 stage OR >3×
   measured noise, no route-segment p99 regression, no WebGL change). Memory is the
   primary win here (~80 MiB) — report bytes explicitly; if CPU/GPU time deltas are
   within noise, say so honestly and promote on the bytes+resolve-count evidence with
   the noise caveat, per the C9-05 ledger row's precedent for honest single-rep claims.

5. **Unit/spec:** registry pure-function Node specs (Slice 1); a
   `shouldAllocateWebGPUOIT`-style exported policy helper for "demanded" (follow
   `WebGPUSceneRendererEnsureResources.ts:163-168` precedent) so the no-allocation rule
   is regression-testable without a browser. `npx tsc --noEmit`, eslint, and the focused
   Karma suites for touched Scene files (Edge binary via `CHROME_BIN`; use
   `--includeName` subsets).

6. **Ledger + docs:** update queue §3.2 rows for C9-09 and C9-10 with exact evidence
   (artifacts, counters, probe names, PNG paths, honest residuals);
   add the probe to DEBUGGING_GUIDE's probe inventory; sync the file-top docstrings
   (Step 3.5 list). A missing ledger update is a campaign-rule violation even if the
   code is perfect.

---

### Rollback boundary

- **What reverts if the gate fails:** ONLY the topology activation — flip the default
  back to conservative full MRT via the force switch / registry default (Slice 3's
  commit). That single switch must restore today's always-on MRT behavior byte-for-byte
  (FAR-403 rollback clause: "capability/active state can force existing MRT mode for
  comparison until all consumers migrate"). If the force switch itself is broken, revert
  the Slice 3 commit.
- **What NEVER reverts:** the consumers (SSR, NPR outlines, contact shadows, SSGI,
  deferred-lighting producer, debug overlay) and their visual quality; the G-buffer
  scaffolding and WIP deferred-lighting shaders; the C9-09 registry, its counters, and
  all specs/probes (campaign rule 6: "Tests and counters remain"; plan §8:
  "Instrumentation and regression tests survive rollback").
- **Never leave `_mrtMode=false` (or an equivalent hard-off) as the rollback state** —
  that is the exact feature-removal anti-pattern queue row 27 forbids: it would strand
  2-target emitter pipelines against 1-attachment passes AND silently degrade
  SSR/NPR/contact-shadow/AO quality.
- Slices 1-2 are observe-only/no-behavior and need no rollback plan beyond ordinary
  revert; they may stay landed even if Slice 3 is rejected.

---

### Pointers

**Source (edit here — never root `Source/`):**
- `packages/engine/Source/Renderer/WebGPU/WebGPUSceneFBTargetHelpers.ts` — `_mrtMode:71`,
  `setSceneFBMrtMode:88`, `isSceneFBMrtMode:97`, `makeSceneFBTargets:146`,
  placeholder/writeMask logic 154-181, `makeSceneFBTargetsMRT:202`
- `packages/engine/Source/Renderer/WebGPU/WebGPUSceneRendererPassRedirect.ts` —
  `buildMrtSlot1Attachment:56-83`, initial-open slot-1 append 191-200, sceneFbLoad 183-193
- `packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts` — `_resumeScenePass:1900`
  (slot1 1928), `_clearDepthStencil:1966` (slot1 2007), effective-MSAA/TAA 1402-1414,
  `_executeGBufferProducer:2533` (MRT skip 2544), AO G-buffer feed ~3163-3190, debug
  overlay gate 3062-3069
- `packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts` —
  `updateAndClearFramebuffers:3591`, unconditional G-buffer block ~3655-3720
- `packages/engine/Source/Scene/GBufferFramebuffer.js` — whole file (update 92,
  destroy ~240)
- `packages/engine/Source/Scene/FramebufferOrchestrator.js:148` — WebGL demand gate
  (reference semantics; do not modify)
- `packages/engine/Source/Scene/Scene.js` — `deferredLighting:~1083`,
  `debugShowGBufferNormals:~1098`, frameState propagation 3369-3376
- `packages/engine/Source/Renderer/WebGPU/WebGPUSceneRendererEnvironmentalEffects.ts` —
  NPR ~223, contact shadows ~259, SSR ~299
- `packages/engine/Source/Renderer/WebGPU/WebGPUSceneRendererEnsureResources.ts` — format
  generation bump 341-349 (pattern), OIT containment 351-369 (do not touch),
  device-invalidation walk 193-218
- `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfacePipelines.ts` — 2-target
  hardcode ~497-506, capture single-target branch ~486-497 (the variant template)
- `packages/engine/Source/Renderer/WebGPU/WebGPUModelPipelineCache.ts` — emitsGBuffer
  927/1011/1088/3167
- `packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.ts:3000`;
  `WebGPUEllipsoidPrimitiveRenderer.ts:494`
- `packages/engine/Source/Renderer/WebGPU/WebGPUDerivedCommand.ts` —
  `restampSceneFBTargets:266-282`
- `packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js:1070` — moon
  bundle colorFormats
- `packages/engine/Source/Renderer/WebGPU/WebGPUShaderDefines.ts` — `CAPTURE_MODE:409`
  (bit 17; template JSDoc for the new bit)
- WGSL: `Shaders/WebGPU/Globe/GlobeTerrain.wgsl` (~3010-3045),
  `Shaders/WebGPU/Model/ModelPBRComplete.wgsl` (~2343-2355),
  `Shaders/WebGPU/Model/ErrorPipeline.wgsl:53`,
  `Shaders/WebGPU/Primitive/PrimitiveMat*Lit.wgsl` + `PrimitivePhong*.wgsl`

**Specs/plans:** queue rows 26-27 + §1 rules + §3 gates + §3.2 ledger
(`migration_doc/QUEUE_2026-07-15_CAMPAIGN9.md`); plan §2.3/§3/§4.3/§7/§8
(`FORK_PERFORMANCE_RTE_VISIBILITY_REMEDIATION_PLAN_2026-07-15.md`); FAR-401/402/403 at
`FORK_ARCHITECTURE_REMEDIATION_PLAN_2026-07-13.md:723-748`;
`SOL_AUDIT_REPORT_2026-07-16.md` (OIT ratification context, P0-6);
`DEFERRED_WORK.md` ~4540-4620 (`NEW-GBUFFER-MRT-PRIMITIVE-EMIT`,
`NEW-GBUFFER-MRT-COMPUTE-PRODUCER-RETIRE`, `NEW-GBUFFER-CONSUMER-*`).

**Probes:** `Tools/visual-regression/probe-{mrt-validation,gbuffer-enabled,
gbuffer-visualize,normalmap-gbuffer,model-mrt,litmat-mrt,ellipsoid-mrt,ssr-consumer,
ssr-tuned,ssr-water,npr-outlines,contact-shadows,ssgi,hdr-pick-format-closure}.mjs`;
perf: `Tools/visual-regression/run-performance-campaign.mjs`
(`--workload moving-camera-altitude-track-3d`); new:
`probe-attachment-demand-mrt.mjs` (this task creates it).

**Ledger rows to update:** `C9-09-ATTACHMENT-DEMAND-REGISTRY`,
`C9-10-CONSUMER-DRIVEN-MRT` in queue §3.2 (both currently NOT STARTED / unlisted);
cross-reference Gate B status and, if Slice 3 is blocked, say so with the drafted
amendment text in the row.

---

<a id="g6"></a>

## G6 — Retained Terrain: `C9-11-RETAINED-TERRAIN-DESCRIPTORS` (FAR-309) + `C9-12-TERRAIN-STATIC-DYNAMIC-UPLOAD-SPLIT` (FAR-303)

**Audience:** an Opus worker with the fork CLAUDE.md charter loaded but no campaign memory.
**Anchors verified against the live tree post-Batch-672 on 2026-07-16.** If a cited line has drifted more than ~40 lines, grep for the quoted symbol/comment marker instead of trusting the number, and re-read the surrounding block before editing.

These two tasks are **Wave 2 items 29 and 30** in `migration_doc/QUEUE_2026-07-15_CAMPAIGN9.md` (queue rows quoted below) and are the campaign's single biggest performance lever. The evidence chain that ranks them first:

- `C9-01` engine-logical evidence (ledger §3.2 row `C9-01-REGRESSION-ATTRIBUTION-AND-SAVED-BUNDLE-REPLAY`, artifact `Tools/visual-regression/output/performance/campaign9-c9-01-logical-owner-counters-webgpu-r1-2026-07-15.json`): over 1,189 frames of the moving-altitude route, **41,224 tile calls** each allocated ready-layer/command arrays and pass slices; **39,300 emitted descriptors mapped 1:1 to fresh adapter command objects and camera/tile UB packs**; aligned UB staging totaled **115.1 MiB**; WebGPU command-count/CPU-time correlation was **0.604–0.783 vs WebGL 0.109–0.139**. Bind-group caching is already healthy (99.66% hits; 3 group-0 / 1 group-2 creates total; 526 group-1 creates tracked imagery churn).
- Gate-A clean median CPU p95: **WebGL 5.50 ms, WebGPU 7.51 ms** (`campaign9-gate-a-clean-r5-2026-07-15.json`). The campaign target (queue §12.6) is ≥10% whole-route and ≥15% near-ground WebGPU CPU-p95 improvement vs Gate A, or >3× measured noise.

Read FIRST, in this order:
1. `migration_doc/QUEUE_2026-07-15_CAMPAIGN9.md` — §1 rules, §3.2 live ledger (you MUST update it), Wave 2 rows 28/29/30/30A, §12 landing requirements.
2. `migration_doc/FORK_PERFORMANCE_RTE_VISIBILITY_REMEDIATION_PLAN_2026-07-15.md` — §4.2 "Retained terrain frontend" (the design you are converging on), §3 invariants, §8 rollback discipline.
3. `migration_doc/FORK_ARCHITECTURE_REMEDIATION_PLAN_2026-07-13.md` — `FAR-303` (line ~633) and `FAR-309` (line ~700) for acceptance wording; note FAR-303's "2026-07-14 preparation slice" (the staged ring) is ALREADY LANDED — do not redo it.
4. `migration_doc/SOL_AUDIT_REPORT_2026-07-16.md` — ratings #10 (terrain UB ring staging, introduced then fixed the `readPixelsAsync` flush gap P0-4) and #12 (C9-01 counters); §3 P0 list (all applied in Batch 670-672 era — verify ledger rows `AUDIT-P0-*` say COMPLETE before you start).

---

### Architecture today (post-Sol, verified)

#### The full per-frame terrain command path, end to end

**Step 0 — selection (backend-neutral, DO NOT TOUCH).**
`QuadtreePrimitive` selects tiles into `quadtree._tilesToRender`; `GlobeSurfaceTileProvider` buckets them into `this._tilesToRenderByTextureCount`. One selection set serves both backends — this is campaign rule §1.2 and was certified by `C9-02` (artifact `campaign9-c9-02-terrain-checkpoint-parity-2026-07-15.json`: identical selected tile IDs both backends at nine route checkpoints). `Pass.GLOBE` bypasses `SceneOctree` entirely. **Nothing in C9-11/C9-12 may alter which tiles are selected or their order.**

**Step 1 — provider loop.**
`packages/engine/Source/Scene/GlobeSurfaceTileProvider.js` — `endUpdate(frameState)` at **line 370**; the per-tile loop at **lines 447–472** calls `addDrawCommandsForTile(this, tile, frameState)` once per selected tile per frame. Lines 430–445 hold the optional C9-02 ownership-diagnostics hooks (`frameState.context._visibilityExecutionOwnershipDiagnostics`) — keep them working. Exaggeration-change and scene-mode-change handling live at lines 401–428 (they mutate tiles BEFORE the loop — relevant to invalidation, see traps).

**Step 2 — backend dispatch.**
`packages/engine/Source/Scene/GlobeSurfaceTileProviderRendering.js` — `addDrawCommandsForTile` at **line 1182**; lines 1186–1191 fetch `context.getFeatureRenderer(FeatureRendererKey.GLOBE_SURFACE)` and route to `addWebGPUDrawCommandsForTile(tileProvider, tile, frameState, fr)`; the WebGL path falls through below and must remain byte-identical.

**Step 3 — the scene adapter (`addWebGPUDrawCommandsForTile`, line 791).**
Per tile per frame it currently:
- updates/creates `TerrainFillMesh` for unloaded tiles (797–802), resolves `mesh = surfaceTile.renderedMesh || surfaceTile.mesh` (804);
- fetches the **per-GPUDevice renderer** from module-level `const _webgpuGlobeRenderers = new WeakMap()` (**line 788**, lookup 858–865; `new fr.RendererClass()` + `initialize(device, shaderCode, fmt)` on miss);
- reads `_webgpuGlobeRenderer._logicalCounters` (871) — the C9-01 counter sink;
- publishes `context._webgpuSceneCaptureSources` when `context.sceneCaptureReflections === true` (881–886);
- calls `_webgpuGlobeRenderer.createTileCommands(tile, surfaceTile, tileProvider, frameState, uniformState)` (900–906). **Empty/null return is the "async pipeline still cooking" signal** (907–918) — wakeup is centralized via `WebGPURenderPipelineCache → AsyncResourceMonitor → Scene.requestRender()`;
- then, **per returned descriptor** (loop at 930): computes a **freshly allocated** 2D-projected `BoundingSphere` in non-3D modes (962–994 — the comment at 966–971 explains why it is deliberately NOT scratch: command objects are per-frame, a shared scratch would be clobbered);
- builds a **fresh command object literal with a fresh `execute` closure** (**lines 995–1091**): `isWebGPUDrawCommand: true, pass: Pass.GLOBE, owner: tile, cull, boundingVolume, _pipeline, _bindGroups, _bindGroup0DynamicOffsets, _vertexBuffer, _indexBuffer, _indexCount, _indexFormat, _shadowCastLayout, _shadowCastTerrainUB, vertexStride, execute()`;
- counts it (`logicalCounters.adapterCommandObjects`, 1092–1095);
- attaches globe-translucency derived commands via the `GLOBE_TRANSLUCENCY` feature renderer (1097–1104);
- in pick/pickVoxel mini-frames only, builds a second fresh pick command object (**1126–1172**, counted as `pickCommandObjects`) attached to `command.derivedCommands.picking.pickCommand`;
- `frameState.commandList.push(command)` (1174).

`updateWebGPUForPick` (**line 1979**) re-runs `addWebGPUDrawCommandsForTile` for EVERY selected tile again inside each pick mini-frame (mirrors WebGL's unconditional `_drawCommands` re-push; needed for classification depth).

**Step 4 — the renderer (`WebGPUGlobeSurfaceRenderer.createTileCommands`, `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts` line 594).**
Per tile call it currently:
- bumps `logicalCounters.tileCalls` (608–611); eagerly touches `frameState.context.uniformAllocator` (618 — keep this, see BUG-9 note there);
- captures cloud-shadow views from `context._cloudCache` (627–659), the central pipeline cache (666–673);
- **format-generation guard** (680–715): on `context._scenePipelineFormatGeneration` change (HDR/MSAA toggle) re-reads `scenePipelineFormat`, `pickPipelineFormat`, `_msaaSamples` and **clears all three local pipeline caches**;
- mirrors `_logDepthEnabled` from `context._logDepthWriteEnabled` **every frame, independent of the ctxGen guard** (717–723);
- `this._bindGroupCache.beginFrame(frameState.frameNumber ?? 0)` (732) — per-frame tick + age eviction of the globe bind-group cache;
- `getTileKeyHelper(tile)` → `"level_x_y"`, then `getOrCreateTileBuffersHelper(this, tileKey, mesh)` (734–736) — **this part IS already retained** (see below);
- allocates a fresh `readyLayers: CesiumTileImagery[]` array and scans `surfaceTile.imagery` for entries with `readyImagery` (**739–756**, counters `readyLayerArrays`, `readyLayers`);
- computes `passCount = ceil(totalLayers / this._imagerySlotCount)` (16 on full-layout adapters, 1 on reduced) and allocates a fresh `commands: TileDrawDescriptor[]` (762–770, counter `commandArrays`);
- reads debug flags, cull gates (843–894);
- **per pass** (loop at 896): `readyLayers.slice(layerStart, layerEnd)` (**900**, counter `passLayerSlices`); pipeline selection through helpers (wireframe/debug/production/material variants, 942–1050; null → `continue` while async-cooking);
- **`createCameraUniformBufferHelper(...)` (1052–1061) and `createTileUniformBufferHelper(...)` (1062–1071)** — full repack + ring upload of both UBs **per tile per pass per frame** (counters `cameraUniformPacks/…Bytes`, `tileUniformPacks/…Bytes` at 1072–1087);
- `_getOrCreateBindGroup0(device, cameraUB, tileUB)` (1089) — cached; `_createTextureBindGroup(device, passLayers)` (1093) — cached; `_createWaterOceanBindGroup` (1095) — cached; effects `bindGroup3` (1123–1255) — resolved per tile per pass from live shadow/CSM/clipping/atmosphere-LUT state, routed through `createEffectsBindGroup` (its own cache in `WebGPUEffectsBindGroup.js` + `WebGPUEffectsStateCache.js`) or `this._placeholderEffectsBG`;
- index-overflow clamp (1273–1300), skirt suppression (1302–1322);
- globe-translucency pre-pass descriptors (depth-only back-face / translucent back-face / depth-only front-face, 1324–1516) pushed conditionally;
- `bindGroup2Final = this._createWaterOceanMaterialBindGroup(...)` (1522–1537) — note the pre-pass commands use `bindGroup2`, the color command uses `bindGroup2Final`; both resolve through the same identity-keyed cache (comment at 1944–1957);
- pick pipeline selection on the primary pass only (1549–1559);
- pushes the main `TileDrawDescriptor` (1561–1585); `passDescriptors` counter (1588–1592).

**Step 5 — UB packing and the ring.**
- `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceCameraUB.ts` — `createCameraUniformBuffer` (**line 97**) packs `CAMERA_UNIFORM_FLOATS = 232` floats (928 B; `WebGPUGlobeSurfaceTypes.ts:165`) into the host scratch `_cameraUniformData`, then `writeUniformSlice` (**line 1028**) routes it through `frameState.context.uniformAllocator.allocateAndWrite(data, bufferSize)` (staged), returning `{buffer, offset, size}`. It also **side-effects the shared `uniformState._logDepthEncodeNearFar` stash** (988–1005) — consumed by depth-sample classifiers AND `WebGPUDepthPlane.update` (the C9-02B scene-half fix). `computeModifiedModelView` (1116) bakes `view × mesh.center` in **CPU f64** (RTE requirement).
- `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTileUB.ts` — `createTileUniformBuffer` (**line 116**) does `data.fill(0)` (128) then packs `TILE_UNIFORM_FLOATS = 484` floats (1,936 B; `WebGPUGlobeSurfaceTypes.ts:227` — the module docstring says "476 floats/1904 bytes"; **the constant is authoritative**): 16 imagery-layer blocks × 24 floats (translationAndScale, texCoordsRectangle, colorToAlpha, cutout, alpha/brightness/contrast/saturation/hue/gamma/split), dayNightAlpha, useWebMercatorT flags, fog, water-mask TS, cartographic limit, night fade, vertical exaggeration, flags, ocean params, wave time, split position, debug fields, HSB, ground-atmosphere control, translucency rect. Layer values are resolved via `resolveImageryLayerValue` — **they can be callback-shaped (functions of frame/time)**.
- `packages/engine/Source/Renderer/WebGPU/WebGPURingBufferAllocator.ts` — 4 MiB × 3 pages, 256-B aligned (`WebGPUContext.ts` getter at **4654–4667**). `beginFrame` (184) advances the page; `allocateAndWrite` (307) stages into a CPU shadow with dirty-range tracking; `flush` (341) emits ≤1 `queue.writeBuffer` per dirty page; `endFrame` (202) trims overflow pages on a 60-frame cadence.
- `packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts` — `beginFrame` advances the ring (**1758**); `beginPickFrame` **also advances the ring** (**1834**) — pick mini-frames invalidate all scene-frame ring offsets; `endFrame` flushes the ring (**2185**) → `performanceManager.endFrame` → `encoder.finish()` + `queue.submit` (2193–2194) → deferred-texture-destroy drain via `onSubmittedWorkDone` (2201–2219) → `allocator.endFrame()` (2222). `readPixelsAsync` flushes before its mid-frame submit (**2964** — audit P0-4 fix; any new mid-frame finish/submit path you add must do the same).

**Alignment math that reproduces the 115.1 MiB number:** per descriptor, camera 928 B → 1,024 B aligned + tile 1,936 B → 2,048 B aligned = 3,072 B. 39,300 descriptors × 3,072 B ≈ 115.1 MiB. This is what C9-12 attacks.

#### What is ALREADY retained (do not rebuild, do not break)

| Resource | Where | Key / invalidation |
| --- | --- | --- |
| Tile VB/IB/shadow-cast UB | `WebGPUGlobeSurfaceTileBuffers.ts` `getOrCreateTileBuffers` (121), cache `renderer._tileBufferCache` | key `"level_x_y"`; entry valid iff `cached.meshGeneration === (mesh._webgpuGeneration||0)` **and `cached.sourceVertices === mesh.vertices`** (139–149). NOTE: nothing ever sets `mesh._webgpuGeneration` on terrain meshes (grep-verified) — the **vertices-reference identity check is the real invalidator** (NS-WEBGPU-TILE-POPPING-SKIRTS fix). |
| Imagery GPUTextures + views | `WebGPUGlobeSurfaceTextures.ts`, cache `_imageryTextureCache` / `_waterMaskTextureCache` | per-imagery/per-WebGL-texture-`_id` keys. **519 direct uploads retained 173.0 MiB with ZERO retirement** in C9-01 — owned by `C9-12A`/`C9-15`/`FAR-200`, **not by you**. |
| Bind groups 0/1/2 | `WebGPUGlobeBindGroupCache.ts` (renderer field at Renderer.ts:309) | identity-keyed (`cache.idOf(resource)` tuples); group 0 keyed on (camera page, tile page) buffer identities only — byte offsets ride as **dynamic offsets** (Batch 292); age eviction 600 frames, scan every 120. |
| Effects bind group (group 3) | `WebGPUEffectsBindGroup.js` + `WebGPUEffectsStateCache.js` | own owner-keyed slot cache (`owner: frameState` at Renderer.ts:1232). |
| Pipelines | central `WebGPURenderPipelineCache` + renderer-local keyed maps | wiped on `_scenePipelineFormatGeneration` bump; `_logDepthEnabled` participates in cache keys, NOT in the wipe. |
| Ring pages | `WebGPURingBufferAllocator` | recycled every 3 frames — **anything allocated in the ring is per-frame by construction**. |

**Eviction status:** `evictStaleResources(activeTileKeys)` (`WebGPUGlobeSurfaceTileBuffers.ts:448`, delegator at Renderer.ts:2299) **has no production caller** — only `destroy()` uses it (Renderer.ts:2364). C9-01 measured 690 tile-buffer misses / 181 rebuilds → 509 net live entries / 5.51 MiB over the route. Terrain byte-budget/retirement is `C9-15`/`FAR-200-S3` — **explicitly out of scope for C9-11/12** (queue §3.1 row "Terrain GPU buffers grow without a production byte-budget/retirement owner"). Your retained packets must not make this worse (bound them to `_tileBufferCache` lifetime), but do not build an eviction system here.

#### What is rebuilt EVERY frame per tile (the target of C9-11)

1. `readyLayers` array + scan (Renderer.ts:739–756).
2. `commands` array + `passLayers` slice per pass (765, 900).
3. Camera UB pack + ring upload (232 floats) per tile per pass.
4. Tile UB `fill(0)` + full 484-float repack + ring upload per tile per pass.
5. Effects/bindGroup3 gate re-evaluation + `createEffectsBindGroup` call per tile per pass.
6. Every `TileDrawDescriptor` object.
7. Every scene-adapter command object + `execute` closure (+ fresh non-3D bounding sphere, + pick command in mini-frames, + translucency derived commands).

---

### Target design + invariants

Queue row 29 (`C9-11-RETAINED-TERRAIN-DESCRIPTORS` / FAR-309, R2): *"Preserve the shared WebGL/WebGPU quadtree selected-tile set, then retain WebGPU tile/imagery/pass/pipeline/effect packets and scratch spans. Key mesh/content and imagery revisions, mode, water, clipping/shadows, effect generation, HDR/MSAA/log-depth, and device generation. Warm moving frames create no full arrays, slices, command wrappers, or execute closures per tile/pass; camera/frustum offsets update in place."*

Queue row 30 (`C9-12-TERRAIN-STATIC-DYNAMIC-UPLOAD-SPLIT` / FAR-303, R2): *"Separate stable tile/material bytes from per-view/per-frustum ring data. Changed tiles only rewrite their ranges; upload calls and bytes fall without stale multi-view or mode data."*

Related rows you must sequence around:
- Row 28 `NEW-GLOBE-EFFECTS-PER-VIEW-PREPARED-HANDLE` / `C9-13` / `FAR-300` (**NOT STARTED**): "Prepare one exact revision-keyed terrain-global effects handle per frame/view. Tiles consume it without repacking shadows, clipping, CSM, atmosphere LUT, or identity strings." The queue orders it BEFORE C9-11. If it has not landed when you start, EITHER do it first as its own slice, OR design C9-11's per-frame packet-refresh step to resolve effects state once per frame (hoisted out of the per-tile loop into `createTileCommands`'s prologue or the provider's `endUpdate` prologue) — which is that item's core anyway. Do not leave per-tile-per-pass effects gate evaluation in the warm path.
- Row 30A `C9-12A-IMAGERY-SOURCE-REALIZATION-DEDUP-AND-MIP-PREP` (**NOT STARTED**): imagery texture dedup/mips/retirement. NOT yours; just don't collide (your revision key consumes texture-view identities, whatever produces them).

#### Invariants (numbered — verify each before landing)

1. **Selection untouched.** Same `_tilesToRender` / `_tilesToRenderByTextureCount` consumption; command `owner: tile`, `pass: Pass.GLOBE`, bounding-volume/cull semantics (Batch 167/268 comments at Rendering.js:932–1019) byte-identical. C9-02 ownership lanes must still pass.
2. **Retained-packet key is EXACT and complete.** A packet may be reused only when ALL of the following are unchanged:
   - mesh identity: `mesh.vertices` reference + `renderedMesh`-vs-`mesh` source (mirror the `_tileBufferCache` discipline at TileBuffers.ts:139–149);
   - imagery set + order: the ordered tuple of `(tileImagery.readyImagery texture-view identity, useWebMercatorT, textureTranslationAndScale bytes, textureCoordinateRectangle bytes)` for every ready layer, plus total ready count (pass split depends on it);
   - globe material: `tileProvider.material` type + `wgslShaderSource` identity;
   - scene mode (`frameState.mode`) — and in MORPHING, nothing is cacheable (morphTime per frame);
   - water: `surfaceTile.waterMaskTexture` identity (may be a fill's), `waterMaskTranslationAndScale` bytes, `tileProvider.hasWaterMask/showWaterEffect/oceanNormalMap` gates;
   - clipping: `clippingPlanes` enabled/length/unionClippingRegions + `useHardwareClipDistances`, `clippingPolygons` enabled/length;
   - shadows: `shadowState.lightShadowsEnabled` + `lightShadowMaps[0]` identity, CSM enabled/params-buffer/array-view identity, cloud-shadow view identity (real vs placeholder vs cascade);
   - translucency: `globeTranslucencyState.translucent` + `_backFaceTranslucent` + `cameraUnderground` + `backFaceCulling` (they change pass structure, not just uniforms);
   - topology: `_scenePipelineFormatGeneration` + `_logDepthEnabled` (**separate signals!** — the ctxGen wipe at Renderer.ts:687–715 does NOT cover a log-depth flip; the flip only changes cache keys at 717–723);
   - debug: `debugShowGlobeWireframe`, the three fragment debug flags, `debugShowImageryProbe` → any active debug mode disables retention for that tile (fallback to legacy path);
   - device generation: the renderer is per-`GPUDevice` (WeakMap, Rendering.js:788) and is recreated on device swap, which implicitly drops packets — but assert `isDestroyed()` handling still covers it;
   - skirts: `showSkirts && !cameraUnderground && !globeTranslucent` (changes `drawIndexCount`).
   Where a key component cannot be captured exactly (e.g., a function-valued imagery `alpha`), the tile **falls back to the per-frame rebuild path** — plan §3 invariant 2 (unknown → conservative execution). Never guess.
3. **Warm-frame allocation contract (FAR-309 acceptance):** after warm-up on a settled or smoothly moving camera, per tile/pass the path creates **zero** new arrays, `slice()` copies, descriptor objects, command objects, or execute closures. Camera/frustum data updates in place (mutate the retained `bindGroup0DynamicOffsets` array elements and the retained command's `_bindGroups[0]`/`_pipeline` fields; never re-literal the object).
4. **RTE stays CPU-f64.** `modifiedModelView`/`modifiedModelViewProjection` = f64 `view × mesh.center` per tile per frame (CameraUB.ts:1116–1131 and the MORPHING/2D/CV overrides at 110–223). This is an **irreducible per-tile-per-frame CPU compute + upload** — the split reduces its transport cost, it cannot eliminate it. Never reconstruct `view × center` in f32 on the GPU (charter RTE rule; plan §3.4).
5. **The `_logDepthEncodeNearFar` stash side effect survives.** CameraUB.ts:988–1005 writes the shared `uniformState._logDepthEncodeNearFar` used by depth-sample classifiers and `WebGPUDepthPlane.update`. If camera packing becomes once-per-view, this stash must still be written every frame before classification/depth-plane consumers run — including on fully-warm frames where you skip per-tile packs.
6. **Pick mini-frames keep working.** `beginPickFrame` advances the ring page (WebGPUContext.ts:1834), so every scene-frame ring offset is stale inside a pick mini-frame. Keep `updateWebGPUForPick`'s rebuild semantics for pick frames in the first slices (packets may be *reused for structure* but camera/tile dynamic slices MUST be re-allocated inside the mini-frame). Terrain-classification picking (the pick command's depth contribution, Rendering.js:1106–1172) is load-bearing.
7. **Counters survive and extend.** The `WebGPUGlobeLogicalCounters` sites (interface at `WebGPUGlobeSurfaceTypes.ts:470`) are acceptance instrumentation. Keep every existing counter semantically intact; add new ones (e.g. `retainedPacketHits`, `retainedPacketMisses`, `retainedPacketInvalidations`, `staticTileBytesWritten`, `dynamicBytesWritten`) rather than repurposing old ones — the verification recipe diffs against the C9-01 artifact.
8. **No feature deletion, no default flips, no visual change.** Every gate in queue §1.1 / plan §3.1. Off-path (WebGL) byte-identical; on-path WebGPU output pixel-identical vs pre-change WebGPU (probe-verified).
9. **New GPU memory is bounded and lifetime-tied.** Any persistent per-tile UB storage you add is owned alongside `_tileBufferCache` entries (created/destroyed with them) so its growth profile is identical to the existing, already-tracked tile-buffer growth. Destruction of a buffer possibly referenced by an in-flight frame must ride the deferred-destroy pattern (WebGPUContext.ts:2201–2219) or an equivalent ≥3-frame delay — never `destroy()` a UB the previous frame's submit may still read.
10. **One concern per slice; internal A/B switch allowed while stabilizing** (plan §8). Roll back the optimization, never the feature.

#### The static/dynamic split — what actually goes where (C9-12)

Classify the current `CameraUniforms` (232 floats) and `TileUniforms` (484 floats) fields by variance. Verified against the packers:

**Per-VIEW (once per frame per view; belongs in a view ring slice shared by all tiles):**
`mvpRelativeToEye` (identity model ⇒ per-view), `encodedCameraHigh/Low`, sun + lighting, `previousViewProjection` (DP-H41 tail), HDR flag + gamma (CameraUB.ts:965–970), log-depth near/far, cloud-shadow VP + cascade VPs (972–986), scene mode + morph time, `pickColor` (CameraUB.ts:741–755 — globe-wide per frame, zero unless pickable), fog density/offset/minBrightness, `splitPosition`, vertical exaggeration + relative height, night fade in/out, wave `TIME_OFFSET`, HSB shift, cartographic limit rect, ground-atmosphere control, debug fields, localized translucency rect (tile-clipped — see traps).

**Per-TILE STATIC (write once per tile revision into persistent storage):**
`center3DHigh/Low`, `scaleAndBias` (mesh.encoding.matrix), `minMaxHeight` + ellipsoid radius, per-layer imagery blocks (translationAndScale, texCoordsRectangle, cutout, colorToAlpha — static per imagery revision), `useWebMercatorTLayer`, `layerCount`, water-mask translationAndScale, flags word (waterMask/clipping/oceanWaves/subsequentPass), 2D/CV projected `tileRectangle` + south/north/mercatorY (static per tile per mode — mode change = revision bump).

**Per-TILE × PER-VIEW DYNAMIC (irreducible per-frame per-tile ring write):**
`modifiedModelView`, `modifiedModelViewProjection` (f64 CPU products baking `mesh.center`) — ~32 floats ≈ 128 B → one 256-B aligned slice per tile per frame instead of 3,072 B. That is the ~12× upload-byte reduction that makes C9-12 the lever.

**Per-tile POSSIBLY-dynamic (decides fallback vs static):** imagery layer `alpha/brightness/contrast/hue/saturation/gamma/dayNightAlpha` — resolved via `resolveImageryLayerValue`, may be functions. If every value is a plain number, they are static-per-imagery-revision; if any is a function, that tile's UB (or just that block) is per-frame. Detect at pack time; count fallbacks.

**Layout consequence:** splitting one WGSL struct into three bindings requires editing `GlobeTerrain.wgsl`'s group-0 declarations, `WebGPUGlobeSurfaceLayouts.ts` (BGL 0 currently: binding 0 camera + binding 1 tile, both dynamic-offset), every pipeline layout, `_getOrCreateBindGroup0`, and the wireframe/capture paths that share them (`createWireframeTileCommands` at 2008, `getOrCreateCaptureTileCommands` at 2166 — capture deliberately does NOT run the on-screen path; check its own UB usage before touching shared layouts). Group-0 can host three buffer bindings (maxBindGroups=4 on Windows is about group count, not bindings-per-group; dynamic-offset uniform buffers are capped at 8 per pipeline layout — 3 is fine). **This WGSL/layout change is its own slice** (see walkthrough), because rolling it back must be a clean revert.

---

### Implementation walkthrough

Work in bounded slices, each independently landable, verified, and revertible. Suggested order (respects queue ordering 28 → 29 → 30 and keeps the WGSL-touching slice last):

#### Slice 0 — Effects handle hoist (= row 28, if still NOT STARTED in the ledger)
Hoist the per-tile-per-pass effects resolution (Renderer.ts:1123–1255: perfMgr LUT lookup, `receiveShadowMap`, `csmBinding`, `activeClippingPolygons`, the bindGroup3 branch) into a once-per-`createTileCommands`-prologue — better, once per provider `endUpdate` via a small "terrain effects handle" object computed at first tile call per frame (guard on `frameState.frameNumber`) and stored on the renderer. Key it by the exact revision inputs (shadow-map identity, CSM identity, clipping identity, LUT views, cloud-shadow view). Tiles then read `this._frameEffectsHandle.bindGroup3` / `.useClipDistances` etc.
- **Decision point:** if you find the ledger row 28 already IN PROGRESS/COMPLETE (someone else's lane), consume its handle API instead of building one. If its design conflicts with per-tile fallback needs, STOP and mark blocked on row 28.
- Acceptance for this slice: identical visuals with shadows/CSM/clipping/LUT/cloud-shadow toggles exercised; effects bind-group create counters unchanged or lower; multi-view (split-screen `Apps/WebGPUTest/split-screen-comparison.html`) still correct.

#### Slice 1 — Retained tile packets, structure only (C9-11 core; no WGSL change, no upload change)
1. Add a `TileRenderPacket` store on the renderer: `Map<tileKey, TileRenderPacket>` where a packet holds: the computed revision-key snapshot (invariant 2), the `TileDrawDescriptor[]` array (retained), the per-descriptor retained scene-adapter command objects (see step 3), the retained `readyLayers` array and per-pass layer sub-arrays (reused, resized in place), and the retained non-3D bounding sphere + offsets arrays.
2. In `createTileCommands`: compute the revision key (cheap field reads + identity comparisons — NO string building on the warm path; compare component-wise against the stored snapshot, mirroring how `exactSignature` is composed in `Tools/visual-regression/run-performance-campaign.mjs:482–516`, which is the reference model for key completeness — but implement it as field comparisons, not JSON). On match: refresh ONLY the per-frame fields (camera/tile UB packs still happen this slice — they produce new ring slices; write the new offsets into the retained `bindGroup0DynamicOffsets` arrays IN PLACE, refresh `_bindGroups[0]` from `_getOrCreateBindGroup0`, refresh `bindGroup3` from the Slice-0 handle) and return the retained descriptor array. On mismatch: run the legacy build path, store the new packet, count `retainedPacketMisses`/`retainedPacketInvalidations`.
3. In `addWebGPUDrawCommandsForTile`: stop rebuilding command objects when the renderer returns a retained descriptor set. Move command-object construction INTO the packet (build once on miss; on warm hit just `frameState.commandList.push(retainedCommand)` per descriptor). The retained command keeps one `execute` closure for its lifetime. Fields updated in place per frame: `_pipeline` (can change when async variants finish materializing), `_bindGroups`, `_bindGroup0DynamicOffsets` (same array object, mutated), `boundingVolume` (recompute the non-3D sphere INTO the retained sphere object — it is safe to reuse now precisely because the command object is no longer per-frame; update the comment at Rendering.js:966–971 accordingly), `derivedCommands` for translucency/pick.
   - **Scope guard:** commands pushed to `frameState.commandList` are consumed by the scene renderer within the frame; retaining them across frames is exactly what WebGL does with its cached tile commands (`GlobeSurfaceTileProvider` `_drawCommands` pooling upstream). Check `Scene.updateDerivedCommands` treatment of `isWebGPUDrawCommand` (the tag exists to bypass WebGL derived-command cloning — Rendering.js:996–1000) still holds when the same object appears in consecutive frames.
4. Fallback gates (invariant 2's debug/material/morph conditions) route to the legacy path unchanged — keep the legacy code intact and reachable; the packet path is additive.
5. Pick mini-frames: on `frameState.passes.pick || passes.pickVoxel`, reuse packet structure but force UB repack (ring page changed) and build/refresh the pick command object retained on the packet.
- **Decision points:**
  - If refreshing `_bindGroups[0]` per frame shows the group-0 cache no longer converging (creates climbing in `CesiumDebug.globeBindGroups()`), you regressed the (page-identity) key path — the camera/tile UBs must still come from the same ring allocator; investigate before proceeding.
  - If you find `frameState.commandList` consumers mutating pushed command objects (grep for writes to `command.derivedCommands` outside the globe path — `GlobeTranslucencyState`, shadow pipeline), account for them: either re-derive per frame or verify mutation is idempotent.
  - If TypeScript interop friction appears between the JS scene adapter and TS renderer packet types, add a co-located `.d.ts` per charter (never `any`).
- Expected counter movement (instrumented lane, warm segments): `adapterCommandObjects`, `commandArrays`, `readyLayerArrays`, `passLayerSlices` → near-zero on settled/smooth segments (only churn tiles miss); `tileCalls`, `cameraUniformPacks`, `tileUniformPacks` unchanged (that is Slice 2/3).

#### Slice 2 — Camera UB split (C9-12 part 1: per-view block + per-tile dynamic block) — **the WGSL slice**
1. New group-0 layout: binding 0 = `ViewUniforms` (per-view: everything in the per-VIEW list above), binding 1 = `TileDynamicUniforms` (`modifiedModelView`, `modifiedModelViewProjection`), binding 2 = `TileStaticUniforms` (per-tile static camera-side fields: center3D hi/lo, scaleAndBias, minMaxHeight, tileRectangle/south/north/mercatorY) — then fold the tile UB in Slice 3. All three dynamic-offset (or make static binding non-dynamic since its buffer identity is per-tile — but then the group-0 bind-group cache key must include the static buffer identity per tile; dynamic-offset-into-a-shared-slab keys better. **Prefer: one persistent slab buffer for static tile blocks, dynamic offset per tile.**)
2. Edit `GlobeTerrain.wgsl` group-0 struct declarations + every field access; `WebGPUGlobeSurfaceLayouts.ts`; `_getOrCreateBindGroup0`; the wireframe + capture paths; the pick pipeline shares the vertex stage so it inherits the change; the shadow-cast path does NOT (it has its own 96-B UB — leave it).
3. Pack `ViewUniforms` ONCE per frame (per view; per pick-mini-frame too) via the ring; pack `TileDynamicUniforms` per tile per frame via the ring (128 B → 256 aligned); write `TileStaticUniforms` into the persistent slab only on packet revision miss (via `queue.writeBuffer`, not the ring).
4. Preserve invariant 5 (`_logDepthEncodeNearFar` stash) in the once-per-frame view pack.
5. Slab management: fixed-size 256-B slots, free-list, grow-by-page; slot lifetime tied to the packet (freed on invalidation/eviction with deferred destroy per invariant 9).
- **Decision points:**
  - The subsequent-pass camera UB today is IDENTICAL to the primary pass's (same helper call, Renderer.ts:1052) — after the split, passes share the view + tile-dynamic slices; only the tile UB's `isSubsequentPass` flag differs (it lives in TileUniforms `FLAGS_OFFSET`). Handle by giving subsequent passes their own static-block variant or (better) moving the flag into the per-DRAW dynamic offset choice: two static blocks per multi-pass tile (primary/subsequent) is simplest and bounded (multi-imagery >16 layers is rare).
  - 2D/CV/MORPHING: `tileRectangle` and rtc math are mode-dependent (CameraUB.ts:110–162) and morphing repacks per frame (morph time) — **retain packets only in SCENE3D + 2D + CV; MORPHING always falls back** (explicitly allowed; note it in the ledger row).
  - If `GlobeTerrain.wgsl` field-access rewiring balloons (the file is ~3,300 lines), STOP and re-scope: an intermediate landing point is keeping the WGSL struct UNSPLIT but skipping the tile UB repack when the packet is warm and only re-packing camera — smaller win, no shader change. Record the decision in the ledger as PARTIAL with the WGSL split as the named remainder.
- This slice changes bytes-on-the-wire layout: verify **pixel-identical output** across all probe scenes before/after (same camera, same scene → same image). Any diff is a packing bug.

#### Slice 3 — Tile UB split (C9-12 part 2)
Move the per-TILE STATIC list of `TileUniforms` into the persistent slab (extend `TileStaticUniforms` or a fourth binding), leave the per-VIEW globals in `ViewUniforms`, and eliminate the per-tile-per-pass 1,936-B repack entirely on warm frames. Function-valued imagery properties force the per-frame fallback for that tile (count it). Wave time, fog, exaggeration, split position, HSB, translucency rect move to `ViewUniforms` — EXCEPT `localizedTranslucencyRect`, which is tile-clipped via `clipRectangleAntimeridian` (TileUB.ts:83–86 import): it is per-tile × per-translucency-rect-revision → static block, revision includes the provider's translucency rectangle.
- After this slice: warm per-tile upload = 256 B (tile dynamic) vs today's 3,072 B; per-frame per-view upload = one ViewUniforms slice.

#### Slice 4 — Scratch spans + counters closure (C9-11 tail)
Retained `readyLayers`/pass sub-arrays already landed in Slice 1; sweep the remaining per-frame allocations the counters still show (check `passLayerSlices`… should be zero warm), add the new counters to `CesiumDebug` surfaces if useful, update `migration_doc/DEBUGGING_GUIDE.md` if you add any debug command (guide-sync rule), and write the ledger acceptance evidence.

---

### Traps for the unwary (each of these has bitten someone or is armed to)

1. **Imagery readiness churn without mesh change.** `TileImagery.readyImagery` swaps as tiles upgrade from parent/ancestor imagery to their own (`textureTranslationAndScale` changes at the same time). Your revision key MUST include per-layer texture-view identity + TS/rect bytes, or tiles render with stale UV transforms (visible as misplaced imagery). The C9-01 artifact shows 526 group-1 creates over the route — that is the churn rate your invalidation must track.
2. **Imagery layer ORDER (raise/lower/add/remove)** changes `readyLayers` order without necessarily changing any texture identity's set membership. Key on the ordered tuple, not a set.
3. **Function-valued layer properties** (`alpha` et al. via `resolveImageryLayerValue`) are legal public API (hover fades, time-of-day). Freezing them in a static block is a silent feature break — detect `typeof === "function"` at pack time → per-frame fallback for that tile (or per-frame re-resolution of just those scalars into the dynamic block).
4. **Water mask is a SHARED texture with per-tile TS.** Upstream shares one `waterMaskTexture` across descendant tiles, differentiated by `waterMaskTranslationAndScale`; fill tiles borrow `surfaceTile.fill.waterMaskTexture`. Key the texture identity AND the TS bytes; do not assume per-tile textures. The WebGPU-side cache keys by the WebGL texture `_id` (`WebGPUGlobeSurfaceTextures.ts` module doc, line 16). The Campaign-7 lake-water-mask work (Natural Earth PD lakes) widened which tiles carry masks — exercise a lake view (Great Lakes) in verification, not just ocean.
5. **`showWaterEffect`/`oceanNormalMap` and the frozen-ocean failure.** Wave animation comes from `TIME_OFFSET` in TileUniforms — if you move it to the static block, the ocean freezes (this exact class of bug is `NS-WEBGPU-OCEAN-BRIGHT-NO-WAVES` history). Time-varying scalars are per-view/per-frame, period.
6. **Clipping mutation.** `ClippingPlaneCollection` planes move per frame (texture content updates) WITHOUT changing count/enabled — that flows through the effects bind group (fine, Slice 0 handle), but `useClipDistances` (Renderer.ts:926–933) flips PIPELINES when count crosses 0, union flips, or mode changes — pipeline selection must be part of the revision, not just bind groups.
7. **Shadow/CSM/cloud-shadow arrival is asynchronous.** `shadowState.lightShadowMaps[0]` appears a frame after `viewer.shadows = true`; the cloud-shadow view swaps real↔placeholder per frame depending on the cloud renderer's last frame (Renderer.ts:627–659 reads *last* frame's map). These flow through bindGroup2/3 identities — key on the resolved view identities and re-resolve them per frame in the packet-refresh step (they are cheap reads; only the *bind-group create* must stay cache-hit).
8. **HDR/MSAA vs log-depth are SEPARATE invalidation signals.** ctxGen bump wipes pipeline caches (Renderer.ts:687–715); `_logDepthEnabled` (717–723) only changes cache keys. A retained packet holding a raw `GPURenderPipeline` must be invalidated by BOTH. Also mirror `_pickFormat` behavior (`NEW-WEBGPU-HDR-PICK-FORMAT-CLOSURE` landed Batch 672: `PipelineHost._pickFormat` refreshes on generation bump — your packets hold pick pipelines too).
9. **Async pipeline materialization ≠ stable pipelines.** `selectPipelineHelper` returns null while the central cache cooks a variant; the pass is skipped that frame, and the NEXT frame returns a real pipeline. A packet built during the cooking window has a *missing descriptor* — do not cache "descriptor absent" as part of the packet; rebuild until all expected descriptors resolved (the empty-cmdDescs requestRender wakeup at Rendering.js:907–918 depends on the renderer being consulted again).
10. **`beginPickFrame` advances the ring** (WebGPUContext.ts:1826–1836). Scene-frame ring offsets are dead inside pick mini-frames and vice versa. Any "reuse last pack" optimization keyed on frame number must treat the pick mini-frame as a distinct allocation epoch. Symptom if you get this wrong: picks return garbage IDs / classification pick breaks, with zero validation errors.
11. **2D/CV bounding spheres and `cull:false`.** The fresh-allocation comment (Rendering.js:966–971) is only safe to convert to a retained sphere BECAUSE the command becomes retained. If any code path still builds per-frame commands (fallback path!), it must keep the fresh allocation. Do not share one scratch sphere between retained and fallback paths.
12. **Multi-context / split-screen / pooled device.** The renderer is per-`GPUDevice` — after Sol's pooled-device work, two contexts CAN share one device and therefore one renderer instance. Packets contain per-VIEW data (camera offsets, bindGroup3) — key any per-frame refresh by `frameState.context`/view, or store view-dynamic state outside the packet. Test the split-screen page explicitly. Error logs must carry context ID (charter).
13. **Env-map scene capture** (`getOrCreateCaptureTileCommands`, Renderer.ts:2166) deliberately bypasses the on-screen path and reads `context._webgpuSceneCaptureSources` (published at Rendering.js:881–886, gated on `sceneCaptureReflections`). Do not route capture through scene packets; do not let a layouts change (Slice 2) silently break the capture path's own UB packing — it calls `_getOrCreateBindGroup0` at 2262, so it SHARES group 0. Update it in the same commit as the layout change.
14. **Exaggeration.** `endUpdate` handles exaggeration change by regenerating meshes (provider lines 401–418) → caught by the `sourceVertices` identity check. But the exaggeration SCALARS live in TileUniforms and change immediately (frameState reads) — per-view block. A one-frame mismatch between new scalars and old mesh is upstream-identical behavior; don't "fix" it.
15. **Skirt count truncation** (`indexCountWithoutSkirts`, Renderer.ts:1302–1322) depends on `cameraUnderground`/translucency — `drawIndexCount` is a retained-command field; it must be part of the revision or refreshed per frame (cheap: refresh per frame in the packet-refresh step).
16. **Translucency restructures the pass list** (0–3 extra descriptors per tile, different bind group 2 vs 2Final usage, front-face pipeline swap — Renderer.ts:1324–1516). Cleanest: translucent globe → fallback path (translucency is not the hot default); gate retention on `!globeTranslucent`. Record that in the ledger row as an explicit boundary, not a silent skip.
17. **The effects-cache `frameNumber ?? 0` alias** (queue Wave-5 item 91, audit P1 #14): if any of your new code keys on `frameState.frameNumber`, a missing frame number must assert in debug, not silently alias slot 0.
18. **Ring single-producer discipline** (documented invariant at `WebGPURingBufferAllocator.ts:340` area): never mix raw `allocate()` + direct `queue.writeBuffer` with `allocateAndWrite` staging on the same pages — ordering vs `flush()` breaks. All new ring writes go through `allocateAndWrite`. Any NEW mid-frame submit must flush first (P0-4 lesson, WebGPUContext.ts:2964).
19. **Do not add terrain eviction/residency here.** The missing `evictStaleResources` production caller and the 173-MiB imagery retention are `C9-15`/`FAR-200-S3`/`C9-12A` scope. Your only lifetime obligation: new persistent slabs are freed with their packet/tile-buffer entries via deferred destroy, and total growth tracks `_tileBufferCache` growth (which C9-01 counters already watch).
20. **Docstring drift is real:** TileUB module doc says 476 floats/1,904 B; the constant is 484/1,936 (`WebGPUGlobeSurfaceTypes.ts:227`). Trust constants + WGSL struct; fix the docstring while you are there (doc-drift rule).
21. **Dead-code / scaffolding rule (charter Principle 7):** `_tileUniformU32View` is documented scaffolding (TileUB.ts:98) — leave it. The legacy `createTileCommand` singular (Renderer.ts:1599) is deprecated-but-public — leave it working.
22. **`gulp test --workspace engine` staleness** (`NEW-WORKSPACE-SPEC-BUNDLE-FRESHNESS`, queue item 4A, NOT STARTED): if you add engine specs, the required sequence is explicit engine build then focused production test — `npm run build --workspace @cesium/engine` before `gulp test --workspace engine --browsers=EdgeHeadlessCI --includeName "..."`; otherwise your new spec can silently not run.
23. **Request-render mode:** invalidations (imagery arrival, pipeline-ready, shadow arrival) must produce a rendered frame. The existing wakeups cover pipeline-ready and imagery; your packet invalidation itself happens *during* a frame, so no new wakeup is needed — but do not add any "skip createTileCommands when warm" shortcut ABOVE the renderer (the per-frame call is the refresh point; the win is inside it).
24. **Audit-agents / worktree hygiene:** per user memory, snapshot/commit before running broad audit subagents; never bare `git stash`. Branch-transparency rules apply if you create a safety branch.

---

### Verification recipe

**Build gates (every slice):**
```powershell
npx tsc --noEmit
npx gulp build
```

**Unit/spec:** add focused specs for the revision key (component completeness: flip each key input, assert invalidation exactly once) and the packet lifecycle (device-loss/destroy/multi-context per queue §12.3 "Every cache change tests key completeness, mutation, resize, device loss, multi-context isolation, destroy, leases, completion serial, and repeated-route plateau"). Run per trap 22's sequence.

**Instrumented counters lane (the primary logical-acceptance evidence):**
```powershell
node server.js --production   # terminal 1
node Tools/visual-regression/run-performance-campaign.mjs `
  --workload moving-camera-altitude-track-3d `
  --renderer both --repetitions 2 --api-instrumentation `
  --output Tools/visual-regression/output/performance/c9-11-logical-after.json
```
The runner publishes `globalThis.__webgpuGlobeLogicalCounters` in the instrumented lane only (runner line ~317–320; renderer constructor pickup at Renderer.ts:345–354). Compare against the pinned baseline `campaign9-c9-01-logical-owner-counters-webgpu-r1-2026-07-15.json`. **PASS means:**
- Slice 1: `adapterCommandObjects`, `commandArrays`, `readyLayerArrays`, `passLayerSlices` collapse to ≈ the packet-miss count (tile churn only — expect same order as `tileBufferCacheMisses` ≈ 690-order, NOT 39,300/41,224-order); `pickCommandObjects` scales with pick mini-frames only.
- Slice 2/3: `cameraUniformAlignedBytes + tileUniformAlignedBytes` drop ≥80% vs baseline's 115.1 MiB-equivalent; `cameraUniformPacks`/`tileUniformPacks` (or your successor counters) drop from ~2×39,300 to (1 view-pack/frame + 1 dynamic-pack/tile/frame + revision-miss statics);
- no counter goes UP except your new `retainedPacket*` ones; `tileBufferLiveBytes` plateau unchanged.

**Clean timing lane (the blocking performance claim — needs ≥5 counterbalanced reps, queue §12.5):**
```powershell
node Tools/visual-regression/run-performance-campaign.mjs `
  --workload moving-camera-altitude-track-3d `
  --renderer both --repetitions 5 `
  --output Tools/visual-regression/output/performance/c9-11-clean-r5.json
```
PASS = WebGPU CPU p95 improves ≥5% in the named stage or >3× measured run-to-run noise vs a same-session pre-change run of the SAME lane (run the baseline yourself on your pre-change tree — do not compare across machines/sessions to Gate A's absolute 7.51 ms; Gate A is the campaign reference, your slice gate is before/after on one bundle pair), with **no route-segment p99 regression beyond noise and no WebGL regression**. All eight segments + full altitude range must report covered; zero page/device errors.

**Visual/feature oracles (probe-first rule — read the PNGs yourself):**
- `node Tools/visual-regression/capture-and-diff.mjs` (full scene set) — mismatch vs pre-change WebGPU baselines ≈ 0 (this change must be pixel-neutral).
- `probe-2d-cv-modes.mjs` (2D/CV/morph), `probe-camera-track.mjs`, `probe-classification-primitive-parity.mjs` (terrain pick depth for classifiers), `probe-collections-regression.mjs`, plus a pick check (`probe-pickposition-webgpu.mjs`) because of trap 10.
- Mutation oracles (queue §12.2 discipline), scripted in a probe or driven via `window.viewer`: imagery layer add/remove/reorder/alpha-fade mid-flight; `globe.translucency` on/off/restore; clipping planes add/mutate/remove; `viewer.shadows` on/off; CSM on/off; exaggeration change; `scene.msaaSamples` flip + HDR flip (topology generation); water view over a LAKE and ocean with waves animating (trap 5); wireframe + fragment debug modes still render; split-screen page both halves correct.
- C9-02 regression lanes: re-run the terrain-ownership instrumented lane (the runner's ownership diagnostics) and confirm selected-tile/owner attribution unchanged (`campaign9-c9-02-terrain-ownership-both-r2` semantics).
- Update the ledger row(s) in `QUEUE_2026-07-15_CAMPAIGN9.md` §3.2 with status + artifact names; record in `WEBGPU_DEBUGGING_LOG.md` if you fixed any bug en route.

---

### Rollback boundary

- **Roll back the optimization, never the feature** (queue §1.6, plan §8). Each slice is one revert unit:
  - Slice 1 revert = delete the packet store + restore per-frame command building (the legacy path is still in-tree as the fallback — the revert is small if you kept it reachable, which invariant 2's fallback requires anyway).
  - Slice 2/3 revert = restore the unified group-0 WGSL struct + layouts + packers. This is why the WGSL change is one atomic slice/commit: `git revert <slice2-sha>` must leave a green tree.
- **Never revert:** the shared selection path, the FAR-303 staged ring (pre-existing), bind-group caches, C9-01 counters (they survive rollback per plan §8 "Instrumentation and regression tests survive rollback"), any bug fix you made to pre-existing behavior (queue separate concerns — land fixes as their own commits BEFORE the optimization slice so a revert doesn't take them).
- An internal A/B switch (e.g. `renderer._useRetainedPackets`, default ON after acceptance, settable in a probe) is sanctioned *while stabilizing* (plan §8) but must not become a permanent config surface — remove it at slice acceptance or document it as debug-only.
- If Gate C's promotion rule fails (<5% stage and <3× noise), the slice does NOT land as a perf win: either close honestly as "no measurable improvement, reverted" in the ledger, or re-scope. Do not keep noise-sized churn.

---

### Pointers

**Queue/ledger (MUST update):** `migration_doc/QUEUE_2026-07-15_CAMPAIGN9.md` — §3.2 ledger (add rows for C9-11/C9-12 the moment you start; statuses per the vocabulary at §3.2), Wave 2 rows 28/29/30/30A (#28 `NEW-GLOBE-EFFECTS-PER-VIEW-PREPARED-HANDLE`, #29 `C9-11`, #30 `C9-12`, #30A `C9-12A`), §12 landing requirements, §6 row 35 `C9-30-DEFAULT-PATH-PERFORMANCE-CHECKPOINT` (the tranche-level gate your numbers feed).

**Specs:** plan §4.2 (retained terrain frontend) in `FORK_PERFORMANCE_RTE_VISIBILITY_REMEDIATION_PLAN_2026-07-15.md`; `FAR-303` (~line 633, incl. the landed 2026-07-14 prep slice paragraph) and `FAR-309` (~line 700) in `FORK_ARCHITECTURE_REMEDIATION_PLAN_2026-07-13.md`; `SOL_AUDIT_REPORT_2026-07-16.md` ratings #10/#12, P0 #4.

**Source files (all under `packages/engine/Source/`, canonical — never edit root `Source/`):**
- `Scene/GlobeSurfaceTileProvider.js` — `endUpdate` 370, tile loop 447–472.
- `Scene/GlobeSurfaceTileProviderRendering.js` — `addWebGPUDrawCommandsForTile` 791, renderer WeakMap 788, command literal 995–1091, pick command 1126–1172, `addDrawCommandsForTile` 1182, `updateWebGPUForPick` 1979.
- `Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts` — fields 304–355 (incl. `_logicalCounters` pickup 345), `createTileCommands` 594–1593, `_getOrCreateBindGroup0` 1650, `_createTextureBindGroup` 1695, group-2 inner 1850–1984, `createWireframeTileCommands` 2008, `getOrCreateCaptureTileCommands` 2166, `evictStaleResources` 2299, `destroy` 2359.
- `Renderer/WebGPU/WebGPUGlobeSurfaceCameraUB.ts` — packer 97, log-depth stash 988–1005, `writeUniformSlice` 1028, `computeModifiedModelView` 1116.
- `Renderer/WebGPU/WebGPUGlobeSurfaceTileUB.ts` — packer 116.
- `Renderer/WebGPU/WebGPUGlobeSurfaceTypes.ts` — `CAMERA_UNIFORM_FLOATS` 165 (=232), `TILE_UNIFORM_FLOATS` 227 (=484), `WebGPUGlobeLogicalCounters` 470, `TileDrawDescriptor` 507.
- `Renderer/WebGPU/WebGPUGlobeSurfaceTileBuffers.ts` — `getTileKey` 109, `getOrCreateTileBuffers` 121 (identity check 139–149), `evictStaleResources` 448 (no production caller).
- `Renderer/WebGPU/WebGPUGlobeSurfaceLayouts.ts` — group-0 BGL (Slice 2 surface).
- `Renderer/WebGPU/WebGPURingBufferAllocator.ts` — `beginFrame` 184, `allocateAndWrite` 307, `flush` 341.
- `Renderer/WebGPU/WebGPUContext.ts` — ring `beginFrame` 1758, `beginPickFrame` 1826–1839, `endFrame` flush/submit/deferred-destroy 2176–2229, `readPixelsAsync` flush 2964, `uniformAllocator` getter 4654.
- `Renderer/WebGPU/WebGPUGlobeBindGroupCache.ts` — keying doc 1–75, `EVICT_AFTER_FRAMES` 112.
- `Renderer/WebGPU/WebGPUEffectsBindGroup.js` + `WebGPUEffectsStateCache.js` — group-3 cache (Slice 0 surface).
- `Shaders/WebGPU/Globe/GlobeTerrain.wgsl` — group-0 struct (Slice 2; ~3.3k lines; also note its line ~3292 stale-comment fix is queue item 83, not yours).

**Probes/runner:** `Tools/visual-regression/run-performance-campaign.mjs` (workload `moving-camera-altitude-track-3d` in `performance-workloads.json`; `--api-instrumentation` publishes the counter sink at line ~320; tile revision reference model `makeTileRecord` at ~447–532), `capture-and-diff.mjs`, `probe-2d-cv-modes.mjs`, `probe-camera-track.mjs`, `probe-classification-primitive-parity.mjs`, `probe-pickposition-webgpu.mjs`. Protocol doc: `migration_doc/DEBUGGING_GUIDE.md` §"Canonical moving-altitude campaign (2026-07-14)" (line 1089).

**Artifacts (pinned baselines):** `Tools/visual-regression/output/performance/campaign9-c9-01-{owner-families,logical-owner-counters,owner-labels}-webgpu-r1-2026-07-15.json`, `campaign9-gate-a-{smoke,clean-r5,api-r5}-2026-07-15.json`, `campaign9-post-offline-boot-clean-r1-2026-07-15.json` (referenced in ledger; deterministic-boot lane).

**Ledger rows to read before starting (state as of 2026-07-16):** `C9-01` PARTIAL/PAUSED (evidence source), `C9-02` PARTIAL/PAUSED (selection ownership certified), `C9-05`/`C9-06` COMPLETE, `C9-07` NOT STARTED, rows 28/29/30/30A NOT STARTED (unlisted = NOT STARTED per §3.2 header). If any of 28/29/30 is no longer NOT STARTED, reconcile with the existing work before writing code.

---

<a id="g7"></a>

## G7 — Imagery source-realization dedup + frame-owned mip preparation

### C9-12A-IMAGERY-SOURCE-REALIZATION-DEDUP-AND-MIP-PREP

Queue row: `migration_doc/QUEUE_2026-07-15_CAMPAIGN9.md` **item 30A, line 205** (Wave 2 table).
Investigation-to-task coverage row: same file **line 70**. Live status ledger: same file **§3.2
(lines 94–140)** — you MUST add/maintain a row there for this task (status vocabulary at lines
100–105). Risk class R2/R4.

All anchors below were re-verified against the LIVE tree at HEAD `ea6332d0aa` (Batch 672,
2026-07-16), post-Sol-landing (Batches 656–669) and post-audit-fixes (670–672). Campaign 9 runs
concurrently in this repo — **re-verify every line number by symbol search before editing**; treat
the symbol names as authoritative and line numbers as hints.

---

#### Architecture today (post-Sol, verified)

##### The two realization routes

**Route A — geographic providers (direct upload from DRAW EMISSION).** This is the route the
513-finding is about, and the only route this task restructures.

1. `Imagery.processStateMachine` (`packages/engine/Source/Scene/Imagery.js:121-162`) drives
   RECEIVED → `ImageryLayer._createTexture` (`packages/engine/Source/Scene/ImageryLayer.js:444`).
   When the GLOBE_SURFACE feature renderer exists (always on WebGPU), lines 478–504 set a
   **placeholder** `{width, height, _isPlaceholder, destroy(){}}` on `imagery.texture` (geographic
   provider) and deliberately **keep `imagery.image` alive** for later GPU upload. No GPU work
   happens here.
2. The actual GPU realization happens **during command building** (draw emission):
   `WebGPUGlobeSurfaceRenderer._createTextureBindGroup`
   (`packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts:1695`, call site 1716) →
   `getOrCreateImageryTexture`
   (`packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTextures.ts:270`) → on cache miss →
   `uploadImageSource` (same file, **line 555**).
3. `uploadImageSource` does, per imagery tile:
   - `device.createTexture` with full mip chain (line 637; `mipLevelCountFor` at line 65 — a
     256×256 tile gets 9 levels),
   - `device.queue.copyExternalImageToTexture` (line 656, `colorSpace:"srgb"`, `flipY` for raw
     canvas/img sources — Batch 60 comment at lines 570–595),
   - **`ensureMipmapGenerator(device).generateMipmapsAndSubmit(...)` (lines 665–671)** — this is
     the **private encoder + private submit from draw emission** the task must eliminate.
4. `WebGPUMipmapGenerator.generateMipmapsAndSubmit`
   (`packages/engine/Source/Renderer/WebGPU/WebGPUMipmapGenerator.ts:247-254`) creates a private
   `"MipmapGeneration"` encoder, encodes one fullscreen-blit render pass per mip level
   (`Mipmap_RenderPass_Level1..8` for 256², loop at lines 192–238), finishes and
   `device.queue.submit`s it immediately. Note: **`generateMipmaps(texture, format, mipLevelCount,
   commandEncoder?)` (line 162) already accepts an external encoder and returns without
   submitting** — the frame-owned hook already exists in the generator API.

**Route B — Mercator providers (eager dual-texture in the load state machine).** NOT draw
emission; leave its submit shape alone in this slice.

- `ImageryLayer._reprojectTexture` (`ImageryLayer.js:590`, WebGPU dual path lines 630–661) calls
  the IMAGERY_REPROJECTION feature renderer's `uploadAndReproject` →
  `uploadAndReprojectMercatorImage`
  (`packages/engine/Source/Renderer/WebGPU/WebGPUImageryReprojection.ts:365`), which performs per
  imagery: mercator upload + mip submit (line 419), a reproject render pass + submit
  (`reprojectWebMercatorWebGPU`, submit at line 252), and a second mip submit for the reprojected
  texture (line 258). Results land on `imagery._webgpuMercatorTexture` /
  `imagery._webgpuReprojectedTexture`, with `imagery._webgpuContext = context` stored for deferred
  destruction (`ImageryLayer.js:646-658`).

##### Keying and the identity gap

- Cache key: `imagery.key || \`${x}_${y}_${level}\`` (`WebGPUGlobeSurfaceTextures.ts:283-284`).
  **`Imagery` has no `key` field — it is never assigned anywhere in the tree** (the optional
  `key?: string` in `cesium-js-types.d.ts:976` is aspirational). The per-tile-coordinate fallback
  is ALWAYS used. Consequence: an imagery **source** reused across tiles (GridImagery returns the
  SAME `HTMLCanvasElement` object for every tile — `GridImageryProvider.js:72` draws once in the
  constructor, `requestImage` at lines 156–157 returns `Promise.resolve(this._canvas)`) is
  realized once per tile coordinate: N tiles → N identical full-mip GPUTextures.
- The key also carries **no layer/provider component**. Two ImageryLayers with the same tile
  x/y/level on the direct-upload route collide in the one shared per-renderer
  `_imageryTextureCache` (`WebGPUGlobeSurfaceRenderer.ts:317`). FAR-205's acceptance text
  explicitly requires "two layers/providers/maps at identical coordinates never alias"
  (`migration_doc/FORK_ARCHITECTURE_REMEDIATION_PLAN_2026-07-13.md:556-571`). See Traps #3.

##### Lifetime today (and the retention leak)

- Quadtree lifetime: `GlobeSurfaceTile.freeResources` (`Scene/GlobeSurfaceTile.js:136`, imagery
  loop at 160/195) → `TileImagery.freeResources` (`Scene/TileImagery.js:27`) →
  `Imagery.releaseReference` (`Scene/Imagery.js:50`). At refcount 0 the imagery calls its
  renderer-registered `_webgpuTextureCacheCleanup` (lines 90–93) and defers the dual-path
  textures via `webgpuContext.scheduleTextureDestroy` (lines 94–110).
- **BUT** for Route A, `registerImageryCacheCleanup` (`WebGPUGlobeSurfaceTextures.ts:83-98`) only
  `cache.delete(key)`s the map entry for reprojection-produced textures, and the direct-upload
  path (`uploadImageSource`) **registers no cleanup at all and never destroys its GPUTexture**.
  Compare the water-mask path (same file, lines 527–532) which does destroy. This is the measured
  "zero retirement": `imageryOwnedRetirements` is declared
  (`WebGPUGlobeSurfaceTypes.ts:499`) but **nothing in the tree increments it**.

##### FAR-200 state (what "shadow serials" means)

`packages/engine/Source/Renderer/ResourceOwnership/` contains the S1 shadow infrastructure:
`SubmissionSerialAuthority.ts` (explicit `authority.submit(encoderLease, buffers)` — one monotonic
serial per physical queue/device generation, coalesced `onSubmittedWorkDone` retirement drain),
`RealizationShadowCache.ts` (fingerprint = existing cache key + ownership token + domain +
descriptor + sourceRevision; CREATING/READY/RETIRING/FAILED; lease refcounts; `retireAfter(serial)`
destroy), plus `RealizationDescriptor/RealizationLease/BackendDomain/ResourceFamily/
ResourceOwnershipPolicy`. Per
`migration_doc/FAR_200_SUBMISSION_AUTHORITY_ADOPTION_2026-07-13.md` this is **shadow-mode only**:
no production submit site is adopted, and queue §3 (lines 58–62) explicitly gates "production
submit-source migration" behind Gate B. **Do NOT route imagery submits through the authority in
this slice.** The sanctioned production deferral primitive is
`WebGPUContext.scheduleTextureDestroy` (`WebGPUContext.ts:2144`), drained in `endFrame`
(lines 2201–2219) after the frame submit's `onSubmittedWorkDone`.

##### Frame plumbing you will build on

- `WebGPUContext.beginFrame` (`WebGPUContext.ts:1734`) creates the `"Scene Frame Command Encoder"`
  (line 1772) and **immediately opens the default canvas render pass** (line 1808) — you cannot
  encode extra render passes on that encoder mid-update while a pass is open
  (`hasActiveRenderPass`, line 2126).
- `WebGPUContext.endFrame` (line 2160): ends any active pass → `this._uniformAllocator?.flush()`
  (line 2185 — the audit P0-4 lesson: EVERY submit path must flush the staged uniform ring first)
  → `finish()` + `queue.submit([commandBuffer])` (2193–2194) → drains `_pendingTextureDestroys`
  (2201–2219). `beginPickFrame` (1826) creates an encoder without a canvas pass; pick mini-frames
  also end via `endFrame`.
- The context already owns a lazy per-device `WebGPUMipmapGenerator`:
  `get mipmapGenerator()` (`WebGPUContext.ts:4538`), device-loss-registered at 5408. The
  module-global generators in `WebGPUGlobeSurfaceTextures.ts:47-56` and
  `WebGPUImageryReprojection.ts:25-39` are single-device slots (multi-context thrash hazard).
- The globe renderer reaches the context via `frameState.context` in its tile-descriptor entry
  point (`WebGPUGlobeSurfaceRenderer.ts:604`, e.g. `void frameState.context?.uniformAllocator` at
  618), but `initialize()` (line 496) receives only `device` and the texture helpers' host
  interface (`TextureCacheHost`, `WebGPUGlobeSurfaceTextures.ts:110-116`) exposes only `_device`,
  the two caches, `_logicalCounters`, and `_diagShouldLog`.

##### Measured evidence (the acceptance baseline)

From `Tools/visual-regression/output/performance/campaign9-c9-01-owner-families-webgpu-r1-2026-07-15.json`
(HEAD `a54cc06`, dirty bundle `B8015811…C11E`, Edge 150.0.4078.65, workload
`moving-camera-altitude-track-3d`, 1197 frames, `--api-instrumentation`):

- `webgpuCommandEncodersCreated.MipmapGeneration` delta = **513**
- `webgpuCommandBuffersSubmitted.MipmapGeneration` delta = **513** (513 private submits)
- Σ `webgpuRenderPassesBegun.Mipmap_RenderPass_Level1..8` delta = **4104** (513 × 8)
- Texture labels are `Globe ${x}_${y}_${level}` — per-tile keys, one realization per tile.

From `…/campaign9-c9-01-logical-owner-counters-webgpu-r1-2026-07-15.json`
(`globeLogicalCounters.delta`): `imageryDirectUploads` = **519**, `imageryDirectUploadBytes` =
**181,402,956** (= 173.0 MiB; the ledger's "171.0 MiB" is the owner-families window of the same
phenomenon), `imageryOwnedLiveTextures` = 519 = high-water (**zero retirement**),
`imageryTextureCacheHits` = 38,774. Counters are opt-in: the runner publishes
`globalThis.__webgpuGlobeLogicalCounters` only in the instrumented lane
(`Tools/visual-regression/run-performance-campaign.mjs:317-320`); the renderer picks it up in its
constructor (`WebGPUGlobeSurfaceRenderer.ts:345-354`). The runner's deterministic offline boot
installs a `GridImageryProvider` (`run-performance-campaign.mjs:1546`) — the acceptance vehicle.

---

#### Target design + invariants

Converge on plan §4.4 (`FORK_PERFORMANCE_RTE_VISIBILITY_REMEDIATION_PLAN_2026-07-15.md:131-140`)
and FAR-205 slices 6/7. Numbered invariants — treat each as a hard requirement:

1. **Reference/realization split.** Terrain-tile imagery entries become *references* to a shared
   realization record; the GPUTexture+view is owned by a new per-context, device-scoped
   **SharedImageryRealizationTable**, never by the per-tile cache entry when sharing applies.
2. **Exact-identity sharing key** (all four components must match; anything less = distinct):
   `sourceId` (object identity of the immutable source) + `sourceRevision` (monotonic, default 0)
   + `descriptor` (`width × height | rgba8unorm | mipLevelCount | flipY(0/1) | srgb`) + device
   scope (the table itself lives per WebGPUContext and is invalidated when that context's
   `GPUDevice` changes).
3. **Mutable/unknown sources never alias** (queue rule 3 / plan invariant 2 analogue):
   - `ImageBitmap` → immutable by spec → shareable by object identity, revision 0.
   - `HTMLCanvasElement` / `HTMLImageElement` / `OffscreenCanvas` → shareable **only** when
     explicitly declared immutable through the new identity module (see walkthrough step 1).
     `GridImageryProvider` declares its constructor-drawn `_canvas`. Undeclared sources keep
     today's one-owned-texture-per-imagery behavior exactly.
   - Real streamed imagery (per-tile distinct ImageBitmaps from `Resource.fetchImage`) gets
     distinct sourceIds → dedup is a natural no-op → "real distinct imagery remains distinct".
4. **Refcounted release with quadtree lifetime.** Every per-imagery cache entry that references a
   shared realization takes a reference at bind time (creation of the cache entry) and releases it
   from the imagery's `_webgpuTextureCacheCleanup` (invoked by `Imagery.releaseReference` at
   refcount 0, which is driven by `TileImagery.freeResources` ← `GlobeSurfaceTile.freeResources`
   ← quadtree eviction). Never destroy while refCount > 0.
5. **Byte-budgeted grace LRU.** A realization whose refCount reaches 0 is NOT destroyed; it moves
   to a grace list stamped with the frame number. Retirement happens only when (a) it has been
   zero-ref for ≥ GRACE_FRAMES (suggest 120) AND total zero-ref bytes exceed the budget (suggest
   64 MiB, a module const with a doc comment), oldest-first; or (b) the table is torn down /
   device replaced. Destruction goes through `context.scheduleTextureDestroy` ONLY. Active/leased
   realizations are pinned unconditionally (plan §2 finding 4).
6. **Owned (non-shared) direct uploads also get retirement.** On imagery eviction their GPUTexture
   is released via `scheduleTextureDestroy` — closing the pre-existing zero-retirement leak.
   `imageryOwnedRetirements` finally increments; live/high-water counters decrement.
7. **Mip preparation is frame-owned.** `uploadImageSource` never calls
   `generateMipmapsAndSubmit`. It enqueues a mip job on the context; `endFrame` encodes all
   pending jobs into ONE `"ImageryMipPreparation"` encoder (using the context-owned
   `mipmapGenerator` and the existing external-encoder parameter of `generateMipmaps`) and submits
   it **in the same `queue.submit([prepBuffer, frameBuffer])` call, prep buffer first**. Queue
   ordering guarantees: `copyExternalImageToTexture` (issued at update time) → mip passes → scene
   passes, so the very frame that created the texture samples complete mips. **Zero private
   submits from draw emission.**
8. **No production FAR-200 adoption.** The SubmissionSerialAuthority stays shadow-only (Gate B).
   Optionally mirror table events into `RealizationShadowCache` for evidence — off by default,
   and only if trivial; do not let it grow the slice.
9. **Multi-context isolation.** The table is per-context state (never module-global keyed only by
   object); GPU handles never cross contexts (Gate F). Split-screen (two contexts) must show two
   independent tables.
10. **Backends and visuals unchanged.** WebGL path untouched. Route B (reprojection) submit shape
    untouched. Texel data, sampler (single shared globe sampler at binding 16), projection-variant
    selection (`resolveImageryProjection`, `WebGPUGlobeSurfaceTextures.ts:224-268`) all unchanged
    → output byte-identical.
11. **Acceptance shape.** The GridImagery deterministic route produces **1** realization per
    context/device generation (or an explicitly documented exact bound), instead of 500+; the
    repeated-altitude route shows a byte plateau; mutation/provider-replacement/recovery/resize/
    2D/CV/pick/water/exaggeration all certified (see Verification).

---

#### Implementation walkthrough

Work through these in order. Each numbered step is independently compilable; steps 5–6 are the
optimization core.

**Step 0 — re-verify premises on the live tree.** Confirm: (a) `generateMipmapsAndSubmit` is still
called from `uploadImageSource` (`Grep "generateMipmapsAndSubmit" packages/engine/Source`
— expect exactly 3 production hits: WebGPUGlobeSurfaceTextures.ts + 2 in
WebGPUImageryReprojection.ts); (b) `imagery.key` is still never assigned (`Grep "\.key = "
packages/engine/Source/Scene/Imagery*.js` → nothing); (c) the C9-12A ledger row status in the
queue §3.2 — **if another session has started or completed C9-12A, STOP and reconcile with that
work instead of duplicating.** If `uploadImageSource` has been restructured beyond recognition,
STOP and mark blocked with the divergence noted.

**Step 1 — identity module.** New file
`packages/engine/Source/Renderer/ImagerySourceIdentity.ts` (TypeScript, no `any` anywhere,
backend-neutral — NOT under `Renderer/WebGPU/` so it is available to Scene providers in all build
variants without stub redirection):

- `const sourceIds = new WeakMap<object, number>()` + counter; `getImagerySourceId(source: object): number`.
- `const immutableDeclared = new WeakSet<object>()`;
  `declareImmutableImagerySource(source: object): void`;
  `const revisions = new WeakMap<object, number>()`;
  `bumpImagerySourceRevision(source: object): void` (provided for future mutable-snapshot
  providers; nothing calls it yet — document that per FAR-205 slice 2 semantics).
- `getShareableImagerySourceIdentity(source: unknown): { sourceId: number; revision: number } | null`
  — returns non-null iff `source instanceof ImageBitmap` OR `immutableDeclared.has(source)`.
  Guard `typeof ImageBitmap !== "undefined"` for Node spec environments.
- Export via a named + default export; add the module to `packages/engine/Source/Cesium.js`
  generation only if the build requires it (it should be picked up automatically by
  `createCesiumJs`; verify `npx gulp build` emits it — never hand-edit root `Source/`).

**Step 2 — provider declaration.** `packages/engine/Source/Scene/GridImageryProvider.js`
constructor, immediately after `this._canvas = this._createGridCanvas();` (line ~72): call
`declareImmutableImagerySource(this._canvas)`. Decision point: search the file for any other
writer of `_canvas` or later `_drawGrid`/`_createGridCanvas` calls — as of Batch 672 the canvas is
drawn exactly once in the constructor; **if you find a mutation site, do NOT declare and STOP** —
the acceptance vehicle premise would be wrong and the task needs re-scoping to an explicit
revision-bump at the mutation site. Do NOT declare for `TileCoordinatesImageryProvider` or
`DebugTileImageryProvider` (they draw a fresh canvas per tile — distinct objects, no benefit) and
do NOT auto-declare any user-supplied canvas.

**Step 3 — context plumbing (mip jobs + destroy access).** In
`packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts`:

- Add `private _pendingImageryMipJobs: Array<{ texture: GPUTexture; format: GPUTextureFormat; mipLevelCount: number }> = [];`
  and `enqueueImageryMipGeneration(texture, format, mipLevelCount): void` (push; guard
  `_isDeviceUnavailable` → fall back to `this.mipmapGenerator.generateMipmapsAndSubmit` is NOT
  needed — if the device is gone nothing will sample it; just drop).
- In `endFrame()` (line 2160), after ending the active pass and after
  `this._uniformAllocator?.flush()` (keep the existing flush position — P0-4), and **before**
  `this._currentCommandEncoder.finish()`: if jobs are pending, build the prep buffer:

  ```ts
  let prepBuffer: GPUCommandBuffer | null = null;
  if (this._pendingImageryMipJobs.length > 0) {
    const jobs = this._pendingImageryMipJobs;
    this._pendingImageryMipJobs = [];
    const prepEncoder = this._device.createCommandEncoder({ label: "ImageryMipPreparation" });
    const gen = this.mipmapGenerator;
    for (const job of jobs) { gen.generateMipmaps(job.texture, job.format, job.mipLevelCount, prepEncoder); }
    prepBuffer = prepEncoder.finish();
  }
  // ...existing finish():
  const commandBuffer = this._currentCommandEncoder.finish();
  this._device.queue.submit(prepBuffer ? [prepBuffer, commandBuffer] : [commandBuffer]);
  ```

  Decision points: (a) if a job's texture was evicted the same frame (present in
  `_pendingTextureDestroys` or destroyed), encoding a pass on it is a validation error — keep a
  `Set` of textures scheduled for destroy this frame and skip matching jobs (the texture dies
  anyway); (b) if `endFrame` early-returns (no encoder), leave the jobs queued — nothing sampled
  them this frame, they ride the next real frame; (c) pick mini-frames flush pending jobs
  harmlessly (single-sample color pass, no interaction with pick FBO).
- Do NOT touch `readPixelsAsync`'s mid-frame submit path except to confirm it cannot run with
  pending mip jobs for textures it reads (it reads framebuffer attachments, not imagery — no
  interaction).

**Step 4 — realization table.** New class in a new file
`packages/engine/Source/Renderer/WebGPU/WebGPUSharedImageryRealizations.ts` (TS; or a
well-delimited section of `WebGPUGlobeSurfaceTextures.ts` if you prefer fewer files — the
standalone file keeps `WebGPUGlobeSurfaceTextures.ts` under the 1000-line rule):

```
interface SharedImageryRealization {
  fingerprint: string; texture: GPUTexture; view: GPUTextureView;
  byteSize: number; refCount: number; zeroRefSinceFrame: number; // -1 while referenced
}
class WebGPUSharedImageryRealizations {
  constructor(device: GPUDevice, scheduleDestroy: (t: GPUTexture) => void)
  get(fingerprint): SharedImageryRealization | undefined   // revives from grace list (refCount++)
  register(fingerprint, texture, view, byteSize): SharedImageryRealization // refCount = 1
  addRef(entry) / release(entry)                            // release → zeroRefSinceFrame = frame
  sweep(frameNumber): void  // grace LRU: destroy zero-ref entries older than GRACE_FRAMES while
                            // zero-ref bytes > BYTE_BUDGET, oldest first, via scheduleDestroy
  destroyAll(): void        // teardown/device-change: scheduleDestroy everything
  getDiagnostics()          // entries, liveBytes, zeroRefBytes, highWater — for counters/probe
}
```

Host it on the globe renderer: add
`public _sharedImageryRealizations: WebGPUSharedImageryRealizations | null = null;` plus
`public _webgpuContext: <context type> | null = null;` to `WebGPUGlobeSurfaceRenderer`
(`WebGPUGlobeSurfaceRenderer.ts` field block ~315–324) and to the `TextureCacheHost` interface
(`WebGPUGlobeSurfaceTextures.ts:110-116`). Populate `_webgpuContext` once from the tile entry
point that already receives `frameState` (near `void frameState.context?.uniformAllocator`,
line ~618): `if (this._webgpuContext !== frameState.context) { this._webgpuContext = frameState.context; /* device change ⇒ rebuild table */ }`
and lazily construct the table with `scheduleDestroy = (t) => ctx.scheduleTextureDestroy(t)`.
Device-change detection: if the table's stored device !== `host._device`, `destroyAll()` (safe
no-op destroys on a lost device) and recreate — this is your device-generation key. Call
`table.sweep(frameState.frameNumber)` once per frame from the same site (it is O(zero-ref
entries)).

**Step 5 — uploadImageSource rewrite** (`WebGPUGlobeSurfaceTextures.ts:555-718`). Preserve the
function shape and ALL existing guards (undecoded `<img>` C-P18, zero-size, flipY table, srgb
comment blocks, the permanent catch/console.error). Changes:

1. After `width/height/needsFlipY` are resolved, compute
   `const identity = getShareableImagerySourceIdentity(source);`
2. If `identity !== null` and `logicalOwner === "imagery"` (only the imagery cache participates —
   the ocean-normal/material callers at `WebGPUGlobeSurfaceRenderer.ts:1838/1887` pass no
   logicalOwner and must keep owned textures):
   - `const mips = mipLevelCountFor(width, height);`
   - `const fingerprint = \`s${identity.sourceId}r${identity.revision}|${width}x${height}|rgba8unorm|m${mips}|f${needsFlipY ? 1 : 0}|srgb\`;`
   - Table hit → `addRef`, `cache.set(cacheKey, { texture: entry.texture, view: entry.view, sourceWidth: width, sourceHeight: height, byteSize: entry.byteSize, logicalOwner, shared: entry })`
     (extend `ImageryGPUTexture` in `WebGPUGlobeSurfaceTypes.ts:448-457` with an optional
     `shared?: SharedImageryRealization`), bump a new `imageryRealizationShares` counter, return
     `entry.view`. **Reuse the ONE cached view object** — view identity feeds the group-1
     bind-group cache key (`WebGPUGlobeSurfaceRenderer.ts:1741-1750` via `cache.idOf(view)`), so
     sharing the view also collapses the 526 group-1 bind-group creates C9-01 measured.
   - Table miss → create texture + `copyExternalImageToTexture` exactly as today, then
     **replace the `generateMipmapsAndSubmit` block (lines 665–671) with
     `host._webgpuContext?.enqueueImageryMipGeneration(texture, "rgba8unorm", mips)`** (decision
     point: if `_webgpuContext` is null — first frames before the tile entry ran, which cannot
     happen because uploads only occur from that path, but guard anyway — fall back to the old
     private submit and count it in a `imageryMipFallbackSubmits` counter so the probe catches
     regressions), `register` in the table, `imageryRealizationsCreated++`.
3. If `identity === null` (unknown/mutable): identical to today EXCEPT the mip block also becomes
   an `enqueueImageryMipGeneration` call (frame-owned prep applies to ALL imagery uploads), and
   the entry is marked owned (`shared` undefined).
4. Register the release hook for BOTH cases: extend `registerImageryCacheCleanup`
   (lines 83–98) — or add a sibling `registerImageryUploadCleanup` — so that on imagery eviction,
   with the identity guard (`cache.get(key)?.texture === texture`) intact:
   - shared entry → `table.release(entry.shared)` + `cache.delete(key)`;
   - owned entry → `cache.delete(key)` + `host._webgpuContext?.scheduleTextureDestroy(texture)`
     (falling back to `texture.destroy()` when no context — mirrors `Imagery.js:94-110`), and
     increment `imageryOwnedRetirements` / decrement `imageryOwnedLiveTextures/Bytes`.
   Note the current direct-upload path registers NO cleanup — you are adding it; the imagery
   object is reachable at that point only in `getOrCreateImageryTexture` (which has `imagery`),
   not inside `uploadImageSource` (which doesn't). Register from `getOrCreateImageryTexture`
   after a successful upload (it already does this for the merc/reproj branches at 318/354).
5. Counters: add `imageryRealizationsCreated? / imageryRealizationShares? /
   imageryRealizationLiveBytes? / imageryRealizationRetirements? / imageryMipFallbackSubmits?` to
   `WebGPUGlobeLogicalCounters` (`WebGPUGlobeSurfaceTypes.ts:470-504`) — all optional, all
   null-guarded so the clean lane allocates nothing (existing pattern at
   `incrementLogicalCounter`, lines 118–125).

**Step 6 — do NOT restructure Route B**, but confirm no regression: `Imagery.releaseReference`
already handles the dual-path textures; the merc/reproj cache-entry branches of
`getOrCreateImageryTexture` keep their current cleanup. The dedup table never sees
`_webgpuMercatorTexture`/`_webgpuReprojectedTexture` textures.

**Step 7 — docs + ledger.**
- `migration_doc/IMAGERY_PROJECTION.md` — MANDATORY (CLAUDE.md lists
  `WebGPUGlobeSurfaceTextures.ts` in the projection chain): add a short section stating
  realization sharing changes texture OWNERSHIP only, never projection-variant selection.
- `migration_doc/FEATURE_INVENTORY.md` — add the shared-realization table under §B (SHIPPED) /
  move any matching §C row.
- `migration_doc/QUEUE_2026-07-15_CAMPAIGN9.md` §3.2 — add the C9-12A row with evidence.
- `migration_doc/WEBGPU_DEBUGGING_LOG.md` — batch entry.
- If you confirm the cross-layer key collision (Traps #3), add a NEW ledger/DEFERRED_WORK item —
  do not silently fix it inside this slice beyond what the fingerprint naturally fixes.

---

#### Traps for the unwary

1. **Never key sharing on tile coordinates, and never hash pixel content.** The identity is
   object-identity + declared revision. Pixel hashing is both a perf trap and a false-aliasing
   correctness trap (two canvases can be byte-equal now and diverge later).
2. **`imagery.key` looks like the right hook — it is a mirage.** It exists only in the `.d.ts`;
   nothing assigns it. If you "fix" the problem by assigning a source-based `imagery.key`, you
   change the cache key of the merc/reproj branches too and break the per-imagery dual-texture
   cleanup identity guards. Leave `baseKey` semantics alone; dedup lives BELOW the cache.
3. **Cross-layer collision (pre-existing, distinct item).** `${x}_${y}_${level}` has no layer
   component: two geographic-provider layers can serve each other's cached textures via the
   `projection?.variant === "geo"` cache-hit branch (`WebGPUGlobeSurfaceTextures.ts:331-339`).
   The dedup fingerprint fixes this for SHAREABLE sources only. Per Principle 9: reproduce it
   (two GridImagery layers with different colors), then file it as its own queue item citing
   FAR-205's "two layers/providers/maps at identical coordinates never alias" acceptance line.
   Folding a silent key change for owned entries into this slice violates "one concern per slice".
4. **Do not begin render passes on the frame encoder mid-update.** `beginFrame` leaves the default
   canvas pass OPEN; `GPUCommandEncoder.beginRenderPass` while another pass is recording is a
   validation error. That is exactly why the design uses a separate prep encoder submitted in
   `endFrame`, not `context.currentCommandEncoder`.
5. **Do not batch Route B reprojections.** `reprojectWebMercatorWebGPU` writes a SINGLE shared
   16-byte uniform buffer (`ReprojectCache.uniformBuffer`, `WebGPUImageryReprojection.ts:131-137`)
   per call and submits immediately. Deferring multiple reprojections into one encoder makes every
   pass read the LAST tile's latitudes (queue writes land before the whole submit). Migrating
   Route B needs a per-job UB ring — that is FAR-205 slice 7 / FAR-402, out of scope here.
6. **`scheduleTextureDestroy` timing:** destroys enqueued BEFORE this frame's `endFrame` ride this
   frame's drain; after, the next frame's (captured-then-cleared at `WebGPUContext.ts:2201-2203`).
   Either is safe; inline `texture.destroy()` on a texture the current frame binds is NOT
   ("Destroyed texture used in a submit" — the Batch 320 split-screen bug class).
7. **Mip-job-vs-eviction race:** a shared realization created and evicted in the same frame (LRU
   thrash) can reach `endFrame` with a mip job for a texture already scheduled for destroy.
   Encoding a pass on a destroyed texture is a validation error; scheduleTextureDestroy only
   defers, so the texture is still alive at encode time — but add the skip-set guard anyway (Step
   3a) for the recovery/teardown path where destroys may have been immediate.
8. **Gate B / FAR-200:** do NOT adopt `SubmissionSerialAuthority` for the prep submit, do NOT
   attach per-resource `onSubmittedWorkDone` callbacks (the adoption doc forbids individual
   callbacks), do NOT monkeypatch `queue.submit`. Shadow-mode mirroring is optional evidence only.
9. **Multi-context:** the existing module-global `ensureMipmapGenerator` single-device slot
   (`WebGPUGlobeSurfaceTextures.ts:47-56`) thrashes under split-screen. Your prep path uses the
   CONTEXT-owned `context.mipmapGenerator` instead — do not add another module-global, and do not
   "fix" the existing global in this slice (it becomes dead for imagery once Step 5 lands; the
   reprojection copy at `WebGPUImageryReprojection.ts:25` remains a live Route B dependency —
   leave both in place per the dead-code-audit rule; note the imagery one as removable in the
   batch doc only if grep proves zero remaining callers).
10. **Device loss/recovery:** after recovery the context's `GPUDevice` changes. The table must
    detect `storedDevice !== host._device` and rebuild (destroys on a lost device are safe
    no-ops). Never let a realization created on device A be served on device B — that is the
    device-generation component of the identity.
11. **requestRenderMode:** pending mip jobs can sit across idle frames — safe (nothing rendered,
    nothing sampled), but your probe must call `scene.requestRender()` or use the moving workload.
    Never use idle FPS as evidence (CLAUDE.md campaign rule).
12. **2D/CV:** `resolveImageryProjection` (`WebGPUGlobeSurfaceTextures.ts:224-268`) is a pure peek
    that decides merc/geo/upload — dedup must not alter it. Sharing only changes who owns the
    GPUTexture on the `"upload"` branch. GridImagery (geographic) never takes the merc branch.
    Certify 2D/CV via the workload matrix anyway (`settled-static-2d`, `moving-camera-columbus`,
    `morph-roundtrip` in `Tools/visual-regression/performance-workloads.json`).
13. **Water mask / ocean normal / exaggeration:** `getOrCreateWaterMaskTexture` and the material
    upload sites keep their own caches, formats (`r8unorm`), and inline-destroy cleanups —
    routing them through the imagery table is out of scope and would violate their cleanup
    contract (`GlobeSurfaceTile.js:144-145` calls the water-mask cleanup directly). Exaggeration
    changes terrain meshes, not imagery textures — no interaction.
14. **Pick:** globe pick derives from the same tile descriptors and binds the same group-1 views —
    sharing is transparent (same view objects). No pick-specific work, but keep
    `probe-pickposition-webgpu.mjs` in the regression set.
15. **Clean-lane purity:** every new counter increment must be behind the existing
    `if (!counters) return;` guards. The clean timing lane must allocate ZERO diagnostic state
    (C9-01 pattern, `WebGPUGlobeSurfaceTypes.ts:459-469` doc comment).
16. **Charter mechanics:** new files in `packages/engine/Source/` only (never root `Source/`);
    TypeScript with zero `any`; preserve every existing comment block you move; pragma-wrap any
    new per-upload diagnostics; lint-staged OOM on big commits → `--concurrent 1` (memory note).
17. **Placeholder texture width:** `_createTexture`'s placeholder (ImageryLayer.js:482-493) keeps
    `imagery.image` alive — for GridImagery that is the ONE shared canvas, so CPU-side cost is
    already deduped; do not "optimize" by clearing `imagery.image` (the upload path needs it on
    cache miss after eviction/re-realization).

---

#### Verification recipe

Prereqs: `npx tsc --noEmit` clean; `npx gulp build` clean; `node server.js --production` running.

1. **Acceptance lane (the 513 → 1 gate).** Instrumented moving route, WebGPU:

   ```powershell
   node Tools/visual-regression/run-performance-campaign.mjs `
     --workload moving-camera-altitude-track-3d --renderer webgpu `
     --repetitions 1 --api-instrumentation `
     --output Tools/visual-regression/output/performance/campaign9-c9-12a-api-webgpu-r1-<date>.json
   ```

   PASS means, comparing deltas against the C9-01 baseline artifact
   (`campaign9-c9-01-owner-families-webgpu-r1-2026-07-15.json`):
   - `apiCounters.labels` delta for `webgpuCommandEncodersCreated.MipmapGeneration` = **0**
     (was 513) and `webgpuCommandBuffersSubmitted.MipmapGeneration` = **0**; a new
     `ImageryMipPreparation` encoder label appears with count ≈ number of frames that realized a
     NEW texture (for GridImagery: ~1).
   - Σ `Mipmap_RenderPass_Level*` delta ≈ **8** (one realization × 8 levels), not 4104.
   - `globeLogicalCounters`: `imageryRealizationsCreated` = **1**;
     `imageryRealizationShares` ≈ old `imageryDirectUploads` (~500+);
     `imageryOwnedLiveTextures/Bytes` bounded and ≪ 181 MB; `imageryMipFallbackSubmits` = 0.
   - Zero page/device/console errors; all eight altitude segments complete.
2. **Plateau (Gate D shape).** Re-run the same workload with `--repetitions 2` (or loop the route)
   and assert `imageryRealization*LiveBytes` / `imageryOwnedHighWaterBytes` do not grow run-over-
   run beyond the grace budget — retirement counters must be non-zero after altitude churn.
3. **Clean lane (no timing mixing).** Same workload WITHOUT `--api-instrumentation`,
   `--renderer both`, `--repetitions 2+`. Gate: WebGL unchanged; WebGPU CPU p95 vs the Gate A
   median (7.51 ms, artifact `campaign9-gate-a-clean-r5`) — claim improvement only per the §7
   promotion rule (≥5% in the named stage or >3× measured noise; single-rep numbers are
   characterization, not claims — the C9-05 ledger row shows the accepted phrasing).
4. **Visual parity (probe-first rule).**
   `node Tools/visual-regression/capture-and-diff.mjs` (all scenes; at minimum
   `--scene globe-default`) — mismatch percentages unchanged vs current baselines; **read the
   PNGs yourself**. Regression probes:
   `probe-terrain-selection-parity.mjs` (GridImagery user), `probe-imagery.mjs`,
   `probe-imagery-overlay.mjs`, `probe-polar-imagery-state.mjs`,
   `probe-pickposition-webgpu.mjs`, `probe-split-screen.mjs` (multi-context isolation + the
   Batch 320 destroyed-texture class).
5. **Real-imagery distinctness (rule-3 negative control).** Default TMS/Natural Earth scene (no
   GridImagery): `imageryRealizationsCreated` ≈ `imageryTextureCacheMisses` (every distinct tile
   realizes its own texture, shares ≈ 0). Any share on undeclared sources = FAIL.
6. **Lifetime matrix.** Workloads `destroy-recreate-content` and `resize-cycle-3d` (both in
   `performance-workloads.json`): zero `"Destroyed texture"` validation errors, zero device
   errors; after full destroy, table diagnostics report 0 entries. Provider replacement:
   `imageryLayers.removeAll(); addImageryProvider(new GridImageryProvider(...))` mid-run inside a
   small probe — old realization retires through the grace LRU, new one is created (revision/
   identity differ because the new provider has a NEW canvas object).
7. **Focused specs.** New Jasmine specs for `ImagerySourceIdentity` (ImageBitmap auto-shareable;
   undeclared canvas → null; declared canvas → stable id; revision bump changes identity) and the
   realization table (ref/release/grace/budget/device-change). Run per the memory notes:
   `npm run build --workspace @cesium/engine` first (workspace spec-bundle freshness trap, queue
   item 4A), then
   `gulp test --workspace engine --browsers=EdgeHeadlessCI --includeName "<SpecName>"` with
   `CHROME_BIN` pointed at Edge.
8. **Ledger + artifacts.** Save the JSON artifacts under
   `Tools/visual-regression/output/performance/`, update the queue §3.2 row with exact numbers,
   and record the batch in `WEBGPU_DEBUGGING_LOG.md`.

---

#### Rollback boundary

- **Land as two sub-slices so rollback is surgical** (plan §8: one concern per slice):
  **(1)** retirement/leak closure + counters (owned direct-upload textures released via
  `scheduleTextureDestroy` on imagery eviction) — this is lifetime-correctness work;
  **(2)** the sharing table + frame-owned mip prep — the optimization.
- If the gate fails (visual delta, validation errors, plateau failure, p95 regression): revert
  slice (2) — restore per-imagery owned textures and the in-place
  `generateMipmapsAndSubmit` call in `uploadImageSource` — but KEEP slice (1), the new counters,
  the specs, and the probe (instrumentation and tests survive rollback, plan §8). **Never** roll
  back mip generation itself (Batch 57 correctness — removing mips reintroduces the orbital
  aliasing/brightness bug), never default-disable imagery, never touch WebGL.
- During stabilization you may keep two module-level consts
  (`IMAGERY_REALIZATION_SHARING_ENABLED`, `IMAGERY_FRAME_OWNED_MIPS_ENABLED`) as an internal A/B
  switch — plan §8 sanctions this "only while stabilizing"; remove them (or convert to a
  containment-stats-visible flag with an owning ledger row) before declaring COMPLETE.
- The FAR-200 shadow services and Route B are untouched by construction, so no rollback surface
  exists there.

---

#### Pointers

**Source (all under `packages/engine/Source/` — canonical; never edit root `Source/`):**
- `Renderer/WebGPU/WebGPUGlobeSurfaceTextures.ts` — helpers module: `ensureMipmapGenerator` 47,
  `mipLevelCountFor` 65, `registerImageryCacheCleanup` 83, `TextureCacheHost` 110,
  `resolveImageryProjection` 224, `getOrCreateImageryTexture` 270, water mask 435,
  `uploadImageSource` 555 (texture create 637, copy 656, **mip submit 665–671**).
- `Renderer/WebGPU/WebGPUMipmapGenerator.ts` — `generateMipmaps` 162 (external-encoder param),
  `generateMipmapsAndSubmit` 247, WeakMap bind-group cache 76.
- `Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts` — caches 317–318, `_logicalCounters` 323/345,
  `initialize` 496 (device-only), tile entry w/ `frameState.context` ~604/618,
  `_createTextureBindGroup` 1695 (helper call 1716, group-1 key 1741–1767), material/ocean
  uploads 1838/1887 (logicalOwner-less — exclude from dedup).
- `Renderer/WebGPU/WebGPUGlobeSurfaceTypes.ts` — `ImageryGPUTexture` 448,
  `WebGPUGlobeLogicalCounters` 470 (imagery counters 495–503; `imageryOwnedRetirements` never
  incremented today).
- `Renderer/WebGPU/WebGPUContext.ts` — `beginFrame` 1734 (opens default pass 1808),
  `beginPickFrame` 1826, `currentCommandEncoder` 2080, `hasActiveRenderPass` 2126,
  `scheduleTextureDestroy` 2144, `endFrame` 2160 (uniform flush 2185, submit 2193, destroy drain
  2201), `get mipmapGenerator` 4538 (loss-registered 5408).
- `Renderer/WebGPU/WebGPUImageryReprojection.ts` — Route B: shared 16-byte UB 131,
  reproject submit 252, mip submits 258/419, `uploadAndReprojectMercatorImage` 365.
- `Scene/Imagery.js` — refcount 46–119, cleanup invocation 90–93, deferred destroys 94–110.
- `Scene/TileImagery.js` — `freeResources` 27; `Scene/GlobeSurfaceTile.js` — 136/160/195.
- `Scene/ImageryLayer.js` — `_createTexture` 444 (placeholder branch 478–504),
  `_reprojectTexture` 590 (dual path 630–661), `_imageryCache` 235/739–754.
- `Scene/GridImageryProvider.js` — one canvas 72, `requestImage` 156–157 (acceptance vehicle).
- `Renderer/ResourceOwnership/` — FAR-200 S1 shadow: `SubmissionSerialAuthority.ts`,
  `RealizationShadowCache.ts` (fingerprint shape to imitate: existingCacheKey + token + domain +
  descriptor + sourceRevision, lines 83–89), leases/descriptor/domain siblings. Shadow-only.

**Specs/plans:** queue row 30A (`QUEUE_2026-07-15_CAMPAIGN9.md:205`), rules §1 (lines 22–35),
gates §3 (Gate B fence lines 58–62, Gate D line 53); plan finding 2 + §4.4 + WS2 bullet
(`FORK_PERFORMANCE_RTE_VISIBILITY_REMEDIATION_PLAN_2026-07-15.md:44-49, 131-140, 179-180`),
promotion rule §7, rollback §8; FAR-205 slices 2/6/7 + acceptance
(`FORK_ARCHITECTURE_REMEDIATION_PLAN_2026-07-13.md:556-571`); FAR-200 adoption boundary
(`FAR_200_SUBMISSION_AUTHORITY_ADOPTION_2026-07-13.md`); Sol audit P0-4 flush lesson + commit
strategy (`SOL_AUDIT_REPORT_2026-07-16.md` §3.4, §7).

**Probes/tools:** `Tools/visual-regression/run-performance-campaign.mjs` (counters handshake 320,
GridImagery boot 1546, `--api-instrumentation`), `performance-workloads.json` (workload ids),
`capture-and-diff.mjs`, `probe-terrain-selection-parity.mjs`, `probe-imagery*.mjs`,
`probe-polar-imagery-state.mjs`, `probe-split-screen.mjs`, `probe-pickposition-webgpu.mjs`;
canonical lane commands in `migration_doc/DEBUGGING_GUIDE.md` (~lines 1096–1126).

**Artifacts (baselines):**
`Tools/visual-regression/output/performance/campaign9-c9-01-owner-families-webgpu-r1-2026-07-15.json`
(513 encoders/submits, 4104 mip passes, `Globe x_y_level` labels),
`…/campaign9-c9-01-logical-owner-counters-webgpu-r1-2026-07-15.json` (519 uploads,
181,402,956 bytes live, zero retirement, 38,774 hits),
`…/campaign9-gate-a-clean-r5-2026-07-15.json` (clean p95 baseline WebGPU 7.51 ms).

**Ledger duty:** update `QUEUE_2026-07-15_CAMPAIGN9.md` §3.2 on start, on pause, and on
completion; statuses per lines 100–105. If you discover the cross-layer collision is real, add a
new NOT STARTED row for it rather than widening this slice.

---

<a id="g8"></a>

## G8 — Effects & Atmosphere cluster

### C9-13 `NEW-GLOBE-EFFECTS-PER-VIEW-PREPARED-HANDLE` + C9-14 `C9-14-GROUND-ATMOSPHERE-STAGE-OWNERSHIP`

**Audience:** Opus worker with the fork CLAUDE.md charter loaded but NO Campaign-9 memory.
**Anchors verified against the live tree post-Batch-672 (2026-07-16), after the Sol tranche (Batches 656–669) and the Sol-audit P0 fixes.** Every `file:line` below was re-read from disk on 2026-07-16 — do not trust older docs when they conflict with this section.

**These are TWO SEPARATE SLICES.** Land C9-13 as one batch/commit, C9-14 as another. Campaign rule 6: "Land one concern per slice. Roll back the optimization, never the feature."

**Before starting either task:** read `migration_doc/QUEUE_2026-07-15_CAMPAIGN9.md` — §1 (campaign rules), §3.2 (live ledger — update it when you start, pause, complete, or block), §6 rows 28 and 31 (your acceptance text). Both items are Wave 2 ("default-path performance recovery"). Check the §3 gate table: Wave-2 hot-path work formally sits behind Gate B (Wave-1 correctness). If the ledger shows Gate B not closed and no explicit amendment covering your slice, record a gate-amendment rationale in the ledger row (these two slices are correctness-independent local optimizations with exact off/on oracles — that is the amendment argument) — or STOP and mark the row BLOCKED with that finding. Do not silently ignore the gate.

---

## TASK 1 — C9-13: per-frame/view prepared globe effects handle

Queue row (§6 item 28, verified): *"Prepare one exact revision-keyed terrain-global effects handle per frame/view. Tiles consume it without repacking shadows, clipping, CSM, atmosphere LUT, or identity strings; multi-view, mutation, model-specific state, recovery, and visuals remain exact."* Risk R2. Cross-refs: `FAR-300` (backend-neutral render packet, `FORK_ARCHITECTURE_REMEDIATION_PLAN_2026-07-13.md:605`) and the §3.1 coverage row "Per-visible-tile arrays, slices, command wrappers, execute closures, **effects packing**, and dynamic uploads".

### 1. Architecture today (post-Sol, verified)

#### The call chain, per selected terrain tile, per frame

1. `packages/engine/Source/Scene/GlobeSurfaceTileProviderRendering.js:791` — `addWebGPUDrawCommandsForTile(tileProvider, tile, frameState, fr)` runs once per PVS-selected tile per frame. It resolves the per-**device** renderer instance from `_webgpuGlobeRenderers.get(device)` (L858–865 — note: keyed by GPUDevice, NOT by context; two Scenes sharing a pooled device share ONE renderer instance) and calls:
2. `_webgpuGlobeRenderer.createTileCommands(tile, surfaceTile, tileProvider, frameState, uniformState)` at **L900** →
3. `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts:594` — `createTileCommands(...)`. Inside it, **per tile**:
   - L740–756: `readyLayers` array built (counter `readyLayerArrays`);
   - L764: `passCount = ceil(totalLayers / imagerySlots)`;
   - **L896: `for (let pass = 0; pass < passCount; pass++)`** — the per-imagery-pass loop. Inside it, **per tile per pass**:
     - L900: `readyLayers.slice(...)` (counter `passLayerSlices`);
     - L1052 / L1062: camera-UB and tile-UB packs (owned by **C9-11/C9-12 — NOT this task**);
     - L1093 / L1095: texture + water/ocean bind groups (also NOT this task);
     - **L1101–1255: the effects block — THIS is the C9-13 target.** Specifically:
       - L1123–1161: `perfMgr.ensureAtmosphereLUTResources(device)` — LUT view resolution + `atmosphereLutViews` wrapper object literal, **allocated per tile per pass**;
       - L1169–1173: receive shadow map resolution (`frameState.shadowState.lightShadowMaps[0]` gated on `lightShadowsEnabled`);
       - L1186–1206: CSM narrowing + `csmBinding` wrapper object literal per tile per pass;
       - L1211–1217: clipping-polygons gate;
       - L1219–1228: the active-vs-placeholder gate (`useClipDistances || clippingPlanes.length>0 || activeClippingPolygons || atmosphereLutViews || receiveShadowMap || csmBinding`);
       - **L1229–1251: `createEffectsBindGroup(device, frameState, {…})`** with a fresh options object literal every call, including a fresh `atmosphereLutPlanetRadii: { inner, outer }` literal (L1247–1250) and `owner: frameState` (L1232);
       - L1254: else-branch binds `this._placeholderEffectsBG!`.
4. `packages/engine/Source/Renderer/WebGPU/WebGPUEffectsBindGroup.js:1009` — `createEffectsBindGroup(device, frameState, options)`. **Per call** (i.e., per tile per pass when any effect is active) it:
   - L1112: `getPlaceholderEffects(device)` (WeakMap lookup + lazy init);
   - L1184–1195: early-out to placeholder when NO feature active (`hasShadow/hasClipping/hasPolygonClipping/hasAtmosphereLut/hasCsm/hasEdges/hasPointLight/hasClusteredLighting` all false);
   - **L1198–1199: `const ud = _scratchEffectsData; ud.fill(0);`** then L1201–1444 repacks the FULL 480-byte effects UBO (shadow matrix, CSM control, clip-polygon extents copy, clip-plane `computeClipPlaneDPrimes` at L1317, LUT control, point-light block) — every call, even when the bytes come out identical to the previous tile's;
   - L1470: `_ensureEffectsBgCache(pCache, frameState?.context)` — the bind-group/UBO slot cache is correctly **context-scoped** (Sol-era fix; frame numbers are only monotonic within one Scene/Context — see comment L1466–1469);
   - **L1536–1548: `resKey` identity string** — 22 `_idFor()` WeakMap lookups + one big template-literal concatenation, per call;
   - L1555–1571: `ownerKey` (`owner:${_idFor(...)}` for the globe since `owner: frameState` is supplied); L1572: `cacheKey = ownerKey#resKey` — another string concat per call;
   - L1575–1623: `bgCache.stateCache.acquire(cacheKey, _scratchEffectsBits, frameNumber, createSlot, writeSlot, retireSlots)`.
5. `packages/engine/Source/Renderer/WebGPU/WebGPUEffectsStateCache.js:38` — `acquire()`: Map lookup + linear slot scan with `bitsEqual` (L56–62; 120 × u32 compares per candidate slot, `bitsEqual` at L191). On a same-bytes hit: no GPU write (`_skippedWrites`). On changed bytes: one `writeBuffer` into a reused slot.

**Net effect today:** GPU-side churn was already fixed (Batch 55 / C-R11 — ~1 UBO+BG per frame instead of ~200). What remains is **CPU-side repacking**: with ~200 visible tiles and shadows or LUT active, the 480-byte `fill(0)`+repack, `computeClipPlaneDPrimes`, 22 WeakMap lookups, 3 string concatenations, the options/wrapper object literals, the LUT/shadow/CSM re-resolution, and the 120-u32 compare run ~200× per frame to produce the SAME bind group ~200 times. C9-01 evidence (queue §3.2): 41,224 tile calls over 1,189 frames each allocating wrappers; this task removes the effects share of that.

#### The template that already exists (copy this pattern)

`packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.ts:1389` — `_getOrCreateSharedPrimitiveEffectsBG(frameState)` is the Slice-2d precedent for exactly this design:
- memo stored **on the context** (`context._primitiveEffectsBG`, `_primitiveEffectsBGFrameNumber`, `_primitiveEffectsBGToggleHash`);
- validity check at L1465–1471: `frameNumber === memoFrame && toggleHash === memoHash && defined(memoBG)`;
- `toggleHash` at L1460–1464 packs (hasShadow | hasCsm | hasAtmosphereLut | hasClustered) into an int;
- **L1473–1486: the toggle-OFF transition comment — read it.** When all effects turn off, the memo must return the PLACEHOLDER explicitly (not null, not stale active BG) so a CSM/shadow/LUT toggle-off doesn't leave last frame's `csmControl = 1.0` bytes bound.

The globe version needs a stronger validity tuple than the primitive one (the primitive path binds no clipping planes/polygons; the globe does).

#### What stays per-model (do NOT touch)

`packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.ts` calls `createEffectsBindGroup` with `owner: model` at **L4215/4218** and passes model-specific state (per-model clipping planes, model-space `cameraInPlaneSpace`, per-model edges/point-light config) at L5376, L5535, L5704, L5765, L5933, L6083, L6363. Models can each have DIFFERENT clipping collections and non-identity model matrices — their effects state is legitimately per-model. The queue row's "model-specific state … remain exact" clause means: your change is confined to the **globe terrain path**; `WebGPUModelRenderer.ts` and `WebGPUPrimitiveCommands.ts` are untouched, and `createEffectsBindGroup` itself keeps its exact signature and semantics for them.

### 2. Target design + invariants

Prepare the globe's group-3 effects bind group **once per (context, frame)**; every tile/pass consumes the prepared handle. Numbered invariants — each is an acceptance criterion:

1. **One prepare per context per frame.** On a warm moving frame, `createEffectsBindGroup` is entered at most ONCE from the globe path (or zero times when the placeholder gate holds). Tiles 2..N and passes 2..M perform: one memo-validity check (reference/scalar compares only) → reuse. No `_scratchEffectsData` touch, no `resKey`/`ownerKey`/`cacheKey` string, no options-object literal, no `ensureAtmosphereLUTResources` call, no `computeClipPlaneDPrimes`.
2. **Byte-exact output.** The bind group and UBO bytes bound by every tile are identical to what the per-tile path would have produced (trivially true because the prepare path IS the current code, executed once).
3. **The memo lives on the context, never on the renderer keyed by frame number alone.** The renderer instance is per-GPUDevice (`GlobeSurfaceTileProviderRendering.js:858`) and pooled devices are shared across contexts post-Sol; two Scenes at the same `frameNumber` with different cameras MUST NOT alias. Follow `_ensureEffectsBgCache`'s context-scoping rationale (`WebGPUEffectsBindGroup.js:1466–1469`) and the primitive precedent (store fields on `frameState.context`).
4. **Validity tuple is exhaustive.** The handle is reusable only when ALL of these match the stored snapshot:
   - `frameState.frameNumber` (real value — never a `?? 0` fallback; cf. audit P1 #14 on the effects-cache `frameNumber ?? 0` hazard, queue item 91);
   - `frameState.context` identity (that's the memo's home) and `this._device` identity;
   - reference identity of: `receiveShadowMap` (the resolved `lightShadowMaps[0]`-or-undefined), `csmCandidate.cascadeParamsBuffer`, `csmCandidate.cascadeArrayView`, `csmCandidate.pcfRadius` (scalar), LUT `transmittanceView` + `inscatterView`, `tileProvider.clippingPlanes` ref + `.length` + `.enabled`-equivalent, `activeClippingPolygons` ref + `.length`, `tileProvider` ref;
   - **`uniformState.cameraPosition` VALUES `x/y/z`** — snapshot the three numbers, never the object reference (it is a mutated-in-place scratch Cartesian3; the ref compares equal across frames while the values change).
   Any mismatch, or any input you cannot classify → fall through to the full current path (campaign rule 3: unknown ⇒ conservative execution). A mismatch mid-frame is legal and must produce a fresh exact handle, not a stale reuse.
5. **The placeholder decision is part of the handle.** The gate at `WebGPUGlobeSurfaceRenderer.ts:1219–1228` is evaluated inside the prepare; when it selects the placeholder, the memo stores "placeholder" so toggle-off transitions swap the slot back (the `WebGPUPrimitiveCommands.ts:1473–1486` lesson).
6. **No change to `createEffectsBindGroup` semantics.** Its other consumers (model, primitives) and the state cache (`WebGPUEffectsStateCache.js`) are shared infrastructure. You may add a read-only counter hook at most. The `_scratchEffectsData` module global stays as-is (also used by `updateEffectsUniforms`, L1669).
7. **Wireframe and capture paths keep the placeholder.** `createWireframeTileCommands` binds `this._placeholderEffectsBG!` at L2125; `getOrCreateCaptureTileCommands` at L2277 (its doc comment at L2156 says the single-pass placeholder is intentional). Do not "upgrade" them.
8. **Clustered lighting stays OFF for the globe.** The globe call site passes no `clusteredLighting` (the globe FS reads the effects BGL's per-device placeholder cluster buffers and early-outs). Do not add it.
9. **Multi-frustum execution is unaffected.** TileDrawDescriptors are re-executed across natural frusta with dynamic offsets on group 0; group 3 (effects) is the same object today across frusta and stays so.
10. **Recovery/loss:** the memo is per-frame, so a device swap invalidates naturally on the next frame tick; include the device ref in the tuple anyway (invariant 4) so a mid-frame recreate can never serve a dead-device bind group.
11. **Counters:** add optional fields to `WebGPUGlobeLogicalCounters` (`packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTypes.ts:470` — interface with all-optional members, additive is safe), e.g. `effectsHandlePrepares` and `effectsHandleReuses`, incremented under the existing `if (logicalCounters)` guards. Clean lanes stay null → zero overhead (the sink is installed only by the instrumented perf lane via `globalThis.__webgpuGlobeLogicalCounters`, renderer ctor L345–350; runner install at `Tools/visual-regression/run-performance-campaign.mjs:320`).

### 3. Implementation walkthrough

1. **Read first:** `WebGPUGlobeSurfaceRenderer.ts:1101–1255` (whole effects block + its comments), `WebGPUEffectsBindGroup.js:912–1009` (JSDoc) and L1446–1470 (cache-design comment block), `WebGPUPrimitiveCommands.ts:1367–1486` (the template + its two long comments).
2. **Write a private helper** in `WebGPUGlobeSurfaceRenderer.ts` (TS, no `any` — use `unknown` + local structural narrowing exactly like the surrounding code does):
   `private _getOrCreateFrameEffectsBindGroup(device, frameState, tileProvider, uniformState): GPUBindGroup`
   Body = MOVE (not copy-and-fork) the code currently at L1123–1255: LUT resolve, shadow resolve, CSM narrow, clip-polygons gate, the active/placeholder gate, the `createEffectsBindGroup` call. Preserve every comment block — they are load-bearing (DP-H28, CSM Slice 1, GLOBE-CLIPPOLY-GEODETIC, the `shouldRecomputeAtmosphereLUT` side-effect warning at L1140–1153).
3. **Memo storage:** on the context object (mirror the primitive naming): e.g. `context._globeEffectsBG`, `context._globeEffectsBGFrameNumber`, `context._globeEffectsBGSnapshot` (a small mutable record holding the invariant-4 tuple: refs + camera x/y/z + device ref). Reuse-check order: frameNumber first (cheapest, changes every frame), then device, then refs, then camera values. On hit: `effectsHandleReuses++`, return. On miss: run the moved body, store, `effectsHandlePrepares++`, return. Declare the added context fields where the primitive path declared ITS fields (find `_primitiveEffectsBG` in `cesium-js-types.d.ts` / the context typing and follow the same declaration route).
4. **Call site:** replace L1219–1255 with `const bindGroup3 = this._getOrCreateFrameEffectsBindGroup(device, frameState, tileProvider, uniformState);`. `useClipDistances` (L926–933) stays where it is — it also feeds pipeline selection; the effects gate inside the helper re-derives its clipping-planes condition from `tileProvider.clippingPlanes` directly (the `useClipDistances ||` term at L1221 is redundant with `clippingPlanes.length > 0` because `useClipDistances` requires `cp.length > 0`; keep the full original expression anyway to stay provably byte-equal in review).
5. **Decision points:**
   - If you find the effects block has moved (line drift from concurrent Campaign-9 batches): re-locate via `Grep createEffectsBindGroup` in `WebGPUGlobeSurfaceRenderer.ts` — there is exactly ONE call site in that file. If there are suddenly TWO call sites, STOP and re-read the newer batch's intent before proceeding.
   - If you find someone already added a frame-memo (grep `_globeEffectsBG` / `effectsHandle` first): the task may be partially done — reconcile with the ledger (§3.2) instead of duplicating.
   - If the reuse-check needs an input you cannot snapshot cheaply (e.g. a new mutable field appears in the options): include the ref + a length/scalar, or fall back to always-prepare for that configuration. Never guess.
6. **Counters + interface:** add the two optional fields to `WebGPUGlobeLogicalCounters` with a one-line doc each (match the terse existing style; do NOT add JSDoc boilerplate).
7. **Ledger:** set the queue §3.2 row for `NEW-GLOBE-EFFECTS-PER-VIEW-PREPARED-HANDLE` to IN PROGRESS when you start; record evidence and flip to COMPLETE (or honest PARTIAL) when done.

### 4. Traps for the unwary

- **T1 — Pooled-device renderer sharing.** The single biggest correctness trap. `_webgpuGlobeRenderers` is keyed by `device`; post-Sol multi-context work shares devices. A memo on `this` (renderer) keyed only by frameNumber will serve Scene A's camera bytes to Scene B. Memo on `frameState.context`. This exact hazard is documented at `WebGPUEffectsBindGroup.js:1466–1469`.
- **T2 — `uniformState.cameraPosition` is a live scratch object.** Reference equality is always true; value equality is what you must check. Snapshot x/y/z floats.
- **T3 — Toggle-off must re-bind the placeholder.** If your memo returns early on `frameNumber` match alone, a mid-session `viewer.shadows = false` (same-frame toggles are rare but the NEXT frame's gate flip) must flow through. The tuple check covers it (receiveShadowMap ref becomes undefined ⇒ miss ⇒ prepare ⇒ gate selects placeholder). Test it explicitly (verification step V4).
- **T4 — Do not touch `ensureAtmosphereLUTResources`' sibling `shouldRecomputeAtmosphereLUT()`.** The comment at L1140–1153 explains it is SIDE-EFFECTING (clears SkyAtmosphere's dirty flag). The helper must keep calling only `ensureAtmosphereLUTResources`.
- **T5 — Scope creep into C9-11/C9-12.** Camera-UB packs (L1052), tile-UB packs (L1062), texture BG (L1093), water/ocean BG (L1095), the `readyLayers` array and `slice()` — all stay per-tile. They have their own queue rows (items 29, 30). A diff that touches them will fail the one-concern-per-slice review.
- **T6 — Don't "optimize" `WebGPUEffectsStateCache` or `createEffectsBindGroup` internals.** Shared with model/primitive paths and with Sol's effects-cache leases + specs (audit rating table #8). Your slice consumes them; it does not rewrite them.
- **T7 — Dead-code illusion.** After your change, the per-call string-key machinery in `createEffectsBindGroup` looks "wasted" for the globe (one call/frame). It is NOT dead — the model path calls it per model. Charter Principle 7: leave it.
- **T8 — TS discipline.** No `any` (including in the context-field declarations — use the co-located `.d.ts` / ambient-interface pattern the file already uses); no new JSDoc on moved code; keep the moved comments verbatim.
- **T9 — Pick/derived commands.** The globe pick pass derives from the same TileDrawDescriptors and rebinding uses the same group 3. Nothing to do — but run the pick probe (V6) to prove it.
- **T10 — `frameNumber ?? 0`.** If frameState ever lacks a frame number on this path, do NOT memoize (prepare fresh). Queue item 91 documents the aliasing hazard class.

### 5. Verification recipe

Environment: Edge only (`CHROME_BIN` → Edge for Karma; Playwright uses Edge channel). Server: `node server.js --production` (probes default to :8080; `probe-ground-atmosphere.mjs` uses PROBE_BASE default :8134 — pass `PROBE_BASE=http://localhost:8080`).

- **V0 Build gates:** `npx tsc --noEmit` (zero errors), `npx gulp build` clean.
- **V1 Byte-identity (the core gate):** run the split-screen/visual baseline BEFORE and AFTER on the same build machine: `node Tools/visual-regression/capture-and-diff.mjs` — mismatch percentages must be unchanged (this slice is supposed to be pixel-invisible). Any pixel delta = bug, full stop.
- **V2 Effects-active parity probes** (each must PASS on both backends, and pass identically pre/post):
  - `node Tools/visual-regression/probe-csm-globe-receive-trace.mjs` (globe CSM shadow receive — exercises the csmBinding path);
  - `node Tools/visual-regression/probe-clipping-planes-parity.mjs` and `probe-globe-clippoly-geodetic.mjs` (clipping planes/polygons → active BG + dPrime pack);
  - `PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-ground-atmosphere.mjs` (LUT/atmosphere contribution + toggle);
  - `node Tools/visual-regression/probe-atmo-lut-off.mjs` (LUT-fallback band unchanged).
- **V3 Counters prove the claim:** instrumented lane —
  `node Tools/visual-regression/run-performance-campaign.mjs --workload moving-camera-altitude-track-3d --renderer webgpu --repetitions 1 --api-instrumentation --output Tools/visual-regression/output/performance/c9-13-instrumented-r1.json`
  In the artifact, your new counters must show `effectsHandlePrepares ≈ frames` (≤ frames + toggle events) while `tileCalls` is in the tens of thousands, and `effectsHandleReuses ≈ (tile passes with active effects) − prepares`. If prepares scales with tiles, the memo is broken.
- **V4 Toggle matrix (on/off/restored):** scripted or manual on `http://localhost:8080/Apps/CesiumViewer/index.html?renderer=webgpu`: flip `viewer.shadows`, `globe.clippingPlanes.enabled`, atmosphere LUT availability (toggle `scene.skyAtmosphere.show`) each true→false→true across frames; screenshot each state; OFF states must not retain shadow darkening / clipping / LUT fog (stale-BG symptom), ON-restored must match the original ON.
- **V5 Multi-context:** load `http://localhost:8080/Apps/WebGPUTest/split-screen-comparison.html` — no cross-scene bleed, no console/device errors (this is the T1 trap's oracle; if a pooled-device dual-WebGPU probe exists in the tree, prefer it).
- **V6 Pick regression:** `node Tools/visual-regression/probe-pickposition-webgpu.mjs` (globe depth/pick unaffected).
- **V7 Performance evidence (named-stage, not campaign-blocking):** clean lane, 2 reps both renderers:
  `node Tools/visual-regression/run-performance-campaign.mjs --workload moving-camera-altitude-track-3d --renderer both --repetitions 2 --output .../c9-13-clean-r2.json`
  Report CPU p95 delta honestly; a within-noise result is acceptable for landing (the WS2 promotion rule — ≥5% named stage or >3× noise — governs *promotion claims*, and the combined-tranche checkpoint is item 35, not this slice). Never mix clean and instrumented samples.
- **V8 Ledger + docs:** update queue §3.2 row with artifacts; if you added a probe, register it in `migration_doc/DEBUGGING_GUIDE.md`'s probe inventory (the guide MUST stay in sync — CLAUDE.md).

### 6. Rollback boundary

Revert **only** the memoization commit (helper + call-site + context fields). The inline per-tile `createEffectsBindGroup` path is the proven fallback and is byte-identical by construction. NEVER revert or default-off shadows/CSM/clipping/LUT themselves, `WebGPUEffectsBindGroup.js`, or `WebGPUEffectsStateCache.js`. The new counters and any specs SURVIVE rollback (campaign rule 6). If V1 shows any pixel delta you cannot root-cause quickly, roll back and record the finding in the ledger row as PARTIAL with the failing artifact.

### 7. Pointers

- Loop sites: `packages/engine/Source/Scene/GlobeSurfaceTileProviderRendering.js:791,858–865,900`; `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts:594,896,1052,1062,1101–1255` (esp. 1123–1161, 1169–1206, 1219–1251, 1254), wireframe 2125, capture 2277.
- Effects module: `packages/engine/Source/Renderer/WebGPU/WebGPUEffectsBindGroup.js:1009` (fn), 1184–1195 (placeholder early-out), 1198–1199 (fill+repack), 1317 (dPrime), 1466–1470 (context scoping), 1536–1572 (identity strings), 1575–1623 (acquire), exports 1830–1849 (`getEffectsCacheDiagnostics` is exported — usable in probes).
- Slot cache: `packages/engine/Source/Renderer/WebGPU/WebGPUEffectsStateCache.js:38` (acquire), 191 (bitsEqual).
- Template: `packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.ts:1389–1509` (esp. 1460–1486).
- Stays per-model: `packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.ts:4215,4218` (+ owner: model at 5376/5535/5704/5765/5933/6083/6363).
- Counters: `WebGPUGlobeSurfaceRenderer.ts:323,345–350`; interface `WebGPUGlobeSurfaceTypes.ts:470`; runner install `Tools/visual-regression/run-performance-campaign.mjs:320`.
- Specs/probes named in V1–V7; canonical route recipe: `migration_doc/DEBUGGING_GUIDE.md:1089` ("Canonical moving-altitude campaign").
- Ledger rows: `migration_doc/QUEUE_2026-07-15_CAMPAIGN9.md` §6 item 28, §3.1, §3.2. Architecture: `FORK_PERFORMANCE_RTE_VISIBILITY_REMEDIATION_PLAN_2026-07-15.md` §2 finding 1, §4.2, WS2. FAR-300/FAR-303 context: `FORK_ARCHITECTURE_REMEDIATION_PLAN_2026-07-13.md:605,633`.

---

## TASK 2 — C9-14: ground-atmosphere one-stage-per-variant ownership

Queue row (§6 item 31, verified): *"Reuse `perFragmentGroundAtmosphere`: fragment mode skips the vertex march; vertex mode consumes the varying and skips fragment recompute. Preserve debug visualizers and fog/atmosphere on/off, ground/horizon/orbit, HDR/SDR, water, and exaggeration."* Risk R3. Plan §2 finding 5: *"The default terrain shader can perform a vertex atmosphere march and recompute the atmosphere in the fragment path while the vertex result is not consumed. One exact quality variant must own the work at a time."*

### 1. Architecture today (post-Sol, verified)

#### WebGL (the reference — already one-stage-per-variant)

- CPU flag: `packages/engine/Source/Scene/GlobeSurfaceTileProviderRendering.js:1275–1280` — `perFragmentGroundAtmosphere = showGroundAtmosphere && (Cartesian3.magnitude(frameState.camera.positionWC) > tileProvider.nightFadeOutDistance)` (fadeOut default 10 Mm). Threaded via `surfaceShaderSetOptions` (L1410–1411) into `GlobeSurfaceShaderSet.js` — flag bit 15 in the shader-variant key (L186), pushes the `PER_FRAGMENT_GROUND_ATMOSPHERE` define into VS+FS (L345–347).
- VS gate: `packages/engine/Source/Shaders/GlobeVS.glsl:306` — `#if defined(FOG) || (defined(GROUND_ATMOSPHERE) && !defined(PER_FRAGMENT_GROUND_ATMOSPHERE))` → vertex march fills `v_atmosphereRayleighColor/MieColor/Opacity`.
- FS: `packages/engine/Source/Shaders/GlobeFS.glsl:664–755` — block gated `#if defined(GROUND_ATMOSPHERE) || defined(FOG)`; **L681–697**: `#ifdef PER_FRAGMENT_GROUND_ATMOSPHERE` → `computeAtmosphereScattering(...)` per fragment; `#else` → consume the three varyings. Fog branch L708–723, drape branch L724–753.
- Upstream corner: FOG + GROUND_ATMOSPHERE + PER_FRAGMENT ⇒ WebGL's VS still marches (because of the `FOG ||` term) while the FS recomputes — vertex result unconsumed. This corner is practically unreachable at defaults (fog cuts off at 800 km; per-fragment starts at 10 Mm) and your WGSL design may legitimately skip the vertex march there (output identical — the varyings are unconsumed).

#### WebGPU (the duplicate — your target)

`packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl` (canonical source; the sibling `GlobeTerrain.js` is BUILD OUTPUT regenerated by `npx gulp build` — never hand-edit it, same for `GlobeFS.js`):

- Varyings: `@location(6/7/8) v_atmosphereRayleighColor / v_atmosphereMieColor / v_atmosphereOpacity` — struct at **L663–665**.
- **Vertex march (always-on half of the duplicate): L1368–1399** in `processVertex()` (shared by all six `@vertex` entry points). Zero-init at L1374–1376; gate at **L1377**: `if (camera.atmosphereParams.w > 0.5 && mode > 2.5)`; dynamic-lighting select L1389–1394; `computeAtmosphereScatteringGround(position3DWC, lightDir)` at **L1395** (fn defined at L1150; ported from `GroundAtmosphere.glsl::computeAtmosphereScattering`).
- **Fragment recompute (the other half): L4063–4360** — PAIR-SECTION header L3996–4002 (GLSL twin `GlobeFS.glsl` ~512–603 — note this GLSL line range in the header is STALE; the live GLSL block is at 630–755). Key lines: gate L4064–4065 (`tile.fogDensity > 0 || tile.groundAtmosphereControl.x > 0.5`); LUT-vs-analytic fog color L4073–4099 (leave untouched); **per-fragment march L4116–4146** — `computeAtmosphereScatteringGround(positionWC, lightDir)` at **L4136** feeding `computeGroundAtmosphereColor(viewDir, lightDir, rayleigh, mie)` (fn at L1177) and `groundAtmoOpacity` L4143; fog branch L4148–4210 (consumes `groundAtmoColor` at L4153); drape branch L4211–4358 (consumes `groundAtmoColor`/`groundAtmoOpacity` via `opacityForDrape` L4234–4238, darken mix L4285–4304, HDR gate L4319–4324).
- **The FS NEVER consumes the varyings on the shading path.** Verified: the only `input.v_atmosphere*` reads in the whole file are the two debug visualizers at **L4328 (rayleigh-v, tile.time window 13.5e9–14.5e9)** and **L4332 (mie-v, 14.5e9–15.5e9)**. So today: VS marches per VERTEX whenever atmosphere/fog is on in 3D, AND the FS marches per FRAGMENT — the duplicate integration.
- Documented divergence (now to be retired): structural-divergence note #2 at L4017–4027 ("WGSL **always** does per-fragment … per-vertex varyings remain in the WGSL VS for future use") — Batch 56's rationale was a mesh-pattern artifact at ORBIT from interpolated optical depths. That rationale is preserved by this task: vertex ownership applies only where WebGL itself uses per-vertex (near ground / fog range).

#### CPU-side UB plumbing (where the new flag goes)

- Camera UB packer: `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceCameraUB.ts` — `atmosphereParams.w` encoding (0 off / 1 static / 2 dynamic) packed at L611–661 (`fogEnabled` L627, `groundAtmoEnabled` L628–629, aerial-perspective override L625–626). It has `frameState` and `tileProvider` in scope — everything needed to compute the WebGL flag exactly.
- Camera UB size: `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTypes.ts:165` — `CAMERA_UNIFORM_FLOATS = 232`. WGSL struct tail: `cloudShadowVP1/VP2` + `cloudShadowCascadeParams` at `GlobeTerrain.wgsl:245–248` (cascadeParams = offsets 228–231, `y/z/w` reserved).
- Tile UB carries `nightFadeOutDistance`/`nightFadeInDistance` (`WebGPUGlobeSurfaceTileUB.ts:528–529`, default 10 Mm / 50 Mm) and `groundAtmosphereControl` (x enable, y fade, z intensity, w HDR).
- Debug sentinel: `WebGPUGlobeSurfaceTileUB.ts:610–622` (pragma-wrapped) writes `getActiveDebugSentinel()` into `tile.time`; registry `WebGPUGlobeFragmentDebug.ts` — `rayleigh-v` sentinel 14.0e9 (L116–120), `mie-v` 15.0e9 (L122–125).

### 2. Target design + invariants

Mirror WebGL's stage ownership at runtime (the WGSL convention is runtime UBO gates, not pipeline variants — keep it that way; a define-keyed variant would churn pipelines every time the camera crosses 10 Mm).

**Ownership predicate (computed CPU-side, exactly WebGL's consumption logic):**
```
atmoEnabled     = fogEnabled || groundAtmoEnabled              // existing L627–629 values
perFragment     = groundAtmoEnabled &&
                  Cartesian3.magnitude(frameState.camera.positionWC) > nightFadeOutDistance
vertexOwnership = atmoEnabled && !perFragment                  // 1.0 → VS marches, FS consumes varyings
                                                               // 0.0 → VS skips,   FS marches
```
(`nightFadeOutDistance` from the tileProvider, `?? 10000000.0` like `WebGPUGlobeSurfaceTileUB.ts:528`.) This reproduces every WebGL consumption case, including making the FOG-only case vertex-owned and the far-orbit case fragment-owned; in WebGL's wasteful FOG+PER_FRAGMENT corner it chooses fragment-only (output identical — WebGL discards the vertex result there).

Invariants:

1. **Exactly one stage integrates the atmosphere per rendered fragment.** Never both, never neither while `atmoEnabled`.
2. **Orbit (perFragment=true) output is byte-identical to the current tree** — the FS fragment path is untouched; the VS march is skipped there and its result was already unconsumed.
3. **Near-ground/fog (vertexOwnership=1) output matches WebGL** (which consumes varyings there). Expect a small, characterizable delta vs the CURRENT WebGPU output (per-fragment → per-vertex-interpolated). `SHADER_PAIRS_LOCKSTEP.md:236` records that the two collapse to the same answer close-in; you must PROVE it with the probes in §5 and read the PNGs yourself (charter Principle 8).
4. **Atmosphere off (`atmosphereParams.w = 0`)**: both stages skipped — unchanged behavior, byte-identical.
5. **Debug visualizers keep working in every mode.** `rayleigh-v`/`mie-v` must show live varyings even when fragment mode would skip the VS march: in the camera-UB packer, inside a `//>>includeStart('debug')` pragma block, force `vertexOwnership = 1.0` when `getActiveDebugSentinel()` returns 14.0e9 or 15.0e9. (Production builds strip it; behavior at defaults is untouched.)
6. **HDR/SDR gates untouched** (`tile.groundAtmosphereControl.w` at L4199/L4319 — do not move or restructure).
7. **Fog on/off works under both ownerships** — the fog branch (L4148) consumes `groundAtmoColor` from whichever stage owns the march.
8. **Water, exaggeration, 2D/CV, underground, translucency untouched.** The `mode > 2.5` VS guard stays; the FS gates stay; ocean/water code paths don't read the atmosphere varyings.
9. **New UB field is a tail-append.** Append `groundAtmosphereStageControl: vec4<f32>` after `cloudShadowCascadeParams` in the WGSL struct (x = vertexOwnership; y/z/w reserved) and bump `CAMERA_UNIFORM_FLOATS` 232 → 236 (`WebGPUGlobeSurfaceTypes.ts:165`). 236 floats = 944 B, still under the 1024-B aligned ring slice — no ring-geometry change. **Zero-fill default = fragment ownership = the FS behaves exactly as today** — the flag fails toward current behavior. (Alternative if a size bump proves disruptive: use the reserved `cloudShadowCascadeParams.y` — but the dedicated vec4 with its own doc comment is the established pattern; every tail-append in this struct carries an "Additive tail-append — no existing offset shifts; all-zero default ⇒ byte-identical" note. Write the same note.)
10. **GLSL runtime behavior unchanged.** C9-14 is a WGSL-side fix; WebGL already has stage ownership. But SHADER_PAIRS_LOCKSTEP discipline (see traps T1) requires the divergence NOTES in both files and the lockstep doc row to be updated in the same commit.
11. **No feature-flagging.** This is not opt-in; it is the corrected default. Rollback is by revert, not by a runtime kill-switch.

### 3. Implementation walkthrough

1. **Read first:** `GlobeTerrain.wgsl` L3996–4046 (pair-section header + divergence notes), L1368–1399 (VS block), L4063–4146 (FS gate + march); `GlobeFS.glsl` L630–755; `GlobeVS.glsl` L300–320; `SHADER_PAIRS_LOCKSTEP.md` rows 235–238; `WebGPUGlobeSurfaceCameraUB.ts` L600–700.
2. **CPU (packer):** in `WebGPUGlobeSurfaceCameraUB.ts`, after the `atmosphereParams.w` write (L661), compute `vertexOwnership` per the predicate above (all inputs already in scope: `fogEnabled`, `groundAtmoEnabled`, `frameState.camera.positionWC`, `tileProvider.nightFadeOutDistance`). Add the pragma-wrapped debug force (invariant 5 — import `getActiveDebugSentinel` from `./WebGPUGlobeFragmentDebug.js`; check how `WebGPUGlobeSurfaceTileUB.ts:618` imports it and mirror). Pack it into the new tail vec4 slot (offsets 232–235).
3. **Types:** `WebGPUGlobeSurfaceTypes.ts:165` — bump to 236; extend the offset-map comment above it (L160–164 style).
4. **WGSL struct:** append the field at `GlobeTerrain.wgsl:248` (before the closing `};`) with the standard tail-append doc comment naming C9-14.
5. **WGSL VS:** L1377 — extend the gate:
   `if (camera.atmosphereParams.w > 0.5 && mode > 2.5 && camera.groundAtmosphereStageControl.x > 0.5)`
   Update the block comment L1368–1373 (it currently says "When skipped, the v_atmosphere* outputs stay at zero so the FS additive contribution evaluates to a no-op" — now also true in fragment-ownership mode) and the stale note that the varyings are "for future use".
6. **WGSL FS:** restructure ONLY L4113–4146:
   ```wgsl
   var groundAtmoColor: vec3<f32>;
   var groundAtmoOpacity: f32 = atmosphereOpacity;
   var groundAtmoLightDir: vec3<f32> = vec3<f32>(0.0, 0.0, 1.0);
   if (camera.atmosphereParams.w > 0.5) {
     // viewDir/lightDir stay PER-FRAGMENT in both modes (mirrors GlobeFS.glsl:692-693,
     // which recomputes lightDirection per fragment even when consuming varyings).
     let cameraWC = camera.encodedCameraHigh + camera.encodedCameraLow;
     let positionWC = input.v_positionMC;
     let viewDir = normalize(positionWC - cameraWC);
     let dynamicLightingActive = camera.atmosphereParams.w > 1.5;
     let lightDir = select(normalize(positionWC),
                           camera.atmosphereLightDirectionAndIntensity.xyz,
                           dynamicLightingActive);
     groundAtmoLightDir = lightDir;
     if (camera.groundAtmosphereStageControl.x > 0.5) {
       // C9-14 vertex-stage ownership — consume the VS march (WebGL !PER_FRAGMENT path,
       // GlobeFS.glsl:691-697). Skips the per-fragment ray march entirely.
       groundAtmoColor = computeGroundAtmosphereColor(
         viewDir, lightDir,
         input.v_atmosphereRayleighColor, input.v_atmosphereMieColor,
       );
       groundAtmoOpacity = input.v_atmosphereOpacity;
     } else {
       // Fragment-stage ownership (WebGL PER_FRAGMENT path) — unchanged from Batch 56.
       let perFragScattering = computeAtmosphereScatteringGround(positionWC, lightDir);
       groundAtmoColor = computeGroundAtmosphereColor(
         viewDir, lightDir, perFragScattering.rayleigh, perFragScattering.mie,
       );
       groundAtmoOpacity = perFragScattering.opacity;
     }
   } else {
     groundAtmoColor = atmosphereColor;
   }
   ```
   Preserve the surrounding Batch 56/38 comments (move/trim only what the restructure makes false). Everything downstream (fog mix, drape, darken, HDR, debug windows) is untouched.
7. **Doc/comment sync (same commit — drift is itself a bug per CLAUDE.md):**
   - `GlobeTerrain.wgsl` divergence note #2 (L4017–4027) → describe runtime stage ownership mirroring `PER_FRAGMENT_GROUND_ATMOSPHERE`;
   - `GlobeFS.glsl` L645–652 ("WGSL ALWAYS does per-fragment") → same correction; comment-only GLSL change, zero runtime delta;
   - bump both "Last lockstep audit" lines (`GlobeTerrain.wgsl:3999`, `GlobeFS.glsl:633`) to your date/batch;
   - `SHADER_PAIRS_LOCKSTEP.md:236` — rewrite the row: both backends now switch per-vertex/per-fragment on the same camera-distance rule; WGSL gate is runtime (`camera.groundAtmosphereStageControl.x`), GLSL gate is the compile-time define;
   - `WebGPUGlobeFragmentDebug.ts:119` — drop "currently unused at orbit" from the `rayleigh-v` description; note the debug force.
   - While in these files you will see stale references owned by OTHER queue items — `GlobeTerrain.wgsl:3292` comment and `SHADER_PAIRS_LOCKSTEP.md:260` (`Matrix4.setDepthRangeType`, removed by Sol's ClipSpaceConvention) belong to queue item 83 (`NEW-DOC-SYNC-CLIPSPACE-GRAPHICSCAPABILITIES`). Do NOT fold them into this slice.
8. **Rebuild:** `npx gulp build` regenerates `GlobeTerrain.js` / shader string modules.
9. **Decision points:**
   - If `CAMERA_UNIFORM_FLOATS` is no longer 232 (a concurrent batch appended another tail field): append AFTER the new tail, recompute offsets, keep going — the pattern is unchanged.
   - If the FS block has drifted from L4063: re-anchor via `Grep "computeAtmosphereScatteringGround" GlobeTerrain.wgsl` — the FS call site is the one inside `fragmentMain`'s fog/atmosphere block (the other hit is the VS at ~1395 and the fn def at ~1150).
   - If near-ground parity probing (V3 below) shows a mesh-pattern artifact BELOW 10 Mm (i.e., WebGL's own per-vertex regime looks wrong on WebGPU): STOP. That means the WGSL vertex march diverges from `computeAtmosphereScattering` numerically — do not "fix" by re-enabling the FS recompute; mark the ledger row PARTIAL/BLOCKED with PNGs and the finding (surface missing/deferred functionality per Principle 9).
   - If you find `groundAtmosphereControl.x` semantics changed by a concurrent batch (grep the tile-UB packer), re-verify the FS gate truth table before editing.

### 4. Traps for the unwary

- **T1 — SHADER_PAIRS_LOCKSTEP.** `GlobeTerrain.wgsl` ↔ `GlobeFS.glsl` is a registered pair with PAIR-SECTION sentinels. Any WGSL change inside the block REQUIRES the matching GLSL-side edit (here: comments + doc row, since GLSL behavior is already correct) landing in the SAME commit, plus the lockstep-doc row update. Reviewers grep for this.
- **T2 — Canonical paths.** Edit `packages/engine/Source/Shaders/**` only. Root `Source/` and every `Shaders/**/*.js` (including `GlobeTerrain.js`, `GlobeFS.js`) are build outputs.
- **T3 — Do not remove the varyings** (`@location(6/7/8)`, L663–665) or their zero-init (L1374–1376) — the FS consumes them in vertex mode and in the debug visualizers, and pipeline validation requires the VS/FS interface to match for all six vertex entry points.
- **T4 — The mesh-pattern artifact is real, at orbit only.** Batch 56 (comments L4101–4112, L4017–4027) documents why per-vertex is wrong at orbit: near-side ~110 m marches vs limb ~13 Mm marches interpolated across one triangle. Your ownership predicate must NEVER select vertex mode above `nightFadeOutDistance`. Do not be tempted to widen vertex ownership for extra performance.
- **T5 — Zero-fill must equal current behavior.** The struct default (all-zero UB before first pack, capture/wireframe paths, any packer bypass) must select FRAGMENT ownership (x=0 → FS marches → today's output). This is why x=1 means "vertex" and not the reverse. Don't flip the polarity.
- **T6 — `select()` in WGSL evaluates both arms.** Use the `if/else` structure above for the march switch — a `select` would run BOTH marches and destroy the point of the task. (The existing small `select` for lightDir is fine — both arms are cheap.)
- **T7 — Don't touch the LUT fog block (L4066–4099)** or `sampleAtmosphereFogLut`. The LUT path is a documented WGSL-only enhancement (lockstep row 237) orthogonal to stage ownership; `atmosphereColor`/`atmosphereOpacity` feed the `else` fallback at L4145 and the `opacityForDrape` default — leave the dataflow intact.
- **T8 — `atmosphereParams.w` is an ENCODING (0/1/2), not a bool.** Do not pack your flag into it (a 4-bit would break the `> 1.5` dynamic-lighting checks at L1389/L4125/L4186/L4285). New slot only.
- **T9 — The debug force must be pragma-wrapped** (`//>>includeStart('debug', pragmas.debug);`) exactly like the sentinel write in `WebGPUGlobeSurfaceTileUB.ts:610–622` — `stripPragmaPlugin` handles `.ts`. An unwrapped `getActiveDebugSentinel()` call on the hot path violates the logging/pragma rules AND C9-18's diagnostic-demand-gate direction.
- **T10 — Camera-UB consumers beyond the main pass.** The capture path (`getOrCreateCaptureTileCommands`) packs its own camera UB via the same packer/constants — the size bump flows automatically, but verify no hardcoded `232`/`928` literals exist: `Grep -n "232|928" packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurface*.ts` and fix any that mirror the constant.
- **T11 — This is GPU work, not CPU work.** Do not expect (or claim) CPU-p95 movement. The win is per-fragment ALU near ground and per-vertex ALU at orbit. Evidence = GPU timestamps + parity, not CPU deltas (see V6).
- **T12 — 2D/CV.** The VS `mode > 2.5` guard means planar modes never march; WebGL's `showGroundAtmosphere` is SCENE3D-gated CPU-side (`GlobeSurfaceTileProviderRendering.js:1258–1259`). Your predicate inherits `groundAtmoEnabled` from the packer, which does NOT check mode (L628–629) — that asymmetry exists TODAY; do not "fix" it in this slice. Just keep the `mode > 2.5` VS guard and verify 2D/CV byte-identity (V5).

### 5. Verification recipe

Server: `node server.js --production`. Rebuild before probing (`npx gulp build`). `npx tsc --noEmit` first.

- **V1 Orbit byte-identity (invariant 2):** capture WebGPU-only screenshots at a 12 Mm view pre/post change (e.g. `node Tools/visual-regression/probe-atmosphere-orbit.mjs` — it captures WebGL-vs-WebGPU diffs for full/sky-only/ground-only/all-off configs at lat 80, alt 12 Mm). The WebGPU captures must be pixel-identical pre/post (fragment path unchanged); the WebGL↔WebGPU diff percentages must not regress in any of the four configs.
- **V2 Ground-atmosphere liveness:** `PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-ground-atmosphere.mjs` — asserts (A) renders, (B) toggling `showGroundAtmosphere` changes pixels, (C) retired FR key empty, (D) zero console/validation errors. Must PASS.
- **V3 NEW probe — build it (Principle 8, probe-first): `probe-ground-atmosphere-stage.mjs`.** Template: `probe-saved-view.mjs` / `probe-atmosphere-orbit.mjs` (Playwright + canvas-decode diff, Edge). Matrix — for BOTH backends, WebGL-vs-WebGPU pixel diff plus WebGPU pre/post where relevant:
  1. ground ~3 km altitude, fog on (vertex ownership; fog branch);
  2. ~2 Mm altitude — above fog maxHeight (800 km), below fadeOut 10 Mm (vertex ownership; drape branch — the case whose WebGPU output CHANGES);
  3. ~12 Mm orbit (fragment ownership; must be pre/post identical);
  4. case 2 with `scene.highDynamicRange = true` (HDR gate);
  5. case 2 with `globe.terrainExaggeration = 2` (exaggeration);
  6. case 1 over ocean (water + fog interplay);
  7. `fog.enabled=false` + `showGroundAtmosphere=false` (all-off byte-identity);
  8. dynamic lighting on (`globe.dynamicAtmosphereLighting=true`, `globe.enableLighting=true`) at case 2 (darken/sunlit mix path).
  Pass rule: case 3 and 7 pixel-identical pre/post; cases 1/2/4/5/6/8 WebGL↔WebGPU mismatch ≤ the pre-change mismatch for the same view (the change moves WebGPU TOWARD WebGL) and no new structured artifact. **Read every PNG yourself** — specifically hunt for triangle-mesh banding in cases 1–2 (the T4 artifact signature) and terminator/limb changes in case 8.
- **V4 Debug visualizers:** on the live viewer (`?renderer=webgpu`), run `CesiumDebug.globeFragmentDebug("rayleigh-v")` then `("mie-v")` at BOTH a 3 km and a 12 Mm camera — non-black, structured output in all four combinations (proves the debug force). Then `globeFragmentDebug("atmo-color")` and `("draped")` still render.
- **V5 Mode sweep:** 2D and Columbus View load without console/validation errors and match pre-change captures (`node Tools/visual-regression/probe-2d-cv-modes.mjs`).
- **V6 GPU cost evidence (named stage):** `CesiumDebug.gpuPassCost(true)` on the viewer at case-1 and case-3 cameras, compare globe-pass GPU ms pre/post (expect a drop near ground, a small VS drop at orbit; the timestamp-query feature must be available — if not, record "GPU timestamps unavailable" honestly and rely on V3 parity only). Optionally the `--gpu-timestamps` lane of `run-performance-campaign.mjs` on the moving route.
- **V7 Regression sweep:** `node Tools/visual-regression/capture-and-diff.mjs` (baseline scenes), `probe-atmo-lut-off.mjs` (LUT fallback band unchanged: 2.4–6.4% documented), `probe-fog-ms.mjs` / `probe-atmosphere-toggle.mjs` if present in tree.
- **V8 Ledger + docs:** queue §3.2 row updated with artifacts + PNG paths; new probe registered in `DEBUGGING_GUIDE.md`; lockstep row updated (step 7 above); `WEBGPU_DEBUGGING_LOG.md` entry if any bug was found en route.

### 6. Rollback boundary

Revert the stage-ownership commit as a unit: the WGSL VS gate term, the FS if/else, the UB field + `CAMERA_UNIFORM_FLOATS` bump, the packer write. That restores VS-always-march + FS-always-recompute — the current (wasteful but correct) behavior. NEVER disable ground atmosphere, fog, the LUT path, or the debug visualizers to make a gate pass; never leave the flag in with a "temporarily 0" default as a pseudo-rollback (that would still have shipped the FS restructure — revert properly). The new probe and any spec SURVIVE rollback. If only the near-ground parity (V3 cases 1/2) fails while orbit identity holds, that is a numeric divergence in the WGSL vertex march vs GLSL — record it as the blocking finding (PARTIAL in the ledger) rather than shipping fragment-ownership-everywhere silently.

### 7. Pointers

- WGSL (canonical): `packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl` — varyings 663–665; VS block 1368–1399 (gate 1377, march 1395); fns `computeAtmosphereScatteringGround` 1150, `computeGroundAtmosphereColor` 1177; FS pair-header 3996; FS gate 4064–4065; LUT fog 4066–4099; FS march 4113–4146 (call 4136); fog branch 4148–4210; drape 4211–4358; debug windows 4326–4348; struct `CameraUniforms` 38–248 (atmosphereParams 117, tail 245–248).
- GLSL (reference, comment-sync only): `packages/engine/Source/Shaders/GlobeFS.glsl:630–755` (per-frag choose 681–697, fog 708–723, drape 724–753); `GlobeVS.glsl:306`.
- CPU: `GlobeSurfaceTileProviderRendering.js:1275–1280` (WebGL flag), `GlobeSurfaceShaderSet.js:186,345–347` (bit 15 / define); packer `WebGPUGlobeSurfaceCameraUB.ts:600–700`; sizes `WebGPUGlobeSurfaceTypes.ts:165`; tile-UB fade distances `WebGPUGlobeSurfaceTileUB.ts:528–529`; debug sentinel `WebGPUGlobeSurfaceTileUB.ts:610–622` + `WebGPUGlobeFragmentDebug.ts:116–125`.
- Docs to sync: `migration_doc/SHADER_PAIRS_LOCKSTEP.md:235–238` (row 236 is yours; row 260's `setDepthRangeType` drift is item 83's — leave it); `migration_doc/IMAGERY_PROJECTION.md` NOT affected (no projection-chain files touched).
- Probes: `probe-ground-atmosphere.mjs`, `probe-atmosphere-orbit.mjs`, `probe-atmo-lut-off.mjs`, `probe-2d-cv-modes.mjs`, `capture-and-diff.mjs`; new `probe-ground-atmosphere-stage.mjs` (you build it).
- Ledger: `QUEUE_2026-07-15_CAMPAIGN9.md` §6 item 31, §3.1 row "Duplicate vertex/fragment ground-atmosphere integration", §3.2. Plan: `FORK_PERFORMANCE_RTE_VISIBILITY_REMEDIATION_PLAN_2026-07-15.md` §2 finding 5, WS2 ("Make ground-atmosphere integration one-stage-per-variant").

---

### Stale anchors corrected while writing this guide (trust these, not the docs)

1. `GlobeTerrain.wgsl:3998` pair-header says the GLSL twin is at "GlobeFS.glsl ~lines 512–603" — the live GLSL ground-atmosphere block is at **630–755** (header comment 630–663, code 664–755). Fix the header while doing C9-14 step 7.
2. `GlobeFS.glsl:632` says the WGSL twin is at "~lines 2849–3170" — the live WGSL block is at **3996–4360**. Same fix.
3. `SHADER_PAIRS_LOCKSTEP.md:236` says the WGSL per-vertex varyings are "currently unused" — they ARE consumed by the `rayleigh-v`/`mie-v` debug visualizers (`GlobeTerrain.wgsl:4328,4332`); the row is rewritten by C9-14 anyway.
4. `SHADER_PAIRS_LOCKSTEP.md:260` still documents the removed `Matrix4.setDepthRangeType()` — pre-existing drift OWNED BY queue item 83, not by this cluster; do not fix it here.
5. The C9-13 "loop site" is NOT in a WebGPU scene renderer pass file — the per-tile entry is `GlobeSurfaceTileProviderRendering.js:791/900` and the per-tile-per-pass effects repack is inside `WebGPUGlobeSurfaceRenderer.ts:createTileCommands` (L896 pass loop, L1229 effects call). `WebGPUSceneRendererGlobePass.ts` executes already-built descriptors and needs no change.

---

<a id="g9"></a>

## G9-model-cert — C9-16-CLUSTERED-LIGHT-ZERO-WORK-CONTRACT + C9-17-MODEL-SETTLED-FRONTEND-REVISIONS

Execution guide for an Opus worker with no Campaign-9 memory. Both tasks are Wave-2 rows in
`migration_doc/QUEUE_2026-07-15_CAMPAIGN9.md` (items **32** and **33**, table at lines ~207-208; live
ledger row for C9-16 at line ~138). Every file/line anchor below was verified against the live tree at
HEAD `ea6332d0aa` (Batch 672) on 2026-07-16. The Sol tranche landed as **Batches 656-669**
(`0e35c68c76`..`421aff7685`); the model cohort is Batch 665 (`7bd87f5c02`), the clustered zero-work
core is Batch 661 (`374f193f8a`). Line numbers can drift a few lines if Campaign 9 lands more batches
first — **re-grep every anchor before editing** (symbol names are stable; use them).

Read these BEFORE writing code, in this order:

1. `migration_doc/QUEUE_2026-07-15_CAMPAIGN9.md` — §1 rules (esp. rule 1: never weaken a feature for
   a metric; rule 6: one concern per slice, roll back the optimization never the feature), §3.2
   ledger, Wave-2 rows 32/33.
2. `migration_doc/FORK_PERFORMANCE_WEEKLY_CHANGE_DEFENSE_2026-07-15.md` **§8.3** (lines ~290-296,
   clustered disabled path — states the exact remaining work) and **§8.6** (lines ~319-335, model
   caches — the authoritative 5-bullet remaining-work list and the "14 total bind-group creations per
   settled frame from other groups/owners" evidence sentence at line ~335).
3. `migration_doc/FORK_PERFORMANCE_RTE_VISIBILITY_REMEDIATION_PLAN_2026-07-15.md` §4 (architecture)
   and WS2 bullet at lines ~182-183 ("Add direct zero-work-disabled clustered-light coverage and
   complete settled Model frontend/group-1 revision caches").
4. `migration_doc/FORK_ARCHITECTURE_REMEDIATION_PLAN_2026-07-13.md` ledger rows at lines ~73 (FAR-204)
   and ~75 (FAR-309) — each row's fourth column is the deferred-work list these tasks close — and the
   FAR-309 acceptance text at line ~700-708.
5. `migration_doc/SOL_AUDIT_REPORT_2026-07-16.md` — ratings #21 (ModelPrimitiveGeometry ~900-line
   manual signature capture "needs the queued revision token") and #23 (group-2 cache, rating 5, the
   pattern to copy); P1 #9 (the ledger under-claim that created the C9-16 PARTIAL row).

Shared environment facts:

- Dev server: `node server.js --production` (port 8080). All probes are Node/Playwright on **Edge**
  (`channel: "msedge"`), never Firefox.
- Focused Karma spec runs require the engine workspace bundle to be rebuilt first (standing trap
  `NEW-WORKSPACE-SPEC-BUNDLE-FRESHNESS`, queue ledger line ~123): run
  `npm run build --workspace @cesium/engine` **before**
  `npx gulp test --workspace engine --browsers=EdgeHeadlessCI --includeName "<name>"`.
- Type/build gates: `npx tsc --noEmit` and `npx gulp build` must be clean before any probe run.
- The working tree is shared with a live campaign — commit or stash nothing you did not author;
  check `git status` before starting and keep your diff limited to the files named below.

---

### C9-16-CLUSTERED-LIGHT-ZERO-WORK-CONTRACT (Wave 2 item 32, R1/test)

Queue acceptance text: *"Direct unit and physical evidence proves disabled/no-light frames allocate,
upload, dispatch, and submit zero clustered-light work; enabled multi-frustum output remains exact."*

This is mostly a **certification task of already-landed, under-claimed work** (audit Appendix B /
P1 #9: the core landed in Batch 661 but was never ledgered; the queue now carries a PARTIAL/PAUSED
row). There is, however, one **real residual implementation gap** (enabled-but-zero-light frames,
below) — do not skip it, and do not claim COMPLETE without it.

#### Architecture today (post-Sol, verified)

Files (all verified live):

- `packages/engine/Source/Renderer/WebGPU/WebGPUSceneRendererClusteredLighting.ts` (407 lines) —
  the per-frame hook `dispatchClusteredLighting(host, config)`. Called once per frame from
  `WebGPUSceneRenderer.ts:1652` (`this._dispatchClusteredLighting(config)`, delegating at :2882-2887),
  early in `executeCommands`, before any consumer draw.
- `packages/engine/Source/Renderer/WebGPU/WebGPUClusteredLightingDispatcher.ts` (625 lines) — owns
  params UBO (256 B, label `"ClusteredLighting params"`, `COPY_SRC` deliberately kept for probe
  readback, :204-213), the LTC area-light buffer (label `"LTC area lights"`, :191), and the two
  compute renderers. `dispatch()` at :336-395: packs lights, **always writes the params UBO**
  (:365), then returns 0 before any compute pass when `activeCount === 0` (:367-370).
- `packages/engine/Source/Renderer/WebGPU/WebGPUClusterBoundsRenderer.ts` — compute pass label
  `"ClusterBounds compute pass"` (:271); re-dispatches only on viewport/near/far/projection change.
- `packages/engine/Source/Renderer/WebGPU/WebGPUClusterAssignRenderer.ts` — compute pass label
  `"ClusterAssign compute pass"` (:381); checksum dirty-tracking at :341-347 skips re-dispatch when
  lights and bounds are unchanged; uploads `"ClusterAssign lights"` + `"ClusterAssign UB"` only on
  dirty (:351-359).

The Batch-661 zero-work core in `dispatchClusteredLighting`:

- Module-level `const _disabledClusteredLightingHosts = new WeakSet<ClusteredLightingHost>()`
  (:87) tracks the one zero-sync already sent per host.
- Disabled path (:118-166): clears `ctxStash._clusteredLightingBuffers`/`_clusteredLightingActive`,
  then — if no dispatcher exists OR already synchronized — marks the WeakSet and returns **before any
  allocation, pass churn, or queue traffic**. If a dispatcher exists and is not yet synchronized, it
  performs exactly ONE `dispatch(encoder, {enabled:false, lights:[], ...})` (the transition-frame
  zero-count params write, so commands built earlier in the transition frame cannot observe stale
  lights), then marks the WeakSet. If encoder/uniformState are missing (:143-145) it returns WITHOUT
  marking, deliberately retrying next frame — preserve that.
- Enabled path (:168+): deletes the host from the WeakSet, lazily constructs the dispatcher, ends the
  active canvas render pass (`context.endCurrentRenderPass?.()` :189), walks `scene.lights` into
  fresh `lights[]` / `areaLights[]` arrays (:198-220, per-frame allocations), dispatches, stashes a
  fresh `ClusteredLightingBuffers` object literal on the context (:356-365), sets
  `_clusteredLightingActive = enabled && d.lastActiveLightCount > 0` (:374), resumes the pass (:379).

Existing evidence/gates (these ARE the "spec'd" claim in the ledger row — they are Playwright
probes, not Karma specs; no Karma spec for this module exists anywhere in `packages/engine/Specs`):

- `Tools/visual-regression/probe-clustered-per-frame.mjs` — asserts: dispatcher NOT constructed
  during an initial 30-frame disabled phase; lazily constructed on first enabled frame;
  `lastActiveLightCount === 2` enabled; exactly **1** dispatcher call across the enabled→disabled
  transition plus 9 stable disabled frames; compute actually ran (per-cluster readback); 0 device
  errors.
- `Tools/visual-regression/probe-clustered-dispatcher.mjs` — dispatcher-level end-to-end incl.
  dirty-tracking skip on identical inputs.
- `Tools/visual-regression/probe-clustered-multifrustum.mjs` — proves single-grid binning is
  self-consistent and conservatively correct at `scene.numberOfFrustums >= 2` (this is the "enabled
  multi-frustum output remains exact" half; per-frustum grids are explicitly NOT required — that is
  the separate evidence-gated `P2-3 NEW-CLUSTER-MULTIFRUSTUM-BOUNDS`, queue line ~331).

What is MISSING (the acceptance gap, per weekly-defense §8.3 line ~296: "direct unit coverage for the
zero-work disabled path and a promoted exact-current physical gate are still missing"):

1. **Direct unit (Karma) coverage** of the disabled/transition state machine.
2. **The physical API-counter gate** on the moving-altitude route (zero clustered-attributed API calls
   at defaults, positive control when enabled).
3. **Enabled-but-zero-light frames are NOT yet zero-work** — verified in live code: with
   `clusteredLightingEnabled = true` and no lights, every frame still (a) allocates the `lights` and
   `areaLights` arrays, (b) ends+resumes the canvas render pass (:189/:379), (c) calls
   `dispatcher.dispatch` which writes 32 B to the params UBO unconditionally (:365 in the
   dispatcher), and (d) allocates the buffers-stash object literal. The acceptance row says
   "disabled/**no-light** frames" — this must become zero-work too.

#### Target design + invariants

1. **Disabled stable frames**: zero allocation, zero pass churn, zero queue traffic (already true —
   keep it, and now prove it in a unit spec).
2. **Enabled→disabled transition**: exactly one zero-count params write; subsequent disabled frames
   are no-ops; if frame state is unavailable the sync retries next frame (already true — prove it).
3. **Enabled, zero effective lights** (no punctual `scene.lights` survivors AND no area lights):
   after one zero-state synchronization, subsequent settled frames perform no array allocation, no
   render-pass end/resume, no params write, no compute pass, no light-buffer upload. The FS gates
   (`params.activeLightCount.x` punctual, `.y` area — `_paramsData[4]`/`[5]`) both read 0.
4. **Zero-light frames still publish stable dispatcher buffer handles** once a dispatcher exists:
   `ctxStash._clusteredLightingBuffers` keeps pointing at the SAME `GPUBuffer` objects (they are
   identity-stable for the dispatcher's lifetime — getters at dispatcher :226-247). Consumers' effects
   bind-group cache keys on resource identity; flip-flopping real↔placeholder across frames would
   churn that cache (see Traps #2).
5. **Enabled with lights**: behavior byte-identical to today — light gathering, pass split, both
   compute passes (subject to existing checksum dirty-tracking), consumer bindings, and
   `_clusteredLightingActive` semantics unchanged.
6. **Transition N-lights→0-lights (still enabled)**: exactly one params write publishing
   `activeLightCount = 0` (and `areaCount = 0`), analogous to the disabled transition.
7. **Multi-context safe**: per-host state stays keyed on the host object (the existing WeakSet
   pattern) or lives on the dispatcher instance — never a module-level boolean.
8. Params UBO keeps `COPY_SRC` usage (probe readback depends on it).

#### Implementation walkthrough

**Step 0 — re-verify the premise.** `git log --oneline -3 -- packages/engine/Source/Renderer/WebGPU/WebGPUSceneRendererClusteredLighting.ts`
should show `374f193f8a` (Batch 661) as the latest zero-work change. If a later Campaign-9 batch has
already touched this file, STOP, read that diff, and reconcile with the ledger row before proceeding —
another worker may have started item 32.

**Step 1 — close the enabled/zero-light gap** (one bounded edit, ~40 lines, in
`WebGPUSceneRendererClusteredLighting.ts` + ~10 in the dispatcher):

- In the dispatcher, add a private `_lastWrittenParamsZero: boolean` (or track last-written
  `activeCount`/`areaCount` pair, initialized to match the constructor's initial zero write at
  :214-217). In `dispatch()`, when `activeCount === 0 && areaCount === 0` AND the last write was
  also all-zero, skip the `writeBuffer` at :365 and return 0. Any nonzero→zero or zero→nonzero
  change writes. (Viewport/near/far staleness inside params is safe: the FS only reads
  `clusterIndexFor` inputs when `activeLightCount > 0` — the always-bind-something contract in the
  module docstring at dispatcher :33-50.)
- In the hook, before ending the render pass: compute whether there is any candidate light cheaply.
  You must still walk `scene.lights` (disabled entries are filtered at :247), but hoist the two
  arrays to module-level scratch (`const scratchLights = []` / `scratchAreaLights = []`, reset with
  `.length = 0` per frame) so the walk is allocation-free. If after the walk both are empty AND the
  dispatcher's last-written state is already zero: publish the stable buffers stash (cache the
  object literal on the host or dispatcher so it isn't re-allocated — invariant 4), set
  `_clusteredLightingActive = false`, and return WITHOUT `endCurrentRenderPass`/`resumeDefaultRenderPass`
  and without calling `dispatch`. If the zero state is not yet synchronized, do one dispatch (which
  writes the zero params) — reuse the existing pass-split path for that single frame.
- Decision point: the scratch-array conversion changes the enabled-with-lights path too (it must —
  the per-frame `lights[]`/`areaLights[]` allocations are also settled-frame garbage). If you are not
  confident about lifetime (the dispatcher's `_packEyeSpaceLights` copies data out into
  `_scratchEyeLights` synchronously during `dispatch`, and `_packAreaLights` copies into
  `_areaLightsData` — verified, no retention of the input arrays), keep the scratch conversion; if
  you find any code path retaining the input array beyond `dispatch()` returning, STOP and mark that
  sub-slice blocked, land only the zero-light gating with fresh arrays on transition frames.
- Note the dispatcher's enabled path also does `this._scratchEyeLights.slice(0, activeCount)` (:389)
  — a per-enabled-frame allocation. Optional cleanup (pass the count instead); NOT required for this
  row (only no-light frames must be zero-work). If you touch it, `WebGPUClusterAssignRenderer.dispatch`
  signature takes `(encoder, clusterAABBs, lights, boundsChanged)` — you would add a `count`
  parameter; keep the change minimal or skip it.

**Step 2 — direct unit spec** (new file
`packages/engine/Specs/Renderer/WebGPU/WebGPUSceneRendererClusteredLightingSpec.js`):

`dispatchClusteredLighting` and `getClusteredLightingBuffers` are named exports — import them
directly. Follow the mock-device pattern of
`packages/engine/Specs/Renderer/WebGPU/WebGPUModelInstanceBindGroupCacheSpec.js` (:1-47): plain
objects with recording `createBuffer`/`createBindGroup`/`createCommandEncoder`, a recording
`queue.writeBuffer`, and a recording encoder whose `beginComputePass` returns a stub pass. The
`config` argument needs `{ scene, context }` where `context` carries `_device`,
`_currentCommandEncoder`, `uniformState: { inverseProjection, view }`, `endCurrentRenderPass`,
`resumeDefaultRenderPass` (record calls). One wrinkle: the hook constructs a REAL
`WebGPUClusteredLightingDispatcher` on first enabled call, whose constructor creates real buffers on
your mock device and constructs `WebGPUClusterBoundsRenderer`/`WebGPUClusterAssignRenderer` (which
create shader modules/pipelines via a per-device pipeline-cache). If the mock-device surface needed
by those constructors is too deep (check `WebGPUClusterBoundsRenderer.ts` :100-190 — it needs
`createShaderModule`, `createBindGroupLayout`, `createPipelineLayout`, `createComputePipeline`,
`createBuffer`, `createBindGroup`), you have two sanctioned options:
  - stub them all (they are label+descriptor recorders; nothing is executed at construction), or
  - inject a pre-built fake dispatcher on the host (`host._clusteredLightingDispatcher = fake`)
    for the disabled/transition cases and reserve real-construction for one lazy-construction case.

Required cases (mirror the probe semantics exactly):

1. Disabled + no dispatcher → returns before ANY device call; `_clusteredLightingBuffers` undefined,
   `_clusteredLightingActive` false; repeated calls make zero device calls.
2. Disabled + existing (fake) dispatcher → exactly one `dispatch` with `enabled:false, lights:[]`;
   the next disabled call makes zero calls.
3. Disabled transition with missing encoder → no sync recorded; next call WITH encoder syncs once.
4. Enabled + zero lights → after one zero-sync, subsequent calls: zero writeBuffer, zero
   endCurrentRenderPass/resume, zero array allocation observable via the recording device; buffers
   stash keeps object identity across frames (invariant 4).
5. Enabled + one light → pass end/resume called, dispatch called with packed light; toggling the
   light's `enabled=false` (walk filter) behaves as case 4 after one sync.
6. Re-enable after disable → WeakSet cleared, dispatch resumes.

**Step 3 — the physical API-counter gate** (the "promoted exact-current physical gate"):

The instrumentation already exists: `Tools/visual-regression/run-performance-campaign.mjs`
`--api-instrumentation` patches `createBindGroup`/`createBuffer`/`writeBuffer`/`beginComputePass`/
`dispatchWorkgroups`/`submit` etc. with **per-label buckets** (`incrementLabel`, :889-905; compute
passes at :1155-1167). All clustered resources are labeled with stable prefixes: `ClusteredLighting
params`, `LTC area lights`, `ClusterBounds *`, `ClusterAssign *` (verified above). Two options —
prefer (a):

(a) Write a small gate script `Tools/visual-regression/probe-clustered-zero-work-route.mjs` (or a
`--assert` post-processing step) that runs:

```powershell
node Tools/visual-regression/run-performance-campaign.mjs `
  --workload moving-camera-altitude-track-3d `
  --renderer webgpu --repetitions 1 --api-instrumentation `
  --output Tools/visual-regression/output/performance/campaign9-c9-16-clustered-zero-work-api-r1-2026-07-XX.json
```

then loads the JSON and asserts: every `apiCounterLabels` bucket key matching
`/^(ClusterBounds|ClusterAssign|ClusteredLighting|LTC area)/` is **absent** across
`webgpuBuffersCreated`, `webgpuBindGroupsCreated`, `webgpuComputePassesBegun`, `webgpuWriteBufferCalls`
(check the exact counter names in the JSON — the writeBuffer counter is patched at :1272 of the
runner; buffer-create labels at :1002). Clustered lighting is default-OFF (`Scene.js:1154`
`this._clusteredLightingEnabled = false`), so the default route must show zero.

(b) Positive control (MANDATORY — a label rename would otherwise silently green the gate forever):
in the same gate script, after the route run (or as a second cheap phase reusing
`probe-clustered-per-frame.mjs`), enable clustered lighting with one light for a few frames under the
same patching approach and assert the labels DO appear. If you integrate with the campaign runner
instead of a standalone probe, do not modify the runner's clean-lane behavior — API patching stays
opt-in.

**Step 4 — regression re-runs + ledger.** Re-run `probe-clustered-per-frame.mjs`,
`probe-clustered-dispatcher.mjs`, `probe-clustered-multifrustum.mjs`, `probe-clustered-litmat.mjs`,
`probe-clustered-visible.mjs` (server running, WebGPU/Edge). All must PASS with your diff applied.
Then update `migration_doc/QUEUE_2026-07-15_CAMPAIGN9.md` §3.2: flip the
`C9-16-CLUSTERED-LIGHT-ZERO-WORK-CONTRACT` row from PARTIAL/PAUSED to COMPLETE with dated evidence
(spec counts, gate artifact filename, probe results); update
`migration_doc/FORK_ARCHITECTURE_REMEDIATION_PLAN_2026-07-13.md` only if its ledger references
clustered coverage (it does not directly — leave it); add a `WEBGPU_DEBUGGING_LOG.md` entry per
charter.

#### Traps for the unwary (C9-16)

1. **"No-light" includes area lights.** `data[4]` is the punctual gate, `data[5]` the LTC area gate
   (C6-LTC-AREA-LIGHTS). A scene with ONLY a `RectAreaLight`/`DiskAreaLight` has `activeCount === 0`
   but `areaCount > 0` — it needs the params write AND the area-light buffer upload AND the LUT
   ensure, and the dispatcher's early return at :367 already fires (no compute needed for area
   lights — they are iterated directly in the FS). Gate zero-work on BOTH counts being zero.
2. **Do not un-publish the buffers stash on enabled/zero-light frames.** If
   `_clusteredLightingBuffers` alternates between real buffers and `undefined`, model/primitive
   effects bind groups re-key (the effects cache keys on resource identity) and you create the very
   bind-group churn C9-17 is removing. Once a dispatcher exists, the stash should be identity-stable.
3. **Every early return on the enabled path after `endCurrentRenderPass` MUST resume the pass.** The
   comment at :310-316 records the historical dropped-frame bug. Best structure: decide zero-work
   BEFORE ending the pass, so new early-returns never sit between end and resume.
4. **Do not replace the WeakSet with a boolean.** Multiple `GraphicsContext`s / SceneRenderers can be
   live (multi-context charter rule); the WeakSet keys per host. Dispatcher-instance fields are
   equally safe.
5. **Do not remove `COPY_SRC` from the params buffer** ("cost is zero" comment at :207-209) — probes
   read it back.
6. **Preserve probe gate semantics exactly**: `probe-clustered-per-frame.mjs` asserts
   `dispatcherFoundEvenWhenOff === false`, transition dispatch count exactly 1, `lastActiveOffAgain
   === 0`. Your zero-light gating must not add or remove dispatcher calls on those phases. Note the
   probe reads `v.scene._alternateSceneRenderer._clusteredLightingDispatcher` — if that private path
   errors, the probe is what needs fixing, not the engine.
7. **The checksum in `WebGPUClusterAssignRenderer` is not a full hash** (position+type only, :330-335)
   — do not "improve" it in this slice; it is deliberate dirty-tracking and out of scope.
8. **Karma cannot create real WebGPU devices in CI** — the unit spec must be mock-device based (the
   Batch-665 spec pattern), not `navigator.gpu` based.
9. **Enabled+lights frames may legitimately skip compute** (checksum hit) while still writing params
   — that is existing behavior; your gate script must not assert "params writes == compute passes".

#### Verification recipe (C9-16)

Pass criteria, in order:

1. `npx tsc --noEmit` → 0 errors; `npx gulp build` → clean.
2. `npm run build --workspace @cesium/engine` then
   `npx gulp test --workspace engine --browsers=EdgeHeadlessCI --includeName "WebGPUSceneRendererClusteredLighting"`
   → all new cases green (expect ≥6 specs). Exit 0; a trailing "Chrome failed" line is a known
   wrapper artifact, not a failure (see C9 ledger row for item 68).
3. `node server.js --production` in one terminal; then
   `node Tools/visual-regression/probe-clustered-per-frame.mjs` → prints the PASS line;
   `probe-clustered-dispatcher.mjs`, `probe-clustered-multifrustum.mjs`, `probe-clustered-litmat.mjs`
   → PASS/exit 0 each.
4. API-counter gate: default moving route JSON contains NO clustered-prefixed label under any
   creation/upload/pass counter; positive-control phase DOES contain them. Archive the JSON under
   `Tools/visual-regression/output/performance/` with a `campaign9-c9-16-*` name and cite it in the
   ledger row.
5. Visual byte-identity at defaults is implied (feature default-off + no shader change), but if you
   touched the enabled path (scratch arrays), re-run `probe-clustered-matsweep.mjs` and
   `probe-clustered-phong.mjs` as enabled-path visual gates.

#### Rollback boundary (C9-16)

Revert-safe unit = the zero-work gating edits in `WebGPUSceneRendererClusteredLighting.ts` +
`WebGPUClusteredLightingDispatcher.ts` (the optimization). The clustered-lighting FEATURE (dispatcher,
compute renderers, consumer bindings, LTC area lights) must never be disabled, stubbed, or
default-changed to pass the gate. The new spec file and the API-counter gate script remain landed even
if the optimization reverts (tests and counters remain — queue rule 6). If the physical gate fails
after the unit spec passes, suspect trap #2 (stash identity) first, then trap #1 (area-light gate).

---

### C9-17-MODEL-SETTLED-FRONTEND-REVISIONS / FAR-309 (Wave 2 item 33, R2)

Queue acceptance text: *"Complete positive-path revisions, group-1 material/texture/IBL caching,
allocation-free implicit feature lookup, and settled draw-command/frontend reuse; mutation changes
only exact affected resources."*

The authoritative gap list is weekly-defense §8.6 (lines ~327-335) — five bullets plus the evidence
sentence: *"The same model probe still observed **14 total bind-group creations per settled frame**
from other groups/owners."* That probe is
`Tools/visual-regression/probe-model-instance-bg-cache.mjs` (its `settledAllBindGroupCreates`
counter, :44-52 and :147 — it counts ALL `device.createBindGroup` calls over 40 settled frames but
only GATES on the group-2 label). Bullet 5 (duplicate/eager Model pick IDs) is explicitly owned by
Wave-4 items 50/56 (`NEW-PICK-ID-OWNERSHIP-MODEL`, `NEW-PICK-CONTIGUOUS-ID-RANGES-NATIVE`) — do NOT
pull it into this task.

#### Architecture today (post-Sol, verified)

All in `packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.ts` (6548 lines; entry
`updateWebGPUModel` at :3707; exports at :6543 already include `getOrCreateMergedInstanceBindGroup`
for spec use) unless noted:

**What is already cached (do not rebuild):**

- **Group 0 (camera)**: `cache.cameraBG` created once (:3965, guarded by `!defined(cache.cameraBuffer)`
  at :3958); per-node `nc.cameraBG` created once per non-identity node (:4496); 2D-IDL variant once
  (:4540). Contents update via per-frame `writeBuffer` — correct, leave alone.
- **Group 2 (skin/morph/instance)**: `getOrCreateMergedInstanceBindGroup` (:3224-…) — the Sol
  Batch-665 exact-7-buffer-identity cache, audit rating 5. Spec:
  `packages/engine/Specs/Renderer/WebGPU/WebGPUModelInstanceBindGroupCacheSpec.js` (6 cases). Probe:
  `probe-model-instance-bg-cache.mjs` (gates `settledMergedInstanceBindGroupCreates === 0` +
  identity stability). **This is the pattern to replicate for group 1.**
- **Group 3 (effects)**: `createEffectsBindGroup(device, frameState, {owner: model, ...})` (:4215)
  — owner-keyed effects cache (C-R11), identity-keyed on shadow/CSM/clipping/clustered buffers.
- **Geometry descriptor**: `extractPrimitiveGeometry(rp)` (:4618) →
  `packages/engine/Source/Scene/Model/ModelPrimitiveGeometry.js` — WeakMap-memoized immutable base
  (`primitiveGeometryCache` :32) + mutable renderer view (`createPrimitiveGeometryView` :676 /
  `resetPrimitiveGeometryView` :689). Hit-validation is the **manual signature walk**:
  `captureAttributeSignature` :94, `attributeSignatureMatches` :130, `captureGeometrySignature` :174,
  `geometrySignatureMatches` :221 — O(attributes+morphs) per hit per primitive per frame. This is the
  "~900 lines of manual signature capture that needs the queued revision token" (audit #21).
  `getGeometryRevision` (:43) already probes `_webgpuGeometryRevision ?? _geometryRevision ?? …` —
  **nothing in the engine assigns any of those fields today** (verified: only consumers exist, here
  and in `WebGPUModelMetadataCache.js:48`). That is Principle-7 scaffolding for THIS task.
  Diagnostics: `getPrimitiveGeometryCacheDiagnostics` :707 (hit/miss/invalidation/build/conversion
  counters), `resetPrimitiveGeometryCacheForSpecs` :711. Spec:
  `packages/engine/Specs/Scene/Model/ModelPrimitiveGeometrySpec.js` (3 cases, Batch 665).
- **Metadata**: `WebGPUModelMetadataCache.js` (917 lines, Batch 665; JS not TS — conversion is
  Wave-5 item 88, NOT this task) — descriptor + negative cache; same revision-probe scaffolding.
- **Feature-ID resources**: `WebGPUModelFeatureId.js` `ensureFeatureIdResources` (:391) has an
  early-exit cache hit at :412-434 returning cached `primCache._featureIdEntries` (stable array
  identity), re-uploading the batch texture only when `batchTexture._batchValuesDirty` (:421-428 —
  this is the setShow/setColor mutation path, content-only, no bind-group rebuild).
  `getSelectedImplicitFeatureId` (:114-136) is the Sol allocation-free implicit lookup (returns the
  `FeatureIdImplicitRange` instance itself or null — no wrapper object); its renderer consumer at
  `WebGPUModelRenderer.ts:4649-4688` change-gates synthesis on
  `(source, offset, repeat, vertexCount)` so `synthesizeImplicitFeatureIdData` (allocates a
  `Float32Array(vertexCount)`) runs only on change. **No direct spec exists for any of this** — that
  is the named spec gap (§8.6 bullet 4).
- **Texture entries (group-1 bindings 2-25 + property/custom slots)**: `primCache.textureEntries`
  array is rebuilt ONLY on real change — deferred-placeholder upgrade or refraction-view change
  (:4854-4899) — so its ARRAY IDENTITY is already a valid revision token.

**What is NOT cached — the 14 settled creates + frontend garbage (the actual work):**

- **Group 1 (merged material)**: `buildMergedMaterialBindGroup` (:3049-3070) does a raw
  `device.createBindGroup` (:3060, **unlabeled** — see Step 1) every frame per primitive at THREE
  emission sites: primary :5277 (reused for pick :5524, velocity :5754, edge :5693), silhouette
  :5907, translucent dual-command :6057.
- **IBL entries**: `buildModelIBLEntries(model, pipelineCache, frameState)` (:3132-3212) allocates a
  fresh 6-entry array EVERY frame (:5276) even when the resolved views are unchanged;
  `defaultIBLEntries` (:3080) + `brdfLutEntries` (:3103) likewise on the fallback path (inside
  :3067). The underlying identities: `diffuseView`, `specularView`, `sampler`, `shBuffer` (explicit
  IBL vs `model.environmentMapManager._webgpuIBL*` precedence logic :3162-3192), `brdfLutView`
  (placeholder→real flip once, :3107-3119).
- **Draw commands / frontend**: `new WebGPUDrawCommand(webgpuCmdArgs)` per primitive per frame
  (:5388), plus velocity (:5750), silhouette (~:5918), translucent (~:6068); plus per-frame
  `webgpuCmdArgs` object, `bindGroups` array (:5363), `vertexBuffers` array (:5151-5186),
  `drawPasses` array (:5239).
- **Per-frame UBO writes** (uploads, not creates): material UBO `writeBuffer` :5095 (after
  `packMaterialUniforms` :5022), light UBO :5105 (after `packLightUniforms` :5104), camera UBO per
  model/node. These are content-driven (sun direction, camera RTE fields change per frame) — see
  decision point in Step 5.

#### Target design + invariants

1. **Group-1 bind group is cached per (primCache, variant-class)** keyed on exact identities:
   `device`, `materialBGL` (from `pipelineCache.getOrCreateMaterialBGL(materialDefines|0)` — the
   layout object itself is per-variant-cached), `materialBuffer` (NOTE: silhouette uses
   `materialBufferSilhouette`, translucent uses `materialBufferTranslucent` — three distinct cache
   slots or key on the buffer), `lightBuffer`, `textureEntries` ARRAY IDENTITY,
   `featureIdEntries` ARRAY IDENTITY (or null → the pipeline-cache default entries), and the FIVE
   resolved IBL identities (diffuseView, specularView, sampler, shBuffer-or-default, brdfLutView).
   Cache hit ⇒ zero `createBindGroup`. Any identity change ⇒ exactly one rebuild.
2. **IBL entry resolution is memoized**: `buildModelIBLEntries` resolution happens per model per
   frame (cheap reads), but the returned entries ARRAY identity is stable while the five resolved
   identities are unchanged (memoize on the model cache). This makes invariant-1's key a simple
   identity tuple.
3. **Positive-path geometry validation is O(1)**: loader-owned monotonic revision tokens
   (`_webgpuGeometryRevision`) stamped at every mutation site make `geometrySignatureMatches`
   short-circuit; the full signature walk remains as (a) the fallback when tokens are absent and
   (b) a pragma-stripped debug cross-check (revision-hit MUST imply signature-match).
4. **Implicit feature-ID lookup is certified allocation-free** by direct unit spec (no product code
   change expected).
5. **Settled draw-command/frontend reuse**: on a settled frame the emission loop pushes RETAINED
   command objects (and retained `bindGroups`/`vertexBuffers` arrays) instead of constructing new
   ones; per-frame-varying fields (modelMatrix, boundingVolume) update in place. This is the riskiest
   slice — staged LAST with an explicit STOP condition (Step 6).
6. **Mutation exactness**: `Cesium3DTileFeature.setShow/setColor` → one `writeTexture` (existing
   dirty path), NO bind-group rebuild, NO pipeline change; `model.color`/colorBlend → material UBO
   bytes only; animation (joints/morph/instancing) → buffer content writes only (group-2 cache
   already proves identity stability); IBL/env-map source swap → exactly the group-1 rebuild;
   texture placeholder→real upgrade → exactly the textureEntries rebuild + group-1 rebuild.
7. WebGL behavior, pick results, silhouette/translucent/classifier/edge paths, 2D/CV/IDL duplicate,
   capture records, and TAA velocity output are byte-identical throughout.

#### Implementation walkthrough

Land as 3-4 SEPARATE slices (queue rule 6: one concern per slice), each buildable + gated:

**Slice A — group-1/IBL caching (the headline; kills most of the 14 creates/frame).**

1. Add `label: "Model merged material bind group"` to the descriptor in
   `buildMergedMaterialBindGroup` (:3060). This is load-bearing: it lets
   `probe-model-instance-bg-cache.mjs` and the API-counter lane attribute group-1 creates by label.
2. Memoize IBL entries on the model cache (`cache._iblEntriesMemo = { key: [d,s,smp,sh,brdf], entries }`),
   compare the five resolved identities each frame in `buildModelIBLEntries`'s caller (or convert
   `buildModelIBLEntries` to take the cache and return the memoized array). Do the same for the
   default path (`defaultIBLEntries` — memo per pipelineCache+brdfLutView; note
   `pipelineCache.defaultFeatureIdEntries()` at :3066 — check whether it allocates per call
   (`WebGPUModelPipelineCache.ts` `_defaultFeatureIdEntries` :1813) and memoize similarly if so).
3. Convert `buildMergedMaterialBindGroup` to `getOrCreateMergedMaterialBindGroup(primCache, slot, …)`
   mirroring `getOrCreateMergedInstanceBindGroup` (:3224): store per-primCache records
   `_mergedMaterialBindGroupCache`, `_mergedMaterialBindGroupCacheSilhouette`,
   `_mergedMaterialBindGroupCacheTranslucent` (or one record keyed on materialBuffer identity).
   Compare: device, layout, materialBuffer, lightBuffer, textureEntries ref, featureIdEntries ref,
   iblEntries ref (post-memoization one ref suffices — but ALSO include refractionView only if you
   did NOT key textureEntries by identity; you did, so no). On mismatch: create, stamp, return.
4. Wire the three call sites (:5277, :5907, :6057). The `featureIdEntries` local at :5062-5093 is
   either `primCache._featureIdEntries` (stable identity) or null — safe key input.
5. New spec `WebGPUModelMaterialBindGroupCacheSpec.js` copying the instance-cache spec pattern:
   stable-identity reuse; each key component change (device/layout/either buffer/any entries array/
   each IBL identity) forces exactly one rebuild; null-vs-default featureId entries distinct.
6. Extend `probe-model-instance-bg-cache.mjs`: count creates by the new label; gate
   `settledMergedMaterialBindGroupCreates === 0` over the 40 settled frames, and tighten the overall
   settled gate — after this slice `settledAllBindGroupCreates` should drop from ~14/frame to ~0
   (whatever nonzero remainder you observe must be attributed by label and either cached here or
   explicitly listed in the ledger row as owned elsewhere — e.g. pick-pass-owned creates belong to
   items 50/56). Record before/after numbers in the batch notes.

**Slice B — loader-owned revision tokens (FAR-204 positive-path O(1)).**

1. Mutation sites to stamp (verified): `packages/engine/Source/Scene/GltfLoader.js` —
   `attribute.typedArray = …` at :1178, :1199, :1251; `indices.typedArray = …` at :1639; the
   `loadTypedArrayForWebGPU` retention blocks (:1432, :1535, :1596). Also grep
   `packages/engine/Source/Scene/Model/PntsLoader.js` and `PrimitiveOutlineGenerator.js` for
   attribute/typedArray assignment (both were touched by Batch 665) and stamp there too. Stamp
   helper: `attr._webgpuGeometryRevision = (attr._webgpuGeometryRevision ?? 0) + 1;` — put ONE
   shared helper in `ModelPrimitiveGeometry.js` (export `bumpGeometryRevision(value)`) so the field
   name can never drift.
2. In `geometrySignatureMatches` (:221), add the fast path FIRST: if the cached signature captured a
   defined top-level revision tuple and all captured object identities + revisions match
   (`runtimePrimitive`, `source`, `gltfPrimitive`, their revisions), return true without the
   attribute walk **only when every attribute signature also captured a defined revision**. Where
   revisions are `undefined` (any non-instrumented producer), fall through to the existing walk —
   never assume.
3. Debug cross-check (pragma rules from CLAUDE.md): inside `//>>includeStart('debug', pragmas.debug)`
   run the full walk when the fast path hits and `console.error` on divergence (this catches a missed
   mutation site in dev without production cost).
4. Extend `ModelPrimitiveGeometrySpec.js`: revision bump invalidates exactly once; undefined
   revisions still validate via the walk; fast path taken (assert via diagnostics counters — add a
   `fastHitCount` to `primitiveGeometryCacheDiagnostics` if needed).
5. Decision point: if you cannot enumerate mutation sites with confidence (e.g. you find Draco decode
   or morph post-processing assigning typedArrays outside GltfLoader — grep `typedArray =` across
   `Source/Scene`), DO NOT ship the fast path for those shapes; scope the token to the shapes you
   instrumented and leave the rest on the walk, and say so in the ledger row (honest-partial beats a
   stale-geometry bug). The walk is correct today — this slice is pure CPU-cost reduction.

**Slice C — implicit feature-ID lookup certification (spec-only, no product change expected).**

New spec (e.g. `packages/engine/Specs/Renderer/WebGPU/WebGPUModelFeatureIdSpec.js`) driving the pure
exports of `WebGPUModelFeatureId.js` (`getSelectedImplicitFeatureId`,
`synthesizeImplicitFeatureIdData` are named exports :800-806) with mock model/runtimeNode/primitive
shapes (`ModelComponents.FeatureIdImplicitRange` / `FeatureIdAttribute` / `FeatureIdTexture`
instances — import `ModelComponents` and construct real instances so the `instanceof` classification
at :87-99 is exercised):

- implicit selection returns the EXACT same `FeatureIdImplicitRange` instance (`toBe`) — no wrapper;
- instance-feature precedence returns null (the per-instance transport rule, :116-123);
- texture/attribute selections return null;
- `synthesizeImplicitFeatureIdData` honors `offset`/`repeat` per EXT_mesh_features
  (`id = offset + floor(v/repeat)`) and returns null when nothing implicit is selected;
- (renderer-side gating) if practical, unit-test the change-gate shape at
  `WebGPUModelRenderer.ts:4659-4680` indirectly: same (source, offset, repeat, vertexCount) ⇒ the
  memoized `geometryRecord.implicitFeatureIdData` identity is reused. If not practical without the
  full renderer, assert it in the probe instead and note that in the ledger row.

**Slice D — settled draw-command/frontend reuse (riskiest; stage last; optional-STOP).**

Before writing code, answer two questions from the live tree:

- Does anything mutate a pushed `WebGPUDrawCommand` after emission? Grep the executor
  (`WebGPUSceneRenderer*.ts`, `WebGPUDrawCommand` class file) for post-construction writes to command
  fields (derived pick/velocity attachment at :5771 `webgpuCmd.velocityCommand = velocityCmd` happens
  at build time — fine if the retained pair is rebuilt together). If the executor stamps per-frame
  state on commands (sort keys, derived caches) verify overwriting is idempotent across reuse.
- `captureRecords.push({... nodeModelMatrix: Matrix4.clone(nodeModelMatrix)})` (:5408-5445) — the
  env-capture path deliberately CLONES because capture replays NEXT frame. Retained commands must
  keep this clone semantics; a retained `modelMatrix` reference that you update in place is only safe
  if the command consumer reads it same-frame (verify against `WebGPUDrawCommand`'s modelMatrix use).

If either answer is "unclear after an hour of reading", STOP this slice, mark it in the ledger row as
the explicit remaining PARTIAL ("settled draw-command reuse deferred — executor mutation semantics
unresolved"), and land A-C. The row's acceptance can then honestly read PARTIAL with A-C evidence —
that matches how Sol-era rows were kept truthful.

If safe: retain per `primCache` a `_settledCommandRecord` per variant (primary/velocity/silhouette/
translucent) holding the command + its `bindGroups` array + `vertexBuffers` array + args object.
Rebuild when any of: pipeline identity, any bind-group identity (from slices A + group-2 cache +
effectsBG + nodeCameraBG), any vertex/index buffer identity, pass, renderState identity,
instanceCount, indexCount changes. Per-frame: update `modelMatrix`/`boundingVolume` fields in place
and push the retained object. Gate with the extended probe (zero `new WebGPUDrawCommand` per settled
frame — count via a debug-pragma'd counter or by spying in the probe on a diagnostics hook) plus the
full visual regression set below.

**Explicitly OUT of scope** (name them in the ledger row as untouched): per-frame material/light/
camera UBO `writeBuffer`s (content-driven; gating them needs byte-compare or input-revision design —
if you attempt it, byte-identical oracle required and it is its own slice), pick-ID eagerness
(items 50/56), collection dirty gating (other FAR-309 surfaces), JS→TS conversion of
`WebGPUModelMetadataCache.js` (item 88).

#### Traps for the unwary (C9-17)

1. **Three material buffers, one function.** Primary/silhouette/translucent group-1 BGs differ ONLY
   by material buffer (`materialBuffer` / `materialBufferSilhouette` / `materialBufferTranslucent`).
   A single-slot cache keyed without the buffer would alias silhouette onto primary. Key on the
   buffer identity or use three slots.
2. **IBL entries array is fresh every frame today** — caching group-1 on `iblEntries` array identity
   WITHOUT first memoizing the resolution (Slice A step 2) would make the cache miss every frame and
   "work" while creating just as many bind groups. Verify post-slice with the labeled counter, not
   just by eyeball.
3. **The brdf LUT view flips once** from `pipelineCache.defaultBrdfLutView` to the generated
   `frameState.brdfLutGenerator._colorTexture._webgpuTextureView` (:3107-3119) — your memo must
   include it or models keep the placeholder LUT forever (visually: missing split-sum specular).
   Same for env-manager views which change when the environment capture refreshes.
4. **`primCache.textureEntries` identity is the invalidation token — do not deep-compare or clone
   it.** It is rebuilt exactly on deferred-texture upgrade and refraction-view change (:4854-4899).
   If you clone it into the cache key, upgrades stop invalidating and models stay white (the exact
   "Mars/Moon all-white" bug class the rebuild comment at :4886-4891 documents).
5. **Transmission scenes legitimately rebuild every frame** when the refraction capture view
   reallocates — do not "fix" that churn in this task; the identity key handles it correctly.
6. **`ensureFeatureIdResources` returns `undefined`** (not null) for no-feature models and the
   emission site distinguishes `defined(featureIdRes)` (:5088) — a cache key must treat
   null-featureIdEntries (default entries spliced at :3066) as its own state.
7. **The frozen base descriptor must never be annotated** — renderer fields go on the mutable view
   (`resetPrimitiveGeometryView` :689 clears exactly the annotatable fields). Slice B must not add
   revision fields to the FROZEN geometry object (`freezeGeometryDescriptor` :314 would throw in
   strict mode); revisions live on the SOURCE objects (attributes/primitives), not the descriptor.
8. **Do not renumber/reorder anything in `ShaderDefine`** while touching materialDefines-keyed
   layouts (add-only registry, CLAUDE.md). You should not need any shader change at all in this task
   — if you think you do, re-read the task; group-1 caching is pure JS resource identity.
9. **`getGeometryRevision` probes SIX field spellings** (:47-54). Pick `_webgpuGeometryRevision` for
   the stamp (first in the chain) and never stamp two different spellings on the same object.
10. **`WebGPUModelMetadataCache.js` has its own copy of the revision probe** (:48-50) — if Slice B
    stamps sources consumed by the metadata cache, its positive path accelerates for free; do not
    fork a second token scheme there.
11. **The spec-bundle freshness trap** (ledger row 4A/item 123): a new spec file silently NOT running
    is a green-looking lie — after adding specs run the workspace build first and confirm the new
    spec NAMES appear in the Karma output count.
12. **The 14/frame number is workload-specific** (BoxTextured + BoxInstanced + AnimatedMorphCube,
    1024x768, TAA on). Reproduce the BEFORE number with the unmodified tree first; if you measure
    something very different (e.g. a Campaign-9 batch already landed part of this), STOP and
    re-read the ledger before implementing.
13. **Audit-agent hazard** (memory: `feedback_audit_subagent_git_revert`): if you spawn review
    subagents, snapshot/commit your work first.

#### Verification recipe (C9-17)

Per slice: `npx tsc --noEmit` + `npx gulp build` clean, then:

1. **Specs** (after `npm run build --workspace @cesium/engine`):
   `npx gulp test --workspace engine --browsers=EdgeHeadlessCI --includeName "WebGPUModel"` (covers
   instance-cache + new material-cache + metadata-cache + feature-id specs) and
   `--includeName "ModelPrimitiveGeometry"`. All green, counts include your new cases.
2. **The settled probe** (server running):
   `node Tools/visual-regression/probe-model-instance-bg-cache.mjs` — PASS with the extended gates:
   `settledMergedInstanceBindGroupCreates === 0` (existing), new
   `settledMergedMaterialBindGroupCreates === 0`, and report `settledAllBindGroupCreates`
   before/after (expect ~14/frame → ~0-2/frame; attribute any remainder by label in the batch notes).
3. **Mutation exactness probes**: `node Tools/visual-regression/verify-model-feature-pick.mjs`
   (setShow/setColor + per-feature pick), `probe-model-color.mjs` (model.color blend),
   `probe-taa-model-skinned-velocity.mjs` (animation + TAA velocity),
   `probe-model-ibl.mjs` + `probe-model-pbr-ibl-parity.mjs` (IBL identity flips — trap #3),
   `probe-standalone-model-pick.mjs` (pick unaffected), `probe-model-scene-modes.mjs` (2D/CV/IDL).
   All PASS, zero device/page errors.
4. **Visual parity**: `node Tools/visual-regression/capture-and-diff.mjs --scene <model scenes>` or
   at minimum the IBL/color probes' pixel gates — group-1 caching must be byte-identical by
   construction (same resources bound); any pixel delta is a cache-key bug, full stop.
5. **Moving-route evidence** (promotion metric for the C9-30 checkpoint, not a per-slice blocker):
   API lane `run-performance-campaign.mjs --api-instrumentation` before/after — the
   `webgpuBindGroupsCreated` per-frame rate and its `"Model merged material bind group"` label
   bucket drop; archive JSONs as `campaign9-c9-17-*-2026-07-XX.json`. Do NOT claim a CPU-p95 win
   from a single repetition (queue rule: ≥5 counterbalanced reps for timing claims; the default
   moving route has few models, so the headline evidence for this row is the probe counters, not
   route p95).
6. **Ledger + docs**: update the C9 §3.2 ledger (add/flip the C9-17 row with per-slice evidence),
   update the FAR plan rows at lines ~73/75 (move the closed items out of the "remaining" column),
   move/annotate the corresponding FEATURE_INVENTORY §C entry if one names FAR-309 model work, and
   add the WEBGPU_DEBUGGING_LOG batch entry. Do NOT edit
   `FORK_PERFORMANCE_WEEKLY_CHANGE_DEFENSE_2026-07-15.md` (frozen evidence) — supersede it in the
   queue ledger instead.

#### Rollback boundary (C9-17)

Each slice reverts independently, and each cache degrades to create-per-call — the correct rollback
for a bad key is REMOVING THE CACHE LOOKUP (falling back to per-frame `createBindGroup`/signature
walk/fresh commands), never removing or gating the underlying feature (feature IDs, IBL, silhouette,
batch styling, velocity). Specifically: Slice A rollback = restore the direct
`buildMergedMaterialBindGroup` calls (keep the label); Slice B rollback = the fast path is deleted,
the stamps are harmless and may stay; Slice C is spec-only (never roll back tests); Slice D rollback
= restore per-frame `new WebGPUDrawCommand`. Probes, specs, labels, and counters remain landed in all
cases (queue rule 6). If a mutation-exactness probe fails after Slice A, the failure mode is almost
certainly a missing key component — fix the key or revert the slice; do NOT "fix" it by forcing
per-frame invalidation of one path (that silently reintroduces the churn under a green gate).

---

#### Pointers (both tasks)

| What | Where |
| --- | --- |
| Queue rows + ledger | `migration_doc/QUEUE_2026-07-15_CAMPAIGN9.md` §3.2 (C9-16 row ~:138), Wave 2 items 32/33 (~:207-208), rules §1 |
| Remaining-work authority | `migration_doc/FORK_PERFORMANCE_WEEKLY_CHANGE_DEFENSE_2026-07-15.md` §8.3 (~:290), §8.6 (~:319, "14 … per settled frame" ~:335) |
| Architecture target | `migration_doc/FORK_PERFORMANCE_RTE_VISIBILITY_REMEDIATION_PLAN_2026-07-15.md` §4, WS2 (~:182) |
| FAR ledger + acceptance | `migration_doc/FORK_ARCHITECTURE_REMEDIATION_PLAN_2026-07-13.md` ~:73 (FAR-204), ~:75 (FAR-309), §FAR-309 ~:700 |
| Audit context | `migration_doc/SOL_AUDIT_REPORT_2026-07-16.md` ratings #21/#23, P1 #9, Appendix A cohort D |
| Clustered hook | `packages/engine/Source/Renderer/WebGPU/WebGPUSceneRendererClusteredLighting.ts` (WeakSet :87, disabled :118, transition :153, enabled :168, stash :356) |
| Clustered dispatcher | `packages/engine/Source/Renderer/WebGPU/WebGPUClusteredLightingDispatcher.ts` (params write :365, zero early-out :367, labels :191/:204) |
| Cluster compute | `WebGPUClusterBoundsRenderer.ts` (:271 pass label), `WebGPUClusterAssignRenderer.ts` (checksum :341, pass label :381) |
| Scene default | `packages/engine/Source/Scene/Scene.js:1154` (`_clusteredLightingEnabled = false`), getter/setter ~:3051 |
| Clustered probes | `Tools/visual-regression/probe-clustered-{per-frame,dispatcher,multifrustum,litmat,matsweep,phong,visible,lights-resize,demo-scene}.mjs` |
| Model renderer | `packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.ts` (entry :3707; group-1 build :3049/:3060; IBL :3080/:3103/:3132; group-2 cache :3224; textureEntries rebuild :4854-4899; implicit FID gate :4649-4688; featureId :5062; UBO writes :5095/:5105; emission :5276-5303; command :5388; silhouette :5907; translucent :6057; capture clone :5444; exports :6543) |
| Geometry cache | `packages/engine/Source/Scene/Model/ModelPrimitiveGeometry.js` (WeakMap :32, revision probe :43, signatures :94-300, extract :614, view :676/:689, diagnostics :707) |
| Feature IDs | `packages/engine/Source/Renderer/WebGPU/WebGPUModelFeatureId.js` (cache hit :412, implicit lookup :114, synthesize :157, batch dirty :421, exports :800) |
| Metadata cache | `packages/engine/Source/Renderer/WebGPU/WebGPUModelMetadataCache.js` (revision probe :48) |
| Loader stamp sites | `packages/engine/Source/Scene/GltfLoader.js` :1178/:1199/:1251/:1639, `loadTypedArrayForWebGPU` :1432/:1535/:1596; also check `PntsLoader.js`, `PrimitiveOutlineGenerator.js` |
| Spec templates | `packages/engine/Specs/Renderer/WebGPU/WebGPUModelInstanceBindGroupCacheSpec.js` (mock device), `packages/engine/Specs/Scene/Model/ModelPrimitiveGeometrySpec.js` |
| Model probes | `Tools/visual-regression/probe-model-instance-bg-cache.mjs` (settled counter :44-52/:147), `verify-model-feature-pick.mjs`, `probe-model-{color,ibl,pbr-ibl-parity,scene-modes}.mjs`, `probe-taa-model-skinned-velocity.mjs`, `probe-standalone-model-pick.mjs` |
| Perf runner | `Tools/visual-regression/run-performance-campaign.mjs` (`--api-instrumentation`; label buckets :889-905; createBindGroup :1091; writeBuffer :1272; compute pass :1155); protocol in `migration_doc/DEBUGGING_GUIDE.md` §"Canonical moving-altitude campaign" (~:1089) |
| Artifacts dir | `Tools/visual-regression/output/performance/campaign9-*.json` (naming convention to follow) |

---

---

<a id="traps-index"></a>

## TRAPS INDEX (every trap, one line, with section link)

### [G10 — checkpoint protocol + engine handoff](#g10)

1. Running backends in separate invocations kills counterbalancing — one invocation, `--renderer both`.
2. `--api-instrumentation` numbers are NOT timing evidence — never quote an instrumented p95 as the campaign delta.
3. `--gpu-timestamps` contaminates cross-backend CPU comparison (only the WebGPU leg is instrumented) — leave it off for verdict lanes.
4. `--reuse-browser` leaks WebGPU resources across repetitions — fresh process per run is the default; keep it.
5. Aggregates hide segments — the ≥15% near-ground target and p99 rule require per-run `trackMetrics.segments` medians computed across runs.
6. The 7.08 ms C9-05 number is NOT the baseline — the comparison anchor is Gate-A r5 (WebGL 5.50 / WebGPU 7.51).
7. consoleErrors ≠ pageErrors — fail on pageErrors/deviceErrors (must be 0) and NEW console-error classes only.
8. Idle workloads prove nothing — the moving-altitude track is the only valid promotion evidence.
9. Never edit `performance-workloads.json`, the track, or the runner to "help" the measurement — that forks the protocol from Gate-A.
10. Dirty tree = wrong hash — `source.dirty: true` you didn't expect means an engine task left WIP; clean, rebuild, re-run.
11. Machine load — serialize the lanes, close other Edge instances/builds; a quietly-inflated-but-stable lane still lies.
12. (Part B) Completed task entries must stay BYTE-IDENTICAL in the resume script — any edit forces a live re-run of already-landed work.
13. (Part B) NEVER edit `CHARTER`, prompt builders, or schemas — a CHARTER edit invalidates EVERY cache including completed tasks (the stale 24-bit-mask sentence stays).
14. (Part B) Never remove the `safeAgent` wrapper or add a bare `await agent(...)` — a subagent finishing without StructuredOutput throws and killed a prior run.
15. (Part B) Dead audit ≠ failed audit (B18): one retry, never revert probe-verified work; trust the auditor's GO verdict — sub-flags are inputs, not vetoes (B3/B12: four false reverts).

### [G1 — depth-plane pick-gate remainder](#g1)

1. The working tree is SHARED with a running campaign — stage by explicit path; never `git add -A`, `git stash`, or revert files you didn't author.
2. The ledger already says "scene half LANDED" but the code floats — check file content, not the ledger, before (re)implementing.
3. Never mix encode sources — stash near/far + recomputed factor together, always (the Sol scene defect was exactly this mismatch).
4. Do not build a hyperbolic pick variant of the depth plane — both dead ends are instrumented-proven (runs 1 and 1b).
5. Do not convert a subset of the pick fleet and land it — a lone log producer picks through every hyperbolic producer.
6. `less-equal` ties are not a rejection mechanism — at 5,000 km the hyperbolic Δz is sub-f32-ulp and ties PASS.
7. The clip-z clamp (`csm_updatePositionDepth`) is not optional — without it far geometry is hardware-clipped and the vanish looks like success.
8. ShaderDefine registry is add-only — use the existing `LOG_DEPTH` bit; never add a "pick log depth" bit, never renumber.
9. Uniform struct extension must match byte offsets — collection pick structs are a PREFIX view; `logDepth` goes at floats 44-47 exactly.
10. `debugSkipDepthPlane` has a known WebGPU parity gap (queue item 79) — nonzero skip-phase draws means fix item 79 as its own slice.
11. Known-failing gates that are NOT yours: compute-instance pick mirror, buffer-primitive pickAsync, MSAA-flip race, cold async-pipeline miss — reproduce-before/after, don't chase.
12. HDR interplay — Batch 672 made `pickPipelineFormat` the single authority; after WGSL edits re-run `probe-hdr-pick-format-closure.mjs`.
13. The oracle asserts the plane is the `[ld]` module — don't weaken that assertion.
14. Playwright = Edge only; probes are the acceptance mechanism; scan new probes for unbounded loops.
15. Karma may not launch in a sandboxed session — say so and lean on probes + tsc + build; don't skip silently.
16. Comment/doc drift is itself a bug — the `GlobeTerrain.wgsl` pick note and gate JSDoc must be rewritten with the fleet conversion.

### [G2 — broad-suite remainder](#g2)

1. The stale-spec-bundle trap (item 4A) — a green focused run proves nothing unless you rebuilt `packages/engine/Build/Specs` first; use the sentinel-failure trick.
2. Do not clobber the concurrent worker — uncommitted destroyObject/PolylineGeometryUpdater/VoxelBounds/depth-plane files belong to in-flight slices.
3. Baseline drift — R20/DS10/S47 were pinned on Sol's pre-landing dirty tree; re-pin (W0) or you will misattribute.
4. "Chrome failed to start" after SUCCESS is a launcher artifact; a run executing ZERO specs fails nonzero by design — don't "fix" that.
5. destroyObject pragma semantics — the destroyed-method throw exists only in debug builds; don't make it always-throw.
6. destroyObject fleet blast radius — every `destroy()` funnels through it; if allocation-tax lanes regress, the prototype walk is the suspect (don't add a WeakMap cache speculatively).
7. GLSL100 fix must not perturb GLSL300 — verify a WebGL2 model renders identically; don't rename czm_-prefixed functions.
8. GLSL ES 1.00 Appendix A subtlety — keep the constant-bound-plus-break loop shape; `i < additionalLightCount` would disqualify the loop.
9. WebGL1 async pick — don't route WebGL2 through the Promise-wrapped sync read; don't try to make WebGL1 truly async.
10. Resource: do not reconstruct what you can preserve — verbatim-slice before the first `?`/`#`; the L233–238 negative controls (protocol-relative, bare-relative) must stay green.
11. Resource: `getUrlComponent` does brace-template restoration (`%7B`→`{`) — templated URLs must keep working.
12. KMZ keys are raw and case-sensitive — normalize the LOOKUP, never stored keys; decode percent-escapes on the lookup side only.
13. KMZ: don't "fix" the HTTP fallthrough by removing it — genuinely-external hrefs must still resolve via `getDerivedResource`.
14. Semantic-oracle discipline — if the semantic env-map check fails, that's a product bug: queue it, don't tune tolerances until green.
15. CubeMapPanorama hoist — the validation stays pragma-wrapped debug-only.
16. Item 72 is not "run and hope" — triage GraphicsCapabilities/ContextLimits FIRST per the queue row.
17. The `afterAll` and full-run abort are item 8's property — don't add network mocks/timeouts to Scene specs.
18. Ledger duty — every slice start/land/block gets a §3.2 row edit in the SAME commit.
19. lint-staged OOM on big files (KmlDataSource ~4k lines) — `--concurrent 1`, never `--no-verify`.
20. Commit as kurtyoung-dev — 403 on push = wrong active gh account.

### [G3 — demand-open canvas pass](#g3)

1. Depth lazy-zero vs clear-to-1.0 — first canvas-pass open with `depthLoadOp:"load"` on an untouched texture reads 0.0 and every depth-tested draw fails; Invariant 4 exists for this.
2. PP writes the canvas invisibly (raw encoder passes) — miss `markCanvasContentWritten()` and the endFrame fallback clears the canvas AFTER post-process: solid black with zero validation errors.
3. The debug throw in `_beginDefaultRenderPass` — fallback/lazy opens must only run with no pass active; test in the UNMINIFIED build to catch it loudly.
4. `clear()`'s guard consumed more than the background clear — the target-based guard must early-return on BOTH "scene-framebuffer" AND "default-canvas".
5. Pick frames — gate the endFrame fallback on `_currentTextureView !== null`; reset canvas flags in beginFrame/beginPickFrame only.
6. 2D wrap halves (BUG-3) — one beginFrame/endFrame spans two `executeCommands` calls; don't reset `_activePassTarget` outside pass transitions; run `probe-2d-cv-modes.mjs`.
7. `numFrustums === 0` is not the only empty producer — exceptions, redirect branch-2, `usePostProcess=false` all exist; the endFrame fallback covers them uniformly.
8. Do not "fix" the OIT resume at `WebGPUSceneRendererTranslucentPass.ts:273` — behavior change to an enabled feature; ledger it instead.
9. Label strings in tooling — the API lane buckets by pass label; a new fallback label changes the acceptance assertion shape; never rewrite historical artifacts.
10. Don't let the redirect's `endCurrentRenderPass` disappear — load-bearing for branch-2/error frames and the second 2D half.
11. `_ensureDepthTexture` must stay in beginFrame — it backs `depthOnlyTextureView` (Hi-Z) regardless of the pass.
12. TypeScript `any` ban + pragma rules apply — real types for new fields; diagnostics inside pragma blocks; keep permanent sentinels.

### [G4 — scheduler/octree demand + diagnostic demand gates](#g4)

1. T-1 The FAR-003 containment spec asserts the OLD behavior — rewrite the spec in the same commit; the force-reachability case stays green untouched.
2. T-2 Do not retire/trim the scheduler — `predictSortPosition`/octree/occlusion/WasmSortBridge are FAR-504 scope and Principle-7 scaffolding.
3. T-3 `ensureMaterialSortId` only fills zeros — commands keep stale IDs after demand release by design; don't "clean up".
4. T-4 2D wrap-split and pick frames call `executeCommandsInViewport` multiple times — the gate sits inside it, not in `Scene.render()`.
5. T-5 Root-sphere drop bug — out-of-root-bounds commands stored at the root get wrongly culled; fix is bypass at build time, not a bigger root.
6. T-6 Octree horizon culling is only safe because sphere-conservative — any non-conservative change is a silent feature regression.
7. T-7 3D-Tiles-derived TRANSLUCENT commands are octree-eligible — enforced by pass constants; don't add owner-based exclusions.
8. T-8 The octree replaces `frameState.commandList` order — dirty/reuse must reproduce the same replacement semantics or equal-depth overlaps flicker.
9. T-9 Don't break the `time()` accumulation contract — `endPass` must `+=`, not assign.
10. T-10 The pick early-return block has order-sensitive cleanup — keep begin/try/finally strictly around `_executePickPass` only.
11. T-11 Pragma blocks and TypeScript — tsc checks unstripped source; a variable declared in a block and used outside breaks `buildRelease`; keep blocks self-contained.
12. T-12 Do not pragma-wrap or demand-gate error sentinels — `console.error` for real defects stays permanent in all builds.
13. T-13 Concurrent campaign execution — C9-07/C9-11 touch the same files; rebase-verify the nine call-site anchors immediately before editing.
14. T-14 `binCommand`'s pass fallback reads `command._pass ?? command.pass ?? 8` — preserve both reads.
15. T-15 Don't turn `materialSortIdDemand` into a per-command check — one boolean read per viewport execution, outside the loop.

### [G5 — attachment demand registry + consumer-driven MRT](#g5)

1. Trailing-null target arrays — `[slot0, null]` validates as 1-target; the MRT placeholder must be non-null `{format, writeMask:0}`; the ONE_TARGET variant must be length-1.
2. Shader/pipeline output mismatch is a creation-time error in BOTH directions — define, targets, and pass attachments flip as ONE variant.
3. Mid-frame divergence — never read `scene._enableSSR` etc. at pass-open time; the frame-frozen record + per-frame mirror stamp is the defense.
4. The generation-bump race precedent (`NEW-WEBGPU-SCENE-PASS-MSAA-FLIP-TRANSITION`) — prefer variant-cache-and-select over invalidate-and-rebuild.
5. Render bundles fail at EXECUTION, not creation — every bundle key must include topology, plus `invalidateAll()` on transition.
6. `resolveTarget` sample-count mismatches kill the whole scene pass — the ONLY G-buffer sample authority is effective `context._msaaSamples` (TAA forces 1).
7. `ErrorPipeline.wgsl` emits `@location(1)` unconditionally — forget it and error visualization silently dies in one-target mode.
8. The depth-only globe pre-pass writes slot 1 on purpose (back-face normals) — don't "fix" the asymmetry.
9. Scaffolding is not dead code — deferred-lighting shaders, compute producer, AO placeholder all stay.
10. Shader-module cache identity — `defines=0` output must stay byte-identical; keep WGSL diffs surgical; never renumber defines.
11. Stale bind groups holding a destroyed G-buffer view — invalidate effect caches on ON→OFF transitions.
12. SCENE2D wrap halves — the second half opens with `loadOp:"load"` on ALL color attachments including slot 1; preserve `sceneFbLoad` plumbing.
13. `debugShowGBufferNormals` implies deferredLighting — count BOTH as readers so the raw flag still yields a working overlay.
14. `usePostProcess` is unconditionally true on WebGPU — demand-gating applies ONLY to slot 1 / the G-buffer.
15. Multi-context / split-screen — `_mrtMode` is module-global; per-frame re-stamping is safe, but add a split-screen probe leg; context IDs in error logs.
16. Async pipeline compilation on first toggle — prewarm the hot MRT set on OFF→ON; do NOT eagerly compile both variants at startup.
17. Monorepo rule — `packages/engine/Source/**` only; WGSL edits need `npx gulp build` before probes see them.
18. Do not weaken the pick path — `probe-hdr-pick-format-closure.mjs` stays green as the Batch-672 regression gate.

### [G6 — retained terrain descriptors + static/dynamic upload split](#g6)

1. Imagery readiness churn without mesh change — key on per-layer texture-view identity + TS/rect bytes or tiles render with stale UV transforms.
2. Imagery layer ORDER changes without set-membership change — key on the ordered tuple, not a set.
3. Function-valued layer properties (`alpha` et al.) are legal public API — detect at pack time, fall back per tile.
4. Water mask is a SHARED texture with per-tile TS — key texture identity AND TS bytes; exercise a lake view, not just ocean.
5. The frozen-ocean failure — `TIME_OFFSET` in a static block freezes waves; time-varying scalars are per-view/per-frame, period.
6. Clipping mutation — `useClipDistances` flips PIPELINES; pipeline selection is part of the revision, not just bind groups.
7. Shadow/CSM/cloud-shadow arrival is asynchronous — key on resolved view identities and re-resolve per frame in the refresh step.
8. HDR/MSAA vs log-depth are SEPARATE invalidation signals — retained pipelines must be invalidated by BOTH; mirror `_pickFormat` refresh behavior.
9. Async pipeline materialization — never cache "descriptor absent" as part of the packet; rebuild until all expected descriptors resolved.
10. `beginPickFrame` advances the ring — scene-frame ring offsets are dead inside pick mini-frames; treat them as a distinct allocation epoch.
11. 2D/CV bounding spheres and `cull:false` — the fallback path must keep the fresh allocation; never share one scratch sphere between retained and fallback paths.
12. Multi-context / pooled device — the renderer is per-GPUDevice and shared post-Sol; key per-frame refresh by context/view; test split-screen.
13. Env-map scene capture bypasses the on-screen path but SHARES group 0 — update it in the same commit as any layout change.
14. Exaggeration — a one-frame scalar/mesh mismatch is upstream-identical; don't "fix" it.
15. Skirt count truncation depends on `cameraUnderground`/translucency — refresh `drawIndexCount` per frame or key it.
16. Translucency restructures the pass list — gate retention on `!globeTranslucent` and record the boundary in the ledger.
17. `frameNumber ?? 0` alias (item 91) — a missing frame number must assert in debug, never alias slot 0.
18. Ring single-producer discipline — all new ring writes via `allocateAndWrite`; any NEW mid-frame submit must flush first (P0-4).
19. Do not add terrain eviction/residency here — C9-15/FAR-200-S3/C9-12A scope; tie new slabs to `_tileBufferCache` lifetime only.
20. Docstring drift — TileUB doc says 476 floats; the constant says 484/1,936 B; trust constants + WGSL, fix the docstring in passing.
21. Dead-code/scaffolding rule — `_tileUniformU32View` and the deprecated `createTileCommand` stay.
22. Workspace spec-bundle staleness — explicit engine build before focused Karma runs.
23. Request-render mode — no "skip createTileCommands when warm" shortcut ABOVE the renderer; the per-frame call is the refresh point.
24. Audit-agent / worktree hygiene — snapshot/commit before broad audit subagents; never bare `git stash`.

### [G7 — imagery source-realization dedup + frame-owned mips](#g7)

1. Never key sharing on tile coordinates, never hash pixel content — object identity + declared revision only.
2. `imagery.key` is a mirage — it exists only in the `.d.ts`; assigning it breaks the merc/reproj cleanup identity guards; dedup lives BELOW the cache.
3. Cross-layer collision is pre-existing and a DISTINCT item — reproduce it, file it, don't fold a silent key change into this slice.
4. Do not begin render passes on the frame encoder mid-update — the default canvas pass is open; that's why the prep encoder is separate and submitted in endFrame.
5. Do not batch Route B reprojections — the single shared 16-byte UB makes deferred passes all read the LAST tile's latitudes; that's FAR-205 slice 7 / FAR-402.
6. `scheduleTextureDestroy` timing — inline `texture.destroy()` on a texture the current frame binds is the Batch-320 bug class.
7. Mip-job-vs-eviction race — add the skip-set guard for same-frame create+evict.
8. Gate B / FAR-200 — no SubmissionSerialAuthority adoption, no per-resource `onSubmittedWorkDone`, no `queue.submit` monkeypatching.
9. Multi-context — use the CONTEXT-owned `mipmapGenerator`; don't add another module-global; leave the existing globals per the dead-code rule.
10. Device loss/recovery — the table detects device change and rebuilds; never serve a realization created on device A to device B.
11. requestRenderMode — pending mip jobs across idle frames are safe, but probes must request renders; never use idle FPS as evidence.
12. 2D/CV — `resolveImageryProjection` is untouched; sharing only changes ownership on the "upload" branch; certify via the workload matrix.
13. Water mask / ocean normal / exaggeration — own caches, formats, cleanups; out of scope.
14. Pick — sharing is transparent (same view objects); keep `probe-pickposition-webgpu.mjs` in the regression set.
15. Clean-lane purity — every new counter increment stays behind the `if (!counters)` guards; the clean lane allocates ZERO diagnostic state.
16. Charter mechanics — packages/engine only, zero `any`, preserve moved comments, pragma-wrap new per-upload diagnostics, `--concurrent 1` for big commits.
17. Placeholder keeps `imagery.image` alive — do not "optimize" by clearing it; the upload path needs it after eviction/re-realization.

### [G8 — effects handle + ground-atmosphere stage ownership](#g8)

1. (C9-13 T1) Pooled-device renderer sharing — a memo on the renderer keyed by frameNumber serves Scene A's camera bytes to Scene B; memo on `frameState.context`.
2. (T2) `uniformState.cameraPosition` is a live scratch object — snapshot x/y/z values, never the reference.
3. (T3) Toggle-off must re-bind the placeholder — the tuple check covers it; test explicitly (V4).
4. (T4) Don't touch `shouldRecomputeAtmosphereLUT()` — it is side-effecting (clears the dirty flag); the helper calls only `ensureAtmosphereLUTResources`.
5. (T5) Scope creep into C9-11/C9-12 — camera/tile UB packs, texture/water BGs, readyLayers all stay per-tile; they have their own rows.
6. (T6) Don't "optimize" `WebGPUEffectsStateCache`/`createEffectsBindGroup` internals — shared with model/primitive paths.
7. (T7) Dead-code illusion — the per-call string-key machinery is NOT dead; the model path calls it per model.
8. (T8) TS discipline — no `any`, co-located `.d.ts` pattern for context fields, moved comments verbatim.
9. (T9) Pick/derived commands — same group 3; nothing to do, but run the pick probe.
10. (T10) `frameNumber ?? 0` — if frameState lacks a frame number, do NOT memoize.
11. (C9-14 T1) SHADER_PAIRS_LOCKSTEP — WGSL change inside the pair block REQUIRES the matching GLSL-side edit + lockstep-doc row in the SAME commit.
12. (T2) Canonical paths — `Shaders/**/*.js` including `GlobeTerrain.js`/`GlobeFS.js` are build outputs; never hand-edit.
13. (T3) Do not remove the atmosphere varyings or their zero-init — consumed in vertex mode and by debug visualizers; VS/FS interface must match all six entries.
14. (T4) The mesh-pattern artifact at orbit is real — never select vertex ownership above `nightFadeOutDistance`.
15. (T5) Zero-fill must equal current behavior — x=0 selects FRAGMENT ownership; don't flip the polarity.
16. (T6) `select()` in WGSL evaluates both arms — use if/else for the march switch.
17. (T7) Don't touch the LUT fog block or `sampleAtmosphereFogLut` — orthogonal, documented WGSL-only enhancement.
18. (T8) `atmosphereParams.w` is an ENCODING (0/1/2) — new slot only; never pack the flag into it.
19. (T9) The debug force must be pragma-wrapped — an unwrapped `getActiveDebugSentinel()` on the hot path violates the pragma rules.
20. (T10) Grep for hardcoded `232`/`928` literals mirroring `CAMERA_UNIFORM_FLOATS` before bumping it.
21. (T11) This is GPU work, not CPU work — evidence is GPU timestamps + parity, not CPU deltas.
22. (T12) 2D/CV asymmetry (packer doesn't check mode) exists TODAY — keep the `mode > 2.5` VS guard, verify byte-identity, don't "fix" it here.

### [G9 — clustered zero-work + model settled frontend](#g9)

1. (C9-16 #1) "No-light" includes area lights — gate zero-work on BOTH punctual and area counts being zero.
2. (#2) Do not un-publish the buffers stash on enabled/zero-light frames — identity flip-flop churns the effects bind-group cache.
3. (#3) Every early return on the enabled path after `endCurrentRenderPass` MUST resume the pass — decide zero-work BEFORE ending it.
4. (#4) Do not replace the WeakSet with a boolean — multi-context keys per host.
5. (#5) Do not remove `COPY_SRC` from the params buffer — probes read it back.
6. (#6) Preserve probe gate semantics exactly — transition dispatch count exactly 1; the private dispatcher path belongs to the probe, not the engine.
7. (#7) The ClusterAssign checksum is deliberately partial — do not "improve" it in this slice.
8. (#8) Karma cannot create real WebGPU devices in CI — mock-device specs only.
9. (#9) Enabled+lights frames may legitimately skip compute (checksum hit) while writing params — don't assert writes == passes.
10. (C9-17 #1) Three material buffers, one function — key group-1 on the material buffer identity or use three slots; a single slot aliases silhouette onto primary.
11. (#2) IBL entries array is fresh every frame today — memoize the resolution FIRST or the cache misses every frame while "working".
12. (#3) The brdf LUT view flips once placeholder→real — the memo must include it or models keep the placeholder LUT (missing specular).
13. (#4) `primCache.textureEntries` identity IS the invalidation token — never deep-compare or clone it (the all-white-model bug class).
14. (#5) Transmission scenes legitimately rebuild every frame — the identity key handles it; don't "fix" the churn.
15. (#6) `ensureFeatureIdResources` returns `undefined`, not null — null-featureIdEntries (default entries) is its own key state.
16. (#7) The frozen base geometry descriptor must never be annotated — revisions live on SOURCE objects, not the descriptor.
17. (#8) Do not renumber/reorder `ShaderDefine` — you should need no shader change at all in this task.
18. (#9) `getGeometryRevision` probes six spellings — stamp `_webgpuGeometryRevision` only; never two spellings on one object.
19. (#10) `WebGPUModelMetadataCache.js` shares the revision probe — do not fork a second token scheme.
20. (#11) Spec-bundle freshness — confirm new spec NAMES appear in the Karma output count.
21. (#12) The 14-creates/frame number is workload-specific — reproduce the BEFORE number on the unmodified tree first.
22. (#13) Audit-agent hazard — snapshot/commit before spawning review subagents.

---

*End of guide. Assembled 2026-07-16 from ten independently-researched cluster reports, each verified against the live tree at HEAD `ea6332d0aa` (Batch 672). Re-verify anchors before acting; the ledger in `QUEUE_2026-07-15_CAMPAIGN9.md` §3.2 is the live source of truth for task status.*
