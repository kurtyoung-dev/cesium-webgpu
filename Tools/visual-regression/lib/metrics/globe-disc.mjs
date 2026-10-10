// globe-disc.mjs — where the planet disc is in a frame, and how its latitude bands sit.
// @purpose Pure RGBA metrics over a globe-disc frame: the lit disc's bounding box (per image and as the consensus of two), its centre and radius, the per-row land and ice profile with the ice centroid, and the vertical shift that best aligns two top-half land profiles.
// @status ACTIVE
//
// WHERE IT CAME FROM. `probe-globe-polar-stretch` (the acceptance for the
// Mercator-reprojection double-flip fix) measured latitude-band alignment
// between WebGL and WebGPU in disc-radius units so its three zooms (2, 25 and
// 55 Mm) compare on one scale: the ice centroid's vertical offset, the ice area
// ratio and the best vertical shift between the top-half land profiles. Those
// computations ran inside `page.evaluate`; this module is that source moved to
// Node, with the loop bounds and floating-point steps kept exactly (the shift
// search accumulates `s += 0.005` and `v += 0.01`, and its result depends on
// that accumulation), so a banked report number re-derives bit for bit.
// `metrics-globe-extraction.spec.mjs` holds every function here to the
// original in-page source.
//
// The land and ice classes are the probe's own and are colour heuristics over
// display bytes (ice: Rec. 709 luma > 130 with R, G and B within 40 of each
// other; land: ice, or R > B + 8 with luma > 30). They are descriptive
// classes for alignment, not a photometric claim.
//
// Pure: no I/O and no gate decision.

import { luminance } from "./luminance.mjs";

/**
 * @typedef {{width: number, height: number, data: ArrayLike<number>}} RgbaImage
 * @typedef {{x0: number, y0: number, x1: number, y1: number}} Crop Half-open bounds.
 * @typedef {{minX: number, maxX: number, minY: number, maxY: number}} Disc
 *   Inclusive pixel bounds; -1 on an axis with no qualifying row or column.
 */

function lumAt(data, i) {
  return luminance(data[i], data[i + 1], data[i + 2]);
}

/**
 * The lit disc's bounding box in one image: the rows and columns inside `crop`
 * that carry at least `minCount` pixels brighter than `lumFloor`.
 *
 * @param {RgbaImage} image
 * @param {Crop} crop
 * @param {{lumFloor?: number, minCount?: number}} [options] Defaults 24 and 30.
 * @returns {Disc}
 */
export function detectDisc(image, crop, options = {}) {
  const lumFloor = options.lumFloor ?? 24;
  const minCount = options.minCount ?? 30;
  const W = image.width;
  const H = image.height;
  const d = image.data;
  const rowCnt = new Array(H).fill(0);
  const colCnt = new Array(W).fill(0);
  for (let y = crop.y0; y < crop.y1; y++) {
    for (let x = crop.x0; x < crop.x1; x++) {
      if (lumAt(d, 4 * (y * W + x)) > lumFloor) {
        rowCnt[y]++;
        colCnt[x]++;
      }
    }
  }
  let minX = -1,
    maxX = -1,
    minY = -1,
    maxY = -1;
  for (let y = 0; y < H; y++)
    if (rowCnt[y] >= minCount) {
      if (minY < 0) minY = y;
      maxY = y;
    }
  for (let x = 0; x < W; x++)
    if (colCnt[x] >= minCount) {
      if (minX < 0) minX = x;
      maxX = x;
    }
  return { minX, maxX, minY, maxY };
}

/**
 * The disc both images agree on: the intersection of their two boxes. With
 * identical cameras the true geometry is identical, so the intersection keeps
 * a brighter limb on one backend from widening the box.
 *
 * @param {RgbaImage} first
 * @param {RgbaImage} second
 * @param {Crop} crop
 * @param {{lumFloor?: number, minCount?: number}} [options]
 * @returns {Disc}
 * @throws {RangeError} When the two frames differ in size, since the two boxes
 *   would not be in one coordinate frame.
 */
export function consensusDisc(first, second, crop, options = {}) {
  if (first.width !== second.width || first.height !== second.height) {
    throw new RangeError(
      `consensusDisc: size mismatch ${first.width}x${first.height} vs ${second.width}x${second.height}`,
    );
  }
  const dA = detectDisc(first, crop, options);
  const dB = detectDisc(second, crop, options);
  return {
    minX: Math.max(dA.minX, dB.minX),
    maxX: Math.min(dA.maxX, dB.maxX),
    minY: Math.max(dA.minY, dB.minY),
    maxY: Math.min(dA.maxY, dB.maxY),
  };
}

