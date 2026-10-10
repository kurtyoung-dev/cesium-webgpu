/**
 * @purpose Voxel-family frame metrics over decoded RGBA: region colour statistics, the coarse footprint grid with its per-cell colours, mask IoU, the interior per-cell colour match, a cropped frame-pair difference and a centre-crop mean channel difference.
 * @status ACTIVE
 *
 * WHERE THESE CAME FROM. Six voxel probes each carried a private copy of the
 * same arithmetic, run INSIDE the page: the Playwright screenshot was sent back
 * as a data URL, drawn into a 2-D canvas and read out with `getImageData`.
 *
 *   - `probe-voxel-parity.mjs` Part A, `probe-voxel-ellipsoid.mjs`,
 *     `probe-voxel-cylinder.mjs` and `probe-voxel-user-customshader.mjs`: the
 *     centred region `[0.2w, 0.2h] + [0.55w, 0.6h]`, a 64 x 48 sample grid over
 *     it whose non-black cells (`r+g+b > 20`) form the footprint mask, and the
 *     average colour and coverage of the region's non-black pixels.
 *   - `probe-voxel-megatexture.mjs` PART 1 and PART 2: the same statistics
 *     over the region `[0.28w, 0.28h] + [0.4w, 0.4h]` (PART 1) and
 *     `[0.3w, 0.3h] + [0.4w, 0.4h]` (PART 2), threshold `r+g+b > 12`.
 *   - `probe-voxel-megatexture.mjs` PART 3: the two corner-A frames compared
 *     over `[0.2w, 0.2h] + [0.6w, 0.6h]`, a pixel differing when any channel
 *     moves by more than 8.
 *   - `probe-voxel-octree.mjs` / `probe-voxel-octree-l3plus.mjs`: the far-view
 *     centre crop `[0.3w, 0.3h] + [0.4w, 0.4h]`, flattened to RGB triples, and
 *     the mean absolute channel difference between the two backends.
 *
 * The functions below are that arithmetic, unchanged, over bytes decoded in
 * Node by `Tools/lib/png-decode.mjs` instead of by a browser canvas. The
 * region rounding is the probes' own — `Math.floor(width * fraction)` for the
 * origin and for the extent separately — and every threshold is a parameter
 * whose default is the value the probes used, so a caller that passes nothing
 * reproduces the pre-migration number from the same frame. The one departure
 * is deliberate and fails closed: a frame pair of different sizes, or a region
 * that crops to nothing, answers NaN in `framePairRegionDifference` and
 * `cropMeanAbsDifference`, so a caller's bar fails instead of scoring
 * misaligned or absent pixels.
 *
 * NOTHING HERE DECIDES A VERDICT. A caller compares these numbers with its own
 * bars; this module only measures.
 */

import { diffImages } from "../image-diff.mjs";
import { rectRoi, requireFinite } from "./masks.mjs";

/** The centred region the parity, shape and custom-shader probes measure. */
export const VOXEL_PARITY_REGION = Object.freeze({
  x: 0.2,
  y: 0.2,
  w: 0.55,
  h: 0.6,
});

/** `r+g+b` above which a parity-family sample counts as part of the footprint. */
export const VOXEL_FOOTPRINT_LUM_THRESHOLD = 20;

/** The footprint grid's resolution, as every parity-family probe sampled it. */
export const VOXEL_FOOTPRINT_GRID = Object.freeze({ width: 64, height: 48 });

/**
 * Validate a decoded RGBA image. Fails loudly: a metric computed over the
 * wrong number of bytes is a number about nothing.
 *
 * @param {{width: number, height: number, data: ArrayLike<number>}} image
 * @param {string} what Name used in the error.
 * @returns {{width: number, height: number, data: ArrayLike<number>}}
 */
function requireImage(image, what) {
  requireFinite(image?.width, `${what}.width`);
  requireFinite(image?.height, `${what}.height`);
  if (image.data?.length !== image.width * image.height * 4) {
    throw new TypeError(
      `${what} must carry ${image.width * image.height * 4} RGBA bytes, received ${image.data?.length}`,
    );
  }
  return image;
}

/**
 * A region given as fractions of the frame, rounded the way the voxel probes
 * rounded it: origin and extent are each floored separately, then clamped to
 * the frame through the kit's `rectRoi`.
 *
 * @param {{width: number, height: number}} image The frame.
 * @param {{x: number, y: number, w: number, h: number}} fractions Region as fractions.
 * @returns {{x0: number, y0: number, x1: number, y1: number}} Half-open pixel bounds.
 */
