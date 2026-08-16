# WebGPU Visual Regression

Captures the WebGL and WebGPU canvases from the split-screen comparison page,
diffs them pixel-by-pixel, and reports per-scene mismatch ratios. Designed
for opt-in CI gating once the WebGPU backend approaches visual parity.

> **Finding a tool.** This README covers the regression harness and the shared
> libraries. For "which probe do I run for X", see
> [migration_doc/DEBUGGING_GUIDE.md](../../migration_doc/DEBUGGING_GUIDE.md) —
> the curated first-probe-to-run view. For the everything-view — all 1,012
> `.mjs` files under `Tools/` and `scripts/`, with class and status — see
> [migration_doc/TOOLING_CATALOG.md](../../migration_doc/TOOLING_CATALOG.md).

## Quick start

```bash
# 1. Start the dev server in another terminal
npm run restart

# 2. Run the regression suite (historical WebGL, historical WebGPU, and parity)
node Tools/visual-regression/capture-and-diff.mjs

# 3. Inspect output
ls Tools/visual-regression/output/
# - <scene>.webgl.png   captured WebGL canvas
# - <scene>.webgpu.png  captured WebGPU canvas
# - <scene>.diff.png    red pixels = mismatch (gray = matching context)
# - report.json         per-scene diff ratios + pass/fail
```

## Append-only visual-evidence library

Probe-owned `output/` directories remain local scratch space. Finished runs can
also be retained in a shared, append-only library whose default location is the
external Git sibling `cesium-webgpu-visual-evidence`; the main and linked
worktrees derive that same path from their Git common directory. Use
`--library-root` to choose another same-volume location.

```bash
# Read-only preflight: validates and fingerprints the exact source set.
node Tools/visual-regression/visual-evidence-library.mjs archive --dry-run <archive-options>

# Repeat without --dry-run to publish, then audit or list the library.
node Tools/visual-regression/visual-evidence-library.mjs archive <archive-options>
node Tools/visual-regression/visual-evidence-library.mjs verify
node Tools/visual-regression/visual-evidence-library.mjs catalog

# Existing v1 hardlink stores must be upgraded before another archive.
# `upgrade` is read-only by default; inspect its plan, then opt in explicitly.
node Tools/visual-regression/visual-evidence-library.mjs upgrade
node Tools/visual-regression/visual-evidence-library.mjs upgrade --apply
```

Publication uses protected read-only SHA-256 objects, independent protected
original-path copies, and an atomic no-clobber producer/run-ID directory. A
view can therefore be damaged only locally; it cannot mutate the canonical
object or another deduplicated run. Protection is defense in depth rather than
an ACL boundary, so `verify` still hashes every byte and checks that objects,
views, and manifests remain non-writable. The archive refuses active locks,
`RUNNING` or incomplete JSON, artifact/verdict mismatches, and source or Git
provenance changes between preflight and postflight. A dry run writes nothing
and reserves nothing; the real archive repeats all checks. Archiving preserves
the source result exactly—it neither certifies a run nor promotes a baseline.
Older bytes require `import-legacy --namespace ... --reason ...` and are always
recorded as `NON_CERTIFYING`; the reason must be concise public text without
absolute host paths, control characters, or credential literals. Retrying the
exact same producer/run ID and source
bytes is idempotent; any changed identity is a hard collision. Source and
library junctions/symbolic links are rejected. Shared manifests retain hashes,
portable paths, and Git identity but omit absolute host paths and store only a
hash plus byte length for an optional source command. `verify` checks the full
library topology, manifests, protected objects, independent views, and
authoritative artifact semantics before `catalog` will emit an index. Parsed
manifest JSON that is null, an array, or another non-object is reported as an
invalid library rather than escaping the verifier as an exception. V2 manifests
are exact schemas: unknown fields, run/legacy provenance mixing, false repository
stability, and extra host-path, command, or credential-bearing fields all fail
verification even when an attacker refreshes the manifest hash sidecar.
Catalog output uses only the portable library directory label; it does not emit
the absolute host location of the shared store.

