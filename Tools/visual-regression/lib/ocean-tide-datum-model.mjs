// ocean-tide-datum-model.mjs — pure math, published reference constants and
// verdict logic for the C6-FFT-OCEAN-TIDE-DATUM acceptance
// (`probe-ocean-tide-datum.mjs` + `ocean-tide-datum.spec.mjs`).
//
// NO browser, NO Playwright, NO engine imports. Everything here is
// Node-testable in isolation; the spec is the trust anchor for the probe's
// verdicts, exactly as `lib/ocean-datum-model.mjs` is for the Batch 759 datum
// probe.
//
// WHAT IS BEING ACCEPTED
// ----------------------
// Two things land together, and the acceptance must separate them:
//
//   (1) A DEFECT FIX. `OceanSurfacePrimitive` anchored its FFT patch at
//       ELLIPSOIDAL height 0 while Cesium World Terrain's baked sea sits on the
//       GEOID. Batch 759 measured the disagreement at the Sri Lanka coast:
//       terrain - anchor = -101.642 m, i.e. the patch floats ~102 m ABOVE the
//       baked sea as a raised water plateau. The fix adds a geoid-undulation
//       term to the anchor and is therefore DEFAULT-ON.
//
//   (2) A FEATURE. An in-engine equilibrium tide (ruling T1), phase-locked to
//       the scene clock and the Simon-1994 ephemerides (ruling T6), with a
//       documented `tideExaggeration` (ruling T3).
//
// Lane (a) accepts (1) with a before/after measured IN THE SAME RUN — the
// baseline is re-measured by pinning `oceanVerticalDatum = "ELLIPSOID"` rather
// than trusted from the Batch 759 manifest, so terrain-LOD or provider drift
// cannot masquerade as an improvement.
//
// REFERENCE DISAGREEMENT IS STRUCTURAL. Where a published constant and this
// engine disagree beyond the stated band, that is a finding about the engine
// or about the constant — never something to widen a band for. Each band below
// says what it is protecting.

/**
 * Published constants used as external anchors. None of these are derived from
 * this engine, which is the point: they are what makes the phase assertions
 * falsifiable rather than self-consistent.
 */
export const PUBLISHED_CONSTANTS = Object.freeze({
  /**
   * Speed of the M2 (principal lunar semidiurnal) tidal constituent, degrees
   * per mean solar hour. NOAA CO-OPS harmonic constituent table
   * (https://tidesandcurrents.noaa.gov/harcon.html — US Government work, public
   * domain). Period = 360 / speed = 12.420601 h = 12 h 25.2 min.
   */
  M2_SPEED_DEG_PER_HOUR: 28.984104,
  /** Mean synodic (new-moon to new-moon) month in days — the spring/neap beat is half of this. */
  SYNODIC_MONTH_DAYS: 29.530589,
  /** Mean lunar (tidal) day in mean solar hours; two M2 cycles. */
  MEAN_LUNAR_DAY_HOURS: 24.841201,
  /**
   * Nominal degree-2 Love numbers, IERS Conventions (2010) §7.1.1. The engine
   * must carry these exact values; the diminishing factor 1 + k2 - h2 they
   * imply is what turns the raw potential into the tide-gauge quantity.
   */
  LOVE_H2: 0.6078,
  LOVE_K2: 0.3022,
});

/** M2 period in hours, derived from the published speed. */
export const M2_PERIOD_HOURS =
  360.0 / PUBLISHED_CONSTANTS.M2_SPEED_DEG_PER_HOUR;

/**
 * Geoid reference sites. `cwtMeasuredM` is the Cesium-World-Terrain ocean-lid
 * ellipsoidal height measured by `probe-ocean-datum.mjs` (Batch 759,
 * `output/ocean-datum.json`, `sampleTerrainMostDetailed`). `gridExpectedM` is
 * what the bundled 0.5-degree EGM2008 grid returns at the same coordinate,
 * measured when the asset was baked.
 *
 * The pairing is the strongest single piece of evidence in this work package:
 * an INDEPENDENTLY BAKED EGM2008 grid reproduces the terrain provider's own sea
 * surface to a few centimetres at six sites spanning 171 m of undulation. That
 * is what licenses "CWT's lid IS the geoid" as an engineering fact rather than
 * a correlation. It also retires the Batch 759 advisory table's RMS 3.7 m,
 * which was table read-off error, not lid error.
 */
