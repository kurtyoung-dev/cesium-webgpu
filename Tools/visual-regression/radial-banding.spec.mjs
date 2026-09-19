// radial-banding.spec.mjs — C13-N60's instrument. Pure Node: no browser, no GPU.
//
// @purpose Drives lib/metrics/radial-banding.mjs over synthetic fields whose answer is known by construction and over the checked-in reduction of a banked orbital capture, asserting returned numbers rather than the shape of the code that produced them.
// @status ACTIVE
//
// WHAT IS BEING CERTIFIED. Every case below states an OUTPUT: a number the
// metric returns for an input built here, or a number it returns for the
// banked capture's own reduction. No case reads the metric's source text, and
// no case asserts that a clause is present.
//
// WHY A GOLDEN PROFILE AND NOT A PNG. The capture this metric was built for is
// a two-megabyte frame in the gitignored visual-regression output tree; a spec
// that required it would be green on the machine that captured it and skipped
// everywhere else. `fixtures/radial-banding-nowx.golden.json` carries that
// capture's radial reduction — the real pixels, summed — so the statistics run
// on banked data in a shallow clone with no capture present. The pixel pass
// that produced it is covered by the synthetic cases, which build their fields
// in memory.
//
// COHERENCE ALONE IS NOT AN ACCEPTANCE, AND CASE 5 IS WHY. An all-black field
// scores exactly 0 — the same answer a ring-free render gives. The conjunction
// cases at the end are the shape a row's acceptance has to take.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_LIT_THRESHOLD,
  PROVISIONAL_BANDS,
  cosIncidenceAt,
  discGeometry,
  eyeAxisDepthMetres,
  luminanceField,
  radialBanding,
  radialBandingConjunction,
  radialBandingFromProfile,
  radialProfile,
} from "./lib/metrics/radial-banding.mjs";
import { syntheticFractionalBrownianField } from "./lib/metrics/spectral-slope.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const GOLDEN = JSON.parse(
  readFileSync(
    path.join(HERE, "fixtures", "radial-banding-nowx.golden.json"),
    "utf8",
  ),
);

/**
 * The banked capture's camera, scaled so a synthetic control can be built at a
 * size a hand-rolled DFT can transform.
 *
 * Scaling `focalPixels`, the centre and the disc radius by the same factor
 * leaves `atan(r / focalPixels)` — and therefore every geometric quantity this
 * metric computes — unchanged at the same fraction of the disc. The control's
 * geometry is the capture's geometry; only the sampling is coarser.
 */
const SCALE = 8;
const FRAME = GOLDEN.source.frame.width / SCALE;
const CONTROL_CAMERA = Object.freeze({
  centreX: FRAME / 2,
  centreY: FRAME / 2,
  discRadiusPixels: GOLDEN.camera.discRadiusPixels / SCALE,
  focalPixels: GOLDEN.camera.focalPixels / SCALE,
  altitudeMetres: GOLDEN.camera.altitudeMetres,
  planetRadiusMetres: GOLDEN.camera.planetRadiusMetres,
  deck: GOLDEN.camera.deck,
});

/** Build a square scalar field from a per-pixel function of (x, y). */
function buildField(width, valueAt) {
  const data = new Float64Array(width * width);
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width; x++) {
      data[y * width + x] = valueAt(x, y);
    }
  }
  return { width, height: width, data };
}

/** Radius from the control camera's centre. */
function radiusAt(x, y, camera = CONTROL_CAMERA) {
  return Math.hypot(x + 0.5 - camera.centreX, y + 0.5 - camera.centreY);
}

/** A field that is `sin(2*pi*k*cos i)` inside the disc and 0 outside it. */
function ringField(cycles, width = FRAME, camera = CONTROL_CAMERA) {
  return buildField(width, (x, y) => {
    const radius = radiusAt(x, y, camera);
    if (radius > camera.discRadiusPixels) {
      return 0;
    }
    const cosI = cosIncidenceAt(radius, camera);
    return cosI === null
      ? 0
      : 0.5 + 0.5 * Math.sin(2 * Math.PI * cycles * cosI);
  });
}

// The fBm generator is a hand-rolled O(N^3) separable DFT, so the control
// fields are built once and shared: four cases want the same seed and the
// runner should not pay for it four times.
const FBM_CACHE = new Map();