The v1-to-v2 `upgrade` command first inspects the complete legacy hardlink
store without writing. `upgrade --apply` takes an external library-wide claim,
builds and verifies a complete sibling v2 store from the canonical object
bytes, then swaps it into place. If the swap or final verification fails, it
restores the untouched v1 directory; an already-v2 store is an idempotent
no-op. New publications refuse mixed v1/v2 stores. Because the apply form
rewrites the library topology, always review the plan and take a filesystem
backup before applying it to the shared store.

## Flags

| Flag                                          | Default  | Notes                                                      |
| --------------------------------------------- | -------- | ---------------------------------------------------------- |
| `--update`                                    | off      | Request reviewed promotion; requires the three flags below |
| `--confirm-baseline-promotion`                | off      | Explicitly authorize baseline replacement                  |
| `--update-rationale TEXT`                     | none     | Required written reason for a promotion                    |
| `--reviewed-by NAME`                          | none     | Required independent reviewer/provenance field             |
| `--scene NAME`                                | all      | Run only the named scene from `scenes.json`                |
| `--threshold N`                               | `0.02`   | Fail when any scene's diff ratio exceeds N                 |
| `--browser msedge\|chromium\|firefox\|webkit` | `msedge` | Playwright browser; Edge is preferred for Chromium WebGPU  |
| `--headed`                                    | off      | Show the browser window (for debugging)                    |

Exit code: `0` only when both historical renderer gates, current cross-backend
parity, and the WebGPU error gate certify. A missing, stale, or unreviewed
historical baseline is explicitly `NON_CERTIFYING` and exits `1`; a pixel/GPU
regression also exits `1`. Invalid arguments or an incomplete promotion request
exit `2`; uncaught errors exit `99`.

Baseline replacement is never implicit. After inspecting the before/current/diff
artifacts, use all four promotion flags:

```bash
node Tools/visual-regression/capture-and-diff.mjs \
  --scene globe-default \
  --update \
  --confirm-baseline-promotion \
  --update-rationale "Reviewed renderer correction" \
  --reviewed-by "Reviewer Name"
```

Promotion is refused when parity or the GPU error gate is red, publishes images
and `baseline/manifest.json` atomically, and deliberately remains
non-certifying. Run the same scene again without `--update` to certify the
published history.

## Adding scenes

Edit `scenes.json`. Each scene needs a `name` and an optional `camera`:

```json
{
  "name": "my-scene",
  "camera": {
    "destination": [longitude, latitude, height],
    "orientation": { "heading": 0, "pitch": -0.5, "roll": 0 }
  }
}
```

When `camera` is `null` the page's default initial view is used — or, for a
scene whose pose is an ECEF position with an explicit direction/up rather than
a lon/lat/height, the `setupFile` sets the camera on both viewers itself.

Two optional fields tune how a scene is judged:

| Field              | Effect                                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `thresholds`       | Per-gate mismatch ceiling (`historicalWebgl` / `historicalWebgpu` / `crossBackend`). Omitted gates use `--threshold`. |
| `expectedMismatch` | Pre-registers what a gate is expected to do, and why. Reported, never enforced — see below.                           |

### Pre-registered expectations

`expectedMismatch` is an array of `{ gate, expect, trackedBy, rationale }`.
`expect` is `PASS`, `FAIL`, or `UNMEASURED`.

```json
"expectedMismatch": [
  {
    "gate": "crossBackend",
    "expect": "FAIL",
    "trackedBy": "PARITY-POINTCLOUD-COLOR-TINT",
    "rationale": "WebGPU renders this cloud 27-45% brighter with blue lifted most, and the magnitude drifts within a session."
  }
]
```

It exists because a scene that sits on an open, filed defect has only two
other ways to be recorded, and both are bad: widen its threshold until the red
turns green (which normalizes the defect and silently absorbs any _worsening_
of it), or leave the red unannotated (in which case nobody reading
`report.json` can tell a known defect from a fresh regression).

