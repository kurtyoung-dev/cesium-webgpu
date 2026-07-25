import Cartesian3 from "./Cartesian3.js";
import CesiumMath from "./Math.js";
import defined from "./defined.js";
import JulianDate from "./JulianDate.js";
import Matrix3 from "./Matrix3.js";
import Simon1994PlanetaryPositions from "./Simon1994PlanetaryPositions.js";
import Transforms from "./Transforms.js";

/**
 * TideModel — the equilibrium (static) ocean tide, evaluated from the engine's
 * own lunar and solar ephemerides at the scene clock.
 *
 * Ratified by maintainer ruling **T1** (`migration_doc/TIDES_FEASIBILITY_2026-07-24.md`
 * §5a): the equilibrium model lands in Core as an engine feature; REGIONAL
 * PREDICTION (harmonic atlases, station APIs) stays out of the engine. Ruling
 * **T6** additionally requires that tide timing be phase-locked to the scene
 * clock and the real Simon-1994 ephemerides — which is why nothing here uses
 * wall time, a synthetic sinusoid, or a fitted period.
 *
 * WHAT IT IS. The equilibrium tide is the ocean surface that would exist if
 * water responded instantly and frictionlessly to the tide-generating
 * potential. For a body of gravitational parameter GM at geocentric distance
 * d, seen from a site at geocentric radius r and geocentric zenith angle psi,
 * the degree-2 tide-generating potential is
 *
 *     V2 = (GM / d) * (r / d)^2 * P2(cos psi),     P2(x) = (3x^2 - 1) / 2
 *
 * and the equilibrium surface displacement is V2 / g. Summed over Moon and
 * Sun and scaled by the Love-number diminishing factor:
 *
 *     zeta = GAMMA2 * sum_b [ (GM_b / g) * (r^2 / d_b^3) * P2(cos psi_b) ]
 *
 * With GM_moon this gives +0.357 m under the Moon and -0.179 m at 90 degrees
 * from it before the Love factor; the solar term is 0.46x the lunar one. The
 * whole signal is +-0.3 m — the "false-hope guard" of the feasibility report.
 * Everything qualitative about real tides falls out of the geometry: the
 * 12 h 25 m semidiurnal beat, the spring/neap envelope, and the diurnal
 * inequality that follows lunar declination.
 *
 * WHICH QUANTITY, AND WHY. Three different tides can be written from the same
 * potential and they differ by a factor of ~2:
 *
 *   - geocentric equilibrium sea surface:      (1 + k2) * zeta_raw
 *   - solid-Earth (sea floor / crust) uplift:  h2 * zeta_raw
 *   - water level RELATIVE TO THE CRUST:       (1 + k2 - h2) * zeta_raw
 *
 * A tide gauge — and a viewer watching the waterline move against a cliff —
 * measures the third, and this engine's terrain mesh carries no TIME-VARYING
 * solid-Earth tide, so for everything that moves the terrain IS the unmoving
 * crust and GAMMA2 = 1 + k2 - h2 is the honest factor.
 *
 * PERMANENT TIDE — THE ONE PART GAMMA2 GETS WRONG. The zero-frequency part of
 * P2 does not average away: over a nodal cycle the Moon and Sun leave a
 * constant, latitude-dependent deformation. h2 must NOT be subtracted from it,
 * because the real crust already carries its permanent deformation and the
 * terrain mesh is a survey OF that real crust — the mesh is not "missing" the
 * permanent uplift the way it is missing the time-varying one. Meanwhile
 * EGM2008 (the geoid this engine's datum term uses) is published TIDE-FREE, so
 * the permanent geoid rise (1 + k2) * zeta_bar has been removed from N and does
 * belong in the tide term. Splitting on that basis:
 *
 *     water = N_tidefree + (1 + k2) * zeta_bar + GAMMA2 * (zeta - zeta_bar)
 *           = N_tidefree + GAMMA2 * zeta + h2 * zeta_bar
 *
 * so the correction to the naive GAMMA2 * zeta is exactly h2 * zeta_bar:
 * +0.060 m at the equator, -0.120 m at the poles. Sub-noise against the 0.5 m
 * geoid grid today, but the claim has to be true.
 *
 * DERIVING zeta_bar (closed form in latitude). By the addition theorem the
 * hour-angle average of the degree-2 kernel separates exactly:
 *
 *     <P2(cos psi)>_H = P2(sin phi) * <P2(sin delta)>
 *
 * (verified directly: <cos^2 psi>_H = sin^2 phi sin^2 delta +
 *  cos^2 phi cos^2 delta / 2 reduces to the product form). For a body moving
 * uniformly in a plane inclined I to the equator, <sin^2 delta> = <sin^2 I> / 2,
 * so <P2(sin delta)> = (1.5 * <sin^2 I> - 1) / 2. For the Sun I is the
 * obliquity; for the Moon the inclination to the EQUATOR swings 18.3-28.6 deg
 * over the 18.6-year nodal cycle, whose average is
 *
 *     <cos^2 I_moon> = cos^2 eps cos^2 i + sin^2 eps sin^2 i / 2
 *
 * from cos I = cos eps cos i - sin eps sin i cos Omega averaged over Omega.
 * With <d^-3> = a^-3 (1 - e^2)^(-3/2),
 *
 *     zeta_bar(phi, r) = PERMANENT_TIDE_COEFFICIENT * r^2 * P2(sin phi)
 *
 * which evaluates to -0.1978 m * P2(sin phi) at r = 6371 km — the classic
 * -0.198 m permanent-tide coefficient (Melchior, "The Tides of the Planet
 * Earth", 2nd ed. 1983; Ekman, M. (1989), "Impacts of geodynamic phenomena on
 * systems for height and gravity", Bull. Geod. 63:281-296; IERS Conventions
 * (2010) §7.1.1 on the tide-free / mean-tide conventions).
 *
 * WHAT IT IS NOT. It is not a prediction. The real ocean is a forced,
 * resonant, friction-damped basin: observed coastal ranges run 1-16 m and lag
 * lunar transit by the station's "high water lunitidal interval" (hours). The
 * equilibrium tide has, by construction, ZERO lag and no basin amplification.
 * Its PERIODS and its spring/neap ENVELOPE match reality; its amplitude and
 * absolute phase at any given coast do not. Use `tideExaggeration` for a
 * stylised amplitude and label it as stylised.
 *
 * OMITTED. Degree-3 (about 1.7% of degree 2 for the Moon), ocean loading and
 * self-attraction, and the frequency dependence of the Love numbers.
 *
 * CONSTANTS AND THEIR SOURCES
 *   GM_MOON  4.902800076e12 m^3/s^2   JPL DE421 lunar GM. (DE430 gives
 *                                     4.902800066e12 — a 2e-9 relative
 *                                     difference with no functional effect
 *                                     here; the value and the citation are
 *                                     kept in agreement deliberately.)
 *   GM_SUN   1.32712440041e20 m^3/s^2 JPL DE430 heliocentric gravitational constant
 *   g        9.80665 m/s^2            standard gravity, CGPM 3rd (1901) / ISO 80000-3
 *   h2       0.6078                   IERS Conventions (2010) §7.1.1 nominal degree-2
 *   k2       0.3022                   IERS Conventions (2010) §7.1.1 nominal degree-2
 *   M2 speed 28.984104 deg/hour       NOAA CO-OPS harmonic constituent table
 *                                     (principal lunar semidiurnal; period 12.4206 h)
 *   a_moon   384400000 m              mean Earth-Moon distance (IAU/JPL)
 *   au       149597870700 m           IAU 2012 Resolution B2 (exact, by definition)
 *   e_moon   0.0549                   mean lunar orbital eccentricity
 *   e_earth  0.016708634              Earth orbital eccentricity at J2000
 *   eps      23.4392911 deg           mean obliquity at J2000 (IAU 2006)
 *   i_moon   5.145 deg                lunar orbit inclination to the ecliptic
 *
 * @namespace TideModel
 */
