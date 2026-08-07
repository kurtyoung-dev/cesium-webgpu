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
  CLOUD_SHADOW_BEER_FLOOR,
  ECLIPSE_ADAPTATION_EXPONENT,
  ECLIPSE_CLOUD_BANDS,
  ECLIPSE_CLOUD_EXIT,
  ECLIPSE_CLOUD_GATE_PREDICATES,
  ECLIPSE_CLOUD_PARITY_PREDICATES,
  ECLIPSE_CLOUD_PREDICATE_LANES,
  ECLIPSE_CLOUD_REPORTED_ONLY_PREDICATES,
  ECLIPSE_RADIOMETRIC_FLOOR,
  ENV_REFRESH_STEPS,
  REFRESH_COST_MIN_SEGMENTS_PER_LEG,
  SWEEP_FRAMES,
  SWEEP_PEAK_OBSCURATION,
  SWEEP_RISING_FRAMES,
  computeRefreshCost,
  countBucketChanges,
  eclipseCloudExitCode,
  eclipseCloudGateLabel,
  idealSweepBuckets,
  judgeEclipseCloudResponse,
  maxBucketStep,
  predictBucket,
  predictDirectional,
  predictFactor,
  predictedSweepRefreshCount,
  shadowContrast,
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

/** A run in which every gate passes. Mutants below break exactly one thing. */
function passingRun() {
  const rungs = ECLIPSE_CLOUD_BANDS.ladderTargets.map((target) => {
    const factor = predictFactor(target);
    const directional = predictDirectional(target);
    // Deck: the un-eclipsed contribution is 0.20; the eclipsed one is the
    // linear factor times it (a display transform would lift this, and the
    // band admits that, but the linear value is the honest stand-in).
    const offContribution = 0.2;
    const onContribution = offContribution * factor;
    // Ground: unshadowed 0.5; shadowed = unshadowed * mix(1, 0.35, strength).
    // The eclipse scales BOTH bands by `factor`, which cancels in the ratio.
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
      shadow: {
        offNoShadow,
        offShadow,
        onNoShadow,
        onShadow,
        strengthOff: 1,
        strengthOn: directional,
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
  assert.equal(ECLIPSE_CLOUD_GATE_PREDICATES.length, 23);
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
      "shadowNonVacuous",
      "shadowContrastInvariant",
      "shadowContrastRejectsAlternativeDesign",
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
    const cloudOwned =
      lane === "cloud-page" || lane === "deck" || lane === "shadow";
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

  // Lane B flies its own, higher camera: the cast-shadow map is 512 texels
  // across a +/-60 km footprint, so a 300 m vantage put the whole scored ground
  // band inside ONE texel.
  assert.match(probe, /groundCameraHeight: 9000\.0/);
  assert.match(
    probe,
    /aimCamera\(julian, cfg\.groundPitchDegrees, cfg\.groundCameraHeight\)/,
  );
  const engineCloud = readEngine(
    "Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts",
  );
  assert.match(engineCloud, /const CLOUD_SHADOW_SIZE = 512;/);
  assert.match(engineCloud, /const CLOUD_SHADOW_FOOTPRINT_M = 60000\.0;/);
  // One texel is 234 m of ground; the first run's band was ~131 m deep.
  assert.equal(Number(((2 * 60000) / 512).toFixed(1)), 234.4);
  const bandDepthAt = (height) =>
    height / Math.tan((38.6 * Math.PI) / 180) -
    height / Math.tan((50.8 * Math.PI) / 180);
  assert.ok(
    bandDepthAt(300) < 234.4,
    "the 300 m vantage's scored band must be sub-texel — that is the diagnosis",
  );
  assert.ok(
    bandDepthAt(9000) > 10 * 234.4,
    "the 9000 m vantage must span many texels",
  );
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
