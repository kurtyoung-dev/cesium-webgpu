// godray-energy-law.spec.mjs — the god-ray energy law: an isolated sun
// emitter, and a chord fraction that does not move with the sample count.
//
// @purpose Executes the god-ray energy law straight out of GodRayGenerate.wgsl, pins count invariance and the energy bound against derived tolerances, records the emitter data dependency, and carries the inertness mutants that make those verdicts able to fail.
// @status ACTIVE
//
// Run: node --test Tools/visual-regression/godray-energy-law.spec.mjs
// Runner home: `npm run test-engine-node`.
//
// ── WHAT THE DEFECT WAS ───────────────────────────────────────────────────
//
// `GodRayGenerate.wgsl` accumulated `sceneColor * weight * decay^i` over N
// samples and multiplied by `exposure`. For a uniform sky field — every
// sampled pixel the same linear RGB C, every sample classified sky, cloud
// transmittance exactly 1 — that is
//
//     ray = C * exposure * weight * sum(decay^i, i = 0 .. N-1)
//
// an ADDITIVE multiple of the SKY's own colour whose size is set by the loop
// trip count. Group A re-derives the four multipliers that follow from it.
// Two things are wrong at once and each gets its own group below:
//
//   1. the emitter is the sampled scene colour, so a bright sky washes the
//      screen out by construction — the shaft is a scaled copy of the sky,
//      not light from the sun;
//   2. the sample count is a BRIGHTNESS control, 1.784x between 16 and 128
//      samples, when it should be a quality control.
//
// ── WHAT MAKES THIS SPEC ABLE TO FAIL ─────────────────────────────────────
//
// It does not transcribe the law. It PARSES the six law functions out of
// `Shaders/WebGPU/PostProcess/GodRayGenerate.wgsl` and EVALUATES them
// (`lib/wgsl-mini-eval.mjs`), so every number below came from the text that
// ships. Group F substitutes mutated source in memory and requires the verdict
// to flip, including an INERTNESS mutant that leaves every symbol in place and
// only makes the normalisation unreachable.
//
// The convergence target in B4 is a CLOSED-FORM integral derived by
// calculus, not a value recorded from a previous run of this code, so the
// quadrature is checked against something the implementation cannot move.
//
// ── WHAT IT DELIBERATELY DOES NOT PROVE ───────────────────────────────────
//
//   * The march LOOP. The evaluator reads no loops, so the spec drives the
//     march itself over the shader's own per-step functions. That the shipped
//     `fragmentMain` runs `sampleCount` iterations, advances `stepUV` by
//     `deltaUV`, and feeds both accumulators from the same attenuation is NOT
//     asserted here. The named Edge leg is what measures that.
//   * Any claim about DISPLAYED brightness. Nothing here draws a pixel. The
//     effect allocates its targets in the caller-supplied format and each
//     stage can clamp or round, so none of these numbers is an assertion about
//     stored pixels. Attribution of washout to this law needs a capture that
//     records formats, HDR state and tone mapping.
//   * Anything about the f16 path. `useShaderF16` reachability is not
//     established. Group D asserts only that the f16 twin carries the SAME law
//     text — not that the path is reached, and not that the predecessor ever
//     overflowed.
//
// PRECISION. The evaluator computes in f64 where the GPU computes in f32. The
// tolerances in Group B are therefore derived for the DEVICE — f32 unit
// roundoff plus the quadrature error of the midpoint scheme — and honoured
// here with room to spare rather than measured to the last bit. Where the
// DIFFERENCE between the two formats is the behaviour under test — the decay
// floor in B9, where a weight that is merely small in f64 is ZERO in f32 —
// `chordFraction` is driven with `Math.fround` at each value boundary so the
// underflow is expressible at all.
//
// GROUP H AND THE PROBE. `lib/godray-near-ceiling.mjs` carries the Edge leg's
// near-sun amplitude ceiling. It is dependency-free arithmetic, so Group H
// EXECUTES it against a closed form derived here by calculus, and F11-F14
// import mutated copies of it from `data:` URLs — the same in-memory mutant
// discipline the WGSL gets, applied to the bar that judges the capture.
//
// CRLF: this repo checks out with `core.autocrlf=true`; every reader below
// normalises line endings before matching.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  compileFunction,
  readConstants,
  stripComments,
} from "./lib/wgsl-mini-eval.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

const GENERATE_WGSL_PATH = path.join(
  ROOT,
  "packages/engine/Source/Shaders/WebGPU/PostProcess/GodRayGenerate.wgsl",
);
const GENERATE_F16_WGSL_PATH = path.join(
  ROOT,
  "packages/engine/Source/Shaders/WebGPU/PostProcess/GodRayGenerate_f16.wgsl",
);
const EFFECT_TS_PATH = path.join(
  ROOT,
  "packages/engine/Source/Renderer/WebGPU/WebGPUGodRayEffect.ts",
);
const PIPELINE_TS_PATH = path.join(
  ROOT,
  "packages/engine/Source/Renderer/WebGPU/WebGPUPostProcessPipeline.ts",
);

/**
 * Read a source file with its line endings normalised to LF.
 *
 * @param {string} file Absolute path.
 * @returns {string} The source.
 */