const TideModel = {};

/** Moon gravitational parameter, m^3/s^2 (JPL DE421). @type {number} */
TideModel.GM_MOON = 4.902800076e12;
/** Sun gravitational parameter, m^3/s^2 (JPL DE430). @type {number} */
TideModel.GM_SUN = 1.32712440041e20;
/** Standard gravity, m/s^2 (CGPM 1901 / ISO 80000-3). @type {number} */
TideModel.STANDARD_GRAVITY = 9.80665;
/** Degree-2 vertical displacement Love number (IERS 2010). @type {number} */
TideModel.LOVE_H2 = 0.6078;
/** Degree-2 potential Love number (IERS 2010). @type {number} */
TideModel.LOVE_K2 = 0.3022;
/**
 * Diminishing factor 1 + k2 - h2 taking the raw equilibrium tide to the water
 * level relative to the (unmoving) crust — the tide-gauge quantity.
 * @type {number}
 */
TideModel.DIMINISHING_FACTOR = 1.0 + TideModel.LOVE_K2 - TideModel.LOVE_H2;
/**
 * Speed of the M2 (principal lunar semidiurnal) constituent in degrees per
 * mean solar hour — NOAA CO-OPS harmonic constituent table. The dominant
 * period of the equilibrium tide at low latitudes must equal 360 / this.
 * @type {number}
 */
