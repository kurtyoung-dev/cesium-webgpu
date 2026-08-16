// celestial-g4-gate.spec.mjs — browser-free guard for the Campaign-12 G4 lane
// (`probe-celestial-gates.mjs --g4`).
// @purpose Guards the G4 sun/moon gate: thresholds re-derived from shipped Scene modules, synthetic-frame recovery proofs, eight aimed mutants each rejected.
// @status ACTIVE
//
// G4 is a gate, so a spec that only ran the correct implementation would be
// worth nothing — the wrong implementations of every rule below also "pass",
// they just pass vacuously. Every rule is stated once and then run twice: once
// against the real module (or a synthetic frame whose answer is known in closed
// form) and once against a MUTANT that is the plausible wrong implementation
// somebody would actually write.
//
// The spec has five jobs:
//
//   1. PIN THE DERIVATIONS AGAINST THE SHIPPED MODULES. Every "DERIVED"
//      threshold in `lib/celestial-g4-gate.mjs` is recomputed here from
//      `Scene/SolarDiscModel.js`, `Scene/MoonPhaseAppearance.js` and
//      `Scene/computeLunarOppositionSurge.js` — the real files, imported, not
//      transcribed. A constant that drifts away from the physics it claims to
//      encode fails here rather than in an Edge run six weeks later.
//
//   2. PROVE THE MEASUREMENTS RECOVER WHAT THEY CLAIM. The disc, halo,
//      earthshine and terminator measurements run over SYNTHETIC frames built
//      from the shipped laws, where the true disc radius, the true size ratio,
//      the true tint and the true band width are all known exactly.
//
//   3. PROVE THE PREDICATES DISCRIMINATE. Eight mutants — flat disc, linear
//      limb law, reverted C12-18 size fix, uniform dim, terminating halo,
//      polluted control band, displaced halo peak, hard-edge terminator,
//      darkening "gate" terminator, white earthshine, constant (pre-C12-21)
//      earthshine — each rejected by the criterion it is aimed at.
//
//   4. PROVE THE COMPOSITION RULES. `{}.every(Boolean)` is vacuously true, a
//      structural leg is neither a pass nor a defect, and a pass on ONE backend
//      is a FAIL for a gate over shared, CPU-resolved appearance state.
//
//   5. PROVE THE PENDING ARM CANNOT SILENTLY SKIP. All four of its states are
//      exercised, including the discriminator DISAGREEMENT, and the fold is
//      required to surface it.
//
// CRLF: this repo checks out with `core.autocrlf=true`. Source-text assertions
// normalize line endings first — a spec anchored on a bare "\n" silently
// false-greens on Windows.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import SolarDiscModel from "../../packages/engine/Source/Scene/SolarDiscModel.js";
import computeLunarOppositionSurge from "../../packages/engine/Source/Scene/computeLunarOppositionSurge.js";
import {
  EARTHSHINE_STRENGTH,
  EARTHSHINE_TINT_BLUE,
  EARTHSHINE_TINT_GREEN,
  EARTHSHINE_TINT_RED,
  MEAN_SOLAR_ANGULAR_RADIUS,
  computeEarthshinePhaseScale,
  softTerminatorMu0,
} from "../../packages/engine/Source/Scene/MoonPhaseAppearance.js";
import {
  DISPLAY_GAMMA,
  displayToLinear,
  pbrNeutralTonemap,
  stitchBracketLinear,
} from "./lib/celestial-g2-gate.mjs";
import { VIEWPORT } from "./lib/celestial-capture-harness.mjs";
import {
  DISC_RADIANCE_RECOVERY_CEILING,
  discBloomPlateauDifferentialOver,
} from "./lib/solar-bloom-glow.mjs";
import {
  ARM_STATE,
  C12_19_HDR_PEAK_DISCRIMINATOR,
  DISC_AIM_TOLERANCE_PX,
  DISC_BRACKET_EXPOSURES,
  DISC_EPHEMERIS_TOLERANCE,
  EARTHSHINE_INERTNESS_FACTOR,
  EARTHSHINE_INERTNESS_MIN_MUTANT_CODES,
  EARTHSHINE_INERTNESS_QUANTILE,
  EARTHSHINE_MIN_CHANGED_PIXELS,
  EARTHSHINE_MIN_MASK_PIXELS,
  EARTHSHINE_MIN_MEDIAN_DELTA,
  EARTHSHINE_PHASE_SCALING_MAX_REL_DEV,
  EARTHSHINE_TINT_BR_NOMINAL,
  EARTHSHINE_TINT_GR_NOMINAL,
  EARTHSHINE_TINT_MAX_REL_DEV,
  EXIT_CODE,
  G4_CROSS_BACKEND_MAX_RELATIVE_SPREAD,
  HALO_AIM_SEARCH_RADIUS_PX,
  HALO_AIM_TOLERANCE_PX,
  HALO_BAKE_BAND_MAX_RADIANCE,
  HALO_BAND_RSUN,
  HALO_DELTA_PEAK_NOMINAL_RSUN,
  HALO_DELTA_PEAK_TOLERANCE_RSUN,
  HALO_MIN_BAND_RADIANCE,
  HALO_SHAPE_MAX_REL_DEV,
  HALO_SHAPE_SAMPLE_RSUN,
  HALO_TAIL_SLOPE_BAND,
  HDR_EXPECTED_POLICY,
  LIMB_ABSOLUTE_RATIO_BAND,
  LIMB_BAND_MODEL_DISC_RADIUS_PX,
  LIMB_CENTRE_MAX_RELATIVE,
  LIMB_DISC_ONLY_ANNULUS,
  LIMB_DISC_RADIANCE_RECOVERY_TOLERANCE,
  LIMB_MIN_DROP_LINEAR,
  LIMB_SHAPE_MAX_REL_DEV,
  LIMB_SHAPE_MIN_EXPECTATION,
  LIMB_SHAPE_QUANTUM_ANCHOR_UNITS,
  LIMB_SHAPE_SAMPLE_X,
  MOON_AIM_TOLERANCE_PX,
  MOON_DISC_MASK_FRACTION,
  MOON_FULL_MIN_PHASE_FRACTION,
  MOON_FULL_QUARTER_RATIO_MIN,
  MOON_PHASE_ORDERING_MIN_RATIO,
  MOON_PHASE_TARGETS,
  MOON_PHASE_TARGET_TOLERANCE,
  MOON_UNLIT_DARK_FLOOR,
  MOON_UNLIT_MASK_FRACTION,
  PARITY_SCALAR_SOURCE_LANE,
  PENDING_CONTENT,
  SOLAR_ANGULAR_DIAMETER_NOMINAL_DEG,
  SOLAR_ANGULAR_DIAMETER_TOLERANCE,
  STRUCTURAL_NON_VERDICT_MARKER,
  SUN_BAKE_BLUE_HUE_OFFSET,
  SUN_BAKE_GAMMA_NOMINAL,
  SURGE_REACHABLE_MAX_PHASE_ANGLE_DEG,
  TERMINATOR_DELTA_EPS,
  TERMINATOR_MAX_BAND_FRACTION,
  TERMINATOR_MAX_DARKENED_PIXELS,
  TERMINATOR_MIN_CHANGED_PIXELS,
  TERMINATOR_MIN_DISC_PIXELS,
  TERMINATOR_SOFTNESS_BAND,
  TRUE_SIZE_RATIO_NOMINAL,
  TRUE_SIZE_RATIO_TOLERANCE,
  angleDegForPixelOffset,
  bracketQuantum,
  bracketQuantumAt,
  brightestWithinRadius,
  buildAimDiagnostic,
  buildG4Summary,
  captureCodeQuantumLinear,
  chooseBracketLeg,
  deriveDiscOnlyLimbBand,
  deriveDiscRadianceRecoveryBand,
  describeAimMiss,
  discDeltaCensus,
  discIntegratedBrightness,
  evaluateDiscSubLane,
  evaluateEarthshineSubLane,
  evaluateG4Backend,
  evaluateHaloSubLane,
  evaluateLimbAbsoluteArm,
  evaluatePhaseSubLane,
  evaluatePolicySubLane,
  evaluateTerminatorSubLane,
  expectedCompositeLimbRatio,
  flooredDeviation,
  findRetainedImageBuffers,
  foldG4Verdict,
  haloShapeExpectation,
  limbShapeExpectation,
  logLogSlope,
  measureDiscDifferential,
  measureHaloProfile,
  median,
  radialProfile,
  relativeDeviation,
  relativeSpread,
  screenMinusBakedPeak,
  shapeDeviation,
  solarDiscChainLuminance,
  unlitLimbDelta,
} from "./lib/celestial-g4-gate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const readNormalized = (relative) =>
  readFileSync(resolve(HERE, relative), "utf8").replaceAll("\r\n", "\n");

// The glow length both bakes compute (`glowFactor * 5` at the default
// `glowFactor = 1`). Every model derivation below is at this value.
const GLOW_LENGTH_TS = 5.0;
// The bake's own corner distance in solar radii, `sqrt(2) * (1 + 2*glowLengthTS)`.
const BILLBOARD_CORNER_RSUN = Math.SQRT2 * (1 + 2 * GLOW_LENGTH_TS);

// The shipped appearance scalars the disc-only band is derived against —
// `SunHaloAppearance`'s resolution at the shipped defaults (`SunLight`, white,
// `intensity = 2`, HDR on). Written as the module's own derivations, never as
// literals, so a change to either propagates here.
const SHIPPED_DISC_RADIANCE = SolarDiscModel.solarDiscHdrRadiance(true, {
  intensity: 2.0,
  color: { red: 1, green: 1, blue: 1 },
});
const SHIPPED_HALO_CORE_RADII =
  SolarDiscModel.solarHaloCoreRadii(GLOW_LENGTH_TS);
const SHIPPED_HALO_AMPLITUDE =
  SolarDiscModel.SOLAR_HALO_AMPLITUDE * SHIPPED_DISC_RADIANCE;

/** The disc-only band derivation at the shipped state and modelled geometry. */
const shippedDiscOnlyBand = (model = SolarDiscModel, overrides = {}) =>
  deriveDiscOnlyLimbBand(model, {
    discRadiance: SHIPPED_DISC_RADIANCE,
    haloAmplitude: SHIPPED_HALO_AMPLITUDE,
    haloCoreRadii: SHIPPED_HALO_CORE_RADII,
    discRadiusPx: LIMB_BAND_MODEL_DISC_RADIUS_PX,
    exposures: DISC_BRACKET_EXPOSURES,
    ...overrides,
  });

// The drawing buffer the G4 lanes capture into, which is what sizes the sun
// bloom's blur buffer and therefore the glow's screen footprint. Imported
// rather than restated so a change to the capture framing moves the fixture.
const MODEL_VIEWPORT = VIEWPORT;

/** The plateau's radiance-recovery band at the shipped state and framing. */
const shippedRecoveryBand = (model = SolarDiscModel, overrides = {}) =>
  deriveDiscRadianceRecoveryBand(model, {
    discRadiance: SHIPPED_DISC_RADIANCE,
    limbPx: LIMB_BAND_MODEL_DISC_RADIUS_PX,
    discRadiusPx: LIMB_BAND_MODEL_DISC_RADIUS_PX,
    viewportWidth: MODEL_VIEWPORT.width,
    viewportHeight: MODEL_VIEWPORT.height,
    centerX: MODEL_VIEWPORT.width / 2,
    centerY: MODEL_VIEWPORT.height / 2,
    // The annulus population at the modelled radius, which is what the
    // quantization term is averaged over.
    plateauPixels: Math.floor(
      Math.PI *
        LIMB_BAND_MODEL_DISC_RADIUS_PX *
        LIMB_BAND_MODEL_DISC_RADIUS_PX *
        (LIMB_DISC_ONLY_ANNULUS.hi * LIMB_DISC_ONLY_ANNULUS.hi -
          LIMB_DISC_ONLY_ANNULUS.lo * LIMB_DISC_ONLY_ANNULUS.lo),
    ),
    exposures: DISC_BRACKET_EXPOSURES,
    ...overrides,
  });

/**
 * The arm's inputs for a LANDED C12-19 build with a healthy disc lane. The
 * disc-only reading defaults to the shipped prediction, so a test that wants a
 * red only has to override `discOnlyRatio`.
 *
 * ⚠ `discRadianceMeasured` IS THE PLATEAU, not the radiance. The `flat - legacy`
 * annulus carries the disc PLUS the sun bloom's glow, so a healthy frame reads
 * `L + glow` there — feeding it `L` would be feeding it a 29.6% radiance
 * DEFICIT, which is exactly what the superseded flat tolerance could not tell
 * apart from a healthy disc.
 */
const landedArmInputs = (overrides = {}) => {
  const derived = shippedDiscOnlyBand();
  const recovery = shippedRecoveryBand();
  return {
    bakeClampPresent: false,
    discPeakLinear: 1.2e5,
    ratioI095overI0: 0.9,
    discOnlyRatio: derived.predicted,
    discRadianceMeasured: recovery.expectedPlateau,
    discRadianceResolved: SHIPPED_DISC_RADIANCE,
    derivedBand: derived,
    radianceRecovery: recovery,
    ...overrides,
  };
};

// ===========================================================================
// 1. THE SHIPPED MODEL — every DERIVED constant recomputed from the real files
// ===========================================================================

test("B906 derivation: screen-minus-baked halo peaks at exactly 11 R_sun", () => {
  const peak = screenMinusBakedPeak(SolarDiscModel, GLOW_LENGTH_TS);
  assert.ok(
    Math.abs(peak.peakRadii - HALO_DELTA_PEAK_NOMINAL_RSUN) <=
      HALO_DELTA_PEAK_TOLERANCE_RSUN,
    `peak at ${peak.peakRadii} R_sun, expected ${HALO_DELTA_PEAK_NOMINAL_RSUN}`,
  );
  // The peak is the OLD SUPPORT: the baked profile is pedestal-subtracted to
  // reach exactly 0 there while the screen profile is still 0.1314. Both facts
  // are asserted so the peak's LOCATION reads as the consequence it is.
  const core = SolarDiscModel.solarHaloCoreRadii(GLOW_LENGTH_TS);
  // The baked profile reaches its support's zero to within one binary64 ULP of
  // the pedestal subtraction (6.4e-17 measured); past the support the clamp
  // takes it to EXACTLY 0, which is the property the band derivation uses.
  assert.ok(
    Math.abs(
      SolarDiscModel.solarGlareProfile(
        HALO_DELTA_PEAK_NOMINAL_RSUN / BILLBOARD_CORNER_RSUN,
      ),
    ) < 1e-12,
    "the baked profile must vanish at its support",
  );
  assert.equal(
    SolarDiscModel.solarGlareProfile(
      (HALO_DELTA_PEAK_NOMINAL_RSUN + 0.5) / BILLBOARD_CORNER_RSUN,
    ),
    0,
    "the baked profile must be EXACTLY 0 past its support",
  );
  assert.ok(
    Math.abs(
      SolarDiscModel.solarScreenHaloProfile(
        HALO_DELTA_PEAK_NOMINAL_RSUN,
        core,
      ) - peak.peakDelta,
    ) < 1e-12,
  );
  assert.ok(Math.abs(peak.peakDelta - 0.1314) < 1e-3);
});

test("MUTANT REJECTED — a displaced halo core moves the peak off 11 R_sun", () => {
  // The obvious "tune the halo until it looks right" change: double the
  // half-amplitude radius. The curve stays a Lorentzian and stays
  // non-terminating, so nothing about C12-18's headline claim is broken — but
  // the peak of the screen-minus-baked difference slides inward, which is
  // exactly the quantity B906 derived.
  const mutant = {
    ...SolarDiscModel,
    solarHaloCoreRadii: (g) => 2 * SolarDiscModel.solarHaloCoreRadii(g),
  };
  const peak = screenMinusBakedPeak(mutant, GLOW_LENGTH_TS);
  assert.ok(
    Math.abs(peak.peakRadii - HALO_DELTA_PEAK_NOMINAL_RSUN) >
      HALO_DELTA_PEAK_TOLERANCE_RSUN,
    `the displaced-core mutant still peaked at ${peak.peakRadii} R_sun`,
  );
});

test("C12-18 size fix: the true-size edge is exactly sqrt(2) x the legacy one", () => {
  const legacy = SolarDiscModel.solarDiscBakeEdgeLegacy(GLOW_LENGTH_TS);
  const trueSize = SolarDiscModel.solarDiscBakeEdge(GLOW_LENGTH_TS, true);
  assert.ok(
    Math.abs(trueSize / legacy - TRUE_SIZE_RATIO_NOMINAL) < 1e-12,
    `shipped ratio ${trueSize / legacy}`,
  );
  // ...and the true-size edge lands at exactly 1 solar radius, which is what
  // makes the pixel measurement a statement about ANGULAR SIZE.
  assert.ok(
    Math.abs(
      SolarDiscModel.solarBakeRadiusToSolarRadii(trueSize, GLOW_LENGTH_TS) - 1,
    ) < 1e-12,
  );
  assert.ok(
    Math.abs(
      SolarDiscModel.solarBakeRadiusToSolarRadii(legacy, GLOW_LENGTH_TS) -
        Math.SQRT1_2,
    ) < 1e-12,
  );
});

test("the 16 R_sun band floor is past the billboard's own corner", () => {
  // The halo lane's whole positive control rests on this: nothing baked — disc,
  // halo or lens-flare burst — can reach the band, because the quad ends first.
  assert.ok(
    HALO_BAND_RSUN.inner > BILLBOARD_CORNER_RSUN,
    `band inner ${HALO_BAND_RSUN.inner} vs billboard corner ${BILLBOARD_CORNER_RSUN}`,
  );
});

test("limb-darkening expectation is the shipped quadratic law", () => {
  const expected = limbShapeExpectation(SolarDiscModel, LIMB_SHAPE_SAMPLE_X);
  // Recomputed independently from the shipped coefficients rather than pasted.
  const byHand = LIMB_SHAPE_SAMPLE_X.map((x) => {
    const mu = Math.sqrt(1 - x * x);
    const i =
      SolarDiscModel.SOLAR_LIMB_DARKENING_A0 +
      SolarDiscModel.SOLAR_LIMB_DARKENING_A1 * mu +
      SolarDiscModel.SOLAR_LIMB_DARKENING_A2 * mu * mu;
    return 1 - i;
  });
  const anchor = byHand[byHand.length - 1];
  byHand.forEach((v, i) => {
    assert.ok(Math.abs(expected[i] - v / anchor) < 1e-12);
  });
  assert.equal(expected[expected.length - 1], 1);
  assert.ok(expected[0] < 0.06, "x=0.30 must be far below the anchor");
  // §5's own probe point: `1 - I(0.95)` is the anchor's absolute value, and it
  // is what `LIMB_MIN_DROP_LINEAR` is 40x below.
  assert.ok(Math.abs(anchor - 0.432) < 0.002, `1 - I(0.95) = ${anchor}`);
  assert.ok(LIMB_MIN_DROP_LINEAR < anchor / 20);
});

test("MUTANT REJECTED — a LINEAR limb law fails the shape bar", () => {
  const mutant = { ...SolarDiscModel, solarLimbIntensity: (x) => 1 - 0.7 * x };
  const expected = limbShapeExpectation(SolarDiscModel, LIMB_SHAPE_SAMPLE_X);
  const measured = LIMB_SHAPE_SAMPLE_X.map(
    (x) => 1 - mutant.solarLimbIntensity(x),
  );
  const dev = shapeDeviation(
    measured,
    expected,
    LIMB_SHAPE_SAMPLE_X.length - 1,
  );
  assert.ok(
    dev.maxRelDev > LIMB_SHAPE_MAX_REL_DEV,
    `linear law deviated only ${dev.maxRelDev}`,
  );
});

// ---------------------------------------------------------------------------
// THE SHAPE BAR'S DENOMINATOR FLOOR. The shape profile is normalised by its own
// last sample, so the inner samples are small fractions of the anchor and the
// relative form divides the measurement error by those fractions. These pin
// (a) that the floor is the arithmetic it claims, (b) that the constant is
// re-derivable from shipped pieces rather than chosen, and (c) that it buys
// exactly one code of absolute slack and hides nothing larger.
// ---------------------------------------------------------------------------

test("flooredDeviation is the relative form above the floor and an absolute one below it", () => {
  // Above the floor: identical to `relativeDeviation`, to the bit.
  assert.equal(flooredDeviation(1.1, 1.0, 0.5), relativeDeviation(1.1, 1.0));
  assert.equal(flooredDeviation(0.4, 0.5, 0.2), relativeDeviation(0.4, 0.5));
  // Below it: the denominator is the floor, so the reading is the absolute
  // error measured in floors.
  assert.ok(Math.abs(flooredDeviation(0.05, 0.01, 0.2) - 0.2) < 1e-15);
  // A non-positive / non-finite floor is a no-op.
  assert.equal(flooredDeviation(0.05, 0.01, 0), relativeDeviation(0.05, 0.01));
  assert.equal(
    flooredDeviation(0.05, 0.01, NaN),
    relativeDeviation(0.05, 0.01),
  );
  // An expectation of exactly 0 is Infinity without a floor and finite with one
  // — which is the point: "the model predicts nothing here" is a statement
  // about resolution, not an automatic failure.
  assert.equal(relativeDeviation(0.01, 0), Infinity);
  assert.ok(Math.abs(flooredDeviation(0.01, 0, 0.2) - 0.05) < 1e-15);
  assert.equal(flooredDeviation(0, 0, 0), 0);
});

test("shapeDeviation's default floor reproduces the pure relative form exactly", () => {
  const measured = [0.05, 0.16, 0.37, 0.83, 1.0];
  const expected = limbShapeExpectation(SolarDiscModel, LIMB_SHAPE_SAMPLE_X);
  const bare = shapeDeviation(measured, expected, 4);
  assert.equal(bare.floor, 0);
  bare.deviations.forEach((d, i) => {
    assert.equal(d, relativeDeviation(bare.normalized[i], expected[i]));
  });
  // …and so does an explicitly zero / negative floor, so no caller can acquire
  // the allowance by accident.
  assert.deepEqual(
    shapeDeviation(measured, expected, 4, 0).deviations,
    bare.deviations,
  );
  assert.deepEqual(
    shapeDeviation(measured, expected, 4, -1).deviations,
    bare.deviations,
  );
});