function read(file) {
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

const LAW_FUNCTIONS = [
  "godRayPathAttenuation",
  "godRayGain",
  "godRaySunGlow",
  "godRayAccumulate",
  "godRayTransmittance",
  "godRayResolve",
];

/**
 * Compile the law out of arbitrary WGSL text.
 *
 * @param {string} text WGSL source.
 * @returns {{constants: object, fns: object}} Constants and callables.
 */
function lawFrom(text) {
  const stripped = stripComments(text);
  const constants = readConstants(stripped);
  const fns = {};
  const globals = { ...constants, __functions: fns };
  for (const name of LAW_FUNCTIONS) {
    fns[name] = compileFunction(stripped, name, globals);
  }
  return { constants, fns };
}

const generateWgsl = read(GENERATE_WGSL_PATH);
const generateF16Wgsl = read(GENERATE_F16_WGSL_PATH);
const effectTs = read(EFFECT_TS_PATH);
const pipelineTs = read(PIPELINE_TS_PATH);

const shipped = lawFrom(generateWgsl);
const LAW = shipped.fns;
const CONSTANTS = shipped.constants;

// The sample counts the behaviour is specified across.
const SAMPLE_COUNTS = [16, 32, 64, 128];

// The shipped artistic defaults, read out of the effect rather than retyped.
// They live in `DEFAULT_APPEARANCE`, which is the same authority the runtime
// reads: the constructor spreads it and `updateConfig` restores a removed
// override to it. Reading the constructor's own `?? literal` spellings would
// pin a spelling rather than the value.
const appearanceDefaults = bodyAfter(
  effectTs,
  "const DEFAULT_APPEARANCE = Object.freeze",
);

/**
 * Read one numeric default out of the effect's appearance snapshot.
 *
 * @param {string} key The config key.
 * @returns {number} The default.
 */
function effectDefault(key) {
  const match = new RegExp(String.raw`\b${key}\s*:\s*(-?[0-9.]+)\s*,`).exec(
    appearanceDefaults,
  );
  assert.ok(match, `no numeric default for ${key} in DEFAULT_APPEARANCE`);
  return Number(match[1]);
}

const DEFAULT_DECAY = effectDefault("decay");
const DEFAULT_WEIGHT = effectDefault("weight");
const DEFAULT_EXPOSURE = effectDefault("exposure");
const DEFAULT_SAMPLE_COUNT = effectDefault("sampleCount");
const DEFAULT_GLOW_RADIUS = effectDefault("sunGlowRadius");

// ── Derived tolerances ────────────────────────────────────────────────────
//
// These are DERIVED, not fitted. Nothing below was chosen by running the
// implementation and reading off what it produced.

/** f32 unit roundoff. */
const F32_UNIT_ROUNDOFF = 2 ** -24;

/**
 * Worst-case relative error of the chord fraction for a CLEAR chord on a
 * device.
 *
 * The fraction is `sum(v_i * a_i) / sum(a_i)`. Sequential summation of N
 * terms carries a relative error bounded by `gamma_N = N*u / (1 - N*u)`
 * (Higham, Accuracy and Stability of Numerical Algorithms, 3.1); the quotient
 * of two such sums adds one more rounding. The midpoint quadrature error is
 * exactly zero here, because a clear chord makes numerator and denominator
 * quadratures of the SAME integrand.
 *
 * @param {number} maximumSamples Largest sample count in the sweep.
 * @returns {number} The bound.
 */
function clearChordTolerance(maximumSamples) {
  const gamma =
    (maximumSamples * F32_UNIT_ROUNDOFF) /
    (1 - maximumSamples * F32_UNIT_ROUNDOFF);
  return 2 * gamma + F32_UNIT_ROUNDOFF;
}

const CLEAR_CHORD_TOLERANCE = clearChordTolerance(128);

/**
 * The chord extinction the shipped law uses, in the exponent of `exp(-k t)`.
 *
 * Read out of the shader's own constant so a change to the reference sample
 * count moves this with it rather than leaving a stale bound behind.
 *
 * @param {number} decay The decay control.
 * @returns {number} k.
 */
function extinction(decay) {
  return -CONSTANTS.GODRAY_REFERENCE_SAMPLES * Math.log(decay);
}

// ── The visibility profiles the behaviour is specified over ───────────────
//
// `t` is the fraction of the marched chord, 0 at the pixel and 1 at the end
// of the march. A profile returns how much light gets through at that point:
// 1 for open sky, 0 for geometry, fractional for cloud.

/** A chord with nothing in it. */
const CLEAR = () => 1;

/**
 * A smooth partial-occlusion profile: a raised cosine, fully open at the
 * pixel and fully closed at the sun end. Smooth, so the midpoint rule's
 * second-order error bound applies and can be checked.
 *
 * @param {number} t Path fraction.
 * @returns {number} Visibility.
 */
const SMOOTH = (t) => 0.5 * (1 + Math.cos(Math.PI * t));

/** Bounds on the raised cosine's first two derivatives. */
const SMOOTH_MAX_FIRST_DERIVATIVE = Math.PI / 2;
const SMOOTH_MAX_SECOND_DERIVATIVE = Math.PI ** 2 / 2;

/** A hard-edged occluder: a slab across part of the chord. */
const HARD_OCCLUDER_ENTRY = 0.35;
const HARD_OCCLUDER_EXIT = 0.55;
const HARD = (t) => (t > HARD_OCCLUDER_ENTRY && t < HARD_OCCLUDER_EXIT ? 0 : 1);

/**
 * Drive the march over the SHIPPED per-step functions and return the chord
 * fraction. The loop is the spec's; every arithmetic step in it is the
 * shader's.
 *
 * The evaluator computes in f64 where the device computes in f32, so `round`
 * is how a caller asks for the device's number format. It is the identity by
 * default; `Math.fround` at each value boundary is what makes UNDERFLOW —
 * where the whole quadrature collapses to zero and the shaft goes black —
 * expressible at all.
 *
 * @param {object} fns The compiled law.
 * @param {number} samples Sample count.
 * @param {number} decay Decay control.
 * @param {(t: number) => number} visibility Visibility profile.
 * @param {(x: number) => number} [round] Number format; f64 when omitted.
 * @returns {number} The chord fraction.
 */
function chordFraction(fns, samples, decay, visibility, round) {
  const r = round ?? ((x) => x);
  let attenuation = r(fns.godRayPathAttenuation(0.5 / samples, decay));
  const attenuationStep = r(fns.godRayPathAttenuation(1 / samples, decay));
  let visibleSum = 0;
  let weightSum = 0;
  for (let i = 0; i < samples; i += 1) {
    const t = (i + 0.5) / samples;
    visibleSum = r(
      fns.godRayAccumulate(visibleSum, visibility(t), attenuation),
    );
    weightSum = r(fns.godRayAccumulate(weightSum, 1, attenuation));
    attenuation = r(attenuation * attenuationStep);
  }
  return fns.godRayTransmittance(visibleSum, weightSum);
}

// ── A. CHARACTERISATION — the defect, re-derived independently ────────────
//
// These four numbers are the BEFORE. They are what the predecessor loop did,
// and they are banked in
// `migration_doc/audits/2026-09-06_CLOUD_WAVE_RAY_ENERGY_SOURCE_NOTES.md`
// and in the C1/C3 fixture interface. Group A re-derives them from the closed
// form of the geometric series so a disagreement surfaces as a failure rather
// than as a quietly updated constant. Nothing in this file may change them.

const BANKED_PREDECESSOR_MULTIPLIERS = Object.freeze({
  16: 0.839809997,
  32: 1.2094327733,
  64: 1.4437137912,
  128: 1.4978879085,
});

/**
 * The predecessor's additive multiplier of the SKY colour for a uniform sky
 * field: `exposure * weight * sum(decay^i, i = 0..N-1)`.
 *
 * @param {number} samples Sample count.
 * @returns {number} The multiplier.
 */
function predecessorMultiplier(samples) {
  return (
    (DEFAULT_EXPOSURE * DEFAULT_WEIGHT * (1 - DEFAULT_DECAY ** samples)) /
    (1 - DEFAULT_DECAY)
  );
}

test("A1 the predecessor's uniform-sky multipliers re-derive to the banked table", () => {
  for (const samples of SAMPLE_COUNTS) {
    assert.ok(
      Math.abs(
        predecessorMultiplier(samples) -
          BANKED_PREDECESSOR_MULTIPLIERS[samples],
      ) < 5e-10,
      `N=${samples}: derived ${predecessorMultiplier(samples)} against banked ${BANKED_PREDECESSOR_MULTIPLIERS[samples]}`,
    );
  }
});

test("A2 the predecessor's brightness tracked the sample count", () => {
  // The defect stated as the observable it is: same input, more samples,
  // brighter picture. 1.784x across the specified sweep.
  const low = BANKED_PREDECESSOR_MULTIPLIERS[16];
  const high = BANKED_PREDECESSOR_MULTIPLIERS[128];
  assert.ok(high / low > 1.75, `spread ${high / low}`);
  for (let i = 1; i < SAMPLE_COUNTS.length; i += 1) {
    assert.ok(
      BANKED_PREDECESSOR_MULTIPLIERS[SAMPLE_COUNTS[i]] >
        BANKED_PREDECESSOR_MULTIPLIERS[SAMPLE_COUNTS[i - 1]],
      "the predecessor's multiplier was strictly increasing in N",
    );
  }
});

test("A3 the predecessor's supremum is the amplitude the new law keeps", () => {
  // `weight * exposure / (1 - decay)` is the limit the unnormalised sum
  // converged to, and it is exactly what `godRayGain` returns.
  const supremum = (DEFAULT_WEIGHT * DEFAULT_EXPOSURE) / (1 - DEFAULT_DECAY);
  assert.ok(Math.abs(supremum - 1.5) < 1e-12, `supremum ${supremum}`);
  assert.ok(
    Math.abs(
      LAW.godRayGain(DEFAULT_WEIGHT, DEFAULT_EXPOSURE, DEFAULT_DECAY) -
        supremum,
    ) < 1e-12,
    "the shipped gain is the predecessor's supremum",
  );
});

// ── B. COUNT INVARIANCE — the behaviour, not the shape ────────────────────

test("B1 a clear chord gives the same answer at 16, 32, 64 and 128 samples", () => {
  const values = SAMPLE_COUNTS.map((n) =>
    chordFraction(LAW, n, DEFAULT_DECAY, CLEAR),
  );
  for (let i = 0; i < values.length; i += 1) {
    assert.ok(
      Math.abs(values[i] - values[values.length - 1]) <= CLEAR_CHORD_TOLERANCE,
      `N=${SAMPLE_COUNTS[i]}: ${values[i]} against ${values[values.length - 1]}, tolerance ${CLEAR_CHORD_TOLERANCE}`,
    );
  }
  // And the discriminating power: the predecessor's own spread over the same
  // sweep is larger than this tolerance by five orders of magnitude.
  const predecessorSpread =
    (BANKED_PREDECESSOR_MULTIPLIERS[128] - BANKED_PREDECESSOR_MULTIPLIERS[16]) /
    BANKED_PREDECESSOR_MULTIPLIERS[128];
  assert.ok(
    predecessorSpread / CLEAR_CHORD_TOLERANCE > 1e4,
    `discrimination ${predecessorSpread / CLEAR_CHORD_TOLERANCE}x`,
  );
});

test("B1b a uniform partial transmittance passes exactly that fraction", () => {
  // The chord fraction is a FRACTION: a chord under uniform cloud that lets
  // one percent through passes one percent of the sun's light, and it passes
  // the same one percent at every sample count. This is the statement the
  // predecessor could not make at all — its output was a multiple of the SKY
  // colour whose size was set by the loop trip count.
  for (const transmittance of [0.01, 0.25, 0.5, 1]) {
    for (const samples of SAMPLE_COUNTS) {
      const fraction = chordFraction(
        LAW,
        samples,
        DEFAULT_DECAY,
        () => transmittance,
      );
      assert.ok(
        Math.abs(fraction - transmittance) <= CLEAR_CHORD_TOLERANCE,
        `transmittance ${transmittance} at N=${samples} read back as ${fraction}`,
      );
    }
  }
});

test("B2 a smooth partial occlusion converges at the midpoint rule's own rate", () => {
  // The derived bound. Midpoint error over [0,1] is h^2/24 times the second
  // derivative of the integrand; the chord fraction is a quotient of two such
  // quadratures, so the numerator's absolute error and the denominator's
  // relative error both enter.
  const k = extinction(DEFAULT_DECAY);
  const integralOfAttenuation = (1 - Math.exp(-k)) / k;
  const maxIntegrandSecondDerivative =
    SMOOTH_MAX_SECOND_DERIVATIVE + 2 * SMOOTH_MAX_FIRST_DERIVATIVE * k + k * k;

  /**
   * @param {number} samples Sample count.
   * @returns {number} Absolute bound on the chord fraction's quadrature error.
   */
  function bound(samples) {
    const h2 = 1 / (samples * samples);
    const numeratorError = (h2 / 24) * maxIntegrandSecondDerivative;
    const denominatorRelative = ((h2 / 24) * k * k) / integralOfAttenuation;
    return numeratorError / integralOfAttenuation + denominatorRelative;
  }

  const values = SAMPLE_COUNTS.map((n) =>
    chordFraction(LAW, n, DEFAULT_DECAY, SMOOTH),
  );
  const reference = values[values.length - 1];
  for (let i = 0; i < values.length; i += 1) {
    const error = Math.abs(values[i] - reference);
    assert.ok(
      error <= bound(SAMPLE_COUNTS[i]) + CLEAR_CHORD_TOLERANCE,
      `N=${SAMPLE_COUNTS[i]}: error ${error} exceeds derived bound ${bound(SAMPLE_COUNTS[i])}`,
    );
  }
  // Convergence, not merely a loose bound: each doubling of the sample count
  // must cut the error by at least 3x (the midpoint rule's theoretical 4x,
  // with headroom).
  for (let i = 1; i < values.length - 1; i += 1) {
    const before = Math.abs(values[i - 1] - reference);
    const after = Math.abs(values[i] - reference);
    assert.ok(
      before / after > 3,
      `N=${SAMPLE_COUNTS[i - 1]} -> ${SAMPLE_COUNTS[i]}: error fell only ${before / after}x`,
    );
  }
});

test("B3 the sample count is a quality control at a hard occluder edge, and stays bounded", () => {
  // A discontinuous visibility profile is where the sample count genuinely
  // matters, and the residual is the first-order error of sampling a step —
  // one sample's worth of weight at each transition. The honest statement is
  // that the spread is bounded by that, and does NOT climb with N the way the
  // predecessor's brightness did.
  const k = extinction(DEFAULT_DECAY);
  const integralOfAttenuation = (1 - Math.exp(-k)) / k;
  const transitionWeight =
    Math.exp(-k * HARD_OCCLUDER_ENTRY) + Math.exp(-k * HARD_OCCLUDER_EXIT);

  const values = SAMPLE_COUNTS.map((n) =>
    chordFraction(LAW, n, DEFAULT_DECAY, HARD),
  );
  for (const value of values) {
    assert.ok(value >= 0 && value <= 1, `chord fraction ${value} out of range`);
  }
  const reference = values[values.length - 1];
  for (let i = 0; i < values.length; i += 1) {
    const bound =
      transitionWeight / (SAMPLE_COUNTS[i] * integralOfAttenuation) +
      transitionWeight / (128 * integralOfAttenuation);
    assert.ok(
      Math.abs(values[i] - reference) <= bound,
      `N=${SAMPLE_COUNTS[i]}: ${Math.abs(values[i] - reference)} exceeds ${bound}`,
    );
  }
  // The positive form of the same claim. Asserting only that the sequence is
  // NOT monotone tests the absence of a pattern over four points, which a
  // legitimate reimplementation could trip by luck; what the law actually
  // guarantees is that the whole spread across N is contained by the
  // quadrature band derived above, and that the band is strictly tighter than
  // the count-dependence it replaces. Both halves are derived — the band from
  // the transition weights, the comparison from the banked BEFORE table.
  const widest =
    transitionWeight / (SAMPLE_COUNTS[0] * integralOfAttenuation) +
    transitionWeight / (128 * integralOfAttenuation);
  const band = (reference + widest) / (reference - widest);
  const spread = Math.max(...values) / Math.min(...values);
  assert.ok(
    spread <= band,
    `the spread across N is ${spread}, outside the quadrature band ${band}`,
  );
  const predecessorSpread =
    BANKED_PREDECESSOR_MULTIPLIERS[128] / BANKED_PREDECESSOR_MULTIPLIERS[16];
  assert.ok(
    band < predecessorSpread,
    `the quadrature band ${band} is no tighter than the ${predecessorSpread} count-dependence it replaces`,
  );
});

test("B4 the chord fraction converges to the closed-form integral of the law's own profile", () => {
  // An independent target: the exact value of
  //   integral(V(t) A(t) dt) / integral(A(t) dt),   A(t) = exp(-k t)
  // for the raised cosine, done by calculus rather than recorded from a run.
  const k = extinction(DEFAULT_DECAY);
  const e = Math.exp(-k);
  const integralOfAttenuation = (1 - e) / k;
  const integralOfProduct =
    0.5 * integralOfAttenuation +
    (0.5 * k * (1 + e)) / (k * k + Math.PI * Math.PI);
  const exact = integralOfProduct / integralOfAttenuation;

  const measured = chordFraction(LAW, 128, DEFAULT_DECAY, SMOOTH);
  assert.ok(
    Math.abs(measured - exact) < 1e-5,
    `128-sample quadrature ${measured} against the exact integral ${exact}`,
  );
});

test("B5 the energy bound: the added radiance never exceeds gain x glow", () => {
  const gain = LAW.godRayGain(DEFAULT_WEIGHT, DEFAULT_EXPOSURE, DEFAULT_DECAY);
  const profiles = { CLEAR, SMOOTH, HARD };
  for (const [name, visibility] of Object.entries(profiles)) {
    for (const samples of SAMPLE_COUNTS) {
      for (const distance of [0, 0.05, 0.1, 0.4, 1.2]) {
        let attenuation = LAW.godRayPathAttenuation(
          0.5 / samples,
          DEFAULT_DECAY,
        );
        const step = LAW.godRayPathAttenuation(1 / samples, DEFAULT_DECAY);
        let visibleSum = 0;
        let weightSum = 0;
        for (let i = 0; i < samples; i += 1) {
          const t = (i + 0.5) / samples;
          visibleSum = LAW.godRayAccumulate(
            visibleSum,
            visibility(t),
            attenuation,
          );
          weightSum = LAW.godRayAccumulate(weightSum, 1, attenuation);
          attenuation *= step;
        }
        const amplitude = LAW.godRayResolve(
          visibleSum,
          weightSum,
          distance,
          DEFAULT_GLOW_RADIUS,
          DEFAULT_WEIGHT,
          DEFAULT_EXPOSURE,
          DEFAULT_DECAY,
        );
        const ceiling = gain * LAW.godRaySunGlow(distance, DEFAULT_GLOW_RADIUS);
        assert.ok(
          amplitude >= 0 && amplitude <= ceiling + 1e-12,
          `${name} N=${samples} d=${distance}: ${amplitude} outside [0, ${ceiling}]`,
        );
      }
    }
  }
});

test("B6 a fully blocked chord contributes nothing, at every sample count", () => {
  for (const samples of SAMPLE_COUNTS) {
    const fraction = chordFraction(LAW, samples, DEFAULT_DECAY, () => 0);
    assert.equal(fraction, 0, `N=${samples}`);
    assert.equal(
      LAW.godRayResolve(
        0,
        1,
        0,
        DEFAULT_GLOW_RADIUS,
        DEFAULT_WEIGHT,
        DEFAULT_EXPOSURE,
        DEFAULT_DECAY,
      ),
      0,
    );
  }
});

test("B7 the shaft falls off with distance from the sun instead of lifting the whole sky", () => {
  // The predecessor added the same multiple of the sky colour to EVERY sky
  // pixel — there was no radial falloff at all once the source stopped being
  // a bright pass. The glow profile is what puts it back.
  assert.equal(LAW.godRaySunGlow(0, DEFAULT_GLOW_RADIUS), 1);
  let previous = Infinity;
  for (const d of [0, 0.02, 0.05, 0.1, 0.2, 0.4, 0.8, 1.5]) {
    const value = LAW.godRaySunGlow(d, DEFAULT_GLOW_RADIUS);
    assert.ok(value < previous, `glow is not decreasing at d=${d}`);
    assert.ok(value >= 0, `glow negative at d=${d}`);
    previous = value;
  }
  // Four glow radii out, at most a seventeenth of the peak.
  assert.ok(
    LAW.godRaySunGlow(4 * DEFAULT_GLOW_RADIUS, DEFAULT_GLOW_RADIUS) <= 1 / 17,
    "the glow has no far-field falloff",
  );
});

test("B8 the reference sample count is a FROZEN calibration, not a coupling", () => {
  // Read this one carefully, because its obvious form is inverted. The law's
  // count invariance does NOT depend on GODRAY_REFERENCE_SAMPLES matching
  // GodRayConfig.sampleCount's default: A(t) = decay^(R t) is count-invariant
  // for ANY R, which B1 asserts directly. R = 64 is a frozen historical
  // calibration — the one value that makes the SHIPPED default keep the chord
  // shape the predecessor produced — and once landed it never moves again.
  //
  // Asserting the EQUALITY instead would fire red the day someone legitimately
  // raises the default sampleCount to 128 as a quality improvement, and the
  // repair it points at (raise R to 128) would silently change the artistic
  // chord profile, which is the coupling this lane exists to remove. So the
  // constant is pinned against the literal, and the default is free to move.
  assert.equal(
    CONSTANTS.GODRAY_REFERENCE_SAMPLES,
    64,
    "GODRAY_REFERENCE_SAMPLES moved; the shipped chord profile moved with it",
  );
  // The default is READ, so a drift is visible in the record, but it is not
  // constrained: the law holds at any sample count (B1) and at any reference.
  assert.ok(
    Number.isFinite(DEFAULT_SAMPLE_COUNT) && DEFAULT_SAMPLE_COUNT >= 1,
    "GodRayConfig.sampleCount has no readable numeric default",
  );
});

test("B9 the decay floor keeps the chord quadrature alive in f32", () => {
  // The lower clamp exists so `pow` cannot reach zero. Below the floor it does
  // exactly that: the first quadrature node sits at t = 0.5/N, so its weight
  // is decay^(R/2) at N = 1 — the smallest sample count the shader permits —
  // and if that underflows f32 then every weight does, weightSum is 0,
  // godRayTransmittance returns 0 and the shaft is BLACK. Subnormals are
  // flush-to-zero on much hardware, so the bar is the smallest NORMAL f32.
  const floor = CONSTANTS.GODRAY_MIN_DECAY;
  const smallestNormal = 2 ** -126;
  const required = Math.pow(2, -126 / (CONSTANTS.GODRAY_REFERENCE_SAMPLES / 2));
  assert.ok(
    floor >= required,
    `GODRAY_MIN_DECAY ${floor} is below the ${required} that keeps decay^(R/2) a normal f32`,
  );
  // Driven from what a CALLER can ask for, not from the floor itself: the
  // clamp only does anything for a decay below it, so a request of 0 is the
  // input that exercises it. `GodRayConfig.decay` is public, so this is
  // reachable behaviour, not a hypothetical.
  for (const requested of [0, 1e-6, 0.0001, floor]) {
    for (const samples of [1, 2, 3, 4, 16, 64, 128]) {
      const firstWeight = Math.fround(
        LAW.godRayPathAttenuation(0.5 / samples, requested),
      );
      assert.ok(
        firstWeight >= smallestNormal,
        `decay=${requested} N=${samples}: the first node's weight ${firstWeight} is not a normal f32`,
      );
      // The behaviour that follows from it: a clear chord still reads fully
      // clear, and a blocked one still reads nothing.
      const clear = chordFraction(LAW, samples, requested, CLEAR, Math.fround);
      assert.ok(
        Math.abs(clear - 1) <= CLEAR_CHORD_TOLERANCE,
        `decay=${requested} N=${samples}: a clear chord reads ${clear}`,
      );
      assert.equal(
        chordFraction(LAW, samples, requested, () => 0, Math.fround),
        0,
        `decay=${requested} N=${samples}: a blocked chord is not dark`,
      );
    }
  }
  // And the pre-fix floor is what it fails at, so the assertion above is not
  // vacuously true of any floor: at 0.0001 the whole quadrature underflows.
  assert.equal(
    Math.fround(Math.pow(0.0001, CONSTANTS.GODRAY_REFERENCE_SAMPLES / 2)),
    0,
    "the pre-fix decay floor no longer underflows, so B9 proves nothing",
  );
});

// ── C. THE EMITTER IS ISOLATED FROM THE SCENE COLOUR ──────────────────────
//
// This is a DATA-DEPENDENCY group, and says so. A value the fragment stage
// never reads cannot reach its output, so "the sky's colour does not enter the
// shaft" is decidable from which textures the stage samples. What the shaft
// then looks like is a capture's job, not this file's.

/**
 * Extract a WGSL function body by brace matching from a marker.
 *
 * @param {string} text WGSL source, comments stripped.
 * @param {string} marker Text that starts the function.
 * @returns {string} The body.
 */
function bodyAfter(text, marker) {
  const at = text.indexOf(marker);
  assert.ok(at >= 0, `marker not found: ${marker}`);
  const open = text.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "{") {
      depth += 1;
    } else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(open + 1, i);
      }
    }
  }
  throw new Error(`unbalanced braces after ${marker}`);
}