export const GEOID_REFERENCE_SITES = Object.freeze(
  [
    {
      id: "IND-LOW",
      lonDeg: 78.0,
      latDeg: 4.0,
      cwtMeasuredM: -104.2456,
      gridExpectedM: -104.17,
    },
    {
      id: "ICE-HIGH",
      lonDeg: -20.0,
      latDeg: 62.0,
      cwtMeasuredM: 63.0059,
      gridExpectedM: 63.06,
    },
    {
      id: "NGUI-HIGH",
      lonDeg: 146.0,
      latDeg: 1.0,
      cwtMeasuredM: 66.9911,
      gridExpectedM: 66.94,
    },
    {
      id: "HUDSON-LOW",
      lonDeg: -85.0,
      latDeg: 59.5,
      cwtMeasuredM: -46.0647,
      gridExpectedM: -45.98,
    },
    {
      id: "PAC-MID",
      lonDeg: -150.0,
      latDeg: 10.0,
      cwtMeasuredM: 1.0858,
      gridExpectedM: 1.4,
    },
    {
      id: "ATL-MID",
      lonDeg: -30.0,
      latDeg: 30.0,
      cwtMeasuredM: 30.1945,
      gridExpectedM: 30.22,
    },
    {
      id: "LKA-COAST",
      lonDeg: 79.75,
      latDeg: 6.0,
      cwtMeasuredM: -101.6424,
      gridExpectedM: -101.165,
    },
  ].map(Object.freeze),
);

/**
 * Lane (a) site — the same Laccadive Sea framing the Batch 759 probe used, so
 * the before/after is directly comparable with the archived PNGs.
 */
export const DATUM_FIX_SITE = Object.freeze({
  id: "LKA-COAST",
  lonDeg: 79.75,
  latDeg: 6.0,
  cameraAltM: 120.0,
  headingDeg: 90.0,
  pitchDeg: -6.0,
  /** Batch 759 measured `terrainRaw - anchor`, metres. Negative = patch above. */
  baselineOffsetM: -101.6424,
});

/**
 * Lane (b) site. Portland, Maine — the NOAA CO-OPS reference station 8418150
 * region, a strongly semidiurnal Atlantic coast. The site choice affects only
 * the diurnal-inequality shape; every assertion below is site-independent
 * except the range band.
 */
export const TIDE_PHASE_SITE = Object.freeze({
  id: "PORTLAND-ME",
  lonDeg: -70.7,
  latDeg: 43.07,
  noaaStation: "8418150",
});

/** Equatorial control site for the period assertion (see THRESHOLDS.M2_*). */
export const TIDE_PERIOD_SITE = Object.freeze({
  id: "EQ-PACIFIC",
  lonDeg: -150.0,
  latDeg: 0.0,
});