TideModel.M2_SPEED_DEGREES_PER_HOUR = 28.984104;
/** M2 period in seconds, derived from {@link TideModel.M2_SPEED_DEGREES_PER_HOUR}. @type {number} */
TideModel.M2_PERIOD_SECONDS =
  (360.0 / TideModel.M2_SPEED_DEGREES_PER_HOUR) * 3600.0;

// ── Permanent (zero-frequency) tide constants ────────────────────────────
/** Mean Earth-Moon distance, metres (IAU/JPL). @type {number} */
TideModel.MEAN_LUNAR_DISTANCE = 384400000.0;
/** Astronomical unit, metres — IAU 2012 Resolution B2, exact by definition. @type {number} */
TideModel.ASTRONOMICAL_UNIT = 149597870700.0;
/** Mean lunar orbital eccentricity. @type {number} */
TideModel.LUNAR_ECCENTRICITY = 0.0549;
/** Earth orbital eccentricity at J2000. @type {number} */
TideModel.SOLAR_ECCENTRICITY = 0.016708634;
/** Mean obliquity of the ecliptic at J2000, radians (IAU 2006, 23d 26' 21.406"). @type {number} */
TideModel.OBLIQUITY = 23.4392911 * CesiumMath.RADIANS_PER_DEGREE;
/** Lunar orbit inclination to the ecliptic, radians. @type {number} */
TideModel.LUNAR_ORBIT_INCLINATION = 5.145 * CesiumMath.RADIANS_PER_DEGREE;

/**
 * Time-averaged P2(sin declination) for a body whose apparent orbit is
 * inclined to the equator with mean-square sine `meanSinSquaredInclination`.
 * <sin^2 delta> = <sin^2 I> / 2 for uniform motion in the orbit plane.
 *
 * @param {number} meanSinSquaredInclination <sin^2 I>.
 * @returns {number} <P2(sin delta)>, dimensionless.
 * @private
 */
function meanDeclinationLegendre(meanSinSquaredInclination) {
  return (1.5 * meanSinSquaredInclination - 1.0) * 0.5;
}

const sinSquaredObliquity = Math.sin(TideModel.OBLIQUITY) ** 2;
const cosSquaredObliquity = Math.cos(TideModel.OBLIQUITY) ** 2;
const sinSquaredLunarInclination =
  Math.sin(TideModel.LUNAR_ORBIT_INCLINATION) ** 2;
const cosSquaredLunarInclination =
  Math.cos(TideModel.LUNAR_ORBIT_INCLINATION) ** 2;

/**
 * <P2(sin delta)> for the Sun — its apparent orbit is inclined at the fixed
 * obliquity, so <sin^2 I> is simply sin^2(eps). Value: -0.38133.
 * @type {number}
 */
TideModel.MEAN_SOLAR_DECLINATION_LEGENDRE =
  meanDeclinationLegendre(sinSquaredObliquity);

/**
 * <P2(sin delta)> for the Moon, averaged over the 18.6-year nodal cycle. From
 * cos I = cos(eps)cos(i) - sin(eps)sin(i)cos(Omega) with Omega uniform,
 * <cos^2 I> = cos^2(eps)cos^2(i) + sin^2(eps)sin^2(i)/2. Value: -0.37673.
 * @type {number}
 */
TideModel.MEAN_LUNAR_DECLINATION_LEGENDRE = meanDeclinationLegendre(
  1.0 -
    (cosSquaredObliquity * cosSquaredLunarInclination +
      0.5 * sinSquaredObliquity * sinSquaredLunarInclination),
);

// <d^-3> = a^-3 (1 - e^2)^(-3/2) for a Keplerian orbit averaged over time.
const lunarInverseCubeDistance =
  Math.pow(1.0 - TideModel.LUNAR_ECCENTRICITY ** 2, -1.5) /
  TideModel.MEAN_LUNAR_DISTANCE ** 3;
const solarInverseCubeDistance =
  Math.pow(1.0 - TideModel.SOLAR_ECCENTRICITY ** 2, -1.5) /
  TideModel.ASTRONOMICAL_UNIT ** 3;

