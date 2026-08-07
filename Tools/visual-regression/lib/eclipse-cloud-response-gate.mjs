/**
 * The GATE half of `probe-eclipse-cloud-response.mjs` — C13-41's Edge
 * acceptance predicates, their pre-registered bands, and the fold that turns a
 * run's measurements into a verdict.
 *
 * WHY THIS IS ITS OWN MODULE, AND NOT A `judge()` INSIDE THE PROBE. The same
 * reason `eclipse-ladder-rungs.mjs` exists: a predicate that lives inside a
 * Playwright driver can only be exercised by a full browser run, so its own
 * arithmetic is never tested. Every number below is derivable without an
 * adapter, and `eclipse-cloud-response-gate.spec.mjs` proves the composition —
 * including that each gating predicate can FAIL, which is the property a
 * gate-with-no-mutant silently lacks.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE THREE PRE-REGISTERED PREDICTIONS (C13-41, Batch 871), and where each one
 * is measured
 * ─────────────────────────────────────────────────────────────────────────────
 *   (i)   deck lighting — at obscuration 0.9 the PRE-tonemap deck radiance
 *         ratio is exactly 0.4642; the DISPLAYED ratio lands in [0.46, ~0.63],
 *         never above ~0.7.                       -> `deckRatioInBand`
 *   (ii)  cloud shadow — the ground contrast `mix(1, 0.35, s)` moves
 *         0.350000 -> 0.350293, i.e. +0.08%; a LARGE measured change REFUTES
 *         the model.                              -> `shadowContrastInvariant`
 *   (iii) IBL refresh — a 0 -> 0.9 -> 0 sweep produces exactly 275 environment
 *         refreshes (1 baseline + 2 x 137 bucket edges, buckets 256 -> 119),
 *         quiescent on roughly two thirds of an 801-frame sweep.
 *                             -> `predictedRefreshCountExact` + the two engine
 *                                count bands + `sweepQuiescenceInBand`
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERY BAND IS `DERIVED` UNTIL THE FIRST EDGE RUN
 * ─────────────────────────────────────────────────────────────────────────────
 * No band here was fitted to a measurement, because no measurement exists yet —
 * this probe has never run. Each carries its derivation in `why`. After the
 * first Edge run the orchestrator may TIGHTEN a band against the observed
 * margin; widening one to make a run pass is the failure mode this note exists
 * to make visible.
 */

/** The engine's totality floor, recomputed from the two published illuminances
 * rather than imported, so a silent retune of the engine constant fails the
 * probe instead of riding along with it. */
export const ECLIPSE_RADIOMETRIC_FLOOR = 5.0 / 100000.0;
/** The eye-adaptation exponent S2 carries unless `eclipseAutoExposure` is on. */
export const ECLIPSE_ADAPTATION_EXPONENT = 1.0 / 3.0;
/** The 1/256 unit grid the environment-refresh input snaps to. */
export const ENV_REFRESH_STEPS = 256;

/** The sweep's peak obscuration — the row's own `0 -> 0.9 -> 0`. */
export const SWEEP_PEAK_OBSCURATION = 0.9;
/** Frames on the rising branch, inclusive of both ends. */
export const SWEEP_RISING_FRAMES = 401;
/** Total sweep frames: rising + the reverse replay with the peak not repeated. */
export const SWEEP_FRAMES = SWEEP_RISING_FRAMES * 2 - 1;

/**
 * S2's scene-light curve, reimplemented from the published constants. A SECOND
 * implementation on purpose: a gate that echoed `getEclipseSceneLightFactor`
 * would certify that the engine agrees with itself.
 *
 * @param {number} obscuration
 * @param {boolean} [autoExposure=false] Ruling E2's linear radiometric mode.
 * @returns {number}
 */
export function predictFactor(obscuration, autoExposure = false) {
  if (!(obscuration > 0)) {
    return 1.0;
  }
  const visible = obscuration >= 1 ? 0 : 1 - obscuration;
  const flux = visible + ECLIPSE_RADIOMETRIC_FLOOR * (1 - visible);
  return autoExposure ? flux : Math.pow(flux, ECLIPSE_ADAPTATION_EXPONENT);
}

/**
 * C13-41's DIRECTIONAL fraction — the share of the surviving flux a cast
 * shadow can still modulate. Deliberately NOT the scene factor: see
 * `shadowContrastRejectsAlternativeDesign` for the arithmetic that rules the
 * substitution out.
 *
 * @param {number} obscuration
 * @returns {number} exactly 1.0 at zero obscuration, exactly 0 at totality
 */