So an expectation is **documentation that is checked**. It is folded into
`report.json` and printed next to the gate, and it **never** changes a gate's
`status`, `certifying`, or the process exit code — a red scene stays red, and
the run still exits `1`. What it adds is the signal the suite could not
previously express: an expectation that is **UNMET**, which is either a new
regression (predicted `PASS`, observed `FAIL`) or a defect fixed without the
record being updated (predicted `FAIL`, observed `PASS`). Both are findings.

A predicted `FAIL` **must** name a `trackedBy` ID. Without that rule the field
would become the thing it replaces: "expected to fail" with no filed row behind
it is threshold-widening with extra steps. A malformed declaration fails the
run with exit `2` before a browser is launched.

`UNMEASURED` is a first-class value, for a scene whose subsystem has never been
compared in _this_ metric. Transcribing a number from a probe that measures
something else (an IoU, a per-channel gain) would be fabricating a derivation;
declaring the gap is honest, and the first run records the real value.

### Synthetic scenes via `setup` / `setupFile` (Batch 224, refactored Batch 225)

Scenes can include a `setupFile` field — a path (relative to
`scenes.json`) to a JS source file evaluated in the page context (same
origin as the viewers) before the camera is positioned. Or, for
trivial one-liners, an inline `setup` string. The script receives a
`params` argument from the scene's `setupParams` field, has access to
`window.Cesium`, `window.webglViewer`, and `window.webgpuViewer`, and
may return a Promise that resolves when async setup completes (e.g.,
procedural geometry generation).

Prefer `setupFile` over `setup` for any non-trivial generator —
inline strings are fragile (no syntax highlighting, no formatter, no
debuggability) and bloat `scenes.json`.

The `high-density-5k-spheres` scene is the reference example: it
procedurally adds 5000 sphere instances around San Francisco with a
deterministic mulberry32 RNG seed. It crosses every threshold-gated
GPU dispatcher's activation point (gpuCuller HI=384, HiZ HI=2400) and
opts the WebGPU viewer into eager warm-up via `Scene.gpuCullingHint =
'always'`. Use it to verify that the threshold-gated dispatchers
introduced in Batches 209-218 produce visually identical output to
the unmodified WebGL pipeline:

```bash
# After starting the dev server (npm run restart), run:
node Tools/visual-regression/capture-and-diff.mjs --scene high-density-5k-spheres
# This scene is currently characterization/red evidence. Do not promote it
# until its parity failure is fixed and independently reviewed.
```

### Subsystem parity scenes: voxels, point clouds, Gaussian splats

`voxel-box-procedural`, `pointcloud-timedynamic-edl` and `gsplat-sh-unit-cube`
share one generator, `scenes/subsystem-parity-setup.js`, selected through
`setupParams.subsystem`. They exist because those three subsystems had no scene
in this suite at all, so their cross-backend evidence was one-shot probe
history — the newest voxel and point-cloud runs on record are from 2026-07 —
instead of a gate that re-runs.

Each of them hides every primitive it does not own plus the globe, sky, sun,
moon and fog, paints an opaque black background, pins the clock, suppresses
the split-screen page's camera mirroring, and writes the same ECEF pose to both
viewers. That makes them **order-independent** (`--scene <name>` alone renders
the same frame as a full sweep) and makes the captured pixels dominated by the
subsystem under test rather than by terrain and atmosphere noise. Every asset
is in-tree (`Apps/SampleData`, `Specs/Data`), so they run offline.

If a scene's content never reaches readiness inside its wall-clock budget the
setup **throws**, aborting the run with exit `99`. That is deliberate: an empty
frame on both backends is a cross-backend `PASS`, so a scene that silently
failed to build its subject would certify parity by rendering nothing.

```bash
node Tools/visual-regression/capture-and-diff.mjs --scene voxel-box-procedural
node Tools/visual-regression/capture-and-diff.mjs --scene pointcloud-timedynamic-edl
node Tools/visual-regression/capture-and-diff.mjs --scene gsplat-sh-unit-cube
```

