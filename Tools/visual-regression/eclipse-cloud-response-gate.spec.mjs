// eclipse-cloud-response-gate.spec.mjs — the pure-Node half of C13-41's Edge
// acceptance: the probe's predicate COMPOSITION, its pre-registered bands, and
// the arithmetic those bands are derived from.
//
// Pure Node (`node --test`). No browser, no build. This exists because
// `probe-eclipse-cloud-response.mjs` cannot be run by its author (no Edge in
// the worker lane), and a gate whose fold has never been executed is a gate
// nobody has checked. Everything below is executable without an adapter:
//
//   - the three published numbers the row pre-registered are RECOMPUTED here
//     from the published constants and must match the row's text exactly
//     (0.464228 / 0.999550 / 275). A retune of the 5-lux floor, the 1/3
//     adaptation exponent or the 1/256 grid moves them and fails here;
//   - the sweep's refresh count is DERIVED, not written down, and the ramp is
//     shown not to skip a bucket — the failure mode that would collapse the
//     count from "edges crossed" to "jumps taken";
//   - every gating predicate is shown to be able to FAIL, by feeding the fold
//     a run that breaks exactly that one thing. A gate with no mutant is a
//     gate that has never been shown to gate;
//   - the REJECTED design (cloud-shadow strength = S2's scene factor) is
//     reconstructed and shown to land far outside the shadow band, so the
//     probe's shadow lane genuinely discriminates instead of passing both
//     designs;
//   - vacuity is shown to be STRUCTURAL rather than a product FAIL — a lane
//     that could not see its subject certifies nothing either way.
//
// Run: node --test Tools/visual-regression/eclipse-cloud-response-gate.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BAND_MEAN_CAPTURE_DELTA,
  CLOUD_SHADOW_BEER_FLOOR,
  DECK_AERIAL_SHARE_CROSS_RUN,
  DECK_TONEMAP_ENTRY_CEILING,
  ECLIPSE_ADAPTATION_EXPONENT,
  ECLIPSE_CLOUD_BANDS,
  ECLIPSE_CLOUD_EXIT,
  ECLIPSE_CLOUD_GATE_PREDICATES,
  ECLIPSE_CLOUD_LANE_PARENTS,
  ECLIPSE_CLOUD_PARITY_PREDICATES,
  ECLIPSE_CLOUD_PREDICATE_LANES,
  ECLIPSE_CLOUD_REPORTED_ONLY_PREDICATES,
  ECLIPSE_RADIOMETRIC_FLOOR,
  ENV_REFRESH_STEPS,
  REFRESH_COST_MIN_SEGMENTS_PER_LEG,
  SHADOW_GROUND_BRIGHTNESS_FLOOR,
  SWEEP_FRAMES,
  SWEEP_PEAK_OBSCURATION,
  SWEEP_RISING_FRAMES,
  computeRefreshCost,
  countBucketChanges,
  deckDisplayedRatio,
  deckFreeGroundDimTolerance,
  eclipseCloudExitCode,
  eclipseCloudGateLabel,
  extractShadowableDimming,
  fitDeckAerialShare,
  fitDeckAerialShareFromPureDeck,
  fitDeckTonemapEntry,
  idealSweepBuckets,
  judgeEclipseCloudResponse,
  laneIsBlind,
  maxBucketStep,
  predictBucket,
  predictDirectional,
  predictFactor,
  predictShadowContrastRatio,
  predictedSweepRefreshCount,
  shadowContrast,
  shadowContrastModelIsBoundedByDirectional,
  shadowContrastRatioSupremum,
} from "./lib/eclipse-cloud-response-gate.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const readEngine = (p) =>
  fs
    .readFileSync(path.join(root, "packages/engine/Source", p), "utf8")
    .replace(/\r\n/g, "\n");

// ─────────────────────────────────────────────────────────────────────────────
// A. The three pre-registered numbers, recomputed
// ─────────────────────────────────────────────────────────────────────────────

test("A1 the S2 factor at obscuration 0.9 is the row's 0.464228", () => {
  const factor = predictFactor(SWEEP_PEAK_OBSCURATION);
  assert.equal(Number(factor.toFixed(6)), 0.464228);
  // ...and the constants it is built from are the published ones, not tuned.
  assert.equal(ECLIPSE_RADIOMETRIC_FLOOR, 5.0 / 100000.0);
  assert.equal(ECLIPSE_ADAPTATION_EXPONENT, 1 / 3);
  // Exactly 1.0 outside an eclipse — the byte-identity position.
  assert.equal(predictFactor(0), 1.0);
  assert.equal(predictFactor(-1), 1.0);
});

test("A2 the DIRECTIONAL fraction at 0.9 is the row's 0.999550, and it is monotone", () => {
  assert.equal(
    Number(predictDirectional(SWEEP_PEAK_OBSCURATION).toFixed(6)),
    0.99955,
  );
  assert.equal(
    predictDirectional(0),
    1.0,
    "exact identity at zero obscuration",
  );
  assert.equal(predictDirectional(1), 0.0, "exactly zero at totality");
  assert.equal(Number(predictDirectional(0.999).toFixed(4)), 0.9524);
  let previous = Infinity;
  for (let i = 0; i <= 2000; i++) {
    const value = predictDirectional(i / 2000);
    assert.ok(value <= previous + 1e-15, `not monotone at ${i / 2000}`);
    previous = value;
  }
});

test("A3 the sweep produces EXACTLY 275 refreshes, buckets 256 -> 119", () => {
  assert.equal(ENV_REFRESH_STEPS, 256);
  assert.equal(SWEEP_FRAMES, 801);
  assert.equal(SWEEP_RISING_FRAMES, 401);

  const buckets = idealSweepBuckets();
  assert.equal(buckets.length, SWEEP_FRAMES);
  assert.equal(buckets[0], 256, "a clear frame sits in the identity bucket");
  assert.equal(
    Math.min(...buckets),
    119,
    "obscuration 0.9 buckets to 119 — the row's stated endpoint",
  );
  assert.equal(buckets[buckets.length - 1], 256, "the sweep returns to clear");

  // 1 baseline + 2 x 137 edges.
  assert.equal(countBucketChanges(buckets, buckets[0]), 274);
  assert.equal(predictedSweepRefreshCount(), 275);
  assert.equal(256 - 119, 137);
});

test("A4 the ramp is fine enough that no bucket edge is SKIPPED", () => {
  // The count is the number of bucket CHANGES, not EDGES: a ramp coarse enough
  // to jump two buckets in one frame fires ONE refresh and the count collapses.
  const buckets = idealSweepBuckets();
  assert.equal(maxBucketStep(buckets), 1);

  // The margin is real, not incidental. A ramp with half the frames skips.
  const coarse = [];
  for (let k = 0; k < 201; k++) {
    coarse.push(predictBucket(predictFactor((0.9 * k) / 200)));
  }
  assert.ok(
    maxBucketStep(coarse) >= 2,
    "a 201-frame ramp must skip, or 401 frames was not a considered choice",
  );
  assert.ok(
    countBucketChanges(coarse, coarse[0]) < 137,
    "and a skipping ramp under-counts the edges",
  );
});

test("A5 the quantizer's identity bucket covers the 'no eclipse for refresh purposes' zone", () => {
  assert.equal(predictBucket(1.0), 256);
  assert.equal(predictBucket(0.998046875), 256, "255.5/256 is the low edge");
  assert.ok(predictBucket(0.998046875 - 1e-9) < 256);
  // A factor outside [0,1] (or not a number) resolves to the identity, never to
  // a poisoned bucket.
  assert.equal(predictBucket(Number.NaN), 256);
  assert.equal(predictBucket(-0.5), 256);
});

