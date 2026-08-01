// ocean-datum-model.mjs — pure math + reference table for the shared
// TIDES / OCEAN-DYNAMICS W0 datum probe (`probe-ocean-datum.mjs`).
//
// NO browser, NO Playwright, NO engine imports. Every export here is
// Node-testable in isolation, which is what `ocean-datum.spec.mjs`
// (`node --test`) exercises as the trust anchor for the probe's verdict.
//
// WHAT THIS MODULE DECIDES
// ------------------------
// The probe measures the Cesium World Terrain (ion asset 1) "ocean lid"
// ellipsoidal height at open-ocean sites spread across the EGM2008 geoid
// undulation range. This module turns those raw heights into ONE of three
// answers, which is the gate on every vertical ocean design
// (`migration_doc/TIDES_FEASIBILITY_2026-07-24.md` §5a ruling T2,
//  `migration_doc/OCEAN_DYNAMICS_PLAN_2026-07-24.md` W0 / UNCONFIRMED register):
//
//   ELLIPSOID_ZERO  — the lid is flat at ellipsoidal height 0 everywhere.
//                     ⇒ a tide offset rides RAW ELLIPSOIDAL heights; the FFT
//                       patch's existing `scaleToGeodeticSurface` anchor is
//                       already correct; no geoid term is needed for CWT.
//   GEOID           — the lid tracks the geoid (undulation ±~100 m).
//                     ⇒ per T2 the offset uniform must carry geoid + tide
//                       TOGETHER, and today's ellipsoid-0 FFT anchor is a
//                       LATENT DEFECT of up to ~100 m independent of tides.
//   MIXED_OR_OTHER  — constant non-zero shift, partial/blended datum, or a
//                     datum that changes with terrain LOD.
//                     ⇒ escalate to the T2 multi-vertical-datum adapter design
//                       (per-provider datum metadata + manual override).
//
// THE REFERENCE TABLE IS ADVISORY, NOT LOAD-BEARING
// -------------------------------------------------
// The PRIMARY discriminator is table-independent: "are all sampled heights
// ≈ 0, or do they spread over tens of metres?". The EGM2008 undulations below
// only feed the SECONDARY corroboration (sign agreement + slope-1 regression),
// whose tolerances are deliberately wide enough to absorb ~20% table error.
// When the spread is geoid-shaped but the slope lands outside the band, the
// classifier says GEOID_SHAPED_SLOPE_MISMATCH — which means "either the
// reference table needs refining OR the lid carries a blended datum", NOT
// "the datum is definitely mixed".

/**
 * Physical bound on EGM2008 geoid undulation. The model's global extrema are
 * approximately -106 m (Indian Ocean low, south of Sri Lanka) and +86 m
 * (New Guinea highlands); ±110 m is the sanity envelope every reference value
 * in this file must sit inside.
 * @type {{minM: number, maxM: number}}
 */
export const EGM2008_RANGE_M = Object.freeze({ minM: -110, maxM: 110 });

/** Allowed confidence tags on a reference undulation. */
export const CONFIDENCE_TAGS = Object.freeze([
  "HIGH",
  "MEDIUM_HIGH",
  "MEDIUM",
  "MEDIUM_LOW",
  "LOW",
]);

/**
 * Open-ocean survey sites, chosen to span the EGM2008 undulation range so that
 * "flat at 0" and "tracks the geoid" are separated by ~165 m of signal.
 *
 * SOURCE for every `undulationM`: the EGM2008 global gravitational model
 * (Pavlis, Holmes, Kenyon & Factor, "The development and evaluation of the
 * Earth Gravitational Model 2008 (EGM2008)", J. Geophys. Res. 117, B04406,
 * 2012; NGA EGM2008 model documentation and the standard published
 * geoid-undulation map derived from it). Values are read off that map at the
 * stated coordinates and are therefore APPROXIMATE — each carries an explicit
 * `toleranceM` band and a `confidence` tag. They are hardcoded on purpose: the
 * probe must never fetch a datum reference at runtime (determinism + the
 * project's stream-only/licence rules).
 *
 * REFINEMENT PATH: an authoritative per-point value can be obtained offline
 * from the NGA/NOAA EGM2008 geoid-height calculator and substituted here; the
 * spec's ±110 m physical-range assertion and the classifier's wide slope band
 * both survive such a refinement unchanged.
 *
 * Every site is OPEN OCEAN, far enough offshore that the CWT surface there is
 * unambiguously the water lid rather than a coastal DEM.
 */