Their pre-registered cross-backend expectations, and why each was chosen:

| Scene                        | Expect       | Basis                                                                                                                                                                                                                      |
| ---------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `voxel-box-procedural`       | `UNMEASURED` | No cross-backend voxel number exists in this metric; `probe-voxel-parity` gates on footprint IoU and colour-structure overlap.                                                                                             |
| `pointcloud-timedynamic-edl` | `FAIL`       | `PARITY-POINTCLOUD-COLOR-TINT`. Threshold left at the suite default rather than loosened, because the recorded divergence _drifts within a session_ — a ceiling derived from it would need re-widening as the defect grew. |
| `gsplat-sh-unit-cube`        | `PASS`       | Derived: after `C15-G5`, Batch 895 measured this asset at 0.000% cross-backend under **exact** per-channel equality, and this suite's tolerance of 16 is strictly more forgiving.                                          |

Baselines for all three start missing, so their historical gates are
`NON_CERTIFYING` until someone reviews the captures and promotes them. Promote
**per scene** with `--scene`: the full-sweep promotion path refuses while any
scene in the run is cross-backend red, and it has been blocked since
`high-density-5k-spheres` became red evidence.

## How it works

1. Playwright opens `Apps/WebGPUTest/split-screen-comparison.html`.
2. Waits for `window.webglViewer` and `window.webgpuViewer` to be defined
   (the page exposes them globally for tests — see the script's
   `window.webglViewer = webglViewer;` line).
3. For each scene, applies the camera, waits `settleFrames` rAF ticks
   for terrain LOD / imagery / atmosphere to stabilize, then captures
   both canvases via OffscreenCanvas → `getImageData()`.
4. Pixel-diffs the two RGBA buffers with a small per-channel tolerance
   (16/255 ≈ 6%) so JPEG/imagery noise doesn't cause flapping.
5. Independently compares current WebGL/historical WebGL, current
   WebGPU/historical WebGPU, and current WebGL/current WebGPU. Historical PNGs
   without matching reviewed manifest provenance are still compared but cannot
   certify.
6. Encodes baseline / current / diff PNGs from raw RGBA without
   any external dependencies.

## Allocation and performance characterization

Both campaign tools are Node/Playwright scripts and launch installed Edge; they
do not use Python. Start the normal Cesium Node server first.

The independent allocation probe instruments browser WebGPU API boundaries and
fails if an explicit WebGPU launch opens a WebGL/WebGL2 canvas:

```bash
node Tools/visual-regression/probe-webgpu-allocation-tax.mjs \
  --output Tools/visual-regression/output/allocation-tax.json
```

Add `--strict-native` for migrated fixtures whose ownership contract requires
zero `GL Compatibility` buffers. Buffer byte counts are exact at the API
boundary; texture bytes are descriptor estimates and driver-private memory is
outside the result. `GLStub_*` textures are reported as compatibility-shaped
native resources but do not fail this buffer gate: the label proves that the
WebGL-shaped construction path ran, not that a second physical texture exists.
Use decoded/backend-realization ownership events to prove or disprove a texture
double allocation.

The versioned performance campaign reads `performance-workloads.json`, asserts
the resolved backend, uses local/procedural deterministic content, and records
full `Scene.render()` CPU samples, p50/p95/p99/MAD, capability-available GPU
timestamps, long tasks, heap diagnostics, and renderer snapshots:

```bash
# One bounded smoke on both backends
node Tools/visual-regression/run-performance-campaign.mjs \
  --workload settled-static-3d --repetitions 1 --frames 120

# Manifest protocol (all workloads and repetitions)
node Tools/visual-regression/run-performance-campaign.mjs

# Counterbalanced WebGL/WebGPU altitude flight (18,000 km down to 300 m)
node Tools/visual-regression/run-performance-campaign.mjs \
  --workload moving-camera-altitude-track-3d \
  --renderer both \
  --output Tools/visual-regression/output/performance/altitude-track-ab.json

# Separate API-boundary characterization run (observer overhead is explicit)
node Tools/visual-regression/run-performance-campaign.mjs \
  --workload moving-camera-altitude-track-3d \
  --renderer both \
  --api-instrumentation \
  --output Tools/visual-regression/output/performance/altitude-track-api.json
```

