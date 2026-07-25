import CesiumMath from "./Math.js";
import TidalArguments from "./TidalArguments.js";
import defined from "./defined.js";

/**
 * TidalConstituents — the constituent table: Doodson numbers, angular speeds,
 * equilibrium amplitudes, species latitude factors and the 18.6-year nodal
 * corrections.
 *
 * This is the frequency basis shared by BOTH tide paths required by maintainer
 * ruling T5 (EOT20 by default, NOAA CO-OPS for US stations) and by the
 * dataset-free equilibrium fallback. A per-location atlas supplies only an
 * amplitude and a Greenwich phase lag per constituent; every angle — the
 * astronomical argument V, the nodal factor f and the nodal angle u — comes
 * from here and from {@link TidalArguments}, so all three data tiers are
 * phase-locked to the same scene clock and therefore inherit ruling T6.
 *
 * DOODSON NUMBERS. Each constituent's astronomical argument is
 *
 *     V = n1*tau + n2*s + n3*h + n4*p + n5*N' + n6*ps + phaseOffset
 *
 * with the six arguments from {@link TidalArguments}. `n1` is the SPECIES: 2 =
 * semidiurnal, 1 = diurnal, 0 = long period. The classic printed form adds 5 to
 * n2..n6 to keep the digits non-negative, so M2's `[2,0,0,0,0,0]` prints as
 * 255.555 — see {@link TidalConstituents.doodsonNumber}.
 *
 * The eight primary constituents (M2 S2 N2 K2 K1 O1 P1 Q1) are the set every
 * global atlas publishes and are the ones EOT20 is baked for; Mf and Mm are the
 * two cheap long-period terms, included because they cost two more table rows
 * and carry the fortnightly and monthly envelope.
 *
 * THE PHASE OFFSETS ARE NOT DECORATION. Expanding the degree-2 potential,
 * `P2(cos psi) = (3/4)cos^2(phi)cos^2(delta)cos(2H) + (3/4)sin(2phi)sin(2delta)cos(H)
 * + P2(sin phi)P2(sin delta)` with H the body's local hour angle. Since
 * `H = tau - pi + lambda`, the semidiurnal species picks up `cos(2tau + 2lambda)`
 * (the half-turn doubles to a full turn and vanishes) while the diurnal species
 * picks up `-cos(tau + lambda)`. Resolving that sign through the product-to-sum
 * expansion of `sin(2delta)cos(H)` puts K1 at +90 deg and O1/P1/Q1 at -90 deg.
 * Get them wrong and the semidiurnal band still looks perfect while every
 * diurnal contribution is INVERTED — the diurnal inequality flips to the wrong
 * side of the day and nothing about the M2 period reveals it. The spec catches
 * this by correlating against the geometric {@link TideModel} at off-equatorial
 * latitudes, where the diurnal band actually carries power.
 *
 * EQUILIBRIUM AMPLITUDES. `equilibriumAmplitudeM` is the classical geodetic
 * coefficient of each constituent in metres, BEFORE any Love-number scaling and
 * before the latitude factor — i.e. the amplitude at the latitude where that
 * species peaks. Values are the standard harmonic-development coefficients used
 * by the OSU/OTIS tide-model family and reproduced by pyTMD's constituent table
 * (Egbert & Erofeeva 2002; Cartwright & Tayler 1971; Cartwright & Edden 1973).
 * Their internal ratios are the classic textbook ones and are spec-pinned:
 * S2/M2 = 0.465 (the solar/lunar tidal ratio), N2/M2 = 0.191, K2/S2 = 0.272,
 * K1/O1 = 1.409, P1/K1 = 0.331, Q1/O1 = 0.192.
 *
 * NODAL CORRECTIONS (f and u). The Moon's ascending node regresses once every
 * 18.61 years, swinging the lunar orbit's inclination to the equator between
 * 18.3 and 28.6 deg. Constituents whose Doodson numbers do not already carry N'
 * absorb that as a slowly varying amplitude factor `f` and phase `u`. Dropping
 * them is not a rounding error: f(M2) alone runs 0.963 to 1.038, and the spec
 * measures that including them cuts the residual against the geometric tide from
 * about 13% of signal RMS to about 7%. The truncated series below are the
 * standard ones (Schureman, *Manual of Harmonic Analysis and Prediction of
 * Tides*, USC&GS Special Publication 98, 1958; reproduced in Pugh, *Tides,
 * Surges and Mean Sea-Level*, 1987, Table 4.3), written in the node longitude
 * Omega = -N'.
 *
 * WHAT THIS IS NOT. Equilibrium amplitudes describe the FORCING, not any real
 * coast: the ocean is a forced resonant basin whose response runs 1-16 m and
 * lags lunar transit by hours. That is precisely why the atlas path exists.
 *
 * f32 NOTE. Everything here is f64 CPU math. Nothing in this module has been
 * validated in f32, so a WGSL port cannot claim these tolerances — the
 * astronomical arguments alone reach 1e5 radians of accumulated angle before
 * wrapping, which f32 cannot carry. If the phase sum ever moves to a shader,
 * the arguments must be wrapped on the CPU and uploaded already reduced.
 *
 * @namespace TidalConstituents
 */