test("C1 the generate stage never reads the scene colour", () => {
  for (const [name, text] of [
    ["GodRayGenerate.wgsl", generateWgsl],
    ["GodRayGenerate_f16.wgsl", generateF16Wgsl],
  ]) {
    const stripped = stripComments(text);
    const body = bodyAfter(stripped, "fn fragmentMain");
    assert.ok(
      !body.includes("sceneColorTex"),
      `${name}: the fragment stage still samples the scene colour, so the sky can still be the emitter`,
    );
    assert.ok(
      stripped.includes("sceneColorTex"),
      `${name}: the binding itself must stay declared — the explicit bind group layout still provides it`,
    );
  }
});

/**
 * Collapse every run of whitespace to a single space.
 *
 * Groups C/D/E decide facts from source text, and a source-shape assertion
 * that encodes a line break decides a fact about the FORMATTER instead: a
 * prettier pass that reflows one expression turns a green spec red, or a red
 * one green, without changing a single thing the assertion is about. Matching
 * against the collapsed form removes the formatter from the answer, and the
 * patterns below keep `\s*` at every token join so the collapsed single space
 * is optional too.
 *
 * @param {string} text Source.
 * @returns {string} The same source with whitespace runs collapsed.
 */
function collapseWhitespace(text) {
  return text.replace(/\s+/g, " ");
}

