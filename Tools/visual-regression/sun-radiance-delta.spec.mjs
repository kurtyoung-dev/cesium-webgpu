// sun-radiance-delta.spec.mjs — browser-free guard for the two-radiance solar
// disc run (`probe-sun-hdr-radiance.mjs`) and its lib.
//
// The lane exists to DECIDE something, so a spec that only exercised the
// correct implementation would be worth nothing: the wrong implementations pass
// too, they just pass vacuously. Every rule below is stated once and run twice
// — once against the real module or a synthetic frame whose answer is known in
// closed form, and once against the plausible wrong implementation somebody
// would actually write.
//
// The spec has four jobs:
//
//   1. PIN THE PRE-REGISTRATION AGAINST THE SHIPPED MODULE. The recorded
//      display-code table is recomputed here from `Scene/SolarDiscModel.js` —
//      the real file, imported, not transcribed. A table that stops describing
//      the shipped chain fails here rather than in a browser run days later.
//   2. PROVE THE MEASUREMENT RECOVERS WHAT IT CLAIMS, over synthetic 8-bit
//      frames whose code difference is known exactly.
//   3. PROVE THE DISCRIMINATION DISCRIMINATES — a multiplicative world, an
//      additive world, a no-excess world and a world matching neither, each
//      constructed from its own generating law and required to be named
//      correctly.
//   4. HOLD THE PROBE TO THE RECIPE, in particular the prohibition that gives
//      this run its shape: no scene flag may be pinned to "remove the halo".

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import SolarDiscModel from "../../packages/engine/Source/Scene/SolarDiscModel.js";
import { BRACKET_SATURATION_CODE } from "./lib/celestial-g2-gate.mjs";
import {
  DISC_BRACKET_EXPOSURES,
  DISC_MIN_DIFFERENTIAL_PIXELS,
  EXIT_CODE,
} from "./lib/celestial-g4-gate.mjs";
import {
  EXCESS_SHAPE,
  PRE_REGISTERED_D1_CODES,
  PRE_REGISTRATION_AGREEMENT_CODES,
  RADIANCE_DELTA_BIN_HALF_PX,
  RADIANCE_DELTA_EXPOSURE,
  RADIANCE_DELTA_LEGS,
  RADIANCE_DELTA_MIN_RESOLVED_SEPARATION,
  RADIANCE_DELTA_SAMPLE_X,
  d1DiscriminationPower,
  deriveDiscDifferentialCodes,
  discDifferentialCodeModel,
  discriminateRadianceExcess,
  evaluateRadianceDeltaBackend,
  foldRadianceDeltaVerdict,
  measureDiscDifferentialCodes,
  peakChannelCodeImage,
  plateauResolution,
} from "./lib/sun-radiance-delta.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const readNormalized = (relative) =>
  readFileSync(resolve(ROOT, relative), "utf8").replaceAll("\r\n", "\n");
const PROBE_REL = "Tools/visual-regression/probe-sun-hdr-radiance.mjs";
const PROBE = readNormalized(PROBE_REL);

// The bake's glow length at the shipped `glowFactor = 1`, which both bakes
// compute the same way. Every model evaluation below is at this value.
const GLOW_LENGTH_TS = 5.0;
const CORE = SolarDiscModel.solarHaloCoreRadii(GLOW_LENGTH_TS);
// The halo's amplitude is a fixed multiple of the disc radiance.
const HALO_PER_RADIANCE = SolarDiscModel.SOLAR_HALO_AMPLITUDE;
// The disc radius a 2-degree field puts a 0.5334-degree disc at on a 1280 px
// canvas — the geometry the recorded table was derived at.
const MODEL_DISC_RADIUS_PX = 170;
// The two shipped radiance positions.
const RESOLVED = { trueRadiance: 2.0, sdrRadiance: 1.0 };

