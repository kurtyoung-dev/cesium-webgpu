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
  PRE_REGISTERED_D1_CODES_NO_BLOOM,
  PRE_REGISTRATION_AGREEMENT_CODES,
  RADIANCE_DELTA_BIN_HALF_PX,
  RADIANCE_DELTA_EXPOSURE,
  RADIANCE_DELTA_LEGS,
  RADIANCE_DELTA_MIN_RESOLVED_SEPARATION,
  RADIANCE_DELTA_SAMPLE_X,
  ZERO_DITHER_QUANTUM_CODES,
  brightPassSourceRadiusPx,
  d1DiscriminationPower,
  deriveDiscDifferentialCodes,
  discBloomGlowField,
  discBloomPlateauDifferential,
  discBloomSourceEdgeUncertaintyPx,
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
// The drawing buffer the shipped run captures at, which is what sizes the sun
// bloom's blur buffer and therefore the glow's screen footprint.
const MODEL_VIEWPORT = { width: 1280, height: 720 };
// The sun bloom's geometry at that framing. `limbPx` is the disc's own edge in
// pixels, which for the true-size disc is the solar limb.
const BLOOM = Object.freeze({
  viewportWidth: MODEL_VIEWPORT.width,
  viewportHeight: MODEL_VIEWPORT.height,
  limbPx: MODEL_DISC_RADIUS_PX,
  centerX: MODEL_VIEWPORT.width / 2,
  centerY: MODEL_VIEWPORT.height / 2,
});
// The two shipped radiance positions.
const RESOLVED = { trueRadiance: 2.0, sdrRadiance: 1.0 };

const derivedAt = (
  L,
  model = SolarDiscModel,
  radiusPx = MODEL_DISC_RADIUS_PX,
  bloom = BLOOM,
) =>
  deriveDiscDifferentialCodes(model, {
    discRadiance: L,
    haloAmplitude: HALO_PER_RADIANCE * L,
    haloCoreRadii: CORE,
    discRadiusPx: radiusPx,
    exposure: RADIANCE_DELTA_EXPOSURE,
    bloom,
  });

/** The sun bloom's plateau contribution at one radiance, at the model framing. */
const glowAt = (L, model = SolarDiscModel) =>
  discBloomPlateauDifferential(model, { discRadiance: L, ...BLOOM });

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
  assert.ok(b.d1Codes !== a.d1Codes);
  assert.ok(b.tolCodes !== a.tolCodes);
  // WITHOUT the glow the composite's differential rises with the radiance, and
  // that is what the pre-bloom table recorded. WITH it the ordering at x=0.95
  // reverses, for a reason that is arithmetic rather than noise: the bright
  // pass's threshold is `start at display white`, so at radiance 2 the LIMB leg
  // still extracts out to x=0.974 while at radiance 1 it stops at x=0.847. The
  // high-radiance leg therefore keeps more of its own glow at the sample and
  // the differential closes. Both halves are asserted so a future reader can
  // see the inversion is modelled and not an accident.
  const aNoBloom = derivedAt(1.0, SolarDiscModel, MODEL_DISC_RADIUS_PX, null)
    .samples[1];
  const bNoBloom = derivedAt(2.0, SolarDiscModel, MODEL_DISC_RADIUS_PX, null)
    .samples[1];
  assert.ok(bNoBloom.d1Codes > aNoBloom.d1Codes);
  assert.ok(b.d1Codes < a.d1Codes);
  assert.ok(
    brightPassSourceRadiusPx(SolarDiscModel, {
      discRadiance: 2.0,
      limbDarkened: true,
      discEdgePx: MODEL_DISC_RADIUS_PX,
    }) >
      brightPassSourceRadiusPx(SolarDiscModel, {
        discRadiance: 1.0,
        limbDarkened: true,
        discEdgePx: MODEL_DISC_RADIUS_PX,
      }),
  );
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
  // The limb law is exactly 1 at the centre, so the only differential there is
  // the glow's — and the blur reaches a little further out than the centre
  // pixel, so it is small but not identically zero.
  assert.ok(Math.abs(s.d1Codes) < 0.5, `centre differential ${s.d1Codes}`);
  // The limb law is stationary at the disc centre, so the binning term is zero
  // to within the central difference's own rounding — it is not merely small.
  assert.ok(s.terms.t1 < 1e-6, `centre slope term ${s.terms.t1}`);
  assert.ok(s.terms.t1 < s.terms.t2 / 1000);
  assert.equal(s.tolCodes, s.terms.loBar);
  // The centre bin is FLAT on both legs, so neither dithers and the band is
  // three sigmas of nothing plus the full undithered code.
  assert.ok(
    Math.abs(s.terms.quantum - ZERO_DITHER_QUANTUM_CODES) < 1e-3,
    `centre quantum ${s.terms.quantum}`,
  );
  assert.equal(s.terms.dithers, false);
  assert.ok(
    Math.abs(s.tolCodes - (3 * s.terms.modelled + s.terms.quantum)) < 1e-12,
  );
  assert.ok(s.tolCodes > 1 && s.tolCodes < 2, `${s.tolCodes} codes`);
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

