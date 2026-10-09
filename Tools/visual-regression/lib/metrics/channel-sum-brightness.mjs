// channel-sum-brightness.mjs — the OFF/ON brightness change the clustered-lighting probes read.
// @purpose Pure RGBA metric over a half-open region of two same-sized frames: the per-pixel change in the channel sum R+G+B (mean before, mean after, signed mean change, the count of pixels whose absolute sum change exceeds a threshold, and the largest such change), plus the fractional-box arithmetic those probes place the region by.
// @status ACTIVE
//
// WHAT MOVED HERE. Five clustered-lighting probes (`probe-clustered-demo-scene`,
// `-litmat`, `-multifrustum`, `-phong`, `-visible`) each carried a private copy
// of one loop, run inside a second "decoder" browser over two page screenshots:
// for every pixel of a box, `sOff = R+G+B` of the OFF frame and `sOn = R+G+B` of
// the ON frame, summed into two means, with a pixel counted as changed when
// `|sOn - sOff| > 5` and the largest such difference kept. They differed only
// in the box: the whole frame (demo-scene), `[0.3, 0.7)` on both axes (litmat,
// phong), `[0.3, 0.7) x [0.35, 0.75)` (multifrustum) and `[0.25, 0.75)` on both
// axes (visible). `channelSumChange` is that loop over decoded PNG bytes in
// Node; `fractionalRoi` is the box arithmetic (`Math.floor(width * fraction)`,
// half-open). phong wrote `(width * 0.3) | 0` instead of `Math.floor`, which is
// the same integer for every non-negative product below 2^31.
// `metrics-clustered.spec.mjs` holds both functions equal to verbatim
// reference copies of the five originals.
//
// WHY THIS IS NOT `lib/image-diff.mjs`. `diffImages` calls a pixel changed
// when its LARGEST single-channel difference exceeds a tolerance. These probes
// ask whether a pixel got BRIGHTER or DARKER: the difference of the two channel
// sums. A pixel whose three channels each rise by 4 changes its sum by 12 and
// trips this rule at 5, while its largest channel difference is 4 and trips no
// `diffImages` tolerance of 4 or more. The banked bars (`changedPx >= 50`,
// `>= 200`) are bars on THIS count and cannot be re-read through `diffImages`.
//
// WHY THIS IS NOT A SUM OF ABSOLUTE CHANNEL DIFFERENCES. That rule
// (`|dR| + |dG| + |dB|`) counts a hue shift at constant brightness (red +10,
// green -10) as a change of 20. The rule here, `|(R'+G'+B') - (R+G+B)|`, counts
// it as 0. The clustered probes measure added light, so a hue shift that adds
// no brightness is, by their own definition, no contribution.
//
// FAILS CLOSED. Two frames of different sizes throw rather than return a
// number: the originals indexed the ON frame by the OFF frame's width and read
// past or beside it, and a metric that answers a size mismatch with any value
// at all lets the check it feeds pass on a pair it never measured. A region
// that is empty, fractional or outside the frame also throws.
//
// Pure: no I/O, no browser, no gate decision. The probes own their bars.

import { requireFinite } from "./masks.mjs";

/**
 * @typedef {{width: number, height: number, data: ArrayLike<number>}} RgbaImage
 * @typedef {{x0: number, y0: number, x1: number, y1: number}} Roi Half-open pixel bounds.
 */

/** The per-pixel sum change the five originals counted as "changed" (`> 5`). */
export const DEFAULT_SUM_CHANGE_THRESHOLD = 5;

function requireImage(image, what) {
  const ok =
    image !== null &&
    typeof image === "object" &&
    Number.isInteger(image.width) &&
    Number.isInteger(image.height) &&
    image.width > 0 &&
    image.height > 0 &&
    image.data !== null &&
    typeof image.data === "object" &&
    image.data.length === image.width * image.height * 4;
  if (!ok) {
    throw new TypeError(
      `${what} must be a decoded RGBA image {width, height, data} with data.length === width * height * 4`,
    );
  }
}

function requireRoiInside(width, height, roi) {
  const inside =
    roi !== null &&
    typeof roi === "object" &&
    Number.isInteger(roi.x0) &&
    Number.isInteger(roi.y0) &&
    Number.isInteger(roi.x1) &&
    Number.isInteger(roi.y1) &&
    roi.x0 >= 0 &&
    roi.y0 >= 0 &&
    roi.x1 <= width &&
    roi.y1 <= height &&
    roi.x0 < roi.x1 &&
    roi.y0 < roi.y1;
  if (!inside) {
    throw new RangeError(
      `roi ${JSON.stringify(roi)} is not a non-empty integer box inside ${width}x${height}`,
    );
  }
}

