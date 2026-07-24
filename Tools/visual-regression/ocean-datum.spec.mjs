// ocean-datum.spec.mjs — analytic spec for the shared TIDES + OCEAN-DYNAMICS
// W0 datum probe (`node --test Tools/visual-regression/ocean-datum.spec.mjs`).
//
// Pins ALL pure math the probe's verdict rests on BEFORE any GPU or network is
// involved, so a wrong classification can never be blamed on the browser run:
//
//   (a) the EGM2008 reference table is physically sane (every undulation inside
//       the ±110 m model range), well-formed, and DISCRIMINATING (it actually
//       spans the range — a table of near-zero sites could not tell an
//       ellipsoid-0 lid from a geoid one).
//   (b) linearRegression / rms are correct on closed-form inputs and degrade to
//       nulls rather than NaN on degenerate ones.
//   (c) classifyDatum returns each of its labels on the synthetic input that
//       defines that label, and its thresholds are mutually consistent (the
//       branches cannot overlap or leave a gap).
//   (d) exaggerationVerdict implements Cesium's own exaggeration map
//       h' = (h - relativeHeight)·scale + relativeHeight, so "ellipsoid 0 is a
//       fixed point" is asserted, not assumed.
//   (e) patchAnchorVerdict signs are the ones the design doc reads
//       (terrain - anchor > 0  ⇒  the patch is BELOW the waterline).
//   (f) decisionFromLanes maps each classification to the documented exit code.
//   (g) the probe source and the model do not drift (site ids, levels).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CLASSIFICATIONS,
  CONFIDENCE_TAGS,
  DATUM_SITES,
  EGM2008_RANGE_M,
  MIXED_SUBLABELS,
  SURVEY_LEVELS,
  THRESHOLDS,
  classifyDatum,
  decisionFromLanes,
  exaggerationVerdict,
  linearRegression,
  patchAnchorVerdict,
  rms,
  siteById,
  summarizeSamples,
} from "./lib/ocean-datum-model.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const probeSource = fs.readFileSync(
  path.join(here, "probe-ocean-datum.mjs"),
  "utf8",
);

/** Build a full six-site sample set from a height-producing function. */
function samplesFrom(fn) {
  return DATUM_SITES.map((s, i) => ({ id: s.id, heightM: fn(s, i) }));
}

// ───────────────────────── (a) reference table ─────────────────────────

test("(a) every EGM2008 reference undulation is inside the physical ±110 m range", () => {
  assert.equal(EGM2008_RANGE_M.minM, -110);
  assert.equal(EGM2008_RANGE_M.maxM, 110);
  for (const s of DATUM_SITES) {
    assert.ok(
      Number.isFinite(s.undulationM),
      `${s.id}: undulationM must be a finite number`,
    );
    assert.ok(
      s.undulationM >= EGM2008_RANGE_M.minM &&
        s.undulationM <= EGM2008_RANGE_M.maxM,
      `${s.id}: undulation ${s.undulationM} m outside the physical EGM2008 range ±110 m`,
    );
    // The tolerance band must also stay physical — a site whose band escapes
    // the model range would let an impossible measurement "agree".
    assert.ok(
      s.undulationM - s.toleranceM >= EGM2008_RANGE_M.minM - 25 &&
        s.undulationM + s.toleranceM <= EGM2008_RANGE_M.maxM + 25,
      `${s.id}: tolerance band escapes the physical range`,
    );
  }
});

test("(a) the reference table is well-formed (ids, coords, bands, provenance)", () => {
  const ids = new Set();
  for (const s of DATUM_SITES) {
    assert.ok(typeof s.id === "string" && s.id.length > 0, "site id required");
    assert.ok(!ids.has(s.id), `duplicate site id ${s.id}`);
    ids.add(s.id);
    assert.ok(
      s.lonDeg >= -180 && s.lonDeg <= 180,
      `${s.id}: longitude out of range`,
    );
    assert.ok(s.latDeg >= -90 && s.latDeg <= 90, `${s.id}: latitude out of range`);
    assert.equal(s.water, true, `${s.id}: every survey site must be open water`);
    assert.ok(
      Number.isFinite(s.toleranceM) && s.toleranceM > 0,
      `${s.id}: toleranceM must be positive and finite`,
    );
    assert.ok(
      CONFIDENCE_TAGS.includes(s.confidence),
      `${s.id}: confidence "${s.confidence}" is not one of ${CONFIDENCE_TAGS.join("/")}`,
    );
    assert.ok(
      typeof s.source === "string" && /EGM2008/.test(s.source),
      `${s.id}: source must cite EGM2008`,
    );
    assert.ok(
      typeof s.why === "string" && s.why.length > 40,
      `${s.id}: needs a rationale for why this site is in the survey`,
    );
    assert.ok(Object.isFrozen(s), `${s.id}: site record must be frozen`);
  }
  assert.ok(DATUM_SITES.length >= 5, "need at least 5 survey sites");
});