/**
 * Permanent (zero-frequency) equilibrium tide per unit r^2, in m^-1, such that
 * `zeta_bar = PERMANENT_TIDE_COEFFICIENT * r^2 * P2(sin phi)`. Derived from
 * this module's own constants — see the header for the addition-theorem
 * derivation. Approximately -4.873e-15 m^-1, i.e. -0.1978 m at r = 6371 km,
 * which is the classic -0.198 m permanent-tide coefficient.
 * @type {number}
 */
TideModel.PERMANENT_TIDE_COEFFICIENT =
  (TideModel.GM_MOON *
    lunarInverseCubeDistance *
    TideModel.MEAN_LUNAR_DECLINATION_LEGENDRE +
    TideModel.GM_SUN *
      solarInverseCubeDistance *
      TideModel.MEAN_SOLAR_DECLINATION_LEGENDRE) /
  TideModel.STANDARD_GRAVITY;

const icrfToFixedScratch = new Matrix3();
const moonScratch = new Cartesian3();
const sunScratch = new Cartesian3();

// Return shape for the rotation-branch helper. Module-level so the ephemeris
// path stays allocation-free.
const branchResult = {
  matrix: undefined,
  usedIcrf: false,
};

/**
 * ICRF->fixed rotation WITH the branch reported.
 *
 * `Transforms.computeIcrfToCentralBodyFixedMatrix` hides the fact that it
 * silently falls back to the TEME pseudo-fixed rotation while the IAU2006 XYS
 * data is still loading. The two disagree by ~0.3-0.4 degrees of Earth
 * rotation in 2026, which is ~1.4 minutes of tide phase — small, but it must
 * not be FROZEN into a memo under a pinned clock (every probe, and any paused
 * scene). Reporting the branch lets the memo key on it, exactly as
 * `Scene/EclipseState.js` does for the lunar disc.
 *
 * @param {JulianDate} time The time.
 * @param {Matrix3} result The matrix to store into.
 * @returns {object} The shared `{matrix, usedIcrf}` — read it immediately.
 * @private
 */
function computeIcrfToFixedBranch(time, result) {
  const icrf = Transforms.computeIcrfToFixedMatrix(time, result);
  if (defined(icrf)) {
    branchResult.matrix = icrf;
    branchResult.usedIcrf = true;
  } else {
    branchResult.matrix = Transforms.computeTemeToPseudoFixedMatrix(
      time,
      result,
    );
    branchResult.usedIcrf = false;
  }
  return branchResult;
}

// Frame-time memo for BOTH bodies. A scene evaluates the tide once per ocean
// primitive per frame, but multi-view scenes and the acceptance probe hit the
// same instant repeatedly; the Simon1994 series plus the ICRF rotation is the
// only non-trivial cost in this module. `usedIcrf` is PART OF THE KEY for the
// reason given on `computeIcrfToFixedBranch`.
const ephemerisMemo = {
  time: new JulianDate(),
  hasTime: false,
  usedIcrf: false,
  moon: new Cartesian3(),
  sun: new Cartesian3(),
};

function refreshEphemeris(time) {
  Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(
    time,
    ephemerisMemo.moon,
  );
  Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
    time,
    ephemerisMemo.sun,
  );
  const branch = computeIcrfToFixedBranch(time, icrfToFixedScratch);
  Matrix3.multiplyByVector(
    branch.matrix,
    ephemerisMemo.moon,
    ephemerisMemo.moon,
  );
  Matrix3.multiplyByVector(branch.matrix, ephemerisMemo.sun, ephemerisMemo.sun);
  ephemerisMemo.usedIcrf = branch.usedIcrf;
  JulianDate.clone(time, ephemerisMemo.time);
  ephemerisMemo.hasTime = true;
}

/**
 * Ensure the memo holds the Moon and Sun in the Earth-centred FIXED frame at
 * `time`. A hit built from the TEME fallback is re-probed (XYS availability is
 * monotone, so the probe is a cheap `undefined` until the data lands, then the
 * memo rebuilds exactly once); a hit built from true ICRF is reused
 * unconditionally, since for a fixed time that rotation is deterministic.
 *
 * @param {JulianDate} time The simulation time.
 * @private
 */
function ensureEphemeris(time) {
  if (ephemerisMemo.hasTime && JulianDate.equals(ephemerisMemo.time, time)) {
    if (
      ephemerisMemo.usedIcrf ||
      !defined(Transforms.computeIcrfToFixedMatrix(time, icrfToFixedScratch))
    ) {
      return;
    }
  }
  refreshEphemeris(time);
}