const derivedAt = (
  L,
  model = SolarDiscModel,
  radiusPx = MODEL_DISC_RADIUS_PX,
) =>
  deriveDiscDifferentialCodes(model, {
    discRadiance: L,
    haloAmplitude: HALO_PER_RADIANCE * L,
    haloCoreRadii: CORE,
    discRadiusPx: radiusPx,
    exposure: RADIANCE_DELTA_EXPOSURE,
  });

// ===========================================================================
// 1. THE PRE-REGISTRATION, AGAINST THE SHIPPED MODULE
// ===========================================================================

test("the recorded table is what the SHIPPED chain predicts at both positions", () => {
  for (const [key, expected] of Object.entries(PRE_REGISTERED_D1_CODES)) {
    const d = derivedAt(RESOLVED[key]);
    assert.equal(d.samples.length, expected.length);
    d.samples.forEach((s, i) => {
      assert.ok(
        Math.abs(s.d1Codes - expected[i]) <= PRE_REGISTRATION_AGREEMENT_CODES,
        `${key} x=${s.x}: recorded ${expected[i]}, shipped model ${s.d1Codes}`,
      );
    });
  }
});

test("the forward model is the shipped display code, not a second transcription", () => {
  // At the disc centre with limb darkening OFF the composite is exactly
  // `L + haloAmplitude`, so the modelled code must equal the shipped function
  // evaluated on that number. Any private re-derivation of the tone curve would
  // show up here.
  const L = 2.0;
  const m = discDifferentialCodeModel(SolarDiscModel, {
    x: 0,
    limbDarkened: false,
    discRadiance: L,
    haloAmplitude: HALO_PER_RADIANCE * L,
    haloCoreRadii: CORE,
    exposure: RADIANCE_DELTA_EXPOSURE,
  });
  assert.equal(m.linear, L + HALO_PER_RADIANCE * L);
  assert.equal(
    m.code,
    SolarDiscModel.solarDiscDisplayCode(
      RADIANCE_DELTA_EXPOSURE * m.linear,
      2.2,
    ),
  );
});

test("the derivation READS the law — a flat mutant produces a flat prediction", () => {
  const flatLaw = { ...SolarDiscModel, solarLimbIntensity: () => 1.0 };
  for (const s of derivedAt(2.0, flatLaw).samples) {
    assert.equal(
      s.d1Codes,
      0,
      `a flat law must predict no differential at x=${s.x}`,
    );
  }
  // ...and a law with a different extreme-limb coefficient predicts a
  // different differential, so the band is a function of the law rather than a
  // constant somebody could edit the law out from under.
  const steeper = {
    ...SolarDiscModel,
    solarLimbIntensity: (x) => SolarDiscModel.solarLimbIntensity(x) * 0.5,
  };
  const shipped = derivedAt(2.0).samples[1].d1Codes;
  const mutant = derivedAt(2.0, steeper).samples[1].d1Codes;
  assert.ok(mutant > shipped * 1.2, `${mutant} must exceed ${shipped}`);
});

test("the derivation READS the radiance — the band moves with it", () => {
  const a = derivedAt(1.0).samples[1];
  const b = derivedAt(2.0).samples[1];
  assert.ok(b.d1Codes > a.d1Codes);
  assert.ok(b.tolCodes !== a.tolCodes);
});

// ===========================================================================
// 2. WHICH SAMPLES MAY CERTIFY, AND WHY
// ===========================================================================

test("the extreme limb is measured but NOT scored — the law diverges there", () => {
  const d = derivedAt(2.0);
  const byX = Object.fromEntries(d.samples.map((s) => [s.x, s]));
  assert.equal(byX[0].certifying, true, "the null control certifies");
  assert.equal(byX[0.95].certifying, true, "the law sample certifies");
  assert.equal(
    byX[1].certifying,
    false,
    "x=1 sits on the limb law's vertical tangent; its band cannot bound anything",
  );
  assert.match(byX[1].nonCertifyingReason, /FLAT disc/);
  // The mechanism, stated as arithmetic rather than as prose: the band at the
  // extreme limb is wider than the expectation it brackets, so it admits zero.
  assert.ok(byX[1].tolCodes > Math.abs(byX[1].d1Codes));
  assert.ok(byX[0.95].tolCodes < Math.abs(byX[0.95].d1Codes));
});