/** A seeded fBm field normalized into [0, 1]: the deterministic ring-free control. */
function fbmField(seed, width = FRAME) {
  const key = `${seed}:${width}`;
  if (FBM_CACHE.has(key)) {
    return FBM_CACHE.get(key);
  }
  const raw = syntheticFractionalBrownianField({
    width,
    height: width,
    slope: -5 / 3,
    seed,
  });
  let low = Infinity;
  let high = -Infinity;
  for (const value of raw) {
    low = Math.min(low, value);
    high = Math.max(high, value);
  }
  const data = new Float64Array(raw.length);
  for (let index = 0; index < raw.length; index++) {
    data[index] = (raw[index] - low) / (high - low);
  }
  const field = { width, height: width, data };
  FBM_CACHE.set(key, field);
  return field;
}

// ===========================================================================
// 1-2, 5-6. The fields whose answer is known by construction
// ===========================================================================

test("1. a field periodic in cos(incidence) scores above the RED band and its frequency is recovered", () => {
  for (const cycles of [8, 12, 20]) {
    const result = radialBanding(ringField(cycles), CONTROL_CAMERA);
    assert.ok(
      result.coherence > PROVISIONAL_BANDS.red,
      `k=${cycles}: coherence ${result.coherence} should clear the RED band ${PROVISIONAL_BANDS.red}`,
    );
    const error = Math.abs(result.dominantCyclesPerUnitCos - cycles) / cycles;
    assert.ok(
      error < 0.02,
      `k=${cycles}: recovered ${result.dominantCyclesPerUnitCos} cycles/unit-cos, ${(error * 100).toFixed(2)} % off`,
    );
  }
});

test("2. a seeded fBm field with no radial structure scores below the GREEN band at three seeds", () => {
  const scores = [];
  for (const seed of [1, 2, 3]) {
    const result = radialBanding(fbmField(seed), CONTROL_CAMERA);
    scores.push(result.coherence);
    assert.ok(
      result.coherence < PROVISIONAL_BANDS.green,
      `seed ${seed}: coherence ${result.coherence} should sit below the GREEN band ${PROVISIONAL_BANDS.green}`,
    );
  }
  // And it is not merely small: the banked ringed capture is an order of
  // magnitude above every seed, which is the separation the band claims.
  for (const score of scores) {
    assert.ok(
      GOLDEN.expected.coherence / score > 10,
      `the banked capture scores ${GOLDEN.expected.coherence} against a control of ${score}`,
    );
  }
});

test("5. an all-black field returns coherence exactly 0 and divides by nothing", () => {
  const result = radialBanding(
    buildField(FRAME, () => 0),
    CONTROL_CAMERA,
  );
  assert.equal(result.coherence, 0);
  assert.equal(result.dutyFull, 0);
  assert.equal(result.darkFraction, 1);
  assert.equal(result.bandCount, 0);
  assert.equal(result.lnZSpacingMean, null);
  assert.equal(result.qFromDuty, null);
  for (const value of Object.values(result.dutyByAnnulus)) {
    assert.ok(Number.isFinite(value), "an annulus duty came back non-finite");
  }
  // THE REASON THIS CASE EXISTS: a blank render scores a perfect GREEN.
  assert.ok(
    result.coherence < PROVISIONAL_BANDS.green,
    "a frame with nothing in it scores in the GREEN band, which is why coherence alone can never be an acceptance",
  );
});

test("6. a smooth radial ramp scores below GREEN — the detrend is what makes that true", () => {
  const ramp = buildField(FRAME, (x, y) => {
    const radius = radiusAt(x, y);
    return radius > CONTROL_CAMERA.discRadiusPixels
      ? 0
      : 1 - radius / CONTROL_CAMERA.discRadiusPixels;
  });
  const result = radialBanding(ramp, CONTROL_CAMERA);
  assert.ok(
    result.coherence < PROVISIONAL_BANDS.green,
    `a limb-darkening ramp scored ${result.coherence}, above the GREEN band`,
  );
});

// ===========================================================================
// 7. Refusals
// ===========================================================================