export function predictDirectional(obscuration) {
  if (!(obscuration > 0)) {
    return 1.0;
  }
  const visible = obscuration >= 1 ? 0 : 1 - obscuration;
  const flux = visible + ECLIPSE_RADIOMETRIC_FLOOR * (1 - visible);
  return flux > 0 ? visible / flux : 0;
}

/**
 * The refresh grid: an exact integer bucket. Bucket `k` covers
 * `[(k - 0.5)/256, (k + 0.5)/256)`, so the identity bucket 256 covers a factor
 * at or above 0.998046875.
 *
 * @param {number} factor
 * @returns {number}
 */
export function predictBucket(factor) {
  const clamped =
    typeof factor === "number" && factor >= 0 && factor <= 1 ? factor : 1;
  return Math.round(clamped * ENV_REFRESH_STEPS);
}

/**
 * The shadowed-ground contrast term the globe applies, `mix(1, T, s)` with the
 * beer floor T = 0.35. Used by both the invariance gate and its refutation
 * control.
 *
 * @param {number} strength The published `shadowStrength`.
 * @returns {number}
 */
export function shadowContrast(strength) {
  return 1.0 - 0.65 * strength;
}

/** Beer floor the globe's cloud-shadow mix targets. */
export const CLOUD_SHADOW_BEER_FLOOR = 0.35;

/**
 * Counts LEVEL CHANGES in a committed-bucket series, which is what an
 * environment refresh count is: the managers commit the bucket only inside the
 * branch that actually re-fills, so one transition is one fill. A series that
 * jumps two buckets in one step is ONE change, not two — which is exactly why
 * the ramp has to be fine enough not to skip.
 *
 * @param {Array<number>} series
 * @param {number} [seed=Number.NaN] The committed level before the series.
 * @returns {number}
 */
export function countBucketChanges(series, seed = Number.NaN) {
  let changes = 0;
  let previous = seed;
  for (const value of series) {
    if (!Object.is(value, previous)) {
      changes++;
      previous = value;
    }
  }
  return changes;
}

/**
 * The IDEAL sweep's bucket series: the linear obscuration ramp `0 -> 0.9`
 * across `SWEEP_RISING_FRAMES`, then its reverse replay.
 *
 * @returns {Array<number>}
 */
export function idealSweepBuckets() {
  const rising = [];
  for (let k = 0; k < SWEEP_RISING_FRAMES; k++) {
    const obscuration =
      (SWEEP_PEAK_OBSCURATION * k) / (SWEEP_RISING_FRAMES - 1);
    rising.push(predictBucket(predictFactor(obscuration)));
  }
  const full = rising.slice();
  for (let k = SWEEP_RISING_FRAMES - 2; k >= 0; k--) {
    full.push(rising[k]);
  }
  return full;
}

/**
 * The row's headline number: `1 + 2 x 137`. Computed rather than written down,
 * so a retune of the curve, the exponent, the floor or the grid moves it and
 * the gate notices.
 *
 * @returns {number}
 */
export function predictedSweepRefreshCount() {
  // The first commit walks NaN -> 256 during the warm-up, before the sweep's
  // first frame; the sweep itself then contributes its own level changes.
  const buckets = idealSweepBuckets();
  return 1 + countBucketChanges(buckets, buckets[0]);
}

/**
 * Largest single-frame bucket jump in a series. Must be at most 1, or the ramp
 * skipped an edge and the refresh count collapses toward the number of jumps
 * rather than the number of edges.
 *
 * @param {Array<number>} series
 * @returns {number}
 */
export function maxBucketStep(series) {
  let worst = 0;
  for (let i = 1; i < series.length; i++) {
    const a = series[i - 1];
    const b = series[i];
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      continue;
    }
    const step = Math.abs(b - a);
    if (step > worst) {
      worst = step;
    }
  }
  return worst;
}

const band = (lo, hi, why) => Object.freeze({ lo, hi, why, status: "DERIVED" });

/**
 * Every pre-registered band, each with its derivation. `status: "DERIVED"`
 * until the first Edge run confirms the margin.
 */
