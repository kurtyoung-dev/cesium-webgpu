// cloud-orbital-ladder-contract.spec.mjs — C13-N04b. Pure Node: no browser, no GPU.
//
// @purpose Unit-checks the orbital ladder's four statistics against geometry the plan states independently, then drives the REAL descriptor through runProbe with a stubbed browser so the instrument is known to reach a verdict before an Edge slot is spent on it.
// @status ACTIVE
//
// TWO HALVES, TWO JOBS.
//
// A. THE STATISTICS. O7 and O3's derivable leg are arithmetic over geometry, so
//    they can be checked against numbers Campaign 13 v2 §1.3 arrived at by a
//    different route: the plan says the limb chord is "451 km at a 4 km deck
//    top" and the spacing "~18.8 km ... 451 km / 24 steps". This file
//    recomputes both from first principles and requires them to agree. That is
//    an INDEPENDENT check in the sense Principle 10 means — the model and the
//    plan's figure do not share a source.
//
// B. THE DESCRIPTOR. `probe-descriptor-cells-contract.spec.mjs` exists because
//    AR-752 lost an Edge leg to a three-character shape error on the probe's
//    only execution path, after the slot had been taken and the measurements
//    made. Every authoring-time guard in the fleet reads probe SOURCE; none of
//    them EXECUTES a descriptor. So this half runs the real one — argv,
//    preflight, slot, cells, receipt, verdicts, summary — against a stub page,
//    in milliseconds, before the ladder is ever queued for Edge.
//
// WHAT IT DOES NOT DO: measure anything. Every pixel below is a fixture chosen
// to put a statistic on a known side of its bar. No number in this file is
// evidence about the renderer, and the probe has never run — its first run is
// owed to the Edge slot the lane does not hold.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// THE ENGINE, IMPORTED — NOT TRANSCRIBED. Section D's double is built from
// these two classes rather than from a reading of them; the section-D header
// says why round two returned this file twice for the same defect.
// `CloudVolumetrics` and `CloudRenderMode` are plain data modules that load
// under `node --test` with no build step (`CloudVolumetrics.js` imports only
// `CloudType` and `Frozen`), the way `aurora-geomagnetic-oval.spec.mjs`
// already imports `Cartesian3`. `CloudCollection` itself cannot: it pulls in
// `Shaders/CloudCollectionFS.js`, a generated module that exists only after a
// build — so its one accessor pair is EXTRACTED from the tracked source in
// section D rather than retyped.
import CloudRenderMode from "../../packages/engine/Source/Scene/CloudRenderMode.js";
import CloudVolumetrics from "../../packages/engine/Source/Scene/CloudVolumetrics.js";
import { encodeRgbaPng } from "../lib/png-rgba.mjs";
import {
  ALTITUDE_LADDER_METRES,
  ORBITAL_BARS,
  WGS84_EQUATORIAL_RADIUS_METRES,
  aerialCapDistanceMetres,
  evaluateO3,
  evaluateO4,
  evaluateO6Retention,
  evaluateO6ZoomFlicker,
  evaluateO7,
  evaluateO7Field,
  imageAerialCapFraction,
  limbBand,
  limbChordMetres,
  meanCloudAlpha,
  minimumMarchMidDistanceMetres,
} from "./lib/cloud-orbital-ladder-model.mjs";
import {
  MECHANISM_ARM_IDS,
  armById,
  evaluateFarSweep,
  logDepthScale,
  pageBuildScene,
  pageRunArm,
  predictedPeriod,
} from "./lib/cloud-march-mechanism.mjs";
import { forwardReinhard } from "./lib/cloud-photometry.mjs";
import { installCloudProbeHarness } from "./lib/cloud-probe-harness.mjs";
import { PROBE_EXIT_CODES, runProbe } from "./lib/probe-runtime.mjs";
import {
  acquireCesiumNamespace as acquireMechanismNamespace,
  armDialSets,
  descriptor as mechanismDescriptor,
  selectArms,
} from "./probe-cloud-march-mechanism.mjs";
import {
  acquireCesiumNamespace,
  descriptor as ladderDescriptor,
} from "./probe-cloud-orbital-ladder.mjs";
import MECHANISM_RIG from "./rigs/orbital-fulldisc-6608km.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE_PATH = path.join(HERE, "probe-cloud-orbital-ladder.mjs");

// ===========================================================================
// A. The statistics
// ===========================================================================

test("A1. the limb chord reproduces the plan's independently stated 451 km", () => {
  // Campaign 13 v2 §1.3, O7: "chord 451 km at a 4 km deck top". The plan got
  // there by its own arithmetic; this gets there from 2*sqrt((R+top)^2 - R^2).
  const chord = limbChordMetres({ deckTopMetres: 4000 });
  assert.ok(
    Math.abs(chord / 1000 - 451) < 1,
    `chord ${(chord / 1000).toFixed(1)} km should agree with the plan's 451 km`,
  );
  // A thicker deck lengthens the chord; a thinner one shortens it. Monotone, so
  // a sign error cannot hide inside a single agreeing value.
  assert.ok(limbChordMetres({ deckTopMetres: 16000 }) > chord);
  assert.ok(limbChordMetres({ deckTopMetres: 1000 }) < chord);
  // Starting the chord at a raised deck BASE shortens it, because the ray is
  // tangent to a larger sphere.
  assert.ok(
    limbChordMetres({ deckTopMetres: 4000, deckBottomMetres: 1500 }) < chord,
  );
  assert.throws(() =>
    limbChordMetres({ deckTopMetres: 100, deckBottomMetres: 200 }),
  );
});

test("A2. O7 reproduces the plan's 18.8 km at 24 steps and fails its own 2 km bar", () => {
  const o7 = evaluateO7({ primarySteps: 24, deckTopMetres: 4000 });
  assert.equal(o7.kind, "derivable");
  assert.ok(
    Math.abs(o7.spacingMetres / 1000 - 18.8) < 0.2,
    `spacing ${(o7.spacingMetres / 1000).toFixed(2)} km should agree with the plan's ~18.8 km`,
  );
  assert.equal(o7.pass, false, "18.8 km is nine times the 2 km bar");
  assert.equal(o7.targetMetres, ORBITAL_BARS.O7.targetMetres);
  // And it says what WOULD satisfy the bar, which is the number C13-N13 needs.
  assert.equal(o7.stepsRequired, Math.ceil(o7.chordMetres / 2000));
  assert.ok(o7.stepsRequired > 200);
  // The bar is reachable, so it is a gate rather than an aspiration: enough
  // steps and it passes.
  assert.equal(
    evaluateO7({ primarySteps: o7.stepsRequired, deckTopMetres: 4000 }).pass,
    true,
  );
  assert.throws(() => evaluateO7({ primarySteps: 0, deckTopMetres: 4000 }));
});

// ---------------------------------------------------------------------------
// A2b-A2f. O7 as a distribution over the disc, not as one ray.
//
// THE CAMERA THESE CASES USE IS THE BANKED ONE. Altitude 6,608,426.573 m,
// focal 1,773.620 px, disc 1,000 px, deck 1,500-4,000 m: every number is read
// out of the L5 orbital receipt's own capture manifest
// (`…/c13v2-wave1-engine-legs-2026-09-18/L5/structural/full-res/NOWX-capture.json`),
// so the distribution below is the one the banked frames were rendered under.
// ---------------------------------------------------------------------------

const L5_CAMERA = Object.freeze({
  altitudeMetres: 6608426.573306667,
  focalPixels: 1773.6200269505305,
  discRadiusPixels: 1000,
  deckBottomMetres: 1500,
  deckTopMetres: 4000,
});

test("A2b. the two chords are different rays, and limbTangent is the one the march spans", () => {
  const field = evaluateO7Field({ ...L5_CAMERA, primarySteps: 96 });
  // The march spans deck bottom to deck top.
  assert.equal(
    field.limbTangent,
    evaluateO7({
      primarySteps: 96,
      deckTopMetres: 4000,
      deckBottomMetres: 1500,
    }).spacingMetres,
  );
  assert.ok(
    Math.abs(field.limbTangent - 3721.2) < 0.1,
    `limbTangent ${field.limbTangent} should be 3,721.2 m`,
  );
  assert.ok(Math.abs(field.limbTangentChordMetres - 357236.3) < 0.1);

  // `evaluateO7`'s own default is a GROUND-to-deck-top chord, which is the
  // figure the plan's O7 row quotes. It is carried, labelled, and never folded
  // into the bar: the two differ by more than a quarter.
  assert.ok(Math.abs(field.limbTangentGroundToTopChordMetres - 451845.5) < 0.1);
  assert.equal(
    field.limbTangentGroundToTopChordMetres,
    evaluateO7({ primarySteps: 24, deckTopMetres: 4000 }).chordMetres,
  );
  const apart =
    field.limbTangentGroundToTopChordMetres / field.limbTangentChordMetres - 1;
  assert.ok(
    Math.abs(apart - 0.265) < 0.002,
    `the two chords are ${(apart * 100).toFixed(1)} % apart`,
  );
});

test("A2c. at the banked orbital camera the bar is met at tier 3 and missed at tier 1", () => {
  // Tier 3 — 96 primary steps, which is what the banked capture ran.
  const tier3 = evaluateO7Field({ ...L5_CAMERA, primarySteps: 96 });
  assert.equal(tier3.kind, "derived-per-ray");
  assert.ok(
    tier3.max < 2000,
    `tier 3 max spacing ${tier3.max} m should be under the 2 km bar`,
  );
  assert.equal(tier3.fractionOverBar, 0);
  // The nadir ray crosses the deck once: its spacing is the deck thickness
  // over the step count, and it is the smallest on the disc. The innermost
  // SAMPLE sits half a cell off the axis, so the agreement is to a micron
  // rather than exact.
  assert.ok(
    Math.abs(tier3.min - 2500 / 96) < 1e-4,
    `the sub-satellite spacing is ${tier3.min} m, not 2500/96`,
  );

  // Tier 1 — 24 primary steps, which is what `auto` resolves to at this
  // altitude (`WebGPUCloudTierPresets.ts:193-203`: far = low). The bar IS
  // exceeded there, on a narrow annulus near the limb.
  const tier1 = evaluateO7Field({ ...L5_CAMERA, primarySteps: 24 });
  assert.ok(
    tier1.max > 2000,
    `tier 1 max spacing ${tier1.max} m should exceed the 2 km bar`,
  );
  assert.ok(
    tier1.fractionOverBar > 0 && tier1.fractionOverBar < 0.01,
    `tier 1 exceeds the bar over ${(tier1.fractionOverBar * 100).toFixed(3)} % of the disc`,
  );
  // And overwhelmingly it is met: the defect is a tail, not the disc.
  assert.ok(tier1.p99 < 2000);
});

test("A2d. the distribution is ordered and monotone in the step count", () => {
  let previousMax = Infinity;
  for (const primarySteps of [12, 24, 48, 96, 192]) {
    const field = evaluateO7Field({ ...L5_CAMERA, primarySteps });
    assert.ok(field.min <= field.p50, "min above p50");
    assert.ok(field.p50 <= field.p95, "p50 above p95");
    assert.ok(field.p95 <= field.p99, "p95 above p99");
    assert.ok(field.p99 <= field.max, "p99 above max");
    assert.ok(
      field.max <= previousMax,
      `max rose from ${previousMax} to ${field.max} at ${primarySteps} steps`,
    );
    previousMax = field.max;
  }
});

test("A2e. degenerate geometry throws rather than returning NaN", () => {
  assert.throws(() => evaluateO7Field({ ...L5_CAMERA, primarySteps: 0 }));
  assert.throws(() =>
    evaluateO7Field({ ...L5_CAMERA, primarySteps: 96, discRadiusPixels: 0 }),
  );
  assert.throws(() =>
    evaluateO7Field({ ...L5_CAMERA, primarySteps: 96, focalPixels: 0 }),
  );
  assert.throws(() =>
    evaluateO7Field({ ...L5_CAMERA, primarySteps: 96, samples: 1 }),
  );
  // A camera inside the deck is a different geometry with a different solve.
  assert.throws(() =>
    evaluateO7Field({ ...L5_CAMERA, primarySteps: 96, altitudeMetres: 2000 }),
  );
  // A DEGENERATE-BUT-NOT-ZERO CAMERA. `focalPixels: 1` is finite and positive,
  // so every guard above passes it; 2,047 of its 2,048 rays miss the shell and
  // the old `entries.length === 0` check let the last one produce a confident
  // `max` over a sample of one. The refusal is on the usable FRACTION.
  assert.throws(
    () => evaluateO7Field({ ...L5_CAMERA, primarySteps: 96, focalPixels: 1 }),
    /sampled rays reached the deck/,
  );
  // A caller that genuinely wants a sparse disc has to say so, and then gets a
  // distribution that names how little of it was usable.
  const sparse = evaluateO7Field({
    ...L5_CAMERA,
    primarySteps: 96,
    focalPixels: 1,
    minimumUsableFraction: 0,
  });
  assert.equal(sparse.samples, 1);
  // The honest camera is nowhere near the guard: every ray inside the
  // silhouette crosses the outer shell.
  assert.equal(
    evaluateO7Field({ ...L5_CAMERA, primarySteps: 96 }).samples,
    2048,
  );
});

/**
 * Import a copy of the ladder model with one construct made unreachable.
 *
 * The copy is an inline `data:` module built from the mutated source string,
 * so there is no file on disk a stale import could reach instead. The model's
 * one relative import has no base to resolve against in a `data:` URL and is
 * rewritten to the absolute URL this spec resolves it to; that rewrite makes
 * the mutant loadable and is not part of the mutation.
 *
 * @param {(source: string) => string} mutate The mutation.
 * @returns {Promise<object>} The mutated module.
 */
async function importMutatedLadderModel(mutate) {
  let source = readFileSync(
    path.join(HERE, "lib", "cloud-orbital-ladder-model.mjs"),
    "utf8",
  ).replaceAll("\r\n", "\n");
  const relative = './metrics/region-means.mjs"';
  assert.ok(
    source.split(relative).length - 1 > 0,
    "the model's metrics re-exports moved",
  );
  source = source.replaceAll(
    relative,
    `${new URL("./lib/metrics/region-means.mjs", import.meta.url).href}"`,
  );
  const mutated = mutate(source);
  assert.notEqual(mutated, source, "the mutation did not apply");
  return import(
    `data:text/javascript;base64,${Buffer.from(mutated).toString("base64")}`
  );
}

test("A2f. MUTATION control: without the per-ray deck crossing the bar case cannot fail", async () => {
  // Unreachable, not deleted. With the inner-shell branch inert every ray
  // reports the WHOLE outer chord — which is the one-ray model this field
  // instrument exists to replace — and the tier-3 bar case reads kilometres.
  const guard = "  if (innerHalfChordSq > 0) {";
  const mutant = await importMutatedLadderModel((source) => {
    assert.equal(source.split(guard).length - 1, 1);
    return source.replace(guard, "  if (false && innerHalfChordSq > 0) {");
  });
  assert.notEqual(mutant.evaluateO7Field, evaluateO7Field);
  const real = evaluateO7Field({ ...L5_CAMERA, primarySteps: 96 });
  const inert = mutant.evaluateO7Field({ ...L5_CAMERA, primarySteps: 96 });
  assert.ok(real.max < 2000, `the real instrument reads ${real.max} m`);
  assert.ok(
    inert.max > 2000,
    `the inert instrument reads ${inert.max} m, which A2c would still have passed`,
  );
  // `evaluateO7` is untouched by the mutation, which is what says the mutant
  // hit the new code path rather than the old one.
  assert.equal(
    mutant.evaluateO7({ primarySteps: 24, deckTopMetres: 4000 }).spacingMetres,
    evaluateO7({ primarySteps: 24, deckTopMetres: 4000 }).spacingMetres,
  );
});