test("every certifying non-null band EXCLUDES the flat disc", () => {
  // This is the criterion's whole job. A band containing zero would pass on the
  // headline defect it exists to catch.
  for (const L of [1.0, 2.0]) {
    for (const s of derivedAt(L).samples) {
      if (s.x === 0 || !s.certifying) {
        continue;
      }
      assert.ok(
        s.band.lo > 0,
        `L=${L} x=${s.x}: band ${s.band.lo} admits zero`,
      );
    }
  }
});

test("the null control's band is the instrument error alone", () => {
  const s = derivedAt(2.0).samples[0];
  assert.equal(s.d1Codes, 0);
  // The limb law is stationary at the disc centre, so the binning term is zero
  // to within the central difference's own rounding — it is not merely small.
  assert.ok(s.terms.t1 < 1e-6, `centre slope term ${s.terms.t1}`);
  assert.ok(s.terms.t1 < s.terms.t2 / 1000);
  assert.equal(s.tolCodes, s.terms.loBar);
  assert.ok(s.tolCodes > 0 && s.tolCodes < 1, `${s.tolCodes} codes`);
});

test("the dominant band term is radial binning, and it is one bin wide", () => {
  const s = derivedAt(2.0).samples[1];
  assert.ok(s.terms.t1 > s.terms.t2, "binning must dominate quantization");
  assert.ok(s.terms.t1 > s.terms.t3, "binning must dominate the fp16 bake");
  // Halving the pixel radius doubles the binning term, because the bin is a
  // FIXED number of pixels and therefore a larger fraction of a smaller disc.
  const half = derivedAt(2.0, SolarDiscModel, MODEL_DISC_RADIUS_PX / 2);
  assert.ok(
    Math.abs(half.samples[1].terms.t1 / s.terms.t1 - 2) < 1e-6,
    "the binning term must scale as 1/R",
  );
  assert.equal(RADIANCE_DELTA_BIN_HALF_PX, 0.5);
});

// ===========================================================================
// 3. THE MEASUREMENT, OVER SYNTHETIC FRAMES
// ===========================================================================

/** An 8-bit RGBA frame whose neutral code is a function of normalized radius. */
function syntheticCodeFrame({ size, radius, codeAt }) {
  const data = new Uint8ClampedArray(size * size * 4);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      const code = codeAt(r / radius);
      const i = 4 * (y * size + x);
      data[i] = code;
      data[i + 1] = code;
      data[i + 2] = code;
      data[i + 3] = 255;
    }
  }
  return { data, width: size, height: size };
}

const SYN = { size: 128, radius: 40 };

test("the code measurement recovers a KNOWN constant difference exactly", () => {
  const flat = syntheticCodeFrame({ ...SYN, codeAt: () => 200 });
  const limb = syntheticCodeFrame({ ...SYN, codeAt: () => 160 });
  const m = measureDiscDifferentialCodes({
    flat,
    limb,
    cx: SYN.size / 2,
    cy: SYN.size / 2,
    discRadiusPx: SYN.radius,
  });
  for (const s of m.samples) {
    assert.ok(s.pixels > 0, `x=${s.x} sampled no pixels`);
    assert.ok(
      Math.abs(s.d1Codes - 40) < 1e-9,
      `x=${s.x}: expected 40 codes, measured ${s.d1Codes}`,
    );
  }
});

