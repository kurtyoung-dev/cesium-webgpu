/**
 * How far a treatment moved a frame's cloud pixels toward a reference colour,
 * as a fraction of the way there — the aerial-perspective gate's blend
 * coefficient, computed privately in that probe until the harvest.
 * @purpose Pure two-frame blend coefficient over decoded RGBA: over pixels bright in either frame, the distance the mean colour moved from OFF to ON divided by the distance from OFF to a reference colour.
 * @status ACTIVE
 *
 * THE MODEL. Aerial perspective maps each un-hazed colour toward a haze colour
 * by a fraction `a`: `on = mix(off, haze, a)`. Averaged over the cloud pixels,
 * `|meanOn - meanOff| / |meanOff - haze|` recovers `a` without depending on
 * how bright the clouds were to begin with, which a raw colour distance would
 * confound (near undersides are dim, far ones are not).
 *
 * WHICH PIXELS. A pixel counts when its Rec. 601 luma is at least `lumaFloor`
 * in EITHER frame, so the black background is excluded and a cloud that only
 * one arm lights is not. Rows `[floor(h * y0), floor(h * y1))`, every column.
 *
 * THE GUARD. When the OFF mean is within one level (Euclidean, 0-255) of the
 * reference, the ratio is ill-conditioned and the coefficient is reported as
 * 0, as the in-page copy did.
 */

import { rec601Luma, requireSameSize } from "./luma-difference.mjs";

const distance = (a, b) =>
  Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);

/**
 * The blend coefficient of `on` over `off` toward `reference`.
 *
 * @param {{width: number, height: number, data: ArrayLike<number>}} off The untreated frame.
 * @param {{width: number, height: number, data: ArrayLike<number>}} on The treated frame.
 * @param {number[]} reference The reference colour as three 0-1 channels.
 * @param {object} [options] Options.
 * @param {number} [options.y0] First row, as a fraction of the height; default 0.
 * @param {number} [options.y1] End row (exclusive), as a fraction; default 1.
 * @param {number} [options.lumaFloor] Luma a pixel must reach in either frame; default 40.
 * @returns {{cloud: number, meanOff?: number[], meanOn?: number[], a?: number}}
 *   `cloud` pixels counted; with none, only `{cloud: 0}`. Means are 0-1.
 */
export function aerialBlendCoefficient(
  off,
  on,
  reference,
  { y0 = 0, y1 = 1, lumaFloor = 40 } = {},
) {
  requireSameSize(off, on, "aerialBlendCoefficient");
  const { width: w, height: h } = off;
  const o = off.data;
  const n = on.data;
  const ref255 = [reference[0] * 255, reference[1] * 255, reference[2] * 255];
  let cloud = 0;
  const so = [0, 0, 0];
  const sn = [0, 0, 0];
  for (let y = Math.floor(h * y0); y < Math.floor(h * y1); y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (
        Math.max(
          rec601Luma(o[i], o[i + 1], o[i + 2]),
          rec601Luma(n[i], n[i + 1], n[i + 2]),
        ) < lumaFloor
      ) {
        continue;
      }
      cloud++;
      so[0] += o[i];
      so[1] += o[i + 1];
      so[2] += o[i + 2];
      sn[0] += n[i];
      sn[1] += n[i + 1];
      sn[2] += n[i + 2];
    }
  }
  if (!cloud) {
    return { cloud: 0 };
  }
  const meanOff = so.map((v) => v / cloud);
  const meanOn = sn.map((v) => v / cloud);
  const toReference = distance(meanOff, ref255);
  const moved = distance(meanOff, meanOn);
  return {
    cloud,
    meanOff: meanOff.map((v) => v / 255),
    meanOn: meanOn.map((v) => v / 255),
    a: toReference > 1 ? moved / toReference : 0,
  };
}
