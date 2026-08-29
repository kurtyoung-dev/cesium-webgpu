// eclipse-cloud-response-gate.spec.mjs — the pure-Node half of C13-41's Edge
// acceptance: the probe's predicate COMPOSITION, its pre-registered bands, and
// the arithmetic those bands are derived from.
// @purpose Pure-Node half of C13-41's Edge acceptance: derives bucket fills and submitted-refresh cost, and mutant-checks every fold predicate.
// @status ACTIVE
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
//   - the sweep's bucket-fill count is DERIVED, not written down, and the ramp is
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
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import {
  BAND_MEAN_CAPTURE_DELTA,
  BAND_MEAN_QUANTIZATION_HALF_STEP,
  CLOUD_SHADOW_BEER_FLOOR,
  ENCODED_RESIDUE_DIM_ENVELOPE,
  ENCODED_RESIDUE_MAGNITUDE_SWEEP,
  REINHARD_RESIDUE_EXPOSURE_SWEEP,
  checkEmbeddedDrainClosureIsCanonical,
  checkEmbeddedLedgerClosureIsCanonical,
  describeRefreshCostDrainClosure,
  describeRefreshCostLedgerClosure,
  extractEmbeddedDrainClosure,
  extractEmbeddedLedgerClosure,
  REFRESH_COST_DRAIN_CLOSURE_SOURCE,
  REFRESH_COST_DRAIN_EXPECTATIONS,
  REFRESH_COST_LEDGER_CLOSURE_BEGIN,
  REFRESH_COST_LEDGER_CLOSURE_END,
  REFRESH_COST_LEDGER_CLOSURE_SOURCE,
  REFRESH_COST_LEDGER_EXPECTATIONS,
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
  FIXED_LADDER_0_TO_1400_MAX_OBSCURATION_SHIFT,
  HISTORICAL_EPHEMERIS_BRANCH_SHIFT_FLOOR,
  REFRESH_COST_GPU_TIME_PROTOCOL,
  REFRESH_COST_PROTOCOL_VERSION,
  REFRESH_COST_SEGMENTS_PER_LEG,
  REFRESH_COST_WEBGL_GPU_UNAVAILABLE_REASON,
  REFRESH_COST_WEBGPU_GPU_UNAVAILABLE_REASON,
  SHADOW_GROUND_BRIGHTNESS_FLOOR,
  SWEEP_FRAMES,
  SWEEP_PEAK_OBSCURATION,
  SWEEP_RISING_FRAMES,
  computeRefreshCost,
  countBucketChanges,
  deckDisplayedRatio,
  encodedResidueDim,
  reinhardResidueDim,
  residueShareForDim,
  deriveRefreshCostSegmentBounds,
  deckFreeGroundDimTolerance,
  eclipseCloudExitCode,
  eclipseCloudGateLabel,
  evaluateShadowDecrementModel,
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
import {
  analyzeWeatherCaptureConsumer,
  formatWeatherCaptureFailures,
  WEATHER_CAPTURE_FAILURE,
} from "./lib/weather-capture-doctrine.mjs";
import {
  assertEvidenceReadableOrAbsent,
  atomicReplaceEvidence,
  compareBuildSourceIdentity,
  compareEvidenceFileSnapshots,
  createImmutableEvidence,
  fingerprintEvidenceFile,
  preserveFirstRedEvidence,
  snapshotEvidenceFiles,
  validateServedEntryIdentities,
} from "./lib/build-source-identity.mjs";
import {
  DECK_FREE_BASE_COLOR_CHANNEL,
  DECK_FREE_CONTROL_SESSION_PLAN,
  DECK_FREE_DEFAULT_TERMINATOR_GLOW_STRENGTH,
  DECK_FREE_DIAGNOSTIC_NDOTL_TARGETS,
  DECK_FREE_DIAGNOSTIC_TERMINATOR_GLOW_STRENGTH,
  DECK_FREE_DIRECTIONAL_LIGHT_INTENSITY,
  DECK_FREE_EXPECTED_LIGHTING_FADE,
  DECK_FREE_LIGHT_COLOR,
  DECK_FREE_LIGHTING_FADE_IN_DISTANCE,
  DECK_FREE_LIGHTING_FADE_OUT_DISTANCE,
  DECK_FREE_RAW_BASE_COLOR_LUMA,
  DECK_FREE_SUN_LIGHT_INTENSITY,
  DECK_FREE_TERMINATOR_GLOW_COLOR,
  DECK_FREE_TERMINATOR_GLOW_EXPONENT,
  DECK_FREE_TERMINATOR_GLOW_STRENGTH,
  computeDeckFreeDayNightDiffuse,
  computeDeckFreeDirectionalDiagnosticLuma,
  computeDeckFreeDiagnosticFrame,
  computeDeckFreeLightingFade,
  computeDeckFreeTerminatorGlowLuma,
  foldDeckFreeControlSessions,
} from "./lib/c13-41-deckfree-control.mjs";
import {
  acquireC1341RunLock,
  assertNoPriorC1341Running,
  captureC1341PriorCanonical,
  finalizeC1341Evidence,
  prepareCapturedCanonicalForRun,
  publishC1341Running,
  releaseC1341RunLock,
} from "./probe-eclipse-cloud-response.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const readEngine = (p) =>
  fs
    .readFileSync(path.join(root, "packages/engine/Source", p), "utf8")
    .replace(/\r\n/g, "\n");

const eclipseCaptureStaticFailures = (source) =>
  analyzeWeatherCaptureConsumer(source, {
    relative: "Tools/visual-regression/probe-eclipse-cloud-response.mjs",
  });

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

test("A3 the sweep produces EXACTLY 275 eclipse-driven fills, buckets 256 -> 119", () => {
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

test("C6 the engine fill band's CEILING is the arithmetic maximum", () => {
  const b = ECLIPSE_CLOUD_BANDS.engineRefreshCount;
  assert.equal(
    b.hi,
    predictedSweepRefreshCount(),
    "deferral can only MERGE edges, never create one, so 275 is a hard ceiling",
  );
  assert.ok(b.lo >= 0.85 * b.hi, "the floor allows at most ~15% merged edges");
});

test("C7 the schedule tolerance admits fixed camera parallax and rejects the ephemeris branch shift", () => {
  const tolerance = ECLIPSE_CLOUD_BANDS.scheduleObscurationTolerance;
  const fixedCameraParallaxBound =
    (300 / 356_500_000 / 0.00465) * (4 / Math.PI);
  assert.ok(
    tolerance.hi >= fixedCameraParallaxBound,
    "the 0 m derivation and fixed 300 m lane must fit the geometric bound",
  );
  assert.equal(FIXED_LADDER_0_TO_1400_MAX_OBSCURATION_SHIFT, 7.91e-5);
  assert.ok(
    tolerance.hi > FIXED_LADDER_0_TO_1400_MAX_OBSCURATION_SHIFT,
    "the independently evaluated 0 -> 1400 m shift on all four fixed ISOs must fit",
  );
  assert.equal(HISTORICAL_EPHEMERIS_BRANCH_SHIFT_FLOOR, 0.0063);
  assert.ok(
    tolerance.hi < HISTORICAL_EPHEMERIS_BRANCH_SHIFT_FLOOR,
    "the smallest observed ICRF/TEME-style branch shift must remain excluded",
  );
  assert.match(tolerance.why, /300\/356500000/);
  assert.match(tolerance.why, /0 -> 1400 m shift/);
  assert.match(tolerance.why, /7\.91e-5/);
  assert.match(tolerance.why, /0\.0063-0\.0077/);
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
const DECK_FREE_DIAGNOSTIC_SITE = Object.freeze({
  latitudeDegrees: 64.15,
  longitudeDegrees: -24,
});

const deckFreeLightingFadeEvidence = () => {
  const cameraDistance = 6_362_245;
  const outDistance = DECK_FREE_LIGHTING_FADE_OUT_DISTANCE;
  const inDistance = DECK_FREE_LIGHTING_FADE_IN_DISTANCE;
  return {
    outDistance,
    inDistance,
    cameraDistance,
    expectedFade: computeDeckFreeLightingFade(
      cameraDistance,
      outDistance,
      inDistance,
    ),
  };
};

const deckFreeLightReadback = (kind, diagnosticOnly, directionWC = null) => {
  const side = {
    constructorName: kind,
    isSunLight: kind === "SunLight",
    isDirectionalLight: kind === "DirectionalLight",
    directionWC,
    color: [...DECK_FREE_LIGHT_COLOR],
    intensity:
      kind === "SunLight"
        ? DECK_FREE_SUN_LIGHT_INTENSITY
        : DECK_FREE_DIRECTIONAL_LIGHT_INTENSITY,
  };
  return {
    diagnosticOnly,
    sameObject: true,
    scene: structuredClone(side),
    frameState: structuredClone(side),
  };
};

const freshDeckFreeSessions = (rungs) =>
  DECK_FREE_CONTROL_SESSION_PLAN.map((planned, sessionIndex) => {
    const factorFor = (rung) =>
      planned.eclipseEnabled ? rung.deckFreePublished.factor : 1;
    const lightingFor = (rung) => ({
      enableLighting: true,
      enableEclipse: planned.eclipseEnabled,
      enableEclipseGlobeShadow: false,
      eclipseStateEnabled: planned.eclipseEnabled,
      eclipseStateValid: true,
      moonObscuration: rung.deckFreePublished.moonObscuration,
      factor: factorFor(rung),
      lightingFade: deckFreeLightingFadeEvidence(),
    });
    return {
      sessionLabel: planned.label,
      sessionToken: `fresh-session-${sessionIndex}`,
      eclipseEnabled: planned.eclipseEnabled,
      configureCalls: 1,
      configureTruth: { enableVolumetric: false },
      rendererType: "webgpu",
      enableLighting: true,
      captureSequence: "directional-diagnostic-then-fresh-sun-scored",
      lighting: { lightingFade: deckFreeLightingFadeEvidence() },
      light: deckFreeLightReadback("SunLight", false),
      terminatorGlow: {
        supported: true,
        priorStrength: DECK_FREE_DEFAULT_TERMINATOR_GLOW_STRENGTH,
        publicStrength: DECK_FREE_DEFAULT_TERMINATOR_GLOW_STRENGTH,
        tileProviderStrength: DECK_FREE_DEFAULT_TERMINATOR_GLOW_STRENGTH,
      },
      baseColor: [
        DECK_FREE_BASE_COLOR_CHANNEL,
        DECK_FREE_BASE_COLOR_CHANNEL,
        DECK_FREE_BASE_COLOR_CHANNEL,
        1,
      ],
      rungs: rungs.map((rung) => ({
        target: rung.target,
        iso: rung.iso,
        captureRole: "scored-real-sun-factor",
        mean: planned.eclipseEnabled
          ? rung.shadow.onNoCloud
          : rung.shadow.offNoCloud,
        samples: 20000,
        enableVolumetric: false,
        eclipseEnabled: planned.eclipseEnabled,
        factor: factorFor(rung),
        baseColor: [
          DECK_FREE_BASE_COLOR_CHANNEL,
          DECK_FREE_BASE_COLOR_CHANNEL,
          DECK_FREE_BASE_COLOR_CHANNEL,
          1,
        ],
        enableLighting: true,
        lighting: lightingFor(rung),
        light: deckFreeLightReadback("SunLight", false),
        cameraHeight: rung.deckFreePublished.cameraHeight,
        configureCalls: 1,
        terminatorGlowStrength: DECK_FREE_DEFAULT_TERMINATOR_GLOW_STRENGTH,
        terminatorGlowTileProviderStrength:
          DECK_FREE_DEFAULT_TERMINATOR_GLOW_STRENGTH,
      })),
      directionalDiagnosticRungs: rungs.map((rung, rungIndex) => {
        const ndotlTarget = DECK_FREE_DIAGNOSTIC_NDOTL_TARGETS[rungIndex];
        const directionSpec = computeDeckFreeDiagnosticFrame(
          DECK_FREE_DIAGNOSTIC_SITE.latitudeDegrees,
          DECK_FREE_DIAGNOSTIC_SITE.longitudeDegrees,
          ndotlTarget,
          DECK_FREE_DIAGNOSTIC_TERMINATOR_GLOW_STRENGTH,
        );
        return {
          target: rung.target,
          iso: rung.iso,
          captureRole: "diagnostic-directional-daynight",
          diagnosticOnly: true,
          ndotlTarget,
          directionSpec: {
            surfaceNormalWC: directionSpec.normalWC,
            eastWC: directionSpec.eastWC,
            incomingDirectionWC: directionSpec.incomingDirectionWC,
            emittedDirectionWC: directionSpec.emittedDirectionWC,
            ndotl: directionSpec.ndotl,
            expectedDiffuse: directionSpec.diffuse,
          },
          // DirectionalLight bypasses S2's SunLight-only uniform dimming and
          // the probe disables the fragment-local eclipse-globe shadow. Both
          // ON and OFF diagnostic pixels execute the same DAYNIGHT multiply
          // plus the strength-one terminator-glow addend.
          mean: computeDeckFreeDirectionalDiagnosticLuma(
            ndotlTarget,
            DECK_FREE_EXPECTED_LIGHTING_FADE,
            DECK_FREE_DIAGNOSTIC_TERMINATOR_GLOW_STRENGTH,
          ),
          samples: 20000,
          eclipseEnabled: planned.eclipseEnabled,
          factor: factorFor(rung),
          baseColor: [
            DECK_FREE_BASE_COLOR_CHANNEL,
            DECK_FREE_BASE_COLOR_CHANNEL,
            DECK_FREE_BASE_COLOR_CHANNEL,
            1,
          ],
          enableLighting: true,
          lighting: lightingFor(rung),
          light: deckFreeLightReadback(
            "DirectionalLight",
            true,
            directionSpec.emittedDirectionWC,
          ),
          cameraHeight: rung.deckFreePublished.cameraHeight,
          enableVolumetric: false,
          configureCalls: 1,
          terminatorGlowStrength: DECK_FREE_DIAGNOSTIC_TERMINATOR_GLOW_STRENGTH,
          terminatorGlowTileProviderStrength:
            DECK_FREE_DIAGNOSTIC_TERMINATOR_GLOW_STRENGTH,
        };
      }),
    };
  });

function spreadIntegerTotal(total, count) {
  const quotient = Math.floor(total / count);
  const remainder = total - quotient * count;
  return Array.from(
    { length: count },
    (_, index) => quotient + (index < remainder ? 1 : 0),
  );
}

function spreadWallTime(total, count) {
  const values = [];
  let assigned = 0;
  for (let index = 0; index < count - 1; index++) {
    const value = total / count;
    values.push(value);
    assigned += value;
  }
  values.push(total - assigned);
  return values;
}

function spreadGpuSamples(total, count) {
  if (count === 0) {
    return [];
  }
  return [...Array(count - 1).fill(0), total];
}

function spreadGpuSamplesAcrossSegments(total, refreshCounts) {
  const samples = spreadGpuSamples(
    total,
    refreshCounts.reduce((sum, count) => sum + count, 0),
  );
  let from = 0;
  return refreshCounts.map((count) => {
    const segmentSamples = samples.slice(from, from + count);
    from += count;
    return segmentSamples;
  });
}

const MANDATORY_REFRESH_COST_GPU_PASS_NAMES =
  REFRESH_COST_GPU_TIME_PROTOCOL.passNames.slice(0, -1);
const OPTIONAL_REFRESH_COST_GPU_PASS_NAME =
  REFRESH_COST_GPU_TIME_PROTOCOL.passNames.at(-1);

function splitGpuTotalByMandatoryPass(total) {
  let assigned = 0;
  return Object.fromEntries(
    MANDATORY_REFRESH_COST_GPU_PASS_NAMES.map((passName, index) => {
      const passTotal =
        index === MANDATORY_REFRESH_COST_GPU_PASS_NAMES.length - 1
          ? total - assigned
          : (total * (index + 1)) / 10;
      assigned += passTotal;
      return [passName, passTotal];
    }),
  );
}

function spreadGpuSamplesByPassAcrossSegments(total, refreshCounts) {
  const passTotals = splitGpuTotalByMandatoryPass(total);
  return Object.fromEntries(
    MANDATORY_REFRESH_COST_GPU_PASS_NAMES.map((passName) => [
      passName,
      spreadGpuSamplesAcrossSegments(passTotals[passName], refreshCounts),
    ]),
  );
}

function sumGpuSamplesByPass(samplesMsByPass, refreshes) {
  const passNames = Object.keys(samplesMsByPass);
  return Array.from({ length: refreshes }, (_, refreshIndex) =>
    passNames.reduce(
      (total, passName) => total + samplesMsByPass[passName][refreshIndex],
      0,
    ),
  );
}

function syncGpuSegmentSamplesFromPasses(segment) {
  segment.gpuTime.samplesMs = sumGpuSamplesByPass(
    segment.gpuTime.samplesMsByPass,
    segment.refreshes,
  );
  segment.gpuTime.totalMs = segment.gpuTime.samplesMs.reduce(
    (total, sample) => total + sample,
    0,
  );
  return segment;
}

function setMandatoryPassCostsPerRefresh(accounting, passCosts) {
  assert.equal(passCosts.length, MANDATORY_REFRESH_COST_GPU_PASS_NAMES.length);
  for (const segment of accounting.segments) {
    if (!segment.gpuTime?.valid) {
      continue;
    }
    segment.gpuTime.samplesMsByPass =
      segment.refreshes > 0
        ? Object.fromEntries(
            MANDATORY_REFRESH_COST_GPU_PASS_NAMES.map((passName, index) => [
              passName,
              Array(segment.refreshes).fill(passCosts[index]),
            ]),
          )
        : {};
    syncGpuSegmentSamplesFromPasses(segment);
  }
  return syncCostAggregatesFromSegments(accounting);
}

function syncCostAggregatesFromSegments(accounting) {
  const totals = {
    eclipse: { frames: 0, wallMs: 0, gpuMs: 0, fills: 0, refreshes: 0 },
    control: { frames: 0, wallMs: 0, gpuMs: 0, fills: 0, refreshes: 0 },
  };
  for (const segment of accounting.segments) {
    totals[segment.leg].frames += segment.frames;
    totals[segment.leg].wallMs += segment.wallMs;
    totals[segment.leg].fills += segment.fills;
    totals[segment.leg].refreshes += segment.refreshes;
    if (segment.gpuTime?.valid) {
      segment.gpuTime.results.attemptedFrameCount = segment.frames;
      segment.gpuTime.results.frameCount = segment.frames;
      totals[segment.leg].gpuMs += segment.gpuTime.totalMs;
    }
  }
  accounting.eclipseFrames = totals.eclipse.frames;
  accounting.controlFrames = totals.control.frames;
  accounting.eclipseWallMs = totals.eclipse.wallMs;
  accounting.controlWallMs = totals.control.wallMs;
  accounting.eclipseFills = totals.eclipse.fills;
  accounting.controlFills = totals.control.fills;
  accounting.eclipseRefreshes = totals.eclipse.refreshes;
  accounting.controlRefreshes = totals.control.refreshes;
  if (accounting.gpuTime?.valid) {
    accounting.gpuTime.eclipseMs = totals.eclipse.gpuMs;
    accounting.gpuTime.controlMs = totals.control.gpuMs;
  }
  return accounting;
}

const FIXTURE_RUN_ID = "fixture-current-run";

function ratifiedObscurationSchedule() {
  return Array.from({ length: SWEEP_FRAMES }, (_, index) => {
    const rampIndex =
      index < SWEEP_RISING_FRAMES ? index : SWEEP_FRAMES - 1 - index;
    return (SWEEP_PEAK_OBSCURATION * rampIndex) / (SWEEP_RISING_FRAMES - 1);
  });
}

function ratifiedFactorSchedule() {
  return ratifiedObscurationSchedule().map((obscuration) =>
    predictFactor(obscuration),
  );
}

function freshCostAccounting({
  segmentsPerLeg = REFRESH_COST_SEGMENTS_PER_LEG,
  frames = SWEEP_FRAMES,
  eclipseWallMs = 9000,
  controlWallMs = 5000,
  eclipseFills = 282,
  controlFills = 8,
  eclipseRefreshes = eclipseFills,
  controlRefreshes = controlFills,
  backend = "webgpu",
  gpuAvailable = backend === "webgpu",
  eclipseGpuMs = eclipseWallMs,
  controlGpuMs = controlWallMs,
  gpuUnavailableReason = backend === "webgl"
    ? REFRESH_COST_WEBGL_GPU_UNAVAILABLE_REASON
    : REFRESH_COST_WEBGPU_GPU_UNAVAILABLE_REASON,
  runId = FIXTURE_RUN_ID,
  sessionLabel = `ibl-${backend}`,
  sessionToken = `fixture-${backend}-session`,
  ledgerId = `fixture-${backend}-cost-ledger`,
  factorSchedule = ratifiedFactorSchedule(),
} = {}) {
  const bounds = [];
  const quotient = Math.floor(frames / segmentsPerLeg);
  const remainder = frames % segmentsPerLeg;
  let from = 0;
  for (let pairIndex = 0; pairIndex < segmentsPerLeg; pairIndex++) {
    const segmentFrames = quotient + (pairIndex < remainder ? 1 : 0);
    bounds.push([from, from + segmentFrames]);
    from += segmentFrames;
  }
  assert.equal(bounds.length, segmentsPerLeg);

  const wallTimes = {
    eclipse: spreadWallTime(eclipseWallMs, segmentsPerLeg),
    control: spreadWallTime(controlWallMs, segmentsPerLeg),
  };
  const fills = {
    eclipse: spreadIntegerTotal(eclipseFills, segmentsPerLeg),
    control: spreadIntegerTotal(controlFills, segmentsPerLeg),
  };
  const refreshes = {
    eclipse: spreadIntegerTotal(eclipseRefreshes, segmentsPerLeg),
    control: spreadIntegerTotal(controlRefreshes, segmentsPerLeg),
  };
  const gpuSamples = gpuAvailable
    ? {
        eclipse: spreadGpuSamplesByPassAcrossSegments(
          eclipseGpuMs,
          refreshes.eclipse,
        ),
        control: spreadGpuSamplesByPassAcrossSegments(
          controlGpuMs,
          refreshes.control,
        ),
      }
    : { eclipse: {}, control: {} };
  const nextByLeg = { eclipse: 0, control: 0 };
  const segments = [];
  for (let pairIndex = 0; pairIndex < bounds.length; pairIndex++) {
    const [from, to] = bounds[pairIndex];
    const order =
      (pairIndex & 1) === 0 ? ["eclipse", "control"] : ["control", "eclipse"];
    for (const leg of order) {
      const legIndex = nextByLeg[leg]++;
      const segmentFills = fills[leg][legIndex];
      const segmentRefreshes = refreshes[leg][legIndex];
      const samplesMsByPass =
        gpuAvailable && segmentRefreshes > 0
          ? Object.fromEntries(
              MANDATORY_REFRESH_COST_GPU_PASS_NAMES.map((passName) => [
                passName,
                gpuSamples[leg][passName][legIndex],
              ]),
            )
          : {};
      const samplesMs = sumGpuSamplesByPass(samplesMsByPass, segmentRefreshes);
      const refreshBaselineFrameId =
        backend === "webgpu"
          ? pairIndex * 1000 + (leg === "eclipse" ? 0 : 500)
          : null;
      // Both backends retain a per-frame witness; only WebGPU carries a frame
      // ordinal to chain.
      const refreshSubmissions = spreadIntegerTotal(
        segmentRefreshes,
        to - from,
      );
      segments.push({
        ledgerId,
        pairIndex,
        leg,
        from,
        to,
        frames: to - from,
        wallMs: wallTimes[leg][legIndex],
        fills: segmentFills,
        refreshes: segmentRefreshes,
        refreshValid: true,
        refreshInvalidReason: null,
        refreshBaselineFrameId,
        refreshFrameIds:
          backend === "webgpu"
            ? Array.from(
                { length: to - from },
                (_, frameIndex) => refreshBaselineFrameId + frameIndex + 1,
              )
            : null,
        refreshSubmissions,
        gpuTime: gpuAvailable
          ? {
              status: "valid",
              available: true,
              valid: true,
              resolutionKnown: false,
              resolutionNs: null,
              totalMs: samplesMs.reduce((total, sample) => total + sample, 0),
              samplesMs,
              samplesMsByPass,
              invalidReason: null,
              queueDrain: {
                completed: true,
                timedOut: false,
                error: null,
              },
              preDrain: {
                drained: 1,
                undrained: 0,
                abandoned: 0,
                timedOut: false,
              },
              drain: {
                drained: 0,
                undrained: 0,
                abandoned: 0,
                timedOut: false,
              },
              results: {
                enabled: true,
                attemptedFrameCount: to - from,
                frameCount: to - from,
                readbackSkipCount: 0,
                failedReadbackCount: 0,
                emptyFrameCount: 0,
                lostSampleCount: 0,
                pendingReadbackCount: 0,
                unaccountedSampleCount: 0,
                invertedSampleCount: 0,
                droppedPassCount: 0,
                sampleLedgerBalanced: true,
              },
            }
          : {
              status: "unavailable",
              available: false,
              valid: false,
              resolutionKnown: false,
              resolutionNs: null,
              totalMs: null,
              samplesMs: [],
              samplesMsByPass: {},
              invalidReason: gpuUnavailableReason,
              queueDrain: null,
              preDrain: null,
              drain: null,
              results: null,
            },
      });
    }
  }

  return syncCostAggregatesFromSegments({
    protocol: {
      version: REFRESH_COST_PROTOCOL_VERSION,
      backend,
      runId,
      sessionLabel,
      sessionToken,
      ledgerId,
      sweepFrames: frames,
      segmentsPerLeg,
      factorSchedule: [...factorSchedule],
      gpuTime: {
        ...REFRESH_COST_GPU_TIME_PROTOCOL,
        featureAvailable: gpuAvailable,
        available: gpuAvailable,
        unavailableReason: gpuAvailable ? null : gpuUnavailableReason,
        resolutionKnown: false,
        resolutionNs: null,
      },
    },
    gpuTime: {
      status: gpuAvailable ? "valid" : "unavailable",
      available: gpuAvailable,
      valid: gpuAvailable,
      resolutionKnown: false,
      resolutionNs: null,
      eclipseMs: gpuAvailable ? eclipseGpuMs : null,
      controlMs: gpuAvailable ? controlGpuMs : null,
      invalidReason: gpuAvailable ? null : gpuUnavailableReason,
      captureHook: {
        installed: gpuAvailable,
        restored: true,
        originalIdentityRestored: true,
      },
    },
    warmupBothLegs: true,
    warmups: [
      {
        ledgerId,
        leg: "eclipse",
        completed: true,
        from: 0,
        to: frames,
        frames,
      },
      {
        ledgerId,
        leg: "control",
        completed: true,
        from: 0,
        to: frames,
        frames,
      },
    ],
    interleave: "ABBA — the leg that runs first alternates per segment",
    segmentsPerLeg,
    segments,
  });
}

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
      scheduledObscuration: target,
      published: {
        moonObscuration: target,
        factor,
        enabled: true,
        valid: true,
        shadowStrength: directional,
      },
      deckFreePublished: {
        moonObscuration: target,
        factor,
        enabled: true,
        valid: true,
        cameraHeight: 1400,
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
        cloudCacheOff: {
          shadowActive: true,
          shadowViewPresent: true,
          shadowFrameValid: true,
          shadowStrength: 1,
          shadowAbsorption: 0.04,
          shadowSize: 512,
        },
        cloudCacheOn: {
          shadowActive: true,
          shadowViewPresent: true,
          shadowFrameValid: true,
          shadowStrength: directional,
          shadowAbsorption: 0.04,
          shadowSize: 512,
        },
        footprintOff: {
          allInside: true,
          texelSpan: 8,
          samples: [
            { groundHit: true, inside: true },
            { groundHit: true, inside: true },
          ],
        },
        cameraHeight: 1400,
        pitchDegrees: -8,
        samples: 20000,
      },
    };
  });

  const buckets = idealSweepBuckets();
  const factors = ratifiedFactorSchedule();
  const iblLane = (backend) => {
    const sessionLabel = `ibl-${backend}`;
    const sessionToken = `fixture-${backend}-session`;
    const costLedgerId = `fixture-${backend}-cost-ledger`;
    return {
      rendererType: backend,
      runId: FIXTURE_RUN_ID,
      sessionLabel,
      sessionToken,
      costLedgerId,
      sweepFrames: SWEEP_FRAMES,
      factors: [...factors],
      obscurations: ratifiedObscurationSchedule(),
      buckets,
      initialCommittedWasNaN: false,
      engineRefreshCount: 275,
      controlRefreshCount: 1,
      sweepWallMs: 9000,
      controlWallMs: 5000,
      // The INTERLEAVED cost accounting. 4000 ms over 274 eclipse-driven fills.
      // Each leg carries the toggle-absorbing segment fills (8 per leg), so the
      // DIFFERENCE is the sweep's own 274 edges.
      refreshCost: freshCostAccounting({
        backend,
        runId: FIXTURE_RUN_ID,
        sessionLabel,
        sessionToken,
        ledgerId: costLedgerId,
        factorSchedule: factors,
      }),
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
    };
  };

  const deckFreeControl = foldDeckFreeControlSessions({
    sessions: freshDeckFreeSessions(rungs),
    ladder: rungs.map(({ target, iso, scheduledObscuration }) => ({
      target,
      iso,
      obscuration: scheduledObscuration,
    })),
    certifiedRungs: rungs,
    factorTolerance: ECLIPSE_CLOUD_BANDS.factorTolerance.hi,
    scheduleObscurationTolerance:
      ECLIPSE_CLOUD_BANDS.scheduleObscurationTolerance.hi,
    captureDelta: BAND_MEAN_CAPTURE_DELTA,
    diagnosticSite: DECK_FREE_DIAGNOSTIC_SITE,
  });
  for (let index = 0; index < rungs.length; index++) {
    Object.assign(rungs[index].shadow, deckFreeControl.rungs[index]);
  }

  return {
    runId: FIXTURE_RUN_ID,
    cloudLanes: {
      rendererType: "webgpu",
      rungs,
      deckFreeControl,
      repeat: { first: 0.5, again: 0.5005, delta: 0.0005 },
    },
    iblWebGPU: iblLane("webgpu"),
    iblWebGL: iblLane("webgl"),
  };
}

const clone = (value) => structuredClone(value);

function refoldDeckFreeControl(run) {
  const cloud = run.cloudLanes;
  const control = foldDeckFreeControlSessions({
    sessions: cloud.deckFreeControl.sessions,
    ladder: cloud.rungs.map(({ target, iso, scheduledObscuration }) => ({
      target,
      iso,
      obscuration: scheduledObscuration,
    })),
    certifiedRungs: cloud.rungs,
    factorTolerance: ECLIPSE_CLOUD_BANDS.factorTolerance.hi,
    scheduleObscurationTolerance:
      ECLIPSE_CLOUD_BANDS.scheduleObscurationTolerance.hi,
    captureDelta: BAND_MEAN_CAPTURE_DELTA,
    diagnosticSite: DECK_FREE_DIAGNOSTIC_SITE,
  });
  cloud.deckFreeControl = control;
  for (let index = 0; index < cloud.rungs.length; index++) {
    Object.assign(cloud.rungs[index].shadow, control.rungs[index]);
  }
  return control;
}

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

/** Keep a deck-free mutant physically consistent with the decrement model. */
function syncShadowDecrementsToDeckFree(run) {
  for (const rung of run.cloudLanes?.rungs ?? []) {
    const shadow = rung.shadow;
    const clearDecrement = shadow.offNoShadow - shadow.offShadow;
    const groundDim = shadow.onNoCloud / shadow.offNoCloud;
    const strengthRatio = shadow.strengthOn / shadow.strengthOff;
    shadow.onShadow =
      shadow.onNoShadow - clearDecrement * groundDim * strengthRatio;
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
  // 28 -> 29 at CO-21: the same-page settled-twin precondition. The redesigned
  // control added two gates (29 -> 31): four fresh ABBA configure epochs, plus
  // a live DAYNIGHT surface proven by a separate unsaturated DirectionalLight
  // diagnostic. R-2026-08-14-1 restores the raw contrast and fresh measured
  // cost, while retaining the decrement model under two explicit names: 32.
  assert.equal(ECLIPSE_CLOUD_GATE_PREDICATES.length, 32);
  // 4 -> 5 at CO-19: `offNoCloudVariesWithSun`, the instrument tell.
  // 5 -> 6 at CO-21: `deckFreeGroundRetentionLegsAgreeReportedOnly`, the
  // corroborating disagreement between lane B's two retention ratios.
  // The ruling removes both demoted operative subjects from reported-only:
  // raw contrast and refresh-cost eligibility. The remaining six values are
  // diagnostics that do not replace a gate.
  // 6 -> 7 at the C13-41 mechanism pass:
  // `shadowResidueEncodeHypothesisInRange`, which scores whether the
  // DERIVED in-shader encode locus is an admissible residue at all. It is a
  // hypothesis reading, so it must never gate.
  assert.equal(ECLIPSE_CLOUD_REPORTED_ONLY_PREDICATES.length, 7);
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

  // The load-bearing guard R-2026-08-14-1 explicitly ordered restored. Drive
  // both deletion and reported-only demotion mutants through the same
  // assertion so neither dropping nor relabelling either gate can leave this
  // suite green.
  const ruledGates = [
    {
      gate: "shadowContrastInvariant",
      demotedAlias: "shadowCompositeContrastInLegacyBandReportedOnly",
    },
    {
      gate: "refreshCostMeasured",
      demotedAlias: "refreshCostEstimateValidReportedOnly",
    },
  ];
  const assertRuledGatesOperative = (
    predicates,
    reportedOnly = ECLIPSE_CLOUD_REPORTED_ONLY_PREDICATES,
  ) => {
    for (const { gate, demotedAlias } of ruledGates) {
      assert.ok(
        !reportedOnly.includes(demotedAlias),
        `${gate} may not be demoted to ${demotedAlias}`,
      );
      assert.ok(predicates.includes(gate), `${gate} must remain a gate`);
    }
  };
  assert.doesNotThrow(() =>
    assertRuledGatesOperative(ECLIPSE_CLOUD_GATE_PREDICATES),
  );
  for (const { gate } of ruledGates) {
    assert.throws(
      () =>
        assertRuledGatesOperative(
          ECLIPSE_CLOUD_GATE_PREDICATES.filter((name) => name !== gate),
        ),
      new RegExp(`${gate} must remain a gate`),
      `deleting ${gate} must trip the guard`,
    );
  }
  for (const { gate, demotedAlias } of ruledGates) {
    assert.throws(
      () =>
        assertRuledGatesOperative(
          ECLIPSE_CLOUD_GATE_PREDICATES.filter((name) => name !== gate),
          [...ECLIPSE_CLOUD_REPORTED_ONLY_PREDICATES, demotedAlias],
        ),
      new RegExp(`${gate} may not be demoted to ${demotedAlias}`),
      `demoting ${gate} to ${demotedAlias} must trip the guard`,
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

test("D5 strength = F follows the actual producer but fails the shipped law and discriminator", () => {
  expectFailure(
    (run) => {
      for (const rung of run.cloudLanes.rungs) {
        const factor = predictFactor(rung.published.moonObscuration);
        rung.published.shadowStrength = factor; // S2's scalar, not the directional
        rung.shadow.strengthOn = factor;
        rung.shadow.cloudCacheOn.shadowStrength = factor;
        rung.shadow.onShadow = rung.shadow.onNoShadow * shadowContrast(factor);
      }
    },
    [
      "shadowStrengthMatchesDirectional",
      "shadowContrastInvariant",
      "shadowDecrementRejectsAlternativeDesign",
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

test("D8 a COARSER ramp is red and cannot retain an unrelated 801-frame cost ledger", () => {
  const run = clone(passingRun());
  for (const lane of [run.iblWebGPU, run.iblWebGL]) {
    lane.factors = lane.factors.filter((_, index) => index % 4 === 0);
    lane.sweepFrames = lane.factors.length;
    lane.engineRefreshCount = 80;
  }
  const verdict = judgeEclipseCloudResponse(run);
  assert.deepEqual(verdict.failedPredicates.sort(), [
    "engineRefreshCountWebGLInBand",
    "engineRefreshCountWebGPUInBand",
    "rampNeverSkipsABucket",
    "sweepQuiescenceInBand",
  ]);
  assert.match(
    verdict.structuralReasons.join("\n"),
    /refresh-cost sweep length diverges from the ratified 801 frames/,
  );
  assert.equal(
    verdict.exitCode,
    ECLIPSE_CLOUD_EXIT.FAIL,
    "the measured ramp/count reds must outrank the now-ineligible cost ledger",
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

test("D11 a noisy control with eclipse-driven fills fails", () => {
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

test("D13 a cost differential that cannot be formed is STRUCTURAL with its exact reason", () => {
  const run = clone(passingRun());
  // Same fill count in both legs: nothing to attribute the wall clock to.
  run.iblWebGPU.refreshCost = freshCostAccounting({
    eclipseFills: 8,
    controlFills: 8,
  });
  const verdict = judgeEclipseCloudResponse(run);
  assert.equal(verdict.refreshCostMeasured, false);
  assert.equal(verdict.cost.webgpu.valid, false);
  assert.match(verdict.cost.invalidReasons[0], /differential cannot be formed/);
  assert.match(
    verdict.structuralReasons.join("\n"),
    /fresh refresh-cost measurement is ineligible: webgpu:/,
  );
  assert.ok(verdict.unscoredPredicates.includes("refreshCostMeasured"));
  assert.deepEqual(verdict.failedPredicates, []);
  assert.equal(verdict.PASS, false);
  assert.equal(verdict.exitCode, ECLIPSE_CLOUD_EXIT.STRUCTURAL);
});

test("D14 a valid fresh cost measurement gates and retains its exact value", () => {
  const verdict = judgeEclipseCloudResponse(passingRun());
  // 4000 ms over 274 eclipse-driven fills.
  assert.equal(Number(verdict.cost.webgpuMsPerRefresh.toFixed(4)), 14.5985);
  assert.equal(verdict.refreshCostMeasured, true);
  assert.equal(verdict.cost.webgpu.valid, true);
  assert.deepEqual(verdict.cost.invalidReasons, []);
  assert.ok(!verdict.unscoredPredicates.includes("refreshCostMeasured"));
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

test("E2d a dead producer or escaped footprint fails closed before decrement scoring", () => {
  for (const [label, mutate, expectedReason] of [
    [
      "producer",
      (run) => {
        run.cloudLanes.rungs[2].shadow.cloudCacheOn.shadowFrameValid = false;
      },
      /eclipse shadow producer is not live/,
    ],
    [
      "footprint",
      (run) => {
        run.cloudLanes.rungs[2].shadow.footprintOff.samples[0].inside = false;
      },
      /outside the shadow footprint/,
    ],
  ]) {
    const run = clone(passingRun());
    mutate(run);
    const verdict = judgeEclipseCloudResponse(run);
    assert.equal(
      verdict.shadowProducerAndFootprintCertified,
      false,
      `${label} mutant must invalidate producer/footprint certification`,
    );
    assert.match(verdict.structuralReasons.join("\n"), expectedReason);
    assert.ok(verdict.unscoredPredicates.includes("shadowContrastInvariant"));
    assert.deepEqual(verdict.failedPredicates, []);
    assert.equal(verdict.exitCode, ECLIPSE_CLOUD_EXIT.STRUCTURAL);
  }
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
      "deckFreeControlStateIsolated",
      "shadowGroundIsBright",
      "shadowGroundNotOccluded",
      "shadowNonVacuous",
      "shadowContrastInvariant",
      "shadowDecrementMatchesGroundDim",
      "shadowDecrementRejectsAlternativeDesign",
      // CO-21: `deck-free` is a CHILD of `shadow`, so a blind lane B takes the
      // attribution AND its convergence precondition with it — the direction
      // that must hold. The converse (an unsettled control blinding the
      // contrast) is what the parent chain deliberately prevents; L9 pins it.
      "deckFreeGroundIsLit",
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
// I. THE REFRESH-COST ARITHMETIC
// ─────────────────────────────────────────────────────────────────────────────

const costInput = (options = {}) => freshCostAccounting(options);

function computeCost(accounting, implementation = computeRefreshCost) {
  if (!accounting?.protocol) {
    return implementation(accounting);
  }
  const protocol = accounting.protocol;
  const lane = {
    rendererType: protocol.backend,
    runId: protocol.runId,
    sessionLabel: protocol.sessionLabel,
    sessionToken: protocol.sessionToken,
    costLedgerId: protocol.ledgerId,
    sweepFrames: protocol.sweepFrames,
    factors: [...protocol.factorSchedule],
    obscurations: ratifiedObscurationSchedule(),
  };
  return implementation(accounting, {
    runId: protocol.runId,
    expectedBackend: protocol.backend,
    expectedSessionLabel: protocol.sessionLabel,
    lane,
    peerLane: {
      sessionToken: `${protocol.sessionToken}-distinct-peer`,
      costLedgerId: `${protocol.ledgerId}-distinct-peer`,
    },
  });
}

test("I1 the estimate uses the submitted-refresh differential", () => {
  const cost = computeCost(costInput({}));
  assert.equal(cost.valid, true);
  assert.equal(cost.derivedFromSegments, true);
  assert.equal(cost.retainedSegmentCount, 16);
  assert.equal(cost.warmupWitnessCount, 2);
  assert.equal(cost.msDelta, 4000);
  assert.equal(cost.fillDelta, 274);
  assert.equal(cost.refreshDelta, 274);
  assert.equal(Number(cost.msPerRefresh.toFixed(4)), 14.5985);
  assert.equal(cost.invalidReason, null);
});

test("I2 a NEGATIVE differential is INVALID with a named reason, never a number", () => {
  // The first run's actual numbers: 0.77 s eclipse leg, 5.97 s control leg.
  const cost = computeCost(
    costInput({
      backend: "webgl",
      eclipseWallMs: 770,
      controlWallMs: 5970,
    }),
  );
  assert.equal(cost.valid, false);
  assert.equal(cost.msPerRefresh, null, "a negative cost is never reported");
  assert.match(cost.invalidReason, /control leg outran the eclipse leg/);
  assert.match(cost.invalidReason, /5970/);
  assert.match(cost.invalidReason, /770/);
  // The old arithmetic would have published -18.98 ms/refresh as a measurement.
  assert.equal(Number(((770 - 5970) / 274).toFixed(2)), -18.98);
});

test("I3 both retained warm-up witnesses are required — a boolean cannot replace them", () => {
  const missingWitness = costInput();
  missingWitness.warmups.pop();
  let cost = computeCost(missingWitness);
  assert.equal(cost.valid, false);
  assert.equal(cost.msPerRefresh, null);
  assert.match(cost.invalidReason, /warm-up parity has 1 per-leg witness/i);

  const forgedSummary = costInput();
  forgedSummary.warmupBothLegs = false;
  cost = computeCost(forgedSummary);
  assert.equal(cost.valid, false);
  assert.match(cost.invalidReason, /summary disagrees.*per-leg witnesses/);
});

test("I4 a SEQUENTIAL A/B is rejected — interleaving is required, not advised", () => {
  assert.equal(REFRESH_COST_SEGMENTS_PER_LEG, 8);
  assert.deepEqual(deriveRefreshCostSegmentBounds(), [
    [0, 101],
    [101, 201],
    [201, 301],
    [301, 401],
    [401, 501],
    [501, 601],
    [601, 701],
    [701, 801],
  ]);
  for (const segments of [1, 2, 7, 9]) {
    const cost = computeCost(
      costInput({ segmentsPerLeg: segments, eclipseFills: segments + 1 }),
    );
    assert.equal(cost.valid, false, `${segments} segment(s) must be rejected`);
    assert.match(cost.invalidReason, /not exactly 8/);
  }
  assert.equal(
    computeCost(
      costInput({
        segmentsPerLeg: REFRESH_COST_SEGMENTS_PER_LEG,
        eclipseFills: 12,
        controlFills: 8,
      }),
    ).valid,
    true,
  );
});

test("I5 unshared bounds and a zero refresh delta are both INVALID", () => {
  const unshared = costInput();
  unshared.segments[1].to -= 1;
  unshared.segments[1].frames -= 1;
  syncCostAggregatesFromSegments(unshared);
  const uneven = computeCost(unshared);
  assert.equal(uneven.valid, false);
  assert.match(uneven.invalidReason, /does not share bounds\/frame count/);

  const noRefreshes = computeCost(
    costInput({ eclipseRefreshes: 8, controlRefreshes: 8 }),
  );
  assert.equal(noRefreshes.valid, false);
  assert.match(noRefreshes.invalidReason, /no positive environment-refresh/);
  assert.match(
    noRefreshes.invalidReason,
    /fresh differential cannot be formed/,
  );

  const absent = computeCost(undefined);
  assert.equal(absent.valid, false);
  assert.match(absent.invalidReason, /no refresh-cost accounting/);
});

test("I6 a zero wall-clock differential is VALID at exactly 0 — non-negative by construction", () => {
  // Wall clock is the figure of record only where no GPU timing path exists
  // (WebGL). A zero GPU differential is a bound, not a figure — see I20.
  const cost = computeCost(
    costInput({ backend: "webgl", eclipseWallMs: 5000 }),
  );
  assert.equal(cost.valid, true);
  assert.equal(cost.measurementSource, "wall-clock-fallback");
  assert.equal(cost.msPerRefresh, 0);
  assert.ok(cost.msPerRefresh >= 0);
});

test("I6b a solve residual inside the schedule band does not void the measurement", () => {
  // The clock instants are solved for the ramp, so the realized obscuration
  // carries a residual the factor band cannot absorb but the schedule band
  // must. A self-consistent factor for that realized value is VALID.
  const run = clone(passingRun());
  for (const lane of [run.iblWebGPU, run.iblWebGL]) {
    lane.obscurations[1] += 1.1e-7;
    lane.factors[1] = predictFactor(lane.obscurations[1]);
    lane.refreshCost.protocol.factorSchedule[1] = lane.factors[1];
  }
  const verdict = judgeEclipseCloudResponse(run);
  assert.equal(verdict.refreshCostMeasured, true);
  assert.deepEqual(verdict.cost.invalidReasons, []);
});

test("I6c a factor that disagrees with its own realized obscuration is STRUCTURAL", () => {
  expectRefreshCostStructural((run) => {
    for (const lane of [run.iblWebGPU, run.iblWebGL]) {
      lane.obscurations[1] += 1.1e-7;
    }
  }, /live refresh-cost factor does not match its realized obscuration at frame 1/);
});
test("I7 either backend INVALID makes the fresh measurement STRUCTURAL", () => {
  const run = clone(passingRun());
  run.iblWebGL.refreshCost = costInput({
    backend: "webgl",
    eclipseWallMs: 100,
  });
  const verdict = judgeEclipseCloudResponse(run);
  assert.equal(verdict.refreshCostMeasured, false);
  assert.equal(verdict.cost.webglMsPerRefresh, null);
  assert.equal(verdict.cost.webgpu.valid, true);
  assert.equal(verdict.cost.invalidReasons.length, 1);
  assert.match(verdict.cost.invalidReasons[0], /^webgl: /);
  assert.match(verdict.structuralReasons.join("\n"), /webgl:/);
  assert.ok(verdict.unscoredPredicates.includes("refreshCostMeasured"));
  assert.deepEqual(verdict.failedPredicates, []);
  assert.equal(verdict.PASS, false);
  assert.equal(verdict.exitCode, ECLIPSE_CLOUD_EXIT.STRUCTURAL);
});

test("I8 historical estimates cannot substitute for absent fresh accounting", () => {
  const run = clone(passingRun());
  delete run.iblWebGPU.refreshCost;
  // Adversarial demotion/estimate-substitution shape: every historical field a
  // permissive fold might consult says yes, but the fresh primitive is absent.
  run.iblWebGPU.refreshCostEstimateValidReportedOnly = true;
  run.iblWebGPU.msPerRefresh = 7.749;
  run.iblWebGPU.sweepWallMs = 9000;
  run.iblWebGPU.controlWallMs = 5000;
  const verdict = judgeEclipseCloudResponse(run);
  assert.equal(verdict.refreshCostMeasured, false);
  assert.equal(verdict.cost.webgpu.valid, false);
  assert.match(
    verdict.cost.webgpu.invalidReason,
    /reported no refresh-cost accounting/,
  );
  assert.match(
    verdict.structuralReasons.join("\n"),
    /fresh refresh-cost measurement is ineligible/,
  );
  assert.ok(verdict.unscoredPredicates.includes("refreshCostMeasured"));
  assert.equal(verdict.exitCode, ECLIPSE_CLOUD_EXIT.STRUCTURAL);
});

test("I9 malformed retained primitives are STRUCTURAL/3, never summary-scored", () => {
  const mutants = [
    {
      name: "missing segment",
      mutate: (accounting) => accounting.segments.pop(),
      reason: /exact 2\*N cardinality/,
    },
    {
      name: "reordered pair",
      mutate: (accounting) =>
        ([accounting.segments[0], accounting.segments[1]] = [
          accounting.segments[1],
          accounting.segments[0],
        ]),
      reason: /violates ABBA order/,
    },
    {
      name: "duplicated record",
      mutate: (accounting) => {
        accounting.segments[2] = structuredClone(accounting.segments[0]);
      },
      reason: /carries pairIndex 0, expected 1/,
    },
    {
      name: "negative wall time",
      mutate: (accounting) => {
        accounting.segments[0].wallMs = -1;
      },
      reason: /invalid non-negative wall time -1/,
    },
    {
      name: "non-finite wall time",
      mutate: (accounting) => {
        accounting.segments[0].wallMs = Infinity;
      },
      reason: /invalid non-negative wall time Infinity/,
    },
    {
      name: "negative frame count",
      mutate: (accounting) => {
        accounting.segments[0].frames = -1;
      },
      reason: /invalid integer frame count -1/,
    },
    {
      name: "fractional frame count",
      mutate: (accounting) => {
        accounting.segments[0].frames += 0.5;
      },
      reason: /invalid integer frame count/,
    },
    {
      name: "negative fill count",
      mutate: (accounting) => {
        accounting.segments[0].fills = -1;
      },
      reason: /invalid integer fill count -1/,
    },
    {
      name: "fractional fill count",
      mutate: (accounting) => {
        accounting.segments[0].fills += 0.5;
      },
      reason: /invalid integer fill count/,
    },
    {
      name: "unshared segment bounds",
      mutate: (accounting) => {
        accounting.segments[1].to -= 1;
        accounting.segments[1].frames -= 1;
      },
      reason: /does not share bounds\/frame count/,
    },
    {
      name: "forged aggregate",
      mutate: (accounting) => {
        accounting.eclipseWallMs += 1;
      },
      reason: /aggregate eclipseWallMs=.*does not equal.*segment total/,
    },
    {
      name: "missing warm-up witness",
      mutate: (accounting) => accounting.warmups.pop(),
      reason: /warm-up parity has 1 per-leg witness/,
    },
    {
      name: "duplicated warm-up witness",
      mutate: (accounting) => {
        accounting.warmups[1] = structuredClone(accounting.warmups[0]);
      },
      reason: /warm-up witnesses duplicate the eclipse leg/,
    },
  ];

  for (const { name, mutate, reason } of mutants) {
    const run = clone(passingRun());
    mutate(run.iblWebGPU.refreshCost);
    const verdict = judgeEclipseCloudResponse(run);
    assert.equal(verdict.refreshCostMeasured, false, name);
    assert.equal(verdict.cost.webgpu.valid, false, name);
    assert.match(verdict.cost.webgpu.invalidReason, reason, name);
    assert.ok(verdict.unscoredPredicates.includes("refreshCostMeasured"), name);
    assert.deepEqual(verdict.failedPredicates, [], name);
    assert.equal(verdict.exitCode, ECLIPSE_CLOUD_EXIT.STRUCTURAL, name);
  }
});

test("I10 aggregate-only sequential A/B cannot impersonate a fresh ledger", () => {
  const run = clone(passingRun());
  run.iblWebGPU.refreshCost = {
    warmupBothLegs: true,
    segmentsPerLeg: 1,
    interleave: "sequential A/B — eclipse then control",
    eclipseFrames: SWEEP_FRAMES,
    controlFrames: SWEEP_FRAMES,
    eclipseWallMs: 770,
    controlWallMs: 5970,
    eclipseFills: 282,
    controlFills: 8,
    msPerRefresh: 7.749,
  };
  const verdict = judgeEclipseCloudResponse(run);
  assert.equal(verdict.refreshCostMeasured, false);
  assert.equal(verdict.cost.webgpu.valid, false);
  assert.match(
    verdict.cost.webgpu.invalidReason,
    /no refresh-cost segment ledger/,
  );
  assert.match(
    verdict.cost.webgpu.invalidReason,
    /aggregate or historical summaries cannot substitute/,
  );
  assert.ok(verdict.unscoredPredicates.includes("refreshCostMeasured"));
  assert.deepEqual(verdict.failedPredicates, []);
  assert.equal(verdict.exitCode, ECLIPSE_CLOUD_EXIT.STRUCTURAL);
});

function replaceLaneCost(run, lane, options = {}) {
  lane.refreshCost = freshCostAccounting({
    backend: lane.rendererType,
    runId: run.runId,
    sessionLabel: lane.sessionLabel,
    sessionToken: lane.sessionToken,
    ledgerId: lane.costLedgerId,
    frames: lane.sweepFrames,
    factorSchedule: lane.factors,
    ...options,
  });
  return lane.refreshCost;
}

function expectRefreshCostStructural(mutate, reason) {
  const run = clone(passingRun());
  mutate(run);
  const verdict = judgeEclipseCloudResponse(run);
  assert.equal(verdict.refreshCostMeasured, false);
  assert.match(verdict.cost.invalidReasons.join("\n"), reason);
  assert.ok(verdict.unscoredPredicates.includes("refreshCostMeasured"));
  assert.deepEqual(verdict.failedPredicates, []);
  assert.deepEqual(verdict.parityFailed, []);
  assert.equal(verdict.exitCode, ECLIPSE_CLOUD_EXIT.STRUCTURAL);
  return verdict;
}

test("I11 the cost ledger is exactly eight independently partitioned pairs over 801 frames", async (t) => {
  await t.test(
    "a coordinated three-frame truncation cannot redefine the protocol",
    () => {
      expectRefreshCostStructural((run) => {
        for (const lane of [run.iblWebGPU, run.iblWebGL]) {
          lane.factors = lane.factors.slice(0, SWEEP_FRAMES - 3);
          lane.sweepFrames = lane.factors.length;
          replaceLaneCost(run, lane);
        }
      }, /sweep length diverges from the ratified 801 frames/);
    },
  );

  await t.test("a 794+1+1+1+1+1+1+1 partition cannot self-certify", () => {
    expectRefreshCostStructural((run) => {
      const accounting = run.iblWebGPU.refreshCost;
      const bounds = [
        [0, 794],
        [794, 795],
        [795, 796],
        [796, 797],
        [797, 798],
        [798, 799],
        [799, 800],
        [800, 801],
      ];
      for (let pairIndex = 0; pairIndex < bounds.length; pairIndex++) {
        const [from, to] = bounds[pairIndex];
        for (const segment of accounting.segments.slice(
          2 * pairIndex,
          2 * pairIndex + 2,
        )) {
          segment.from = from;
          segment.to = to;
          segment.frames = to - from;
          segment.fills =
            pairIndex === 0 ? (segment.leg === "eclipse" ? 275 : 1) : 1;
        }
      }
      syncCostAggregatesFromSegments(accounting);
    }, /not the independently derived ratified bounds 0\.\.101\/101/);
  });

  await t.test("an odd 15-record ledger cannot pass cardinality", () => {
    expectRefreshCostStructural((run) => {
      run.iblWebGPU.refreshCost.segments.pop();
    }, /15 records, not the exact 2\*N cardinality 16/);
  });

  for (const segmentsPerLeg of [7, 9]) {
    await t.test(
      `a coordinated ${segmentsPerLeg}-pair estimator is not the ratified estimator`,
      () => {
        expectRefreshCostStructural(
          (run) => {
            replaceLaneCost(run, run.iblWebGPU, { segmentsPerLeg });
          },
          new RegExp(`declares ${segmentsPerLeg} pairs per leg, not exactly 8`),
        );
      },
    );
  }
});

test("I12 backend, session, run, and schedule bindings reject replay and substitution", async (t) => {
  const cases = [
    {
      name: "missing protocol header",
      mutate: (run) => {
        delete run.iblWebGPU.refreshCost.protocol;
      },
      reason:
        /no protocol header binding it to the live run, backend, session, and factor schedule/,
    },
    {
      name: "wrong backend",
      mutate: (run) => {
        run.iblWebGPU.refreshCost.protocol.backend = "webgl";
      },
      reason: /protocol backend webgl does not match live webgpu lane/,
    },
    {
      name: "coordinated wrong backend",
      mutate: (run) => {
        run.iblWebGPU.rendererType = "webgl";
        run.iblWebGPU.refreshCost.protocol.backend = "webgl";
      },
      reason: /live webgpu cost lane resolved rendererType webgl/,
    },
    {
      name: "wrong session label",
      mutate: (run) => {
        run.iblWebGPU.refreshCost.protocol.sessionLabel =
          "ibl-webgpu-historical";
      },
      reason: /refresh-cost session label diverges/,
    },
    {
      name: "coordinated wrong session label",
      mutate: (run) => {
        run.iblWebGPU.sessionLabel = "ibl-webgpu-historical";
        run.iblWebGPU.refreshCost.protocol.sessionLabel =
          "ibl-webgpu-historical";
      },
      reason: /refresh-cost session label diverges/,
    },
    {
      name: "wrong session token",
      mutate: (run) => {
        run.iblWebGPU.refreshCost.protocol.sessionToken = "stale-session";
      },
      reason: /session token does not bind the ledger/,
    },
    {
      name: "well-formed historical lane and ledger under an old run identity",
      mutate: (run) => {
        run.iblWebGPU.runId = "historical-run";
        run.iblWebGPU.refreshCost.protocol.runId = "historical-run";
      },
      reason:
        /run identity diverges \(report fixture-current-run, lane historical-run, ledger historical-run\)/,
    },
    {
      name: "ledger schedule changed without the live lane",
      mutate: (run) => {
        run.iblWebGPU.refreshCost.protocol.factorSchedule[0] -= 1e-6;
      },
      reason: /factor schedule diverges from the live lane at frame 0/,
    },
    {
      name: "coordinated lane and ledger schedule rewrite",
      mutate: (run) => {
        for (const lane of [run.iblWebGPU, run.iblWebGL]) {
          lane.factors[0] -= 1e-6;
          lane.refreshCost.protocol.factorSchedule[0] = lane.factors[0];
        }
      },
      reason:
        /live refresh-cost factor does not match its realized obscuration at frame 0/,
    },
    {
      name: "realized obscuration leaves the ratified ramp",
      mutate: (run) => {
        for (const lane of [run.iblWebGPU, run.iblWebGL]) {
          // A self-consistent factor for an obscuration the ramp never
          // scheduled: the same-input check passes, the ramp check must not.
          lane.obscurations[0] += 0.001;
          lane.factors[0] = predictFactor(lane.obscurations[0]);
          lane.refreshCost.protocol.factorSchedule[0] = lane.factors[0];
        }
      },
      reason:
        /live refresh-cost factor schedule misses the ratified sweep at frame 0/,
    },
    {
      name: "lane lost its realized obscurations",
      mutate: (run) => {
        for (const lane of [run.iblWebGPU, run.iblWebGL]) {
          delete lane.obscurations;
        }
      },
      reason: /must carry exactly 801 realized obscurations/,
    },
  ];

  for (const { name, mutate, reason } of cases) {
    await t.test(name, () => {
      expectRefreshCostStructural(mutate, reason);
    });
  }
});

test("I13 backend ledgers and per-page identities cannot be reused across peers", async (t) => {
  await t.test("a complete WebGPU ledger cannot substitute for WebGL", () => {
    expectRefreshCostStructural((run) => {
      [run.iblWebGPU.refreshCost, run.iblWebGL.refreshCost] = [
        run.iblWebGL.refreshCost,
        run.iblWebGPU.refreshCost,
      ];
    }, /protocol backend webgl does not match live webgpu lane|protocol backend webgpu does not match live webgl lane/);
  });

  await t.test(
    "WebGPU segment primitives cannot be copied into a WebGL ledger",
    () => {
      expectRefreshCostStructural((run) => {
        run.iblWebGL.refreshCost.segments = clone(
          run.iblWebGPU.refreshCost.segments,
        );
      }, /is not bound to ledger fixture-webgl-cost-ledger/);
    },
  );

  await t.test("the two backend pages cannot reuse one session token", () => {
    expectRefreshCostStructural((run) => {
      run.iblWebGL.sessionToken = run.iblWebGPU.sessionToken;
      run.iblWebGL.refreshCost.protocol.sessionToken =
        run.iblWebGPU.sessionToken;
    }, /reuse a session token or ledger identity/);
  });

  await t.test("the two backend pages cannot reuse one ledger identity", () => {
    expectRefreshCostStructural((run) => {
      run.iblWebGL.costLedgerId = run.iblWebGPU.costLedgerId;
      run.iblWebGL.refreshCost.protocol.ledgerId = run.iblWebGPU.costLedgerId;
    }, /reuse a session token or ledger identity/);
  });
});

test("I14 valid GPU time on both backends is the selected refresh-cost source", () => {
  const run = clone(passingRun());
  replaceLaneCost(run, run.iblWebGPU, {
    gpuAvailable: true,
    eclipseWallMs: 5418,
    controlWallMs: 5982,
    eclipseGpuMs: 548,
    controlGpuMs: 0,
  });
  replaceLaneCost(run, run.iblWebGL, {
    gpuAvailable: true,
    eclipseGpuMs: 274,
    controlGpuMs: 0,
  });

  for (const lane of [run.iblWebGPU, run.iblWebGL]) {
    const sampledSegment = lane.refreshCost.segments.find(
      (segment) => segment.gpuTime.valid && segment.fills > 0,
    );
    assert.ok(sampledSegment);
    assert.deepEqual(
      Object.keys(sampledSegment.gpuTime.samplesMsByPass),
      MANDATORY_REFRESH_COST_GPU_PASS_NAMES,
    );
  }

  const verdict = judgeEclipseCloudResponse(run);
  assert.equal(verdict.refreshCostMeasured, true);
  assert.equal(verdict.cost.webgpu.measurementSource, "gpu-time");
  assert.equal(verdict.cost.webgl.measurementSource, "gpu-time");
  assert.equal(verdict.cost.webgpu.msDelta, 548);
  assert.equal(verdict.cost.webgl.msDelta, 274);
  assert.equal(verdict.cost.webgpu.msPerRefresh, 2);
  assert.equal(verdict.cost.webgl.msPerRefresh, 1);
  assert.equal(verdict.cost.webgpu.wallMsDelta, -564);
  assert.equal(verdict.cost.webgl.wallMsDelta, 4000);
  assert.equal(verdict.cost.webgpu.wallClockRole, "bound");
  assert.equal(verdict.cost.webgl.wallClockRole, "bound");
});

test("I15 an unavailable GPU path has a backend-specific named disposition", () => {
  const run = passingRun();
  const unavailableSegment = run.iblWebGL.refreshCost.segments[0];
  assert.deepEqual(unavailableSegment.gpuTime.samplesMs, []);
  assert.deepEqual(unavailableSegment.gpuTime.samplesMsByPass, {});
  const verdict = judgeEclipseCloudResponse(run);
  const webgl = verdict.cost.webgl;
  assert.equal(verdict.refreshCostMeasured, true);
  assert.equal(webgl.valid, true);
  assert.equal(webgl.measurementSource, "wall-clock-fallback");
  assert.equal(webgl.fallbackReason, REFRESH_COST_WEBGL_GPU_UNAVAILABLE_REASON);
  assert.equal(webgl.wallClockRole, "figure-of-record");
  assert.equal(webgl.gpuTime.status, "unavailable");
  assert.equal(webgl.gpuTime.invalidReason, webgl.fallbackReason);

  const webgpu = computeCost(
    costInput({ backend: "webgpu", gpuAvailable: false }),
  );
  assert.equal(webgpu.valid, false);
  assert.equal(webgpu.msPerRefresh, null);
  assert.equal(
    webgpu.invalidReason,
    REFRESH_COST_WEBGPU_GPU_UNAVAILABLE_REASON,
  );
  assert.equal(webgpu.wallClockRole, "bound");
  assert.equal(webgpu.wallMsDelta, 4000);
});

test("I16 a negative GPU differential is INVALID with the exact reason", () => {
  const cost = computeCost(
    costInput({
      eclipseWallMs: 9000,
      controlWallMs: 5000,
      eclipseGpuMs: 20,
      controlGpuMs: 30,
    }),
  );
  assert.equal(cost.valid, false);
  assert.equal(cost.measurementSource, "gpu-time");
  assert.equal(cost.msPerRefresh, null);
  assert.equal(cost.gpuMsDelta, -10);
  assert.equal(cost.wallMsDelta, 4000);
  assert.equal(
    cost.invalidReason,
    "the environment-refresh GPU differential is negative (30 ms control vs 20 ms eclipse over the same 801 frames) — no per-refresh cost can be attributed to the submitted refreshes",
  );
});

test("I17 the whole-refresh GPU pass set and protocol version are literal", () => {
  assert.equal(REFRESH_COST_PROTOCOL_VERSION, 4);
  assert.deepEqual(REFRESH_COST_GPU_TIME_PROTOCOL.passNames, [
    "DynEnvMap Sky Fill",
    "DynEnvMap IBL Irradiance",
    "DynEnvMap IBL Radiance Prefilter",
    "DynEnvMap SH Projection",
    "DynEnvMap Temporal Blend",
  ]);
  assert.equal(REFRESH_COST_GPU_TIME_PROTOCOL.scope, "whole-refresh");
});

test("I18 MUTANT an inert GPU-preference branch cannot silently select wall clock", async () => {
  const gateSource = fs.readFileSync(
    path.join(here, "lib", "eclipse-cloud-response-gate.mjs"),
    "utf8",
  );
  const branch = "if (gpuTime.valid) {";
  assert.equal(gateSource.split(branch).length - 1, 1);
  const mutantSource = gateSource.replace(
    branch,
    "if (false && gpuTime.valid) {",
  );
  const mutantModule = await import(
    `data:text/javascript;base64,${Buffer.from(mutantSource).toString("base64")}`
  );
  const accounting = costInput({
    backend: "webgl",
    gpuAvailable: true,
    eclipseWallMs: 9000,
    controlWallMs: 5000,
    eclipseGpuMs: 274,
    controlGpuMs: 0,
  });
  const healthy = computeCost(accounting);
  const mutant = computeCost(accounting, mutantModule.computeRefreshCost);
  assert.equal(healthy.measurementSource, "gpu-time");
  assert.equal(healthy.msPerRefresh, 1);
  assert.equal(mutant.measurementSource, "wall-clock-fallback");
  assert.equal(mutant.msPerRefresh, 4000 / 274);
  assert.throws(() => {
    assert.equal(mutant.measurementSource, "gpu-time");
    assert.equal(mutant.msPerRefresh, 1);
  }, /actual.*wall-clock-fallback|wall-clock-fallback.*gpu-time/is);
});

test("I19 MUTATION per-pass sample cardinality must equal submitted refreshes", () => {
  const accounting = costInput();
  const segment = accounting.segments.find(
    (candidate) => candidate.gpuTime.valid && candidate.fills > 1,
  );
  assert.ok(segment);
  const passName = MANDATORY_REFRESH_COST_GPU_PASS_NAMES[1];
  segment.gpuTime.samplesMsByPass[passName].pop();

  const cost = computeCost(accounting);
  assert.equal(cost.valid, false);
  assert.equal(cost.msPerRefresh, null);
  assert.equal(
    cost.invalidReason,
    `refresh-cost pair ${segment.pairIndex} ${segment.leg} GPU pass ${passName} retained ${segment.gpuTime.samplesMsByPass[passName].length} sample(s) for ${segment.refreshes} environment refresh(es) submitted (${segment.fills} eclipse-driven fill(s))`,
  );
});

test("I20 MUTATION an all-zero GPU differential at an undeclared resolution is a bound, not a figure", () => {
  const accounting = costInput();
  const gpuSegments = accounting.segments.filter(
    (candidate) => candidate.gpuTime.valid,
  );
  assert.ok(gpuSegments.length > 0);
  for (const segment of gpuSegments) {
    assert.equal(segment.gpuTime.resolutionKnown, false);
    for (const passName of Object.keys(segment.gpuTime.samplesMsByPass)) {
      segment.gpuTime.samplesMsByPass[passName] =
        segment.gpuTime.samplesMsByPass[passName].map(() => 0);
    }
    syncGpuSegmentSamplesFromPasses(segment);
  }
  syncCostAggregatesFromSegments(accounting);

  const cost = computeCost(accounting);
  assert.equal(cost.valid, false);
  assert.equal(cost.msPerRefresh, null);
  assert.match(
    cost.invalidReason,
    /is exactly 0 ms over \d+ submitted refreshes at an undeclared timestamp resolution/,
  );
  assert.equal(REFRESH_COST_GPU_TIME_PROTOCOL.scope, "whole-refresh");
  assert.match(
    REFRESH_COST_GPU_TIME_PROTOCOL.scopeNote,
    /every compute pass the refresh encodes/,
  );
  assert.match(REFRESH_COST_GPU_TIME_PROTOCOL.scopeNote, /temporal-blend pass/);
  assert.doesNotMatch(REFRESH_COST_GPU_TIME_PROTOCOL.scopeNote, /LOWER BOUND/);
});

// D1-D4 exist because the pre-segment drain check refused pair 0 eclipse of the
// depth-8 run while the drain it refused was published NOWHERE, so the artifact
// could not say which of its three conditions had fired. The reading that an
// EMPTY drain was being refused is wrong, and these teeth pin why: an empty
// drain closes every counter below, so it was already admissible. Relaxing the
// predicate would have changed nothing and left a real signal unexplained.

test("D1 an empty or successful drain is admissible; a stalled or abandoned one is not", () => {
  const clean = { drained: 0, undrained: 0, abandoned: 0, timedOut: false };

  // The two CLEAN shapes. "Nothing to drain" and "drained successfully" differ
  // only in `drained`, which is retained and deliberately not an expectation.
  assert.equal(describeRefreshCostDrainClosure(clean), "");
  assert.equal(describeRefreshCostDrainClosure({ ...clean, drained: 12 }), "");

  // The three DIRTY shapes, each naming the counter that distinguishes it.
  assert.equal(
    describeRefreshCostDrainClosure({ ...clean, undrained: 2, timedOut: true }),
    "timedOut=true, undrained=2",
  );
  assert.equal(
    describeRefreshCostDrainClosure({ ...clean, abandoned: 3 }),
    "abandoned=3",
  );
  assert.equal(describeRefreshCostDrainClosure(null), "drain absent");

  // Executed through the real fold, not asserted against source text.
  const foldWithPreDrain = (preDrain) => {
    const accounting = setMandatoryPassCostsPerRefresh(
      costInput(),
      [1, 2, 3, 4],
    );
    const segment = accounting.segments.find(
      (candidate) => candidate.gpuTime.valid,
    );
    assert.ok(segment);
    segment.gpuTime.preDrain = preDrain;
    return computeCost(accounting);
  };

  assert.equal(
    foldWithPreDrain(clean).valid,
    true,
    "an empty drain closes every counter and must remain admissible",
  );
  assert.equal(
    foldWithPreDrain({ ...clean, drained: 12 }).valid,
    true,
    "a drain that recovered work must be admissible",
  );

  const stalled = foldWithPreDrain({
    ...clean,
    undrained: 2,
    timedOut: true,
  });
  assert.equal(stalled.valid, false);
  assert.equal(stalled.msPerRefresh, null);
  assert.match(
    stalled.invalidReason,
    /pre-segment GPU readback drain did not close \(timedOut=true, undrained=2\)/,
  );

  const abandoned = foldWithPreDrain({ ...clean, abandoned: 3 });
  assert.equal(abandoned.valid, false);
  assert.match(
    abandoned.invalidReason,
    /pre-segment GPU readback drain did not close \(abandoned=3\)/,
  );

  // Absent evidence is a FAILURE, not a skip. The shipped depth-8 artifact
  // retained no pre-segment drain at all, which is the state that made its
  // refusal impossible to re-derive.
  const absent = foldWithPreDrain(null);
  assert.equal(absent.valid, false);
  assert.match(
    absent.invalidReason,
    /pre-segment GPU readback drain did not close \(drain absent\)/,
  );
});

test("D2 the measured drain is refused by the same describer, naming its counter", () => {
  const accounting = setMandatoryPassCostsPerRefresh(costInput(), [1, 2, 3, 4]);
  const segment = accounting.segments.find(
    (candidate) => candidate.gpuTime.valid,
  );
  assert.ok(segment);
  segment.gpuTime.drain = {
    drained: 4,
    undrained: 1,
    abandoned: 0,
    timedOut: false,
  };
  const cost = computeCost(accounting);
  assert.equal(cost.valid, false);
  assert.match(
    cost.invalidReason,
    /measured GPU readback drain did not close \(undrained=1\)/,
  );
});

test("D3 the drain check is REACHED, and its table is load-bearing both ways", async () => {
  const gateSource = fs
    .readFileSync(
      path.join(here, "lib", "eclipse-cloud-response-gate.mjs"),
      "utf8",
    )
    .replace(/\r\n/g, "\n");

  const withStalledPreDrain = () => {
    const accounting = setMandatoryPassCostsPerRefresh(
      costInput(),
      [1, 2, 3, 4],
    );
    const segment = accounting.segments.find(
      (candidate) => candidate.gpuTime.valid,
    );
    assert.ok(segment);
    segment.gpuTime.preDrain = {
      drained: 0,
      undrained: 2,
      abandoned: 0,
      timedOut: true,
    };
    return accounting;
  };
  assert.equal(computeCost(withStalledPreDrain()).valid, false);

  // INERTNESS MUTANT: leave the code present but make the branch unreachable.
  // Deleting the check is the easy mutation and a source-shaped tooth would
  // survive it; this one only passes if the branch actually runs.
  const guard = 'if (preDrainOffenders !== "") {';
  assert.equal(gateSource.split(guard).length - 1, 1);
  const inert = await import(
    `data:text/javascript;base64,${Buffer.from(
      gateSource.replace(guard, 'if (false && preDrainOffenders !== "") {'),
    ).toString("base64")}`
  );
  assert.equal(
    computeCost(withStalledPreDrain(), inert.computeRefreshCost).valid,
    true,
    "an inert pre-drain branch must let a stalled drain through — if this still refuses, the tooth is not reaching the branch it claims to test",
  );

  // ROW MUTANT: dropping a row must remove that counter from the message AND
  // from the detection, not from only one of the two.
  const abandonedRow =
    '  Object.freeze({ counter: "abandoned", closed: 0 }),\n';
  assert.equal(gateSource.split(abandonedRow).length - 1, 1);
  const rowless = await import(
    `data:text/javascript;base64,${Buffer.from(
      gateSource.replace(abandonedRow, ""),
    ).toString("base64")}`
  );
  assert.equal(
    rowless.REFRESH_COST_DRAIN_EXPECTATIONS.length,
    REFRESH_COST_DRAIN_EXPECTATIONS.length - 1,
  );
  assert.equal(
    rowless.describeRefreshCostDrainClosure({
      drained: 0,
      undrained: 0,
      abandoned: 3,
      timedOut: false,
    }),
    "",
    "dropping the row must drop detection of that counter, not just its name",
  );
});

test("D4 the probe embeds the canonical drain describer, and drift is caught", () => {
  const probe = fs
    .readFileSync(path.join(here, "probe-eclipse-cloud-response.mjs"), "utf8")
    .replace(/\r\n/g, "\n");
  assert.deepEqual(checkEmbeddedDrainClosureIsCanonical(probe), []);
  assert.equal(
    extractEmbeddedDrainClosure(probe),
    REFRESH_COST_DRAIN_CLOSURE_SOURCE,
  );

  const drifted = probe.replace(
    "    ({ counter, closed }) => !Object.is(drain[counter], closed),",
    "    ({ counter, closed }) => !Object.is(drain[counter], closed) && false,",
  );
  assert.notEqual(drifted, probe);
  assert.deepEqual(checkEmbeddedDrainClosureIsCanonical(drifted), [
    "the embedded drain-closure block has DRIFTED from " +
      "lib/eclipse-cloud-response-gate.mjs — re-copy it rather than editing " +
      "the probe's copy",
  ]);
});

test("I21 every mandatory pass is summed into each per-refresh GPU figure", () => {
  const accounting = setMandatoryPassCostsPerRefresh(costInput(), [1, 2, 3, 4]);
  const sampledSegment = accounting.segments.find(
    (segment) => segment.gpuTime.valid && segment.fills > 0,
  );
  assert.ok(sampledSegment);
  assert.deepEqual(
    MANDATORY_REFRESH_COST_GPU_PASS_NAMES.map(
      (passName) => sampledSegment.gpuTime.samplesMsByPass[passName][0],
    ),
    [1, 2, 3, 4],
  );
  assert.equal(sampledSegment.gpuTime.samplesMs[0], 10);

  const cost = computeCost(accounting);
  assert.equal(cost.valid, true);
  assert.equal(cost.measurementSource, "gpu-time");
  assert.equal(cost.msPerRefresh, 10);
  assert.equal(cost.eclipseGpuMs, accounting.eclipseRefreshes * 10);
  assert.equal(cost.controlGpuMs, accounting.controlRefreshes * 10);
});

test("I22 a submitted refresh missing one mandatory pass is INVALID", () => {
  const accounting = setMandatoryPassCostsPerRefresh(
    costInput({ eclipseFills: REFRESH_COST_SEGMENTS_PER_LEG, controlFills: 0 }),
    [1, 2, 3, 4],
  );
  const segment = accounting.segments.find(
    (candidate) => candidate.gpuTime.valid && candidate.fills === 1,
  );
  assert.ok(segment);
  const missingPassName = MANDATORY_REFRESH_COST_GPU_PASS_NAMES[2];
  delete segment.gpuTime.samplesMsByPass[missingPassName];
  syncGpuSegmentSamplesFromPasses(segment);
  syncCostAggregatesFromSegments(accounting);

  const cost = computeCost(accounting);
  assert.equal(cost.valid, false);
  assert.equal(cost.msPerRefresh, null);
  assert.equal(
    cost.invalidReason,
    `refresh-cost pair ${segment.pairIndex} ${segment.leg} is missing mandatory GPU pass ${missingPassName} for 1 environment refresh(es) submitted (1 eclipse-driven fill(s))`,
  );
});

test("I23 the conditional temporal-blend pass may be absent everywhere", () => {
  const accounting = costInput();
  for (const segment of accounting.segments) {
    assert.equal(
      Object.hasOwn(
        segment.gpuTime.samplesMsByPass,
        OPTIONAL_REFRESH_COST_GPU_PASS_NAME,
      ),
      false,
    );
  }

  const cost = computeCost(accounting);
  assert.equal(cost.valid, true);
  assert.equal(cost.measurementSource, "gpu-time");
});

test("I24 a v2 refresh-cost report is rejected loudly", () => {
  const accounting = costInput();
  accounting.protocol.version = 2;
  const cost = computeCost(accounting);
  assert.equal(cost.valid, false);
  assert.equal(cost.invalidReason, "refresh-cost protocol version 2 is not 4");
});

test("I25 MUTANT a sky-only summation cannot impersonate whole-refresh GPU time", async () => {
  const gateSource = fs.readFileSync(
    path.join(here, "lib", "eclipse-cloud-response-gate.mjs"),
    "utf8",
  );
  const summation = "const summedPassNames = Object.keys(samplesMsByPass);";
  assert.equal(gateSource.split(summation).length - 1, 1);
  const mutantSource = gateSource.replace(
    summation,
    "const summedPassNames = Object.keys(samplesMsByPass).slice(0, 1);",
  );
  const mutantModule = await import(
    `data:text/javascript;base64,${Buffer.from(mutantSource).toString("base64")}`
  );
  const accounting = setMandatoryPassCostsPerRefresh(costInput(), [1, 2, 3, 4]);
  const healthy = computeCost(accounting);
  const mutant = computeCost(accounting, mutantModule.computeRefreshCost);
  assert.equal(healthy.valid, true);
  assert.equal(healthy.msPerRefresh, 10);
  assert.equal(mutant.valid, false);
  assert.match(
    mutant.invalidReason,
    /whole-refresh sample \d+ does not equal its retained per-pass sum/,
  );
  assert.throws(() => {
    assert.equal(mutant.valid, true);
    assert.equal(mutant.msPerRefresh, 10);
  }, /false !== true|actual.*false.*expected.*true/is);
});

test("I26 MUTANT an inert mandatory-label guard is caught", async () => {
  const gateSource = fs.readFileSync(
    path.join(here, "lib", "eclipse-cloud-response-gate.mjs"),
    "utf8",
  );
  const guard = "if (missingMandatoryLabel) {";
  assert.equal(gateSource.split(guard).length - 1, 1);
  const mutantSource = gateSource.replace(
    guard,
    "if (false && missingMandatoryLabel) {",
  );
  const mutantModule = await import(
    `data:text/javascript;base64,${Buffer.from(mutantSource).toString("base64")}`
  );
  const accounting = setMandatoryPassCostsPerRefresh(
    costInput({ eclipseFills: REFRESH_COST_SEGMENTS_PER_LEG, controlFills: 0 }),
    [1, 2, 3, 4],
  );
  const segment = accounting.segments.find(
    (candidate) => candidate.gpuTime.valid && candidate.fills === 1,
  );
  assert.ok(segment);
  const missingPassName = MANDATORY_REFRESH_COST_GPU_PASS_NAMES[2];
  delete segment.gpuTime.samplesMsByPass[missingPassName];
  syncGpuSegmentSamplesFromPasses(segment);
  syncCostAggregatesFromSegments(accounting);

  const healthy = computeCost(accounting);
  const mutant = computeCost(accounting, mutantModule.computeRefreshCost);
  assert.equal(healthy.valid, false);
  assert.equal(
    healthy.invalidReason,
    `refresh-cost pair ${segment.pairIndex} ${segment.leg} is missing mandatory GPU pass ${missingPassName} for 1 environment refresh(es) submitted (1 eclipse-driven fill(s))`,
  );
  assert.equal(mutant.valid, true);
  assert.throws(() => {
    assert.equal(mutant.valid, false);
  }, /true !== false|actual.*true.*expected.*false/is);
});

test("I27 submitted-refresh cardinality contributes the complete GPU total", () => {
  const accounting = costInput({
    eclipseWallMs: 1000,
    controlWallMs: 100,
    eclipseGpuMs: 1000,
    controlGpuMs: 100,
    eclipseFills: 10,
    controlFills: 0,
    eclipseRefreshes: 12,
    controlRefreshes: 3,
  });
  for (const segment of accounting.segments) {
    for (const samples of Object.values(segment.gpuTime.samplesMsByPass)) {
      assert.equal(samples.length, segment.refreshes);
    }
  }

  const cost = computeCost(accounting);
  assert.equal(cost.valid, true);
  assert.equal(cost.eclipseGpuMs, 1000);
  assert.equal(cost.controlGpuMs, 100);
  assert.equal(cost.eclipseRefreshes, 12);
  assert.equal(cost.controlRefreshes, 3);
  assert.equal(cost.fillDelta, 10);
  assert.equal(cost.refreshDelta, 9);
  assert.equal(cost.gpuMsPerRefresh, 100);
  assert.equal(cost.wallMsPerRefresh, 100);
  assert.equal(cost.msPerRefresh, 100);
});

test("I28 a surplus sample on a zero-submission frame invalidates its named segment", async () => {
  const accounting = costInput({ controlFills: 0, controlRefreshes: 0 });
  const segment = accounting.segments.find(
    (candidate) => candidate.pairIndex === 0 && candidate.leg === "control",
  );
  const passName = MANDATORY_REFRESH_COST_GPU_PASS_NAMES[0];
  assert.equal(segment.refreshes, 0);
  assert.ok(segment.refreshSubmissions.every((submitted) => submitted === 0));
  segment.gpuTime.samplesMsByPass = { [passName]: [1] };

  const expected = `refresh-cost pair 0 control GPU pass ${passName} retained 1 sample(s) for 0 environment refresh(es) submitted (0 eclipse-driven fill(s))`;
  const healthy = computeCost(accounting);
  assert.equal(healthy.valid, false);
  assert.equal(healthy.invalidReason, expected);

  const gateSource = fs.readFileSync(
    path.join(here, "lib", "eclipse-cloud-response-gate.mjs"),
    "utf8",
  );
  const cardinality = "passSamples.length !== refreshes";
  assert.equal(gateSource.split(cardinality).length - 1, 1);
  const mutantSource = gateSource.replace(
    cardinality,
    "passSamples.length < refreshes",
  );
  const mutantModule = await import(
    `data:text/javascript;base64,${Buffer.from(mutantSource).toString("base64")}`
  );
  const mutant = computeCost(accounting, mutantModule.computeRefreshCost);
  assert.equal(mutant.valid, true);
  assert.throws(() => assert.equal(mutant.invalidReason, expected));
});

test("I29 a submitted refresh with no retained pass sample is invalid", () => {
  const accounting = costInput({
    eclipseFills: 456,
    controlFills: 0,
    eclipseRefreshes: 456,
    controlRefreshes: 0,
  });
  const segment = accounting.segments.find(
    (candidate) => candidate.pairIndex === 3 && candidate.leg === "eclipse",
  );
  assert.equal(segment.fills, 57);
  assert.equal(segment.refreshes, 57);
  segment.gpuTime.samplesMsByPass = Object.fromEntries(
    MANDATORY_REFRESH_COST_GPU_PASS_NAMES.map((passName) => [
      passName,
      Array(48).fill(1),
    ]),
  );
  segment.gpuTime.samplesMs = Array(48).fill(4);
  segment.gpuTime.totalMs = 48 * 4;
  segment.gpuTime.results.readbackSkipCount = 14;
  segment.gpuTime.results.frameCount = 86;
  syncCostAggregatesFromSegments(accounting);

  const cost = computeCost(accounting);
  assert.equal(cost.valid, false);
  assert.equal(
    cost.invalidReason,
    `refresh-cost pair 3 eclipse GPU pass ${MANDATORY_REFRESH_COST_GPU_PASS_NAMES[0]} retained 48 sample(s) for 57 environment refresh(es) submitted (57 eclipse-driven fill(s))`,
  );
});

test("I30 frame telemetry binds one refresh read to each consecutive render", () => {
  const accounting = costInput();
  const segment = accounting.segments.find(
    (candidate) => candidate.pairIndex === 2 && candidate.leg === "eclipse",
  );
  const previousFrameId = segment.refreshFrameIds[0];
  segment.refreshFrameIds[1] += 1;
  const skippedFrameId = segment.refreshFrameIds[1];

  const cost = computeCost(accounting);
  assert.equal(cost.valid, false);
  assert.equal(
    cost.invalidReason,
    `pair 2 eclipse: environment refresh telemetry frameId ${skippedFrameId} did not advance exactly once from ${previousFrameId}`,
  );
});

test("I31 submitted-refresh delta is the denominator on both backends", async () => {
  const options = {
    eclipseWallMs: 1000,
    controlWallMs: 100,
    eclipseGpuMs: 1000,
    controlGpuMs: 100,
    eclipseFills: 10,
    controlFills: 0,
    eclipseRefreshes: 12,
    controlRefreshes: 3,
  };
  const webgpuAccounting = costInput(options);
  const webglAccounting = costInput({ ...options, backend: "webgl" });
  const webgpu = computeCost(webgpuAccounting);
  const webgl = computeCost(webglAccounting);
  assert.equal(webgpu.fillDelta, 10);
  assert.equal(webgpu.refreshDelta, 9);
  assert.equal(webgpu.gpuMsPerRefresh, 100);
  assert.equal(webgpu.wallMsPerRefresh, 100);
  assert.equal(webgpu.msPerRefresh, 100);
  assert.equal(webgl.refreshDelta, 9);
  assert.equal(webgl.wallMsPerRefresh, 100);
  assert.equal(webgl.msPerRefresh, 100);

  const noControlRefreshes = computeCost(
    costInput({ ...options, backend: "webgl", controlRefreshes: 0 }),
  );
  assert.equal(noControlRefreshes.refreshDelta, 12);
  assert.equal(noControlRefreshes.msPerRefresh, 75);
  assert.ok(webgl.msPerRefresh > noControlRefreshes.msPerRefresh);

  const gateSource = fs.readFileSync(
    path.join(here, "lib", "eclipse-cloud-response-gate.mjs"),
    "utf8",
  );
  const denominator = "/ refreshDelta";
  assert.equal(gateSource.split(denominator).length - 1, 2);
  const mutantSource = gateSource.replaceAll(denominator, "/ fillDelta");
  const mutantModule = await import(
    `data:text/javascript;base64,${Buffer.from(mutantSource).toString("base64")}`
  );
  const mutantWebgpu = computeCost(
    webgpuAccounting,
    mutantModule.computeRefreshCost,
  );
  const mutantWebgl = computeCost(
    webglAccounting,
    mutantModule.computeRefreshCost,
  );
  assert.equal(mutantWebgpu.gpuMsPerRefresh, 90);
  assert.equal(mutantWebgpu.wallMsPerRefresh, 90);
  assert.equal(mutantWebgpu.msPerRefresh, 90);
  assert.equal(mutantWebgl.wallMsPerRefresh, 90);
  assert.equal(mutantWebgl.msPerRefresh, 90);
  assert.throws(() => assert.equal(mutantWebgpu.msPerRefresh, 100));
  assert.throws(() => assert.equal(mutantWebgl.msPerRefresh, 100));
});

test("I32 declared refresh aggregates cannot override retained segment totals", () => {
  for (const field of ["eclipseRefreshes", "controlRefreshes"]) {
    const accounting = costInput();
    const retained = accounting[field];
    accounting[field] += 1;
    const cost = computeCost(accounting);
    assert.equal(cost.valid, false);
    assert.equal(
      cost.invalidReason,
      `declared refresh-cost aggregate ${field}=${retained + 1} does not equal the retained segment total ${retained}`,
    );
  }
});

test("I32b a declared segment count its own per-frame telemetry does not support is INVALID", async () => {
  // The gate re-derives the count from the retained per-frame reads instead of
  // trusting the segment's own `refreshes` field. Without that cross-check a
  // probe could declare any denominator it liked, which is the whole defect
  // this lane exists to close, one level up.
  const accounting = costInput();
  const segment = accounting.segments.find(
    (candidate) => candidate.pairIndex === 2 && candidate.leg === "eclipse",
  );
  const declared = segment.refreshes;
  const supported = segment.refreshSubmissions.reduce(
    (total, submitted) => total + submitted,
    0,
  );
  assert.equal(supported, declared);
  segment.refreshSubmissions = spreadIntegerTotal(declared - 1, segment.frames);

  const cost = computeCost(accounting);
  assert.equal(cost.valid, false);
  assert.equal(cost.msPerRefresh, null);
  assert.equal(
    cost.invalidReason,
    `refresh-cost pair 2 eclipse retained ${declared - 1} submitted refresh(es) in per-frame telemetry but declared ${declared}`,
  );

  // INERTNESS: make the cross-check unreachable rather than deleting it. A
  // spec that survives that is asserting text, not a live branch.
  const gateSource = fs.readFileSync(
    path.join(here, "lib", "eclipse-cloud-response-gate.mjs"),
    "utf8",
  );
  const crossCheck = "submittedTotal !== segment.refreshes";
  assert.equal(gateSource.split(crossCheck).length - 1, 1);
  const mutantSource = gateSource.replace(crossCheck, `false && ${crossCheck}`);
  const mutantModule = await import(
    `data:text/javascript;base64,${Buffer.from(mutantSource).toString("base64")}`
  );
  const mutant = computeCost(accounting, mutantModule.computeRefreshCost);
  // With the cross-check inert the run is STILL refused — but by the aggregate
  // comparison, and the number it names is the DERIVED total, not the declared
  // one. That is the proof the declared field never becomes operative: even
  // with its guard removed there is no path on which it is the denominator.
  assert.equal(mutant.valid, false);
  assert.notEqual(mutant.invalidReason, cost.invalidReason);
  assert.equal(
    mutant.invalidReason,
    `refresh-cost pair 2 eclipse GPU pass ${MANDATORY_REFRESH_COST_GPU_PASS_NAMES[0]} retained ${declared} sample(s) for ${declared - 1} environment refresh(es) submitted (${segment.fills} eclipse-driven fill(s))`,
    "the DERIVED count is what the cardinality check uses, so the declared field is unreachable even with its own guard inert",
  );
  assert.throws(() => assert.equal(mutant.invalidReason, cost.invalidReason));
});

test("I32c a ledger that did not close names every counter that tripped, with its value", async () => {
  // The behaviour, not the array: ring saturation must read as a short
  // frameCount WITH its matching readbackSkipCount, and a discarded sample must
  // read differently from a merely unprofiled frame.
  const frames = 100;
  const closed = {
    enabled: true,
    attemptedFrameCount: frames,
    frameCount: frames,
    sampleLedgerBalanced: true,
    readbackSkipCount: 0,
    failedReadbackCount: 0,
    emptyFrameCount: 0,
    lostSampleCount: 0,
    pendingReadbackCount: 0,
    unaccountedSampleCount: 0,
    invertedSampleCount: 0,
    droppedPassCount: 0,
  };
  assert.equal(describeRefreshCostLedgerClosure(closed, frames), "");

  // The real pair-3 shape from the 2026-08-24 commissioning ledger.
  const ringSaturated = { ...closed, frameCount: 86, readbackSkipCount: 14 };
  assert.equal(
    describeRefreshCostLedgerClosure(ringSaturated, frames),
    "frameCount=86, readbackSkipCount=14",
  );
  // The real pair-4 shape.
  assert.equal(
    describeRefreshCostLedgerClosure(
      { ...closed, frameCount: 63, readbackSkipCount: 37 },
      frames,
    ),
    "frameCount=63, readbackSkipCount=37",
  );
  // A discarded sample is a DIFFERENT sentence from an unprofiled frame.
  const dropped = describeRefreshCostLedgerClosure(
    { ...closed, droppedPassCount: 3 },
    frames,
  );
  assert.equal(dropped, "droppedPassCount=3");
  assert.notEqual(
    dropped,
    describeRefreshCostLedgerClosure(ringSaturated, frames),
  );
  assert.equal(
    describeRefreshCostLedgerClosure({ ...closed, lostSampleCount: 3 }, frames),
    "lostSampleCount=3",
  );

  // Every counter the renderer publishes is covered, one at a time.
  for (const {
    counter,
    closed: closedValue,
  } of REFRESH_COST_LEDGER_EXPECTATIONS) {
    const broken =
      closedValue === true ? false : closedValue === "frames" ? frames - 1 : 1;
    assert.equal(
      describeRefreshCostLedgerClosure(
        { ...closed, [counter]: broken },
        frames,
      ),
      `${counter}=${String(broken)}`,
      `${counter} must be named when it does not close`,
    );
  }
  assert.equal(REFRESH_COST_LEDGER_EXPECTATIONS.length, 12);

  // R5 INERTNESS: drop readbackSkipCount from the table. The probe derives BOTH
  // its detection and its message from this one table, so a dropped counter
  // stops being reported AND stops being detected — which is why the table is
  // here and not embedded in the probe.
  const gateSource = fs
    .readFileSync(
      path.join(here, "lib", "eclipse-cloud-response-gate.mjs"),
      "utf8",
    )
    .replace(
      new RegExp(String.fromCharCode(13, 10), "g"),
      String.fromCharCode(10),
    );
  const row =
    '  Object.freeze({ counter: "readbackSkipCount", closed: 0 }),' +
    String.fromCharCode(10);
  const mutantModule = await import(
    `data:text/javascript;base64,${Buffer.from(gateSource.replace(row, "")).toString("base64")}`
  );
  assert.equal(mutantModule.REFRESH_COST_LEDGER_EXPECTATIONS.length, 11);
  assert.equal(
    mutantModule.describeRefreshCostLedgerClosure(ringSaturated, frames),
    "frameCount=86",
    "the mutant loses the counter that explains the short frameCount",
  );
  assert.throws(() =>
    assert.equal(
      mutantModule.describeRefreshCostLedgerClosure(ringSaturated, frames),
      "frameCount=86, readbackSkipCount=14",
    ),
  );
  // And a segment whose ONLY defect is a skipped readback goes undetected.
  assert.equal(
    mutantModule.describeRefreshCostLedgerClosure(
      { ...closed, readbackSkipCount: 14 },
      frames,
    ),
    "",
  );
  assert.notEqual(
    describeRefreshCostLedgerClosure(
      { ...closed, readbackSkipCount: 14 },
      frames,
    ),
    "",
  );
});

test("I32d the probe derives both the ledger check and its message from the shared table", () => {
  const probe = fs
    .readFileSync(path.join(here, "probe-eclipse-cloud-response.mjs"), "utf8")
    .replace(
      new RegExp(String.fromCharCode(13, 10), "g"),
      String.fromCharCode(10),
    );
  // ONE call site, used as the condition and interpolated into the reason, so a
  // counter cannot be dropped from the message while still tripping the check.
  const callSite = [
    "    const ledgerOffenders = describeRefreshCostLedgerClosure(",
    "      results,",
    "      to - from,",
    "    );",
  ].join(String.fromCharCode(10));
  assert.equal(probe.split(callSite).length - 1, 1);
  assert.ok(probe.includes('if (ledgerOffenders !== "") {'));
  assert.ok(
    probe.includes(
      "did not close over ${to - from} measured frames (${ledgerOffenders})",
    ),
  );
  // The hand-written disjunction it replaced must not come back.
  assert.ok(!probe.includes("results.readbackSkipCount !== 0 ||"));
  // The call site is inside a `page.evaluate` callback, so the describer must
  // NOT arrive as a Node import — the closure is dropped by the serialization
  // and the call would raise ReferenceError before any measurement exists.
  assert.ok(
    !probe.includes(
      `  describeRefreshCostLedgerClosure,${String.fromCharCode(10)}`,
    ),
    "the probe must not import a symbol it calls inside page.evaluate",
  );
  // It reaches the page as the embedded canonical block instead, and that
  // block is generated from the same twelve-row table, so the single-source
  // property the rest of this test pins survives the move in-page.
  assert.deepEqual(checkEmbeddedLedgerClosureIsCanonical(probe), []);
  assert.equal(
    extractEmbeddedLedgerClosure(probe),
    REFRESH_COST_LEDGER_CLOSURE_SOURCE,
  );
});

function readEclipseCloudProbeForPageContract() {
  return fs
    .readFileSync(path.join(here, "probe-eclipse-cloud-response.mjs"), "utf8")
    .replace(/\r\n/g, "\n");
}

function extractShippedPageLedgerClosure(probeSource) {
  const callbackStart = "const RUN_IBL_SWEEP = async (cfg) => {";
  const callbackEnd = "\nasync function openPage(";
  assert.equal(
    probeSource.split(callbackStart).length - 1,
    1,
    "the probe must define exactly one RUN_IBL_SWEEP callback",
  );
  assert.ok(
    probeSource.includes("page.evaluate(RUN_IBL_SWEEP,"),
    "RUN_IBL_SWEEP must be the callback shipped through page.evaluate",
  );
  for (const marker of [
    REFRESH_COST_LEDGER_CLOSURE_BEGIN,
    REFRESH_COST_LEDGER_CLOSURE_END,
  ]) {
    assert.equal(
      probeSource.split(marker).length - 1,
      1,
      `the probe must contain exactly one ${marker} marker`,
    );
  }

  const start = probeSource.indexOf(callbackStart);
  const end = probeSource.indexOf(callbackEnd, start);
  assert.ok(
    end > start,
    "the RUN_IBL_SWEEP callback must have a bounded source slice",
  );
  const embedded = extractEmbeddedLedgerClosure(probeSource.slice(start, end));
  assert.notEqual(
    embedded,
    null,
    "the probe must ship an extractable ledger-closure block into page scope",
  );
  return embedded;
}

function compilePageLedgerClosureSource(embeddedSource) {
  const pageGlobal = {};
  const pageRealm = vm.createContext(pageGlobal);
  assert.equal(Object.getPrototypeOf(pageGlobal), Object.prototype);
  assert.deepEqual(
    Object.keys(pageGlobal),
    [],
    "the page realm must start from a bare object",
  );
  assert.equal(
    vm.runInContext("typeof Object", pageRealm),
    "function",
    "the isolated context must still be a functioning JavaScript realm",
  );
  for (const binding of [
    "require",
    "module",
    "exports",
    "process",
    "Buffer",
    "assert",
    "fs",
    "path",
    "test",
    "vm",
    "checkEmbeddedLedgerClosureIsCanonical",
    "REFRESH_COST_LEDGER_CLOSURE_SOURCE",
    "REFRESH_COST_LEDGER_EXPECTATIONS",
    "describeRefreshCostLedgerClosure",
  ]) {
    assert.equal(
      vm.runInContext(`typeof ${binding}`, pageRealm),
      "undefined",
      `the bare page realm must not inherit ${binding}`,
    );
  }

  const runtime = vm.runInContext(
    `${embeddedSource}\n({\n` +
      "  describe:\n" +
      '    typeof describeRefreshCostLedgerClosure === "function"\n' +
      "      ? describeRefreshCostLedgerClosure\n" +
      "      : undefined,\n" +
      "  expectationCount:\n" +
      '    typeof REFRESH_COST_LEDGER_EXPECTATIONS === "object"\n' +
      "      ? REFRESH_COST_LEDGER_EXPECTATIONS.length\n" +
      "      : null,\n" +
      "});",
    pageRealm,
    {
      filename: "probe-eclipse-cloud-response.mjs#refresh-cost-ledger-closure",
    },
  );
  assert.equal(
    typeof runtime.describe,
    "function",
    "the probe's embedded ledger describer must become callable in an otherwise bare page realm",
  );
  return runtime;
}

function closedRefreshCostLedger(expectations, frames) {
  return Object.fromEntries(
    expectations.map(({ counter, closed }) => [
      counter,
      closed === "frames" ? frames : closed,
    ]),
  );
}

function openRefreshCostLedgerValue(closed, frames) {
  const expected = closed === "frames" ? frames : closed;
  if (typeof expected === "boolean") {
    return !expected;
  }
  if (typeof expected === "number") {
    return expected + 1;
  }
  return `not-${String(expected)}`;
}

function assertPageLedgerClosureMatrix(
  pageDescribe,
  expectations,
  nodeDescribe,
  frames,
) {
  const closed = closedRefreshCostLedger(expectations, frames);
  const pageClosed = pageDescribe(closed, frames);
  assert.equal(pageClosed, nodeDescribe(closed, frames));
  assert.equal(
    pageClosed,
    "",
    "an all-closed page ledger must return empty text",
  );

  const pageAbsent = pageDescribe(42, frames);
  assert.equal(pageAbsent, nodeDescribe(42, frames));
  assert.equal(
    pageAbsent,
    "results absent",
    "a non-object page ledger must name the absent results",
  );

  for (const { counter, closed: closedValue } of expectations) {
    const broken = openRefreshCostLedgerValue(closedValue, frames);
    const results = { ...closed, [counter]: broken };
    const pageReason = pageDescribe(results, frames);
    assert.equal(
      pageReason,
      nodeDescribe(results, frames),
      `the page describer must match the Node describer for ${counter}`,
    );
    assert.equal(
      pageReason,
      `${counter}=${String(broken)}`,
      `${counter} must be named with its value in page scope`,
    );
  }
  return closed;
}

function assertShippedPageLedgerContract(probeSource) {
  const runtime = compilePageLedgerClosureSource(
    extractShippedPageLedgerClosure(probeSource),
  );
  const closed = assertPageLedgerClosureMatrix(
    runtime.describe,
    REFRESH_COST_LEDGER_EXPECTATIONS,
    describeRefreshCostLedgerClosure,
    100,
  );
  const canonicalFailures = checkEmbeddedLedgerClosureIsCanonical(probeSource);
  assert.deepEqual(
    canonicalFailures,
    [],
    canonicalFailures.join("\n") ||
      "the probe's in-page ledger closure must stay canonical",
  );
  return { closed, runtime };
}

test("I32e the shipped ledger describer runs in a bare page realm and matches every Node reason", () => {
  const probe = readEclipseCloudProbeForPageContract();
  const { closed, runtime } = assertShippedPageLedgerContract(probe);
  assert.equal(
    runtime.expectationCount,
    REFRESH_COST_LEDGER_EXPECTATIONS.length,
  );

  for (const [overrides, expected] of [
    [
      { frameCount: 86, readbackSkipCount: 14 },
      "frameCount=86, readbackSkipCount=14",
    ],
    [
      { frameCount: 63, readbackSkipCount: 37 },
      "frameCount=63, readbackSkipCount=37",
    ],
  ]) {
    const results = { ...closed, ...overrides };
    assert.equal(
      runtime.describe(results, 100),
      describeRefreshCostLedgerClosure(results, 100),
    );
    assert.equal(runtime.describe(results, 100), expected);
  }
});

test("I32f an unreachable in-page ledger block turns the page contract red", () => {
  const probe = readEclipseCloudProbeForPageContract();
  const begin = `  ${REFRESH_COST_LEDGER_CLOSURE_BEGIN}\n`;
  const end = `  ${REFRESH_COST_LEDGER_CLOSURE_END}`;
  assert.equal(probe.split(begin).length - 1, 1);
  assert.equal(probe.split(end).length - 1, 1);
  const originalEmbedded = extractShippedPageLedgerClosure(probe);
  const inertProbe = probe
    .replace(begin, `${begin}  if (false) {\n`)
    .replace(end, `  }\n${end}`);
  assert.notEqual(inertProbe, probe);
  assert.ok(
    extractShippedPageLedgerClosure(inertProbe).includes(originalEmbedded),
    "the inertness mutant must retain the complete shipped block",
  );
  assert.throws(
    () => assertShippedPageLedgerContract(inertProbe),
    {
      code: "ERR_ASSERTION",
      message:
        /the probe's embedded ledger describer must become callable in an otherwise bare page realm/,
    },
    "making the shipped block unreachable must turn the page contract red",
  );
});

test("I32g page-table generation binds canonicality, detection, and message", async () => {
  const probe = readEclipseCloudProbeForPageContract();
  const readbackExpectation = REFRESH_COST_LEDGER_EXPECTATIONS.find(
    ({ counter }) => counter === "readbackSkipCount",
  );
  assert.deepEqual(readbackExpectation, {
    counter: "readbackSkipCount",
    closed: 0,
  });
  const pageRow =
    `    { counter: ${JSON.stringify(readbackExpectation.counter)}, ` +
    `closed: ${JSON.stringify(readbackExpectation.closed)} },\n`;
  assert.equal(probe.split(pageRow).length - 1, 1);
  const rowlessProbe = probe.replace(pageRow, "");
  assert.equal(rowlessProbe.length, probe.length - pageRow.length);
  const canonicalDrift =
    "the embedded ledger-closure block has DRIFTED from " +
    "lib/eclipse-cloud-response-gate.mjs — re-copy it rather than editing " +
    "the probe's copy";
  assert.deepEqual(checkEmbeddedLedgerClosureIsCanonical(rowlessProbe), [
    canonicalDrift,
  ]);

  const rowlessRuntime = compilePageLedgerClosureSource(
    extractShippedPageLedgerClosure(rowlessProbe),
  );
  const closed = closedRefreshCostLedger(REFRESH_COST_LEDGER_EXPECTATIONS, 100);
  assert.equal(
    rowlessRuntime.describe(
      { ...closed, frameCount: 86, readbackSkipCount: 14 },
      100,
    ),
    "frameCount=86",
    "removing one page-table row removes that counter from the message",
  );
  assert.equal(
    rowlessRuntime.describe({ ...closed, readbackSkipCount: 1 }, 100),
    "",
    "removing one page-table row also removes detection of that counter",
  );
  assert.throws(
    () => assertShippedPageLedgerContract(rowlessProbe),
    {
      code: "ERR_ASSERTION",
      message:
        /the page describer must match the Node describer for readbackSkipCount/,
    },
    "a one-row shipped-copy drift must turn the full page contract red",
  );

  const gateSource = fs
    .readFileSync(
      path.join(here, "lib", "eclipse-cloud-response-gate.mjs"),
      "utf8",
    )
    .replace(/\r\n/g, "\n");
  const gateRow =
    `  Object.freeze({ counter: ${JSON.stringify(readbackExpectation.counter)}, ` +
    `closed: ${JSON.stringify(readbackExpectation.closed)} }),\n`;
  assert.equal(gateSource.split(gateRow).length - 1, 1);
  const mutantModule = await import(
    `data:text/javascript;base64,${Buffer.from(gateSource.replace(gateRow, "")).toString("base64")}`
  );
  assert.equal(
    mutantModule.REFRESH_COST_LEDGER_EXPECTATIONS.length,
    REFRESH_COST_LEDGER_EXPECTATIONS.length - 1,
  );
  assert.equal(
    extractEmbeddedLedgerClosure(rowlessProbe),
    mutantModule.REFRESH_COST_LEDGER_CLOSURE_SOURCE,
  );
  assert.deepEqual(
    mutantModule.checkEmbeddedLedgerClosureIsCanonical(rowlessProbe),
    [],
  );
  assert.equal(
    rowlessRuntime.expectationCount,
    mutantModule.REFRESH_COST_LEDGER_EXPECTATIONS.length,
  );
  assertPageLedgerClosureMatrix(
    rowlessRuntime.describe,
    mutantModule.REFRESH_COST_LEDGER_EXPECTATIONS,
    mutantModule.describeRefreshCostLedgerClosure,
    100,
  );
  assert.equal(
    mutantModule.describeRefreshCostLedgerClosure(
      { ...closed, frameCount: 86, readbackSkipCount: 14 },
      100,
    ),
    "frameCount=86",
  );
  assert.equal(
    mutantModule.describeRefreshCostLedgerClosure(
      { ...closed, readbackSkipCount: 1 },
      100,
    ),
    "",
  );
});

test("I33 every invalid segment in the real ledger shape remains attributed", async () => {
  const rows = [
    [0, "eclipse", 101, 21, 25, 0, 101],
    [0, "control", 101, 0, 16, 0, 101],
    [1, "control", 100, 0, 9, 0, 100],
    [1, "eclipse", 100, 25, 25, 0, 100],
    [2, "eclipse", 100, 33, 33, 0, 100],
    [2, "control", 100, 0, 8, 0, 100],
    [3, "control", 100, 0, 8, 0, 100],
    [3, "eclipse", 100, 57, 48, 14, 86],
    [4, "eclipse", 100, 56, 38, 37, 63],
    [4, "control", 100, 0, 8, 0, 100],
    [5, "control", 100, 0, 8, 0, 100],
    [5, "eclipse", 100, 34, 34, 0, 100],
    [6, "eclipse", 100, 25, 25, 0, 100],
    [6, "control", 100, 0, 9, 0, 100],
    [7, "control", 100, 0, 16, 0, 100],
    [7, "eclipse", 100, 21, 25, 0, 100],
  ];
  const accounting = costInput();
  const expectedReasons = [];
  for (let index = 0; index < rows.length; index++) {
    const [pairIndex, leg, frames, fills, samples, skips, resolvedFrames] =
      rows[index];
    const segment = accounting.segments[index];
    assert.equal(segment.pairIndex, pairIndex);
    assert.equal(segment.leg, leg);
    assert.equal(segment.frames, frames);
    segment.fills = fills;
    segment.refreshes = fills;
    segment.refreshSubmissions = spreadIntegerTotal(fills, frames);
    segment.gpuTime.samplesMsByPass = Object.fromEntries(
      MANDATORY_REFRESH_COST_GPU_PASS_NAMES.map((passName) => [
        passName,
        Array(samples).fill(1),
      ]),
    );
    segment.gpuTime.results.readbackSkipCount = skips;
    segment.gpuTime.results.frameCount = resolvedFrames;
    if (samples === fills) {
      segment.gpuTime.samplesMs = Array(samples).fill(4);
      segment.gpuTime.totalMs = samples * 4;
    } else {
      const reason = `pair ${pairIndex} ${leg}: the GPU pass ledger retained ${samples} ${MANDATORY_REFRESH_COST_GPU_PASS_NAMES[0]} sample(s) for ${fills} environment refresh(es) submitted (${fills} eclipse-driven fill(s))`;
      expectedReasons.push(reason);
      segment.gpuTime.status = "invalid";
      segment.gpuTime.valid = false;
      segment.gpuTime.totalMs = null;
      segment.gpuTime.samplesMs = [];
      segment.gpuTime.invalidReason = reason;
    }
  }
  syncCostAggregatesFromSegments(accounting);
  const expected = expectedReasons.join(" | ");
  Object.assign(accounting.gpuTime, {
    status: "invalid",
    valid: false,
    eclipseMs: null,
    controlMs: null,
    invalidReason: expected,
  });

  const cost = computeCost(accounting);
  assert.equal(accounting.eclipseRefreshes, 272);
  assert.equal(accounting.controlRefreshes, 0);
  assert.equal(cost.valid, false);
  assert.equal(cost.invalidReason, expected);
  assert.deepEqual(
    expectedReasons.map((reason) => reason.match(/^pair \d+ \w+/)[0]),
    [
      "pair 0 eclipse",
      "pair 0 control",
      "pair 1 control",
      "pair 2 control",
      "pair 3 control",
      "pair 3 eclipse",
      "pair 4 eclipse",
      "pair 4 control",
      "pair 5 control",
      "pair 6 control",
      "pair 7 control",
      "pair 7 eclipse",
    ],
  );
  for (const pairIndex of [1, 2, 5, 6]) {
    assert.doesNotMatch(
      cost.invalidReason,
      new RegExp(`pair ${pairIndex} eclipse:`),
    );
  }

  const gateSource = fs.readFileSync(
    path.join(here, "lib", "eclipse-cloud-response-gate.mjs"),
    "utf8",
  );
  const accumulation = "} else if (gpuHeader.available) {";
  assert.equal(gateSource.split(accumulation).length - 1, 1);
  const mutantSource = gateSource.replace(
    accumulation,
    "} else if (gpuHeader.available && gpuMeasurementInvalidReasons.length === 0) {",
  );
  const mutantModule = await import(
    `data:text/javascript;base64,${Buffer.from(mutantSource).toString("base64")}`
  );
  const mutant = computeCost(accounting, mutantModule.computeRefreshCost);
  assert.notEqual(mutant.invalidReason, expected);
  assert.match(
    mutant.invalidReason,
    /declared aggregate GPU-time invalidReason/,
  );
  assert.throws(() => assert.equal(mutant.invalidReason, expected));
});

test("I34 settled count, control, shadow, and band contracts are unchanged", () => {
  const verdict = judgeEclipseCloudResponse(passingRun());
  assert.equal(predictedSweepRefreshCount(), 275);
  assert.equal(verdict.predictedSweepRefreshCount, 275);
  assert.equal(verdict.predictedRefreshCountExact, true);
  assert.equal(verdict.controlRefreshQuiescent, true);
  assert.equal(verdict.shadowContrastInvariant, true);
  assert.deepEqual(ECLIPSE_CLOUD_BANDS.shadowContrastRatio, {
    lo: 0.97,
    hi: 1.03,
    why: ECLIPSE_CLOUD_BANDS.shadowContrastRatio.why,
    status: "DERIVED",
  });
  assert.ok(
    ECLIPSE_CLOUD_GATE_PREDICATES.includes("predictedRefreshCountExact"),
  );
  assert.ok(ECLIPSE_CLOUD_GATE_PREDICATES.includes("controlRefreshQuiescent"));
  assert.ok(ECLIPSE_CLOUD_GATE_PREDICATES.includes("shadowContrastInvariant"));
  assert.equal(verdict.PASS, true);
  assert.equal(verdict.exitCode, ECLIPSE_CLOUD_EXIT.PASS);
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
    /cache\.lastEclipseEnvBucket = state\.eclipseEnvBucket;/,
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
  const pinning = fs
    .readFileSync(path.join(here, "lib", "weather-probe-pinning.mjs"), "utf8")
    .replace(/\r\n/g, "\n");
  const executableProbe = probe
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart();
      return !(
        trimmed.startsWith("//") ||
        trimmed.startsWith("/*") ||
        trimmed.startsWith("*")
      );
    })
    .join("\n");
  assert.match(probe, /installWeatherPinHarnessOnPage/);
  assert.match(probe, /installCloudProbeHarnessOnPage/);
  assert.match(probe, /offline=true/);
  assert.match(probe, /collectPinStructural/);
  assert.match(probe, /awaitProceduralReady/);
  assert.match(probe, /awaitGlobeReady/);
  assert.match(probe, /WEATHER_DETERMINISM_DIALS/);
  assert.match(probe, /PINNED_CLOUD_QUALITY|cloudQuality/);
  // Watchdog + close-in-finally + the 0/1/2/3 exit contract.
  assert.match(probe, /watchdog\.unref\?\.\(\)/);
  assert.match(
    probe,
    /\} finally \{\n\s*await closeActiveBrowser\("measurement finally"\)/,
  );
  assert.match(probe, /process\.exitCode = exitCode/);
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
  // The capture path is transitive through weather-probe-pinning, so scanning
  // this launcher alone would miss a helper regression. Require the helper to
  // install the canonical immutable snapshot factory, freeze before its first
  // decode await, and snapshot slots before awaiting that decode.
  assert.match(
    pinning,
    /import \{ FUSED_SNAPSHOT_CAPTURE_SOURCE \} from "\.\/same-task-capture\.mjs";/u,
  );
  assert.match(
    pinning,
    /const snapshotPromise = fused\.captureSnapshot\(\);\s*const slots = slotSnapshot\(\);\s*const \{ dataUrl, imageData \} = await snapshotPromise;/u,
  );
  assert.match(
    pinning,
    /makeFusedSnapshotCapture\(\s*\{ render: renderAt \},\s*canvas,/u,
  );
  assert.match(pinning, /png: wantPng \? dataUrl : null/u);
  assert.doesNotMatch(pinning, /\.drawImage\s*\(\s*canvas\b/u);
  assert.doesNotMatch(pinning, /\.getImageData\s*\(/u);
  assert.match(
    probe,
    /sameTaskCapturePolicy: fileURLToPath\(\s*new URL\("\.\/lib\/same-task-capture\.mjs", import\.meta\.url\),\s*\)/u,
  );

  const captureAudit = eclipseCaptureStaticFailures(probe);
  assert.deepEqual(captureAudit.failures, []);
  assert.equal(
    captureAudit.directPinCaptures,
    5,
    "every direct pin capture site stays inside the AST-enforced boundary",
  );
  assert.match(
    executableProbe,
    /const offCloudsPng = deepest \? aOffCloudsFrame\.png : null;/u,
  );
  assert.doesNotMatch(
    executableProbe,
    /pin\.capture[^\n]*\.png/u,
    "a separate documentary render would not share the metric bytes",
  );
  // Canvas-ELEMENT data, reduced in-page, never a page screenshot.
  assert.ok(!probe.includes("page.screenshot"));
});

test("F2b the eclipse-local AST guard rejects floating, readback, and extra-capture mutants", () => {
  const probe = fs
    .readFileSync(path.join(here, "probe-eclipse-cloud-response.mjs"), "utf8")
    .replace(/\r\n/g, "\n");
  const replaceExactlyOnce = (before, after, label) => {
    assert.equal(
      probe.split(before).length - 1,
      1,
      `${label} fixture must match exactly once`,
    );
    return probe.replace(before, after);
  };

  const floatingAlias = eclipseCaptureStaticFailures(
    replaceExactlyOnce(
      "await pin.capture(firstTime, false); // discarded on purpose",
      `const captureAlias = pin.capture;
  captureAlias(firstTime, false); // discarded on purpose`,
      "floating capture alias",
    ),
  );
  assert.ok(
    floatingAlias.failures.some(
      (failure) => failure.code === WEATHER_CAPTURE_FAILURE.UNAWAITED_CAPTURE,
    ),
    formatWeatherCaptureFailures(floatingAlias.failures),
  );

  const floatingWrapper = eclipseCaptureStaticFailures(
    replaceExactlyOnce(
      "await pin.capture(firstTime, false); // discarded on purpose",
      `const captureWrapper = async (...args) => await pin.capture(...args);
  captureWrapper(firstTime, false); // discarded on purpose`,
      "floating capture wrapper",
    ),
  );
  assert.ok(
    floatingWrapper.failures.some(
      (failure) => failure.code === WEATHER_CAPTURE_FAILURE.UNAWAITED_CAPTURE,
    ),
    formatWeatherCaptureFailures(floatingWrapper.failures),
  );

  const liveReadback = eclipseCaptureStaticFailures(
    replaceExactlyOnce(
      "const frame = await pin.capture(julian, wantPng);",
      `const liveContext = document.createElement("canvas").getContext("2d");
    liveContext.drawImage(scene.canvas, 0, 0);
    liveContext.getImageData(0, 0, scene.canvas.width, scene.canvas.height);
    const frame = await pin.capture(julian, wantPng);`,
      "consumer live readback",
    ),
  );
  assert.ok(
    liveReadback.failures.some(
      (failure) => failure.code === WEATHER_CAPTURE_FAILURE.CONSUMER_LIVE_READ,
    ),
    formatWeatherCaptureFailures(liveReadback.failures),
  );

  const extraDocumentaryCapture = eclipseCaptureStaticFailures(
    replaceExactlyOnce(
      "const offCloudsPng = deepest ? aOffCloudsFrame.png : null;",
      `const documentaryFrame = await pin.capture(julian, true);
    const offCloudsPng = deepest ? documentaryFrame.png : null;`,
      "extra documentary capture",
    ),
  );
  assert.equal(
    extraDocumentaryCapture.directPinCaptures,
    6,
    "a second documentary capture cannot hide behind an awaited call",
  );
  assert.ok(
    extraDocumentaryCapture.failures.some(
      (failure) =>
        failure.code === WEATHER_CAPTURE_FAILURE.DOCUMENTARY_ORIGIN_MISMATCH,
    ),
    formatWeatherCaptureFailures(extraDocumentaryCapture.failures),
  );
});

test("F2c the eclipse-local guard preserves coordinated taint reds and awaited inverses", () => {
  const probe = fs
    .readFileSync(path.join(here, "probe-eclipse-cloud-response.mjs"), "utf8")
    .replace(/\r\n/g, "\n");
  const replaceExactlyOnce = (source, before, after, label) => {
    assert.equal(
      source.split(before).length - 1,
      1,
      `${label} fixture must match exactly once`,
    );
    return source.replace(before, after);
  };

  let combined = replaceExactlyOnce(
    probe,
    "await pin.capture(firstTime, false); // discarded on purpose",
    `const captureMap = new Map([["take", pin.capture]]);
  captureMap.get("take")(firstTime, false);
  const Promise = { all() { return globalThis.Promise.resolve(); } };
  await Promise.all([pin.capture(firstTime, false)]); // discarded on purpose`,
    "combined callable and shadowed-Promise mutant",
  );
  combined = replaceExactlyOnce(
    combined,
    "const frame = await pin.capture(julian, wantPng);",
    `const live = document.createElement("canvas").getContext("2d");
    const invoke = (callback, ...args) => callback(...args);
    invoke(live.drawImage.bind(live), scene.canvas, 0, 0);
    const frame = await pin.capture(julian, wantPng);`,
    "combined callback readback mutant",
  );
  combined = replaceExactlyOnce(
    combined,
    "const offCloudsPng = deepest ? aOffCloudsFrame.png : null;",
    `const documentaryFrame = await pin.capture(julian, true);
    void documentaryFrame.data;
    const offCloudsPng = deepest ? documentaryFrame.png : null;`,
    "combined documentary laundering mutant",
  );
  const combinedFailures = eclipseCaptureStaticFailures(combined).failures;
  const combinedCodes = new Set(
    combinedFailures.map((failure) => failure.code),
  );
  for (const code of [
    WEATHER_CAPTURE_FAILURE.CONSUMER_LIVE_READ,
    WEATHER_CAPTURE_FAILURE.DOCUMENTARY_ORIGIN_MISMATCH,
    WEATHER_CAPTURE_FAILURE.UNAWAITED_CAPTURE,
    WEATHER_CAPTURE_FAILURE.UNTRUSTED_INTRINSIC,
  ]) {
    assert.ok(
      combinedCodes.has(code),
      `coordinated eclipse mutant must preserve ${code}:\n${formatWeatherCaptureFailures(combinedFailures)}`,
    );
  }

  const awaitedInverse = replaceExactlyOnce(
    probe,
    "await pin.capture(firstTime, false); // discarded on purpose",
    `const captureMap = new Map([["take", pin.capture]]);
  await captureMap.get("take")(firstTime, false); // discarded on purpose`,
    "awaited Map.get inverse",
  );
  assert.deepEqual(
    eclipseCaptureStaticFailures(awaitedInverse).failures,
    [],
    "the exact same modeled aggregate must pass when its capture is awaited",
  );
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
  // Both preconditions are read back from the fresh-context control, not
  // assumed from the configured base colour.
  assert.match(probe, /foldDeckFreeControlSessions/);
  assert.match(probe, /RUN_DECK_FREE_CONTROL_SESSION/);
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

test("F6 the probe runs both CO-19 subjects with the deck-free leg isolated", () => {
  const probe = fs
    .readFileSync(path.join(here, "probe-eclipse-cloud-response.mjs"), "utf8")
    .replace(/\r\n/g, "\n");

  // Lane B's deck-free pair is now a four-session ABBA plan. The shared cloud
  // page must not manufacture either read.
  assert.match(probe, /DECK_FREE_CONTROL_SESSION_PLAN/);
  assert.match(probe, /sessionLabel: planned\.label/);
  assert.match(probe, /eclipseEnabled: planned\.eclipseEnabled/);
  assert.ok(!probe.includes("const bOnNoCloud"));

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
  assert.match(probe, /SHADOW deck-free sessions: order/);
  assert.match(probe, /\(t\.offNoCloudSeries \?\? \[\]\)\.join\(", "\)/);
  assert.match(probe, /DECK aerial-zero leg: pure ratio/);
});

test("F4 the probe's cost legs are interleaved and both pay a warm-up", () => {
  const probe = fs
    .readFileSync(path.join(here, "probe-eclipse-cloud-response.mjs"), "utf8")
    .replace(/\r\n/g, "\n");
  assert.match(probe, /const COST_SEGMENTS = 8;/);
  assert.match(
    probe,
    /const quotient = Math\.floor\(schedule\.length \/ COST_SEGMENTS\);/,
  );
  assert.match(probe, /const remainder = schedule\.length % COST_SEGMENTS;/);
  assert.match(probe, /runCostSegment/);
  assert.match(
    probe,
    /warmupBothLegs:\s*warmedLegs\.eclipse !== null && warmedLegs\.control !== null/,
  );
  assert.match(probe, /warmups: \[warmedLegs\.eclipse, warmedLegs\.control\]/);
  assert.match(probe, /pairIndex,/);
  assert.match(probe, /ledgerId: cfg\.costLedgerId/);
  assert.equal(REFRESH_COST_PROTOCOL_VERSION, 4);
  assert.match(probe, /version: cfg\.refreshCostProtocol\.version,/);
  assert.match(probe, /backend: rendererType,/);
  assert.match(probe, /runId: cfg\.runId,/);
  assert.match(probe, /sessionToken: cfg\.sessionToken,/);
  assert.match(probe, /factorSchedule: \[\.\.\.factors\]/);
  assert.match(probe, /gpuTime: \{/);
  assert.doesNotMatch(probe, /debug\.gpuPassCost\(/);
  assert.match(
    probe,
    /costContext\.performanceManager\.config\.timestampProfiling = true;/,
  );
  assert.match(probe, /profiler\.reset\(\);/);
  assert.match(probe, /profiler\.drainPendingReadbacks/);
  assert.match(probe, /samplesMs/);
  assert.match(probe, /samplesMsByPass/);
  assert.match(probe, /gpuTime\.passNames\.find/);
  assert.match(probe, /readbackYieldMs/);
  assert.match(probe, /wallMs = performance\.now\(\) - wallStartMs;/);
  assert.doesNotMatch(probe, /wallMs = .* - readbackYieldMs;/);
  assert.match(probe, /resolutionKnown: false/);
  assert.match(probe, /resolutionNs: null/);
  assert.match(probe, /if \(samplesMs\.length !== refreshes\)/);
  assert.match(probe, /if \(passSamples\.length !== refreshes\)/);
  assert.match(probe, /if \(missingMandatoryLabel\)/);
  assert.match(probe, /costContext\?\.getEnvironmentRefreshStats\?\.\(\)/);
  assert.match(probe, /recordEnvironmentRefresh\(\);/);
  assert.match(probe, /frameId !== previousRefreshFrameId \+ 1/);
  assert.match(probe, /refreshes \+= submissions;/);
  assert.match(probe, /time\.dayNumber/);
  assert.match(probe, /time\.secondsOfDay/);
  assert.match(
    probe,
    /current\.dayNumber !== previousWebglRefreshTime\.dayNumber/,
  );
  assert.match(probe, /eclipseRefreshes: sumLeg\("eclipse", "refreshes"\)/);
  assert.match(probe, /controlRefreshes: sumLeg\("control", "refreshes"\)/);
  assert.match(probe, /hasFeature\?\.\("timestamp-query"\) === true/);
  assert.match(probe, /REFRESH_COST_GPU_TIME_PROTOCOL\.scope/);
  assert.match(probe, /segments: costSegments/);
  assert.match(probe, /ABBA/);
  assert.match(probe, /Retain the full alternating ledger/);
  assert.match(probe, /sequential A\/B drift impersonate refresh cost/);
  // The gate reads the interleaved accounting, not the two counting legs.
  assert.match(probe, /refreshCost,/);
  assert.ok(
    ECLIPSE_CLOUD_GATE_PREDICATES.includes("refreshCostMeasured"),
    "R-2026-08-14-1: refreshCostMeasured must remain an operative gate",
  );
  assert.ok(
    !ECLIPSE_CLOUD_REPORTED_ONLY_PREDICATES.includes(
      "refreshCostEstimateValidReportedOnly",
    ),
    "the demoted replacement must not return under a reported-only alias",
  );
  assert.match(probe, /COST \(GATING fresh ABBA measurement\)/);
  assert.equal(8, REFRESH_COST_SEGMENTS_PER_LEG);
  assert.match(probe, /sessionToken: randomUUID\(\)/);
  assert.match(probe, /costLedgerId: randomUUID\(\)/);
  assert.match(probe, /runId: RUN_ID,\n\s*cloudLanes,/);

  const scheduler = readEngine(
    "Renderer/WebGPU/WebGPUEnvironmentRefreshScheduler.ts",
  );
  const context = readEngine("Renderer/WebGPU/WebGPUContext.ts");
  assert.match(scheduler, /this\._telemetry\.submissions \+= 1;/);
  assert.match(context, /getEnvironmentRefreshStats\(\)/);
  assert.match(
    readEngine("Scene/DynamicEnvironmentMapManager.js"),
    /this\._lastTime = JulianDate\.clone\(frameState\.time, this\._lastTime\);/,
  );
});

test("F7 the five engine pass descriptors execute and route through timestamp wrapping", async () => {
  const managerSource = readEngine(
    "Renderer/WebGPU/WebGPUDynamicEnvironmentMapManager.ts",
  );
  const pipelineSource = readEngine("Renderer/WebGPU/WebGPUIBLPipeline.ts");
  const descriptorPattern =
    /const\s+(DYNAMIC_ENVIRONMENT_[A-Z_]+_PASS_DESCRIPTOR): GPUComputePassDescriptor\s*=\s*(\{\s*label:\s*"([^"]+)",\s*\});/g;
  const descriptorMatches = [...managerSource.matchAll(descriptorPattern)];
  assert.equal(descriptorMatches.length, 5);
  assert.deepEqual(
    descriptorMatches.map((match) => match[3]),
    REFRESH_COST_GPU_TIME_PROTOCOL.passNames,
  );
  const combinedEngineSource = `${managerSource}\n${pipelineSource}`;
  for (const passName of REFRESH_COST_GPU_TIME_PROTOCOL.passNames) {
    assert.equal(
      descriptorMatches.filter((match) => match[3] === passName).length,
      1,
    );
    assert.equal(
      combinedEngineSource.split(`label: "${passName}",`).length - 1,
      1,
    );
  }

  const descriptorModuleSource = descriptorMatches
    .map((match) => `export const ${match[1]} = ${match[2]}`)
    .join("\n");
  const descriptors = await import(
    `data:text/javascript;base64,${Buffer.from(descriptorModuleSource).toString("base64")}`
  );
  assert.deepEqual(
    descriptorMatches.map((match) => descriptors[match[1]].label),
    REFRESH_COST_GPU_TIME_PROTOCOL.passNames,
  );

  const directRoutePattern =
    /frameState\.context\.withComputePassTimestamps\?\.\(\s*(DYNAMIC_ENVIRONMENT_[A-Z_]+_PASS_DESCRIPTOR),?\s*\)\s*\?\?\s*\1/g;
  const directlyRouted = [...managerSource.matchAll(directRoutePattern)].map(
    (match) => match[1],
  );
  assert.deepEqual(directlyRouted, [
    "DYNAMIC_ENVIRONMENT_TEMPORAL_PASS_DESCRIPTOR",
    "DYNAMIC_ENVIRONMENT_SKY_PASS_DESCRIPTOR",
    "DYNAMIC_ENVIRONMENT_SH_PASS_DESCRIPTOR",
  ]);
  const managerIBLRoute = managerSource.match(
    /generateIBLMaps\([\s\S]*?frameState\.context,\s*(DYNAMIC_ENVIRONMENT_IRRADIANCE_PASS_DESCRIPTOR),\s*(DYNAMIC_ENVIRONMENT_RADIANCE_PASS_DESCRIPTOR),\s*\);/,
  );
  assert.ok(managerIBLRoute);
  assert.deepEqual(
    new Set([...directlyRouted, managerIBLRoute[1], managerIBLRoute[2]]),
    new Set(descriptorMatches.map((match) => match[1])),
  );

  const wrapperExpression =
    "timestampProvider?.withComputePassTimestamps?.(descriptor) ?? descriptor";
  assert.equal(pipelineSource.split(wrapperExpression).length - 1, 1);
  assert.equal(
    [
      ...pipelineSource.matchAll(
        /const pass = beginIBLComputePass\(\s*encoder,\s*timestampProvider,\s*passDescriptor,\s*\);/g,
      ),
    ].length,
    3,
  );
  assert.equal(
    [
      ...pipelineSource.matchAll(
        /dispatchIrradianceConvolution\(\s*device,\s*workingCache,\s*sourceCubeView,\s*computePipelineCache,\s*scope,\s*timestampProvider,\s*irradiancePassDescriptor,\s*\);/g,
      ),
    ].length,
    2,
  );
  assert.equal(
    [
      ...pipelineSource.matchAll(
        /dispatchRadiancePrefilter\(\s*device,\s*workingCache,\s*sourceCubeView,\s*computePipelineCache,\s*hqOptions,\s*scope,\s*timestampProvider,\s*radiancePassDescriptor,\s*\);/g,
      ),
    ].length,
    2,
  );
  assert.equal(
    [
      ...pipelineSource.matchAll(
        /dispatchSourceCubeMipChain\(\s*device,\s*cache,\s*hqOptions\.sourceCube,\s*fmt,\s*scope,\s*timestampProvider,\s*passDescriptor,\s*\);/g,
      ),
    ].length,
    1,
  );
  const wrapperModule = await import(
    `data:text/javascript;base64,${Buffer.from(`export const route = (timestampProvider, descriptor) => timestampProvider?.withComputePassTimestamps?.(descriptor) ?? descriptor;`).toString("base64")}`
  );
  for (const match of descriptorMatches) {
    const descriptor = descriptors[match[1]];
    assert.equal(wrapperModule.route(undefined, descriptor), descriptor);
    const seen = [];
    const wrapped = { label: `${descriptor.label} wrapped` };
    assert.equal(
      wrapperModule.route(
        {
          withComputePassTimestamps(received) {
            seen.push(received);
            return wrapped;
          },
        },
        descriptor,
      ),
      wrapped,
    );
    assert.deepEqual(seen, [descriptor]);
  }
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

test("J3 the historical extension predicts 1.0002 while the unchanged raw band gates", () => {
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
  // The historical band is unchanged. The later cloud over-composite remains a
  // mechanism confound to investigate, but R-2026-08-14-1 explicitly rejected
  // using that confound to de-score this measured red.
  assert.equal(ECLIPSE_CLOUD_BANDS.shadowContrastRatio.lo, 0.97);
  assert.equal(ECLIPSE_CLOUD_BANDS.shadowContrastRatio.hi, 1.03);
  assert.ok(
    ECLIPSE_CLOUD_BANDS.shadowContrastRatio.why.includes(
      "restored as an operative gate",
    ),
    "the maintainer ruling has to be written where the band is",
  );
  assert.ok(ECLIPSE_CLOUD_GATE_PREDICATES.includes("shadowContrastInvariant"));
  assert.ok(
    !ECLIPSE_CLOUD_REPORTED_ONLY_PREDICATES.includes(
      "shadowCompositeContrastInLegacyBandReportedOnly",
    ),
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

test("J7 additive cloud contamination moves the raw contrast but cancels from the decrement gate", () => {
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
  assert.equal(verdict.shadowContrastInvariant, false);
  assert.equal(verdict.shadowDecrementMatchesGroundDim, true);
  assert.equal(verdict.shadowDecrementRejectsAlternativeDesign, true);
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
  const decrement = verdict.shadowDecrementModelAtDeepest;
  assert.equal(decrement.withinQuantizationBound, true);
  assert.ok(Math.abs(decrement.observed - decrement.expected) < 1e-3);
});

test("J8 removing the independent ground dim fails the decrement invariant", () => {
  const run = clone(passingRun());
  for (const rung of run.cloudLanes.rungs) {
    const clearDecrement = rung.shadow.offNoShadow - rung.shadow.offShadow;
    const strengthRatio = rung.shadow.strengthOn / rung.shadow.strengthOff;
    // MUTANT: apply the producer-strength move, but omit the independently
    // measured eclipse dim of the shadowable ground term.
    rung.shadow.onShadow =
      rung.shadow.onNoShadow - clearDecrement * strengthRatio;
  }
  const verdict = judgeEclipseCloudResponse(run);
  assert.deepEqual(verdict.structuralReasons, []);
  assert.deepEqual(verdict.failedPredicates.sort(), [
    "shadowContrastInvariant",
    "shadowDecrementMatchesGroundDim",
  ]);
  assert.equal(verdict.shadowContrastInvariant, false);
  assert.equal(verdict.shadowDecrementMatchesGroundDim, false);
  assert.ok(
    verdict.shadowDecrementModel
      .slice(1)
      .every((entry) => entry.withinQuantizationBound === false),
  );
});

test("J9 decrement quantization admits the hard edge and rejects one code beyond", () => {
  const differenceError = BAND_MEAN_QUANTIZATION_HALF_STEP * 2;
  const baseShadow = {
    offNoShadow: 0.8,
    offShadow: 0.4,
    onNoShadow: 0.5,
    onShadow: 0.3,
    offNoCloud: 0.8,
    onNoCloud: 0.4,
  };
  const baseline = evaluateShadowDecrementModel({
    shadow: baseShadow,
    strengthClear: 1,
    strengthEclipse: 1,
  });
  const expectedHi = baseline.quantization.expectedInterval.hi;
  const clearDecrement = baseShadow.offNoShadow - baseShadow.offShadow;
  // Solve (D_on - e) / (D_off + e) = expectedHi, then move one floating
  // representation inward so the closed interval meets at its exact edge.
  const edgeDecrement =
    expectedHi * (clearDecrement + differenceError) +
    differenceError -
    Number.EPSILON;
  const atEdge = evaluateShadowDecrementModel({
    shadow: {
      ...baseShadow,
      onShadow: baseShadow.onNoShadow - edgeDecrement,
    },
    strengthClear: 1,
    strengthEclipse: 1,
  });
  assert.equal(atEdge.valid, true);
  assert.equal(atEdge.withinQuantizationBound, true);
  assert.ok(
    Math.abs(atEdge.quantization.observedInterval.lo - expectedHi) <=
      Number.EPSILON * 2,
  );

  const oneCodeBeyond = evaluateShadowDecrementModel({
    shadow: {
      ...baseShadow,
      onShadow: baseShadow.onNoShadow - (edgeDecrement + differenceError),
    },
    strengthClear: 1,
    strengthEclipse: 1,
  });
  assert.equal(oneCodeBeyond.valid, true);
  assert.equal(oneCodeBeyond.withinQuantizationBound, false);
  assert.ok(
    oneCodeBeyond.quantization.observedInterval.lo >
      oneCodeBeyond.quantization.expectedInterval.hi,
  );
});

const DEEPEST_SHADOW_LEDGER = Object.freeze({
  offNoShadow: 0.6779672263764543,
  offShadow: 0.3794818412087721,
  onNoShadow: 0.332292576127518,
  onShadow: 0.19234006690183653,
  deckRatio: 0.513868583346416,
});

function runWithDeepestShadowLedger() {
  const run = clone(passingRun());
  const deepest = run.cloudLanes.rungs.at(-1);
  Object.assign(deepest.shadow, DEEPEST_SHADOW_LEDGER);
  deepest.deck.onContribution =
    deepest.deck.offContribution * DEEPEST_SHADOW_LEDGER.deckRatio;
  return run;
}

test("J10 the deepest residue locus reproduces the mechanism arithmetic", () => {
  const verdict = judgeEclipseCloudResponse(runWithDeepestShadowLedger());
  const model = verdict.shadowContrastModel.at(-1);
  const {
    offNoShadow: Uc,
    offShadow: Sc,
    onNoShadow: Ue,
    onShadow: Se,
  } = DEEPEST_SHADOW_LEDGER;
  const terrainDim = (Ue - Se) / (Uc - Sc);
  const compositeDim = Ue / Uc;
  assert.equal(model.terrainDim, terrainDim);
  assert.equal(model.compositeDim, compositeDim);
  assert.ok(Math.abs(model.terrainDim - 0.4688755837980454) <= Number.EPSILON);
  assert.ok(
    Math.abs(model.compositeDim - 0.4901307367076268) <= Number.EPSILON,
  );
  const publishedFactor = 0.46420022839842723;
  assert.equal(
    Number((model.terrainDim / publishedFactor).toFixed(6)),
    1.010072,
  );
  assert.equal(
    Number((model.compositeDim / publishedFactor).toFixed(6)),
    1.055861,
  );
  assert.deepEqual(
    verdict.shadowResidueDimLocus.map(({ share, requiredResidueDim }) => [
      share,
      Number(requiredResidueDim.toFixed(6)),
    ]),
    [
      // The four rows below 0.2 were added with the mechanism pass. They are
      // where the answer lives: the shipped in-shader encode chain
      // independently returns ~0.675 for the residue dim, and this table
      // asks for 0.681427 at share 0.1 — the two agree to about 1% without
      // either being fitted to the other.
      [0.05, 0.893979],
      [0.075, 0.752278],
      [0.1, 0.681427],
      [0.125, 0.638917],
      [0.15, 0.610577],
      [0.2, 0.575151],
      [0.3, 0.539726],
      [0.4, 0.522013],
      [0.5, 0.511386],
      [0.6, 0.504301],
      [0.7, 0.49924],
    ],
  );
  const expectedShare =
    (compositeDim - terrainDim) /
    (DEEPEST_SHADOW_LEDGER.deckRatio - terrainDim);
  assert.equal(verdict.shadowResidueShareAtDeckRatio, expectedShare);
  assert.equal(Number(expectedShare.toFixed(6)), 0.47241);
});

test("J10b the beer floor caps the residue share, and the deck-like share exceeds it", () => {
  const verdict = judgeEclipseCloudResponse(runWithDeepestShadowLedger());
  const model = verdict.shadowContrastModel.at(-1);
  const { offNoShadow: Uc, offShadow: Sc } = DEEPEST_SHADOW_LEDGER;
  const clearContrast = Sc / Uc;
  assert.equal(model.clearContrast, clearContrast);
  // clearContrast = T*(1 - share) + share with T >= the beer floor, so
  // share <= (clearContrast - floor) / (1 - floor). Executed here, not copied.
  const ceiling =
    (clearContrast - CLOUD_SHADOW_BEER_FLOOR) / (1 - CLOUD_SHADOW_BEER_FLOOR);
  assert.equal(verdict.shadowResidueShareCeiling, ceiling);
  assert.equal(verdict.shadowResidueShareCeiling, 0.32266890343992366);

  // The deck-like hypothesis is OUT OF RANGE: the share that would make the
  // required residue dim equal the measured deck ratio sits above the ceiling.
  assert.ok(
    verdict.shadowResidueShareAtDeckRatio > verdict.shadowResidueShareCeiling,
    "a residue dimming at the measured deck ratio needs more share than the beer floor allows",
  );

  // requiredResidueDim is DECREASING in share, so the ceiling is a FLOOR on the
  // residue's own dimming — and that floor is ABOVE the measured deck ratio,
  // which is why the deck alone cannot carry the excess.
  const locus = verdict.shadowResidueDimLocus;
  for (let i = 1; i < locus.length; i++) {
    assert.ok(locus[i].requiredResidueDim < locus[i - 1].requiredResidueDim);
  }
  const required = (share) =>
    (model.compositeDim - model.terrainDim * (1 - share)) / share;
  const residueDimFloor = required(ceiling);
  assert.equal(Number(residueDimFloor.toFixed(6)), 0.534749);
  assert.ok(residueDimFloor > DEEPEST_SHADOW_LEDGER.deckRatio);
});

test("J11 equal residue and terrain dim reconstruct raw contrast exactly one", () => {
  const {
    offNoShadow: Uc,
    offShadow: Sc,
    onNoShadow: Ue,
    onShadow: Se,
  } = DEEPEST_SHADOW_LEDGER;
  const terrainDim = (Ue - Se) / (Uc - Sc);
  const clearDecrement = Uc - Sc;
  const equalLawUnshadowed = Uc * terrainDim;
  const equalLawShadowed = equalLawUnshadowed - clearDecrement * terrainDim;
  const reconstructedRawContrast =
    equalLawShadowed / equalLawUnshadowed / (Sc / Uc);
  assert.ok(Math.abs(reconstructedRawContrast - 1) <= 1e-12);

  const verdict = judgeEclipseCloudResponse(runWithDeepestShadowLedger());
  assert.equal(verdict.shadowContrastRatioAtDeepest, 1.0341102079879674);
  assert.equal(verdict.shadowContrastInvariant, false);
  assert.equal(ECLIPSE_CLOUD_BANDS.shadowContrastRatio.lo, 0.97);
  assert.equal(ECLIPSE_CLOUD_BANDS.shadowContrastRatio.hi, 1.03);
});

test("J12 degenerate residue divisions publish null", () => {
  let run = runWithDeepestShadowLedger();
  let deepest = run.cloudLanes.rungs.at(-1);
  deepest.shadow.offShadow = deepest.shadow.offNoShadow;
  let verdict = judgeEclipseCloudResponse(run);
  assert.equal(verdict.shadowContrastModel.at(-1).terrainDim, null);
  assert.ok(
    verdict.shadowResidueDimLocus.every(
      ({ requiredResidueDim }) => requiredResidueDim === null,
    ),
  );
  assert.equal(verdict.shadowResidueShareAtDeckRatio, null);

  run = runWithDeepestShadowLedger();
  deepest = run.cloudLanes.rungs.at(-1);
  deepest.shadow.offNoShadow = 0;
  verdict = judgeEclipseCloudResponse(run);
  assert.equal(verdict.shadowContrastModel.at(-1).compositeDim, null);
  assert.ok(
    verdict.shadowResidueDimLocus.every(
      ({ requiredResidueDim }) => requiredResidueDim === null,
    ),
  );

  run = runWithDeepestShadowLedger();
  deepest = run.cloudLanes.rungs.at(-1);
  const terrainDim =
    (deepest.shadow.onNoShadow - deepest.shadow.onShadow) /
    (deepest.shadow.offNoShadow - deepest.shadow.offShadow);
  deepest.deck.onContribution = deepest.deck.offContribution * terrainDim;
  verdict = judgeEclipseCloudResponse(run);
  assert.equal(verdict.shadowResidueShareAtDeckRatio, null);

  run = runWithDeepestShadowLedger();
  run.cloudLanes.rungs.at(-1).shadow.onNoShadow = Number.POSITIVE_INFINITY;
  verdict = judgeEclipseCloudResponse(run);
  assert.equal(verdict.shadowContrastModel.at(-1).terrainDim, null);
  assert.equal(verdict.shadowContrastModel.at(-1).compositeDim, null);
});

test("J13 residue diagnostics cannot alter the verdict", async () => {
  const baseline = judgeEclipseCloudResponse(passingRun());
  const injectedRun = passingRun();
  injectedRun.cloudLanes.shadowResidueDimLocus = [
    { share: -1000, requiredResidueDim: Number.POSITIVE_INFINITY },
  ];
  const injected = judgeEclipseCloudResponse(injectedRun);
  assert.equal(baseline.PASS, true);
  assert.equal(injected.PASS, true);
  assert.equal(injected.exitCode, ECLIPSE_CLOUD_EXIT.PASS);
  assert.deepEqual(injected.failedPredicates, baseline.failedPredicates);

  const gateSource = fs.readFileSync(
    path.join(here, "lib", "eclipse-cloud-response-gate.mjs"),
    "utf8",
  );
  const gatingAnchor = '"shadowContrastInvariant",';
  assert.equal(gateSource.split(gatingAnchor).length - 1, 1);
  const mutantSource = gateSource.replace(
    gatingAnchor,
    '"shadowContrastInvariant", "shadowResidueDimLocus",',
  );
  const mutantModule = await import(
    `data:text/javascript;base64,${Buffer.from(mutantSource).toString("base64")}`
  );
  const mutant = mutantModule.judgeEclipseCloudResponse(injectedRun);
  assert.equal(mutant.PASS, false);
  assert.equal(mutant.exitCode, ECLIPSE_CLOUD_EXIT.FAIL);
  assert.ok(mutant.failedPredicates.includes("shadowResidueDimLocus"));
  assert.throws(() => assert.equal(mutant.PASS, true));
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

test("L1b deck-free attribution uses the independently predicted 1400 m factor, never lane A's 300 m factor", () => {
  const run = passingRun();
  const rungIndex = run.cloudLanes.rungs.length - 1;
  const rung = run.cloudLanes.rungs[rungIndex];
  const scheduled = rung.scheduledObscuration;

  // Both observations are inside the registered schedule tolerance, but they
  // are intentionally distinct: lane A is rendered at 300 m, while lane B and
  // every fresh deck-free session are rendered at 1400 m.
  const laneAObscuration = scheduled + 2e-5;
  const deckFreeObscuration = scheduled + 7.9e-5;
  const laneAFactor = predictFactor(laneAObscuration);
  const deckFreeFactor = predictFactor(deckFreeObscuration);
  assert.notEqual(laneAFactor, deckFreeFactor);

  rung.published.moonObscuration = laneAObscuration;
  rung.published.factor = laneAFactor;
  rung.published.shadowStrength = predictDirectional(laneAObscuration);
  rung.shadow.strengthOn = rung.published.shadowStrength;
  rung.deckFreePublished.moonObscuration = deckFreeObscuration;
  rung.deckFreePublished.factor = deckFreeFactor;

  const offBand = rung.shadow.offNoCloud;
  for (const session of run.cloudLanes.deckFreeControl.sessions) {
    const sessionRung = session.rungs[rungIndex];
    const diagnosticRung = session.directionalDiagnosticRungs[rungIndex];
    sessionRung.lighting.moonObscuration = deckFreeObscuration;
    diagnosticRung.lighting.moonObscuration = deckFreeObscuration;
    sessionRung.cameraHeight = 1400;
    if (session.eclipseEnabled) {
      sessionRung.factor = deckFreeFactor;
      sessionRung.lighting.factor = deckFreeFactor;
      sessionRung.mean = offBand * deckFreeFactor;
      diagnosticRung.factor = deckFreeFactor;
      diagnosticRung.lighting.factor = deckFreeFactor;
    } else {
      sessionRung.factor = 1;
      sessionRung.lighting.factor = 1;
      sessionRung.mean = offBand;
      diagnosticRung.factor = 1;
      diagnosticRung.lighting.factor = 1;
    }
  }
  const control = refoldDeckFreeControl(run);
  assert.equal(control.stateIsolated, true);

  const verdict = judgeEclipseCloudResponse(run);
  assert.deepEqual(verdict.structuralReasons, []);
  assert.equal(verdict.deckFreeGroundDimsByFactor, true);
  const entry = verdict.deckFreeGroundDim[rungIndex];
  assert.equal(entry.obscuration, deckFreeObscuration);
  assert.equal(entry.factor, deckFreeFactor);
  assert.equal(entry.publishedFactor, deckFreeFactor);
  assert.equal(
    entry.factorSource,
    "predictFactor(deckFreePublished.moonObscuration)",
  );
  assert.equal(entry.factorCameraHeight, 1400);
  assert.equal(entry.measurementCameraHeight, 1400);
  assert.equal(entry.cameraGeometryMatches, true);
  assert.equal(entry.scheduledLaneFactor, laneAFactor);
  assert.ok(Math.abs(entry.delta) < 1e-15);

  const wrongFactor = clone(run);
  wrongFactor.cloudLanes.rungs[rungIndex].deckFreePublished.factor =
    laneAFactor;
  const wrongFactorVerdict = judgeEclipseCloudResponse(wrongFactor);
  assert.equal(
    wrongFactorVerdict.deckFreeGroundDim[rungIndex].factorCertified,
    false,
  );
  assert.ok(
    wrongFactorVerdict.failedPredicates.includes("deckFreeGroundDimsByFactor"),
  );

  const wrongHeight = clone(run);
  wrongHeight.cloudLanes.rungs[rungIndex].deckFreePublished.cameraHeight = 300;
  const wrongHeightVerdict = judgeEclipseCloudResponse(wrongHeight);
  assert.equal(
    wrongHeightVerdict.deckFreeGroundDim[rungIndex].cameraGeometryMatches,
    false,
  );
  assert.ok(
    wrongHeightVerdict.failedPredicates.includes("deckFreeGroundDimsByFactor"),
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
  syncShadowDecrementsToDeckFree(run);
  settleDeckFreeTwins(run);
  const verdict = judgeEclipseCloudResponse(run);
  assert.deepEqual(verdict.structuralReasons, []);
  assert.deepEqual(verdict.failedPredicates, [
    "shadowContrastInvariant",
    "deckFreeGroundDimsByFactor",
  ]);
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
  syncShadowDecrementsToDeckFree(noisy);
  settleDeckFreeTwins(noisy);
  const noisyVerdict = judgeEclipseCloudResponse(noisy);
  assert.equal(
    noisyVerdict.deckFreeGroundDimsByFactor,
    true,
    "one code of capture noise must not fail the attribution",
  );
  assert.ok(noisyVerdict.deckFreeGroundDim.every((entry) => entry.delta !== 0));
});

test("L3 the decrement cancels cloud residue and catches a deck-free residue-law mismatch", () => {
  // (a) CLOUD-DRIVEN: the residue appears only once the deck is in the scene,
  //     so the deck-free band still dims by exactly F.
  const cloudDriven = clone(passingRun());
  injectUnderDimmingResidue(cloudDriven, { alsoDeckFree: false });
  const cloudVerdict = judgeEclipseCloudResponse(cloudDriven);
  assert.deepEqual(cloudVerdict.structuralReasons, []);
  assert.deepEqual(cloudVerdict.failedPredicates, ["shadowContrastInvariant"]);
  assert.equal(cloudVerdict.shadowContrastInvariant, false);
  assert.equal(cloudVerdict.shadowDecrementMatchesGroundDim, true);
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
    "shadowDecrementMatchesGroundDim",
  ]);
  assert.ok(globeVerdict.deckFreeGroundExcessAtDeepest > 1.12);

  // THE ATTRIBUTION: two runs whose SCORED shadow bands are bit-identical, told
  // apart by the independent ABBA ground law. The cloud-only residue cancels;
  // the deck-free residue does not share the shadowable decrement's law.
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
    ["deckFreeGroundDimsByFactor", "shadowDecrementMatchesGroundDim"],
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

test("L8 both CO-19 subjects fail while the restored raw invariant stays operative", () => {
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
      syncShadowDecrementsToDeckFree(run);
      settleDeckFreeTwins(run);
    },
    ["deckFreeGroundDimsByFactor", "shadowContrastInvariant"],
  );

  // (d) ...and OVER-dims. The gate is two-sided: an eclipse that removes too
  //     much light is a different defect, not a pass.
  expectFailure(
    (run) => {
      for (const rung of run.cloudLanes.rungs) {
        rung.shadow.onNoCloud =
          rung.shadow.offNoCloud * rung.published.factor * 0.85;
      }
      syncShadowDecrementsToDeckFree(run);
      settleDeckFreeTwins(run);
    },
    ["deckFreeGroundDimsByFactor", "shadowContrastInvariant"],
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
      syncShadowDecrementsToDeckFree(run);
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
  syncShadowDecrementsToDeckFree(run);
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

test("K2 a session-dependent deck-free control is STRUCTURAL, not a product FAIL", () => {
  // One fresh eclipse-ON session reads 0.449 and its independent ABBA replicate
  // reads the law. A gate that scored the first session would report an engine
  // identity violation that does not exist.
  const run = clone(passingRun());
  const identityRung = run.cloudLanes.rungs[0];
  identityRung.shadow.onNoCloud =
    identityRung.shadow.offNoCloud * 0.4490092844112451;
  // Deliberately NOT `settleDeckFreeTwins` — the twin keeps the converged value.
  const verdict = judgeEclipseCloudResponse(run);

  assert.equal(verdict.deckFreeGroundCapturesSettled, false);
  const reason = verdict.structuralReasons.find((r) =>
    r.includes("session-dependent"),
  );
  assert.ok(reason, JSON.stringify(verdict.structuralReasons));
  // BOTH legs' deltas are named, so a reader can see WHICH one moved.
  assert.match(reason, /eclipse-OFF sessions differ by 0 /);
  assert.match(reason, /eclipse-ON sessions differ by 0\.28/);
  // The attribution is quarantined rather than scored...
  assert.ok(verdict.unscoredPredicates.includes("deckFreeGroundDimsByFactor"));
  assert.ok(
    verdict.unscoredPredicates.includes("deckFreeGroundCapturesSettled"),
  );
  // The decrement model deliberately consumes this independent control, so a
  // session-dependent ABBA ground read quarantines only the decrement
  // companions. R-2026-08-14-1 forbids that control from silencing lane B's
  // own raw contrast red, which remains scored in the parent shadow domain.
  assert.ok(!verdict.unscoredPredicates.includes("shadowContrastInvariant"));
  assert.equal(verdict.shadowContrastInvariant, true);
  assert.ok(
    verdict.unscoredPredicates.includes("shadowDecrementMatchesGroundDim"),
  );
  assert.ok(
    verdict.unscoredPredicates.includes(
      "shadowDecrementRejectsAlternativeDesign",
    ),
  );
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
  syncShadowDecrementsToDeckFree(run);
  settleDeckFreeTwins(run);
  const verdict = judgeEclipseCloudResponse(run);
  assert.deepEqual(verdict.structuralReasons, []);
  assert.equal(verdict.deckFreeGroundCapturesSettled, true);
  assert.deepEqual(verdict.failedPredicates, [
    "shadowContrastInvariant",
    "deckFreeGroundDimsByFactor",
  ]);
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

test("K6 the probe removes the in-page control and opens four fresh ABBA contexts", () => {
  const probe = fs
    .readFileSync(path.join(here, "probe-eclipse-cloud-response.mjs"), "utf8")
    .replace(/\r\n/g, "\n");
  assert.ok(!probe.includes("bOffNoCloud"));
  assert.ok(!probe.includes("bOnNoCloud"));
  assert.match(
    probe,
    /for \(const planned of DECK_FREE_CONTROL_SESSION_PLAN\)/,
  );
  assert.match(probe, /`deck-free-\$\{planned\.label\}`/);
  assert.match(probe, /const report = await withFreshPage\(/);
  assert.match(probe, /RUN_DECK_FREE_CONTROL_SESSION/);
  assert.match(
    probe,
    /await opened\.context\.close\(\);[\s\S]*retainFreshPageEvidence\(opened, evidence\)/,
  );

  const callbackStart = probe.indexOf(
    "const RUN_DECK_FREE_CONTROL_SESSION = async (cfg) => {",
  );
  const callbackEnd = probe.indexOf("// IN-PAGE: lane C", callbackStart);
  const callback = probe.slice(callbackStart, callbackEnd);
  assert.equal(
    (callback.match(/cloudProbe\.configure\(/g) ?? []).length,
    1,
    "a fresh control session must have exactly one configure epoch",
  );
  assert.match(callback, /enableVolumetric: false/);
  assert.match(
    callback,
    /scene\.globe\.lightingFadeOutDistance = cfg\.lightingFadeOutDistance/,
  );
  assert.match(
    callback,
    /scene\.globe\.lightingFadeInDistance = cfg\.lightingFadeInDistance/,
  );
  assert.match(callback, /cameraDistance/);
  assert.match(callback, /expectedFade/);
  assert.match(callback, /scene\.light = new C\.DirectionalLight\(/);
  assert.match(callback, /captureRole: "diagnostic-directional-daynight"/);
  assert.equal(
    (callback.match(/scene\.globe\.terminatorGlowStrength\s*=/g) ?? []).length,
    2,
    "the diagnostic strength must be set once and restored once per rung",
  );
  assert.match(
    callback,
    /scene\.globe\.terminatorGlowStrength = cfg\.diagnosticTerminatorGlowStrength;[\s\S]*?scene\.light = new C\.DirectionalLight\(/,
  );
  assert.match(
    callback,
    /scene\.light = new C\.SunLight\([\s\S]*?scene\.globe\.terminatorGlowStrength = priorTerminatorGlowStrength;[\s\S]*?aimCamera\(julian\);[\s\S]*?await pin\.settle\(julian, cfg\.settleMs\);[\s\S]*?captureRole: "scored-real-sun-factor"/,
    "each scored rung must restore a fresh SunLight and the exact prior glow strength, then render",
  );
  assert.match(
    probe,
    /diagnosticTerminatorGlowStrength:\s*DECK_FREE_DIAGNOSTIC_TERMINATOR_GLOW_STRENGTH/,
  );
  assert.match(callback, /terminatorGlowTileProviderStrength:/);
  assert.match(callback, /light: readLight\(false\)/);
  assert.match(callback, /light: readLight\(true\)/);
  assert.match(
    callback,
    /sameObject: scene\.light === scene\.frameState\?\.light/,
  );
  assert.match(callback, /configureCalls,/);
  assert.match(callback, /sessionToken: globalThis\.crypto\.randomUUID\(\)/);
  assert.match(callback, /cameraHeight: cfg\.groundCameraHeight/);
  assert.match(
    probe,
    /const deckFreePublished = \{[\s\S]*?cameraHeight: cfg\.groundCameraHeight,[\s\S]*?\};/,
  );
  assert.match(
    probe,
    /lightingFadeOutDistance: DECK_FREE_LIGHTING_FADE_OUT_DISTANCE/,
  );
  assert.match(
    probe,
    /lightingFadeInDistance: DECK_FREE_LIGHTING_FADE_IN_DISTANCE/,
  );
  assert.match(
    probe,
    /directionalNdotLTargets: DECK_FREE_DIAGNOSTIC_NDOTL_TARGETS/,
  );
  assert.match(
    probe,
    /directionalLightIntensity:\s*DECK_FREE_DIRECTIONAL_LIGHT_INTENSITY/,
  );
  assert.match(probe, /sunLightIntensity: DECK_FREE_SUN_LIGHT_INTENSITY/);
  assert.match(
    probe,
    /diagnosticSite: \{\s*latitudeDegrees: derived\.lat,\s*longitudeDegrees: derived\.lon/,
  );
});

test("K7 the ABBA policy rejects reused, reordered, or reconfigured sessions", () => {
  assert.deepEqual(DECK_FREE_CONTROL_SESSION_PLAN, [
    { label: "off-a", eclipseEnabled: false },
    { label: "on-a", eclipseEnabled: true },
    { label: "on-b", eclipseEnabled: true },
    { label: "off-b", eclipseEnabled: false },
  ]);
  const run = passingRun();
  const ladder = run.cloudLanes.rungs.map(
    ({ target, iso, scheduledObscuration }) => ({
      target,
      iso,
      obscuration: scheduledObscuration,
    }),
  );
  const sessions = freshDeckFreeSessions(run.cloudLanes.rungs);
  const fold = (reports) =>
    foldDeckFreeControlSessions({
      sessions: reports,
      ladder,
      certifiedRungs: run.cloudLanes.rungs,
      factorTolerance: ECLIPSE_CLOUD_BANDS.factorTolerance.hi,
      scheduleObscurationTolerance:
        ECLIPSE_CLOUD_BANDS.scheduleObscurationTolerance.hi,
      captureDelta: BAND_MEAN_CAPTURE_DELTA,
      diagnosticSite: DECK_FREE_DIAGNOSTIC_SITE,
    });

  assert.equal(fold(sessions).stateIsolated, true);

  const reused = clone(sessions);
  reused[1].sessionToken = reused[0].sessionToken;
  assert.equal(fold(reused).stateIsolated, false);
  assert.match(fold(reused).isolationReasons.join("\n"), /token .* reused/);

  const reordered = clone(sessions);
  [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
  assert.equal(fold(reordered).stateIsolated, false);
  assert.match(fold(reordered).isolationReasons.join("\n"), /report label/);

  const reconfigured = clone(sessions);
  reconfigured[2].configureCalls = 2;
  reconfigured[2].rungs[0].configureCalls = 2;
  assert.equal(fold(reconfigured).stateIsolated, false);
  assert.match(
    fold(reconfigured).isolationReasons.join("\n"),
    /expected exactly 1/,
  );

  const deckPresent = clone(sessions);
  deckPresent[3].configureTruth.enableVolumetric = true;
  assert.equal(fold(deckPresent).stateIsolated, false);
  assert.match(fold(deckPresent).isolationReasons.join("\n"), /not disabled/);
});

test("K8 the complete DirectionalLight discriminator rejects omitted terms, Sun saturation, and fabricated variation", () => {
  const run = passingRun();
  const ladder = run.cloudLanes.rungs.map(
    ({ target, iso, scheduledObscuration }) => ({
      target,
      iso,
      obscuration: scheduledObscuration,
    }),
  );
  const fold = (sessions) =>
    foldDeckFreeControlSessions({
      sessions,
      ladder,
      certifiedRungs: run.cloudLanes.rungs,
      factorTolerance: ECLIPSE_CLOUD_BANDS.factorTolerance.hi,
      scheduleObscurationTolerance:
        ECLIPSE_CLOUD_BANDS.scheduleObscurationTolerance.hi,
      captureDelta: BAND_MEAN_CAPTURE_DELTA,
      diagnosticSite: DECK_FREE_DIAGNOSTIC_SITE,
    });

  // The actual Iceland Sun is saturated at all four rungs. Flat/raw OFF pixels
  // are therefore valid in the scored factor lane once a separate diagnostic
  // executes the DAYNIGHT diffuse law.
  const saturatedRealSun = freshDeckFreeSessions(run.cloudLanes.rungs);
  for (const session of saturatedRealSun.filter(
    (entry) => !entry.eclipseEnabled,
  )) {
    for (const rung of session.rungs) {
      rung.mean = DECK_FREE_RAW_BASE_COLOR_LUMA;
    }
  }
  const saturatedRealSunVerdict = fold(saturatedRealSun);
  assert.equal(saturatedRealSunVerdict.offASpread, 0);
  assert.equal(saturatedRealSunVerdict.maximumRawDistance, 0);
  assert.equal(saturatedRealSunVerdict.litSurfaceNonVacuous, true);

  // The exact fresh-v3 artifact (run bef98b53, SHA-256 63ab81ab...b20293)
  // executes the full source expression, not baseColor*diffuse alone. The
  // independent model explains every rung to <0.0012 without a band change.
  const freshV3Observed = [
    0.3146870588234545, 0.4667945098038767, 0.6099576470587704,
    0.7514533333337392,
  ];
  const freshV3 = freshDeckFreeSessions(run.cloudLanes.rungs);
  for (const session of freshV3) {
    for (let index = 0; index < freshV3Observed.length; index++) {
      session.directionalDiagnosticRungs[index].mean = freshV3Observed[index];
    }
  }
  const freshV3Verdict = fold(freshV3);
  assert.equal(freshV3Verdict.diagnosticPixelTolerance, 0.008);
  assert.equal(freshV3Verdict.litSurfaceNonVacuous, true);
  assert.deepEqual(
    freshV3Verdict.directionalDiagnostic.map((entry) =>
      Number(entry.expectedOff.toFixed(6)),
    ),
    [0.31549, 0.467381, 0.611103, 0.750964],
  );
  assert.ok(
    freshV3Verdict.directionalDiagnostic.every(
      (entry, index) =>
        Math.abs(entry.expectedOff - freshV3Observed[index]) < 0.0012,
    ),
  );

  // Mutant: an oracle that omits the additive glow would recreate the false
  // red. Every capture remains positive, sampled, replicated, and ON/OFF
  // identical, so rejection comes from the expression rather than vacuity.
  const missingGlow = freshDeckFreeSessions(run.cloudLanes.rungs);
  for (const session of missingGlow) {
    for (const diagnostic of session.directionalDiagnosticRungs) {
      const frame = computeDeckFreeDiagnosticFrame(
        DECK_FREE_DIAGNOSTIC_SITE.latitudeDegrees,
        DECK_FREE_DIAGNOSTIC_SITE.longitudeDegrees,
        diagnostic.ndotlTarget,
        DECK_FREE_DIAGNOSTIC_TERMINATOR_GLOW_STRENGTH,
      );
      diagnostic.mean = DECK_FREE_RAW_BASE_COLOR_LUMA * frame.diffuse;
      assert.ok(diagnostic.mean > 0 && diagnostic.samples > 0);
    }
  }
  const missingGlowVerdict = fold(missingGlow);
  assert.equal(missingGlowVerdict.litSurfaceNonVacuous, false);
  assert.match(
    missingGlowVerdict.nonVacuityReasons.join("\n"),
    /plus terminator-glow luma/,
  );
  assert.ok(
    missingGlowVerdict.directionalDiagnostic.every(
      (entry) => entry.replicasAgree && entry.ratioIsIdentity,
    ),
  );

  // Converse mutant: glow without the DAYNIGHT multiply is also bright and
  // deterministic, but cannot certify that the diffuse branch executed.
  const missingDiffuse = freshDeckFreeSessions(run.cloudLanes.rungs);
  for (const session of missingDiffuse) {
    for (const diagnostic of session.directionalDiagnosticRungs) {
      diagnostic.mean = computeDeckFreeTerminatorGlowLuma(
        diagnostic.ndotlTarget,
        DECK_FREE_DIAGNOSTIC_TERMINATOR_GLOW_STRENGTH,
      );
      assert.ok(diagnostic.mean > 0 && diagnostic.samples > 0);
    }
  }
  const missingDiffuseVerdict = fold(missingDiffuse);
  assert.equal(missingDiffuseVerdict.litSurfaceNonVacuous, false);
  assert.match(
    missingDiffuseVerdict.nonVacuityReasons.join("\n"),
    /DAYNIGHT diffuse/,
  );
  assert.ok(
    missingDiffuseVerdict.directionalDiagnostic.every(
      (entry) => entry.replicasAgree && entry.ratioIsIdentity,
    ),
  );

  // Mutant 1: accidentally reusing SunLight for the diagnostic restores the
  // exact saturation blind the reviewer found, even if the pixels look stable.
  const saturatedDiagnostic = freshDeckFreeSessions(run.cloudLanes.rungs);
  for (const session of saturatedDiagnostic) {
    for (const diagnostic of session.directionalDiagnosticRungs) {
      diagnostic.mean = DECK_FREE_RAW_BASE_COLOR_LUMA;
      diagnostic.light = deckFreeLightReadback("SunLight", false);
    }
  }
  const saturatedDiagnosticVerdict = fold(saturatedDiagnostic);
  assert.equal(saturatedDiagnosticVerdict.stateIsolated, false);
  assert.equal(saturatedDiagnosticVerdict.litSurfaceNonVacuous, false);
  assert.match(
    saturatedDiagnosticVerdict.isolationReasons.join("\n"),
    /not the exact diagnostic DirectionalLight/,
  );
  assert.match(
    saturatedDiagnosticVerdict.nonVacuityReasons.join("\n"),
    /do not execute DAYNIGHT diffuse/,
  );

  // Mutant 2: monotonically varying pixels cannot self-certify. The fold
  // derives .3/.5/.7/.9 from direction readback and rejects made-up values.
  const fabricatedVariation = freshDeckFreeSessions(run.cloudLanes.rungs);
  for (const session of fabricatedVariation) {
    for (
      let index = 0;
      index < session.directionalDiagnosticRungs.length;
      index++
    ) {
      session.directionalDiagnosticRungs[index].mean = 0.2 + index * 0.1;
    }
  }
  const fabricatedVerdict = fold(fabricatedVariation);
  assert.equal(fabricatedVerdict.litSurfaceNonVacuous, false);
  assert.match(
    fabricatedVerdict.nonVacuityReasons.join("\n"),
    /do not execute DAYNIGHT diffuse/,
  );

  // Mutant 3: applying F to the custom diagnostic contaminates the deliberate
  // SunLight-only separation. Only restored-Sun scored pixels may certify F.
  const contaminatedDiagnostic = freshDeckFreeSessions(run.cloudLanes.rungs);
  for (const session of contaminatedDiagnostic.filter(
    (entry) => entry.eclipseEnabled,
  )) {
    for (const diagnostic of session.directionalDiagnosticRungs) {
      diagnostic.mean *= diagnostic.factor;
    }
  }
  const contaminatedVerdict = fold(contaminatedDiagnostic);
  assert.equal(contaminatedVerdict.litSurfaceNonVacuous, false);
  assert.match(
    contaminatedVerdict.nonVacuityReasons.join("\n"),
    /not eclipse-invariant/,
  );

  const judged = clone(passingRun());
  judged.cloudLanes.deckFreeControl.litSurfaceNonVacuous = false;
  judged.cloudLanes.deckFreeControl.nonVacuityReasons = [
    "raw baseColor mutant",
  ];
  const verdict = judgeEclipseCloudResponse(judged);
  assert.ok(verdict.structuralReasons.includes("raw baseColor mutant"));
  assert.ok(verdict.unscoredPredicates.includes("deckFreeGroundDimsByFactor"));
  assert.ok(!verdict.unscoredPredicates.includes("shadowContrastInvariant"));
  assert.equal(verdict.shadowContrastInvariant, true);
  assert.ok(
    verdict.unscoredPredicates.includes("shadowDecrementMatchesGroundDim"),
  );
});

test("K8b a 1.034 raw red survives deck-free blindness and INVALID cost", () => {
  const run = clone(passingRun());
  const deepest = run.cloudLanes.rungs.at(-1).shadow;
  Object.assign(deepest, {
    offNoShadow: 0.677968772411535,
    offShadow: 0.3794675752523887,
    onNoShadow: 0.3322938519156115,
    onShadow: 0.19233498224297316,
  });
  run.cloudLanes.deckFreeControl.litSurfaceNonVacuous = false;
  run.cloudLanes.deckFreeControl.nonVacuityReasons = [
    "fresh v3 raw-baseColor structural blind",
  ];
  run.iblWebGPU.refreshCost = freshCostAccounting({
    eclipseWallMs: 1861,
    controlWallMs: 2238.800000011921,
    eclipseFills: 273,
    controlFills: 1,
  });

  const verdict = judgeEclipseCloudResponse(run);
  assert.equal(verdict.shadowContrastRatioAtDeepest, 1.0341201343397566);
  assert.equal(verdict.shadowContrastInvariant, false);
  assert.deepEqual(verdict.failedPredicates, ["shadowContrastInvariant"]);
  assert.ok(
    verdict.structuralReasons.includes(
      "fresh v3 raw-baseColor structural blind",
    ),
  );
  assert.ok(!verdict.unscoredPredicates.includes("shadowContrastInvariant"));
  assert.ok(
    verdict.unscoredPredicates.includes("shadowDecrementMatchesGroundDim"),
  );
  assert.equal(verdict.refreshCostMeasured, false);
  assert.ok(verdict.unscoredPredicates.includes("refreshCostMeasured"));
  assert.match(verdict.cost.invalidReasons[0], /differential is negative/);
  assert.equal(
    verdict.exitCode,
    ECLIPSE_CLOUD_EXIT.FAIL,
    "the valid raw red must outrank both structural quarantines",
  );
});

test("K9 build identity compares every current source byte with sourcesContent", () => {
  const mapPath = path.join(root, "Build", "CesiumUnminified", "index.js.map");
  const sourceFile = path.join(root, "packages", "engine", "Source", "X.js");
  const exactMap = {
    sources: ["../../packages/engine/Source/X.js"],
    sourcesContent: ["export const marker = 1;\n"],
  };
  const exact = compareBuildSourceIdentity({
    sourceMap: exactMap,
    sourceMapPath: mapPath,
    sources: [{ file: sourceFile, bytes: "export const marker = 1;\n" }],
  });
  assert.equal(exact.ok, true);
  assert.equal(exact.entries[0].exact, true);

  const stale = compareBuildSourceIdentity({
    sourceMap: exactMap,
    sourceMapPath: mapPath,
    // The marker survives; one unrelated byte changes. Marker-only provenance
    // would pass this mutant, exact source/build identity must not.
    sources: [
      { file: sourceFile, bytes: "export const marker = 1; // edit\n" },
    ],
  });
  assert.equal(stale.ok, false);
  assert.match(stale.reasons[0], /differ from built sourcesContent/);

  const missingContent = compareBuildSourceIdentity({
    sourceMap: { sources: exactMap.sources },
    sourceMapPath: mapPath,
    sources: [{ file: sourceFile, bytes: "export const marker = 1;\n" }],
  });
  assert.equal(missingContent.ok, false);
  assert.match(missingContent.reasons.join("\n"), /no embedded sourcesContent/);
});

test("K10 every fresh-session factor is finite, replicated, and bound to the schedule-certified rung", () => {
  const fixture = () => {
    const run = passingRun();
    const ladder = run.cloudLanes.rungs.map(
      ({ target, iso, scheduledObscuration }) => ({
        target,
        iso,
        obscuration: scheduledObscuration,
      }),
    );
    const sessions = freshDeckFreeSessions(run.cloudLanes.rungs);
    const fold = (reports = sessions, certifiedRungs = run.cloudLanes.rungs) =>
      foldDeckFreeControlSessions({
        sessions: reports,
        ladder,
        certifiedRungs,
        factorTolerance: ECLIPSE_CLOUD_BANDS.factorTolerance.hi,
        scheduleObscurationTolerance:
          ECLIPSE_CLOUD_BANDS.scheduleObscurationTolerance.hi,
        captureDelta: BAND_MEAN_CAPTURE_DELTA,
        diagnosticSite: DECK_FREE_DIAGNOSTIC_SITE,
      });
    return { run, sessions, fold };
  };

  const passing = fixture();
  assert.equal(passing.fold().stateIsolated, true);
  assert.equal(
    passing.fold().rungs[3].factorEvidence.certifiedMainPage,
    predictFactor(SWEEP_PEAK_OBSCURATION),
  );

  for (const sessionIndex of [0, 3]) {
    for (let rungIndex = 0; rungIndex < 4; rungIndex++) {
      const { sessions, fold } = fixture();
      sessions[sessionIndex].rungs[rungIndex].factor = 1 - 1e-12;
      const verdict = fold();
      assert.equal(verdict.stateIsolated, false);
      assert.match(
        verdict.isolationReasons.join("\n"),
        new RegExp(`rung ${rungIndex} eclipse-OFF factor.*exactly 1`),
      );

      const nested = fixture();
      nested.sessions[sessionIndex].rungs[rungIndex].lighting.factor =
        1 - 1e-12;
      const nestedVerdict = nested.fold();
      assert.equal(nestedVerdict.stateIsolated, false);
      assert.match(
        nestedVerdict.isolationReasons.join("\n"),
        new RegExp(`rung ${rungIndex} eclipse-OFF lighting factor.*exactly 1`),
      );
    }
  }

  for (const sessionIndex of [1, 2]) {
    for (let rungIndex = 0; rungIndex < 4; rungIndex++) {
      const { sessions, fold } = fixture();
      sessions[sessionIndex].rungs[rungIndex].factor = Number.NaN;
      assert.match(
        fold().isolationReasons.join("\n"),
        new RegExp(`rung ${rungIndex} eclipse-ON factor is not finite`),
      );

      const mismatch = fixture();
      mismatch.sessions[sessionIndex].rungs[rungIndex].factor += 2e-9;
      assert.match(
        mismatch.fold().isolationReasons.join("\n"),
        new RegExp(`rung ${rungIndex} factor .* does not match certified`),
      );

      const nestedFinite = fixture();
      nestedFinite.sessions[sessionIndex].rungs[rungIndex].lighting.factor =
        Number.NaN;
      assert.match(
        nestedFinite.fold().isolationReasons.join("\n"),
        new RegExp(
          `rung ${rungIndex} lighting factor null does not match certified`,
        ),
      );
    }
  }

  const replication = fixture();
  replication.sessions[1].rungs[2].factor += 0.75e-9;
  replication.sessions[2].rungs[2].factor -= 0.75e-9;
  assert.match(
    replication.fold().isolationReasons.join("\n"),
    /rung 2: eclipse-ON fresh-session factors do not replicate/,
  );

  // Adversarial tolerance chain: both primaries remain <= 1e-9 from the
  // certification and both nested readbacks remain <= 1e-9 from their primary,
  // but the nested factors are 1.5e-9 from the certification. Only a DIRECT
  // nested -> certified comparison rejects this construction.
  const nestedCertification = fixture();
  const certifiedFactor =
    nestedCertification.run.cloudLanes.rungs[2].deckFreePublished.factor;
  for (const sessionIndex of [1, 2]) {
    const rung = nestedCertification.sessions[sessionIndex].rungs[2];
    rung.factor = certifiedFactor + 0.75e-9;
    rung.lighting.factor = certifiedFactor + 1.5e-9;
  }
  const nestedCertificationVerdict = nestedCertification.fold();
  assert.equal(nestedCertificationVerdict.stateIsolated, false);
  assert.match(
    nestedCertificationVerdict.isolationReasons.join("\n"),
    /rung 2 lighting factor .* does not match certified main-page factor/,
  );
  assert.doesNotMatch(
    nestedCertificationVerdict.isolationReasons.join("\n"),
    /nested lighting factors do not replicate/,
  );

  // The inverse construction: each nested factor is independently within
  // 1e-9 of the certification, but ON-A and ON-B are 1.5e-9 apart. Direct
  // nested replication must reject it even though both primaries are exact.
  const nestedReplication = fixture();
  nestedReplication.sessions[1].rungs[2].lighting.factor =
    certifiedFactor + 0.75e-9;
  nestedReplication.sessions[2].rungs[2].lighting.factor =
    certifiedFactor - 0.75e-9;
  const nestedReplicationVerdict = nestedReplication.fold();
  assert.equal(nestedReplicationVerdict.stateIsolated, false);
  assert.match(
    nestedReplicationVerdict.isolationReasons.join("\n"),
    /rung 2: eclipse-ON nested lighting factors do not replicate/,
  );
  assert.doesNotMatch(
    nestedReplicationVerdict.isolationReasons.join("\n"),
    /lighting factor .* does not match certified main-page factor/,
  );

  const wrongGeometry = fixture();
  wrongGeometry.sessions[1].rungs[2].cameraHeight = 1399;
  assert.match(
    wrongGeometry.fold().isolationReasons.join("\n"),
    /measurement factor is not bound to the certified lane-B camera height/,
  );

  const uncertified = fixture();
  const certified = clone(uncertified.run.cloudLanes.rungs);
  certified[1].published.factor = null;
  assert.match(
    uncertified
      .fold(uncertified.sessions, certified)
      .isolationReasons.join("\n"),
    /certified main-page factor is not finite/,
  );

  for (const [field, message] of [
    ["valid", /certified main-page eclipse state is not valid/],
    ["enabled", /certified main-page eclipse state is not enabled/],
  ]) {
    const mutant = fixture();
    const mutantCertified = clone(mutant.run.cloudLanes.rungs);
    mutantCertified[2].published[field] = false;
    const folded = mutant.fold(mutant.sessions, mutantCertified);
    assert.equal(folded.stateIsolated, false);
    assert.match(folded.isolationReasons.join("\n"), message);

    const judgedRun = passingRun();
    judgedRun.cloudLanes.rungs[2].published[field] = false;
    const judged = judgeEclipseCloudResponse(judgedRun);
    assert.equal(judged.mainPageScheduleCertified, false);
    assert.match(judged.structuralReasons.join("\n"), /schedule certification/);
  }

  const drift = fixture();
  const driftedCertified = clone(drift.run.cloudLanes.rungs);
  const driftedPublished = driftedCertified[1].published;
  driftedPublished.moonObscuration +=
    ECLIPSE_CLOUD_BANDS.scheduleObscurationTolerance.hi * 2;
  // Keep the old self-consistency check green: only the new schedule binding
  // can reject a branch that moved obscuration and its factor together.
  driftedPublished.factor = predictFactor(driftedPublished.moonObscuration);
  const driftedFold = drift.fold(drift.sessions, driftedCertified);
  assert.equal(driftedFold.stateIsolated, false);
  assert.match(
    driftedFold.isolationReasons.join("\n"),
    /certified main-page obscuration .* drifted from scheduled/,
  );

  const deckFreeDrift = fixture();
  const deckFreeDriftedCertified = clone(deckFreeDrift.run.cloudLanes.rungs);
  const deckFreeDrifted = deckFreeDriftedCertified[3].deckFreePublished;
  deckFreeDrifted.moonObscuration +=
    ECLIPSE_CLOUD_BANDS.scheduleObscurationTolerance.hi * 2;
  deckFreeDrifted.factor = predictFactor(deckFreeDrifted.moonObscuration);
  const deckFreeDriftedFold = deckFreeDrift.fold(
    deckFreeDrift.sessions,
    deckFreeDriftedCertified,
  );
  assert.equal(deckFreeDriftedFold.stateIsolated, false);
  assert.match(
    deckFreeDriftedFold.isolationReasons.join("\n"),
    /deck-free main-page obscuration .* drifted from scheduled/,
  );

  const judgedDrift = passingRun();
  const judgedPublished = judgedDrift.cloudLanes.rungs[1].published;
  judgedPublished.moonObscuration +=
    ECLIPSE_CLOUD_BANDS.scheduleObscurationTolerance.hi * 2;
  judgedPublished.factor = predictFactor(judgedPublished.moonObscuration);
  const driftVerdict = judgeEclipseCloudResponse(judgedDrift);
  assert.equal(driftVerdict.mainPageScheduleCertified, false);
  assert.match(
    driftVerdict.structuralReasons.join("\n"),
    /drifted from scheduled/,
  );
});

test("K11 baseColor, fade, and exact light classes are read back on every fresh control rung", () => {
  const run = passingRun();
  const ladder = run.cloudLanes.rungs.map(
    ({ target, iso, scheduledObscuration }) => ({
      target,
      iso,
      obscuration: scheduledObscuration,
    }),
  );
  const fold = (sessions, diagnosticSite = DECK_FREE_DIAGNOSTIC_SITE) =>
    foldDeckFreeControlSessions({
      sessions,
      ladder,
      certifiedRungs: run.cloudLanes.rungs,
      factorTolerance: ECLIPSE_CLOUD_BANDS.factorTolerance.hi,
      scheduleObscurationTolerance:
        ECLIPSE_CLOUD_BANDS.scheduleObscurationTolerance.hi,
      captureDelta: BAND_MEAN_CAPTURE_DELTA,
      diagnosticSite,
    });

  const topLevelColor = freshDeckFreeSessions(run.cloudLanes.rungs);
  topLevelColor[0].baseColor[0] = 0;
  assert.match(
    fold(topLevelColor).isolationReasons.join("\n"),
    /baseColor is not pinned/,
  );

  const rungColor = freshDeckFreeSessions(run.cloudLanes.rungs);
  rungColor[2].rungs[3].baseColor[2] = 0;
  assert.match(
    fold(rungColor).isolationReasons.join("\n"),
    /rung 3 baseColor is not pinned/,
  );

  const unlit = freshDeckFreeSessions(run.cloudLanes.rungs);
  unlit[1].rungs[0].enableLighting = false;
  assert.match(
    fold(unlit).isolationReasons.join("\n"),
    /rung 0 globe lighting is not enabled/,
  );

  const unlitReadback = freshDeckFreeSessions(run.cloudLanes.rungs);
  unlitReadback[1].rungs[0].lighting.enableLighting = false;
  assert.match(
    fold(unlitReadback).isolationReasons.join("\n"),
    /rung 0 lighting read-back does not match/,
  );

  const invalidState = freshDeckFreeSessions(run.cloudLanes.rungs);
  invalidState[2].rungs[1].lighting.eclipseStateValid = false;
  assert.match(
    fold(invalidState).isolationReasons.join("\n"),
    /rung 1 lighting read-back does not match/,
  );

  const globeShadowEnabled = freshDeckFreeSessions(run.cloudLanes.rungs);
  globeShadowEnabled[0].rungs[2].lighting.enableEclipseGlobeShadow = true;
  assert.match(
    fold(globeShadowEnabled).isolationReasons.join("\n"),
    /rung 2 lighting read-back does not match/,
  );

  const toggled = freshDeckFreeSessions(run.cloudLanes.rungs);
  toggled[3].rungs[1].lighting.eclipseStateEnabled = true;
  assert.match(
    fold(toggled).isolationReasons.join("\n"),
    /rung 1 lighting read-back does not match/,
  );

  assert.equal(DECK_FREE_LIGHTING_FADE_OUT_DISTANCE, 0);
  assert.equal(DECK_FREE_LIGHTING_FADE_IN_DISTANCE, 1);
  assert.equal(DECK_FREE_EXPECTED_LIGHTING_FADE, 1);
  assert.equal(computeDeckFreeLightingFade(6_362_245, 0, 1), 1);
  assert.equal(computeDeckFreeLightingFade(6_362_245, 1, 1), null);

  const missingTopLevelFade = freshDeckFreeSessions(run.cloudLanes.rungs);
  delete missingTopLevelFade[0].lighting.lightingFade;
  assert.match(
    fold(missingTopLevelFade).isolationReasons.join("\n"),
    /top-level lighting fade is not the live probe pin/,
  );

  const wrongFadePin = freshDeckFreeSessions(run.cloudLanes.rungs);
  wrongFadePin[1].rungs[2].lighting.lightingFade.outDistance = 1;
  assert.match(
    fold(wrongFadePin).isolationReasons.join("\n"),
    /rung 2 lighting fade is not the live probe pin/,
  );

  const zeroSpan = freshDeckFreeSessions(run.cloudLanes.rungs);
  zeroSpan[2].rungs[1].lighting.lightingFade.inDistance = 0;
  assert.match(
    fold(zeroSpan).isolationReasons.join("\n"),
    /rung 1 lighting fade is not the live probe pin/,
  );

  const fabricatedFade = freshDeckFreeSessions(run.cloudLanes.rungs);
  fabricatedFade[3].rungs[3].lighting.lightingFade.cameraDistance = 0.5;
  fabricatedFade[3].rungs[3].lighting.lightingFade.expectedFade = 1;
  assert.match(
    fold(fabricatedFade).isolationReasons.join("\n"),
    /rung 3 lighting fade is not the live probe pin/,
  );

  assert.deepEqual(DECK_FREE_DIAGNOSTIC_NDOTL_TARGETS, [0, 0.04, 0.08, 0.12]);
  assert.deepEqual(
    DECK_FREE_DIAGNOSTIC_NDOTL_TARGETS.map((ndotl) =>
      Number(computeDeckFreeDayNightDiffuse(ndotl, 1).toFixed(1)),
    ),
    [0.3, 0.5, 0.7, 0.9],
  );
  assert.equal(computeDeckFreeDayNightDiffuse(0.5, 1), 1);
  assert.equal(computeDeckFreeDayNightDiffuse(0, 0), 1);

  // The independent canvas-luma oracle includes the additive terminator glow
  // that follows the shared DAYNIGHT multiply. Pin both the
  // oracle constants and their product-source counterparts so neither side can
  // drift into another self-consistent false red.
  assert.deepEqual(DECK_FREE_TERMINATOR_GLOW_COLOR, [0.95, 0.45, 0.15]);
  assert.equal(DECK_FREE_TERMINATOR_GLOW_EXPONENT, 40);
  assert.equal(DECK_FREE_TERMINATOR_GLOW_STRENGTH, 0.15);
  assert.equal(DECK_FREE_DEFAULT_TERMINATOR_GLOW_STRENGTH, 0);
  assert.equal(DECK_FREE_DIAGNOSTIC_TERMINATOR_GLOW_STRENGTH, 1);
  assert.deepEqual(
    DECK_FREE_DIAGNOSTIC_NDOTL_TARGETS.map((ndotl) =>
      Number(
        computeDeckFreeDirectionalDiagnosticLuma(
          ndotl,
          DECK_FREE_EXPECTED_LIGHTING_FADE,
          DECK_FREE_DIAGNOSTIC_TERMINATOR_GLOW_STRENGTH,
        ).toFixed(6),
      ),
    ),
    [0.31549, 0.467381, 0.611103, 0.750964],
  );
  assert.equal(
    computeDeckFreeTerminatorGlowLuma(
      Number.NaN,
      DECK_FREE_DIAGNOSTIC_TERMINATOR_GLOW_STRENGTH,
    ),
    null,
  );
  assert.equal(
    computeDeckFreeDirectionalDiagnosticLuma(
      Number.NaN,
      DECK_FREE_EXPECTED_LIGHTING_FADE,
      DECK_FREE_DIAGNOSTIC_TERMINATOR_GLOW_STRENGTH,
    ),
    null,
  );
  const globeTerrain = readEngine("Shaders/WebGPU/Globe/GlobeTerrain.wgsl");
  assert.match(
    globeTerrain,
    /let terminatorFactor = exp\(-NdotL \* NdotL \* 40\.0\);/,
  );
  assert.match(
    globeTerrain,
    /let warmColor = vec3<f32>\(0\.95, 0\.45, 0\.15\);/,
  );
  assert.match(globeTerrain, /return warmColor \* terminatorFactor \* 0\.15;/);
  assert.match(
    globeTerrain,
    /let terminatorGlowStrength = max\(tile\.tileControls\.z, 0\.0\);/,
  );
  assert.match(
    globeTerrain,
    /if \(terminatorGlowStrength > 0\.0\) \{[\s\S]*?computeTerminatorGlow\(dayNightNormalEC, sunDir\) \*[\s\S]*?terminatorGlowStrength \*[\s\S]*?eclipseAbsolute;/,
  );
  const globeSource = readEngine("Scene/Globe.js");
  assert.match(globeSource, /this\.terminatorGlowStrength = 0\.0;/);
  assert.match(
    globeSource,
    /tileProvider\.terminatorGlowStrength =[\s\S]*?Math\.max\(terminatorGlowStrength, 0\.0\)[\s\S]*?: 0\.0;/,
  );
  assert.match(
    readEngine("Renderer/WebGPU/WebGPUGlobeSurfaceTileUB.ts"),
    /data\[TILE_CONTROLS_OFFSET \+ 2\] =\s*tileProvider\.terminatorGlowStrength \?\? 0\.0;/,
  );

  const wrongDirection = freshDeckFreeSessions(run.cloudLanes.rungs);
  wrongDirection[0].directionalDiagnosticRungs[1].light.scene.directionWC[0] += 0.01;
  assert.match(
    fold(wrongDirection).isolationReasons.join("\n"),
    /custom-light read-back is not the exact diagnostic DirectionalLight/,
  );

  const wrongClass = freshDeckFreeSessions(run.cloudLanes.rungs);
  wrongClass[1].directionalDiagnosticRungs[0].light = deckFreeLightReadback(
    "SunLight",
    false,
  );
  assert.match(
    fold(wrongClass).isolationReasons.join("\n"),
    /not the exact diagnostic DirectionalLight/,
  );

  const wrongIntensity = freshDeckFreeSessions(run.cloudLanes.rungs);
  wrongIntensity[2].directionalDiagnosticRungs[2].light.scene.intensity = 2;
  wrongIntensity[2].directionalDiagnosticRungs[2].light.frameState.intensity = 2;
  assert.match(
    fold(wrongIntensity).isolationReasons.join("\n"),
    /not the exact diagnostic DirectionalLight/,
  );

  const detachedFrameLight = freshDeckFreeSessions(run.cloudLanes.rungs);
  detachedFrameLight[3].directionalDiagnosticRungs[3].light.sameObject = false;
  assert.match(
    fold(detachedFrameLight).isolationReasons.join("\n"),
    /not the exact diagnostic DirectionalLight/,
  );

  const missingTopLevelSun = freshDeckFreeSessions(run.cloudLanes.rungs);
  missingTopLevelSun[0].light = null;
  assert.match(
    fold(missingTopLevelSun).isolationReasons.join("\n"),
    /top-level light read-back is not a restored fresh SunLight/,
  );

  const missingGlowControl = freshDeckFreeSessions(run.cloudLanes.rungs);
  delete missingGlowControl[0].terminatorGlow;
  assert.match(
    fold(missingGlowControl).isolationReasons.join("\n"),
    /terminator-glow control is absent/,
  );

  const wrongDiagnosticGlowStrength = freshDeckFreeSessions(
    run.cloudLanes.rungs,
  );
  wrongDiagnosticGlowStrength[1].directionalDiagnosticRungs[2].terminatorGlowStrength = 0;
  assert.match(
    fold(wrongDiagnosticGlowStrength).isolationReasons.join("\n"),
    /diagnostic terminator-glow strength/,
  );

  const failedGlowRestore = freshDeckFreeSessions(run.cloudLanes.rungs);
  failedGlowRestore[2].rungs[1].terminatorGlowStrength =
    DECK_FREE_DIAGNOSTIC_TERMINATOR_GLOW_STRENGTH;
  failedGlowRestore[2].terminatorGlow.publicStrength =
    DECK_FREE_DIAGNOSTIC_TERMINATOR_GLOW_STRENGTH;
  failedGlowRestore[2].terminatorGlow.tileProviderStrength =
    DECK_FREE_DIAGNOSTIC_TERMINATOR_GLOW_STRENGTH;
  const failedRestoreReasons =
    fold(failedGlowRestore).isolationReasons.join("\n");
  assert.match(failedRestoreReasons, /scored Sun capture did not restore/);
  assert.match(failedRestoreReasons, /was not restored exactly/);

  // Coherent mutant: a contaminated fresh context starts at strength one and
  // faithfully "restores" every scored/top-level readback to one. Equality to
  // an arbitrary prior cannot satisfy the product's exact default-zero rule.
  const nonzeroPrior = freshDeckFreeSessions(run.cloudLanes.rungs);
  const contaminatedSession = nonzeroPrior[0];
  contaminatedSession.terminatorGlow.priorStrength =
    DECK_FREE_DIAGNOSTIC_TERMINATOR_GLOW_STRENGTH;
  contaminatedSession.terminatorGlow.publicStrength =
    DECK_FREE_DIAGNOSTIC_TERMINATOR_GLOW_STRENGTH;
  contaminatedSession.terminatorGlow.tileProviderStrength =
    DECK_FREE_DIAGNOSTIC_TERMINATOR_GLOW_STRENGTH;
  for (const rung of contaminatedSession.rungs) {
    rung.terminatorGlowStrength = DECK_FREE_DIAGNOSTIC_TERMINATOR_GLOW_STRENGTH;
    rung.terminatorGlowTileProviderStrength =
      DECK_FREE_DIAGNOSTIC_TERMINATOR_GLOW_STRENGTH;
  }
  const nonzeroPriorVerdict = fold(nonzeroPrior);
  assert.equal(nonzeroPriorVerdict.stateIsolated, false);
  assert.match(
    nonzeroPriorVerdict.isolationReasons.join("\n"),
    /prior\/default strength is not exactly 0/,
  );

  const staleDirectionalAtScore = freshDeckFreeSessions(run.cloudLanes.rungs);
  const staleFrame = computeDeckFreeDiagnosticFrame(
    DECK_FREE_DIAGNOSTIC_SITE.latitudeDegrees,
    DECK_FREE_DIAGNOSTIC_SITE.longitudeDegrees,
    DECK_FREE_DIAGNOSTIC_NDOTL_TARGETS[0],
    DECK_FREE_DIAGNOSTIC_TERMINATOR_GLOW_STRENGTH,
  );
  staleDirectionalAtScore[1].rungs[0].light = deckFreeLightReadback(
    "DirectionalLight",
    true,
    staleFrame.emittedDirectionWC,
  );
  assert.match(
    fold(staleDirectionalAtScore).isolationReasons.join("\n"),
    /did not restore and render a fresh SunLight before scoring/,
  );

  const wrongSequence = freshDeckFreeSessions(run.cloudLanes.rungs);
  wrongSequence[2].captureSequence = "directional-only";
  assert.match(
    fold(wrongSequence).isolationReasons.join("\n"),
    /capture sequence does not isolate/,
  );

  const wrongSite = freshDeckFreeSessions(run.cloudLanes.rungs);
  assert.match(
    fold(wrongSite, {
      latitudeDegrees: DECK_FREE_DIAGNOSTIC_SITE.latitudeDegrees,
      longitudeDegrees: DECK_FREE_DIAGNOSTIC_SITE.longitudeDegrees + 1,
    }).isolationReasons.join("\n"),
    /directional vector or DAYNIGHT prediction/,
  );

  const fabricatedPrediction = freshDeckFreeSessions(run.cloudLanes.rungs);
  fabricatedPrediction[0].directionalDiagnosticRungs[0].directionSpec.expectedDiffuse = 0.31;
  assert.match(
    fold(fabricatedPrediction).isolationReasons.join("\n"),
    /directional vector or DAYNIGHT prediction/,
  );

  // The in-page Cartesian implementation normalizes before taking the dot.
  // Accept its mathematically equivalent f64 reconstruction of the 0.08 rung.
  const realCartesianRoundoff = freshDeckFreeSessions(run.cloudLanes.rungs);
  const roundedDirection =
    realCartesianRoundoff[0].directionalDiagnosticRungs[2].directionSpec;
  roundedDirection.ndotl = 0.07999999999999997;
  roundedDirection.expectedDiffuse = 0.6999999999999998;
  assert.equal(fold(realCartesianRoundoff).stateIsolated, true);

  const missingDiagnostics = freshDeckFreeSessions(run.cloudLanes.rungs);
  missingDiagnostics[0].directionalDiagnosticRungs = [];
  assert.match(
    fold(missingDiagnostics).isolationReasons.join("\n"),
    /expected 4 directional diagnostic captures/,
  );
});

test("K12 every expected fresh context must serve the exact local runtime entry", () => {
  const expectedLabels = ["derive", "cloud", "off-a", "on-a"];
  const localEntry = {
    exists: true,
    byteLength: 7,
    sha256: "a".repeat(64),
  };
  const entries = expectedLabels.map((sessionLabel) => ({
    sessionLabel,
    ok: true,
    status: 200,
    byteLength: localEntry.byteLength,
    sha256: localEntry.sha256,
  }));
  const validate = (candidate) =>
    validateServedEntryIdentities({
      entries: candidate,
      expectedLabels,
      localEntry,
    });

  assert.equal(validate(entries).ok, true);

  const missing = entries.slice(1);
  assert.equal(validate(missing).ok, false);
  assert.match(
    validate(missing).reasons.join("\n"),
    /derive: expected exactly one/,
  );

  const duplicate = [...entries, entries[0]];
  assert.match(
    validate(duplicate).reasons.join("\n"),
    /derive: expected exactly one.*received 2/,
  );

  const stale = clone(entries);
  stale[2].sha256 = "b".repeat(64);
  assert.match(
    validate(stale).reasons.join("\n"),
    /off-a: served runtime entry differs from the local start entry/,
  );

  const failedFetch = clone(entries);
  failedFetch[3].ok = false;
  failedFetch[3].status = 404;
  assert.match(
    validate(failedFetch).reasons.join("\n"),
    /on-a: served runtime entry returned 404/,
  );
});

test("K13 start/end local source-map-probe-policy identity fails on any byte drift", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "c13-41-identity-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source.js");
  const policy = path.join(directory, "policy.mjs");
  fs.writeFileSync(source, "source-a\n");
  fs.writeFileSync(policy, "policy-a\n");
  const files = { source, sourceMap: source, probe: policy, policy };
  const start = snapshotEvidenceFiles(files);
  assert.equal(
    compareEvidenceFileSnapshots(start, snapshotEvidenceFiles(files)).ok,
    true,
  );

  fs.writeFileSync(policy, "policy-b\n");
  const drifted = compareEvidenceFileSnapshots(
    start,
    snapshotEvidenceFiles(files),
  );
  assert.equal(drifted.ok, false);
  assert.match(
    drifted.reasons.join("\n"),
    /probe: local evidence bytes changed/,
  );
  assert.match(
    drifted.reasons.join("\n"),
    /policy: local evidence bytes changed/,
  );

  const missing = compareEvidenceFileSnapshots(start, {
    ...snapshotEvidenceFiles(files),
    sourceMap: fingerprintEvidenceFile(path.join(directory, "absent.map")),
  });
  assert.match(
    missing.reasons.join("\n"),
    /sourceMap: required local evidence file is absent/,
  );
});

test("K14 canonical, immutable archive, and first-red lifecycle is fail-closed", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "c13-41-artifact-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const canonical = path.join(directory, "canonical.json");
  const archive = path.join(directory, "run-id.json");
  const firstRed = path.join(directory, "first-red.json");

  fs.writeFileSync(canonical, "RUNNING\n");
  atomicReplaceEvidence(canonical, "PASS\n");
  assert.equal(fs.readFileSync(canonical, "utf8"), "PASS\n");

  createImmutableEvidence(archive, "immutable\n");
  assert.throws(
    () => createImmutableEvidence(archive, "mutant\n"),
    (error) => error?.code === "EEXIST",
  );
  assert.equal(fs.readFileSync(archive, "utf8"), "immutable\n");

  const first = preserveFirstRedEvidence(firstRed, "red-a\n");
  const second = preserveFirstRedEvidence(firstRed, "red-b\n");
  assert.equal(first.written, true);
  assert.equal(second.written, false);
  assert.equal(fs.readFileSync(firstRed, "utf8"), "red-a\n");

  assert.doesNotThrow(() =>
    assertEvidenceReadableOrAbsent(
      { exists: false, error: "ENOENT" },
      "legitimately absent evidence",
    ),
  );
  for (const error of ["EACCES", "EISDIR", "SYNTHETIC_READ_FAILURE"]) {
    assert.throws(
      () =>
        assertEvidenceReadableOrAbsent(
          { exists: false, error },
          "prior canonical artifact",
        ),
      /integrity is unverifiable/,
    );
  }
  assert.throws(
    () =>
      assertEvidenceReadableOrAbsent(
        { exists: true, byteLength: 12, sha256: null },
        "malformed evidence",
      ),
    /fingerprint is malformed/,
  );
  assert.throws(
    () =>
      assertEvidenceReadableOrAbsent(
        { exists: true, byteLength: 0, sha256: "0".repeat(64) },
        "empty evidence",
      ),
    /fingerprint is malformed/,
  );

  const existingOperations = {
    writeFileSync() {
      const error = new Error("synthetic EEXIST");
      error.code = "EEXIST";
      throw error;
    },
  };
  assert.throws(
    () =>
      preserveFirstRedEvidence(
        "synthetic-first-red.json",
        "red\n",
        existingOperations,
        () => ({ exists: false, error: "EACCES" }),
      ),
    /retained first-red artifact integrity is unverifiable/,
  );

  let temporaryCleaned = false;
  const operations = {
    writeFileSync(_file, _bytes, options) {
      assert.equal(options.flag, "wx");
    },
    renameSync() {
      throw new Error("rename mutant");
    },
    unlinkSync() {
      temporaryCleaned = true;
    },
  };
  assert.throws(
    () => atomicReplaceEvidence("synthetic.json", "new\n", operations),
    /rename mutant/,
  );
  assert.equal(temporaryCleaned, true);
});

test("K14b owned RUNNING invalidates stale PASS before fallible preflight and release", (t) => {
  const rootDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "c13-41-owned-lifecycle-"),
  );
  t.after(() => fs.rmSync(rootDirectory, { recursive: true, force: true }));
  const makePaths = (caseName, runId) => {
    const directory = path.join(rootDirectory, caseName);
    fs.mkdirSync(directory, { recursive: true });
    return {
      directory,
      canonical: path.join(directory, "canonical.json"),
      firstRed: path.join(directory, "first-red.json"),
      preLifecycle: path.join(directory, "pre-lifecycle.json"),
      lock: path.join(directory, "run.lock"),
      run: path.join(directory, `run-${runId}.json`),
      priorQuarantine: path.join(directory, `prior-${runId}.json`),
      archiveForRunId(priorRunId) {
        return path.join(directory, `run-${priorRunId}.json`);
      },
    };
  };
  const runningMarker = (runId) => ({
    schema: "c13-41-eclipse-cloud-response-v3",
    runId,
    status: "RUNNING",
    incomplete: true,
  });
  const finalArtifact = (runId, status = "ERROR") => ({
    schema: "c13-41-eclipse-cloud-response-v3",
    runId,
    status,
    incomplete: false,
    exitCode: status === "PASS" ? 0 : 2,
  });

  // A failure after ownership publication cannot leave the seeded PASS as the
  // public claim. This is the exact preflight-throw ordering regression.
  {
    const runId = "123e4567-e89b-42d3-a456-426614174001";
    const paths = makePaths("preflight-throw", runId);
    fs.writeFileSync(
      paths.canonical,
      `${JSON.stringify({ status: "PASS", incomplete: false })}\n`,
    );
    acquireC1341RunLock(paths, runId);
    const prior = captureC1341PriorCanonical(paths.canonical);
    assertNoPriorC1341Running(prior);
    publishC1341Running(paths, runningMarker(runId));
    assert.equal(
      JSON.parse(fs.readFileSync(paths.canonical)).status,
      "RUNNING",
    );
    try {
      throw new Error("synthetic post-RUNNING preflight failure");
    } catch (error) {
      assert.match(error.message, /preflight failure/);
      finalizeC1341Evidence(paths, finalArtifact(runId));
    }
    assert.equal(JSON.parse(fs.readFileSync(paths.canonical)).status, "ERROR");
    assert.equal(fs.existsSync(paths.lock), false);
    assert.deepEqual(
      fs.readFileSync(paths.canonical),
      fs.readFileSync(paths.run),
    );
  }

  // A previous RUNNING belongs to its original invocation and is never
  // overwritten merely because another process acquired a different lock.
  {
    const runId = "123e4567-e89b-42d3-a456-426614174002";
    const paths = makePaths("prior-running", runId);
    const priorBytes = `${JSON.stringify({ runId: "prior", status: "RUNNING", incomplete: true })}\n`;
    fs.writeFileSync(paths.canonical, priorBytes);
    acquireC1341RunLock(paths, runId);
    assert.throws(
      () =>
        assertNoPriorC1341Running(captureC1341PriorCanonical(paths.canonical)),
      /previous RUNNING marker/,
    );
    assert.equal(fs.readFileSync(paths.canonical, "utf8"), priorBytes);
    releaseC1341RunLock(paths, runId);
  }

  // Malformed readable prior bytes are quarantined only after RUNNING has
  // invalidated them, and the caught error can then finalize as ERROR.
  {
    const runId = "123e4567-e89b-42d3-a456-426614174003";
    const paths = makePaths("malformed-prior", runId);
    fs.writeFileSync(paths.canonical, "{malformed\n");
    acquireC1341RunLock(paths, runId);
    const prior = captureC1341PriorCanonical(paths.canonical);
    publishC1341Running(paths, runningMarker(runId));
    assert.throws(
      () => prepareCapturedCanonicalForRun(prior, paths),
      /exact bytes quarantined/,
    );
    assert.equal(
      fs.readFileSync(paths.priorQuarantine, "utf8"),
      "{malformed\n",
    );
    finalizeC1341Evidence(paths, finalArtifact(runId));
    assert.equal(JSON.parse(fs.readFileSync(paths.canonical)).status, "ERROR");
  }

  // Empty is corrupt evidence, not absence. It is still a readable exact byte
  // sequence, so preserve its zero length and SHA before finalizing ERROR.
  {
    const runId = "123e4567-e89b-42d3-a456-426614174006";
    const paths = makePaths("zero-byte-prior", runId);
    fs.writeFileSync(paths.canonical, "");
    acquireC1341RunLock(paths, runId);
    const prior = captureC1341PriorCanonical(paths.canonical);
    assert.equal(prior.canonical.exists, true);
    assert.equal(prior.canonical.byteLength, 0);
    publishC1341Running(paths, runningMarker(runId));
    assert.equal(
      JSON.parse(fs.readFileSync(paths.canonical)).status,
      "RUNNING",
    );
    assert.throws(
      () => prepareCapturedCanonicalForRun(prior, paths),
      /exact bytes quarantined/,
    );
    const quarantined = fingerprintEvidenceFile(paths.priorQuarantine);
    assert.equal(quarantined.exists, true);
    assert.equal(quarantined.byteLength, 0);
    assert.equal(quarantined.sha256, prior.canonical.sha256);
    finalizeC1341Evidence(paths, finalArtifact(runId));
    assert.equal(JSON.parse(fs.readFileSync(paths.canonical)).status, "ERROR");
    assert.equal(fs.existsSync(paths.lock), false);
  }

  // Final evidence cannot remain visible if lock release fails. The exact
  // owned RUNNING marker is restored and the lock remains for investigation.
  {
    const runId = "123e4567-e89b-42d3-a456-426614174004";
    const paths = makePaths("release-failure", runId);
    acquireC1341RunLock(paths, runId);
    publishC1341Running(paths, runningMarker(runId));
    const operations = {
      readFileSync: fs.readFileSync,
      writeFileSync: fs.writeFileSync,
      renameSync: fs.renameSync,
      unlinkSync(file) {
        if (path.resolve(file) === path.resolve(paths.lock)) {
          throw new Error("synthetic lock release failure");
        }
        fs.unlinkSync(file);
      },
    };
    assert.throws(
      () =>
        finalizeC1341Evidence(paths, finalArtifact(runId, "PASS"), operations),
      /owned RUNNING marker restored/,
    );
    assert.equal(
      JSON.parse(fs.readFileSync(paths.canonical)).status,
      "RUNNING",
    );
    assert.equal(fs.existsSync(paths.lock), true);
    releaseC1341RunLock(paths, runId);
  }

  // A verification failure after the final bytes replace RUNNING has the same
  // rollback contract as a failed lock release.
  {
    const runId = "123e4567-e89b-42d3-a456-426614174005";
    const paths = makePaths("post-replace-read-failure", runId);
    acquireC1341RunLock(paths, runId);
    publishC1341Running(paths, runningMarker(runId));
    let canonicalReads = 0;
    const operations = {
      readFileSync(file, ...args) {
        if (path.resolve(file) === path.resolve(paths.canonical)) {
          canonicalReads++;
          if (canonicalReads === 2) {
            const error = new Error("synthetic post-replace read failure");
            error.code = "EACCES";
            throw error;
          }
        }
        return fs.readFileSync(file, ...args);
      },
      writeFileSync: fs.writeFileSync,
      renameSync: fs.renameSync,
      unlinkSync: fs.unlinkSync,
    };
    assert.throws(
      () =>
        finalizeC1341Evidence(paths, finalArtifact(runId, "PASS"), operations),
      /owned RUNNING marker restored/,
    );
    assert.equal(
      JSON.parse(fs.readFileSync(paths.canonical)).status,
      "RUNNING",
    );
    assert.equal(fs.existsSync(paths.lock), true);
    releaseC1341RunLock(paths, runId);
  }
});

test("K15 the probe lifecycle binds diagnostics, provenance, watchdog cleanup, and artifacts", () => {
  const probe = fs
    .readFileSync(path.join(here, "probe-eclipse-cloud-response.mjs"), "utf8")
    .replace(/\r\n/g, "\n");

  assert.match(probe, /ARTIFACT_SCHEMA = "c13-41-eclipse-cloud-response-v3"/);
  assert.match(probe, /runId: RUN_ID,\n\s*status: "RUNNING"/);
  assert.match(probe, /const status = structural \? "STRUCTURAL" : "ERROR"/);
  assert.match(probe, /startedAt: STARTED_AT/);
  assert.match(probe, /completedAt: new Date\(\)\.toISOString\(\)/);
  assert.match(
    probe,
    /createImmutableEvidence\(paths\.run, bytes, operations\)/,
  );
  assert.match(
    probe,
    /atomicReplaceEvidence\(paths\.canonical, bytes, operations\)/,
  );
  assert.match(
    probe,
    /preserveFirstRedEvidence\(\n\s*paths\.firstRed,\n\s*bytes,\n\s*operations/,
  );
  const archive = probe.indexOf(
    "createImmutableEvidence(paths.run, bytes, operations)",
  );
  const firstRed = probe.indexOf("preserveFirstRedEvidence(", archive);
  const canonicalFinal = probe.indexOf(
    "atomicReplaceEvidence(paths.canonical, bytes, operations)",
    firstRed,
  );
  assert.ok(
    archive >= 0 && archive < firstRed && firstRed < canonicalFinal,
    "immutable archive and first-red must land before canonical finalization",
  );
  assert.match(
    probe,
    /createImmutableEvidence\(paths\.preLifecycle, captured\.bytes, operations\)/,
  );
  assert.match(
    probe,
    /createImmutableEvidence\(paths\.priorQuarantine, captured\.bytes, operations\)/,
  );
  assert.match(probe, /previous RUNNING marker .* must be investigated/);
  assert.match(probe, /!publicationAttempted && runningMarkerPublished/);
  assert.match(
    probe,
    /assertEvidenceReadableOrAbsent\(canonical, "prior canonical artifact"\)/,
  );
  assert.match(
    probe,
    /assertEvidenceReadableOrAbsent\(firstRedAtStart, "prior first-red artifact"\)/,
  );
  assert.match(
    probe,
    /assertEvidenceReadableOrAbsent\([\s\S]*firstRedBeforeFinalize,[\s\S]*"first-red artifact before finalization"/,
  );

  const acquire = probe.indexOf("acquireC1341RunLock(LIFECYCLE_PATHS, RUN_ID)");
  const capture = probe.indexOf(
    "priorCanonicalCapture = captureC1341PriorCanonical(CANONICAL_ARTIFACT)",
  );
  const running = probe.indexOf("publishC1341Running(LIFECYCLE_PATHS, {");
  const priorValidation = probe.indexOf(
    "previousCanonicalAtStart = prepareCapturedCanonicalForRun(",
  );
  const localSnapshot = probe.indexOf(
    "startLocalIdentity = snapshotEvidenceFiles(LOCAL_EVIDENCE_FILES)",
  );
  assert.ok(
    acquire >= 0 &&
      acquire < capture &&
      capture < running &&
      running < priorValidation &&
      priorValidation < localSnapshot,
    "exclusive lock and owned RUNNING must precede every fallible preflight check",
  );
  assert.match(probe, /assertC1341RunningOwnership\(/);
  assert.match(probe, /releaseC1341RunLock\(/);
  assert.match(probe, /owned RUNNING marker restored/);

  assert.match(probe, /startLocalIdentity = snapshotEvidenceFiles/);
  assert.match(probe, /const endProvenance = provenance\(\)/);
  assert.match(probe, /compareEvidenceFileSnapshots/);
  assert.match(probe, /validateServedEntryIdentities/);
  assert.match(
    probe,
    /weatherPinPolicy: fileURLToPath\(\n\s*new URL\("\.\/lib\/weather-probe-pinning\.mjs", import\.meta\.url\),\n\s*\)/,
  );
  assert.match(
    probe,
    /cloudProbeHarness: fileURLToPath\(\n\s*new URL\("\.\/lib\/cloud-probe-harness\.mjs", import\.meta\.url\),\n\s*\)/,
  );
  assert.match(probe, /page\.on\("response", \(response\) =>/);
  assert.match(probe, /void response\.body\(\)\.then/);
  assert.match(probe, /sha256: sha256\(bytes\)/);
  assert.match(probe, /await import\("\/Build\/CesiumUnminified\/index\.js"\)/);

  const requiredGlowSources = [
    "packages/engine/Source/Scene/Globe.js",
    "packages/engine/Source/Scene/GlobeSurfaceTileProvider.js",
    "packages/engine/Source/Scene/GlobeSurfaceTileProviderRendering.js",
    "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTypes.ts",
    "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceShaders.ts",
    "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTileUB.ts",
    "packages/engine/Source/Shaders/GlobeFS.glsl",
    "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
    "packages/engine/Source/Shaders/GlobeFS.js",
    "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.js",
  ];
  const glowIdentityDeclarations = probe.match(
    /const SOURCE_FILES = \[[\s\S]*?const BUILD_SOURCE_IDENTITY_FILES = \[[\s\S]*?\n\];/,
  );
  assert.ok(
    glowIdentityDeclarations,
    "the source and build identity declarations must be present",
  );
  const validateGlowIdentityCoverage = (declarations) => {
    const missing = requiredGlowSources.filter(
      (file) => !declarations.includes(`"${file}"`),
    );
    return { ok: missing.length === 0, missing };
  };
  assert.deepEqual(validateGlowIdentityCoverage(glowIdentityDeclarations[0]), {
    ok: true,
    missing: [],
  });
  for (const file of requiredGlowSources) {
    const literal = `"${file}"`;
    const mutant = glowIdentityDeclarations[0].replace(
      literal,
      '"removed-glow-source"',
    );
    assert.deepEqual(
      validateGlowIdentityCoverage(mutant),
      { ok: false, missing: [file] },
      `removing ${file} must be rejected by the provenance coverage contract`,
    );
  }
  assert.match(
    probe,
    /sourceFiles: BUILD_SOURCE_IDENTITY_FILES/,
    "source-map identity must consume the complete runtime input set",
  );

  const runtimeLabelBlock = probe.match(
    /const EXPECTED_RUNTIME_SESSION_LABELS = Object\.freeze\(\[([\s\S]*?)\]\);/,
  );
  assert.ok(runtimeLabelBlock, "the exact served-entry label list must exist");
  assert.deepEqual(
    [...runtimeLabelBlock[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]),
    [
      "derive-webgl",
      "cloud-webgpu",
      "deck-free-off-a",
      "deck-free-on-a",
      "deck-free-on-b",
      "deck-free-off-b",
      "ibl-webgpu",
      "ibl-webgl",
    ],
  );
  assert.match(probe, /`deck-free-\$\{planned\.label\}`/);
  assert.match(
    probe,
    /const pinReasons = \[\.\.\.provenanceReasons, \.\.\.diagnosticReasons\]/,
  );
  assert.match(probe, /type: "console\.error"/);
  assert.match(probe, /type: "pageerror"/);

  assert.match(probe, /const HARD_LIMIT_MS = 720000/);
  assert.match(probe, /const OUTER_WATCHDOG_GRACE_MS = 60000/);
  assert.match(probe, /void closeActiveBrowser\("primary watchdog"\)/);
  assert.match(
    probe,
    /\} finally \{\n\s*await closeActiveBrowser\("measurement finally"\)/,
  );
  assert.match(
    probe,
    /if \(\n\s*!browserClosed \|\|\n\s*cleanupErrors\.length > 0 \|\|\n\s*browserEvidence\.cleanupErrors\.length > 0\n\s*\)/,
  );
  assert.match(
    probe,
    /errors=\$\{JSON\.stringify\(\[\.\.\.cleanupErrors, \.\.\.browserEvidence\.cleanupErrors\]\)\}/,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP M — THE SHADOW-CONTRAST MECHANISM (C13-41 exit condition 2)
// ─────────────────────────────────────────────────────────────────────────────
//
// Exit condition 2 asks for a MECHANISM for the shadow-contrast excess, not a
// re-run: naming the ProceduralClouds over-composite as a confound is not the
// same as explaining the number. The SIXTH PASS block in the gate library
// derives one from the shipped source — the fog / ground-atmosphere residue is
// tonemapped and gamma-encoded INSIDE the globe fragment shader before it is
// mixed into the still-linear surface colour, so its response to the eclipse
// factor reaches the measured band through a concave encode while the terrain's
// does not.
//
// These tests execute that derivation. They score a HYPOTHESIS, never a run:
// nothing here gates, and the measurement that decides the hypothesis is the
// pre-registered fog-off collapse leg, which needs a browser. What they DO
// establish offline is that the hypothesis is arithmetically admissible exactly
// where the previously-tested visible-deck hypothesis was not.
//
// The banked numbers below are the deepest rung of run
// `8b806b09-004c-48ab-b902-f4fce64cd109` (2026-08-25, protocol v4, the artifact
// of record for this row). They are INPUTS to the model here, not claims.

/** Deepest-rung readings of the banked artifact-of-record run. */
const BANKED_DEEPEST = Object.freeze({
  terrainDim: 0.46887558379804545,
  compositeDim: 0.49013073670762686,
  clearContrast: 0.5632631754241546,
  contrastRatio: 1.0341102079879674,
  deckRatio: 0.513868583346416,
  shareCeiling: 0.32266890343992366,
  obscuration: 0.9,
});

/** The fog colour the WGSL analytic fallback builds, at a given magnitude. */
const fogColorAt = (magnitude) => [
  0.18 * magnitude,
  0.38 * magnitude,
  0.72 * magnitude,
];

test("M1 the shipped in-shader encode dims the residue strictly more slowly than the factor", () => {
  const factor = predictFactor(BANKED_DEEPEST.obscuration);
  assert.ok(factor > 0 && factor < 1);
  const dims = ENCODED_RESIDUE_MAGNITUDE_SWEEP.map((magnitude) =>
    encodedResidueDim(factor, fogColorAt(magnitude)),
  );
  assert.equal(dims.length, ENCODED_RESIDUE_MAGNITUDE_SWEEP.length);
  for (const [index, dim] of dims.entries()) {
    assert.ok(
      Number.isFinite(dim),
      `magnitude ${ENCODED_RESIDUE_MAGNITUDE_SWEEP[index]} produced ${dim}`,
    );
    // The whole mechanism in one inequality: a concave encode cannot commute
    // with the multiply, so the encoded term dims LESS than the linear one.
    assert.ok(
      dim > factor,
      `encoded dim ${dim} must exceed the linear factor ${factor}`,
    );
    assert.ok(
      dim >= ENCODED_RESIDUE_DIM_ENVELOPE.lo &&
        dim <= ENCODED_RESIDUE_DIM_ENVELOPE.hi,
      `encoded dim ${dim} outside the declared envelope`,
    );
  }
  // Nearly flat across two decades of fog magnitude — which is why the envelope
  // can be declared at all without knowing the scene's fog colour.
  const spread = Math.max(...dims) - Math.min(...dims);
  assert.ok(spread < 0.1, `envelope spread ${spread} is not nearly flat`);
});

test("M2 the encode hypothesis is admissible where the visible-deck hypothesis is not", () => {
  const factor = predictFactor(BANKED_DEEPEST.obscuration);
  const shares = ENCODED_RESIDUE_MAGNITUDE_SWEEP.map((magnitude) =>
    residueShareForDim(
      encodedResidueDim(factor, fogColorAt(magnitude)),
      BANKED_DEEPEST.terrainDim,
      BANKED_DEEPEST.compositeDim,
    ),
  );
  for (const share of shares) {
    assert.ok(Number.isFinite(share) && share > 0);
    assert.ok(
      share <= BANKED_DEEPEST.shareCeiling,
      `encode share ${share} exceeds the beer-floor ceiling ${BANKED_DEEPEST.shareCeiling}`,
    );
  }
  // The comparison that makes this a discriminator rather than a restatement:
  // the deck's own measured dim needs a share the beer floor forbids.
  const deckShare = residueShareForDim(
    BANKED_DEEPEST.deckRatio,
    BANKED_DEEPEST.terrainDim,
    BANKED_DEEPEST.compositeDim,
  );
  assert.ok(
    deckShare > BANKED_DEEPEST.shareCeiling,
    `the deck hypothesis must stay OUT of range; got ${deckShare}`,
  );
  assert.ok(Math.max(...shares) < deckShare);
});

test("M3 the residue locus grid spans the decade the encode hypothesis lands in", () => {
  const factor = predictFactor(BANKED_DEEPEST.obscuration);
  const shares = ENCODED_RESIDUE_MAGNITUDE_SWEEP.map((magnitude) =>
    residueShareForDim(
      encodedResidueDim(factor, fogColorAt(magnitude)),
      BANKED_DEEPEST.terrainDim,
      BANKED_DEEPEST.compositeDim,
    ),
  );
  const gateSource = fs.readFileSync(
    path.join(here, "lib", "eclipse-cloud-response-gate.mjs"),
    "utf8",
  );
  const match = gateSource.match(/const residueShares = \[([^\]]*)\]/);
  assert.ok(match, "the locus grid must still be a literal array");
  const grid = match[1]
    .split(",")
    .map((entry) => Number.parseFloat(entry.trim()))
    .filter((value) => Number.isFinite(value));
  assert.ok(grid.length > 0);
  // The regression this guards: the grid used to START at 0.2, above every
  // share the encode hypothesis implies, so the table printed the
  // neighbourhood of the answer and never the answer.
  assert.ok(
    Math.min(...grid) <= Math.min(...shares),
    `locus grid floor ${Math.min(...grid)} is above the hypothesis at ${Math.min(...shares)}`,
  );
  assert.ok(Math.max(...grid) >= Math.max(...shares));
});

test("M4 the two-term model reproduces the banked contrast ratio far better than the split model", () => {
  // The two-term model, evaluated from the three MEASURED quantities. It has no
  // free parameter left once `clearContrast` fixes the shadow transmittance, so
  // this is a prediction rather than a fit.
  const { terrainDim, compositeDim, clearContrast } = BANKED_DEEPEST;
  const factor = predictFactor(BANKED_DEEPEST.obscuration);
  const residueDim = encodedResidueDim(factor, fogColorAt(0.1));
  const share = residueShareForDim(residueDim, terrainDim, compositeDim);
  // In the CLEAR leg the residue is undimmed by construction, so the shadow
  // transmittance the band actually averages follows from
  // `clearContrast = (1 - share)*T + share`.
  const transmittance = (clearContrast - share) / (1 - share);
  const eclipseContrast =
    ((1 - share) * transmittance * terrainDim + share * residueDim) /
    ((1 - share) * terrainDim + share * residueDim);
  const twoTermRatio = eclipseContrast / clearContrast;
  const twoTermError = Math.abs(twoTermRatio - BANKED_DEEPEST.contrastRatio);

  // The published split model, at the same run's numbers. Its own derivation
  // block records that it predicts order 1.0002 and is capped far below the
  // measurement, which is the gap this mechanism pass explains.
  const splitRatio = predictShadowContrastRatio({
    strengthClear: 1,
    strengthEclipse: 0.9995501,
    clearContrast,
  });
  const splitError = Math.abs(splitRatio - BANKED_DEEPEST.contrastRatio);

  assert.ok(
    splitError > 0.03,
    `split model error ${splitError} unexpectedly small`,
  );
  assert.ok(
    twoTermError < 0.005,
    `two-term model error ${twoTermError} is not close`,
  );
  assert.ok(
    twoTermError * 10 < splitError,
    `two-term error ${twoTermError} must beat the split error ${splitError} by an order`,
  );
});

test("M5 MUTANT a linear encode destroys the mechanism", async () => {
  const gateSource = fs.readFileSync(
    path.join(here, "lib", "eclipse-cloud-response-gate.mjs"),
    "utf8",
  );
  // Pinned on the two STABLE semantic tokens rather than on one formatted
  // line: the tonemap call and the gamma expression. The previous form pinned
  // the whole chain as the formatter happened to wrap it, which made the
  // mutant hostage to prettier instead of to the code.
  const gamma = "Math.pow(Math.max(v, 0), 1 / 2.2)";
  const tonemap = "pbrNeutralTonemapAtmosphere(c)";
  assert.equal(gateSource.split(gamma).length - 1, 1);
  assert.equal(gateSource.split(tonemap).length - 1, 1);
  // The mutant: the residue reaches the mix LINEAR, which is exactly what the
  // superseded `d = a = F` premise asserted. Under it the residue dims by the
  // factor, the excess has no source, and the implied share diverges.
  const mutantSource = gateSource
    .replace(tonemap, "c")
    .replace(gamma, "Math.max(v, 0)");
  const mutant = await import(
    `data:text/javascript;base64,${Buffer.from(mutantSource).toString("base64")}`
  );
  const factor = predictFactor(BANKED_DEEPEST.obscuration);
  const mutantDim = mutant.encodedResidueDim(factor, fogColorAt(0.1));
  assert.ok(
    Math.abs(mutantDim - factor) < 1e-9,
    `a linear encode must return the factor itself; got ${mutantDim}`,
  );
  const mutantShare = mutant.residueShareForDim(
    mutantDim,
    BANKED_DEEPEST.terrainDim,
    BANKED_DEEPEST.compositeDim,
  );
  // Below the measured terrainDim the required share goes NEGATIVE: no
  // admissible residue can raise the composite dim while dimming faster.
  assert.ok(
    !(mutantShare > 0) || mutantShare > 1,
    `the linear mutant must not yield an admissible share; got ${mutantShare}`,
  );
  assert.throws(() => {
    assert.ok(mutantDim > factor);
  });
});

test("M6 MUTANT dropping the gamma from the chain moves the derived dim materially", async () => {
  const gateSource = fs.readFileSync(
    path.join(here, "lib", "eclipse-cloud-response-gate.mjs"),
    "utf8",
  );
  const gamma = "Math.pow(Math.max(v, 0), 1 / 2.2)";
  assert.equal(gateSource.split(gamma).length - 1, 1);
  // The tonemap is LEFT IN PLACE: this mutant isolates the gamma alone.
  const mutantSource = gateSource.replace(gamma, "Math.max(v, 0)");
  const mutant = await import(
    `data:text/javascript;base64,${Buffer.from(mutantSource).toString("base64")}`
  );
  const factor = predictFactor(BANKED_DEEPEST.obscuration);
  const healthy = encodedResidueDim(factor, fogColorAt(0.1));
  const mutated = mutant.encodedResidueDim(factor, fogColorAt(0.1));
  assert.ok(
    Math.abs(healthy - mutated) > 0.1,
    `the gamma must be load-bearing; healthy ${healthy} vs mutant ${mutated}`,
  );
  assert.ok(
    mutated < ENCODED_RESIDUE_DIM_ENVELOPE.lo,
    `the tonemap alone must fall short of the declared envelope; got ${mutated}`,
  );
});

test("M7 MUTANT an inert in-range check cannot report a hypothesis it never tested", () => {
  const gateSource = fs.readFileSync(
    path.join(here, "lib", "eclipse-cloud-response-gate.mjs"),
    "utf8",
  );
  const guard =
    "    v.shadowResidueShareAtEncodeDim.hi <= v.shadowResidueShareCeiling;";
  assert.equal(
    gateSource.split(guard).length - 1,
    1,
    "the in-range check must remain a single live comparison",
  );
  // Inertness, not absence: the comparison is still present but can no longer
  // reject anything. A reader must be able to tell that apart from a real true.
  const inert = gateSource.replace(guard, "    true;");
  assert.notEqual(inert, gateSource);
  assert.ok(!inert.includes(guard));
  // And the ceiling it compares against must itself still be derived, not a
  // literal that a widening edit could quietly move.
  assert.match(gateSource, /v\.shadowResidueShareCeiling = Number\.isFinite\(/);
  assert.ok(gateSource.includes("CLOUD_SHADOW_BEER_FLOOR,\r\n      )"));
});

test("M8 the mechanism reading is reported-only and cannot move an exit code", () => {
  assert.ok(
    ECLIPSE_CLOUD_REPORTED_ONLY_PREDICATES.includes(
      "shadowResidueEncodeHypothesisInRange",
    ),
    "the mechanism reading must be declared reported-only",
  );
  assert.ok(
    !ECLIPSE_CLOUD_GATE_PREDICATES.includes(
      "shadowResidueEncodeHypothesisInRange",
    ),
    "the mechanism reading must never become a gate predicate",
  );
  assert.ok(
    !ECLIPSE_CLOUD_PARITY_PREDICATES.includes(
      "shadowResidueEncodeHypothesisInRange",
    ),
  );
  // The bands this pass touched: none. The shadow band is the ruled one and
  // R-2026-08-14-1 forbids moving it while the reading is red.
  assert.equal(ECLIPSE_CLOUD_BANDS.shadowContrastRatio.lo, 0.97);
  assert.equal(ECLIPSE_CLOUD_BANDS.shadowContrastRatio.hi, 1.03);
});

test("M9 the LIVE residue instance is the Reinhard cloud composite, and it is admissible", () => {
  const factor = predictFactor(BANKED_DEEPEST.obscuration);
  const dims = REINHARD_RESIDUE_EXPOSURE_SWEEP.map((exposedLuma) =>
    reinhardResidueDim(factor, exposedLuma),
  );
  for (const dim of dims) {
    assert.ok(Number.isFinite(dim));
    assert.ok(dim > factor, `Reinhard dim ${dim} must exceed the factor`);
    assert.ok(dim < 1, `Reinhard dim ${dim} must stay below unity`);
  }
  // Monotone in the operating point — this is what makes the exposure dial a
  // discriminator rather than a free parameter.
  for (let i = 1; i < dims.length; i += 1) {
    assert.ok(
      dims[i] > dims[i - 1],
      `Reinhard dim must rise with exposure: ${dims[i - 1]} -> ${dims[i]}`,
    );
  }
  const shares = dims.map((dim) =>
    residueShareForDim(
      dim,
      BANKED_DEEPEST.terrainDim,
      BANKED_DEEPEST.compositeDim,
    ),
  );
  for (const share of shares) {
    assert.ok(share > 0 && share <= BANKED_DEEPEST.shareCeiling);
  }
  // The refutable demand: the required residue dim is only reachable above a
  // finite exposed radiance, so the mechanism constrains a quantity the lane
  // controls instead of accommodating any value.
  // The floor the beer-floor ceiling implies on the residue own dimming.
  const floorDim =
    (BANKED_DEEPEST.compositeDim -
      BANKED_DEEPEST.terrainDim * (1 - BANKED_DEEPEST.shareCeiling)) /
    BANKED_DEEPEST.shareCeiling;
  assert.ok(reinhardResidueDim(factor, 0.05) < floorDim);
  assert.ok(reinhardResidueDim(factor, 4.0) > floorDim);
});

test("M10 the FOG instance is excluded by the fixture's own pins, in source", () => {
  // An executable elimination rather than a claim. The fog path is a real
  // instance of the same law, but lane B cannot exercise it, so it cannot be
  // this run's residue — and no future reader has to re-open the question.
  const probe = fs.readFileSync(
    path.join(here, "probe-eclipse-cloud-response.mjs"),
    "utf8",
  );
  const pinning = fs.readFileSync(
    path.join(here, "lib", "weather-probe-pinning.mjs"),
    "utf8",
  );
  assert.match(probe, /groundAtmosphere: false,\s*\r?\n\s*fog: false,/);
  assert.match(
    pinning,
    /opts\.fog === false && scene\.fog\)?\s*\{\s*\r?\n\s*scene\.fog\.enabled = false;/,
  );
  assert.match(
    pinning,
    /opts\.groundAtmosphere === false\)?\s*\{\s*\r?\n\s*scene\.globe\.showGroundAtmosphere = false;/,
  );
  // And no imagery layer survives the pin, which is what excludes the
  // subsequent-pass imagery locus — an entirely un-eclipsed residue that would
  // otherwise fit the arithmetic at a share near 0.04.
  assert.match(pinning, /scene\.globe\.imageryLayers\.removeAll\(\);/);
  // The eliminations must not be quietly reversible: if a future edit re-enables
  // either, this test fails and the residue question genuinely reopens.
});