CPU render time is the primary cross-backend metric. Available GPU timestamps
are a separate WebGPU characterization metric. The requestAnimationFrame wall
metric is retained as diagnostic evidence and must
not be treated as an uncapped FPS promotion gate. The altitude workload uses a
fixed-duration, time-parametrized route and reports observed FPS, one-percent
low FPS, 60 Hz dropped-frame diagnostics, camera-height/segment coverage, and
per-segment CPU/wall distributions. GPU timing remains available for the whole
trace; it is not assigned to route segments because asynchronous timestamp
readback does not expose the originating scene frame. API instrumentation is
off by default so its JavaScript wrappers cannot bias clean timing runs.
Renderer repetitions alternate WebGL/WebGPU then WebGPU/WebGL to counterbalance
thermal and ordering drift. The flight's `default-globe` feature profile retains
the renderer's default fog, skybox, atmosphere, sun, moon, and HDR state; each
run records the resolved feature state. Other micro-workloads declare the
isolated `deterministic-core` profile explicitly rather than silently disabling
features as a benchmark optimization.

GPU timestamps are off by default so a WebGL/WebGPU CPU comparison does not
instrument only the WebGPU leg. Use `--gpu-timestamps` for a separate WebGPU
characterization run. Current delayed profiler values are not uniquely tied to
Scene trace rows, so timestamp p95 remains diagnostic until the profiler emits
unique submission/frame serials and the runner consumes each completed sample
once; it is not a promotion metric.

The `moving-pick-camera-altitude-track-3d` lane uses the public asynchronous
`Scene.pickHoverAsync` path with a deterministic 3x3 cursor sweep. It does not
use synchronous `Scene.pick`: WebGPU's synchronous compatibility result is
query-rectangle-specific, so a continuously moving cursor cannot warm that
cache. Pick mini-frames execute outside the normal `Scene.render` trace; the
harness therefore records public-call CPU, physical pick-execution CPU, and
completion latency separately, then reports a combined render-plus-pick CPU
distribution without double-counting the initial execution nested in the
public call. A run is invalid if requests do not complete during sustained
traffic, the chain fails to drain, calls reject, CPU evidence does not balance,
or cursor/route evidence is incomplete.

### Campaign 13 cloud characterization (C13-01 Slice A)

The first Campaign 13 slice provides deterministic, offline Node/Playwright
characterization for the current cloud architecture. Start the normal Cesium
Node server first (`node server.js --production`). The probes open the local
viewer with `offline=true`,
disable request-render pausing, stop clock animation, and render at authored
fixed times. A shared browser helper writes directly to
`globe.defaultCloudCollection.volumetric`, rejects unknown properties, and
round-trips every requested value into a truth record. Procedural probes also
await the exported lazy feature renderer, drive bounded camera motion until a
real cloud execute initializes the cache, and record the realized step/target
path. This prevents a stale probe from silently assigning removed fields or
treating skipped cold-start frames as rendered clouds.

Run the complete static cloud tour:

```powershell
node Tools/visual-regression/probe-cloud-tour.mjs
```

The tour captures every procedural scene on WebGPU and captures billboard
`CloudCollection` scenes on both WebGPU and WebGL. Procedural volumetric clouds
are WebGPU-only; WebGL is a parity control for the shared billboard/API path,
not a volumetric comparison. For a shorter seam/pole/API smoke:

```powershell
$env:TOUR_SCENES = "proc-dateline-east-horizon,proc-dateline-west-horizon,proc-north-pole-oblique,proc-south-pole-oblique,billboard-cumulus-noon"
node Tools/visual-regression/probe-cloud-tour.mjs
Remove-Item Env:TOUR_SCENES
```