test("7. an incomplete or out-of-frame geometry throws rather than measuring a partial annulus", () => {
  const field = buildField(FRAME, () => 0.5);
  const { focalPixels, ...noFocal } = CONTROL_CAMERA;
  assert.ok(focalPixels > 0);
  assert.throws(
    () => radialBanding(field, noFocal),
    /camera\.focalPixels/,
    "a camera with no focal length must not be measured",
  );
  assert.throws(
    () => radialBanding(field, { ...CONTROL_CAMERA, deck: { bottom: 1500 } }),
    /camera\.deck\.top/,
  );
  assert.throws(
    () => radialBanding(field, { ...CONTROL_CAMERA, discRadiusPixels: 0 }),
    /discRadiusPixels must be positive/,
  );
  // The measured case: the banked 300 km rung records discRadiusPixels
  // 5715.894 against a 2048 px frame and `limbInFrame: false`. Its disc is
  // three times the frame, so every annulus it could report is an average over
  // whichever corners survived the crop.
  assert.throws(
    () =>
      radialBanding(
        { width: 2048, height: 2048, data: new Float64Array(2048 * 2048) },
        {
          ...GOLDEN.camera,
          centreX: 1024,
          centreY: 1024,
          altitudeMetres: 300000,
          discRadiusPixels: 5715.894079106477,
        },
      ),
    /leaves the 2048x2048 frame/,
  );
  // A camera inside the deck has no disc to measure from outside it.
  assert.throws(
    () => radialBanding(field, { ...CONTROL_CAMERA, altitudeMetres: 2000 }),
    /is not above deck top/,
  );
  assert.throws(
    () =>
      radialBanding(
        { width: 4, height: 4, data: new Float64Array(3) },
        CONTROL_CAMERA,
      ),
    /field\.data must hold/,
  );
});

// ===========================================================================
// 8-9. What the statistic is actually a statistic OF
// ===========================================================================

test("8. rotating the field about the disc centre leaves the statistics where they were", () => {
  // TWO LEGS, AND WHY NEITHER OF THEM RESAMPLES. A 37-degree rotation of a
  // raster has to interpolate, and interpolating a field whose radial
  // structure is a few pixels wide costs 5-25 % of the coherence on its own
  // — a resampled rotation measures the resampler, not the metric.
  //
  // Leg A rotates by 90 degrees as an exact index permutation: every pixel
  // lands on another pixel's centre, nothing is interpolated, and a metric
  // that keyed on anything but distance-from-the-centre would move.
  const source = ringField(12);
  const rotatedQuarter = buildField(FRAME, (x, y) => {
    // (x, y) <- (y, FRAME - 1 - x); exact for a centre at FRAME/2.
    return source.data[(FRAME - 1 - x) * FRAME + y];
  });
  const before = radialBanding(source, CONTROL_CAMERA);
  const quarter = radialBanding(rotatedQuarter, CONTROL_CAMERA);
  assert.ok(
    Math.abs(quarter.coherence - before.coherence) / before.coherence < 1e-12,
    `an exact quarter turn moved coherence ${before.coherence} -> ${quarter.coherence}`,
  );
  assert.deepEqual(quarter.onsetsPx, before.onsetsPx);
  assert.equal(quarter.dutyFull, before.dutyFull);

  // Leg B rotates the field's own angular term by 37 degrees in its
  // construction, so the rotated field is synthesised exactly rather than
  // interpolated. An angular term of order one is used deliberately: a
  // higher-order one is invariant under many rotations by symmetry and would
  // make the case easier than it should be.
  const angular = (phase) =>
    buildField(FRAME, (x, y) => {
      const dx = x + 0.5 - CONTROL_CAMERA.centreX;
      const dy = y + 0.5 - CONTROL_CAMERA.centreY;
      const radius = Math.hypot(dx, dy);
      if (radius > CONTROL_CAMERA.discRadiusPixels) {
        return 0;
      }
      const cosI = cosIncidenceAt(radius, CONTROL_CAMERA);
      if (cosI === null) {
        return 0;
      }
      return (
        (0.5 + 0.5 * Math.sin(2 * Math.PI * 12 * cosI)) *
        (0.6 + 0.4 * Math.sin(Math.atan2(dy, dx) - phase))
      );
    });
  const upright = radialBanding(angular(0), CONTROL_CAMERA).coherence;
  const turned = radialBanding(
    angular((37 * Math.PI) / 180),
    CONTROL_CAMERA,
  ).coherence;
  const change = Math.abs(turned - upright) / upright;
  assert.ok(
    change < 0.02,
    `a 37 deg rotation moved coherence ${upright} -> ${turned} (${(change * 100).toFixed(3)} %)`,
  );
});

