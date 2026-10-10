/**
 * Statistics of the lit pixels in the upper band of a black-sky cloud frame —
 * the measure the W-series lighting gates (phase, ambient, time of day) each
 * computed privately in the page.
 * @purpose Pure upper-band cloud-pixel statistics over decoded RGBA (count, sorted max-channel values, channel sums, top/bottom blue ratios) plus the floor-index quantile the phase, ambient and time-of-day gates read them with.
 * @status ACTIVE
 *
 * THE FRAME THESE GATES LOOK AT. The camera sits under the deck looking up
 * against a black background with the sky, atmosphere and sun hidden, so a
 * pixel whose brightest channel clears a small floor is cloud and every other
 * pixel is background. Only the upper `bandFraction` of the rows is read
 * (`Math.floor(height * bandFraction)` rows, from the top), which is where the
 * deck is; the lower rows hold the horizon.
 *
 * WHAT IS RETURNED, AND WHY NOT A PERCENTILE FUNCTION. The phase gate reads
 * the median and the 95th percentile of the brightest channel, the ambient
 * gate the 10th / 50th / 90th, and the time-of-day gate the red and blue sums.
 * So the band's max-channel values are returned sorted ascending and
 * `bandQuantile` indexes them the way every in-page copy did
 * (`sorted[Math.floor(length * q)]`), instead of each caller re-deriving an
 * index rule and drifting.
 *
 * THE BLUE RATIO'S ROWS. `topBlueRatio` averages `b / (r + g + b)` over cloud
 * pixels in rows `y < band * 0.4`, `bottomBlueRatio` over rows
 * `y > band * 0.6` — the ambient gate's split, reproduced exactly.
 */

/**
 * The upper-band statistics.
 *
 * @param {{width: number, height: number, data: ArrayLike<number>}} image The frame.
 * @param {object} [options] Options.
 * @param {number} [options.bandFraction] Fraction of rows, from the top, that is read; default 0.6.
 * @param {number} [options.minMaxChannel] A pixel is cloud when its brightest channel is ABOVE this; default 24.
 * @returns {{count: number, bandRows: number, sortedMaxChannel: Uint8Array,
 *   sumR: number, sumG: number, sumB: number,
 *   topBlueRatio: number, topCount: number,
 *   bottomBlueRatio: number, bottomCount: number}} The statistics; ratios are 0 with no pixel in their rows.
 */
export function cloudBandStats(
  image,
  { bandFraction = 0.6, minMaxChannel = 24 } = {},
) {
  if (
    !image ||
    !Number.isInteger(image.width) ||
    !Number.isInteger(image.height) ||
    image.data?.length !== image.width * image.height * 4
  ) {
    throw new TypeError("cloudBandStats needs a decoded RGBA image");
  }
  const { width, data: d } = image;
  const bandRows = Math.floor(image.height * bandFraction);
  const maxima = [];
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let topBlue = 0;
  let topCount = 0;
  let bottomBlue = 0;
  let bottomCount = 0;
  for (let y = 0; y < bandRows; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      const mx = Math.max(r, g, b);
      if (mx <= minMaxChannel) {
        continue;
      }
      maxima.push(mx);
      sumR += r;
      sumG += g;
      sumB += b;
      const blue = r + g + b > 0 ? b / (r + g + b) : 0;
      if (y < bandRows * 0.4) {
        topBlue += blue;
        topCount++;
      } else if (y > bandRows * 0.6) {
        bottomBlue += blue;
        bottomCount++;
      }
    }
  }
  const sortedMaxChannel = Uint8Array.from(maxima).sort();
  return {
    count: sortedMaxChannel.length,
    bandRows,
    sortedMaxChannel,
    sumR,
    sumG,
    sumB,
    topBlueRatio: topCount > 0 ? topBlue / topCount : 0,
    topCount,
    bottomBlueRatio: bottomCount > 0 ? bottomBlue / bottomCount : 0,
    bottomCount,
  };
}

/**
 * The value at quantile `q` of an ascending array, indexed as the in-page
 * copies indexed it: `sorted[Math.floor(sorted.length * q)]`.
 *
 * @param {ArrayLike<number>} sorted Ascending values.
 * @param {number} q Quantile in [0, 1).
 * @returns {number|undefined} The value, or undefined for an empty array.
 */
export function bandQuantile(sorted, q) {
  return sorted[Math.floor(sorted.length * q)];
}