test("the undithered quantum is charged where averaging cannot work, and only there", () => {
  // The B979-era null control read `flat - limb = 1` EXACTLY on the shipped
  // radiance leg and `0` EXACTLY on the SDR one — both integers over twelve
  // identical pixels — against a band of 0.612 built on `N = 12`. Averaging
  // twelve copies of the same rounding averages nothing, so the honest budget
  // there is the full code.
  const centre = derivedAt(2.0).samples[0];
  assert.ok(centre.terms.codeSpread.flat < 1e-3);
  assert.ok(centre.terms.codeSpread.limb < 1e-3);
  assert.ok(centre.terms.quantum > 0.99);
  assert.ok(
    centre.tolCodes > 1,
    "a full code must fit inside the null control's band",
  );
  // ...and a leg that DOES sweep a full code is charged NOTHING, so the
  // allowance cannot be spent where the instrument can resolve. A disc a tenth
  // the size puts ten times the radial gradient inside one pixel bin, and the
  // limb leg — the one with a law under it — crosses the threshold while the
  // flat leg, which is only halo and glow out there, does not.
  const tiny = derivedAt(2.0, SolarDiscModel, MODEL_DISC_RADIUS_PX / 10, {
    ...BLOOM,
    limbPx: MODEL_DISC_RADIUS_PX / 10,
  }).samples[1];
  assert.ok(
    tiny.terms.codeSpread.limb > 1,
    `limb sweep ${tiny.terms.codeSpread.limb}`,
  );
  assert.ok(
    tiny.terms.codeSpread.flat < 1,
    `flat sweep ${tiny.terms.codeSpread.flat}`,
  );
  // The charge is exactly the per-leg formula, so the swept leg contributes
  // zero and the still one contributes the part of its half-code that no
  // averaging reaches.
  const charge = (spread) => 0.5 * Math.max(0, 1 - spread);
  for (const s of [centre, tiny]) {
    assert.ok(
      Math.abs(
        s.terms.quantum -
          (charge(s.terms.codeSpread.flat) + charge(s.terms.codeSpread.limb)),
      ) < 1e-12,
      `x=${s.x} quantum ${s.terms.quantum}`,
    );
  }
  assert.equal(charge(tiny.terms.codeSpread.limb), 0);
  assert.ok(tiny.terms.quantum < centre.terms.quantum);
  assert.equal(ZERO_DITHER_QUANTUM_CODES, 1.0);
});

// ===========================================================================
// 2b. THE SUN BLOOM — the term the first run was missing
// ===========================================================================

