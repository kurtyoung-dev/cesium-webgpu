// LunarEclipseState.js — Earth's shadow at the Moon, and the appearance law
// both moon shaders read from it.
//
// A lunar eclipse is the one celestial event where the Moon's own disc is the
// screen the Earth's shadow falls on. The geometry is a pair of coaxial cones
// anchored on the Sun and the Earth, sampled in the plane the Moon happens to
// occupy: inside the umbral radius the solar disc is entirely hidden, outside
// the penumbral radius it is entirely visible, and between them exactly the
// circle-circle overlap of the two projected discs is blocked. That is the
// whole of the geometry, and it is computed here once per frame in f64 so the
// WGSL twin (`Shaders/WebGPU/Environment/Moon.wgsl`) and the GLSL twin
// (`Shaders/EllipsoidFS.glsl`) receive numbers rather than each re-deriving
// an ephemeris.
//
// Why the shadow radii are enlarged. A ray grazing the solid Earth would draw
// a geometrically sharp shadow, but the real edge is drawn by rays that graze
// the ATMOSPHERE, several tens of kilometres higher, and every observed
// timing has matched an enlarged shadow since Danjon measured the excess at
// 1/85 of the Earth's radius. Against the five published eclipses the goldens
// pin, that value fits best: peak umbral magnitudes land within 0.019 of the
// catalogue, against 0.033 with no enlargement and 0.034 with the older 1/50
// rule.
//
// Why the umbra is copper and not black. No sunlight reaches the umbra
// directly, but the Earth's atmosphere refracts a ring of it inward, and that
// ring has crossed a very long, very low atmospheric path — the light of every
// sunrise and sunset on Earth at once. Rayleigh scattering removes the short
// wavelengths from it in proportion to 1/lambda^4, so what arrives is the red
// end of the spectrum, and the deeper into the umbra a point sits the longer
// the path its light had to bend through. `lunarShadowFactor` is that model:
// one optical depth that grows from the umbral rim to the axis, applied per
// channel through the Rayleigh ratio.
//
// @private
// @module LunarEclipseState

import Cartesian3 from "../Core/Cartesian3.js";
import CesiumMath from "../Core/Math.js";
import defined from "../Core/defined.js";

/**
 * Danjon's shadow enlargement — the factor the Earth's radius is multiplied
 * by before the shadow cones are drawn, standing in for the atmosphere that
 * actually casts their edge.
 *
 * @private
 */
const LUNAR_SHADOW_ENLARGEMENT = 1.0 + 1.0 / 85.0;

/**
 * Rayleigh optical depth at the reference wavelength for light refracted past
 * the umbral RIM — the shallowest path through the Earth's atmosphere that
 * still lands inside the umbra.
 *
 * @private
 */
const LUNAR_UMBRA_OPTICAL_DEPTH_EDGE = 1.2;

/**
 * The same optical depth on the shadow AXIS, where the refracted light has
 * taken the longest and lowest path. The ratio of the two ends is what makes
 * the umbra deepen from orange at its rim to blood red at its centre.
 *
 * @private
 */
const LUNAR_UMBRA_OPTICAL_DEPTH_CENTER = 4.0;

/**
 * Per-channel Rayleigh optical-depth ratios, `(550 / lambda)^4` at
 * lambda = 650 / 550 / 450 nm. The green channel is the reference and is
 * exactly 1. These three literals appear verbatim in both shader twins;
 * `lunar-eclipse-earth-shadow.spec.mjs` asserts the three texts carry one set
 * of numbers, and that each matches the closed form to 1e-6.
 *
 * @private
 */
const LUNAR_UMBRA_RAYLEIGH_RED = 0.512622;
const LUNAR_UMBRA_RAYLEIGH_GREEN = 1.0;
const LUNAR_UMBRA_RAYLEIGH_BLUE = 2.23152;

