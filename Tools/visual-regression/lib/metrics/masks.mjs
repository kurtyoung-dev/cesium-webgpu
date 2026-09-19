/**
 * @purpose Region-of-interest geometry for photometric statistics: the circular sun-disc mask every ROI must exclude, and a rectangle clamped to the image.
 * @status ACTIVE
 *
 * The leaf of `lib/metrics`: it imports nothing, so the shared finite-argument
 * check lives here rather than in a sibling that would then import back.
 */

export function requireFinite(value, what) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(
      `${what} must be a finite number, received ${String(value)}`,
    );
  }
  return value;
}

/**
 * A circular mask, used for the sun disc every photometric ROI must exclude.
 *
 * The radius is the caller's: the disc's apparent size depends on the camera's
 * field of view and the viewport, and inventing a constant here would silently
 * mask a different fraction of every scene. `probe-cloud-orbital-ladder.mjs`
 * derives its own from the sun's projected position and an angular radius.
 *
 * @returns {{width:number,height:number,data:Uint8Array,count:number}} 1 = inside.
 */
export function circularMask({
  width,
  height,
  centreX,
  centreY,
  radiusPixels,
}) {
  requireFinite(width, "width");
  requireFinite(height, "height");
  requireFinite(centreX, "centreX");
  requireFinite(centreY, "centreY");
  requireFinite(radiusPixels, "radiusPixels");
  if (radiusPixels < 0) {
    throw new RangeError(
      `radiusPixels must be non-negative, received ${radiusPixels}`,
    );
  }
  const data = new Uint8Array(width * height);
  const r2 = radiusPixels * radiusPixels;
  let count = 0;
  for (let y = 0; y < height; y++) {
    const dy = y + 0.5 - centreY;
    for (let x = 0; x < width; x++) {
      const dx = x + 0.5 - centreX;
      if (dx * dx + dy * dy <= r2) {
        data[y * width + x] = 1;
        count++;
      }
    }
  }
  return { width, height, data, count };
}

/** A rectangular region of interest, clamped to the image. */
export function rectRoi({
  width,
  height,
  x = 0,
  y = 0,
  w = width,
  h = height,
}) {
  const x0 = Math.max(0, Math.min(width, Math.floor(x)));
  const y0 = Math.max(0, Math.min(height, Math.floor(y)));
  const x1 = Math.max(x0, Math.min(width, Math.floor(x + w)));
  const y1 = Math.max(y0, Math.min(height, Math.floor(y + h)));
  return { x0, y0, x1, y1 };
}
