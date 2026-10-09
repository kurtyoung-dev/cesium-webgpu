// c11-footprint.mjs — the non-black footprint of one decoded frame and the
// cross-backend comparison of two footprints, extracted from the C11-13 voxel
// camera-inside harness.
// @purpose Pure non-black footprint statistics over a decoded RGB/RGBA frame (count, fraction, interior and centre-patch counts, bounding box, mean colour, green dominance, mask) and the IoU / ratio / mean-colour comparison of two such footprints.
// @status ACTIVE
//
// WHERE THIS CAME FROM. `lib/c11-13-voxel-inside-camera-probe.mjs` carried these
// two computations inline (`analyzePng`'s pixel loop and
// `compareBackendCaptures`), next to the harness's own sharp decode and SHA-256
// hashing. The probe-kit harvest (PROBE_KIT_PLAN_2026-09-17.md §4, DX-108) moved
// the arithmetic here so a future probe that needs "is the subject on screen,
// where, what colour, and does the other backend draw the same footprint" can
// import it instead of writing a sixth copy. The harness keeps the decode, the
// hashes and the verdicts (`assessPixelEvidence`, `assessCrossBackendEvidence`);
// only the arithmetic moved, and `metrics-c11.spec.mjs` proves it returns
// what the inline code returned, field for field and in the same key order.
//
// WHY NOT `frameStats` OR `cellMetrics`. `Tools/lib/png-decode.mjs`'s
// `frameStats` and `capture.mjs`'s `cellMetrics` both count a pixel as non-black
// when ANY channel exceeds 12; this footprint uses `max(R,G,B) >= threshold`
// (18 in C11-13) and additionally keeps the mask, the interior and centre-patch
// counts and the bounding box, which neither of those returns. The banked
// C11-13 receipts were computed with this rule, so it is kept as written.
//
// CHANNELS. sharp's `.removeAlpha().raw()` hands the harness 3-channel RGB;
// `Tools/lib/png-decode.mjs` hands everything else 4-channel RGBA. Both are
// accepted: `channels` defaults to 4 and the frame's byte length must match.
//
// A SIZE MISMATCH NEVER PASSES. By default `compareFootprints` THROWS a
// RangeError naming both sizes when the two frames differ in width, height or
// mask length: no value it could return fails every bar a future caller might
// write ("IoU at least 0.6" and "IoU below 0.1" cannot both fail on one
// number), so the only answer that fails every check is no answer. A caller
// whose verdict already reads `comparable` first may opt in with
// `onSizeMismatch: "not-comparable"` and receive `comparable: false`,
// `footprintIou: 0`, null ratios and an infinite colour delta — the record the
// C11-13 harness has always written into its receipt, which its
// `assessCrossBackendEvidence` fails. The C11-13 harness is the one caller that
// opts in, and `metrics-c11.spec.mjs` pins both paths.

/** The C11-13 defaults, restated from the harness's `PIXEL_TOLERANCES`. */
export const FOOTPRINT_DEFAULTS = Object.freeze({
  /** A pixel is in the footprint when `max(R,G,B)` is at least this. */
  nonBlackThreshold: 18,
  /** The interior window is `[fraction, 1 - fraction)` of each axis. */
  interiorFraction: 0.2,
  /** The centre patch is every pixel within this Chebyshev radius of centre. */
  centerPatchRadius: 4,
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
 * The non-black footprint of one decoded frame.
 *
 * @param {{width: number, height: number, data: ArrayLike<number>, channels?: 3|4}} image
 *   Decoded frame; `channels` defaults to 4 (RGBA).
 * @param {{nonBlackThreshold?: number, interiorFraction?: number, centerPatchRadius?: number}} [options]
 * @returns {{mask: Uint8Array, metrics: {width: number, height: number,
 *   channels: number, pixelCount: number, nonBlackPixels: number,
 *   nonBlackFraction: number, interiorNonBlackPixels: number,
 *   centerPatchNonBlackPixels: number, centerPixelRgb: number[],
 *   centerPixelMaximum: number, meanRgb: number[], greenDominance: number,
 *   boundingBox: {minX: number, minY: number, maxX: number, maxY: number,
 *   width: number, height: number}|null}}} `mask` holds 1 for every footprint
 *   pixel, row-major.
 */
export function nonBlackFootprint(image, options = {}) {
  const { width, height, channels, data } = readFrame(
    image,
    "nonBlackFootprint",
  );
  const threshold =
    options.nonBlackThreshold ?? FOOTPRINT_DEFAULTS.nonBlackThreshold;
  const interiorFraction =
    options.interiorFraction ?? FOOTPRINT_DEFAULTS.interiorFraction;
  const radius =
    options.centerPatchRadius ?? FOOTPRINT_DEFAULTS.centerPatchRadius;
  const pixelCount = width * height;
  const mask = new Uint8Array(pixelCount);
  const interiorMinX = Math.floor(width * interiorFraction);
  const interiorMaxX = Math.ceil(width * (1 - interiorFraction));
  const interiorMinY = Math.floor(height * interiorFraction);
  const interiorMaxY = Math.ceil(height * (1 - interiorFraction));
  const centerX = Math.floor(width / 2);
  const centerY = Math.floor(height / 2);
  let nonBlackPixels = 0;
  let interiorNonBlackPixels = 0;
  let centerPatchNonBlackPixels = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      const offset = pixel * channels;
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      if (Math.max(red, green, blue) < threshold) continue;
      mask[pixel] = 1;
      nonBlackPixels += 1;
      sumR += red;
      sumG += green;
      sumB += blue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      if (
        x >= interiorMinX &&
        x < interiorMaxX &&
        y >= interiorMinY &&
        y < interiorMaxY
      ) {
        interiorNonBlackPixels += 1;
      }
      if (Math.abs(x - centerX) <= radius && Math.abs(y - centerY) <= radius) {
        centerPatchNonBlackPixels += 1;
      }
    }
  }

  const centerOffset = (centerY * width + centerX) * channels;
  const meanRgb =
    nonBlackPixels > 0
      ? [sumR, sumG, sumB].map((value) => value / nonBlackPixels)
      : [0, 0, 0];
  return {
    mask,
    metrics: {
      width,
      height,
      channels,
      pixelCount,
      nonBlackPixels,
      nonBlackFraction: nonBlackPixels / pixelCount,
      interiorNonBlackPixels,
      centerPatchNonBlackPixels,
      centerPixelRgb: [
        data[centerOffset],
        data[centerOffset + 1],
        data[centerOffset + 2],
      ],
      centerPixelMaximum: Math.max(
        data[centerOffset],
        data[centerOffset + 1],
        data[centerOffset + 2],
      ),
      meanRgb,
      greenDominance: meanRgb[1] - Math.max(meanRgb[0], meanRgb[2]),
      boundingBox:
        nonBlackPixels > 0
          ? {
              minX,
              minY,
              maxX,
              maxY,
              width: maxX - minX + 1,
              height: maxY - minY + 1,
            }
          : null,
    },
  };
}