test("9. displacing the assumed centre by 20 px drops coherence by more than 30 % — it measures concentricity", () => {
  // The real-pixel leg: the banked capture's own reduction, taken twice from
  // the same image with the assumed centre 20 px apart. Nothing about the
  // picture changes; only the geometry the statistics are computed against.
  const centred = radialBandingFromProfile(GOLDEN.profile, GOLDEN.camera);
  assert.equal(centred.coherence, GOLDEN.expected.coherence);
  const displaced = radialBandingFromProfile(
    GOLDEN.displacedProfile,
    GOLDEN.displacedCamera,
  );
  assert.equal(GOLDEN.expectedDisplaced.centreOffsetPixels, 20);
  assert.equal(
    GOLDEN.displacedCamera.centreX - GOLDEN.camera.centreX,
    20,
    "the displaced camera in the fixture is not 20 px from the real one",
  );
  assert.equal(displaced.coherence, GOLDEN.expectedDisplaced.coherence);
  const drop = (centred.coherence - displaced.coherence) / centred.coherence;
  assert.ok(
    drop > 0.3,
    `a 20 px displacement moved coherence ${centred.coherence} -> ${displaced.coherence} (drop ${(drop * 100).toFixed(1)} %)`,
  );
  // The ladder goes with it: most of the onsets stop being resolvable at all.
  assert.ok(
    displaced.bandCount < centred.bandCount / 2,
    `the band count fell only ${centred.bandCount} -> ${displaced.bandCount}`,
  );
});

// ===========================================================================
// 3, 10-12. The banked orbital capture
// ===========================================================================

test("3. the banked orbital capture reproduces its pinned statistics and scores RED", () => {
  const result = radialBandingFromProfile(GOLDEN.profile, GOLDEN.camera);
  for (const key of [
    "coherence",
    "bandCount",
    "bandCountThreshold",
    "lnZSpacingMean",
    "lnZSpacingCv",
    "cosISpacingMean",
    "cosISpacingCv",
    "dominantCyclesPerUnitCos",
    "dutyFull",
    "dutyInner",
    "darkFraction",
    "innerAnnulusDuty",
    "innerAnnulusPeak",
    "meanRenderWindowLnZ",
    "qFromSpacing",
    "qFromDuty",
    "qFromDutyNadirAny",
    "qFromDutyNadirFullDeck",
    "qAgreementRatio",
  ]) {
    assert.equal(result[key], GOLDEN.expected[key], `${key} moved`);
  }
  assert.deepEqual(result.onsetsPx, GOLDEN.expected.onsetsPx);
  assert.deepEqual(result.dutyByAnnulus, GOLDEN.expected.dutyByAnnulus);
  assert.deepEqual(result.presence, GOLDEN.expected.presence);
  assert.ok(
    result.coherence > PROVISIONAL_BANDS.red,
    `the banked ringed capture scored ${result.coherence}, inside the RED band`,
  );
});

test("10. the banked capture's onset ladder is regular in ln(depth) and irregular in cos(incidence)", () => {
  const result = radialBandingFromProfile(GOLDEN.profile, GOLDEN.camera);
  assert.ok(
    result.lnZSpacingCv < 0.05,
    `lnZSpacingCv ${result.lnZSpacingCv} should be under 5 %`,
  );
  assert.ok(
    result.cosISpacingCv > 0.1,
    `cosISpacingCv ${result.cosISpacingCv} should exceed 10 %`,
  );
  // The pair is the discriminator, not either number: the family is periodic
  // in one coordinate and not in the other, by better than a factor of ten.
  assert.ok(
    result.cosISpacingCv / result.lnZSpacingCv > 10,
    `the two coefficients of variation are only ${(result.cosISpacingCv / result.lnZSpacingCv).toFixed(1)}x apart`,
  );
});

test("11. the banked capture's duty cycle: a mostly-dark disc whose innermost annulus renders nothing", () => {
  const result = radialBandingFromProfile(GOLDEN.profile, GOLDEN.camera);
  assert.ok(
    result.dutyInner >= 0.02 && result.dutyInner <= 0.1,
    `dutyInner ${result.dutyInner} should land in [0.02, 0.10]`,
  );
  assert.equal(
    result.innerAnnulusDuty,
    0,
    "the r/R < 0.1 annulus is not empty",
  );
  assert.equal(result.innerAnnulusPeak, 0, "the r/R < 0.1 annulus has a peak");
  assert.ok(
    Math.abs(result.darkFraction - 0.88) <= 0.02,
    `darkFraction ${result.darkFraction} should be 0.88 +/- 0.02`,
  );
  // The disc-wide duty is nowhere near the ~50 % a round-to-nearest recovery
  // would leave: the shortfall is one-sided, which is what makes a full,
  // one-sided tolerance the right shape for a fix.
  assert.ok(
    result.dutyFull < 0.2,
    `dutyFull ${result.dutyFull} is too high for a one-sided shortfall`,
  );
});

