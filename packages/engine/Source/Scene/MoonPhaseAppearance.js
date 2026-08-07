// MoonPhaseAppearance.js — C12-21 / C12-22 shared resolver + reference math.
//
// Scene Logic Extractor pattern (CLAUDE.md): both moon-phase appearance terms
// are resolved HERE, once, before `Moon.update` branches into the feature
// renderer, and the resolved NUMBERS are published on `frameState` exactly the
// way C12-25 publishes `moonNormalMapStrength` and C12-15/16 publish
// `sunDiscAppearance`. That is what makes the WGSL twin
// (`Shaders/WebGPU/Environment/Moon.wgsl`) and the GLSL twin
// (`Shaders/EllipsoidFS.glsl`) provably read the same values instead of each
// re-deriving them from `atmosphericConditions`.
//
// WHY A SHARED MODULE AND NOT TWO SHADER LITERALS. The C12 moon wave already
// pays for one drift class here: `phaseFraction` used to be a WGSL-only disc
// multiplier with no GLSL counterpart (the C11-176b `phaseGate` blackout).
// Every number below therefore has exactly one definition, and
// `Tools/visual-regression/moon-phase-terminator.spec.mjs` asserts that both
// shader texts agree with it.
//
// ─── C12-21, phase-dependent earthshine ────────────────────────────────────
// Earthshine is sunlight that reflects off EARTH onto the Moon's night side —
// the "ashen light" / "old moon in the new moon's arms". Earth's phase as seen
// from the Moon is the exact COMPLEMENT of the Moon's phase as seen from
// Earth, so earthshine PEAKS at new moon and VANISHES at full. The shipped
// term was a constant, which is physically backwards; the fix is one factor of
// `1 - phaseFraction`. Off position: the scale is exactly 1.0, i.e. the
// historical constant, bit-for-bit.
//
// ─── C12-22, soft terminator ───────────────────────────────────────────────
// The Sun is not a point: from the Moon it subtends an angular RADIUS of
// `asin(SOLAR_RADIUS / d)` ≈ 0.2664° ≈ 4.649e-3 rad. Inside that band around
// the geometric terminator the solar disc is partially below the local
// horizon, so the irradiance falls off smoothly instead of being clipped by
// `max(N·L, 0)`. Off position: softness is exactly 0.0 and both shaders return
// the legacy `max(N·L, 0)` unchanged.
//
// @private
// @module MoonPhaseAppearance

import CesiumMath from "../Core/Math.js";

/**
 * Blue-grey earthshine tint, and its strength, as they appear verbatim in
 * BOTH shader twins. Exported so the spec can prove the two texts and this
 * module carry one set of numbers rather than three.
 *
 * The tint is cool because Earth's albedo is dominated by ocean and cloud;
 * the strength is the shipped artistic value, unchanged by C12-21 — this row
 * only makes the term's PHASE dependence correct, not its amplitude.
 *
 * @private
 */
const EARTHSHINE_TINT_RED = 0.4;
const EARTHSHINE_TINT_GREEN = 0.5;
const EARTHSHINE_TINT_BLUE = 0.7;
const EARTHSHINE_STRENGTH = 0.08;

/**
 * One astronomical unit in metres (IAU 2012 exact definition). Used only as
 * the fallback Sun→Moon distance when the frame has no sun position; the live
 * path measures the real distance, which varies ±1.7% over a year with
 * Earth's orbital eccentricity.
 *
 * @private
 */
const ASTRONOMICAL_UNIT = 1.495978707e11;

/**
 * Mean solar angular RADIUS seen from the Moon, in radians — the width of the
 * terminator penumbra in N·L units.
 *
 * `asin(CesiumMath.SOLAR_RADIUS / ASTRONOMICAL_UNIT)` = 4.6491e-3 rad =
 * 0.26638°, i.e. a 0.5328° angular diameter. NOTE for anyone comparing
 * against the C12-22 queue row: that row quotes "±0.0044", which is the
 * half-angle of a solar diameter ROUNDED to 0.5° (0.25° = 4.3633e-3 rad). The
 * unrounded figure used here is 6.6% larger. The difference is far below one
 * pixel at any rendered disc size, but there is no reason to ship the rounded
 * number when the exact one costs the same.
 *
 * @private
 */
const MEAN_SOLAR_ANGULAR_RADIUS = Math.asin(
  CesiumMath.SOLAR_RADIUS / ASTRONOMICAL_UNIT,
);

/**
 * C12-21. Converts the Moon's illuminated fraction as seen from Earth into
 * the earthshine scale — Earth's illuminated fraction as seen from the Moon,
 * which is its exact complement.
 *
 * @param {number} phaseFraction The Moon's illuminated fraction, 0 = new,
 *        1 = full. Clamped; a non-finite input yields the identity 1.0.
 * @returns {number} `1 - phaseFraction`, in [0, 1].
 * @private
 */
function computeEarthshinePhaseScale(phaseFraction) {
  if (!Number.isFinite(phaseFraction)) {
    return 1.0;
  }
  return 1.0 - Math.min(Math.max(phaseFraction, 0.0), 1.0);
}

/**
 * C12-22. Solar angular radius seen from the Moon at a given Sun→Moon
 * distance.
 *
 * @param {number} [sunDistance] Sun→Moon distance in metres.
 * @returns {number} Angular radius in radians; the mean value when the
 *          distance is missing or physically impossible.
 * @private
 */
function computeSolarAngularRadius(sunDistance) {
  if (!Number.isFinite(sunDistance) || sunDistance <= CesiumMath.SOLAR_RADIUS) {
    return MEAN_SOLAR_ANGULAR_RADIUS;
  }
  return Math.asin(CesiumMath.SOLAR_RADIUS / sunDistance);
}