export const ECLIPSE_CLOUD_BANDS = Object.freeze({
  /** Lane A/B ladder targets. 0.5452 is the discriminating rung — see below. */
  ladderTargets: Object.freeze([0.0, 0.3, 0.5452, SWEEP_PEAK_OBSCURATION]),

  deckDisplayedRatio: band(
    0.44,
    0.7,
    "prediction (i) verbatim: the PRE-tonemap ratio is exactly 0.4642 and the row states the DISPLAYED ratio lands between 0.46 and ~0.63, never above ~0.7. The upper bound is the row's own ceiling. The lower bound is 0.4642 minus a 5% relative allowance (0.0232) for 8-bit quantization on a DIFFERENCE image (deck = cloudsOn - cloudsOff, so two quantized band means are subtracted before the ratio is taken); a compressive tonemap can only push the displayed ratio ABOVE the linear value, so the lower bound is measurement slack rather than physics",
  ),

  shadowContrastRatio: band(
    0.97,
    1.03,
    "prediction (ii) verbatim: mix(1, 0.35, s) moves 0.350000 -> 0.350293, i.e. +0.084%. +/-3% is two orders of magnitude wider than the predicted move and is set by 8-bit quantization on a ground band, NOT by the effect. It is also the DISCRIMINATOR: the rejected design (shadow strength = S2's factor) puts the contrast at 1 - 0.65*0.769 = 0.5001 against an un-eclipsed 0.35 at the 0.5452 rung, a ratio of 1.429 — 14x outside this band. A measured move beyond it REFUTES the shipped model, exactly as the row asks",
  ),

  iblDeepestRatio: band(
    0.3,
    0.85,
    "the model's displayed IBL brightness at obscuration 0.9 against its clear baseline. The cube is dimmed by the same 0.4642 factor pre-tonemap, so a linear display would read 0.464; the PBR-Neutral shoulder plus the SH projection of an already-dimmed cube compress that upward. The upper bound 0.85 requires a VISIBLE response (a leg that barely moves is the undimmed-IBL defect this row exists to fix); the lower bound 0.30 catches DOUBLE application — the SH step-3 multiply acquiring the factor as well would square it to 0.2155, which lands below this bound",
  ),

  iblRecoveryRatio: band(
    0.98,
    1.02,
    "the anti-latch assertion. After the sweep has been through the deep phase and back, the model's brightness at the SAME clear instant must return to its own baseline. +/-2% is capture noise on a static scene; the defect this catches (a one-way 'only re-fill when it got darker' gate) leaves the environment at ~0.46 of baseline, which is 27 band-widths away",
  ),

  engineRefreshCount: band(
    234,
    275,
    "the ENGINE's committed-bucket transition count. 275 is a HARD CEILING by construction: the managers commit the bucket only inside the branch that re-fills, and a bounded-refresh deferral (C11-193) can only MERGE two adjacent edges into one fill, never create one. The floor allows 15% of the 274 sweep edges to be merged. The exact-275 reading is reported separately (`engineRefreshCountExactReportedOnly`) so a merge is visible without being a false failure on a first run",
  ),

  sweepQuiescence: band(
    0.6,
    0.75,
    "the row's 'quiescent on roughly two thirds of an 801-frame sweep'. 274 of the 801 sweep frames change a bucket, so 527/801 = 0.658 are quiescent. The band is 0.658 -0.058/+0.092, wide enough to survive a handful of merged edges and narrow enough that a refresh EVERY frame (0.0) or a refresh NEVER (1.0) fails",
  ),

  controlRefreshCount: band(
    0,
    2,
    "the eclipse-OFF control over the identical 801-frame schedule. With the effect off the factor is exactly 1.0 on every frame, so the bucket sits at the identity 256 and commits at most once. Two is the allowance for the initial commit plus one resource-generation re-commit",
  ),

  determinismDelta: band(
    0,
    0.004,
    "the repeat bracket: the first scored configuration re-captured at the end of the lane. 0.004 is ~1 eight-bit code value on a band mean — the smallest difference distinguishable at all. Set strictly INSIDE the tightest scored margin (lane B's +/-3% of a ~0.35 contrast is 0.0105), so a control PASS means residual capture noise cannot flip an assertion",
  ),

  factorTolerance: band(
    0,
    1e-9,
    "the published `eclipseSceneLightFactor` against this module's second implementation, and across backends. It is ONE CPU module evaluated on f64 inputs, so anything above f64 round-off is a real divergence",
  ),

  strengthTolerance: band(
    0,
    1e-9,
    "the published `shadowStrength` against `predictDirectional`. Same reasoning: one CPU expression, no shader involved",
  ),

  deckVacuityFloor: band(
    0.01,
    1,
    "the deck's own contribution (cloudsOn - cloudsOff) in the UN-eclipsed leg. Below 0.01 there is no deck in frame and every ratio computed from it is noise over noise — the `NEW-PROBE-VACUOUS-REACHABILITY-ASSERTION` class. STRUCTURAL, not a product failure",
  ),

  shadowVacuityCeiling: band(
    0,
    0.98,
    "the un-eclipsed ground contrast (shadowOn / shadowOff). At or above 0.98 the cast shadow is not darkening the ground at all, so its invariance under an eclipse is unmeasurable. STRUCTURAL",
  ),

  iblVacuityFloor: band(
    0.05,
    1,
    "lit fraction of the model band in the clear baseline. Below 5% the model is not in frame (or is unlit) and the dim/recover ratios are noise. STRUCTURAL",
  ),
});

