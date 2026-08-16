// tidal-harmonics-model.mjs — published reference values and the pure analysis
// helpers behind `tidal-harmonics.spec.mjs`.
// @purpose Published NOAA/Schureman constituent speeds, Doodson fundamental rates and physics-free signal helpers anchoring the tidal-harmonics spec.
// @status ACTIVE
//
// Everything here is either (a) a number taken from a named external source, or
// (b) a signal-processing helper with no tide physics in it. The physics lives
// in `packages/engine/Source/Core/Tidal*.js` and `HarmonicTideModel.js`; if a
// helper here started doing physics the spec would be grading its own homework.

/**
 * Published constituent speeds in degrees per mean solar hour — NOAA CO-OPS
 * "Harmonic Constituents" table (https://tidesandcurrents.noaa.gov/, the same
 * table `Core/TideModel.js` already cites for M2). These are the external
 * anchor for the Doodson numbers AND for the mean-element polynomials, because
 * the engine assembles each speed from the polynomials' linear coefficients
 * rather than tabulating it.
 */
export const NOAA_SPEED_DEGREES_PER_HOUR = Object.freeze({
  M2: 28.984104,
  S2: 30.0,
  N2: 28.43973,
  K2: 30.082137,
  K1: 15.041069,
  O1: 13.943035,
  P1: 14.958931,
  Q1: 13.398661,
  Mf: 1.098033,
  Mm: 0.544375,
});

/**
 * Published rates of the six Doodson fundamental arguments, degrees per mean
 * solar hour. Standard values, reproduced in every harmonic-analysis reference
 * (Schureman 1958 Table 1; Pugh, *Tides, Surges and Mean Sea-Level*, 1987,
 * Table 4.1).
 */
export const FUNDAMENTAL_RATE_DEGREES_PER_HOUR = Object.freeze([
  14.49205211, // tau
  0.54901653, // s
  0.04106864, // h
  0.00464183, // p
  0.00220641, // N'
  0.00000196, // ps
]);

/**
 * Mean elements at J2000.0 TT, degrees. `s`, `p` and `node` are the constant
 * terms of Meeus's own polynomials so they are partly self-referential; `h` and
 * `ps` are DERIVED (h = s - D, ps = h - M) and are therefore genuine
 * cross-checks:
 *   h  280.4665 — mean longitude of the Sun at J2000, the constant term of the
 *                 classical L0 = 280.46646 + 36000.76983 T series (Meeus ch. 25).
 *   ps 282.9372 — longitude of solar perigee = Earth's perihelion longitude
 *                 102.9372 deg + 180 deg (standard J2000 orbital element).
 */
export const J2000_ARGUMENT_DEGREES = Object.freeze({
  s: 218.3165,
  h: 280.4665,
  p: 83.3532,
  node: 125.0445,
  ps: 282.9372,
});

/**
 * Lunar phase instants in April 2024, UTC, as published in standard almanacs.
 * The 2024-04-08 new moon is the total solar eclipse `eclipse-state.spec.mjs`
 * already pins this engine's Simon-1994 chain against, so it doubles as an
 * independent anchor on the ephemeris feeding the tide.
 */
export const APRIL_2024_PHASES = Object.freeze([
  { name: "lastQuarter", elongationDegrees: 270, iso: "2024-04-02T03:15:00Z" },
  { name: "new", elongationDegrees: 0, iso: "2024-04-08T18:21:00Z" },
  { name: "firstQuarter", elongationDegrees: 90, iso: "2024-04-15T19:13:00Z" },
  { name: "full", elongationDegrees: 180, iso: "2024-04-23T23:49:00Z" },
]);