test("12. the onset ladder and the duty cycle give the same constant to within 20 %", () => {
  const result = radialBandingFromProfile(GOLDEN.profile, GOLDEN.camera);
  // Two features of one image, reduced two different ways. Agreement is
  // evidence about the mechanism; it is not exact and this pins how inexact.
  assert.ok(
    result.qAgreementRatio > 0.8 && result.qAgreementRatio < 1.25,
    `qFromDuty/qFromSpacing is ${result.qAgreementRatio}`,
  );
  // And the nadir window — the number a reader reaches for first — is NOT the
  // right divisor for a disc-wide duty: it is short by more than a factor of
  // two against the area-weighted window, and by five in its full-deck form.
  assert.ok(
    result.qFromSpacing / result.qFromDutyNadirAny > 1.8,
    `the nadir 'anything survives' window is only ${(result.qFromSpacing / result.qFromDutyNadirAny).toFixed(2)}x off`,
  );
  assert.ok(
    result.qFromSpacing / result.qFromDutyNadirFullDeck > 4,
    `the nadir full-deck window is only ${(result.qFromSpacing / result.qFromDutyNadirFullDeck).toFixed(2)}x off`,
  );
});

// ===========================================================================
// The geometry helpers, against distances anyone can check by subtraction
// ===========================================================================

test("G. the nadir ray's depths are the altitude minus the shell heights, and cos i runs 1 to 0", () => {
  const camera = GOLDEN.camera;
  const geometry = discGeometry(camera);
  const height = camera.altitudeMetres;
  assert.ok(
    Math.abs(
      eyeAxisDepthMetres(0, camera, geometry.outerShellRadiusMetres) -
        (height - camera.deck.top),
    ) < 1e-6,
  );
  assert.ok(
    Math.abs(
      eyeAxisDepthMetres(0, camera, geometry.innerShellRadiusMetres) -
        (height - camera.deck.bottom),
    ) < 1e-6,
  );
  assert.ok(
    Math.abs(
      eyeAxisDepthMetres(0, camera, geometry.planetRadiusMetres) - height,
    ) < 1e-6,
  );
  assert.equal(cosIncidenceAt(0, camera), 1);
  // Monotone inward-to-outward, and past the grazing ray there is no entry.
  assert.ok(cosIncidenceAt(500, camera) > cosIncidenceAt(900, camera));
  assert.equal(cosIncidenceAt(1e9, camera), null);
  // The two nadir windows are what the duty estimates divide by.
  assert.ok(Math.abs(geometry.lnWindowNadirAny - 6.0547e-4) < 1e-8);
  assert.ok(Math.abs(geometry.lnWindowNadirFullDeck - 2.2701e-4) < 1e-8);
});

test("R. the pixel pass and the statistics pass compose into radialBanding", () => {
  const field = ringField(12);
  const composed = radialBanding(field, CONTROL_CAMERA);
  const split = radialBandingFromProfile(
    radialProfile(field, CONTROL_CAMERA),
    CONTROL_CAMERA,
  );
  assert.equal(composed.coherence, split.coherence);
  assert.deepEqual(composed.onsetsPx, split.onsetsPx);
});

test("L. luminanceField reads an RGBA buffer at the documented scale", () => {
  const image = {
    width: 2,
    height: 1,
    channels: 4,
    data: new Uint8Array([255, 255, 255, 255, 0, 0, 0, 255]),
  };
  const field = luminanceField(image);
  assert.ok(Math.abs(field.data[0] - 1) < 1e-9);
  assert.equal(field.data[1], 0);
  assert.ok(DEFAULT_LIT_THRESHOLD > 0 && DEFAULT_LIT_THRESHOLD < 0.02);
});

// ===========================================================================
// The conjunction: what a single statistic cannot say
// ===========================================================================

test("C. the conjunction refuses a blank frame that the banding clause alone accepts", () => {
  const blank = radialBanding(
    buildField(FRAME, () => 0),
    CONTROL_CAMERA,
  );
  const control = radialBanding(fbmField(1), CONTROL_CAMERA);
  const baseline = radialBandingFromProfile(GOLDEN.profile, GOLDEN.camera);

  const verdict = radialBandingConjunction({
    measure: blank,
    control,
    baseline,
    spectralSlope: -5 / 3,
    realisedPrimarySamples: 10,
    baselinePrimarySamples: 1,
  });
  const clause = (id) => verdict.clauses.find((entry) => entry.id === id);
  assert.equal(
    clause("banding-down").satisfied,
    true,
    "a frame with nothing in it does pass the banding clause — that is the point",
  );
  assert.equal(
    clause("presence-up").satisfied,
    false,
    "a blank frame must fail the presence clause",
  );
  assert.equal(
    clause("inner-annulus-renders").satisfied,
    false,
    "a blank frame's innermost annulus renders nothing",
  );
  assert.equal(verdict.satisfied, false);
  assert.equal(verdict.provisional, true);
});

