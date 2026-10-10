/**
 * Two-frame luma measures the cloud probe family computed privately, inside
 * the page, one copy per probe.
 * @purpose Pure Rec. 601 luma and the whole-frame mean absolute luma difference the cloud demo probes each hand-rolled in the page, now computed in Node over decoded RGBA.
 * @status ACTIVE
 *
 * WHY REC. 601 AND NOT `luminance.mjs`. `metrics/luminance.mjs` is Rec. 709
 * (0.2126 / 0.7152 / 0.0722) because the photometric bars say "luminance" and
 * mean that. The probes this module was extracted from — thirteen private
 * `diff()` copies at the time of the harvest — weighted
 * with 0.299 / 0.587 / 0.114, and every threshold they banked (`< 0.25`,
 * `> 1.0`, `> 3`) was calibrated on that weighting. Switching the weights
 * would move every banked number, so this module keeps them and says so.
 *
 * NO ROUNDING HERE. The in-page copies returned `+(x).toFixed(n)`; the probes
 * that call this module round for display and for the comparison exactly as
 * they did before, so the metric itself stays a plain number a spec can pin.
 *
 * ARITHMETIC ORDER IS PART OF THE CONTRACT. Luma is summed as
 * `0.299 * r + 0.587 * g + 0.114 * b`, left to right, and the difference is
 * accumulated in raster order — the order the in-page loop used — so a value
 * computed here is bit-for-bit the value the page would have produced from the
 * same bytes.
 */

/** The Rec. 601 weights the family's private copies used. */
export const REC601_LUMA_WEIGHTS = Object.freeze({
  r: 0.299,
  g: 0.587,
  b: 0.114,
});

/**
 * Rec. 601 luma of one pixel (or of one per-channel delta), 0-255 in, 0-255 out.
 *
 * @param {number} r Red.
 * @param {number} g Green.
 * @param {number} b Blue.
 * @returns {number} Luma.
 */
export function rec601Luma(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Refuse a pair of images a two-frame measure cannot compare pixel for pixel.
 *
 * @param {object} a First decoded RGBA image.
 * @param {object} b Second decoded RGBA image.
 * @param {string} what The measure's name, for the message.
 * @returns {void}
 * @throws {TypeError} When either is missing, the sizes differ, or a buffer is not `width * height * 4` long.
 */
export function requireSameSize(a, b, what) {
  if (
    !a ||
    !b ||
    a.width !== b.width ||
    a.height !== b.height ||
    a.data.length !== b.data.length ||
    a.data.length !== a.width * a.height * 4
  ) {
    throw new TypeError(
      `${what} needs two decoded RGBA images of the same size`,
    );
  }
}

/**
 * Mean absolute Rec. 601 luma difference over EVERY pixel of two same-size
 * images, on the 0-255 scale.
 *
 * @param {{width: number, height: number, data: ArrayLike<number>}} a First image.
 * @param {{width: number, height: number, data: ArrayLike<number>}} b Second image.
 * @returns {number} The mean; 0 for identical frames.
 */
export function meanAbsLumaDifference(a, b) {
  requireSameSize(a, b, "meanAbsLumaDifference");
  const da = a.data;
  const db = b.data;
  let acc = 0;
  const n = da.length / 4;
  for (let i = 0; i < da.length; i += 4) {
    acc += Math.abs(
      rec601Luma(da[i], da[i + 1], da[i + 2]) -
        rec601Luma(db[i], db[i + 1], db[i + 2]),
    );
  }
  return acc / n;
}