Outputs are
`Tools/visual-regression/output/cloud-tour/<scene>-<backend>.png` and
`Tools/visual-regression/output/cloud-tour/cloud-tour-truth.json`. The script
fails on a configuration round-trip failure, a new console/page/GPU/device
error, or missing cloud-contribution evidence for a gated seam, pole, or
billboard fixture. Procedural scenes use a same-camera, same-time clouds-OFF/ON
delta so colored polar/dusk lighting cannot fool a bright-neutral-pixel
heuristic; billboard parity retains the neutral-pixel metric. A RED fixture is
a captured renderer defect, not permission to weaken the visibility gate.

Run the moving planetary coordinate oracle:

```powershell
node Tools/visual-regression/probe-cloud-planetary.mjs
```

For the highest-signal pole route and an explicit RTE A/B:

```powershell
$env:CLOUD_PLANETARY_ROUTES = "north-pole"
$env:CLOUD_RTE_MODE = "on"
node Tools/visual-regression/probe-cloud-planetary.mjs
$env:CLOUD_RTE_MODE = "off"
node Tools/visual-regression/probe-cloud-planetary.mjs
Remove-Item Env:CLOUD_PLANETARY_ROUTES
Remove-Item Env:CLOUD_RTE_MODE
```

`CLOUD_PLANETARY_ROUTES` accepts `antimeridian`, `north-pole`,
`south-pole`, and `altitude`; `CLOUD_RTE_MODE` accepts `default`, `on`, or
`off`. Consecutive checkpoints are joined by 12 deterministic camera-motion
frames by default; set `CLOUD_PLANETARY_TRANSITION_FRAMES` to another positive
integer when a longer motion trace is required. The probe then renders clouds
OFF/ON at the same settled camera and fixed time, so its raw-canvas delta
isolates actual cloud contribution from sky and terrain. Mode and selected
route set are part of every artifact name, preventing an explicit RTE A/B or a
subset smoke from overwriting another run. PNG pairs and
`cloud-planetary-<mode>-<route-set>-truth.json` land under
`Tools/visual-regression/output/cloud-planetary/`. Missing delta,
configuration/realization mismatch, a skipped lazy renderer, or a WebGPU/device
error fails the run. Each truth record also carries the source commit/dirty
state and runtime-bundle byte length/SHA-256 so a stale build cannot silently
certify the reviewed source.

Run the fixed-time temporal sequence at either implemented temporal tier:

```powershell
$env:TEMPORAL_TIER = "medium"
node Tools/visual-regression/probe-cloud-temporal.mjs
Remove-Item Env:TEMPORAL_TIER
```

Use `low` in place of `medium` for the other tier. Outputs are
`Tools/visual-regression/output/cloud-temporal/<tier>-static-converged.png`,
`<tier>-moving-mid.png`, `<tier>-moving-settle.png`, and
`<tier>-truth.json`. The truth file records the effective time, exact resolved
configuration, and browser errors; a configuration mismatch or new
console/page error fails the run.

Run the current fixed-scene maximum-throughput characterization:

```powershell
$env:CLOUD_PERF_PAIR_ID = "w5-local-2026-07-23"
$env:TAG = "adaptive"
node Tools/visual-regression/probe-cloud-perf.mjs
Remove-Item Env:CLOUD_PERF_PAIR_ID
Remove-Item Env:TAG
```

This writes `Tools/visual-regression/output/cloud-perf-<tag>.png` and `.json`,
records its metric as `gpu-queue-drain-max-throughput`, and gates configuration
truth, an actual lazy-renderer execute, `maxSteps=128`, the full-resolution
non-temporal target path, WebGPU device/browser errors, and cloud-pixel
liveness. `TAG` is only an artifact label: it does not select an implementation. A valid
adaptive/fixed A/B requires running separately checked-out implementations
under their matching tags and the same explicit `CLOUD_PERF_PAIR_ID`. The
probe records source/runtime-bundle identity, adapter, browser, and canvas
dimensions; it rejects an unpaired, same-bundle, stale, invalid, or differently
configured companion artifact. When a pair ID is supplied, the first capture
still writes its artifact but intentionally exits RED until the comparable
companion exists. One tag by itself is not speedup evidence.

