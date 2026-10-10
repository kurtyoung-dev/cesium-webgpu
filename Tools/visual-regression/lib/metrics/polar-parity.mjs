// polar-parity.mjs — the channel-sum parity rule the polar imagery baselines
// were banked under.
// @purpose Pure RGBA WebGL-vs-WebGPU parity over a per-pixel channel-sum delta and an inset region (mismatch percent, mean summed delta, brightness ratio), under the two named rules the polar baselines were banked with.
// @status ACTIVE
//
// WHY NOT `image-diff.mjs`, AND WHERE THE RULE LIVES. The polar imagery
// numbers on record were taken under the summed-delta rule
// `|dR| + |dG| + |dB| > threshold`, not `image-diff.mjs`'s largest-channel
// rule. Why the two cannot be read through each other is written once, in
// `rgb-sum.mjs`'s header. This module does not implement the rule:
// `channelSumParity` is the inset region below, one call into `rgb-sum.mjs`'s
// `rgbSumDiff` (the kit's one channel-sum engine) and the brightness ratio of
// the two legs' means. What this module owns is the rule TABLE: the threshold
// and the region each banked polar figure was taken under.
//
// TWO RULES, BOTH ON RECORD, AND THEY ARE NOT THE SAME NUMBER. Measured on the
// banked frames under `Tools/visual-regression/output/` (lane Edoras, Node,
// 2026-10-08):
//
//   - `centre80-sum24` is `probe-polar-diff-all.mjs`'s in-page rule: the
//     central 80 % of the frame (x in [floor(0.1 w), floor(0.9 w)), y likewise),
//     mismatch when the summed delta is strictly greater than 24, plus the mean
//     summed delta and the ratio of the two legs' mean channel values. Run over
//     the six `polar-multi-*` frame pairs that probe last diffed, this module
//     reproduces its banked `polar-multi-diff-report.json`
//     (2026-05-19T18:54:58Z) exactly: every mismatch count, mean delta and
//     brightness ratio, to the last digit.
//   - `frame-sum30` is the rule behind the post-fix numbers the debugging log
//     records for GLOBE-POLAR-STRETCH (2026-07-02) and `IMAGERY_PROJECTION.md`
//     names as the baseline to gate against: the whole frame, summed delta
//     strictly greater than 30. Over the six `polar-plain-*` pairs banked that
//     day it gives 2.39 / 6.35 / 2.72 / 5.36 / 1.18 / 1.47 %, the six figures
//     on record to two decimals. Under `centre80-sum24` the same frames read
//     2.19 / 6.05 / 1.74 / 4.57 / 0.07 / 0.20 %, so a figure is only
//     comparable to another taken under the same rule.
//
// A SIZE MISMATCH THROWS. Two frames of different sizes have no pixel
// correspondence, so there is no parity number to report; returning one (or a
// null a caller could read as "nothing differed") would let a check pass over
// a pair it never compared. The caller's run fails instead.
//
// Pure: no I/O, no browser, no gate decision. A probe owns any limit it
// applies to these numbers.

import { rectRoi } from "./masks.mjs";
import { rgbSumDiff } from "./rgb-sum.mjs";

/**
 * @typedef {{width: number, height: number, data: ArrayLike<number>}} RgbaImage
 * @typedef {{x0: number, y0: number, x1: number, y1: number}} Roi Half-open pixel bounds.
 */

/**
 * The two rules the polar baselines were banked under, by id. Add-only: a
 * rule's numbers are only comparable to numbers taken under the same rule, so
 * changing one in place would silently re-base every figure recorded against
 * it.
 */
export const POLAR_PARITY_RULES = Object.freeze({
  "centre80-sum24": Object.freeze({
    threshold: 24,
    insetFraction: 0.1,
    provenance:
      "probe-polar-diff-all.mjs in-page rule; reproduces its banked polar-multi-diff-report.json (2026-05-19T18:54:58Z) exactly",
  }),
  "frame-sum30": Object.freeze({
    threshold: 30,
    insetFraction: 0,
    provenance:
      "the rule behind the GLOBE-POLAR-STRETCH (2026-07-02) polar-plain figures IMAGERY_PROJECTION.md names as the baseline",
  }),
});