test("(a) the table DISCRIMINATES — it spans the undulation range incl. a near-zero control", () => {
  const ns = DATUM_SITES.map((s) => s.undulationM);
  const min = Math.min(...ns);
  const max = Math.max(...ns);
  assert.ok(min <= -60, `need a strongly NEGATIVE site; min is ${min} m`);
  assert.ok(max >= 40, `need a strongly POSITIVE site; max is ${max} m`);
  assert.ok(
    max - min >= 120,
    `undulation span ${max - min} m is too narrow to separate the hypotheses`,
  );
  assert.ok(
    ns.some((n) => Math.abs(n) <= 20),
    "need at least one near-zero control site (reads ~0 under BOTH hypotheses)",
  );
  // The span must dwarf the flat-lid tolerance, otherwise the two hypotheses
  // are not separable at all.
  assert.ok(
    max - min > 10 * THRESHOLDS.ELLIPSOID_ZERO_ABS_M,
    "undulation span must dwarf the ellipsoid-zero tolerance",
  );
  // And there must be enough strong-|N| sites for the sign test to mean anything.
  const strong = ns.filter(
    (n) => Math.abs(n) >= THRESHOLDS.SIGN_TEST_MIN_ABS_UNDULATION_M,
  );
  assert.ok(strong.length >= 3, "need >= 3 strong-|N| sites for the sign test");
});

test("(a) siteById resolves every table entry and nothing else", () => {
  for (const s of DATUM_SITES) {
    assert.equal(siteById(s.id), s);
  }
  assert.equal(siteById("NO-SUCH-SITE"), undefined);
});

// ───────────────────────── (b) regression / rms ─────────────────────────

test("(b) linearRegression recovers a known line exactly", () => {
  const xs = [-100, -40, 5, 30, 60, 65];
  const ys = xs.map((x) => 2.5 * x - 7.0);
  const r = linearRegression(xs, ys);
  assert.ok(Math.abs(r.slope - 2.5) < 1e-9, `slope ${r.slope}`);
  assert.ok(Math.abs(r.intercept + 7.0) < 1e-9, `intercept ${r.intercept}`);
  assert.ok(Math.abs(r.r2 - 1) < 1e-9, `r2 ${r.r2}`);
  assert.equal(r.n, 6);
});

test("(b) linearRegression degrades to nulls, never NaN", () => {
  assert.deepEqual(linearRegression([], []), {
    slope: null,
    intercept: null,
    r2: null,
    n: 0,
  });
  assert.deepEqual(linearRegression([3], [4]), {
    slope: null,
    intercept: null,
    r2: null,
    n: 1,
  });
  // Zero x-variance: no line is determined.
  const flat = linearRegression([5, 5, 5], [1, 2, 3]);
  assert.equal(flat.slope, null);
  assert.equal(flat.r2, null);
});

test("(b) linearRegression: a perfectly flat y is a perfect fit at slope 0", () => {
  const r = linearRegression([-100, 0, 60], [0, 0, 0]);
  assert.equal(r.slope, 0);
  assert.equal(r.intercept, 0);
  assert.equal(r.r2, 1);
});

test("(b) rms is the root-mean-square and null on empty", () => {
  assert.equal(rms([]), null);
  assert.equal(rms([3, 4]), Math.sqrt((9 + 16) / 2));
  assert.equal(rms([0, 0, 0]), 0);
});

// ───────────────────────── (c) classification ─────────────────────────

