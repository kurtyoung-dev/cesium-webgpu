/**
 * C13-N09 — the HDR pre-tonemap capture rule, as executable code.
 * @purpose Recover linear pre-Reinhard cloud radiance from an 8-bit capture, mask the sun disc, and refuse where the recovery is not defined.
 * @status ACTIVE
 *
 * WHY THIS EXISTS. Campaign 13 v2 §1.3 makes one rule binding on every
 * photometric bar in the plan:
 *
 *   "all photometric statistics are computed on linear, pre-tonemap HDR
 *    values, with the sun disc masked out of every ROI. The march applies its
 *    own Reinhard at ProceduralClouds.wgsl:2645-2646, so any ratio measured
 *    after it is a ratio of the tonemapper."
 *
 * That is not a stylistic preference. A1 wants an edge/interior luminance ratio
 * >= 4.0; A5 wants a base/top ratio in [0.05, 0.35]; A4 wants <= 0.80; G3 wants
 * a >= 3x luminance ratio at sun -2 deg. Reinhard is x/(x+1): it is very nearly
 * linear near zero and asymptotically flat above ~1, so it COMPRESSES exactly
 * the ratios those bars are made of. An A1 measured on display bytes can read
 * 2.6 while the radiance ratio is 12 — the bar would then be failing a renderer
 * that is correct, or passing one that is not, and either way the number is a
 * property of the tonemapper rather than of the clouds.
 *
 * WHAT THE RULE CAN AND CANNOT RECOVER — stated because it bounds every bar
 * built on it. The march composites in display space: after the Reinhard at
 * `:2645-2646` the color is lerped toward the aerial tint (`:2660`, and the
 * physical-LUT path at `:2711`) and then composited over whatever the frame
 * already held. So the inverse below is EXACT only for a pixel whose displayed
 * value is the tone-mapped cloud radiance and nothing else — an opaque cloud
 * pixel at negligible aerial weight. Where aerial or a background term has been
 * mixed in, the recovered value is the radiance whose tone-mapping would have
 * produced the displayed composite, which is a lower bound on the cloud's own
 * radiance. `photometricStats` therefore reports `assumption` in its provenance
 * rather than letting a caller forget which of the two it is holding. A bar
 * that needs the exact value needs a render target read before the composite,
 * which does not exist today and is not in this row.
 *
 * SATURATION IS A REFUSAL, NOT A NUMBER. The inverse of x/(x+1) diverges as the
 * display value approaches 1: at 254/255 it already reports 254x the radiance
 * of a mid-grey, and at 255/255 it is infinite. A saturated pixel carries NO
 * recoverable radiance, so it is excluded and COUNTED. The count is itself
 * evidence — a photometric ROI that is mostly saturated cannot support any of
 * the ratio bars, and a silent mean over inverted 254s would have looked like a
 * measurement.
 *
 * THE TRANSFER FUNCTION IS DECLARED, NEVER ASSUMED. The WebGPU presentation
 * format is `navigator.gpu.getPreferredCanvasFormat()` with a `bgra8unorm`
 * fallback (`WebGPUContext.ts:523`, `:1411`, `:3832`) — a NON-sRGB format, so
 * the byte the shader wrote is its own [0,1) output rather than an sRGB
 * encoding of it, and decoding it as sRGB would apply a gamma the renderer
 * never applied. That is the default here. It is still a premise about a
 * capture path, so it is a named parameter: a caller reading a capture that DID
 * pass through an sRGB encode passes `transfer: "srgb"`, and the choice is
 * recorded in the provenance of every statistic. `cloud-photometry-rule.spec.mjs`
 * pins that the choice changes a ratio, so it cannot be a decoration.
 *
 * @module cloud-photometry
 */

/**
 * The exact operator this module inverts, as it is written in the shader.
 *
 * This string is a PIN, not documentation: `cloud-photometry-rule.spec.mjs`
 * asserts it still occurs in `ProceduralClouds.wgsl`. If a later row replaces
 * Reinhard with ACES, a filmic curve or an exposure-only path, the inverse here
 * stops being the inverse of what the renderer did — and the spec goes red in
 * the same commit rather than every photometric bar silently drifting.
 */
export const REINHARD_OPERATOR_PIN = Object.freeze({
  file: "packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl",
  exposeLine: "let exposed = weightedColor * cloud.exposure;",
  mapLine: "let toneMapped = exposed / (exposed + vec3<f32>(1.0));",
  citedAs: "ProceduralClouds.wgsl:2645-2646",
});

/**
 * Uniform slot carrying the Reinhard exposure the march actually used.
 *
 * Read from the live uniform array rather than hard-coded, because a bar
 * measured against the wrong exposure is wrong by exactly the factor nobody
 * checked. `WebGPUProceduralCloudRenderer.ts:3823` packs `config.cloudExposure
 * ?? 0.22` here and `ProceduralClouds.wgsl:106` declares it as slot 97.
 */