/**
 * The predicates that COMPOSE the verdict, in evaluation order.
 *
 * This list IS the gate: `judgeEclipseCloudResponse` folds it to produce PASS
 * and filters it to produce `failedPredicates`, so there is no second
 * hand-maintained conjunction that could disagree. Adding a name adds a gate;
 * removing one removes a gate. `eclipse-cloud-response-gate.spec.mjs` pins the
 * membership so neither happens by accident.
 */
export const ECLIPSE_CLOUD_GATE_PREDICATES = Object.freeze([
  // Lane A — deck lighting (prediction i)
  "cloudLaneIsWebGPU",
  "deckNonVacuous",
  "offFactorExactlyOne",
  "factorMatchesSecondImplementation",
  "deckRatioInBand",
  "deckRatioMonotone",
  // Lane B — cloud shadow (prediction ii)
  "shadowNonVacuous",
  "offShadowStrengthExactlyOne",
  "shadowStrengthMatchesDirectional",
  "shadowContrastInvariant",
  "shadowContrastRejectsAlternativeDesign",
  // Lane C — IBL dim, refresh cadence, recovery (prediction iii)
  "predictedRefreshCountExact",
  "rampNeverSkipsABucket",
  "engineRefreshCountWebGPUInBand",
  "engineRefreshCountWebGLInBand",
  "controlRefreshQuiescent",
  "sweepQuiescenceInBand",
  "iblNonVacuous",
  "iblDimsAtDeepest",
  "iblRecovers",
  // Instrument health
  "determinismBracketHolds",
  "refreshCostMeasured",
]);

/** Cross-backend predicates, folded the same way. */
export const ECLIPSE_CLOUD_PARITY_PREDICATES = Object.freeze([
  "sweepFactorSeriesParity",
  "predictedRefreshCountParity",
]);

/**
 * Computed and reported, deliberately NOT gating, with the reason each may
 * legitimately read false.
 */
export const ECLIPSE_CLOUD_REPORTED_ONLY_PREDICATES = Object.freeze([
  // A C11-193 bounded-refresh deferral can merge two adjacent bucket edges
  // into a single fill. That is correct behaviour, not a defect, so the exact
  // reading is information rather than a verdict — the BAND gates.
  "engineRefreshCountExactReportedOnly",
  // The linear (untonemapped) comparison. Kept because it is the number the
  // row's 0.4642 actually names, but the capture is post-tonemap so it cannot
  // gate — the same lesson `probe-eclipse-scene-dimming` learned over four
  // rounds of trying to predict a saturating display transform.
  "deckRatioMatchesLinearReportedOnly",
]);

const inBand = (value, b) =>
  Number.isFinite(value) && value >= b.lo && value <= b.hi;

const ratio = (a, b) =>
  Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? a / b : null;

/**
 * Folds one run's measurements into the verdict.
 *
 * A missing lane, a vacuous measurement or a backend mismatch is STRUCTURAL —
 * never a product FAIL. A gate verdict over a measurement that could not have
 * seen its subject certifies nothing, and this fleet has re-learned that often
 * enough for it to be a rule.
 *
 * @param {object} run
 * @param {object} run.cloudLanes WebGPU lanes A + B.
 * @param {object} run.iblWebGPU Lane C on WebGPU.
 * @param {object} run.iblWebGL Lane C on WebGL.
 */