export const THRESHOLDS = Object.freeze({
  // ── lane (a): datum fix ────────────────────────────────────────────────
  /**
   * |terrain - anchor| accepted AFTER the fix. The bundled 0.5-degree grid's
   * measured worst case over open water is 3.598 m (Vitoria-Trindade
   * seamounts); at the lane site the grid reproduces the CWT lid to 0.477 m.
   * 3.0 m protects the claim "the plateau is gone", not "the grid is exact".
   */
  DATUM_RESIDUAL_BUDGET_M: 3.0,
  /** What the residual should actually be at this site if nothing regressed. */
  DATUM_RESIDUAL_EXPECTED_M: 1.0,
  /** Tolerance on reproducing the Batch 759 baseline offset in the same run. */
  DATUM_BASELINE_TOL_M: 5.0,
  /** Residual must be at most this FRACTION of the baseline offset. */
  DATUM_MAX_RESIDUAL_FRACTION: 0.05,
  /** Canvas ON-vs-OFF mean |dLuminance| proving the patch is in frame. */
  PATCH_VISIBLE_MIN_LUM_DELTA: 0.5,
  /** ... and it must also beat the OFF-vs-OFF temporal baseline by this factor. */
  PATCH_VISIBLE_BASELINE_FACTOR: 2.0,

  // ── lane (b): tide phase ───────────────────────────────────────────────
  /**
   * Peak-to-peak equilibrium range over 25 h at true scale. Theory bounds it:
   * the lunar term alone spans 0.357 m * 1.5 * gamma2 = 0.372 m and the solar
   * adds 0.46 of that at syzygy, so a spring maximum near 0.55 m and a neap
   * minimum near 0.10 m. The band is deliberately wider than the extremes it
   * protects against — a factor-2 amplitude error, a dropped Love factor
   * (would read 0.79 m), or a dropped solar term.
   */
  TIDE_RANGE_MIN_M: 0.05,
  TIDE_RANGE_MAX_M: 1.2,
  /** Semidiurnal signal over 25 h: ~2 highs + ~2 lows. */
  TIDE_EXTREMA_MIN: 2,
  TIDE_EXTREMA_MAX: 8,
  /**
   * The LUNAR-ONLY term's maxima must coincide with lunar culmination (upper
   * or lower meridian passage) — by construction they are the same instant, so
   * any drift is an ephemeris-frame or time-base defect. Minutes.
   */
  LUNAR_PHASE_LOCK_MAX_MINUTES: 5.0,
  /**
   * Mean lunar-maximum interval over a multi-week baseline vs the published M2
   * half-period. Individual intervals swing +-0.1 h with the Moon's variable
   * speed; only the MEAN is the constituent. Hours.
   */
  M2_MEAN_INTERVAL_TOL_HOURS: 0.05,
  /** Baseline over which the mean is taken. Shorter windows do not converge. */
  M2_BASELINE_DAYS: 40,
  /**
   * Spring (max daily range) must fall at syzygy and neap at quadrature.
   * Elongation between Sun and Moon, degrees from 0/180 and from 90.
   */
  SYZYGY_ELONGATION_TOL_DEG: 20.0,
  /**
   * The rendered `tideHeightMeters` must equal the model evaluated at the same
   * pinned scene time. This is the scene-clock lock (ruling T6): anything
   * reading wall time fails it immediately. Metres.
   */
  SCENE_CLOCK_LOCK_TOL_M: 1e-9,

  // ── lane (c): exaggeration composition ─────────────────────────────────
  /**
   * `h' = (h - relativeHeight) * scale + relativeHeight` applied to the TOTAL
   * datum+tide height. Measured against the anchor height the scene publishes.
   * The tolerance absorbs the tide moving between the two renders, not model
   * error. Metres.
   */
  EXAG_COMPOSITION_TOL_M: 0.05,

  // ── lane (d): off-contract ─────────────────────────────────────────────
  /**
   * Off-contract offsets are EXACTLY zero, not small. Anything else means a
   * term is leaking into the default path.
   */
  OFF_CONTRACT_EXACT_ZERO: 0.0,
  /** Anchor geodetic height under the off-contract, metres (round-trip noise). */
  OFF_CONTRACT_ANCHOR_HEIGHT_TOL_M: 1e-6,
});

function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/** Bound on the prominence-merge loop (house rule: every loop is bounded). */
const MAX_PROMINENCE_PASSES = 256;

/**
 * Local extrema of a uniformly-sampled series, optionally filtered by
 * prominence.
 *
 * WHY PROMINENCE. Without it, "count the extrema" and "is the series monotone
 * between extrema" are both vacuous: every wiggle becomes its own extremum, so
 * every inter-extremum segment is monotone by construction and a jittering
 * tide term passes. With a prominence floor, sub-threshold wiggles are merged
 * away and {@link monotoneSegments} then actually sees them.
 *
 * @param {number[]} values The samples.
 * @param {number} dtSeconds Sample spacing.
 * @param {number} [minProminence=0] Minimum swing between consecutive extrema.
 * @returns {{kind:string, index:number, timeSeconds:number, value:number}[]}
 *   Interior extrema in order. Endpoints are never reported — a 25 h window
 *   starts and ends mid-cycle, so endpoint "extrema" are window artifacts.
 */