/**
 * Moon position in the Earth-centred FIXED frame (ECEF metres).
 *
 * @param {JulianDate} time The simulation time.
 * @param {Cartesian3} result The object onto which to store the result.
 * @returns {Cartesian3} The modified result parameter.
 */
TideModel.computeMoonPositionFixed = function (time, result) {
  ensureEphemeris(time);
  return Cartesian3.clone(ephemerisMemo.moon, result ?? new Cartesian3());
};

/**
 * Sun position in the Earth-centred FIXED frame (ECEF metres).
 *
 * @param {JulianDate} time The simulation time.
 * @param {Cartesian3} result The object onto which to store the result.
 * @returns {Cartesian3} The modified result parameter.
 */
TideModel.computeSunPositionFixed = function (time, result) {
  ensureEphemeris(time);
  return Cartesian3.clone(ephemerisMemo.sun, result ?? new Cartesian3());
};

/**
 * Per-body equilibrium term.
 *
 * @param {number} gm Gravitational parameter of the body, m^3/s^2.
 * @param {Cartesian3} bodyFixed Body position, ECEF metres.
 * @param {Cartesian3} siteFixed Site position, ECEF metres.
 * @param {number} siteRadius |siteFixed|.
 * @returns {number} Raw (pre-Love) equilibrium height in metres, or 0 when the
 *   geometry is degenerate.
 * @private
 */
function bodyTerm(gm, bodyFixed, siteFixed, siteRadius) {
  const d = Cartesian3.magnitude(bodyFixed);
  if (!(d > 0.0)) {
    return 0.0;
  }
  let cosPsi = Cartesian3.dot(bodyFixed, siteFixed) / (d * siteRadius);
  if (cosPsi > 1.0) {
    cosPsi = 1.0;
  } else if (cosPsi < -1.0) {
    cosPsi = -1.0;
  }
  const legendre = (3.0 * cosPsi * cosPsi - 1.0) * 0.5;
  return (
    (((gm / TideModel.STANDARD_GRAVITY) * (siteRadius * siteRadius)) /
      (d * d * d)) *
    legendre
  );
}

/**
 * The permanent (zero-frequency) equilibrium tide at a site, RAW — before any
 * Love-number scaling. `zeta_bar = PERMANENT_TIDE_COEFFICIENT * r^2 * P2(sin phi)`
 * with `phi` the GEOCENTRIC latitude, which is what the degree-2 expansion is
 * written in and what `cos psi` is computed from elsewhere in this module.
 *
 * Time-independent by construction: it is the nodal-cycle average of the
 * degree-2 kernel, not a snapshot. See the module header for the derivation and
 * for why it is scaled by (1 + k2) rather than by GAMMA2.
 *
 * @param {Cartesian3} positionWC Site position, ECEF metres.
 * @returns {number} Metres. Exactly 0 for a degenerate position.
 */
TideModel.permanentTideHeight = function (positionWC) {
  if (!defined(positionWC)) {
    return 0.0;
  }
  const r = Cartesian3.magnitude(positionWC);
  if (!(r > 0.0)) {
    return 0.0;
  }
  const sinLatitude = positionWC.z / r;
  return (
    TideModel.PERMANENT_TIDE_COEFFICIENT *
    r *
    r *
    ((3.0 * sinLatitude * sinLatitude - 1.0) * 0.5)
  );
};

/**
 * Allocate a result object for {@link TideModel.evaluate}. A caller on the
 * per-frame path holds one for its lifetime.
 *
 * @returns {object} The result object.
 */
TideModel.createResult = function () {
  return {
    /**
     * Total water level, metres — `lunarM + solarM + permanentM`.
     */
    heightM: 0.0,
    /** Lunar contribution, metres, scaled by GAMMA2. */
    lunarM: 0.0,
    /** Solar contribution, metres, scaled by GAMMA2. */
    solarM: 0.0,
    /**
     * The permanent tide before Love scaling (`zeta_bar`), metres. Constant in
     * time; a function of geocentric latitude and radius only.
     */
    permanentRawM: 0.0,
    /**
     * Permanent-tide CORRECTION actually added, `h2 * zeta_bar`, metres. This
     * is the difference between the correct `(1+k2)*zeta_bar + GAMMA2*(zeta -
     * zeta_bar)` and the naive `GAMMA2 * zeta`; +0.060 m at the equator,
     * -0.120 m at the poles.
     */
    permanentM: 0.0,
    /** cos of the Moon's geocentric zenith angle at the site. */
    moonZenithCosine: 0.0,
    /** cos of the Sun's geocentric zenith angle at the site. */
    sunZenithCosine: 0.0,
    /** Geocentric Moon distance, metres. */
    moonDistanceM: 0.0,
    /** Geocentric Sun distance, metres. */
    sunDistanceM: 0.0,
    /** Geocentric site radius, metres. */
    siteRadiusM: 0.0,
    /** True when the true ICRF rotation was used (false = TEME fallback). */
    usedIcrf: false,
    /** False when the inputs were degenerate; `heightM` is then exactly 0. */
    valid: false,
  };
};

