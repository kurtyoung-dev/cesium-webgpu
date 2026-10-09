// colour-mask.mjs — colour-class masks over a decoded RGBA frame.
//
// @purpose Count, locate and sample the pixels of a decoded RGBA frame that satisfy a colour-class predicate (strict per-channel thresholds, or any channel above a floor), the population every hue-separated probe scores.
// @status ACTIVE
//
// WHY THIS EXISTS. Every polyline probe draws its subject in a hue no other
// object in the frame can produce (cyan on black, a red|blue split texture, five
// hue-separated lines in one collection) and then scores the pixels of that
// hue: how many there are, where their centroid sits, and which of them a
// follow-up step should act on. Before the probe-kit harvest each probe carried
// that loop inside its own `page.evaluate`, reading the live canvas through
// `drawImage` — the reader `prohibited-reader-allowlist.mjs` exists to retire —
// and each loop restated its thresholds inline. This module is that loop once,
// over the decoded PNG the capture seam already hands back in Node, so the
// thresholds a probe scores are data it declares rather than code it copies.
//
// STRICT COMPARISONS, BY CONSTRUCTION. `channelThresholds` builds a predicate
// from `{rAbove, rBelow, gAbove, gBelow, bAbove, bBelow}` and every bound is a
// STRICT inequality (`r > rAbove`, `r < rBelow`). That is the form every probe
// this was extracted from used (`b > 200 && g > 200 && r < 80`, and so on), so
// a probe that moves onto this module keeps its exact population — a
// non-strict bound would silently admit the boundary value the original
// excluded.
//
// IMPORTS NOTHING, AND OWNS THE FRAME CHECKS. This file imports nothing, so a
// spec can drive it with no browser and a mutation harness can rewrite it as
// text. Its two argument checks, `requireImage` and `requirePredicate`, are
// exported so `line-structure.mjs` and `curve-bow.mjs` refuse a ragged frame
// or a non-function colour class with these words instead of carrying copies.
// (Other `lib/metrics` modules do import their siblings; `masks.mjs` holds the
// shared finite-number check, `requireFinite`.)

const BOUND_KEYS = Object.freeze([
  "rAbove",
  "rBelow",
  "gAbove",
  "gBelow",
  "bAbove",
  "bBelow",
]);

/**
 * Refuse anything that is not a decoded RGBA frame of exactly
 * `width * height * 4` bytes. A short or ragged buffer would otherwise be
 * scored as far as it goes and read like a frame with fewer subject pixels.
 *
 * @param {{width: number, height: number, data: ArrayLike<number>}} image Decoded frame.
 * @param {string} caller Name used in the thrown message.
 */
export function requireImage(image, caller) {
  if (image === null || typeof image !== "object") {
    throw new TypeError(`${caller}: image must be a decoded RGBA frame`);
  }
  const { width, height, data } = image;
  if (!Number.isInteger(width) || width <= 0) {
    throw new TypeError(`${caller}: image.width must be a positive integer`);
  }
  if (!Number.isInteger(height) || height <= 0) {
    throw new TypeError(`${caller}: image.height must be a positive integer`);
  }
  if (!data || data.length !== width * height * 4) {
    throw new TypeError(
      `${caller}: image.data must hold exactly width*height*4 bytes (${width * height * 4}), got ${data?.length}`,
    );
  }
}

/**
 * Refuse a colour class that is not a function `(r, g, b, a) => boolean`.
 *
 * @param {unknown} predicate Candidate predicate.
 * @param {string} caller Name used in the thrown message.
 */
export function requirePredicate(predicate, caller) {
  if (typeof predicate !== "function") {
    throw new TypeError(
      `${caller}: predicate must be a function (r, g, b, a) => boolean`,
    );
  }
}

/**
 * A colour-class predicate from strict per-channel bounds.
 *
 * @param {{rAbove?: number, rBelow?: number, gAbove?: number, gBelow?: number, bAbove?: number, bBelow?: number}} bounds
 *   At least one bound; each a finite number on 0-255. `xAbove` means
 *   `channel > xAbove`, `xBelow` means `channel < xBelow`.
 * @returns {(r: number, g: number, b: number) => boolean} The predicate.
 */
