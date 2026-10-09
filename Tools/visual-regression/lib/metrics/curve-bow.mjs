// curve-bow.mjs — how far a rendered curve bows away from a straight chord.
//
// @purpose Measure a near-horizontal rendered curve in one colour class against a straight reference in another: the curve's largest perpendicular departure from the line through its own endpoints, and its largest vertical separation from the reference, column by column.
// @status ACTIVE
//
// WHY THIS EXISTS. `probe-polyline-geodesic.mjs` (DP-H7) proved that a
// geodesic `PolylineCollection` line CURVES on WebGPU by drawing the subdivided
// great circle in cyan beside its two-point chord in red and reading, per
// column, the topmost pixel of each. A straight-line bug collapses both numbers
// to about zero; a correct geodesic bows by tens of pixels. That reading lived
// as a private function in the probe; it is extracted here so any probe whose
// subject is "this should be curved, not straight" — a rhumb line, a great
// circle, an arc that wraps in 2D — declares two colour classes instead of
// re-deriving the scan.
//
// THE ARITHMETIC IS THE ORIGINAL'S. `metrics-polyline.spec.mjs` runs the
// probe's pre-harvest `measureArc` verbatim against this module over seeded
// frames and requires equal numbers.
//
// IMPORTS. Only the frame and colour-class checks, from `colour-mask.mjs`, so
// every polyline metric refuses a ragged frame in the same words.

import { requireImage, requirePredicate } from "./colour-mask.mjs";

/**
 * The row of the topmost pixel of a colour class in every column, or `null`
 * for a column with none.
 *
 * @param {{width: number, height: number, data: ArrayLike<number>}} image Decoded frame.
 * @param {(r: number, g: number, b: number, a: number) => boolean} predicate Colour class.
 * @returns {Array<number|null>} One entry per column.
 */
export function topmostPerColumn(image, predicate) {
  requireImage(image, "topmostPerColumn");
  requirePredicate(predicate, "topmostPerColumn");
  const { width: w, height: h, data } = image;
  const tops = new Array(w).fill(null);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * 4;
      if (predicate(data[i], data[i + 1], data[i + 2], data[i + 3])) {
        tops[x] = y;
        break;
      }
    }
  }
  return tops;
}

/**
 * The curve's bow and its separation from the chord.
 *
 * - `maxBow` is the largest perpendicular distance of the curve's topmost
 *   pixels from the straight line through its own first and last columns —
 *   curve against straight, with no reference needed.
 * - `maxSeparation` is the largest vertical distance between the curve's and
 *   the chord's topmost pixels over the columns where both appear.
 *
 * Fewer than `minColumns` curve columns is reported as `ok: false` with both
 * numbers 0, the original's refusal to fit a bow to a fragment.
 *
 * @param {{width: number, height: number, data: ArrayLike<number>}} image Decoded frame.
 * @param {(r: number, g: number, b: number, a: number) => boolean} curvePredicate The curve's colour class.
 * @param {(r: number, g: number, b: number, a: number) => boolean} chordPredicate The chord's colour class.
 * @param {{minColumns?: number}} [options] `minColumns` defaults to 20.
 * @returns {{ok: boolean, maxBow: number, maxSeparation: number, curveColumns: number, sharedColumns: number}} The measurement.
 */
export function curveBowAgainstChord(
  image,
  curvePredicate,
  chordPredicate,
  options = {},
) {
  const minColumns = options.minColumns ?? 20;
  if (!Number.isInteger(minColumns) || minColumns < 2) {
    throw new TypeError(
      "curveBowAgainstChord: minColumns must be an integer of at least 2",
    );
  }
  const curveTop = topmostPerColumn(image, curvePredicate);
  const chordTop = topmostPerColumn(image, chordPredicate);
  const curve = [];
  for (let x = 0; x < curveTop.length; x++) {
    if (curveTop[x] !== null) {
      curve.push({ x, y: curveTop[x] });
    }
  }
  if (curve.length < minColumns) {
    return {
      ok: false,
      maxBow: 0,
      maxSeparation: 0,
      curveColumns: curve.length,
      sharedColumns: 0,
    };
  }

  const a = curve[0];
  const b = curve[curve.length - 1];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  let maxBow = 0;
  for (const p of curve) {
    const dist = Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
    if (dist > maxBow) {
      maxBow = dist;
    }
  }

  let maxSeparation = 0;
  let sharedColumns = 0;
  for (let x = 0; x < curveTop.length; x++) {
    if (curveTop[x] !== null && chordTop[x] !== null) {
      sharedColumns++;
      const sep = Math.abs(curveTop[x] - chordTop[x]);
      if (sep > maxSeparation) {
        maxSeparation = sep;
      }
    }
  }
  return {
    ok: true,
    maxBow,
    maxSeparation,
    curveColumns: curve.length,
    sharedColumns,
  };
}
