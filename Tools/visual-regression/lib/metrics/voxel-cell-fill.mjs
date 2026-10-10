/**
 * @purpose Voxel-family per-target metrics over decoded RGBA: the mean or luminance-median colour of a small window around a projected cell, and the fill-layout judgement (filled, empty or skipped per cell, per octree level) the voxel parity and octree probes gate on.
 * @status ACTIVE
 *
 * WHERE THESE CAME FROM. Two probe families sampled a window of the screenshot
 * around each projected voxel cell and asked whether it read lit or black:
 *
 *   - `probe-voxel-parity.mjs` Part B took the MEAN colour of a 7 x 7 window
 *     (`half = 3`) and judged each cell against an in-page expectation that
 *     was already `"filled"`, `"empty"` or `"skip"`: filled when
 *     `r+g+b > 40`, empty when `r+g+b < 25`.
 *   - `probe-voxel-octree.mjs` and `probe-voxel-octree-l3plus.mjs` took the
 *     MEDIAN pixel by `r+g+b` of a `(2 half + 1)` square window (robust to a
 *     stray star dot, which a mean is not) and judged each cell per octree
 *     level from the in-page ray fractions: filled when the centre ray spends
 *     at least 15 % of its in-box path in filled cells of that level's grid,
 *     empty only when every ray of the five-ray cone misses them, otherwise
 *     skipped; filled reads `r+g+b > 60`, empty `r+g+b < 40`.
 *
 * Both read the window with `CanvasRenderingContext2D.getImageData`, which
 * answers transparent black for pixels outside the canvas. The window readers
 * below reproduce that: a pixel outside the frame contributes `[0, 0, 0]`, and
 * the mean divides by the full window size. The centre is `Math.round` of the
 * projected coordinate, as the probes rounded it.
 *
 * NOTHING HERE PROJECTS A CELL OR MARCHES A RAY: those need the live camera and
 * stay in the page. What arrives here is the projected point, the ray
 * fractions the page computed and the decoded frame.
 */

import { requireFinite } from "./masks.mjs";

/** The parity probe's per-cell thresholds on `r+g+b`. */
export const PARITY_FILL_THRESHOLDS = Object.freeze({
  filledAbove: 40,
  emptyBelow: 25,
});

/** The octree probes' per-cell thresholds on `r+g+b`. */
export const OCTREE_FILL_THRESHOLDS = Object.freeze({
  filledAbove: 60,
  emptyBelow: 40,
});

/** Fraction of a centre ray's in-box path that makes a cell "filled". */
export const OCTREE_SOLID_FRACTION = 0.15;

function windowPixels(image, point, half) {
  requireFinite(image?.width, "image.width");
  requireFinite(image?.height, "image.height");
  requireFinite(half, "half");
  const cx = Math.round(point[0]);
  const cy = Math.round(point[1]);
  const pixels = [];
  for (let y = cy - half; y <= cy + half; y++) {
    for (let x = cx - half; x <= cx + half; x++) {
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) {
        pixels.push([0, 0, 0]);
        continue;
      }
      const o = (y * image.width + x) * 4;
      pixels.push([image.data[o], image.data[o + 1], image.data[o + 2]]);
    }
  }
  return pixels;
}

/**
 * The rounded mean colour of the `(2 half + 1)` square window centred on
 * `point`, or `null` when there is no point (the cell did not project).
 *
 * @param {{width: number, height: number, data: ArrayLike<number>}} image Decoded RGBA.
 * @param {number[]|null} point Window-space `[x, y]`.
 * @param {number} half Half-width of the window.
 * @returns {number[]|null}
 */
export function windowMeanRgb(image, point, half) {
  if (!point) {
    return null;
  }
  const pixels = windowPixels(image, point, half);
  let r = 0;
  let g = 0;
  let b = 0;
  for (const p of pixels) {
    r += p[0];
    g += p[1];
    b += p[2];
  }
  const n = pixels.length;
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

/**
 * The median pixel of the window by `r+g+b` (a stable sort, so ties keep row
 * order), or `null` when there is no point.
 *
 * @param {{width: number, height: number, data: ArrayLike<number>}} image Decoded RGBA.
 * @param {number[]|null} point Window-space `[x, y]`.
 * @param {number} half Half-width of the window.
 * @returns {number[]|null}
 */
export function windowMedianRgb(image, point, half) {
  if (!point) {
    return null;
  }
  const pixels = windowPixels(image, point, half);
  pixels.sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]));
  return pixels[Math.floor(pixels.length / 2)];
}

/**
 * One cell's verdict against one expectation.
 *
 * @param {"filled"|"empty"|"skip"} expected
 * @param {number} lum The cell's `r+g+b` (`-1` when it has no sample).
 * @param {{filledAbove: number, emptyBelow: number}} thresholds
 * @returns {"ok"|"MISSING"|"SPURIOUS"|"skip"}
 */