const effectTsFlat = collapseWhitespace(effectTs);

// The byte-range table the effect exports, read out of the source rather
// than imported — this file runs under `node --test` with no TypeScript
// loader, and the point is to pin what the shipped module declares.
const UNIFORM_BYTE_LENGTH = Number(
  /export const GOD_RAY_UNIFORM_BYTE_LENGTH\s*=\s*(\d+)/.exec(effectTs)[1],
);

/**
 * Parse `GOD_RAY_UNIFORM_RANGES` out of the effect source.
 *
 * @returns {Array<{name: string, offset: number, size: number}>} The ranges.
 */
function uniformRanges() {
  const block = bodyAfter(effectTs, "export const GOD_RAY_UNIFORM_RANGES");
  const re =
    /(\w+)\s*:\s*Object\.freeze\(\{\s*offset\s*:\s*(\d+)\s*,\s*size\s*:\s*(\d+)\s*\}\)/g;
  const out = [];
  let m = re.exec(block);
  while (m !== null) {
    out.push({ name: m[1], offset: Number(m[2]), size: Number(m[3]) });
    m = re.exec(block);
  }
  assert.ok(out.length >= 4, `too few uniform ranges parsed: ${out.length}`);
  return out;
}

test("C2 the emitted colour comes from the sun radiance uniform", () => {
  for (const [name, text] of [
    ["GodRayGenerate.wgsl", generateWgsl],
    ["GodRayGenerate_f16.wgsl", generateF16Wgsl],
  ]) {
    const body = collapseWhitespace(
      bodyAfter(stripComments(text), "fn fragmentMain"),
    );
    assert.ok(
      /sunRadiance\s*=\s*uniforms\s*\.\s*params2\s*\.\s*xyz/.test(body),
      `${name}: no isolated sun radiance`,
    );
    assert.ok(
      body.includes("sunRadiance"),
      `${name}: the sun radiance does not reach the output`,
    );
  }
});