function requireImage(image, what) {
  const ok =
    image !== null &&
    typeof image === "object" &&
    Number.isInteger(image.width) &&
    Number.isInteger(image.height) &&
    image.width > 0 &&
    image.height > 0 &&
    image.data !== undefined &&
    image.data.length >= image.width * image.height * 4;
  if (!ok) {
    throw new TypeError(
      `${what} must be a decoded RGBA image {width, height, data} with width*height*4 channel values`,
    );
  }
}

/**
 * The inset region `probe-polar-diff-all.mjs` measured: `insetFraction` of the
 * frame trimmed from every edge, with the original's flooring
 * (`floor(0.1 w)` to `floor(0.9 w)`), as `masks.mjs`'s half-open `rectRoi`.
 * An inset of 0 is the whole frame.
 *
 * @param {number} width
 * @param {number} height
 * @param {number} insetFraction In `[0, 0.5)`.
 * @returns {Roi}
 */
export function insetRoi(width, height, insetFraction) {
  if (
    typeof insetFraction !== "number" ||
    !Number.isFinite(insetFraction) ||
    insetFraction < 0 ||
    insetFraction >= 0.5
  ) {
    throw new RangeError(
      `insetFraction must be a finite number in [0, 0.5), received ${String(insetFraction)}`,
    );
  }
  const x0 = Math.floor(width * insetFraction);
  const y0 = Math.floor(height * insetFraction);
  return rectRoi({
    width,
    height,
    x: x0,
    y: y0,
    w: Math.floor(width * (1 - insetFraction)) - x0,
    h: Math.floor(height * (1 - insetFraction)) - y0,
  });
}

/**
 * The channel-sum parity of two same-sized frames.
 *
 * A pixel inside the region mismatches when `|dR| + |dG| + |dB| > threshold`
 * (strictly greater, as the original wrote it). `meanAbsSum` is the mean of
 * that summed delta over the region; `meanFirst` / `meanSecond` are each leg's
 * mean channel value `(R + G + B) / 3` over the region, and `brightnessRatio`
 * is `meanFirst / meanSecond` — `Infinity` when the second leg's mean is 0, as
 * the original returned it. Alpha is never read.
 *
 * @param {RgbaImage} first The WebGL leg, in every polar caller.
 * @param {RgbaImage} second The WebGPU leg, in every polar caller.
 * @param {{threshold: number, insetFraction: number}} rule
 * @returns {{width: number, height: number, roi: Roi, countedPx: number,
 *   mismatchPx: number, mismatchPct: number, meanAbsSum: number,
 *   meanFirst: number, meanSecond: number, brightnessRatio: number}}
 * @throws {RangeError} When the two frames differ in size (see the header).
 */
export function channelSumParity(first, second, rule) {
  requireImage(first, "first");
  requireImage(second, "second");
  if (first.width !== second.width || first.height !== second.height) {
    throw new RangeError(
      `channelSumParity: size mismatch ${first.width}x${first.height} vs ${second.width}x${second.height}; a pair of two sizes has no parity number`,
    );
  }
  const threshold = rule?.threshold;
  if (
    typeof threshold !== "number" ||
    !Number.isFinite(threshold) ||
    threshold < 0
  ) {
    throw new RangeError(
      `rule.threshold must be a finite non-negative number, received ${String(threshold)}`,
    );
  }
  const { width, height } = first;
  const roi = insetRoi(width, height, rule.insetFraction);
  if (roi.x1 <= roi.x0 || roi.y1 <= roi.y0) {
    throw new RangeError(
      `channelSumParity: the inset leaves no pixel of a ${width}x${height} frame to compare`,
    );
  }
  const diff = rgbSumDiff(first, second, { threshold, roi });
  return {
    width,
    height,
    roi,
    countedPx: diff.countedPx,
    mismatchPx: diff.mismatchPx,
    mismatchPct: diff.mismatchPct,
    meanAbsSum: diff.meanAbsSum,
    meanFirst: diff.meanFirst,
    meanSecond: diff.meanSecond,
    brightnessRatio:
      diff.meanSecond > 0 ? diff.meanFirst / diff.meanSecond : Infinity,
  };
}

/**
 * Both banked rules over one WebGL/WebGPU pair, keyed by rule id.
 *
 * @param {RgbaImage} webgl
 * @param {RgbaImage} webgpu
 * @returns {Record<string, ReturnType<typeof channelSumParity>>}
 */
export function polarParity(webgl, webgpu) {
  const result = {};
  for (const [id, rule] of Object.entries(POLAR_PARITY_RULES)) {
    result[id] = channelSumParity(webgl, webgpu, rule);
  }
  return result;
}