const TidalConstituents = {};

/** Semidiurnal species (n1 = 2). @type {number} */
TidalConstituents.SPECIES_SEMIDIURNAL = 2;
/** Diurnal species (n1 = 1). @type {number} */
TidalConstituents.SPECIES_DIURNAL = 1;
/** Long-period species (n1 = 0). @type {number} */
TidalConstituents.SPECIES_LONG_PERIOD = 0;

/** Constituent forced by the Moon alone. @type {string} */
TidalConstituents.ORIGIN_LUNAR = "LUNAR";
/** Constituent forced by the Sun alone. @type {string} */
TidalConstituents.ORIGIN_SOLAR = "SOLAR";
/**
 * Constituent both bodies force at the SAME frequency — the declinational terms
 * K1 and K2, where the Sun's contribution lands on the lunar argument because
 * the h's cancel out of the product-to-sum expansion.
 * @type {string}
 */
TidalConstituents.ORIGIN_LUNISOLAR = "LUNISOLAR";

// Lunar share of the two lunisolar constituents. Derived, not looked up: the
// declinational forcing of a body scales as (GM/d^3) * sin(I)cos(I) for the
// diurnal band and (GM/d^3) * sin^2(I) for the semidiurnal one, with I the
// orbit's inclination to the EQUATOR. Using this engine's own constants
// (GM_moon 4.9028e12, GM_sun 1.3271244e20, a_moon 384400 km, au, obliquity
// 23.4392911 deg, and the nodal-mean lunar <sin^2 I> = 0.16436 that
// TideModel derives for the permanent tide) the lunar share works out to 0.689
// for K1 and 0.693 for K2. `tidal-harmonics.spec.mjs` recomputes both from
// TideModel's constants and fails if they drift. They matter only for the
// lunar-subset used to check bulge alignment against the Moon; the full tide
// uses the whole constituent.
const K1_LUNAR_FRACTION = 0.689;
const K2_LUNAR_FRACTION = 0.693;

const DEG = CesiumMath.RADIANS_PER_DEGREE;

/**
 * Build one frozen constituent row, assembling its speed from the Doodson
 * numbers and {@link TidalArguments.RATES_DEGREES_PER_HOUR}.
 *
 * @param {string} id Short name, e.g. `"M2"`.
 * @param {number[]} doodson The six Doodson coefficients `[n1..n6]`.
 * @param {number} equilibriumAmplitudeM Classical equilibrium amplitude, metres.
 * @param {number} phaseOffsetDegrees Constant phase offset of the argument.
 * @param {string} nodalId Key into the nodal f/u series, or `"NONE"`.
 * @param {string} origin One of the `ORIGIN_*` constants.
 * @param {number} lunarFraction Share of the forcing that comes from the Moon.
 * @returns {object} The frozen constituent.
 * @private
 */