/**
 * The disc's centre and its radius as the mean of the two half-extents.
 *
 * @param {Disc} disc
 * @returns {{cx: number, cy: number, radius: number}}
 */
export function discCentreRadius(disc) {
  return {
    cx: (disc.minX + disc.maxX) / 2,
    cy: (disc.minY + disc.maxY) / 2,
    radius: (disc.maxX - disc.minX + (disc.maxY - disc.minY)) / 4,
  };
}

/**
 * The per-row land and ice profile inside 93 % of the disc, and the ice
 * pixels' vertical centroid.
 *
 * @param {RgbaImage} image
 * @param {Disc} disc
 * @returns {{r: number, cy: number,
 *   rows: Array<{y: number, v: number, landFrac: number, iceCnt: number}>,
 *   icePx: number, iceCentroidY: number|null}} `v` is the row's offset from the
 *   centre in disc radii (negative is up).
 */
export function latitudeProfile(image, disc) {
  const W = image.width;
  const H = image.height;
  const d = image.data;
  const { minX, maxX, minY, maxY } = disc;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const r = (maxX - minX + (maxY - minY)) / 4;
  const rows = [];
  for (let y = Math.ceil(cy - r); y <= Math.floor(cy + r); y++) {
    if (y < 0 || y >= H) continue;
    const dy = (y - cy) / r;
    if (Math.abs(dy) > 0.93) continue;
    const halfW = Math.sqrt(Math.max(0, 1 - dy * dy)) * r * 0.93;
    if (halfW < 3) continue;
    let n = 0,
      land = 0,
      ice = 0;
    const x0 = Math.max(0, Math.ceil(cx - halfW));
    const x1 = Math.min(W - 1, Math.floor(cx + halfW));
    for (let x = x0; x <= x1; x++) {
      const i = 4 * (y * W + x);
      const R = d[i],
        G = d[i + 1],
        Bl = d[i + 2];
      n++;
      const L = luminance(R, G, Bl);
      const isIce = L > 130 && Math.abs(R - Bl) < 40 && Math.abs(R - G) < 40;
      const isLand = isIce || (R > Bl + 8 && L > 30);
      if (isIce) ice++;
      if (isLand) land++;
    }
    rows.push({ y, v: dy, landFrac: land / n, iceCnt: ice });
  }
  let iceSum = 0,
    iceWY = 0;
  for (const rr of rows) {
    iceSum += rr.iceCnt;
    iceWY += rr.iceCnt * rr.y;
  }
  return {
    r,
    cy,
    rows,
    icePx: iceSum,
    iceCentroidY: iceSum > 0 ? iceWY / iceSum : null,
  };
}

/** The land fraction of the profile row nearest `v` (first row wins a tie). */
function sampleLandFraction(profile, v) {
  let best = null,
    bd = 1e9;
  for (const rr of profile.rows) {
    const dd = Math.abs(rr.v - v);
    if (dd < bd) {
      bd = dd;
      best = rr;
    }
  }
  return best ? best.landFrac : 0;
}

/**
 * The vertical shift (in disc radii, searched over [-0.2, 0.2] in 0.005 steps)
 * that best aligns the second profile's top half to the first's, by mean
 * absolute land-fraction error over `v` in [-0.9, 0] at 0.01 steps.
 *
 * @param {{rows: Array<{v: number, landFrac: number}>}} first
 * @param {{rows: Array<{v: number, landFrac: number}>}} second
 * @returns {{shift: number, error: number}} The first minimum, in search order,
 *   after a stable ascending sort by error — the tie-break the original had.
 */
export function bestProfileShift(first, second) {
  const shifts = [];
  for (let s = -0.2; s <= 0.2001; s += 0.005) {
    let err = 0,
      cnt = 0;
    for (let v = -0.9; v <= 0; v += 0.01) {
      err += Math.abs(
        sampleLandFraction(first, v) - sampleLandFraction(second, v + s),
      );
      cnt++;
    }
    shifts.push({ s, err: err / cnt });
  }
  shifts.sort((a, b) => a.err - b.err);
  return { shift: shifts[0].s, error: shifts[0].err };
}