export function fractionalRegion(image, fractions) {
  const { width, height } = image;
  requireFinite(width, "width");
  requireFinite(height, "height");
  for (const key of ["x", "y", "w", "h"]) {
    requireFinite(fractions?.[key], `fractions.${key}`);
  }
  return rectRoi({
    width,
    height,
    x: Math.floor(width * fractions.x),
    y: Math.floor(height * fractions.y),
    w: Math.floor(width * fractions.w),
    h: Math.floor(height * fractions.h),
  });
}

/**
 * Colour statistics of a region's non-black pixels.
 *
 * `nonBlack` counts pixels with `r+g+b > lumThreshold` (strictly), and the
 * average colour is taken over exactly those pixels, each channel rounded,
 * with the pixel count floored at 1 so an empty region reports black rather
 * than NaN. `maxLum` is the largest `r+g+b` anywhere in the region, black or
 * not. `distinctColours` counts non-black pixels by `channel >> quantizeShift`.
 *
 * @param {{width: number, height: number, data: ArrayLike<number>}} image Decoded RGBA.
 * @param {{x0: number, y0: number, x1: number, y1: number}} region Half-open pixel bounds.
 * @param {{lumThreshold?: number, quantizeShift?: number}} [options]
 * @returns {{sampled: number, nonBlack: number, coveragePct: number,
 *   avgColor: number[], distinctColours: number, maxLum: number}}
 */
export function regionColourStats(image, region, options = {}) {
  requireImage(image, "image");
  const lumThreshold = options.lumThreshold ?? VOXEL_FOOTPRINT_LUM_THRESHOLD;
  const quantizeShift = options.quantizeShift ?? 4;
  const { data, width } = image;
  let nonBlack = 0;
  let maxLum = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  const colours = new Set();
  for (let y = region.y0; y < region.y1; y++) {
    for (let x = region.x0; x < region.x1; x++) {
      const o = (y * width + x) * 4;
      const r = data[o];
      const g = data[o + 1];
      const b = data[o + 2];
      const lum = r + g + b;
      if (lum > lumThreshold) {
        nonBlack++;
        sumR += r;
        sumG += g;
        sumB += b;
        colours.add(
          `${r >> quantizeShift}_${g >> quantizeShift}_${b >> quantizeShift}`,
        );
      }
      if (lum > maxLum) {
        maxLum = lum;
      }
    }
  }
  const sampled = (region.x1 - region.x0) * (region.y1 - region.y0);
  const n = Math.max(1, nonBlack);
  return {
    sampled,
    nonBlack,
    coveragePct: sampled > 0 ? (nonBlack / sampled) * 100 : 0,
    avgColor: [
      Math.round(sumR / n),
      Math.round(sumG / n),
      Math.round(sumB / n),
    ],
    distinctColours: colours.size,
    maxLum,
  };
}

/**
 * The coarse footprint grid: one sample per grid cell at
 * `x0 + floor((gx / gridWidth) * regionWidth)`, likewise in y, marked when its
 * `r+g+b` exceeds the threshold. Each marked cell keeps the sampled colour;
 * `colourClasses` counts the marked samples by `channel >> quantizeShift`.
 *
 * @param {{width: number, height: number, data: ArrayLike<number>}} image Decoded RGBA.
 * @param {{x0: number, y0: number, x1: number, y1: number}} region Half-open pixel bounds.
 * @param {{gridWidth?: number, gridHeight?: number, lumThreshold?: number, quantizeShift?: number}} [options]
 * @returns {{gridWidth: number, gridHeight: number, mask: Uint8Array,
 *   cellRgb: Array<number[]|null>, maskCells: number, colourClasses: number}}
 */
export function footprintGrid(image, region, options = {}) {
  requireImage(image, "image");
  const gridWidth = options.gridWidth ?? VOXEL_FOOTPRINT_GRID.width;
  const gridHeight = options.gridHeight ?? VOXEL_FOOTPRINT_GRID.height;
  const lumThreshold = options.lumThreshold ?? VOXEL_FOOTPRINT_LUM_THRESHOLD;
  const quantizeShift = options.quantizeShift ?? 5;
  const { data, width } = image;
  const regionWidth = region.x1 - region.x0;
  const regionHeight = region.y1 - region.y0;
  const mask = new Uint8Array(gridWidth * gridHeight);
  const cellRgb = new Array(gridWidth * gridHeight).fill(null);
  const colours = new Set();
  let maskCells = 0;
  for (let gy = 0; gy < gridHeight; gy++) {
    for (let gx = 0; gx < gridWidth; gx++) {
      const sx = region.x0 + Math.floor((gx / gridWidth) * regionWidth);
      const sy = region.y0 + Math.floor((gy / gridHeight) * regionHeight);
      const o = (sy * width + sx) * 4;
      const r = data[o];
      const g = data[o + 1];
      const b = data[o + 2];
      if (r + g + b > lumThreshold) {
        const index = gy * gridWidth + gx;
        mask[index] = 1;
        cellRgb[index] = [r, g, b];
        colours.add(
          `${r >> quantizeShift}_${g >> quantizeShift}_${b >> quantizeShift}`,
        );
        maskCells++;
      }
    }
  }
  return {
    gridWidth,
    gridHeight,
    mask,
    cellRgb,
    maskCells,
    colourClasses: colours.size,
  };
}