function makeConstituent(
  id,
  doodson,
  equilibriumAmplitudeM,
  phaseOffsetDegrees,
  nodalId,
  origin,
  lunarFraction,
) {
  const rates = TidalArguments.RATES_DEGREES_PER_HOUR;
  let speedDegreesPerHour = 0.0;
  for (let i = 0; i < 6; i++) {
    speedDegreesPerHour += doodson[i] * rates[i];
  }
  return Object.freeze({
    /** Short name, e.g. `"M2"`. @type {string} */
    id: id,
    /** The six Doodson coefficients `[n1..n6]`. @type {readonly number[]} */
    doodson: Object.freeze(doodson.slice()),
    /** Species, `= doodson[0]`. @type {number} */
    species: doodson[0],
    /**
     * Angular speed in degrees per mean solar hour, ASSEMBLED from the Doodson
     * numbers and {@link TidalArguments.RATES_DEGREES_PER_HOUR} rather than
     * tabulated — so the NOAA CO-OPS comparison in the spec tests the argument
     * polynomials, not a second copy of NOAA's own table.
     * @type {number}
     */
    speedDegreesPerHour: speedDegreesPerHour,
    /** Angular speed in radians per second. @type {number} */
    speedRadiansPerSecond: (speedDegreesPerHour * DEG) / 3600.0,
    /** Period in seconds. @type {number} */
    periodSeconds: (360.0 / speedDegreesPerHour) * 3600.0,
    /** Constant phase offset of the astronomical argument, radians. @type {number} */
    phaseOffsetRadians: phaseOffsetDegrees * DEG,
    /**
     * Classical equilibrium amplitude in metres, before the Love factor and
     * before the latitude factor.
     * @type {number}
     */
    equilibriumAmplitudeM: equilibriumAmplitudeM,
    /** Key into the nodal f/u series; `"NONE"` means f = 1, u = 0. @type {string} */
    nodalId: nodalId,
    /** One of the `ORIGIN_*` constants. @type {string} */
    origin: origin,
    /**
     * Fraction of this constituent's forcing that comes from the Moon: 1 for
     * lunar, 0 for solar, and the derived split for the two lunisolar ones.
     * @type {number}
     */
    lunarFraction: lunarFraction,
  });
}

const L = TidalConstituents.ORIGIN_LUNAR;
const S = TidalConstituents.ORIGIN_SOLAR;
const LS = TidalConstituents.ORIGIN_LUNISOLAR;

/** Principal lunar semidiurnal, 255.555, 12.4206 h. @type {object} */
TidalConstituents.M2 = makeConstituent(
  "M2",
  [2, 0, 0, 0, 0, 0],
  0.242334,
  0.0,
  "M2",
  L,
  1.0,
);
/** Principal solar semidiurnal, 273.555, exactly 12 h. @type {object} */
TidalConstituents.S2 = makeConstituent(
  "S2",
  [2, 2, -2, 0, 0, 0],
  0.112743,
  0.0,
  "NONE",
  S,
  0.0,
);
/** Larger lunar elliptic semidiurnal, 245.655. @type {object} */
TidalConstituents.N2 = makeConstituent(
  "N2",
  [2, -1, 0, 1, 0, 0],
  0.046398,
  0.0,
  "M2",
  L,
  1.0,
);
/** Lunisolar declinational semidiurnal, 275.555. @type {object} */
TidalConstituents.K2 = makeConstituent(
  "K2",
  [2, 2, 0, 0, 0, 0],
  0.030684,
  0.0,
  "K2",
  LS,
  K2_LUNAR_FRACTION,
);
/** Lunisolar declinational diurnal, 165.555. @type {object} */
TidalConstituents.K1 = makeConstituent(
  "K1",
  [1, 1, 0, 0, 0, 0],
  0.141565,
  90.0,
  "K1",
  LS,
  K1_LUNAR_FRACTION,
);
/** Principal lunar declinational diurnal, 145.555. @type {object} */
TidalConstituents.O1 = makeConstituent(
  "O1",
  [1, -1, 0, 0, 0, 0],
  0.100514,
  -90.0,
  "O1",
  L,
  1.0,
);
/** Principal solar declinational diurnal, 163.555. @type {object} */
TidalConstituents.P1 = makeConstituent(
  "P1",
  [1, 1, -2, 0, 0, 0],
  0.046843,
  -90.0,
  "NONE",
  S,
  0.0,
);
/** Larger lunar elliptic diurnal, 135.655. @type {object} */
TidalConstituents.Q1 = makeConstituent(
  "Q1",
  [1, -2, 0, 1, 0, 0],
  0.019256,
  -90.0,
  "O1",
  L,
  1.0,
);
/** Lunar fortnightly, 075.555, 13.66 d. @type {object} */
TidalConstituents.Mf = makeConstituent(
  "Mf",
  [0, 2, 0, 0, 0, 0],
  0.041742,
  0.0,
  "Mf",
  L,
  1.0,
);
/** Lunar monthly, 065.455, 27.55 d. @type {object} */
TidalConstituents.Mm = makeConstituent(
  "Mm",
  [0, 1, 0, -1, 0, 0],
  0.022191,
  0.0,
  "Mm",
  L,
  1.0,
);

