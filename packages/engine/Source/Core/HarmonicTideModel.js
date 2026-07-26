import CesiumMath from "./Math.js";
import TidalArguments from "./TidalArguments.js";
import TidalConstituents from "./TidalConstituents.js";
import TideModel from "./TideModel.js";
import defined from "./defined.js";

/** @import JulianDate from "./JulianDate.js"; */

/**
 * HarmonicTideModel — harmonic tide prediction from a per-location constituent
 * table, and the seam every tide data tier plugs into.
 *
 * Maintainer ruling **T5** is "support EOT20 and NOAA, default EOT20". Ruling
 * **T6** is "tides must match the real dates and timings and stay aligned with
 * the Moon". This module is where those meet: a data tier supplies nothing but
 * an amplitude and a Greenwich phase lag per constituent, and every ANGLE comes
 * from {@link TidalArguments} + {@link TidalConstituents} evaluated at the scene
 * clock. No tier can drift off the Moon, because no tier owns a clock.
 *
 * THE TWO FORMS, AND WHY THEY ARE THE SAME FUNCTION.
 *
 *   Atlas / station:  h(t) = SUM_c  f_c(t) * A_c * cos( V_c(t) + u_c(t) - g_c )
 *   Equilibrium:      h(t) = gamma2 * SUM_c f_c(t) * Aeq_c * G_species(phi)
 *                                    * cos( V_c(t) + u_c(t) + n1 * lambda )
 *
 * `A, g` are what EOT20 and NOAA CO-OPS publish — g is the Greenwich phase LAG,
 * the convention both use, and it already carries the station's longitude and
 * its basin's lag. The equilibrium form has no lag at all, so its "g" is a pure
 * geometric term. Writing the second as the first is exact:
 *
 *     A_c = gamma2 * Aeq_c * |G_species(phi)|
 *     g_c = -n1 * lambda   (+ pi when G_species(phi) is negative)
 *
 * — which is what {@link HarmonicTideModel.equilibriumStation} does. There is
 * therefore exactly ONE prediction routine, exercised by both paths, and the
 * spec proves the equilibrium station reproduces the direct equilibrium
 * evaluation bit-for-bit.
 *
 * WHICH MODEL IS THE DEFAULT. `Core/TideModel.js` — the geometric degree-2 tide
 * straight from the Simon-1994 Moon and Sun — remains the dataset-free default,
 * because it is strictly MORE accurate than any truncated harmonic development
 * of itself: it carries the full lunar equation of centre, evection, variation
 * and parallax for free, where a ten-constituent expansion truncates them. The
 * equilibrium form here exists so that (a) the harmonic path has a working
 * answer everywhere before any atlas loads, (b) an atlas covering only some
 * constituents can be completed from theory, and (c) the harmonic engine can be
 * validated against the geometric one. Measured agreement between the two, over
 * a year at four latitudes and three separate decades: correlation 0.992-0.998,
 * demeaned RMS residual 6-12% of signal RMS. The residual IS the truncation.
 *
 * gamma2 = 1 + k2 - h2 is imported from {@link TideModel} rather than restated,
 * so the tide-gauge-versus-geocentric decision recorded in that module's header
 * has exactly one home.
 *
 * THE PERMANENT TIDE IS NOT HERE. The zero-frequency term is, by definition,
 * not a constituent: it has no argument to advance. {@link TideModel.permanentTideHeight}
 * owns it, and a caller composing a total water level adds it separately — the
 * same split `Scene/OceanSurfacePrimitive.js` already makes.
 *
 * @namespace HarmonicTideModel
 */
const HarmonicTideModel = {};

/**
 * Provenance tag for a station filled from the theoretical equilibrium tide.
 * @type {string}
 */
HarmonicTideModel.SOURCE_EQUILIBRIUM = "EQUILIBRIUM";
/**
 * Provenance tag for a station sampled from a baked EOT20 atlas — the default
 * data tier under ruling T5.
 * @type {string}
 */
HarmonicTideModel.SOURCE_EOT20 = "EOT20";
/**
 * Provenance tag for a station filled from NOAA CO-OPS published harmonic
 * constituents (US stations, public domain).
 * @type {string}
 */
HarmonicTideModel.SOURCE_NOAA = "NOAA";

/**
 * Allocate a station: the per-location amplitude/phase table that every data
 * tier produces and {@link HarmonicTideModel.predict} consumes.
 *
 * The parallel-array shape (rather than an array of objects) is deliberate: a
 * grid sampler fills one of these per ocean patch per frame, and the arrays are
 * reused in place so the per-frame path allocates nothing.
 *
 * @param {object[]} [constituents=TidalConstituents.ALL] The constituents this
 *   station carries, in the order the amplitude and phase arrays use.
 * @returns {object} The station.
 */