export const DATUM_SITES = Object.freeze(
  [
    {
      id: "IND-LOW",
      lonDeg: 78.0,
      latDeg: 4.0,
      water: true,
      undulationM: -100,
      toleranceM: 15,
      confidence: "HIGH",
      why:
        "Indian Ocean geoid low SW of Sri Lanka — the EGM2008 GLOBAL MINIMUM " +
        "region (≈ -106 m near 4.7N/78.8E). The single strongest lever in the " +
        "survey: if CWT carries the geoid this site alone reads ≈ -100 m.",
      source: "EGM2008 (Pavlis et al. 2012) global minimum region",
    },
    {
      id: "ICE-HIGH",
      lonDeg: -20.0,
      latDeg: 62.0,
      water: true,
      undulationM: 60,
      toleranceM: 15,
      confidence: "MEDIUM_HIGH",
      why:
        "North Atlantic geoid high south of Iceland — the opposite-sign " +
        "anchor to IND-LOW. Together they give a ~160 m signed span that no " +
        "ellipsoid-0 lid can imitate.",
      source: "EGM2008 (Pavlis et al. 2012) North Atlantic high",
    },
    {
      id: "NGUI-HIGH",
      lonDeg: 146.0,
      latDeg: 1.0,
      water: true,
      undulationM: 65,
      toleranceM: 20,
      confidence: "MEDIUM",
      why:
        "West Pacific high north of New Guinea, on the flank of the EGM2008 " +
        "GLOBAL MAXIMUM (≈ +86 m, New Guinea highlands). A second positive " +
        "site in a different ocean basin guards against a basin-local artifact.",
      source: "EGM2008 (Pavlis et al. 2012) West Pacific / New Guinea high",
    },
    {
      id: "HUDSON-LOW",
      lonDeg: -85.0,
      latDeg: 59.5,
      water: true,
      undulationM: -40,
      toleranceM: 15,
      confidence: "MEDIUM",
      why:
        "Hudson Bay geoid low (post-glacial-rebound mass deficit). A HIGH-" +
        "LATITUDE negative site: distinguishes a genuine geoid from any " +
        "latitude-banded ellipsoid artifact, and it is inland sea water, so " +
        "it also probes whether CWT treats enclosed sea the same as open ocean.",
      source: "EGM2008 (Pavlis et al. 2012) Hudson Bay low",
    },
    {
      id: "PAC-MID",
      lonDeg: -150.0,
      latDeg: 10.0,
      water: true,
      undulationM: 5,
      toleranceM: 15,
      confidence: "MEDIUM_LOW",
      why:
        "Central North Pacific near-neutral undulation band. THE CONTROL " +
        "SITE: under BOTH hypotheses it reads ≈ 0, so a non-zero value here " +
        "with zeros elsewhere (or vice versa) is the tell for a mixed datum.",
      source: "EGM2008 (Pavlis et al. 2012) central Pacific neutral band",
    },
    {
      id: "ATL-MID",
      lonDeg: -30.0,
      latDeg: 30.0,
      water: true,
      undulationM: 30,
      toleranceM: 20,
      confidence: "LOW",
      why:
        "Mid North Atlantic, mildly positive — an INTERMEDIATE point that " +
        "gives the slope-1 regression a mid-range lever instead of only the " +
        "two extremes. Lowest-confidence value in the table; its wide band " +
        "keeps it from dominating the fit.",
      source: "EGM2008 (Pavlis et al. 2012) mid North Atlantic",
    },
  ].map(Object.freeze),
);

/**
 * Terrain LODs sampled per site in addition to "most detailed". A datum that
 * changes with LOD breaks every single-offset design, so it must be detected
 * rather than averaged away.
 *
 * Level 0-3 are deliberately NOT sampled: a level-0 quantized-mesh tile spans
 * 90 deg of longitude, so an open-ocean point there is interpolated across
 * triangles that can reach continental land — a coarse-LOD height difference
 * would be a TESSELLATION artifact, not a datum signal. Only levels at or above
 * `THRESHOLDS.LEVEL_DEPENDENCE_MIN_LEVEL` feed the LOD-dependence verdict; the
 * rest are informational.
 */
export const SURVEY_LEVELS = Object.freeze([4, 8, 11]);