export function channelThresholds(bounds) {
  if (bounds === null || typeof bounds !== "object") {
    throw new TypeError("channelThresholds: bounds must be an object");
  }
  const keys = Object.keys(bounds);
  if (keys.length === 0) {
    throw new TypeError("channelThresholds: declare at least one bound");
  }
  for (const key of keys) {
    if (!BOUND_KEYS.includes(key)) {
      throw new TypeError(`channelThresholds: unknown bound ${key}`);
    }
    if (!Number.isFinite(bounds[key])) {
      throw new TypeError(`channelThresholds: ${key} must be a finite number`);
    }
  }
  const rAbove = bounds.rAbove ?? -Infinity;
  const rBelow = bounds.rBelow ?? Infinity;
  const gAbove = bounds.gAbove ?? -Infinity;
  const gBelow = bounds.gBelow ?? Infinity;
  const bAbove = bounds.bAbove ?? -Infinity;
  const bBelow = bounds.bBelow ?? Infinity;
  return (r, g, b) =>
    r > rAbove &&
    r < rBelow &&
    g > gAbove &&
    g < gBelow &&
    b > bAbove &&
    b < bBelow;
}

/**
 * A predicate true when ANY of red, green or blue is strictly above a floor —
 * the "clearly non-black" test.
 *
 * @param {number} floor Value on 0-255.
 * @returns {(r: number, g: number, b: number) => boolean} The predicate.
 */
export function anyChannelAbove(floor) {
  if (!Number.isFinite(floor)) {
    throw new TypeError("anyChannelAbove: floor must be a finite number");
  }
  return (r, g, b) => r > floor || g > floor || b > floor;
}

/**
 * How many pixels satisfy the predicate.
 *
 * @param {{width: number, height: number, data: ArrayLike<number>}} image Decoded frame.
 * @param {(r: number, g: number, b: number, a: number) => boolean} predicate Colour class.
 * @returns {number} The count.
 */
export function maskCount(image, predicate) {
  requireImage(image, "maskCount");
  requirePredicate(predicate, "maskCount");
  const { data } = image;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (predicate(data[i], data[i + 1], data[i + 2], data[i + 3])) {
      count += 1;
    }
  }
  return count;
}

/**
 * The count and the coordinate sums of the matching pixels, with their means.
 *
 * The means are `null` — not 0, not -1 — when nothing matched, so a caller
 * cannot mistake "no subject" for "a subject at the origin". A probe that
 * historically printed `-1` for an empty centroid maps the `null` itself.
 *
 * @param {{width: number, height: number, data: ArrayLike<number>}} image Decoded frame.
 * @param {(r: number, g: number, b: number, a: number) => boolean} predicate Colour class.
 * @returns {{count: number, sumX: number, sumY: number, meanX: number|null, meanY: number|null}} The centroid.
 */
export function maskCentroid(image, predicate) {
  requireImage(image, "maskCentroid");
  requirePredicate(predicate, "maskCentroid");
  const { width, data } = image;
  let count = 0;
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (predicate(data[i], data[i + 1], data[i + 2], data[i + 3])) {
      count += 1;
      const p = i / 4;
      sumX += p % width;
      sumY += Math.floor(p / width);
    }
  }
  return {
    count,
    sumX,
    sumY,
    meanX: count > 0 ? sumX / count : null,
    meanY: count > 0 ? sumY / count : null,
  };
}

/**
 * Every `every`-th matching pixel's coordinates, in raster order.
 *
 * The n-th match (counting from 1) is kept when `n % every === 0`, so the first
 * kept pixel is the `every`-th match, never the first. That is the sampling the
 * polyline pick probe has always used to pick ON the line rather than at its
 * centroid, which for a zig-zag lands in an empty gap.
 *
 * @param {{width: number, height: number, data: ArrayLike<number>}} image Decoded frame.
 * @param {(r: number, g: number, b: number, a: number) => boolean} predicate Colour class.
 * @param {number} every Positive integer stride over the matches.
 * @returns {{count: number, samples: Array<[number, number]>}} The total match count and the kept coordinates.
 */
export function maskSamples(image, predicate, every) {
  requireImage(image, "maskSamples");
  requirePredicate(predicate, "maskSamples");
  if (!Number.isInteger(every) || every < 1) {
    throw new TypeError("maskSamples: every must be a positive integer");
  }
  const { width, data } = image;
  let count = 0;
  const samples = [];
  for (let i = 0; i < data.length; i += 4) {
    if (predicate(data[i], data[i + 1], data[i + 2], data[i + 3])) {
      count += 1;
      if (count % every === 0) {
        const p = i / 4;
        samples.push([p % width, Math.floor(p / width)]);
      }
    }
  }
  return { count, samples };
}
