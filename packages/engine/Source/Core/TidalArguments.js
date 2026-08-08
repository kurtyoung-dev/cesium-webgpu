import CesiumMath from "./Math.js";
import defined from "./defined.js";
import JulianDate from "./JulianDate.js";

/**
 * TidalArguments — the six Doodson/Cartwright fundamental arguments of the tidal
 * potential, evaluated from a {@link JulianDate}.
 *
 * Maintainer ruling **T6** requires the rendered tide to "match the correct tide
 * dates and timings for the globe and align with the position and movement of
 * the moon". {@link TideModel} satisfies that geometrically, straight from the
 * Simon-1994 Moon and Sun vectors. This module is the OTHER half: the harmonic
 * frequency basis that lets a per-location constituent atlas (EOT20 per ruling
 * T5, NOAA CO-OPS for US stations) be evaluated at the same scene clock. The two
 * agree — `tidal-harmonics.spec.mjs` correlates the harmonic reconstruction
 * against this engine's own geometric tide at r >= 0.99 across four latitudes
 * and three decades — which is what makes the harmonic path inherit T6 rather
 * than merely assert it.
 *
 * THE SIX ARGUMENTS. Every tidal constituent's phase is an integer combination
 * of these (Doodson 1921; Cartwright & Tayler 1971):
 *
 *   tau  mean lunar time      the Moon's rotation-driven term, ~14.492 deg/h
 *   s    mean longitude of the Moon                            0.549 deg/h
 *   h    mean longitude of the Sun                             0.0411 deg/h
 *   p    mean longitude of lunar perigee                       0.00464 deg/h
 *   N'   NEGATIVE of the longitude of the lunar ascending node 0.00221 deg/h
 *   ps   mean longitude of solar perigee (perihelion)          0.0000020 deg/h
 *
 * `N'` carries the sign convention deliberately: Doodson defined the fifth
 * argument as -Omega so that all six rates are positive and the tabulated
 * Doodson numbers come out as small non-negative digits after the +5 offset.
 * {@link TidalArguments.node} carries the un-negated Omega, because the nodal
 * f/u corrections in {@link TidalConstituents} are published in terms of it.
 *
 * SOURCE OF THE POLYNOMIALS. The mean elements are Meeus, *Astronomical
 * Algorithms*, 2nd ed. (1998): the Moon's mean longitude L', mean elongation D,
 * mean anomaly M', argument of latitude and node Omega from ch. 47 (ELP-2000/82
 * reduction), and the Sun's mean anomaly M from ch. 25 (VSOP87 reduction). The
 * four tidal arguments that are not themselves elements follow by definition:
 *
 *     h  = s - D          (D is the Moon-Sun elongation)
 *     p  = s - M'         (M' is the Moon's anomaly, measured from perigee)
 *     ps = h - M          (M is the Sun's anomaly, measured from perigee)
 *     N' = -Omega
 *
 * This is used INSTEAD of re-deriving mean longitudes from the Simon-1994
 * Cartesian ephemeris because the harmonic development needs UNIFORMLY MOVING
 * mean elements — the whole point of the Doodson basis is that each argument is
 * linear in time, which a fitted instantaneous longitude is not. The Simon-1994
 * ephemeris remains the authority for the geometric tide in {@link TideModel},
 * and the two are cross-checked against each other in the spec.
 *
 * The derivation is not taken on trust. The per-hour rates fall out of the
 * polynomials' linear coefficients and reproduce the NOAA CO-OPS published
 * constituent speeds for all ten constituents to better than 1e-6 deg/h (see
 * {@link TidalConstituents}), and `tau + s - 180 deg` reproduces this engine's
 * own IAU-82 GMST (`Transforms.computeTemeToPseudoFixedMatrix`) to a CONSTANT
 * 0.0064 deg — 1.5 s of Earth rotation — with no measurable drift over 35 years.
 *
 * TIME SCALES — THE ONE-MINUTE TRAP. `tau` is mean SOLAR time and is
 * conventionally reckoned in UT1; the five mean longitudes are functions of TT.
 * Evaluating tau in TT instead of UT1 puts every tide 69 s early, which a
 * "correct tide timings" requirement does not survive. The bridge:
 *
 *   - {@link JulianDate} stores TAI. `dayNumber` is a Julian Day Number and
 *     `secondsOfDay` is measured from NOON, not midnight — hence the +180 deg in
 *     tau below. (Dropping that +180 leaves every SEMIDIURNAL constituent
 *     correct, because 2 x 180 = 360, while silently INVERTING every diurnal
 *     one. It is the single most dangerous typo in this file.)
 *   - TT = TAI + 32.184 s exactly, so the mean longitudes use
 *     `secondsOfDay + TT_MINUS_TAI_SECONDS` with no table lookup.
 *   - UTC = TAI - dAT via {@link JulianDate.computeTaiMinusUtc} (the leap-second
 *     table this engine already ships).
 *   - UT1 = UTC + DUT1. This engine's default
 *     `Transforms.earthOrientationParameters` is `EarthOrientationParameters.NONE`,
 *     i.e. DUT1 = 0, and `Transforms.computeTemeToPseudoFixedMatrix` documents
 *     the same UT1 ~ UTC approximation. |DUT1| is held below 0.9 s by leap
 *     seconds, which is 0.0037 deg of tau and therefore under 1 SECOND of tide
 *     phase — three orders of magnitude inside anything a viewer can see, and
 *     four inside the equilibrium model's own accuracy. Callers holding real EOP
 *     pass it as the third argument of {@link TidalArguments.compute} rather
 *     than this module reaching into `Transforms` for it, which keeps the module
 *     free of the XYS/EOP dependency chain and keeps the approximation visible
 *     at the call site instead of buried here.
 *
 * @namespace TidalArguments
 */