/** Classification + verdict thresholds. All metres unless noted. */
export const THRESHOLDS = Object.freeze({
  /** |height| at or below this at EVERY site ⇒ the lid is ellipsoidal 0. */
  ELLIPSOID_ZERO_ABS_M: 2.0,
  /** Height spread (max-min) at or above this ⇒ the lid is NOT flat. */
  GEOID_MIN_SPREAD_M: 40.0,
  /** Coefficient of determination of height-vs-undulation for a geoid call. */
  GEOID_MIN_R2: 0.85,
  /** Fraction of strong-|N| sites whose height sign matches the undulation. */
  GEOID_MIN_SIGN_AGREEMENT: 0.8,
  /** |undulation| above which a site's sign is considered informative. */
  SIGN_TEST_MIN_ABS_UNDULATION_M: 20.0,
  /** Regression slope band for "heights ARE the undulation" (1.0 ± 30%). */
  GEOID_SLOPE_MIN: 0.7,
  GEOID_SLOPE_MAX: 1.3,
  /** |intercept| ceiling for a clean geoid call. */
  GEOID_MAX_INTERCEPT_M: 15.0,
  /** Spread at or below this with a non-zero mean ⇒ a uniform datum shift. */
  CONSTANT_OFFSET_MAX_SPREAD_M: 2.0,
  /** A blended/partial datum still correlates, but at a shrunken slope. */
  PARTIAL_GEOID_MIN_R2: 0.7,
  PARTIAL_GEOID_SLOPE_MIN: 0.2,
  /** Per-site disagreement between terrain LODs that counts as LOD-dependent. */
  LEVEL_DEPENDENCE_M: 2.0,
  /**
   * Coarser levels than this are informational only. Below it, a height
   * difference is a coarse-tessellation artifact (a level-4 tile still spans
   * ~11 deg), not evidence of a datum that varies with LOD.
   */
  LEVEL_DEPENDENCE_MIN_LEVEL: 8,
  /** Minimum sites with a height for any classification at all. */
  MIN_SITES_FOR_CLASSIFICATION: 3,

  /** Lane 2: |terrain - patch anchor| at or below this ⇒ co-planar. */
  PATCH_COPLANAR_ABS_M: 2.0,
  /** Lane 2: mean |Δluminance| ON-vs-OFF proving the patch is in frame. */
  PATCH_VISIBLE_MIN_LUM_DELTA: 0.5,
  /**
   * Lane 2: the ON-vs-OFF delta must also beat the OFF-vs-OFF temporal
   * baseline by this factor. The base globe already animates its water-mask
   * waves, so "pixels changed" alone does NOT prove the FFT patch is in frame.
   */
  PATCH_VISIBLE_BASELINE_FACTOR: 2.0,

  /** Lane 3: |Δ rendered height| above this ⇒ exaggeration moved the lid. */
  EXAG_DISPLACEMENT_ABS_M: 1.0,
  /** Lane 3: absolute + relative tolerance on the (h-r)*s+r prediction. */
  EXAG_MODEL_TOL_ABS_M: 1.0,
  EXAG_MODEL_TOL_REL: 0.1,
  /** Lane 3: raw sampleTerrain must be exaggeration-invariant within this. */
  EXAG_RAW_INVARIANT_M: 0.5,
});

/** Datum classifications this module can return. */
export const CLASSIFICATIONS = Object.freeze([
  "ELLIPSOID_ZERO",
  "GEOID",
  "MIXED_OR_OTHER",
  "INSUFFICIENT_DATA",
]);

/** Sub-labels that refine MIXED_OR_OTHER. */
export const MIXED_SUBLABELS = Object.freeze([
  "LEVEL_DEPENDENT",
  "CONSTANT_OFFSET",
  "GEOID_SHAPED_SLOPE_MISMATCH",
  "PARTIAL_GEOID",
  "UNCLASSIFIED",
]);

/**
 * Look a survey site up by id.
 * @param {string} id Site id.
 * @returns {object|undefined} The frozen site record.
 */
export function siteById(id) {
  return DATUM_SITES.find((s) => s.id === id);
}

function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Ordinary least-squares fit of y = slope*x + intercept.
 * @param {number[]} xs Independent values.
 * @param {number[]} ys Dependent values (same length as xs).
 * @returns {{slope:number|null, intercept:number|null, r2:number|null, n:number}}
 *   `null` fields when there are fewer than two points or x has zero variance.
 */