/**
 * C12-22 REFERENCE IMPLEMENTATION of the shader math — the JS twin of
 * `softTerminatorMu0` in `Moon.wgsl` and `EllipsoidFS.glsl`. Every property
 * the shaders rely on is asserted against THIS function in
 * `Tools/visual-regression/moon-phase-terminator.spec.mjs`.
 *
 * Replaces `max(nDotL, 0)` with the cosine-weighted irradiance from a solar
 * disc of angular radius `softness`, using the standard C1 quadratic
 * "wrap" closed form:
 *
 *     f(c) = 0                          c <= -w
 *     f(c) = (c + w)^2 / (4w)           -w < c < w
 *     f(c) = c                          c >= w
 *
 * It is EXACTLY the legacy value outside the band, matches value AND slope at
 * both seams, and peaks over the legacy curve at exactly `c = 0`, where the
 * difference is exactly `w / 4`. Compared against the exact disc integral it
 * is high by ~18% at `c = 0` (`w/4` vs `2w/3π`) — an error of 2.7e-4 in μ0,
 * which is not resolvable at any disc size this engine renders.
 *
 * WHY NOT LITERALLY "one smoothstep", as the C12-22 row prescribes: a bare
 * `smoothstep(-w, w, c)` returns a 0..1 GATE, not an irradiance. Multiplying
 * `max(c, 0)` by it leaves the dark side at exactly 0 (so the terminator is
 * not softened at all) while darkening the lit side — it makes the edge
 * HARDER, not softer. The spec keeps that mutant as an explicit negative
 * control.
 *
 * @param {number} nDotL Cosine of the angle between the surface normal and
 *        the light direction.
 * @param {number} softness Solar angular radius in radians. `<= 0` selects the
 *        exact legacy `max(nDotL, 0)`.
 * @returns {number} The softened μ0.
 * @private
 */
function softTerminatorMu0(nDotL, softness) {
  const hard = Math.max(nDotL, 0.0);
  // `!(softness > 0)` rather than `softness <= 0` so a NaN softness also
  // selects the identity. The shaders use `softness <= 0.0` because their
  // uniform is CPU-resolved here and can never be NaN.
  if (!(softness > 0.0)) {
    return hard;
  }
  const clamped = Math.min(Math.max(nDotL, -softness), softness);
  const t = clamped + softness;
  return Math.max(nDotL - softness, 0.0) + (t * t) / (4.0 * softness);
}

/**
 * Creates the mutable result object {@link readMoonPhaseAppearance} fills in.
 * One per {@link Moon} instance; never reallocated per frame.
 *
 * @returns {object} The appearance state.
 * @private
 */
function createMoonPhaseAppearance() {
  return {
    // Resolved toggle positions.
    earthshinePhase: false,
    softTerminator: false,
    // Uniform payload — exactly what both shader twins consume.
    // 1.0 and 0.0 are the two exact identities.
    earthshinePhaseScale: 1.0,
    terminatorSoftness: 0.0,
  };
}

/**
 * Resolves the two C12 moon-phase appearance toggles from the frame's
 * `atmosphericConditions.lighting` leaf.
 *
 * Both require the facade (`=== true`), matching how {@link Moon} already
 * reads `enableLunarBRDF`, `enableOppositionSurge` and `enableLunarNormalMap`:
 * a scene with no globe attached keeps the pre-C12 look exactly.
 *
 * `enableMoonPhase` gates the earthshine phase term as well as the disc phase
 * fraction. It has to: when moon-phase modelling is off, {@link Moon} forces
 * `phaseFraction` to the 1.0 sentinel, and `1 - 1 = 0` would silently DELETE
 * earthshine rather than leave it constant — the opposite of what "don't model
 * phase" means.
 *
 * @param {object} [lighting] The `atmosphericConditions.lighting` leaf.
 * @param {boolean} phaseModelled Whether `lighting.enableMoonPhase` is on.
 * @param {number} phaseFraction The Moon's illuminated fraction in [0, 1].
 * @param {number} [sunDistance] Sun→Moon distance in metres.
 * @param {object} result A {@link createMoonPhaseAppearance} object to fill.
 * @returns {object} `result`.
 * @private
 */
function readMoonPhaseAppearance(
  lighting,
  phaseModelled,
  phaseFraction,
  sunDistance,
  result,
) {
  const earthshinePhase =
    phaseModelled === true && lighting?.enableEarthshinePhase === true;
  const softTerminator = lighting?.enableSoftTerminator === true;

  result.earthshinePhase = earthshinePhase;
  result.softTerminator = softTerminator;
  result.earthshinePhaseScale = earthshinePhase
    ? computeEarthshinePhaseScale(phaseFraction)
    : 1.0;
  result.terminatorSoftness = softTerminator
    ? computeSolarAngularRadius(sunDistance)
    : 0.0;
  return result;
}

export {
  ASTRONOMICAL_UNIT,
  EARTHSHINE_TINT_RED,
  EARTHSHINE_TINT_GREEN,
  EARTHSHINE_TINT_BLUE,
  EARTHSHINE_STRENGTH,
  MEAN_SOLAR_ANGULAR_RADIUS,
  computeEarthshinePhaseScale,
  computeSolarAngularRadius,
  createMoonPhaseAppearance,
  readMoonPhaseAppearance,
  softTerminatorMu0,
};
// Default export REQUIRED by the generated barrel: `packages/engine/index.js`
// is produced by `scripts/build.js`, which emits `export { default as X }`
// for every `Source/**/*.js` with no exclusion mechanism, so a named-exports-
// only module fails `npx gulp build` with "No matching export ... for import
// default". `npx tsc --noEmit` does NOT catch it (it never checks the
// generated barrel) — a gulp build is the only gate for this class.
export default readMoonPhaseAppearance;