/**
 * The eight primary constituents every global atlas publishes, in descending
 * equilibrium amplitude. This is the EOT20 bake set.
 * @type {readonly object[]}
 */
TidalConstituents.PRIMARY = Object.freeze([
  TidalConstituents.M2,
  TidalConstituents.K1,
  TidalConstituents.S2,
  TidalConstituents.O1,
  TidalConstituents.P1,
  TidalConstituents.N2,
  TidalConstituents.K2,
  TidalConstituents.Q1,
]);

/**
 * The eight primary constituents plus the two long-period ones.
 * @type {readonly object[]}
 */
TidalConstituents.ALL = Object.freeze([
  ...TidalConstituents.PRIMARY,
  TidalConstituents.Mf,
  TidalConstituents.Mm,
]);

// KEYED UPPERCASE, because the lookup upper-cases its argument. The canonical
// ids are mixed case ("Mf", "Mm"), so keying on `c.id` made those two
// unreachable through fromId under EVERY casing — and the only consumer that
// notices is TideConstituentGrid's constructor, which then throws
// DeveloperError (outside the debug pragmas, so in release too) on any atlas
// baked with `--all`. Every id must survive a round trip through fromId; the
// spec asserts that for all three casings of every entry in ALL.
const byId = new Map(TidalConstituents.ALL.map((c) => [c.id.toUpperCase(), c]));

/**
 * Look a constituent up by id, case-insensitively.
 *
 * @param {string} id e.g. `"M2"`, `"m2"`, `"mf"`.
 * @returns {object|undefined} The constituent, or `undefined` if unknown.
 */
TidalConstituents.fromId = function (id) {
  if (typeof id !== "string") {
    return undefined;
  }
  return byId.get(id.toUpperCase());
};

/**
 * The classic printed Doodson number, e.g. `"255.555"` for M2. The last five
 * digits carry a +5 offset so they stay non-negative; a coefficient outside
 * [-5, 4] would not be representable and is emitted as `"?"`.
 *
 * @param {object} constituent A constituent from this namespace.
 * @returns {string} The printed number.
 */
TidalConstituents.doodsonNumber = function (constituent) {
  if (!defined(constituent)) {
    return "";
  }
  const d = constituent.doodson;
  /**
   * @param {number} n A Doodson coefficient.
   * @returns {string} Its printed digit, or `"?"` when it will not fit.
   */
  const digit = (n) => {
    const v = n + 5;
    return v >= 0 && v <= 9 ? String(v) : "?";
  };
  return `${d[0]}${digit(d[1])}${digit(d[2])}.${digit(d[3])}${digit(d[4])}${digit(d[5])}`;
};

/**
 * The astronomical argument V of a constituent, WITHOUT the nodal angle u.
 *
 * @param {object} constituent A constituent from this namespace.
 * @param {object} args A filled {@link TidalArguments.createResult}.
 * @returns {number} V in radians, [0, 2pi). Zero for degenerate inputs.
 */
TidalConstituents.astronomicalArgument = function (constituent, args) {
  if (!defined(constituent) || !defined(args) || args.valid !== true) {
    return 0.0;
  }
  const n = constituent.doodson;
  const a = args.doodson;
  let v = constituent.phaseOffsetRadians;
  for (let i = 0; i < 6; i++) {
    v += n[i] * a[i];
  }
  return CesiumMath.zeroToTwoPi(v);
};

/**
 * Nodal f/u series, written in the node longitude Omega. `f` is dimensionless;
 * `u` is converted to RADIANS from the published degree series.
 *
 * @param {string} nodalId The series key, or `"NONE"` for f = 1, u = 0.
 * @param {number} node Omega in radians.
 * @param {object} result A {@link TidalConstituents.createNodalResult} to fill.
 * @returns {object} `result`, mutated in place.
 * @private
 */