/** Published tidal-cycle constants. */
export const PUBLISHED = Object.freeze({
  /** M2 half-period = mean interval between successive lunar high waters, h. */
  M2_PERIOD_HOURS: 360.0 / NOAA_SPEED_DEGREES_PER_HOUR.M2,
  /** Mean lunar day, h — twice the above. */
  MEAN_LUNAR_DAY_HOURS: 720.0 / NOAA_SPEED_DEGREES_PER_HOUR.M2,
  /** The "tides come ~50 minutes later each day" figure, minutes. */
  DAILY_LAG_MINUTES: (720.0 / NOAA_SPEED_DEGREES_PER_HOUR.M2 - 24.0) * 60.0,
  /** Mean synodic month, days. */
  SYNODIC_MONTH_DAYS: 29.530588,
  /** Nodal (regression of the lunar node) period, Julian years. */
  NODAL_PERIOD_YEARS: 18.6129,
  /**
   * Published bounds of the M2 nodal amplitude factor f. Schureman (1958);
   * quoted as 0.963-1.038 in every harmonic-analysis text.
   */
  M2_NODAL_FACTOR_MIN: 0.963,
  M2_NODAL_FACTOR_MAX: 1.038,
  /**
   * Classic ratios among the equilibrium amplitudes. S2/M2 is the solar/lunar
   * tidal ratio; the rest are the standard development coefficients.
   */
  RATIO_S2_M2: 0.465,
  RATIO_N2_M2: 0.191,
  RATIO_K2_S2: 0.272,
  RATIO_K1_O1: 1.409,
  RATIO_P1_K1: 0.331,
  RATIO_Q1_O1: 0.192,
});

/**
 * Tolerances, each with the reason it is what it is. A tolerance without a
 * reason is a number chosen to make a test pass.
 */
export const TOLERANCE = Object.freeze({
  /** Constituent speeds, deg/h. NOAA prints 6 decimals, so this is their last digit. */
  SPEED_DEGREES_PER_HOUR: 1.0e-6,
  /** Fundamental rates, deg/h — same reasoning at the published precision. */
  RATE_DEGREES_PER_HOUR: 1.0e-7,
  /**
   * J2000 mean elements, deg. The published values are quoted to 4 decimals, so
   * half a unit in the last place is 0.00005; 0.001 leaves room for the
   * mean-longitude definition differences (aberration, equinox of date) that
   * separate "the constant term of L0" from "h".
   */
  J2000_ARGUMENT_DEGREES: 0.001,
  /**
   * GMST agreement with this engine's own IAU-82 polynomial, deg. The two
   * differ by a CONSTANT 0.0064 deg (1.5 s of Earth rotation) from the equinox
   * definition; what must not happen is drift.
   */
  GMST_OFFSET_DEGREES: 0.01,
  /** Change in that offset across 35 years, deg. Zero drift is the real claim. */
  GMST_DRIFT_DEGREES: 1.0e-4,
  /**
   * Harmonic reconstruction vs the geometric ephemeris tide. 0.99 is set from
   * the measured 0.994-0.998; the gap is the truncation of the development at
   * ten constituents, and it is the honest ceiling of a ten-term expansion.
   */
  HARMONIC_CORRELATION_MIN: 0.99,
  /** ... and the demeaned residual, as a fraction of signal RMS. Measured 0.070-0.109. */
  HARMONIC_RESIDUAL_FRACTION_MAX: 0.15,
  /**
   * Geometric bulge longitude vs the ephemeris sub-lunar longitude, deg. The
   * geometric model puts them at the same place BY CONSTRUCTION, so anything
   * above the ring's own refinement noise means a frame or time-base defect.
   */
  GEOMETRIC_BULGE_DEGREES: 0.05,
  /**
   * Harmonic-lunar bulge vs the ephemeris sub-lunar longitude, deg. Measured
   * worst case 2.92 over 400 samples across 2026; the residual is the lunar
   * evection and variation, which four lunar constituents cannot carry.
   */
  HARMONIC_BULGE_DEGREES: 4.0,
  /** Antipodal bulge separation from 180 deg, deg. */
  ANTIPODAL_DEGREES: 0.05,
  /** Daily lag against the published 50.47 min. Measured 50.46-50.47. */
  DAILY_LAG_MINUTES: 0.5,
  /** Derived lunar phase instant vs the published almanac time, minutes. */
  PHASE_INSTANT_MINUTES: 20.0,
});

