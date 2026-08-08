// celestial-g4-gate.spec.mjs — browser-free guard for the Campaign-12 G4 lane
// (`probe-celestial-gates.mjs --g4`).
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
  ARM_STATE,
  C12_19_HDR_PEAK_DISCRIMINATOR,
  DISC_EPHEMERIS_TOLERANCE,
  EARTHSHINE_INERTNESS_FACTOR,
  EARTHSHINE_MIN_CHANGED_PIXELS,
  EARTHSHINE_MIN_MASK_PIXELS,
  EARTHSHINE_MIN_MEDIAN_DELTA,
  EARTHSHINE_PHASE_SCALING_MAX_REL_DEV,
  EARTHSHINE_TINT_BR_NOMINAL,
  EARTHSHINE_TINT_GR_NOMINAL,
  EARTHSHINE_TINT_MAX_REL_DEV,
  EXIT_CODE,
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
  LIMB_CENTRE_MAX_RELATIVE,
  LIMB_MIN_DROP_LINEAR,
  LIMB_SHAPE_MAX_REL_DEV,
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
  PENDING_CONTENT,
  SOLAR_ANGULAR_DIAMETER_NOMINAL_DEG,
  SOLAR_ANGULAR_DIAMETER_TOLERANCE,
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
  buildG4Summary,
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
  foldG4Verdict,
  haloShapeExpectation,
  limbShapeExpectation,
  logLogSlope,
  measureDiscDifferential,
  measureHaloProfile,
  median,
  radialProfile,
  relativeDeviation,
  screenMinusBakedPeak,
  shapeDeviation,
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
function renderSun({ size, radiusPx, limbOn, haloFn }) {
  const data = new Float64Array(size * size * 4);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const rho = Math.hypot(x + 0.5 - c, y + 0.5 - c) / radiusPx;
      const disc =
        rho <= 1 ? (limbOn ? SolarDiscModel.solarLimbIntensity(rho) : 1) : 0;
      const v = disc + (haloFn ? haloFn(rho) : 0);
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
function synthFullInertness(scale, phaseFraction = 0.995) {
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
  return discDeltaCensus(on, off, {
    cx: MOON_MASK.cx,
    cy: MOON_MASK.cy,
    radius: MOON_RADIUS_PX * MOON_DISC_MASK_FRACTION,
    eps: TERMINATOR_DELTA_EPS,
  });
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
  const pass = evaluateLimbAbsoluteArm({
    bakeClampPresent: false,
    discPeakLinear: 1.2e5,
    ratioI095overI0: 0.42,
  });
  assert.equal(pass.state, ARM_STATE.ACTIVE);
  assert.equal(pass.pending, null);
  assert.equal(pass.criteria.limb_absoluteRatio_I095_over_I0_in_band, true);
  const fail = evaluateLimbAbsoluteArm({
    bakeClampPresent: false,
    discPeakLinear: 1.2e5,
    ratioI095overI0: 0.9,
  });
  assert.equal(fail.state, ARM_STATE.ACTIVE);
  assert.equal(fail.criteria.limb_absoluteRatio_I095_over_I0_in_band, false);
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
  landed.limbAbsolute = {
    bakeClampPresent: false,
    discPeakLinear: 1e5,
    ratioI095overI0: 0.42,
  };
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
