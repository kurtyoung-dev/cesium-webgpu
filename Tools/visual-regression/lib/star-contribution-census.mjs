// star-contribution-census.mjs — resolve a star sprite's OWN contribution at a
// known screen position, out of a stars-on / stars-off pair.
// @purpose One home for the positional star-reachability control: luma planes, the absolute-frame census and the stars-on-minus-off difference census.
// @status ACTIVE
//
// WHY A DIFFERENCE CENSUS
// ───────────────────────
// `Tools/skybox-bake/starmap-census.mjs` is the shared point-source detector,
// and its `minPeak` of 40 is the number that lets it refuse the DIFFUSE star
// cube map (whose shipped faces peak at 8-28). That floor is load-bearing on an
// ABSOLUTE frame and must not be lowered there.
//
// It is also, by that module's own derivation, a bar only stars brighter than
// vmag 2.56 clear — and that derivation assumes no atmosphere. A camera on the
// ground sees every star through the shipped per-star extinction, which at 30
// degrees elevation is roughly a third of the space value, so the effective bar
// moves past vmag 1.5. A narrow frame is not guaranteed to contain such a star,
// which makes "the brightest star in this frame must clear 40" a proposition
// about the FRAMING rather than about the star field.
//
// A probe that renders the same pinned instant twice, differing only in
// `starField.show`, has a better image available: on the difference, the cube
// map, the sky and anything composited over them cancel exactly, so the job the
// 40 floor was doing is done by construction. The honest bar there is zero —
// any code above the local ring at the star's projected position is the sprite
// — and the detector's geometry (a strict local maximum over a core radius,
// with the background taken from a ring outside it) is unchanged.

import { pointSourceCensus } from "../../skybox-bake/starmap-census.mjs";

/**
 * How far a resolved source may sit from the star's PROJECTED position.
 *
 * The projection and the render consume the same catalogue row through the same
 * transform at the same instant, so the only legitimate error is sub-pixel
 * rounding plus the detector's plateau tie-break.
 */
export const STAR_AIM_TOLERANCE_PX = 3;

/**
 * Detector options for the difference image. Zero-barred on purpose: see the
 * module note. Nothing about the detector's GEOMETRY changes.
 */
export const DIFFERENCE_CENSUS_OPTIONS = Object.freeze({
  minPeak: 1,
  minContrast: 1,
  collectSources: true,
});

