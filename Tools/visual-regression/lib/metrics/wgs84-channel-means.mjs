// wgs84-channel-means.mjs — whole-frame RGB channel means and channel-sum
// coverage over decoded RGBA, extracted from the wgs84 probe family.
//
// @purpose Pure whole-frame per-channel RGB means plus the percentage of pixels whose channel sum exceeds a threshold, over decoded RGBA bytes; the Node-side home of probe-wgs84-quick.mjs's in-page canvas statistics.
// @status ACTIVE
//
// WHERE IT CAME FROM. `probe-wgs84-quick.mjs` (archived by the wgs84 harvest,
// DX-108) read the scene canvas INSIDE the page — `drawImage` onto a 2-D
// canvas, then `getImageData` — and reported `meanR`, `meanG`, `meanB` over
// every pixel plus `nonBlackPct`, the percentage of pixels with
// `r + g + b > 15`. That in-page read is the prohibited live-canvas reader
// (`probe-fleet-contract.spec.mjs` C14; the probe sat on
// `lib/prohibited-reader-allowlist.mjs` for it). This module computes the same
// numbers in Node, from the PNG bytes `captureElement` banks, so a probe keeps
// the reading without reading the canvas. `wgs84-channel-means.spec.mjs` holds
// it to the archived probe's own loop, executed over the same bytes.
//
// WHY NOT `frameStats` OR `cellMetrics`. Both count a pixel non-black when ANY
// channel exceeds 12 (`Tools/lib/png-decode.mjs` `frameStats`,
// `lib/capture.mjs` `cellMetrics`), and both report one Rec. 709 luma mean
// instead of the three channel means. The coverage rule here is a SUM rule: a
// pixel of (5, 5, 6) sums to 16 and counts here, while no channel of it
// exceeds 12 so it is black there. Neither population is wrong; they are two
// questions, and a figure banked under one cannot be compared with the other.
//
// WHAT IT IS NOT. Raw display bytes, averaged. There is no exposure inversion
// and no transfer function, so a mean here is descriptive, never photometric
// evidence — the same standing as `capture.mjs`'s `CELL_METRIC_PROVENANCE`.
// The name carries the family because the harvest names new files by family;
// the function itself is generic and is a candidate for consolidation with the
// fleet's other per-channel-mean readers once the wave lands.

/** The channel-sum floor the archived probe used: `r + g + b > 15`. */
export const NON_BLACK_SUM_THRESHOLD = 15;

/** What a mean from this module is, stated on every result. */
export const CHANNEL_MEANS_PROVENANCE =
  "display-bytes; descriptive only, not photometric evidence";

/**
 * Whole-frame channel means and channel-sum coverage.
 *
 * Every pixel is counted, black ones included, exactly as the archived probe's
 * loop did: the means answer "what does the frame average to", not "what does
 * the lit part average to".
 *
 * @param {{width: number, height: number, data: ArrayLike<number>}} image
 *   Decoded RGBA, row-major, 4 bytes per pixel.
 * @param {{nonBlackSumThreshold?: number}} [options] `nonBlackSumThreshold` is
 *   the channel-sum value a pixel must EXCEED to count as non-black; default
 *   {@link NON_BLACK_SUM_THRESHOLD}.
 * @returns {{width: number, height: number, pixels: number, meanR: number,
 *   meanG: number, meanB: number, nonBlackPct: number,
 *   nonBlackSumThreshold: number, provenance: string}} The statistics;
 *   `nonBlackPct` is a PERCENT (0-100), as the archived probe printed it.
 * @throws {TypeError} When the dimensions are not positive integers, the byte
 *   count is not `width * height * 4`, or the threshold is not a finite,
 *   non-negative number. A frame that cannot be read is an error, never a
 *   frame of zeros.
 */
export function frameChannelMeans(image, options = {}) {
  const width = image?.width;
  const height = image?.height;
  const data = image?.data;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new TypeError(
      `frameChannelMeans needs positive integer dimensions, got ${width}x${height}`,
    );
  }
  const pixels = width * height;
  if (data?.length !== pixels * 4) {
    throw new TypeError(
      `frameChannelMeans: ${width}x${height} needs ${pixels * 4} RGBA bytes, got ${data?.length}`,
    );
  }
  const threshold = options.nonBlackSumThreshold ?? NON_BLACK_SUM_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold < 0) {
    throw new TypeError(
      `frameChannelMeans: nonBlackSumThreshold must be a finite non-negative number, got ${threshold}`,
    );
  }

  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let nonBlack = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    rSum += r;
    gSum += g;
    bSum += b;
    if (r + g + b > threshold) {
      nonBlack++;
    }
  }
  return {
    width,
    height,
    pixels,
    meanR: rSum / pixels,
    meanG: gSum / pixels,
    meanB: bSum / pixels,
    nonBlackPct: (100 * nonBlack) / pixels,
    nonBlackSumThreshold: threshold,
    provenance: CHANNEL_MEANS_PROVENANCE,
  };
}