/**
 * Amplitude of the refracted umbral term. Radiometrically the umbra is some
 * four orders of magnitude below the full Moon, which would render as black;
 * a photograph or a dark-adapted eye sees copper instead, and this is the
 * exposure that stands in for both. It multiplies a transmission that is
 * already below 1, so the umbral rim lands near a tenth of the uneclipsed
 * disc and the axis near a fortieth of it.
 *
 * @private
 */
const LUNAR_UMBRA_GAIN = 0.25;

/**
 * Exponent on the coverage fraction that fades the refracted term out through
 * the penumbra. Refracted light exists there too but is swamped by the direct
 * sunlight that is still arriving, and a linear weight would lay a visible
 * copper wash across the whole penumbral gradient. The cube leaves under 2%
 * of the term at half coverage and reaches full strength exactly at the
 * umbral rim, where the direct term has just gone to zero — so the two halves
 * meet continuously.
 *
 * @private
 */
const LUNAR_UMBRA_COVERAGE_EXPONENT = 3.0;

/**
 * Rec. 709 luminance weights, used only to collapse the per-channel disc
 * brightness into the single scalar a light source can carry.
 *
 * @private
 */
const LUMINANCE_RED = 0.2126;
const LUMINANCE_GREEN = 0.7152;
const LUMINANCE_BLUE = 0.0722;

/**
 * Radial quadrature steps for the disc integral. The integrand is smooth
 * except at the umbral rim, where it is continuous but has a kink; 64 steps
 * put the integral within 1e-4 of a 4096-step reference at every phase of
 * every golden eclipse.
 *
 * @private
 */
const DISC_INTEGRAL_STEPS = 64;

const scratchAxis = new Cartesian3();
const scratchOffset = new Cartesian3();
const scratchFactor = new Cartesian3();

/**
 * Fraction of the solar disc that the Earth hides, at a point `radius` metres
 * from the shadow axis in the plane of the Moon.
 *
 * The two radii the caller supplies are exactly the two circle-overlap
 * limits, which is what lets this be written scale-free. Working in units of
 * the penumbral radius, the projected solar disc has radius `(1 - u) / 2` and
 * the projected Earth disc `(1 + u) / 2`, where `u` is the umbral radius in
 * those same units. Their sum is 1 and their difference is `u`, so first
 * contact is at exactly the penumbral radius and totality at exactly the
 * umbral one — no tolerance, no tuning.
 *
 * The JavaScript twin of `lunarShadowCoverage` in both shaders.
 *
 * @param {number} radius Distance from the shadow axis, metres.
 * @param {number} umbraRadius Umbral radius at the Moon's plane, metres.
 * @param {number} penumbraRadius Penumbral radius at the Moon's plane, metres.
 * @returns {number} Blocked fraction in [0, 1]; 0 when no shadow is present.
 * @private
 */
function lunarShadowCoverage(radius, umbraRadius, penumbraRadius) {
  if (!(penumbraRadius > 0.0)) {
    return 0.0;
  }
  const inv = 1.0 / penumbraRadius;
  const u = umbraRadius * inv;
  const d = radius * inv;
  const rs = 0.5 * (1.0 - u);
  const re = 0.5 * (1.0 + u);
  if (!(rs > 0.0)) {
    return 0.0;
  }
  if (d >= 1.0) {
    return 0.0;
  }
  if (d <= u) {
    return 1.0;
  }
  // Reachable only for a negative umbral radius, i.e. a Moon beyond the tip
  // of the umbral cone. That cannot happen at the lunar distance, but the
  // annular arm keeps the function total rather than silently wrong if the
  // inputs ever change.
  if (d <= rs - re) {
    return (re * re) / (rs * rs);
  }
  const dd = Math.max(d, 1.0e-6);
  const cosA = Math.min(
    Math.max((dd * dd + rs * rs - re * re) / (2.0 * dd * rs), -1.0),
    1.0,
  );
  const cosB = Math.min(
    Math.max((dd * dd + re * re - rs * rs) / (2.0 * dd * re), -1.0),
    1.0,
  );
  const a = Math.acos(cosA);
  const b = Math.acos(cosB);
  const area =
    rs * rs * (a - Math.sin(a) * cosA) + re * re * (b - Math.sin(b) * cosB);
  return Math.min(Math.max(area / (Math.PI * rs * rs), 0.0), 1.0);
}