/**
 * Compare two footprints the way C11-13 compares its WebGL and WebGPU legs.
 *
 * @param {{mask: ArrayLike<number>, metrics: object}} reference The reference leg (C11-13: WebGL).
 * @param {{mask: ArrayLike<number>, metrics: object}} candidate The candidate leg (C11-13: WebGPU).
 * @param {{minimumNonBlackPixels: number, onSizeMismatch?: "throw"|"not-comparable"}} options
 *   `minimumNonBlackPixels` is the footprint size each leg must reach for the
 *   pair to count as non-vacuous. Required: a silent default would let a
 *   black-on-black pair through. `onSizeMismatch` (default `"throw"`) says what
 *   a size mismatch does; see the module header.
 * @returns {{comparable: boolean, bothNonVacuous: boolean,
 *   intersectionPixels: number, unionPixels: number, footprintIou: number,
 *   footprintRatio: number|null, boundingBoxWidthRatio: number|null,
 *   boundingBoxHeightRatio: number|null, meanColorL1: number}}
 * @throws {RangeError} On a size mismatch, unless the caller opted in to
 *   `onSizeMismatch: "not-comparable"`.
 */
export function compareFootprints(reference, candidate, options) {
  const minimumNonBlackPixels = options?.minimumNonBlackPixels;
  if (!Number.isFinite(minimumNonBlackPixels)) {
    throw new TypeError(
      "compareFootprints: options.minimumNonBlackPixels is required",
    );
  }
  const onSizeMismatch = options?.onSizeMismatch ?? "throw";
  if (onSizeMismatch !== "throw" && onSizeMismatch !== "not-comparable") {
    throw new TypeError(
      `compareFootprints: options.onSizeMismatch must be "throw" or "not-comparable", got ${String(onSizeMismatch)}`,
    );
  }
  const comparable =
    reference?.metrics?.width === candidate?.metrics?.width &&
    reference?.metrics?.height === candidate?.metrics?.height &&
    reference?.mask?.length === candidate?.mask?.length &&
    reference?.mask?.length > 0;
  if (!comparable) {
    if (onSizeMismatch === "throw") {
      throw new RangeError(
        `compareFootprints: the two footprints are not the same size — reference ` +
          `${reference?.metrics?.width}x${reference?.metrics?.height} ` +
          `(mask ${reference?.mask?.length}), candidate ` +
          `${candidate?.metrics?.width}x${candidate?.metrics?.height} ` +
          `(mask ${candidate?.mask?.length})`,
      );
    }
    return {
      comparable: false,
      bothNonVacuous: false,
      intersectionPixels: 0,
      unionPixels: 0,
      footprintIou: 0,
      footprintRatio: null,
      boundingBoxWidthRatio: null,
      boundingBoxHeightRatio: null,
      meanColorL1: Number.POSITIVE_INFINITY,
    };
  }
  let intersectionPixels = 0;
  let unionPixels = 0;
  for (let pixel = 0; pixel < reference.mask.length; pixel += 1) {
    const inReference = reference.mask[pixel] === 1;
    const inCandidate = candidate.mask[pixel] === 1;
    if (inReference && inCandidate) intersectionPixels += 1;
    if (inReference || inCandidate) unionPixels += 1;
  }
  const referencePixels = reference.metrics.nonBlackPixels;
  const candidatePixels = candidate.metrics.nonBlackPixels;
  const bothNonVacuous =
    referencePixels >= minimumNonBlackPixels &&
    candidatePixels >= minimumNonBlackPixels;
  return {
    comparable: true,
    bothNonVacuous,
    intersectionPixels,
    unionPixels,
    footprintIou: unionPixels > 0 ? intersectionPixels / unionPixels : 0,
    footprintRatio:
      referencePixels > 0 ? candidatePixels / referencePixels : null,
    boundingBoxWidthRatio:
      reference.metrics.boundingBox?.width > 0
        ? candidate.metrics.boundingBox?.width /
          reference.metrics.boundingBox.width
        : null,
    boundingBoxHeightRatio:
      reference.metrics.boundingBox?.height > 0
        ? candidate.metrics.boundingBox?.height /
          reference.metrics.boundingBox.height
        : null,
    meanColorL1: reference.metrics.meanRgb.reduce(
      (sum, channel, index) =>
        sum + Math.abs(channel - candidate.metrics.meanRgb[index]),
      0,
    ),
  };
}