export function findExtrema(values, dtSeconds, minProminence = 0) {
  const out = [];
  for (let i = 1; i < values.length - 1; i++) {
    const a = values[i - 1];
    const b = values[i];
    const c = values[i + 1];
    if (!isNum(a) || !isNum(b) || !isNum(c)) {
      continue;
    }
    if (b > a && b >= c) {
      out.push({ kind: "MAX", index: i, timeSeconds: i * dtSeconds, value: b });
    } else if (b < a && b <= c) {
      out.push({ kind: "MIN", index: i, timeSeconds: i * dtSeconds, value: b });
    }
  }
  if (!(minProminence > 0)) {
    return out;
  }

  // Repeatedly retire the smallest sub-threshold MAX/MIN pair, then collapse
  // any two same-kind neighbours it exposed by keeping the more extreme one.
  const list = out.slice();
  for (let pass = 0; pass < MAX_PROMINENCE_PASSES; pass++) {
    let worstIndex = -1;
    let smallest = Infinity;
    for (let i = 0; i < list.length - 1; i++) {
      const d = Math.abs(list[i + 1].value - list[i].value);
      if (d < smallest) {
        smallest = d;
        worstIndex = i;
      }
    }
    if (worstIndex < 0 || smallest >= minProminence) {
      break;
    }
    list.splice(worstIndex, 2);
    if (
      worstIndex > 0 &&
      worstIndex < list.length &&
      list[worstIndex - 1].kind === list[worstIndex].kind
    ) {
      const first = list[worstIndex - 1];
      const second = list[worstIndex];
      const keepFirst =
        first.kind === "MAX"
          ? first.value >= second.value
          : first.value <= second.value;
      list.splice(keepFirst ? worstIndex : worstIndex - 1, 1);
    }
  }
  return list;
}

/**
 * Sub-sample refinement of an extremum by parabolic fit through its three
 * samples. Used for the phase-lock assertion so the verdict is not limited by
 * the ladder step.
 *
 * @param {number[]} values The samples.
 * @param {number} index Index of the extremum.
 * @param {number} dtSeconds Sample spacing.
 * @returns {number} Refined time in seconds from the first sample.
 */
export function refineExtremumSeconds(values, index, dtSeconds) {
  const a = values[index - 1];
  const b = values[index];
  const c = values[index + 1];
  const denom = a - 2 * b + c;
  if (!isNum(denom) || denom === 0) {
    return index * dtSeconds;
  }
  const delta = (a - c) / (2 * denom);
  const clamped = delta > 0.5 ? 0.5 : delta < -0.5 ? -0.5 : delta;
  return (index + clamped) * dtSeconds;
}

/**
 * Mean spacing of a list of instants.
 *
 * @param {number[]} timesSeconds Instants, ascending.
 * @returns {number|null} Mean interval in hours, or null with fewer than two.
 */
export function meanIntervalHours(timesSeconds) {
  if (!Array.isArray(timesSeconds) || timesSeconds.length < 2) {
    return null;
  }
  const span = timesSeconds[timesSeconds.length - 1] - timesSeconds[0];
  return span / (timesSeconds.length - 1) / 3600.0;
}

/**
 * Every consecutive pair between two extrema must move the same direction —
 * a smoothness check that catches a jittering or aliased tide term (e.g. an
 * unmemoised ephemeris re-solved per sample with a different frame branch).
 *
 * @param {number[]} values The samples.
 * @param {{index:number}[]} extrema Output of {@link findExtrema}.
 * @returns {{segments:number, monotoneSegments:number, allMonotone:boolean}}
 */
export function monotoneSegments(values, extrema) {
  let segments = 0;
  let monotone = 0;
  for (let e = 0; e < extrema.length - 1; e++) {
    const from = extrema[e].index;
    const to = extrema[e + 1].index;
    if (to - from < 2) {
      continue;
    }
    segments++;
    const rising = values[to] > values[from];
    let ok = true;
    for (let i = from + 1; i <= to; i++) {
      const d = values[i] - values[i - 1];
      if (rising ? d < 0 : d > 0) {
        ok = false;
        break;
      }
    }
    if (ok) {
      monotone++;
    }
  }
  return {
    segments,
    monotoneSegments: monotone,
    allMonotone: segments > 0 && monotone === segments,
  };
}