/**
 * The per-channel brightness multiplier the moon disc is scaled by, at a
 * point `radius` metres from the shadow axis.
 *
 * Two terms. The direct one is simply the unblocked fraction of the solar
 * disc, achromatic because nothing has filtered it. The refracted one is the
 * copper: an optical depth that grows linearly from the umbral rim to the
 * axis, applied per channel through the Rayleigh ratio, faded in through the
 * penumbra by the coverage cube so the two terms hand over continuously at
 * the rim.
 *
 * Returns exactly `(1, 1, 1)` outside the penumbra, so a disc drawn outside
 * the shadow is untouched.
 *
 * The JavaScript twin of `lunarShadowFactor` in both shaders.
 *
 * @param {number} radius Distance from the shadow axis, metres.
 * @param {number} umbraRadius Umbral radius at the Moon's plane, metres.
 * @param {number} penumbraRadius Penumbral radius at the Moon's plane, metres.
 * @param {Cartesian3} result The object to store the multiplier in.
 * @returns {Cartesian3} `result`.
 * @private
 */
function lunarShadowFactor(radius, umbraRadius, penumbraRadius, result) {
  const coverage = lunarShadowCoverage(radius, umbraRadius, penumbraRadius);
  const illumination = 1.0 - coverage;
  const depth = Math.min(
    Math.max(1.0 - radius / Math.max(umbraRadius, 1.0), 0.0),
    1.0,
  );
  const tau =
    LUNAR_UMBRA_OPTICAL_DEPTH_EDGE +
    (LUNAR_UMBRA_OPTICAL_DEPTH_CENTER - LUNAR_UMBRA_OPTICAL_DEPTH_EDGE) * depth;
  const weight =
    LUNAR_UMBRA_GAIN * Math.pow(coverage, LUNAR_UMBRA_COVERAGE_EXPONENT);
  result.x = illumination + weight * Math.exp(-tau * LUNAR_UMBRA_RAYLEIGH_RED);
  result.y =
    illumination + weight * Math.exp(-tau * LUNAR_UMBRA_RAYLEIGH_GREEN);
  result.z = illumination + weight * Math.exp(-tau * LUNAR_UMBRA_RAYLEIGH_BLUE);
  return result;
}

/**
 * Half-angle of the arc that a circle of radius `discRadius`, whose centre
 * sits `centerDistance` from the origin, cuts out of the ring of radius
 * `radius`. `PI` when the ring lies wholly inside the circle, 0 when wholly
 * outside. The measure the disc integral below weights each ring by.
 *
 * @param {number} radius Ring radius.
 * @param {number} centerDistance Distance from origin to the disc centre.
 * @param {number} discRadius Disc radius.
 * @returns {number} Half-angle in [0, PI].
 * @private
 */
function ringHalfAngleInsideDisc(radius, centerDistance, discRadius) {
  if (centerDistance <= 1.0e-9) {
    return radius <= discRadius ? Math.PI : 0.0;
  }
  if (radius <= 1.0e-9) {
    return centerDistance <= discRadius ? Math.PI : 0.0;
  }
  const cos =
    (radius * radius +
      centerDistance * centerDistance -
      discRadius * discRadius) /
    (2.0 * radius * centerDistance);
  if (cos <= -1.0) {
    return Math.PI;
  }
  if (cos >= 1.0) {
    return 0.0;
  }
  return Math.acos(cos);
}

/**
 * Area fraction of the lunar disc that lies inside a circle of radius
 * `circleRadius` centred on the shadow axis — the closed-form two-circle
 * overlap. Used for the umbral and penumbral disc fractions, which are the
 * geometric quantities a published eclipse catalogue can be checked against
 * without reference to any appearance model.
 *
 * @param {number} circleRadius Radius of the shadow circle, metres.
 * @param {number} centerDistance Moon centre to shadow axis, metres.
 * @param {number} moonRadius Lunar radius, metres.
 * @returns {number} Fraction in [0, 1].
 * @private
 */