export const EXPOSURE_UNIFORM_SLOT = 97;

/** The packer's own fallback, recorded so a spec can tell "default" from "unset". */
export const DEFAULT_CLOUD_EXPOSURE = 0.22;

/**
 * Display values at or above this are treated as saturated and excluded.
 *
 * 254/255 rather than 1.0: the inverse already reports 254x a mid-grey's
 * radiance at that byte, so a single quantization step separates "very bright"
 * from "arbitrarily bright" and any statistic that includes it is dominated by
 * the quantizer. Callers may lower it; raising it above 1 is refused.
 */
export const DEFAULT_SATURATION_CEILING = 254 / 255;

/** Transfer functions a capture may have been encoded with. */
export const TRANSFER_FUNCTIONS = Object.freeze({
  /**
   * The byte is the shader's own [0,1) output. Correct for a non-sRGB
   * presentation format, which is what this renderer configures.
   */
  identity: (value) => value,
  /** IEC 61966-2-1 sRGB EOTF, for a capture that did pass an sRGB encode. */
  srgb: (value) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
});

/** @see TRANSFER_FUNCTIONS — why `identity` and not `srgb`. */
export const DEFAULT_TRANSFER = "identity";

/** Rec. 709 luminance. The bars say "luminance"; this is which one. */
export function luminance(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function requireFinite(value, what) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(
      `${what} must be a finite number, received ${String(value)}`,
    );
  }
  return value;
}

/**
 * The march's own operator, forward. Present so tests can author a known
 * radiance, push it through the REAL curve, and ask the inverse to recover it —
 * a round trip against a hand-written constant would only prove arithmetic.
 *
 * @param {number} radiance Pre-tonemap, pre-exposure radiance (>= 0).
 * @param {number} exposure The `cloud.exposure` uniform.
 * @returns {number} The display value in [0, 1).
 */
export function forwardReinhard(radiance, exposure) {
  requireFinite(radiance, "radiance");
  requireFinite(exposure, "exposure");
  if (radiance < 0) {
    throw new RangeError(`radiance must be non-negative, received ${radiance}`);
  }
  if (!(exposure > 0)) {
    throw new RangeError(`exposure must be positive, received ${exposure}`);
  }
  const exposed = radiance * exposure;
  return exposed / (exposed + 1);
}

/**
 * Recover pre-tonemap radiance from a decoded display value.
 *
 * Inverting `t = e/(e+1)` gives `e = t/(1-t)`, and `radiance = e / exposure`.
 *
 * @param {number} display Decoded display value in [0, 1).
 * @param {number} exposure The `cloud.exposure` uniform the march used.
 * @returns {number} Pre-tonemap, pre-exposure radiance.
 */
export function inverseReinhard(display, exposure) {
  requireFinite(display, "display");
  requireFinite(exposure, "exposure");
  if (!(exposure > 0)) {
    throw new RangeError(`exposure must be positive, received ${exposure}`);
  }
  if (display < 0) {
    throw new RangeError(`display must be non-negative, received ${display}`);
  }
  if (display >= 1) {
    // Not clamped to a large finite number: a clamp would let a saturated
    // pixel enter a mean as "big but measured". It is not measured.
    throw new RangeError(
      `display ${display} is saturated; pre-tonemap radiance is not recoverable — exclude the pixel`,
    );
  }
  const exposed = display / (1 - display);
  return exposed / exposure;
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

/**
 * The same ratio computed on raw display bytes — the thing §1.3 forbids.
 *
 * It is exported ON PURPOSE. A spec that only asserts the correct path works
 * cannot show that the rule MATTERS; this lets one assert that the forbidden
 * measurement and the required one disagree, on the same pixels, by the factor
 * the compression predicts. Nothing in the probe fleet should call it for
 * evidence, and `cloud-photometry-rule.spec.mjs` is its only intended caller.
 */
export function displaySpaceLuminanceMean(rgba, options = {}) {
  const { width, height, roi, transfer = DEFAULT_TRANSFER } = options;
  const decode = TRANSFER_FUNCTIONS[transfer];
  const region = roi ?? rectRoi({ width, height });
  let sum = 0;
  let counted = 0;
  for (let y = region.y0; y < region.y1; y++) {
    for (let x = region.x0; x < region.x1; x++) {
      const base = (y * width + x) * 4;
      sum += luminance(
        decode(rgba[base] / 255),
        decode(rgba[base + 1] / 255),
        decode(rgba[base + 2] / 255),
      );
      counted++;
    }
  }
  return counted === 0 ? null : sum / counted;
}
