/**
 * @purpose Per-ROI photometric statistics in linear pre-Reinhard radiance, with saturated and sun-disc pixels excluded and counted, plus the ratio the bars are made of.
 * @status ACTIVE
 */

import { rectRoi, requireFinite } from "./masks.mjs";
import {
  DEFAULT_TRANSFER,
  EXPOSURE_UNIFORM_SLOT,
  REINHARD_OPERATOR_PIN,
  TRANSFER_FUNCTIONS,
  inverseReinhard,
  luminance,
} from "./luminance.mjs";

/**
 * Display values at or above this are treated as saturated and excluded.
 *
 * 254/255 rather than 1.0: the inverse already reports 254x a mid-grey's
 * radiance at that byte, so a single quantization step separates "very bright"
 * from "arbitrarily bright" and any statistic that includes it is dominated by
 * the quantizer. Callers may lower it; raising it above 1 is refused.
 */
export const DEFAULT_SATURATION_CEILING = 254 / 255;

function median(sorted) {
  if (sorted.length === 0) {
    return null;
  }
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]
    : 0.5 * (sorted[mid - 1] + sorted[mid]);
}

/**
 * The rule, applied to one capture.
 *
 * Every photometric bar in §1.3 goes through here, so what it refuses matters
 * as much as what it returns:
 *   - no `exposure` (or a non-positive one) is a THROW, not a default. Silently
 *     assuming 0.22 would report a number whose scale is a guess, and every
 *     ratio built on two different guesses would be meaningless.
 *   - saturated pixels are excluded and counted (`saturatedFraction`).
 *   - sun-disc pixels are excluded and counted, and a caller that supplies no
 *     mask is recorded as `sunDiscMasked: false` so a reviewer can see that a
 *     bar the plan says must mask the sun did not.
 *   - an ROI whose recoverable count is zero returns nulls, never NaN.
 *
 * @param {Uint8Array|Uint8ClampedArray|Buffer} rgba Row-major RGBA bytes.
 * @param {object} options
 * @returns {object} Statistics plus the provenance that makes them readable.
 */
export function photometricStats(rgba, options = {}) {
  const {
    width,
    height,
    exposure,
    roi,
    sunDiscMask: mask = null,
    transfer = DEFAULT_TRANSFER,
    saturationCeiling = DEFAULT_SATURATION_CEILING,
    assumption = "cloud-dominated-composite",
  } = options;

  requireFinite(width, "width");
  requireFinite(height, "height");
  if (!(exposure > 0) || !Number.isFinite(exposure)) {
    throw new TypeError(
      "photometricStats requires the live cloud.exposure uniform (slot " +
        `${EXPOSURE_UNIFORM_SLOT}); received ${String(exposure)}. A photometric ` +
        "statistic measured against a guessed exposure is not a measurement.",
    );
  }
  const decode = TRANSFER_FUNCTIONS[transfer];
  if (typeof decode !== "function") {
    throw new TypeError(
      `unknown transfer function ${String(transfer)}; expected one of ${Object.keys(
        TRANSFER_FUNCTIONS,
      ).join(", ")}`,
    );
  }
  if (!(saturationCeiling > 0) || saturationCeiling > 1) {
    throw new RangeError(
      `saturationCeiling must be in (0, 1], received ${String(saturationCeiling)}`,
    );
  }
  if (rgba.length < width * height * 4) {
    throw new RangeError(
      `rgba holds ${rgba.length} bytes, ${width * height * 4} required for ${width}x${height}`,
    );
  }
  if (mask && (mask.width !== width || mask.height !== height)) {
    throw new RangeError(
      `sun-disc mask is ${mask.width}x${mask.height} but the capture is ${width}x${height}`,
    );
  }

  const region = roi ?? rectRoi({ width, height });
  let considered = 0;
  let counted = 0;
  let excludedSaturated = 0;
  let excludedSunDisc = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  const luminances = [];

  for (let y = region.y0; y < region.y1; y++) {
    for (let x = region.x0; x < region.x1; x++) {
      const index = y * width + x;
      considered++;
      if (mask && mask.data[index] === 1) {
        excludedSunDisc++;
        continue;
      }
      const base = index * 4;
      const r = decode(rgba[base] / 255);
      const g = decode(rgba[base + 1] / 255);
      const b = decode(rgba[base + 2] / 255);
      if (
        r >= saturationCeiling ||
        g >= saturationCeiling ||
        b >= saturationCeiling
      ) {
        excludedSaturated++;
        continue;
      }
      const lr = inverseReinhard(r, exposure);
      const lg = inverseReinhard(g, exposure);
      const lb = inverseReinhard(b, exposure);
      sumR += lr;
      sumG += lg;
      sumB += lb;
      luminances.push(luminance(lr, lg, lb));
      counted++;
    }
  }

  luminances.sort((a, b) => a - b);
  const meanLuminance =
    counted === 0
      ? null
      : luminance(sumR / counted, sumG / counted, sumB / counted);

  return {
    considered,
    counted,
    excludedSaturated,
    excludedSunDisc,
    saturatedFraction: considered === 0 ? null : excludedSaturated / considered,
    meanRadiance:
      counted === 0
        ? null
        : { r: sumR / counted, g: sumG / counted, b: sumB / counted },
    meanLuminance,
    medianLuminance: median(luminances),
    provenance: {
      space: "linear-pre-reinhard",
      operator: REINHARD_OPERATOR_PIN.citedAs,
      exposure,
      transfer,
      saturationCeiling,
      sunDiscMasked: mask !== null,
      assumption,
    },
  };
}

/**
 * The ratio the A/G bars are actually made of, computed in radiance.
 *
 * Returned with both operands' provenance attached, because two statistics
 * recovered under different exposures or different transfer functions are not
 * comparable and a bare number hides that.
 */
export function photometricRatio(numerator, denominator) {
  const nl = numerator?.meanLuminance;
  const dl = denominator?.meanLuminance;
  const comparable =
    numerator?.provenance?.exposure === denominator?.provenance?.exposure &&
    numerator?.provenance?.transfer === denominator?.provenance?.transfer &&
    numerator?.provenance?.space === denominator?.provenance?.space;
  return {
    ratio: nl === null || dl === null || dl === 0 ? null : nl / dl,
    comparable,
    numerator: numerator?.provenance ?? null,
    denominator: denominator?.provenance ?? null,
  };
}