function discFractionInsideCircle(circleRadius, centerDistance, moonRadius) {
  if (!(moonRadius > 0.0) || !(circleRadius > 0.0)) {
    return 0.0;
  }
  if (centerDistance >= circleRadius + moonRadius) {
    return 0.0;
  }
  if (centerDistance <= circleRadius - moonRadius) {
    return 1.0;
  }
  if (centerDistance <= moonRadius - circleRadius) {
    return (circleRadius * circleRadius) / (moonRadius * moonRadius);
  }
  const d = Math.max(centerDistance, 1.0e-9);
  const rm = moonRadius;
  const rc = circleRadius;
  const cosM = Math.min(
    Math.max((d * d + rm * rm - rc * rc) / (2.0 * d * rm), -1.0),
    1.0,
  );
  const cosC = Math.min(
    Math.max((d * d + rc * rc - rm * rm) / (2.0 * d * rc), -1.0),
    1.0,
  );
  const am = Math.acos(cosM);
  const ac = Math.acos(cosC);
  const area =
    rm * rm * (am - Math.sin(am) * cosM) + rc * rc * (ac - Math.sin(ac) * cosC);
  return Math.min(Math.max(area / (Math.PI * rm * rm), 0.0), 1.0);
}

/**
 * Disc-averaged luminance of {@link lunarShadowFactor} over the lunar disc —
 * the single scalar a moonlight consumer can multiply by.
 *
 * Integrated in the shadow plane rather than over the sphere, which is the
 * same approximation the shaders make when they project a surface point onto
 * the plane, so the light and the disc cannot disagree about how eclipsed the
 * Moon is.
 *
 * @param {number} umbraRadius Umbral radius at the Moon's plane, metres.
 * @param {number} penumbraRadius Penumbral radius at the Moon's plane, metres.
 * @param {number} centerDistance Moon centre to shadow axis, metres.
 * @param {number} moonRadius Lunar radius, metres.
 * @returns {number} Multiplier in (0, 1]; exactly 1.0 outside the penumbra.
 * @private
 */
function computeLunarDiscLuminanceFactor(
  umbraRadius,
  penumbraRadius,
  centerDistance,
  moonRadius,
) {
  if (!(penumbraRadius > 0.0) || !(moonRadius > 0.0)) {
    return 1.0;
  }
  if (centerDistance >= penumbraRadius + moonRadius) {
    return 1.0;
  }
  const lo = Math.max(centerDistance - moonRadius, 0.0);
  const hi = centerDistance + moonRadius;
  const step = (hi - lo) / DISC_INTEGRAL_STEPS;
  if (!(step > 0.0)) {
    return 1.0;
  }
  let weighted = 0.0;
  let total = 0.0;
  for (let i = 0; i < DISC_INTEGRAL_STEPS; i++) {
    const radius = lo + (i + 0.5) * step;
    const halfAngle = ringHalfAngleInsideDisc(
      radius,
      centerDistance,
      moonRadius,
    );
    if (halfAngle <= 0.0) {
      continue;
    }
    const measure = halfAngle * radius;
    lunarShadowFactor(radius, umbraRadius, penumbraRadius, scratchFactor);
    weighted +=
      measure *
      (LUMINANCE_RED * scratchFactor.x +
        LUMINANCE_GREEN * scratchFactor.y +
        LUMINANCE_BLUE * scratchFactor.z);
    total += measure;
  }
  if (!(total > 0.0)) {
    return 1.0;
  }
  return weighted / total;
}

/**
 * Creates the mutable state object {@link updateLunarEclipseState} fills in.
 * One per logical view; never reallocated, so consumers may hold the
 * reference across frames.
 *
 * @returns {object} The lunar-eclipse state.
 * @private
 */
