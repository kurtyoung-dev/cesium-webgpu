/**
 * Region statistics the cloud probe family computed privately over a
 * fractional rectangle of the frame: the deck's mean luma, the fraction of it
 * that reads as grey cloud, and the chroma shift of the pixels a toggle moved.
 * @purpose Pure fractional-ROI luma mean, grey-deck fraction and changed-pixel chroma shift over decoded RGBA, extracted from the in-page deckLum/deck/cloudFrac/coolShift copies of the cloud demo and depth-occlusion probes.
 * @status ACTIVE
 *
 * THE REGION IS A FRACTION, FLOORED. Every in-page copy wrote its rectangle
 * as `Math.floor(width * 0.42)` and so on, and then read
 * `getImageData(x0, y0, x1 - x0, y1 - y0)`: half-open on both axes, rows in
 * order. `fractionRoi` reproduces exactly that through the kit's own
 * `rectRoi`, so a region stated here covers the same pixels the page read.
 *
 * THE THRESHOLDS ARE THE PROBES', AND THEY ARE STRICT. A pixel is grey cloud
 * when its luma is ABOVE the floor and its chroma spread is BELOW the ceiling,
 * and (optionally) when it is not "blue sky" (`b > r + 25 && b > 120`). The
 * defaults are the Weather Inspector cohort's (`> 90`, `< 50`, blue sky
 * excluded); the depth-occlusion probe's whitish-cloud test is the same shape
 * at `> 150`, `< 40` with no blue-sky exclusion.
 *
 * Rec. 601 luma, for the reason `luma-difference.mjs` gives.
 */

import { rec601Luma, requireSameSize } from "./luma-difference.mjs";
import { rectRoi } from "./masks.mjs";

function requireImage(image, what) {
  if (
    !image ||
    !Number.isInteger(image.width) ||
    !Number.isInteger(image.height) ||
    image.data?.length !== image.width * image.height * 4
  ) {
    throw new TypeError(`${what} needs a decoded RGBA image`);
  }
}

/**
 * A rectangle stated as fractions of the frame, floored to pixels the way the
 * in-page copies floored it, half-open on both axes.
 *
 * @param {{width: number, height: number}} image The frame (only its size is read).
 * @param {{x0: number, x1: number, y0: number, y1: number}} region Fractions in [0, 1].
 * @returns {{x0: number, y0: number, x1: number, y1: number}} Pixel bounds.
 */
export function fractionRoi({ width, height }, region) {
  const x0 = Math.floor(width * region.x0);
  const y0 = Math.floor(height * region.y0);
  return rectRoi({
    width,
    height,
    x: x0,
    y: y0,
    w: Math.floor(width * region.x1) - x0,
    h: Math.floor(height * region.y1) - y0,
  });
}

/**
 * Mean Rec. 601 luma over a fractional region (the dials probe's `deckLum`).
 *
 * @param {{width: number, height: number, data: ArrayLike<number>}} image The frame.
 * @param {{x0: number, x1: number, y0: number, y1: number}} region Fractions.
 * @returns {number} Mean luma, 0-255; NaN for an empty region.
 */
export function roiMeanLuma(image, region) {
  requireImage(image, "roiMeanLuma");
  const { x0, x1, y0, y1 } = fractionRoi(image, region);
  const d = image.data;
  let lum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * image.width + x) * 4;
      lum += rec601Luma(d[i], d[i + 1], d[i + 2]);
      n++;
    }
  }
  return lum / n;
}

/**
 * Percentage of a fractional region that reads as grey cloud (the demo
 * cohort's `deck()`, the depth-occlusion probe's `cloudFrac`).
 *
 * @param {{width: number, height: number, data: ArrayLike<number>}} image The frame.
 * @param {{x0: number, x1: number, y0: number, y1: number}} region Fractions.
 * @param {object} [options] Thresholds.
 * @param {number} [options.minLuma] Luma a cloud pixel must exceed; default 90.
 * @param {number} [options.maxChroma] `max - min` channel spread it must stay below; default 50.
 * @param {boolean} [options.excludeBlueSky] Drop `b > r + 25 && b > 120` pixels; default true.
 * @returns {number} Percent of the region's pixels, 0-100; NaN for an empty region.
 */
export function greyDeckFraction(
  image,
  region,
  { minLuma = 90, maxChroma = 50, excludeBlueSky = true } = {},
) {
  requireImage(image, "greyDeckFraction");
  const { x0, x1, y0, y1 } = fractionRoi(image, region);
  const d = image.data;
  let cloud = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * image.width + x) * 4;
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      const blueSky = excludeBlueSky && b > r + 25 && b > 120;
      const spread = Math.max(r, g, b) - Math.min(r, g, b);
      if (!blueSky && rec601Luma(r, g, b) > minLuma && spread < maxChroma) {
        cloud++;
      }
      n++;
    }
  }
  return (100 * cloud) / n;
}

/**
 * Over the pixels of a region whose luma MOVED between two frames, the mean
 * red and blue deltas and `blue - red` (the special probe's `coolShift`), so a
 * tint can be told from a brightness change without the static backdrop
 * diluting it.
 *
 * A pixel counts when `|rec601Luma(dr, dg, db)| > lumaDelta` (strict). The
 * region is `fractionRoi` of the FIRST frame.
 *
 * @param {{width: number, height: number, data: ArrayLike<number>}} before The reference frame.
 * @param {{width: number, height: number, data: ArrayLike<number>}} after The treated frame.
 * @param {{x0: number, x1: number, y0: number, y1: number}} region Fractions.
 * @param {object} [options] Options.
 * @param {number} [options.lumaDelta] Luma change a pixel must exceed; default 10.
 * @returns {{dr: number, db: number, cool: number, n: number}} Mean deltas; all 0 when no pixel moved.
 */
export function changedPixelChromaShift(
  before,
  after,
  region,
  { lumaDelta = 10 } = {},
) {
  requireSameSize(before, after, "changedPixelChromaShift");
  const { x0, x1, y0, y1 } = fractionRoi(before, region);
  const a = before.data;
  const b = after.data;
  let sdr = 0;
  let sdb = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * before.width + x) * 4;
      const dr = b[i] - a[i];
      const dg = b[i + 1] - a[i + 1];
      const db = b[i + 2] - a[i + 2];
      if (Math.abs(rec601Luma(dr, dg, db)) > lumaDelta) {
        sdr += dr;
        sdb += db;
        n++;
      }
    }
  }
  if (n === 0) {
    return { dr: 0, db: 0, cool: 0, n: 0 };
  }
  return { dr: sdr / n, db: sdb / n, cool: (sdb - sdr) / n, n };
}