export function linearRegression(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) {
    return { slope: null, intercept: null, r2: null, n };
  }
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (sxx === 0) {
    return { slope: null, intercept: null, r2: null, n };
  }
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  // r2 is undefined when y has zero variance; report 1 for an exact flat fit
  // only when the slope is also zero (a perfectly predicted constant).
  const r2 = syy === 0 ? (slope === 0 ? 1 : 0) : (sxy * sxy) / (sxx * syy);
  return { slope, intercept, r2, n };
}

/**
 * Root-mean-square of a numeric array.
 * @param {number[]} values Values.
 * @returns {number|null} RMS, or null for an empty array.
 */
export function rms(values) {
  if (values.length === 0) {
    return null;
  }
  let s = 0;
  for (const v of values) {
    s += v * v;
  }
  return Math.sqrt(s / values.length);
}

/**
 * @typedef {object} DatumSample
 * @property {string} id Site id (must exist in DATUM_SITES).
 * @property {number|null} heightM Most-detailed sampled ellipsoidal height.
 * @property {Object<string, number|null>} [heightByLevelM] Per-LOD heights.
 */

/**
 * Reduce raw samples to the statistics the classifier reads.
 * @param {DatumSample[]} samples Raw per-site samples.
 * @returns {object} Summary statistics (all metres unless noted).
 */
export function summarizeSamples(samples) {
  const rows = [];
  for (const s of samples ?? []) {
    const site = siteById(s.id);
    if (!site) {
      continue;
    }
    rows.push({
      id: s.id,
      undulationM: site.undulationM,
      heightM: isNum(s.heightM) ? s.heightM : null,
      heightByLevelM: s.heightByLevelM ?? {},
    });
  }

  const withH = rows.filter((r) => r.heightM !== null);
  const hs = withH.map((r) => r.heightM);
  const ns = withH.map((r) => r.undulationM);

  // LOD dependence: per site, the spread across most-detailed + every sampled
  // level AT OR ABOVE LEVEL_DEPENDENCE_MIN_LEVEL. Any site exceeding the
  // threshold makes the whole survey LOD-dependent. Coarser levels are tracked
  // separately as `coarseLevelSpreadM` and never gate — at level 4 a tile still
  // spans ~11 deg, so a difference there is tessellation, not datum.
  let levelMaxSpreadM = 0;
  let levelWorstSiteId = null;
  let coarseMaxSpreadM = 0;
  const levelsUsed = new Set();
  for (const r of rows) {
    const vals = [];
    const allVals = [];
    if (r.heightM !== null) {
      vals.push(r.heightM);
      allVals.push(r.heightM);
    }
    for (const [levelKey, v] of Object.entries(r.heightByLevelM)) {
      if (!isNum(v)) {
        continue;
      }
      allVals.push(v);
      const level = Number(levelKey);
      if (
        Number.isFinite(level) &&
        level >= THRESHOLDS.LEVEL_DEPENDENCE_MIN_LEVEL
      ) {
        vals.push(v);
        levelsUsed.add(level);
      }
    }
    if (allVals.length >= 2) {
      coarseMaxSpreadM = Math.max(
        coarseMaxSpreadM,
        Math.max(...allVals) - Math.min(...allVals),
      );
    }
    if (vals.length < 2) {
      continue;
    }
    const spread = Math.max(...vals) - Math.min(...vals);
    if (spread > levelMaxSpreadM) {
      levelMaxSpreadM = spread;
      levelWorstSiteId = r.id;
    }
  }

  // Sign agreement over sites whose undulation is large enough to be a real test.
  const signRows = withH.filter(
    (r) => Math.abs(r.undulationM) >= THRESHOLDS.SIGN_TEST_MIN_ABS_UNDULATION_M,
  );
  const signHits = signRows.filter(
    (r) => Math.sign(r.heightM) === Math.sign(r.undulationM),
  ).length;

  return {
    n: rows.length,
    nWithHeight: withH.length,
    meanHeightM: hs.length ? hs.reduce((a, b) => a + b, 0) / hs.length : null,
    meanAbsHeightM: hs.length
      ? hs.reduce((a, b) => a + Math.abs(b), 0) / hs.length
      : null,
    maxAbsHeightM: hs.length ? Math.max(...hs.map(Math.abs)) : null,
    spreadM: hs.length ? Math.max(...hs) - Math.min(...hs) : null,
    rmsResidualVsEllipsoidM: rms(hs),
    rmsResidualVsGeoidM: rms(withH.map((r) => r.heightM - r.undulationM)),
    regression: linearRegression(ns, hs),
    signAgreement: signRows.length ? signHits / signRows.length : null,
    signTestSites: signRows.length,
    levelDependence: {
      maxSpreadM: levelMaxSpreadM,
      worstSiteId: levelWorstSiteId,
      dependent: levelMaxSpreadM > THRESHOLDS.LEVEL_DEPENDENCE_M,
      minLevelConsidered: THRESHOLDS.LEVEL_DEPENDENCE_MIN_LEVEL,
      levelsUsed: [...levelsUsed].sort((a, b) => a - b),
      // Informational only (includes coarse levels) — never gates.
      coarseLevelSpreadM: coarseMaxSpreadM,
    },
    perSite: rows.map((r) => ({
      id: r.id,
      undulationM: r.undulationM,
      heightM: r.heightM,
      residualVsEllipsoidM: r.heightM,
      residualVsGeoidM: r.heightM === null ? null : r.heightM - r.undulationM,
    })),
  };
}

