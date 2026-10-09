// line-structure.mjs — the shape of a screen-space line, read from one colour class.
//
// @purpose Structure metrics for a rendered line in one colour class of a decoded RGBA frame: colored runs per row (dash vs solid), the full width at half maximum of the row-intensity profile (glow taper), per-column heights, an arrow head's fill against its bounding box, and whether an outline brackets its core.
// @status ACTIVE
//
// WHY THIS EXISTS. A lit-pixel count is a weak gate for a line material: the
// dash defect behind `BUG-POLYLINE-COLLECTION-MULTI-MATERIAL` moved the dash
// PATTERN without moving the count much, the glow defect moved the count by
// 3.3x while a solid band of similar area would have passed a count check, and
// an arrow head painted as a filled rectangle has the same bounding box, the
// same peak and a total only ~14 % high. Each failure moves a different
// STRUCTURAL quantity, and `probe-polyline-multimaterial.mjs` (AR-754) and
// `probe-polyline-material-primitive.mjs` measured those quantities inside a
// `page.evaluate` over the live canvas. This module is the same arithmetic over
// a decoded frame in Node, extracted so the two probes share one copy and the
// next line probe declares a colour class instead of re-deriving a profile.
//
// EVERY FUNCTION TAKES A COLOUR CLASS. The predicate is `(r, g, b, a) =>
// boolean` (see `colour-mask.mjs` for the strict-threshold builders), so one
// material's measurement can never be inflated by another hue's pixels — the
// separation the multi-material scene is built around.
//
// THE ARITHMETIC IS THE ORIGINALS', NOT A REWRITE. `metrics-polyline.spec.mjs`
// runs the pre-harvest in-page bodies, copied verbatim, against this module
// over seeded frames and requires deep equality; that equivalence (E1) is what
// holds the 1.5x flare factor. The other two boundaries are pinned on frames
// built to sit on them: B7 has a row exactly at half the peak, and B9 an arrow
// whose columns between 70 % and 80 % of the span decide the shaft. So a
// "cleanup" that changes a boundary (a `>=` for a `>`, the 80 % shaft split,
// the 1.5x flare factor) reds.
//
// IMPORTS. Only the frame and colour-class checks, from `colour-mask.mjs`, so
// every polyline metric refuses a ragged frame in the same words.

import { requireImage, requirePredicate } from "./colour-mask.mjs";

/**
 * Pixels, colored runs per row, and the full width at half maximum of the
 * row-intensity profile, for one colour class.
 *
 * A run is a maximal horizontal stretch of matching pixels, so a solid line
 * crossing a row contributes about one run and a dashed line several; summed
 * over the rows it crosses, `runsPerRow` tells dash from solid without a
 * separate solid baseline. A row's intensity is the sum of `max(r, g, b)` over
 * its matching pixels, and `fwhm` counts the rows at or above half the peak
 * row — the cross-line thickness a glow losing its taper moves.
 *
 * @param {{width: number, height: number, data: ArrayLike<number>}} image Decoded frame.
 * @param {(r: number, g: number, b: number, a: number) => boolean} predicate Colour class.
 * @returns {{colored: number, runs: number, coloredRows: number, fwhm: number, runsPerRow: number}} The profile.
 */
export function rowRunProfile(image, predicate) {
  requireImage(image, "rowRunProfile");
  requirePredicate(predicate, "rowRunProfile");
  const { width: w, height: h, data: px } = image;
  let colored = 0;
  let runs = 0;
  let coloredRows = 0;
  const rowIntensity = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    let prev = false;
    let rowHas = false;
    let sum = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const c = predicate(px[i], px[i + 1], px[i + 2], px[i + 3]);
      if (c) {
        colored++;
        rowHas = true;
        sum += Math.max(px[i], px[i + 1], px[i + 2]);
        if (!prev) {
          runs++;
        }
      }
      prev = c;
    }
    rowIntensity[y] = sum;
    if (rowHas) {
      coloredRows++;
    }
  }
  let peak = 0;
  for (let y = 0; y < h; y++) {
    if (rowIntensity[y] > peak) {
      peak = rowIntensity[y];
    }
  }
  let fwhm = 0;
  if (peak > 0) {
    const half = peak / 2;
    for (let y = 0; y < h; y++) {
      if (rowIntensity[y] >= half) {
        fwhm++;
      }
    }
  }
  return {
    colored,
    runs,
    coloredRows,
    fwhm,
    runsPerRow: coloredRows > 0 ? runs / coloredRows : 0,
  };
}

/**
 * Per-column count of matching pixels.
 *
 * @param {{width: number, height: number, data: ArrayLike<number>}} image Decoded frame.
 * @param {(r: number, g: number, b: number, a: number) => boolean} predicate Colour class.
 * @returns {Int32Array} One height per column.
 */