test("C2. an unmeasured clause leaves the conjunction null, never false", () => {
  const control = radialBanding(fbmField(1), CONTROL_CAMERA);
  const measure = radialBandingFromProfile(GOLDEN.profile, GOLDEN.camera);
  const verdict = radialBandingConjunction({ measure, control });
  assert.equal(verdict.satisfied, null);
  for (const id of ["presence-up", "slope-in-band", "samples-up"]) {
    assert.equal(
      verdict.clauses.find((entry) => entry.id === id).satisfied,
      null,
      `${id} was decided without an input`,
    );
  }
  assert.throws(() => radialBandingConjunction({ measure }), /control/);
});

// ===========================================================================
// Inertness mutant
// ===========================================================================

/**
 * Import a copy of the metric with one construct made unreachable.
 *
 * The copy is an inline `data:` module, so there is no chance of the spec
 * importing the unmutated file by mistake: the source string is mutated first,
 * the mutation is asserted to have applied, and the module object that comes
 * back was compiled from that string. Its two relative sibling imports have no
 * base to resolve against in a `data:` URL, so they are rewritten to the
 * absolute URLs this spec resolves them to — that rewrite is what makes the
 * mutant loadable and is not part of the mutation.
 *
 * @param {(source: string) => string} mutate The mutation.
 * @returns {Promise<object>} The mutated module.
 */
async function importMutatedMetric(mutate) {
  let source = readFileSync(
    path.join(HERE, "lib", "metrics", "radial-banding.mjs"),
    "utf8",
  ).replaceAll("\r\n", "\n");
  for (const sibling of ["./luminance.mjs", "./masks.mjs"]) {
    const specifier = `from "${sibling}";`;
    assert.equal(source.split(specifier).length - 1, 1, `${sibling} import`);
    source = source.replace(
      specifier,
      `from ${JSON.stringify(new URL(`./lib/metrics/${sibling.slice(2)}`, import.meta.url).href)};`,
    );
  }
  const mutated = mutate(source);
  assert.notEqual(mutated, source, "the mutation did not apply");
  return import(
    `data:text/javascript;base64,${Buffer.from(mutated).toString("base64")}`
  );
}

test("M. MUTATION control: an unreachable detrend makes a smooth ramp score RED", async () => {
  const guard = "  if (detrendBins > 1) {";
  const mutant = await importMutatedMetric((source) => {
    assert.equal(source.split(guard).length - 1, 1);
    return source.replace(guard, "  if (false && detrendBins > 1) {");
  });
  // The harness really loaded the mutant: its exported band constants are
  // present, and the module object is not the one this file imported.
  assert.notEqual(mutant.radialBanding, radialBanding);
  assert.deepEqual(mutant.PROVISIONAL_BANDS, PROVISIONAL_BANDS);

  const ramp = buildField(FRAME, (x, y) => {
    const radius = radiusAt(x, y);
    return radius > CONTROL_CAMERA.discRadiusPixels
      ? 0
      : 1 - radius / CONTROL_CAMERA.discRadiusPixels;
  });
  const real = radialBanding(ramp, CONTROL_CAMERA).coherence;
  const inert = mutant.radialBanding(ramp, CONTROL_CAMERA).coherence;
  assert.ok(
    real < PROVISIONAL_BANDS.green,
    `the real metric scored the ramp ${real}, which case 6 requires to be GREEN`,
  );
  assert.ok(
    inert > PROVISIONAL_BANDS.red,
    `the inert metric scored the ramp ${inert}, which case 6 would still have passed`,
  );
  // The banked ringed capture keeps scoring RED either way, which is why the
  // ramp is the case that carries the mutant: a ring-only assertion survives
  // the mutation and certifies nothing about the detrend.
  assert.ok(
    mutant.radialBandingFromProfile(GOLDEN.profile, GOLDEN.camera).coherence >
      PROVISIONAL_BANDS.red,
  );
});

// ===========================================================================
// 2b, 13-15. The three inputs that fooled the instrument's first draft
//
// EVERY CASE HERE IS BUILT FROM AN ADVERSARIAL FIELD OR CAMERA that a reviewer
// produced against the frozen v1 and that no case then covered. They are not
// re-statements of the fix: each one scores an IMAGE (or refuses a camera) and
// asserts the number that comes back.
// ===========================================================================

