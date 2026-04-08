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

## Known caveats

- The diff is sensitive to **timing**: imagery tiles may load in
  different orders between WebGL and WebGPU, so a high `settleFrames`
  is recommended (currently 30).
- Edge / Chromium WebGPU requires a compatible adapter — if the
  WebGPU canvas is blank, check `chrome://gpu` first.
- The hand-rolled PNG encoder uses uncompressed deflate blocks, so
  output files are larger than zlib-compressed PNGs. They are valid
  and viewable in any image tool.