/**
 * Lane (a) verdict: did the datum term actually close the plateau?
 *
 * @param {object} obs Observation.
 * @param {number|null} obs.beforeOffsetM `terrainRaw - anchor` with the datum
 *   pinned to ELLIPSOID (the pre-fix anchor, re-measured in this run).
 * @param {number|null} obs.afterOffsetM The same with the datum resolved.
 * @param {string|null} [obs.resolvedDatum] What AUTO resolved to.
 * @param {number|null} [obs.geoidUndulationM] The undulation the engine applied.
 * @param {boolean|null} [obs.patchVisible] Whether the patch was in frame.
 * @returns {object} Verdict.
 */
export function datumFixVerdict(obs) {
  const before = isNum(obs?.beforeOffsetM) ? obs.beforeOffsetM : null;
  const after = isNum(obs?.afterOffsetM) ? obs.afterOffsetM : null;
  const T = THRESHOLDS;
  const reasons = [];

  if (before === null || after === null) {
    return {
      verdict: "INDETERMINATE",
      beforeOffsetM: before,
      afterOffsetM: after,
      residualFraction: null,
      reasons: ["one of the before/after offsets could not be measured"],
    };
  }

  const baselineMatches =
    Math.abs(before - DATUM_FIX_SITE.baselineOffsetM) <= T.DATUM_BASELINE_TOL_M;
  if (!baselineMatches) {
    reasons.push(
      `pinned-ELLIPSOID baseline ${before.toFixed(2)} m does not reproduce the Batch 759 measurement ${DATUM_FIX_SITE.baselineOffsetM} m within ${T.DATUM_BASELINE_TOL_M} m — the before/after comparison is not anchored`,
    );
  }
  const residualFraction =
    Math.abs(before) > 0 ? Math.abs(after) / Math.abs(before) : null;
  const withinBudget = Math.abs(after) <= T.DATUM_RESIDUAL_BUDGET_M;
  const improved =
    residualFraction !== null &&
    residualFraction <= T.DATUM_MAX_RESIDUAL_FRACTION;

  if (!withinBudget) {
    reasons.push(
      `residual ${after.toFixed(2)} m exceeds the ${T.DATUM_RESIDUAL_BUDGET_M} m grid budget`,
    );
  }
  if (!improved) {
    reasons.push(
      `residual is ${(100 * (residualFraction ?? 1)).toFixed(1)}% of the baseline (needed <= ${100 * T.DATUM_MAX_RESIDUAL_FRACTION}%)`,
    );
  }
  if (obs?.patchVisible === false) {
    reasons.push(
      "the FFT patch was NOT proven in frame — a 0 m offset from an absent patch is not a fix",
    );
  }
  if (obs?.resolvedDatum && obs.resolvedDatum !== "GEOID") {
    reasons.push(
      `AUTO resolved to ${obs.resolvedDatum}, not GEOID, over Cesium World Terrain`,
    );
  }

  const pass =
    baselineMatches && withinBudget && improved && obs?.patchVisible !== false;
  return {
    verdict: pass ? "DATUM_FIXED" : "DATUM_NOT_FIXED",
    beforeOffsetM: before,
    afterOffsetM: after,
    residualFraction,
    geoidUndulationM: isNum(obs?.geoidUndulationM)
      ? obs.geoidUndulationM
      : null,
    resolvedDatum: obs?.resolvedDatum ?? null,
    reasons,
  };
}

/**
 * Lane (b) verdict: is the tide real, phase-locked, and the right size?
 *
 * @param {object} obs Observation.
 * @param {number[]} obs.renderedSeries `tideHeightMeters` read after a render
 *   at each pinned time.
 * @param {number[]} obs.modelSeries The model evaluated at the same instants.
 * @param {number} obs.dtSeconds Ladder step.
 * @param {number|null} obs.lunarPhaseLockMaxMinutes Worst lunar-maximum vs
 *   lunar-culmination separation over the window.
 * @param {number|null} obs.meanM2IntervalHours Mean lunar-maximum interval.
 * @param {number|null} [obs.springElongationMaxDeg] Worst |elongation - 0/180|
 *   at a daily-range maximum.
 * @param {number|null} [obs.neapElongationMaxDeg] Worst |elongation - 90| at a
 *   daily-range minimum.
 * @returns {object} Verdict.
 */