test("the code measurement recovers a RADIALLY VARYING difference", () => {
  // `limb` carries a difference that is a known function of x, so each sample
  // must return that function evaluated at its own radius rather than a
  // disc-wide average.
  const delta = (x) => Math.round(50 * x);
  const flat = syntheticCodeFrame({ ...SYN, codeAt: () => 200 });
  const limb = syntheticCodeFrame({ ...SYN, codeAt: (x) => 200 - delta(x) });
  const m = measureDiscDifferentialCodes({
    flat,
    limb,
    cx: SYN.size / 2,
    cy: SYN.size / 2,
    discRadiusPx: SYN.radius,
  });
  const byX = Object.fromEntries(m.samples.map((s) => [s.x, s.d1Codes]));
  // The centre sample is a 2 px DISC, not a point. This synthetic law is linear
  // in x and therefore already moves 3 codes across those 2 px of a 40 px
  // radius, so its centre mean is a few codes rather than zero — the shipped
  // law, which is stationary at the centre, moves ~1e-4 codes over the same
  // span. The assertion is on the property that matters: the centre reads a
  // small fraction of the limb.
  assert.ok(byX[0] < byX[0.95] / 10, `centre ${byX[0]} vs limb ${byX[0.95]}`);
  // One radial bin is +/-0.5 px of a 40 px radius, so the sampled x spans
  // +/-0.0125 and the rounded law moves by at most one code across it.
  assert.ok(Math.abs(byX[0.95] - delta(0.95)) <= 1.5, `x=0.95 ${byX[0.95]}`);
  assert.ok(Math.abs(byX[1] - delta(1)) <= 1.5, `x=1 ${byX[1]}`);
  assert.ok(byX[1] > byX[0.95], "the differential must grow toward the limb");
});

test("a FLAT rendered disc FAILS the shipped band — the headline defect", () => {
  // Both legs identical is exactly what a disc with no limb term renders. The
  // null control still passes (it is a claim about the centre); the law sample
  // must not.
  const frame = syntheticCodeFrame({ ...SYN, codeAt: () => 200 });
  const m = measureDiscDifferentialCodes({
    flat: frame,
    limb: frame,
    cx: SYN.size / 2,
    cy: SYN.size / 2,
    discRadiusPx: SYN.radius,
  });
  const d = derivedAt(2.0);
  const byX = Object.fromEntries(d.samples.map((s) => [s.x, s]));
  const measured = Object.fromEntries(m.samples.map((s) => [s.x, s.d1Codes]));
  assert.equal(measured[0.95], 0);
  assert.ok(
    measured[0.95] < byX[0.95].band.lo,
    "a flat disc must fall outside the derived band",
  );
  assert.ok(
    measured[0] >= byX[0].band.lo && measured[0] <= byX[0].band.hi,
    "the null control is a claim about the centre and still holds",
  );
});

test("peak channel is the MAX of the triple, and saturation is counted", () => {
  const data = new Uint8ClampedArray([10, 200, 30, 255, 251, 0, 0, 255]);
  const img = peakChannelCodeImage({ data, width: 2, height: 1 });
  assert.equal(img.data[0], 200, "max of (10,200,30)");
  assert.equal(img.data[4], 251, "max of (251,0,0)");
  assert.equal(
    img.saturated,
    1,
    `only the pixel at or above ${BRACKET_SATURATION_CODE}`,
  );
});

test("saturation on EITHER leg is reported — a clipped difference is not a difference", () => {
  const hot = syntheticCodeFrame({ ...SYN, codeAt: () => 255 });
  const cool = syntheticCodeFrame({ ...SYN, codeAt: () => 100 });
  const a = measureDiscDifferentialCodes({
    flat: hot,
    limb: cool,
    cx: 64,
    cy: 64,
    discRadiusPx: SYN.radius,
  });
  const b = measureDiscDifferentialCodes({
    flat: cool,
    limb: hot,
    cx: 64,
    cy: 64,
    discRadiusPx: SYN.radius,
  });
  assert.ok(a.saturatedPixels > 0);
  assert.equal(a.saturatedPixels, b.saturatedPixels, "the guard is the union");
});

// ===========================================================================
// 4. THE DISCRIMINATION
// ===========================================================================

/** Two legs generated by an explicit law, with a realistic plateau population. */
function worldLegs(generate, pixels = 21600) {
  return RADIANCE_DELTA_LEGS.map((leg) => {
    const resolvedRadiance = RESOLVED[leg.key];
    return {
      key: leg.key,
      resolvedRadiance,
      ...plateauResolution({
        plateau: generate(resolvedRadiance),
        plateauPixels: pixels,
        exposures: DISC_BRACKET_EXPOSURES,
      }),
    };
  });
}