function createLunarEclipseState() {
  return {
    // True only while the Moon is at least touching the penumbra. Every
    // consumer short-circuits on this, so a frame with no eclipse costs one
    // boolean test rather than an arithmetic identity.
    inProgress: false,
    valid: false,
    // Unit anti-solar direction from the Earth's centre — the shadow axis.
    shadowAxisWC: new Cartesian3(),
    // Axis to Moon centre, perpendicular to the axis. Its magnitude is
    // `centerDistance`; its direction is what the shaders need to know which
    // side of the disc the bite is on.
    shadowOffsetWC: new Cartesian3(),
    axisDistance: 0.0,
    centerDistance: 0.0,
    umbraRadius: 0.0,
    penumbraRadius: 0.0,
    umbralMagnitude: 0.0,
    penumbralMagnitude: 0.0,
    umbralDiscFraction: 0.0,
    penumbralDiscFraction: 0.0,
    discLuminanceFactor: 1.0,
  };
}

/**
 * Resets `state` to the no-eclipse position — every field at the value it
 * would hold on a frame where the Moon is nowhere near the shadow.
 *
 * @param {object} state
 * @param {boolean} valid
 * @returns {object} `state`.
 * @private
 */
function clearLunarEclipseState(state, valid) {
  state.inProgress = false;
  state.valid = valid;
  Cartesian3.clone(Cartesian3.ZERO, state.shadowAxisWC);
  Cartesian3.clone(Cartesian3.ZERO, state.shadowOffsetWC);
  state.axisDistance = 0.0;
  state.centerDistance = 0.0;
  state.umbraRadius = 0.0;
  state.penumbraRadius = 0.0;
  state.umbralMagnitude = 0.0;
  state.penumbralMagnitude = 0.0;
  state.umbralDiscFraction = 0.0;
  state.penumbralDiscFraction = 0.0;
  state.discLuminanceFactor = 1.0;
  return state;
}

/**
 * Recomputes `state` from this frame's Sun and Moon positions.
 *
 * Both positions must be expressed in the same Earth-centred frame; the
 * geometry is invariant under the rotation that separates the inertial and
 * fixed frames, so either works as long as they agree.
 *
 * @param {object} state A {@link createLunarEclipseState} object to fill.
 * @param {object} options
 * @param {Cartesian3} [options.sunPositionWC] Earth-centred Sun position, metres.
 * @param {Cartesian3} [options.moonPositionWC] Earth-centred Moon position, metres.
 * @param {number} [options.earthRadius] Equatorial radius of the shadow-casting
 *        body, metres, BEFORE Danjon's enlargement is applied.
 * @param {number} [options.moonRadius] Lunar radius, metres.
 * @returns {object} `state`.
 * @private
 */
