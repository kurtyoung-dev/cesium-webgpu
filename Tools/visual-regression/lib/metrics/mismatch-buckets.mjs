// mismatch-buckets.mjs — where a cross-backend mismatch sits on a globe frame, and what shape it has.
// @purpose Pure RGBA metric: decompose a mismatch mask over a globe-disc frame into space, limb, thin interior structure and interior blobs split by which image is brighter, count the dark-navy tile-seam fingerprint, and paint the bucket mask.
// @status ACTIVE
//
// WHERE IT CAME FROM. GLOBE-POLAR-STRETCH-POLISH decomposed the residual
// WebGL-vs-WebGPU mismatch of `probe-globe-polar-stretch` into buckets, and
// FARZOOM-INTERIOR-BLOBS (Q23) re-ran the same decomposition with the ground
// atmosphere toggled (`probe-globe-farzoom`, retired with its conclusion
// banked). Both carried the same in-page code; this module is that code moved
// to Node, held to the original source by `metrics-globe-extraction.spec.mjs`.
//
// THE BUCKETS, by the pixel's distance from the consensus disc centre in disc
// radii (see `globe-disc.mjs`):
//   space                   r > 1.02 — outside the disc (stars, background)
//   limb                    0.90 < r <= 1.02 — the atmosphere ring
//   seamThin                interior pixels that do not survive a 3x3
//                           morphological opening (thin lines, edge noise)
//   interiorBlobGlBrighter  interior opened pixels where FIRST is brighter
//   interiorBlobGpuBrighter interior opened pixels where SECOND is brighter
// The bucket names keep the probe's report keys, so FIRST is the WebGL frame
// and SECOND the WebGPU frame, and every signed delta is SECOND minus FIRST.
//
// THE SEAM FINGERPRINT is the probe's BUG-GLOBE-TILE-SEAM-LINES test on a
// seamThin pixel: SECOND darker by more than 20 luma, bluer (blue delta minus
// the mean red/green delta) by more than 15, and absolutely dark (SECOND luma
// < 90), which is the exposed dark-blue initial colour and excludes the bright
// inner-limb gradient that shares the darker-and-bluer delta.
//
// Pure: no I/O and no gate decision.

import { luminance } from "./luminance.mjs";

/** Report order of the buckets, as the probe printed and banked them. */
export const MISMATCH_BUCKETS = Object.freeze([
  "space",
  "limb",
  "seamThin",
  "interiorBlobGlBrighter",
  "interiorBlobGpuBrighter",
]);

/** Paint colour per bucket in the bucket-mask image; seam-fingerprint pixels are blue. */
const BUCKET_COLOUR = Object.freeze({
  space: [255, 0, 255],
  limb: [255, 160, 0],
  seamThin: [0, 255, 255],
  seamFingerprint: [0, 0, 255],
  interiorBlobGlBrighter: [255, 0, 0],
  interiorBlobGpuBrighter: [0, 255, 0],
});

function lumAt(data, i) {
  return luminance(data[i], data[i + 1], data[i + 2]);
}

function morph(m, cw, ch, isErode) {
  const o = new Uint8Array(cw * ch);
  for (let y = 1; y < ch - 1; y++) {
    for (let x = 1; x < cw - 1; x++) {
      let acc = isErode ? 1 : 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const v = m[(y + dy) * cw + (x + dx)];
          if (isErode && !v) acc = 0;
          if (!isErode && v) acc = 1;
        }
      }
      o[y * cw + x] = acc;
    }
  }
  return o;
}

/**
 * A 3x3 morphological opening (erosion, then dilation) of a binary mask. The
 * one-pixel border is left 0 in both passes, as the original did.
 *
 * @param {ArrayLike<number>} mask Row-major, `width * height`.
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array}
 */
export function openMask(mask, width, height) {
  return morph(morph(mask, width, height, true), width, height, false);
}

/**
 * Bucket every mismatching pixel of a crop.
 *
 * @param {{width: number, height: number, data: ArrayLike<number>}} first The WebGL frame.
 * @param {{width: number, height: number, data: ArrayLike<number>}} second The WebGPU frame.
 * @param {object} options
 * @param {{x0: number, y0: number, x1: number, y1: number}} options.crop Half-open crop the mask covers.
 * @param {ArrayLike<number>} options.mask Mismatch mask over the crop (e.g. `rgbSumDiff(..., {roi: crop, returnMask: true}).mask`).
 * @param {{cx: number, cy: number, radius: number}} options.disc Consensus disc centre and radius (`discCentreRadius`).
 * @returns {{counts: Record<string, number>,
 *   sums: Record<string, {dr: number, dg: number, db: number}>,
 *   positionSums: Record<string, {x: number, y: number}>,
 *   seamFingerprintPx: number, maskRgba: Uint8ClampedArray,
 *   maskWidth: number, maskHeight: number}} `maskRgba` is FIRST dimmed to a
 *   quarter with each mismatching pixel painted its bucket's colour.
 *   `positionSums` are full-frame pixel coordinates summed per bucket, so
 *   `bucketCentroids` can say where a bucket sits (the retired farzoom probe
 *   read the GPU-brighter blob's centroid to confirm it stayed over the same
 *   high-latitude region with the ground atmosphere on and off).
 * @throws {RangeError} When the two frames differ in size, since the buckets
 *   compare the pixel at one index in both.
 */
