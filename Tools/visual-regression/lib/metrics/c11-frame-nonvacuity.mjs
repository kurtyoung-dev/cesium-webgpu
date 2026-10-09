// c11-frame-nonvacuity.mjs — "the scored scene is visible and non-vacuous",
// measured over one decoded frame, extracted from the C11-209 startup probe.
// @purpose Pure whole-frame non-vacuity statistics over a decoded RGB/RGBA frame: non-black count and fraction by channel sum, mean and standard deviation of Rec. 709 luma, and the count of distinct 4-bit-per-channel colours.
// @status ACTIVE
//
// WHERE THIS CAME FROM. `probe-c11-209-effects-placeholder-startup.mjs`'s
// `analyzeScreenshot` decided whether the frame its WebGPU startup counts were
// taken under actually showed a scene: non-black fraction above 0.05, at least
// eight distinct quantized colours, luma standard deviation above 1. Its
// banked pass (`output/performance/c11-209-effects-placeholder-startup.json`,
// run `81b6febc-…`) recorded 20.9036 % non-black, 384 colours and a luma
// standard deviation of 52.7167, over an element capture of the CesiumViewer
// canvas taken with the viewer's widgets still in place, so those three
// figures describe the canvas plus whatever chrome overlapped it, not the
// scene alone (the archived probe now removes the widgets before capturing).
// The function itself is pure and reads whatever frame it is handed; scoping
// the frame to the canvas is the caller's job. The probe-kit harvest (PROBE_KIT_PLAN_2026-09-17.md
// §4, DX-108) archived that probe with its row complete and kept this metric,
// because "the frame my counts were taken under is not blank" is a check
// almost every instrumentation probe owes and few make.
//
// WHY NOT `frameStats` OR `cellMetrics`. `Tools/lib/png-decode.mjs`'s
// `frameStats` counts a pixel as non-black when ANY channel exceeds 12, counts
// colours over every 97th pixel only, and reports no spread; `capture.mjs`'s
// `cellMetrics` reports a luma mean and the any-channel fraction. This module
// keeps the C11-209 rule as written — non-black when `R + G + B > 24`, every
// pixel's colour counted, luma spread reported — so its numbers stay
// comparable with the banked receipt. `metrics-c11.spec.mjs` proves it returns
// what the inline code returned.
//
// The values are descriptive display-byte statistics, not photometry: no
// exposure is read and nothing here is linear radiance.

/** The C11-209 defaults, restated from the probe's inline constants. */
export const FRAME_NONVACUITY_DEFAULTS = Object.freeze({
  /** A pixel is non-black when `R + G + B` exceeds this. */
  nonBlackChannelSum: 24,
  /** Colours are quantized by dropping this many low bits per channel. */
  quantizeShift: 4,
});

/**
 * Whole-frame non-vacuity statistics.
 *
 * @param {{width: number, height: number, data: ArrayLike<number>, channels?: 3|4}} image
 *   Decoded frame; `channels` defaults to 4 (RGBA).
 * @param {{nonBlackChannelSum?: number, quantizeShift?: number}} [options]
 * @returns {{width: number, height: number, pixels: number,
 *   nonBlackPixels: number, nonBlackFraction: number,
 *   distinctQuantizedColors: number, meanLuma: number, lumaStddev: number}}
 */
export function frameNonVacuity(image, options = {}) {
  if (image === null || typeof image !== "object") {
    throw new TypeError("frameNonVacuity: frame must be an object");
  }
  const { width, height, data } = image;
  const channels = image.channels ?? 4;
  if (!Number.isInteger(width) || width <= 0) {
    throw new TypeError("frameNonVacuity: width must be a positive integer");
  }
  if (!Number.isInteger(height) || height <= 0) {
    throw new TypeError("frameNonVacuity: height must be a positive integer");
  }
  if (channels !== 3 && channels !== 4) {
    throw new TypeError(
      `frameNonVacuity: channels must be 3 or 4, got ${channels}`,
    );
  }
  if (data?.length !== width * height * channels) {
    throw new TypeError(
      `frameNonVacuity: ${width}x${height}x${channels} needs ${width * height * channels} bytes, got ${data?.length}`,
    );
  }
  const nonBlackChannelSum =
    options.nonBlackChannelSum ?? FRAME_NONVACUITY_DEFAULTS.nonBlackChannelSum;
  const shift =
    options.quantizeShift ?? FRAME_NONVACUITY_DEFAULTS.quantizeShift;
  const colors = new Set();
  let nonBlack = 0;
  let sum = 0;
  let sumSquares = 0;
  const pixels = width * height;
  for (let index = 0; index < data.length; index += channels) {
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    if (red + green + blue > nonBlackChannelSum) {
      nonBlack++;
    }
    const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    sum += luma;
    sumSquares += luma * luma;
    colors.add(`${red >> shift},${green >> shift},${blue >> shift}`);
  }
  const mean = sum / pixels;
  return {
    width,
    height,
    pixels,
    nonBlackPixels: nonBlack,
    nonBlackFraction: nonBlack / pixels,
    distinctQuantizedColors: colors.size,
    meanLuma: mean,
    lumaStddev: Math.sqrt(Math.max(0, sumSquares / pixels - mean * mean)),
  };
}