test("the glow's centre is the SHIPPED closed form, to a part in a thousand", () => {
  // `solarBloomCentreAmplitude` states what the bright-pass chain contributes at
  // the disc centre in one line of algebra. The field built here runs the whole
  // chain numerically — down-sample, bright pass, two blurs, up-sample — and at
  // the centre of a disc many blur widths across the two must agree. If they
  // ever stop, one of them has drifted from the shipped shader.
  for (const L of [1.0, 2.0]) {
    const field = discBloomGlowField(SolarDiscModel, {
      discRadiance: L,
      limbDarkened: false,
      discEdgePx: MODEL_DISC_RADIUS_PX,
      ...BLOOM,
    });
    const closedForm = SolarDiscModel.solarBloomCentreAmplitude(L);
    assert.ok(
      Math.abs(field.sampleAtRadiusPx(0) / closedForm - 1) < 1e-3,
      `L=${L}: field ${field.sampleAtRadiusPx(0)} vs closed form ${closedForm}`,
    );
    assert.equal(field.centreAmplitude, closedForm);
  }
});

test("the glow SATURATES — it is neither proportional to L nor constant in it", () => {
  // This is the whole reason a two-term model produced `NEITHER`. Between the
  // two shipped positions the disc doubles; the glow must grow, but by strictly
  // less than double, or the omission would have looked multiplicative and been
  // absorbed into the gain instead of showing up as an unnamed shape.
  const g1 = glowAt(1.0);
  const g2 = glowAt(2.0);
  assert.ok(g1 > 0 && g2 > 0);
  assert.ok(g2 > g1, "the glow must grow with the radiance");
  assert.ok(g2 < 2 * g1, "and by strictly less than the radiance does");
  // The FLAT and LEGACY legs both present the bright pass a uniform disc, so the
  // shape of their difference is purely geometric and the radiance enters only
  // through the closed-form amplitude. That makes the ratio an identity, and it
  // is a much sharper statement than an inequality.
  const ratio =
    SolarDiscModel.solarBloomCentreAmplitude(2.0) /
    SolarDiscModel.solarBloomCentreAmplitude(1.0);
  assert.ok(
    Math.abs(g2 / g1 - ratio) < 1e-3,
    `${g2 / g1} must be the amplitude ratio ${ratio}`,
  );
});

test("the glow does NOT cancel out of D1 — the legs present different sources", () => {
  // The premise the two-term model rested on. The screen halo cancels because
  // no halo uniform reads either disc toggle; the glow does not, because the
  // bright pass reads the SCENE and the limb-darkened leg falls below its
  // threshold partway out.
  for (const L of [1.0, 2.0]) {
    const support = {
      flat: brightPassSourceRadiusPx(SolarDiscModel, {
        discRadiance: L,
        limbDarkened: false,
        discEdgePx: MODEL_DISC_RADIUS_PX,
      }),
      limb: brightPassSourceRadiusPx(SolarDiscModel, {
        discRadiance: L,
        limbDarkened: true,
        discEdgePx: MODEL_DISC_RADIUS_PX,
      }),
    };
    assert.equal(support.flat, MODEL_DISC_RADIUS_PX);
    assert.ok(
      support.limb > 0 && support.limb < support.flat,
      `L=${L}: limb support ${support.limb} must sit inside the disc`,
    );
    // The crossing is a solve, not a search: the luminance there IS the
    // threshold the shipped tuning names.
    const avg = SolarDiscModel.SUN_BRIGHT_PASS_AVG_LUMINANCE;
    const scale = SolarDiscModel.sunBrightPassKey(avg) / avg;
    const needed =
      SolarDiscModel.solarBrightPassTuning(L, avg).threshold / scale;
    const atCrossing =
      L *
      SolarDiscModel.solarLimbIntensity(support.limb / MODEL_DISC_RADIUS_PX);
    assert.ok(
      Math.abs(atCrossing - needed) < 1e-9,
      `L=${L}: ${atCrossing} must be the threshold luminance ${needed}`,
    );
  }
  // And the consequence, in the quantity the lane scores: at the sample the
  // limb law is read on, the two legs' glows differ by codes, not by rounding.
  const s = derivedAt(1.0).samples[1];
  assert.ok(
    s.terms.glowFlat - s.terms.glowLimb > 0.1,
    `glow differential ${s.terms.glowFlat - s.terms.glowLimb} at x=0.95`,
  );
});