test("A6 the level fold counts CHANGES, not samples — a merged edge is one fill", () => {
  assert.equal(countBucketChanges([256, 256, 255, 255, 254], 256), 2);
  assert.equal(
    countBucketChanges([256, 254], 256),
    1,
    "a two-bucket jump is ONE fill",
  );
  assert.equal(
    countBucketChanges([256], Number.NaN),
    1,
    "the NaN-seeded first commit is itself a refresh",
  );
  assert.equal(countBucketChanges([], Number.NaN), 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// B. The shadow lane genuinely DISCRIMINATES the rejected design
// ─────────────────────────────────────────────────────────────────────────────

test("B1 the shipped design moves the ground contrast by the row's +0.08%", () => {
  const unEclipsed = shadowContrast(1.0);
  assert.equal(Number(unEclipsed.toFixed(6)), 0.35);
  assert.equal(CLOUD_SHADOW_BEER_FLOOR, 0.35);
  const eclipsed = shadowContrast(predictDirectional(SWEEP_PEAK_OBSCURATION));
  assert.equal(Number(eclipsed.toFixed(6)), 0.350292);
  const move = eclipsed / unEclipsed - 1;
  assert.ok(move > 0.0008 && move < 0.0009, `+0.08% expected, got ${move}`);
  // ...and that move is comfortably INSIDE the band, so the shipped design
  // passes rather than squeaking through.
  const ratio = eclipsed / unEclipsed;
  assert.ok(
    ratio > ECLIPSE_CLOUD_BANDS.shadowContrastRatio.lo &&
      ratio < ECLIPSE_CLOUD_BANDS.shadowContrastRatio.hi,
  );
});

test("B2 the REJECTED design (strength = S2's factor) lands far outside the band", () => {
  // The row's refutation: shadowed ground would be F*(1 - 0.65F), which RISES
  // from 0.350 to a peak 0.3846 at F = 0.769 — a shadowed patch getting ~10%
  // BRIGHTER through the early partial phase.
  let peakF = 0;
  let peakValue = 0;
  for (let i = 0; i <= 100000; i++) {
    const F = i / 100000;
    const value = F * (1 - 0.65 * F);
    if (value > peakValue) {
      peakValue = value;
      peakF = F;
    }
  }
  assert.equal(Number(peakF.toFixed(3)), 0.769);
  assert.equal(Number(peakValue.toFixed(4)), 0.3846);
  assert.ok(peakValue > 0.35, "the rejected design is NON-MONOTONE");

  // The obscuration at which F = 0.769 — which is the probe's discriminating
  // rung target, and it must be one of the ladder targets.
  const discriminatingObscuration = 0.5452;
  assert.ok(
    ECLIPSE_CLOUD_BANDS.ladderTargets.includes(discriminatingObscuration),
    "the ladder must actually visit the rung where the discrimination is widest",
  );
  assert.equal(
    Number(predictFactor(discriminatingObscuration).toFixed(3)),
    0.769,
  );

  // At that rung the CONTRAST ratio under the rejected design is 1.429 — 14x
  // outside the +/-3% band. The band therefore rejects it rather than passing
  // both designs.
  const rejectedRatio =
    shadowContrast(predictFactor(discriminatingObscuration)) /
    shadowContrast(1.0);
  assert.equal(Number(rejectedRatio.toFixed(3)), 1.429);
  assert.ok(rejectedRatio > ECLIPSE_CLOUD_BANDS.shadowContrastRatio.hi);
  const shippedRatio =
    shadowContrast(predictDirectional(discriminatingObscuration)) /
    shadowContrast(1.0);
  assert.ok(shippedRatio < ECLIPSE_CLOUD_BANDS.shadowContrastRatio.hi);
  assert.ok(
    rejectedRatio / shippedRatio > 1.4,
    "the two designs must be separated by far more than the band width",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// C. The bands themselves
// ─────────────────────────────────────────────────────────────────────────────

test("C1 every band is two-sided, ordered, and carries its derivation", () => {
  for (const [name, band] of Object.entries(ECLIPSE_CLOUD_BANDS)) {
    if (name === "ladderTargets") {
      continue;
    }
    assert.equal(typeof band.lo, "number", `${name}.lo`);
    assert.equal(typeof band.hi, "number", `${name}.hi`);
    assert.ok(band.hi > band.lo, `${name} is not a two-sided band`);
    assert.equal(
      band.status,
      "DERIVED",
      `${name} must stay DERIVED until an Edge run confirms its margin`,
    );
    assert.ok(
      typeof band.why === "string" && band.why.length > 80,
      `${name} has no recorded derivation`,
    );
  }
});

test("C2 the ladder targets are ascending, distinct, and end at the sweep peak", () => {
  const targets = ECLIPSE_CLOUD_BANDS.ladderTargets;
  assert.ok(targets.length >= 4);
  assert.equal(targets[0], 0.0, "an identity rung is required");
  assert.equal(targets[targets.length - 1], SWEEP_PEAK_OBSCURATION);
  for (let i = 1; i < targets.length; i++) {
    assert.ok(
      targets[i] > targets[i - 1] + 0.05,
      `rungs ${i - 1}/${i} are too close to separate`,
    );
  }
});

test("C3 the deck band brackets the row's own stated ratio window", () => {
  const b = ECLIPSE_CLOUD_BANDS.deckDisplayedRatio;
  const linear = predictFactor(SWEEP_PEAK_OBSCURATION);
  assert.ok(
    b.lo < linear,
    "the band must admit the linear (pre-tonemap) value",
  );
  assert.ok(b.hi >= 0.7, "the row's ceiling is ~0.7");
  assert.ok(b.hi <= 0.7, "and the band must not be widened past it");
  // A fully undimmed deck (ratio 1.0) — the defect this row exists to fix —
  // must be REJECTED.
  assert.ok(1.0 > b.hi);
});

test("C4 the IBL band rejects both no-response and DOUBLE application", () => {
  const b = ECLIPSE_CLOUD_BANDS.iblDeepestRatio;
  const factor = predictFactor(SWEEP_PEAK_OBSCURATION);
  assert.ok(1.0 > b.hi, "an undimmed IBL must fail");
  assert.ok(
    factor * factor < b.lo,
    "the squared factor (the SH step-3 multiply also acquiring it) must fail",
  );
  assert.ok(factor > b.lo && factor < b.hi, "the correct response must pass");
});

test("C5 the quiescence band matches 'roughly two thirds of an 801-frame sweep'", () => {
  const buckets = idealSweepBuckets();
  const quiescent =
    (buckets.length - countBucketChanges(buckets, buckets[0])) / buckets.length;
  assert.equal(Number(quiescent.toFixed(3)), 0.658);
  const b = ECLIPSE_CLOUD_BANDS.sweepQuiescence;
  assert.ok(quiescent > b.lo && quiescent < b.hi);
  assert.ok(0.0 < b.lo, "a refresh every frame must fail");
  assert.ok(1.0 > b.hi, "a refresh never must fail");
});

test("C6 the engine refresh band's CEILING is the arithmetic maximum", () => {
  const b = ECLIPSE_CLOUD_BANDS.engineRefreshCount;
  assert.equal(
    b.hi,
    predictedSweepRefreshCount(),
    "deferral can only MERGE edges, never create one, so 275 is a hard ceiling",
  );
  assert.ok(b.lo >= 0.85 * b.hi, "the floor allows at most ~15% merged edges");
});

// ─────────────────────────────────────────────────────────────────────────────
// D. The fold — every gating predicate must be able to FAIL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The re-derived deck the reference fixture models (CO-17): a compressive
 * Reinhard core at tonemap entry `e` plus an aerial tint that is exactly linear
 * in F. Until CO-19 the fixture's deck was LINEAR, which made the
 * `cloudAerialStrength = 0` leg unrepresentable — with rho == R the share is
 * 0/0 and the pre-registered 0.635 is unreachable — so the fixture now carries
 * the shape the fourth run actually measured.
 */
const REFERENCE_DECK_TONEMAP_ENTRY = 1.01;

/** A run in which every gate passes. Mutants below break exactly one thing. */
function passingRun() {
  const rungs = ECLIPSE_CLOUD_BANDS.ladderTargets.map((target, rungIndex) => {
    const factor = predictFactor(target);
    const directional = predictDirectional(target);
    // Deck: the un-eclipsed contribution is 0.20; the eclipsed one is the
    // TWO-TERM display model CO-17 derived — (1-s)*rho + s*F with
    // e = 1.01 and s = DECK_AERIAL_SHARE_CROSS_RUN — because that is the shape
    // the fourth Edge run measured and the shape the CO-19 legs decompose.
    // `pureRatio` is the same deck with the tint dial at 0, i.e. what the
    // diagnostic leg reads.
    const offContribution = 0.2;
    const pureRatio = deckDisplayedRatio(
      factor,
      REFERENCE_DECK_TONEMAP_ENTRY,
      0,
    );
    const onContribution =
      offContribution *
      deckDisplayedRatio(
        factor,
        REFERENCE_DECK_TONEMAP_ENTRY,
        DECK_AERIAL_SHARE_CROSS_RUN,
      );
    // Ground: unshadowed 0.5; shadowed = unshadowed * mix(1, 0.35, strength).
    // The eclipse scales BOTH bands by `factor`, which cancels in the ratio.
    // `offNoCloud` is the DECK-FREE ground: lane B now flies below the deck
    // floor, so turning the deck on leaves the ground band essentially
    // untouched and the retention ratio sits at ~1. `onNoCloud` is CO-19's
    // eclipse-ON twin of it, and under the published laws it is exactly
    // `offNoCloud * factor` — the globe's own light path dimming correctly.
    // The four rungs are 54 minutes apart and the lane's camera is sun-locked
    // in HEADING only, so the local sun ELEVATION does change and a deck-free
    // ground band must move with it. The fixture makes it move, because a
    // fixture that repeated one value would model the very defect
    // `offNoCloudVariesWithSun` exists to detect (CO-19).
    const offNoCloud = 0.51 + 0.01 * rungIndex;
    const onNoCloud = offNoCloud * factor;
    const offNoShadow = 0.5;
    const offShadow = offNoShadow * shadowContrast(1.0);
    const onNoShadow = offNoShadow * factor;
    const onShadow = onNoShadow * shadowContrast(directional);
    return {
      target,
      iso: `2026-08-12T16:0${ECLIPSE_CLOUD_BANDS.ladderTargets.indexOf(target)}:00Z`,
      published: {
        moonObscuration: target,
        factor,
        enabled: true,
        valid: true,
        shadowStrength: directional,
      },
      publishedOff: {
        factor: 1,
        moonObscuration: target,
        shadowStrength: 1,
      },
      deck: {
        // The background is BLACK by construction — the probe removes the sky
        // shell, skybox, sun, moon and clear colour so that
        // `cloudsOn - cloudsOff` is the deck's own contribution rather than
        // `alpha * (H - S)`. 0.005 is the residual the isolation ceiling
        // admits.
        offClouds: 0.005 + offContribution,
        offBare: 0.005,
        onClouds: 0.005 * factor + onContribution,
        onBare: 0.005 * factor,
        offContribution,
        onContribution,
        samples: 20000,
      },
      // CO-19's lane-A diagnostic leg, deepest rung only — the same difference
      // image with the aerial tint dial at 0, so its ratio IS the pure deck
      // ratio rho and the share falls out of this one run by subtraction.
      deckAerialZero:
        target === SWEEP_PEAK_OBSCURATION
          ? {
              aerialStrength: 0,
              offContribution,
              onContribution: offContribution * pureRatio,
              samples: 20000,
            }
          : null,
      shadow: {
        offNoCloud,
        onNoCloud,
        // CO-21: the settled twins. In a healthy run the deck-free control is
        // the same number whether it is read in first or last position, and the
        // fixture says so exactly — a fixture that jittered them would model the
        // very unsettled instrument `deckFreeGroundCapturesSettled` detects.
        offNoCloudSettled: offNoCloud,
        onNoCloudSettled: onNoCloud,
        offNoShadow,
        offShadow,
        onNoShadow,
        onShadow,
        strengthOff: 1,
        strengthOn: directional,
        shadowActiveOff: true,
        shadowActiveOn: true,
        cameraHeight: 1400,
        pitchDegrees: -8,
        samples: 20000,
      },
    };
  });

  const buckets = idealSweepBuckets();
  const factors = buckets.map((_, index) => {
    const rising = index < SWEEP_RISING_FRAMES;
    const k = rising ? index : SWEEP_FRAMES - 1 - index;
    return predictFactor(
      (SWEEP_PEAK_OBSCURATION * k) / (SWEEP_RISING_FRAMES - 1),
    );
  });
  const iblLane = (rendererType) => ({
    rendererType,
    sweepFrames: SWEEP_FRAMES,
    factors,
    obscurations: factors.map(() => 0),
    buckets,
    initialCommittedWasNaN: false,
    engineRefreshCount: 275,
    controlRefreshCount: 1,
    sweepWallMs: 9000,
    controlWallMs: 5000,
    // The INTERLEAVED cost accounting. 4000 ms over 274 eclipse-driven fills.
    // Each leg carries the toggle-absorbing segment fills (8 per leg), so the
    // DIFFERENCE is the sweep's own 274 edges.
    refreshCost: {
      warmupBothLegs: true,
      segmentsPerLeg: 8,
      eclipseFrames: SWEEP_FRAMES,
      controlFrames: SWEEP_FRAMES,
      eclipseWallMs: 9000,
      controlWallMs: 5000,
      eclipseFills: 282,
      controlFills: 8,
    },
    ibl: {
      baseline: { mean: 0.4, litFraction: 0.5, samples: 20000 },
      deepest: {
        mean: 0.4 * predictFactor(SWEEP_PEAK_OBSCURATION),
        litFraction: 0.5,
        samples: 20000,
      },
      recovered: { mean: 0.4, litFraction: 0.5, samples: 20000 },
    },
    publishedAtDeepest: {
      moonObscuration: SWEEP_PEAK_OBSCURATION,
      factor: predictFactor(SWEEP_PEAK_OBSCURATION),
    },
    modelReady: true,
  });

  return {
    cloudLanes: {
      rendererType: "webgpu",
      rungs,
      repeat: { first: 0.5, again: 0.5005, delta: 0.0005 },
    },
    iblWebGPU: iblLane("webgpu"),
    iblWebGL: iblLane("webgl"),
  };
}

const clone = (value) => structuredClone(value);

/**
 * Re-point CO-21's settled twins at whatever the mutant just wrote to the
 * first-position deck-free reads.
 *
 * Every mutant below models a SETTLED instrument reading a wrong number — a
 * converged capture of a real defect. Leaving the twins behind would instead
 * model an UNSETTLED instrument, which `deckFreeGroundCapturesSettled` is built
 * to quarantine, and the mutant would then prove the convergence detector works
 * rather than the thing it was written for. K2 injects the unsettled shape
 * deliberately and is the only test that must NOT call this.
 */
function settleDeckFreeTwins(run) {
  for (const rung of run.cloudLanes?.rungs ?? []) {
    if (!rung.shadow) {
      continue;
    }
    rung.shadow.offNoCloudSettled = rung.shadow.offNoCloud;
    rung.shadow.onNoCloudSettled = rung.shadow.onNoCloud;
  }
  return run;
}

test("D1 the reference run PASSES, so the mutants below are isolating one thing", () => {
  const verdict = judgeEclipseCloudResponse(passingRun());
  assert.deepEqual(
    verdict.structuralReasons,
    [],
    `unexpected structural reasons: ${JSON.stringify(verdict.structuralReasons)}`,
  );
  assert.deepEqual(
    verdict.failedPredicates,
    [],
    `unexpected failures: ${JSON.stringify(verdict.failedPredicates)}`,
  );
  assert.deepEqual(verdict.parityFailed, []);
  assert.equal(verdict.PASS, true);
});

test("D2 PASS is the fold of the predicate LIST, with no second conjunction", () => {
  const verdict = judgeEclipseCloudResponse(passingRun());
  assert.deepEqual(verdict.gatePredicates, ECLIPSE_CLOUD_GATE_PREDICATES);
  assert.deepEqual(
    verdict.reportedOnlyPredicates,
    ECLIPSE_CLOUD_REPORTED_ONLY_PREDICATES,
  );
  // Membership is pinned so a gate cannot be added or removed by accident.
  // 25 -> 26 at CO-17: `shadowContrastModelIsBoundedByDirectional`, the
  // arithmetic property that keeps the shadow invariant from moving outward.
  // 26 -> 28 at CO-19: the two pre-registered fifth-run legs,
  // `deckPureRatioInBand` (lane A's tint-free deck ratio) and
  // `deckFreeGroundDimsByFactor` (lane B's deck-free attribution).
  // 28 -> 29 at CO-21: `deckFreeGroundCapturesSettled`, the convergence
  // precondition that decides whether the fifth run's 0.449 is a measurement
  // (ENGINE) or a transient (INSTRUMENT).
  assert.equal(ECLIPSE_CLOUD_GATE_PREDICATES.length, 29);
  // 4 -> 5 at CO-19: `offNoCloudVariesWithSun`, the instrument tell.
  // 5 -> 6 at CO-21: `deckFreeGroundRetentionLegsAgreeReportedOnly`, the
  // corroborating disagreement between lane B's two retention ratios.
  assert.equal(ECLIPSE_CLOUD_REPORTED_ONLY_PREDICATES.length, 6);
  assert.equal(ECLIPSE_CLOUD_PARITY_PREDICATES.length, 2);
  // Nothing is scored without a declared blindness domain — an unmapped
  // predicate would be silently unquarantinable.
  for (const name of ECLIPSE_CLOUD_GATE_PREDICATES) {
    assert.ok(
      ECLIPSE_CLOUD_PREDICATE_LANES[name],
      `${name} has no blindness domain`,
    );
  }
  // A reported-only name must never also gate — that was the confusion the S2
  // probe had to name explicitly after a run was misdiagnosed twice in one day.
  for (const name of ECLIPSE_CLOUD_REPORTED_ONLY_PREDICATES) {
    assert.ok(
      !ECLIPSE_CLOUD_GATE_PREDICATES.includes(name),
      `${name} is both gating and reported-only`,
    );
  }
});

/** Break one thing; require exactly the named predicate(s) to fail. */
function expectFailure(mutate, expected) {
  const run = clone(passingRun());
  mutate(run);
  const verdict = judgeEclipseCloudResponse(run);
  assert.deepEqual(
    verdict.structuralReasons,
    [],
    `the mutant went STRUCTURAL instead of failing ${expected.join(", ")}: ${JSON.stringify(verdict.structuralReasons)}`,
  );
  assert.deepEqual(verdict.failedPredicates.sort(), [...expected].sort());
  assert.equal(verdict.PASS, false);
}

test("D3 an UNDIMMED cloud deck fails the deck band (the defect this row fixes)", () => {
  expectFailure(
    (run) => {
      for (const rung of run.cloudLanes.rungs) {
        rung.deck.onContribution = rung.deck.offContribution;
      }
    },
    ["deckRatioInBand"],
  );
});

test("D4 a non-monotone deck response fails", () => {
  expectFailure(
    (run) => {
      // Make the deepest rung BRIGHTER than the previous one while keeping the
      // deepest ratio inside the band, so only monotonicity can catch it.
      const rungs = run.cloudLanes.rungs;
      rungs[rungs.length - 2].deck.onContribution =
        rungs[rungs.length - 2].deck.offContribution * 0.3;
    },
    ["deckRatioMonotone"],
  );
});

test("D5 the REJECTED shadow design fails both shadow predicates", () => {
  expectFailure(
    (run) => {
      for (const rung of run.cloudLanes.rungs) {
        const factor = predictFactor(rung.published.moonObscuration);
        rung.published.shadowStrength = factor; // S2's scalar, not the directional
        rung.shadow.onShadow = rung.shadow.onNoShadow * shadowContrast(factor);
      }
    },
    [
      "shadowStrengthMatchesDirectional",
      "shadowContrastInvariant",
      "shadowContrastRejectsAlternativeDesign",
    ],
  );
});

test("D6 losing the exact-identity position at the OFF toggle fails", () => {
  expectFailure(
    (run) => {
      run.cloudLanes.rungs[1].publishedOff.factor = 0.9999999;
    },
    ["offFactorExactlyOne"],
  );
  expectFailure(
    (run) => {
      run.cloudLanes.rungs[1].publishedOff.shadowStrength = 0.9999999;
    },
    ["offShadowStrengthExactlyOne"],
  );
});

test("D7 a published factor that drifts from the second implementation fails", () => {
  expectFailure(
    (run) => {
      run.cloudLanes.rungs[2].published.factor += 1e-6;
    },
    ["factorMatchesSecondImplementation"],
  );
});

test("D8 a COARSER ramp that skips bucket edges fails, and takes the count with it", () => {
  expectFailure(
    (run) => {
      for (const lane of [run.iblWebGPU, run.iblWebGL]) {
        lane.factors = lane.factors.filter((_, index) => index % 4 === 0);
        lane.sweepFrames = lane.factors.length;
        lane.engineRefreshCount = 80;
      }
    },
    [
      "rampNeverSkipsABucket",
      "engineRefreshCountWebGPUInBand",
      "engineRefreshCountWebGLInBand",
      "sweepQuiescenceInBand",
    ],
  );
});

test("D9 a stale-dark LATCH fails the recovery gate — the row's whole point", () => {
  expectFailure(
    (run) => {
      // The one-way "only re-fill when it got darker" gate: the environment never
      // brightens back, so the recovered frame still reads the deep-phase cube.
      for (const lane of [run.iblWebGPU, run.iblWebGL]) {
        lane.ibl.recovered.mean = lane.ibl.deepest.mean;
      }
    },
    ["iblRecovers"],
  );
});

test("D10 an IBL that does not respond at all fails, and so does DOUBLE dimming", () => {
  expectFailure(
    (run) => {
      for (const lane of [run.iblWebGPU, run.iblWebGL]) {
        lane.ibl.deepest.mean = lane.ibl.baseline.mean;
      }
    },
    ["iblDimsAtDeepest"],
  );
  expectFailure(
    (run) => {
      const factor = predictFactor(SWEEP_PEAK_OBSCURATION);
      for (const lane of [run.iblWebGPU, run.iblWebGL]) {
        lane.ibl.deepest.mean = lane.ibl.baseline.mean * factor * factor;
      }
    },
    ["iblDimsAtDeepest"],
  );
});

test("D11 a noisy control (the eclipse-off leg re-filling) fails", () => {
  expectFailure(
    (run) => {
      run.iblWebGPU.controlRefreshCount = 40;
    },
    ["controlRefreshQuiescent"],
  );
});

test("D12 an unreproducible capture fails the determinism bracket", () => {
  expectFailure(
    (run) => {
      run.cloudLanes.repeat.delta = 0.02;
    },
    ["determinismBracketHolds"],
  );
});

test("D13 a cost differential that cannot be formed fails — the row does NOT discharge", () => {
  expectFailure(
    (run) => {
      // Same fill count in both legs: nothing to attribute the wall clock to.
      run.iblWebGPU.refreshCost.eclipseFills =
        run.iblWebGPU.refreshCost.controlFills;
    },
    ["refreshCostMeasured"],
  );
});

test("D14 the cost IS reported when the differential exists", () => {
  const verdict = judgeEclipseCloudResponse(passingRun());
  // 4000 ms over 274 eclipse-driven fills.
  assert.equal(Number(verdict.cost.webgpuMsPerRefresh.toFixed(4)), 14.5985);
  assert.equal(verdict.refreshCostMeasured, true);
  assert.equal(verdict.cost.webgpu.valid, true);
  assert.deepEqual(verdict.cost.invalidReasons, []);
});

test("D15 backend divergence in the published factor fails PARITY, not a lane gate", () => {
  const run = clone(passingRun());
  run.iblWebGL.factors = run.iblWebGL.factors.map((f) => f * 0.999);
  const verdict = judgeEclipseCloudResponse(run);
  assert.deepEqual(verdict.failedPredicates, []);
  assert.ok(verdict.parityFailed.includes("sweepFactorSeriesParity"));
  assert.equal(verdict.PASS, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// E. Vacuity and absence are STRUCTURAL, never a product verdict
// ─────────────────────────────────────────────────────────────────────────────

test("E1 a deck that is not in frame is STRUCTURAL, not a deck FAIL", () => {
  const run = clone(passingRun());
  for (const rung of run.cloudLanes.rungs) {
    rung.deck.offContribution = 0.001;
    rung.deck.onContribution = 0.0005;
  }
  const verdict = judgeEclipseCloudResponse(run);
  assert.ok(verdict.structuralReasons.length > 0);
  assert.deepEqual(
    verdict.failedPredicates,
    [],
    "a lane that could not see its subject must not emit a product verdict",
  );
  assert.equal(verdict.PASS, false);
});

test("E2 a cast shadow that does not darken the ground is STRUCTURAL", () => {
  const run = clone(passingRun());
  for (const rung of run.cloudLanes.rungs) {
    rung.shadow.offShadow = rung.shadow.offNoShadow;
    rung.shadow.onShadow = rung.shadow.onNoShadow;
  }
  const verdict = judgeEclipseCloudResponse(run);
  assert.ok(
    verdict.structuralReasons.some((r) => r.includes("ground contrast")),
    JSON.stringify(verdict.structuralReasons),
  );
  assert.deepEqual(verdict.failedPredicates, []);
});

test("E2b a ground too DARK to carry a shadow is STRUCTURAL, and names why", () => {
  // The offline pin removes every imagery layer, so an un-brightened globe
  // renders `baseColor` (0, 0, 0.5) at luma 0.036. The beer floor removes at
  // most 65% of that. The contrast ceiling can only ever report "no shadow";
  // this detector reports the REASON.
  const run = clone(passingRun());
  for (const rung of run.cloudLanes.rungs) {
    const dark = 0.036;
    rung.shadow.offNoCloud = dark;
    rung.shadow.offNoShadow = dark;
    rung.shadow.offShadow = dark * shadowContrast(1.0);
    rung.shadow.onNoShadow = dark * predictFactor(rung.target);
    rung.shadow.onShadow =
      rung.shadow.onNoShadow * shadowContrast(predictDirectional(rung.target));
  }
  settleDeckFreeTwins(run);
  const verdict = judgeEclipseCloudResponse(run);
  assert.equal(verdict.shadowGroundIsBright, false);
  assert.ok(
    verdict.structuralReasons.some((r) => r.includes("brightness floor")),
    JSON.stringify(verdict.structuralReasons),
  );
  assert.deepEqual(
    verdict.failedPredicates,
    [],
    "a lane that cannot photometrically see its subject must not emit a verdict",
  );
  // ...and it must NOT drag the deck or IBL lanes down with it.
  assert.ok(!verdict.unscoredPredicates.includes("deckRatioInBand"));
  assert.ok(!verdict.unscoredPredicates.includes("iblRecovers"));
});

test("E2c the SECOND run's exact shape — a deck sitting in the ground band — is STRUCTURAL", () => {
  // Replays the 2026-08-07 second Edge run's lane B verbatim: 9000 m above a
  // 1500-4000 m deck, band mean 0.512511 clouds-on vs a ~0.03 deck-free ground,
  // shadowed 0.511866 (contrast 0.998743). The old fold could only say "the
  // cast shadow is not darkening the ground", which pointed the diagnosis at
  // the engine. The retention read-back says what actually happened.
  const run = clone(passingRun());
  for (const rung of run.cloudLanes.rungs) {
    rung.shadow.offNoCloud = 0.03;
    rung.shadow.offNoShadow = 0.512511;
    rung.shadow.offShadow = 0.511866;
    rung.shadow.onNoShadow = 0.378175;
    rung.shadow.onShadow = 0.377913;
  }
  settleDeckFreeTwins(run);
  const verdict = judgeEclipseCloudResponse(run);
  assert.equal(verdict.shadowGroundIsBright, false);
  assert.equal(verdict.shadowGroundNotOccluded, false);
  assert.ok(
    verdict.structuralReasons.some((r) => r.includes("turning the deck on")),
    JSON.stringify(verdict.structuralReasons),
  );
  // The retention ratio is the headline number: the deck made the "ground"
  // band 17x brighter than the ground.
  assert.equal(
    Number(verdict.shadowGroundRetentionRatio.toFixed(2)),
    17.08,
    "the second run's band was 17x the deck-free ground — it was not ground",
  );
  assert.deepEqual(verdict.failedPredicates, []);
  assert.equal(verdict.exitCode, 3);
});

test("E3 a wrong backend on the cloud lane is STRUCTURAL", () => {
  const run = clone(passingRun());
  run.cloudLanes.rendererType = "webgl";
  const verdict = judgeEclipseCloudResponse(run);
  assert.ok(verdict.structuralReasons.some((r) => r.includes("webgpu")));
  assert.deepEqual(verdict.failedPredicates, []);
});

test("E4 a missing lane is STRUCTURAL and short-circuits the fold", () => {
  for (const key of ["cloudLanes", "iblWebGPU", "iblWebGL"]) {
    const run = clone(passingRun());
    run[key] = { structuralError: "lane blew up" };
    const verdict = judgeEclipseCloudResponse(run);
    assert.equal(verdict.structuralReasons.length, 1);
    assert.deepEqual(verdict.failedPredicates, []);
    assert.equal(verdict.PASS, false);
  }
});

test("E5 an unlit IBL model band is STRUCTURAL", () => {
  const run = clone(passingRun());
  run.iblWebGPU.ibl.baseline.litFraction = 0.001;
  const verdict = judgeEclipseCloudResponse(run);
  assert.ok(verdict.structuralReasons.some((r) => r.includes("unlit")));
  assert.deepEqual(verdict.failedPredicates, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// G. THE EXIT CONTRACT (Batch 909 instrument fix 1)
//
// The first run printed EXIT 2 on a STRUCTURAL verdict, colliding with the
// watchdog's own code, so a reader could not tell a probe that REFUSED to
// certify from one that never FINISHED.
// ─────────────────────────────────────────────────────────────────────────────

test("G1 the four exit codes are 0 PASS / 1 FAIL / 2 HARNESS / 3 STRUCTURAL", () => {
  assert.deepEqual(
    { ...ECLIPSE_CLOUD_EXIT },
    {
      PASS: 0,
      FAIL: 1,
      HARNESS: 2,
      STRUCTURAL: 3,
    },
  );
});

test("G2 a STRUCTURAL verdict exits 3, NEVER 2 — the first run's exact defect", () => {
  const structural = { structuralReasons: ["a lane went blind"] };
  assert.equal(eclipseCloudExitCode(structural), 3);
  assert.notEqual(
    eclipseCloudExitCode(structural),
    ECLIPSE_CLOUD_EXIT.HARNESS,
    "exit 2 is the watchdog's code; a structural refusal must not collide with it",
  );
  assert.equal(eclipseCloudGateLabel(structural), "STRUCTURAL");

  // The MUTANT: the mapping the first run shipped. It must be rejected.
  const mutantExitCode = (outcome) =>
    (outcome.structuralReasons?.length ?? 0) > 0
      ? 2
      : (outcome.failedPredicates?.length ?? 0)
        ? 1
        : 0;
  assert.equal(mutantExitCode(structural), 2);
  assert.notEqual(
    mutantExitCode(structural),
    eclipseCloudExitCode(structural),
    "the shipped mapping must differ from the mutant that returns 2 for structural",
  );
});

test("G3 PASS, FAIL and HARNESS map, and FAIL OUTRANKS structural", () => {
  assert.equal(eclipseCloudExitCode({}), 0);
  assert.equal(eclipseCloudGateLabel({}), "PASS");
  assert.equal(eclipseCloudExitCode({ failedPredicates: ["x"] }), 1);
  assert.equal(eclipseCloudExitCode({ parityFailed: ["y"] }), 1);
  assert.equal(eclipseCloudExitCode({ harnessFault: true }), 2);
  assert.equal(eclipseCloudGateLabel({ harnessFault: true }), "HARNESS FAULT");
  // A harness fault outranks everything: no verdict was formed at all.
  assert.equal(
    eclipseCloudExitCode({
      harnessFault: true,
      failedPredicates: ["x"],
      structuralReasons: ["z"],
    }),
    2,
  );
  // A quarantined lane PLUS a real failure in an evaluable one is a FAIL. This
  // is the first run's shape and the reason the ranking is this way round.
  assert.equal(
    eclipseCloudExitCode({
      structuralReasons: ["shadow lane blind"],
      failedPredicates: ["deckRatioInBand"],
    }),
    1,
  );
});

test("G4 the judge's own exitCode/GATE agree with the pure mapping", () => {
  const pass = judgeEclipseCloudResponse(passingRun());
  assert.equal(pass.exitCode, 0);
  assert.equal(pass.GATE, "PASS");

  const blind = clone(passingRun());
  for (const rung of blind.cloudLanes.rungs) {
    rung.shadow.offShadow = rung.shadow.offNoShadow;
    rung.shadow.onShadow = rung.shadow.onNoShadow;
  }
  const blindVerdict = judgeEclipseCloudResponse(blind);
  assert.equal(blindVerdict.exitCode, 3);
  assert.equal(blindVerdict.GATE, "STRUCTURAL");
  assert.equal(blindVerdict.exitCode, eclipseCloudExitCode(blindVerdict));
});

// ─────────────────────────────────────────────────────────────────────────────
// H. PER-LANE STRUCTURAL SCOPING (Batch 909 instrument fix 2)
//
// The first run: shadow lane vacuous, deck ratio 2.937 out of band, and
// `failedPredicates: []`. A blind lane must quarantine ITS OWN predicates and
// nothing else.
// ─────────────────────────────────────────────────────────────────────────────

test("H1 the first run's EXACT shape — shadow-blind + deck out of band — is a FAIL, not STRUCTURAL", () => {
  const run = clone(passingRun());
  // (a) the shadow lane goes vacuous, exactly as measured: 0.9969 against the
  //     0.98 ceiling.
  for (const rung of run.cloudLanes.rungs) {
    rung.shadow.offShadow = rung.shadow.offNoShadow * 0.9969;
    rung.shadow.onShadow = rung.shadow.onNoShadow * 0.9969;
  }
  // (b) the deck reads 2.937 with the background verifiably dark, so the deck
  //     lane can still see and its verdict still counts.
  for (const rung of run.cloudLanes.rungs) {
    rung.deck.onContribution = rung.deck.offContribution * 2.937;
  }
  const verdict = judgeEclipseCloudResponse(run);

  assert.ok(
    verdict.structuralReasons.some((r) => r.includes("ground contrast")),
    "the shadow lane must still report itself blind",
  );
  assert.deepEqual(
    verdict.unscoredPredicates.sort(),
    [
      "shadowGroundIsBright",
      "shadowGroundNotOccluded",
      "shadowNonVacuous",
      "shadowContrastInvariant",
      "shadowContrastRejectsAlternativeDesign",
      // CO-21: `deck-free` is a CHILD of `shadow`, so a blind lane B takes the
      // attribution AND its convergence precondition with it — the direction
      // that must hold. The converse (an unsettled control blinding the
      // contrast) is what the parent chain deliberately prevents; L9 pins it.
      "deckFreeGroundCapturesSettled",
      "deckFreeGroundDimsByFactor",
    ].sort(),
    "ONLY the shadow lane's own predicates may be quarantined",
  );
  assert.ok(
    verdict.failedPredicates.includes("deckRatioInBand"),
    `the deck FAIL must survive the shadow lane's blindness: ${JSON.stringify(verdict.failedPredicates)}`,
  );
  assert.equal(verdict.exitCode, 1, "FAIL outranks the quarantine");
  assert.equal(verdict.GATE, "FAIL");
  // ...and this is precisely what the old fold did instead.
  assert.notDeepEqual(verdict.failedPredicates, []);
});

test("H2 a blind DECK lane leaves the shadow and IBL lanes gating", () => {
  const run = clone(passingRun());
  for (const rung of run.cloudLanes.rungs) {
    rung.deck.offContribution = 0.001;
    rung.deck.onContribution = 0.0005;
  }
  // Break the IBL recovery at the same time: it must still FAIL.
  for (const lane of [run.iblWebGPU, run.iblWebGL]) {
    lane.ibl.recovered.mean = lane.ibl.deepest.mean;
  }
  const verdict = judgeEclipseCloudResponse(run);
  assert.deepEqual(
    verdict.unscoredPredicates.sort(),
    [
      "deckNonVacuous",
      "deckRatioInBand",
      "deckRatioMonotone",
      "deckBackgroundIsDark",
      "deckPureRatioInBand",
    ].sort(),
  );
  assert.deepEqual(verdict.failedPredicates, ["iblRecovers"]);
  assert.equal(verdict.exitCode, 1);
});

test("H3 a blind cloud PAGE blinds both its lanes and nothing else", () => {
  const run = clone(passingRun());
  run.cloudLanes.rendererType = "webgl";
  const verdict = judgeEclipseCloudResponse(run);
  for (const name of ECLIPSE_CLOUD_GATE_PREDICATES) {
    const lane = ECLIPSE_CLOUD_PREDICATE_LANES[name];
    // `deck-free` is a descendant of `shadow`, so the cloud page owns it too —
    // resolved through `ECLIPSE_CLOUD_LANE_PARENTS` rather than restated, so a
    // new child domain cannot be added without this list following it.
    const cloudOwned = laneIsBlind(
      { "cloud-page": ["blind"] },
      ECLIPSE_CLOUD_PREDICATE_LANES[name],
    );
    assert.equal(
      verdict.unscoredPredicates.includes(name),
      cloudOwned,
      `${name} (${lane}) quarantine state is wrong`,
    );
  }
  assert.deepEqual(verdict.failedPredicates, []);
  assert.equal(verdict.exitCode, 3);
});

test("H4 a blind IBL page also quarantines PARITY, since both legs read it", () => {
  const run = clone(passingRun());
  run.iblWebGL = { structuralError: "the WebGL IBL lane did not run" };
  const verdict = judgeEclipseCloudResponse(run);
  assert.deepEqual(verdict.unscoredParityPredicates, [
    ...ECLIPSE_CLOUD_PARITY_PREDICATES,
  ]);
  assert.deepEqual(verdict.parityFailed, []);
  // ...but the cloud page is untouched.
  assert.deepEqual(verdict.failedPredicates, []);
  assert.ok(!verdict.unscoredPredicates.includes("deckRatioInBand"));
  assert.equal(verdict.exitCode, 3);
});

test("H5 the arithmetic-only predicate is NEVER quarantined", () => {
  const run = {
    cloudLanes: { structuralError: "gone" },
    iblWebGPU: { structuralError: "gone" },
    iblWebGL: { structuralError: "gone" },
  };
  const verdict = judgeEclipseCloudResponse(run);
  assert.ok(
    !verdict.unscoredPredicates.includes("predictedRefreshCountExact"),
    "the 275 derivation needs no run input and must always be scored",
  );
  assert.deepEqual(verdict.failedPredicates, []);
  assert.equal(verdict.predictedRefreshCountExact, true);
  assert.equal(verdict.exitCode, 3);
});

test("H6 the deck ISOLATION precondition is structural, and 2.937 is unattainable", () => {
  // A ratio above 1 is impossible for ANY deck: the pre-tonemap radiance is
  // exactly linear in the eclipse factor F <= 1 and Reinhard is monotone, so
  // H(F) <= H(1). Even the FILED `C13-41-CLOUD-AMBIENT-IS-A-CONSTANT`
  // mechanism — an ambient term that refuses to dim — has a supremum of 1.
  const reinhard = (x) => x / (1 + x);
  const F = predictFactor(SWEEP_PEAK_OBSCURATION);
  for (const direct of [0.1, 1.8, 10, 52]) {
    for (const ambient of [0.45, 0.9, 1.43]) {
      const shipped =
        reinhard(0.22 * F * (direct + ambient)) /
        reinhard(0.22 * (direct + ambient));
      const ambientUndimmed =
        reinhard(0.22 * (F * direct + ambient)) /
        reinhard(0.22 * (direct + ambient));
      assert.ok(shipped <= 1, `shipped deck ratio ${shipped} exceeds 1`);
      assert.ok(
        ambientUndimmed <= 1,
        `constant-ambient deck ratio ${ambientUndimmed} exceeds 1`,
      );
      assert.ok(
        ambientUndimmed >= shipped,
        "a constant ambient can only RAISE the ratio, never above 1",
      );
    }
  }
  // ...so a background that survives the difference is the only way to 2.937,
  // and the ceiling catches it STRUCTURALLY rather than as a deck FAIL.
  const run = clone(passingRun());
  for (const rung of run.cloudLanes.rungs) {
    rung.deck.offBare = 0.5;
    rung.deck.onBare = 0.376;
    rung.deck.onContribution = rung.deck.offContribution * 2.937;
  }
  const verdict = judgeEclipseCloudResponse(run);
  assert.ok(
    verdict.structuralReasons.some((r) => r.includes("isolation ceiling")),
    JSON.stringify(verdict.structuralReasons),
  );
  assert.ok(verdict.unscoredPredicates.includes("deckRatioInBand"));
  assert.deepEqual(verdict.failedPredicates, []);
  assert.equal(verdict.exitCode, 3);
});

test("H7 the band [0.44, 0.70] IS the pure-deck formula F(1+e)/(1+Fe)", () => {
  // The row's "0.46 (faint deck) to ~0.63 (a bright core at exposed radiance
  // ~1)" is exactly this curve, which is the ratio of two Reinhards of the SAME
  // radiance scaled by F — i.e. it presumes NO background term.
  const F = predictFactor(SWEEP_PEAK_OBSCURATION);
  const pure = (e) => (F * (1 + e)) / (1 + F * e);
  assert.equal(Number(pure(0).toFixed(4)), 0.4642);
  assert.equal(Number(pure(1).toFixed(4)), 0.6341);
  const b = ECLIPSE_CLOUD_BANDS.deckDisplayedRatio;
  assert.ok(pure(0) > b.lo && pure(1) < b.hi);
  // The curve is monotone in e and bounded by 1, so no exposure choice can
  // reach the first run's 2.937.
  assert.ok(pure(1e6) < 1.0);
});

// ─────────────────────────────────────────────────────────────────────────────
// I. THE REFRESH-COST ARITHMETIC (Batch 909 instrument fix 3)
// ─────────────────────────────────────────────────────────────────────────────

const costInput = (overrides) => ({
  warmupBothLegs: true,
  segmentsPerLeg: 8,
  eclipseFrames: 801,
  controlFrames: 801,
  eclipseWallMs: 9000,
  controlWallMs: 5000,
  eclipseFills: 282,
  controlFills: 8,
  ...overrides,
});

test("I1 the estimate is (eclipseMs - controlMs) / (eclipseFills - controlFills)", () => {
  const cost = computeRefreshCost(costInput({}));
  assert.equal(cost.valid, true);
  assert.equal(cost.msDelta, 4000);
  assert.equal(cost.fillDelta, 274);
  assert.equal(Number(cost.msPerRefresh.toFixed(4)), 14.5985);
  assert.equal(cost.invalidReason, null);
});

test("I2 a NEGATIVE differential is INVALID with a named reason, never a number", () => {
  // The first run's actual numbers: 0.77 s eclipse leg, 5.97 s control leg.
  const cost = computeRefreshCost(
    costInput({ eclipseWallMs: 770, controlWallMs: 5970 }),
  );
  assert.equal(cost.valid, false);
  assert.equal(cost.msPerRefresh, null, "a negative cost is never reported");
  assert.match(cost.invalidReason, /control leg outran the eclipse leg/);
  assert.match(cost.invalidReason, /5970/);
  assert.match(cost.invalidReason, /770/);
  // The old arithmetic would have published -18.98 ms/refresh as a measurement.
  assert.equal(Number(((770 - 5970) / 274).toFixed(2)), -18.98);
});

test("I3 missing warm-up parity is its own named reason — the first run's cause", () => {
  const cost = computeRefreshCost(costInput({ warmupBothLegs: false }));
  assert.equal(cost.valid, false);
  assert.equal(cost.msPerRefresh, null);
  assert.match(cost.invalidReason, /warm-up parity/);
});

test("I4 a SEQUENTIAL A/B is rejected — interleaving is required, not advised", () => {
  assert.ok(REFRESH_COST_MIN_SEGMENTS_PER_LEG >= 3);
  for (const segments of [1, 2]) {
    const cost = computeRefreshCost(costInput({ segmentsPerLeg: segments }));
    assert.equal(cost.valid, false, `${segments} segment(s) must be rejected`);
    assert.match(cost.invalidReason, /not interleaved/);
  }
  assert.equal(
    computeRefreshCost(
      costInput({ segmentsPerLeg: REFRESH_COST_MIN_SEGMENTS_PER_LEG }),
    ).valid,
    true,
  );
});

test("I5 unequal frame counts and a zero fill delta are both INVALID", () => {
  const uneven = computeRefreshCost(costInput({ controlFrames: 400 }));
  assert.equal(uneven.valid, false);
  assert.match(uneven.invalidReason, /different frame counts/);

  const noFills = computeRefreshCost(costInput({ eclipseFills: 8 }));
  assert.equal(noFills.valid, false);
  assert.match(noFills.invalidReason, /no eclipse-driven fills/);
  assert.match(noFills.invalidReason, /does NOT discharge/);

  const absent = computeRefreshCost(undefined);
  assert.equal(absent.valid, false);
  assert.match(absent.invalidReason, /no refresh-cost accounting/);
});

test("I6 a zero differential is VALID at exactly 0 — non-negative by construction", () => {
  const cost = computeRefreshCost(costInput({ eclipseWallMs: 5000 }));
  assert.equal(cost.valid, true);
  assert.equal(cost.msPerRefresh, 0);
  assert.ok(cost.msPerRefresh >= 0);
});

test("I7 the fold refuses to discharge the row when EITHER backend is INVALID", () => {
  const run = clone(passingRun());
  run.iblWebGL.refreshCost.eclipseWallMs = 100;
  const verdict = judgeEclipseCloudResponse(run);
  assert.equal(verdict.refreshCostMeasured, false);
  assert.equal(verdict.cost.webglMsPerRefresh, null);
  assert.equal(verdict.cost.webgpu.valid, true);
  assert.equal(verdict.cost.invalidReasons.length, 1);
  assert.match(verdict.cost.invalidReasons[0], /^webgl: /);
  assert.deepEqual(verdict.failedPredicates, ["refreshCostMeasured"]);
});

// ─────────────────────────────────────────────────────────────────────────────
// F. The probe drives the surfaces this gate assumes exist
// ─────────────────────────────────────────────────────────────────────────────

test("F1 the probe reads the committed bucket from BOTH managers' own seam", () => {
  const probe = fs
    .readFileSync(path.join(here, "probe-eclipse-cloud-response.mjs"), "utf8")
    .replace(/\r\n/g, "\n");
  assert.match(probe, /webgpu\.lastEclipseEnvBucket/);
  assert.match(probe, /manager\._lastEclipseEnvBucket/);
  // ...and those are the names the engine actually commits.
  assert.match(
    readEngine("Renderer/WebGPU/WebGPUDynamicEnvironmentMapManager.ts"),
    /cache\.lastEclipseEnvBucket = eclipseEnvBucket;/,
  );
  assert.match(
    readEngine("Scene/DynamicEnvironmentMapManager.js"),
    /this\._lastEclipseEnvBucket = eclipseEnvBucket;/,
  );
  // The shadow strength the lane-B gate reads comes from the ONE published
  // seam, not a consumer's copy.
  assert.match(probe, /_cloudCache\?\.shadowStrength/);
  assert.match(
    readEngine("Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts"),
    /cache\.shadowStrength = eclipseCloudDirectionalFraction\(frameState\);/,
  );
});

test("F2 the probe follows the pinning doctrine it documents", () => {
  const probe = fs
    .readFileSync(path.join(here, "probe-eclipse-cloud-response.mjs"), "utf8")
    .replace(/\r\n/g, "\n");
  assert.match(probe, /installWeatherPinHarnessOnPage/);
  assert.match(probe, /installCloudProbeHarnessOnPage/);
  assert.match(probe, /offline=true/);
  assert.match(probe, /collectPinStructural/);
  assert.match(probe, /awaitProceduralReady/);
  assert.match(probe, /awaitGlobeReady/);
  assert.match(probe, /WEATHER_DETERMINISM_DIALS/);
  assert.match(probe, /PINNED_CLOUD_QUALITY|cloudQuality/);
  // Watchdog + close-in-finally + the 0/1/2/3 exit contract.
  assert.match(probe, /watchdog\.unref\(\)/);
  assert.match(probe, /\} finally \{\n\s*await browser\.close\(\)/);
  assert.match(probe, /process\.exit\(exitCode\)/);
  // The mapping comes from the pinned pure function, NOT from a ternary in the
  // driver. That ternary is what shipped `2` for a STRUCTURAL verdict.
  assert.match(probe, /const exitCode = eclipseCloudExitCode\(outcome\)/);
  assert.ok(
    !/pinReasons\.length > 0 \? 3 : structural \? 2 :/.test(probe),
    "the first run's exit ternary must be gone, not merely bypassed",
  );
  // The determinism bracket and the discarded warm-up.
  assert.match(probe, /discarded on purpose/);
  assert.match(probe, /repeat-A0-eclipseOff-cloudsOn/);
  // Canvas-ELEMENT data, reduced in-page, never a page screenshot.
  assert.ok(!probe.includes("page.screenshot"));
});

test("F3 the probe establishes the deck ISOLATION and the lane-B shadow geometry", () => {
  const probe = fs
    .readFileSync(path.join(here, "probe-eclipse-cloud-response.mjs"), "utf8")
    .replace(/\r\n/g, "\n");
  // Isolation: the background is removed, so `cloudsOn - cloudsOff` is the deck
  // and not `alpha * (H - S)`.
  assert.match(probe, /sky: false/);
  assert.match(probe, /deckBackgroundIsDark/);
  // ...and the shared pinning harness really does black the background out.
  const pinning = fs
    .readFileSync(path.join(here, "lib", "weather-probe-pinning.mjs"), "utf8")
    .replace(/\r\n/g, "\n");
  assert.match(pinning, /opts\.sky === false/);
  assert.match(pinning, /skyAtmosphere\.show = false/);
  assert.match(pinning, /scene\.backgroundColor = C\.Color\.BLACK/);

  // Lane B flies its own camera, and it has to clear TWO vacuity traps at once.
  assert.match(probe, /groundCameraHeight: 1400\.0/);
  assert.match(probe, /groundPitchDegrees: -8\.0/);
  assert.match(
    probe,
    /aimCamera\(julian, cfg\.groundPitchDegrees, cfg\.groundCameraHeight\)/,
  );
  const engineCloud = readEngine(
    "Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts",
  );
  assert.match(engineCloud, /const CLOUD_SHADOW_SIZE = 512;/);
  assert.match(engineCloud, /const CLOUD_SHADOW_FOOTPRINT_M = 60000\.0;/);

  // TRAP 1 — GEOMETRIC (the first run, 300 m / -35 deg). One texel is 234 m of
  // ground, and that vantage's scored band was ~131 m deep: sub-texel, so the
  // map was constant over the whole measurement by construction.
  assert.equal(Number(((2 * 60000) / 512).toFixed(1)), 234.4);
  // `bandDepth` for a camera at `height` looking down, over the scored
  // 60%..95% of the frame: `height/tan(near angle) - height/tan(far angle)`.
  const bandDepth = (height, nearAngle, farAngle) =>
    height / Math.tan((farAngle * Math.PI) / 180) -
    height / Math.tan((nearAngle * Math.PI) / 180);
  assert.ok(
    bandDepth(300, 50.8, 38.6) < 234.4,
    "the 300 m vantage's scored band must be sub-texel — that is diagnosis 1",
  );
  // The 1400 m / -8 deg vantage: down-angles 11.7..24.3 deg (vertical half-FOV
  // 18 deg on a 1280x720 canvas at the default 60 deg horizontal FOV).
  assert.ok(
    bandDepth(1400, 24.3, 11.7) > 10 * 234.4,
    "the 1400 m vantage must span many texels",
  );

  // TRAP 2 — PHOTOMETRIC (the second run, 9000 m / -38 deg). That vantage
  // cleared trap 1 and still read 0.9987, because it flew ABOVE the
  // 1500-4000 m deck: the line of sight to the ground crossed the cloud, the
  // band was ~98% cloud top, and the beer floor's reach over a ~1.8% ground
  // share is 0.65 * 0.018 = 1.2% — the 0.98 ceiling was unreachable. Reproduce
  // that arithmetic here so the fix cannot be undone without failing.
  const DECK_BOTTOM = 1500;
  const beerReach = (groundShare) => groundShare * (1 - 0.35);
  assert.ok(
    beerReach(0.018) < 1 - ECLIPSE_CLOUD_BANDS.shadowVacuityCeiling.hi,
    "a 1.8% ground share cannot cross the vacuity ceiling — that is diagnosis 2",
  );
  assert.equal(
    Number(
      (
        beerReach(ECLIPSE_CLOUD_BANDS.shadowGroundBrightness.lo) /
        (1 - ECLIPSE_CLOUD_BANDS.shadowVacuityCeiling.hi)
      ).toFixed(3),
    ),
    4.875,
    "the brightness floor clears the vacuity ceiling by 4.875x — the band's own `why`",
  );
  // The fix is structural, not a tuning: the camera is BELOW the deck floor, so
  // the line of sight to the scored ground never crosses the deck at all.
  assert.ok(
    1400 < DECK_BOTTOM,
    "lane B must fly below the deck floor for the ground band to be ground",
  );
  assert.match(probe, /cloudLayerBottom: 1500/);
  // And the probe brightens the offline globe, whose default base colour cannot
  // carry the measurement.
  assert.match(
    probe,
    /scene\.globe\.baseColor = C\.Color\.fromBytes\(200, 200, 200\)/,
  );
  assert.match(
    readEngine("Scene/GlobeSurfaceTileProvider.js"),
    /this\.baseColor = new Color\(0\.0, 0\.0, 0\.5, 1\.0\);/,
  );
  assert.ok(
    0.2126 * 0 + 0.7152 * 0 + 0.0722 * 0.5 <
      ECLIPSE_CLOUD_BANDS.shadowGroundBrightness.lo,
    "the DEFAULT base colour must fail the brightness floor — that is what the floor is for",
  );
  // Both preconditions are read back, not assumed.
  assert.match(probe, /offNoCloud: bOffNoCloud\.mean/);
  assert.match(probe, /shadowGroundIsBright/);
  assert.match(probe, /shadowGroundNotOccluded/);
});

test("F5 lane B publishes the producer / consumer / footprint telemetry", () => {
  // The second run's report DID carry `shadowActiveOff/On`; nothing READ it, so
  // the row recorded the telemetry as missing. These three reads answer the
  // three separable questions a blind shadow lane raises, and the gate surfaces
  // them next to the verdict rather than three levels down in the JSON.
  const probe = fs
    .readFileSync(path.join(here, "probe-eclipse-cloud-response.mjs"), "utf8")
    .replace(/\r\n/g, "\n");
  // The provenance guard must refuse a build that predates the aerial-tint dim,
  // or the next run re-measures 0.894 against the OLD engine and reports it as
  // the fix's result.
  assert.match(probe, /marker: "dimAerialTint"/);
  assert.match(
    readEngine("Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts"),
    /const dimAerialTint = /,
  );
  assert.match(probe, /const cloudCacheTelemetry = \(\) => \{/);
  assert.match(probe, /const globeUniformTelemetry = \(\) => \{/);
  assert.match(probe, /const shadowFootprintTelemetry = \(\) => \{/);
  // The consumer read has to be the SAME slots the terrain FS branches on.
  assert.match(
    probe,
    /cloudShadowControl: \[data\[164\], data\[165\], data\[166\], data\[167\]\]/,
  );
  assert.match(probe, /cloudShadowRelativeToEye: data\[229\]/);
  const cameraUb = readEngine("Renderer/WebGPU/WebGPUGlobeSurfaceCameraUB.ts");
  assert.match(
    cameraUb,
    /cloudShadowVP \(mat4, offsets 148-163\) \+ cloudShadowControl \(vec4, 164-167\)/,
  );
  assert.match(cameraUb, /cascade tail \(196-231\)/);
  const globeFs = readEngine("Shaders/WebGPU/Globe/GlobeTerrain.wgsl");
  assert.match(globeFs, /if \(camera\.cloudShadowControl\.x > 0\.5\) \{/);
  assert.match(globeFs, /if \(camera\.cloudShadowCascadeParams\.y > 0\.5\) \{/);
  // And the verdict carries them, so the console line has something to print.
  const verdict = judgeEclipseCloudResponse(passingRun());
  assert.equal(verdict.shadowTelemetry.producerActiveOff, true);
  assert.equal(verdict.shadowTelemetry.cameraHeight, 1400);
  assert.equal(verdict.shadowTelemetry.pitchDegrees, -8);
  assert.match(probe, /SHADOW telemetry: producerActive off\/on/);
});

test("F6 the probe runs BOTH CO-19 legs and prints the tell unrounded", () => {
  const probe = fs
    .readFileSync(path.join(here, "probe-eclipse-cloud-response.mjs"), "utf8")
    .replace(/\r\n/g, "\n");

  // Lane B's eclipse-ON deck-free twin, at the same instant and over the same
  // dials as the OFF control it is compared against.
  assert.match(probe, /const bOnNoCloud = groundBand\(/);
  assert.match(probe, /B\$\{index\}-eclipseOn-cloudsOff/);
  assert.match(probe, /onNoCloud: bOnNoCloud\.mean,/);

  // Lane A's `cloudAerialStrength = 0` leg, at the deepest rung, over the dial
  // the shader actually reads.
  assert.match(
    probe,
    /const aerialZeroDials = \{ cloudAerialStrength: 0\.0 \};/,
  );
  assert.match(probe, /A\$\{index\}-aerial0-eclipseOn-cloudsOn/);
  assert.match(probe, /deckAerialZero: aerialZero,/);
  assert.match(
    readEngine("Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts"),
    /config\.cloudAerialStrength \?\? 1\.0; \/\/ 91 aerialStrength/,
  );
  assert.match(
    readEngine("Scene/CloudVolumetrics.js"),
    /this\.cloudAerialStrength = options\.cloudAerialStrength \?\? 1\.0;/,
  );
  // The dial is RE-PINNED on every configure, so the diagnostic leg cannot leak
  // into the captures that follow it — the dials live on a persistent object.
  assert.match(
    probe,
    /cloudAerialStrength: 1\.0,\n\s*\.\.\.cfg\.determinismDials,/,
  );

  // The tell is printed UNROUNDED: four identical f64s IS the discriminator,
  // and `r3()` would erase it.
  assert.match(probe, /SHADOW deck-free series: offNoCloud/);
  assert.match(probe, /\(t\.offNoCloudSeries \?\? \[\]\)\.join\(", "\)/);
  assert.match(probe, /DECK aerial-zero leg: pure ratio/);
});

test("F4 the probe's cost legs are interleaved and both pay a warm-up", () => {
  const probe = fs
    .readFileSync(path.join(here, "probe-eclipse-cloud-response.mjs"), "utf8")
    .replace(/\r\n/g, "\n");
  assert.match(probe, /const COST_SEGMENTS = 8;/);
  assert.match(probe, /runCostSegment/);
  assert.match(
    probe,
    /warmupBothLegs:\s*\n?\s*warmedLegs\.eclipse === true && warmedLegs\.control === true/,
  );
  assert.match(probe, /ABBA/);
  // The gate reads the interleaved accounting, not the two counting legs.
  assert.match(probe, /refreshCost,/);
  assert.ok(
    ECLIPSE_CLOUD_GATE_PREDICATES.includes("refreshCostMeasured"),
    "the cost must remain a gate, or the row silently stops discharging",
  );
  assert.ok(
    8 >= REFRESH_COST_MIN_SEGMENTS_PER_LEG,
    "the probe's segment count must satisfy the gate's interleaving minimum",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// J. THE AMBIENT/DIRECT SPLIT — the fifth-pass shadow model (CO-17)
//
// `C13-41-SHADOW-CONTRAST-ECLIPSE-EXCESS` named this extension as the
// derivation that would move the [0.97, 1.03] invariant if it predicted ~1.05.
// It predicts 1.0002. These tests are that arithmetic, and J3 is the reason the
// band stays where it is.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A SECOND implementation of the split, carrying the two things the closed form
 * cancels away — the residue's share and the beer transmittance — plus the one
 * thing the published laws do NOT contain: a residue that dims by its own law
 * `F^residueExponent` instead of by `F`. Every J test below compares against
 * this, never against `predictShadowContrastRatio` echoing itself.
 */
function contrastRatioWithResidueLaw({
  factor,
  residueShare,
  beer,
  strengthEclipse,
  strengthClear = 1,
  residueExponent = 1,
}) {
  const direct = 1 - residueShare;
  const residue = residueShare;
  const transmittance = (strength) => 1 - strength * (1 - beer);
  const at = (f, strength, exponent) => {
    const lit = direct * f;
    const floor = residue * Math.pow(f, exponent);
    return (transmittance(strength) * lit + floor) / (lit + floor);
  };
  return at(factor, strengthEclipse, residueExponent) / at(1, strengthClear, 1);
}

test("J1 the closed form has NO free parameters — the split and the beer term cancel", () => {
  // Two wildly different (share, transmittance) pairs chosen to land on the
  // SAME clear contrast. Under the published laws they must predict the same
  // eclipse contrast ratio, because the only thing that moves it is the shadow
  // strength. If the closed form were secretly carrying a split, these diverge.
  const strengthEclipse = 0.9995501111290277;
  const pairs = [
    { residueShare: 0, beer: 0.6 },
    { residueShare: 0.5, beer: 0.2 },
    { residueShare: 0.8, beer: -1.0 },
  ];
  const predictions = pairs.map(({ residueShare, beer }) => {
    const clearContrast = beer * (1 - residueShare) + residueShare;
    assert.ok(
      Math.abs(clearContrast - 0.6) < 1e-12,
      "the fixture pairs must share a clear contrast",
    );
    const second = contrastRatioWithResidueLaw({
      factor: 0.4642002390771099,
      residueShare,
      beer,
      strengthEclipse,
    });
    const closed = predictShadowContrastRatio({
      strengthClear: 1,
      strengthEclipse,
      clearContrast,
    });
    assert.ok(
      Math.abs(second - closed) < 1e-12,
      `closed form ${closed} != second implementation ${second}`,
    );
    return closed;
  });
  assert.ok(Math.abs(predictions[0] - predictions[1]) < 1e-12);
  assert.ok(Math.abs(predictions[0] - predictions[2]) < 1e-12);
  // And the eclipse FACTOR itself is absent: the same prediction at any depth.
  for (const factor of [1, 0.9, 0.4642002390771099, 0.01]) {
    const second = contrastRatioWithResidueLaw({
      factor,
      residueShare: 0.5,
      beer: 0.2,
      strengthEclipse,
    });
    assert.ok(Math.abs(second - predictions[0]) < 1e-12);
  }
});

test("J2 the directional-only model is the SUPREMUM of the split family, not a rival", () => {
  // Equality at the corner (no residue, transmittance at the beer floor), and
  // strictly below it everywhere the residue is real.
  for (const strengthEclipse of [1, 0.9995501111290277, 0.9, 0.5, 0]) {
    const supremum = shadowContrastRatioSupremum(strengthEclipse);
    const atCorner = predictShadowContrastRatio({
      strengthClear: 1,
      strengthEclipse,
      clearContrast: CLOUD_SHADOW_BEER_FLOOR,
    });
    assert.ok(
      Math.abs(atCorner - supremum) < 1e-12,
      `the corner must BE the directional-only model: ${atCorner} vs ${supremum}`,
    );
    for (const clearContrast of [0.5, 0.663306, 0.67987, 0.95]) {
      const split = predictShadowContrastRatio({
        strengthClear: 1,
        strengthEclipse,
        clearContrast,
      });
      assert.ok(
        split <= supremum + 1e-12,
        `a split reached ${split}, above the ${supremum} cap`,
      );
      if (strengthEclipse < 1) {
        assert.ok(
          split < supremum,
          "a real residue must DILUTE the move, not preserve it",
        );
      }
    }
  }
  assert.equal(shadowContrastModelIsBoundedByDirectional(), true);
});

test("J3 the extension predicts 1.0002 at the fourth run's numbers, so the BAND DOES NOT MOVE", () => {
  // The fourth Edge run (tip 6e9c997287), deepest rung, verbatim.
  const strengthEclipse = 0.9995501111290277;
  const clearContrast = 0.22385011803330374 / 0.32925418914786103;
  const measured = 0.12282138936132907 / 0.1721177829881891 / clearContrast;
  assert.ok(Math.abs(clearContrast - 0.67987) < 5e-6);
  assert.ok(Math.abs(measured - 1.049596) < 5e-6);

  const predicted = predictShadowContrastRatio({
    strengthClear: 1,
    strengthEclipse,
    clearContrast,
  });
  const supremum = shadowContrastRatioSupremum(strengthEclipse);
  assert.ok(
    Math.abs(predicted - 1.00021184) < 1e-7,
    `the split model predicts ${predicted}`,
  );
  assert.ok(
    Math.abs(supremum - 1.00083551) < 1e-7,
    `the directional-only model predicts ${supremum}`,
  );
  // The extension moves the prediction TOWARD 1, i.e. the opposite direction
  // from the measurement. That is the whole finding.
  assert.ok(predicted - 1 < supremum - 1);
  assert.ok(Math.abs((supremum - 1) / (predicted - 1) - 3.943) < 0.01);
  // 59x past the cap of the whole family: no split can reach the measurement.
  const excessOverCap = (measured - 1) / (supremum - 1);
  assert.ok(
    excessOverCap > 55 && excessOverCap < 65,
    `the measurement is ${excessOverCap}x the family cap`,
  );
  // THE BAND IS UNCHANGED, and this assertion is the point of the test.
  assert.equal(ECLIPSE_CLOUD_BANDS.shadowContrastRatio.lo, 0.97);
  assert.equal(ECLIPSE_CLOUD_BANDS.shadowContrastRatio.hi, 1.03);
  assert.ok(
    ECLIPSE_CLOUD_BANDS.shadowContrastRatio.why.includes(
      "the band DOES NOT MOVE",
    ),
    "the derivation that keeps the band has to be written where the band is",
  );
  // Headroom over the model, before and after the extension.
  assert.ok(Math.abs(0.03 / (supremum - 1) - 35.9) < 0.5);
  assert.ok(Math.abs(0.03 / (predicted - 1) - 141.6) < 1.0);
});

test("J4 MUTANT — only a residue law the publication does NOT contain reaches 1.05", () => {
  const strengthEclipse = 0.9995501111290277;
  const factor = 0.4642002390771099;
  const clearContrast = 0.22385011803330374 / 0.32925418914786103;
  // The residue's share implied by that clear contrast at the beer floor.
  const residueShare = 1 - (1 - clearContrast) / (1 - CLOUD_SHADOW_BEER_FLOOR);
  assert.ok(Math.abs(residueShare - 0.507493) < 1e-5);

  // p = 1 — the published laws. Reproduces the closed form exactly.
  const published = contrastRatioWithResidueLaw({
    factor,
    residueShare,
    beer: CLOUD_SHADOW_BEER_FLOOR,
    strengthEclipse,
    residueExponent: 1,
  });
  assert.ok(
    Math.abs(
      published -
        predictShadowContrastRatio({
          strengthClear: 1,
          strengthEclipse,
          clearContrast,
        }),
    ) < 1e-12,
  );
  assert.ok(
    published >= ECLIPSE_CLOUD_BANDS.shadowContrastRatio.lo &&
      published <= ECLIPSE_CLOUD_BANDS.shadowContrastRatio.hi,
    "the published laws land INSIDE the invariant, as designed",
  );

  // p = 0.708 — the exponent the fourth run's three rungs actually fit. This is
  // the mutant: a residue that dims SUB-linearly. It reproduces the measurement
  // and leaves the band, which is what makes 1.0496 a product finding rather
  // than a modelling gap.
  const subLinear = contrastRatioWithResidueLaw({
    factor,
    residueShare,
    beer: CLOUD_SHADOW_BEER_FLOOR,
    strengthEclipse,
    residueExponent: 0.708,
  });
  assert.ok(
    Math.abs(subLinear - 1.049596) < 0.006,
    `the sub-linear residue predicts ${subLinear} against the measured 1.049596`,
  );
  assert.ok(subLinear > ECLIPSE_CLOUD_BANDS.shadowContrastRatio.hi);
  // A residue that dims SUPER-linearly moves it the other way, so the sign of
  // the excess is itself diagnostic.
  assert.ok(
    contrastRatioWithResidueLaw({
      factor,
      residueShare,
      beer: CLOUD_SHADOW_BEER_FLOOR,
      strengthEclipse,
      residueExponent: 1.5,
    }) < 1,
  );
});

test("J5 the shadowable term's law is recoverable from the four band reads alone", () => {
  // Round trip on a synthetic rung whose split, transmittance and two dimming
  // laws are all known.
  const beer = 0.42;
  const residueShare = 0.3;
  const direct = 1 - residueShare;
  for (const [d, a] of [
    [0.4642002390771099, 0.4642002390771099],
    [0.4642002390771099, 0.62],
    [0.31, 0.9],
  ]) {
    const shadow = {
      offNoShadow: direct + residueShare,
      offShadow: beer * direct + residueShare,
      onNoShadow: direct * d + residueShare * a,
      onShadow: beer * direct * d + residueShare * a,
    };
    assert.ok(
      Math.abs(extractShadowableDimming(shadow) - d) < 1e-12,
      "the inversion must return the shadowable term's own law",
    );
  }
  // The fourth run's four rungs: the SHADOWABLE term dims by exactly the
  // published factor to under 1%, while BOTH bands under-dim by up to 12.6% /
  // 18.2%. The defect is in the residue, not in the shadow path.
  const measured = [
    {
      factor: 1,
      offNoShadow: 0.31876608674032336,
      offShadow: 0.21143960549489235,
      onNoShadow: 0.31876608674032336,
      onShadow: 0.21143960549489235,
    },
    {
      factor: 0.8879051946524728,
      offNoShadow: 0.32176625572455075,
      offShadow: 0.21351292724028043,
      onNoShadow: 0.2907439288632721,
      onShadow: 0.19535515345023421,
    },
    {
      factor: 0.7690319128580584,
      offNoShadow: 0.3249127691632386,
      offShadow: 0.21815151409170608,
      onNoShadow: 0.260078973339444,
      onShadow: 0.17835615828277648,
    },
    {
      factor: 0.4642002390771099,
      offNoShadow: 0.32925418914786103,
      offShadow: 0.22385011803330374,
      onNoShadow: 0.1721177829881891,
      onShadow: 0.12282138936132907,
    },
  ];
  for (const rung of measured) {
    const value = extractShadowableDimming(rung) / rung.factor;
    assert.ok(
      Math.abs(value - 1) < 0.01,
      `the shadowable term read ${value} of the published factor`,
    );
  }
  const unshadowedOverFactor = measured.map(
    (rung) => rung.onNoShadow / rung.offNoShadow / rung.factor,
  );
  assert.ok(Math.abs(unshadowedOverFactor[3] - 1.126131) < 1e-5);
  const shadowedOverFactor = measured.map(
    (rung) => rung.onShadow / rung.offShadow / rung.factor,
  );
  assert.ok(Math.abs(shadowedOverFactor[3] - 1.181983) < 1e-5);
  // And the contrast excess is exactly their quotient — the shadow finding is a
  // CONSEQUENCE of the ground-band under-dim, not an independent one.
  assert.ok(
    Math.abs(shadowedOverFactor[3] / unshadowedOverFactor[3] - 1.049596) < 1e-5,
  );
});

test("J6 the split model is REPORTED, never gated, and the reference run agrees with it", () => {
  assert.ok(
    ECLIPSE_CLOUD_REPORTED_ONLY_PREDICATES.includes(
      "shadowContrastMatchesSplitModelReportedOnly",
    ),
  );
  assert.ok(
    !ECLIPSE_CLOUD_GATE_PREDICATES.includes(
      "shadowContrastMatchesSplitModelReportedOnly",
    ),
    "one finding must not be scored twice",
  );
  const verdict = judgeEclipseCloudResponse(passingRun());
  assert.equal(verdict.shadowContrastMatchesSplitModelReportedOnly, true);
  assert.equal(verdict.shadowContrastModelIsBoundedByDirectional, true);
  assert.equal(verdict.shadowContrastModel.length, 4);
  for (const entry of verdict.shadowContrastModel) {
    // The estimator absorbs the strength move as well as the dimming law — it
    // returns `d * (1 - T_F)/(1 - T_1)`, and that second factor is the <=0.05%
    // the shadow strength itself changes. It is why the reading is ~1 rather
    // than exactly 1 even on a fixture built from the published laws.
    assert.ok(Math.abs(entry.groundDimming.shadowableOverFactor - 1) < 1e-3);
    assert.ok(Math.abs(entry.groundDimming.unshadowedOverFactor - 1) < 1e-9);
    assert.ok(Math.abs(entry.predicted - entry.supremum) < 1e-12);
  }
  // The arithmetic gate belongs to the domain that is never quarantined.
  assert.equal(
    ECLIPSE_CLOUD_PREDICATE_LANES.shadowContrastModelIsBoundedByDirectional,
    "gate-arithmetic",
  );
});

test("J7 a run whose residue UNDER-DIMS fails only the contrast gate, and the model says so", () => {
  const run = clone(passingRun());
  // Rebuild the ground bands with a real residue that dims as F^0.708 — the
  // fourth run's shape, injected into the fixture. The deck, the IBL and the
  // published scalars are untouched.
  const beer = CLOUD_SHADOW_BEER_FLOOR;
  const residueShare = 0.507493;
  const direct = 1 - residueShare;
  for (const rung of run.cloudLanes.rungs) {
    const factor = rung.published.factor;
    const strength = rung.published.shadowStrength;
    const litOff = direct;
    const litOn = direct * factor;
    const floorOff = residueShare;
    const floorOn = residueShare * Math.pow(factor, 0.708);
    const scale = 0.5 / (litOff + floorOff);
    rung.shadow.offNoShadow = (litOff + floorOff) * scale;
    rung.shadow.offShadow = (beer * litOff + floorOff) * scale;
    rung.shadow.onNoShadow = (litOn + floorOn) * scale;
    rung.shadow.onShadow =
      ((1 - strength * (1 - beer)) * litOn + floorOn) * scale;
    rung.shadow.offNoCloud = rung.shadow.offNoShadow / 1.02;
    // CO-19: this fixture models the CLOUD-DRIVEN branch of the attribution —
    // the residue appears only once the deck is in the scene, so the DECK-FREE
    // band still dims by exactly F and `deckFreeGroundDimsByFactor` stays
    // green. L3 injects the other branch (a globe-path residue) and requires
    // the new gate to catch it, which is what makes this one an attribution
    // rather than a restatement of the contrast fail.
    rung.shadow.onNoCloud = rung.shadow.offNoCloud * factor;
  }
  settleDeckFreeTwins(run);
  const verdict = judgeEclipseCloudResponse(run);
  assert.deepEqual(verdict.structuralReasons, []);
  assert.deepEqual(verdict.failedPredicates, ["shadowContrastInvariant"]);
  assert.equal(verdict.shadowContrastMatchesSplitModelReportedOnly, false);
  // The model still reports its own prediction, and it is still ~1.0002 — the
  // instrument does not follow the measurement.
  const deepest =
    verdict.shadowContrastModel[verdict.shadowContrastModel.length - 1];
  assert.ok(Math.abs(deepest.predicted - 1.00021184) < 1e-6);
  assert.ok(deepest.measured > 1.04);
  assert.ok(deepest.groundDimming.unshadowedOverFactor > 1.1);
  // The shadowable term is still exactly right (to the strength move) even
  // though the band it lives in under-dims by 12.6% — which is the whole point
  // of publishing this column.
  assert.ok(Math.abs(deepest.groundDimming.shadowableOverFactor - 1) < 1e-3);
});

// ─────────────────────────────────────────────────────────────────────────────
// K. THE DECK'S TONEMAP ENTRY, RE-FITTED FROM THE CLEAN RUN (CO-17)
//
// `C13-41-CLOUD-DECK-TONEMAP-SWALLOWS-THE-DIM` was filed on a fit of e ~ 7.7
// taken while the aerial tint was still UNDIMMED. These tests re-derive e from
// the fourth run and retire the entry.
// ─────────────────────────────────────────────────────────────────────────────

/** The two Edge runs' deck ratio series, verbatim, for the subtraction. */
const DECK_RUN_SERIES = [
  {
    factor: 0.8879051946524728,
    undimmed: 0.983,
    dimmed: 0.5662402716260491 / 0.626916402213654,
  },
  {
    factor: 0.7690319128580584,
    undimmed: 0.962,
    dimmed: 0.5006915227201424 / 0.6272655114233235,
  },
  {
    factor: 0.4642002390771099,
    undimmed: 0.894,
    dimmed: 0.322503925908934 / 0.6276002579608294,
  },
];

test("K1 the aerial share falls out by SUBTRACTION, and the three rungs agree", () => {
  // The runs differ only in the tint's law (1 vs F), so
  // R_undimmed - R_dimmed = s*(1 - F) at every rung. No fitting.
  const shares = DECK_RUN_SERIES.map((rung) =>
    fitDeckAerialShare(rung.factor, rung.undimmed, rung.dimmed),
  );
  assert.ok(Math.abs(shares[0] - 0.711764) < 1e-5);
  assert.ok(Math.abs(shares[1] - 0.709132) < 1e-5);
  assert.ok(Math.abs(shares[2] - 0.709466) < 1e-5);
  const spread = Math.max(...shares) - Math.min(...shares);
  assert.ok(
    spread / DECK_AERIAL_SHARE_CROSS_RUN < 0.005,
    `three independent rungs must agree: spread ${spread}`,
  );
  const mean = shares.reduce((a, b) => a + b, 0) / shares.length;
  assert.ok(Math.abs(mean - DECK_AERIAL_SHARE_CROSS_RUN) < 5e-4);
  // CO-11's geometric estimate was 0.099. The correction is 7.2x, not the ~4x
  // the fourth-run note recorded.
  assert.ok(Math.abs(mean / 0.099 - 7.17) < 0.05);
});

test("K2 e re-fits to ~1.01 on the CLEAN run, consistently across all three rungs", () => {
  const entries = DECK_RUN_SERIES.map((rung) =>
    fitDeckTonemapEntry(rung.factor, rung.dimmed, DECK_AERIAL_SHARE_CROSS_RUN),
  );
  assert.ok(Math.abs(entries[0] - 1.0033) < 5e-3);
  assert.ok(Math.abs(entries[1] - 1.0045) < 5e-3);
  assert.ok(Math.abs(entries[2] - 1.0127) < 5e-3);
  const spread = Math.max(...entries) - Math.min(...entries);
  assert.ok(
    spread < 0.012,
    `e must be one number, not three: spread ${spread}`,
  );
  // CONSEQUENCE (i): inside the band's own design envelope, by a factor of 1.67.
  for (const entry of entries) {
    assert.ok(entry <= DECK_TONEMAP_ENTRY_CEILING);
    assert.ok(
      entry < 1.7,
      "the deck sits inside the e <= 1.693 envelope the band was derived for",
    );
  }
  // The forward model closes the loop on the measurement it was fitted to.
  const deepest = DECK_RUN_SERIES[2];
  assert.ok(
    Math.abs(
      deckDisplayedRatio(
        deepest.factor,
        entries[2],
        DECK_AERIAL_SHARE_CROSS_RUN,
      ) - deepest.dimmed,
    ) < 1e-9,
  );
  // And the pure-deck (tint-free) ratio the fit implies is the number the
  // [0.44, 0.70] window was derived for — in band, near its e = 1 edge.
  const pureDeck = deckDisplayedRatio(deepest.factor, entries[2], 0);
  assert.ok(Math.abs(pureDeck - 0.6355) < 5e-4);
  assert.ok(
    pureDeck >= ECLIPSE_CLOUD_BANDS.deckDisplayedRatio.lo &&
      pureDeck <= ECLIPSE_CLOUD_BANDS.deckDisplayedRatio.hi,
  );
});

test("K3 the e ~ 7.7 reading is REPRODUCED, and it is the missing addend term", () => {
  // The third pass inverted the SINGLE-term form against the undimmed run's
  // 0.882. Same function, aerial share 0 — so the disagreement is the share,
  // not the arithmetic.
  const thirdPass = fitDeckTonemapEntry(0.4642002390771099, 0.882, 0);
  assert.ok(
    Math.abs(thirdPass - 7.7) < 0.2,
    `the third pass's inversion must be reproducible: ${thirdPass}`,
  );
  // The SAME undimmed measurement, corrected for the share the two runs
  // actually pin, gives an e inside the design envelope instead.
  const withShare = fitDeckTonemapEntry(
    0.4642002390771099,
    0.894 - DECK_AERIAL_SHARE_CROSS_RUN * (1 - 0.4642002390771099),
    DECK_AERIAL_SHARE_CROSS_RUN,
  );
  assert.ok(withShare < DECK_TONEMAP_ENTRY_CEILING);
  // A displayed ratio at or below the linear factor cannot come from a
  // compressive transform at all, and a ratio at or above 1 is unattainable:
  // both are `null`, never a fitted number.
  assert.equal(fitDeckTonemapEntry(0.4642002390771099, 0.4, 0), null);
  assert.equal(fitDeckTonemapEntry(0.4642002390771099, 1.2, 0), null);
  assert.equal(fitDeckTonemapEntry(0.4642002390771099, 0.9, 0.95), null);
});

test("K4 the fold publishes the re-fit, reported-only, with its provenance", () => {
  assert.ok(
    ECLIPSE_CLOUD_REPORTED_ONLY_PREDICATES.includes(
      "deckTonemapEntryWithinDesignEnvelopeReportedOnly",
    ),
  );
  assert.ok(
    !ECLIPSE_CLOUD_GATE_PREDICATES.includes(
      "deckTonemapEntryWithinDesignEnvelopeReportedOnly",
    ),
    "a cross-run input must never gate",
  );
  // CO-19: the reference run now RUNS the `cloudAerialStrength = 0` leg, so
  // the share is a SINGLE-RUN number and the cross-run constant has become the
  // FALLBACK it was always meant to be. Both paths are pinned, each on a run
  // that actually takes it — the scaffolding half of this test is now the
  // shipped half.
  const verdict = judgeEclipseCloudResponse(passingRun());
  assert.ok(
    Math.abs(verdict.deckTonemapFit.aerialShare - DECK_AERIAL_SHARE_CROSS_RUN) <
      1e-9,
    "the single-run leg must REPRODUCE the cross-run number it replaces",
  );
  assert.equal(verdict.deckTonemapFit.laneSuppliedShare, null);
  assert.ok(
    verdict.deckTonemapFit.aerialShareSource.includes("single-run subtraction"),
  );

  // The cross-run FALLBACK, on a run whose leg did not happen.
  const noLeg = clone(passingRun());
  for (const rung of noLeg.cloudLanes.rungs) {
    rung.deckAerialZero = null;
  }
  const noLegVerdict = judgeEclipseCloudResponse(noLeg);
  assert.equal(
    noLegVerdict.deckTonemapFit.aerialShare,
    DECK_AERIAL_SHARE_CROSS_RUN,
  );
  assert.equal(noLegVerdict.deckTonemapFit.singleRunShare, null);
  assert.ok(
    noLegVerdict.deckTonemapFit.aerialShareSource.includes(
      "cross-run subtraction",
    ),
  );
  // ...and a leg that simply did not run is a NAMED FAIL, not a silent
  // quarantine. The probe captures it unconditionally, so a null here is an
  // instrument defect and must be actionable rather than absorbed.
  assert.deepEqual(noLegVerdict.failedPredicates, ["deckPureRatioInBand"]);

  // An explicitly supplied share still outranks both.
  const supplied = clone(passingRun());
  supplied.cloudLanes.deckAerialShare = 0;
  const suppliedVerdict = judgeEclipseCloudResponse(supplied);
  assert.equal(suppliedVerdict.deckTonemapFit.aerialShare, 0);
  assert.ok(
    suppliedVerdict.deckTonemapFit.aerialShareSource.includes("lane-supplied"),
  );

  // A LINEAR deck — built explicitly now that the fixture carries the two-term
  // shape — inverts to ZERO with the share removed. `e = 0` is Reinhard's own
  // linear limit, not a fabrication.
  const linear = clone(passingRun());
  linear.cloudLanes.deckAerialShare = 0;
  for (const rung of linear.cloudLanes.rungs) {
    rung.deck.onContribution =
      rung.deck.offContribution * rung.published.factor;
  }
  assert.ok(
    Math.abs(
      judgeEclipseCloudResponse(linear).deckTonemapFit.entries[3].tonemapEntry,
    ) < 1e-12,
    "a linear deck must invert to e = 0",
  );
  // Below the linear factor there is no compressive entry at all, and the
  // inversion says so rather than returning a negative one.
  const belowLinear = clone(linear);
  belowLinear.cloudLanes.rungs[3].deck.onContribution *= 0.9;
  assert.equal(
    judgeEclipseCloudResponse(belowLinear).deckTonemapFit.entries[3]
      .tonemapEntry,
    null,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// L. THE TWO PRE-REGISTERED FIFTH-RUN LEGS (CO-19)
//
// CO-17 discharged both fourth-run deferrals by derivation and pre-registered
// exactly two probe legs for the fifth Edge run, plus one instrument tell:
//
//   1. `onNoCloud` — the eclipse-ON twin of lane B's deck-free ground control,
//      at the same instant per rung. It ATTRIBUTES the under-dimming residue
//      CO-17 measured: == F exonerates the globe's own light path and makes the
//      residue cloud-driven, > F indicts the globe path and exonerates the
//      cloud subsystem. Neither branch was measurable before, because every
//      band the fourth run had was captured with the deck ON.
//   2. `cloudAerialStrength = 0` on lane A — the tint dial zeroed for one extra
//      deepest-rung capture pair, so the displayed ratio IS the pure deck ratio
//      rho and `e` reads off a SINGLE run with no cross-run input.
//      Pre-registered: 0.635 +/- 0.01.
//   3. the tell — `offNoCloud` read bit-identical at all four rungs, 54 minutes
//      apart, while `offNoShadow` moved +3.3%. Reported, never gating.
//
// These tests pin both tolerance derivations, the attribution arithmetic, and
// the mutants: a tolerance loose enough to admit the globe-path excess must
// differ from the shipped one, and a fit that IGNORES the leg's share must not
// reproduce `e`.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rebuilds one run's ground bands with CO-17's measured residue — a term worth
 * 50.7% of the band that dims as F^0.708 instead of F. `alsoDeckFree` chooses
 * WHICH branch of the attribution the fixture models: false puts the residue
 * only in the deck-lit bands (cloud-driven), true puts it in the deck-free
 * control as well (the globe's own light path).
 */
function injectUnderDimmingResidue(run, { alsoDeckFree }) {
  const beer = CLOUD_SHADOW_BEER_FLOOR;
  const residueShare = 0.507493;
  const direct = 1 - residueShare;
  for (const rung of run.cloudLanes.rungs) {
    const factor = rung.published.factor;
    const strength = rung.published.shadowStrength;
    const litOff = direct;
    const litOn = direct * factor;
    const floorOff = residueShare;
    const floorOn = residueShare * Math.pow(factor, 0.708);
    const scale = 0.5 / (litOff + floorOff);
    rung.shadow.offNoShadow = (litOff + floorOff) * scale;
    rung.shadow.offShadow = (beer * litOff + floorOff) * scale;
    rung.shadow.onNoShadow = (litOn + floorOn) * scale;
    rung.shadow.onShadow =
      ((1 - strength * (1 - beer)) * litOn + floorOn) * scale;
    rung.shadow.offNoCloud = rung.shadow.offNoShadow / 1.02;
    rung.shadow.onNoCloud = alsoDeckFree
      ? (rung.shadow.offNoCloud * (litOn + floorOn)) / (litOff + floorOff)
      : rung.shadow.offNoCloud * factor;
  }
  settleDeckFreeTwins(run);
}

test("L1 the deck-free tolerance is PROPAGATED from the band it was measured on", () => {
  // A second implementation, written from the partial derivatives rather than
  // from the factored form the module ships.
  const secondImplementation = (uOff, uOn) =>
    BAND_MEAN_CAPTURE_DELTA * (1 / uOff) +
    BAND_MEAN_CAPTURE_DELTA * (uOn / (uOff * uOff));
  for (const uOff of [0.2, 0.2750603921572111, 0.4, 0.75]) {
    for (const r of [0.2, 0.464228, 0.88791, 1.0]) {
      assert.ok(
        Math.abs(
          deckFreeGroundDimTolerance(uOff, r) -
            secondImplementation(uOff, uOff * r),
        ) < 1e-12,
        `two implementations disagree at U_off=${uOff}, r=${r}`,
      );
    }
  }

  // The fourth run's OWN deck-free band, and the number the attribution has to
  // resolve there: 1.126131*F - F = 0.0585, i.e. 2.75x the tolerance.
  const F = predictFactor(SWEEP_PEAK_OBSCURATION);
  const tol = deckFreeGroundDimTolerance(0.2750603921572111, F);
  assert.equal(Number(tol.toFixed(5)), 0.02129);
  assert.ok((1.126131 * F - F) / tol > 2.5);

  // The CAP is not a choice — it is the loosest tolerance the structural floor
  // can ever admit, and the band records exactly that arithmetic.
  const cap = ECLIPSE_CLOUD_BANDS.deckFreeGroundDimToleranceCap.hi;
  assert.equal(
    cap,
    (BAND_MEAN_CAPTURE_DELTA / SHADOW_GROUND_BRIGHTNESS_FLOOR) * 2,
  );
  assert.equal(Number(cap.toFixed(5)), 0.05333);
  assert.equal(
    deckFreeGroundDimTolerance(0.0001, 1),
    cap,
    "a band below the vacuity floor must not buy itself a wider gate",
  );

  // Degenerate inputs return null rather than a plausible-looking number.
  assert.equal(deckFreeGroundDimTolerance(0, 0.5), null);
  assert.equal(deckFreeGroundDimTolerance(0.3, Number.NaN), null);

  // Both constants the derivation stands on ARE the ones the bands use, so the
  // tolerance and the bands bounding it cannot drift apart.
  assert.equal(
    ECLIPSE_CLOUD_BANDS.determinismDelta.hi,
    BAND_MEAN_CAPTURE_DELTA,
  );
  assert.equal(
    ECLIPSE_CLOUD_BANDS.shadowGroundBrightness.lo,
    SHADOW_GROUND_BRIGHTNESS_FLOOR,
  );
});

test("L2 MUTANT — a tolerance that admits the globe-path excess is required to differ", () => {
  const run = clone(passingRun());
  // CO-17's measured residue law, applied to the DECK-FREE band: the globe's
  // own light path retaining ~12.6% too much brightness at the deepest rung.
  for (const rung of run.cloudLanes.rungs) {
    const F = rung.published.factor;
    rung.shadow.onNoCloud =
      rung.shadow.offNoCloud * (0.492507 * F + 0.507493 * Math.pow(F, 0.708));
  }
  settleDeckFreeTwins(run);
  const verdict = judgeEclipseCloudResponse(run);
  assert.deepEqual(verdict.structuralReasons, []);
  assert.deepEqual(verdict.failedPredicates, ["deckFreeGroundDimsByFactor"]);
  const deepest =
    verdict.deckFreeGroundDim[verdict.deckFreeGroundDim.length - 1];
  assert.ok(
    deepest.overFactor > 1.12 && deepest.overFactor < 1.14,
    `the injected excess must reproduce the fourth run's 1.126: ${deepest.overFactor}`,
  );

  // THE MUTANT: the same comparison with a hand-picked 10% tolerance. It ADMITS
  // the excess, which is what makes the propagated tolerance load-bearing
  // rather than decorative.
  assert.ok(
    Math.abs(deepest.delta) <= 0.1,
    "the mutant tolerance must admit what the shipped gate rejects",
  );
  assert.ok(Math.abs(deepest.delta) > deepest.tolerance);

  // ...and the tolerance cannot simply be REMOVED either: a run perturbed by a
  // single eight-bit code — capture noise the instrument cannot even resolve —
  // must still pass.
  const noisy = clone(passingRun());
  for (const rung of noisy.cloudLanes.rungs) {
    rung.shadow.onNoCloud += BAND_MEAN_CAPTURE_DELTA;
  }
  settleDeckFreeTwins(noisy);
  const noisyVerdict = judgeEclipseCloudResponse(noisy);
  assert.equal(
    noisyVerdict.deckFreeGroundDimsByFactor,
    true,
    "one code of capture noise must not fail the attribution",
  );
  assert.ok(noisyVerdict.deckFreeGroundDim.every((entry) => entry.delta !== 0));
});

test("L3 the leg SPLITS the candidates — cloud-driven vs globe-driven differ by exactly one gate", () => {
  // (a) CLOUD-DRIVEN: the residue appears only once the deck is in the scene,
  //     so the deck-free band still dims by exactly F.
  const cloudDriven = clone(passingRun());
  injectUnderDimmingResidue(cloudDriven, { alsoDeckFree: false });
  const cloudVerdict = judgeEclipseCloudResponse(cloudDriven);
  assert.deepEqual(cloudVerdict.structuralReasons, []);
  assert.deepEqual(cloudVerdict.failedPredicates, ["shadowContrastInvariant"]);
  assert.equal(cloudVerdict.deckFreeGroundDimsByFactor, true);
  assert.ok(
    Math.abs(cloudVerdict.deckFreeGroundExcessAtDeepest - 1) < 1e-9,
    "the globe's own light path is exonerated",
  );

  // (b) GLOBE-DRIVEN: the SAME residue also carried by the deck-free control.
  const globeDriven = clone(passingRun());
  injectUnderDimmingResidue(globeDriven, { alsoDeckFree: true });
  const globeVerdict = judgeEclipseCloudResponse(globeDriven);
  assert.deepEqual(globeVerdict.structuralReasons, []);
  assert.deepEqual(globeVerdict.failedPredicates.sort(), [
    "deckFreeGroundDimsByFactor",
    "shadowContrastInvariant",
  ]);
  assert.ok(globeVerdict.deckFreeGroundExcessAtDeepest > 1.12);

  // THE ATTRIBUTION: two runs whose SCORED shadow bands are bit-identical, told
  // apart by exactly one predicate. Before this leg they returned one verdict.
  for (const key of ["offNoShadow", "offShadow", "onNoShadow", "onShadow"]) {
    assert.equal(
      cloudDriven.cloudLanes.rungs[3].shadow[key],
      globeDriven.cloudLanes.rungs[3].shadow[key],
      `${key} must be identical between the two branches`,
    );
  }
  assert.equal(
    cloudVerdict.shadowContrastRatioAtDeepest,
    globeVerdict.shadowContrastRatioAtDeepest,
  );
  assert.deepEqual(
    globeVerdict.failedPredicates.filter(
      (name) => !cloudVerdict.failedPredicates.includes(name),
    ),
    ["deckFreeGroundDimsByFactor"],
  );
});

test("L4 four bit-identical deck-free reads set the TELL, and it never gates", () => {
  assert.ok(
    ECLIPSE_CLOUD_REPORTED_ONLY_PREDICATES.includes("offNoCloudVariesWithSun"),
  );
  assert.ok(
    !ECLIPSE_CLOUD_GATE_PREDICATES.includes("offNoCloudVariesWithSun"),
    "an instrument investigation is not a product verdict",
  );

  // A lane that DOES re-capture per rung reads true.
  const healthy = judgeEclipseCloudResponse(passingRun());
  assert.equal(healthy.offNoCloudVariesWithSun, true);
  assert.ok(healthy.offNoCloudSpread > 0);

  // The fourth run VERBATIM: the deck-free control bit-identical at all four
  // rungs while the deck-lit band moved +3.3% over the same 54 minutes.
  const run = clone(passingRun());
  const stale = 0.2750603921572111;
  const moving = [0.31877, 0.3221, 0.3257, 0.32925];
  run.cloudLanes.rungs.forEach((rung, index) => {
    rung.shadow.offNoCloud = stale;
    rung.shadow.onNoCloud = stale * rung.published.factor;
    rung.shadow.offNoShadow = moving[index];
    rung.shadow.offShadow = moving[index] * shadowContrast(1);
    rung.shadow.onNoShadow = moving[index] * rung.published.factor;
    rung.shadow.onShadow =
      rung.shadow.onNoShadow * shadowContrast(rung.published.shadowStrength);
  });
  settleDeckFreeTwins(run);
  const verdict = judgeEclipseCloudResponse(run);
  assert.equal(
    verdict.offNoCloudVariesWithSun,
    false,
    "four identical f64s is the tell",
  );
  assert.equal(verdict.offNoCloudSpread, 0);
  assert.ok(
    verdict.offNoShadowSpread > 0.01,
    "the comparison series must move, or the tell means nothing",
  );
  assert.equal(
    Number((moving[3] / moving[0]).toFixed(3)),
    1.033,
    "the fourth run's +3.3%",
  );

  // It is REPORTED, so the run still certifies everything it can — including
  // the attribution the same four captures feed.
  assert.ok(!verdict.failedPredicates.includes("offNoCloudVariesWithSun"));
  assert.deepEqual(verdict.failedPredicates, []);

  // ...and all four values reach the source the console line prints from.
  assert.deepEqual(verdict.shadowTelemetry.offNoCloudSeries, [
    stale,
    stale,
    stale,
    stale,
  ]);
  assert.equal(verdict.shadowTelemetry.offNoCloudVariesWithSun, false);
});

test("L5 the aerial share and e fall out of ONE run via the cloudAerialStrength = 0 leg", () => {
  const F = predictFactor(SWEEP_PEAK_OBSCURATION);
  // R = (1-s)*rho + s*F  =>  s = (rho - R)/(rho - F), exactly, for every
  // admissible (s, e) — no fitting and no cross-run input.
  for (const s of [0, 0.25, 0.5, DECK_AERIAL_SHARE_CROSS_RUN, 0.95]) {
    for (const e of [0.1, 1.01, 1.6]) {
      const rho = deckDisplayedRatio(F, e, 0);
      const R = deckDisplayedRatio(F, e, s);
      assert.ok(
        Math.abs(fitDeckAerialShareFromPureDeck(F, R, rho) - s) < 1e-9,
        `share round trip failed at s=${s}, e=${e}`,
      );
      // ...and the tonemap entry reads off the tint-free leg ALONE, with no
      // share involved at any point.
      assert.ok(Math.abs(fitDeckTonemapEntry(F, rho, 0) - e) < 1e-9);
    }
  }

  // A deck with no compression has rho == F, where the split is not
  // identifiable at all — null, not a fabricated number.
  assert.equal(fitDeckAerialShareFromPureDeck(F, F, F), null);
  assert.equal(
    fitDeckAerialShareFromPureDeck(F, 0.45, 0.6),
    null,
    "a share at or above 1 makes the tonemap inversion unsolvable",
  );
  assert.equal(
    fitDeckAerialShareFromPureDeck(F, 0.7, 0.6),
    null,
    "a negative share is not a share",
  );

  // On the reference run the SINGLE-run number reproduces the cross-run
  // constant it replaces, and the leg's own entry is the fixture's entry.
  const verdict = judgeEclipseCloudResponse(passingRun());
  assert.ok(
    Math.abs(verdict.deckAerialShareSingleRun - DECK_AERIAL_SHARE_CROSS_RUN) <
      1e-9,
  );
  assert.ok(
    Math.abs(
      verdict.deckTonemapEntryFromPureLeg - REFERENCE_DECK_TONEMAP_ENTRY,
    ) < 1e-9,
  );
  assert.ok(
    Math.abs(
      verdict.deckTonemapFit.entries[3].tonemapEntry -
        REFERENCE_DECK_TONEMAP_ENTRY,
    ) < 1e-9,
  );
});

test("L6 the pure-deck band IS CO-17's pre-registration, and it is a band on e", () => {
  const b = ECLIPSE_CLOUD_BANDS.deckPureDeckRatio;
  assert.equal(b.lo, 0.625);
  assert.equal(b.hi, 0.645);
  assert.equal(
    Number(((b.lo + b.hi) / 2).toFixed(3)),
    0.635,
    "the pre-registered centre, verbatim",
  );

  const F = predictFactor(SWEEP_PEAK_OBSCURATION);
  const entryAt = (rho) => fitDeckTonemapEntry(F, rho, 0);
  assert.equal(Number(entryAt(b.lo).toFixed(4)), 0.9235);
  assert.equal(Number(entryAt(b.hi).toFixed(4)), 1.0969);

  // It brackets the cross-run per-rung spread e = [1.0033, 1.0045, 1.0127]...
  for (const e of [1.0033, 1.0045, 1.0127]) {
    const rho = deckDisplayedRatio(F, e, 0);
    assert.ok(rho >= b.lo && rho <= b.hi, `e = ${e} must land in the band`);
  }

  // ...while excluding BOTH rival readings by a wide margin: a linear deck
  // (e = 0) and the third pass's e = 7.70.
  const halfWidth = (b.hi - b.lo) / 2;
  const centre = (b.hi + b.lo) / 2;
  const linear = deckDisplayedRatio(F, 0, 0);
  const thirdPass = deckDisplayedRatio(F, 7.7, 0);
  assert.equal(Number(linear.toFixed(6)), 0.464228);
  assert.equal(Number(thirdPass.toFixed(6)), 0.88288);
  assert.ok((centre - linear) / halfWidth > 17);
  assert.ok((thirdPass - centre) / halfWidth > 24);

  // And it REFINES the composited band rather than contradicting it.
  const outer = ECLIPSE_CLOUD_BANDS.deckDisplayedRatio;
  assert.ok(b.lo > outer.lo && b.hi < outer.hi);
});

test("L7 MUTANT — a fit that IGNORES the leg's share re-derives the WRONG entry", () => {
  const verdict = judgeEclipseCloudResponse(passingRun());
  const F = predictFactor(SWEEP_PEAK_OBSCURATION);
  const measured = verdict.deckTonemapFit.entries[3].measured;

  // The shipped fit consumes the share the leg produced.
  assert.ok(
    Math.abs(verdict.deckTonemapFit.aerialShare - DECK_AERIAL_SHARE_CROSS_RUN) <
      1e-9,
  );
  assert.ok(
    Math.abs(
      verdict.deckTonemapFit.entries[3].tonemapEntry -
        REFERENCE_DECK_TONEMAP_ENTRY,
    ) < 1e-9,
  );

  // THE MUTANT: the same inversion with the share DROPPED — the third pass's
  // single-term form. It must not reproduce the entry.
  const mutant = fitDeckTonemapEntry(F, measured, 0);
  assert.ok(
    Math.abs(mutant - REFERENCE_DECK_TONEMAP_ENTRY) > 0.2,
    `the share must be load-bearing, the mutant read ${mutant}`,
  );
  // It is reported alongside, so the difference is visible rather than lost.
  assert.ok(
    Math.abs(
      verdict.deckTonemapFit.entries[3].tonemapEntrySingleTerm - mutant,
    ) < 1e-12,
  );

  // The pure-deck ratio the pre-registered band scores comes from the LEG, and
  // the mutant's entry cannot reproduce it — which is why the band gates the
  // leg rather than the fit.
  assert.ok(
    Math.abs(
      verdict.deckTonemapFit.entries[3].pureDeckRatio - verdict.deckPureRatio,
    ) < 1e-9,
  );
  assert.ok(
    Math.abs(deckDisplayedRatio(F, mutant, 0) - verdict.deckPureRatio) > 0.05,
  );
});

test("L8 both CO-19 gates can FAIL in isolation, each scoped to its own lane", () => {
  assert.equal(ECLIPSE_CLOUD_PREDICATE_LANES.deckPureRatioInBand, "deck");
  // CO-21 moved the attribution into its own `deck-free` domain, a CHILD of
  // `shadow`. Both directions are pinned: lane B still blinds it, and it no
  // longer blinds lane B.
  assert.equal(
    ECLIPSE_CLOUD_PREDICATE_LANES.deckFreeGroundDimsByFactor,
    "deck-free",
  );
  assert.equal(ECLIPSE_CLOUD_LANE_PARENTS["deck-free"], "shadow");

  // (a) the leg reads a LINEAR deck — e = 0, rho = 0.4642, 17 half-widths below.
  expectFailure(
    (run) => {
      const deepest = run.cloudLanes.rungs[run.cloudLanes.rungs.length - 1];
      deepest.deckAerialZero.onContribution =
        deepest.deckAerialZero.offContribution * deepest.published.factor;
    },
    ["deckPureRatioInBand"],
  );

  // (b) the leg reproduces the third pass's e ~ 7.70 — 24 half-widths above.
  expectFailure(
    (run) => {
      const deepest = run.cloudLanes.rungs[run.cloudLanes.rungs.length - 1];
      deepest.deckAerialZero.onContribution =
        deepest.deckAerialZero.offContribution *
        deckDisplayedRatio(deepest.published.factor, 7.7, 0);
    },
    ["deckPureRatioInBand"],
  );

  // (c) the deck-free ground UNDER-dims — the globe light path indicted.
  expectFailure(
    (run) => {
      for (const rung of run.cloudLanes.rungs) {
        rung.shadow.onNoCloud =
          rung.shadow.offNoCloud * Math.min(1, rung.published.factor * 1.12);
      }
      settleDeckFreeTwins(run);
    },
    ["deckFreeGroundDimsByFactor"],
  );

  // (d) ...and OVER-dims. The gate is two-sided: an eclipse that removes too
  //     much light is a different defect, not a pass.
  expectFailure(
    (run) => {
      for (const rung of run.cloudLanes.rungs) {
        rung.shadow.onNoCloud =
          rung.shadow.offNoCloud * rung.published.factor * 0.85;
      }
      settleDeckFreeTwins(run);
    },
    ["deckFreeGroundDimsByFactor"],
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// CO-21 — THE ENABLE-IDENTITY ATTRIBUTION
// ─────────────────────────────────────────────────────────────────────────────
//
// The fifth Edge run measured `onNoCloud / offNoCloud` = 0.449 at obscuration
// ZERO, where every published law forces exactly 1.0: `resolveEclipseCloudFactor`
// returns 1.0, `eclipseCloudDirectionalFraction` returns 1.0,
// `applyEclipseCloudDimming` is a bit-exact multiply by 1.0, and
// `quantizeEclipseEnvironmentRefreshInput(1.0)` is the identity bucket. Enabling
// the eclipse at zero obscuration must therefore be byte-neutral for the ground.
//
// The run's own numbers contain BOTH halves of the ambiguity CO-21 exists to
// remove, and neither half is decidable from the fifth run alone:
//
//   deck-present, rung 0   onNoShadow 0.45784608750450445 == offNoShadow, and
//                          onShadow 0.27773434657205215 == offShadow — BIT for
//                          BIT. The eclipse-enable contributed nothing.
//   deck-free,    rung 0   onNoCloud 0.2077768453355468 against offNoCloud
//                          0.46274509803954333 — a factor of 0.4490.
//
// Either the deck-free read is the truth and the deck-present pair masks a real
// engine violation, or the deck-free read is a transient: it is the ONLY scored
// capture in the probe taken one settle after a genuine eclipse-state
// TRANSITION, because the eclipse-OFF leg's toggle at the lane-B entry is a
// no-op (the `publishedOff` read two blocks earlier already left the flag
// false). The settled twin decides it, and these tests pin both verdict shapes.

test("K1 the ENABLE-IDENTITY mutant — a dim at F = 1 — FAILS, settled or not", () => {
  // The fifth run's rung-0 shape verbatim, on a fixture whose factor at that
  // rung IS exactly 1.0. This is the mutant the row's identity contract exists
  // to catch, and it must not be survivable by any tolerance the gate derives:
  // at F = 1 the propagated tolerance is at most `deckFreeGroundDimToleranceCap`
  // = 0.05333 and the injected delta is 0.551 — 10.3x it.
  assert.equal(predictFactor(0), 1, "the first rung must BE the identity rung");
  expectFailure(
    (run) => {
      const identityRung = run.cloudLanes.rungs[0];
      assert.equal(identityRung.published.factor, 1);
      identityRung.shadow.onNoCloud =
        identityRung.shadow.offNoCloud * 0.4490092844112451;
      settleDeckFreeTwins(run);
    },
    ["deckFreeGroundDimsByFactor"],
  );

  // ...and the arithmetic is REPORTED, not just the boolean: 0.449 at F = 1 is
  // an `overFactor` of 0.449, i.e. 55% of the ground's light removed by the
  // TOGGLE rather than by the eclipse.
  const run = clone(passingRun());
  const identityRung = run.cloudLanes.rungs[0];
  identityRung.shadow.onNoCloud =
    identityRung.shadow.offNoCloud * 0.4490092844112451;
  settleDeckFreeTwins(run);
  const verdict = judgeEclipseCloudResponse(run);
  const entry = verdict.deckFreeGroundDim[0];
  assert.equal(entry.factor, 1);
  assert.ok(Math.abs(entry.measured - 0.4490092844112451) < 1e-12);
  assert.ok(Math.abs(entry.overFactor - 0.4490092844112451) < 1e-12);
  assert.ok(Math.abs(entry.delta + 0.5509907155887549) < 1e-12);
  assert.ok(
    entry.tolerance <= ECLIPSE_CLOUD_BANDS.deckFreeGroundDimToleranceCap.hi,
    "no derived tolerance may exceed the cap",
  );
  assert.equal(entry.withinTolerance, false);
});

test("K2 an UNSETTLED deck-free control is STRUCTURAL, not a product FAIL", () => {
  // The instrument branch of the fifth run: the first-position eclipse-ON
  // capture reads 0.449 and the settled twin, three settles further from the
  // transition, has converged onto the law. A gate that scored the first read
  // would report an engine identity violation that does not exist.
  const run = clone(passingRun());
  const identityRung = run.cloudLanes.rungs[0];
  identityRung.shadow.onNoCloud =
    identityRung.shadow.offNoCloud * 0.4490092844112451;
  // Deliberately NOT `settleDeckFreeTwins` — the twin keeps the converged value.
  const verdict = judgeEclipseCloudResponse(run);

  assert.equal(verdict.deckFreeGroundCapturesSettled, false);
  const reason = verdict.structuralReasons.find((r) =>
    r.includes("had not converged"),
  );
  assert.ok(reason, JSON.stringify(verdict.structuralReasons));
  // BOTH legs' deltas are named, so a reader can see WHICH one moved.
  assert.match(reason, /eclipse-OFF moved 0 /);
  assert.match(reason, /eclipse-ON moved 0\.28/);
  // The attribution is quarantined rather than scored...
  assert.ok(verdict.unscoredPredicates.includes("deckFreeGroundDimsByFactor"));
  assert.ok(
    verdict.unscoredPredicates.includes("deckFreeGroundCapturesSettled"),
  );
  // ...and NOTHING else is: an unsettled deck-free CONTROL says nothing about
  // the cast-shadow contrast, which is a ratio of ratios among the
  // deck-present captures. This is the per-lane scoping the third pass asked
  // for, in the direction that matters.
  assert.ok(!verdict.unscoredPredicates.includes("shadowContrastInvariant"));
  assert.ok(!verdict.unscoredPredicates.includes("shadowNonVacuous"));
  assert.ok(!verdict.unscoredPredicates.includes("deckRatioInBand"));
  assert.deepEqual(verdict.failedPredicates, []);
  assert.equal(verdict.exitCode, ECLIPSE_CLOUD_EXIT.STRUCTURAL);
});

test("K3 the convergence detector cannot LAUNDER a settled defect", () => {
  // The engine branch: both reads agree on 0.449. A detector that merely
  // demanded "two numbers exist" would let this through; it must PASS the
  // convergence check and FAIL the attribution.
  const run = clone(passingRun());
  for (const rung of run.cloudLanes.rungs) {
    rung.shadow.onNoCloud = rung.shadow.offNoCloud * 0.4490092844112451;
  }
  settleDeckFreeTwins(run);
  const verdict = judgeEclipseCloudResponse(run);
  assert.deepEqual(verdict.structuralReasons, []);
  assert.equal(verdict.deckFreeGroundCapturesSettled, true);
  assert.deepEqual(verdict.failedPredicates, ["deckFreeGroundDimsByFactor"]);
  assert.equal(verdict.exitCode, ECLIPSE_CLOUD_EXIT.FAIL);
});

test("K4 a MISSING settled twin is treated as unconverged, never as agreement", () => {
  // `absDelta` returns null rather than 0 when a read is absent, so a probe
  // that silently stops capturing the twin blinds the lane instead of
  // certifying it. An absent convergence check is exactly as uninformative as
  // a failed one.
  const run = clone(passingRun());
  for (const rung of run.cloudLanes.rungs) {
    delete rung.shadow.onNoCloudSettled;
  }
  const verdict = judgeEclipseCloudResponse(run);
  assert.equal(verdict.deckFreeGroundCapturesSettled, false);
  assert.equal(verdict.deckFreeGroundSettleDelta[0].onDelta, null);
  assert.ok(verdict.unscoredPredicates.includes("deckFreeGroundDimsByFactor"));
  assert.deepEqual(verdict.failedPredicates, []);
});

test("K5 the ON-leg retention twin is computed and REPORTED, never gating", () => {
  // `shadowGroundNotOccluded` reads the OFF leg only. Its ON twin is the
  // corroborating number for the whole CO-21 question: the fifth run read
  // 0.9894 off against 2.2035 on, and the deck-present and deck-free bands
  // cannot both be measuring one surface. It does not gate, because WHICH of
  // the two is wrong is exactly what `deckFreeGroundCapturesSettled` decides.
  const verdict = judgeEclipseCloudResponse(passingRun());
  assert.ok(Number.isFinite(verdict.deckFreeGroundOnRetentionRatio));
  assert.ok(
    !ECLIPSE_CLOUD_GATE_PREDICATES.includes("deckFreeGroundOnRetentionRatio"),
  );
  assert.equal(
    verdict.shadowTelemetry.groundRetentionOn,
    verdict.deckFreeGroundOnRetentionRatio,
  );

  // The fifth run's actual pair, replayed: the ON leg's retention is 2.2x
  // while the OFF leg's is 0.99.
  const run = clone(passingRun());
  const r0 = run.cloudLanes.rungs[0].shadow;
  r0.offNoCloud = 0.46274509803954333;
  r0.onNoCloud = 0.2077768453355468;
  r0.offNoShadow = 0.45784608750450445;
  r0.onNoShadow = 0.45784608750450445;
  settleDeckFreeTwins(run);
  const fifth = judgeEclipseCloudResponse(run);
  assert.ok(Math.abs(fifth.shadowGroundRetentionRatio - 0.9894131552) < 1e-8);
  assert.ok(Math.abs(fifth.deckFreeGroundOnRetentionRatio - 2.2035) < 1e-3);
});

test("K6 the probe captures the settled twin on BOTH legs, matched in position", () => {
  const probe = fs
    .readFileSync(path.join(here, "probe-eclipse-cloud-response.mjs"), "utf8")
    .replace(/\r\n/g, "\n");

  // Both twins exist, over the SAME dials and the same settle as the
  // first-position reads they are compared against.
  assert.match(probe, /const bOffNoCloudSettled = groundBand\(/);
  assert.match(probe, /const bOnNoCloudSettled = groundBand\(/);
  assert.match(probe, /B\$\{index\}-eclipseOff-cloudsOff-settled/);
  assert.match(probe, /B\$\{index\}-eclipseOn-cloudsOff-settled/);
  assert.match(probe, /offNoCloudSettled: bOffNoCloudSettled\.mean,/);
  assert.match(probe, /onNoCloudSettled: bOnNoCloudSettled\.mean,/);

  // MATCHED ORDERING is the point. A repeat on the eclipse-ON leg alone would
  // re-introduce the unmatched-position defect it exists to detect, so the two
  // must be structurally identical statements — same configure, same settle,
  // same reducer — and each must sit AFTER its own leg's shadow captures.
  const legSetup =
    /configure\(\{ enableVolumetric: false, dials: groundDials \}\);\n\s*await pin\.settle\(julian, cfg\.settleMs\);\n\s*const bO(?:ff|n)NoCloudSettled = groundBand\(/g;
  assert.equal(
    (probe.match(legSetup) ?? []).length,
    2,
    "both legs must set up their settled twin identically",
  );
  assert.ok(
    probe.indexOf("bOffNoCloudSettled") <
      probe.indexOf("const bOnNoCloud = groundBand("),
    "the OFF twin must be captured before the eclipse-ON leg begins",
  );
  assert.ok(
    probe.indexOf("const bOffShadow") < probe.indexOf("bOffNoCloudSettled"),
    "the OFF twin must sit AFTER its leg's shadow captures",
  );
  assert.ok(
    probe.indexOf("const bOnShadow") < probe.indexOf("bOnNoCloudSettled"),
    "the ON twin must sit AFTER its leg's shadow captures",
  );

  // The evidence reaches the console unrounded — the deltas ARE the verdict.
  assert.match(probe, /SHADOW deck-free convergence: settled/);
  assert.match(
    probe,
    /settled\+failing = ENGINE identity violation; unsettled = INSTRUMENT/,
  );
});
