// Behaviour spec for lib/image-diff.mjs — drives the real diffImages() and its
// probe-model-ktx2-ibl.mjs caller shim, asserting returned values only.
// @purpose Pin diffImages's tolerance/mask/bbox contract and prove the migrated probe-model-ktx2-ibl.mjs caller is output-identical to its pre-migration body.
// @status ACTIVE

import assert from "node:assert/strict";
import test from "node:test";
import { diffImages, diffModelPixelsAdapter } from "./lib/image-diff.mjs";
import { compareCaptures } from "./lib/visual-gate-policy.mjs";

function makeImage(width, height, fill) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = fill[0];
    data[i + 1] = fill[1];
    data[i + 2] = fill[2];
    data[i + 3] = fill[3] ?? 255;
  }
  return { width, height, data };
}

function cloneImage(image) {
  return {
    width: image.width,
    height: image.height,
    data: new Uint8ClampedArray(image.data),
  };
}

test("diffImages: a known-identical pair reports zero mismatch and no bbox", () => {
  const a = makeImage(3, 3, [77, 88, 99, 255]);
  const b = cloneImage(a);
  const result = diffImages(a, b);
  assert.strictEqual(result.mismatchPct, 0);
  assert.strictEqual(result.changedPx, 0);
  assert.strictEqual(result.bbox, null);
});

test("diffImages: a hand-countable 4x4 pair returns the hand-derived changedPx, mismatchPct and bbox", () => {
  const width = 4;
  const height = 4;
  const a = makeImage(width, height, [100, 100, 100, 255]);
  const b = cloneImage(a);
  // Push exactly 3 of the 16 pixels past the default tolerance (16), at
  // (1,1), (2,1), (1,2) — (2,2) is left alone so the bbox is pinned to the
  // three moved pixels' own bounds, not the enclosing square.
  for (const [x, y] of [
    [1, 1],
    [2, 1],
    [1, 2],
  ]) {
    b.data[(y * width + x) * 4] = 140; // diff 40, past tolerance 16
  }
  const result = diffImages(a, b);
  assert.strictEqual(result.changedPx, 3);
  assert.strictEqual(result.mismatchPct, (100 * 3) / 16);
  assert.deepStrictEqual(result.bbox, { x0: 1, y0: 1, x1: 2, y1: 2 });
});

test("diffImages: absolute tolerance 16 - a diff of exactly 16 is unchanged, 17 is changed", () => {
  const a = makeImage(1, 1, [100, 100, 100, 255]);
  const atBoundary = makeImage(1, 1, [116, 100, 100, 255]); // diff 16
  const overBoundary = makeImage(1, 1, [117, 100, 100, 255]); // diff 17

  const withinTolerance = diffImages(a, atBoundary);
  assert.strictEqual(withinTolerance.changedPx, 0);
  assert.strictEqual(withinTolerance.mismatchPct, 0);

  const pastTolerance = diffImages(a, overBoundary);
  assert.strictEqual(pastTolerance.changedPx, 1);
  assert.strictEqual(pastTolerance.mismatchPct, 100);
});

test("diffImages: mask excludes pixels from both changedPx and the mismatchPct denominator", () => {
  const width = 2;
  const height = 2;
  const a = makeImage(width, height, [10, 10, 10, 255]);
  const b = cloneImage(a);
  // Pixel indices 1 and 2 diff by 40 (past tolerance); 0 and 3 are identical.
  b.data[1 * 4] = 50;
  b.data[2 * 4] = 50;

  const unmasked = diffImages(a, b);
  assert.strictEqual(unmasked.changedPx, 2);
  assert.strictEqual(unmasked.mismatchPct, 50);

  // Exclude pixel index 1 (one of the two changed pixels): the denominator
  // drops from 4 to 3 and changedPx drops from 2 to 1, so mismatchPct moves
  // from 50 to 100/3 under the SAME two buffers.
  const mask = [1, 0, 1, 1];
  const masked = diffImages(a, b, { mask });
  assert.strictEqual(masked.changedPx, 1);
  assert.strictEqual(masked.mismatchPct, (100 * 1) / 3);
  assert.notStrictEqual(masked.mismatchPct, unmasked.mismatchPct);
});

