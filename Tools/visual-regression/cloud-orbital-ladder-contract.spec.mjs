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
  imageAerialCapFraction,
  limbBand,
  limbChordMetres,
  meanCloudAlpha,
  minimumMarchMidDistanceMetres,
} from "./lib/cloud-orbital-ladder-model.mjs";
import { forwardReinhard } from "./lib/cloud-photometry.mjs";
import { PROBE_EXIT_CODES, runProbe } from "./lib/probe-runtime.mjs";
import {
  acquireCesiumNamespace,
  descriptor as ladderDescriptor,
} from "./probe-cloud-orbital-ladder.mjs";

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