test("C3 the effect defaults the emitter to unit radiance and the documented glow radius", () => {
  assert.ok(
    /sunRadiance\s*:\s*\[\s*1\s*,\s*1\s*,\s*1\s*,?\s*\]/.test(
      collapseWhitespace(appearanceDefaults),
    ),
    "the sun radiance default is not unit white",
  );
  assert.equal(DEFAULT_GLOW_RADIUS, 0.1);
});

test("C4 the uniform buffer carries the emitter, the aspect and the usability flag", () => {
  // Twenty floats: five vec4s. A layout that drifts from the WGSL struct is a
  // silent misread of every field after the drift.
  const packer = effectTsFlat.slice(
    effectTsFlat.indexOf("return new Float32Array(["),
  );
  const floats = packer.slice(0, packer.indexOf("]);"));
  assert.ok(/this\s*\.\s*_config\s*\.\s*sunGlowRadius/.test(floats));
  assert.ok(/this\s*\.\s*_sunUnusable/.test(floats));
  assert.ok(
    /radiance\s*\[\s*0\s*\][\s\S]*radiance\s*\[\s*1\s*\][\s\S]*radiance\s*\[\s*2\s*\]/.test(
      floats,
    ),
  );
  assert.ok(
    /aspect\s*=\s*this\s*\.\s*_width\s*>\s*0\s*&&\s*this\s*\.\s*_height\s*>\s*0/.test(
      effectTsFlat,
    ),
    "the glow is not aspect-corrected, so it is an ellipse on a non-square canvas",
  );

  // The caller's boolean is the sole authority on usability: the effect
  // stores what it was handed and does not re-derive it. A second opinion
  // here is how the pass skip and the shader arm come to disagree.
  assert.ok(
    /_sunUnusable\s*=\s*usable\s*\?\s*0\.0\s*:\s*1\.0/.test(effectTsFlat),
    "the unusable flag is not taken verbatim from the caller's boolean",
  );

  // ── THE SILENT-FREEZE GUARD ──────────────────────────────────────────
  //
  // Every per-frame setter writes only the bytes it owns. A field whose
  // bytes NO range covers — or whose range is declared but written by no
  // setter — reaches the GPU once at `initialize()` and then stops moving.
  // Nothing fails to compile, WebGPU raises no validation error, and every
  // other assertion in this file still passes: the packer would carry the
  // value, the shader would read the slot, and the slot would hold the
  // init-time placeholder forever. This is the only check that can see it.
  const ranges = uniformRanges();
  // Brace-matching from the DECLARATION would stop at a `= {}` default
  // parameter inside the signature and hand back an empty body — which reads
  // exactly like a setter that writes nothing. Start the match past the
  // signature text instead.
  const bodyOfMethod = (declaration) => {
    const at = effectTs.indexOf(declaration);
    assert.ok(at >= 0, `method not found: ${declaration}`);
    return bodyAfter(effectTs.slice(at + declaration.length), "): void");
  };
  const setters = {
    setSunScreenUV: bodyOfMethod("setSunScreenUV(u: number"),
    updateConfig: bodyOfMethod("updateConfig(config: GodRayAppearanceConfig"),
  };
  for (const [field, first, end] of [
    ["sunUnusable (params3.y)", 68, 72],
    ["the emitter (params2: sunRadiance.rgb + sunGlowRadius)", 48, 64],
  ]) {
    const covering = ranges.filter(
      (r) => r.offset <= first && r.offset + r.size >= end,
    );
    assert.equal(
      covering.length,
      1,
      `${field}: expected exactly one declared range covering bytes ${first}-${end}, got ${covering.length}`,
    );
    const writers = Object.entries(setters).filter(([, body]) =>
      body.includes(`GOD_RAY_UNIFORM_RANGES.${covering[0].name}`),
    );
    assert.ok(
      writers.length >= 1,
      `${field}: the \`${covering[0].name}\` range is declared but no per-frame setter writes it, so the field freezes at its init value`,
    );
  }

  // And the table stays a partition inside the struct: an overlap would let
  // one setter clobber another's field, which is the defect the ranges exist
  // to prevent in the other direction.
  const sorted = [...ranges].sort((a, b) => a.offset - b.offset);
  for (let i = 0; i < sorted.length; i += 1) {
    assert.ok(
      sorted[i].offset + sorted[i].size <= UNIFORM_BYTE_LENGTH,
      `${sorted[i].name} runs past the ${UNIFORM_BYTE_LENGTH}-byte struct`,
    );
    if (i > 0) {
      assert.ok(
        sorted[i - 1].offset + sorted[i - 1].size <= sorted[i].offset,
        `${sorted[i - 1].name} overlaps ${sorted[i].name}`,
      );
    }
  }
});