test("the floor moves ONLY the samples whose expectation is below it", () => {
  const measured = [0.05, 0.16, 0.37, 0.83, 1.0];
  const expected = limbShapeExpectation(SolarDiscModel, LIMB_SHAPE_SAMPLE_X);
  const bare = shapeDeviation(measured, expected, 4);
  const floored = shapeDeviation(
    measured,
    expected,
    4,
    LIMB_SHAPE_MIN_EXPECTATION,
  );
  assert.equal(floored.floor, LIMB_SHAPE_MIN_EXPECTATION);
  expected.forEach((e, i) => {
    if (e >= LIMB_SHAPE_MIN_EXPECTATION) {
      assert.equal(floored.deviations[i], bare.deviations[i], `sample ${i}`);
    } else {
      assert.ok(floored.deviations[i] < bare.deviations[i], `sample ${i}`);
    }
  });
  // The normalisation itself is untouched — the floor is a denominator, not a
  // rescaling of the measurement.
  assert.deepEqual(floored.normalized, bare.normalized);
});

test("LIMB_SHAPE_QUANTUM_ANCHOR_UNITS re-derives from the shipped chain", () => {
  // Recomputed from the shipped model and the lane's own bracket rather than
  // pasted, so a change to the radiance, the halo amplitude, the bracket or the
  // hue term fails HERE rather than silently rescaling the bar.
  const discRadiance = SolarDiscModel.solarDiscHdrRadiance(true, {
    intensity: 2.0,
  });
  const brightestDiscPixel =
    discRadiance * (1 + SolarDiscModel.SOLAR_HALO_AMPLITUDE);
  const quantum = bracketQuantum(brightestDiscPixel, DISC_BRACKET_EXPOSURES);
  const anchorLinear =
    discRadiance *
    (solarDiscChainLuminance(1) -
      solarDiscChainLuminance(SolarDiscModel.solarLimbIntensity(0.95)));
  const derived = quantum.oneCodeLinear / anchorLinear;
  assert.ok(
    Math.abs(derived - LIMB_SHAPE_QUANTUM_ANCHOR_UNITS) < 1e-5,
    `derived ${derived} vs constant ${LIMB_SHAPE_QUANTUM_ANCHOR_UNITS}`,
  );
  // And the floor is the satisfiability point of the ratified bar, exactly.
  assert.ok(
    Math.abs(
      LIMB_SHAPE_MAX_REL_DEV * LIMB_SHAPE_MIN_EXPECTATION -
        LIMB_SHAPE_QUANTUM_ANCHOR_UNITS,
    ) < 1e-15,
  );
});

test("the derivation's premise holds: every disc pixel is served by the LOW bracket leg", () => {
  // The budget is only as large as it is because the disc saturates the 1x
  // capture end to end, which forces the 0.125x leg and its coarse code. If a
  // future bracket or radiance breaks that, the constant above is wrong.
  const discRadiance = SolarDiscModel.solarDiscHdrRadiance(true, {
    intensity: 2.0,
  });
  const haloAmplitude = discRadiance * SolarDiscModel.SOLAR_HALO_AMPLITUDE;
  const core = SolarDiscModel.solarHaloCoreRadii(GLOW_LENGTH_TS);
  const brightest = discRadiance + haloAmplitude;
  const dimmest =
    discRadiance *
      solarDiscChainLuminance(SolarDiscModel.solarLimbIntensity(0.95)) +
    haloAmplitude * SolarDiscModel.solarScreenHaloProfile(0.95, core);
  const lowLeg = Math.min(...DISC_BRACKET_EXPOSURES);
  for (const [label, linear] of [
    ["brightest", brightest],
    ["dimmest", dimmest],
  ]) {
    const q = bracketQuantum(linear, DISC_BRACKET_EXPOSURES);
    assert.equal(
      q.exposure,
      lowLeg,
      `${label} disc pixel served at ${q.exposure}x`,
    );
  }
  // The quantum grows monotonically up the display curve, so reading it at the
  // brightest pixel bounds every other sample in the frame.
  assert.ok(
    bracketQuantum(brightest, DISC_BRACKET_EXPOSURES).oneCodeLinear >
      bracketQuantum(dimmest, DISC_BRACKET_EXPOSURES).oneCodeLinear,
  );
});

test("bracketQuantum picks the leg chooseBracketLeg would have picked", () => {
  // ⚠ MIRRORED RULE. `bracketQuantum` selects from the LINEAR side and
  // `chooseBracketLeg` from the captured codes; both claim to be
  // `stitchBracketLinear`'s rule. Encode known radiances through the forward
  // chain and require the two to agree on every one of them.
  const encode = (linear, exposure) => {
    const t = pbrNeutralTonemap([
      linear * exposure,
      linear * exposure,
      linear * exposure,
    ]);
    const code = Math.min(
      255,
      Math.max(0, Math.round(255 * Math.pow(Math.max(t[0], 0), 2.2 ** -1))),
    );
    return code;
  };
  for (const linear of [0.02, 0.2, 0.9, 1.75, 2.5, 3.5, 8, 40]) {
    const captures = DISC_BRACKET_EXPOSURES.map((e) => {
      const c = encode(linear, e);
      return { data: [c, c, c, 255], exposureFactor: e };
    });
    const byCode = chooseBracketLeg(captures, 0);
    const byLinear = bracketQuantum(linear, DISC_BRACKET_EXPOSURES);
    assert.equal(
      byLinear.exposure,
      byCode.exposureFactor,
      `disagreed at ${linear}: linear side ${byLinear.exposure}x, code side ${byCode.exposureFactor}x`,
    );
    // And the quantum the two report at that leg is the same number — asked
    // only where the display curve is not near-vertical. The linear-side helper
    // keeps a FRACTIONAL code and the code side has already rounded, and above
    // ~240 one code is worth so much linear light that a third of a code is a
    // double-digit relative gap. That is the instrument, not a disagreement.
    if (byLinear.code < 240) {
      assert.ok(
        relativeDeviation(
          byLinear.oneCodeLinear,
          bracketQuantumAt(captures, 0),
        ) < 0.05,
        `quantum disagreed at ${linear}`,
      );
    }
  }
});

test("the floor buys ONE code of slack and refuses anything larger", () => {
  const expected = limbShapeExpectation(SolarDiscModel, LIMB_SHAPE_SAMPLE_X);
  // A measurement offset at x = 0.3 by exactly the budget passes; twice the
  // budget does not. This is the whole claim the constant makes, stated as a
  // pair rather than as a one-sided bound that a huge floor would also satisfy.
  const within = expected.slice();
  within[0] = expected[0] - 0.99 * LIMB_SHAPE_QUANTUM_ANCHOR_UNITS;
  const beyond = expected.slice();
  beyond[0] = expected[0] - 2.0 * LIMB_SHAPE_QUANTUM_ANCHOR_UNITS;
  assert.ok(
    shapeDeviation(within, expected, 4, LIMB_SHAPE_MIN_EXPECTATION).maxRelDev <=
      LIMB_SHAPE_MAX_REL_DEV,
  );
  assert.ok(
    shapeDeviation(beyond, expected, 4, LIMB_SHAPE_MIN_EXPECTATION).maxRelDev >
      LIMB_SHAPE_MAX_REL_DEV,
  );
  // A limb term that simply does not exist over the inner disc — the mutant the
  // floored sample is closest to admitting — is still refused.
  const dead = expected.slice();
  dead[0] = 0;
  assert.ok(
    shapeDeviation(dead, expected, 4, LIMB_SHAPE_MIN_EXPECTATION).maxRelDev >
      LIMB_SHAPE_MAX_REL_DEV,
    "a dead inner-disc differential must still fail the shape bar",
  );
});

test("MUTANT REJECTED (floored) — the linear law and a 10% a1 error still fail", () => {
  const expected = limbShapeExpectation(SolarDiscModel, LIMB_SHAPE_SAMPLE_X);
  const mutants = {
    "linear law 1 - 0.7x": (x) => 1 - 0.7 * x,
    "a1 x 1.1": (x) => {
      const mu = Math.sqrt(Math.max(0, 1 - x * x));
      return (
        SolarDiscModel.SOLAR_LIMB_DARKENING_A0 +
        1.1 * SolarDiscModel.SOLAR_LIMB_DARKENING_A1 * mu +
        SolarDiscModel.SOLAR_LIMB_DARKENING_A2 * mu * mu
      );
    },
    "a1 x 0.9": (x) => {
      const mu = Math.sqrt(Math.max(0, 1 - x * x));
      return (
        SolarDiscModel.SOLAR_LIMB_DARKENING_A0 +
        0.9 * SolarDiscModel.SOLAR_LIMB_DARKENING_A1 * mu +
        SolarDiscModel.SOLAR_LIMB_DARKENING_A2 * mu * mu
      );
    },
    "flat disc (no limb darkening at all)": () => 1,
  };
  for (const [label, law] of Object.entries(mutants)) {
    const measured = LIMB_SHAPE_SAMPLE_X.map((x) => 1 - law(x));
    const dev = shapeDeviation(
      measured,
      expected,
      LIMB_SHAPE_SAMPLE_X.length - 1,
      LIMB_SHAPE_MIN_EXPECTATION,
    );
    assert.ok(
      dev.maxRelDev > LIMB_SHAPE_MAX_REL_DEV,
      `${label} deviated only ${dev.maxRelDev} with the floor applied`,
    );
  }
});

test("halo shape expectation is the shipped Lorentzian, and its tail slope is ~-1.92", () => {
  const expected = haloShapeExpectation(
    SolarDiscModel,
    HALO_SHAPE_SAMPLE_RSUN,
    GLOW_LENGTH_TS,
  );
  assert.equal(expected[0], 1);
  const core = SolarDiscModel.solarHaloCoreRadii(GLOW_LENGTH_TS);
  HALO_SHAPE_SAMPLE_RSUN.forEach((rho, i) => {
    const v =
      SolarDiscModel.solarScreenHaloProfile(rho, core) /
      SolarDiscModel.solarScreenHaloProfile(HALO_SHAPE_SAMPLE_RSUN[0], core);
    assert.ok(Math.abs(expected[i] - v) < 1e-12);
  });
  const slope = logLogSlope(HALO_SHAPE_SAMPLE_RSUN, expected);
  assert.ok(
    slope >= HALO_TAIL_SLOPE_BAND.lo && slope <= HALO_TAIL_SLOPE_BAND.hi,
    `shipped tail slope ${slope} is outside the band the gate accepts`,
  );
  // The band must EXCLUDE the star PSF's inverse-fourth wing. G2 and G4 measure
  // two different laws and the bands must not overlap on that point.
  assert.ok(HALO_TAIL_SLOPE_BAND.lo > -4);
});

test("MUTANT REJECTED — a GAUSSIAN halo fails the shape bar", () => {
  const core = SolarDiscModel.solarHaloCoreRadii(GLOW_LENGTH_TS);
  const mutant = {
    ...SolarDiscModel,
    solarScreenHaloProfile: (rho, c) => Math.exp(-Math.LN2 * (rho / c) ** 2),
  };
  const expected = haloShapeExpectation(SolarDiscModel, HALO_SHAPE_SAMPLE_RSUN);
  const measured = HALO_SHAPE_SAMPLE_RSUN.map((rho) =>
    mutant.solarScreenHaloProfile(rho, core),
  );
  const dev = shapeDeviation(measured, expected, 0);
  assert.ok(
    dev.maxRelDev > HALO_SHAPE_MAX_REL_DEV,
    `gaussian halo deviated only ${dev.maxRelDev}`,
  );
});

test("the surge reachability bound is the shipped surge's own 10% contour", () => {
  const alpha = (SURGE_REACHABLE_MAX_PHASE_ANGLE_DEG * Math.PI) / 180;
  const b = computeLunarOppositionSurge(alpha);
  assert.ok(
    Math.abs(b - 1.1) < 0.002,
    `surge multiplier at ${SURGE_REACHABLE_MAX_PHASE_ANGLE_DEG} deg is ${b}, ` +
      "so the bound no longer names the 10% contour",
  );
  // And the demo's own "full moon" framing (0.98) is NOT inside it — which is
  // why the full:quarter arm is reachability-gated rather than simply asserted.
  const alpha098 = Math.acos(2 * 0.98 - 1);
  assert.ok((alpha098 * 180) / Math.PI > SURGE_REACHABLE_MAX_PHASE_ANGLE_DEG);
  assert.ok(computeLunarOppositionSurge(alpha098) < 1.05);
  // At true opposition the surge is 1.6, which is what lifts LS's ~2.65:1 over
  // the 3:1 bar. Recorded so the gate's own reachability story is checkable.
  assert.ok(Math.abs(computeLunarOppositionSurge(0) - 1.6) < 1e-12);
});

test("the terminator softness band contains the shipped solar angular radius", () => {
  assert.ok(
    MEAN_SOLAR_ANGULAR_RADIUS >= TERMINATOR_SOFTNESS_BAND.lo &&
      MEAN_SOLAR_ANGULAR_RADIUS <= TERMINATOR_SOFTNESS_BAND.hi,
    `shipped mean ${MEAN_SOLAR_ANGULAR_RADIUS} outside the band`,
  );
  // ...with room for the +/-1.7% the Sun-Moon distance actually moves.
  assert.ok(MEAN_SOLAR_ANGULAR_RADIUS * 1.017 <= TERMINATOR_SOFTNESS_BAND.hi);
  assert.ok(MEAN_SOLAR_ANGULAR_RADIUS * 0.983 >= TERMINATOR_SOFTNESS_BAND.lo);
});

test("softTerminatorMu0 never darkens — the property TERMINATOR_MAX_DARKENED_PIXELS rests on", () => {
  const w = MEAN_SOLAR_ANGULAR_RADIUS;
  let equalOutside = 0;
  for (let k = -2000; k <= 2000; k++) {
    const c = (k / 2000) * 4 * w;
    const soft = softTerminatorMu0(c, w);
    const hard = Math.max(c, 0);
    assert.ok(soft >= hard - 1e-15, `softening darkened at N.L = ${c}`);
    if (Math.abs(c) >= w) {
      assert.ok(Math.abs(soft - hard) < 1e-12);
      equalOutside++;
    }
  }
  assert.ok(equalOutside > 1000, "the outside-band sample was too thin");
  // The peak excess is exactly w/4, at N.L = 0.
  assert.ok(Math.abs(softTerminatorMu0(0, w) - w / 4) < 1e-15);
});

test("MUTANT REJECTED — the smoothstep GATE softening darkens the lit side", () => {
  // `MoonPhaseAppearance`'s own docstring names this: a bare
  // `smoothstep(-w, w, c)` returns a 0..1 GATE, not an irradiance, so
  // multiplying `max(c,0)` by it leaves the dark side at 0 and DIMS the lit
  // side — it makes the edge harder, not softer.
  const w = MEAN_SOLAR_ANGULAR_RADIUS;
  const gate = (c) => {
    const t = Math.min(1, Math.max(0, (c + w) / (2 * w)));
    return Math.max(c, 0) * t * t * (3 - 2 * t);
  };
  let darkened = 0;
  for (let k = 1; k <= 1000; k++) {
    const c = (k / 1000) * w;
    if (gate(c) < Math.max(c, 0) - 1e-15) {
      darkened++;
    }
  }
  assert.ok(
    darkened > 900,
    "the gate mutant should darken almost the whole band",
  );
});

test("earthshine tint nominals are the shipped literals, and the complement is exact", () => {
  assert.equal(
    EARTHSHINE_TINT_BR_NOMINAL,
    EARTHSHINE_TINT_BLUE / EARTHSHINE_TINT_RED,
  );
  assert.equal(
    EARTHSHINE_TINT_GR_NOMINAL,
    EARTHSHINE_TINT_GREEN / EARTHSHINE_TINT_RED,
  );
  assert.equal(computeEarthshinePhaseScale(0), 1);
  assert.equal(computeEarthshinePhaseScale(1), 0);
  assert.ok(Math.abs(computeEarthshinePhaseScale(0.12) - 0.88) < 1e-12);
  // The bar is set below the LUMINANCE of the shipped term at a 0.12 crescent.
  const lum =
    0.2126 * EARTHSHINE_TINT_RED +
    0.7152 * EARTHSHINE_TINT_GREEN +
    0.0722 * EARTHSHINE_TINT_BLUE;
  const modelled = EARTHSHINE_STRENGTH * lum * 0.88;
  assert.ok(
    EARTHSHINE_MIN_MEDIAN_DELTA < modelled / 5,
    `bar ${EARTHSHINE_MIN_MEDIAN_DELTA} vs modelled ${modelled}`,
  );
});

test("MUTANT REJECTED — a WHITE earthshine fails both tint ratios", () => {
  assert.ok(
    relativeDeviation(1, EARTHSHINE_TINT_BR_NOMINAL) >
      EARTHSHINE_TINT_MAX_REL_DEV,
  );
  assert.ok(
    relativeDeviation(1, EARTHSHINE_TINT_GR_NOMINAL) >
      EARTHSHINE_TINT_MAX_REL_DEV,
  );
});

test("the C12-19 peak discriminator separates the clamped ceiling from the SHIPPED radiance", () => {
  // The clamped bake's chroma is bounded by 1.0 and the screen halo adds at
  // most SOLAR_HALO_AMPLITUDE — 1.75 at the disc centre. The landed C12-19
  // (Batch 937) ships discRadiance derived from the engine's own light — 2.0
  // at defaults, NOT the row's pre-landing ~1e5 (see the tradeoff filing).
  // The discriminator must sit strictly between those two edges.
  const clampedCeiling = 1.0 + SolarDiscModel.SOLAR_HALO_AMPLITUDE;
  const shippedHdrMinimum = SolarDiscModel.solarDiscHdrRadiance(true, {
    intensity: 2.0,
  });
  assert.ok(
    C12_19_HDR_PEAK_DISCRIMINATOR > clampedCeiling,
    `discriminator ${C12_19_HDR_PEAK_DISCRIMINATOR} vs clamped ceiling ${clampedCeiling}`,
  );
  assert.ok(
    C12_19_HDR_PEAK_DISCRIMINATOR < shippedHdrMinimum,
    `discriminator ${C12_19_HDR_PEAK_DISCRIMINATOR} vs shipped HDR minimum ${shippedHdrMinimum}`,
  );
});

// ===========================================================================
// 2. SYNTHETIC FRAMES — the measurements recover what they claim
// ===========================================================================

/**
 * Render one synthetic solar leg into a linear-light RGBA image. Neutral, so
 * the Rec.709 luminance of every pixel is exactly its scalar value.
 */
function renderSun({
  size,
  radiusPx,
  limbOn,
  haloFn,
  haloRadiusPx,
  limbFn = SolarDiscModel.solarLimbIntensity,
  radiance = 1,
}) {
  const data = new Float64Array(size * size * 4);
  const c = size / 2;
  // The screen halo's own scale is `SunHaloAppearance.limbPx`, computed from
  // the EPHEMERIS angular radius and the projection — it reads neither
  // `enableSolarLimbDarkening` nor `enableTrueSolarDiscSize`, so it is
  // IDENTICAL in all three legs of the real capture. The legacy leg therefore
  // has to be rendered with the true-size leg's halo scale; normalising the
  // halo by the leg's own (undersized) disc radius would put a halo mismatch
  // into `flat - legacy` that the shipped chain does not have, and the R-2
  // disc-only reading divides by exactly that difference.
  const haloScale = haloRadiusPx ?? radiusPx;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      const rho = r / radiusPx;
      const disc = rho <= 1 ? (limbOn ? limbFn(rho) : 1) : 0;
      const v = radiance * (disc + (haloFn ? haloFn(r / haloScale) : 0));
      const i = 4 * (y * size + x);
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 1;
    }
  }
  return { data, width: size, height: size };
}

const DISC_SIZE = 400;
const DISC_RADIUS_PX = 120;
// A field of view that puts a 120 px radius at the Sun's nominal angular radius
// — so the SYNTHETIC frame is dimensionally what the probe's 2 deg framing
// produces, and the criterion is exercised at its real operating point.
const DISC_FOV_X_DEG = 0.8889;
// The screen halo, in the synthetic's own units: rho is already in solar radii
// because the disc radius IS one solar radius.
const SYNTH_HALO = (rho) =>
  SolarDiscModel.SOLAR_HALO_AMPLITUDE *
  SolarDiscModel.solarScreenHaloProfile(
    rho,
    SolarDiscModel.solarHaloCoreRadii(GLOW_LENGTH_TS),
  );

function synthDiscLegs(overrides = {}) {
  const flat = renderSun({
    size: DISC_SIZE,
    radiusPx: DISC_RADIUS_PX,
    limbOn: false,
    haloFn: SYNTH_HALO,
  });
  const limb =
    overrides.limb ??
    renderSun({
      size: DISC_SIZE,
      radiusPx: DISC_RADIUS_PX,
      limbOn: true,
      haloFn: SYNTH_HALO,
    });
  const legacy =
    overrides.legacy ??
    renderSun({
      size: DISC_SIZE,
      radiusPx: DISC_RADIUS_PX / TRUE_SIZE_RATIO_NOMINAL,
      limbOn: false,
      haloFn: SYNTH_HALO,
      haloRadiusPx: DISC_RADIUS_PX,
    });
  return { flat, limb, legacy };
}

function measureSynthDisc(overrides = {}) {
  const legs = synthDiscLegs(overrides);
  return measureDiscDifferential({
    ...legs,
    model: SolarDiscModel,
    fovXDeg: DISC_FOV_X_DEG,
    canvasWidth: DISC_SIZE,
    ephemerisDiameterDeg:
      2 * angleDegForPixelOffset(DISC_RADIUS_PX, DISC_FOV_X_DEG, DISC_SIZE),
  });
}

test("SYNTHETIC DISC: the differential recovers the radius, the sqrt(2) ratio and the limb law", () => {
  const m = measureSynthDisc();
  assert.ok(m.aimDistancePx < 1, `centroid drifted ${m.aimDistancePx} px`);
  assert.ok(
    Math.abs(m.discRadiusPx - DISC_RADIUS_PX) < 1.5,
    `disc radius ${m.discRadiusPx}`,
  );
  assert.ok(
    Math.abs(m.legacyRadiusPx - DISC_RADIUS_PX / TRUE_SIZE_RATIO_NOMINAL) < 1.5,
    `legacy radius ${m.legacyRadiusPx}`,
  );
  assert.ok(
    relativeDeviation(m.trueSizeRatio, TRUE_SIZE_RATIO_NOMINAL) <=
      TRUE_SIZE_RATIO_TOLERANCE,
    `ratio ${m.trueSizeRatio}`,
  );
  assert.ok(
    relativeDeviation(m.discDiameterDeg, SOLAR_ANGULAR_DIAMETER_NOMINAL_DEG) <=
      SOLAR_ANGULAR_DIAMETER_TOLERANCE,
    `diameter ${m.discDiameterDeg} deg`,
  );
  assert.ok(
    m.limbShapeMaxRelDev <= LIMB_SHAPE_MAX_REL_DEV,
    `shape deviation ${m.limbShapeMaxRelDev}`,
  );
  assert.ok(m.limbAnchorDelta >= LIMB_MIN_DROP_LINEAR);
  assert.ok(m.limbCentreRelative <= LIMB_CENTRE_MAX_RELATIVE);
  assert.ok(m.limbOutsideRelative <= 0.02);
  assert.ok(
    m.limbOutsidePixels > 1000,
    "the outside annulus must have samples",
  );
  // THE HALO CANCELS. Its amplitude over the disc is ~0.71 — larger than the
  // whole limb signal — so if the differential did not cancel it the shape test
  // above could not pass. Stated explicitly as the reason the differential
  // exists.
  assert.ok(SYNTH_HALO(0) > 0.7);
  // And the ABSOLUTE ratio is NOT in §5's band on this (clamp-free but
  // halo-loaded) frame, which is the pending arm's whole point.
  assert.ok(m.ratioI095overI0_DIAGNOSTIC > LIMB_ABSOLUTE_RATIO_BAND.hi);
});

