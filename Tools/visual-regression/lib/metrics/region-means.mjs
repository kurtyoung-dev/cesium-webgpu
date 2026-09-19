/**
 * @purpose Whole-image means over a cloud mask: captured alpha with its coverage fraction, and the fraction of cloud pixels whose colour has collapsed onto the aerial tint.
 * @status ACTIVE
 */

import { requireFinite as finite } from "./masks.mjs";

/**
 * O3's corroborating image leg: the fraction of cloud pixels whose colour has
 * collapsed onto the aerial tint.
 *
 * At the cap the shader emits `mix(toneMapped, aerialColor, 0.85)`, i.e. 85 %
 * of the horizon tint and 15 % of the cloud's own radiance, so a capped pixel
 * sits within `0.15 * |cloud - tint|` of the tint. The tolerance is therefore
 * not a tuning knob: it is what "capped" means, expressed in the channel units
 * the capture carries. Pixels outside the supplied cloud mask are ignored.
 *
 * @returns {{cloudPixels:number, cappedPixels:number, fraction:(number|null)}}
 */
export function imageAerialCapFraction(
  rgba,
  { width, height, cloudMask, aerialColor, tolerance = 0.15 },
) {
  finite(width, "width");
  finite(height, "height");
  if (
    !aerialColor ||
    ![aerialColor.r, aerialColor.g, aerialColor.b].every(Number.isFinite)
  ) {
    throw new TypeError(
      "imageAerialCapFraction requires the live aerialColor uniform",
    );
  }
  let cloudPixels = 0;
  let cappedPixels = 0;
  for (let index = 0; index < width * height; index++) {
    if (cloudMask && cloudMask[index] !== 1) {
      continue;
    }
    cloudPixels++;
    const base = index * 4;
    const dr = rgba[base] / 255 - aerialColor.r;
    const dg = rgba[base + 1] / 255 - aerialColor.g;
    const db = rgba[base + 2] / 255 - aerialColor.b;
    if (Math.sqrt(dr * dr + dg * dg + db * db) <= tolerance) {
      cappedPixels++;
    }
  }
  return {
    cloudPixels,
    cappedPixels,
    fraction: cloudPixels === 0 ? null : cappedPixels / cloudPixels,
  };
}

/**
 * Mean cloud alpha over a capture, given a mask of which pixels are cloud.
 *
 * "Alpha" here is the captured alpha channel, which is what the composite left
 * behind; a caller with no alpha (an opaque capture) passes a derived mask and
 * gets a coverage fraction instead. Both are stated in the return so a reader
 * knows which one a rung carries.
 */
export function meanCloudAlpha(rgba, { width, height, cloudMask = null }) {
  let sum = 0;
  let count = 0;
  let masked = 0;
  for (let index = 0; index < width * height; index++) {
    if (cloudMask && cloudMask[index] !== 1) {
      continue;
    }
    masked++;
    sum += rgba[index * 4 + 3] / 255;
    count++;
  }
  return {
    meanAlpha: count === 0 ? 0 : sum / count,
    cloudPixels: masked,
    totalPixels: width * height,
    coverageFraction: masked / (width * height),
  };
}