function nodalInto(nodalId, node, result) {
  const c1 = Math.cos(node);
  const s1 = Math.sin(node);
  const c2 = Math.cos(2.0 * node);
  const s2 = Math.sin(2.0 * node);
  const c3 = Math.cos(3.0 * node);
  const s3 = Math.sin(3.0 * node);
  let f = 1.0;
  let uDegrees = 0.0;
  switch (nodalId) {
    case "M2":
      // Also carries N2 and every other constituent built on the M2 elliptic
      // family. Range 0.963 (Omega = 0) to 1.038 (Omega = 180 deg).
      f = 1.0004 - 0.0373 * c1 + 0.0002 * c2;
      uDegrees = -2.14 * s1;
      break;
    case "K2":
      f = 1.0241 + 0.2863 * c1 + 0.0083 * c2 - 0.0015 * c3;
      uDegrees = -17.74 * s1 + 0.68 * s2 - 0.04 * s3;
      break;
    case "K1":
      f = 1.006 + 0.115 * c1 - 0.0088 * c2 + 0.0006 * c3;
      uDegrees = -8.86 * s1 + 0.68 * s2 - 0.07 * s3;
      break;
    case "O1":
      // Q1 shares the O1 series.
      f = 1.0089 + 0.1871 * c1 - 0.0147 * c2 + 0.0014 * c3;
      uDegrees = 10.8 * s1 - 1.34 * s2 + 0.19 * s3;
      break;
    case "Mf":
      f = 1.0429 + 0.4135 * c1 - 0.004 * c2;
      uDegrees = -23.74 * s1 + 2.68 * s2 - 0.38 * s3;
      break;
    case "Mm":
      f = 1.0 - 0.013 * c1 + 0.0008 * c2;
      uDegrees = 0.0;
      break;
    default:
      // S2 and P1 are purely solar: the lunar node does not modulate them.
      break;
  }
  result.f = f;
  result.u = uDegrees * DEG;
  return result;
}

/**
 * Allocate a result object for {@link TidalConstituents.nodalCorrection}.
 *
 * @returns {object} `{f, u}` with `f` dimensionless and `u` in radians.
 */
TidalConstituents.createNodalResult = function () {
  return { f: 1.0, u: 0.0 };
};

/**
 * The nodal amplitude factor f and phase angle u of a constituent.
 *
 * @param {object} constituent A constituent from this namespace.
 * @param {number} node The ascending-node longitude Omega in radians — the
 *   `node` field of a filled {@link TidalArguments.createResult}, NOT `nPrime`.
 * @param {object} [result] A {@link TidalConstituents.createNodalResult} to fill.
 * @returns {object} `result` (or a fresh object), mutated in place.
 */
TidalConstituents.nodalCorrection = function (constituent, node, result) {
  const out = result ?? TidalConstituents.createNodalResult();
  out.f = 1.0;
  out.u = 0.0;
  if (!defined(constituent) || !isFinite(node)) {
    return out;
  }
  return nodalInto(constituent.nodalId, node, out);
};

/**
 * The latitude factor of a species, for the EQUILIBRIUM form only. An atlas
 * amplitude already contains the latitude dependence and must not be scaled by
 * this.
 *
 * `cos^2(phi)` semidiurnal (peaks at the equator), `sin(2 phi)` diurnal (peaks
 * at 45 deg and CHANGES SIGN across the equator, which is what puts the diurnal
 * inequality on opposite sides of the day in the two hemispheres), and
 * `(1 - 3 sin^2 phi) / 2` long period (+1/2 at the equator, zero at 35.26 deg,
 * -1 at either pole).
 *
 * The long-period factor is MINUS `P2(sin phi)`. That sign convention is the
 * one that makes the reconstruction agree with the geometric {@link TideModel};
 * it lives here so the amplitude table can stay positive. It was determined by
 * measurement, not preference — flipping it drops the correlation against the
 * geometric tide from 0.997 to 0.971 at the equator and 0.996 to 0.913 at 62
 * deg — and the spec re-measures the resulting factor at four latitudes.
 *
 * @param {number} species One of the `SPECIES_*` constants.
 * @param {number} geocentricLatitude GEOCENTRIC latitude in radians. The
 *   degree-2 expansion is written in geocentric latitude; using geodetic
 *   latitude instead biases the factor by up to 0.2 deg of latitude.
 * @returns {number} The dimensionless factor.
 */
TidalConstituents.speciesFactor = function (species, geocentricLatitude) {
  if (!isFinite(geocentricLatitude)) {
    return 0.0;
  }
  const sinLatitude = Math.sin(geocentricLatitude);
  if (species === TidalConstituents.SPECIES_SEMIDIURNAL) {
    const cosLatitude = Math.cos(geocentricLatitude);
    return cosLatitude * cosLatitude;
  }
  if (species === TidalConstituents.SPECIES_DIURNAL) {
    return Math.sin(2.0 * geocentricLatitude);
  }
  return (1.0 - 3.0 * sinLatitude * sinLatitude) * 0.5;
};

export default TidalConstituents;