test("A3. the aerial clamp saturates at 51 km, so O3 is 1.0 at every orbital rung", () => {
  // `clamp(midDist / 60000 * aerialStrength, 0, 0.85)` reaches its cap at
  // midDist = 0.85 * 60000 = 51 km when strength is neutral.
  assert.ok(
    Math.abs(aerialCapDistanceMetres({ aerialStrength: 1 }) - 51000) < 1e-6,
  );
  // Doubling the strength halves the range at which everything is flat haze.
  assert.ok(
    Math.abs(aerialCapDistanceMetres({ aerialStrength: 2 }) - 25500) < 1e-6,
  );
  // Strength zero disables the term entirely: nothing ever caps.
  assert.equal(
    aerialCapDistanceMetres({ aerialStrength: 0 }),
    Number.POSITIVE_INFINITY,
  );

  const deck = { deckBottomMetres: 1500, deckTopMetres: 4000 };
  const nadir = minimumMarchMidDistanceMetres({
    cameraAltitudeMetres: 200_000,
    ...deck,
  });
  assert.ok(nadir > 51000, "even the nearest ray at 200 km is past the cap");

  for (const altitudeMetres of ALTITUDE_LADDER_METRES.filter(
    (metres) => metres >= ORBITAL_BARS.O3.appliesAboveMetres,
  )) {
    const o3 = evaluateO3({
      cameraAltitudeMetres: altitudeMetres,
      ...deck,
      aerialStrength: 1,
    });
    assert.equal(o3.applies, true);
    assert.equal(
      o3.derivedCappedFraction,
      1,
      `at ${altitudeMetres} m every cloud pixel is at the cap`,
    );
    assert.equal(
      o3.pass,
      false,
      "which is exactly the defect C13-N20 exists to fix",
    );
  }
});

test("A4. O3 refuses to guess where it cannot derive, and does not apply below 200 km", () => {
  const deck = { deckBottomMetres: 1500, deckTopMetres: 4000 };
  // Below the cap range with the aerial term weak, the nadir ray says nothing
  // about the much longer grazing rays, so the derived fraction is null rather
  // than 0 — the model does not hand C13-N20 a number nobody measured.
  const weak = evaluateO3({
    cameraAltitudeMetres: 20_000,
    ...deck,
    aerialStrength: 0.01,
  });
  assert.equal(weak.derivedCappedFraction, null);
  // The bar itself only applies at or above 200 km, so a 20 km rung is neither
  // passed nor failed.
  assert.equal(weak.applies, false);
  assert.equal(weak.pass, null);
});

test("A5. O3's image leg counts only pixels that have collapsed onto the aerial tint", () => {
  const width = 4;
  const height = 1;
  const aerialColor = { r: 0.6, g: 0.7, b: 0.9 };
  const rgba = new Uint8Array(width * height * 4);
  const paint = (index, r, g, b) => {
    rgba[index * 4] = Math.round(r * 255);
    rgba[index * 4 + 1] = Math.round(g * 255);
    rgba[index * 4 + 2] = Math.round(b * 255);
    rgba[index * 4 + 3] = 255;
  };
  paint(0, 0.6, 0.7, 0.9); // exactly the tint — capped
  paint(1, 0.62, 0.71, 0.91); // within tolerance — capped
  paint(2, 0.1, 0.1, 0.1); // nothing like it — not capped
  paint(3, 1, 1, 1); // outside the cloud mask below
  const cloudMask = Uint8Array.from([1, 1, 1, 0]);
  const result = imageAerialCapFraction(rgba, {
    width,
    height,
    cloudMask,
    aerialColor,
  });
  assert.equal(result.cloudPixels, 3);
  assert.equal(result.cappedPixels, 2);
  assert.ok(Math.abs(result.fraction - 2 / 3) < 1e-9);
  assert.throws(() =>
    imageAerialCapFraction(rgba, { width, height, aerialColor: null }),
  );
});

test("A6. O4 measures the largest 2-px step inside the band, over the band's own mean", () => {
  const width = 8;
  const height = 1;
  const band = Uint8Array.from([0, 1, 1, 1, 1, 1, 1, 0]);
  const field = Float64Array.from([99, 1, 1, 1, 1.5, 1, 1, 99]);
  const o4 = evaluateO4({ luminanceField: field, width, height, band });
  assert.equal(o4.kind, "measured");
  assert.equal(o4.bandPixels, 6);
  // The 99s are outside the band and must not reach either the step or the
  // mean; if they did, the mean would be ~25 and the step ~98.
  assert.ok(Math.abs(o4.localMean - 6.5 / 6) < 1e-9);
  assert.ok(Math.abs(o4.maxStep - 0.5) < 1e-9);
  assert.ok(Math.abs(o4.normalizedStep - 0.5 / (6.5 / 6)) < 1e-9);
  assert.equal(o4.pass, false, "a 46 % step is far above the 10 % bar");

  // A flat band passes, so the bar can be met.
  const flat = evaluateO4({
    luminanceField: Float64Array.from([99, 1, 1, 1, 1, 1, 1, 99]),
    width,
    height,
    band,
  });
  assert.equal(flat.pass, true);
  assert.equal(flat.normalizedStep, 0);

  // An empty band is `null`, not a passing zero.
  const empty = evaluateO4({
    luminanceField: field,
    width,
    height,
    band: new Uint8Array(width * height),
  });
  assert.equal(empty.pass, null);
  assert.match(empty.reason, /selected no pixels/);
});

test("A7. the limb band names which reading of '5 deg' it used, and they differ hugely", () => {
  const frame = {
    width: 128,
    height: 128,
    centreX: 64,
    centreY: 64,
    radiusPixels: 50,
  };
  // 60 deg fovy over a 128-px capture.
  const pixelsPerRadian = 128 / 2 / Math.tan(Math.PI / 6);

  const viewAngle = limbBand({ ...frame, mode: "view-angle", pixelsPerRadian });
  const surfaceArc = limbBand({ ...frame, mode: "surface-arc" });
  assert.equal(viewAngle.mode, "view-angle");
  assert.equal(surfaceArc.mode, "surface-arc");
  assert.equal(viewAngle.outerRadiusPixels, 50);

  // The surface-arc reading is a sliver: cos(5 deg) * 50 = 49.81, a 0.19-px
  // annulus that cannot host the 2-px window O4's own sentence asks for. That
  // is the evidence for defaulting to the view-angle reading, and it is
  // asserted rather than asserted-in-prose.
  assert.ok(
    50 - surfaceArc.innerRadiusPixels < 2,
    `surface-arc band is ${(50 - surfaceArc.innerRadiusPixels).toFixed(2)} px wide`,
  );
  assert.ok(
    50 - viewAngle.innerRadiusPixels > 5,
    `view-angle band is ${(50 - viewAngle.innerRadiusPixels).toFixed(2)} px wide`,
  );
  assert.ok(viewAngle.count > surfaceArc.count * 5);

  // And it is thin enough that at this radius it can select FEWER PIXELS THAN
  // THE WINDOW IT IS SUPPOSED TO HOST along any given ray — the 0.19-px annulus
  // does not even contain the pixel centre one step inside the silhouette.
  const justInside = 64 * 128 + (64 + 49);
  assert.equal(viewAngle.band[justInside], 1);
  assert.equal(
    surfaceArc.band[justInside],
    0,
    "if the surface-arc band now reaches this pixel the reading is no longer degenerate " +
      "and C13-29 should revisit which one O4 means",
  );
  // Geometry common to both: the disc centre is in neither band.
  assert.equal(viewAngle.band[64 * 128 + 64], 0);
  assert.equal(surfaceArc.band[64 * 128 + 64], 0);

  // Widening the angle can only grow the band, under either reading.
  assert.ok(
    limbBand({ ...frame, mode: "view-angle", pixelsPerRadian, degrees: 15 })
      .count > viewAngle.count,
  );
  assert.ok(
    limbBand({ ...frame, mode: "surface-arc", degrees: 15 }).count >
      surfaceArc.count,
  );

  // The default is the computable reading, and it refuses without the scale it
  // needs rather than silently falling back to the other one.
  assert.equal(limbBand({ ...frame, pixelsPerRadian }).mode, "view-angle");
  assert.throws(() => limbBand({ ...frame }), /pixelsPerRadian/);
  assert.throws(
    () => limbBand({ ...frame, mode: "nonsense" }),
    /unknown limb-band mode/,
  );
});

test("A8. O6 measures retention against the 20 km rung and refuses an empty reference", () => {
  const rungs = [
    { altitudeMetres: 20_000, meanCloudAlpha: 0.5 },
    { altitudeMetres: 200_000, meanCloudAlpha: 0.48 },
    { altitudeMetres: 2_000_000, meanCloudAlpha: 0.46 },
    { altitudeMetres: 20_000_000, meanCloudAlpha: 0.2 },
  ];
  const result = evaluateO6Retention(rungs);
  assert.equal(result.referenceAltitudeMetres, 20_000);
  assert.equal(result.rungs[0].retention, 1);
  assert.ok(Math.abs(result.rungs[1].retention - 0.96) < 1e-9);
  assert.equal(result.rungs[3].pass, false, "0.40 is below the 0.90 bar");
  assert.equal(result.pass, false);
  assert.equal(result.worst.altitudeMetres, 20_000_000);

  // All rungs above the bar passes, so it is falsifiable in both directions.
  assert.equal(
    evaluateO6Retention(rungs.map((r) => ({ ...r, meanCloudAlpha: 0.5 }))).pass,
    true,
  );

  // No cloud at the bottom of the ladder is a refusal, not a divide by zero.
  const empty = evaluateO6Retention([
    { altitudeMetres: 20_000, meanCloudAlpha: 0 },
  ]);
  assert.equal(empty.pass, null);
  assert.match(empty.reason, /no cloud at the bottom of the ladder/);
});

test("A9. O6's zoom clause normalizes its RMS, so it is a percentage of the run", () => {
  const steady = Array.from({ length: 60 }, () => 1.0);
  assert.equal(evaluateO6ZoomFlicker(steady).pass, true);
  assert.equal(evaluateO6ZoomFlicker(steady).normalizedRms, 0);

  // A 20 % square-wave flicker fails; the same absolute wobble on a run ten
  // times brighter passes, which is what "normalized" buys.
  const flickering = Array.from({ length: 60 }, (_, i) =>
    i % 2 === 0 ? 1.0 : 1.2,
  );
  assert.equal(evaluateO6ZoomFlicker(flickering).pass, false);
  const brighter = flickering.map((value) => value + 9);
  assert.equal(evaluateO6ZoomFlicker(brighter).pass, true);

  assert.throws(() => evaluateO6ZoomFlicker([1]));
});

test("A10. mean cloud alpha reads the capture's alpha inside the mask only", () => {
  const width = 4;
  const height = 1;
  const rgba = new Uint8Array(width * height * 4);
  rgba[3] = 255;
  rgba[7] = 0;
  rgba[11] = 128;
  rgba[15] = 255;
  const all = meanCloudAlpha(rgba, { width, height });
  assert.ok(Math.abs(all.meanAlpha - (255 + 0 + 128 + 255) / 4 / 255) < 1e-9);
  const masked = meanCloudAlpha(rgba, {
    width,
    height,
    cloudMask: Uint8Array.from([1, 0, 1, 0]),
  });
  assert.equal(masked.cloudPixels, 2);
  assert.ok(Math.abs(masked.meanAlpha - (255 + 128) / 2 / 255) < 1e-9);
  assert.ok(Math.abs(masked.coverageFraction - 0.5) < 1e-9);
});

test("A11. the ladder is one rung per decade from 20 km to 20,000 km", () => {
  assert.deepEqual(
    ALTITUDE_LADDER_METRES,
    [20_000, 200_000, 2_000_000, 20_000_000],
  );
  for (let i = 1; i < ALTITUDE_LADDER_METRES.length; i++) {
    assert.equal(ALTITUDE_LADDER_METRES[i] / ALTITUDE_LADDER_METRES[i - 1], 10);
  }
  assert.ok(WGS84_EQUATORIAL_RADIUS_METRES > 6e6);
});

// ===========================================================================
// B. The descriptor, executed
// ===========================================================================

const FRAME = { width: 16, height: 16 };
const STUB_EXPOSURE = 0.31;

/** A grey frame whose every pixel carries a known pre-Reinhard radiance. */
function framePng(radiance, alpha = 200) {
  const byte = Math.round(forwardReinhard(radiance, STUB_EXPOSURE) * 255);
  const pixels = new Uint8Array(FRAME.width * FRAME.height * 4);
  for (let index = 0; index < FRAME.width * FRAME.height; index++) {
    pixels[index * 4] = byte;
    pixels[index * 4 + 1] = byte;
    pixels[index * 4 + 2] = byte;
    pixels[index * 4 + 3] = alpha;
  }
  return Buffer.from(encodeRgbaPng(pixels, FRAME.width, FRAME.height));
}

/**
 * A page that answers the ladder's `page.evaluate` calls by the marker comment
 * in the function it was handed. Dispatch order matters: the harness installer
 * arrives through `addInitScript`, not `evaluate`, so it needs no branch.
 */
function fakePage(
  log,
  {
    exposure = STUB_EXPOSURE,
    sunVisible = true,
    // What the page reports when the probe asks it for the engine namespace.
    // The default is the served CesiumViewer page AFTER the installer has run;
    // B7 overrides it with the answer a page gives when the module cannot be
    // reached at all.
    namespace = {
      ok: true,
      source: "module",
      moduleUrl: "/Build/CesiumUnminified/index.js",
    },
  } = {},
) {
  let rung = 0;
  return {
    on() {},
    async addInitScript() {},
    async goto() {},
    async waitForFunction() {},
    async evaluate(fn, arg) {
      const source = String(fn);
      if (source.includes("__ladderInstallNamespace")) {
        log.calls.push("namespace");
        return namespace;
      }
      if (source.includes("__ladderBuildScene")) {
        log.calls.push("build");
        return {
          ok: true,
          rendererType: "webgpu",
          renderLoopDisabled: true,
          deck: {
            bottom: arg.volumetric.cloudLayerBottom,
            top: arg.volumetric.cloudLayerTop,
          },
        };
      }
      if (source.includes("__ladderMeasureRung")) {
        log.calls.push(`rung:${arg.altitudeMetres}`);
        rung++;
        return {
          altitudeMetres: arg.altitudeMetres,
          width: FRAME.width,
          height: FRAME.height,
          photometry: {
            ok: exposure !== null,
            reasons:
              exposure === null
                ? ["cloud exposure unavailable at uniform slot 97"]
                : [],
            exposure,
            exposureSlot: 97,
            width: FRAME.width,
            height: FRAME.height,
            transfer: "identity",
            sunDisc: sunVisible
              ? { visible: true, x: 3, y: 3, radiusPixels: 2 }
              : { visible: false },
          },
          limb: {
            // The first rung is inside the atmosphere and has no limb in frame,
            // which is the case the reducer must report rather than score.
            visible: arg.altitudeMetres >= 200_000,
            angularRadiusRadians: 0.2,
            centreX: FRAME.width / 2,
            centreY: FRAME.height / 2,
            radiusPixels: 6,
            pixelsPerRadian: 8,
          },
          uniforms: {
            primarySteps: 24,
            lightSteps: 6,
            aerialStrength: 1,
            aerialColor: { r: 0.6, g: 0.7, b: 0.9 },
            exposure,
          },
        };
      }
      if (source.includes("__ladderZoomSeries")) {
        log.calls.push("zoom");
        return {
          series: Array.from({ length: arg.frames }, (_, i) => ({
            altitudeMetres: 20_000 * (i + 1),
          })),
        };
      }
      if (source.includes("__armWebGPUDevice")) {
        log.calls.push("arm");
        return { armed: 1, found: 1, total: 1 };
      }
      if (source.includes("__webgpuGate")) {
        log.calls.push("gate");
        return { errors: [], deviceLost: null, armedDevices: 1 };
      }
      throw new Error(`unstubbed page.evaluate: ${source.slice(0, 140)}`);
    },
    locator() {
      return {
        first: () => ({
          async screenshot() {
            log.calls.push("shot");
            return framePng(1 + rung);
          },
        }),
      };
    },
  };
}

