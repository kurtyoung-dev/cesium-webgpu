# WebGPU Visual Regression

Captures the WebGL and WebGPU canvases from the split-screen comparison page,
diffs them pixel-by-pixel, and reports per-scene mismatch ratios. Designed
for opt-in CI gating once the WebGPU backend approaches visual parity.

## Quick start

```bash
# 1. Start the dev server in another terminal
npm run restart

# 2. Run the regression suite
node Tools/visual-regression/capture-and-diff.mjs

# 3. Inspect output
ls Tools/visual-regression/output/
# - <scene>.webgl.png   captured WebGL canvas
# - <scene>.webgpu.png  captured WebGPU canvas
# - <scene>.diff.png    red pixels = mismatch (gray = matching context)
# - report.json         per-scene diff ratios + pass/fail
```

## Flags

| Flag                                          | Default  | Notes                                                     |
| --------------------------------------------- | -------- | --------------------------------------------------------- |
| `--update`                                    | off      | Promote current outputs to `baseline/`                    |
| `--scene NAME`                                | all      | Run only the named scene from `scenes.json`               |
| `--threshold N`                               | `0.02`   | Fail when any scene's diff ratio exceeds N                |
| `--browser msedge\|chromium\|firefox\|webkit` | `msedge` | Playwright browser; Edge is preferred for Chromium WebGPU |
| `--headed`                                    | off      | Show the browser window (for debugging)                   |

Exit code: `0` when every scene is under threshold, `1` on any failure,
`2` on bad arguments, `99` on uncaught errors.

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
node Tools/visual-regression/capture-and-diff.mjs --scene high-density-5k-spheres --update
# review the captured PNGs in Tools/visual-regression/output/, then promote:
# (the --update flag above already promotes outputs to baseline/)
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
5. Encodes baseline / current / diff PNGs from raw RGBA without
   any external dependencies.

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

## Known caveats

- The diff is sensitive to **timing**: imagery tiles may load in
  different orders between WebGL and WebGPU, so a high `settleFrames`
  is recommended (currently 30).
- Edge / Chromium WebGPU requires a compatible adapter — if the
  WebGPU canvas is blank, check `chrome://gpu` first.
- The hand-rolled PNG encoder uses uncompressed deflate blocks, so
  output files are larger than zlib-compressed PNGs. They are valid
  and viewable in any image tool.