test("OMITTING the glow is a WRONG model, not a smaller one — and it says so", () => {
  // The fail-loud posture. A call with no bloom geometry must not quietly score
  // a two-term prediction, because that is exactly what produced the first
  // run's four red criteria.
  const d = derivedAt(2.0, SolarDiscModel, MODEL_DISC_RADIUS_PX, null);
  assert.equal(d.bloomModelled, false);
  for (const s of d.samples) {
    assert.equal(s.certifying, false, `x=${s.x} must not certify`);
    assert.match(s.nonCertifyingReason, /bright-pass chain/);
    assert.ok(Number.isNaN(s.tolCodes));
  }
  assert.equal(derivedAt(2.0).bloomModelled, true);
});

test("the recorded table SUPERSEDES a two-term one, and the gap is the glow", () => {
  // Both tables are carried. The superseded one is what the first two-radiance
  // run was scored against; the shipped one is the same arithmetic with the
  // glow. The difference must be large — it is what eight red criteria were
  // made of — and it must be LARGER on the low-radiance leg, because the glow's
  // share of a dimmer disc is bigger.
  const gapAt = (key) =>
    Math.abs(
      PRE_REGISTERED_D1_CODES[key][1] -
        PRE_REGISTERED_D1_CODES_NO_BLOOM[key][1],
    );
  assert.ok(gapAt("sdrRadiance") > 5, `${gapAt("sdrRadiance")} codes`);
  assert.ok(gapAt("trueRadiance") > 3, `${gapAt("trueRadiance")} codes`);
  assert.ok(gapAt("sdrRadiance") > gapAt("trueRadiance"));
  // The superseded table must NOT still describe the shipped chain, or nothing
  // would have changed and this whole term would be decoration.
  const d = derivedAt(1.0);
  assert.ok(
    Math.abs(
      d.samples[1].d1Codes - PRE_REGISTERED_D1_CODES_NO_BLOOM.sdrRadiance[1],
    ) > PRE_REGISTRATION_AGREEMENT_CODES,
  );
});

