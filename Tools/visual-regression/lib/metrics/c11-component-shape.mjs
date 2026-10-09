// c11-component-shape.mjs — the achromatic subject mask of one decoded frame and
// the shape statistics of its significant 8-connected components, extracted
// from the C11-90 primitive-restart harness and rebuilt on the kit's
// connected-component labeller.
// @purpose Pure achromatic (grey-subject) mask over a decoded RGB/RGBA frame and the count, size balance, coverage, aspect and elongation of its significant 8-connected components, labelled by metrics/connected-components.mjs.
// @status ACTIVE
//
// WHERE THIS CAME FROM. `lib/c11-90-primitive-restart-probe.mjs` carried
// `imageMetrics`: a mask of pixels whose brightest channel is at least 32 and
// whose channel spread is at most 42 (any near-neutral subject; the banked
// restart frames draw white shapes on black), a private breadth-first
// 8-connected flood fill, and the per-component shape terms its "nine
// balanced components with the authored aspect law" verdict reads. The
// probe-kit harvest (PROBE_KIT_PLAN_2026-09-17.md §4, DX-108) moved the mask
// and the shape terms here and replaced the private flood fill with
// `connectedComponents` (`metrics/connected-components.mjs`), which already
// labels 8-connected regions with an iteration guard. The
// harness keeps its sharp decode, its file hashes and its verdicts
// (`assessShapeAuthority`); `metrics-c11.spec.mjs` proves the result equals
// what the inline code returned, field for field and in the same key order.
//
// WHY THE LABELLER CAN STAND IN. Both walk seeds in raster order, both keep a
// component only when its area reaches the significance floor, and both order
// the survivors by area descending with ties in discovery order (the private
// code relied on `Array.prototype.sort` being stable; the kit sorts by area
// and then by its raster-order id). Area and bounds do not depend on the
// order a flood fill visits pixels in, so the two produce the same list.
//
// CHANNELS. `channels` defaults to 4 (RGBA); the harness passes 3 for sharp's
// `.removeAlpha().raw()` output.

import { connectedComponents } from "./connected-components.mjs";

/** The C11-90 defaults, restated from the harness's inline constants. */
export const ACHROMATIC_SUBJECT_DEFAULTS = Object.freeze({
  /** A subject pixel's brightest channel is at least this. */
  minimumMaximum: 32,
  /** A subject pixel's channel spread (max - min) is at most this. */
  maximumSpread: 42,
  /** Significance floor: `max(minimumComponentPixels, floor(pixels * componentFraction))`. */
  minimumComponentPixels: 64,
  componentFraction: 0.00005,
  /** How many components (and sizes) the result lists. */
  listLimit: 16,
});

function readFrame(image, label) {
  if (image === null || typeof image !== "object") {
    throw new TypeError(`${label}: frame must be an object`);
  }
  const { width, height } = image;
  const channels = image.channels ?? 4;
  if (!Number.isInteger(width) || width <= 0) {
    throw new TypeError(`${label}: width must be a positive integer`);
  }
  if (!Number.isInteger(height) || height <= 0) {
    throw new TypeError(`${label}: height must be a positive integer`);
  }
  if (channels !== 3 && channels !== 4) {
    throw new TypeError(`${label}: channels must be 3 or 4, got ${channels}`);
  }
  const data = image.data;
  if (data?.length !== width * height * channels) {
    throw new TypeError(
      `${label}: ${width}x${height}x${channels} needs ${width * height * channels} bytes, got ${data?.length}`,
    );
  }
  return { width, height, channels, data };
}

/**
 * The achromatic subject mask: bright enough and grey enough.
 *
 * @param {{width: number, height: number, data: ArrayLike<number>, channels?: 3|4}} image
 * @param {{minimumMaximum?: number, maximumSpread?: number}} [options]
 * @returns {{width: number, height: number, mask: Uint8Array, maskPixels: number}}
 */