export function tidePhaseVerdict(obs) {
  const T = THRESHOLDS;
  const rendered = Array.isArray(obs?.renderedSeries) ? obs.renderedSeries : [];
  const model = Array.isArray(obs?.modelSeries) ? obs.modelSeries : [];
  const dt = isNum(obs?.dtSeconds) ? obs.dtSeconds : null;
  const reasons = [];

  if (rendered.length < 5 || dt === null) {
    return {
      verdict: "INDETERMINATE",
      reasons: ["the rendered tide ladder is too short to analyse"],
    };
  }

  const finite = rendered.filter(isNum);
  const rangeM =
    finite.length > 0 ? Math.max(...finite) - Math.min(...finite) : null;
  // Prominence floor at 2% of the observed range: below that a "peak" is
  // sampling noise, and counting it would both inflate the extremum count and
  // make the monotonicity check vacuous.
  const prominence = rangeM !== null ? Math.max(rangeM * 0.02, 1e-9) : 0;
  const extrema = findExtrema(rendered, dt, prominence);
  const mono = monotoneSegments(rendered, extrema);

  let maxClockLockErrM = null;
  if (model.length === rendered.length) {
    maxClockLockErrM = 0;
    for (let i = 0; i < rendered.length; i++) {
      if (isNum(rendered[i]) && isNum(model[i])) {
        maxClockLockErrM = Math.max(
          maxClockLockErrM,
          Math.abs(rendered[i] - model[i]),
        );
      }
    }
  }

  if (rangeM === null || rangeM < T.TIDE_RANGE_MIN_M) {
    reasons.push(
      `25 h range ${rangeM === null ? "n/a" : rangeM.toFixed(4)} m is below ${T.TIDE_RANGE_MIN_M} m — the tide is not moving`,
    );
  } else if (rangeM > T.TIDE_RANGE_MAX_M) {
    reasons.push(
      `25 h range ${rangeM.toFixed(4)} m exceeds ${T.TIDE_RANGE_MAX_M} m — larger than any equilibrium tide (a missing Love factor reads ~1.44x)`,
    );
  }
  if (
    extrema.length < T.TIDE_EXTREMA_MIN ||
    extrema.length > T.TIDE_EXTREMA_MAX
  ) {
    reasons.push(
      `${extrema.length} extrema over the window; a semidiurnal signal gives ${T.TIDE_EXTREMA_MIN}-${T.TIDE_EXTREMA_MAX}`,
    );
  }
  if (extrema.length >= 2 && !mono.allMonotone) {
    reasons.push(
      `${mono.segments - mono.monotoneSegments} of ${mono.segments} inter-extremum segments are not monotone — the tide term is jittering`,
    );
  }
  if (
    maxClockLockErrM !== null &&
    maxClockLockErrM > T.SCENE_CLOCK_LOCK_TOL_M
  ) {
    reasons.push(
      `rendered tide differs from the model at the same pinned scene time by up to ${maxClockLockErrM.toExponential(2)} m — the render path is not reading the scene clock`,
    );
  }
  const lock = obs?.lunarPhaseLockMaxMinutes;
  if (isNum(lock) && lock > T.LUNAR_PHASE_LOCK_MAX_MINUTES) {
    reasons.push(
      `lunar-only maxima are ${lock.toFixed(2)} min from lunar culmination (> ${T.LUNAR_PHASE_LOCK_MAX_MINUTES} min) — the tide is not phase-locked to the Moon`,
    );
  }
  const m2 = obs?.meanM2IntervalHours;
  if (
    isNum(m2) &&
    Math.abs(m2 - M2_PERIOD_HOURS) > T.M2_MEAN_INTERVAL_TOL_HOURS
  ) {
    reasons.push(
      `mean lunar-maximum interval ${m2.toFixed(4)} h differs from the published M2 half-period ${M2_PERIOD_HOURS.toFixed(4)} h by more than ${T.M2_MEAN_INTERVAL_TOL_HOURS} h`,
    );
  }
  const spring = obs?.springElongationMaxDeg;
  if (isNum(spring) && spring > T.SYZYGY_ELONGATION_TOL_DEG) {
    reasons.push(
      `a spring (max daily range) fell ${spring.toFixed(1)} deg from syzygy — the spring/neap envelope is not tracking the Sun-Moon geometry`,
    );
  }
  const neap = obs?.neapElongationMaxDeg;
  if (isNum(neap) && neap > T.SYZYGY_ELONGATION_TOL_DEG) {
    reasons.push(
      `a neap (min daily range) fell ${neap.toFixed(1)} deg from quadrature`,
    );
  }

  return {
    verdict: reasons.length === 0 ? "TIDE_PHASE_LOCKED" : "TIDE_PHASE_FAILED",
    rangeM,
    extremaCount: extrema.length,
    monotone: mono,
    maxClockLockErrM,
    lunarPhaseLockMaxMinutes: isNum(lock) ? lock : null,
    meanM2IntervalHours: isNum(m2) ? m2 : null,
    m2PublishedHours: M2_PERIOD_HOURS,
    springElongationMaxDeg: isNum(spring) ? spring : null,
    neapElongationMaxDeg: isNum(neap) ? neap : null,
    reasons,
  };
}