Run the zero-frustum scheduling acceptance independently of throughput:

```powershell
node Tools/visual-regression/probe-cloud-empty-frustum.mjs
```

This uses the same black, upward-looking, command-empty view for three phases.
Both the managed default collection and a real user-owned volumetric
`CloudCollection` (with the managed collection off) must retain zero frustums
while reaching resource setup, post-processing, environmental effects, the
procedural cloud renderer, and the canvas. The final all-clouds-disabled phase
requires the same zero-frustum scene calls to retain the true-empty fast path
and skip those stages. The JSON truth record and three PNGs land under
`Tools/visual-regression/output/cloud-empty-frustum/`.

The moving-camera volumetric lane reuses the canonical 20-second,
18,000-km-to-300-m route and is restricted by the workload manifest to WebGPU:

```powershell
node Tools/visual-regression/run-performance-campaign.mjs `
  --workload moving-camera-cloud-altitude-track-3d `
  --renderer webgpu `
  --repetitions 1 `
  --output Tools/visual-regression/output/performance/campaign13-cloud-route.json
```

It records the fixed cloud configuration in `featureState`: coverage `0.5`,
density `0.75`, layer `1500–3800 m`, medium temporal quality, `64` march steps,
and weather-map animation, wind, shadows/cascades, cloud IBL, multi-deck, and
other optional paths disabled; the production high-precision WGS84 path is
enabled. It asserts WebGPU, rejects external
requests/page/device errors, and requires aligned evidence for every route
segment and route completion. It also requires the cloud renderer to have
realized its raymarch, temporal resolve, upscale, current target, and history
target; configuration round-trip alone is not execution evidence. Compare it
only with a WebGPU run of
`moving-camera-altitude-track-3d`, never with a WebGL volumetric result.
An explicit cloud workload request using `--renderer webgl` or `both` fails
instead of silently dropping WebGL. An implicit all-workload campaign records
that per-workload renderer skip in the report.

These Slice A artifacts are characterization, not a performance-promotion
claim. In particular, the cloud-on and cloud-off workloads are not yet executed
as a cross-workload counterbalanced pair, so launch order, thermal drift, and
browser state can bias their delta. Static dateline/pole views also do not prove
dynamic seam crossings, RTE correctness, regional weather, or temporal-history
validity. C13-01 remains incomplete until the remaining fixtures and evidence
gates in the Campaign 13 queue are implemented.

## Why no external deps

This scaffold deliberately avoids `pixelmatch`/`pngjs`/`jimp` so the
script can be invoked from any contributor's checkout without a
package install. The diff function is intentionally simple — once we
have stable baselines we can replace it with a Wasserstein/SSIM
implementation if needed.

### Exception: `sharp` for the Campaign 13 cloud evidence probes