/**
 * Intersection-over-union of two equal-length binary masks. An empty union
 * reports `iou: 0`, as the probes did, never NaN.
 *
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @returns {{intersection: number, union: number, iou: number}}
 */
export function maskIoU(a, b) {
  if (a?.length !== b?.length) {
    throw new TypeError(
      `maskIoU needs equal-length masks, received ${a?.length} and ${b?.length}`,
    );
  }
  let intersection = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] && b[i]) {
      intersection++;
    }
    if (a[i] || b[i]) {
      union++;
    }
  }
  return { intersection, union, iou: union > 0 ? intersection / union : 0 };
}

/**
 * The L1 distance between two RGB triples.
 *
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
export function colourL1(a, b) {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

function populationStddev(values) {
  if (values.length === 0) {
    return 0;
  }
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  return Math.sqrt(
    values.reduce((sum, v) => sum + (v - mean) * (v - mean), 0) / values.length,
  );
}

/**
 * Per-cell colour agreement over the INTERIOR of two footprint grids: a cell
 * counts when it and its four neighbours are marked in BOTH grids, which keeps
 * the silhouette-edge sampling noise out of the comparison. A cell matches
 * when the Euclidean RGB distance is below `tolerance`.
 *
 * `referenceSpread` is the population standard deviation of the reference
 * grid's (first argument's) red values plus that of its green values over the
 * same interior cells: the probes' own floor proving the reference itself
 * carries a colour pattern for the match to discriminate. With no interior
 * cells `meanDistance` is 999, the probes' sentinel.
 *
 * @param {{gridWidth: number, gridHeight: number, mask: ArrayLike<number>, cellRgb: Array<number[]|null>}} reference
 * @param {{gridWidth: number, gridHeight: number, mask: ArrayLike<number>, cellRgb: Array<number[]|null>}} candidate
 * @param {{tolerance?: number}} [options]
 * @returns {{interiorCells: number, matchedCells: number, matchFraction: number,
 *   meanDistance: number, referenceSpread: number}}
 */
export function interiorCellColourMatch(reference, candidate, options = {}) {
  if (
    reference.gridWidth !== candidate.gridWidth ||
    reference.gridHeight !== candidate.gridHeight
  ) {
    throw new TypeError("interiorCellColourMatch needs grids of equal shape");
  }
  const tolerance = options.tolerance ?? 60;
  const gw = reference.gridWidth;
  const gh = reference.gridHeight;
  const a = reference.mask;
  const b = candidate.mask;
  let interiorCells = 0;
  let matchedCells = 0;
  let distanceSum = 0;
  const reds = [];
  const greens = [];
  for (let gy = 1; gy < gh - 1; gy++) {
    for (let gx = 1; gx < gw - 1; gx++) {
      const index = gy * gw + gx;
      const neighbours = [index - 1, index + 1, index - gw, index + gw];
      const interior =
        a[index] && b[index] && neighbours.every((n) => a[n] && b[n]);
      if (!interior) {
        continue;
      }
      const ca = reference.cellRgb[index];
      const cb = candidate.cellRgb[index];
      if (!ca || !cb) {
        continue;
      }
      interiorCells++;
      reds.push(ca[0]);
      greens.push(ca[1]);
      const distance = Math.hypot(ca[0] - cb[0], ca[1] - cb[1], ca[2] - cb[2]);
      distanceSum += distance;
      if (distance < tolerance) {
        matchedCells++;
      }
    }
  }
  return {
    interiorCells,
    matchedCells,
    matchFraction: interiorCells > 0 ? matchedCells / interiorCells : 0,
    meanDistance: interiorCells > 0 ? distanceSum / interiorCells : 999,
    referenceSpread: populationStddev(reds) + populationStddev(greens),
  };
}