/**
 * Lane (c) verdict: does the datum+tide offset compose with
 * `scene.verticalExaggeration` the way the terrain lid does?
 *
 * @param {object} obs Observation.
 * @param {number|null} obs.anchorHeight1M Published anchor height at scale 1.
 * @param {number|null} obs.anchorHeightNM Published anchor height at `scale`.
 * @param {number} obs.scale The exaggerated scale.
 * @param {number} [obs.relativeHeightM=0] `verticalExaggerationRelativeHeight`.
 * @param {number|null} [obs.geoid1M] Published undulation at scale 1.
 * @param {number|null} [obs.geoidNM] Published undulation at `scale`.
 * @param {number|null} [obs.tide1M] Published tide term at scale 1.
 * @param {number|null} [obs.tideNM] Published tide term at `scale`.
 * @returns {object} Verdict.
 */
export function exaggerationCompositionVerdict(obs) {
  const T = THRESHOLDS;
  const h1 = isNum(obs?.anchorHeight1M) ? obs.anchorHeight1M : null;
  const hN = isNum(obs?.anchorHeightNM) ? obs.anchorHeightNM : null;
  const scale = isNum(obs?.scale) ? obs.scale : null;
  const rel = isNum(obs?.relativeHeightM) ? obs.relativeHeightM : 0;

  if (h1 === null || hN === null || scale === null) {
    return {
      verdict: "INDETERMINATE",
      predictedM: null,
      residualM: null,
      reasons: ["anchor heights were not published at both exaggerations"],
    };
  }
  const predicted = (h1 - rel) * scale + rel;
  const residual = hN - predicted;
  const reasons = [];
  if (Math.abs(residual) > T.EXAG_COMPOSITION_TOL_M) {
    reasons.push(
      `anchor height at scale ${scale} is ${hN.toFixed(3)} m; (h-rel)*scale+rel predicts ${predicted.toFixed(3)} m (residual ${residual.toFixed(3)} m). The terrain lid DOES move under exaggeration (Batch 759 lane 3), so a patch that does not follow it re-opens the plateau at scale > 1`,
    );
  }
  // The two COMPONENT terms must be exaggeration-invariant: the map is applied
  // once, to their sum. If the scale has been folded back into a component the
  // anchor total can still look right while `tideExaggeration` and the geoid
  // diagnostic silently report scaled values.
  const invariant = (name, a, b) => {
    if (!isNum(a) || !isNum(b)) {
      return;
    }
    if (Math.abs(b - a) > T.EXAG_COMPOSITION_TOL_M) {
      reasons.push(
        `${name} changed from ${a.toFixed(4)} to ${b.toFixed(4)} m under exaggeration — the map was folded into a component instead of the sum`,
      );
    }
  };
  invariant("geoidUndulationMeters", obs?.geoid1M, obs?.geoidNM);
  invariant("tideHeightMeters", obs?.tide1M, obs?.tideNM);

  return {
    verdict:
      reasons.length === 0 ? "COMPOSES_AS_MODELED" : "COMPOSITION_MISMATCH",
    predictedM: predicted,
    residualM: residual,
    toleranceM: T.EXAG_COMPOSITION_TOL_M,
    reasons,
  };
}

