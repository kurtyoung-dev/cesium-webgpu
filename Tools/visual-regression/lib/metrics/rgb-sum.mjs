// rgb-sum.mjs — the channel-SUM family of pixel metrics the globe probes share.
// @purpose Pure RGBA metrics built on the per-pixel channel sum |dR|+|dG|+|dB| or R+G+B: the kit's one summed-delta mismatch engine (with per-leg and signed channel means and an optional mismatch mask), the fraction of a region below a sum ceiling, and the mean channel average over a region.
// @status ACTIVE
//
// WHY THIS IS NOT `image-diff.mjs`. `diffImages` (and `png-decode.mjs`'s
// `diffPixels`) call a pixel changed when its LARGEST channel delta exceeds a
// tolerance. Five globe probes (`probe-globe-clippoly-geodetic`,
// `probe-globe-translucency`, `probe-globe-underground`,
// `probe-globe-polar-stretch`, and the retired `probe-globe-farzoom`) each
// carried a private copy of a different rule, and the polar imagery baselines
// (`polar-parity.mjs`) were banked under it too: a pixel mismatches when the
// SUM of its three channel deltas exceeds a threshold (30 for the globe
// probes; 24 or 30 for the two polar rules). The two rules disagree on every
// pixel whose delta is spread across channels (three deltas of 12 sum to 36
// and trip a sum rule at 30; their maximum is 12 and trips neither tolerance
// 16 nor 30), so the banked limits those probes carry (mismatch <= 0.27 % at
// mid zoom, the baseline-relative translucency limits, the polar baselines)
// are limits on THIS number and cannot be re-read through `diffImages`
// without re-deriving every one of them.
//
// ONE ENGINE. `rgbSumDiff` below is the kit's only implementation of the
// summed-delta rule. `polar-parity.mjs`'s `channelSumParity` is its inset
// region, one call into `rgbSumDiff` and the brightness ratio of the two
// legs' means. A new channel-sum measure belongs here as an option or a
// returned field, not as another loop.
//
// WHAT MOVED, AND HOW IT IS HELD TO THE OLD BYTES. Each function below is the
// body those probes ran inside `page.evaluate`, moved to Node so it runs over
// decoded PNG bytes instead of an in-page canvas. `metrics-globe-extraction.spec.mjs`
// compares every function against the ORIGINAL in-page source, sliced verbatim
// from the probes at `7e12d8f1d0` and run over the synthetic fixtures in
// `fixtures/globe-metrics-inputs.mjs`; the golden it compares against is
// `fixtures/globe-metrics.golden.json`.
//
// Pure: no I/O, no browser, no gate decision. The probes own their limits.

import { luminance } from "./luminance.mjs";

/**
 * @typedef {{width: number, height: number, data: ArrayLike<number>}} RgbaImage
 * @typedef {{x0: number, y0: number, x1: number, y1: number}} Roi Half-open pixel bounds.
 */

function wholeImage(image) {
  return { x0: 0, y0: 0, x1: image.width, y1: image.height };
}

function requireRoiInside(image, roi, what) {
  const inside =
    Number.isInteger(roi.x0) &&
    Number.isInteger(roi.y0) &&
    Number.isInteger(roi.x1) &&
    Number.isInteger(roi.y1) &&
    roi.x0 >= 0 &&
    roi.y0 >= 0 &&
    roi.x1 <= image.width &&
    roi.y1 <= image.height &&
    roi.x0 < roi.x1 &&
    roi.y0 < roi.y1;
  if (!inside) {
    // The in-page originals never clamped: a box that ran off the canvas read
    // `undefined` channels and silently counted them. Failing closed here is
    // the only behaviour change, and it applies only to inputs the probes
    // never pass.
    throw new RangeError(
      `${what}: roi ${JSON.stringify(roi)} is not a non-empty integer box inside ${image.width}x${image.height}`,
    );
  }
}

/**
 * The summed-channel mismatch between two same-sized images.
 *
 * A pixel mismatches when `|dR| + |dG| + |dB| > threshold` (strictly greater,
 * as every original wrote it). `meanAbsSum` is the mean of that summed delta
 * over the counted pixels, and `meanSigned` is the mean of `second - first`
 * per channel — the sign convention the originals used (`sumDR += b - a`).
 * `meanFirst` / `meanSecond` are each leg's mean channel value
 * `(R + G + B) / 3` over the counted pixels, from which `polar-parity.mjs`
 * reads its brightness ratio. Alpha is never read.
 *
 * @param {RgbaImage} first
 * @param {RgbaImage} second
 * @param {{threshold?: number, roi?: Roi, returnMask?: boolean}} [options]
 *   `threshold` defaults to 30. `roi` restricts the counted pixels (default the
 *   whole image). `returnMask` also returns a row-major `Uint8Array` over the
 *   ROI with 1 at each mismatching pixel.
 * @returns {{countedPx: number, mismatchPx: number, mismatchPct: number,
 *   meanAbsSum: number, meanSigned: {r: number, g: number, b: number},
 *   meanFirst: number, meanSecond: number, meanMismatchLuma: number,
 *   mask: Uint8Array|null, roi: Roi}}
 *   `meanMismatchLuma` is the mean, over the MISMATCHING pixels only, of the
 *   Rec. 709 luma of `second - first` (0 when none mismatch) — the retired
 *   `probe-globe-farzoom`'s same-backend drape magnitude, read as
 *   `rgbSumDiff(off, on, {threshold: 12, roi})` for "on minus off".
 */
