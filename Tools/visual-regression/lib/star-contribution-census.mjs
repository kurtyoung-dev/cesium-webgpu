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