/**
 * The half-open pixel box a fractional box covers: `x0 = floor(width * left)`,
 * `x1 = floor(width * right)`, and the same for `y` with `top`/`bottom`.
 *
 * @param {number} width Frame width in pixels.
 * @param {number} height Frame height in pixels.
 * @param {{left?: number, right?: number, top?: number, bottom?: number}} [box]
 *   Fractions in `[0, 1]`; the defaults are the whole frame.
 * @returns {Roi} The frozen half-open box.
 */
export function fractionalRoi(width, height, box = {}) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new RangeError(
      `fractionalRoi needs positive integer dimensions, received ${width}x${height}`,
    );
  }
  const { left = 0, right = 1, top = 0, bottom = 1 } = box;
  for (const [name, value] of [
    ["left", left],
    ["right", right],
    ["top", top],
    ["bottom", bottom],
  ]) {
    requireFinite(value, `fractionalRoi ${name}`);
    if (value < 0 || value > 1) {
      throw new RangeError(
        `fractionalRoi ${name} must lie in [0, 1], received ${value}`,
      );
    }
  }
  const roi = {
    x0: Math.floor(width * left),
    y0: Math.floor(height * top),
    x1: Math.floor(width * right),
    y1: Math.floor(height * bottom),
  };
  requireRoiInside(width, height, roi);
  return Object.freeze(roi);
}

/**
 * The change in per-pixel channel sum `R + G + B` from `before` to `after`
 * over a region.
 *
 * @param {RgbaImage} before The reference frame (the probes' OFF capture).
 * @param {RgbaImage} after The treated frame (the probes' ON capture).
 * @param {{roi?: Roi, threshold?: number}} [options] `roi` defaults to the
 *   whole frame; `threshold` defaults to {@link DEFAULT_SUM_CHANGE_THRESHOLD}
 *   and a pixel counts as changed when its absolute sum change is STRICTLY
 *   greater, as every original wrote it.
 * @returns {{countedPx: number, meanBefore: number, meanAfter: number,
 *   delta: number, changedPx: number, maxDelta: number, threshold: number,
 *   roi: Roi}} `meanBefore`/`meanAfter` are mean channel sums (0-765) over the
 *   region, `delta` is `meanAfter - meanBefore`, `maxDelta` is the largest
 *   absolute per-pixel sum change (0 when nothing changed).
 * @throws {RangeError} When the frames differ in size or the region is not a
 *   non-empty integer box inside them.
 */
export function channelSumChange(before, after, options = {}) {
  requireImage(before, "before");
  requireImage(after, "after");
  if (before.width !== after.width || before.height !== after.height) {
    throw new RangeError(
      `channelSumChange: frame size mismatch ${before.width}x${before.height} vs ${after.width}x${after.height}; a pair of two sizes cannot be measured`,
    );
  }
  const threshold = requireFinite(
    options.threshold ?? DEFAULT_SUM_CHANGE_THRESHOLD,
    "channelSumChange threshold",
  );
  const width = before.width;
  const roi = options.roi ?? {
    x0: 0,
    y0: 0,
    x1: width,
    y1: before.height,
  };
  requireRoiInside(width, before.height, roi);

  const a = before.data;
  const b = after.data;
  let sumBefore = 0;
  let sumAfter = 0;
  let counted = 0;
  let changed = 0;
  let maxDelta = 0;
  for (let y = roi.y0; y < roi.y1; y++) {
    for (let x = roi.x0; x < roi.x1; x++) {
      const i = (y * width + x) * 4;
      const sBefore = a[i] + a[i + 1] + a[i + 2];
      const sAfter = b[i] + b[i + 1] + b[i + 2];
      sumBefore += sBefore;
      sumAfter += sAfter;
      counted += 1;
      const d = Math.abs(sAfter - sBefore);
      if (d > threshold) {
        changed += 1;
      }
      if (d > maxDelta) {
        maxDelta = d;
      }
    }
  }
  return {
    countedPx: counted,
    meanBefore: sumBefore / counted,
    meanAfter: sumAfter / counted,
    delta: (sumAfter - sumBefore) / counted,
    changedPx: changed,
    maxDelta,
    threshold,
    roi: Object.freeze({ x0: roi.x0, y0: roi.y0, x1: roi.x1, y1: roi.y1 }),
  };
}