export function classifyFill(expected, lum, thresholds) {
  if (expected === "filled") {
    return lum > thresholds.filledAbove ? "ok" : "MISSING";
  }
  if (expected === "empty") {
    return lum < thresholds.emptyBelow ? "ok" : "SPURIOUS";
  }
  return "skip";
}

function lumOf(cell) {
  return cell.rgb ? cell.rgb[0] + cell.rgb[1] + cell.rgb[2] : -1;
}

/**
 * Judge cells whose expectation is already decided (`cell.expected`).
 *
 * @param {Array<{label: string, expected: string, rgb: number[]|null}>} cells
 * @param {{filledAbove: number, emptyBelow: number}} [thresholds]
 * @returns {{pass: boolean, rows: string[]}}
 */
export function judgeExpectedFill(cells, thresholds = PARITY_FILL_THRESHOLDS) {
  let pass = true;
  const rows = [];
  for (const cell of cells) {
    const verdict = classifyFill(cell.expected, lumOf(cell), thresholds);
    if (verdict === "MISSING" || verdict === "SPURIOUS") {
      pass = false;
    }
    rows.push(
      `${cell.label} expect=${cell.expected} rgb=${cell.rgb ? cell.rgb.join(",") : "?"} ${verdict}`,
    );
  }
  return { pass, rows };
}

/**
 * A cell's expectation at one octree level from the page's ray fractions:
 * `frac[level]` is the centre ray's filled fraction in that level's grid and
 * `coneAny[level]` whether any ray of the cone touched a filled cell there.
 *
 * @param {{frac: number[], coneAny: boolean[]}} cell
 * @param {number} level
 * @param {number} [solidFraction]
 * @returns {"filled"|"empty"|"skip"}
 */
export function expectFillAtLevel(
  cell,
  level,
  solidFraction = OCTREE_SOLID_FRACTION,
) {
  if (cell.frac[level] >= solidFraction) {
    return "filled";
  }
  if (!cell.coneAny[level]) {
    return "empty";
  }
  return "skip";
}

/**
 * Judge rendered cells against ONE level's analytic grid, counting the named
 * discriminator family: a discriminator cell (`cell[discriminator] === true`)
 * that is not skipped must read `"ok"` for the level to be considered really
 * rendered.
 *
 * @param {Array<object>} cells Cells with `label`, `frac`, `coneAny`, `rgb` and the discriminator flag.
 * @param {{level: number, discriminator: string, thresholds?: object, solidFraction?: number}} options
 * @returns {{pass: boolean, discriminators: number, discriminatorsOk: number, failures: string[]}}
 */
export function judgeLevelFill(cells, options) {
  const thresholds = options.thresholds ?? OCTREE_FILL_THRESHOLDS;
  let pass = true;
  let discriminators = 0;
  let discriminatorsOk = 0;
  const failures = [];
  for (const cell of cells) {
    const expected = expectFillAtLevel(
      cell,
      options.level,
      options.solidFraction,
    );
    const verdict = classifyFill(expected, lumOf(cell), thresholds);
    const isDiscriminator = cell[options.discriminator] === true;
    if (isDiscriminator && expected !== "skip") {
      discriminators++;
      if (verdict === "ok") {
        discriminatorsOk++;
      }
    }
    if (verdict === "MISSING" || verdict === "SPURIOUS") {
      pass = false;
      failures.push(
        `${cell.label} L${options.level}-expect=${expected}${isDiscriminator ? ` (${options.discriminator})` : ""} rgb=${cell.rgb ? cell.rgb.join(",") : "?"} ${verdict}`,
      );
    }
  }
  return { pass, discriminators, discriminatorsOk, failures };
}

/**
 * Judge rendered cells accepting EITHER of two levels per cell: a cell fails
 * only when it is a hard miss against both.
 *
 * @param {Array<object>} cells Cells with `label`, `frac`, `coneAny`, `rgb`.
 * @param {{levels: number[], thresholds?: object, solidFraction?: number}} options
 * @returns {{pass: boolean, failures: string[]}}
 */
export function judgeEitherLevelFill(cells, options) {
  const thresholds = options.thresholds ?? OCTREE_FILL_THRESHOLDS;
  const [la, lb] = options.levels;
  let pass = true;
  const failures = [];
  for (const cell of cells) {
    const lum = lumOf(cell);
    const va = classifyFill(
      expectFillAtLevel(cell, la, options.solidFraction),
      lum,
      thresholds,
    );
    const vb = classifyFill(
      expectFillAtLevel(cell, lb, options.solidFraction),
      lum,
      thresholds,
    );
    if (va !== "ok" && va !== "skip" && vb !== "ok" && vb !== "skip") {
      pass = false;
      failures.push(
        `${cell.label} rgb=${cell.rgb ? cell.rgb.join(",") : "?"} vsL${la}=${va} vsL${lb}=${vb}`,
      );
    }
  }
  return { pass, failures };
}