/**
 * Classify the CWT ocean-lid vertical datum from the survey samples.
 * @param {DatumSample[]} samples Raw per-site samples.
 * @returns {{classification:string, subLabel:string|null, reasons:string[], stats:object}}
 */
export function classifyDatum(samples) {
  const stats = summarizeSamples(samples);
  const T = THRESHOLDS;
  const reasons = [];

  if (stats.nWithHeight < T.MIN_SITES_FOR_CLASSIFICATION) {
    reasons.push(
      `only ${stats.nWithHeight} site(s) returned a height (need ${T.MIN_SITES_FOR_CLASSIFICATION})`,
    );
    return {
      classification: "INSUFFICIENT_DATA",
      subLabel: null,
      reasons,
      stats,
    };
  }

  // A datum that varies with terrain LOD defeats any single-offset design, so
  // it is checked BEFORE the flat/geoid split.
  if (stats.levelDependence.dependent) {
    reasons.push(
      `terrain LODs disagree by ${stats.levelDependence.maxSpreadM.toFixed(2)} m at ${stats.levelDependence.worstSiteId} (> ${T.LEVEL_DEPENDENCE_M} m)`,
    );
    return {
      classification: "MIXED_OR_OTHER",
      subLabel: "LEVEL_DEPENDENT",
      reasons,
      stats,
    };
  }

  if (stats.maxAbsHeightM <= T.ELLIPSOID_ZERO_ABS_M) {
    reasons.push(
      `every site is within ${T.ELLIPSOID_ZERO_ABS_M} m of ellipsoidal 0 (max |h| = ${stats.maxAbsHeightM.toFixed(3)} m)`,
    );
    return {
      classification: "ELLIPSOID_ZERO",
      subLabel: null,
      reasons,
      stats,
    };
  }

  const reg = stats.regression;
  const geoidShaped =
    stats.spreadM >= T.GEOID_MIN_SPREAD_M &&
    isNum(reg.r2) &&
    reg.r2 >= T.GEOID_MIN_R2 &&
    isNum(stats.signAgreement) &&
    stats.signAgreement >= T.GEOID_MIN_SIGN_AGREEMENT;

  if (geoidShaped) {
    const slopeOk =
      isNum(reg.slope) &&
      reg.slope >= T.GEOID_SLOPE_MIN &&
      reg.slope <= T.GEOID_SLOPE_MAX;
    const interceptOk =
      isNum(reg.intercept) &&
      Math.abs(reg.intercept) <= T.GEOID_MAX_INTERCEPT_M;
    if (slopeOk && interceptOk) {
      reasons.push(
        `heights track the EGM2008 undulation: slope ${reg.slope.toFixed(3)}, intercept ${reg.intercept.toFixed(2)} m, r2 ${reg.r2.toFixed(3)}, sign agreement ${stats.signAgreement.toFixed(2)}`,
      );
      return { classification: "GEOID", subLabel: null, reasons, stats };
    }
    reasons.push(
      `spread is geoid-SHAPED (${stats.spreadM.toFixed(1)} m, r2 ${reg.r2.toFixed(3)}, sign agreement ${stats.signAgreement.toFixed(2)}) but slope ${isNum(reg.slope) ? reg.slope.toFixed(3) : "n/a"} / intercept ${isNum(reg.intercept) ? reg.intercept.toFixed(2) : "n/a"} m fall outside the band — EITHER the advisory reference table needs refining against an authoritative EGM2008 calculator, OR the lid carries a scaled/blended datum. Refine the table FIRST; do not read this as a settled mixed datum`,
    );
    return {
      classification: "MIXED_OR_OTHER",
      subLabel: "GEOID_SHAPED_SLOPE_MISMATCH",
      reasons,
      stats,
    };
  }

  if (
    stats.spreadM <= T.CONSTANT_OFFSET_MAX_SPREAD_M &&
    stats.meanAbsHeightM > T.ELLIPSOID_ZERO_ABS_M
  ) {
    reasons.push(
      `flat but not zero: spread ${stats.spreadM.toFixed(3)} m about a mean of ${stats.meanHeightM.toFixed(2)} m — a uniform datum shift`,
    );
    return {
      classification: "MIXED_OR_OTHER",
      subLabel: "CONSTANT_OFFSET",
      reasons,
      stats,
    };
  }

  if (
    isNum(reg.r2) &&
    reg.r2 >= T.PARTIAL_GEOID_MIN_R2 &&
    isNum(reg.slope) &&
    reg.slope >= T.PARTIAL_GEOID_SLOPE_MIN &&
    reg.slope < T.GEOID_SLOPE_MIN
  ) {
    reasons.push(
      `heights correlate with the undulation at a shrunken slope ${reg.slope.toFixed(3)} (r2 ${reg.r2.toFixed(3)}) — a blended/partial datum`,
    );
    return {
      classification: "MIXED_OR_OTHER",
      subLabel: "PARTIAL_GEOID",
      reasons,
      stats,
    };
  }

  reasons.push(
    `heights are neither flat-at-zero nor geoid-correlated: spread ${stats.spreadM.toFixed(2)} m, max |h| ${stats.maxAbsHeightM.toFixed(2)} m, r2 ${isNum(reg.r2) ? reg.r2.toFixed(3) : "n/a"}, slope ${isNum(reg.slope) ? reg.slope.toFixed(3) : "n/a"}`,
  );
  return {
    classification: "MIXED_OR_OTHER",
    subLabel: "UNCLASSIFIED",
    reasons,
    stats,
  };
}