test("diffImages: diffRgba byte-matches compareCaptures's diff buffer for an unmasked, tolerance-16 pair", () => {
  const width = 5;
  const height = 5;
  const a = {
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4),
  };
  const b = {
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4),
  };
  // Offsets cycle through values below, at, and past the tolerance-16
  // boundary, applied identically to R/G/B, so both implementations see the
  // same spread of changed and unchanged pixels.
  const offsets = [-30, -16, 0, 16, 30];
  for (let k = 0; k < width * height; k++) {
    const i = k * 4;
    const offset = offsets[k % offsets.length];
    const r = (k * 13) % 256;
    const g = (k * 7) % 256;
    const bl = (k * 29) % 256;
    a.data[i] = r;
    a.data[i + 1] = g;
    a.data[i + 2] = bl;
    a.data[i + 3] = 255;
    b.data[i] = r + offset;
    b.data[i + 1] = g + offset;
    b.data[i + 2] = bl + offset;
    b.data[i + 3] = 255;
  }

  const { diff } = compareCaptures(a, b, 16);
  const { diffRgba } = diffImages(a, b, { tolerance: 16 });
  assert.deepStrictEqual(Array.from(diffRgba), Array.from(diff));
});

// The ORIGINAL diffModelPixels(a, b) body, copied verbatim from
// probe-model-ktx2-ibl.mjs as it read before this batch's migration, kept
// here as an independent reference implementation — see PROBE_KIT_PLAN_2026-09-17
// §3.2 / DX-102. Do not "fix" this copy if it looks odd; it must stay
// byte-for-byte what the probe used to run.
function referenceDiffModelPixels(a, b) {
  let modelPx = 0,
    mismatch = 0;
  if (a.w !== b.w || a.h !== b.h)
    return { modelPx: 0, mismatch: 0, mismatchPct: null };
  for (let i = 0; i < a.data.length; i += 4) {
    const aLum = a.data[i] + a.data[i + 1] + a.data[i + 2];
    const bLum = b.data[i] + b.data[i + 1] + b.data[i + 2];
    if (aLum > 12 || bLum > 12) {
      modelPx++;
      if (
        Math.abs(a.data[i] - b.data[i]) > 24 ||
        Math.abs(a.data[i + 1] - b.data[i + 1]) > 24 ||
        Math.abs(a.data[i + 2] - b.data[i + 2]) > 24
      ) {
        mismatch++;
      }
    }
  }
  return {
    modelPx,
    mismatch,
    mismatchPct: modelPx ? +((100 * mismatch) / modelPx).toFixed(2) : null,
  };
}

test("diffImages: the migrated probe caller (diffModelPixelsAdapter) is output-identical to the original diffModelPixels", () => {
  // probe-model-ktx2-ibl.mjs launches Playwright captures as an unguarded
  // top-level await, so importing the probe module itself would launch a
  // browser as a side effect of the import; diffModelPixelsAdapter is the
  // caller-shim route named in the brief instead — the same logic, moved to
  // lib/image-diff.mjs where it is safe to import directly.
  const dimensionMismatch = [
    { w: 2, h: 2, data: new Uint8ClampedArray(16) },
    { w: 3, h: 2, data: new Uint8ClampedArray(24) },
  ];
  const belowLuminanceThreshold = [
    {
      w: 2,
      h: 2,
      data: Uint8ClampedArray.from([
        2, 2, 2, 255, 2, 2, 2, 255, 2, 2, 2, 255, 2, 2, 2, 255,
      ]),
    },
    {
      w: 2,
      h: 2,
      data: Uint8ClampedArray.from([
        2, 2, 2, 255, 2, 2, 2, 255, 2, 2, 2, 255, 2, 2, 2, 255,
      ]),
    },
  ];
  const mixed = [
    {
      w: 2,
      h: 2,
      data: Uint8ClampedArray.from([
        50, 50, 50, 255, 50, 50, 50, 255, 2, 2, 2, 255, 50, 50, 50, 255,
      ]),
    },
    {
      w: 2,
      h: 2,
      data: Uint8ClampedArray.from([
        50, 50, 50, 255, 90, 50, 50, 255, 2, 2, 2, 255, 60, 50, 50, 255,
      ]),
    },
  ];

  for (const [a, b] of [dimensionMismatch, belowLuminanceThreshold, mixed]) {
    assert.deepStrictEqual(
      diffModelPixelsAdapter(a, b),
      referenceDiffModelPixels(a, b),
    );
  }
});