/**
 * Lane (d) verdict: the off-contract must be EXACT.
 *
 * @param {object} obs Observation.
 * @param {number|null} obs.tideOffMeters `tideHeightMeters` with the tide off.
 * @param {number|null} obs.zeroCallbackMeters `tideHeightMeters` with a
 *   callback that returns 0.
 * @param {number|null} obs.ellipsoidUndulationMeters `geoidUndulationMeters`
 *   with the datum pinned to ELLIPSOID.
 * @param {number|null} obs.identityAnchorMeters `anchorHeightMeters` with both
 *   off at identity exaggeration.
 * @param {number|null} [obs.identityAnchorGeodeticHeightM] Geodetic height of
 *   the anchor position in the same configuration.
 * @returns {object} Verdict.
 */
export function offContractVerdict(obs) {
  const T = THRESHOLDS;
  const reasons = [];
  const exact = (name, v) => {
    if (v === null || v === undefined) {
      reasons.push(`${name} was not measured`);
      return;
    }
    if (v !== T.OFF_CONTRACT_EXACT_ZERO) {
      reasons.push(`${name} is ${v} — the off-contract requires EXACTLY 0`);
    }
  };
  exact("tideHeightMeters with tideEnabled=false", obs?.tideOffMeters ?? null);
  exact(
    "tideHeightMeters with a zero callback",
    obs?.zeroCallbackMeters ?? null,
  );
  exact(
    "geoidUndulationMeters with datum=ELLIPSOID",
    obs?.ellipsoidUndulationMeters ?? null,
  );
  exact("anchorHeightMeters with both off", obs?.identityAnchorMeters ?? null);

  const gh = obs?.identityAnchorGeodeticHeightM;
  if (isNum(gh) && Math.abs(gh) > T.OFF_CONTRACT_ANCHOR_HEIGHT_TOL_M) {
    reasons.push(
      `the off-contract anchor sits at geodetic height ${gh} m, not on the ellipsoid surface`,
    );
  }

  return {
    verdict: reasons.length === 0 ? "OFF_IS_IDENTITY" : "OFF_LEAKS",
    reasons,
  };
}

/**
 * Fold the four lanes into one decision + exit code.
 *
 * exit 0 — the datum defect is fixed, the tide is phase-locked, the offset
 *          composes with exaggeration, and off is exact identity.
 * exit 1 — a lane returned a real but failing verdict.
 * exit 2 — structural; assigned by the probe, never here.
 *
 * @param {object} lanes Lane verdicts.
 * @returns {object} Decision.
 */
export function decisionFromLanes(lanes) {
  const failures = [];
  const push = (name, v, pass) => {
    if (!v) {
      failures.push(`${name}: lane missing`);
    } else if (v.verdict === "INDETERMINATE") {
      failures.push(`${name}: INDETERMINATE — ${(v.reasons ?? []).join("; ")}`);
    } else if (v.verdict !== pass) {
      failures.push(`${name}: ${v.verdict} — ${(v.reasons ?? []).join("; ")}`);
    }
  };
  push("datumFix", lanes?.datumFix, "DATUM_FIXED");
  push("tidePhase", lanes?.tidePhase, "TIDE_PHASE_LOCKED");
  push("exaggeration", lanes?.exaggeration, "COMPOSES_AS_MODELED");
  push("offContract", lanes?.offContract, "OFF_IS_IDENTITY");

  return {
    pass: failures.length === 0,
    failures,
    exitCode: failures.length === 0 ? 0 : 1,
    GATE:
      failures.length === 0
        ? "ACCEPTED — geoid datum fix + phase-locked equilibrium tide"
        : "REJECTED — see failures",
  };
}