The dependency-free rule holds for the split-screen diff scaffold above. The
one deliberate exception is the Campaign 13 cloud image-analysis path
(`lib/cloud-image-analysis.mjs` and the `probe-cloud-*` evidence probes, e.g.
`probe-cloud-perf.mjs` / `probe-cloud-empty-frustum.mjs`), which decodes and
statistically characterizes captured cloud PNGs (baked-noise periodicity,
coherent-band density, cloud-cell counts) rather than doing a raw RGBA diff.
That analysis uses [`sharp`](https://www.npmjs.com/package/sharp) for fast PNG
decode. `sharp` was previously reachable only TRANSITIVELY (via
`@cesium/sandcastle → @huggingface/transformers → sharp@0.34.5`), which is
fragile — a sandcastle/transformers bump could silently drop it. It is now
declared as a pinned root devDependency (`sharp: ^0.34.5`, matching the
transitively-resolved 0.34.x) so the cloud evidence tooling has a first-class,
version-stable dependency. The core split-screen diff remains dep-free.

## Cross-backend Sandcastle runner

`cross-backend-sandcastle-runner.mjs` is a separate harness that runs
each Sandcastle gallery demo TWICE — once forced to WebGL and once to
WebGPU — and writes per-demo PNGs + a combined `report.json`. Outputs
land in `Tools/visual-regression/output/cross-backend/` (gitignored).

```bash
# Full sweep — all 229 demos. Wipes output/cross-backend/ first.
node Tools/visual-regression/cross-backend-sandcastle-runner.mjs

# Single demo by exact filename
node Tools/visual-regression/cross-backend-sandcastle-runner.mjs \
  --exact "Hello World.html"

# Multiple demos (group). OR-match on substring.
node Tools/visual-regression/cross-backend-sandcastle-runner.mjs \
  --include "Hello World,Atmosphere,Globe Materials"

# Whole 3D-Tiles batch except Yemen + BIM
node Tools/visual-regression/cross-backend-sandcastle-runner.mjs \
  --include "3D Tiles" --exclude "Yemen,BIM"

# Preview the selection without running anything
node Tools/visual-regression/cross-backend-sandcastle-runner.mjs \
  --include "CZML" --list

# Get the full flag reference
node Tools/visual-regression/cross-backend-sandcastle-runner.mjs --help
```

Selection flags:

| Flag               | Behavior                                                   |
| ------------------ | ---------------------------------------------------------- |
| `--exact "X.html"` | Exact filename(s), comma-separated. Bypasses substring.    |
| `--include "A,B"`  | Substring OR-match (repeatable). Case-insensitive.         |
| `--exclude "X,Y"`  | Drop demos matching any substring. Applied last.           |
| `--filter "X"`     | Single substring (legacy; same effect as `--include "X"`). |
| `--start N`        | Skip the first N selected demos.                           |
| `--limit N`        | Cap to N demos after slicing.                              |
| `--list`           | Print selected demos, do not render.                       |
| `--headed`         | Visible browser window (debugging).                        |
| `--help` / `-h`    | Print usage and exit.                                      |

**Output-dir wipe behavior**: a full sweep (no selection knob set)
clears `output/cross-backend/*.png` + `report.json` at the start so a
prior partial run can't leave stale screenshots. Subset runs (any
`--exact` / `--include` / `--exclude` / `--filter` / `--start` /
`--limit`) preserve the existing files and only overwrite the demos
they intend to render — useful when iterating on a fix without losing
the rest of the sweep's output.

Use `analyze-cross-backend-report.mjs` to bucket the report into
WebGPU-only regressions / both-OK / etc.

## Standalone diagnostic probes

Alongside the split-screen battery, standalone `probe-*.mjs` scripts target one
subsystem each (see the probe inventory in `migration_doc/DEBUGGING_GUIDE.md`).
Notable:

- `probe-frustum-count-3d.mjs` — **default-3D frustum-count parity gate (C10-01).**
  Records `scene.numberOfFrustums` for WebGL vs WebGPU at 18,000 km / 500 km /
  300 m plus a sky-only leg, with per-frustum `ENVIRONMENT`/`GLOBE` bin counts and
  PNGs. Asserts WebGPU count `=== 1 === WebGL` (pre-fix WebGPU floored at 2
  because BV-less `Pass.ENVIRONMENT` commands widened near/far). Server on :8080
  first. `node Tools/visual-regression/probe-frustum-count-3d.mjs [both|webgl|webgpu]`.

## Known caveats

- The diff is sensitive to **timing**: imagery tiles may load in
  different orders between WebGL and WebGPU, so a high `settleFrames`
  is recommended (currently 30).
- Edge / Chromium WebGPU requires a compatible adapter — if the
  WebGPU canvas is blank, check `chrome://gpu` first.
- The hand-rolled PNG encoder uses uncompressed deflate blocks, so
  output files are larger than zlib-compressed PNGs. They are valid
  and viewable in any image tool.