// ─────────────────── STAR REACHABILITY DIFFERENCE-PEAK FLOOR (Q-115) ────────
//
// `probe-sky-twilight-range.mjs`'s STAR REACHABILITY control reads the box
// census's `peakMax` at the control lane's target star (`differencePeak` in
// the probe's console output). Before this floor existed, an Edge executor
// graded that number by eye against an ad hoc "8", reverse-engineered from
// the probe's OWN unrelated whole-frame `addedPixels()` metric (threshold 24
// on an RGB CHANNEL SUM, which a roughly-achromatic star clears only once its
// Rec.709 LUMA is around 24/3 = 8) rather than from this control's own
// framing. That number does not belong here: the control's box census and the
// whole-frame added-pixel count measure the same star through two different
// arithmetic paths that happen to share no derivation.
//
// REPAIRED post-B1-review (station-3 pass 1). The first version of this floor
// re-applied atmospheric extinction under a second name. What Node CAN
// compute and what it CANNOT are kept strictly separate below:
//
//   1. STAR_PEAK_LUMA_AT_CONTROL_ELEVATION (21.2) — the control lane's target
//      star (vmag 2.14, camera 500 m, sun -20 deg, target elevation 30.73
//      deg), analytic PSF peak AFTER the shipped per-star atmospheric
//      (Bouguer/airmass) extinction, BEFORE the sky shell composites over it.
//      Independently reproduced twice: the Q-62 review pass's root-cause
//      script (`peak luma 21.20`) and `sky-shell-star-occlusion.spec.mjs`'s
//      shipped-source chain (`computeAtmosphereExtinction` + `StarFieldMath`
//      + `BrightStarCatalog` at this exact geometry), both landing at
//      21.1969-21.20. THE EXTINCTION IS ALREADY INSIDE THIS NUMBER: the
//      computed ratio at this elevation is 0.41544 (51.023 un-extinguished ->
//      21.1969), not the header's rounded "roughly a third" (0.3333) — and
//      either way, it must not be applied a second time to reach the floor.
//      An earlier version of this file did exactly that under the name
//      `RENDER_TIME_RESIDUAL_FACTOR`, borrowing the header's rounded prose
//      figure as if it were a second, independent quantity. At the CORRECT
//      (computed) extinction ratio the resulting floor would have been 7.31,
//      which the tranche's own banked measurement of 6.07 fails — the same
//      class of false-fail this row exists to remove, just smaller.
//   2. STAR_REACHABILITY_RESIDUAL_FRACTION (0.14) — a DECLARED SAFETY FACTOR,
//      not a physical quantity. What actually separates the analytic peak
//      above from what a real render puts on screen is sub-pixel quad
//      coverage / antialiasing at the star's screen footprint — a rasterizer
//      quantity Node cannot compute without a GPU, which is exactly why this
//      claim needs a browser probe. The only render-side data point this
//      fork has ever banked is tranche 3e-C's `differencePeak` of 6.07 on
//      BOTH backends, i.e. an observed fraction of 6.07 / 21.1969 = 0.2864 of
//      the analytic peak. That single observation is treated as an UPPER
//      BOUND the floor must clear, never as the source of the floor's
//      magnitude: 0.14 is roughly half of 0.2864, so a correct fix whose
//      antialiasing differs — a different driver, a different MSAA/resolve
//      path — has headroom to land anywhere from 0 up to about double the
//      one banked observation before this floor would false-fail it.
//   3. QUANTIZATION_HALF_CODE (0.5) — one 8-bit sample's rounding error.
//
//   floor = 21.2 * 0.14 - 0.5 = 2.968 - 0.5 = 2.468 — well below the single
//   banked observation (6.07) and well above both the fully-erased pre-fix
//   state (0.0) and the modelled shell-composite residual (~0.095,
//   `sky-shell-star-occlusion.spec.mjs`'s "the shell composite is what the
//   difference census sees"). No fitted assertion is made about this floor's
//   distance from any single measurement — that was the B1 review's finding
//   against the first version of this derivation, and the replacement
//   assertions (in `sky-shell-star-occlusion.spec.mjs`) check only the class
//   separation and the stated headroom, never a specific gap to 6.07.

/** @see the derivation block above. */
export const STAR_PEAK_LUMA_AT_CONTROL_ELEVATION = 21.2;
/** @see the derivation block above — a declared safety factor, not physics. */
export const STAR_REACHABILITY_RESIDUAL_FRACTION = 0.14;
/** @see the derivation block above. */
export const QUANTIZATION_HALF_CODE = 0.5;

/**
 * Derives the STAR REACHABILITY control's `differencePeak` floor (Q-115,
 * repaired post-B1-review). Pure function of its inputs — every default is a
 * named, documented constant above, never the probe's own measured value —
 * so it can be unit-tested against the pre-fix (0.0), the modelled shell
 * composite (~0.095), and the banked post-fix (6.07) measurements without a
 * browser.
 *
 * @param {object} [inputs] Override any term for testing; all default to the
 *   derived-from-the-header constants above.
 * @param {number} [inputs.starPeakLuma] Analytic, atmosphere-extinguished
 *   peak luma of the control lane's target star (extinction is already
 *   inside this value — do not multiply it by an extinction ratio again).
 * @param {number} [inputs.residualFraction] Declared safety factor applied to
 *   `starPeakLuma`; NOT a physical quantity — see the derivation block.
 * @param {number} [inputs.quantizationHalfCode] 8-bit rounding-error margin.
 * @returns {number} The `differencePeak` floor, in 8-bit luma codes.
 */
export function deriveStarReachabilityFloor({
  starPeakLuma = STAR_PEAK_LUMA_AT_CONTROL_ELEVATION,
  residualFraction = STAR_REACHABILITY_RESIDUAL_FRACTION,
  quantizationHalfCode = QUANTIZATION_HALF_CODE,
} = {}) {
  return starPeakLuma * residualFraction - quantizationHalfCode;
}