test("a MULTIPLICATIVE world is named MULTIPLICATIVE", () => {
  for (const k of [1.1, 1.295, 1.36, 2.0]) {
    const r = discriminateRadianceExcess({ legs: worldLegs((L) => k * L) });
    assert.equal(r.verdict, EXCESS_SHAPE.MULTIPLICATIVE, `k=${k}`);
    // The signature is parameter-free: the measured ratio is the ratio of the
    // two RESOLVED radiances whatever k is.
    assert.ok(Math.abs(r.ratioMeasured - 2.0) < 1e-9, `k=${k}`);
    for (const v of Object.values(r.recovered)) {
      assert.ok(Math.abs(v - k) < 1e-9, "both legs recover the same gain");
    }
  }
});

test("an ADDITIVE world is named ADDITIVE", () => {
  for (const c of [0.3, 0.59, 0.9]) {
    const r = discriminateRadianceExcess({ legs: worldLegs((L) => L + c) });
    assert.equal(r.verdict, EXCESS_SHAPE.ADDITIVE, `c=${c}`);
    assert.ok(Math.abs(r.additiveConstant - c) < 1e-9);
    assert.ok(
      Math.abs(r.ratioMeasured - (2 + c) / (1 + c)) < 1e-9,
      "the additive world lands on the additive prediction",
    );
    assert.ok(r.recovered.sdrRadiance > r.recovered.trueRadiance);
  }
});

test("a world with NO excess is named as such rather than guessed at", () => {
  const r = discriminateRadianceExcess({ legs: worldLegs((L) => L) });
  assert.equal(r.verdict, EXCESS_SHAPE.NONE);
  assert.equal(r.separation, 0, "the two predictions coincide");
  assert.ok(r.usable);
});

test("a world matching NEITHER law is not forced into one", () => {
  // A plateau that is neither proportional nor offset — here a power law.
  const r = discriminateRadianceExcess({
    legs: worldLegs((L) => 1.3 * Math.pow(L, 1.6)),
  });
  assert.equal(r.verdict, EXCESS_SHAPE.NEITHER);
});

test("the recorded excess separates the two laws by far more than the instrument", () => {
  // This is the arithmetic that makes the run worth doing at all.
  const r = discriminateRadianceExcess({ legs: worldLegs((L) => 1.295 * L) });
  assert.ok(
    r.separation > 100 * r.sigmaRatio,
    `separation ${r.separation} against instrument ${r.sigmaRatio}`,
  );
  assert.ok(r.separation > 2 * r.tolerance, "the band cannot span both laws");
});

test("an unusable leg set yields NEITHER, never a confident verdict", () => {
  assert.equal(
    discriminateRadianceExcess({ legs: [] }).verdict,
    EXCESS_SHAPE.NEITHER,
  );
  assert.equal(discriminateRadianceExcess({}).usable, false);
  const oneLeg = discriminateRadianceExcess({
    legs: [{ key: "a", resolvedRadiance: 2, plateau: 2.6, plateauPixels: 10 }],
  });
  assert.equal(oneLeg.usable, false);
});

test("the display-code criteria CANNOT separate the two laws — and say so", () => {
  // The honesty receipt. Their band is set by the need to refuse a flat disc,
  // which is much coarser than the code-level gap between the two radiance
  // hypotheses; a reader must not take a green there as evidence either way.
  const power = d1DiscriminationPower(SolarDiscModel, {
    resolvedRadiance: 2.0,
    recoveredRadiance: 2.59,
    haloAmplitudePerRadiance: HALO_PER_RADIANCE,
    haloCoreRadii: CORE,
    discRadiusPx: MODEL_DISC_RADIUS_PX,
    exposure: RADIANCE_DELTA_EXPOSURE,
  });
  const at95 = power.samples.find((s) => s.x === 0.95);
  assert.ok(at95.separationCodes > 0, "the two hypotheses do differ in codes");
  assert.ok(
    at95.power < 1,
    `power ${at95.power} — if this ever exceeds 1 the code criteria BECOME a ` +
      "discriminator and the probe's report must stop disclaiming them",
  );
});