/**
 * Evaluate the equilibrium tide at a site, with diagnostics.
 *
 * @param {JulianDate} time The simulation time. The tide is a pure function of
 *   this and the site — nothing reads wall time.
 * @param {Cartesian3} positionWC The site position in the Earth-centred FIXED
 *   frame (ECEF metres). Only its direction and magnitude are used, so a point
 *   at the sea surface, on the ellipsoid, or a few hundred metres up all give
 *   the same answer to within 1e-5 m.
 * @param {object} [result] A {@link TideModel.createResult} object to fill.
 * @returns {object} `result` (or a fresh object), mutated in place.
 */
TideModel.evaluate = function (time, positionWC, result) {
  const out = result ?? TideModel.createResult();
  out.heightM = 0.0;
  out.lunarM = 0.0;
  out.solarM = 0.0;
  out.permanentRawM = 0.0;
  out.permanentM = 0.0;
  out.moonZenithCosine = 0.0;
  out.sunZenithCosine = 0.0;
  out.moonDistanceM = 0.0;
  out.sunDistanceM = 0.0;
  out.siteRadiusM = 0.0;
  out.valid = false;

  if (!defined(time) || !defined(positionWC)) {
    return out;
  }
  const r = Cartesian3.magnitude(positionWC);
  if (!(r > 0.0)) {
    return out;
  }

  ensureEphemeris(time);
  const moon = Cartesian3.clone(ephemerisMemo.moon, moonScratch);
  const sun = Cartesian3.clone(ephemerisMemo.sun, sunScratch);

  const gamma = TideModel.DIMINISHING_FACTOR;
  const lunar = gamma * bodyTerm(TideModel.GM_MOON, moon, positionWC, r);
  const solar = gamma * bodyTerm(TideModel.GM_SUN, sun, positionWC, r);

  // Permanent-tide correction. The full expression is
  //   (1 + k2) * zeta_bar + GAMMA2 * (zeta - zeta_bar)
  // which rearranges to GAMMA2 * zeta + h2 * zeta_bar, i.e. the GAMMA2-scaled
  // body terms above plus this one additive term. h2 is NOT subtracted from the
  // permanent part because the real crust already carries its permanent
  // deformation and the terrain mesh is a survey of the real crust; the
  // tide-free geoid, by contrast, has had (1 + k2) * zeta_bar removed from it.
  const permanentRaw = TideModel.permanentTideHeight(positionWC);
  const permanent = TideModel.LOVE_H2 * permanentRaw;

  const dMoon = Cartesian3.magnitude(moon);
  const dSun = Cartesian3.magnitude(sun);
  out.lunarM = lunar;
  out.solarM = solar;
  out.permanentRawM = permanentRaw;
  out.permanentM = permanent;
  out.heightM = lunar + solar + permanent;
  out.moonDistanceM = dMoon;
  out.sunDistanceM = dSun;
  out.moonZenithCosine =
    dMoon > 0.0 ? Cartesian3.dot(moon, positionWC) / (dMoon * r) : 0.0;
  out.sunZenithCosine =
    dSun > 0.0 ? Cartesian3.dot(sun, positionWC) / (dSun * r) : 0.0;
  out.siteRadiusM = r;
  out.usedIcrf = ephemerisMemo.usedIcrf;
  out.valid = true;
  return out;
};

const scratchResult = TideModel.createResult();

/**
 * Equilibrium tide height at a site, in metres of water level relative to the
 * crust. Positive is a higher sea surface.
 *
 * @param {JulianDate} time The simulation time.
 * @param {Cartesian3} positionWC The site position, ECEF metres.
 * @returns {number} Metres. Exactly 0 when the inputs are degenerate.
 */
TideModel.equilibriumHeight = function (time, positionWC) {
  return TideModel.evaluate(time, positionWC, scratchResult).heightM;
};

export default TideModel;