export function rgbSumDiff(first, second, options = {}) {
  if (first.width !== second.width || first.height !== second.height) {
    throw new RangeError(
      `rgbSumDiff: size mismatch ${first.width}x${first.height} vs ${second.width}x${second.height}`,
    );
  }
  const threshold = options.threshold ?? 30;
  const roi = options.roi ?? wholeImage(first);
  requireRoiInside(first, roi, "rgbSumDiff");
  const width = first.width;
  const a = first.data;
  const b = second.data;
  const roiWidth = roi.x1 - roi.x0;
  const mask = options.returnMask
    ? new Uint8Array(roiWidth * (roi.y1 - roi.y0))
    : null;

  let counted = 0;
  let mismatch = 0;
  let sum = 0;
  let sumDR = 0;
  let sumDG = 0;
  let sumDB = 0;
  let sumMismatchLuma = 0;
  let sumFirst = 0;
  let sumSecond = 0;
  for (let y = roi.y0; y < roi.y1; y++) {
    for (let x = roi.x0; x < roi.x1; x++) {
      const i = 4 * (y * width + x);
      counted++;
      const dr = Math.abs(a[i] - b[i]);
      const dg = Math.abs(a[i + 1] - b[i + 1]);
      const db = Math.abs(a[i + 2] - b[i + 2]);
      const d = dr + dg + db;
      sum += d;
      if (d > threshold) {
        mismatch++;
        if (mask) {
          mask[(y - roi.y0) * roiWidth + (x - roi.x0)] = 1;
        }
        sumMismatchLuma += luminance(
          b[i] - a[i],
          b[i + 1] - a[i + 1],
          b[i + 2] - a[i + 2],
        );
      }
      sumDR += b[i] - a[i];
      sumDG += b[i + 1] - a[i + 1];
      sumDB += b[i + 2] - a[i + 2];
      sumFirst += a[i] + a[i + 1] + a[i + 2];
      sumSecond += b[i] + b[i + 1] + b[i + 2];
    }
  }
  return {
    countedPx: counted,
    mismatchPx: mismatch,
    mismatchPct: (100 * mismatch) / counted,
    meanAbsSum: sum / counted,
    meanSigned: { r: sumDR / counted, g: sumDG / counted, b: sumDB / counted },
    meanFirst: sumFirst / (3 * counted),
    meanSecond: sumSecond / (3 * counted),
    meanMismatchLuma: mismatch > 0 ? sumMismatchLuma / mismatch : 0,
    mask,
    roi,
  };
}

/**
 * The fraction of a region whose channel sum `R + G + B` is below a ceiling —
 * `probe-globe-clippoly-geodetic`'s "the hole shows the black background" test.
 *
 * @param {RgbaImage} image
 * @param {Roi} roi
 * @param {{ceiling?: number}} [options] `ceiling` defaults to 60 (strictly below).
 * @returns {{fraction: number, belowPx: number, countedPx: number}}
 */
export function rgbSumBelowFraction(image, roi, options = {}) {
  const ceiling = options.ceiling ?? 60;
  requireRoiInside(image, roi, "rgbSumBelowFraction");
  const data = image.data;
  let below = 0;
  let total = 0;
  for (let y = roi.y0; y < roi.y1; y++) {
    for (let x = roi.x0; x < roi.x1; x++) {
      const i = (y * image.width + x) * 4;
      const sum = data[i] + data[i + 1] + data[i + 2];
      if (sum < ceiling) below++;
      total++;
    }
  }
  return { fraction: below / total, belowPx: below, countedPx: total };
}

/**
 * The mean of `(R + G + B) / 3` over a region — `probe-globe-hdr-gamma`'s
 * known-gray patch mean.
 *
 * @param {RgbaImage} image
 * @param {Roi} roi
 * @returns {number}
 */
export function rgbMeanInRoi(image, roi) {
  requireRoiInside(image, roi, "rgbMeanInRoi");
  const data = image.data;
  let sum = 0;
  let n = 0;
  for (let y = roi.y0; y < roi.y1; y++) {
    for (let x = roi.x0; x < roi.x1; x++) {
      const i = 4 * (y * image.width + x);
      sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
      n++;
    }
  }
  return sum / n;
}

/**
 * The square region `[cx - half, cx + half) x [cy - half, cy + half)` the
 * originals iterated, as a half-open ROI.
 *
 * @param {number} cx
 * @param {number} cy
 * @param {number} half
 * @returns {Roi}
 */
export function centredSquare(cx, cy, half) {
  return { x0: cx - half, y0: cy - half, x1: cx + half, y1: cy + half };
}