test("SYNTHETIC DISC (R-2): the DISC-ONLY reading recovers the law with the halo removed", () => {
  const m = measureSynthDisc();
  // The synthetic disc is drawn at unit radiance, so the `flat - legacy`
  // annulus must recover exactly 1 — that is the measurement claiming, and
  // proving, that it knows what it divided by.
  assert.ok(
    Math.abs(m.discRadianceMeasured - 1) < 0.02,
    `recovered disc radiance ${m.discRadianceMeasured}`,
  );
  assert.ok(
    m.discRadiancePlateauPixels > 5000,
    `the annulus must have samples: ${m.discRadiancePlateauPixels}`,
  );
  // These frames carry no bake hue term (they are neutral by construction), so
  // the disc-only reading must recover the PURE law at 0.95R.
  const pure =
    SolarDiscModel.solarLimbIntensity(0.95) /
    SolarDiscModel.solarLimbIntensity(0);
  assert.ok(
    relativeDeviation(m.discOnlyRatio_I095_over_I0, pure) < 0.03,
    `disc-only ${m.discOnlyRatio_I095_over_I0} vs law ${pure}`,
  );
  // …while the COMPOSITE reading on the very same frames is 27% higher. That
  // gap IS the confound §5's old bound was being measured through.
  assert.ok(
    m.ratioI095overI0_DIAGNOSTIC > 1.2 * m.discOnlyRatio_I095_over_I0,
    `composite ${m.ratioI095overI0_DIAGNOSTIC} vs disc-only ${m.discOnlyRatio_I095_over_I0}`,
  );
});

test("SYNTHETIC DISC (R-2): the disc-only reading is INVARIANT to the halo", () => {
  // The strongest available statement of the cancellation: quadruple the halo
  // — a change four times larger than the entire limb signal — and the
  // disc-only reading must not move, while the composite moves a great deal.
  const base = measureSynthDisc();
  const fatHalo = (rho) => 4 * SYNTH_HALO(rho);
  const legs = {
    flat: renderSun({
      size: DISC_SIZE,
      radiusPx: DISC_RADIUS_PX,
      limbOn: false,
      haloFn: fatHalo,
    }),
    limb: renderSun({
      size: DISC_SIZE,
      radiusPx: DISC_RADIUS_PX,
      limbOn: true,
      haloFn: fatHalo,
    }),
    legacy: renderSun({
      size: DISC_SIZE,
      radiusPx: DISC_RADIUS_PX / TRUE_SIZE_RATIO_NOMINAL,
      limbOn: false,
      haloFn: fatHalo,
      haloRadiusPx: DISC_RADIUS_PX,
    }),
  };
  const fat = measureDiscDifferential({
    ...legs,
    model: SolarDiscModel,
    fovXDeg: DISC_FOV_X_DEG,
    canvasWidth: DISC_SIZE,
    ephemerisDiameterDeg:
      2 * angleDegForPixelOffset(DISC_RADIUS_PX, DISC_FOV_X_DEG, DISC_SIZE),
  });
  assert.ok(
    relativeDeviation(
      fat.discOnlyRatio_I095_over_I0,
      base.discOnlyRatio_I095_over_I0,
    ) < 1e-9,
    `disc-only moved from ${base.discOnlyRatio_I095_over_I0} to ${fat.discOnlyRatio_I095_over_I0}`,
  );
  assert.ok(
    relativeDeviation(
      fat.ratioI095overI0_DIAGNOSTIC,
      base.ratioI095overI0_DIAGNOSTIC,
    ) > 0.1,
    "the composite reading must be the one that moves",
  );
  // The recovered radiance is likewise untouched: it is the disc's own step
  // across the annulus, not the level the halo sits at.
  assert.ok(
    relativeDeviation(fat.discRadianceMeasured, base.discRadianceMeasured) <
      1e-9,
  );
});

// ---------------------------------------------------------------------------
// THE SAME FRAMES, THROUGH THE DIGITIZER. Every synthetic above is a float
// image, which is the one thing the shipped capture is not: the probe reads
// back 8-bit codes and inverts them, and the disc is bright enough that one
// code costs more linear light than the inner samples of `1 - I(x)` carry. The
// pair below renders at the SHIPPED radiance, pushes the legs through the
// forward display chain at the lane's own bracket, quantises, and stitches back
// — so the criterion is exercised against the instrument it actually runs on.
// ---------------------------------------------------------------------------

// `SunHaloAppearance`'s shipped resolution: the disc composites at
// `solarDiscHdrRadiance` and the screen halo at `SOLAR_HALO_AMPLITUDE` times
// it, which is what `SYNTH_HALO` already carries per unit disc.
const SYNTH_DISC_RADIANCE = SolarDiscModel.solarDiscHdrRadiance(true, {
  intensity: 2.0,
});

/** Forward display chain — `exposure -> PBR-Neutral -> gamma -> 8 bit`. */
function digitizeBracket(image, exposures) {
  return exposures.map((exposure) => {
    const data = new Uint8ClampedArray(image.data.length);
    for (let i = 0; i < image.data.length; i += 4) {
      const t = pbrNeutralTonemap([
        image.data[i] * exposure,
        image.data[i + 1] * exposure,
        image.data[i + 2] * exposure,
      ]);
      for (let k = 0; k < 3; k++) {
        data[i + k] = Math.round(
          255 * Math.pow(Math.max(t[k], 0), 1 / DISPLAY_GAMMA),
        );
      }
      data[i + 3] = 255;
    }
    return {
      data,
      width: image.width,
      height: image.height,
      exposureFactor: exposure,
    };
  });
}

function measureDigitizedDisc(limbFn) {
  const leg = (o) =>
    stitchBracketLinear(
      digitizeBracket(
        renderSun({
          size: DISC_SIZE,
          radiusPx: DISC_RADIUS_PX,
          haloFn: SYNTH_HALO,
          radiance: SYNTH_DISC_RADIANCE,
          ...o,
        }),
        DISC_BRACKET_EXPOSURES,
      ),
    );
  return measureDiscDifferential({
    flat: leg({ limbOn: false }),
    limb: leg({ limbOn: true, limbFn }),
    legacy: leg({
      limbOn: false,
      radiusPx: DISC_RADIUS_PX / TRUE_SIZE_RATIO_NOMINAL,
      haloRadiusPx: DISC_RADIUS_PX,
    }),
    model: SolarDiscModel,
    fovXDeg: DISC_FOV_X_DEG,
    canvasWidth: DISC_SIZE,
    ephemerisDiameterDeg:
      2 * angleDegForPixelOffset(DISC_RADIUS_PX, DISC_FOV_X_DEG, DISC_SIZE),
  });
}

test("DIGITIZED DISC: the shipped law survives its own 8-bit capture", () => {
  const m = measureDigitizedDisc(SolarDiscModel.solarLimbIntensity);
  // The premise: the disc really is served from the low bracket leg, and one
  // code there really is a large fraction of the anchor. If either stops being
  // true this test is no longer testing the thing it was written for.
  assert.equal(
    m.limbShapeQuantumExposure,
    Math.min(...DISC_BRACKET_EXPOSURES),
    "the disc must saturate the high bracket leg",
  );
  assert.ok(
    m.limbShapeQuantumAnchorUnits >
      0.5 * limbShapeExpectation(SolarDiscModel, LIMB_SHAPE_SAMPLE_X)[0],
    `one code is ${m.limbShapeQuantumAnchorUnits} of the anchor — too small for ` +
      "this frame to exercise the budget the criterion is floored with",
  );
  // The floor never exceeds the value the constant was derived and reviewed at.
  assert.ok(
    m.limbShapeMinExpectation <= LIMB_SHAPE_MIN_EXPECTATION + 1e-12,
    `floor ${m.limbShapeMinExpectation}`,
  );
  assert.ok(
    m.limbShapeMaxRelDev <= LIMB_SHAPE_MAX_REL_DEV,
    `shape deviation ${m.limbShapeMaxRelDev} on a digitized capture of the ` +
      "shipped law — the criterion is failing its own subject",
  );
  // The shape of the problem, on a frame clean enough to still pass without
  // the floor: the unfloored deviations are largest at the sample carrying the
  // LEAST signal and smallest at the ones carrying most, which is the ordering
  // a denominator hazard produces and the opposite of what a law error would.
  // (The shipped capture is the same ordering with the inner term over the bar
  // — see the recorded-run test below.)
  const bare = shapeDeviation(
    m.limbShapeMeasured,
    m.limbShapeExpected,
    LIMB_SHAPE_SAMPLE_X.length - 1,
  );
  assert.ok(
    bare.deviations[0] > bare.deviations[2] &&
      bare.deviations[0] > bare.deviations[3],
    `the unfloored bar must break hardest at x = ${LIMB_SHAPE_SAMPLE_X[0]}: ` +
      `${bare.deviations.join(", ")}`,
  );
  const verdict = evaluateDiscSubLane({
    ...m,
    hdrEngaged: true,
    ephemerisDiameterDeg: m.discDiameterDeg,
  });
  assert.equal(verdict.criteria.limb_shape_matches_shipped_law, true);
  assert.deepEqual(verdict.structural, []);
});

test("DIGITIZED DISC — MUTANT REJECTED: a 10% error in a1 is still caught", () => {
  // The coefficient the shape arm is most sensitive to, perturbed both ways,
  // measured through the identical capture chain the passing case used.
  for (const scale of [1.1, 0.9]) {
    const law = (x) => {
      const mu = Math.sqrt(Math.max(0, 1 - x * x));
      return (
        SolarDiscModel.SOLAR_LIMB_DARKENING_A0 +
        scale * SolarDiscModel.SOLAR_LIMB_DARKENING_A1 * mu +
        SolarDiscModel.SOLAR_LIMB_DARKENING_A2 * mu * mu
      );
    };
    const m = measureDigitizedDisc(law);
    assert.ok(
      m.limbShapeMaxRelDev > LIMB_SHAPE_MAX_REL_DEV,
      `a1 x ${scale} deviated only ${m.limbShapeMaxRelDev}`,
    );
    const verdict = evaluateDiscSubLane({
      ...m,
      hdrEngaged: true,
      ephemerisDiameterDeg: m.discDiameterDeg,
    });
    assert.equal(verdict.criteria.limb_shape_matches_shipped_law, false);
  }
});

/**
 * The disc lane's own first Edge run, both backends — the raw `D1` samples
 * `measureDiscDifferential` read off the shipped capture, and the flat leg's
 * peak radiance the budget is derived from. Recorded rather than synthesised
 * because no synthetic reproduces the ONE thing that made this criterion red:
 * an inner sample whose whole signal is a single 8-bit code.
 */
const RECORDED_DISC_RUN = {
  webgl: {
    flatPeakLinear: 4.222121615022485,
    shape: [
      0.046199773226060614, 0.1829787570123028, 0.4253755910984467,
      0.9582565038187536, 1.1486804524262706,
    ],
  },
  webgpu: {
    flatPeakLinear: 4.222121615022485,
    shape: [
      0.046199773226060614, 0.18297875701230282, 0.43991498148306185,
      0.9874815385881526, 1.1787914876744359,
    ],
  },
};

test("RECORDED RUN: the shipped capture was red on its smallest sample and is green now", () => {
  const expected = limbShapeExpectation(SolarDiscModel, LIMB_SHAPE_SAMPLE_X);
  const anchorIndex = LIMB_SHAPE_SAMPLE_X.length - 1;
  for (const [backend, run] of Object.entries(RECORDED_DISC_RUN)) {
    const anchor = run.shape[anchorIndex];
    // The budget, re-derived from the run's own peak through the lane's bracket
    // — not pasted, so a change to the bracket or the display chain moves it.
    const quantum = bracketQuantum(run.flatPeakLinear, DISC_BRACKET_EXPOSURES);
    const quantumAnchorUnits = quantum.oneCodeLinear / anchor;
    const floor =
      Math.min(quantumAnchorUnits, LIMB_SHAPE_QUANTUM_ANCHOR_UNITS) /
      LIMB_SHAPE_MAX_REL_DEV;

    const bare = shapeDeviation(run.shape, expected, anchorIndex);
    assert.ok(
      bare.maxRelDev > LIMB_SHAPE_MAX_REL_DEV,
      `${backend}: the recorded run must reproduce the red — ${bare.maxRelDev}`,
    );
    assert.equal(
      bare.deviations.indexOf(bare.maxRelDev),
      0,
      `${backend}: the red must be at x = ${LIMB_SHAPE_SAMPLE_X[0]}, the ` +
        `smallest-signal sample: ${bare.deviations.join(", ")}`,
    );
    // …and the miss there is smaller than one code of the instrument, i.e. the
    // renderer was never outside the resolution the capture could assert on.
    assert.ok(
      Math.abs(bare.normalized[0] - expected[0]) < quantumAnchorUnits,
      `${backend}: miss ${Math.abs(bare.normalized[0] - expected[0])} vs one ` +
        `code ${quantumAnchorUnits}`,
    );

    const floored = shapeDeviation(run.shape, expected, anchorIndex, floor);
    assert.ok(
      floored.maxRelDev <= LIMB_SHAPE_MAX_REL_DEV,
      `${backend}: still red after flooring — ${floored.maxRelDev}`,
    );
    // The floor did exactly the arithmetic it claims and nothing else: the one
    // sample below it is rescaled by `expected/floor`, and every sample above
    // it is untouched.
    assert.ok(
      Math.abs(
        floored.deviations[0] - bare.deviations[0] * (expected[0] / floor),
      ) < 1e-12,
    );
    for (let i = 1; i < expected.length; i++) {
      if (expected[i] >= floor) {
        assert.equal(floored.deviations[i], bare.deviations[i], `sample ${i}`);
      }
    }
    // And the pass is not a squeaker: the bar is met with better than 2x margin
    // on every sample, so it certifies rather than merely clears.
    assert.ok(
      floored.maxRelDev < 0.5 * LIMB_SHAPE_MAX_REL_DEV,
      `${backend}: margin is thin — ${floored.maxRelDev}`,
    );
    // And the same floor still refuses the linear law on the same frame.
    const linear = LIMB_SHAPE_SAMPLE_X.map((x) => 0.7 * x * anchor);
    assert.ok(
      shapeDeviation(linear, expected, anchorIndex, floor).maxRelDev >
        LIMB_SHAPE_MAX_REL_DEV,
    );
  }
});

test("MUTANT REJECTED — a FLAT disc (limb darkening removed) has no differential", () => {
  const flat = renderSun({
    size: DISC_SIZE,
    radiusPx: DISC_RADIUS_PX,
    limbOn: false,
    haloFn: SYNTH_HALO,
  });
  const m = measureSynthDisc({ limb: flat });
  const verdict = evaluateDiscSubLane({
    ...m,
    hdrEngaged: true,
    ephemerisDiameterDeg: m.discDiameterDeg,
  });
  // Reported as a named DEFECT, not as blindness — the frame is fully lit, the
  // reference leg rendered, and the differential is empty anyway.
  assert.ok(m.limbLegLitPixels > 1000, "the mutant frame is still lit");
  assert.equal(m.differentialPositivePixels, 0);
  assert.equal(verdict.criteria.limb_differential_has_signal, false);
  assert.deepEqual(verdict.structural, []);
  assert.equal(verdict.pass, false);
});

test("a BLANK disc frame is STRUCTURAL — blindness and the C12-15 defect stay separate", () => {
  const blank = {
    data: new Float64Array(DISC_SIZE * DISC_SIZE * 4),
    width: DISC_SIZE,
    height: DISC_SIZE,
  };
  const m = measureSynthDisc({ limb: blank, legacy: blank });
  const verdict = evaluateDiscSubLane({
    ...m,
    limbLegLitPixels: 0,
    hdrEngaged: true,
  });
  assert.deepEqual(verdict.criteria, {});
  assert.ok(verdict.structural.some((s) => /not in frame/.test(s)));
  assert.equal(verdict.pass, false);
});

test("MUTANT REJECTED — a LINEAR limb law renders a differential of the wrong shape", () => {
  const linear = { ...SolarDiscModel, solarLimbIntensity: (x) => 1 - 0.7 * x };
  const size = DISC_SIZE;
  const data = new Float64Array(size * size * 4);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const rho = Math.hypot(x + 0.5 - c, y + 0.5 - c) / DISC_RADIUS_PX;
      const v =
        (rho <= 1 ? linear.solarLimbIntensity(rho) : 0) + SYNTH_HALO(rho);
      const i = 4 * (y * size + x);
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 1;
    }
  }
  const m = measureSynthDisc({ limb: { data, width: size, height: size } });
  assert.ok(
    m.limbShapeMaxRelDev > LIMB_SHAPE_MAX_REL_DEV,
    `linear-law frame deviated only ${m.limbShapeMaxRelDev}`,
  );
});

test("MUTANT REJECTED — the C12-18 size fix reverted (both toggles give one edge)", () => {
  const flat = renderSun({
    size: DISC_SIZE,
    radiusPx: DISC_RADIUS_PX,
    limbOn: false,
    haloFn: SYNTH_HALO,
  });
  const m = measureSynthDisc({ legacy: flat });
  const verdict = evaluateDiscSubLane({
    ...m,
    hdrEngaged: true,
    ephemerisDiameterDeg: m.discDiameterDeg,
  });
  // With no annulus at all the legacy edge is not locatable, so the lane is
  // STRUCTURAL rather than silently reading a ratio of 1 — and either way it is
  // not a pass.
  assert.equal(verdict.pass, false);
  assert.ok(
    verdict.structural.length > 0 ||
      verdict.criteria.disc_trueSizeRatio_is_sqrt2 === false,
  );
});

test("MUTANT REJECTED — a UNIFORM dim is not limb darkening", () => {
  // "Limb darkening implemented as an overall multiplier" — the differential is
  // then a filled disc rather than a ring, and it does NOT vanish at centre.
  const size = DISC_SIZE;
  const data = new Float64Array(size * size * 4);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const rho = Math.hypot(x + 0.5 - c, y + 0.5 - c) / DISC_RADIUS_PX;
      const v = (rho <= 1 ? 0.5 : 0) + SYNTH_HALO(rho);
      const i = 4 * (y * size + x);
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 1;
    }
  }
  const m = measureSynthDisc({ limb: { data, width: size, height: size } });
  assert.ok(
    m.limbCentreRelative > LIMB_CENTRE_MAX_RELATIVE,
    `uniform dim left a centre relative of only ${m.limbCentreRelative}`,
  );
});

const HALO_SIZE = 500;
const HALO_LIMB_PX = 6;

function renderHaloLeg(profileFn) {
  const data = new Float64Array(HALO_SIZE * HALO_SIZE * 4);
  const c = HALO_SIZE / 2;
  for (let y = 0; y < HALO_SIZE; y++) {
    for (let x = 0; x < HALO_SIZE; x++) {
      const rho = Math.hypot(x + 0.5 - c, y + 0.5 - c) / HALO_LIMB_PX;
      const v = (rho <= 1 ? 1 : 0) + profileFn(rho);
      const i = 4 * (y * HALO_SIZE + x);
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 1;
    }
  }
  return { data, width: HALO_SIZE, height: HALO_SIZE };
}

// The BAKED halo, in solar radii: exactly 0 beyond its 11 R_sun support.
const SYNTH_BAKED_HALO = (rho) =>
  SolarDiscModel.SOLAR_HALO_AMPLITUDE *
  SolarDiscModel.solarGlareProfile(rho / BILLBOARD_CORNER_RSUN);

test("SYNTHETIC HALO: the tail is present past the billboard, and the bake band is empty", () => {
  const m = measureHaloProfile({
    screen: renderHaloLeg(SYNTH_HALO),
    bake: renderHaloLeg(SYNTH_BAKED_HALO),
    limbPx: HALO_LIMB_PX,
    model: SolarDiscModel,
    aimSearchRadiusPx: 12,
  });
  assert.ok(m.aimDistancePx < 2, `aim drifted ${m.aimDistancePx} px`);
  assert.ok(
    m.screenBandMean >= HALO_MIN_BAND_RADIANCE,
    `screen band mean ${m.screenBandMean}`,
  );
  assert.equal(m.bakeBandMean, 0, "the baked halo cannot reach past its quad");
  assert.ok(m.bakeBandMean <= HALO_BAKE_BAND_MAX_RADIANCE);
  assert.ok(m.screenBandPixels > 5000, "the band must carry samples");
  assert.ok(
    m.haloShapeMaxRelDev <= HALO_SHAPE_MAX_REL_DEV,
    `shape deviation ${m.haloShapeMaxRelDev}`,
  );
  assert.ok(
    m.haloTailSlope >= HALO_TAIL_SLOPE_BAND.lo &&
      m.haloTailSlope <= HALO_TAIL_SLOPE_BAND.hi,
    `slope ${m.haloTailSlope}`,
  );
  assert.ok(
    Math.abs(m.deltaPeakRadii - HALO_DELTA_PEAK_NOMINAL_RSUN) <=
      HALO_DELTA_PEAK_TOLERANCE_RSUN,
  );
});

test("MUTANT REJECTED — a TERMINATING halo leaves the band empty", () => {
  // The failure mode of a half-done C12-18: the halo moved to the post-process
  // chain but kept the bake's pedestal subtraction, so it still dies at 11 R_sun
  // and the "non-terminating tail" claim is false.
  const m = measureHaloProfile({
    screen: renderHaloLeg(SYNTH_BAKED_HALO),
    bake: renderHaloLeg(SYNTH_BAKED_HALO),
    limbPx: HALO_LIMB_PX,
    model: SolarDiscModel,
  });
  const verdict = evaluateHaloSubLane({
    ...m,
    hdrEngaged: true,
    cropRadiusPx: HALO_SIZE / 2,
    screenLeg: {
      screenHalo: true,
      bakeHaloGain: 0,
      haloIntensity: 0.75,
      eclipseFactor: 1,
    },
    bakeLeg: { screenHalo: false, bakeHaloGain: 1, haloIntensity: 0 },
    sunVisibleFraction: 1,
    sunEclipseAlpha: 1,
  });
  assert.equal(verdict.criteria.halo_tail_present_beyond_billboard, false);
  assert.equal(verdict.pass, false);
});