HarmonicTideModel.createStation = function (constituents) {
  const list = defined(constituents)
    ? constituents.slice()
    : TidalConstituents.ALL.slice();
  return {
    /** The constituents, in array order. @type {object[]} */
    constituents: list,
    /** Amplitude of each constituent in METRES. @type {Float64Array} */
    amplitudeM: new Float64Array(list.length),
    /**
     * GREENWICH phase lag of each constituent in radians — the convention both
     * EOT20 and NOAA CO-OPS publish. High water occurs when
     * `V + u = g`; a larger g is a LATER tide.
     * @type {Float64Array}
     */
    phaseLagRadians: new Float64Array(list.length),
    /** East longitude the station is for, radians. @type {number} */
    longitude: 0.0,
    /**
     * Latitude the station is for, radians. GEOCENTRIC for an equilibrium
     * station, because the species factor that built it is written in
     * geocentric latitude; whatever graticule the atlas publishes for a sampled
     * one. Provenance only — {@link HarmonicTideModel.predict} never reads it,
     * since an atlas amplitude already carries its own latitude dependence.
     * @type {number}
     */
    latitude: 0.0,
    /**
     * Fraction of the source data that was present where this station was
     * sampled: 1 for an equilibrium station and in open water, between 0 and 1
     * within one atlas cell of a coast, 0 on land. A caller falls back to the
     * equilibrium station rather than rendering the flat sea a zero-coverage
     * sample would give.
     * @type {number}
     */
    coverage: 1.0,
    /** One of the `SOURCE_*` tags. @type {string} */
    source: HarmonicTideModel.SOURCE_EQUILIBRIUM,
    /** False until something fills it; {@link HarmonicTideModel.predict} then returns 0. @type {boolean} */
    valid: false,
  };
};

/**
 * Fill a station with the theoretical equilibrium amplitudes and phases at a
 * location, so the dataset-free path runs through the same predictor as an
 * atlas.
 *
 * @param {number} longitude East longitude in radians.
 * @param {number} geocentricLatitude GEOCENTRIC latitude in radians.
 * @param {object} [station] A {@link HarmonicTideModel.createStation} to fill.
 * @returns {object} `station` (or a fresh one), mutated in place.
 */
HarmonicTideModel.equilibriumStation = function (
  longitude,
  geocentricLatitude,
  station,
) {
  const out = station ?? HarmonicTideModel.createStation();
  out.valid = false;
  out.coverage = 0.0;
  out.source = HarmonicTideModel.SOURCE_EQUILIBRIUM;
  if (!isFinite(longitude) || !isFinite(geocentricLatitude)) {
    out.amplitudeM.fill(0.0);
    out.phaseLagRadians.fill(0.0);
    return out;
  }
  out.longitude = longitude;
  out.latitude = geocentricLatitude;
  const gamma = TideModel.DIMINISHING_FACTOR;
  for (let i = 0; i < out.constituents.length; i++) {
    const c = out.constituents[i];
    const g = TidalConstituents.speciesFactor(c.species, geocentricLatitude);
    // A negative species factor is a half-turn of phase, not a negative
    // amplitude: keeping amplitudes non-negative is what lets a station be
    // compared against, or blended with, an atlas sample.
    out.amplitudeM[i] = gamma * c.equilibriumAmplitudeM * Math.abs(g);
    out.phaseLagRadians[i] = CesiumMath.zeroToTwoPi(
      -c.doodson[0] * longitude + (g < 0.0 ? Math.PI : 0.0),
    );
  }
  out.coverage = 1.0;
  out.valid = true;
  return out;
};

/**
 * Allocate a result object for {@link HarmonicTideModel.predict}.
 *
 * @returns {object} The result object.
 */
HarmonicTideModel.createResult = function () {
  return {
    /** Total harmonic water level, metres. */
    heightM: 0.0,
    /** Semidiurnal (species 2) part, metres. */
    semidiurnalM: 0.0,
    /** Diurnal (species 1) part, metres. */
    diurnalM: 0.0,
    /** Long-period (species 0) part, metres. */
    longPeriodM: 0.0,
    /** The nodal factor f applied to M2 at this instant — diagnostic. */
    m2NodalFactor: 1.0,
    /** East longitude of the MEAN sub-lunar point, radians — diagnostic. */
    meanSubLunarLongitude: 0.0,
    /** False when the inputs were degenerate; `heightM` is then exactly 0. */
    valid: false,
  };
};

const scratchArgs = TidalArguments.createResult();
const scratchNodal = TidalConstituents.createNodalResult();