/**
 * Two frames of the same view compared over one region: the region pixels
 * whose channels move by more than `tolerance`, and the first frame's
 * non-black count there. The shape is the one
 * `lib/voxel-megatexture-reupload-gate.mjs` reads (`nonBlackA`, `mismatchPct`).
 *
 * The comparison itself is the kit's `diffImages`, masked to the region, so
 * this module does not carry a second pixel diff. Frames of different sizes
 * are not comparable and report `comparable: false` with NaN counts rather
 * than a number about misaligned pixels, and an empty region's `mismatchPct`
 * is NaN as well (the retired in-page arithmetic's `0 / 0`). NaN, never null:
 * callers hold `mismatchPct < bar`, every comparison with NaN is false, so a
 * pair that cannot be measured FAILS the bar, while `null < bar` coerces null
 * to 0 and would pass it. (A JSON receipt prints NaN as null; `comparable`
 * says which case it was.)
 *
 * @param {{width: number, height: number, data: ArrayLike<number>}} a First frame.
 * @param {{width: number, height: number, data: ArrayLike<number>}} b Second frame.
 * @param {{x: number, y: number, w: number, h: number}} fractions Region as fractions of `a`.
 * @param {{tolerance?: number, lumThreshold?: number}} [options]
 * @returns {{comparable: boolean, total: number, nonBlackA: number,
 *   mismatch: number, mismatchPct: number}} `mismatch` and `mismatchPct`
 *   are NaN for an incomparable pair.
 */
export function framePairRegionDifference(a, b, fractions, options = {}) {
  requireImage(a, "a");
  requireImage(b, "b");
  const region = fractionalRegion(a, fractions);
  const total = (region.x1 - region.x0) * (region.y1 - region.y0);
  const nonBlackA = regionColourStats(a, region, {
    lumThreshold: options.lumThreshold ?? 12,
  }).nonBlack;
  if (a.width !== b.width || a.height !== b.height) {
    return {
      comparable: false,
      total,
      nonBlackA,
      mismatch: Number.NaN,
      mismatchPct: Number.NaN,
    };
  }
  const mask = new Uint8Array(a.width * a.height);
  for (let y = region.y0; y < region.y1; y++) {
    mask.fill(1, y * a.width + region.x0, y * a.width + region.x1);
  }
  const { changedPx } = diffImages(a, b, {
    tolerance: options.tolerance ?? 8,
    mask,
  });
  return {
    comparable: true,
    total,
    nonBlackA,
    mismatch: changedPx,
    mismatchPct: total > 0 ? (100 * changedPx) / total : Number.NaN,
  };
}

/**
 * A region's pixels as a flat `[r, g, b, r, g, b, ...]` list in row order.
 *
 * @param {{width: number, height: number, data: ArrayLike<number>}} image
 * @param {{x: number, y: number, w: number, h: number}} fractions
 * @returns {number[]}
 */
export function regionRgbValues(image, fractions) {
  requireImage(image, "image");
  const region = fractionalRegion(image, fractions);
  const values = [];
  for (let y = region.y0; y < region.y1; y++) {
    for (let x = region.x0; x < region.x1; x++) {
      const o = (y * image.width + x) * 4;
      values.push(image.data[o], image.data[o + 1], image.data[o + 2]);
    }
  }
  return values;
}

/**
 * The mean absolute channel difference between two frames' crops of the same
 * fractional region (the octree probes' far-view number).
 *
 * Fails closed, as {@link framePairRegionDifference} does. Frames of different
 * sizes are not comparable, and a region that crops to nothing has no mean, so
 * both answer NaN: callers hold `farDiff < bar`, every comparison with NaN is
 * false, so a pair that cannot be measured FAILS the bar. The retired in-page
 * code compared the two crops' value lists over the shorter one, so a smaller
 * frame was scored against misaligned pixels and could pass; a zero-extent
 * crop made the page's `getImageData` throw `IndexSizeError`, so that probe
 * crashed rather than passed (a `Math.max(1, n)` divisor would read it as 0).
 *
 * @param {{width: number, height: number, data: ArrayLike<number>}} a
 * @param {{width: number, height: number, data: ArrayLike<number>}} b
 * @param {{x: number, y: number, w: number, h: number}} [fractions]
 * @returns {number} NaN for frames of different sizes or an empty crop.
 */
export function cropMeanAbsDifference(
  a,
  b,
  fractions = { x: 0.3, y: 0.3, w: 0.4, h: 0.4 },
) {
  requireImage(a, "a");
  requireImage(b, "b");
  if (a.width !== b.width || a.height !== b.height) {
    return Number.NaN;
  }
  const va = regionRgbValues(a, fractions);
  const vb = regionRgbValues(b, fractions);
  let sum = 0;
  for (let i = 0; i < va.length; i++) {
    sum += Math.abs(va[i] - vb[i]);
  }
  // Same sizes, so the two lists are the same length. An empty crop divides
  // 0 by 0, which is NaN (the retired `Math.max(1, n)` made it 0, a pass).
  return sum / va.length;
}