test("MUTANT REJECTED — a POLLUTED control band voids the positive control", () => {
  // If something else in the scene lights the 16-30 R_sun band, the screen
  // leg's signal is no longer attributable to the halo. The bake leg is the
  // control that says the band is empty, and it must be able to fail.
  const m = measureHaloProfile({
    screen: renderHaloLeg(SYNTH_HALO),
    bake: renderHaloLeg((rho) => SYNTH_BAKED_HALO(rho) + 0.05),
    limbPx: HALO_LIMB_PX,
    model: SolarDiscModel,
  });
  const verdict = evaluateHaloSubLane({
    ...m,
    hdrEngaged: true,
    cropRadiusPx: HALO_SIZE / 2,
    screenLeg: {
      screenHalo: true,
      bakeHaloGain: 0,
      haloIntensity: 0.75,
      eclipseFactor: 1,
    },
    bakeLeg: { screenHalo: false, bakeHaloGain: 1, haloIntensity: 0 },
    sunVisibleFraction: 1,
    sunEclipseAlpha: 1,
  });
  assert.equal(verdict.criteria.halo_bakeLeg_band_is_empty, false);
});

// ---------------------------------------------------------------------------
// MOON SYNTHETICS
// ---------------------------------------------------------------------------

const MOON_SIZE = 640;
const MOON_RADIUS_PX = 283;
const MOON_ALBEDO = 0.5;

/**
 * Render one synthetic lunar leg. The shading is the shipped structure: a
 * softened `mu0` times an albedo, plus an ADDITIVE earthshine term proportional
 * to `1 - max(N.L, 0)` and scaled by the Earth-phase complement — exactly the
 * expression both shader twins carry.
 */
function renderMoon({
  size = MOON_SIZE,
  radiusPx = MOON_RADIUS_PX,
  phaseFraction,
  softness,
  earthshineScale,
  tint = [EARTHSHINE_TINT_RED, EARTHSHINE_TINT_GREEN, EARTHSHINE_TINT_BLUE],
  mu0Fn = softTerminatorMu0,
}) {
  const data = new Float64Array(size * size * 4);
  const c = size / 2;
  // Phase angle from the illuminated fraction; light direction in view space.
  const alpha = Math.acos(Math.max(-1, Math.min(1, 2 * phaseFraction - 1)));
  const lx = Math.sin(alpha);
  const lz = Math.cos(alpha);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - c) / radiusPx;
      const dy = (y + 0.5 - c) / radiusPx;
      const rr = dx * dx + dy * dy;
      const i = 4 * (y * size + x);
      data[i + 3] = 1;
      if (rr > 1) {
        continue;
      }
      const nz = Math.sqrt(1 - rr);
      const nDotL = dx * lx + nz * lz;
      const mu0 = mu0Fn(nDotL, softness);
      const raw = Math.max(nDotL, 0);
      const es = EARTHSHINE_STRENGTH * (1 - raw) * earthshineScale;
      data[i] = MOON_ALBEDO * mu0 + tint[0] * es;
      data[i + 1] = MOON_ALBEDO * mu0 + tint[1] * es;
      data[i + 2] = MOON_ALBEDO * mu0 + tint[2] * es;
    }
  }
  return { data, width: size, height: size };
}

const MOON_MASK = {
  cx: MOON_SIZE / 2,
  cy: MOON_SIZE / 2,
  radius: MOON_RADIUS_PX,
};

function synthEarthshine(phaseFraction, scale, tint) {
  const on = renderMoon({
    phaseFraction,
    softness: MEAN_SOLAR_ANGULAR_RADIUS,
    earthshineScale: scale,
    tint,
  });
  const off = renderMoon({
    phaseFraction,
    softness: MEAN_SOLAR_ANGULAR_RADIUS,
    earthshineScale: 0,
  });
  return unlitLimbDelta(on, off, {
    ...MOON_MASK,
    innerFraction: MOON_UNLIT_MASK_FRACTION,
    darkFloor: MOON_UNLIT_DARK_FLOOR,
    changedEps: TERMINATOR_DELTA_EPS,
  });
}

/**
 * The FULL-moon inertness census, over the whole disc.
 *
 * A near-full moon shows essentially no unlit limb, so `unlitLimbDelta`'s mask
 * is EMPTY there and its median is NaN. That is a property of the geometry, not
 * of the renderer, and evaluating inertness on it would fail a healthy build.
 */
/**
 * The capture quantum the synthetic censuses are graded against.
 *
 * The synthetic frames are float — they HAVE no 8-bit readback and therefore no
 * quantization step of their own. Batch 941's measured value at the WebGL
 * full-moon peak pixel is used instead, so the mutants below are rejected by
 * the floor the REAL lane will apply rather than by a friendlier one:
 * `captureCodeQuantumLinear([230,231,227], 1) = 0.0098041`. The spec asserts
 * that identity separately, so this number cannot drift away from the module.
 */
const RUN941_WEBGL_PEAK_QUANTUM = 0.00980414014788722;

function synthFullInertness(
  scale,
  phaseFraction = 0.995,
  peakQuantumLinear = RUN941_WEBGL_PEAK_QUANTUM,
) {
  const on = renderMoon({
    phaseFraction,
    softness: MEAN_SOLAR_ANGULAR_RADIUS,
    earthshineScale: scale,
  });
  const off = renderMoon({
    phaseFraction,
    softness: MEAN_SOLAR_ANGULAR_RADIUS,
    earthshineScale: 0,
  });
  return {
    ...discDeltaCensus(on, off, {
      cx: MOON_MASK.cx,
      cy: MOON_MASK.cy,
      radius: MOON_RADIUS_PX * MOON_DISC_MASK_FRACTION,
      eps: TERMINATOR_DELTA_EPS,
      // The certifying rank, requested exactly as the probe requests it
      // (`G4-FOLLOWUP-EARTHSHINE-EXPOSURE`). A spec that censused the peak
      // while the lane censused a rank would grade a statistic nobody runs.
      quantile: EARTHSHINE_INERTNESS_QUANTILE,
    }),
    peakQuantumLinear,
  };
}

test("the full-moon unlit mask is EMPTY — which is why inertness is censused over the disc", () => {
  // Recorded as a measurement rather than a comment: this is the trap the
  // whole-disc census exists to avoid, and it was found here before any Edge
  // run.
  const masked = synthEarthshine(0.995, 0.005);
  assert.equal(masked.maskPixels, 0);
  assert.ok(Number.isNaN(masked.medianDelta));
  const census = synthFullInertness(0.005);
  assert.ok(census.discPixels >= TERMINATOR_MIN_DISC_PIXELS);
  assert.ok(Number.isFinite(census.peakDelta));
  // ...and the RANK the criterion actually reads is defined on the same mask
  // (`G4-FOLLOWUP-EARTHSHINE-EXPOSURE`).
  assert.equal(census.quantileLevel, EARTHSHINE_INERTNESS_QUANTILE);
  assert.ok(Number.isFinite(census.quantileDelta));
  assert.ok(census.quantileDelta <= census.peakDelta);
});

test("SYNTHETIC EARTHSHINE: the unlit limb lights, with the shipped ashen tint", () => {
  const crescent = synthEarthshine(0.12, 0.88);
  assert.ok(
    crescent.maskPixels >= EARTHSHINE_MIN_MASK_PIXELS,
    `mask ${crescent.maskPixels}`,
  );
  assert.ok(
    crescent.changedPixels >= EARTHSHINE_MIN_CHANGED_PIXELS,
    `changed ${crescent.changedPixels}`,
  );
  assert.ok(
    crescent.medianDelta >= EARTHSHINE_MIN_MEDIAN_DELTA,
    `median delta ${crescent.medianDelta}`,
  );
  assert.ok(
    relativeDeviation(
      crescent.medianB / crescent.medianR,
      EARTHSHINE_TINT_BR_NOMINAL,
    ) <= EARTHSHINE_TINT_MAX_REL_DEV,
  );
  assert.ok(
    relativeDeviation(
      crescent.medianG / crescent.medianR,
      EARTHSHINE_TINT_GR_NOMINAL,
    ) <= EARTHSHINE_TINT_MAX_REL_DEV,
  );
  // The recovered per-channel median IS the shipped constant on the unlit
  // hemisphere, where `rawNdotL` is exactly 0.
  assert.ok(
    Math.abs(
      crescent.medianB - EARTHSHINE_TINT_BLUE * EARTHSHINE_STRENGTH * 0.88,
    ) < 1e-9,
  );
});

test("SYNTHETIC EARTHSHINE: the delta follows the Earth-phase complement", () => {
  const crescent = synthEarthshine(0.12, 0.88);
  const quarter = synthEarthshine(0.5, 0.5);
  const measuredRatio = crescent.medianDelta / quarter.medianDelta;
  const predicted = 0.88 / 0.5;
  assert.ok(
    relativeDeviation(measuredRatio, predicted) <=
      EARTHSHINE_PHASE_SCALING_MAX_REL_DEV,
    `measured ${measuredRatio} vs predicted ${predicted}`,
  );
});

test("MUTANT REJECTED — a WHITE earthshine fails the tint arm on real pixels", () => {
  const white = synthEarthshine(0.12, 0.88, [1, 1, 1]);
  const verdict = evaluateEarthshineSubLane({
    enableEarthshine: true,
    aimDistancePx: 0,
    scaleCrescent: 0.88,
    scaleQuarter: 0.5,
    scaleFull: 0.02,
    crescent: white,
    quarter: synthEarthshine(0.5, 0.5),
    full: synthFullInertness(0.02),
  });
  assert.equal(verdict.criteria.earthshine_tint_blue_over_red, false);
  assert.equal(verdict.criteria.earthshine_tint_green_over_red, false);
  assert.equal(verdict.pass, false);
});

test("MUTANT REJECTED — the PRE-C12-21 constant earthshine breaks the scaling AND the inertness", () => {
  // The defect C12-21 exists to fix: a term with no phase factor. Both the
  // scaling criterion and the full-moon inertness criterion must reject it, and
  // the inertness one is what makes "earthshine vanishes at full" a measurement
  // rather than a comment.
  const constantTerm = synthEarthshine(0.12, 1.0);
  const constantAtQuarter = synthEarthshine(0.5, 1.0);
  const constantAtFull = synthFullInertness(1.0);
  const verdict = evaluateEarthshineSubLane({
    enableEarthshine: true,
    aimDistancePx: 0,
    scaleCrescent: 0.88,
    scaleQuarter: 0.5,
    scaleFull: 0.02,
    crescent: constantTerm,
    quarter: constantAtQuarter,
    full: constantAtFull,
  });
  assert.equal(
    verdict.criteria.earthshine_scales_with_earth_phase_complement,
    false,
  );
  assert.equal(verdict.criteria.earthshine_inert_at_full_moon, false);
  assert.equal(verdict.pass, false);
});

function synthTerminator(mu0Fn) {
  const on = renderMoon({
    phaseFraction: 0.5,
    softness: MEAN_SOLAR_ANGULAR_RADIUS,
    earthshineScale: 0.5,
    mu0Fn,
  });
  const off = renderMoon({
    phaseFraction: 0.5,
    softness: 0,
    earthshineScale: 0.5,
  });
  return discDeltaCensus(on, off, {
    cx: MOON_MASK.cx,
    cy: MOON_MASK.cy,
    radius: MOON_RADIUS_PX * MOON_DISC_MASK_FRACTION,
    eps: TERMINATOR_DELTA_EPS,
  });
}

test("SYNTHETIC TERMINATOR: a thin, non-negative band that no pixel darkens", () => {
  const census = synthTerminator(softTerminatorMu0);
  assert.ok(
    census.discPixels >= TERMINATOR_MIN_DISC_PIXELS,
    `disc pixels ${census.discPixels}`,
  );
  assert.ok(
    census.changedPixels >= TERMINATOR_MIN_CHANGED_PIXELS,
    `changed ${census.changedPixels}`,
  );
  assert.equal(census.darkenedPixels, TERMINATOR_MAX_DARKENED_PIXELS);
  const fraction = census.changedPixels / census.discPixels;
  assert.ok(
    fraction <= TERMINATOR_MAX_BAND_FRACTION,
    `band fraction ${fraction}`,
  );
  // LOCAL, and by a wide margin: the whole point of C12-22 is a penumbra the
  // width of the solar disc, not a disc-wide softening.
  assert.ok(fraction < TERMINATOR_MAX_BAND_FRACTION / 5);
});

test("MUTANT REJECTED — the HARD-EDGE terminator changes nothing", () => {
  const census = synthTerminator((nDotL) => Math.max(nDotL, 0));
  const verdict = evaluateTerminatorSubLane({
    ...census,
    aimDistancePx: 0,
    softnessOff: 0,
    softnessOn: MEAN_SOLAR_ANGULAR_RADIUS,
  });
  assert.equal(verdict.criteria.terminator_band_exists, false);
  assert.equal(verdict.pass, false);
});

test("MUTANT REJECTED — the smoothstep GATE terminator darkens pixels", () => {
  const w = MEAN_SOLAR_ANGULAR_RADIUS;
  const gate = (nDotL) => {
    const t = Math.min(1, Math.max(0, (nDotL + w) / (2 * w)));
    return Math.max(nDotL, 0) * t * t * (3 - 2 * t);
  };
  const census = synthTerminator(gate);
  const verdict = evaluateTerminatorSubLane({
    ...census,
    aimDistancePx: 0,
    softnessOff: 0,
    softnessOn: w,
  });
  assert.ok(census.darkenedPixels > 0);
  assert.equal(verdict.criteria.terminator_no_pixel_darkened, false);
  assert.equal(verdict.pass, false);
});

test("SYNTHETIC PHASE: the disc-integrated brightness increases with phase", () => {
  const brightness = (pf) =>
    discIntegratedBrightness(
      renderMoon({
        phaseFraction: pf,
        softness: MEAN_SOLAR_ANGULAR_RADIUS,
        earthshineScale: 1 - pf,
      }),
      {
        cx: MOON_MASK.cx,
        cy: MOON_MASK.cy,
        radius: MOON_RADIUS_PX * MOON_DISC_MASK_FRACTION,
      },
    ).integrated;
  const full = brightness(0.99);
  const quarter = brightness(0.5);
  const crescent = brightness(0.12);
  assert.ok(full / quarter >= MOON_PHASE_ORDERING_MIN_RATIO);
  assert.ok(quarter / crescent >= MOON_PHASE_ORDERING_MIN_RATIO);
  // A LAMBERT sphere gives ~pi:1 full:quarter. The synthetic is Lambert, so
  // this doubles as a check that the integration is over the whole disc rather
  // than a crop of it.
  assert.ok(
    Math.abs(full / quarter - Math.PI) < 0.35,
    `Lambert full:quarter measured ${full / quarter}`,
  );
});

// ===========================================================================
// 3. THE PENDING ARM
// ===========================================================================

test("PENDING ARM: the clamped build reports STRUCTURAL-pending-content BY NAME", () => {
  const arm = evaluateLimbAbsoluteArm({
    bakeClampPresent: true,
    discPeakLinear: 1.7,
    ratioI095overI0: 0.9,
  });
  assert.equal(arm.state, ARM_STATE.PENDING_CONTENT);
  assert.equal(arm.pending, PENDING_CONTENT.C12_19);
  assert.match(arm.pending, /C12-19/);
  assert.deepEqual(arm.criteria, {});
  // The ratio is MEASURED and carried even though it certifies nothing.
  assert.equal(arm.measured.ratioI095overI0, 0.9);
});

test("PENDING ARM: it ACTIVATES when C12-19 lands, and then certifies", () => {
  const pass = evaluateLimbAbsoluteArm(landedArmInputs());
  assert.equal(pass.state, ARM_STATE.ACTIVE);
  assert.equal(pass.pending, null);
  assert.equal(pass.criteria.limb_discOnlyRatio_I095_over_I0_in_band, true);
  // R-2 — the CERTIFYING reading is the disc-only one. The composite ratio is
  // carried and printed but no longer decides anything: a composite reading
  // way outside the old band cannot fail the arm on its own.
  const fail = evaluateLimbAbsoluteArm(landedArmInputs({ discOnlyRatio: 0.9 }));
  assert.equal(fail.state, ARM_STATE.ACTIVE);
  assert.equal(fail.criteria.limb_discOnlyRatio_I095_over_I0_in_band, false);
  assert.equal(
    "limb_absoluteRatio_I095_over_I0_in_band" in pass.criteria,
    false,
    "the SUPERSEDED composite criterion must not still be emitted",
  );
});

test("R-2: the halo-contaminated composite no longer decides the arm", () => {
  // Batch 950's actual readings, which failed the superseded [0.3, 0.5] band
  // on BOTH backends. With a healthy disc-only reading the arm now certifies,
  // and the composite is still on the record.
  for (const composite of [0.7138, 0.7181]) {
    const arm = evaluateLimbAbsoluteArm(
      landedArmInputs({ ratioI095overI0: composite }),
    );
    assert.equal(arm.state, ARM_STATE.ACTIVE);
    assert.equal(arm.criteria.limb_discOnlyRatio_I095_over_I0_in_band, true);
    assert.equal(arm.measured.ratioI095overI0, composite);
    assert.deepEqual(arm.measured.supersededBand, LIMB_ABSOLUTE_RATIO_BAND);
  }
  // MUTANT — the disc-only arm fed the halo-CONTAMINATED number. This is the
  // exact failure R-2 exists to prevent, and it must be refused.
  for (const contaminated of [0.7138, 0.7181, 0.733]) {
    const mutant = evaluateLimbAbsoluteArm(
      landedArmInputs({ discOnlyRatio: contaminated }),
    );
    assert.equal(
      mutant.criteria.limb_discOnlyRatio_I095_over_I0_in_band,
      false,
      `a halo-contaminated reading (${contaminated}) must not certify`,
    );
  }
});

test("an unrecovered disc radiance withholds the ratio AND is scored red", () => {
  // The ratio's denominator is the radiance recovered from the flat-minus-
  // legacy annulus, so a plateau that is not `L + glow` means the quotient is
  // not I(0.95R)/I(0) and the ratio criterion is withheld. The RECOVERY itself
  // is scored, because its expectation is now a prediction of the shipped
  // chain rather than a tolerance wide enough to hide the missing term.
  const recovery = shippedRecoveryBand();
  const off =
    recovery.expectedPlateau + 2 * recovery.tolRel * SHIPPED_DISC_RADIANCE;
  const arm = evaluateLimbAbsoluteArm(
    landedArmInputs({ discRadianceMeasured: off }),
  );
  assert.equal(arm.state, ARM_STATE.RADIANCE_UNRECOVERED);
  assert.deepEqual(arm.criteria, { disc_radiance_recovers_resolved: false });
  assert.equal(
    "limb_discOnlyRatio_I095_over_I0_in_band" in arm.criteria,
    false,
    "the ratio must be WITHHELD, not scored, when its denominator is in doubt",
  );
  assert.equal(arm.measured.discRadianceMeasured, off);
  assert.equal(arm.measured.discOnlyRatio, shippedDiscOnlyBand().predicted);
  // Just inside the derived band still certifies — the bar is an error budget,
  // and it must not be so tight that modelling residue trips it.
  const near = evaluateLimbAbsoluteArm(
    landedArmInputs({
      discRadianceMeasured:
        recovery.expectedPlateau +
        0.9 * recovery.tolRel * SHIPPED_DISC_RADIANCE,
    }),
  );
  assert.equal(near.state, ARM_STATE.ACTIVE);
  assert.equal(near.criteria.disc_radiance_recovers_resolved, true);
});

test("a recovery band that could not be derived is STRUCTURAL, not a pass", () => {
  // A bound that cannot be derived certifies nothing — and comparing the
  // plateau against the radiance ALONE would be off by ~30% of the radiance by
  // construction, so falling back to that is not an option either.
  for (const recovery of [
    null,
    { usable: false },
    shippedRecoveryBand(SolarDiscModel, { limbPx: 0 }),
    shippedRecoveryBand(SolarDiscModel, { viewportWidth: 0 }),
  ]) {
    const arm = evaluateLimbAbsoluteArm(
      landedArmInputs({ radianceRecovery: recovery }),
    );
    assert.equal(arm.state, ARM_STATE.RECOVERY_UNDERIVED);
    assert.deepEqual(arm.criteria, {});
    assert.match(arm.reason, /could not be derived/);
  }
});

// ===========================================================================
// 3a-bis. THE PLATEAU'S EXPECTATION — `resolved radiance + the sun bloom's
// glow`, and the derived band that replaced the flat 0.35.
//
// The old bound was symmetric about the RESOLVED radiance while the plateau's
// truth sits 29.6% above it, so it was spending 0.296 of its 0.35 on a term
// nobody had modelled. These tests prove the term is now modelled from the
// shipped chain, that the derivation reads every input it claims to, and — the
// point of the exercise — that the new band REFUSES radiance defects the old
// one admitted.
// ===========================================================================

test("the plateau's expectation is the radiance PLUS the shipped glow", () => {
  const r = shippedRecoveryBand();
  assert.equal(r.usable, true);
  // The glow half is the shared bright-pass model, recomputed here from the
  // shipped module over the same annulus — not a number this file carries.
  const glow = discBloomPlateauDifferentialOver(SolarDiscModel, {
    discRadiance: SHIPPED_DISC_RADIANCE,
    limbPx: LIMB_BAND_MODEL_DISC_RADIUS_PX,
    viewportWidth: MODEL_VIEWPORT.width,
    viewportHeight: MODEL_VIEWPORT.height,
    centerX: MODEL_VIEWPORT.width / 2,
    centerY: MODEL_VIEWPORT.height / 2,
    annulus: LIMB_DISC_ONLY_ANNULUS,
  });
  assert.equal(r.glow, glow);
  assert.equal(r.expectedPlateau, SHIPPED_DISC_RADIANCE + glow);
  // And it is the size the closed rider names: between a quarter and a third
  // of the disc's own radiance at the shipped position.
  const share = glow / SHIPPED_DISC_RADIANCE;
  assert.ok(
    share > 0.25 && share < 0.35,
    `the glow is ${share} of the disc radiance, expected ~0.296`,
  );
  // The old bound was 0.35 and the reading it was compared against was this
  // share — i.e. it was 84.6% spent before any error was allowed for.
  assert.ok(
    share / LIMB_DISC_RADIANCE_RECOVERY_TOLERANCE > 0.8,
    "the superseded bound was NOT mostly spent on the unmodelled glow",
  );
});