export function achromaticMask(image, options = {}) {
  const { width, height, channels, data } = readFrame(image, "achromaticMask");
  const minimumMaximum =
    options.minimumMaximum ?? ACHROMATIC_SUBJECT_DEFAULTS.minimumMaximum;
  const maximumSpread =
    options.maximumSpread ?? ACHROMATIC_SUBJECT_DEFAULTS.maximumSpread;
  const pixelCount = width * height;
  const mask = new Uint8Array(pixelCount);
  let maskPixels = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const offset = pixel * channels;
    const colors = [data[offset], data[offset + 1], data[offset + 2]];
    const maximum = Math.max(...colors);
    const minimum = Math.min(...colors);
    if (maximum >= minimumMaximum && maximum - minimum <= maximumSpread) {
      mask[pixel] = 1;
      maskPixels += 1;
    }
  }
  return { width, height, mask, maskPixels };
}

/**
 * Shape statistics of the significant 8-connected components of a 0/1 mask.
 *
 * @param {{width: number, height: number, mask: ArrayLike<number>, maskPixels: number}} masked
 *   The result of {@link achromaticMask} (or any mask of the same shape).
 * @param {{minimumComponentPixels?: number, componentFraction?: number, listLimit?: number}} [options]
 * @returns {{modelMaskPixels: number, modelMaskFraction: number,
 *   significantComponentThreshold: number, significantComponentCount: number,
 *   significantComponentPixels: number, significantComponentCoverage: number,
 *   significantComponentSizes: number[], significantComponents: object[],
 *   componentBalance: number, largestComponentShare: number}} The C11-90 field
 *   names, kept so the harness's receipt reads as it always has.
 */
export function componentShapeStats(masked, options = {}) {
  const { width, height, mask, maskPixels } = masked ?? {};
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new TypeError("componentShapeStats: width and height are required");
  }
  if (mask?.length !== width * height) {
    throw new TypeError(
      `componentShapeStats: mask must hold ${width * height} entries, got ${mask?.length}`,
    );
  }
  const minimumComponentPixels =
    options.minimumComponentPixels ??
    ACHROMATIC_SUBJECT_DEFAULTS.minimumComponentPixels;
  const componentFraction =
    options.componentFraction ?? ACHROMATIC_SUBJECT_DEFAULTS.componentFraction;
  const listLimit = options.listLimit ?? ACHROMATIC_SUBJECT_DEFAULTS.listLimit;
  const pixelCount = width * height;
  const significantThreshold = Math.max(
    minimumComponentPixels,
    Math.floor(pixelCount * componentFraction),
  );
  const labelled = connectedComponents(
    { width, height, data: mask },
    { threshold: 0, connectivity: 8, minArea: significantThreshold },
  );
  const components = labelled.components.map(({ area, bbox }) => {
    const { x0: minimumX, x1: maximumX, y0: minimumY, y1: maximumY } = bbox;
    const componentWidth = maximumX - minimumX + 1;
    const componentHeight = maximumY - minimumY + 1;
    return {
      pixels: area,
      bounds: { minimumX, maximumX, minimumY, maximumY },
      width: componentWidth,
      height: componentHeight,
      verticalAspect: componentHeight / componentWidth,
      elongation: Math.max(
        componentWidth / componentHeight,
        componentHeight / componentWidth,
      ),
    };
  });
  const componentSizes = components.map((component) => component.pixels);
  const significantComponentPixels = componentSizes.reduce(
    (sum, size) => sum + size,
    0,
  );
  const componentBalance =
    components.length > 0 ? components.at(-1).pixels / components[0].pixels : 0;
  return {
    modelMaskPixels: maskPixels,
    modelMaskFraction: maskPixels / pixelCount,
    significantComponentThreshold: significantThreshold,
    significantComponentCount: components.length,
    significantComponentPixels,
    significantComponentCoverage:
      maskPixels > 0 ? significantComponentPixels / maskPixels : 0,
    significantComponentSizes: componentSizes.slice(0, listLimit),
    significantComponents: components.slice(0, listLimit),
    componentBalance,
    largestComponentShare:
      maskPixels > 0 ? (componentSizes[0] ?? 0) / maskPixels : 1,
  };
}