const TidalArguments = {};

/**
 * TT - TAI, seconds. Exact by definition (IAU 1991 Resolution A4).
 * @type {number}
 */
TidalArguments.TT_MINUS_TAI_SECONDS = 32.184;

/** Days per Julian century. @type {number} */
TidalArguments.DAYS_PER_JULIAN_CENTURY = 36525.0;

/** Julian Day Number of the J2000.0 epoch. @type {number} */
TidalArguments.J2000_DAY_NUMBER = 2451545;

// Mean-element polynomials, degrees, argument T = Julian centuries of TT from
// J2000.0. Coefficient order is ascending power. Meeus (1998) ch. 47 for the
// four lunar elements and ch. 25 for the solar anomaly.
const MOON_MEAN_LONGITUDE = [
  218.3164477,
  481267.88123421,
  -0.0015786,
  1.0 / 538841.0,
  -1.0 / 65194000.0,
];
const MOON_MEAN_ELONGATION = [
  297.8501921,
  445267.1114034,
  -0.0018819,
  1.0 / 545868.0,
  -1.0 / 113065000.0,
];
const SUN_MEAN_ANOMALY = [
  357.5291092,
  35999.0502909,
  -0.0001536,
  1.0 / 24490000.0,
];
const MOON_MEAN_ANOMALY = [
  134.9633964,
  477198.8675055,
  0.0087414,
  1.0 / 69699.0,
  -1.0 / 14712000.0,
];
const MOON_ASCENDING_NODE = [
  125.0445479,
  -1934.1362891,
  0.0020754,
  1.0 / 467441.0,
  -1.0 / 60616000.0,
];

/**
 * Horner evaluation of a polynomial whose coefficients ascend in power.
 *
 * @param {number[]} coefficients Ascending-power coefficients.
 * @param {number} t The argument.
 * @returns {number} The value.
 * @private
 */
function evaluatePolynomial(coefficients, t) {
  let value = 0.0;
  for (let i = coefficients.length - 1; i >= 0; i--) {
    value = value * t + coefficients[i];
  }
  return value;
}

// Degrees per hour from a polynomial's linear term. The rates are DERIVED here
// rather than tabulated so that the NOAA constituent-speed check in the spec
// tests the polynomials themselves, not a second hand-entered table that could
// agree with NOAA while disagreeing with the phases this module actually emits.
const HOURS_PER_JULIAN_CENTURY = TidalArguments.DAYS_PER_JULIAN_CENTURY * 24.0;
/**
 * @param {number[]} coefficients An ascending-power mean-element polynomial.
 * @returns {number} Its linear term expressed in degrees per mean solar hour.
 * @private
 */
const ratePerHour = (coefficients) =>
  coefficients[1] / HOURS_PER_JULIAN_CENTURY;

const moonLongitudeRate = ratePerHour(MOON_MEAN_LONGITUDE);
const moonElongationRate = ratePerHour(MOON_MEAN_ELONGATION);
const sunAnomalyRate = ratePerHour(SUN_MEAN_ANOMALY);
const moonAnomalyRate = ratePerHour(MOON_MEAN_ANOMALY);
const nodeRate = ratePerHour(MOON_ASCENDING_NODE);

const sRate = moonLongitudeRate;
const hRate = moonLongitudeRate - moonElongationRate;
const pRate = moonLongitudeRate - moonAnomalyRate;
const psRate = hRate - sunAnomalyRate;
const nPrimeRate = -nodeRate;
// 15 deg per mean solar hour, less the rate at which the mean Moon falls behind
// the mean Sun. Reproduces the classic 14.49205211 deg/h.
const tauRate = 15.0 + hRate - sRate;