test("(c) thresholds are mutually consistent (no overlapping or empty branches)", () => {
  const T = THRESHOLDS;
  assert.ok(
    T.ELLIPSOID_ZERO_ABS_M < T.GEOID_MIN_SPREAD_M,
    "a flat-zero lid must not also qualify as a geoid spread",
  );
  assert.ok(
    T.CONSTANT_OFFSET_MAX_SPREAD_M < T.GEOID_MIN_SPREAD_M,
    "the constant-offset branch must not overlap the geoid branch",
  );
  assert.ok(
    T.GEOID_SLOPE_MIN < 1 && T.GEOID_SLOPE_MAX > 1,
    "the geoid slope band must bracket 1.0",
  );
  assert.ok(
    T.PARTIAL_GEOID_SLOPE_MIN < T.GEOID_SLOPE_MIN,
    "the partial-geoid slope band must sit below the geoid band",
  );
  assert.ok(
    T.PARTIAL_GEOID_MIN_R2 <= T.GEOID_MIN_R2,
    "partial geoid must not demand a tighter fit than a full geoid",
  );
  assert.ok(
    T.GEOID_MIN_SIGN_AGREEMENT > 0.5 && T.GEOID_MIN_SIGN_AGREEMENT <= 1,
    "sign agreement must beat a coin flip",
  );
  assert.ok(
    T.LEVEL_DEPENDENCE_M > 0 && T.LEVEL_DEPENDENCE_M <= T.ELLIPSOID_ZERO_ABS_M,
    "LOD disagreement must be detectable at or below the flat-lid tolerance",
  );
  assert.ok(
    Number.isInteger(T.LEVEL_DEPENDENCE_MIN_LEVEL) &&
      T.LEVEL_DEPENDENCE_MIN_LEVEL >= 6,
    "coarse tiles (level < 6) reach too far to be datum evidence",
  );
  assert.ok(
    T.PATCH_VISIBLE_BASELINE_FACTOR > 1,
    "the ON delta must strictly beat the animated-water baseline",
  );
  assert.ok(T.MIN_SITES_FOR_CLASSIFICATION >= 3);
});

test("(c) ELLIPSOID_ZERO — a flat lid at ellipsoidal 0", () => {
  const r = classifyDatum(
    DATUM_SITES.map((s) => ({
      id: s.id,
      heightM: 0.0,
      heightByLevelM: { 0: 0.0, 4: 0.0, 8: 0.0 },
    })),
  );
  assert.equal(r.classification, "ELLIPSOID_ZERO");
  assert.equal(r.subLabel, null);
  assert.equal(r.stats.maxAbsHeightM, 0);
  assert.equal(r.stats.levelDependence.dependent, false);
});

test("(c) ELLIPSOID_ZERO tolerates sub-metre tile-decode noise", () => {
  const r = classifyDatum(samplesFrom((_s, i) => (i % 2 ? 0.4 : -0.7)));
  assert.equal(r.classification, "ELLIPSOID_ZERO");
});

test("(c) GEOID — heights equal to the undulations", () => {
  const r = classifyDatum(samplesFrom((s) => s.undulationM));
  assert.equal(r.classification, "GEOID");
  assert.equal(r.subLabel, null);
  assert.ok(Math.abs(r.stats.regression.slope - 1) < 1e-9);
  assert.ok(Math.abs(r.stats.regression.intercept) < 1e-9);
  assert.equal(r.stats.signAgreement, 1);
  assert.ok(r.stats.rmsResidualVsGeoidM < 1e-9);
  assert.ok(r.stats.rmsResidualVsEllipsoidM > 40);
});

test("(c) GEOID survives realistic table error (±10 m per site)", () => {
  const jitter = [8, -9, 6, -7, 4, -5];
  const r = classifyDatum(samplesFrom((s, i) => s.undulationM + jitter[i]));
  assert.equal(
    r.classification,
    "GEOID",
    `advisory-table error must not flip the call: ${JSON.stringify(r.stats.regression)}`,
  );
});

test("(c) GEOID_SHAPED_SLOPE_MISMATCH — geoid-shaped but the slope is off", () => {
  const r = classifyDatum(samplesFrom((s) => 2.0 * s.undulationM));
  assert.equal(r.classification, "MIXED_OR_OTHER");
  assert.equal(r.subLabel, "GEOID_SHAPED_SLOPE_MISMATCH");
  assert.match(r.reasons[0], /refining|refine/i);
});

test("(c) CONSTANT_OFFSET — flat but not zero", () => {
  const r = classifyDatum(samplesFrom(() => 5.0));
  assert.equal(r.classification, "MIXED_OR_OTHER");
  assert.equal(r.subLabel, "CONSTANT_OFFSET");
  assert.equal(r.stats.spreadM, 0);
  assert.equal(r.stats.meanHeightM, 5.0);
});