// ── D. THE TWO VARIANTS CARRY THE SAME LAW ────────────────────────────────

test("D1 the f16 twin's law functions are byte-identical to the f32 reference", () => {
  const a = stripComments(generateWgsl);
  const b = stripComments(generateF16Wgsl);
  for (const name of LAW_FUNCTIONS) {
    assert.equal(
      bodyAfter(a, `fn ${name}`).trim(),
      bodyAfter(b, `fn ${name}`).trim(),
      `${name} has drifted between the f32 and f16 shaders`,
    );
  }
});

test("D2 the f16 twin accumulates in f32 and narrows only at the end", () => {
  // Not a claim that the path is reachable — `useShaderF16` reachability is
  // not established and nothing here establishes it. This only pins that the
  // twin does not reintroduce an unbounded half-precision sum.
  const body = bodyAfter(stripComments(generateF16Wgsl), "fn fragmentMain");
  const loop = bodyAfter(body, "for (var i");
  assert.ok(
    !loop.includes("f16"),
    "the f16 twin accumulates in half precision inside the march again",
  );
  assert.ok(
    body.includes("vec3<f16>"),
    "the f16 twin no longer narrows at all, so it is not an f16 variant",
  );
});

// ── E. PASS ORDER AND COLOUR SPACE — recorded, not changed ────────────────

test("E1 the pass order comment states the order the code actually runs", () => {
  // The predecessor comment claimed the shaft participated in the bloom while
  // sitting after the bloom pass. Correcting the claim is in scope; moving
  // either pass is a separate reviewed contract and is not done here.
  const at = pipelineTs.indexOf("// 2.5 GodRays");
  assert.ok(at >= 0, "the GodRay step comment is gone");
  const comment = pipelineTs.slice(at, at + 700);
  assert.ok(
    /AFTER Bloom/.test(comment) && /does NOT participate/.test(comment),
    "the ordering comment still claims the shaft blooms",
  );
  // And the order itself is unchanged: bloom, then god rays, then tonemap.
  const bloomAt = pipelineTs.indexOf("// 2. Bloom");
  const dofAt = pipelineTs.indexOf("// 3. Depth of Field");
  assert.ok(
    bloomAt >= 0 && bloomAt < at && at < dofAt,
    "the pass order moved; this lane does not move passes",
  );
});

// ── F. MUTANTS — one source substituted in memory, nothing written ────────
//
// The verdict RECOMPILES the law out of whatever text it is handed and
// executes it, so an arithmetic mutation flips it even though every symbol is
// still present. F1 is the INERTNESS mutant the proof bar asks for: the
// normalisation is still compiled, still syntactically live, and unreachable.

/**
 * The law's whole claim, as one boolean, recomputed from arbitrary text.
 *
 * @param {string} [text] WGSL source; the shipped file when omitted.
 * @returns {boolean} Whether the energy law holds.
 */
function verdict(text) {
  try {
    const { fns, constants } = lawFrom(text ?? generateWgsl);
    // Count invariance on a clear chord.
    const clear = SAMPLE_COUNTS.map((n) =>
      chordFraction(fns, n, DEFAULT_DECAY, CLEAR),
    );
    const reference = clear[clear.length - 1];
    for (const value of clear) {
      if (!(Math.abs(value - reference) <= CLEAR_CHORD_TOLERANCE)) {
        return false;
      }
    }
    // The chord fraction is a FRACTION — a uniform transmittance reads back
    // as itself, at every sample count. Without this an unnormalised sum
    // survives, because clamping a sum that is always greater than one to
    // [0, 1] looks count-invariant for a clear chord.
    for (const transmittance of [0.01, 0.25, 0.5, 1]) {
      for (const samples of SAMPLE_COUNTS) {
        const fraction = chordFraction(
          fns,
          samples,
          DEFAULT_DECAY,
          () => transmittance,
        );
        if (!(Math.abs(fraction - transmittance) <= CLEAR_CHORD_TOLERANCE)) {
          return false;
        }
      }
    }
    // A blocked chord contributes nothing.
    if (chordFraction(fns, 64, DEFAULT_DECAY, () => 0) !== 0) {
      return false;
    }
    // The lower decay clamp keeps the chord quadrature alive in the device's
    // number format. A caller may ask for any decay; below the floor every
    // attenuation weight underflows f32, weightSum is zero, and the shaft goes
    // black at the smallest sample counts the shader permits. Driven from a
    // request of 0 because the clamp only acts on values below it.
    if (!(constants.GODRAY_MIN_DECAY > 0)) {
      return false;
    }
    for (const samples of [1, 2]) {
      const atFloor = chordFraction(fns, samples, 0, CLEAR, Math.fround);
      if (!(Math.abs(atFloor - 1) <= CLEAR_CHORD_TOLERANCE)) {
        return false;
      }
    }
    // The amplitude anchor.
    const gain = fns.godRayGain(
      DEFAULT_WEIGHT,
      DEFAULT_EXPOSURE,
      DEFAULT_DECAY,
    );
    if (!(Math.abs(gain - 1.5) < 1e-9)) {
      return false;
    }
    // The radial falloff.
    if (fns.godRaySunGlow(0, DEFAULT_GLOW_RADIUS) !== 1) {
      return false;
    }
    if (
      !(
        fns.godRaySunGlow(4 * DEFAULT_GLOW_RADIUS, DEFAULT_GLOW_RADIUS) <=
        1 / 17
      )
    ) {
      return false;
    }
    // The composition: a blocked chord resolves to zero radiance even at the
    // centre of the glow.
    if (
      fns.godRayResolve(
        0,
        1,
        0,
        DEFAULT_GLOW_RADIUS,
        DEFAULT_WEIGHT,
        DEFAULT_EXPOSURE,
        DEFAULT_DECAY,
      ) !== 0
    ) {
      return false;
    }
    return true;
  } catch {
    // A law that no longer compiles is a failed verdict, not a harness error.
    return false;
  }
}