function fakeLaunch(log, pageOptions) {
  return async () => {
    log.launches += 1;
    return {
      async newPage() {
        return fakePage(log, pageOptions);
      },
      async close() {},
    };
  };
}

async function driveLadder({ argv = [], page } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "cloud-orbital-ladder-"));
  // Destructive-test discipline: everything this spec writes is under
  // os.tmpdir(), asserted rather than assumed.
  assert.ok(
    root.startsWith(tmpdir()),
    "the spec's sandbox must live under os.tmpdir()",
  );
  const out = path.join(root, "out");
  const log = { calls: [], launches: 0 };
  const code = await runProbe(ladderDescriptor, {
    argv: [
      "--repository-root",
      root,
      "--output",
      out,
      "--no-serve-built",
      "--renderer",
      "webgpu",
      "--settle-frames",
      "1",
      "--zoom-frames",
      "4",
      ...argv,
    ],
    now: () => Date.UTC(2026, 8, 12, 23, 0, 0),
    launch: fakeLaunch(log, page),
  });
  return { code, root, out, log };
}

test("B1. the real descriptor walks cells to a receipt, verdicts and a summary", async () => {
  const { code, root, out, log } = await driveLadder();
  try {
    assert.equal(
      code,
      PROBE_EXIT_CODES.FAILURE,
      "the fixture ladder fails O7 by construction",
    );
    // Every rung was visited, in ladder order, each with its own capture.
    for (const altitudeMetres of ALTITUDE_LADDER_METRES) {
      assert.ok(
        log.calls.includes(`rung:${altitudeMetres}`),
        `rung ${altitudeMetres} not visited`,
      );
    }
    assert.equal(
      log.calls.filter((call) => call === "shot").length,
      ALTITUDE_LADDER_METRES.length,
    );
    assert.ok(log.calls.includes("zoom"));
    assert.equal(log.launches, 1);

    // With `receiptEnvelope: "probe-owned"` the report carries the probe's own
    // fields and the runtime writes its record — verdicts included — beside it.
    const receipt = JSON.parse(
      readFileSync(path.join(out, "cloud-orbital-ladder-report.json"), "utf8"),
    );
    const runtime = JSON.parse(
      readFileSync(path.join(out, "cloud-orbital-ladder-runtime.json"), "utf8"),
    );
    assert.equal(
      receipt.clockIso,
      "2026-06-21T18:20:00Z",
      "the pinned clock is in the receipt",
    );
    assert.deepEqual(receipt.ladderMetres, ALTITUDE_LADDER_METRES);
    const verdicts = runtime.verdicts;
    const ids = (verdicts ?? []).map((verdict) => verdict.id);
    assert.deepEqual(ids, ["O3", "O4", "O6", "O7"]);
    // O7 is derivable and its fixture is 24 steps over a 2.5 km-thick deck, so
    // it must be the bar that fails — and it must fail for the stated reason.
    const o7 = verdicts.find((verdict) => verdict.id === "O7");
    assert.equal(o7.pass, false);
    assert.match(o7.claim, /2 km apart/);
    const o3 = verdicts.find((verdict) => verdict.id === "O3");
    assert.equal(
      o3.pass,
      false,
      "the fixture is at the aerial cap at every orbital rung",
    );
    // A bare `pass: false` cannot tell "measured and failed" from "could not be
    // derived", and O3's whole value to C13-N20 is that it is DERIVED. So the
    // detail must carry the derived 1 at every orbital rung, and the image leg
    // must have been computed too.
    const o3Rungs = o3.detail[0];
    assert.ok(
      o3Rungs.length >= 3,
      "every rung at or above 200 km should be scored",
    );
    for (const rung of o3Rungs) {
      assert.equal(
        rung.derived,
        1,
        `rung ${rung.altitudeMetres} did not derive a capped fraction of 1`,
      );
      assert.ok(Math.abs(rung.capDistanceMetres - 51000) < 1e-6);
      assert.equal(
        typeof rung.image,
        "number",
        "the corroborating image leg did not run",
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("B2. the photometric rule reaches the probe: no live exposure is a refusal", async () => {
  const { code, root, out } = await driveLadder({ page: { exposure: null } });
  try {
    assert.equal(code, PROBE_EXIT_CODES.REFUSAL);
    const incident = JSON.parse(
      readFileSync(path.join(out, "cloud-orbital-ladder-refusal.json"), "utf8"),
    );
    const text = JSON.stringify(incident);
    assert.match(text, /photometric-context-unavailable/);
    // The refusal must say WHY the rule matters, or a reader will widen it.
    assert.match(text, /pre-Reinhard/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("B3. a WebGL-only invocation refuses instead of measuring a cloudless globe", async () => {
  const { code, root, out } = await driveLadder({
    argv: ["--renderer", "webgl"],
  });
  try {
    assert.equal(code, PROBE_EXIT_CODES.REFUSAL);
    const text = readFileSync(
      path.join(out, "cloud-orbital-ladder-refusal.json"),
      "utf8",
    );
    assert.match(text, /renderer-unavailable/);
    assert.match(
      text,
      /C13-N15c/,
      "the refusal names the row that makes WebGL measurable",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("B4. O4 is reported as not-evaluable at the rung with no limb in frame", async () => {
  const { code, root, out } = await driveLadder();
  try {
    assert.ok(code !== PROBE_EXIT_CODES.ERROR);
    const receipt = JSON.parse(
      readFileSync(path.join(out, "cloud-orbital-ladder-report.json"), "utf8"),
    );
    const runs = receipt.runs;
    const rungs = runs[0].rungs;
    const lowest = rungs.find((rung) => rung.altitudeMetres === 20_000);
    assert.equal(lowest.o4.pass, null);
    assert.match(lowest.o4.reason, /no limb is in frame/);
    // And the rungs that DO have a limb produced a number.
    assert.ok(
      rungs.filter((rung) => rung.o4.normalizedStep !== undefined).length >= 1,
    );
    // The sun disc was masked on every rung, which §1.3 requires of every
    // photometric ROI.
    for (const rung of rungs) {
      assert.equal(
        rung.sunDiscMasked,
        true,
        `rung ${rung.altitudeMetres} did not mask the sun`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// B6-B8. Page acquisition — the harness fault that cost the probe its first leg
//
// On 2026-09-16 the ladder's first ever Edge run exited 2 on both served trees
// with "TypeError: Cannot read properties of undefined (reading 'JulianDate')".
// The served Apps/CesiumViewer page publishes `window.viewer` and never
// `window.Cesium`, so every page function that reads the namespace off the
// global — and `photometricContext()`'s sun-disc projection with it — had
// nothing to read. These legs pin the repair from both ends: that the probe
// ASKS the page for the namespace before anything needs it, and that a page
// which cannot supply one produces a NAMED REFUSAL rather than a crash.
// ---------------------------------------------------------------------------

test("B6. the namespace is acquired once, before the first read of it", async () => {
  const { code, root, log } = await driveLadder();
  try {
    assert.ok(
      code !== PROBE_EXIT_CODES.ERROR,
      "the ladder must not die on page acquisition",
    );
    assert.equal(
      log.calls.filter((call) => call === "namespace").length,
      1,
      "the namespace is installed once per page, not once per rung",
    );
    // Order is the whole point: the scene build reads `JulianDate` and every
    // rung reads `SceneTransforms`, so an install that happens after either is
    // the same defect with a later stack trace.
    assert.ok(
      log.calls.indexOf("namespace") < log.calls.indexOf("build"),
      `namespace acquired after the scene build: ${log.calls.join(",")}`,
    );
    assert.ok(
      log.calls.indexOf("namespace") <
        log.calls.indexOf(`rung:${ALTITUDE_LADDER_METRES[0]}`),
      "namespace acquired after the first rung was measured",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("B7. a page with no engine namespace refuses by name instead of crashing", async () => {
  const { code, root, out, log } = await driveLadder({
    page: {
      namespace: {
        ok: false,
        source: "import-failed",
        moduleUrl: "/Build/CesiumUnminified/index.js",
        reason: "Failed to fetch dynamically imported module",
      },
    },
  });
  try {
    // THE BEHAVIOUR, NOT THE SHAPE. Exit 3 is "the probe declined to measure";
    // exit 2 is "the probe broke". The pre-fix run exited 2, so asserting 3
    // here is asserting that the diagnosis reaches the orchestrator.
    assert.equal(
      code,
      PROBE_EXIT_CODES.REFUSAL,
      "a page that cannot supply the namespace must refuse, not error",
    );
    assert.notEqual(code, PROBE_EXIT_CODES.ERROR);
    const text = readFileSync(
      path.join(out, "cloud-orbital-ladder-refusal.json"),
      "utf8",
    );
    assert.match(text, /cesium-namespace-unavailable/);
    // The refusal carries what the page said, so the next reader does not have
    // to spend an Edge slot finding out which half failed.
    assert.match(text, /Failed to fetch dynamically imported module/);
    assert.match(text, /import-failed/);
    // And it refused BEFORE building a scene it cannot measure.
    assert.equal(
      log.calls.includes("build"),
      false,
      "the ladder built a scene after failing to acquire the namespace",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A page whose `evaluate` really runs the function it is handed. */
function executingPage(log) {
  return {
    async evaluate(fn, arg) {
      log.calls.push("evaluate");
      return fn(arg);
    },
  };
}

/** A `data:` module standing in for `/Build/CesiumUnminified/index.js`. */
function moduleUrlFor(sourceText) {
  const base64 = Buffer.from(sourceText, "utf8").toString("base64");
  return `data:text/javascript;base64,${base64}`;
}

test("B8. the real page function installs the namespace, or names what failed", async (t) => {
  // This leg executes the PAGE function itself — the stub page CALLS it rather
  // than matching its marker — so what is checked is the code that runs on
  // Edge, with a `data:` module in place of the engine bundle.
  const had = Object.hasOwn(globalThis, "Cesium");
  const previous = globalThis.Cesium;
  t.after(() => {
    if (had) {
      globalThis.Cesium = previous;
    } else {
      delete globalThis.Cesium;
    }
  });
  delete globalThis.Cesium;

  const log = { calls: [] };

  // (a) A page WITHOUT the namespace gets one, and it is the module's.
  const complete = moduleUrlFor(
    [
      "export const JulianDate = { tag: 'complete' };",
      "export const Cartesian3 = {};",
      "export const Math = {};",
      "export const SceneTransforms = {};",
    ].join("\n"),
  );
  const installed = await acquireCesiumNamespace(executingPage(log), complete);
  assert.equal(installed.ok, true);
  assert.equal(installed.source, "module");
  assert.equal(
    globalThis.Cesium?.JulianDate?.tag,
    "complete",
    "the page global still has no engine namespace after acquisition",
  );
  assert.notEqual(
    globalThis.Cesium?.SceneTransforms,
    undefined,
    "SceneTransforms is what photometricContext() projects the sun with",
  );

  // (b) A second call is a no-op: what the page already has is kept, and no
  // second engine is pulled in behind it.
  const again = await acquireCesiumNamespace(
    executingPage(log),
    moduleUrlFor(
      [
        "export const JulianDate = { tag: 'other' };",
        "export const Cartesian3 = {};",
        "export const Math = {};",
        "export const SceneTransforms = {};",
      ].join("\n"),
    ),
  );
  assert.equal(again.source, "page");
  assert.equal(globalThis.Cesium.JulianDate.tag, "complete");

  // (c) A module that loads but is not the engine is refused by name, rather
  // than accepted and failed three rungs later.
  delete globalThis.Cesium;
  await assert.rejects(
    () =>
      acquireCesiumNamespace(
        executingPage(log),
        moduleUrlFor("export const JulianDate = {};"),
      ),
    (error) => {
      assert.equal(error.name, "ProbeRefusal");
      assert.equal(error.reason, "cesium-namespace-unavailable");
      assert.equal(error.exitCode, PROBE_EXIT_CODES.REFUSAL);
      assert.equal(error.details.outcome.source, "module-incomplete");
      assert.match(error.message, /SceneTransforms/);
      return true;
    },
    "a partial namespace must refuse rather than install",
  );
  assert.equal(
    globalThis.Cesium,
    undefined,
    "a refused acquisition must not leave a partial namespace behind",
  );

  // (d) A URL that cannot be imported at all — the served-page case — arrives
  // as a refusal, not as a TypeError raised by whoever reads the global next.
  await assert.rejects(
    () =>
      acquireCesiumNamespace(
        executingPage(log),
        "data:text/javascript;base64,%%%not-base64%%%",
      ),
    (error) => {
      assert.equal(error.reason, "cesium-namespace-unavailable");
      assert.equal(error.details.outcome.source, "import-failed");
      return true;
    },
  );
});

test("B9. a namespace missing Cartesian3 or Math is refused, not accepted", async (t) => {
  // MELILOT'S MUTANT, PINNED (review of 0e91da49, finding F-1). The first cut
  // of `complete()` guarded only `JulianDate` and `SceneTransforms` — the two
  // names that happen to be read FIRST. A namespace carrying those two but no
  // `Cartesian3` was therefore ACCEPTED, and then `pageMeasureRung`
  // (`Cesium.Cartesian3.fromDegrees`, `Cesium.Math.PI_OVER_TWO`, :149) died one
  // evaluate later with the exact "Cannot read properties of undefined" exit-2
  // shape this patch exists to eliminate. The guard must cover every name the
  // page functions read, and the refusal must say which one is missing.
  const had = Object.hasOwn(globalThis, "Cesium");
  const previous = globalThis.Cesium;
  t.after(() => {
    if (had) {
      globalThis.Cesium = previous;
    } else {
      delete globalThis.Cesium;
    }
  });
  delete globalThis.Cesium;

  const log = { calls: [] };
  const exports = {
    JulianDate: "export const JulianDate = {};",
    Cartesian3: "export const Cartesian3 = {};",
    Math: "export const Math = {};",
    SceneTransforms: "export const SceneTransforms = {};",
  };
  for (const missing of Object.keys(exports)) {
    const sourceText = Object.entries(exports)
      .filter(([name]) => name !== missing)
      .map(([, text]) => text)
      .join("\n");
    await assert.rejects(
      () =>
        acquireCesiumNamespace(executingPage(log), moduleUrlFor(sourceText)),
      (error) => {
        assert.equal(error.reason, "cesium-namespace-unavailable");
        assert.equal(error.exitCode, PROBE_EXIT_CODES.REFUSAL);
        assert.equal(error.details.outcome.source, "module-incomplete");
        // The refusal names the symbol that is absent, so the reader is not
        // sent back to an Edge slot to find out which half failed.
        assert.match(error.details.outcome.reason, new RegExp(missing));
        return true;
      },
      `a namespace without ${missing} must refuse`,
    );
    assert.equal(
      globalThis.Cesium,
      undefined,
      `${missing}: a refused acquisition left a namespace on the page`,
    );
  }
});

test("B5. the probe stays off the lifecycle path until C13-42a-3 item 8 lands", () => {
  // Adopting `workBudgetMs` today routes this probe through a runtime with a
  // filed hole that silently drops work and reports success. The plan sequences
  // item 8 before ANY probe migration for exactly that reason, so the absence
  // is a decision and this is where it is recorded.
  assert.equal(
    Object.hasOwn(ladderDescriptor, "workBudgetMs"),
    false,
    "the ladder adopted the lifecycle path; confirm C13-42a-3 item 8 has landed first",
  );
  const source = readFileSync(PROBE_PATH, "utf8").replace(/\r\n/g, "\n");
  assert.match(
    source,
    /C13-42a-3` item 8/,
    "the reason for the absence is not written down",
  );
  assert.equal(ladderDescriptor.name, "cloud-orbital-ladder");
  assert.match(ladderDescriptor.title, /C13-N04b/);
});

// ===========================================================================
// D. The march-mechanism preflight's arms and its far-sweep reduction
//
// WHY THIS PROBE'S CASES LIVE IN THIS FILE. Both runners in `package.json` are
// explicit `node --test <file list>`, so a new spec file does not execute
// until the SEAT unions it in, and this batch's one owed union is already
// spent on `radial-banding.spec.mjs`. This file is the cloud-probe contract
// home in the same runner — it already drives a probe descriptor against a
// stub before an Edge slot is spent on it — so a second probe's contract
// belongs here rather than in a file nothing runs.
//
// EVERY CASE ASSERTS A RETURNED VALUE. The arm table is data, the far sweep is
// arithmetic, and the descriptor's receipt and summary are functions; all four
// are exercised, none is grepped.
// ===========================================================================

test("D1. every arm changes exactly one dial, and the non-capturing arm is last", () => {
  const sets = armDialSets();
  assert.ok(sets.length > 8, "the arm table collapsed");
  for (const set of sets) {
    assert.equal(
      Object.keys(set.dial).length,
      set.armId === "M0" ? 0 : 1,
      `${set.label} changes ${Object.keys(set.dial).length} dials; one arm, one dial`,
    );
    assert.ok(MECHANISM_ARM_IDS.includes(set.armId), set.label);
    assert.equal(typeof armById(set.armId).decides, "string");
  }
  // The baseline is first and changes nothing at all.
  assert.equal(sets[0].armId, "M0");
  assert.deepEqual(sets[0].dial, {});
  // The single-sample arm is last and captures nothing: it is expected to
  // raise a device validation error, and a device in an error state must not
  // be able to contaminate a capture taken after it.
  const last = sets[sets.length - 1];
  assert.equal(last.armId, "M2");
  assert.equal(last.capturesNothing, true);
  assert.equal(armById("M2").captures, false);
  assert.equal(typeof armById("M2").confirms, "string");
  assert.equal(
    sets.filter((set) => set.capturesNothing === true).length,
    1,
    "more than one arm declines to capture",
  );

  // The veto arm and the positive arm are different arms, which is the
  // inference error the table exists to prevent.
  assert.equal(armById("M1").veto, true);
  assert.equal(armById("M1").positive, undefined);
  assert.equal(armById("M6").positive, true);
  assert.equal(armById("M6").stopCondition, true);
  assert.throws(() => armById("M99"));

  // The far sweep carries its own reference row, or nothing downstream of it
  // can be predicted.
  const far = sets.filter((set) => set.armId === "M6");
  assert.ok(far.length >= 3, "the far sweep is too short to separate anything");
  assert.equal(
    far.filter((set) => set.dial.farMultiplier === 1).length,
    1,
    "the far sweep has no reference row",
  );
});

test("D2. the predicted period scales with the frustum's own log-depth scale", () => {
  // `log2(far - near + 1)`: the constant the shader's depth inverse multiplies
  // by, and therefore the constant a fixed-mantissa quantum scales with.
  assert.ok(Math.abs(logDepthScale(1, 1e8) - Math.log2(1e8)) < 1e-12);
  assert.throws(() => logDepthScale(1, 1));
  assert.throws(() => logDepthScale(Number.NaN, 1e8));

  // A four-fold far at Cesium's default frustum is two more octaves on the
  // scale, so the predicted period rises by 2 / log2(far - near + 1).
  const referenceNear = 1;
  const referenceFar = 5e8;
  const base = logDepthScale(referenceNear, referenceFar);
  const four = predictedPeriod({
    referencePeriod: 0.010924,
    referenceNear,
    referenceFar,
    near: referenceNear,
    far: 4 * referenceFar,
  });
  assert.ok(
    Math.abs(four / 0.010924 - (base + 2) / base) < 1e-9,
    "a four-fold far is not two octaves on the scale",
  );
  // And the shift is large against a one-to-two per cent onset ladder: this
  // is what makes the arm decisive rather than suggestive.
  assert.ok(four / 0.010924 - 1 > 0.05);
  const sixteen = predictedPeriod({
    referencePeriod: 0.010924,
    referenceNear,
    referenceFar,
    near: referenceNear,
    far: 16 * referenceFar,
  });
  assert.ok(sixteen > four, "a larger far must predict a longer period");
  assert.throws(() =>
    predictedPeriod({
      referencePeriod: 0,
      referenceNear,
      referenceFar,
      near: referenceNear,
      far: referenceFar,
    }),
  );
});

test("D3. the far sweep separates a family that tracks the frustum from one that ignores it", () => {
  const near = 1;
  const far = 5e8;
  const reference = {
    multiplier: 1,
    nearMetres: near,
    farMetres: far,
    lnZSpacingMean: 0.010924,
  };
  const trackingRows = [reference];
  const ignoringRows = [reference];
  for (const multiplier of [0.25, 4, 16]) {
    const predicted = predictedPeriod({
      referencePeriod: reference.lnZSpacingMean,
      referenceNear: near,
      referenceFar: far,
      near,
      far: far * multiplier,
    });
    trackingRows.push({
      multiplier,
      nearMetres: near,
      farMetres: far * multiplier,
      lnZSpacingMean: predicted,
    });
    // The refuting shape: the period does not move at all.
    ignoringRows.push({
      multiplier,
      nearMetres: near,
      farMetres: far * multiplier,
      lnZSpacingMean: reference.lnZSpacingMean,
    });
  }

  const tracking = evaluateFarSweep(trackingRows);
  assert.equal(tracking.verdict, "consistent");
  assert.equal(tracking.stop, false);
  assert.ok(Math.abs(tracking.worst.residual) < 1e-9);

  const ignoring = evaluateFarSweep(ignoringRows);
  assert.equal(ignoring.verdict, "inconsistent");
  // THE STOP CONDITION: the recorded frustum and the measured period disagree,
  // so no engine change is briefed until somebody has read the write/inverse
  // pair.
  assert.equal(ignoring.stop, true);
  assert.match(ignoring.reason, /worst residual/);

  // A sweep with a missing readout is UNMEASURED, never a refutation: a leg
  // that recorded nothing has not refuted anything.
  const partial = trackingRows.map((row, index) =>
    index === 2 ? { ...row, farMetres: null } : row,
  );
  const unmeasured = evaluateFarSweep(partial);
  assert.equal(unmeasured.verdict, "unmeasured");
  assert.equal(unmeasured.stop, false);
  assert.equal(evaluateFarSweep([]).verdict, "unmeasured");
  assert.equal(evaluateFarSweep([reference]).verdict, "unmeasured");
  assert.equal(
    evaluateFarSweep([{ ...reference, multiplier: 4 }, trackingRows[1]])
      .verdict,
    "unmeasured",
    "a sweep with no multiplier-1 row has no reference period",
  );

  // The tolerance is the caller's, and one wide enough swallows the
  // refutation — which is why the leg has to state the one it used.
  assert.equal(
    evaluateFarSweep(ignoringRows, { tolerance: 1 }).verdict,
    "consistent",
  );
});

test("D4. the mechanism descriptor is executable, reports no verdict, and carries the recipe camera", async () => {
  assert.equal(mechanismDescriptor.name, "cloud-march-mechanism");
  assert.equal(mechanismDescriptor.receiptEnvelope, "probe-owned");
  assert.equal(typeof mechanismDescriptor.cells, "function");
  // NO VERDICTS, BY RULING: this leg is a look and the numbers decide the
  // branch afterwards in Node.
  assert.equal(
    Object.hasOwn(mechanismDescriptor, "verdicts"),
    false,
    "the mechanism preflight grew a verdict; it is a look, not a gate",
  );
  // It stays off the lifecycle path for the same reason the ladder does.
  assert.equal(Object.hasOwn(mechanismDescriptor, "workBudgetMs"), false);
  // The served-artifact list names the module the page actually imports.
  assert.ok(
    mechanismDescriptor.servedArtifacts.includes(
      "Build/CesiumUnminified/index.js",
    ),
  );

  // The receipt and the summary are functions, so they are RUN rather than
  // read: a synthetic cell goes in and a table comes out.
  const cells = [
    {
      rig: "orbital-fulldisc-6608km",
      arms: armDialSets().map((set) => ({
        ...set,
        png: set.capturesNothing === true ? null : `${set.label}.png`,
        measurement: {
          frustum: { near: 1, far: 5e8 },
          cloudPlanes: { nearPlane: 1, farPlane: 5e8 },
          depthTexture: { format: "r16float", msaaSamples: 4 },
          realization: { primarySteps: 96 },
        },
      })),
    },
  ];
  const receipt = mechanismDescriptor.receipt(cells, {
    origin: "http://localhost:9999",
  });
  assert.equal(receipt.rig, "orbital-fulldisc-6608km");
  assert.equal(receipt.camera.height, 6608426.573306667);
  assert.equal(receipt.disc.discRadiusPixels, 1000);
  assert.deepEqual(receipt.farMultipliers.slice(0, 1), [1]);
  const summary = mechanismDescriptor.summary(receipt);
  assert.match(summary, /No verdict\./);
  assert.match(summary, /r16float/);
  for (const id of MECHANISM_ARM_IDS) {
    assert.ok(summary.includes(`| ${id}`), `${id} missing from the summary`);
  }

  // And the namespace guard refuses BY NAME against an injected page double
  // rather than dying one evaluate later on a property access.
  const refusingPage = {
    evaluate: async () => ({ ok: false, reason: "no module" }),
  };
  await assert.rejects(
    () => acquireMechanismNamespace(refusingPage),
    (error) => {
      assert.equal(error.name, "ProbeRefusal");
      assert.equal(error.reason, "cesium-namespace-unavailable");
      assert.equal(error.exitCode, PROBE_EXIT_CODES.REFUSAL);
      return true;
    },
  );
  const acceptingPage = {
    evaluate: async () => ({ ok: true, source: "module", moduleUrl: "x" }),
  };
  assert.equal((await acquireMechanismNamespace(acceptingPage)).ok, true);
});

// ===========================================================================
// D5-D12. The page-side arm isolation and the probe's own loop, EXECUTED
//
// WHY THESE EXIST AND WHAT THEY REPLACE. The first freeze of this leg shipped
// `pageBuildScene`/`pageRunArm` inline in the probe behind a `c8 ignore` block,
// and D1-D4 covered the arm TABLE, the far-sweep arithmetic, the descriptor and
// the namespace guard — everything except the code that mutates the scene. Two
// reviewers independently found three defects in that uncovered block: the
// build step handed the cloud harness the rig's globe dials and threw before
// the first arm; no arm restored anything, so `M1`'s hidden globe and `M3`'s
// ellipsoid terrain persisted into the positive arm; and the far multipliers
// compounded so the row labelled x4 rendered the reference frustum.
//
// The functions now live in `lib/cloud-march-mechanism.mjs`, so these cases
// EXECUTE them — against a fake viewer with the REAL cloud harness installed
// over it, so the refusals asserted below are the refusals the page produces.
// `page.evaluate` serialises a function's source, so what runs here and what
// runs on Edge are the same text.
//
// THE DOUBLE IS BUILT FROM THE ENGINE, BECAUSE THE HAND-WRITTEN ONE CERTIFIED
// THE BRIEF. Round two returned this file and found three more defects of ONE
// kind, and the fake is why all three survived: it was written from the same
// reading of the engine that produced the page-side code, so every case over
// it agreed with the code about a scene the engine does not have. It had no
// `enabled` key, so a snapshot-restore collision that THROWS on every real
// clouds-OFF frame was invisible; its `enableVolumetric` was a plain data
// property rather than the accessor pair that causes the collision; it
// INVENTED `scene.postProcessStages.godRays`, a member `git grep godRays`
// over `packages/engine/Source` does not find, so M7's silent no-op passed;
// and it set `_cloudCache: null`, so nothing looked at the cache field names
// and the probe read `counters` where the engine publishes `observability`.
//
// So nothing below is transcribed:
//
//   * the volumetric config IS `new CloudVolumetrics()` — the real class, real
//     defaults, all 55 own properties, imported at the top of this file;
//   * the collection's `enableVolumetric` accessor pair is EXTRACTED from the
//     tracked `CloudCollection.js` and closed over the REAL `CloudRenderMode`,
//     so the double's gate semantics are the engine's bytes. The extraction
//     THROWS if the accessor moves or changes shape, which is the drift alarm;
//   * every scene member the page-side code reads or writes is asserted to
//     EXIST in the engine by D11a, against the real class or against the
//     tracked source file that declares it. An arm whose dial does not exist
//     fails that case rather than running silently.
// ===========================================================================

const ENGINE_SOURCE_DIRECTORY = path.join(
  HERE,
  "..",
  "..",
  "packages/engine/Source",
);

/** Read one tracked engine source file, newline-normalised. */
function engineSource(relativePath) {
  return readFileSync(
    path.join(ENGINE_SOURCE_DIRECTORY, relativePath),
    "utf8",
  ).replaceAll("\r\n", "\n");
}

/**
 * The REAL `CloudCollection.enableVolumetric` accessor pair, lifted out of the
 * tracked engine file and closed over the real `CloudRenderMode`.
 *
 * `CloudCollection.js` cannot be imported under `node --test` — it pulls in a
 * generated shader module — so this is the closest thing to importing it:
 * the getter and setter BODIES are the engine's own text, compiled as a
 * MODULE that imports the real `CloudRenderMode` from its own file, exactly
 * the way `importMutatedLadderModel` above compiles the model. The extraction
 * fails loudly if either accessor is renamed, reordered or reshaped; a
 * transcription would not, and a transcription is what let R2-1 through.
 * Reginard's own suggested fix for it retyped the enum as
 * `BILLBOARD = 1` / `VOLUMETRIC = 2` against the engine's 0 / 1
 * (`CloudRenderMode.js`) — the same failure, one layer down, in the fix for
 * it. Nothing here retypes anything.
 *
 * @returns {Promise<object>} The `enableVolumetric` property descriptor.
 */
async function engineEnableVolumetricDescriptor() {
  const source = engineSource("Scene/CloudCollection.js");
  const pair =
    /\n {2}get enableVolumetric\(\) \{\n([\s\S]*?)\n {2}\}\n\n {2}set enableVolumetric\(value\) \{\n([\s\S]*?)\n {2}\}\n/.exec(
      source,
    );
  assert.ok(
    pair !== null,
    "CloudCollection.enableVolumetric's accessor pair could not be extracted; " +
      "the double below would silently stop being the engine's semantics",
  );
  // The two clauses this double exists to reproduce, asserted on the extracted
  // text rather than assumed: the getter is a conjunction over the render mode
  // AND `volumetric.enabled`, and the setter WRITES `volumetric.enabled` — the
  // write that collides with a snapshot restore in the same `configure` call.
  assert.match(pair[1], /this\.volumetric\.enabled === true/);
  assert.match(pair[2], /this\.volumetric\.enabled = on;/);
  const enumUrl = new URL(
    "../../packages/engine/Source/Scene/CloudRenderMode.js",
    import.meta.url,
  ).href;
  const module = `import CloudRenderMode from "${enumUrl}";
export const holder = {
  get enableVolumetric() {${pair[1]}},
  set enableVolumetric(value) {${pair[2]}},
};
`;
  const compiled = await import(
    `data:text/javascript;base64,${Buffer.from(module).toString("base64")}`
  );
  return Object.getOwnPropertyDescriptor(compiled.holder, "enableVolumetric");
}

const ENGINE_ENABLE_VOLUMETRIC = await engineEnableVolumetricDescriptor();

/** The REAL `CloudVolumetrics`, with the engine's own defaults. */
function fakeVolumetric() {
  return new CloudVolumetrics();
}

/**
 * A collection whose `enableVolumetric` is the ENGINE's accessor pair and
 * whose `renderMode` carries the engine's own enum values.
 *
 * The first double made `enableVolumetric` a plain data property, so writing
 * it touched nothing and the round-trip collision that ends a real run could
 * not be reached from any case (Reginard R2-1, Sigismond R4).
 *
 * @param {object} volumetric The collection's `CloudVolumetrics`.
 * @returns {object} The double.
 */
function fakeCloudCollection(volumetric) {
  const collection = {
    volumetric,
    _renderMode: CloudRenderMode.BILLBOARD,
    get renderMode() {
      return this._renderMode;
    },
    set renderMode(value) {
      this._renderMode = value;
    },
  };
  Object.defineProperty(collection, "enableVolumetric", {
    ...ENGINE_ENABLE_VOLUMETRIC,
    enumerable: true,
    configurable: true,
  });
  return collection;
}

class FakeCesiumTerrainProvider {}
class FakeEllipsoidTerrainProvider {}

/**
 * A fake page: `viewer`, `Cesium` and a `requestAnimationFrame`, with the REAL
 * `installCloudProbeHarness` installed over them.
 *
 * The harness is the real one on purpose. Its refusal path — "unknown
 * CloudVolumetrics property X", and a THROW rather than a returned flag — is
 * the behaviour two of the three defects turned on, and a hand-written double
 * of it would have been written from the same reading that produced the bug.
 */
function installFakePage() {
  const renders = [];
  const views = [];
  const volumetric = fakeVolumetric();
  const scene = {
    requestRenderMode: true,
    msaaSamples: 4,
    logarithmicDepthBuffer: true,
    globe: {
      show: true,
      baseColor: null,
      enableLighting: true,
      showWaterEffect: true,
      maximumScreenSpaceError: 2,
      terrainProvider: new FakeCesiumTerrainProvider(),
      defaultCloudCollection: fakeCloudCollection(volumetric),
    },
    imageryLayers: {
      length: 3,
      removeAll() {
        this.length = 0;
      },
    },
    // The log-depth frustum `Scene.js:1477-1478` pins when the log depth
    // buffer is on, which is the frustum the cloud pass packs.
    camera: {
      frustum: { near: 0.1, far: 10000000000 },
      setView(options) {
        views.push(options);
      },
    },
    // THE REAL `PostProcessStageCollection` MEMBER SET, AND IT HAS NO
    // `godRays`. `scene.postProcessStages` is upstream's collection
    // (`Scene.js:1214`); the fork's god-ray enable is the scene expando
    // `scene.godRayEnabled` (`WebGPUPostProcessStageCollection.ts:456-457`)
    // and the cloud-aware coupling is `scene.godRayCloudAware`
    // (`WebGPUSceneRendererPostFrustumChain.ts:213-219`). The first double
    // invented `postProcessStages.godRays`, so M7's silently-guarded no-op
    // passed section D (Reginard R2-2, Sigismond R5). D11a asserts the
    // absence against the engine's own file rather than against this comment.
    postProcessStages: {
      ready: true,
      fxaa: { enabled: false },
      ambientOcclusion: { enabled: false },
      bloom: { enabled: false },
      length: 0,
      tonemapper: 0,
      exposure: 1,
    },
    godRayEnabled: false,
    godRayCloudAware: false,
    // The realised-effect readback path the tracked
    // `lib/c13-42-reproduction-harness.mjs` uses (`:988`). `addGodRay` runs
    // lazily inside the post-process pipeline, so this double models the
    // laziness: the effect appears only once a frame has been rendered with
    // the flag set, which is what makes `requested` and `realized` different
    // facts rather than the same one twice.
    _alternateSceneRenderer: { postProcessPipeline: { godRayEffect: null } },
    context: {
      rendererType: "webgpu",
      isWebGPU: true,
      // THE REAL CACHE FIELD NAMES. `CloudCache` publishes `observability`, a
      // `CloudFrameCounters` (`WebGPUProceduralCloudRenderer.ts:802`);
      // `counters` is the per-attempt local assigned INTO it at `:3283` and
      // is not a cache field at all, and neither is `qualityFlags` — that is
      // uniform slot 74 (`:3659`). The first double set `_cloudCache: null`,
      // so no case ever looked at a field name and the probe's whole
      // realization block read null on a leg that had rendered (R2-3).
      _cloudCache: {
        initialized: true,
        pipeline: {},
        frameCounter: 7,
        weatherTexture: null,
        observability: {
          maxSteps: 96,
          lightSteps: 8,
          marchWidth: 1024,
          marchHeight: 1024,
          marchPixels: 1048576,
          halfResActive: 1,
          primarySampleBudget: 100663296,
          lightSampleBudget: 805306368,
          weatherUploads: 0,
          weatherUploadBytes: 0,
          weatherCacheHits: 3,
          weatherCacheMisses: 0,
          weatherLiveBytes: 0,
        },
        // Slots 44 / 45 / 74 are the packed step counts and the quality
        // bitfield (`:3576`, `:3577`, `:3659`); 105 / 106 are the frustum
        // planes the cloud pass packs (`:3780-3781`). `qualityFlags` 12601 is
        // the tier-3 value the recipe's Qmedium confound row quotes.
        uniformData: (() => {
          const data = new Float32Array(140);
          data[44] = 96;
          data[45] = 8;
          data[74] = 12601;
          data[105] = 0.1;
          data[106] = 10000000000;
          return data;
        })(),
      },
    },
    render() {
      renders.push(scene.camera.frustum.far);
      // Lazy initialisation, modelled: `updatePostProcessCache` reads the
      // scene flag and only then does `pipeline.addGodRay(...)` run
      // (`WebGPUPostProcessStageCollection.ts:456-457`, `:1016`).
      if (scene.godRayEnabled === true) {
        scene._alternateSceneRenderer.postProcessPipeline.godRayEffect = {
          enabled: true,
        };
      }
    },
  };
  const viewer = {
    scene,
    useDefaultRenderLoop: true,
    clock: { shouldAnimate: true, currentTime: null },
  };
  const previous = {
    viewer: globalThis.viewer,
    Cesium: globalThis.Cesium,
    cloudProbe: globalThis.__cloudProbe,
    raf: globalThis.requestAnimationFrame,
    terrain: globalThis.__mechanismBaselineTerrain,
  };
  globalThis.viewer = viewer;
  globalThis.Cesium = {
    JulianDate: { fromIso8601: (iso) => ({ iso }) },
    Cartesian3: { fromDegrees: (lon, lat, height) => ({ lon, lat, height }) },
    Color: {
      fromCssColorString: (css) => ({ toCssColorString: () => css }),
    },
    EllipsoidTerrainProvider: FakeEllipsoidTerrainProvider,
  };
  globalThis.requestAnimationFrame = (callback) => {
    callback(0);
    return 0;
  };
  globalThis.__mechanismBaselineTerrain = undefined;
  installCloudProbeHarness();
  return {
    scene,
    viewer,
    volumetric,
    renders,
    views,
    restore() {
      globalThis.viewer = previous.viewer;
      globalThis.Cesium = previous.Cesium;
      globalThis.__cloudProbe = previous.cloudProbe;
      globalThis.requestAnimationFrame = previous.raf;
      globalThis.__mechanismBaselineTerrain = previous.terrain;
    },
  };
}

/** The scene state an arm actually rendered, read off the fake. */
function sceneState(page) {
  return {
    globeShow: page.scene.globe.show,
    terrain: page.scene.globe.terrainProvider.constructor.name,
    mSSE: page.scene.globe.maximumScreenSpaceError,
    far: page.scene.camera.frustum.far,
    near: page.scene.camera.frustum.near,
    msaa: page.scene.msaaSamples,
    cloudQuality: page.volumetric.cloudQuality,
    godRays: page.scene.godRayEnabled,
    godRayCloudAware: page.scene.godRayCloudAware,
    enableVolumetric: page.scene.globe.defaultCloudCollection.enableVolumetric,
  };
}

/**
 * Drive the whole leg over a fake page and return what each arm rendered.
 *
 * @param {object} [options] `runArm`/`buildScene` override the shipped
 *   functions, which is how the mutants below are driven through the same
 *   harness as the real ones.
 * @returns {Promise<object>} `{page, scene, states}`.
 */
async function runEveryArm(options = {}) {
  const build = options.buildScene ?? pageBuildScene;
  const run = options.runArm ?? pageRunArm;
  const page = installFakePage();
  try {
    const scene = await build({
      clock: MECHANISM_RIG.clock,
      dials: MECHANISM_RIG.dials,
    });
    const states = [];
    const measurements = [];
    for (const set of armDialSets()) {
      const measurement = await run({
        camera: MECHANISM_RIG.camera,
        baseline: scene.baseline,
        cloudDials: scene.cloudDials,
        dial: set.dial,
        settleFrames: 1,
        cloudsOn: true,
      });
      measurements.push({ label: set.label, armId: set.armId, measurement });
      states.push({ label: set.label, armId: set.armId, ...sceneState(page) });
    }
    return { page, scene, states, measurements };
  } finally {
    page.restore();
  }
}

test("D5. the build step reaches the harness with the cloud dials only, and banks a restorable baseline", async () => {
  const page = installFakePage();
  try {
    // THE INPUT THAT KILLED THE FIRST DRAFT: the rig's dial block carries four
    // globe keys beside its seven cloud keys, and `configure` THROWS on any key
    // that is not a `CloudVolumetrics` property. Handing it the whole block
    // ends the run before arm M0.
    assert.throws(
      () =>
        globalThis.__cloudProbe.configure({
          requireWebGPU: true,
          enableVolumetric: true,
          volumetric: MECHANISM_RIG.dials,
        }),
      /unknown CloudVolumetrics property globeBaseColor/,
      "the harness's refusal moved; this case's premise is gone",
    );

    const scene = await pageBuildScene({
      clock: MECHANISM_RIG.clock,
      dials: MECHANISM_RIG.dials,
    });
    assert.equal(scene.ok, true);
    assert.equal(scene.renderLoopDisabled, true);
    assert.equal(scene.truth.ok, true);
    // The split is by prefix, and every key is accounted for either way.
    assert.deepEqual(Object.keys(scene.globeDials).sort(), [
      "globeBaseColor",
      "globeEnableLighting",
      "globeShowWaterEffect",
      "removeImageryLayers",
    ]);
    assert.deepEqual(scene.unappliedGlobeDials, []);
    assert.equal(
      Object.keys(scene.cloudDials).length +
        Object.keys(scene.globeDials).length,
      Object.keys(MECHANISM_RIG.dials).length,
    );
    // The globe half was applied HERE rather than dropped.
    assert.equal(page.scene.globe.baseColor.toCssColorString(), "rgb(0,0,0)");
    assert.equal(page.scene.globe.enableLighting, false);
    assert.equal(page.scene.imageryLayers.length, 0);
    assert.equal(scene.imageryLayersRemoved, 3);
    // And the cloud half round-tripped onto the collection.
    assert.equal(page.volumetric.cloudCoverage, 0.6);
    assert.equal(page.volumetric.cloudVolumetricQuality, "high");

    // THE BASELINE COVERS EVERY DIAL AN ARM CAN DRIVE. This is the mechanical
    // guard against the residual half of the restore bug: `cloudQuality` is
    // driven by M4 and stated by no rig, so a restore over the rig's keys alone
    // would leave every later arm at the raw escape hatch.
    for (const set of armDialSets()) {
      for (const key of Object.keys(set.dial.volumetric ?? {})) {
        assert.ok(
          scene.baseline.coveredCloudKeys.includes(key),
          `arm ${set.label} drives ${key}, which the baseline does not restore`,
        );
      }
    }
    assert.equal(scene.baseline.globeShow, true);
    assert.equal(scene.baseline.far, 10000000000);
    assert.equal(scene.baseline.near, 0.1);
    assert.equal(scene.baseline.terrainProvider, "FakeCesiumTerrainProvider");

    // An unknown globe dial is REPORTED, not silently dropped.
    const withStray = await pageBuildScene({
      clock: MECHANISM_RIG.clock,
      dials: { ...MECHANISM_RIG.dials, globeSomethingElse: 1 },
    });
    assert.equal(withStray.ok, false);
    assert.deepEqual(withStray.unappliedGlobeDials, ["globeSomethingElse"]);
  } finally {
    page.restore();
  }
});

test("D6. every arm renders the baseline plus exactly its own dial", async () => {
  const { states, scene, measurements } = await runEveryArm();
  assert.equal(states.length, armDialSets().length);
  const base = scene.baseline;

  // EVERY DIAL TOOK, READ BACK OFF THE SCENE. This is the clause that turns a
  // dial written to a property the engine does not have into a failure rather
  // than a silent no-op: `pageRunArm` reads each dial back and reports
  // `applied`, and an arm that reports false is refused by the probe instead
  // of banked. Asserted for EVERY arm, not just for M7, because the defect
  // class is "a dial nobody checked", not "the god-ray dial".
  for (const entry of measurements) {
    assert.equal(
      entry.measurement.dialsApplied,
      true,
      `${entry.label} did not apply its dial: ${JSON.stringify(entry.measurement.unappliedDials)}`,
    );
    const expectedDialCount =
      entry.armId === "M0"
        ? 0
        : entry.armId === "M7"
          ? 2 // the enable and the cloud-aware coupling, both real flags
          : 1;
    assert.equal(
      entry.measurement.dialReports.length,
      expectedDialCount,
      `${entry.label} reported ${entry.measurement.dialReports.length} dials`,
    );
    for (const report of entry.measurement.dialReports) {
      assert.equal(report.reason, null, `${entry.label}: ${report.reason}`);
    }
  }

  for (const state of states) {
    // THE VETO IS ONE ARM. Every other arm must render with the globe DRAWN,
    // because a hidden globe makes the march's depth guard false and the
    // occlusion clamp under test unreachable — including M6, the positive arm,
    // whose whole claim is a number taken with the globe on screen.
    assert.equal(
      state.globeShow,
      state.label === "M1" ? false : true,
      `${state.label} rendered with globe.show = ${state.globeShow}`,
    );
    // The ellipsoid provider belongs to one arm and must not leak into the two
    // screen-space-error legs, whose claim is about TESSELLATION.
    assert.equal(
      state.terrain,
      state.label === "M3-ellipsoid"
        ? "FakeEllipsoidTerrainProvider"
        : "FakeCesiumTerrainProvider",
      `${state.label} rendered on ${state.terrain}`,
    );
    const expectedSse =
      state.label === "M3-sse2"
        ? 2
        : state.label === "M3-sse32"
          ? 32
          : base.maximumScreenSpaceError;
    assert.equal(state.mSSE, expectedSse, `${state.label} mSSE`);
    const expectedQuality =
      state.armId === "M4" ? Number(state.label.slice(4)) : 64;
    assert.equal(
      state.cloudQuality,
      expectedQuality,
      `${state.label} rendered at cloudQuality ${state.cloudQuality}`,
    );
    // BOTH god-ray flags, and they are scene expandos rather than members of
    // `postProcessStages`. The arm is named "cloud-aware god rays": the cloud
    // pass only publishes its transmittance mask when the effect is enabled
    // AND `scene.godRayCloudAware` is set, so driving the enable alone would
    // bank a different picture from the one M7's label claims.
    assert.equal(
      state.godRays,
      state.label === "M7-godrays",
      `${state.label} god rays`,
    );
    assert.equal(
      state.godRayCloudAware,
      state.label === "M7-godrays",
      `${state.label} cloud-aware god rays`,
    );
    assert.equal(
      state.msaa,
      state.label === "M2-msaa1" ? 1 : base.msaaSamples,
      `${state.label} msaa`,
    );
    assert.equal(state.near, base.near, `${state.label} near moved`);
  }

  // THE FAR SWEEP IS TAKEN AGAINST THE BASELINE, so its rows are 1 / 0.25 / 4 /
  // 16 of one reference rather than a running product. Compounding realises
  // F, 0.25F, F, 16F and the row labelled x4 measures the reference frustum.
  const sweep = states.filter((state) => state.armId === "M6");
  assert.deepEqual(
    sweep.map((state) => state.far / base.far),
    [1, 0.25, 4, 16],
  );
  // And every arm that is NOT the sweep renders the reference far.
  for (const state of states.filter((entry) => entry.armId !== "M6")) {
    assert.equal(state.far, base.far, `${state.label} far`);
  }
});

test("D6b. a dial the scene does not take is REPORTED as unapplied, by name", async () => {
  // THE CASE MY OWN INERTNESS MUTANT DEMANDED. Seven mutants of this batch's
  // three engine-shape fixes die against D6 and D8, but an eighth —
  // `applied = true || (…)` inside `reportDial`, the check made INERT rather
  // than deleted — survived them all, because every arm on the faithful page
  // applies. A readback nothing ever sees fail is a readback that proves
  // nothing. So this case builds the exact shape the defect had: a scene that
  // ACCEPTS the write and does not keep it.
  const page = installFakePage();
  try {
    // `scene.godRayEnabled` as a write-swallowing accessor. This is not a
    // hypothetical: it is the observable behaviour of the property the first
    // draft drove. `scene.postProcessStages.godRays` does not exist, so
    // `collection?.godRays` was false, the assignment never ran, and the
    // scene read back exactly what it read back before — which is what this
    // getter reproduces without needing the absent member.
    let swallowed = null;
    Object.defineProperty(page.scene, "godRayEnabled", {
      get() {
        return false;
      },
      set(value) {
        swallowed = value;
      },
      configurable: true,
    });
    const scene = await pageBuildScene({
      clock: MECHANISM_RIG.clock,
      dials: MECHANISM_RIG.dials,
    });
    const measurement = await pageRunArm({
      camera: MECHANISM_RIG.camera,
      baseline: scene.baseline,
      cloudDials: scene.cloudDials,
      dial: { godRays: true },
      settleFrames: 1,
      cloudsOn: true,
    });

    assert.equal(swallowed, true, "the arm never even attempted the write");
    assert.equal(
      measurement.dialsApplied,
      false,
      "a dial the scene swallowed was reported as applied",
    );
    const report = measurement.dialReports.find(
      (entry) => entry.dial === "godRayEnabled",
    );
    assert.equal(report.requested, true);
    assert.equal(report.observed, false);
    assert.equal(report.applied, false);
    assert.match(report.reason, /wrote true, read back false/);
    assert.deepEqual(measurement.unappliedDials, [
      "godRayEnabled: wrote true, read back false",
    ]);
    // The cloud-aware half is a separate property and DID take, so the report
    // is per dial rather than per arm: the receipt says which one failed.
    const cloudAware = measurement.dialReports.find(
      (entry) => entry.dial === "godRayCloudAware",
    );
    assert.equal(cloudAware.applied, true);
    // And the arm still returns a measurement rather than throwing — the
    // REFUSAL is the probe's (D12b), so the receipt can carry the evidence of
    // what went wrong instead of an opaque browser error.
    assert.equal(measurement.godRay.requested, false);
    assert.equal(measurement.godRay.cloudAware, true);
  } finally {
    delete page.scene.godRayEnabled;
    page.restore();
  }
});

test("D6c. a dial whose readback THROWS is unapplied with the throw as its reason", async () => {
  const page = installFakePage();
  try {
    // The readback throws ONCE — on the read `reportDial` makes immediately
    // after the write — and behaves afterwards, which is the shape of a getter
    // that depends on state the arm has just invalidated. The report has to
    // CARRY the throw rather than let it end the run: the probe's named
    // refusal (D12b) is what ends the run, and it needs the reason to print.
    let stored = 2;
    let armed = false;
    Object.defineProperty(page.scene.globe, "maximumScreenSpaceError", {
      get() {
        if (armed) {
          armed = false;
          throw new TypeError("terrain provider is not ready");
        }
        return stored;
      },
      set(value) {
        stored = value;
        armed = value === 32;
      },
      configurable: true,
    });
    const scene = await pageBuildScene({
      clock: MECHANISM_RIG.clock,
      dials: MECHANISM_RIG.dials,
    });
    const measurement = await pageRunArm({
      camera: MECHANISM_RIG.camera,
      baseline: scene.baseline,
      cloudDials: scene.cloudDials,
      dial: { maximumScreenSpaceError: 32 },
      settleFrames: 1,
      cloudsOn: true,
    });
    assert.equal(measurement.dialsApplied, false);
    const report = measurement.dialReports[0];
    assert.equal(report.dial, "maximumScreenSpaceError");
    assert.equal(report.observed, null);
    assert.match(report.reason, /terrain provider is not ready/);
  } finally {
    delete page.scene.globe.maximumScreenSpaceError;
    page.restore();
  }
});

test("D7. an arm whose dial is not a CloudVolumetrics property refuses instead of banking a capture", async () => {
  const page = installFakePage();
  try {
    const scene = await pageBuildScene({
      clock: MECHANISM_RIG.clock,
      dials: MECHANISM_RIG.dials,
    });
    // THE STRUCK ARM'S DIAL. `cloudMarchJitter` is not a `CloudVolumetrics`
    // property — jitter is a tier-preset flag — so the arm cannot run, and an
    // arm that cannot run must not produce a capture that reads as evidence.
    await assert.rejects(
      () =>
        pageRunArm({
          camera: MECHANISM_RIG.camera,
          baseline: scene.baseline,
          cloudDials: scene.cloudDials,
          dial: { volumetric: { cloudMarchJitter: 0 } },
          settleFrames: 1,
        }),
      /unknown CloudVolumetrics property cloudMarchJitter/,
    );
    // And no arm in the shipped table names it, which is what the strike means.
    for (const set of armDialSets()) {
      assert.equal(
        Object.hasOwn(set.dial.volumetric ?? {}, "cloudMarchJitter"),
        false,
        `${set.label} still drives the dial that does not exist`,
      );
    }
    assert.equal(MECHANISM_ARM_IDS.includes("M5"), false);
  } finally {
    page.restore();
  }
});

test("D8. the clouds-OFF control is the same scene with one thing moved", async () => {
  const page = installFakePage();
  try {
    const scene = await pageBuildScene({
      clock: MECHANISM_RIG.clock,
      dials: MECHANISM_RIG.dials,
    });
    const armConfig = {
      camera: MECHANISM_RIG.camera,
      baseline: scene.baseline,
      cloudDials: scene.cloudDials,
      dial: { farMultiplier: 4 },
      settleFrames: 1,
    };
    const on = await pageRunArm({ ...armConfig, cloudsOn: true });
    const onState = sceneState(page);
    const off = await pageRunArm({ ...armConfig, cloudsOn: false });
    const offState = sceneState(page);

    assert.equal(on.cloudsOn, true);
    assert.equal(off.cloudsOn, false);
    assert.equal(on.realization.enableVolumetric, true);
    assert.equal(off.realization.enableVolumetric, false);

    // AND THE OFF FRAME IS A FRAME, NOT A REFUSAL — the clause the first fake
    // could not carry. `configure` assigns the requested properties FIRST, the
    // gate AFTER, and then round-trip-checks every requested key; the real
    // `CloudCollection.enableVolumetric` setter WRITES `volumetric.enabled`.
    // So a baseline snapshot carrying the master gate `enabled: true`, handed
    // back on a `enableVolumetric: false` call, reports "enabled round trip
    // failed: expected true, received false" and THROWS — at arm 1, with one
    // PNG banked and no progress file. The gate is therefore not in the
    // snapshot at all, and neither is the other unprefixed property
    // (Reginard R2-1, Sigismond R4 / F-4).
    assert.equal(
      scene.baseline.coveredCloudKeys.includes("enabled"),
      false,
      "the master gate rides the restore, which refuses every clouds-OFF frame",
    );
    assert.deepEqual(scene.baseline.uncoveredCloudKeys.sort(), [
      "enabled",
      "weatherProvider",
    ]);
    // The gate did move, on the real accessor pair, in both directions.
    assert.equal(page.volumetric.enabled, false);
    assert.equal(
      page.scene.globe.defaultCloudCollection.renderMode,
      CloudRenderMode.BILLBOARD,
    );
    const back = await pageRunArm({ ...armConfig, cloudsOn: true });
    assert.equal(back.realization.enableVolumetric, true);
    assert.equal(page.volumetric.enabled, true);
    assert.equal(
      page.scene.globe.defaultCloudCollection.renderMode,
      CloudRenderMode.VOLUMETRIC,
    );

    // THE REALIZATION READOUT IS LIVE. `CloudCache` publishes `observability`
    // and `uniformData`; there is no `counters` field and no `qualityFlags`
    // field, and a probe reading those names banks null for every number here
    // — `primarySteps` among them, the one figure M4's whole arm is read on.
    // (Reginard R2-3.)
    assert.equal(on.realization.primarySteps, 96);
    assert.equal(on.realization.lightSteps, 8);
    assert.equal(on.realization.qualityFlags, 12601);
    assert.equal(on.realization.resolvedPrimarySteps, 96);
    assert.equal(on.realization.marchPixels, 1048576);
    assert.equal(on.realization.halfWidth, 1024);
    assert.equal(on.realization.halfResActive, true);
    assert.equal(on.cloudPlanes.farPlane, 10000000000);
    assert.equal(on.weatherObservability.source, "cache-observability");
    assert.equal(on.weatherObservability.cacheHits, 3);
    assert.equal(typeof on.timing.firstCloudFrameMs, "number");

    // Everything else about the two frames is the same scene — including the
    // arm's own dial, which is what makes the pair subtractable.
    assert.equal(onState.far, scene.baseline.far * 4);
    assert.equal(offState.far, onState.far);
    for (const key of [
      "globeShow",
      "terrain",
      "mSSE",
      "msaa",
      "cloudQuality",
      "godRays",
    ]) {
      assert.equal(offState[key], onState[key], `${key} moved with the clouds`);
    }
  } finally {
    page.restore();
  }
});

/**
 * Import a copy of the mechanism module with one construct made unreachable.
 *
 * The module has no imports of its own, so the `data:` URL needs no rewriting —
 * unlike the ladder model's mutant loader above.
 *
 * @param {(source: string) => string} mutate The mutation.
 * @returns {Promise<object>} The mutated module.
 */
async function importMutatedMechanism(mutate) {
  const source = readFileSync(
    path.join(HERE, "lib", "cloud-march-mechanism.mjs"),
    "utf8",
  ).replaceAll("\r\n", "\n");
  const mutated = mutate(source);
  assert.notEqual(mutated, source, "the mutation did not apply");
  return import(
    `data:text/javascript;base64,${Buffer.from(mutated).toString("base64")}`
  );
}

test("D9. MUTATION control: four mutants of the restore and the far sweep, and which ones bite", async () => {
  // MUTANT 1 — the restore made UNREACHABLE, not deleted. This is the shape
  // the frozen first draft actually had, and D6 is the case that has to catch
  // it: with the block inert, M1's hidden globe survives into every later arm.
  const inertRestore = await importMutatedMechanism((source) => {
    const anchor = "  scene.globe.show = baseline.globeShow;";
    assert.equal(source.split(anchor).length - 1, 1);
    return source.replace(
      anchor,
      "  if (false) { scene.globe.show = baseline.globeShow; }",
    );
  });
  const inert = await runEveryArm({
    buildScene: inertRestore.pageBuildScene,
    runArm: inertRestore.pageRunArm,
  });
  const afterVeto = inert.states.filter(
    (state) => state.label !== "M0" && state.label !== "M1",
  );
  assert.ok(afterVeto.length > 5);
  assert.ok(
    afterVeto.every((state) => state.globeShow === false),
    "the inert restore did not actually leak the veto arm's dial",
  );
  // The positive arm is among them, which is the consequence that matters.
  assert.equal(
    inert.states.find((state) => state.label === "M6-far-x1").globeShow,
    false,
  );

  // MUTANTS 2-4 — the far sweep. TWO GUARDS STAND BETWEEN THE TABLE AND A
  // COMPOUNDING SWEEP, and mutating them one at a time is what SHOWS that
  // rather than asserting it: the restore puts `frustum.far` back to the
  // baseline, and the multiplier is taken against `baseline.far` instead of the
  // live value. Either alone is sufficient. That redundancy is deliberate, and
  // it is also why the first draft's sequence needs BOTH removed to reproduce —
  // the compounding it shipped was a CONSEQUENCE of having no restore, not an
  // independent second defect. Recording it as one would have been wrong.
  const FAR_RESTORE = "  scene.camera.frustum.far = baseline.far;";
  const FAR_MULTIPLY =
    "    scene.camera.frustum.far = baseline.far * dial.farMultiplier;";
  const FAR_MULTIPLY_LIVE =
    "    scene.camera.frustum.far = scene.camera.frustum.far * dial.farMultiplier;";
  const sweepUnder = async (mutate) => {
    const mutant = await importMutatedMechanism(mutate);
    const run = await runEveryArm({
      buildScene: mutant.pageBuildScene,
      runArm: mutant.pageRunArm,
    });
    return run.states
      .filter((state) => state.armId === "M6")
      .map((state) => state.far / run.scene.baseline.far);
  };

  // Mutant 2: the multiply against the live frustum, restore intact.
  assert.deepEqual(
    await sweepUnder((source) => {
      assert.equal(source.split(FAR_MULTIPLY).length - 1, 1);
      return source.replace(FAR_MULTIPLY, FAR_MULTIPLY_LIVE);
    }),
    [1, 0.25, 4, 16],
    "the restore alone should hold the sweep up",
  );
  // Mutant 3: the far restore made unreachable, multiply intact.
  assert.deepEqual(
    await sweepUnder((source) => {
      assert.equal(source.split(FAR_RESTORE).length - 1, 1);
      return source.replace(FAR_RESTORE, `  if (false) {${FAR_RESTORE} }`);
    }),
    [1, 0.25, 4, 16],
    "the baseline multiply alone should hold the sweep up",
  );
  // Mutant 4: BOTH inert — the first draft. The row LABELLED x4 renders the
  // reference frustum and would score a perfect residual against itself, and
  // every arm after the sweep inherits a 16x far plane.
  const compounded = await sweepUnder((source) => {
    assert.equal(source.split(FAR_RESTORE).length - 1, 1);
    assert.equal(source.split(FAR_MULTIPLY).length - 1, 1);
    return source
      .replace(FAR_RESTORE, `  if (false) {${FAR_RESTORE} }`)
      .replace(FAR_MULTIPLY, FAR_MULTIPLY_LIVE);
  });
  assert.deepEqual(compounded, [1, 0.25, 1, 16]);
  assert.equal(compounded[2], 1);

  // The real module is untouched by either mutation.
  const real = await runEveryArm();
  assert.deepEqual(
    real.states
      .filter((state) => state.armId === "M6")
      .map((state) => state.far / real.scene.baseline.far),
    [1, 0.25, 4, 16],
  );
});

test("D10. the far sweep's predictions are registered BEFORE the run, from the frustum the scene pins", async () => {
  // PRE-REGISTRATION. Under log depth `Scene.js:1477-1478` pins near 0.1 and
  // far 1e10, and `WebGPUProceduralCloudRenderer.ts:3780-3781` packs that pair
  // into slots 105/106 verbatim. So the sweep's predicted shifts are fixed
  // before the leg runs and are not free parameters afterwards.
  const near = 0.1;
  const far = 10000000000;
  const measured = 0.010923873226854678; // the banked NOWX ln-z period
  assert.ok(Math.abs(logDepthScale(near, far) - 33.21928094900347) < 1e-12);

  // The model's absolute magnitude, which the design had recorded as
  // unexplained: L * ln2 * 2^-11 against the measured period.
  const predictedQuantum = (logDepthScale(near, far) * Math.LN2) / 2048;
  assert.ok(Math.abs(predictedQuantum - 0.011243091274428935) < 1e-15);
  assert.ok(
    Math.abs(measured / predictedQuantum - 1) < 0.03,
    `the shipped frustum predicts the measured period to ${((measured / predictedQuantum - 1) * 100).toFixed(2)} %`,
  );
  // And it does so far better than the two frusta the design guessed at, which
  // is what makes this an explanation rather than a coincidence.
  for (const candidate of [5e8, 1e8]) {
    const wrong = (logDepthScale(1, candidate) * Math.LN2) / 2048;
    assert.ok(
      Math.abs(measured / wrong - 1) > 0.1,
      `far ${candidate} would also have fitted`,
    );
  }

  // The registered per-row shifts. A run that comes back outside these is the
  // STOP condition, and nobody gets to choose the numbers after the fact.
  const registered = [
    [0.25, -0.06021],
    [4, 0.06021],
    [16, 0.12041],
  ];
  for (const [multiplier, shift] of registered) {
    const predicted = predictedPeriod({
      referencePeriod: measured,
      referenceNear: near,
      referenceFar: far,
      near,
      far: far * multiplier,
    });
    assert.ok(
      Math.abs(predicted / measured - 1 - shift) < 5e-5,
      `x${multiplier} predicts ${((predicted / measured - 1) * 100).toFixed(3)} %, registered ${(shift * 100).toFixed(3)} %`,
    );
  }
  // Every registered shift clears the onset ladder's own 1.42 % CV by a wide
  // margin, which is what makes the arm decisive rather than suggestive.
  for (const [, shift] of registered) {
    assert.ok(Math.abs(shift) > 4 * 0.0142);
  }
});

// ===========================================================================
// D11. THE ENGINE MEMBERS THE PAGE-SIDE CODE TOUCHES, ASSERTED TO EXIST
//
// WHY THIS CASE EXISTS. Every defect round two found in this leg has the same
// shape: page-side code writes or reads a member the engine does not have, the
// write lands on an expando nobody reads, and the arm banks a picture of the
// scene before it under the label of a treatment that never happened. A double
// cannot catch that on its own — the double was written from the same reading
// as the code, so it grew the same invented member. This case is the
// independent half: for every scene member the page-side halves touch, it
// asserts existence against the ENGINE — the real class for a dial, the
// tracked source file for an expando or a cache field — so an arm whose dial
// does not exist FAILS here rather than running silently on Edge.
//
// It is deliberately a row per member with one mechanism per row, because the
// failure mode being closed is "nobody declared where this name lives".
// ===========================================================================

test("D11. every engine member the page-side code drives EXISTS in the engine", () => {
  const volumetric = new CloudVolumetrics();

  // (a) EVERY ARM DIAL IS A REAL `CloudVolumetrics` PROPERTY. `configure`
  // throws on a key that is not, so an invented dial ends the run part-way
  // through — which is how M5 was caught, after it had been briefed. The
  // check is over the SHIPPED arm table, so a dial added later is covered.
  const volumetricDials = new Set();
  for (const set of armDialSets()) {
    for (const key of Object.keys(set.dial.volumetric ?? {})) {
      volumetricDials.add(key);
      assert.ok(
        key in volumetric,
        `arm ${set.label} drives ${key}, which is not a CloudVolumetrics property`,
      );
      assert.ok(
        key.startsWith("cloud"),
        `arm ${set.label} drives ${key}, which the baseline snapshot does not cover`,
      );
    }
  }
  assert.deepEqual([...volumetricDials].sort(), ["cloudQuality"]);
  // And the arm that was STRUCK for naming a dial that does not exist stays
  // struck, checked against the real class rather than against a grep.
  assert.equal("cloudMarchJitter" in volumetric, false);
  assert.equal(MECHANISM_ARM_IDS.includes("M5"), false);

  // (b) THE TWO UNPREFIXED PROPERTIES, MEASURED ON THE REAL CLASS. The first
  // draft's comment claimed the whole public surface was `cloud*`-prefixed,
  // and believing it is what put the master gate into the dial snapshot.
  const ownKeys = Object.keys(volumetric);
  assert.deepEqual(
    ownKeys.filter((key) => !key.startsWith("cloud")),
    ["enabled", "weatherProvider"],
  );
  assert.equal(ownKeys[0], "enabled", "the master gate is the FIRST property");
  assert.ok(ownKeys.length > 40, "the class collapsed; re-derive this case");

  // (c) THE COLLECTION'S GATE IS AN ACCESSOR PAIR OVER `volumetric.enabled`.
  // Extracted from the tracked engine file at module load; here the extracted
  // pair is EXECUTED, so the collision the OFF frame used to hit is a
  // behaviour this file can reproduce rather than a claim it repeats.
  const collection = fakeCloudCollection(volumetric);
  const gate = Object.getOwnPropertyDescriptor(collection, "enableVolumetric");
  assert.equal(typeof gate.get, "function");
  assert.equal(typeof gate.set, "function");
  assert.equal(collection.enableVolumetric, false);
  collection.enableVolumetric = true;
  assert.equal(
    volumetric.enabled,
    true,
    "the extracted setter does not write volumetric.enabled",
  );
  assert.equal(collection.renderMode, CloudRenderMode.VOLUMETRIC);
  collection.enableVolumetric = false;
  assert.equal(volumetric.enabled, false);
  assert.equal(collection.renderMode, CloudRenderMode.BILLBOARD);
  // The enum's own values, from the engine: a double that retyped them as
  // 1 / 2 would make the getter read false forever and every OFF assertion
  // in this section vacuous.
  assert.equal(CloudRenderMode.BILLBOARD, 0);
  assert.equal(CloudRenderMode.VOLUMETRIC, 1);

  // (d) THE SCENE EXPANDOS THE GOD-RAY ARM DRIVES, and the member it must NOT
  // drive. `scene.postProcessStages` is upstream's `PostProcessStageCollection`
  // and its whole accessor surface is read here: `godRays` is not in it, which
  // is why the first draft's guarded write was a permanent no-op.
  const postProcess = engineSource("Scene/PostProcessStageCollection.js");
  const accessors = [
    ...postProcess.matchAll(/\n {2}get ([A-Za-z]+)\(\) \{/g),
  ].map((match) => match[1]);
  assert.ok(accessors.includes("fxaa") && accessors.includes("bloom"));
  assert.equal(
    accessors.includes("godRays"),
    false,
    "PostProcessStageCollection grew a godRays member; re-read the M7 dial",
  );
  const postProcessCache = engineSource(
    "Renderer/WebGPU/WebGPUPostProcessStageCollection.ts",
  );
  assert.match(
    postProcessCache,
    /cache\.godRayEnabled =\n\s*\(scene as unknown as \{ godRayEnabled\?: boolean \}\)\?\.godRayEnabled === true;/,
    "scene.godRayEnabled is no longer the god-ray enable; M7's dial is stale",
  );
  const postFrustumChain = engineSource(
    "Renderer/WebGPU/WebGPUSceneRendererPostFrustumChain.ts",
  );
  assert.match(
    postFrustumChain,
    /godRayEffect\?\.enabled === true && config\.scene\.godRayCloudAware === true/,
    "scene.godRayCloudAware is no longer the coupling M7 is named after",
  );

  // (e) THE CACHE FIELD NAMES. `observability` is the published surface; the
  // probe used to read `counters`, which is the per-attempt local.
  const cloudRenderer = engineSource(
    "Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts",
  );
  assert.match(
    cloudRenderer,
    /\n {2}observability: CloudFrameCounters;\n/,
    "CloudCache.observability moved; the realization block reads nothing",
  );
  assert.equal(
    /\n {2}counters: CloudFrameCounters;\n/.test(cloudRenderer),
    false,
    "the cache grew a counters field; re-read which one the probe should use",
  );
  // Slots 44 / 45 / 74, named at their pack sites.
  for (const [slot, name] of [
    [44, "maxSteps"],
    [45, "lightSteps"],
    [74, "qualityFlags"],
  ]) {
    assert.match(
      cloudRenderer,
      new RegExp(`data\\[offset\\+\\+\\] = [^\\n]*; // ${slot} ${name}`),
      `uniform slot ${slot} (${name}) moved`,
    );
  }
  // The counter names the realization and weather blocks read.
  const observabilitySource = engineSource(
    "Renderer/WebGPU/WebGPUCloudObservability.ts",
  );
  for (const field of [
    "maxSteps",
    "lightSteps",
    "marchWidth",
    "marchHeight",
    "marchPixels",
    "halfResActive",
    "primarySampleBudget",
    "lightSampleBudget",
    "weatherUploads",
    "weatherUploadBytes",
    "weatherCacheHits",
    "weatherCacheMisses",
    "weatherLiveBytes",
  ]) {
    assert.match(
      observabilitySource,
      new RegExp(`\\n {2}${field}: number;\\n`),
      `CloudFrameCounters.${field} is gone; the probe banks null for it`,
    );
  }

  // (f) THE NON-CLOUD SCENE DIALS, at the definitions that own them.
  const globeSource = engineSource("Scene/Globe.js");
  assert.match(globeSource, /\n {4}this\.show = true;\n/);
  assert.match(globeSource, /\n {4}this\.maximumScreenSpaceError = 2;\n/);
  assert.match(globeSource, /\n {4}this\.enableLighting = false;\n/);
  assert.match(globeSource, /\n {4}this\.showWaterEffect = true;\n/);
  assert.match(globeSource, /\n {2}get baseColor\(\) \{\n/);
  assert.match(globeSource, /\n {2}set terrainProvider\(value\) \{\n/);
  assert.match(globeSource, /\n {2}get defaultCloudCollection\(\) \{\n/);
  const sceneSource = engineSource("Scene/Scene.js");
  assert.match(sceneSource, /\n {2}set msaaSamples\(value\) \{\n/);
  assert.match(sceneSource, /\n {2}get logarithmicDepthBuffer\(\) \{\n/);
  assert.match(sceneSource, /\n {2}get imageryLayers\(\) \{\n/);
  // The frustum the whole far sweep is arithmetic over, at the line that pins
  // it. D10 registers the numbers; this asserts the pin still exists.
  assert.match(
    sceneSource,
    /camera\.frustum\.near = 0\.1;\n\s*camera\.frustum\.far = 10000000000\.0;/,
    "Scene no longer pins the log-depth frustum the far sweep predicts from",
  );

  // (g) THE REALISED-GOD-RAY READBACK PATH, which is the tracked harness's —
  // the evidence that `scene.godRayEnabled` is reachable from a real page at
  // all, and therefore that M7 is an arm rather than a second M5.
  const c13Harness = readFileSync(
    path.join(HERE, "lib", "c13-42-reproduction-harness.mjs"),
    "utf8",
  ).replaceAll("\r\n", "\n");
  assert.match(
    c13Harness,
    /scene\.godRayEnabled = true;/,
    "the tracked harness no longer drives scene.godRayEnabled on a real page",
  );
  assert.match(
    c13Harness,
    /_alternateSceneRenderer\?\.postProcessPipeline\?\.godRayEffect/,
    "the realised-effect readback path moved",
  );
});

// ===========================================================================
// D12. THE PROBE'S OWN `cells` LOOP, DRIVEN TO COMPLETION
//
// WHY. Until this case existed nothing executed `cells`. D4 runs the
// descriptor's `receipt` and `summary` over synthetic cells and never calls
// the loop; the ladder's `fakePage` dispatches on `__ladder*` markers and
// throws `unstubbed page.evaluate` on anything else, so it could not drive
// this probe at all. The mechanism probe carries `__mechanism*` markers and
// its docstring says they exist "so a stubbed page can dispatch on its
// source" — and no stub did. So the ON/OFF pairing, the ORDER of the two
// captures and which dial each arm is run with all lived in code no case
// reached, and three mutants of it passed the whole suite: capturing the
// clouds-OFF frame BEFORE the OFF arm rendered (so every "clouds off" picture
// is the clouds-ON one and the leg reads no rings), never running the OFF leg
// at all, and running EVERY arm with an empty dial — fourteen identical
// captures labelled M0…M7, which is the row-exit case, since the arm table is
// this leg's entire output. (Sigismond R6.)
//
// This stub dispatches on the probe's own markers and asserts the four things
// only the loop can get wrong: the ORDERED trace of evaluates and screenshots,
// the dial each arm was actually run with, the progress file growing by
// exactly one entry per arm, and the refusal paths. D13 kills the mutants.
// ===========================================================================

/** Does a path exist? `fs.existsSync` without widening this file's imports. */
function bankedFileExists(file) {
  try {
    readFileSync(file);
    return true;
  } catch {
    return false;
  }
}

/** The baseline shape the stubbed build step hands every arm. */
function stubBaseline() {
  const snapshot = {};
  const live = new CloudVolumetrics();
  for (const key of Object.keys(live)) {
    const value = live[key];
    if (
      key.startsWith("cloud") &&
      (value === null ||
        (typeof value !== "object" && typeof value !== "function"))
    ) {
      snapshot[key] = value;
    }
  }
  return {
    cloudSnapshot: snapshot,
    coveredCloudKeys: Object.keys(snapshot),
    uncoveredCloudKeys: ["enabled", "weatherProvider"],
    near: 0.1,
    far: 10000000000,
    globeShow: true,
    msaaSamples: 4,
    maximumScreenSpaceError: 2,
    godRays: false,
    godRayCloudAware: false,
    terrainProvider: "CesiumTerrainProvider",
  };
}

/**
 * A page that answers the MECHANISM probe's evaluates by the marker comment in
 * the function it was handed, recording an ORDERED trace of every evaluate and
 * every screenshot.
 *
 * @param {object} log The trace sink.
 * @param {object} [options] `buildOk` / `unappliedArm` drive the refusal paths.
 * @returns {object} The stub page.
 */
function fakeMechanismPage(log, options = {}) {
  const baseline = stubBaseline();
  return {
    on() {},
    async addInitScript() {},
    async goto() {},
    async waitForFunction() {},
    async evaluate(fn, arg) {
      const source = String(fn);
      if (source.includes("__mechanismInstallNamespace")) {
        log.trace.push("namespace");
        return { ok: true, source: "module", moduleUrl: arg };
      }
      if (source.includes("__mechanismBuildScene")) {
        log.trace.push("build");
        return {
          ok: options.buildOk !== false,
          renderLoopDisabled: true,
          truth: { ok: true },
          cloudDials: { cloudCoverage: 0.6 },
          globeDials: {},
          unappliedGlobeDials: options.buildOk === false ? ["globeOops"] : [],
          imageryLayersRemoved: 3,
          baseline,
          defaultFrustum: { near: baseline.near, far: baseline.far },
          logarithmicDepthBuffer: true,
        };
      }
      if (source.includes("__mechanismRunArm")) {
        const phase = arg.cloudsOn === false ? "off" : "on";
        // The DIAL the arm was actually run with, recorded per evaluate. A
        // loop that hands every arm an empty dial is visible here and nowhere
        // else in the batch.
        log.arms.push({ phase, dial: arg.dial, far: arg.baseline.far });
        log.trace.push(`arm:${log.label}:${phase}`);
        const applied = options.unappliedArm !== log.label;
        return {
          cloudsOn: arg.cloudsOn !== false,
          dialReports: [],
          dialsApplied: applied,
          unappliedDials: applied
            ? []
            : ["godRayEnabled: wrote true, read back undefined"],
          restoredToBaseline: { ...baseline },
          frustum: { near: baseline.near, far: baseline.far },
          cloudPlanes: { nearPlane: 0.1, farPlane: baseline.far },
          depthTexture: { format: "r16float", msaaSamples: 4 },
          globe: { show: true, terrainProvider: "CesiumTerrainProvider" },
          realization: { primarySteps: 96, enableVolumetric: phase === "on" },
          godRay: { requested: false, cloudAware: false, realized: null },
          weatherObservability: { source: "cache-observability" },
          timing: { firstCloudFrameMs: 1, settleFrames: arg.settleFrames },
        };
      }
      if (source.includes("cesium-viewer-toolbar")) {
        log.trace.push("strip");
        return { removed: 4 };
      }
      if (source.includes("__armWebGPUDevice")) {
        log.trace.push("arm-devices");
        return { armed: 1, found: 1, total: 1 };
      }
      if (source.includes("__webgpuGate")) {
        return { errors: [], deviceLost: null, armedDevices: 1 };
      }
      throw new Error(`unstubbed page.evaluate: ${source.slice(0, 140)}`);
    },
    locator() {
      return {
        first: () => ({
          async screenshot() {
            log.trace.push(`shot:${log.nextShotLabel()}`);
            // The bank-as-you-go guarantee, sampled from INSIDE the loop: at
            // arm i's two shots the progress file holds i entries.
            log.progressAtShot.push(log.readProgress());
            return framePng(1);
          },
        }),
      };
    },
  };
}

/**
 * Drive the MECHANISM descriptor's real `cells` through the stub page.
 *
 * @param {object} [options] `argv` extras plus `fakeMechanismPage`'s options.
 * @returns {Promise<object>} `{code, root, out, log, sets}`.
 */
async function driveMechanism(options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "cloud-march-mechanism-"));
  // Destructive-test discipline: everything this spec writes is under
  // os.tmpdir(), asserted rather than assumed.
  assert.ok(
    root.startsWith(tmpdir()),
    "the spec's sandbox must live under os.tmpdir()",
  );
  const out = path.join(root, "out");
  const sets = armDialSets();
  let index = 0;
  let shotsForArm = 0;
  const log = {
    trace: [],
    arms: [],
    progressAtShot: [],
    launches: 0,
    get label() {
      return sets[index]?.label ?? "(past the end of the arm table)";
    },
    nextShotLabel() {
      // The ON shot comes first, then the OFF shot, then the arm advances.
      const label = shotsForArm === 0 ? log.label : `${log.label}-clouds-off`;
      shotsForArm += 1;
      if (shotsForArm === 2) {
        shotsForArm = 0;
        index += 1;
      }
      return label;
    },
    readProgress() {
      try {
        return JSON.parse(
          readFileSync(path.join(out, "arms-so-far.json"), "utf8"),
        ).length;
      } catch {
        return null;
      }
    },
  };
  const code = await runProbe(mechanismDescriptor, {
    argv: [
      "--repository-root",
      root,
      "--output",
      out,
      "--no-serve-built",
      "--renderer",
      "webgpu",
      "--settle-frames",
      "1",
      ...(options.argv ?? []),
    ],
    now: () => Date.UTC(2026, 8, 19, 23, 0, 0),
    launch: async () => {
      log.launches += 1;
      return {
        async newPage() {
          return fakeMechanismPage(log, options);
        },
        async close() {},
      };
    },
  });
  return { code, root, out, log, sets };
}

test("D12. the cells loop pairs every capturing arm ON then OFF, in that order, banking as it goes", async () => {
  const { code, root, out, log, sets } = await driveMechanism();
  try {
    assert.notEqual(code, PROBE_EXIT_CODES.ERROR, "the loop did not complete");
    assert.equal(log.launches, 1);

    // THE ORDERED TRACE. Everything about the pairing that can be wrong is
    // wrong in this list: the OFF evaluate missing, the OFF screenshot taken
    // before the OFF evaluate returns, the ON screenshot taken after it.
    const expected = ["namespace", "strip", "arm-devices", "build"];
    for (const set of sets) {
      expected.push(`arm:${set.label}:on`);
      if (set.capturesNothing !== true) {
        expected.push(`shot:${set.label}`);
        expected.push(`arm:${set.label}:off`);
        expected.push(`shot:${set.label}-clouds-off`);
      }
    }
    assert.deepEqual(log.trace, expected);

    // EXACTLY TWO FRAMES PER CAPTURING ARM, AND NONE FOR THE ONE THAT DECLINES.
    const capturing = sets.filter((set) => set.capturesNothing !== true);
    assert.equal(capturing.length, 14, "the capturing arm count moved");
    assert.equal(
      log.trace.filter((entry) => entry.startsWith("shot:")).length,
      capturing.length * 2,
    );
    for (const set of capturing) {
      assert.ok(
        bankedFileExists(
          path.join(out, `cloud-march-mechanism-${set.label}.png`),
        ),
        `${set.label} banked no ON frame`,
      );
      assert.ok(
        bankedFileExists(
          path.join(out, `cloud-march-mechanism-${set.label}-clouds-off.png`),
        ),
        `${set.label} banked no OFF frame`,
      );
    }
    assert.equal(
      bankedFileExists(path.join(out, "cloud-march-mechanism-M2-msaa1.png")),
      false,
      "the non-capturing arm banked a capture",
    );

    // EVERY ARM WAS RUN WITH ITS OWN DIAL, both times. A loop that passed an
    // empty dial to every arm produces fourteen identical captures labelled
    // M0…M7, and the arm table is the whole output of this leg.
    assert.equal(log.arms.length, sets.length + capturing.length);
    let cursor = 0;
    for (const set of sets) {
      assert.deepEqual(log.arms[cursor].dial, set.dial, `${set.label} ON dial`);
      assert.equal(log.arms[cursor].phase, "on");
      cursor += 1;
      if (set.capturesNothing !== true) {
        assert.deepEqual(
          log.arms[cursor].dial,
          set.dial,
          `${set.label} OFF dial`,
        );
        assert.equal(log.arms[cursor].phase, "off");
        cursor += 1;
      }
    }
    // The far sweep's four multipliers reached four different evaluates,
    // twice each — which is what makes "every arm got an empty dial" a
    // detectable mutation rather than a plausible one.
    assert.deepEqual(
      log.arms
        .filter((entry) => entry.dial.farMultiplier !== undefined)
        .map((entry) => entry.dial.farMultiplier),
      [1, 1, 0.25, 0.25, 4, 4, 16, 16],
    );

    // BANK AS YOU GO. The progress file is rewritten after EVERY arm, so a
    // device that dies at arm 11 leaves ten arms of evidence. Sampled from
    // inside the screenshot call: at arm i's two shots the file holds i
    // entries, and it holds every arm at the end.
    assert.equal(log.progressAtShot[0], null, "arm 0 wrote before it finished");
    assert.equal(log.progressAtShot[1], null);
    assert.equal(log.progressAtShot[2], 1, "arm 1 did not bank arm 0");
    assert.deepEqual(
      log.progressAtShot.filter((_, i) => i % 2 === 0),
      capturing.map((_, i) => (i === 0 ? null : i)),
    );
    const banked = JSON.parse(
      readFileSync(path.join(out, "arms-so-far.json"), "utf8"),
    );
    assert.equal(banked.length, sets.length);
    assert.equal(banked[0].label, "M0");
    assert.equal(banked[0].measurement.cloudsOn, true);
    assert.equal(banked[0].measurementCloudsOff.cloudsOn, false);
    assert.equal(banked[banked.length - 1].label, "M2-msaa1");
    assert.equal(banked[banked.length - 1].measurementCloudsOff, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("D12b. the loop REFUSES rather than banking an arm whose dial did not apply", async () => {
  const { code, root, out, log } = await driveMechanism({
    unappliedArm: "M7-godrays",
  });
  try {
    assert.equal(code, PROBE_EXIT_CODES.REFUSAL);
    const refusal = readFileSync(
      path.join(out, "cloud-march-mechanism-refusal.json"),
      "utf8",
    );
    assert.match(refusal, /arm-dial-did-not-apply/);
    assert.match(refusal, /M7-godrays/);
    assert.match(refusal, /picture of the arm before it/);
    // It refused BEFORE the capture: no PNG under the label of an arm whose
    // treatment did not take, which is the whole point of the refusal.
    assert.equal(
      bankedFileExists(path.join(out, "cloud-march-mechanism-M7-godrays.png")),
      false,
      "a capture was banked under a label whose dial did not apply",
    );
    // And the arms that DID apply are still on disk, because the run banks as
    // it goes — a refusal is not a reason to lose ten arms of evidence.
    assert.ok(log.readProgress() >= 8, "the earlier arms were lost with it");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("D12c. a build step that does not own the scene refuses before any arm runs", async () => {
  const { code, root, out, log } = await driveMechanism({ buildOk: false });
  try {
    assert.equal(code, PROBE_EXIT_CODES.REFUSAL);
    const refusal = readFileSync(
      path.join(out, "cloud-march-mechanism-refusal.json"),
      "utf8",
    );
    assert.match(refusal, /scene-not-owned/);
    assert.match(refusal, /globeOops/);
    assert.equal(
      log.trace.filter((entry) => entry.startsWith("arm:")).length,
      0,
      "an arm ran on a scene the preflight does not own",
    );
    assert.equal(log.progressAtShot.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("D12d. a WebGL-only invocation refuses instead of measuring a globe with no clouds", async () => {
  const { code, root, out } = await driveMechanism({
    argv: ["--renderer", "webgl"],
  });
  try {
    assert.equal(code, PROBE_EXIT_CODES.REFUSAL);
    assert.match(
      readFileSync(
        path.join(out, "cloud-march-mechanism-refusal.json"),
        "utf8",
      ),
      /renderer-unavailable/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("D12e. --only-arm runs STEP 0's one arm and its control, and refuses a name that matches nothing", async () => {
  // STEP 0 OF THE EDGE RECIPE, AS A BEHAVIOUR. Three Node rounds argued this
  // leg against a page nobody could see and each missed a member the engine
  // does not have. So the first REAL execution is one arm and its own
  // clouds-OFF control — about a minute — and the twenty-minute run is booked
  // only if both frames come back with every dial applied.
  const { code, root, out, log } = await driveMechanism({
    argv: ["--only-arm", "M0"],
  });
  try {
    assert.notEqual(code, PROBE_EXIT_CODES.ERROR);
    assert.deepEqual(log.trace, [
      "namespace",
      "strip",
      "arm-devices",
      "build",
      "arm:M0:on",
      "shot:M0",
      "arm:M0:off",
      "shot:M0-clouds-off",
    ]);
    const banked = JSON.parse(
      readFileSync(path.join(out, "arms-so-far.json"), "utf8"),
    );
    assert.equal(banked.length, 1);
    assert.equal(banked[0].label, "M0");
    assert.equal(banked[0].measurement.cloudsOn, true);
    assert.equal(banked[0].measurementCloudsOff.cloudsOn, false);
    // THE RECEIPT SAYS IT WAS NARROWED. A one-arm smoke and the full leg
    // otherwise produce the same file shape, and nothing downstream may read
    // the smoke as the leg.
    const receipt = JSON.parse(
      readFileSync(path.join(out, "cloud-march-mechanism-report.json"), "utf8"),
    );
    assert.equal(receipt.runs[0].onlyArm, "M0");
    assert.equal(receipt.runs[0].armsRequested, 1);
    assert.equal(receipt.runs[0].armsInTable, armDialSets().length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // An arm id selects the whole family, which is how the far sweep is smoked.
  const sweep = await driveMechanism({ argv: ["--only-arm", "M6"] });
  try {
    assert.equal(
      sweep.log.arms.filter((entry) => entry.phase === "on").length,
      4,
      "--only-arm M6 did not select the four far-sweep rows",
    );
  } finally {
    rmSync(sweep.root, { recursive: true, force: true });
  }

  // AND A NAME THAT MATCHES NOTHING REFUSES. A run that executed no arm and
  // exited 0 is the worst possible answer to "is the engine the shape this
  // probe believes it is?".
  const missing = await driveMechanism({ argv: ["--only-arm", "M9"] });
  try {
    assert.equal(missing.code, PROBE_EXIT_CODES.REFUSAL);
    const refusal = readFileSync(
      path.join(missing.out, "cloud-march-mechanism-refusal.json"),
      "utf8",
    );
    assert.match(refusal, /unknown-arm/);
    assert.match(refusal, /M7-godrays/, "the refusal does not list the table");
    assert.equal(
      missing.log.trace.filter((entry) => entry.startsWith("shot:")).length,
      0,
    );
  } finally {
    rmSync(missing.root, { recursive: true, force: true });
  }

  // The unnarrowed call is unchanged, which is what makes the flag additive.
  assert.equal(selectArms(undefined).length, armDialSets().length);
  assert.equal(selectArms("").length, armDialSets().length);
  assert.throws(() => selectArms("nope"), { name: "ProbeRefusal" });
});