test("(c) PARTIAL_GEOID — correlated but shrunken, below the geoid spread", () => {
  // Three mid-range sites only: correlation is perfect but the spread never
  // reaches GEOID_MIN_SPREAD_M, which is the blended-datum signature.
  const subset = ["HUDSON-LOW", "PAC-MID", "ATL-MID"];
  const r = classifyDatum(
    DATUM_SITES.filter((s) => subset.includes(s.id)).map((s) => ({
      id: s.id,
      heightM: 0.3 * s.undulationM,
    })),
  );
  assert.equal(r.classification, "MIXED_OR_OTHER");
  assert.equal(r.subLabel, "PARTIAL_GEOID");
});

test("(c) LEVEL_DEPENDENT wins over every other label", () => {
  const samples = DATUM_SITES.map((s, i) => ({
    id: s.id,
    heightM: 0.0,
    heightByLevelM: i === 2 ? { 8: 30.0, 11: 0.0 } : { 8: 0.0, 11: 0.0 },
  }));
  const r = classifyDatum(samples);
  assert.equal(r.classification, "MIXED_OR_OTHER");
  assert.equal(r.subLabel, "LEVEL_DEPENDENT");
  assert.equal(r.stats.levelDependence.worstSiteId, DATUM_SITES[2].id);
  assert.equal(r.stats.levelDependence.maxSpreadM, 30);
});

test("(c) COARSE-LOD disagreement is informational, NOT a datum verdict", () => {
  // A level-4 tile spans ~11 deg: a big height there is tessellation reach, not
  // a datum. It must be reported but must not flip the classification.
  const samples = DATUM_SITES.map((s) => ({
    id: s.id,
    heightM: 0.0,
    heightByLevelM: { 4: 40.0, 8: 0.0, 11: 0.0 },
  }));
  const r = classifyDatum(samples);
  assert.equal(r.classification, "ELLIPSOID_ZERO");
  assert.equal(r.stats.levelDependence.dependent, false);
  assert.equal(r.stats.levelDependence.coarseLevelSpreadM, 40);
  assert.deepEqual(r.stats.levelDependence.levelsUsed, [8, 11]);
  assert.equal(
    r.stats.levelDependence.minLevelConsidered,
    THRESHOLDS.LEVEL_DEPENDENCE_MIN_LEVEL,
  );
});

test("(c) UNCLASSIFIED — scattered heights with no geoid structure", () => {
  const r = classifyDatum(samplesFrom((_s, i) => (i % 2 ? -10 : 10)));
  assert.equal(r.classification, "MIXED_OR_OTHER");
  assert.equal(r.subLabel, "UNCLASSIFIED");
});

test("(c) INSUFFICIENT_DATA when too few sites return a height", () => {
  const r = classifyDatum(
    DATUM_SITES.map((s, i) => ({ id: s.id, heightM: i < 2 ? 0 : null })),
  );
  assert.equal(r.classification, "INSUFFICIENT_DATA");
  assert.equal(r.stats.nWithHeight, 2);
});

test("(c) unknown site ids are dropped rather than poisoning the fit", () => {
  const stats = summarizeSamples([
    { id: "IND-LOW", heightM: 0 },
    { id: "NOT-A-SITE", heightM: 9999 },
  ]);
  assert.equal(stats.n, 1);
  assert.equal(stats.maxAbsHeightM, 0);
});

test("(c) every returned label is a declared label", () => {
  const cases = [
    samplesFrom(() => 0),
    samplesFrom((s) => s.undulationM),
    samplesFrom(() => 5),
    samplesFrom((s) => 2 * s.undulationM),
    samplesFrom((_s, i) => (i % 2 ? -10 : 10)),
  ];
  for (const c of cases) {
    const r = classifyDatum(c);
    assert.ok(
      CLASSIFICATIONS.includes(r.classification),
      `undeclared classification ${r.classification}`,
    );
    if (r.subLabel !== null) {
      assert.ok(
        MIXED_SUBLABELS.includes(r.subLabel),
        `undeclared subLabel ${r.subLabel}`,
      );
    }
    assert.ok(r.reasons.length > 0, "every classification must state a reason");
  }
});

// ───────────────────── (d) vertical exaggeration ─────────────────────