/**
 * Substitute text for the length of one verdict and require the flip.
 *
 * @param {string} from Text to replace.
 * @param {string} to Replacement.
 * @param {boolean} expectation What the verdict must become.
 * @returns {void}
 */
function withMutation(from, to, expectation) {
  assert.ok(
    generateWgsl.includes(from),
    `mutation precondition failed: "${from.slice(0, 70)}..."`,
  );
  assert.equal(
    verdict(generateWgsl.replace(from, to)),
    expectation,
    "the mutant did not move the verdict",
  );
}

test("F0 the verdict is TRUE on the shipped tree", () => {
  assert.equal(
    verdict(undefined),
    true,
    "a verdict that is already false proves nothing about the mutants below",
  );
});

test("F1 INERTNESS — the normalisation compiled, live, and unreachable", () => {
  // Every symbol stays. `clamp(visibleSum / weightSum, 0.0, 1.0)` is still
  // there and still parses. It is simply never reached, because the guard in
  // front of it is true for every sum the march can produce. This is the
  // mutation that a deletion-only mutant would miss.
  withMutation(
    "  if (weightSum <= 0.0) { return 0.0; }\n" +
      "  return clamp(visibleSum / weightSum, 0.0, 1.0);",
    "  if (weightSum > -1.0) { return visibleSum; }\n" +
      "  return clamp(visibleSum / weightSum, 0.0, 1.0);",
    false,
  );
});

test("F2 ABSENCE — the normalisation divided away", () => {
  withMutation(
    "  return clamp(visibleSum / weightSum, 0.0, 1.0);",
    "  return clamp(visibleSum, 0.0, 1.0);",
    false,
  );
});

test("F3 the amplitude anchor is load-bearing", () => {
  withMutation(
    "  return weight * exposure / (1.0 - d);",
    "  return weight * exposure * d;",
    false,
  );
});

test("F4 the radial falloff is load-bearing", () => {
  withMutation(
    "  return 1.0 / (1.0 + s * s);",
    "  return 1.0 / (1.0 + s * 0.0);",
    false,
  );
});

test("F5 the visibility gate inside the accumulator is load-bearing", () => {
  // Drop the visibility factor and a blocked chord stops being dark.
  withMutation(
    "  return sum + visibility * attenuation;",
    "  return sum + attenuation;",
    false,
  );
});

test("F6 the composition is load-bearing", () => {
  withMutation(
    "  return godRayGain(weight, exposure, decay) * glow * transmittance;",
    "  return godRayGain(weight, exposure, decay) * glow;",
    false,
  );
});

test("F7 CONTROL — a comment-only change must NOT flip the verdict", () => {
  // What separates a discriminating mutant from a merely destructive one.
  withMutation(
    "// Peak additive radiance for a unit-radiance sun",
    "// Peak additive radiance (comment-only control mutation)",
    true,
  );
});

test("F8 the mutants never touched the tree", () => {
  assert.equal(
    read(GENERATE_WGSL_PATH),
    generateWgsl,
    "GodRayGenerate.wgsl was modified on disk; mutants must substitute in memory",
  );
});

test("F9 ABSENCE — the decay floor put back where it underflows", () => {
  // The pre-fix value. Every symbol is present and the clamp still runs; the
  // floor is simply back below the point where decay^(R/2) survives f32.
  withMutation(
    "const GODRAY_MIN_DECAY: f32 = 0.07;",
    "const GODRAY_MIN_DECAY: f32 = 0.0001;",
    false,
  );
});

test("F10 INERTNESS — the decay floor compiled, referenced, and never binding", () => {
  // The constant keeps its shipped value, keeps its declaration, and is still
  // READ by the expression that is supposed to enforce it. It simply never
  // wins the `min`, so nothing it says reaches the result. A grep for the
  // symbol still finds it; the behaviour is gone.
  withMutation(
    "  let d = clamp(decay, GODRAY_MIN_DECAY, GODRAY_MAX_DECAY);\n" +
      "  return pow(d, GODRAY_REFERENCE_SAMPLES * t);",
    "  let d = clamp(decay, min(GODRAY_MIN_DECAY, 0.0001), GODRAY_MAX_DECAY);\n" +
      "  return pow(d, GODRAY_REFERENCE_SAMPLES * t);",
    false,
  );
});

// ── H. THE PROBE'S NEAR-SUN CEILING ───────────────────────────────────────
//
// The Edge leg had a FLOOR on near-sun amplitude and a ceiling only on the FAR
// band, so a shaft that blew the sun's neighbourhood out to white passed every
// bar it had. `lib/godray-near-ceiling.mjs` is the missing ceiling. It is pure
// arithmetic with no imports, so this group EXECUTES it rather than grepping
// for it, and the mutants below import mutated copies from `data:` URLs.

const NEAR_CEILING_PATH = path.join(
  ROOT,
  "Tools",
  "visual-regression",
  "lib",
  "godray-near-ceiling.mjs",
);
const nearCeilingSource = read(NEAR_CEILING_PATH);
const PROBE_PATH = path.join(
  ROOT,
  "Tools",
  "visual-regression",
  "probe-godray-energy-law.mjs",
);
const probeSource = read(PROBE_PATH);

/**
 * Import a possibly-mutated copy of the ceiling module without writing a file.
 *
 * @param {string} [source] Module text; the shipped file when omitted.
 * @returns {Promise<object>} The module namespace.
 */
function importCeiling(source) {
  const text = source ?? nearCeilingSource;
  const encoded = Buffer.from(text, "utf8").toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
}

/**
 * The mean of `min(1, alpha * glow)` over the glow's own unit disc, computed
 * here by calculus so the module's constant has an external target:
 * `2 * integral(s * min(1, alpha/(1+s^2)) ds, 0..1)`.
 *
 * @param {number} alpha Peak overshoot of the display white point.
 * @returns {number} The mean, in [0, 1].
 */
function discMeanByCalculus(alpha) {
  const ln2 = Math.log(2);
  if (alpha <= 1) {
    return alpha * ln2;
  }
  if (alpha >= 2) {
    return 1;
  }
  // Clipped for s < sqrt(alpha-1): that area contributes 1, and the rest
  // integrates to alpha * [ln(1+s^2)] between the clip radius and 1.
  return alpha - 1 + alpha * (ln2 - Math.log(alpha));
}

test("H1 the ceiling's arithmetic is the glow profile's own, re-derived by calculus", async () => {
  const m = await importCeiling();
  // The area mean of the unclipped glow over its own unit disc is exactly ln2.
  // Checked against a midpoint quadrature of the area integral, so the closed
  // form is not merely restated.
  let numeric = 0;
  const steps = 200000;
  for (let i = 0; i < steps; i += 1) {
    const s = (i + 0.5) / steps;
    numeric += ((1 / (1 + s * s)) * 2 * s) / steps;
  }
  assert.ok(
    Math.abs(m.NEAR_DISC_MEAN_GLOW - Math.log(2)) < 1e-15,
    "the disc mean is not ln 2",
  );
  assert.ok(
    Math.abs(numeric - m.NEAR_DISC_MEAN_GLOW) < 1e-9,
    `the quadrature ${numeric} disagrees with the closed form ${m.NEAR_DISC_MEAN_GLOW}`,
  );
  // The two anchors of the scale: a peak that exactly reaches white clips
  // nothing and reads ln2; twice the headroom whites out the whole disc.
  assert.ok(Math.abs(m.nearDiscMeanFraction(1) - Math.log(2)) < 1e-15);
  assert.equal(m.nearDiscMeanFraction(2), 1);
  for (const alpha of [0.1, 0.5, 0.9, 1, 1.05, 1.1, 1.5, 1.9, 2]) {
    assert.ok(
      Math.abs(m.nearDiscMeanFraction(alpha) - discMeanByCalculus(alpha)) <
        1e-12,
      `M(${alpha}) disagrees with the closed form`,
    );
  }
  // Monotone, so the overshoot the receipt reports is well defined.
  let previous = -1;
  for (let i = 0; i <= 200; i += 1) {
    const value = m.nearDiscMeanFraction((i / 200) * 2);
    assert.ok(value >= previous, "the disc mean is not monotone in alpha");
    previous = value;
  }
  assert.ok(
    Math.abs(
      m.NEAR_CEILING_FRACTION - discMeanByCalculus(m.NEAR_CEILING_ALPHA),
    ) < 1e-12,
    "the shipped ceiling fraction is not M(NEAR_CEILING_ALPHA)",
  );
});