/** Degrees to radians. */
export const DEGREES_TO_RADIANS = Math.PI / 180.0;

/** Wrap to [0, 360). */
export function wrap360(degrees) {
  return ((degrees % 360.0) + 360.0) % 360.0;
}

/** Wrap to (-180, 180]. */
export function wrap180(degrees) {
  const w = wrap360(degrees);
  return w > 180.0 ? w - 360.0 : w;
}

/**
 * Interior local maxima and minima of a sampled series, with a parabolic
 * refinement of the extremum's position in samples.
 *
 * @param {number[]} values The series.
 * @returns {object[]} `{index, kind, offset}` where `offset` is the sub-sample
 *   refinement to add to `index`.
 */
export function extrema(values) {
  const out = [];
  for (let i = 1; i < values.length - 1; i++) {
    const a = values[i - 1];
    const b = values[i];
    const c = values[i + 1];
    const isMax = b > a && b >= c;
    const isMin = b < a && b <= c;
    if (!isMax && !isMin) {
      continue;
    }
    const denominator = a - 2.0 * b + c;
    out.push({
      index: i,
      kind: isMax ? "MAX" : "MIN",
      offset: denominator === 0 ? 0 : (0.5 * (a - c)) / denominator,
    });
  }
  return out;
}

/**
 * Times (in seconds from the series start) of the local maxima of a uniformly
 * sampled series.
 */
export function maximumTimes(values, dtSeconds) {
  return extrema(values)
    .filter((e) => e.kind === "MAX")
    .map((e) => (e.index + e.offset) * dtSeconds);
}

/**
 * Least-squares slope of `values` against their own index — for a series of
 * successive high-water times this IS the mean period, and it is the estimator
 * that makes the lunar-day lag a multi-day DRIFT measurement rather than a
 * single interval.
 */
export function leastSquaresSlope(values) {
  const n = values.length;
  if (n < 2) {
    return NaN;
  }
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += i;
    sy += values[i];
    sxx += i * i;
    sxy += i * values[i];
  }
  return (n * sxy - sx * sy) / (n * sxx - sx * sx);
}

/** Pearson correlation and demeaned RMS difference between two series. */
export function compareSeries(a, b) {
  const n = Math.min(a.length, b.length);
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  let residual = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    cov += x * y;
    va += x * x;
    vb += y * y;
    residual += (x - y) * (x - y);
  }
  const rmsA = Math.sqrt(va / n);
  const rms = Math.sqrt(residual / n);
  return {
    correlation: cov / Math.sqrt(va * vb),
    rms: rms,
    standardDeviation: rmsA,
    residualFraction: rms / rmsA,
  };
}

/**
 * Longitudes (degrees, [0, 360)) of the local maxima of a function sampled
 * around a full longitude circle. Circular, so a maximum straddling the seam is
 * still found; parabolically refined.
 */
export function ringMaximumLongitudes(sample, sampleCount) {
  const values = new Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    values[i] = sample((i * 360.0) / sampleCount);
  }
  const out = [];
  for (let i = 0; i < sampleCount; i++) {
    const a = values[(i - 1 + sampleCount) % sampleCount];
    const b = values[i];
    const c = values[(i + 1) % sampleCount];
    if (b > a && b >= c) {
      const denominator = a - 2.0 * b + c;
      const offset = denominator === 0 ? 0 : (0.5 * (a - c)) / denominator;
      out.push(wrap360(((i + offset) * 360.0) / sampleCount));
    }
  }
  return out;
}

/** Smallest angular distance from `target` to any longitude in `list`, degrees. */
export function nearestLongitudeError(list, target) {
  let best = Infinity;
  for (const value of list) {
    best = Math.min(best, Math.abs(wrap180(value - target)));
  }
  return best;
}

/** Daily min/max range of a sampled series over one 25-hour window. */
export function rangeOf(values) {
  let low = Infinity;
  let high = -Infinity;
  for (const v of values) {
    if (v < low) {
      low = v;
    }
    if (v > high) {
      high = v;
    }
  }
  return high - low;
}
