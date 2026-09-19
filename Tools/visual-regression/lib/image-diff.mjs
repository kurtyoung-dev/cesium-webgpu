/**
 * One pixel diff for the probe fleet, extracted from the probes that hand-roll
 * their own copy.
 * @purpose Pure per-channel RGBA pixel diff (tolerance + optional mask) returning mismatch stats and a paint-ready diff buffer, no I/O and no gate policy.
 * @status ACTIVE
 *
 * TOLERANCE IS ABSOLUTE, NOT A FRACTION. `Tools/visual-regression/lib/visual-gate-policy.mjs`'s
 * `compareCaptures(current, reference, tolerance = 16)` compares
 * `Math.abs(a[i] - b[i]) > tolerance` against raw `Uint8ClampedArray` channel
 * values (0-255) — so its default of `16` is sixteen levels out of 255, roughly
 * 6%, not the fraction `16/255`. This module keeps that same reading: its
 * default `tolerance` is `16`, applied the same way, over the same 0-255
 * range. Treating it as `16/255` would silently make every caller ~16x
 * stricter.
 *
 * WHAT THIS MODULE IS NOT. `evaluatePixelGate` in `visual-gate-policy.mjs`
 * still owns PASS/FAIL/NON_CERTIFYING policy, thresholds and manifest
 * validation — this module does not fork any of that. It is the one
 * mechanical step (compare two decoded RGBA buffers, count what differs,
 * paint a diff) that `compareCaptures` and several probes each reimplement
 * slightly differently; a caller that wants a gate decision still goes to
 * `visual-gate-policy.mjs`.
 *
 * MASK POLARITY. A mask pixel/predicate result is read as "counted" (masked
 * IN), matching the natural sense of "this pixel is part of what I'm
 * measuring" — not "this pixel is masked out". A pixel excluded by the mask
 * contributes to neither `changedPx` nor the `mismatchPct` denominator, and
 * always renders through the unchanged (dimmed) branch of `diffRgba`
 * regardless of how far apart its channels are.
 */

const DEFAULT_TOLERANCE = 16;

/**
 * Whether a pixel counts toward the diff, given the caller's mask option.
 *
 * @param {undefined | ArrayLike<unknown> | ((byteOffset: number, aData: Uint8ClampedArray, bData: Uint8ClampedArray) => boolean)} mask
 * @param {number} pixelIndex Row-major pixel index (0..width*height-1).
 * @param {number} byteOffset RGBA byte offset of the pixel (`pixelIndex * 4`).
 * @param {Uint8ClampedArray} aData
 * @param {Uint8ClampedArray} bData
 * @returns {boolean} `true` when the pixel is counted (masked in).
 */
function isCounted(mask, pixelIndex, byteOffset, aData, bData) {
  if (mask === undefined) {
    return true;
  }
  if (typeof mask === "function") {
    return !!mask(byteOffset, aData, bData);
  }
  return !!mask[pixelIndex];
}

/**
 * Diff two decoded RGBA images, per channel, with an optional pixel mask.
 *
 * Pure and I/O-free: both inputs are already-decoded `{width, height, data}`
 * buffers and nothing here touches a filesystem, a browser, or a gate
 * threshold decision (see the module header).
 *
 * @param {{width: number, height: number, data: ArrayLike<number>}} a Current capture.
 * @param {{width: number, height: number, data: ArrayLike<number>}} b Reference capture.
 * @param {{tolerance?: number, mask?: ArrayLike<unknown> | ((byteOffset: number, aData: Uint8ClampedArray, bData: Uint8ClampedArray) => boolean)}} [options]
 *   `tolerance` is a per-channel absolute value on 0-255 data, default 16
 *   (see the module header — this is NOT a 0-1 fraction). `mask`, when given,
 *   is either a `length === width*height` array-like read by pixel index, or
 *   a predicate read by RGBA byte offset; either way a truthy result means the
 *   pixel is counted (see MASK POLARITY above).
 * @returns {{mismatchPct: number | null, changedPx: number, bbox: {x0: number, y0: number, x1: number, y1: number} | null, diffRgba: Uint8ClampedArray}}
 *   `mismatchPct` is a PERCENT (0-100) over the counted population, `null`
 *   when that population is zero — deliberately not the 0-1 ratio
 *   `compareCaptures` returns, so the two are never silently interchangeable.
 *   `bbox` is the inclusive pixel-coordinate bounds of the changed pixels, or
 *   `null` when none changed. `diffRgba` renders changed pixels opaque red
 *   and everything else (including masked-out pixels) the same dimmed grey
 *   `compareCaptures` uses, byte-for-byte, so one can stand in for the other
 *   in an existing PNG-writing caller without the artifact changing.
 */