// ===========================================================================
// 5. EVALUATION AND FOLD
// ===========================================================================

function goodLeg(key, overrides = {}) {
  const L = RESOLVED[key];
  const derived = derivedAt(L);
  return {
    hdrEngaged: true,
    limbLegLitPixels: 90000,
    differentialPositivePixels: 90000,
    aimDistancePx: 1.2,
    plateauPixels: 21600,
    plateau: 1.295 * L,
    resolvedRadiance: L,
    derived,
    codes: {
      saturatedPixels: 0,
      // Measured exactly on the prediction, so a healthy payload is green.
      samples: derived.samples.map((s) => ({
        x: s.x,
        d1Codes: s.d1Codes,
        pixels: 1000,
      })),
    },
    ...overrides,
  };
}

function backendPayload(overrides = {}) {
  const legs = {
    sdrRadiance: goodLeg("sdrRadiance"),
    trueRadiance: goodLeg("trueRadiance"),
    ...(overrides.legs ?? {}),
  };
  // `legs` is assigned AFTER the spread on purpose: a partial `overrides.legs`
  // must patch the default pair, not replace it. Getting that backwards makes
  // every "one leg is broken" test silently exercise "one leg is missing".
  return {
    ...overrides,
    legs,
    excess: discriminateRadianceExcess({
      legs: RADIANCE_DELTA_LEGS.map((l) => ({
        key: l.key,
        resolvedRadiance: legs[l.key].resolvedRadiance,
        plateau: legs[l.key].plateau,
        plateauPixels: legs[l.key].plateauPixels,
        plateauQuantumLinear: plateauResolution({
          plateau: legs[l.key].plateau,
          plateauPixels: legs[l.key].plateauPixels,
          exposures: DISC_BRACKET_EXPOSURES,
        }).plateauQuantumLinear,
      })),
    }),
  };
}

test("a healthy payload certifies, and scores only the certifying samples", () => {
  const e = evaluateRadianceDeltaBackend(backendPayload());
  assert.deepEqual(e.structural, []);
  assert.equal(e.pass, true);
  assert.equal(e.criteria.limb_differential_has_signal, true);
  assert.equal(e.criteria.radiance_excess_shape_is_decided, true);
  // x=1 is measured and reported, never scored.
  assert.ok(!("d1_codes_trueRadiance_x1" in e.criteria));
  assert.ok("d1_codes_trueRadiance_x0p95" in e.criteria);
  assert.ok("d1_codes_trueRadiance_x0" in e.criteria);
  assert.equal(
    e.diagnostics.nonCertifyingSamples.length,
    RADIANCE_DELTA_LEGS.length,
  );
});