/**
 * Lane 2 verdict: is the FFT patch's sea-level anchor co-planar with the CWT
 * waterline at a high-undulation coast?
 * @param {object} obs Observation.
 * @param {number|null} obs.anchorHeightM Patch anchor geodetic height.
 * @param {number|null} obs.terrainRawHeightM sampleTerrainMostDetailed height at the anchor.
 * @param {number|null} obs.terrainRenderedHeightM globe.getHeight at the anchor.
 * @param {number|null} [obs.meanAbsLumDelta] ON-vs-OFF canvas delta (patch visibility).
 * @param {number|null} [obs.baselineLumDelta] OFF-vs-OFF delta over the same
 *   frame span — the animated water-mask control the ON delta must beat.
 * @returns {{verdict:string, rawMinusAnchorM:number|null, renderedMinusAnchorM:number|null, patchVisible:boolean|null, patchVisibilityFloor:number|null}}
 */
export function patchAnchorVerdict(obs) {
  const a = isNum(obs?.anchorHeightM) ? obs.anchorHeightM : null;
  const raw = isNum(obs?.terrainRawHeightM) ? obs.terrainRawHeightM : null;
  const rend = isNum(obs?.terrainRenderedHeightM)
    ? obs.terrainRenderedHeightM
    : null;
  const rawMinusAnchorM = a === null || raw === null ? null : raw - a;
  const renderedMinusAnchorM = a === null || rend === null ? null : rend - a;
  // The base globe animates its water-mask waves, so "pixels changed" alone
  // does not prove the FFT patch rendered. Beat the OFF-vs-OFF baseline too.
  const baseline = isNum(obs?.baselineLumDelta) ? obs.baselineLumDelta : null;
  const patchVisibilityFloor = Math.max(
    THRESHOLDS.PATCH_VISIBLE_MIN_LUM_DELTA,
    (baseline ?? 0) * THRESHOLDS.PATCH_VISIBLE_BASELINE_FACTOR,
  );
  const patchVisible = isNum(obs?.meanAbsLumDelta)
    ? obs.meanAbsLumDelta >= patchVisibilityFloor
    : null;

  let verdict = "INDETERMINATE";
  const primary = rawMinusAnchorM ?? renderedMinusAnchorM;
  if (primary !== null) {
    verdict =
      Math.abs(primary) <= THRESHOLDS.PATCH_COPLANAR_ABS_M
        ? "COPLANAR"
        : primary > 0
          ? "PATCH_BELOW_WATERLINE"
          : "PATCH_ABOVE_WATERLINE";
  }
  return {
    verdict,
    rawMinusAnchorM,
    renderedMinusAnchorM,
    patchVisible,
    patchVisibilityFloor,
  };
}