/**
 * Rates of the six fundamental arguments in DEGREES PER MEAN SOLAR HOUR, in
 * Doodson order `[tau, s, h, p, N', ps]`. Derived from the mean-element
 * polynomials above; the published values are
 * `[14.49205211, 0.54901653, 0.04106864, 0.00464183, 0.00220641, 0.00000196]`.
 * Frozen: the phase sum reads it every evaluation.
 * @type {ReadonlyArray<number>}
 */
TidalArguments.RATES_DEGREES_PER_HOUR = Object.freeze([
  tauRate,
  sRate,
  hRate,
  pRate,
  nPrimeRate,
  psRate,
]);

/**
 * The same rates in RADIANS PER SECOND, which is what a constituent's angular
 * speed is assembled from.
 * @type {ReadonlyArray<number>}
 */
TidalArguments.RATES_RADIANS_PER_SECOND = Object.freeze(
  TidalArguments.RATES_DEGREES_PER_HOUR.map(
    (r) => (r * CesiumMath.RADIANS_PER_DEGREE) / 3600.0,
  ),
);

/**
 * Allocate a result object for {@link TidalArguments.compute}. A caller on a
 * per-frame path holds one for its lifetime.
 *
 * @returns {object} The result object.
 */
TidalArguments.createResult = function () {
  return {
    /** Mean lunar time, radians in [0, 2pi). */
    tau: 0.0,
    /** Mean longitude of the Moon, radians in [0, 2pi). */
    s: 0.0,
    /** Mean longitude of the Sun, radians in [0, 2pi). */
    h: 0.0,
    /** Mean longitude of lunar perigee, radians in [0, 2pi). */
    p: 0.0,
    /** NEGATIVE mean longitude of the lunar ascending node, radians in [0, 2pi). */
    nPrime: 0.0,
    /** Mean longitude of solar perigee, radians in [0, 2pi). */
    ps: 0.0,
    /**
     * Mean longitude of the ascending node Omega, radians in [0, 2pi) — the
     * argument the published nodal f/u series are written in. `= -nPrime`.
     */
    node: 0.0,
    /**
     * The six arguments in Doodson order `[tau, s, h, p, N', ps]`, radians.
     * Mirrors the named fields; kept so the phase sum is an allocation-free
     * dot product against a constituent's Doodson numbers.
     */
    doodson: [0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    /** Julian centuries of TT from J2000.0 — diagnostic. */
    julianCenturiesTt: 0.0,
    /** The UT1 - UTC actually applied, seconds — diagnostic. */
    ut1MinusUtcSeconds: 0.0,
    /** False when the inputs were degenerate; every angle is then 0. */
    valid: false,
  };
};

/**
 * Evaluate the six fundamental arguments at a time.
 *
 * @param {JulianDate} time The time. Read as TAI (what {@link JulianDate}
 *   stores); TT and UT1 are derived internally — see the module header.
 * @param {object} [result] A {@link TidalArguments.createResult} object to fill.
 * @param {number} [ut1MinusUtcSeconds=0.0] DUT1. Pass
 *   `Transforms.earthOrientationParameters.compute(time).ut1MinusUtc` if real
 *   EOP is loaded; the default 0 costs under 1 second of tide phase.
 * @returns {object} `result` (or a fresh object), mutated in place.
 */
TidalArguments.compute = function (time, result, ut1MinusUtcSeconds) {
  const out = result ?? TidalArguments.createResult();
  out.tau = 0.0;
  out.s = 0.0;
  out.h = 0.0;
  out.p = 0.0;
  out.nPrime = 0.0;
  out.ps = 0.0;
  out.node = 0.0;
  out.julianCenturiesTt = 0.0;
  out.ut1MinusUtcSeconds = 0.0;
  out.valid = false;
  const d = out.doodson;
  d[0] = d[1] = d[2] = d[3] = d[4] = d[5] = 0.0;

  // FINITENESS, not merely definedness. A JulianDate with NaN components is
  // reachable through the public API without any hand-mutation —
  // `clock.multiplier = NaN; clock.tick()` produces one — and a defined-only
  // guard would let it through, return `valid: true` with every angle NaN, and
  // then HarmonicTideModel.predict (which trusts `valid`) would hand back
  // `{heightM: NaN, valid: true}`. A NaN anchor height is a vanished ocean
  // patch, not a visibly wrong one. The documented invariant on
  // `createResult().valid` is "every angle is 0 when false", so it has to hold
  // here too.
  if (
    !defined(time) ||
    !isFinite(time.dayNumber) ||
    !isFinite(time.secondsOfDay)
  ) {
    return out;
  }

  const dut1 =
    defined(ut1MinusUtcSeconds) && isFinite(ut1MinusUtcSeconds)
      ? ut1MinusUtcSeconds
      : 0.0;

  // TT: a fixed 32.184 s ahead of the stored TAI, no table needed.
  const secondsTt = time.secondsOfDay + TidalArguments.TT_MINUS_TAI_SECONDS;
  const t =
    (time.dayNumber - TidalArguments.J2000_DAY_NUMBER + secondsTt / 86400.0) /
    TidalArguments.DAYS_PER_JULIAN_CENTURY;

  const sDeg = evaluatePolynomial(MOON_MEAN_LONGITUDE, t);
  const elongationDeg = evaluatePolynomial(MOON_MEAN_ELONGATION, t);
  const sunAnomalyDeg = evaluatePolynomial(SUN_MEAN_ANOMALY, t);
  const moonAnomalyDeg = evaluatePolynomial(MOON_MEAN_ANOMALY, t);
  const nodeDeg = evaluatePolynomial(MOON_ASCENDING_NODE, t);

  const hDeg = sDeg - elongationDeg;
  const pDeg = sDeg - moonAnomalyDeg;
  const psDeg = hDeg - sunAnomalyDeg;

  // UT1 time of day. `secondsOfDay` runs from NOON of `dayNumber`, so the hour
  // angle of the mean sun reckoned from LOWER transit — which is what Doodson's
  // tau is built on — needs the half-turn added back. Negative values (an
  // instant within dAT of Julian-day start) wrap correctly through zeroToTwoPi.
  const ut1SecondsOfJulianDay =
    time.secondsOfDay - JulianDate.computeTaiMinusUtc(time) + dut1;
  const tauDeg = (15.0 * ut1SecondsOfJulianDay) / 3600.0 + 180.0 + hDeg - sDeg;

  /**
   * @param {number} deg An angle in degrees, unreduced.
   * @returns {number} The same angle in radians, reduced to [0, 2pi).
   */
  const toAngle = (deg) =>
    CesiumMath.zeroToTwoPi(deg * CesiumMath.RADIANS_PER_DEGREE);

  out.tau = toAngle(tauDeg);
  out.s = toAngle(sDeg);
  out.h = toAngle(hDeg);
  out.p = toAngle(pDeg);
  out.nPrime = toAngle(-nodeDeg);
  out.ps = toAngle(psDeg);
  out.node = toAngle(nodeDeg);
  d[0] = out.tau;
  d[1] = out.s;
  d[2] = out.h;
  d[3] = out.p;
  d[4] = out.nPrime;
  d[5] = out.ps;
  out.julianCenturiesTt = t;
  out.ut1MinusUtcSeconds = dut1;
  out.valid = true;
  return out;
};

/**
 * East longitude of the MEAN sub-lunar point, i.e. the meridian the equilibrium
 * M2 bulge rides. `= pi - tau`, because the mean Moon's Greenwich hour angle is
 * `tau - pi` and east longitude is the negated hour angle.
 *
 * This is the identity that makes ruling T6's "aligns with the position and
 * movement of the moon" checkable rather than rhetorical: the spec compares it
 * against `atan2(moon.y, moon.x)` of the Simon-1994 Moon in the fixed frame.
 * They agree to within the full lunar perturbation budget — equation of centre
 * 6.29 deg, evection 1.27 deg, variation 0.66 deg, plus the reduction to the
 * equator — whose measured worst case over 8.2 years of 3.6-hour samples is
 * 12.10 deg (2027-07-27), with a minimum of 0.0007 deg. That departure is
 * exactly the part N2/Q1 and the rest of the harmonic development supply.
 *
 * @param {object} args A filled {@link TidalArguments.createResult}.
 * @returns {number} East longitude in radians, [0, 2pi).
 */
TidalArguments.meanSubLunarLongitude = function (args) {
  if (!defined(args) || args.valid !== true) {
    return 0.0;
  }
  return CesiumMath.zeroToTwoPi(Math.PI - args.tau);
};

/**
 * Greenwich mean sidereal time implied by these arguments, `tau + s - pi`.
 *
 * Present as the independent cross-check it is: this engine computes GMST a
 * completely different way (the IAU-82 polynomial inside
 * `Transforms.computeTemeToPseudoFixedMatrix`), and the two agree to a constant
 * 0.0064 deg with no drift across 35 years. A time-base regression in this
 * module shows up there as a growing difference.
 *
 * @param {object} args A filled {@link TidalArguments.createResult}.
 * @returns {number} GMST in radians, [0, 2pi).
 */
TidalArguments.greenwichMeanSiderealTime = function (args) {
  if (!defined(args) || args.valid !== true) {
    return 0.0;
  }
  return CesiumMath.zeroToTwoPi(args.tau + args.s - Math.PI);
};

export default TidalArguments;