function updateLunarEclipseState(state, options) {
  const sun = options.sunPositionWC;
  const moon = options.moonPositionWC;
  if (!defined(sun) || !defined(moon)) {
    return clearLunarEclipseState(state, false);
  }
  const sunDistance = Cartesian3.magnitude(sun);
  const moonDistance = Cartesian3.magnitude(moon);
  if (!(sunDistance > 0.0) || !(moonDistance > 0.0)) {
    return clearLunarEclipseState(state, false);
  }

  // Shadow axis: the anti-solar direction, pointing away from the Sun through
  // the Earth's centre.
  const axis = Cartesian3.multiplyByScalar(
    sun,
    -1.0 / sunDistance,
    scratchAxis,
  );

  // Split the Moon's position into its along-axis and perpendicular parts.
  // The perpendicular magnitude is the only geometric input the magnitudes
  // depend on; the along-axis distance sets how wide the cones have opened by
  // the time they reach it.
  const axisDistance = Cartesian3.dot(moon, axis);
  const offset = Cartesian3.subtract(
    moon,
    Cartesian3.multiplyByScalar(axis, axisDistance, scratchOffset),
    scratchOffset,
  );
  const centerDistance = Cartesian3.magnitude(offset);

  const moonRadius = options.moonRadius ?? CesiumMath.LUNAR_RADIUS;
  const earthRadius = options.earthRadius;
  if (!(earthRadius > 0.0) || !(moonRadius > 0.0)) {
    return clearLunarEclipseState(state, false);
  }

  // Behind the Earth is the only place a shadow exists. A Moon on the sunward
  // side would otherwise produce cone radii from a negative along-axis
  // distance and a shadow that is not there.
  if (!(axisDistance > 0.0)) {
    return clearLunarEclipseState(state, true);
  }

  const enlargedEarthRadius = earthRadius * LUNAR_SHADOW_ENLARGEMENT;
  const solarRadius = CesiumMath.SOLAR_RADIUS;
  const umbraRadius =
    enlargedEarthRadius -
    (axisDistance * (solarRadius - enlargedEarthRadius)) / sunDistance;
  const penumbraRadius =
    enlargedEarthRadius +
    (axisDistance * (solarRadius + enlargedEarthRadius)) / sunDistance;

  // Magnitudes in the catalogue convention: how far the Moon's diameter has
  // entered each shadow, in units of that diameter. Negative before first
  // contact, 1 at the start of totality.
  const umbralMagnitude =
    (umbraRadius + moonRadius - centerDistance) / (2.0 * moonRadius);
  const penumbralMagnitude =
    (penumbraRadius + moonRadius - centerDistance) / (2.0 * moonRadius);

  if (!(penumbralMagnitude > 0.0) || !(penumbraRadius > 0.0)) {
    const cleared = clearLunarEclipseState(state, true);
    cleared.umbralMagnitude = umbralMagnitude;
    cleared.penumbralMagnitude = penumbralMagnitude;
    return cleared;
  }

  state.inProgress = true;
  state.valid = true;
  Cartesian3.clone(axis, state.shadowAxisWC);
  Cartesian3.clone(offset, state.shadowOffsetWC);
  state.axisDistance = axisDistance;
  state.centerDistance = centerDistance;
  state.umbraRadius = umbraRadius;
  state.penumbraRadius = penumbraRadius;
  state.umbralMagnitude = umbralMagnitude;
  state.penumbralMagnitude = penumbralMagnitude;
  state.umbralDiscFraction = discFractionInsideCircle(
    umbraRadius,
    centerDistance,
    moonRadius,
  );
  state.penumbralDiscFraction = discFractionInsideCircle(
    penumbraRadius,
    centerDistance,
    moonRadius,
  );
  state.discLuminanceFactor = computeLunarDiscLuminanceFactor(
    umbraRadius,
    penumbraRadius,
    centerDistance,
    moonRadius,
  );
  return state;
}

export {
  LUNAR_SHADOW_ENLARGEMENT,
  LUNAR_UMBRA_OPTICAL_DEPTH_EDGE,
  LUNAR_UMBRA_OPTICAL_DEPTH_CENTER,
  LUNAR_UMBRA_RAYLEIGH_RED,
  LUNAR_UMBRA_RAYLEIGH_GREEN,
  LUNAR_UMBRA_RAYLEIGH_BLUE,
  LUNAR_UMBRA_GAIN,
  LUNAR_UMBRA_COVERAGE_EXPONENT,
  LUMINANCE_RED,
  LUMINANCE_GREEN,
  LUMINANCE_BLUE,
  clearLunarEclipseState,
  computeLunarDiscLuminanceFactor,
  createLunarEclipseState,
  discFractionInsideCircle,
  lunarShadowCoverage,
  lunarShadowFactor,
  updateLunarEclipseState,
};
// The generated barrel requires a default export: `packages/engine/index.js`
// is produced by `scripts/build.js`, which emits `export { default as X }`
// for every `Source/**/*.js` with no exclusion mechanism, so a named-exports-
// only module fails the build with "No matching export ... for import
// default".
export default updateLunarEclipseState;