test("(d) ellipsoid 0 is a FIXED POINT of the exaggeration map", () => {
  const r = exaggerationVerdict({
    exaggeration: 3.0,
    relativeHeightM: 0.0,
    renderedH1M: 0.0,
    renderedH3M: 0.0,
    rawH1M: 0.0,
    rawH3M: 0.0,
  });
  assert.equal(r.verdict, "NO_DISPLACEMENT");
  assert.equal(r.predictedH3M, 0);
  assert.equal(r.renderedDeltaM, 0);
  assert.equal(r.rawInvariant, true);
});

test("(d) a geoid-carrying lid at -100 m drops to -300 m at scale 3", () => {
  const r = exaggerationVerdict({
    exaggeration: 3.0,
    relativeHeightM: 0.0,
    renderedH1M: -100.0,
    renderedH3M: -300.0,
    rawH1M: -100.0,
    rawH3M: -100.0,
  });
  assert.equal(r.verdict, "DISPLACES_AS_MODELED");
  assert.equal(r.predictedH3M, -300);
  assert.equal(r.renderedDeltaM, -200);
  assert.equal(r.modelResidualM, 0);
  assert.equal(r.rawInvariant, true, "raw sampleTerrain must be exaggeration-free");
});

test("(d) a non-zero relativeHeight shifts the fixed point", () => {
  // With relativeHeight = 50, the fixed point is h = 50, not h = 0.
  const fixed = exaggerationVerdict({
    exaggeration: 3.0,
    relativeHeightM: 50.0,
    renderedH1M: 50.0,
    renderedH3M: 50.0,
  });
  assert.equal(fixed.verdict, "NO_DISPLACEMENT");
  const moved = exaggerationVerdict({
    exaggeration: 3.0,
    relativeHeightM: 50.0,
    renderedH1M: 0.0,
    renderedH3M: -100.0,
  });
  assert.equal(moved.predictedH3M, -100);
  assert.equal(moved.verdict, "DISPLACES_AS_MODELED");
});

test("(d) displacement that does NOT follow the map is flagged", () => {
  const r = exaggerationVerdict({
    exaggeration: 3.0,
    relativeHeightM: 0.0,
    renderedH1M: -100.0,
    renderedH3M: -150.0,
  });
  assert.equal(r.verdict, "DISPLACES_UNMODELED");
  assert.equal(r.modelResidualM, 150);
});

test("(d) missing inputs are INDETERMINATE, never a silent pass", () => {
  assert.equal(
    exaggerationVerdict({ exaggeration: 3, renderedH1M: null, renderedH3M: 0 })
      .verdict,
    "INDETERMINATE",
  );
  assert.equal(exaggerationVerdict({}).verdict, "INDETERMINATE");
  assert.equal(exaggerationVerdict({}).rawInvariant, null);
});

test("(d) raw-height drift under exaggeration is reported as a control failure", () => {
  const r = exaggerationVerdict({
    exaggeration: 3.0,
    renderedH1M: 0.0,
    renderedH3M: 0.0,
    rawH1M: 0.0,
    rawH3M: 7.0,
  });
  assert.equal(r.rawInvariant, false);
});

// ───────────────────── (e) patch anchor vs waterline ─────────────────────

test("(e) patchAnchorVerdict sign convention: terrain - anchor", () => {
  const coplanar = patchAnchorVerdict({
    anchorHeightM: 0,
    terrainRawHeightM: 0.3,
    terrainRenderedHeightM: 0.2,
    meanAbsLumDelta: 12,
  });
  assert.equal(coplanar.verdict, "COPLANAR");
  assert.equal(coplanar.patchVisible, true);
  assert.ok(Math.abs(coplanar.rawMinusAnchorM - 0.3) < 1e-12);

  // Geoid lid at -95 m with an ellipsoid-0 patch: terrain - anchor = -95 ⇒ the
  // patch floats ABOVE the baked sea.
  const above = patchAnchorVerdict({
    anchorHeightM: 0,
    terrainRawHeightM: -95,
    terrainRenderedHeightM: -95,
  });
  assert.equal(above.verdict, "PATCH_ABOVE_WATERLINE");

  const below = patchAnchorVerdict({
    anchorHeightM: 0,
    terrainRawHeightM: 40,
    terrainRenderedHeightM: 40,
  });
  assert.equal(below.verdict, "PATCH_BELOW_WATERLINE");
});

