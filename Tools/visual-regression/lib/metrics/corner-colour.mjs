/**
 * @purpose Mean 8-bit RGB over the four corner patches of a frame and the channel that dominates it, for probes whose sky corners carry a known solid colour.
 * @status ACTIVE
 */

import { rectRoi, requireFinite } from "./masks.mjs";

/**
 * Mean RGB over the four square corner patches of an RGBA frame. On a view
 * whose globe sits in the middle, the corners are sky, so a sky box with solid
 * faces is read here without a globe mask.
 *
 * @param {{width: number, height: number, data: ArrayLike<number>}} image
 * @param {{patch?: number}} [options] Patch edge in pixels (default 48).
 * @returns {{r: number, g: number, b: number, pixels: number}}
 */
export function cornerMeans(image, options = {}) {
  const { width, height, data } = image;
  requireFinite(width, "width");
  requireFinite(height, "height");
  const patch = options.patch ?? 48;
  requireFinite(patch, "patch");
  const corners = [
    { x: 0, y: 0 },
    { x: width - patch, y: 0 },
    { x: 0, y: height - patch },
    { x: width - patch, y: height - patch },
  ];
  let r = 0;
  let g = 0;
  let b = 0;
  let pixels = 0;
  for (const corner of corners) {
    const { x0, y0, x1, y1 } = rectRoi({
      width,
      height,
      x: corner.x,
      y: corner.y,
      w: patch,
      h: patch,
    });
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 4;
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        pixels++;
      }
    }
  }
  if (pixels === 0) {
    return { r: 0, g: 0, b: 0, pixels: 0 };
  }
  return { r: r / pixels, g: g / pixels, b: b / pixels, pixels };
}

/**
 * The channel that exceeds both others by at least `margin`, or "none".
 *
 * @param {{r: number, g: number, b: number}} means
 * @param {{margin?: number}} [options] Minimum lead in 8-bit units (default 24).
 * @returns {"red"|"green"|"blue"|"none"}
 */
export function dominantChannel(means, options = {}) {
  const margin = options.margin ?? 24;
  const { r, g, b } = means;
  if (r - Math.max(g, b) >= margin) {
    return "red";
  }
  if (g - Math.max(r, b) >= margin) {
    return "green";
  }
  if (b - Math.max(r, g) >= margin) {
    return "blue";
  }
  return "none";
}
