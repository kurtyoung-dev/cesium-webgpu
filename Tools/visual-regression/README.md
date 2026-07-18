# WebGPU Visual Regression

Captures the WebGL and WebGPU canvases from the split-screen comparison page,
diffs them pixel-by-pixel, and reports per-scene mismatch ratios. Designed
for opt-in CI gating once the WebGPU backend approaches visual parity.

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

When `camera` is `null` the page's default initial view is used.

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

## Why no external deps

This scaffold deliberately avoids `pixelmatch`/`pngjs`/`jimp` so the
script can be invoked from any contributor's checkout without a
package install. The diff function is intentionally simple — once we
have stable baselines we can replace it with a Wasserstein/SSIM
implementation if needed.

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