/**
 * Lane 3 verdict: does scene.verticalExaggeration displace the ocean lid?
 *
 * Cesium's model is `h' = (h - relativeHeight) * scale + relativeHeight`
 * (Core/VerticalExaggeration.js). With relativeHeight 0 an ellipsoid-0 lid is a
 * FIXED POINT of that map (0*s = 0) and does not move; a geoid-carrying lid at
 * h = -100 m moves to -300 m at scale 3 — which is exactly the lake/ocean
 * gating bill Design B would inherit.
 *
 * @param {object} obs Observation.
 * @param {number} obs.exaggeration The exaggerated scale (e.g. 3.0).
 * @param {number} [obs.relativeHeightM=0] scene.verticalExaggerationRelativeHeight.
 * @param {number|null} obs.renderedH1M globe.getHeight at scale 1.
 * @param {number|null} obs.renderedH3M globe.getHeight at the exaggerated scale.
 * @param {number|null} [obs.rawH1M] sampleTerrain height at scale 1 (control).
 * @param {number|null} [obs.rawH3M] sampleTerrain height at the exaggerated scale.
 * @returns {object} Verdict + the modelled prediction.
 */
export function exaggerationVerdict(obs) {
  const T = THRESHOLDS;
  const scale = isNum(obs?.exaggeration) ? obs.exaggeration : null;
  const rel = isNum(obs?.relativeHeightM) ? obs.relativeHeightM : 0;
  const h1 = isNum(obs?.renderedH1M) ? obs.renderedH1M : null;
  const h3 = isNum(obs?.renderedH3M) ? obs.renderedH3M : null;
  const r1 = isNum(obs?.rawH1M) ? obs.rawH1M : null;
  const r3 = isNum(obs?.rawH3M) ? obs.rawH3M : null;

  const rawInvariant =
    r1 === null || r3 === null
      ? null
      : Math.abs(r3 - r1) <= T.EXAG_RAW_INVARIANT_M;

  if (scale === null || h1 === null || h3 === null) {
    return {
      verdict: "INDETERMINATE",
      predictedH3M: null,
      renderedDeltaM: null,
      modelResidualM: null,
      rawInvariant,
    };
  }

  const predictedH3M = (h1 - rel) * scale + rel;
  const renderedDeltaM = h3 - h1;
  const modelResidualM = h3 - predictedH3M;
  const displaces = Math.abs(renderedDeltaM) > T.EXAG_DISPLACEMENT_ABS_M;
  const tol = Math.max(
    T.EXAG_MODEL_TOL_ABS_M,
    T.EXAG_MODEL_TOL_REL * Math.abs(predictedH3M),
  );
  const consistent = Math.abs(modelResidualM) <= tol;

  return {
    verdict: !displaces
      ? "NO_DISPLACEMENT"
      : consistent
        ? "DISPLACES_AS_MODELED"
        : "DISPLACES_UNMODELED",
    predictedH3M,
    renderedDeltaM,
    modelResidualM,
    modelToleranceM: tol,
    rawInvariant,
  };
}

/**
 * The decision tree the three lanes feed. Returns the design consequence and
 * the probe's exit code.
 *
 * exit 0 — a clean, actionable answer (ELLIPSOID_ZERO or GEOID).
 * exit 1 — an answer was obtained but it is the MIXED/OTHER branch (or the
 *          survey was too thin): escalate to the T2 multi-vdatum adapter.
 *          NOT "the probe is broken" — see the design doc.
 * exit 2 — structural; assigned by the probe itself, never here.
 *
 * @param {object} lanes Lane results.
 * @param {{classification:string, subLabel:string|null}} lanes.datum Lane 1 classification.
 * @param {{verdict:string}} [lanes.patch] Lane 2 verdict.
 * @param {{verdict:string}[]} [lanes.exaggeration] Lane 3 per-site verdicts.
 * @returns {{datumHypothesis:string, subLabel:string|null, implication:string, patchImplication:string, exaggerationImplication:string, exitCode:number}}
 */