test("the recovery band READS every input it claims to", () => {
  const base = shippedRecoveryBand();
  const moved = (overrides, pick) => {
    const m = shippedRecoveryBand(SolarDiscModel, overrides);
    return Math.abs(pick(m) - pick(base)) > 0;
  };
  // The radiance sets the bright pass's operating point AND the pedestal.
  assert.ok(
    moved({ discRadiance: SHIPPED_DISC_RADIANCE * 0.5 }, (m) => m.glow),
    "the glow did not move with the disc radiance",
  );
  // The blur buffer is sized from the drawing buffer.
  assert.ok(
    moved({ viewportWidth: 1920, viewportHeight: 1080 }, (m) => m.glow),
    "the glow did not move with the drawing buffer",
  );
  // The source's screen footprint is the disc's limb.
  assert.ok(
    moved({ limbPx: LIMB_BAND_MODEL_DISC_RADIUS_PX * 0.5 }, (m) => m.glow),
    "the glow did not move with the disc's limb in pixels",
  );
  // The annulus is placed at the MEASURED radius, not the engine's.
  assert.ok(
    moved(
      { discRadiusPx: LIMB_BAND_MODEL_DISC_RADIUS_PX * 1.05 },
      (m) => m.glow,
    ),
    "the model integrated over the engine's radii rather than the measured ones",
  );
  // The quantization term is averaged over the annulus population.
  assert.ok(
    moved({ plateauPixels: 100 }, (m) => m.tolRel),
    "the band did not move with the annulus population",
  );
  // A MUTANT chain changes the glow: a wider blur spreads the same extracted
  // light differently across the annulus, and a legacy disc that ended at the
  // true limb would leave nothing for the differential to carry at all.
  const wider = {
    ...SolarDiscModel,
    SUN_BLOOM_BLUR_SIGMA: SolarDiscModel.SUN_BLOOM_BLUR_SIGMA * 3,
  };
  assert.notEqual(shippedRecoveryBand(wider).glow, base.glow);
  const noLegacyGap = {
    ...SolarDiscModel,
    SOLAR_DISC_BAKE_LENGTH_SCALAR: 1.0,
  };
  assert.ok(shippedRecoveryBand(noLegacyGap).glow < 1e-9);
});

test("MUTATION: radiance defects the flat 0.35 ADMITTED are now refused", () => {
  const r = shippedRecoveryBand();
  const L = SHIPPED_DISC_RADIANCE;
  // A pure radiance defect of `delta`: the disc renders at `(1+delta) L`, so
  // the plateau reads `(1+delta) L + glow`.
  const plateauAt = (delta) => r.expectedPlateau + delta * L;
  const oldReading = (delta) => Math.abs(plateauAt(delta) / L - 1);
  const oldAdmits = (delta) =>
    oldReading(delta) <= LIMB_DISC_RADIANCE_RECOVERY_TOLERANCE;

  // THE HEADLINE. The old bound sat symmetric about `L` while the truth sat at
  // `1.296 L`, so it admitted defects all the way down to `0.354 L` — and it
  // read the disc at `0.704 L` as a PERFECT recovery, because the missing
  // light and the unmodelled glow cancel exactly there.
  const blindSpot = -r.glow / L;
  assert.ok(
    oldReading(blindSpot) < 1e-9,
    `the old bound's blind spot is not at ${blindSpot}`,
  );

  for (const delta of [0.05, -0.05, -0.2, blindSpot, -0.4]) {
    assert.ok(
      oldAdmits(delta),
      `the superseded bound is claimed to admit a ${delta} radiance defect`,
    );
    const arm = evaluateLimbAbsoluteArm(
      landedArmInputs({ discRadianceMeasured: plateauAt(delta) }),
    );
    assert.equal(
      arm.state,
      ARM_STATE.RADIANCE_UNRECOVERED,
      `a ${delta} radiance defect still certified`,
    );
    assert.equal(
      arm.criteria.disc_radiance_recovers_resolved,
      false,
      `a ${delta} radiance defect was not scored red`,
    );
    // And by how much, so "it fails" is not read as "it barely fails".
    assert.ok(Math.abs(delta) / r.tolRel > 3);
  }

  // The 20% excess the follow-up named. It fails the new band by 17x — and,
  // stated honestly, it ALSO failed the old one: the old bound's blind side
  // was the DEFICIT direction, where the unmodelled glow masked the loss.
  const excess = evaluateLimbAbsoluteArm(
    landedArmInputs({ discRadianceMeasured: plateauAt(0.2) }),
  );
  assert.equal(excess.criteria.disc_radiance_recovers_resolved, false);
  assert.ok(0.2 / r.tolRel > 15);
  assert.equal(oldAdmits(0.2), false);

  // The tightening, as one number: ~30x.
  assert.ok(
    LIMB_DISC_RADIANCE_RECOVERY_TOLERANCE / r.tolRel > 20,
    `the band only tightened by ${LIMB_DISC_RADIANCE_RECOVERY_TOLERANCE / r.tolRel}x`,
  );
});

test("MUTATION: a build whose bloom never reached the disc is refused", () => {
  // The nearest competing picture to `L + glow` is `L` — the sun bloom absent
  // from the composite. It is what `powerVsGlowAbsent` measures the distance
  // to, and the criterion has to actually refuse it.
  const r = shippedRecoveryBand();
  const arm = evaluateLimbAbsoluteArm(
    landedArmInputs({ discRadianceMeasured: SHIPPED_DISC_RADIANCE }),
  );
  assert.equal(arm.state, ARM_STATE.RADIANCE_UNRECOVERED);
  assert.equal(arm.criteria.disc_radiance_recovers_resolved, false);
  // The doctrine bar: a band must sit at most a third of the way to the thing
  // it refuses, i.e. the separation must be at least 3 tolerances.
  assert.ok(
    r.powerVsGlowAbsent > 3,
    `the band is only ${r.powerVsGlowAbsent} tolerances from the glow-absent picture`,
  );
});

test("the band's error budget is three terms, one of them stochastic", () => {
  const r = shippedRecoveryBand();
  // E1 dominates and is a HARD bracket walked across the source-edge
  // uncertainty, so it enters at 1x.
  assert.ok(r.terms.glowError > 0);
  assert.ok(r.terms.edgeUncertaintyPx > 0);
  assert.ok(
    r.terms.glowError / (SHIPPED_DISC_RADIANCE * r.tolRel) > 0.8,
    "the source-edge bracket is no longer the dominant term",
  );
  // E2 is one code per leg, in quadrature, over the annulus population.
  assert.ok(r.terms.quant > 0);
  assert.ok(3 * r.terms.quant < r.terms.glowError);
  // E3 is EARNED, not assumed: at the shipped framing both legs sweep many
  // codes across the annulus, so the undithered residue is exactly zero.
  assert.equal(r.terms.undithered, 0);
  assert.ok(r.terms.legs.flat.sweepCodes > 1);
  assert.ok(r.terms.legs.legacy.sweepCodes > 1);
  assert.equal(r.terms.legs.flat.dithers, true);
  // ... and a band too narrow for either leg's code to move across DOES earn
  // it, which is what makes it a modelled term rather than a constant zero.
  const narrow = shippedRecoveryBand(SolarDiscModel, {
    annulus: { lo: 0.85, hi: 0.8501 },
  });
  assert.ok(narrow.terms.undithered > 0);
  assert.equal(narrow.terms.legs.flat.dithers, false);
  assert.ok(narrow.tolRel > r.tolRel);
  // The budget is the sum, capped.
  assert.equal(
    r.terms.budgetRel,
    (r.terms.glowError + r.terms.undithered + 3 * r.terms.quant) /
      SHIPPED_DISC_RADIANCE,
  );
  assert.equal(r.terms.capped, false);
  assert.ok(r.tolRel < DISC_RADIANCE_RECOVERY_CEILING);
});

test("the probe feeds the recovery band the FRAME's own bloom geometry", () => {
  // The derivation is only as good as what it is handed: the drawing buffer
  // (which sizes the blur buffer), the engine's own `limbPx`, and the MEASURED
  // disc radius the annulus was binned at. A probe that passed the crop, or
  // the modelled radius, would derive a glow for a picture nobody rendered.
  const src = readNormalized("./probe-celestial-gates.mjs");
  const call = src.slice(
    src.indexOf("radianceRecovery: deriveDiscRadianceRecoveryBand("),
  );
  const body = call.slice(0, call.indexOf("}),"));
  for (const line of [
    "discRadiance: disc?.shippedHaloState?.discRadiance",
    "limbPx: disc?.shippedHaloState?.limbPx",
    "discRadiusPx: disc.discRadiusPx",
    "viewportWidth: disc.canvasWidth",
    "viewportHeight: disc.canvasHeight",
    "plateauPixels: disc.discRadiancePlateauPixels",
  ]) {
    assert.ok(body.includes(line), `the probe does not pass \`${line}\``);
  }
  // ...and the drawing buffer reaches the disc metrics in the first place.
  assert.match(src, /canvasWidth: lane\.setup\.canvasWidth,/);
  assert.match(src, /canvasHeight: lane\.setup\.canvasHeight,/);
});

test("a degenerate geometry cannot buy itself a generous band", () => {
  // The source-edge bracket scales with the disc's screen size, so a frame
  // whose disc fills the buffer would derive a huge one. The shared ceiling is
  // what stops that from becoming a licence.
  const huge = shippedRecoveryBand(SolarDiscModel, {
    limbPx: 1000,
    discRadiusPx: 1000,
  });
  assert.equal(huge.terms.capped, true);
  assert.equal(huge.tolRel, DISC_RADIANCE_RECOVERY_CEILING);
});

test("R-2: a band that could not be derived is STRUCTURAL, not a pass", () => {
  const arm = evaluateLimbAbsoluteArm(
    landedArmInputs({ derivedBand: { band: { lo: NaN, hi: NaN } } }),
  );
  assert.equal(arm.state, ARM_STATE.BAND_UNDERIVED);
  assert.deepEqual(arm.criteria, {});
  assert.match(arm.reason, /cannot be derived is STRUCTURAL/);
});

// ===========================================================================
// 3b. THE DISC-ONLY BAND DERIVATION (ruling R-2026-08-10-2)
//
// The band is not a literal, so the spec's job is not to restate it — it is to
// prove the derivation READS each input it claims to read (a mutant on any one
// of them must move the band), that the chain model it is built on matches the
// shipped shader text, and that the band separates the shipped physics from
// every wrong reading it has to refuse.
// ===========================================================================

test("R-2 chain model: `solarDiscChainLuminance` matches the SHIPPED bake text", () => {
  const glsl = readNormalized(
    "../../packages/engine/Source/Shaders/SunTextureFS.glsl",
  );
  const cpu = readNormalized(
    "../../packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js",
  );
  const sunFs = readNormalized(
    "../../packages/engine/Source/Shaders/SunFS.glsl",
  );
  // The hue term the chain model carries, in BOTH bakes.
  assert.match(
    glsl,
    /vec4 color = vec4\(vec2\(1\.0\), surface \+ 0\.2, surface\);/,
    "the GLSL bake's rgb/alpha construction moved — re-derive the chain model",
  );
  assert.match(
    cpu,
    /let cb = surface \+ 0\.2;/,
    "the WebGPU CPU bake's blue term moved — re-derive the chain model",
  );
  assert.equal(SUN_BAKE_BLUE_HUE_OFFSET, 0.2);
  // The decode order the chain model assumes: gamma FIRST, radiance AFTER.
  // Anchored on the STATEMENTS, not the uniform declaration, which is above
  // both.
  const gammaAt = sunFs.indexOf("out_FragColor = czm_gammaCorrect(color);");
  const radianceAt = sunFs.indexOf("out_FragColor.rgb *= u_discRadiance;");
  assert.ok(gammaAt > 0 && radianceAt > gammaAt, "gamma must precede radiance");

  // And the model itself, recomputed here from the shipped weights.
  const w = [0.2126, 0.7152, 0.0722];
  for (const limb of [0.0, 0.15, 0.3, 0.5679674069255255, 0.8, 1.0]) {
    const blue = Math.min(1, limb + 0.2) ** SUN_BAKE_GAMMA_NOMINAL;
    const expected = limb * (w[0] + w[1] + w[2] * blue);
    assert.ok(
      Math.abs(solarDiscChainLuminance(limb) - expected) < 1e-15,
      `chain(${limb})`,
    );
  }
  // It is EXACTLY the identity at disc centre (blue clamps to 1 there), which
  // is what makes the ratio's denominator the law's own I(0).
  assert.equal(solarDiscChainLuminance(1.0), 1.0);
});

test("R-2 band: the shipped derivation, recomputed independently", () => {
  const d = shippedDiscOnlyBand();
  // The centre is the shipped law through the shipped chain, and nothing else.
  const pure =
    SolarDiscModel.solarLimbIntensity(0.95) /
    SolarDiscModel.solarLimbIntensity(0);
  assert.ok(Math.abs(d.pureLaw - pure) < 1e-15);
  assert.ok(
    Math.abs(
      d.predicted -
        solarDiscChainLuminance(pure) / solarDiscChainLuminance(1.0),
    ) < 1e-15,
    "the band centre must be chain(I(0.95)) / chain(I(0))",
  );
  // The hue term is REAL and is worth ~3.2% — the whole reason the band is
  // centred at 0.5499 rather than at the law's own 0.5680.
  assert.ok(d.predicted < d.pureLaw);
  assert.ok(Math.abs(d.predicted / d.pureLaw - 1) > 0.02);
  assert.ok(Math.abs(d.predicted / d.pureLaw - 1) < 0.05);
  // The two constraints the width sits between, both recomputed.
  assert.ok(Math.abs(d.terms.loBar - 3 * d.modelledRel) < 1e-15);
  assert.ok(Math.abs(d.terms.hiBar - d.separationRel / 3) < 1e-15);
  assert.ok(
    Math.abs(d.tolRel - Math.sqrt(d.terms.loBar * d.terms.hiBar)) < 1e-15,
    "the bar is the GEOMETRIC midpoint of its two constraints",
  );
  assert.ok(d.tolRel >= d.terms.loBar / 3);
  assert.ok(d.tolRel <= d.terms.hiBar * 3);
  // T1 (radial binning) must DOMINATE — if it ever stops dominating, the
  // derivation's stated story is wrong even if the number is not.
  assert.ok(
    d.terms.t1 > 5 * (d.terms.t2 + d.terms.t3),
    "radial binning must dominate the modelled error",
  );
  assert.ok(Math.abs(d.band.lo - d.predicted * (1 - d.tolRel)) < 1e-15);
  assert.ok(Math.abs(d.band.hi - d.predicted * (1 + d.tolRel)) < 1e-15);
});

test("R-2 band ADMITS the shipped physics and every published law", () => {
  const d = shippedDiscOnlyBand();
  const inBandLocal = (v) => v >= d.band.lo && v <= d.band.hi;
  assert.ok(inBandLocal(d.predicted), "the shipped prediction");
  assert.ok(inBandLocal(d.pureLaw), "the pure law without the hue term");
  // The published references from the CO-35 audit, transported to 550 nm and
  // pushed through the SAME chain. The band is a check on the RENDERING, so it
  // must not be tight enough to vote between defensible coefficient sets.
  const chainRatio = (law) =>
    solarDiscChainLuminance(law) / solarDiscChainLuminance(1.0);
  for (const [name, law] of [
    ["Pierce & Slaughter 1977", 0.572463],
    ["Neckel & Labs 1994", 0.574291],
    ["Hestroffer & Magnan 1998 power law", 0.553669],
  ]) {
    assert.ok(inBandLocal(chainRatio(law)), `${name} must be admitted`);
  }
});

test("R-2 band MUTANTS: wrong radiance, wrong law, halo contamination", () => {
  const shipped = shippedDiscOnlyBand();

  // MUTANT 1 — WRONG RADIANCE. The disc-only RATIO is radiance-invariant, so a
  // derivation that never read the radiance would produce an identical band and
  // the "derived from the shipped radiance 2.0" claim would be false. Radiance
  // enters through the display quantum, so it must move the WIDTH.
  for (const L of [1.0, 10.0, 1.0e5]) {
    const mutant = shippedDiscOnlyBand(SolarDiscModel, {
      discRadiance: L,
      haloAmplitude: SolarDiscModel.SOLAR_HALO_AMPLITUDE * L,
    });
    assert.ok(
      Math.abs(mutant.predicted - shipped.predicted) < 1e-15,
      "the ratio itself is radiance-INVARIANT (that is the point of it)",
    );
    assert.ok(
      Math.abs(mutant.tolRel - shipped.tolRel) > 1e-6,
      `radiance ${L} must move the derived tolerance`,
    );
  }
  // A derivation handed no radiance at all cannot produce a band.
  const noRadiance = shippedDiscOnlyBand(SolarDiscModel, {
    discRadiance: undefined,
  });
  assert.ok(!Number.isFinite(noRadiance.band.lo));

  // MUTANT 2 — WRONG LAW. Two plausible wrong implementations, each of which
  // must land OUTSIDE the shipped band AND generate its own, disjoint band.
  const mutantLaws = {
    "linear limb law 1 - 0.7x": (x) => 1 - 0.7 * Math.min(Math.max(x, 0), 1),
    "no limb darkening (flat disc)": () => 1.0,
    "extreme-limb a0 mistaken for 0.95R": (x) => (x > 0.5 ? 0.3 : 1.0),
  };
  for (const [name, law] of Object.entries(mutantLaws)) {
    const model = { ...SolarDiscModel, solarLimbIntensity: law };
    const mutant = shippedDiscOnlyBand(model);
    assert.ok(
      mutant.predicted < shipped.band.lo || mutant.predicted > shipped.band.hi,
      `${name}: its own prediction must fail the SHIPPED band`,
    );
    // And symmetrically the shipped reading must not survive the mutant's own
    // band — either because it falls outside it, or because the mutant law
    // admits no band at all. The flat disc is the second case by construction:
    // with `I == 1` the composite sits BELOW the disc-only value (the halo is
    // dimmer than the disc everywhere), so there is no contamination to
    // separate from and the derivation refuses to emit a bound rather than
    // inventing one.
    const refused =
      !Number.isFinite(mutant.band.lo) ||
      shipped.predicted < mutant.band.lo ||
      shipped.predicted > mutant.band.hi;
    assert.ok(
      refused,
      `${name}: the SHIPPED reading must not survive ITS band`,
    );
  }
  // A coefficient nudge INSIDE the published spread must NOT flip the verdict —
  // the band is a rendering check, not a coefficient vote.
  for (const a0 of [SolarDiscModel.SOLAR_LIMB_DARKENING_A0 - 0.016, 0.30505]) {
    const a1 = SolarDiscModel.SOLAR_LIMB_DARKENING_A1;
    const a2 = 1 - a0 - a1;
    const model = {
      ...SolarDiscModel,
      solarLimbIntensity: (x) => {
        const xc = Math.min(Math.max(x, 0), 1);
        const mu = Math.sqrt(Math.max(0, 1 - xc * xc));
        return a0 + a1 * mu + a2 * mu * mu;
      },
    };
    const near = shippedDiscOnlyBand(model);
    assert.ok(
      near.predicted >= shipped.band.lo && near.predicted <= shipped.band.hi,
      `a0 = ${a0} is inside the published spread and must stay admitted`,
    );
  }

  // MUTANT 3 — HALO-CONTAMINATED MEASUREMENT. The composite is what the old
  // arm read; feeding it to the disc-only criterion must fail, in BOTH its
  // modelled and its measured forms.
  const composite = expectedCompositeLimbRatio(SolarDiscModel, {
    discRadiance: SHIPPED_DISC_RADIANCE,
    haloAmplitude: SHIPPED_HALO_AMPLITUDE,
    haloCoreRadii: SHIPPED_HALO_CORE_RADII,
  });
  for (const v of [
    composite.compositeRatio,
    composite.compositeRatioChroma,
    0.7138,
    0.7181,
    0.6509,
  ]) {
    assert.ok(
      v < shipped.band.lo || v > shipped.band.hi,
      `a halo-contaminated reading (${v}) must be refused`,
    );
  }
  // And the derivation's own separation term is measured against exactly that
  // contamination, with the stated 3x margin.
  assert.ok(shipped.separationRel > 3 * shipped.tolRel * 0.999);
});

test("R-2: the SUPERSEDED [0.3, 0.5] band fits the EXTREME limb, not 0.95R", () => {
  // The old bound is not deleted, and this is why: it is the right band for
  // I(R)/I(0), which is `a0`. Pierce & Slaughter 1977 give 0.30505 and the
  // shipped law 0.30 — both inside — while NOTHING lands there at 0.95R.
  assert.ok(
    SolarDiscModel.solarLimbIntensity(1.0) >= LIMB_ABSOLUTE_RATIO_BAND.lo &&
      SolarDiscModel.solarLimbIntensity(1.0) <= LIMB_ABSOLUTE_RATIO_BAND.hi,
    "I(R)/I(0) = a0 sits inside the old band",
  );
  const at095 =
    SolarDiscModel.solarLimbIntensity(0.95) /
    SolarDiscModel.solarLimbIntensity(0);
  assert.ok(
    at095 > LIMB_ABSOLUTE_RATIO_BAND.hi,
    "I(0.95R)/I(0) is above the old ceiling before any halo — the recorded 0.568",
  );
  // Every published reference at ~550 nm is above it too, so the old bound was
  // unreachable for physics reasons, not for rendering reasons.
  for (const ref of [0.553669, 0.567967, 0.572463, 0.574291, 0.59397]) {
    assert.ok(ref > LIMB_ABSOLUTE_RATIO_BAND.hi);
  }
});

test("PENDING ARM: disagreeing discriminators are STRUCTURAL, not a guess", () => {
  const clampGoneButDim = evaluateLimbAbsoluteArm({
    bakeClampPresent: false,
    discPeakLinear: 1.5,
    ratioI095overI0: 0.42,
  });
  assert.equal(clampGoneButDim.state, ARM_STATE.DISAGREEMENT);
  assert.deepEqual(clampGoneButDim.criteria, {});
  const clampThereButBright = evaluateLimbAbsoluteArm({
    bakeClampPresent: true,
    discPeakLinear: 900,
    ratioI095overI0: 0.42,
  });
  assert.equal(clampThereButBright.state, ARM_STATE.DISAGREEMENT);
});

test("PENDING ARM: an unreadable bake source is UNDETERMINED, never a silent skip", () => {
  const arm = evaluateLimbAbsoluteArm({
    bakeClampPresent: null,
    discPeakLinear: 1.7,
    ratioI095overI0: 0.42,
  });
  assert.equal(arm.state, ARM_STATE.UNDETERMINED);
  assert.deepEqual(arm.criteria, {});
  assert.match(arm.reason, /UNKNOWN/);
});

// ===========================================================================
// 4. SUB-LANE EVALUATION AND VERDICT DOCTRINE
// ===========================================================================

function goodDisc() {
  const m = measureSynthDisc();
  return { ...m, hdrEngaged: true, ephemerisDiameterDeg: m.discDiameterDeg };
}