/**
 * The floor at its documented defaults, precomputed so callers (and their
 * console output) do not each re-derive it.
 */
export const STAR_REACHABILITY_DIFFERENCE_PEAK_FLOOR =
  deriveStarReachabilityFloor();

/**
 * Whether a difference census resolved the star field's OWN contribution AT
 * the target: available, positionally resolved within tolerance, AND its
 * peak clears the Q-115 floor. Extracted so the probe's gate and its unit
 * tests share one boolean instead of the probe re-deriving it inline.
 *
 * @param {object|null} census A `censusAtTargetDifference` result.
 * @param {number} [floor] Difference-peak floor; defaults to
 *   {@link STAR_REACHABILITY_DIFFERENCE_PEAK_FLOOR}.
 * @returns {boolean} True only when every condition holds.
 */
export function isStarReachable(
  census,
  floor = STAR_REACHABILITY_DIFFERENCE_PEAK_FLOOR,
) {
  return (
    !!census &&
    census.available === true &&
    census.resolvedAtTarget === true &&
    Number.isFinite(census.peakMax) &&
    census.peakMax >= floor
  );
}

/**
 * Rec.709 luma of an RGBA box, in the stored 8-bit domain the detector expects.
 *
 * @param {{data: ArrayLike<number>, w: number, h: number}} box RGBA box.
 * @returns {Float32Array} Luma plane, length `w * h`.
 */
export function lumaPlane(box) {
  const plane = new Float32Array(box.w * box.h);
  for (let p = 0; p < plane.length; p++) {
    const i = 4 * p;
    plane[p] =
      0.2126 * box.data[i] +
      0.7152 * box.data[i + 1] +
      0.0722 * box.data[i + 2];
  }
  return plane;
}

/**
 * Reduce a census result to the positional claim, relative to a box centre.
 *
 * @param {object} result A `pointSourceCensus` result with sources collected.
 * @param {{centerX: number, centerY: number}} box The box the census ran on.
 * @returns {object} Count, peak, contrast, nearest distance, and the claim.
 */
export function summarizeCensus(result, box) {
  let nearestPx = Infinity;
  for (const source of result.sources ?? []) {
    const d = Math.hypot(source.x - box.centerX, source.y - box.centerY);
    if (d < nearestPx) {
      nearestPx = d;
    }
  }
  return {
    available: true,
    count: result.count,
    peakMax: result.peakMax,
    strongest: result.strongest,
    nearestPx,
    resolvedAtTarget: nearestPx <= STAR_AIM_TOLERANCE_PX,
  };
}

/**
 * Census of the ABSOLUTE frame at the target, at the shared detector's own
 * thresholds. Reported as a diagnostic; see the module note for why it is not
 * the control for a ground camera.
 *
 * @param {object|null} box RGBA box centred on the target.
 * @returns {object} Census summary, or `{available: false}`.
 */
export function censusAtTarget(box) {
  if (!box) {
    return { available: false };
  }
  return summarizeCensus(
    pointSourceCensus(lumaPlane(box), box.w, box.h, { collectSources: true }),
    box,
  );
}

/**
 * Census of the star field's OWN contribution at the target: the stars-on box
 * minus the stars-off box, clamped at zero.
 *
 * @param {object|null} onBox RGBA box with the star field shown.
 * @param {object|null} offBox RGBA box at the same instant with it hidden.
 * @returns {object} Census summary, or `{available: false}`.
 */
export function censusAtTargetDifference(onBox, offBox) {
  if (!onBox || !offBox || onBox.w !== offBox.w || onBox.h !== offBox.h) {
    return { available: false };
  }
  const on = lumaPlane(onBox);
  const off = lumaPlane(offBox);
  const plane = new Float32Array(on.length);
  for (let p = 0; p < plane.length; p++) {
    plane[p] = Math.max(on[p] - off[p], 0);
  }
  return summarizeCensus(
    pointSourceCensus(plane, onBox.w, onBox.h, DIFFERENCE_CENSUS_OPTIONS),
    onBox,
  );
}