export function mismatchBuckets(first, second, { crop, mask, disc }) {
  if (first.width !== second.width || first.height !== second.height) {
    throw new RangeError(
      `mismatchBuckets: size mismatch ${first.width}x${first.height} vs ${second.width}x${second.height}`,
    );
  }
  const W = first.width;
  const A = first.data;
  const B = second.data;
  const cw = crop.x1 - crop.x0;
  const ch = crop.y1 - crop.y0;
  const blob = openMask(mask, cw, ch);
  const { cx: dcx, cy: dcy, radius: dR } = disc;
  const counts = {};
  const sums = {};
  const positionSums = {};
  for (const k of MISMATCH_BUCKETS) {
    counts[k] = 0;
    sums[k] = { dr: 0, dg: 0, db: 0 };
    positionSums[k] = { x: 0, y: 0 };
  }
  let seamBlue = 0;
  const maskImg = new Uint8ClampedArray(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const mi = y * cw + x;
      const px = x + crop.x0,
        py = y + crop.y0;
      const gi = 4 * (py * W + px);
      maskImg[4 * mi] = A[gi] * 0.25;
      maskImg[4 * mi + 1] = A[gi + 1] * 0.25;
      maskImg[4 * mi + 2] = A[gi + 2] * 0.25;
      maskImg[4 * mi + 3] = 255;
      if (!mask[mi]) continue;
      const r = Math.hypot(px - dcx, py - dcy) / dR;
      let bucket, col;
      if (r > 1.02) {
        bucket = "space";
        col = BUCKET_COLOUR.space;
      } else if (r > 0.9) {
        bucket = "limb";
        col = BUCKET_COLOUR.limb;
      } else if (!blob[mi]) {
        bucket = "seamThin";
        col = BUCKET_COLOUR.seamThin;
        const gpuLum = lumAt(B, gi);
        const dlum = gpuLum - lumAt(A, gi);
        const dblue =
          B[gi + 2] - A[gi + 2] - (B[gi] - A[gi] + (B[gi + 1] - A[gi + 1])) / 2;
        if (dlum < -20 && dblue > 15 && gpuLum < 90) {
          seamBlue++;
          col = BUCKET_COLOUR.seamFingerprint;
        }
      } else if (lumAt(A, gi) > lumAt(B, gi)) {
        bucket = "interiorBlobGlBrighter";
        col = BUCKET_COLOUR.interiorBlobGlBrighter;
      } else {
        bucket = "interiorBlobGpuBrighter";
        col = BUCKET_COLOUR.interiorBlobGpuBrighter;
      }
      counts[bucket]++;
      sums[bucket].dr += B[gi] - A[gi];
      sums[bucket].dg += B[gi + 1] - A[gi + 1];
      sums[bucket].db += B[gi + 2] - A[gi + 2];
      positionSums[bucket].x += px;
      positionSums[bucket].y += py;
      maskImg[4 * mi] = col[0];
      maskImg[4 * mi + 1] = col[1];
      maskImg[4 * mi + 2] = col[2];
    }
  }
  return {
    counts,
    sums,
    positionSums,
    seamFingerprintPx: seamBlue,
    maskRgba: maskImg,
    maskWidth: cw,
    maskHeight: ch,
  };
}

/**
 * Each bucket's centroid in full-frame pixel coordinates, or `null` for an
 * empty bucket.
 *
 * @param {{counts: Record<string, number>, positionSums: Record<string, {x: number, y: number}>}} buckets
 * @returns {Record<string, {x: number, y: number}|null>}
 */
export function bucketCentroids({ counts, positionSums }) {
  const out = {};
  for (const k of MISMATCH_BUCKETS) {
    const n = counts[k];
    out[k] = n ? { x: positionSums[k].x / n, y: positionSums[k].y / n } : null;
  }
  return out;
}

/**
 * The per-bucket summary with the rounding the probe banked in its report:
 * `pctOfCrop` to 3 places, `pctOfMismatch` to 1, and the mean signed delta to 1.
 *
 * @param {{counts: Record<string, number>, sums: Record<string, {dr: number, dg: number, db: number}>}} buckets
 * @param {{cropPx: number, mismatchPx: number}} totals
 * @returns {Record<string, {px: number, pctOfCrop: number, pctOfMismatch: number,
 *   meanDelta_gpuMinusGl: {r: number, g: number, b: number}|null}>}
 */
export function summariseBuckets({ counts, sums }, { cropPx, mismatchPx }) {
  const out = {};
  for (const k of MISMATCH_BUCKETS) {
    const n = counts[k];
    out[k] = {
      px: n,
      pctOfCrop: +((100 * n) / cropPx).toFixed(3),
      pctOfMismatch: +((100 * n) / Math.max(1, mismatchPx)).toFixed(1),
      meanDelta_gpuMinusGl: n
        ? {
            r: +(sums[k].dr / n).toFixed(1),
            g: +(sums[k].dg / n).toFixed(1),
            b: +(sums[k].db / n).toFixed(1),
          }
        : null,
    };
  }
  return out;
}