function goodHalo() {
  const m = measureHaloProfile({
    screen: renderHaloLeg(SYNTH_HALO),
    bake: renderHaloLeg(SYNTH_BAKED_HALO),
    limbPx: HALO_LIMB_PX,
    model: SolarDiscModel,
  });
  return {
    ...m,
    hdrEngaged: true,
    cropRadiusPx: HALO_SIZE / 2,
    screenLeg: {
      screenHalo: true,
      bakeHaloGain: 0,
      haloIntensity: 0.75,
      eclipseFactor: 1,
    },
    bakeLeg: { screenHalo: false, bakeHaloGain: 1, haloIntensity: 0 },
    sunVisibleFraction: 1,
    sunEclipseAlpha: 1,
  };
}

function goodPolicy() {
  return {
    displayIsHdr: false,
    hdrSupported: true,
    policy: HDR_EXPECTED_POLICY,
    sceneHdrOn: false,
    canvasOutputOn: false,
    sceneHdrUserSet: false,
    controlRan: true,
    controlSceneHdrOn: true,
    restoredSceneHdrOn: false,
    restoredSceneHdrUserSet: false,
  };
}

function goodEarthshine() {
  return {
    enableEarthshine: true,
    aimDistancePx: 0,
    scaleCrescent: 0.88,
    scaleQuarter: 0.5,
    scaleFull: 0.02,
    crescent: synthEarthshine(0.12, 0.88),
    quarter: synthEarthshine(0.5, 0.5),
    full: synthFullInertness(0.02),
  };
}

function goodTerminator() {
  return {
    ...synthTerminator(softTerminatorMu0),
    aimDistancePx: 0,
    softnessOff: 0,
    softnessOn: MEAN_SOLAR_ANGULAR_RADIUS,
  };
}

function goodPhase(overrides = {}) {
  return {
    epochs: {
      full: { phaseFraction: 0.995 },
      quarter: { phaseFraction: 0.5 },
      crescent: { phaseFraction: 0.12 },
    },
    fullPhaseAngleDeg: 4.0,
    fullSurgeMultiplier: 1.13,
    fullQuarterRatio: 4.2,
    quarterCrescentRatio: 3.0,
    ...overrides,
  };
}

test("every sub-lane passes on well-formed metrics", () => {
  assert.equal(evaluateDiscSubLane(goodDisc()).pass, true);
  assert.equal(evaluateHaloSubLane(goodHalo()).pass, true);
  assert.equal(evaluatePolicySubLane(goodPolicy()).pass, true);
  assert.equal(evaluateEarthshineSubLane(goodEarthshine()).pass, true);
  assert.equal(evaluateTerminatorSubLane(goodTerminator()).pass, true);
  assert.equal(evaluatePhaseSubLane(goodPhase()).pass, true);
});

test("the C12-18 one-halo-source invariant is exhaustive, and DOUBLE HALO is rejected", () => {
  const doubled = goodHalo();
  doubled.screenLeg = { ...doubled.screenLeg, bakeHaloGain: 1 };
  const verdict = evaluateHaloSubLane(doubled);
  assert.equal(verdict.criteria.halo_screenLeg_bakeGain_is_zero, false);
  assert.equal(verdict.pass, false);
  // ...and the opposite failure, NO halo at all, is rejected too.
  const none = goodHalo();
  none.bakeLeg = { ...none.bakeLeg, bakeHaloGain: 0 };
  assert.equal(
    evaluateHaloSubLane(none).criteria.halo_bakeLeg_bakeGain_is_one,
    false,
  );
});

test("the eclipse alpha chain is asserted as EXACT identity, not approximately", () => {
  for (const key of ["sunVisibleFraction", "sunEclipseAlpha"]) {
    const m = goodHalo();
    m[key] = 0.999999;
    const verdict = evaluateHaloSubLane(m);
    assert.equal(verdict.pass, false, `${key} = 0.999999 must not pass`);
  }
  const m = goodHalo();
  m.screenLeg = { ...m.screenLeg, eclipseFactor: 0.999999 };
  assert.equal(
    evaluateHaloSubLane(m).criteria.eclipse_haloEclipseFactor_is_one,
    false,
  );
});

test("MUTANT REJECTED — the C12-28 SDR leg without its positive control", () => {
  // The row's own finding: the SDR readings pass identically with the feature
  // reverted. A reverted build resolves nothing, so the forced-HDR control does
  // not flip — and that is the only criterion that can tell the two apart.
  const reverted = { ...goodPolicy(), controlSceneHdrOn: false };
  const verdict = evaluatePolicySubLane(reverted);
  assert.equal(
    verdict.criteria.hdr_control_flipsOn_for_synthetic_hdr_display,
    false,
  );
  assert.equal(verdict.pass, false);
  // The three SDR criteria are all still green in that build — which is exactly
  // why the control is not optional.
  assert.equal(verdict.criteria.hdr_sdrDisplay_scene_stays_off, true);
  assert.equal(verdict.criteria.hdr_policy_default_is_scene, true);
});

test("an HDR display makes the C12-28 SDR leg STRUCTURAL, not a failure", () => {
  const verdict = evaluatePolicySubLane({
    ...goodPolicy(),
    displayIsHdr: true,
  });
  assert.equal(verdict.pass, false);
  assert.deepEqual(verdict.criteria, {});
  assert.ok(verdict.structural.some((s) => /dynamic-range/.test(s)));
});

test("the full:quarter bar is REACHABILITY-GATED, and the measurement is reported either way", () => {
  const reachable = evaluatePhaseSubLane(goodPhase());
  assert.equal(reachable.surgeReachable, true);
  assert.equal(
    reachable.criteria.moon_fullQuarterRatio_exceeds_lambertian,
    true,
  );
  // At the demo's 0.98 framing the surge contributes ~3%, so §5's bar is not
  // reachable — the arm must NOT fail the gate for a framing it could not
  // reach, and it must print the number.
  const unreachable = evaluatePhaseSubLane(
    goodPhase({
      fullPhaseAngleDeg: 16.3,
      fullSurgeMultiplier: 1.035,
      fullQuarterRatio: 2.6,
    }),
  );
  assert.equal(unreachable.surgeReachable, false);
  assert.equal(
    unreachable.criteria.moon_fullQuarterRatio_exceeds_lambertian,
    undefined,
  );
  assert.ok(unreachable.structural.some((s) => s.includes("2.6")));
  assert.ok(unreachable.structural.some((s) => /16.3/.test(s)));
  // A REACHABLE epoch below the bar IS a failure — the gate is not toothless.
  const red = evaluatePhaseSubLane(goodPhase({ fullQuarterRatio: 2.6 }));
  assert.equal(red.criteria.moon_fullQuarterRatio_exceeds_lambertian, false);
  assert.equal(red.pass, false);
});

test("a phase search that missed its target is STRUCTURAL, not a product verdict", () => {
  const missed = evaluatePhaseSubLane(
    goodPhase({
      epochs: {
        full: { phaseFraction: 0.995 },
        quarter: { phaseFraction: 0.71 },
        crescent: { phaseFraction: 0.12 },
      },
    }),
  );
  assert.equal(missed.pass, false);
  assert.deepEqual(missed.criteria, {});
  assert.ok(missed.structural.some((s) => /quarter/.test(s)));
  const noFullMoon = evaluatePhaseSubLane(
    goodPhase({
      epochs: {
        full: { phaseFraction: 0.9 },
        quarter: { phaseFraction: 0.5 },
        crescent: { phaseFraction: 0.12 },
      },
    }),
  );
  assert.ok(
    noFullMoon.structural.some((s) =>
      s.includes(String(MOON_FULL_MIN_PHASE_FRACTION)),
    ),
  );
});

test("a mis-aimed moon lane is STRUCTURAL — the masks would cover the wrong disc", () => {
  const es = evaluateEarthshineSubLane({
    ...goodEarthshine(),
    aimDistancePx: MOON_AIM_TOLERANCE_PX + 1,
  });
  assert.equal(es.pass, false);
  assert.deepEqual(es.criteria, {});
  const term = evaluateTerminatorSubLane({
    ...goodTerminator(),
    aimDistancePx: MOON_AIM_TOLERANCE_PX + 1,
  });
  assert.equal(term.pass, false);
  assert.deepEqual(term.criteria, {});
});

test("earthshine default-OFF is STRUCTURAL — ruling R5 shipped it ON", () => {
  const verdict = evaluateEarthshineSubLane({
    ...goodEarthshine(),
    enableEarthshine: false,
  });
  assert.equal(verdict.pass, false);
  assert.ok(verdict.structural.some((s) => /R5/.test(s)));
});

test("a non-zero OFF softness voids the terminator A/B", () => {
  const verdict = evaluateTerminatorSubLane({
    ...goodTerminator(),
    softnessOff: 1e-9,
  });
  assert.equal(verdict.pass, false);
  assert.deepEqual(verdict.criteria, {});
});

function goodBackend(renderer) {
  return {
    renderer,
    disc: goodDisc(),
    halo: goodHalo(),
    policy: goodPolicy(),
    earthshine: goodEarthshine(),
    terminator: goodTerminator(),
    phase: goodPhase(),
    limbAbsolute: {
      bakeClampPresent: true,
      discPeakLinear: 1.7,
      ratioI095overI0: 0.9,
    },
  };
}

test("a clean run PASSES on both backends, with the pending arm surfaced separately", () => {
  const evaluated = {
    webgl: evaluateG4Backend(goodBackend("webgl")),
    webgpu: evaluateG4Backend(goodBackend("webgpu")),
  };
  const folded = foldG4Verdict(evaluated);
  assert.equal(folded.verdict, "PASS");
  assert.equal(folded.exitCode, EXIT_CODE.PASS);
  assert.deepEqual(folded.failures, []);
  // The arm is NOT in `criteria` and IS in `pendingArms`, on both backends.
  assert.equal(
    evaluated.webgl.criteria.limb_absoluteRatio_I095_over_I0_in_band,
    undefined,
  );
  assert.equal(Object.keys(folded.pendingArms).length, 2);
  for (const arm of Object.values(folded.pendingArms)) {
    assert.equal(arm.state, ARM_STATE.PENDING_CONTENT);
    assert.match(arm.pending, /C12-19/);
  }
});

test("a pass on ONE backend is a FAIL for the gate (principle 5)", () => {
  const broken = goodBackend("webgpu");
  broken.terminator = {
    ...broken.terminator,
    changedPixels: 0,
  };
  const folded = foldG4Verdict({
    webgl: evaluateG4Backend(goodBackend("webgl")),
    webgpu: evaluateG4Backend(broken),
  });
  assert.equal(folded.verdict, "FAIL");
  assert.ok(folded.failures.includes("webgpu:terminator_band_exists"));
  assert.ok(!folded.failures.some((f) => f.startsWith("webgl:")));
});

test("an empty criteria set is NOT a pass", () => {
  const folded = foldG4Verdict({
    webgl: {
      renderer: "webgl",
      criteria: {},
      structural: [],
      pendingArms: {},
      parityScalars: {},
      parityCounts: {},
    },
    webgpu: {
      renderer: "webgpu",
      criteria: {},
      structural: [],
      pendingArms: {},
      parityScalars: {},
      parityCounts: {},
    },
  });
  assert.equal(folded.verdict, "STRUCTURAL");
  assert.equal(folded.exitCode, EXIT_CODE.STRUCTURAL);
  assert.equal(folded.structural.length, 2);
});

test("a criterion failure OUTRANKS a structural leg", () => {
  const structuralOnly = goodBackend("webgl");
  structuralOnly.policy = { ...goodPolicy(), displayIsHdr: true };
  const failing = goodBackend("webgpu");
  failing.halo = { ...goodHalo(), sunVisibleFraction: 0.5 };
  const folded = foldG4Verdict({
    webgl: evaluateG4Backend(structuralOnly),
    webgpu: evaluateG4Backend(failing),
  });
  assert.equal(folded.verdict, "FAIL");
  assert.ok(folded.structural.length > 0, "the structural note must survive");
});

test("a missing backend is STRUCTURAL and names the backend", () => {
  const folded = foldG4Verdict({
    webgl: evaluateG4Backend(goodBackend("webgl")),
  });
  assert.equal(folded.verdict, "STRUCTURAL");
  assert.ok(folded.structural.some((s) => s.startsWith("webgpu")));
});

test("cross-backend disagreement on a headline scalar is a FAIL", () => {
  const drifted = goodBackend("webgpu");
  drifted.disc = { ...drifted.disc, trueSizeRatio: 1.0 };
  const folded = foldG4Verdict({
    webgl: evaluateG4Backend(goodBackend("webgl")),
    webgpu: evaluateG4Backend(drifted),
  });
  assert.equal(folded.verdict, "FAIL");
  assert.ok(
    folded.failures.some((f) => f.startsWith("cross-backend:trueSizeRatio")),
  );
});

test("a pending arm resolving differently per backend is a FAIL", () => {
  const landed = goodBackend("webgpu");
  landed.limbAbsolute = landedArmInputs();
  const folded = foldG4Verdict({
    webgl: evaluateG4Backend(goodBackend("webgl")),
    webgpu: evaluateG4Backend(landed),
  });
  assert.equal(folded.verdict, "FAIL");
  assert.ok(
    folded.failures.some(
      (f) =>
        f ===
        "cross-backend:limbAbsoluteArm_state (webgl STRUCTURAL-pending-content, webgpu ACTIVE)",
    ),
  );
});

test("buildG4Summary carries every bound WITH the verdict", () => {
  const evaluated = {
    webgl: evaluateG4Backend(goodBackend("webgl")),
    webgpu: evaluateG4Backend(goodBackend("webgpu")),
  };
  const folded = foldG4Verdict(evaluated);
  const summary = buildG4Summary({ ...folded, backends: evaluated });
  assert.equal(summary.gate, "G4");
  for (const key of [
    "SOLAR_ANGULAR_DIAMETER_NOMINAL_DEG",
    "TRUE_SIZE_RATIO_NOMINAL",
    "LIMB_SHAPE_MAX_REL_DEV",
    "HALO_DELTA_PEAK_NOMINAL_RSUN",
    "HALO_BAND_RSUN",
    "MOON_PHASE_TARGETS",
    "SURGE_REACHABLE_MAX_PHASE_ANGLE_DEG",
    "EARTHSHINE_TINT_BR_NOMINAL",
    "TERMINATOR_SOFTNESS_BAND",
    "G4_CROSS_BACKEND_MAX_COUNT_SPREAD",
  ]) {
    assert.ok(key in summary.bounds, `${key} missing from the printed bounds`);
  }
  assert.ok(summary.pendingArms);
  assert.equal(
    summary.backends.webgl.criteria.disc_trueSizeRatio_is_sqrt2,
    true,
  );
});

// ===========================================================================
// 5. SOURCE ANCHORS — the lane is wired, and the things it keys on exist
// ===========================================================================

test("the probe declares --g4, dispatches to runG4, and writes its own report", () => {
  const src = readNormalized("./probe-celestial-gates.mjs");
  assert.match(src, /const G4 = process\.argv\.includes\("--g4"\)/);
  assert.match(src, /G4\s*\n?\s*\?\s*await runG4\(browser, git\)/);
  assert.match(src, /"celestial-g4\.json"/);
  assert.match(src, /buildG4Summary/);
  // The pending-arm block must be PRINTED, not merely computed.
  assert.match(src, /PENDING ARMS \(bound, NOT certifying at this commit\)/);
});

test("the G4 lane order puts `policy` first and the shipped default last", () => {
  const src = readNormalized("./probe-celestial-gates.mjs");
  const defs = src.slice(src.indexOf("const G4_LANE_DEFS"));
  const body = defs.slice(0, defs.indexOf("\n];"));
  // `policy` runs before any capture pins the HDR flag as user-set.
  assert.ok(
    body.indexOf('key: "policy"') < body.indexOf('key: "disc"'),
    "the policy lane must run first",
  );
  // Within each A/B lane the SHIPPED state is captured last.
  assert.ok(body.indexOf("`flat-${e}x`") < body.indexOf("`limb-${e}x`"));
  assert.ok(body.indexOf("`legacy-${e}x`") < body.indexOf("`limb-${e}x`"));
  assert.ok(body.indexOf("`bake-${e}x`") < body.indexOf("`screen-${e}x`"));
  assert.ok(body.indexOf("`esOff-${e}x`") < body.indexOf("`esOn-${e}x`"));
  assert.ok(body.indexOf("`softOff-${e}x`") < body.indexOf("`softOn-${e}x`"));
});