export function judgeEclipseCloudResponse(run) {
  const v = {};
  const structuralReasons = [];
  const B = ECLIPSE_CLOUD_BANDS;
  const cloud = run.cloudLanes;
  const gpu = run.iblWebGPU;
  const gl = run.iblWebGL;

  for (const [name, lane] of [
    ["webgpu-cloud", cloud],
    ["webgpu-ibl", gpu],
    ["webgl-ibl", gl],
  ]) {
    if (!lane || lane.structuralError) {
      structuralReasons.push(
        `${name}: ${lane?.structuralError ?? "lane did not run"}`,
      );
    }
  }
  if (structuralReasons.length > 0) {
    return {
      ...v,
      gatePredicates: ECLIPSE_CLOUD_GATE_PREDICATES,
      reportedOnlyPredicates: ECLIPSE_CLOUD_REPORTED_ONLY_PREDICATES,
      failedPredicates: [],
      parityFailed: [],
      structuralReasons,
      cost: { webgpuMsPerRefresh: null, webglMsPerRefresh: null },
      PASS: false,
    };
  }

  const rungs = cloud.rungs ?? [];
  const deepest = rungs[rungs.length - 1];
  // The rung whose obscuration is closest to 0.5452 — where the REJECTED
  // design peaks and this band's discrimination is widest.
  const discriminating = rungs.reduce((best, rung) => {
    const d = Math.abs((rung.published?.moonObscuration ?? 0) - 0.5452);
    const bd = Math.abs((best?.published?.moonObscuration ?? 0) - 0.5452);
    return best === undefined || d < bd ? rung : best;
  }, undefined);

  v.cloudLaneIsWebGPU = cloud.rendererType === "webgpu";
  if (!v.cloudLaneIsWebGPU) {
    structuralReasons.push(
      `webgpu-cloud: rendererType resolved "${cloud.rendererType}", not webgpu`,
    );
  }

  // ── Vacuity, checked BEFORE any ratio is scored ──────────────────────────
  v.deckContributionOff = deepest?.deck?.offContribution ?? null;
  v.deckNonVacuous = rungs.every((rung) =>
    inBand(rung.deck?.offContribution, B.deckVacuityFloor),
  );
  if (!v.deckNonVacuous) {
    structuralReasons.push(
      `deck contribution below the vacuity floor ${B.deckVacuityFloor.lo} on at least one rung — no deck in frame`,
    );
  }
  v.shadowContrastClear = ratio(
    rungs[0]?.shadow?.offShadow,
    rungs[0]?.shadow?.offNoShadow,
  );
  v.shadowNonVacuous =
    Number.isFinite(v.shadowContrastClear) &&
    v.shadowContrastClear <= B.shadowVacuityCeiling.hi &&
    v.shadowContrastClear > 0;
  if (!v.shadowNonVacuous) {
    structuralReasons.push(
      `un-eclipsed ground contrast ${v.shadowContrastClear} is not below ${B.shadowVacuityCeiling.hi} — the cast shadow is not darkening the ground`,
    );
  }
  v.iblNonVacuous =
    inBand(gpu.ibl?.baseline?.litFraction, B.iblVacuityFloor) &&
    inBand(gl.ibl?.baseline?.litFraction, B.iblVacuityFloor);
  if (!v.iblNonVacuous) {
    structuralReasons.push(
      "the IBL model band is unlit or out of frame on at least one backend",
    );
  }

  // ── Lane A: prediction (i) ───────────────────────────────────────────────
  v.offFactorExactlyOne = rungs.every(
    (rung) => rung.publishedOff?.factor === 1,
  );
  v.factorMatchesSecondImplementation = rungs.every((rung) => {
    const measured = rung.published?.factor;
    const expected = predictFactor(rung.published?.moonObscuration ?? 0);
    return (
      Number.isFinite(measured) &&
      Math.abs(measured - expected) <= B.factorTolerance.hi
    );
  });
  v.deckRatios = rungs.map((rung) =>
    ratio(rung.deck?.onContribution, rung.deck?.offContribution),
  );
  v.deckRatioAtDeepest = v.deckRatios[v.deckRatios.length - 1];
  v.deckRatioInBand = inBand(v.deckRatioAtDeepest, B.deckDisplayedRatio);
  // Monotone in the eclipse's depth: each successive rung must not be BRIGHTER
  // than the previous one. A small tolerance absorbs 8-bit noise on a
  // difference image without admitting a real inversion.
  v.deckRatioMonotone = v.deckRatios.every(
    (value, index) =>
      index === 0 ||
      (Number.isFinite(value) && value <= v.deckRatios[index - 1] + 0.02),
  );
  v.deckRatioMatchesLinearReportedOnly =
    Number.isFinite(v.deckRatioAtDeepest) &&
    Math.abs(
      v.deckRatioAtDeepest -
        predictFactor(deepest?.published?.moonObscuration ?? 0),
    ) <= 0.02;

  // ── Lane B: prediction (ii), and its refutation control ──────────────────
  v.offShadowStrengthExactlyOne = rungs.every(
    (rung) => rung.publishedOff?.shadowStrength === 1,
  );
  v.shadowStrengthMatchesDirectional = rungs.every((rung) => {
    const measured = rung.published?.shadowStrength;
    const expected = predictDirectional(rung.published?.moonObscuration ?? 0);
    return (
      Number.isFinite(measured) &&
      Math.abs(measured - expected) <= B.strengthTolerance.hi
    );
  });
  const contrastRatioAt = (rung) => {
    const on = ratio(rung?.shadow?.onShadow, rung?.shadow?.onNoShadow);
    const off = ratio(rung?.shadow?.offShadow, rung?.shadow?.offNoShadow);
    return ratio(on, off);
  };
  v.shadowContrastRatioAtDeepest = contrastRatioAt(deepest);
  v.shadowContrastRatioAtDiscriminating = contrastRatioAt(discriminating);
  v.shadowContrastInvariant = inBand(
    v.shadowContrastRatioAtDeepest,
    B.shadowContrastRatio,
  );
  // The REJECTED design's prediction at the discriminating rung, computed here
  // so the report carries the number the band is excluding rather than a bare
  // boolean. `s = F` instead of `s = Fd`.
  const discriminatingObscuration =
    discriminating?.published?.moonObscuration ?? 0;
  v.rejectedDesignContrastRatio =
    shadowContrast(predictFactor(discriminatingObscuration)) /
    shadowContrast(1.0);
  v.shadowContrastRejectsAlternativeDesign =
    inBand(v.shadowContrastRatioAtDiscriminating, B.shadowContrastRatio) &&
    !inBand(v.rejectedDesignContrastRatio, B.shadowContrastRatio);

  // ── Lane C: prediction (iii) ─────────────────────────────────────────────
  v.predictedSweepRefreshCount = predictedSweepRefreshCount();
  v.predictedRefreshCountExact = v.predictedSweepRefreshCount === 275;

  const realizedBuckets = (lane) =>
    (lane.factors ?? []).map((factor) => predictBucket(factor));
  const gpuBuckets = realizedBuckets(gpu);
  const glBuckets = realizedBuckets(gl);
  v.maxBucketStepWebGPU = maxBucketStep(gpuBuckets);
  v.maxBucketStepWebGL = maxBucketStep(glBuckets);
  v.rampNeverSkipsABucket =
    v.maxBucketStepWebGPU <= 1 && v.maxBucketStepWebGL <= 1;

  v.engineRefreshCountWebGPU = gpu.engineRefreshCount ?? null;
  v.engineRefreshCountWebGL = gl.engineRefreshCount ?? null;
  v.engineRefreshCountWebGPUInBand = inBand(
    v.engineRefreshCountWebGPU,
    B.engineRefreshCount,
  );
  v.engineRefreshCountWebGLInBand = inBand(
    v.engineRefreshCountWebGL,
    B.engineRefreshCount,
  );
  v.engineRefreshCountExactReportedOnly =
    v.engineRefreshCountWebGPU === 275 && v.engineRefreshCountWebGL === 275;

  v.controlRefreshQuiescent =
    inBand(gpu.controlRefreshCount, B.controlRefreshCount) &&
    inBand(gl.controlRefreshCount, B.controlRefreshCount);

  const quiescence = (lane, buckets) => {
    const frames = lane.sweepFrames ?? buckets.length;
    if (!(frames > 0)) {
      return null;
    }
    return (frames - countBucketChanges(buckets, buckets[0])) / frames;
  };
  v.sweepQuiescenceWebGPU = quiescence(gpu, gpuBuckets);
  v.sweepQuiescenceWebGL = quiescence(gl, glBuckets);
  v.sweepQuiescenceInBand =
    inBand(v.sweepQuiescenceWebGPU, B.sweepQuiescence) &&
    inBand(v.sweepQuiescenceWebGL, B.sweepQuiescence);

  v.iblDeepRatioWebGPU = ratio(gpu.ibl?.deepest?.mean, gpu.ibl?.baseline?.mean);
  v.iblDeepRatioWebGL = ratio(gl.ibl?.deepest?.mean, gl.ibl?.baseline?.mean);
  v.iblDimsAtDeepest =
    inBand(v.iblDeepRatioWebGPU, B.iblDeepestRatio) &&
    inBand(v.iblDeepRatioWebGL, B.iblDeepestRatio);

  v.iblRecoveryRatioWebGPU = ratio(
    gpu.ibl?.recovered?.mean,
    gpu.ibl?.baseline?.mean,
  );
  v.iblRecoveryRatioWebGL = ratio(
    gl.ibl?.recovered?.mean,
    gl.ibl?.baseline?.mean,
  );
  v.iblRecovers =
    inBand(v.iblRecoveryRatioWebGPU, B.iblRecoveryRatio) &&
    inBand(v.iblRecoveryRatioWebGL, B.iblRecoveryRatio);

  // ── Instrument health ────────────────────────────────────────────────────
  v.determinismDelta = cloud.repeat?.delta ?? null;
  v.determinismBracketHolds = inBand(v.determinismDelta, B.determinismDelta);

  // C13-41-ECLIPSE-REFRESH-COST-UNMEASURED: the differential wall clock of the
  // eclipse-driven fills. The control runs the IDENTICAL schedule with the
  // effect off, so everything except the fills cancels.
  const costPerRefresh = (lane) => {
    const extraFills =
      (lane.engineRefreshCount ?? 0) - (lane.controlRefreshCount ?? 0);
    if (!(extraFills > 0)) {
      return null;
    }
    return ((lane.sweepWallMs ?? 0) - (lane.controlWallMs ?? 0)) / extraFills;
  };
  const cost = {
    webgpuMsPerRefresh: costPerRefresh(gpu),
    webglMsPerRefresh: costPerRefresh(gl),
    webgpuSweepWallMs: gpu.sweepWallMs ?? null,
    webgpuControlWallMs: gpu.controlWallMs ?? null,
    webglSweepWallMs: gl.sweepWallMs ?? null,
    webglControlWallMs: gl.controlWallMs ?? null,
  };
  // MEASURED, not bounded: the row asks for the number, and there is no
  // pre-registered budget to score it against. The gate is only that a real,
  // non-negative number came back — a null means the differential could not be
  // formed and the row does NOT discharge.
  v.refreshCostMeasured =
    Number.isFinite(cost.webgpuMsPerRefresh) &&
    cost.webgpuMsPerRefresh >= 0 &&
    Number.isFinite(cost.webglMsPerRefresh) &&
    cost.webglMsPerRefresh >= 0;

  // ── Parity ───────────────────────────────────────────────────────────────
  const parity = {};
  const n = Math.min((gpu.factors ?? []).length, (gl.factors ?? []).length);
  let maxFactorDelta = 0;
  for (let i = 0; i < n; i++) {
    const a = gpu.factors[i];
    const b = gl.factors[i];
    if (Number.isFinite(a) && Number.isFinite(b)) {
      maxFactorDelta = Math.max(maxFactorDelta, Math.abs(a - b));
    }
  }
  parity.maxFactorDelta = maxFactorDelta;
  parity.sweepFactorSeriesParity =
    n > 0 && maxFactorDelta <= B.factorTolerance.hi;
  parity.predictedRefreshCountParity =
    countBucketChanges(gpuBuckets, gpuBuckets[0]) ===
    countBucketChanges(glBuckets, glBuckets[0]);
  const parityFailed = ECLIPSE_CLOUD_PARITY_PREDICATES.filter(
    (name) => parity[name] !== true,
  );

  v.parity = parity;
  v.gatePredicates = ECLIPSE_CLOUD_GATE_PREDICATES;
  v.reportedOnlyPredicates = ECLIPSE_CLOUD_REPORTED_ONLY_PREDICATES;
  v.structuralReasons = structuralReasons;
  v.cost = cost;
  v.failedPredicates =
    structuralReasons.length > 0
      ? []
      : ECLIPSE_CLOUD_GATE_PREDICATES.filter((name) => v[name] !== true);
  v.parityFailed = structuralReasons.length > 0 ? [] : parityFailed;
  v.PASS =
    structuralReasons.length === 0 &&
    v.failedPredicates.length === 0 &&
    parityFailed.length === 0;
  return v;
}