test("(e) patchAnchorVerdict is INDETERMINATE without both heights", () => {
  const r = patchAnchorVerdict({ anchorHeightM: 0 });
  assert.equal(r.verdict, "INDETERMINATE");
  assert.equal(r.rawMinusAnchorM, null);
  assert.equal(r.patchVisible, null);
});

test("(e) an invisible patch is reported, so a 0 offset cannot be a null result", () => {
  const r = patchAnchorVerdict({
    anchorHeightM: 0,
    terrainRawHeightM: 0,
    terrainRenderedHeightM: 0,
    meanAbsLumDelta: 0.0,
  });
  assert.equal(r.verdict, "COPLANAR");
  assert.equal(r.patchVisible, false);
});

test("(e) patch visibility must beat the animated water-mask baseline", () => {
  // Animated water mask alone moves ~4 luminance units over the frame span; an
  // ON delta of the same size is NOT evidence that the FFT patch rendered.
  const notVisible = patchAnchorVerdict({
    anchorHeightM: 0,
    terrainRawHeightM: 0,
    terrainRenderedHeightM: 0,
    meanAbsLumDelta: 4.2,
    baselineLumDelta: 4.0,
  });
  assert.equal(notVisible.patchVisible, false);
  assert.equal(
    notVisible.patchVisibilityFloor,
    4.0 * THRESHOLDS.PATCH_VISIBLE_BASELINE_FACTOR,
  );

  const visible = patchAnchorVerdict({
    anchorHeightM: 0,
    terrainRawHeightM: 0,
    terrainRenderedHeightM: 0,
    meanAbsLumDelta: 20.0,
    baselineLumDelta: 4.0,
  });
  assert.equal(visible.patchVisible, true);

  // With no baseline the floor degrades to the absolute minimum, never to 0.
  const noBaseline = patchAnchorVerdict({
    anchorHeightM: 0,
    terrainRawHeightM: 0,
    terrainRenderedHeightM: 0,
    meanAbsLumDelta: 1.0,
  });
  assert.equal(
    noBaseline.patchVisibilityFloor,
    THRESHOLDS.PATCH_VISIBLE_MIN_LUM_DELTA,
  );
  assert.equal(noBaseline.patchVisible, true);
});

// ───────────────────── (f) decision tree / exit codes ─────────────────────

test("(f) exit codes follow the documented decision tree", () => {
  const ell = decisionFromLanes({
    datum: { classification: "ELLIPSOID_ZERO", subLabel: null },
  });
  assert.equal(ell.exitCode, 0);
  assert.match(ell.implication, /RAW ELLIPSOIDAL/);

  const geoid = decisionFromLanes({
    datum: { classification: "GEOID", subLabel: null },
  });
  assert.equal(geoid.exitCode, 0);
  assert.match(geoid.implication, /GEOID \+ TIDE together/i);
  assert.match(geoid.implication, /LATENT DATUM DEFECT/i);

  for (const sub of MIXED_SUBLABELS) {
    const mixed = decisionFromLanes({
      datum: { classification: "MIXED_OR_OTHER", subLabel: sub },
    });
    assert.equal(mixed.exitCode, 1, `${sub} must escalate (exit 1)`);
    assert.match(mixed.implication, /multi-vertical-datum/i);
  }

  const thin = decisionFromLanes({
    datum: { classification: "INSUFFICIENT_DATA", subLabel: null },
  });
  assert.equal(thin.exitCode, 1);
});

test("(f) lane 2 / lane 3 implications are reported for every verdict", () => {
  const d = decisionFromLanes({
    datum: { classification: "GEOID", subLabel: null },
    patch: { verdict: "PATCH_ABOVE_WATERLINE" },
    exaggeration: [{ verdict: "DISPLACES_AS_MODELED" }, { verdict: "NO_DISPLACEMENT" }],
  });
  assert.match(d.patchImplication, /ABOVE/);
  assert.match(d.exaggerationImplication, /DOES displace/);

  const flat = decisionFromLanes({
    datum: { classification: "ELLIPSOID_ZERO", subLabel: null },
    patch: { verdict: "COPLANAR" },
    exaggeration: [{ verdict: "NO_DISPLACEMENT" }, { verdict: "NO_DISPLACEMENT" }],
  });
  assert.match(flat.patchImplication, /co-planar/i);
  assert.match(flat.exaggerationImplication, /fixed point/i);

  const unknown = decisionFromLanes({
    datum: { classification: "ELLIPSOID_ZERO", subLabel: null },
  });
  assert.match(unknown.patchImplication, /could not be measured/i);
  assert.match(unknown.exaggerationImplication, /could not be determined/i);
});