test("the source edge's bracket is derived from BOTH quantized edges", () => {
  const u = discBloomSourceEdgeUncertaintyPx(SolarDiscModel, BLOOM);
  // The bake is 512 texels across a quad 22 solar radii wide at glowFactor 1,
  // and the blur buffer is 128 texels across the drawing buffer's long axis.
  const bakeTexelPx = (2 * MODEL_DISC_RADIUS_PX * 11) / 512;
  const blurTexelPx =
    MODEL_VIEWPORT.width /
    SolarDiscModel.solarBloomBlurBufferSize(
      MODEL_VIEWPORT.width,
      MODEL_VIEWPORT.height,
    );
  assert.ok(
    Math.abs(u - Math.hypot(0.5 * bakeTexelPx, 0.5 * blurTexelPx)) < 1e-9,
  );
  // It must be a real bracket, not a rounding: moving the edge across it moves
  // the plateau's glow by a measurable amount.
  const nominal = glowAt(2.0);
  const shifted = discBloomPlateauDifferential(SolarDiscModel, {
    discRadiance: 2.0,
    ...BLOOM,
    discEdgeShiftPx: u,
  });
  assert.ok(Math.abs(shifted - nominal) > 1e-3, `${shifted} vs ${nominal}`);
  // And it must be SMALL against the thing it corrects, or the correction would
  // be worthless.
  assert.ok(Math.abs(shifted - nominal) < 0.1 * nominal);
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

test("a world that is disc + GLOW is named NO-EXCESS once the glow comes off", () => {
  // The generating law of the shipped picture, and the mutation that produced
  // the first run's verdict. With the glow subtracted the plateaus land on the
  // resolved radiances and there is nothing to name; WITHOUT it — the same
  // numbers, the correction dropped — the ratio matches neither hypothesis and
  // the verdict is NEITHER. One term, both verdicts.
  const legs = RADIANCE_DELTA_LEGS.map((leg) => {
    const L = RESOLVED[leg.key];
    const glowDifferential = glowAt(L);
    return {
      key: leg.key,
      resolvedRadiance: L,
      glowDifferential,
      ...plateauResolution({
        plateau: L + glowDifferential,
        plateauPixels: 21600,
        exposures: DISC_BRACKET_EXPOSURES,
      }),
    };
  });
  const corrected = discriminateRadianceExcess({ legs });
  assert.equal(corrected.verdict, EXCESS_SHAPE.NONE);
  assert.equal(corrected.glowModelled, true);
  assert.equal(corrected.recoveryAgrees, true);
  for (const leg of legs) {
    assert.ok(
      Math.abs(corrected.recovered[leg.key] - 1) < 1e-9,
      `${leg.key} recovered ${corrected.recovered[leg.key]}`,
    );
  }
  const uncorrected = discriminateRadianceExcess({
    legs: legs.map(({ glowDifferential, ...rest }) => rest),
  });
  assert.equal(uncorrected.verdict, EXCESS_SHAPE.NEITHER);
  assert.equal(uncorrected.glowModelled, false);
  assert.ok(uncorrected.ratioMeasured < uncorrected.ratioMultiplicative);
  assert.ok(uncorrected.ratioMeasured > uncorrected.ratioAdditive);
});

test("the absolute arm REFUSES a gain the ratio arm cannot see", () => {
  // A ratio is blind to a factor both legs share, which is precisely the shape
  // the row this lane exists for hypothesised. A 30% multiplicative gain on top
  // of the correct glow reads as MULTIPLICATIVE and must still be REFUSED.
  const legs = RADIANCE_DELTA_LEGS.map((leg) => {
    const L = RESOLVED[leg.key];
    const glowDifferential = glowAt(L);
    return {
      key: leg.key,
      resolvedRadiance: L,
      glowDifferential,
      glowDifferentialError: 0.02,
      ...plateauResolution({
        plateau: 1.3 * L + glowDifferential,
        plateauPixels: 21600,
        exposures: DISC_BRACKET_EXPOSURES,
      }),
    };
  });
  const r = discriminateRadianceExcess({ legs });
  assert.equal(r.verdict, EXCESS_SHAPE.MULTIPLICATIVE);
  assert.equal(r.recoveryAgrees, false, "a 30% gain must not be absorbed");
  const e = evaluateRadianceDeltaBackend({
    legs: {
      sdrRadiance: goodLeg("sdrRadiance"),
      trueRadiance: goodLeg("trueRadiance"),
    },
    excess: r,
  });
  assert.equal(e.criteria.disc_radiance_recovers_resolved, false);
  // ...and the healthy world passes the same criterion, so it is not simply
  // impossible to satisfy.
  assert.equal(
    evaluateRadianceDeltaBackend(backendPayload()).criteria
      .disc_radiance_recovers_resolved,
    true,
  );
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
    bloom: BLOOM,
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
  // A HEALTHY world is the disc at exactly the radiance the frame resolved,
  // PLUS the glow the bright-pass chain adds over the plateau annulus. Writing
  // `1.295 * L` here — which is what the plateau reads before the correction —
  // would build a payload that only looks healthy to a model missing the same
  // term the measurement was missing.
  const glowDifferential = glowAt(L);
  return {
    hdrEngaged: true,
    limbLegLitPixels: 90000,
    differentialPositivePixels: 90000,
    aimDistancePx: 1.2,
    plateauPixels: 21600,
    plateau: L + glowDifferential,
    glowDifferential,
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
        glowDifferential: legs[l.key].glowDifferential,
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