test("the C12-19 discriminator reads ABSENT on the landed split and PRESENT on the historical clamp", () => {
  // AUTHORED pre-Batch-937, this test pinned the historical combined
  // `out_FragColor = clamp(color, ...)` as text-that-must-exist. C12-19 then
  // LANDED (Batch 937) by SPLITTING that clamp — `vec4(chroma, blendWeight)`
  // with the radiance as a separate linear scale — which is exactly the
  // "for the reason of C12-19 landing" case the original test carved out.
  // Updated at landing: the discriminator's ABSENT verdict must now rest on
  // the real current text, and the historical text must still read PRESENT
  // so a rollback (or the pre-change server) cannot silently activate.
  const detector = /out_FragColor\s*=\s*clamp\s*\(\s*color/;
  const glsl = readNormalized(
    "../../packages/engine/Source/Shaders/SunTextureFS.glsl",
  );
  // The landed bake: combined clamp GONE, named split + radiance uniform in
  // SunFS present.
  assert.ok(
    !detector.test(glsl),
    "the combined clamp is back in SunTextureFS.glsl — if C12-19 was reverted, revert this test's update with it",
  );
  assert.match(
    glsl,
    /out_FragColor\s*=\s*vec4\s*\(\s*chroma\s*,\s*blendWeight\s*\)/,
  );
  const sunFs = readNormalized(
    "../../packages/engine/Source/Shaders/SunFS.glsl",
  );
  assert.match(sunFs, /u_discRadiance/);
  // The probe still carries the detector, and it still fires on the
  // historical text — the rollback direction stays covered.
  const probe = readNormalized("./probe-celestial-gates.mjs");
  assert.match(probe, /out_FragColor\\s\*=\\s\*clamp\\s\*\\\(\\s\*color/);
  assert.ok(
    detector.test("    out_FragColor = clamp(color, vec4(0.0), vec4(1.0));"),
  );
  // The WebGPU CPU twin's split saturation is the other half of the same row;
  // recorded so "both bakes" is not an unchecked claim.
  const wgpu = readNormalized(
    "../../packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js",
  );
  assert.match(wgpu, /blendWeight/);
  assert.match(wgpu, /discRadiance/);
});

test("ruling R5 is real: `enableEarthshine` ships ON", () => {
  const ac = readNormalized(
    "../../packages/engine/Source/Scene/AtmosphericConditions.js",
  );
  assert.match(ac, /enableEarthshine:\s*true/);
  assert.match(ac, /enableEarthshinePhase:\s*true/);
  assert.match(ac, /enableSoftTerminator:\s*true/);
  assert.match(ac, /enableTrueSolarDiscSize:\s*true/);
  assert.match(ac, /enableScreenSpaceSunHalo:\s*true/);
  assert.match(ac, /enableSolarLimbDarkening:\s*true/);
});

test("the phase targets are the moon-appearance demo's own established framings", () => {
  const demo = readNormalized(
    "../../packages/sandcastle/gallery/moon-appearance/main.js",
  );
  assert.match(demo, /phase:\s*0\.12/);
  assert.match(demo, /phase:\s*0\.5\b/);
  assert.match(demo, /function findTimeForPhase/);
  assert.equal(MOON_PHASE_TARGETS.crescent, 0.12);
  assert.equal(MOON_PHASE_TARGETS.quarter, 0.5);
  // The FULL target is raised to 1.0 on purpose — the demo's 0.98 sits 16 deg
  // from opposition, where the surge is inert.
  assert.equal(MOON_PHASE_TARGETS.full, 1.0);
  // The probe reuses the demo's search window rather than inventing one.
  const probe = readNormalized("./probe-celestial-gates.mjs");
  assert.match(demo, /2026-07-01T00:00:00Z/);
  assert.match(probe, /G4_MOON_SEARCH_START_ISO = "2026-07-01T00:00:00Z"/);
  assert.match(probe, /G4_MOON_SEARCH_DAYS = 32/);
});

test("MOON_PHASE_TARGET_TOLERANCE is loose enough for the 10-minute refinement", () => {
  // The refinement grid is 10 minutes; near quarter phase the illuminated
  // fraction moves ~0.008 per 10 minutes, so a correct search lands inside
  // ~0.004. The tolerance must clear that by a real margin without becoming a
  // tolerance that accepts a failed search.
  assert.ok(MOON_PHASE_TARGET_TOLERANCE >= 0.02);
  assert.ok(MOON_PHASE_TARGET_TOLERANCE <= 0.05);
  // ...and it must not be wide enough to let `crescent` be mistaken for
  // `quarter`, which is the search failure it exists to catch.
  assert.ok(
    MOON_PHASE_TARGET_TOLERANCE <
      Math.abs(MOON_PHASE_TARGETS.quarter - MOON_PHASE_TARGETS.crescent) / 4,
  );
});

test("MEDIAN and RADIAL PROFILE helpers behave on degenerate input", () => {
  assert.ok(Number.isNaN(median([])));
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  const blank = {
    data: new Float64Array(16),
    width: 2,
    height: 2,
  };
  const p = radialProfile(blank, 1, 1, 1);
  assert.equal(p.mean.length, 2);
  assert.ok(p.mean.every((v) => v === 0 || Number.isNaN(v)));
});

test("DISC_EPHEMERIS_TOLERANCE is tighter than the ratified 5% and looser than binning", () => {
  assert.ok(DISC_EPHEMERIS_TOLERANCE < SOLAR_ANGULAR_DIAMETER_TOLERANCE);
  // 0.5 px on a modelled 170 px radius is 0.3%; the bar is 10x that.
  assert.ok(DISC_EPHEMERIS_TOLERANCE > (0.5 / 170) * 5);
});

test("MOON_FULL_QUARTER_RATIO_MIN is §5's ratified Lambertian bar", () => {
  assert.equal(MOON_FULL_QUARTER_RATIO_MIN, 3.0);
  assert.ok(MOON_FULL_QUARTER_RATIO_MIN < Math.PI);
  assert.ok(EARTHSHINE_INERTNESS_FACTOR >= 1);
});

// ===========================================================================
// 9. THE BATCH-941 FIRST-RUN REPAIRS — `G4-FIRSTRUN-FIX-1..5`
//
// Every rule below is stated once and then run against the WRONG
// implementation, which is in each case the implementation that shipped in
// Batch 941 and produced its seven reds.
// ===========================================================================

// --- FIX-1: the aim diagnostic must DISCRIMINATE, not describe --------------

test("FIX-1: an aim diagnostic separates a mis-aimed CAMERA from a mis-drawn SUN", () => {
  // CASE A — camera mis-aimed. The ephemeris projection and the measured light
  // land on the SAME spot, both off centre. That is an instrument defect.
  const cameraMissed = buildAimDiagnostic({
    measuredPx: { x: 419.78, y: 240.93 },
    width: 1000,
    height: 640,
    fovXDeg: 2.0,
    canvasWidth: 1280,
    sunProjection: { x: 419.9, y: 241.0 },
  });
  assert.ok(cameraMissed.measuredOffsetPx > 100);
  assert.ok(cameraMissed.ephemerisVsMeasuredPx < 1);
  assert.match(
    describeAimMiss("disc", cameraMissed, DISC_AIM_TOLERANCE_PX),
    /CAMERA AIM is what is displaced/,
  );

  // CASE B — the Sun is not drawn where the ephemeris says. Same measured
  // offset, but now the two references DISAGREE, and the note must NOT call
  // that aim.
  const sunMisdrawn = buildAimDiagnostic({
    measuredPx: { x: 419.78, y: 240.93 },
    width: 1000,
    height: 640,
    fovXDeg: 2.0,
    canvasWidth: 1280,
    sunProjection: { x: 500, y: 320 },
  });
  assert.ok(sunMisdrawn.ephemerisVsMeasuredPx > DISC_AIM_TOLERANCE_PX);
  assert.match(
    describeAimMiss("disc", sunMisdrawn, DISC_AIM_TOLERANCE_PX),
    /DISAGREE/,
  );
  assert.doesNotMatch(
    describeAimMiss("disc", sunMisdrawn, DISC_AIM_TOLERANCE_PX),
    /CAMERA AIM is what is displaced/,
  );
});

test("FIX-1: the aim miss is reported in DEGREES, and the two sun lanes agree there", () => {
  // The whole reason the first run's decomposition was arguable: 111.65 px and
  // 3.38 px look like different defects until they are converted. They are the
  // SAME angle, and only the degree figure says so.
  const discDeg = angleDegForPixelOffset(111.65251611227245, 2.0, 1280);
  const haloDeg = angleDegForPixelOffset(
    Math.hypot(637.6121917687179 - 640, 362.3878 - 360),
    60.0,
    1280,
  );
  assert.ok(
    relativeDeviation(discDeg, haloDeg) < 0.01,
    `disc ${discDeg} deg vs halo ${haloDeg} deg`,
  );
  // ...and that common angle is sqrt(2) times WGS84's geodetic-vs-geocentric
  // deflection at the Sun's declination on the pinned epoch (19.8024 deg),
  // which is the closed form of the `Camera.setView` gimbal-lock defect the
  // probe now repairs. `f = 1/298.257223563`.
  const f = 1.0 / 298.257223563;
  const phi = (19.8024 * Math.PI) / 180;
  const predictedDeg = (Math.SQRT2 * f * Math.sin(2 * phi) * 180) / Math.PI;
  assert.ok(
    relativeDeviation(discDeg, predictedDeg) < 0.01,
    `measured ${discDeg} deg vs closed form ${predictedDeg} deg`,
  );
});

test("FIX-1: a widened halo aim search REPORTS the miss instead of capping it", () => {
  // Batch 941 reported 11.7686 px against a search radius of 12 — a floor, not
  // a measurement. The certifying tolerance is NOT touched.
  assert.ok(HALO_AIM_SEARCH_RADIUS_PX > HALO_AIM_TOLERANCE_PX * 4);
  assert.equal(HALO_AIM_TOLERANCE_PX, 6);
  // ...and it must stay inside the 16 R_sun band it is about to measure, or the
  // search could latch onto the halo itself.
  const bandInnerPx = HALO_BAND_RSUN.inner * 5.095441965074199;
  assert.ok(
    HALO_AIM_SEARCH_RADIUS_PX < bandInnerPx,
    `search ${HALO_AIM_SEARCH_RADIUS_PX} px vs band inner ${bandInnerPx} px`,
  );
  // The measurement itself: a source planted 30 px out is FOUND at 30 px by the
  // new radius and CAPPED at 12 by the old one.
  const size = 200;
  const image = {
    data: new Float64Array(size * size * 4),
    width: size,
    height: size,
  };
  const px = size / 2 + 30;
  const py = size / 2;
  image.data[4 * (py * size + px) + 1] = 10;
  assert.ok(
    Math.abs(
      brightestWithinRadius(
        image,
        size / 2,
        size / 2,
        HALO_AIM_SEARCH_RADIUS_PX,
      ).distance - 30,
    ) < 1.5,
  );
  assert.ok(
    brightestWithinRadius(image, size / 2, size / 2, 12).distance <= 12,
    "the old radius can only ever report its own wall",
  );
});

// --- FIX-2: the parity fold is scoped per lane -----------------------------

function structuralDiscBackend(renderer) {
  const b = goodBackend(renderer);
  // Exactly Batch 941's webgl disc: a mis-aimed centroid, so the lane declares
  // itself unable to see its subject AND publishes a nonsense diameter.
  b.disc = {
    ...b.disc,
    aimDistancePx: 112.63205854313084,
    discDiameterDeg: 0.29243585918925186,
    trueSizeRatio: 2.2580207250107804,
  };
  return b;
}

test("FIX-2 MUTANT REJECTED — an UNGATED parity fold files structural-lane numbers as failures", () => {
  // The mutant is the shipped Batch-941 fold: compare any two finite scalars.
  const gl = evaluateG4Backend(structuralDiscBackend("webgl"));
  const gpu = evaluateG4Backend(goodBackend("webgpu"));
  const ungated = [];
  for (const key of Object.keys(gl.parityScalars)) {
    const a = gl.parityScalars[key];
    const b = gpu.parityScalars[key];
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      continue;
    }
    if (!(relativeSpread(a, b) <= G4_CROSS_BACKEND_MAX_RELATIVE_SPREAD)) {
      ungated.push(key);
    }
  }
  assert.ok(
    ungated.includes("discDiameterDeg") && ungated.includes("trueSizeRatio"),
    `the ungated fold must produce the failures it produced in Batch 941, got ${ungated}`,
  );

  // The SHIPPED fold must not. Same inputs, and the same numbers are reported —
  // as STRUCTURAL, by name, never silently dropped.
  const folded = foldG4Verdict({ webgl: gl, webgpu: gpu });
  for (const key of ["discDiameterDeg", "trueSizeRatio"]) {
    assert.ok(
      !folded.failures.some((f) => f.startsWith(`cross-backend:${key}_parity`)),
      `${key} parity must not FAIL off a structural lane`,
    );
    const note = folded.structural.find((s) =>
      s.startsWith(`cross-backend:${key}_parity`),
    );
    assert.ok(note, `${key} parity must be reported STRUCTURAL BY NAME`);
    assert.match(note, /MEASURED ANYWAY/);
    assert.match(note, /source sub-lane 'disc'/);
  }
});

test("FIX-2: parity still CERTIFIES when both source lanes can see their subject", () => {
  const gl = evaluateG4Backend(goodBackend("webgl"));
  const drifted = goodBackend("webgpu");
  drifted.disc = { ...drifted.disc, discDiameterDeg: 0.9 };
  const folded = foldG4Verdict({
    webgl: gl,
    webgpu: evaluateG4Backend(drifted),
  });
  assert.ok(
    folded.failures.some((f) =>
      f.startsWith("cross-backend:discDiameterDeg_parity"),
    ),
    "gating must not make the fold toothless",
  );
});

test("FIX-2: every parity scalar declares the sub-lane it came from", () => {
  const gl = evaluateG4Backend(goodBackend("webgl"));
  for (const key of [
    ...Object.keys(gl.parityScalars),
    ...Object.keys(gl.parityCounts),
  ]) {
    assert.ok(
      typeof PARITY_SCALAR_SOURCE_LANE[key] === "string",
      `${key} has no declared source lane`,
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(
        gl.subLaneStructural,
        PARITY_SCALAR_SOURCE_LANE[key],
      ),
      `${key} names a sub-lane that does not exist`,
    );
  }
});

// --- G4-FOLLOWUP-STRUCTURAL-PARITY-CHANNEL: a labelled non-verdict is never
// --- a failure. The filing's MECHANISM is refuted below; the INVARIANT behind
// --- it is given an enforceable home, which is what actually needed doing.

/** Run `fn` with `console.error` captured. */
function captureConsoleError(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.join(" "));
  try {
    return { value: fn(), lines };
  } finally {
    console.error = original;
  }
}

test("FOLLOWUP-CHANNEL: the FILED mechanism is REFUTED — a gated scalar is on the STRUCTURAL channel already", () => {
  // Batch 948 filed this follow-up believing FIX-2's gated entries reached
  // `failures[]` and drove exit 1. They did not: exit 1 came from three
  // per-backend criterion reds, and every gated entry was on `structural[]`.
  // Re-stated here as an executable refutation over the same fixture shape.
  const gl = evaluateG4Backend(structuralDiscBackend("webgl"));
  const gpu = evaluateG4Backend(goodBackend("webgpu"));
  const folded = foldG4Verdict({ webgl: gl, webgpu: gpu });
  assert.deepEqual(
    folded.failures.filter((f) =>
      String(f).includes(STRUCTURAL_NON_VERDICT_MARKER),
    ),
    [],
    "no labelled non-verdict may be a failure",
  );
  const gated = folded.structural.filter((s) =>
    s.startsWith("cross-backend:discDiameterDeg_parity"),
  );
  assert.equal(gated.length, 1);
  assert.ok(gated[0].endsWith(STRUCTURAL_NON_VERDICT_MARKER));
  assert.deepEqual(folded.nonVerdictMisroutes, []);
});

test("FOLLOWUP-CHANNEL: EVERY fold-channel non-verdict carries the marker", () => {
  // Four branches route to the structural channel for a reporting reason. An
  // invariant keyed on a marker is only total if every branch stamps it, so
  // each one is triggered and read rather than assumed.
  // (d) arm-state difference caused by the AIM gate alone: both sides are
  // handed the same LANDED content, so the only thing that can separate their
  // arm states is webgl's structural disc lane.
  const landed = {
    bakeClampPresent: false,
    discPeakLinear: 4.2,
    ratioI095overI0: 0.4,
  };
  const gl = evaluateG4Backend({
    ...structuralDiscBackend("webgl"),
    limbAbsolute: landed,
  });
  const gpu = evaluateG4Backend({
    ...goodBackend("webgpu"),
    limbAbsolute: landed,
  });
  // (a) blocked source lane — already covered above; (b) no declared source
  // lane; (c) not finite on both sides although the lane is clean.
  gl.parityScalars = { ...gl.parityScalars, undeclaredScalar: 1 };
  gpu.parityScalars = {
    ...gpu.parityScalars,
    undeclaredScalar: 2,
    fullQuarterRatio: NaN,
  };
  const folded = foldG4Verdict({ webgl: gl, webgpu: gpu });
  const channel = folded.structural.filter((s) =>
    s.startsWith("cross-backend:"),
  );
  assert.ok(channel.length >= 4, `only ${channel.length} channel entries`);
  for (const note of channel) {
    assert.ok(
      note.includes(STRUCTURAL_NON_VERDICT_MARKER),
      `unmarked non-verdict: ${note}`,
    );
  }
  assert.ok(channel.some((s) => /no declared source/.test(s)));
  assert.ok(channel.some((s) => /not finite on both backends/.test(s)));
  assert.ok(channel.some((s) => s.includes("limbAbsoluteArm_state")));
  assert.deepEqual(folded.nonVerdictMisroutes, []);
});

test("FOLLOWUP-CHANNEL MUTANT — an UNGATED real parity red MUST still fail", () => {
  // The filing's own required mutant, and the reason the invariant is keyed on
  // the LABEL rather than on the `cross-backend:` prefix: a genuine parity
  // disagreement between two lanes that could BOTH see their subject carries no
  // label, so it must still reach `failures[]` and drive exit 1.
  const gl = evaluateG4Backend(goodBackend("webgl"));
  const drifted = goodBackend("webgpu");
  drifted.disc = { ...drifted.disc, discDiameterDeg: 0.9 };
  const folded = foldG4Verdict({
    webgl: gl,
    webgpu: evaluateG4Backend(drifted),
  });
  const red = folded.failures.find((f) =>
    f.startsWith("cross-backend:discDiameterDeg_parity"),
  );
  assert.ok(red, "an ungated parity red must still be a FAILURE");
  assert.ok(!red.includes(STRUCTURAL_NON_VERDICT_MARKER));
  assert.equal(folded.exitCode, EXIT_CODE.FAIL);
  assert.deepEqual(folded.nonVerdictMisroutes, []);
});

test("FOLLOWUP-CHANNEL MUTANT — a labelled entry that DOES reach failures[] is re-routed and NAMED", () => {
  // The enforceable home. The mutant is a future branch that files a labelled
  // non-verdict as a failure; the guard must move it, drop the verdict from
  // FAIL to STRUCTURAL, and say so on a channel that is never pragma-stripped.
  const gl = evaluateG4Backend(goodBackend("webgl"));
  const gpu = evaluateG4Backend(goodBackend("webgpu"));
  const label =
    "cross-backend:invented_parity — STRUCTURAL: some future branch. " +
    STRUCTURAL_NON_VERDICT_MARKER;
  const injected = { ...gl, criteria: { ...gl.criteria, [label]: false } };
  const { value: folded, lines } = captureConsoleError(() =>
    foldG4Verdict({ webgl: injected, webgpu: gpu }),
  );
  assert.deepEqual(
    folded.failures.filter((f) =>
      String(f).includes(STRUCTURAL_NON_VERDICT_MARKER),
    ),
    [],
  );
  assert.equal(folded.nonVerdictMisroutes.length, 1);
  assert.ok(folded.structural.some((s) => s.includes(label)));
  assert.equal(folded.exitCode, EXIT_CODE.STRUCTURAL);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /re-routed to the structural channel/);

  // NEGATIVE CONTROL — an ordinary failure is left exactly where it was, and
  // the sentinel stays silent.
  const ordinary = {
    ...gl,
    criteria: { ...gl.criteria, some_real_predicate: false },
  };
  const clean = captureConsoleError(() =>
    foldG4Verdict({ webgl: ordinary, webgpu: gpu }),
  );
  assert.ok(clean.value.failures.includes("webgl:some_real_predicate"));
  assert.equal(clean.value.exitCode, EXIT_CODE.FAIL);
  assert.deepEqual(clean.value.nonVerdictMisroutes, []);
  assert.deepEqual(clean.lines, []);
});

test("FOLLOWUP-CHANNEL: the summary carries the invariant's own result", () => {
  const gl = evaluateG4Backend(goodBackend("webgl"));
  const gpu = evaluateG4Backend(goodBackend("webgpu"));
  const folded = foldG4Verdict({ webgl: gl, webgpu: gpu });
  const summary = buildG4Summary({
    ...folded,
    backends: { webgl: gl, webgpu: gpu },
  });
  // Printed unconditionally, so a reader sees the invariant was CHECKED rather
  // than inferring it from an absence.
  assert.deepEqual(summary.nonVerdictMisroutes, []);
  assert.equal(
    summary.bounds.STRUCTURAL_NON_VERDICT_MARKER,
    STRUCTURAL_NON_VERDICT_MARKER,
  );
});

// --- FIX-3: the capture's own quantization step, measured AT THE PIXEL -------
//
// The two helpers below are unchanged by
// `G4-FOLLOWUP-EARTHSHINE-EXPOSURE`. What changed is the JOB the quantum does:
// it no longer floors the inertness BOUND (see the FOLLOWUP block after them),
// it states whether the constant-term mutant is resolvable at all. Both are
// still load-bearing, and both are still the only place the mirror of the
// C12-02 selection rule is checked against the rule itself.

test("FIX-3: the capture quantum is the SHIPPED display chain's own code step", () => {
  // Both figures are Batch 941's peak-delta pixels, read off its own PNGs.
  assert.ok(
    Math.abs(captureCodeQuantumLinear([230, 231, 227], 1) - 0.009804) < 1e-5,
  );
  assert.ok(
    Math.abs(captureCodeQuantumLinear([236, 237, 232], 1) - 0.019237) < 1e-5,
  );
  // The whole reason a single constant would be wrong: the same code step is
  // worth two orders of magnitude more near the top of the range.
  assert.ok(
    captureCodeQuantumLinear([249, 249, 249], 1) >
      20 * captureCodeQuantumLinear([128, 128, 128], 1),
  );
  assert.ok(Number.isNaN(captureCodeQuantumLinear([1, 2], 1)));
  assert.ok(Number.isNaN(captureCodeQuantumLinear([1, 2, 3], 0)));
});

test("FIX-3: chooseBracketLeg picks what stitchBracketLinear picks", () => {
  // A rule written twice is a rule that drifts. This is the validator.
  const w = 4;
  const h = 1;
  const mk = (fill, exposureFactor) => ({
    data: new Uint8ClampedArray(w * h * 4).fill(fill),
    width: w,
    height: h,
    exposureFactor,
  });
  const lo = mk(60, 1);
  const hi = mk(60, 8);
  // Saturate the 8x leg on pixel 2 only.
  hi.data[8] = 253;
  hi.data[9] = 253;
  hi.data[10] = 253;
  const stitched = stitchBracketLinear([lo, hi]);
  for (let i = 0; i < w * 4; i += 4) {
    const leg = chooseBracketLeg([lo, hi], i);
    const expected = displayToLinear(
      leg.capture.data[i],
      leg.capture.data[i + 1],
      leg.capture.data[i + 2],
      leg.exposureFactor,
    );
    assert.ok(
      Math.abs(stitched.data[i + 1] - expected[1]) < 1e-12,
      `pixel ${i / 4}: chooseBracketLeg disagrees with the stitch`,
    );
  }
  assert.equal(chooseBracketLeg([lo, hi], 8).exposureFactor, 1);
  assert.equal(chooseBracketLeg([lo, hi], 0).exposureFactor, 8);
  assert.equal(chooseBracketLeg([], 0), null);

  // `bracketQuantumAt` is what the probe calls: the composition of the two, at
  // the pixel `discDeltaCensus` reported. It must read the quantum of the leg
  // the stitch chose, NOT of the highest exposure.
  assert.equal(
    bracketQuantumAt([lo, hi], 8),
    captureCodeQuantumLinear([60, 60, 60], 1),
  );
  assert.equal(
    bracketQuantumAt([lo, hi], 0),
    captureCodeQuantumLinear([60, 60, 60], 8),
  );
  // A census that found no peak (`peakIndex` NaN) must not invent a floor.
  assert.ok(Number.isNaN(bracketQuantumAt([lo, hi], NaN)));
});

// --- G4-FOLLOWUP-EARTHSHINE-EXPOSURE: the census reads a RANK, not the peak --
//
// Batch 948's own numbers are the input to every derivation below, so the
// arithmetic that justified the change is executable rather than recited.
const RUN948 = Object.freeze({
  discPixels: 246832,
  scaleCrescent: 0.880139447663971,
  scaleQuarter: 0.5002862786656523,
  scaleFull: 3.273084444154195e-4,
  webgl: Object.freeze({
    crescentMedianDelta: 0.03477632023848592,
    peakDelta: 0.01704819024525972,
    peakQuantumLinear: 0.01924738563549866,
    changedPixels: 431,
    darkenedPixels: 13,
  }),
  webgpu: Object.freeze({
    crescentMedianDelta: 0.03473231374271182,
    peakDelta: 0.0213296636398278,
    peakQuantumLinear: 0.02508651275798124,
    changedPixels: 311,
    darkenedPixels: 7,
  }),
});

/** The Batch-948 lane input for one backend, with the rank reading supplied. */
function run948Earthshine(renderer, quantileDelta) {
  const shipped = goodEarthshine();
  const r = RUN948[renderer];
  return {
    ...shipped,
    scaleCrescent: RUN948.scaleCrescent,
    scaleQuarter: RUN948.scaleQuarter,
    scaleFull: RUN948.scaleFull,
    crescent: { ...shipped.crescent, medianDelta: r.crescentMedianDelta },
    full: {
      ...shipped.full,
      discPixels: RUN948.discPixels,
      changedPixels: r.changedPixels,
      darkenedPixels: r.darkenedPixels,
      peakDelta: r.peakDelta,
      peakQuantumLinear: r.peakQuantumLinear,
      quantileLevel: EARTHSHINE_INERTNESS_QUANTILE,
      quantileDelta,
    },
  };
}

test("FOLLOWUP-EXPOSURE: the PEAK statistic reads one code step BY CONSTRUCTION", () => {
  // The premise of the whole re-derivation, stated as arithmetic over the run's
  // own numbers rather than as a claim. `peakDelta / quantum` is within one
  // code step of unity on BOTH backends — a max over ~247,000 differences of
  // two independently quantized captures lands on a single flipped code.
  for (const renderer of ["webgl", "webgpu"]) {
    const r = RUN948[renderer];
    const codes = r.peakDelta / r.peakQuantumLinear;
    assert.ok(
      codes > 0.8 && codes < 1.0,
      `${renderer}: peakDelta is ${codes} code steps, not a signal`,
    );
    // ...and pixels got DARKER when an ADDITIVE term was switched ON, which
    // settles it as readback noise rather than a faint real response.
    assert.ok(r.darkenedPixels > 0);
  }
});

test("FOLLOWUP-EXPOSURE: FIX-3's per-pixel floor could not survive Batch 948", () => {
  // Why the floor had to go rather than be widened: at the webgpu quantum, the
  // OLD `1.5 * quantum` floor is ABOVE the constant-term mutant it must reject,
  // so FIX-3's own cap fired and the lane went STRUCTURAL. It was right to.
  const oldFloor = 1.5 * RUN948.webgpu.peakQuantumLinear;
  assert.ok(
    oldFloor > RUN948.webgpu.crescentMedianDelta,
    `the old floor ${oldFloor} must be shown ABOVE the mutant ` +
      `${RUN948.webgpu.crescentMedianDelta} — that is the defect being fixed`,
  );
  // And no factor rescues it: even ONE whole quantum leaves a 1.38x margin, so
  // any floor with slack in it reaches the mutant on this backend.
  assert.ok(
    RUN948.webgpu.crescentMedianDelta / RUN948.webgpu.peakQuantumLinear < 1.5,
  );
});