test("2b. the GREEN band is a CHOICE, and this is the only floor it was chosen against", () => {
  // `PROVISIONAL_BANDS.controlSpread` is a recorded measurement, so it is
  // re-derived here rather than trusted: six seeds of the ring-free control at
  // the acceptance geometry, which is the only non-vacuous floor that exists
  // (the repeat-frame floor is exactly 0 — consecutive frames of a still cloud
  // scene in this renderer are byte-identical).
  const scores = [1, 2, 3, 4, 5, 6].map(
    (seed) => radialBanding(fbmField(seed), CONTROL_CAMERA).coherence,
  );
  const low = Math.min(...scores);
  const high = Math.max(...scores);
  assert.ok(
    Math.abs(low - PROVISIONAL_BANDS.controlSpread.low) < 1e-9,
    `the control's floor moved: ${low} against the recorded ${PROVISIONAL_BANDS.controlSpread.low}`,
  );
  assert.ok(
    Math.abs(high - PROVISIONAL_BANDS.controlSpread.high) < 1e-9,
    `the control's ceiling moved: ${high} against the recorded ${PROVISIONAL_BANDS.controlSpread.high}`,
  );
  assert.equal(PROVISIONAL_BANDS.controlSpread.seeds, scores.length);

  // The bands sit OUTSIDE the clean spread — which is what makes them
  // defensible — and by a multiple small enough that nobody should call them a
  // measured floor. Both halves of that sentence are asserted.
  assert.ok(PROVISIONAL_BANDS.green > high, "GREEN is inside the clean spread");
  assert.ok(PROVISIONAL_BANDS.red > PROVISIONAL_BANDS.green);
  assert.ok(
    PROVISIONAL_BANDS.green / high > 2 && PROVISIONAL_BANDS.green / high < 4,
    `GREEN is ${(PROVISIONAL_BANDS.green / high).toFixed(2)}x the worst clean seed`,
  );
  // And the basis says so in words, so a reader of the constant alone is not
  // misled into gating on it.
  assert.match(PROVISIONAL_BANDS.basis, /do not gate/);
});

/**
 * A clean, ring-free, hard-edged elliptical disc — the silhouette of an oblate
 * planet that is actually DRAWN.
 *
 * `semiMinorScale` 1 is a circle. The field is a smooth fBm-like texture inside
 * the ellipse and 0 outside it, so the only radial feature in it is the edge.
 */
function oblateDiscField(
  semiMinorScale,
  radiusPixels,
  camera = CONTROL_CAMERA,
) {
  const texture = fbmField(11);
  return buildField(FRAME, (x, y) => {
    const dx = x + 0.5 - camera.centreX;
    const dy = (y + 0.5 - camera.centreY) / semiMinorScale;
    if (Math.hypot(dx, dy) > radiusPixels) {
      return 0;
    }
    return 0.35 + 0.3 * texture.data[y * FRAME + x];
  });
}

test("13. a stated radius outside the smallest silhouette makes a ring-free drawn planet score RED", () => {
  // THE IMAGE THAT FOOLED THE IMAGERY RIG. WGS84 is oblate: at the orbital
  // recipe camera the equatorial silhouette is 1000.000 px and the polar one
  // 995.588 px. The first draft of that rig copied the blacked-out sibling's
  // 1,000 — harmless where the globe renders black, and not harmless here,
  // because the 4.41 px annulus between the two radii carries a hard
  // planet/space edge and the detrend cannot remove an edge.
  const equatorial = CONTROL_CAMERA.discRadiusPixels;
  const polarScale = 995.5884034179564 / 1000;
  const circular = radialBanding(
    oblateDiscField(1, equatorial),
    CONTROL_CAMERA,
  );
  const oblate = radialBanding(
    oblateDiscField(polarScale, equatorial),
    CONTROL_CAMERA,
  );
  const insideSmallest = radialBanding(
    oblateDiscField(polarScale, equatorial),
    {
      ...CONTROL_CAMERA,
      discRadiusPixels: equatorial * polarScale - 1,
    },
  );

  assert.ok(
    circular.coherence < PROVISIONAL_BANDS.green,
    `a circular disc measured at its own radius reads ${circular.coherence}`,
  );
  assert.ok(
    oblate.coherence > PROVISIONAL_BANDS.red,
    `the oblate disc measured at the EQUATORIAL radius reads ${oblate.coherence}, which should clear RED`,
  );
  assert.ok(
    oblate.coherence > circular.coherence * 10,
    "the oblateness must dominate, or this case is measuring the texture",
  );
  assert.ok(
    insideSmallest.coherence < PROVISIONAL_BANDS.green,
    `the same field measured inside the POLAR silhouette reads ${insideSmallest.coherence}`,
  );

  // AND THE LADDER IS WHAT TELLS THE TWO APART. A single edge has no spacing:
  // one onset, no ln-depth ladder. A real family has twenty and a 1.4 % CV.
  assert.equal(oblate.bandCount, 1);
  assert.equal(oblate.lnZSpacingMean, null);
  assert.equal(GOLDEN.expected.bandCount, 20);
  assert.ok(GOLDEN.expected.lnZSpacingCv < 0.02);
});