/**
 * Predict the tide at a station and time.
 *
 * @param {JulianDate} time The scene time. The prediction is a pure function of
 *   this and the station — nothing reads wall time.
 * @param {object} station A filled {@link HarmonicTideModel.createStation}.
 * @param {object} [result] A {@link HarmonicTideModel.createResult} to fill.
 * @param {number} [ut1MinusUtcSeconds=0.0] DUT1; see {@link TidalArguments.compute}.
 * @returns {object} `result` (or a fresh object), mutated in place.
 */
HarmonicTideModel.predict = function (
  time,
  station,
  result,
  ut1MinusUtcSeconds,
) {
  const out = result ?? HarmonicTideModel.createResult();
  out.heightM = 0.0;
  out.semidiurnalM = 0.0;
  out.diurnalM = 0.0;
  out.longPeriodM = 0.0;
  out.m2NodalFactor = 1.0;
  out.meanSubLunarLongitude = 0.0;
  out.valid = false;

  if (!defined(time) || !defined(station) || station.valid !== true) {
    return out;
  }

  const args = TidalArguments.compute(time, scratchArgs, ut1MinusUtcSeconds);
  if (args.valid !== true) {
    return out;
  }

  const constituents = station.constituents;
  const amplitudes = station.amplitudeM;
  const lags = station.phaseLagRadians;
  if (
    !defined(constituents) ||
    !defined(amplitudes) ||
    !defined(lags) ||
    !Number.isInteger(constituents.length) ||
    constituents.length === 0 ||
    amplitudes.length < constituents.length ||
    lags.length < constituents.length
  ) {
    return out;
  }

  let semidiurnal = 0.0;
  let diurnal = 0.0;
  let longPeriod = 0.0;
  let hasUsableConstituent = false;

  for (let i = 0; i < constituents.length; i++) {
    const c = constituents[i];
    const amplitude = amplitudes[i];
    const lag = lags[i];
    // Atlas land/missing-data nodes are represented by NaN. A poisoned row
    // must never make an otherwise reusable result report `valid: true` with
    // NaN fields. Mixed stations may still use their remaining finite rows.
    if (!Number.isFinite(amplitude) || !Number.isFinite(lag)) {
      continue;
    }
    // A finite zero-amplitude row is still usable input and represents a valid
    // zero tide. Keep it distinct from an all-missing/NaN station.
    if (amplitude === 0.0) {
      hasUsableConstituent = true;
      continue;
    }
    const nodal = TidalConstituents.nodalCorrection(c, args.node, scratchNodal);
    const v = TidalConstituents.astronomicalArgument(c, args);
    const term = nodal.f * amplitude * Math.cos(v + nodal.u - lag);
    if (!Number.isFinite(term)) {
      continue;
    }
    hasUsableConstituent = true;
    if (c.species === TidalConstituents.SPECIES_SEMIDIURNAL) {
      semidiurnal += term;
    } else if (c.species === TidalConstituents.SPECIES_DIURNAL) {
      diurnal += term;
    } else {
      longPeriod += term;
    }
    if (c === TidalConstituents.M2) {
      out.m2NodalFactor = nodal.f;
    }
  }

  if (!hasUsableConstituent) {
    return out;
  }

  out.semidiurnalM = semidiurnal;
  out.diurnalM = diurnal;
  out.longPeriodM = longPeriod;
  out.heightM = semidiurnal + diurnal + longPeriod;
  out.meanSubLunarLongitude = TidalArguments.meanSubLunarLongitude(args);
  out.valid = true;
  return out;
};

const scratchStation = HarmonicTideModel.createStation();
const scratchResult = HarmonicTideModel.createResult();

/**
 * The dataset-free harmonic equilibrium tide at a location, in metres of water
 * level relative to the crust (the same tide-gauge quantity
 * {@link TideModel.equilibriumHeight} returns, and excluding the permanent tide
 * for the same reason).
 *
 * Prefer {@link TideModel.equilibriumHeight} when no atlas is loaded — it is the
 * untruncated form. This exists so the harmonic path is never without an
 * answer, and so the two can be compared.
 *
 * @param {JulianDate} time The scene time.
 * @param {number} longitude East longitude in radians.
 * @param {number} geocentricLatitude GEOCENTRIC latitude in radians.
 * @returns {number} Metres. Exactly 0 for degenerate inputs.
 */
HarmonicTideModel.equilibriumHeight = function (
  time,
  longitude,
  geocentricLatitude,
) {
  HarmonicTideModel.equilibriumStation(
    longitude,
    geocentricLatitude,
    scratchStation,
  );
  return HarmonicTideModel.predict(time, scratchStation, scratchResult).heightM;
};

export default HarmonicTideModel;