test("FOLLOWUP-EXPOSURE: a DEEPER BRACKET cannot reach the census pixel", () => {
  // The other option the filing offered, refuted with the shipped selection
  // rule rather than by assertion. The full-moon peak reads ~239 at 1x, which
  // is UNSATURATED, so `chooseBracketLeg` takes 1x — and keeps taking it
  // whatever else is in the bracket. A 0.5x leg would be 3.1x finer and is
  // never reached.
  const w = 1;
  const h = 1;
  const mk = (codes, exposureFactor) => ({
    data: new Uint8ClampedArray([...codes, 255]),
    width: w,
    height: h,
    exposureFactor,
  });
  const at1x = [238, 239, 235];
  const at8x = [254, 254, 252];
  const atHalf = [178, 179, 175];
  const legs = [mk(at1x, 1), mk(at8x, 8), mk(atHalf, 0.5)];
  assert.equal(chooseBracketLeg(legs, 0).exposureFactor, 1);
  // ...and the stitch agrees, which is what makes this a property of the
  // shipped rule and not of the mirror.
  const stitched = stitchBracketLinear(legs);
  const expected = displayToLinear(at1x[0], at1x[1], at1x[2], 1);
  assert.ok(Math.abs(stitched.data[1] - expected[1]) < 1e-12);
  // The quantum the unreachable leg would have offered, on the record.
  const coarse = captureCodeQuantumLinear(at1x, 1);
  const fine = captureCodeQuantumLinear(atHalf, 0.5);
  assert.ok(
    coarse / fine > 3,
    `the 0.5x leg is ${coarse / fine}x finer and unreachable`,
  );
  assert.ok(Math.abs(coarse - RUN948.webgpu.peakQuantumLinear) < 1e-9);
});

test("FOLLOWUP-EXPOSURE: the 0.95 rank is the geometric midpoint of what it separates", () => {
  // NULL — the worse backend's measured readback-flip fraction.
  const noise = RUN948.webgl.changedPixels / RUN948.discPixels;
  // MUTANT — the constant term moves at least one code at the COARSEST pixel
  // the census can see, so its brightened fraction is 1.0.
  const mutantCodes =
    RUN948.webgpu.crescentMedianDelta / RUN948.webgpu.peakQuantumLinear;
  assert.ok(mutantCodes >= EARTHSHINE_INERTNESS_MIN_MUTANT_CODES);
  const midpoint = Math.sqrt(noise * 1.0);
  assert.ok(
    Math.abs(midpoint - 0.0418) < 5e-4,
    `midpoint ${midpoint} must reproduce the recorded 4.18e-2`,
  );
  assert.equal(EARTHSHINE_INERTNESS_QUANTILE, 0.95);
  const tail = 1 - EARTHSHINE_INERTNESS_QUANTILE;
  assert.ok(tail / noise > 20, `only ${tail / noise}x above the noise floor`);
  assert.ok(1.0 / tail > 15, `only ${1.0 / tail}x below the mutant`);
});

test("FOLLOWUP-EXPOSURE: the rank reads ZERO on Batch 948's own census population", () => {
  // Constructed from the recorded counts, not from a re-run: 431 brightened and
  // 13 darkened pixels in a 246,832-pixel disc puts the 95th percentile deep
  // inside the zeros. The census is exercised, not stubbed.
  for (const renderer of ["webgl", "webgpu"]) {
    const r = RUN948[renderer];
    const on = {
      data: new Float64Array(RUN948.discPixels * 4),
      width: 1,
      height: 1,
    };
    const off = {
      data: new Float64Array(RUN948.discPixels * 4),
      width: 1,
      height: 1,
    };
    for (let k = 0; k < r.changedPixels; k++) {
      on.data[4 * k + 1] = r.peakQuantumLinear / 0.7152;
    }
    for (let k = 0; k < r.darkenedPixels; k++) {
      const i = 4 * (RUN948.discPixels - 1 - k);
      off.data[i + 1] = r.peakQuantumLinear / 0.7152;
    }
    // One row, so the "disc" is the whole strip.
    on.width = RUN948.discPixels;
    off.width = RUN948.discPixels;
    const census = discDeltaCensus(on, off, {
      cx: RUN948.discPixels / 2,
      cy: 0.5,
      radius: RUN948.discPixels,
      eps: TERMINATOR_DELTA_EPS,
      quantile: EARTHSHINE_INERTNESS_QUANTILE,
    });
    assert.equal(census.discPixels, RUN948.discPixels);
    assert.equal(census.changedPixels, r.changedPixels);
    assert.equal(census.darkenedPixels, r.darkenedPixels);
    assert.equal(census.quantileDelta, 0);
    // The PEAK on the same population is one whole code step — the statistic
    // that could not certify, measured side by side with the one that can.
    assert.ok(Math.abs(census.peakDelta - r.peakQuantumLinear) < 1e-12);
    // A census that was NOT asked for a rank reports NaN, never 0: "not
    // measured" must not be readable as "measured zero", which is exactly the
    // reading that would certify.
    const unasked = discDeltaCensus(on, off, {
      cx: RUN948.discPixels / 2,
      cy: 0.5,
      radius: RUN948.discPixels,
      eps: TERMINATOR_DELTA_EPS,
    });
    assert.equal(unasked.quantileLevel, null);
    assert.ok(Number.isNaN(unasked.quantileDelta));
  }
});

test("FOLLOWUP-EXPOSURE: Batch 948's STRUCTURAL webgpu lane now CERTIFIES", () => {
  // The regression this follow-up exists to remove, pinned on both backends.
  for (const renderer of ["webgl", "webgpu"]) {
    const verdict = evaluateEarthshineSubLane(run948Earthshine(renderer, 0));
    assert.deepEqual(
      verdict.structural,
      [],
      `${renderer} must no longer be structural`,
    );
    assert.equal(verdict.criteria.earthshine_inert_at_full_moon, true);
    assert.equal(verdict.inertnessCensusQuantile, 0.95);
    assert.equal(verdict.inertnessCensusDelta, 0);
    assert.match(verdict.inertnessBoundSource, /phase-scaled crescent delta/);
    // The bound is the PHYSICAL one again — 1.387e-4, not a quantum multiple.
    assert.ok(
      Math.abs(verdict.inertnessBound - 1.3875e-4) < 1e-7,
      `bound ${verdict.inertnessBound}`,
    );
    // ...and both caps are provable WITH MARGIN, printed with the verdict.
    assert.ok(
      verdict.inertnessMutantMargin > 200,
      `bound-vs-mutant margin ${verdict.inertnessMutantMargin}`,
    );
    assert.ok(
      verdict.inertnessResolvabilityMargin > 1.3,
      `resolvability margin ${verdict.inertnessResolvabilityMargin}`,
    );
    assert.ok(verdict.inertnessBrightenedFraction < 0.002);
    // The old statistic is still reported, as the diagnostic it now is.
    assert.equal(verdict.fullPeakDelta, RUN948[renderer].peakDelta);
  }
});

test("FOLLOWUP-EXPOSURE MUTANT REJECTED — the pre-C12-21 CONSTANT term, at Batch 948's own framing", () => {
  // The requirement the re-derivation is capped by, now on the rank statistic:
  // the constant term brightens the WHOLE disc, so the 95th percentile reads
  // its full amplitude and the criterion must go red on both backends.
  for (const renderer of ["webgl", "webgpu"]) {
    const level = RUN948[renderer].crescentMedianDelta;
    const verdict = evaluateEarthshineSubLane(
      run948Earthshine(renderer, level),
    );
    assert.deepEqual(verdict.structural, []);
    assert.equal(
      verdict.criteria.earthshine_inert_at_full_moon,
      false,
      `${renderer}: the constant term must be rejected`,
    );
    assert.ok(
      level / verdict.inertnessBound > 200,
      `rejection margin ${level / verdict.inertnessBound}`,
    );
  }
  // And the same mutant on REAL synthetic pixels, where the census runs for
  // itself rather than being handed a number.
  const constantTerm = synthEarthshine(0.12, 1.0);
  const verdict = evaluateEarthshineSubLane({
    enableEarthshine: true,
    aimDistancePx: 0,
    scaleCrescent: 0.88,
    scaleQuarter: 0.5,
    scaleFull: 0.02,
    crescent: constantTerm,
    quarter: synthEarthshine(0.5, 1.0),
    full: synthFullInertness(1.0),
  });
  assert.equal(verdict.criteria.earthshine_inert_at_full_moon, false);
  assert.ok(verdict.inertnessCensusDelta > 10 * verdict.inertnessBound);
});

test("FOLLOWUP-EXPOSURE: an UNRESOLVABLE mutant is STRUCTURAL, never a weaker certification", () => {
  // FIX-3's cap, restated for the rank statistic and still enforced rather than
  // assumed: if one code step reaches the mutant's own amplitude, a 100%
  // constant term could move zero codes and the census would certify blind.
  const blind = evaluateEarthshineSubLane({
    ...run948Earthshine("webgpu", 0),
    // One code worth more than the 0.03473 mutant.
    full: {
      ...run948Earthshine("webgpu", 0).full,
      peakQuantumLinear: 0.05,
    },
  });
  assert.deepEqual(blind.criteria, {});
  assert.equal(blind.pass, false);
  assert.ok(
    blind.structural.some((s) => /cannot resolve its own target/.test(s)),
    `structural: ${blind.structural}`,
  );
  // The cap sits exactly at one code step, and 1.0 is a RESOLVABILITY
  // precondition rather than slack — so the shipped margins must clear it.
  assert.equal(EARTHSHINE_INERTNESS_MIN_MUTANT_CODES, 1.0);
  for (const renderer of ["webgl", "webgpu"]) {
    const r = RUN948[renderer];
    assert.ok(
      r.crescentMedianDelta / r.peakQuantumLinear >
        EARTHSHINE_INERTNESS_MIN_MUTANT_CODES,
    );
  }
  // A MISSING quantum is structural too — the census cannot state its own
  // resolution, so it does not certify.
  const noQuantum = evaluateEarthshineSubLane({
    ...run948Earthshine("webgpu", 0),
    full: {
      ...run948Earthshine("webgpu", 0).full,
      peakQuantumLinear: undefined,
    },
  });
  assert.deepEqual(noQuantum.criteria, {});
  assert.ok(
    noQuantum.structural.some((s) => /cannot state its own resolution/.test(s)),
  );
  // ...and so is a BOUND that has reached the mutant, which is the literal
  // FIX-3 cap: it fires when the phase scaling stops being small.
  const wideBound = evaluateEarthshineSubLane({
    ...run948Earthshine("webgpu", 0),
    scaleFull: RUN948.scaleCrescent,
  });
  assert.deepEqual(wideBound.criteria, {});
  assert.ok(
    wideBound.structural.some((s) => /cannot see its own target/.test(s)),
  );
});

test("FOLLOWUP-EXPOSURE MUTANT REJECTED — a census taken at the WRONG rank cannot certify", () => {
  // A probe that stopped passing the level, or passed a different one, would
  // otherwise hand the evaluator a number graded against a bound derived
  // somewhere else. This is the drift guard between the two files.
  for (const level of [undefined, null, 0.5, 0.99]) {
    const verdict = evaluateEarthshineSubLane({
      ...run948Earthshine("webgpu", 0),
      full: {
        ...run948Earthshine("webgpu", 0).full,
        quantileLevel: level,
      },
    });
    assert.deepEqual(verdict.criteria, {}, `level ${level} must not certify`);
    assert.ok(verdict.structural.some((s) => /drifted apart/.test(s)));
  }
  // The probe must therefore request exactly the level the evaluator derives.
  const probeSource = readNormalized("./probe-celestial-gates.mjs");
  assert.match(probeSource, /quantile: EARTHSHINE_INERTNESS_QUANTILE,/);
});

test("FOLLOWUP-EXPOSURE: the phase-scaled bound is UNMEASURABLE alone — which is why the rank is needed", () => {
  // Retained from FIX-3, because it is still the reason the criterion cannot
  // simply be a magnitude test on a per-pixel statistic: 1.387e-4 is 71x below
  // one code step, and its PHYSICAL term alone is 253x below.
  const shipped = goodEarthshine();
  const phaseOnlyBound =
    EARTHSHINE_INERTNESS_FACTOR *
      shipped.crescent.medianDelta *
      (RUN948.scaleFull / RUN948.scaleCrescent) +
    TERMINATOR_DELTA_EPS;
  assert.ok(
    phaseOnlyBound < RUN941_WEBGL_PEAK_QUANTUM / 50,
    `the phase-only bound (${phaseOnlyBound}) must be far below one code step`,
  );
  assert.ok(
    phaseOnlyBound - TERMINATOR_DELTA_EPS < RUN941_WEBGL_PEAK_QUANTUM / 200,
  );
  // The rank is what makes it measurable: zero is comfortably under a bound no
  // per-pixel reading could ever be under.
  assert.ok(0 <= phaseOnlyBound);
});

// --- FIX-4: the limb arm is gated on the lane its number comes from ---------

test("FIX-4 MUTANT REJECTED — a certifying limb read on a STRUCTURAL disc lane", () => {
  // Batch 941's actual readings, taken about a centroid 112 px from where the
  // Sun was, plus a disc-only reading that would otherwise certify — so the
  // ONLY thing keeping this out of the criteria set is the aim gate.
  const landed = landedArmInputs({
    discPeakLinear: 4.175617896405583,
    ratioI095overI0: 0.6790315872185032,
  });
  // The mutant is the shipped Batch-941 arm: content landed, so certify —
  // regardless of whether the disc lane could see the disc.
  const ungated = evaluateLimbAbsoluteArm(landed);
  assert.equal(ungated.state, ARM_STATE.ACTIVE);
  assert.equal(
    ungated.criteria.limb_discOnlyRatio_I095_over_I0_in_band,
    true,
    "the ungated arm certified off a mis-aimed capture",
  );

  // The SHIPPED arm, gated.
  const gated = evaluateLimbAbsoluteArm({
    ...landed,
    discLaneStructural: true,
  });
  assert.equal(gated.state, ARM_STATE.PENDING_AIM);
  assert.deepEqual(gated.criteria, {});
  assert.equal(gated.measured.ratioI095overI0, 0.6790315872185032);
  assert.match(gated.reason, /DISC sub-lane is structural/);

  // And the whole-backend path routes the same way: a structural disc lane must
  // not emit the limb criterion at all.
  const backend = evaluateG4Backend({
    ...structuralDiscBackend("webgl"),
    limbAbsolute: landed,
  });
  assert.equal(
    backend.criteria.limb_discOnlyRatio_I095_over_I0_in_band,
    undefined,
  );
  assert.equal(
    backend.pendingArms.limb_discOnlyRatio_I095_over_I0_in_band.state,
    ARM_STATE.PENDING_AIM,
  );
});

test("FIX-4: an aim-gated arm disagreement is STRUCTURAL, not a cross-backend failure", () => {
  const landed = {
    bakeClampPresent: false,
    discPeakLinear: 4.2,
    ratioI095overI0: 0.4,
  };
  const gl = evaluateG4Backend({
    ...structuralDiscBackend("webgl"),
    limbAbsolute: landed,
  });
  const gpu = evaluateG4Backend({
    ...goodBackend("webgpu"),
    limbAbsolute: landed,
  });
  const folded = foldG4Verdict({ webgl: gl, webgpu: gpu });
  assert.ok(
    !folded.failures.some((f) => f.includes("limbAbsoluteArm_state")),
    "an aim gate on one side is not a content disagreement",
  );
  assert.ok(
    folded.structural.some((s) => s.includes("limbAbsoluteArm_state")),
    "...but it must still be named",
  );
  // A REAL content disagreement is still a FAIL.
  const clamped = evaluateG4Backend({
    ...goodBackend("webgl"),
    limbAbsolute: {
      bakeClampPresent: true,
      discPeakLinear: 1.2,
      ratioI095overI0: 0.9,
    },
  });
  assert.ok(
    foldG4Verdict({ webgl: clamped, webgpu: gpu }).failures.some((f) =>
      f.includes("limbAbsoluteArm_state"),
    ),
  );
});

test("FIX-4: the halo-over-disc confound is on the record AS A NUMBER", () => {
  // §5's band is NOT moved. What this pins is the arithmetic the maintainer
  // decision needs: what the SHIPPED chain predicts for the quantity §5 bounds.
  const shipped = expectedCompositeLimbRatio(SolarDiscModel, {
    discRadiance: 2.0,
    haloAmplitude: 1.5,
    haloCoreRadii: SolarDiscModel.solarHaloCoreRadii(GLOW_LENGTH_TS),
  });
  // (1) The DISC-ONLY law at 0.95R is already ABOVE §5's ceiling. §5's band is
  //     satisfied at the EXTREME limb, where I(1)/I(0) = a0 = 0.30.
  assert.ok(
    Math.abs(shipped.discOnlyRatio - 0.5679674069255255) < 1e-9,
    `disc-only ratio ${shipped.discOnlyRatio}`,
  );
  assert.ok(shipped.discOnlyRatio > LIMB_ABSOLUTE_RATIO_BAND.hi);
  assert.ok(
    Math.abs(
      SolarDiscModel.solarLimbIntensity(1.0) /
        SolarDiscModel.solarLimbIntensity(0.0) -
        LIMB_ABSOLUTE_RATIO_BAND.lo,
    ) < 1e-12,
  );
  // (2) The halo lifts it further, and the prediction matches what Batch 941
  //     MEASURED on WebGPU (0.7138) to 2.6%.
  assert.ok(
    Math.abs(shipped.compositeRatio - 0.7329830770625845) < 1e-9,
    `composite ratio ${shipped.compositeRatio}`,
  );
  assert.ok(
    relativeDeviation(0.7137926594658577, shipped.compositeRatio) < 0.05,
    "the shipped laws must predict the measured composite",
  );
  // (3) And the halo is more than half of the signal at 0.95R — which is what
  //     "the ratio cannot be separated from the veil" means numerically.
  assert.ok(shipped.haloShareAtX > 0.5);
  assert.ok(
    Math.abs(shipped.haloShareAtCentre - 1.5 / 3.5) < 1e-12,
    "at the centre the halo profile is exactly 1, so its share is H/(D+H)",
  );
  // With the halo REMOVED the composite collapses onto the disc-only law — the
  // control that says the confound term is what is doing the lifting.
  const noHalo = expectedCompositeLimbRatio(SolarDiscModel, {
    discRadiance: 2.0,
    haloAmplitude: 0,
    haloCoreRadii: SolarDiscModel.solarHaloCoreRadii(GLOW_LENGTH_TS),
  });
  assert.ok(Math.abs(noHalo.compositeRatio - noHalo.discOnlyRatio) < 1e-12);
});

// --- FIX-5: the report may not retain pixels --------------------------------

test("FIX-5: a G4 report contains NO image buffers", () => {
  const evaluated = {
    webgl: evaluateG4Backend(goodBackend("webgl")),
    webgpu: evaluateG4Backend(goodBackend("webgpu")),
  };
  assert.deepEqual(findRetainedImageBuffers(evaluated), []);
  assert.deepEqual(
    findRetainedImageBuffers(
      buildG4Summary({ ...foldG4Verdict(evaluated), backends: evaluated }),
    ),
    [],
  );
});

test("FIX-5 MUTANT REJECTED — a retained capture is FOUND and NAMED", () => {
  const evaluated = {
    webgl: evaluateG4Backend(goodBackend("webgl")),
    webgpu: evaluateG4Backend(goodBackend("webgpu")),
  };
  // Exactly the shape that OOM'd the first run: the lane's own pixels reachable
  // from the report.
  evaluated.webgl.reports.disc.captures = {
    "flat-1x": { data: new Array(2_560_000).fill(0) },
  };
  const hits = findRetainedImageBuffers(evaluated);
  assert.equal(hits.length, 1);
  assert.match(hits[0], /webgl\.reports\.disc\.captures/);
  assert.match(hits[0], /Array\[2560000\]/);
  // A TypedArray is caught at ANY length — a Float64Array in a report is always
  // an image, never a bound.
  assert.ok(
    findRetainedImageBuffers({ a: { b: new Float64Array(8) } }).length === 1,
  );
  // ...and the five-sample shape vectors a real report DOES carry are not.
  assert.deepEqual(findRetainedImageBuffers({ shape: [1, 2, 3, 4, 5] }), []);
});

test("FIX-5: the probe reduces and RELEASES each lane as it completes", () => {
  const src = readNormalized("./probe-celestial-gates.mjs");
  // The lane driver is shared by the whole celestial fleet, so the hook and the
  // release live in the harness; only the G4-specific USE of them is the
  // probe's.
  const harness = readNormalized("./lib/celestial-capture-harness.mjs");
  assert.match(
    harness,
    /async function runBackendLanes\(browser, renderer, laneDefs, onLane\)/,
  );
  assert.match(harness, /lane\.captures = null;/);
  assert.match(src, /writeLaneCaptures\(laneKey, lane, renderer\);/);
  assert.match(src, /reduceLane\(laneKey, lane, sinks\[renderer\]\);/);
  // The permanent sentinel is wired.
  assert.match(src, /findRetainedImageBuffers\(backends\)/);
  assert.match(src, /REPORT RETAINS IMAGE BUFFERS/);
  // The three epochs are reduced ONE LANE AT A TIME — the shape that made all
  // 56 captures co-resident is gone.
  assert.doesNotMatch(src, /function moonEpochMetrics\(/);
  assert.match(src, /function moonEpochLaneMetrics\(lane, key\)/);
  assert.match(src, /function assembleMoonPhase\(epochs, surge\)/);
});

// --- FIX-1 (probe side): the camera basis repair is present and explained ---

test("FIX-1: the probe writes the REQUESTED basis back after setView", () => {
  const src = readNormalized("./probe-celestial-gates.mjs");
  // `setupScene` is the shared harness's; `setupMoonScene` is G4's own. The
  // repair must be present in BOTH, which is why each half is asserted against
  // the file that now owns it — a single-file assertion would go quietly green
  // if either copy lost it.
  const harness = readNormalized("./lib/celestial-capture-harness.mjs");
  // One aim helper in `setupScene`, used by all three aim modes — no branch may
  // call `setView` with an orientation on its own any more.
  assert.match(harness, /const aimCamera = \(position, direction, up\) => \{/);
  assert.match(harness, /aimCamera\(eye, dir, realUp\);/);
  assert.match(harness, /aimCamera\(position, direction, perp\);/);
  assert.match(harness, /aimCamera\(position, perp, up\);/);
  // The repair itself — once in `setupScene`, once in `setupMoonScene`.
  const REPAIR =
    /C\.Cartesian3\.clone\(direction, scene\.camera\.direction\);/g;
  assert.equal(harness.match(REPAIR).length, 1, "setupScene");
  assert.equal(src.match(REPAIR).length, 1, "setupMoonScene");
  // The residual is measured BEFORE the repair, so the defect's own magnitude
  // is reported every run rather than being silently corrected away.
  for (const text of [harness, src]) {
    assert.match(text, /hprRoundTripResidualDeg/);
    assert.match(text, /appliedResidualDeg/);
    assert.match(text, /localVerticalSeparationDeg/);
  }
  // The ephemeris projection reaches both sun lanes' measurements.
  assert.match(harness, /sunProjectionCropPx/);
  assert.match(src, /sunProjectionCropPx/);
  assert.match(
    src,
    /sunProjectionCropPx: lane\.setup\.sunProjectionCropPx \?\? null/,
  );
});
