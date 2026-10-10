// luma-regions.mjs — Rec. 601 luma statistics over a region of a decoded frame,
// and the mean absolute luma difference between two frames.
// @purpose Rec. 601 luma over a fractional region of decoded RGBA — mean luma, the whitish-cloud share and the blue-sky share — plus the whole-frame mean |dLuma| between two same-sized frames, as the Weather Inspector demo probes score them.
// @status ACTIVE
//
// WHERE IT COMES FROM. `probe-weather-presets.mjs` and
// `probe-weather-inspector.mjs` each decoded their element screenshots inside
// the page (Image -> canvas -> getImageData) and reduced them there with two
// private loops: a region's mean luma plus a "bright and unsaturated" cloud
// share, and a whole-frame mean |dLuma| between two screenshots. The presets
// probe scored the deck wedge (x 0.42..0.80, y 0.42..0.90) with a cloud bar
// of luma > 130 and chroma < 40; the inspector probe scored the whole frame
// with luma > 140 and chroma < 45, plus a blue-sky share (b > r and b > 90).
// Both are one function here with the region and the bars as options.
//
// WHY IN NODE NOW. An element screenshot is an opaque PNG. Decoding it with
// `Tools/lib/png-decode.mjs` yields the bytes the page's 2D canvas yielded, so
// the migrated probes read the same pixels without a second trip through the
// page — and the reducers become specifiable with no browser at all.
//
// THE LUMA IS REC. 601 (0.299, 0.587, 0.114) because both probes used it. It is
// NOT `metrics/luminance.mjs`'s Rec. 709 `luminance()`, and swapping one for
// the other would move every number these probes bank.

/**
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {number} Rec. 601 luma on the 0..255 byte scale.
 */
export function rec601Luma(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Luma statistics over a fractional region of one decoded frame.
 *
 * The region's pixel bounds are `floor(width * x0) .. floor(width * x1)` and
 * `floor(height * y0) .. floor(height * y1)`, half-open, every pixel read.
 *
 * @param {{data: ArrayLike<number>, width: number, height: number}} frame
 * @param {object} [options]
 * @param {{x0: number, x1: number, y0: number, y1: number}} [options.region]
 *   Fractions of the frame; the whole frame by default.
 * @param {number} [options.cloudLumaAbove] A pixel is whitish cloud when its
 *   luma exceeds this (140 by default)...
 * @param {number} [options.cloudChromaBelow] ...and `max - min` of its
 *   channels is below this (45 by default).
 * @returns {{lum: number, cloudPct: number, skyPct: number, samples: number}}
 *   `lum` is the mean luma to one decimal; `cloudPct` and `skyPct` are
 *   percentages to two decimals, `skyPct` counting `b > r && b > 90`.
 * @throws {RangeError} When the region holds no pixel, since a share of
 *   nothing is not zero.
 */
export function lumaRegionStats(frame, options = {}) {
  const { data, width, height } = frame;
  const region = options.region ?? { x0: 0, x1: 1, y0: 0, y1: 1 };
  const cloudLumaAbove = options.cloudLumaAbove ?? 140;
  const cloudChromaBelow = options.cloudChromaBelow ?? 45;
  const x0 = Math.floor(width * region.x0);
  const x1 = Math.floor(width * region.x1);
  const y0 = Math.floor(height * region.y0);
  const y1 = Math.floor(height * region.y1);
  let lum = 0;
  let cloud = 0;
  let sky = 0;
  let samples = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const luma = rec601Luma(r, g, b);
      lum += luma;
      if (
        luma > cloudLumaAbove &&
        Math.max(r, g, b) - Math.min(r, g, b) < cloudChromaBelow
      ) {
        cloud++;
      }
      if (b > r && b > 90) {
        sky++;
      }
      samples++;
    }
  }
  if (samples === 0) {
    throw new RangeError(
      `lumaRegionStats: the region ${JSON.stringify(region)} holds no pixel of a ${width}x${height} frame`,
    );
  }
  return {
    lum: +(lum / samples).toFixed(1),
    cloudPct: +((100 * cloud) / samples).toFixed(2),
    skyPct: +((100 * sky) / samples).toFixed(2),
    samples,
  };
}

/**
 * Whole-frame mean absolute Rec. 601 luma difference between two frames.
 *
 * @param {{data: ArrayLike<number>, width: number, height: number}} a
 * @param {{data: ArrayLike<number>, width: number, height: number}} b
 * @returns {number} Mean |dLuma| per pixel, to three decimals.
 * @throws {RangeError} When the frames differ in size; a pixel-wise difference
 *   of two differently sized frames pairs unrelated pixels.
 */
export function meanAbsLumaDelta(a, b) {
  if (a.width !== b.width || a.height !== b.height) {
    throw new RangeError(
      `meanAbsLumaDelta: frames differ in size (${a.width}x${a.height} vs ${b.width}x${b.height})`,
    );
  }
  const da = a.data;
  const db = b.data;
  let acc = 0;
  const n = a.width * a.height;
  for (let i = 0; i < n * 4; i += 4) {
    acc += Math.abs(
      rec601Luma(da[i], da[i + 1], da[i + 2]) -
        rec601Luma(db[i], db[i + 1], db[i + 2]),
    );
  }
  return +(acc / n).toFixed(3);
}