export function diffImages(a, b, options = {}) {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(
      `Dimension mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}`,
    );
  }

  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const mask = options.mask;
  const width = a.width;
  const height = a.height;
  const aData = new Uint8ClampedArray(a.data);
  const bData = new Uint8ClampedArray(b.data);
  const diffRgba = new Uint8ClampedArray(width * height * 4);

  let changedPx = 0;
  let countedPixels = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixelIndex = y * width + x;
      const i = pixelIndex * 4;
      const counted = isCounted(mask, pixelIndex, i, aData, bData);
      let changed = false;
      if (counted) {
        countedPixels++;
        const dr = Math.abs(aData[i] - bData[i]);
        const dg = Math.abs(aData[i + 1] - bData[i + 1]);
        const db = Math.abs(aData[i + 2] - bData[i + 2]);
        changed = dr > tolerance || dg > tolerance || db > tolerance;
      }
      if (changed) {
        changedPx++;
        diffRgba[i] = 255;
        diffRgba[i + 1] = 0;
        diffRgba[i + 2] = 0;
        diffRgba[i + 3] = 255;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      } else {
        const dim = ((aData[i] + aData[i + 1] + aData[i + 2]) / 3) * 0.25;
        diffRgba[i] = dim;
        diffRgba[i + 1] = dim;
        diffRgba[i + 2] = dim;
        diffRgba[i + 3] = 255;
      }
    }
  }

  const bbox =
    changedPx > 0 ? { x0: minX, y0: minY, x1: maxX, y1: maxY } : null;
  const mismatchPct =
    countedPixels > 0 ? (100 * changedPx) / countedPixels : null;

  return { mismatchPct, changedPx, bbox, diffRgba };
}

/**
 * Caller shim reproducing `probe-model-ktx2-ibl.mjs`'s pre-migration
 * `diffModelPixels(a, b)` output contract — `{modelPx, mismatch, mismatchPct}`
 * over `{w, h, data}` captures, mask = either pixel's luminance above 12,
 * tolerance 24 — as a thin wrapper over `diffImages`.
 *
 * This lives here, not in the probe, so a spec can import and exercise the
 * real migrated logic directly: `probe-model-ktx2-ibl.mjs` launches Playwright
 * captures at module top level (it is a run-as-a-script probe, not a library),
 * so importing it to reach one function would launch a browser as a side
 * effect of the import.
 *
 * @param {{w: number, h: number, data: ArrayLike<number>}} a
 * @param {{w: number, h: number, data: ArrayLike<number>}} b
 * @returns {{modelPx: number, mismatch: number, mismatchPct: number | null}}
 */
export function diffModelPixelsAdapter(a, b) {
  if (a.w !== b.w || a.h !== b.h) {
    return { modelPx: 0, mismatch: 0, mismatchPct: null };
  }

  const lumMask = (byteOffset, aData, bData) => {
    const aLum =
      aData[byteOffset] + aData[byteOffset + 1] + aData[byteOffset + 2];
    const bLum =
      bData[byteOffset] + bData[byteOffset + 1] + bData[byteOffset + 2];
    return aLum > 12 || bLum > 12;
  };

  const { changedPx } = diffImages(
    { width: a.w, height: a.h, data: a.data },
    { width: b.w, height: b.h, data: b.data },
    { tolerance: 24, mask: lumMask },
  );

  // `diffImages` does not expose the counted-pixel population (only the
  // `mismatchPct` derived from it, which is unrecoverable when changedPx is
  // 0), so the original contract's `modelPx` denominator is re-derived with
  // the same predicate rather than plumbed through as a fifth return field.
  const aData = new Uint8ClampedArray(a.data);
  const bData = new Uint8ClampedArray(b.data);
  let modelPx = 0;
  for (let i = 0; i < aData.length; i += 4) {
    if (lumMask(i, aData, bData)) {
      modelPx++;
    }
  }

  return {
    modelPx,
    mismatch: changedPx,
    mismatchPct: modelPx ? +((100 * changedPx) / modelPx).toFixed(2) : null,
  };
}