export function decisionFromLanes(lanes) {
  const cls = lanes?.datum?.classification ?? "INSUFFICIENT_DATA";
  const sub = lanes?.datum?.subLabel ?? null;

  let implication;
  let exitCode;
  switch (cls) {
    case "ELLIPSOID_ZERO":
      implication =
        "CWT's ocean lid sits at ellipsoidal 0. A tide offset rides RAW " +
        "ELLIPSOIDAL heights: OceanSurfacePrimitive's existing " +
        "scaleToGeodeticSurface anchor is already the correct sea-level datum, " +
        "and Design A adds tide alone along _a0Up. The T2 multi-vdatum " +
        "adapter is still required as ARCHITECTURE (other providers/datums), " +
        "but CWT itself contributes a zero geoid term.";
      exitCode = 0;
      break;
    case "GEOID": {
      // State-aware: this line used to assert the latent defect
      // UNCONDITIONALLY, which meant that once the fix landed (Batch 763) the
      // prose contradicted the probe's own lane-2 verdict — it printed
      // "LATENT DATUM DEFECT of up to ~100 m" directly above verdict COPLANAR.
      // The datum classification and the state of the shipped anchor are two
      // different questions; only lane 2 answers the second.
      const measured = lanes?.patch?.rawMinusAnchorM;
      const defectOpen =
        !isNum(measured) ||
        Math.abs(measured) > THRESHOLDS.PATCH_COPLANAR_ABS_M;
      implication =
        "CWT's ocean lid carries the geoid. Per ruling T2 the ocean-anchor " +
        "offset must carry GEOID + TIDE together. " +
        (defectOpen
          ? isNum(measured)
            ? `The shipped FFT ocean anchor is OFF THE LID by ${measured.toFixed(2)} m at the lane-2 site — a latent datum defect worth fixing independently of tides.`
            : "The shipped FFT ocean's anchor could not be compared with the lid at the lane-2 site, so whether the latent ~100 m datum defect is still open is UNMEASURED here."
          : `Datum defect RESOLVED at the lane-2 site — the anchor is co-planar with the lid to ${measured.toFixed(2)} m (C6-FFT-OCEAN-TIDE-DATUM). This lane now guards the fix rather than reporting the defect.`);
      exitCode = 0;
      break;
    }
    case "INSUFFICIENT_DATA":
      implication =
        "Too few sites returned a height to classify the datum. Re-run with " +
        "network access to ion; do not design against this result.";
      exitCode = 1;
      break;
    default:
      implication =
        `CWT's ocean lid is neither flat-at-zero nor a clean geoid (${sub}). ` +
        "Escalate to the T2 multi-vertical-datum adapter design: per-provider " +
        "datum metadata + manual override, with regional vdatum offsets riding " +
        "the same uniform. Do NOT hardcode a single geoid term.";
      exitCode = 1;
      break;
  }

  const patchVerdict = lanes?.patch?.verdict ?? "INDETERMINATE";
  const patchImplication =
    patchVerdict === "COPLANAR"
      ? "The FFT patch anchor is co-planar with the CWT waterline at the test coast — no v1 datum defect at that site."
      : patchVerdict === "PATCH_ABOVE_WATERLINE"
        ? "The FFT patch floats ABOVE the baked CWT sea — a visible v1 datum defect (raised water plateau)."
        : patchVerdict === "PATCH_BELOW_WATERLINE"
          ? "The FFT patch sits BELOW the baked CWT sea and is occluded by the opaque lid — the patch is effectively invisible at that site."
          : "The patch-vs-waterline offset could not be measured.";

  const exagVerdicts = (lanes?.exaggeration ?? []).map((e) => e.verdict);
  const anyDisplaced = exagVerdicts.some((v) => v && v.startsWith("DISPLACES"));
  const allNo =
    exagVerdicts.length > 0 &&
    exagVerdicts.every((v) => v === "NO_DISPLACEMENT");
  const exaggerationImplication = anyDisplaced
    ? "verticalExaggeration DOES displace the ocean lid — Design B inherits the full lake/ocean gating bill, and any tide term must compose with the exaggeration map rather than be added after it."
    : allNo
      ? "verticalExaggeration leaves the ocean lid fixed (ellipsoid 0 is a fixed point of the exaggeration map) — Design B's lake-gating bill is not amplified by exaggeration at these sites."
      : "The exaggeration response could not be determined.";

  return {
    datumHypothesis: cls,
    subLabel: sub,
    implication,
    patchImplication,
    exaggerationImplication,
    exitCode,
  };
}
