// capture-metrics.mjs — the capture seam's pixel metrics, pure over decoded bytes.
//
// @purpose Metrics piece of capture.mjs: cellMetrics (the per-cell strip of non-black fraction and luma over decoded RGBA) and pairMetrics (the BEFORE-vs-AFTER pixel diff, changed fraction, bounding box, heat-map and mean structural similarity), computed in Node after the browser has closed.
// @status ACTIVE
//
// WHY A PIECE. The metrics moved out of `capture.mjs` when that module passed
// 1,000 lines (DX-KIT-CAPTURE-SEAM-OVER-SIZE). `capture.mjs` re-exports both
// names, so importers are unchanged.

import { diffImages } from "./image-diff.mjs";
import { luminance } from "./metrics/luminance.mjs";
import { structureSimilarityRgba } from "./metrics/structure-similarity.mjs";
import {
  CELL_METRIC_PROVENANCE,
  DEFAULT_PAIR_TOLERANCE,
  NON_BLACK_CHANNEL_THRESHOLD,
} from "./capture-vocabulary.mjs";

/**
 * The per-cell metric strip.
 *
 * @param {{data: ArrayLike<number>}|ArrayLike<number>} rgba Decoded RGBA, or a
 *   decoded image carrying it.
 * @param {{width: number, height: number}} dimensions The image's dimensions.
 * @returns {{rawByteLumaMean: number, nonBlackFraction: number, provenance: string}} The strip.
 */
export function cellMetrics(rgba, { width, height }) {
  const data = rgba?.data ?? rgba;
  const pixels = width * height;
  if (!Number.isInteger(pixels) || pixels <= 0) {
    throw new TypeError(
      `cellMetrics needs positive integer dimensions, got ${width}x${height}`,
    );
  }
  if (data?.length !== pixels * 4) {
    throw new TypeError(
      `cellMetrics: ${width}x${height} needs ${pixels * 4} rgba bytes, got ${data?.length}`,
    );
  }
  let lumaSum = 0;
  let nonBlack = 0;
  for (let i = 0; i < pixels; i++) {
    const o = i * 4;
    const r = data[o];
    const g = data[o + 1];
    const b = data[o + 2];
    lumaSum += luminance(r, g, b);
    if (
      r > NON_BLACK_CHANNEL_THRESHOLD ||
      g > NON_BLACK_CHANNEL_THRESHOLD ||
      b > NON_BLACK_CHANNEL_THRESHOLD
    ) {
      nonBlack++;
    }
  }
  return {
    rawByteLumaMean: lumaSum / pixels,
    nonBlackFraction: nonBlack / pixels,
    provenance: CELL_METRIC_PROVENANCE,
  };
}

/**
 * The per-pair metric strip and the heat-map buffer that goes beside it.
 *
 * `mismatchPct` is the PERCENT `diffImages` returns, passed through untouched —
 * deliberately not the 0-1 ratio `compareCaptures` returns, so the two can
 * never be silently interchanged.
 *
 * @param {{width: number, height: number, data: ArrayLike<number>}} before BEFORE leg.
 * @param {{width: number, height: number, data: ArrayLike<number>}} after AFTER leg.
 * @param {{tolerance?: number, windowSize?: number}} [options] Options.
 * @returns {{mismatchPct: number|null, changedPx: number, bbox: object|null,
 *   tolerance: number, diffRgba: Uint8ClampedArray, mssim: number, windows: number}} The pair.
 */
export function pairMetrics(before, after, options = {}) {
  const tolerance = options.tolerance ?? DEFAULT_PAIR_TOLERANCE;
  const { mismatchPct, changedPx, bbox, diffRgba } = diffImages(before, after, {
    tolerance,
  });
  const { mssim, windows } = structureSimilarityRgba(before, after, {
    ...(options.windowSize === undefined
      ? {}
      : { windowSize: options.windowSize }),
  });
  return { mismatchPct, changedPx, bbox, tolerance, diffRgba, mssim, windows };
}