test("14. one sharp radial feature scores like banding, and only the ladder separates them", () => {
  // The general statement of case 13, over the features a DRAWN planet has:
  // an atmosphere limb ring and an albedo step both score RED with no rings in
  // the frame, while smooth structure at the same amplitude does not.
  const texture = fbmField(12);
  const featureField = (valueAt) =>
    buildField(FRAME, (x, y) => {
      const radius = radiusAt(x, y);
      if (radius > CONTROL_CAMERA.discRadiusPixels) {
        return 0;
      }
      const base = 0.35 + 0.3 * texture.data[y * FRAME + x];
      return base + valueAt(radius / CONTROL_CAMERA.discRadiusPixels);
    });

  const limbRing = radialBanding(
    featureField((r) => (r > 0.97 ? 0.35 : 0)),
    CONTROL_CAMERA,
  );
  const albedoStep = radialBanding(
    featureField((r) => (r > 0.6 ? 0.3 : 0)),
    CONTROL_CAMERA,
  );
  const smoothLimb = radialBanding(
    featureField((r) => 0.35 * r * r),
    CONTROL_CAMERA,
  );

  for (const [name, result] of [
    ["limb ring", limbRing],
    ["albedo step", albedoStep],
  ]) {
    assert.ok(
      result.coherence > PROVISIONAL_BANDS.red,
      `${name} reads ${result.coherence}; the point of this case is that it does`,
    );
    assert.ok(
      result.bandCount <= 2,
      `${name} produced ${result.bandCount} bands; an edge is not a family`,
    );
  }
  assert.ok(
    smoothLimb.coherence < PROVISIONAL_BANDS.green,
    `smooth limb structure reads ${smoothLimb.coherence} and must not`,
  );
});

test("15. a rung whose silhouette leaves the frame is measured on a stated in-frame sub-disc", () => {
  // THE BANKED 3,000 km RUNG. Its disc is 1,645.4 px in a 2,048 px frame, so
  // `radialBanding` refuses it outright — correctly, because a partial annulus
  // is an average over whichever corners survived the crop. The supported route
  // is a smaller, WHOLE disc: the ladder's coordinate comes from the focal
  // length, the altitude and the planet radius, never from the stated radius,
  // so a sub-disc measures the same physical quantity over less of the image.
  const lowAltitude = {
    ...GOLDEN.camera,
    centreX: 1024,
    centreY: 1024,
    altitudeMetres: 3000000,
    discRadiusPixels: 1645.3831211300906,
  };
  const field = {
    width: 2048,
    height: 2048,
    data: new Float64Array(2048 * 2048).fill(0.5),
  };
  assert.throws(
    () => radialBanding(field, lowAltitude),
    /leaves the 2048x2048 frame/,
  );
  const subDisc = radialBanding(field, {
    ...lowAltitude,
    discRadiusPixels: 1000,
  });
  assert.equal(typeof subDisc.coherence, "number");

  // The geometry the sub-disc reports is the RUNG's geometry, not a rescaled
  // one: the depth at a given pixel radius is unchanged by how much of the
  // disc is being averaged over.
  assert.equal(
    eyeAxisDepthMetres(500, lowAltitude, 6378137 + 4000),
    eyeAxisDepthMetres(
      500,
      { ...lowAltitude, discRadiusPixels: 1000 },
      6378137 + 4000,
    ),
  );
  // And it is a DIFFERENT geometry from the 6,608 km rung's, which is what
  // makes the sub-disc a legitimate rung rather than a relabelled one.
  assert.notEqual(
    eyeAxisDepthMetres(500, lowAltitude, 6378137 + 4000),
    eyeAxisDepthMetres(500, GOLDEN.camera, 6378137 + 4000),
  );
});