// ───────────────────── (g) probe <-> model drift guards ─────────────────────

test("(g) the probe imports its math from the model (no inlined duplicate)", () => {
  assert.match(
    probeSource,
    /from "\.\/lib\/ocean-datum-model\.mjs"/,
    "the probe must import the shared model",
  );
  for (const symbol of [
    "classifyDatum",
    "decisionFromLanes",
    "exaggerationVerdict",
    "patchAnchorVerdict",
    "DATUM_SITES",
    "SURVEY_LEVELS",
  ]) {
    assert.ok(
      probeSource.includes(symbol),
      `probe must use the model's ${symbol}`,
    );
  }
});

test("(g) the probe's exaggeration lane targets real, declared sites", () => {
  const m = probeSource.match(/EXAG_SITE_IDS\s*=\s*Object\.freeze\(\[([^\]]*)\]\)/);
  assert.ok(m, "EXAG_SITE_IDS not found in the probe");
  const ids = m[1]
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter((s) => s.length > 0);
  assert.ok(ids.length >= 2, "the exaggeration lane needs a lever and a control");
  for (const id of ids) {
    assert.ok(siteById(id), `EXAG_SITE_IDS references unknown site ${id}`);
  }
  // One strong-|N| lever + one near-zero control is what makes the lane
  // interpretable: the lever moves under a geoid lid, the control never does.
  const undulations = ids.map((id) => siteById(id).undulationM);
  assert.ok(
    Math.max(...undulations.map(Math.abs)) >= 60,
    "the exaggeration lane needs a high-|undulation| lever site",
  );
  assert.ok(
    Math.min(...undulations.map(Math.abs)) <= 20,
    "the exaggeration lane needs a near-zero control site",
  );
});

test("(g) survey levels ascend, skip the over-coarse tiles, and can detect drift", () => {
  assert.ok(SURVEY_LEVELS.length >= 2, "need >= 2 fixed levels to detect LOD drift");
  for (let i = 0; i < SURVEY_LEVELS.length; i++) {
    assert.ok(Number.isInteger(SURVEY_LEVELS[i]), "levels must be integers");
    assert.ok(SURVEY_LEVELS[i] >= 4 && SURVEY_LEVELS[i] <= 15, "level out of range");
    if (i > 0) {
      assert.ok(SURVEY_LEVELS[i] > SURVEY_LEVELS[i - 1], "levels must ascend");
    }
  }
  const gating = SURVEY_LEVELS.filter(
    (l) => l >= THRESHOLDS.LEVEL_DEPENDENCE_MIN_LEVEL,
  );
  assert.ok(
    gating.length >= 2,
    "need >= 2 levels at or above LEVEL_DEPENDENCE_MIN_LEVEL, else the LOD-dependence detector can never fire",
  );
});

test("(g) the patch lane's baseline span equals its ocean span (fair control)", () => {
  const baseline = probeSource.match(/patchBaseline:\s*(\d+)/);
  const ocean = probeSource.match(/patchOcean:\s*(\d+)/);
  assert.ok(baseline && ocean, "patchBaseline/patchOcean frame counts not found");
  assert.equal(
    baseline[1],
    ocean[1],
    "the OFF-vs-OFF control must span the same number of frames as the OFF-vs-ON measurement",
  );
});

test("(g) the probe declares a watchdog, bounded loops and the 0/1/2 exit contract", () => {
  assert.match(probeSource, /HARD_LIMIT_MS\s*=\s*\d+/, "watchdog limit missing");
  assert.match(probeSource, /watchdog\.unref/, "watchdog must be unref'd");
  assert.match(probeSource, /process\.exit\(2\)/, "structural exit 2 missing");
  assert.match(probeSource, /IN_PAGE_TIMEOUT_MS/, "in-page awaits must be bounded");
  assert.ok(
    !/while\s*\(\s*true\s*\)/.test(probeSource),
    "no unbounded while(true) loops",
  );
  // Fleet capture rules: canvas-element PNG via a 2d copy, same-task grab.
  assert.match(probeSource, /toDataURL\("image\/png"\)/, "canvas-element PNG missing");
  assert.match(probeSource, /useDefaultRenderLoop = false/, "default render loop must be off");
});