test("H2 the ceiling discriminates a blown-out disc from a bright one", async () => {
  const m = await importCeiling();
  // The failure the leg could not fail on: an OFF sky at 0.3 luma and a shaft
  // that whites the whole disc out. Every other bar in the probe passes on it.
  for (const offNear of [0.05, 0.2, 0.3, 0.5, 0.75]) {
    const headroom = 1 - offNear;
    const ceiling = m.nearCeiling(offNear);
    assert.ok(
      headroom > ceiling,
      `a total white-out (${headroom}) must exceed the ceiling (${ceiling})`,
    );
    // A shaft whose peak exactly reaches white clips nothing and must pass.
    assert.ok(
      Math.log(2) * headroom <= ceiling,
      "a shaft that just touches white is refused",
    );
    // A dim shaft must pass with room to spare.
    assert.ok(
      0.25 * Math.log(2) * headroom <= ceiling,
      "a dim shaft is refused",
    );
    // And the inverse reports the overshoot rather than only a verdict.
    for (const alpha of [0.25, 1, 1.1, 1.6]) {
      const delta = m.nearDiscMeanFraction(alpha) * headroom;
      assert.ok(
        Math.abs(m.impliedOvershoot(delta, offNear) - alpha) < 1e-6,
        `the implied overshoot does not round-trip at alpha=${alpha}`,
      );
    }
  }
  // Degenerate inputs answer rather than throw: no headroom, no judgement.
  assert.equal(m.nearCeiling(1), 0);
  assert.equal(m.impliedOvershoot(0.1, 1), 0);
});

test("H3 the probe applies the ceiling and records what calibrates it", () => {
  // A source-shape assertion, and says so: whether the bar is REACHED in a
  // browser is the leg's own job, and the leg has not been run. What is
  // decidable from here is that the ceiling is wired in as a ceiling and that
  // the receipt carries the evidence a recalibration needs.
  const flat = collapseWhitespace(probeSource);
  assert.ok(
    /from\s*"\.\.\/lib\/godray-near-ceiling\.mjs"/.test(flat),
    "the probe does not import the ceiling",
  );
  assert.ok(
    /nearDelta\s*<=\s*nearCeiling\s*\(\s*offM\s*\.\s*near\s*\)/.test(flat),
    "the probe's G6 is not a ceiling on the measured near-sun lift",
  );
  for (const field of [
    "offNear",
    "on64Near",
    "nearHeadroom",
    "offNearSaturatedAll",
    "on64NearSaturatedAll",
    "newlySaturatedAll",
    "ceiling",
    "impliedOvershoot",
  ]) {
    assert.ok(
      flat.includes(`${field}:`),
      `the receipt does not record ${field}, so the bar cannot be recalibrated from a capture`,
    );
  }
  assert.ok(
    /nearSaturatedAll\s*:/.test(flat) && /nearSaturatedAny\s*:/.test(flat),
    "the near disc's clipped fraction is not measured",
  );
  // And the leg's own inertness guard: a bar that is written here but never
  // pushed — `if (false && …)`, or a branch that stops reaching it — shortens
  // the check list instead of failing. The probe requires its bar set BY NAME,
  // so G6 has to be in that list for an inert G6 to be a failure rather than a
  // quieter pass. Whether the guard FIRES is the leg's own job; it has not run.
  assert.ok(
    /after\s*:\s*\[[^\]]*"G6"[^\]]*\]/.test(flat),
    "the after leg does not require G6 by name, so an inert G6 would pass",
  );
});

/**
 * The ceiling's whole claim as one boolean, recomputed from arbitrary module
 * text: it is a ceiling, it refuses a white-out, and it admits a shaft that
 * just touches white.
 *
 * @param {object} m The imported module namespace.
 * @returns {boolean} Whether the ceiling still discriminates.
 */
function ceilingVerdict(m) {
  try {
    for (const offNear of [0.05, 0.3, 0.75]) {
      const headroom = 1 - offNear;
      const ceiling = m.nearCeiling(offNear);
      if (!(headroom > ceiling)) {
        return false;
      }
      if (!(Math.log(2) * headroom <= ceiling)) {
        return false;
      }
    }
    return Math.abs(m.NEAR_DISC_MEAN_GLOW - Math.log(2)) < 1e-15;
  } catch {
    return false;
  }
}

test("F11 the ceiling verdict is TRUE on the shipped module", async () => {
  assert.equal(
    ceilingVerdict(await importCeiling()),
    true,
    "a ceiling verdict that is already false proves nothing about the mutants below",
  );
});

test("F12 ABSENCE — the ceiling widened to the whole headroom", async () => {
  // alpha = 2 is the white-out itself, so M(2) = 1 and the bar becomes
  // `nearDelta <= headroom` — always true of a luma delta. The bar is still
  // there, still computed, still applied; it just cannot fail.
  const mutant = nearCeilingSource.replace(
    "export const NEAR_CEILING_ALPHA = 1.1;",
    "export const NEAR_CEILING_ALPHA = 2;",
  );
  assert.notEqual(mutant, nearCeilingSource, "mutation precondition failed");
  assert.equal(ceilingVerdict(await importCeiling(mutant)), false);
});

test("F13 INERTNESS — the ceiling computed, exported, and never binding", async () => {
  // Every symbol survives and `NEAR_CEILING_FRACTION` is still evaluated and
  // still read by `nearCeiling`. The value simply never wins the `max`, so the
  // ceiling it describes is unreachable — the `if (false && …)` of an
  // expression. A spec that grepped for the constant would not notice.
  const mutant = nearCeilingSource.replace(
    "  return NEAR_CEILING_FRACTION * Math.max(0, 1 - offNear);",
    "  return Math.max(NEAR_CEILING_FRACTION * Math.max(0, 1 - offNear), 1);",
  );
  assert.notEqual(mutant, nearCeilingSource, "mutation precondition failed");
  assert.equal(ceilingVerdict(await importCeiling(mutant)), false);
});

test("F14 CONTROL — a comment-only change to the ceiling must NOT flip it", async () => {
  const mutant = nearCeilingSource.replace(
    " * @module godray-near-ceiling",
    " * @module godray-near-ceiling (comment-only control mutation)",
  );
  assert.notEqual(mutant, nearCeilingSource, "mutation precondition failed");
  assert.equal(ceilingVerdict(await importCeiling(mutant)), true);
});

test("F15 the ceiling mutants never touched the tree either", () => {
  assert.equal(
    read(NEAR_CEILING_PATH),
    nearCeilingSource,
    "godray-near-ceiling.mjs was modified on disk; mutants must substitute in memory",
  );
  assert.equal(read(GENERATE_F16_WGSL_PATH), generateF16Wgsl);
});
