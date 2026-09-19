/**
 * @purpose Rec. 709 luminance, the march's Reinhard operator in both directions, and the display-space mean the photometric rule exists to forbid.
 * @status ACTIVE
 */

import { rectRoi, requireFinite } from "./masks.mjs";

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