export function columnHeights(image, predicate) {
  requireImage(image, "columnHeights");
  requirePredicate(predicate, "columnHeights");
  const { width: w, height: h, data: px } = image;
  const heights = new Int32Array(w);
  for (let x = 0; x < w; x++) {
    let n = 0;
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * 4;
      if (predicate(px[i], px[i + 1], px[i + 2], px[i + 3])) {
        n++;
      }
    }
    heights[x] = n;
  }
  return heights;
}

/**
 * An arrow's head, by its column-height profile rather than its area.
 *
 * `PolylineArrowMaterial.glsl` cuts the head with two half-planes that meet at
 * the tip, so its column heights fall away linearly and it fills about half of
 * its own bounding box (`headFill` ~0.55). The shaft is the leading 80 % of the
 * lit span and its height is the median there; the head is the trailing run of
 * columns that flare past 1.5x the shaft, extended to the end of the span so
 * the tip's taper is included.
 *
 * @param {{width: number, height: number, data: ArrayLike<number>}} image Decoded frame.
 * @param {(r: number, g: number, b: number, a: number) => boolean} predicate The arrow's colour class.
 * @returns {object|null} `null` when no column matched; otherwise the span,
 *   the shaft (`body`), the head's start, column count, peak, fill fraction
 *   (`null` when there is no head) and its per-column heights.
 */
export function arrowHeadProfile(image, predicate) {
  const heights = columnHeights(image, predicate);
  const w = image.width;
  let x0 = -1;
  let x1 = -1;
  for (let x = 0; x < w; x++) {
    if (heights[x] > 0) {
      if (x0 < 0) {
        x0 = x;
      }
      x1 = x;
    }
  }
  if (x0 < 0) {
    return null;
  }
  const bodyEnd = x0 + Math.floor((x1 - x0 + 1) * 0.8);
  const samples = [];
  for (let x = x0; x <= bodyEnd; x++) {
    if (heights[x] > 0) {
      samples.push(heights[x]);
    }
  }
  samples.sort((a, b) => a - b);
  const body = samples.length > 0 ? samples[samples.length >> 1] : 0;
  const flare = body * 1.5;
  let lastFlare = -1;
  for (let x = x1; x >= x0; x--) {
    if (heights[x] > flare) {
      lastFlare = x;
      break;
    }
  }
  if (lastFlare < 0) {
    return { body, headColumns: 0, headPeak: 0, headFill: null, head: [] };
  }
  let headStart = lastFlare;
  while (headStart > x0 && heights[headStart - 1] > flare) {
    headStart--;
  }
  const head = [];
  let sum = 0;
  let peak = 0;
  for (let x = headStart; x <= x1; x++) {
    head.push(heights[x]);
    sum += heights[x];
    if (heights[x] > peak) {
      peak = heights[x];
    }
  }
  return {
    spanStart: x0,
    spanEnd: x1,
    body,
    headStart,
    headColumns: head.length,
    headPeak: peak,
    headFill: peak > 0 && head.length > 0 ? sum / (peak * head.length) : null,
    head,
  };
}

/**
 * An outline's vertical structure at the core's widest column: how many
 * outline-class rows sit above the core and how many below. A two-sided
 * outline brackets its core; a collapse to the plain colour has no outline
 * rows, and a flood has outline rows and no core.
 *
 * @param {{width: number, height: number, data: ArrayLike<number>}} image Decoded frame.
 * @param {(r: number, g: number, b: number, a: number) => boolean} corePredicate The core's colour class.
 * @param {(r: number, g: number, b: number, a: number) => boolean} edgePredicate The outline's colour class.
 * @returns {{column: number, coreRows: number, coreMin: number, coreMax: number, edgeAbove: number, edgeBelow: number}|null}
 *   `null` when no column holds a core pixel.
 */
export function outlineCrossSection(image, corePredicate, edgePredicate) {
  requirePredicate(edgePredicate, "outlineCrossSection");
  const coreHeights = columnHeights(image, corePredicate);
  const { width: w, height: h, data: px } = image;
  let column = -1;
  let best = 0;
  for (let x = 0; x < w; x++) {
    if (coreHeights[x] > best) {
      best = coreHeights[x];
      column = x;
    }
  }
  if (column < 0) {
    return null;
  }
  const at = (predicate, y) => {
    const i = (y * w + column) * 4;
    return predicate(px[i], px[i + 1], px[i + 2], px[i + 3]);
  };
  let coreMin = h;
  let coreMax = -1;
  for (let y = 0; y < h; y++) {
    if (at(corePredicate, y)) {
      if (y < coreMin) {
        coreMin = y;
      }
      coreMax = y;
    }
  }
  let edgeAbove = 0;
  let edgeBelow = 0;
  for (let y = 0; y < h; y++) {
    if (at(edgePredicate, y)) {
      if (y < coreMin) {
        edgeAbove++;
      } else if (y > coreMax) {
        edgeBelow++;
      }
    }
  }
  return { column, coreRows: best, coreMin, coreMax, edgeAbove, edgeBelow };
}