test("NON-VACUITY: two legs at the same radiance is STRUCTURAL, not agreement", () => {
  // The failure this guard exists for: the toggle silently stops taking, both
  // legs render identically, and every comparison becomes a measurement
  // compared with itself.
  const e = evaluateRadianceDeltaBackend(
    backendPayload({
      legs: { sdrRadiance: goodLeg("sdrRadiance", { resolvedRadiance: 2.0 }) },
    }),
  );
  assert.deepEqual(e.criteria, {});
  assert.equal(e.pass, false);
  assert.ok(
    e.structural.some((s) => /enableTrueSolarRadiance` did not take/.test(s)),
  );
  assert.ok(RADIANCE_DELTA_MIN_RESOLVED_SEPARATION <= 1.0);
});

test("an EMPTY differential is a named DEFECT, never 'could not see its subject'", () => {
  const e = evaluateRadianceDeltaBackend(
    backendPayload({
      legs: {
        trueRadiance: goodLeg("trueRadiance", {
          differentialPositivePixels: DISC_MIN_DIFFERENTIAL_PIXELS - 1,
        }),
      },
    }),
  );
  assert.equal(e.criteria.limb_differential_has_signal, false);
  assert.deepEqual(
    e.structural,
    [],
    "a lit frame with no differential is a defect",
  );
});

test("a dark frame, a missed aim and a saturated leg are all STRUCTURAL", () => {
  for (const [name, override] of [
    ["dark", { limbLegLitPixels: 10 }],
    ["aim", { aimDistancePx: 40 }],
    ["saturated", { codes: { saturatedPixels: 12, samples: [] } }],
  ]) {
    const e = evaluateRadianceDeltaBackend(
      backendPayload({
        legs: { trueRadiance: goodLeg("trueRadiance", override) },
      }),
    );
    assert.deepEqual(e.criteria, {}, `${name} must not certify`);
    assert.ok(e.structural.length > 0, `${name} must be structural`);
  }
});

test("the fold routes PASS/FAIL/STRUCTURAL to 0/1/3 and never collapses 3 into 2", () => {
  const ok = evaluateRadianceDeltaBackend(backendPayload());
  const pass = foldRadianceDeltaVerdict({ webgl: ok, webgpu: ok });
  assert.equal(pass.exitCode, EXIT_CODE.PASS);
  assert.deepEqual(pass.failures, []);

  const bad = {
    criteria: { ...ok.criteria, d1_codes_trueRadiance_x0p95: false },
    structural: [],
    diagnostics: ok.diagnostics,
  };
  const fail = foldRadianceDeltaVerdict({ webgl: ok, webgpu: bad });
  assert.equal(fail.exitCode, EXIT_CODE.FAIL);
  assert.ok(fail.failures.includes("webgpu:d1_codes_trueRadiance_x0p95"));

  const blind = {
    criteria: {},
    structural: ["the Sun is not in frame"],
    diagnostics: {},
  };
  const structural = foldRadianceDeltaVerdict({ webgl: ok, webgpu: blind });
  assert.equal(structural.exitCode, EXIT_CODE.STRUCTURAL);
  assert.notEqual(structural.exitCode, EXIT_CODE.ERROR);
});

test("a pass on ONE backend is a FAIL — every scalar here is CPU-resolved", () => {
  const ok = evaluateRadianceDeltaBackend(backendPayload());
  const other = evaluateRadianceDeltaBackend(
    backendPayload({
      legs: { trueRadiance: goodLeg("trueRadiance", { plateau: 4.0 }) },
    }),
  );
  const folded = foldRadianceDeltaVerdict({ webgl: ok, webgpu: other });
  assert.notEqual(folded.exitCode, EXIT_CODE.PASS);
});

test("the cross-backend arm is SCOPED — a blind backend cannot silently pass it", () => {
  const ok = evaluateRadianceDeltaBackend(backendPayload());
  const blind = {
    criteria: {},
    structural: ["blind"],
    diagnostics: { ratioMeasured: 2.0 },
  };
  const folded = foldRadianceDeltaVerdict({ webgl: ok, webgpu: blind });
  assert.ok(
    folded.structural.some((s) =>
      /cross-backend:recoveredRatio_parity/.test(s),
    ),
    "the parity arm must report itself structural rather than certify",
  );
  assert.ok(
    folded.structural.some((s) => /MEASURED ANYWAY/.test(s)),
    "the numbers must be printed even when the arm cannot certify",
  );
});

test("an empty criteria set with no structural note is NOT a pass", () => {
  const folded = foldRadianceDeltaVerdict({
    webgl: { criteria: {}, structural: [], diagnostics: {} },
    webgpu: { criteria: {}, structural: [], diagnostics: {} },
  });
  assert.equal(folded.exitCode, EXIT_CODE.STRUCTURAL);
});

// ===========================================================================
// 6. SOURCE ANCHORS — the probe runs the recipe this lane was corrected to
// ===========================================================================

test("NO scene flag is pinned to remove the halo — the correction that shaped this run", () => {
  // Turning the bloom or the screen halo off does not produce a halo-free disc;
  // it swaps in the baked halo, saturates the bake's alpha across the whole
  // disc and renders it FLAT, which erases the limb law from the capture. The
  // halo-free quantity is the DIFFERENTIAL. This tripwire is on the literal
  // pins somebody would actually add.
  assert.doesNotMatch(PROBE, /sunBloom\s*:/, "no capture may pin sunBloom");
  assert.doesNotMatch(
    PROBE,
    /sceneFlags\s*:/,
    "no capture may carry scene-level pins at all",
  );
  assert.doesNotMatch(
    PROBE,
    /enableScreenSpaceSunHalo:\s*false/,
    "the screen halo must stay at its shipped position on every leg",
  );
  const enabled = PROBE.match(/enableScreenSpaceSunHalo:\s*true/g) ?? [];
  assert.equal(enabled.length, 3, "one per disc toggle leg, pinned explicitly");
});

test("both radiance positions are driven, and every leg pins all four flags", () => {
  assert.match(PROBE, /enableTrueSolarRadiance: leg\.enableTrueSolarRadiance/);
  const legs = PROBE.match(
    /enableTrueSolarRadiance: leg\.enableTrueSolarRadiance/g,
  );
  assert.equal(
    legs.length,
    3,
    "all three disc toggle legs carry the radiance axis",
  );
  assert.deepEqual(
    RADIANCE_DELTA_LEGS.map((l) => l.enableTrueSolarRadiance),
    [false, true],
    "the shipped position is captured LAST",
  );
  for (const flag of [
    "enableSolarLimbDarkening",
    "enableTrueSolarDiscSize",
    "enableScreenSpaceSunHalo",
    "enableTrueSolarRadiance",
  ]) {
    assert.equal(
      (PROBE.match(new RegExp(`${flag}:`, "g")) ?? []).length,
      3,
      `${flag} must be pinned explicitly on every one of the three legs`,
    );
  }
});

test("the probe reuses the shared instrument rather than re-authoring it", () => {
  assert.match(PROBE, /from "\.\/lib\/celestial-capture-harness\.mjs"/);
  assert.match(PROBE, /from "\.\/lib\/celestial-g4-gate\.mjs"/);
  assert.match(PROBE, /from "\.\/lib\/sun-radiance-delta\.mjs"/);
  assert.match(PROBE, /measureDiscDifferential\(/);
  assert.match(PROBE, /const DISC_EXPOSURES = DISC_BRACKET_EXPOSURES;/);
  // No private re-derivation of the measurement math.
  assert.doesNotMatch(PROBE, /function\s+\w*[Rr]adialProfile/);
  assert.doesNotMatch(PROBE, /function\s+\w*[Aa]nnulusMean/);
});

test("the probe writes its own report and prints the pre-registration", () => {
  assert.match(PROBE, /"sun-hdr-radiance\.json"/);
  assert.match(
    PROBE,
    /PRE-REGISTERED HYPOTHESES \(settled by the plateau ratio\)/,
  );
  assert.match(PROBE, /MULTIPLICATIVE predicts/);
  assert.match(PROBE, /ADDITIVE predicts/);
  // The disclaimer on the code criteria must be PRINTED, not merely computed.
  assert.match(PROBE, /CANNOT tell the two apart/);
  assert.match(PROBE, /buildRadianceDeltaSummary/);
});

test("the differential is read on the leg that resolves it, and both legs are captured", () => {
  assert.equal(RADIANCE_DELTA_EXPOSURE, 0.125);
  assert.ok(
    DISC_BRACKET_EXPOSURES.includes(RADIANCE_DELTA_EXPOSURE),
    "the differential exposure must be one the capture actually took",
  );
  assert.deepEqual([...DISC_BRACKET_EXPOSURES], [1, 0.125]);
  assert.deepEqual([...RADIANCE_DELTA_SAMPLE_X], [0, 0.95, 1]);
});
