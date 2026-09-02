// sun-disc-dawn-gate.spec.mjs — the browser-free half of the dawn sun-disc
// instrument.
//
// This spec never launches a browser. It executes the probe's own pure
// evaluator and the probe's own page-side reducer over fixtures, and it proves
// every predicate is LIVE by making each one unreachable in a mutated copy of
// the source and requiring the previously-red fixture to go green.
//
// TWO INSTRUMENT DEFECTS THIS SPEC IS SHAPED BY, both from 2026-08-24:
//
//   1. A probe died because a Node-scope symbol was referenced inside
//      `page.evaluate`. The page instrument therefore lives between markers in
//      the probe, and this spec EXECUTES it in Node and separately proves that
//      none of the probe's top-level names appear inside it.
//   2. A gate's spec was green over a dead path because its assertions were
//      source-text regexes. Nothing here asserts that a string is present:
//      every assertion runs the code and reads an observable, and every tooth
//      makes the code inert rather than merely deleting a line.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { tokenizer } from "acorn";

import {
  checkEmbeddedFusedSnapshotIsCanonical,
  checkFusedCaptureUsage,
} from "./lib/same-task-capture.mjs";
import { PROBE_CONTRACT_ALLOWLIST } from "./lib/probe-fleet-contract-allowlist.mjs";
import { PURPOSE_HEADER_ALLOWLIST } from "./lib/purpose-header-allowlist.mjs";
import {
  buildPageConfig,
  parseArguments,
  parseExposureValue,
} from "./probe-sun-disc-dawn.mjs";
import {
  SUN_DISC_DAWN_BAR,
  SUN_DISC_DAWN_BAR_DERIVATION_DISCRIMINATOR_INDEX,
  SUN_DISC_DAWN_BAR_DERIVATION_MARGIN,
  SUN_DISC_DAWN_BAR_DERIVATION_MINIMUM_SAMPLES,
  SUN_DISC_DAWN_BAR_DERIVATION_PARITY_DELTA,
  SUN_DISC_DAWN_EXPOSURE,
  SUN_DISC_DAWN_LIMB_COEFFICIENTS,
  SUN_DISC_DAWN_LIMB_REFERENCE_RATIO,
  SUN_DISC_DAWN_READINESS,
  SUN_DISC_DAWN_READINESS_WORST_CASE_MS,
  SUN_DISC_DAWN_REGIONS,
  SUN_DISC_DAWN_RENDERERS,
  SUN_DISC_DAWN_SITE,
  SUN_DISC_DAWN_SWEEP,
  SUN_DISC_DAWN_VIEWPORT,
  centreAnnulusChromaRatio,
  centreAnnulusRatio,
  deriveSunDiscDawnBarFromWebGLSweep,
  evaluateSunDiscDawnSweep,
  horizonDipDegrees,
  meanLimbIntensity,
  rescoreSunDiscDawnArtifact,
  sampleIsScored,
  sunAboveLocalHorizon,
} from "./lib/sun-disc-dawn-gate.mjs";
import { exitCodeForS5Status } from "./lib/verdict-exit-gate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const GATE_PATH = path.join(HERE, "lib/sun-disc-dawn-gate.mjs");
const PROBE_PATH = path.join(HERE, "probe-sun-disc-dawn.mjs");
const TEMP_PREFIX = "sun-disc-dawn-mutant-";
const PAGE_MODULE_PREFIX = "sun-disc-dawn-page-instrument-";

const normalize = (text) => String(text).replace(/\r\n/g, "\n");
const gateSource = () => normalize(fs.readFileSync(GATE_PATH, "utf8"));
const probeSource = () => normalize(fs.readFileSync(PROBE_PATH, "utf8"));

// ---------------------------------------------------------------------------
// Fixtures — derived, never typed in
// ---------------------------------------------------------------------------
//
// The area-weighted mean blend weight over each region comes from the shipped
// intensity law itself, and every byte mean below is the composite that weight
// produces over a warm dawn sky. Nothing here is a hand-tuned number chosen to
// make a test pass; change a coefficient and every fixture moves with it.

const MEAN_ALPHA_CENTRE = meanLimbIntensity(
  0,
  SUN_DISC_DAWN_REGIONS.centreOuterFraction,
);
const MEAN_ALPHA_ANNULUS = meanLimbIntensity(
  SUN_DISC_DAWN_REGIONS.annulusInnerFraction,
  SUN_DISC_DAWN_REGIONS.annulusOuterFraction,
);

/** A saturated warm aureole, in framebuffer bytes. */
const DAWN_SKY_BYTES = Object.freeze([255, 230, 200]);

/**
 * The engine's own camera-to-sun transmittance at each sweep altitude.
 *
 * Produced by evaluating `Scene/computeAtmosphereExtinction.js` at the
 * reproduction site with the shipped `Atmosphere` defaults. It is recorded here
 * so the "defect" fixture is the composite the engine's real numbers predict
 * rather than an invented dark patch.
 */
const SWEEP_EXTINCTION = Object.freeze([
  Object.freeze({ altitude: -1.89, rgb: [5.97e-8, 3.16e-10, 6.7e-15] }),
  Object.freeze({ altitude: -0.9, rgb: [3.41e-6, 5.54e-8, 1.17e-11] }),
  Object.freeze({ altitude: 0.1, rgb: [8.29e-5, 3.35e-6, 4.61e-9] }),
  Object.freeze({ altitude: 1.09, rgb: [1.0e-3, 8.29e-5, 4.96e-7] }),
  Object.freeze({ altitude: 2.09, rgb: [5.96e-3, 8.34e-4, 1.47e-5] }),
  Object.freeze({ altitude: 3.09, rgb: [1.59e-2, 3.17e-3, 1.16e-4] }),
  Object.freeze({ altitude: 4.1, rgb: [3.3e-2, 8.55e-3, 5.33e-4] }),
  Object.freeze({ altitude: 5.11, rgb: [6.19e-2, 1.97e-2, 1.88e-3] }),
  Object.freeze({ altitude: 6.11, rgb: [9.5e-2, 3.53e-2, 4.63e-3] }),
  Object.freeze({ altitude: 7.13, rgb: [1.3e-1, 5.43e-2, 9.1e-3] }),
  Object.freeze({ altitude: 8.14, rgb: [1.64e-1, 7.56e-2, 1.54e-2] }),
  Object.freeze({ altitude: 9.15, rgb: [1.98e-1, 9.83e-2, 2.34e-2] }),
  Object.freeze({ altitude: 10.17, rgb: [2.3e-1, 1.22e-1, 3.3e-2] }),
]);

/**
 * The site horizon geometry, as the engine's own ellipsoid resolves it at the
 * registered site.
 *
 * Not free literals: `A4` re-derives the geocentric radius from the WGS84
 * semi-axes read out of `Core/Ellipsoid.js`, ties the height to the registered
 * site, and ties the solar semi-diameter to `CesiumMath.SOLAR_RADIUS` read out
 * of `Core/Math.js` over the Earth-Sun distance range. The values themselves
 * are what the 2026-08-28 sweep's scene publishes.
 */
const ACQUIRED_SITE_GEOMETRY = Object.freeze({
  localEarthRadiusMeters: 6371122.716467735,
  siteHeightMeters: 1175.3399698570242,
  solarAngularRadiusDegrees: 0.2635835,
});

/**
 * The solar altitudes the 2026-08-28 acquisition recorded, in degrees, on BOTH
 * legs. Used to prove the horizon predicate classifies the real sweep the way
 * its own pixels do rather than only the way a synthetic fixture does.
 */
const ACQUIRED_ALTITUDES = Object.freeze([
  -2.245848016361972, -1.2559537011925765, -0.2628795, 0.7331951, 1.7320999,
  2.7336648, 3.7377237, 4.744114952721395, 5.7526758, 6.7632497, 7.7756813,
  8.7898151, 9.8054993,
]);

function luminanceOf([r, g, b]) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function composite(discBytes, alpha) {
  return DAWN_SKY_BYTES.map(
    (sky, channel) => alpha * discBytes[channel] + (1 - alpha) * sky,
  );
}

function regionRecord(bytes, pixels, extra = {}) {
  return {
    pixels,
    meanR: bytes[0],
    meanG: bytes[1],
    meanB: bytes[2],
    meanLuminance: luminanceOf(bytes),
    ...extra,
  };
}

/**
 * One sample built from a disc colour in bytes.
 *
 * @param {number} index Sample index.
 * @param {object} options Sample shape.
 * @returns {object} The sample record the gate reads.
 */
function makeSample(index, options = {}) {
  const entry = SWEEP_EXTINCTION[index];
  const discBytes = options.discBytes ?? [255, 255, 255];
  const visible = options.visible ?? entry.altitude > -1.1;
  const centreBytes =
    options.centreBytes ?? composite(discBytes, MEAN_ALPHA_CENTRE);
  const annulusBytes =
    options.annulusBytes ?? composite(discBytes, MEAN_ALPHA_ANNULUS);
  const pixels = options.pixels ?? 900;
  return {
    index,
    requestedIso: `2026-08-24T22:${String(10 + index * 5).padStart(2, "0")}:00.000Z`,
    observed: {
      sunAltitudeDegrees: options.altitude ?? entry.altitude,
      sunAzimuthDegrees: 80,
      sunVisible: "sunVisible" in options ? options.sunVisible : visible,
      solarAngularRadiusDegrees:
        options.solarAngularRadiusDegrees ??
        ACQUIRED_SITE_GEOMETRY.solarAngularRadiusDegrees,
      localEarthRadiusMeters:
        options.localEarthRadiusMeters ??
        ACQUIRED_SITE_GEOMETRY.localEarthRadiusMeters,
      siteHeightMeters:
        options.siteHeightMeters ?? ACQUIRED_SITE_GEOMETRY.siteHeightMeters,
      globeReady: options.globeReady ?? true,
      globeReadyWaitMs: 0,
      globeReadyFrames: 1,
      globeCommands: options.globeCommands ?? 21,
      icrfFrameResolved: options.icrfFrameResolved ?? true,
      geometryValid: options.geometryValid ?? true,
      centerX: 640,
      centerY: 360,
      limbPx: options.limbPx ?? 64,
      skyAtmosphereVisible: options.skyAtmosphereVisible ?? true,
      sunBloomActive: true,
      bakeHaloGain: 0,
      discRadiance: 1,
      useHdr: false,
      // Defaults to the pre-registered leg so every existing fixture reads as
      // correctly-exposed without setting the field itself (the same
      // opt-in-to-break-it shape `centreClipped`/`annulusClipped` already
      // use, J3's own rationale). `options.exposure` overrides it for the
      // fixtures that specifically exercise the exposure-leg check.
      exposure: options.exposure ?? { ...SUN_DISC_DAWN_EXPOSURE },
      limbDarkening: { ...SUN_DISC_DAWN_LIMB_COEFFICIENTS },
      extinction: { r: entry.rgb[0], g: entry.rgb[1], b: entry.rgb[2] },
      frame: { ...SUN_DISC_DAWN_VIEWPORT },
      regionWindow: null,
    },
    regions: visible
      ? {
          centre: regionRecord(
            centreBytes,
            options.centrePixels ?? pixels,
            options.centreClipped ? { clipped: true, clippedPixels: 1 } : {},
          ),
          annulus: regionRecord(
            annulusBytes,
            options.annulusPixels ?? pixels,
            options.annulusClipped ? { clipped: true, clippedPixels: 1 } : {},
          ),
        }
      : null,
    reasons: options.reasons ?? [],
  };
}

/** A sweep whose disc stays at display white — the shape a healthy sun makes. */
function healthyLeg(overrides = {}) {
  return SWEEP_EXTINCTION.map((entry, index) =>
    makeSample(index, {
      ...overrides,
      ...(overrides.perSample?.[index] ?? {}),
    }),
  );
}

/** A sweep whose disc is the extincted, reddened composite the engine predicts. */
function extinctedLeg(overrides = {}) {
  return SWEEP_EXTINCTION.map((entry, index) =>
    makeSample(index, {
      discBytes: entry.rgb.map((channel) => channel * 255),
      ...overrides,
      ...(overrides.perSample?.[index] ?? {}),
    }),
  );
}

function evidenceOf(webgl, webgpu) {
  return { samples: { webgl, webgpu } };
}

/** A bar a healthy sweep clears and the extincted sweep does not. */
const DERIVED_BAR = Object.freeze({
  status: "DERIVED-FIXTURE",
  minimumCentreAnnulusRatio: 1.0,
  minimumCentreAnnulusChromaRatio: 0.9,
  maximumParityDelta: 0.02,
});

// ---------------------------------------------------------------------------
// A. The reference the instrument is anchored on
// ---------------------------------------------------------------------------

test("A1: the limb coefficients are the engine's, not a private copy", () => {
  const engine = fs.readFileSync(
    path.join(REPO, "packages/engine/Source/Scene/SolarDiscModel.js"),
    "utf8",
  );
  const read = (name) => {
    const match = new RegExp(
      `const SOLAR_LIMB_DARKENING_${name} = (-?[0-9.]+);`,
    ).exec(engine);
    assert.ok(match, `engine constant SOLAR_LIMB_DARKENING_${name} not found`);
    return Number(match[1]);
  };
  assert.equal(read("A0"), SUN_DISC_DAWN_LIMB_COEFFICIENTS.a0);
  assert.equal(read("A1"), SUN_DISC_DAWN_LIMB_COEFFICIENTS.a1);
  assert.equal(read("A2"), SUN_DISC_DAWN_LIMB_COEFFICIENTS.a2);
});

test("A4: the fixture's horizon geometry is derived from the engine, not written down", () => {
  const ellipsoidSource = fs.readFileSync(
    path.join(REPO, "packages/engine/Source/Core/Ellipsoid.js"),
    "utf8",
  );
  const wgs84 =
    /Ellipsoid\.WGS84 = Object\.freeze\(\s*new Ellipsoid\(([0-9.]+), ([0-9.]+), ([0-9.]+)\)/.exec(
      ellipsoidSource,
    );
  assert.ok(wgs84, "the WGS84 semi-axes are not where this test reads them");
  const a = Number(wgs84[1]);
  const b = Number(wgs84[3]);

  // Geocentric radius of the ellipsoid surface under a geodetic latitude: the
  // prime-vertical radius of curvature carried through the parametric point.
  const phi = (SUN_DISC_DAWN_SITE.latitudeDegrees * Math.PI) / 180;
  const eccentricitySquared = 1 - (b * b) / (a * a);
  const primeVertical =
    a / Math.sqrt(1 - eccentricitySquared * Math.sin(phi) * Math.sin(phi));
  const x = primeVertical * Math.cos(phi);
  const z = primeVertical * (1 - eccentricitySquared) * Math.sin(phi);
  const derived = Math.hypot(x, z);
  assert.ok(
    Math.abs(derived - ACQUIRED_SITE_GEOMETRY.localEarthRadiusMeters) < 1e-6,
    `derived ${derived} vs fixture ${ACQUIRED_SITE_GEOMETRY.localEarthRadiusMeters}`,
  );
  assert.ok(b < derived && derived < a, "the radius must lie between the axes");

  assert.equal(
    ACQUIRED_SITE_GEOMETRY.siteHeightMeters,
    SUN_DISC_DAWN_SITE.heightMeters,
    "the fixture height must be the registered site height",
  );

  // The solar semi-diameter is tied to the engine's own solar radius over the
  // Earth-Sun distance range, so it cannot drift into an arbitrary number.
  const mathSource = fs.readFileSync(
    path.join(REPO, "packages/engine/Source/Core/Math.js"),
    "utf8",
  );
  const solar = /CesiumMath\.SOLAR_RADIUS = ([0-9.e+]+);/.exec(mathSource);
  assert.ok(solar, "SOLAR_RADIUS is not where this test reads it");
  const distance =
    Number(solar[1]) /
    Math.sin(
      (ACQUIRED_SITE_GEOMETRY.solarAngularRadiusDegrees * Math.PI) / 180,
    );
  assert.ok(
    distance > 1.46e11 && distance < 1.53e11,
    `implied Earth-Sun distance ${distance} m is outside the annual range`,
  );

  // The dip the whole exclusion turns on, stated once so a change to the
  // derivation shows up here rather than only as a reclassified sample.
  const dip = horizonDipDegrees(
    ACQUIRED_SITE_GEOMETRY.localEarthRadiusMeters,
    ACQUIRED_SITE_GEOMETRY.siteHeightMeters,
  );
  assert.ok(Math.abs(dip - -1.1004695) < 1e-6, `dip ${dip}`);
  assert.equal(horizonDipDegrees(Number.NaN, 1), null);
  assert.equal(horizonDipDegrees(6371000, Number.NaN), null);
});

test("A2: the shipped law puts the centre ABOVE the limb, so a sub-unity ratio is an inversion", () => {
  assert.ok(
    MEAN_ALPHA_CENTRE > MEAN_ALPHA_ANNULUS,
    "the centre blend weight must exceed the annulus blend weight",
  );
  assert.ok(
    SUN_DISC_DAWN_LIMB_REFERENCE_RATIO > 1,
    "the black-sky reference ratio must exceed 1",
  );
  assert.ok(Math.abs(SUN_DISC_DAWN_LIMB_REFERENCE_RATIO - 1.4398) < 1e-3);
});

test("A3: a healthy composite reads above 1 and the extincted composite far below it", () => {
  const healthy = healthyLeg();
  const extincted = extinctedLeg();
  const healthyRatio = centreAnnulusRatio(healthy[10]);
  const extinctedRatio = centreAnnulusRatio(extincted[10]);
  assert.ok(healthyRatio > 1, `healthy ratio ${healthyRatio}`);
  assert.ok(extinctedRatio < 0.5, `extincted ratio ${extinctedRatio}`);
  assert.ok(
    centreAnnulusChromaRatio(extincted[10]) < 0.4,
    "the extincted centre must lose blue relative to its own limb",
  );
  assert.ok(
    centreAnnulusChromaRatio(healthy[10]) >= 1,
    "a white disc cannot make its own centre redder than its limb",
  );
});

// ---------------------------------------------------------------------------
// B. The shipped bar has no standing
// ---------------------------------------------------------------------------

test("B1: the shipped bar is DERIVED-PENDING and every bound is null", () => {
  assert.equal(SUN_DISC_DAWN_BAR.status, "DERIVED-PENDING");
  assert.equal(SUN_DISC_DAWN_BAR.minimumCentreAnnulusRatio, null);
  assert.equal(SUN_DISC_DAWN_BAR.minimumCentreAnnulusChromaRatio, null);
  assert.equal(SUN_DISC_DAWN_BAR.maximumParityDelta, null);
});

test("B2: with the shipped bar even a perfect sweep folds STRUCTURAL, not PASS", () => {
  const result = evaluateSunDiscDawnSweep(
    evidenceOf(healthyLeg(), healthyLeg()),
  );
  assert.deepEqual(result.structural, []);
  assert.deepEqual(result.failures, []);
  assert.equal(result.status, "STRUCTURAL");
  assert.equal(result.exitCode, exitCodeForS5Status("STRUCTURAL"));
  assert.deepEqual(result.unproven.sort(), [
    "chroma:webgl",
    "chroma:webgpu",
    "parity",
    "ratio:webgl",
    "ratio:webgpu",
  ]);
});

test("B3: the artifact sweep also folds STRUCTURAL under the shipped bar — no verdict is earned by landing", () => {
  const result = evaluateSunDiscDawnSweep(
    evidenceOf(extinctedLeg(), extinctedLeg()),
  );
  assert.equal(result.status, "STRUCTURAL");
  assert.deepEqual(result.failures, []);
});

// ---------------------------------------------------------------------------
// C. With a derived bar the verdict branches are live
// ---------------------------------------------------------------------------

test("C1: a healthy sweep PASSES a derived bar", () => {
  const result = evaluateSunDiscDawnSweep(
    evidenceOf(healthyLeg(), healthyLeg()),
    { bar: DERIVED_BAR },
  );
  assert.deepEqual(result.structural, []);
  assert.equal(result.status, "PASS");
  assert.equal(result.exitCode, exitCodeForS5Status("PASS"));
});

test("C2: the extincted sweep FAILS on ratio and chroma, on both legs", () => {
  const result = evaluateSunDiscDawnSweep(
    evidenceOf(extinctedLeg(), extinctedLeg()),
    { bar: DERIVED_BAR },
  );
  assert.equal(result.status, "FAIL");
  assert.equal(result.exitCode, exitCodeForS5Status("FAIL"));
  assert.deepEqual(result.failures.sort(), [
    "chroma:webgl:below-bar",
    "chroma:webgpu:below-bar",
    "ratio:webgl:below-bar",
    "ratio:webgpu:below-bar",
  ]);
});

test("C3: a WebGPU-only defect fails the parity family while WebGL stays green", () => {
  const result = evaluateSunDiscDawnSweep(
    evidenceOf(healthyLeg(), extinctedLeg()),
    { bar: DERIVED_BAR },
  );
  assert.equal(result.status, "FAIL");
  assert.ok(result.failures.includes("parity:above-bar"));
  assert.ok(result.failures.includes("ratio:webgpu:below-bar"));
  assert.ok(!result.failures.includes("ratio:webgl:below-bar"));
});

test("C4: a hue-only defect fails chroma while the luminance ratio stays clear", () => {
  const browned = healthyLeg().map((sample) => {
    if (!sample.regions) {
      return sample;
    }
    const centre = [
      sample.regions.centre.meanR,
      sample.regions.centre.meanG * 0.72,
      sample.regions.centre.meanB * 0.35,
    ];
    return {
      ...sample,
      regions: {
        centre: regionRecord(centre, sample.regions.centre.pixels),
        annulus: sample.regions.annulus,
      },
    };
  });
  const bar = { ...DERIVED_BAR, minimumCentreAnnulusRatio: 0.6 };
  const result = evaluateSunDiscDawnSweep(evidenceOf(browned, browned), {
    bar,
  });
  assert.equal(result.status, "FAIL");
  assert.ok(result.failures.includes("chroma:webgl:below-bar"));
  assert.ok(!result.failures.includes("ratio:webgl:below-bar"));
});

// ---------------------------------------------------------------------------
// D. Blindness outranks the verdict
// ---------------------------------------------------------------------------

const BLINDNESS_CASES = [
  {
    id: "absent-sample",
    reason: "sweep:webgpu:sample4:absent",
    mutate: (leg) => leg.map((sample, index) => (index === 4 ? null : sample)),
  },
  {
    id: "underpopulated-centre",
    reason: "webgpu:sample6:centre-region-underpopulated",
    mutate: (leg) =>
      leg.map((sample, index) =>
        index === 6 ? makeSample(index, { centrePixels: 4 }) : sample,
      ),
  },
  {
    id: "limb-below-resolution",
    reason: "webgpu:sample6:limb-below-resolution",
    mutate: (leg) =>
      leg.map((sample, index) =>
        index === 6 ? makeSample(index, { limbPx: 5 }) : sample,
      ),
  },
  {
    id: "sky-atmosphere-hidden",
    reason: "webgpu:sample6:sky-atmosphere-hidden",
    mutate: (leg) =>
      leg.map((sample, index) =>
        index === 6
          ? makeSample(index, { skyAtmosphereVisible: false })
          : sample,
      ),
  },
  {
    id: "visibility-unreadable",
    reason: "webgpu:sample6:sun-visibility-unreadable",
    mutate: (leg) =>
      leg.map((sample, index) =>
        index === 6 ? makeSample(index, { sunVisible: null }) : sample,
      ),
  },
  {
    id: "page-reason",
    reason: "webgpu:sample2:drawing-buffer-does-not-match-snapshot",
    mutate: (leg) =>
      leg.map((sample, index) =>
        index === 2
          ? makeSample(index, {
              reasons: ["drawing-buffer-does-not-match-snapshot"],
            })
          : sample,
      ),
  },
];

for (const item of BLINDNESS_CASES) {
  test(`D1 ${item.id}: an unreadable sample routes STRUCTURAL, never FAIL`, () => {
    const result = evaluateSunDiscDawnSweep(
      evidenceOf(extinctedLeg(), item.mutate(extinctedLeg())),
      { bar: DERIVED_BAR },
    );
    assert.equal(result.status, "STRUCTURAL");
    assert.equal(result.exitCode, exitCodeForS5Status("STRUCTURAL"));
    assert.deepEqual(result.failures, []);
    assert.ok(
      result.structural.includes(item.reason),
      `expected ${item.reason} in ${JSON.stringify(result.structural)}`,
    );
  });
}

test("D2: a sweep that no longer spans the registered altitude band is blind", () => {
  const short = extinctedLeg().map((sample, index) =>
    makeSample(index, {
      altitude: sample.observed.sunAltitudeDegrees - 3,
      discBytes: SWEEP_EXTINCTION[index].rgb.map((c) => c * 255),
    }),
  );
  const result = evaluateSunDiscDawnSweep(evidenceOf(short, short), {
    bar: DERIVED_BAR,
  });
  assert.equal(result.status, "STRUCTURAL");
  assert.ok(result.structural.includes("sweep:webgl:altitude-coverage"));
});

test("D3: a non-monotone sweep is blind", () => {
  const scrambled = extinctedLeg();
  const swap = scrambled[3];
  scrambled[3] = scrambled[9];
  scrambled[9] = swap;
  scrambled.forEach((sample, index) => {
    sample.index = index;
  });
  const result = evaluateSunDiscDawnSweep(
    evidenceOf(scrambled, extinctedLeg()),
    { bar: DERIVED_BAR },
  );
  assert.equal(result.status, "STRUCTURAL");
  assert.ok(result.structural.includes("sweep:webgl:altitude-not-monotone"));
});

test("D4: legs that disagree about the sun's altitude are blind, not compared", () => {
  const shifted = extinctedLeg().map((sample, index) =>
    makeSample(index, {
      altitude: sample.observed.sunAltitudeDegrees + 0.5,
      discBytes: SWEEP_EXTINCTION[index].rgb.map((c) => c * 255),
    }),
  );
  const result = evaluateSunDiscDawnSweep(evidenceOf(extinctedLeg(), shifted), {
    bar: DERIVED_BAR,
  });
  assert.equal(result.status, "STRUCTURAL");
  assert.ok(
    result.structural.some((reason) =>
      reason.startsWith("sweep:altitude-disagreement"),
    ),
  );
});

test("D5: legs that disagree about WHICH samples carry a disc are blind", () => {
  const hidden = extinctedLeg().map((sample, index) =>
    index === 7
      ? makeSample(index, {
          sunVisible: false,
          visible: false,
          discBytes: SWEEP_EXTINCTION[index].rgb.map((c) => c * 255),
        })
      : sample,
  );
  const result = evaluateSunDiscDawnSweep(evidenceOf(extinctedLeg(), hidden), {
    bar: DERIVED_BAR,
  });
  assert.equal(result.status, "STRUCTURAL");
  assert.ok(
    result.structural.includes("sweep:visibility-disagreement:sample7"),
  );
});

test("D6: below-horizon samples are excluded from scoring, not treated as blindness", () => {
  const legs = healthyLeg();
  const result = evaluateSunDiscDawnSweep(evidenceOf(legs, healthyLeg()), {
    bar: DERIVED_BAR,
  });
  assert.deepEqual(result.structural, []);
  assert.equal(result.status, "PASS");
  assert.equal(result.measurements.webgl[0].scored, false);
  assert.equal(result.measurements.webgl[0].centreAnnulusRatio, null);
  assert.equal(result.measurements.webgl[2].scored, true);
});

test("D7: a sample the ENGINE calls visible below the horizon is still excluded", () => {
  // The acquisition measured isSunVisible true on all thirteen rows of both
  // legs, so this is the shape the real instrument produces - not a contrived
  // one. The engine flag is deliberately left true here.
  const legs = healthyLeg({
    perSample: { 0: { sunVisible: true, visible: true } },
  });
  assert.equal(legs[0].observed.sunVisible, true);
  assert.equal(sampleIsScored(legs[0]), false);
  const result = evaluateSunDiscDawnSweep(evidenceOf(legs, legs), {
    bar: DERIVED_BAR,
  });
  assert.deepEqual(result.structural, []);
  assert.equal(result.measurements.webgl[0].scored, false);
  assert.equal(result.measurements.webgl[0].sunVisible, true);
  assert.equal(result.measurements.webgl[0].sunAboveLocalHorizon, false);
});

test("D8: the acquired sweep is classified the way its own pixels are", () => {
  // Samples 0 and 1 are the two whose WebGL frames carry globe INSIDE the disc
  // window (100 % and 49.4 % of the frame); sample 2's window is clear.
  const classify = (altitude) =>
    sunAboveLocalHorizon({
      sunAltitudeDegrees: altitude,
      ...ACQUIRED_SITE_GEOMETRY,
    });
  assert.equal(classify(ACQUIRED_ALTITUDES[0]), false);
  assert.equal(classify(ACQUIRED_ALTITUDES[1]), false);
  for (let index = 2; index < ACQUIRED_ALTITUDES.length; index++) {
    assert.equal(
      classify(ACQUIRED_ALTITUDES[index]),
      true,
      `sample ${index} at ${ACQUIRED_ALTITUDES[index]} deg`,
    );
  }
  // The nearest row to the threshold clears it by far more than the modelling
  // error the dip derivation admits, so no row's classification is marginal.
  const threshold =
    horizonDipDegrees(
      ACQUIRED_SITE_GEOMETRY.localEarthRadiusMeters,
      ACQUIRED_SITE_GEOMETRY.siteHeightMeters,
    ) + ACQUIRED_SITE_GEOMETRY.solarAngularRadiusDegrees;
  const margins = ACQUIRED_ALTITUDES.map((altitude) =>
    Math.abs(altitude - threshold),
  );
  assert.ok(
    Math.min(...margins) > 0.4,
    `nearest margin ${Math.min(...margins)}`,
  );
});

test("D9: a leg that never got its globe on screen is blind, not scored", () => {
  const blind = healthyLeg({ globeReady: false });
  const result = evaluateSunDiscDawnSweep(evidenceOf(healthyLeg(), blind), {
    bar: DERIVED_BAR,
  });
  assert.equal(result.status, "STRUCTURAL");
  assert.deepEqual(result.failures, []);
  assert.ok(result.structural.includes("webgpu:sample0:globe-not-ready"));
});

test("D10: an acquisition without the horizon geometry is unreadable, not permissive", () => {
  const stripped = healthyLeg().map((sample) => {
    const observed = { ...sample.observed };
    delete observed.solarAngularRadiusDegrees;
    return { ...sample, observed };
  });
  assert.equal(sunAboveLocalHorizon(stripped[6].observed), null);
  assert.equal(sampleIsScored(stripped[6]), false);
  const result = evaluateSunDiscDawnSweep(evidenceOf(healthyLeg(), stripped), {
    bar: DERIVED_BAR,
  });
  assert.equal(result.status, "STRUCTURAL");
  assert.ok(
    result.structural.includes("webgpu:sample6:horizon-geometry-unreadable"),
  );
});

test("D11: every measurement row publishes the terms its verdict was formed from", () => {
  const result = evaluateSunDiscDawnSweep(
    evidenceOf(healthyLeg(), healthyLeg()),
    { bar: DERIVED_BAR },
  );
  for (const renderer of SUN_DISC_DAWN_RENDERERS) {
    for (const row of result.measurements[renderer]) {
      for (const field of [
        "sunVisible",
        "sunAboveLocalHorizon",
        "solarAngularRadiusDegrees",
        "horizonDipDegrees",
        "geometryValid",
        "globeReady",
        "globeCommands",
        "icrfFrameResolved",
      ]) {
        assert.ok(
          Object.hasOwn(row, field),
          `row ${renderer}:${row.index} does not publish ${field}`,
        );
      }
      assert.equal(
        row.scored,
        row.sunVisible === true && row.sunAboveLocalHorizon === true,
        `row ${renderer}:${row.index} scored does not follow from its own terms`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// E. The page instrument, executed
// ---------------------------------------------------------------------------

function extractMarkedBlock(source, begin, end) {
  const start = source.indexOf(begin);
  const finish = source.indexOf(end);
  assert.ok(start >= 0 && finish > start, `markers ${begin} / ${end} missing`);
  const block = source
    .slice(start + begin.length, finish)
    .replace(/^\n/, "")
    .replace(/\n[ \t]*$/, "");
  const indents = block
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => line.match(/^[ \t]*/u)[0]);
  const common = indents.sort((a, b) => a.length - b.length)[0] ?? "";
  return block
    .split("\n")
    .map((line) => (line.startsWith(common) ? line.slice(common.length) : line))
    .join("\n");
}

/**
 * Load the probe's page instrument as its own module and run `use` against it.
 *
 * A standalone module is deliberately stronger evidence than an evaluated
 * closure: the block gets NO enclosing scope at all, so a reference to any
 * binding that is not a genuine global fails to resolve exactly as it would
 * inside `page.evaluate`.
 *
 * @param {Function} use Receives the block's exported helpers.
 * @returns {Promise<*>} Whatever `use` returns.
 */
async function withPageInstrument(use) {
  const block = extractMarkedBlock(
    probeSource(),
    "// ==BEGIN sun-disc-dawn-page-instrument==",
    "// ==END sun-disc-dawn-page-instrument==",
  );
  const file = path.join(HERE, `${PAGE_MODULE_PREFIX}${randomUUID()}.mjs`);
  const exports =
    "export { measureDiscRegions, localAltitudeAzimuth, relativeLuminance, " +
    "countGlobeCommands, awaitGlobeReady, applyUnclippedExposureLeg };";
  try {
    fs.writeFileSync(file, `${block}\n${exports}\n`, { flag: "wx" });
    const module = await import(
      `${pathToFileURL(file).href}?instrument=${randomUUID()}`
    );
    return await use(module);
  } finally {
    try {
      fs.unlinkSync(file);
    } catch (error) {
      assert.equal(
        error?.code,
        "ENOENT",
        `instrument cleanup failed: ${error}`,
      );
    }
    assert.equal(fs.existsSync(file), false, `${file} survived cleanup`);
  }
}

function syntheticFrame(width, height, paint) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const [r, g, b] = paint(x, y);
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      data[offset + 3] = 255;
    }
  }
  return { width, height, data };
}

test("E1: the page reducer runs in Node and separates the core from the limb", async () => {
  await withPageInstrument(async ({ measureDiscRegions }) => {
    const width = 256;
    const height = 256;
    const centerX = 128;
    const centerYFromBottom = 100;
    const centerYFromTop = height - 1 - centerYFromBottom;
    const limbPx = 60;
    const frame = syntheticFrame(width, height, (x, y) => {
      const dx = x + 0.5 - centerX;
      const dy = y + 0.5 - centerYFromTop;
      const radius = Math.sqrt(dx * dx + dy * dy);
      if (radius <= limbPx * SUN_DISC_DAWN_REGIONS.centreOuterFraction) {
        return [40, 20, 5];
      }
      if (radius >= limbPx * SUN_DISC_DAWN_REGIONS.annulusInnerFraction) {
        return [200, 180, 150];
      }
      return [0, 0, 0];
    });
    const measured = measureDiscRegions(
      frame,
      centerX,
      centerYFromBottom,
      limbPx,
      SUN_DISC_DAWN_REGIONS,
    );
    assert.equal(measured.centerYFromTop, centerYFromTop);
    assert.ok(measured.centre.pixels > 300, `${measured.centre.pixels}`);
    assert.ok(measured.annulus.pixels > 300, `${measured.annulus.pixels}`);
    assert.equal(measured.centre.meanR, 40);
    assert.equal(measured.centre.meanB, 5);
    assert.equal(measured.annulus.meanR, 200);
    assert.equal(measured.annulus.meanB, 150);
    assert.ok(
      Math.abs(measured.centre.meanLuminance - luminanceOf([40, 20, 5])) <
        1e-12,
    );
  });
});

test("E2: the reducer honours the GL-to-ImageData row flip", async () => {
  await withPageInstrument(async ({ measureDiscRegions }) => {
    const frame = syntheticFrame(64, 64, (x, y) =>
      y < 32 ? [10, 10, 10] : [250, 250, 250],
    );
    const top = measureDiscRegions(frame, 32, 48, 20, SUN_DISC_DAWN_REGIONS);
    const bottom = measureDiscRegions(frame, 32, 16, 20, SUN_DISC_DAWN_REGIONS);
    assert.ok(
      top.centre.meanR < bottom.centre.meanR,
      "a high GL y must read the TOP rows of the ImageData",
    );
  });
});

test("E3: the page altitude helper agrees with the sweep window it was written for", async () => {
  await withPageInstrument(async ({ localAltitudeAzimuth }) => {
    const east = [1, 0, 0];
    const north = [0, 1, 0];
    const up = [0, 0, 1];
    const thirty = localAltitudeAzimuth(east, north, up, [
      0,
      Math.cos(Math.PI / 6),
      Math.sin(Math.PI / 6),
    ]);
    assert.ok(Math.abs(thirty.altitudeDegrees - 30) < 1e-9);
    assert.ok(Math.abs(thirty.azimuthDegrees - 0) < 1e-9);
    const eastward = localAltitudeAzimuth(east, north, up, [1, 0, 0]);
    assert.ok(Math.abs(eastward.azimuthDegrees - 90) < 1e-9);
    const degenerate = localAltitudeAzimuth(east, north, up, [0, 0, 0]);
    assert.ok(Number.isNaN(degenerate.altitudeDegrees));
  });
});

/** A scene stub whose binned GLOBE count is whatever the test says it is. */
function fakeScene(tilesLoaded, globeSlot, counts) {
  return {
    globe: { tilesLoaded },
    _view: {
      frustumCommandsList: counts.map((count) => ({
        indices: { [globeSlot]: count },
      })),
    },
  };
}

test("E6: the readiness counter reads the GLOBE slot across the whole frustum list", async () => {
  await withPageInstrument(async ({ countGlobeCommands }) => {
    const slot = 2;
    assert.equal(countGlobeCommands(fakeScene(true, slot, [3, 4, 0]), slot), 7);
    assert.equal(countGlobeCommands(fakeScene(true, slot, []), slot), 0);
    // A pass index that is not an integer would index `undefined`, and `| 0`
    // would report a confident zero. It must report "unreadable" instead.
    assert.equal(
      countGlobeCommands(fakeScene(true, slot, [3]), undefined),
      null,
    );
    assert.equal(countGlobeCommands({}, slot), null);
  });
});

test("E7: readiness waits on a binned globe command, never on tilesLoaded alone", async () => {
  await withPageInstrument(async ({ awaitGlobeReady }) => {
    const slot = 2;
    // A virtual clock, so the bound is exercised without spending it.
    let clock = 0;
    const now = () => clock;
    const sleep = (ms) =>
      new Promise((resolve) => {
        clock += ms;
        resolve();
      });

    // Tiles resident, pipeline not: the WebGPU shape the acquisition hit. The
    // gate must spend its whole budget and report NOT ready.
    let renders = 0;
    const starved = await awaitGlobeReady(
      fakeScene(true, slot, [0, 0]),
      slot,
      () => {
        renders++;
      },
      sleep,
      now,
      1000,
      50,
    );
    assert.equal(starved.ready, false);
    assert.equal(starved.commands, 0);
    assert.ok(starved.waitedMs >= 1000, `waited ${starved.waitedMs}`);
    assert.ok(renders > 1, "the gate must keep rendering while it waits");

    // The command lands part way through: ready, early, and with the frames it
    // actually spent recorded.
    clock = 0;
    let polls = 0;
    const landing = {
      globe: { tilesLoaded: true },
      _view: { frustumCommandsList: [{ indices: { [slot]: 0 } }] },
    };
    const arrived = await awaitGlobeReady(
      landing,
      slot,
      () => {
        polls++;
        if (polls === 4) {
          landing._view.frustumCommandsList[0].indices[slot] = 21;
        }
      },
      sleep,
      now,
      10_000,
      50,
    );
    assert.equal(arrived.ready, true);
    assert.equal(arrived.commands, 21);
    assert.equal(arrived.frames, 4);
    assert.ok(arrived.waitedMs < 10_000);

    // Commands binned but tiles still streaming is also not ready: both terms
    // are load-bearing.
    clock = 0;
    const streaming = await awaitGlobeReady(
      fakeScene(false, slot, [21]),
      slot,
      () => {},
      sleep,
      now,
      500,
      50,
    );
    assert.equal(streaming.ready, false);
  });
});

// ---------------------------------------------------------------------------
// H. The unclipped-exposure leg (C12-38 instrument gap, 2026-09-02)
// ---------------------------------------------------------------------------

test("H1: SUN_DISC_DAWN_EXPOSURE turns HDR on and reduces exposure below 1", () => {
  assert.equal(SUN_DISC_DAWN_EXPOSURE.highDynamicRange, true);
  assert.ok(
    SUN_DISC_DAWN_EXPOSURE.value > 0 && SUN_DISC_DAWN_EXPOSURE.value < 1,
    `expected an under-1 exposure, got ${SUN_DISC_DAWN_EXPOSURE.value}`,
  );
});

test("H2: applyUnclippedExposureLeg writes both public properties and reports what it wrote", async () => {
  await withPageInstrument(async ({ applyUnclippedExposureLeg }) => {
    const scene = {
      highDynamicRange: false,
      postProcessStages: { exposure: 1.0 },
    };
    const result = applyUnclippedExposureLeg(scene, SUN_DISC_DAWN_EXPOSURE);
    assert.equal(scene.highDynamicRange, true);
    assert.equal(
      scene.postProcessStages.exposure,
      SUN_DISC_DAWN_EXPOSURE.value,
    );
    assert.deepEqual(result, { hdrApplied: true, exposureApplied: true });
  });
});

test("H3: applyUnclippedExposureLeg reports the exposure write as unattempted, never crashes, when postProcessStages does not exist yet", async () => {
  await withPageInstrument(async ({ applyUnclippedExposureLeg }) => {
    const scene = { highDynamicRange: false };
    const result = applyUnclippedExposureLeg(scene, SUN_DISC_DAWN_EXPOSURE);
    assert.equal(scene.highDynamicRange, true);
    assert.deepEqual(result, { hdrApplied: true, exposureApplied: false });
  });
});

test("H4 MUTATION control: an exposure write that silently fails is detected as unapplied", async () => {
  await withPageInstrument(async ({ applyUnclippedExposureLeg }) => {
    // A scene whose `highDynamicRange` setter refuses the write (e.g. a
    // context that does not support HDR) — the healthy assertion above is
    // that `hdrApplied` reads the property back rather than trusting the
    // assignment, and this fixture is what makes that check live.
    const scene = {
      _hdr: false,
      get highDynamicRange() {
        return this._hdr;
      },
      set highDynamicRange(_value) {
        // Refuses the write — models an unsupported context.
      },
      postProcessStages: { exposure: 1.0 },
    };
    const result = applyUnclippedExposureLeg(scene, SUN_DISC_DAWN_EXPOSURE);
    assert.equal(result.hdrApplied, false);
  });
});

test("I1: measureDiscRegions reports a region unclipped when no channel reaches 255", async () => {
  await withPageInstrument(async ({ measureDiscRegions }) => {
    const width = 128;
    const height = 128;
    const centerX = 64;
    const centerYFromBottom = 64;
    const limbPx = 40;
    const frame = syntheticFrame(width, height, () => [200, 190, 180]);
    const measured = measureDiscRegions(
      frame,
      centerX,
      centerYFromBottom,
      limbPx,
      SUN_DISC_DAWN_REGIONS,
    );
    assert.equal(measured.centre.clipped, false);
    assert.equal(measured.centre.clippedPixels, 0);
    assert.equal(measured.centre.clippedFraction, 0);
    assert.equal(measured.annulus.clipped, false);
    assert.equal(measured.annulus.clippedPixels, 0);
    assert.equal(measured.annulus.clippedFraction, 0);
  });
});

test("I2: measureDiscRegions flags a region clipped when any channel saturates, and counts the pixels", async () => {
  await withPageInstrument(async ({ measureDiscRegions }) => {
    const width = 128;
    const height = 128;
    const centerX = 64;
    const centerYFromTop = 64;
    const limbPx = 40;
    // Pure white inside the centre core; a warm but unsaturated annulus.
    const frame = syntheticFrame(width, height, (x, y) => {
      const dx = x + 0.5 - centerX;
      const dy = y + 0.5 - centerYFromTop;
      const radius = Math.sqrt(dx * dx + dy * dy);
      return radius <= limbPx * SUN_DISC_DAWN_REGIONS.centreOuterFraction
        ? [255, 255, 255]
        : [200, 190, 180];
    });
    const centerYFromBottom = height - 1 - centerYFromTop;
    const measured = measureDiscRegions(
      frame,
      centerX,
      centerYFromBottom,
      limbPx,
      SUN_DISC_DAWN_REGIONS,
    );
    assert.equal(measured.centre.clipped, true);
    assert.equal(measured.centre.clippedPixels, measured.centre.pixels);
    // Every centre pixel is [255,255,255] — a total wash, not a near-miss —
    // so the fraction the gate would need to distinguish the two is exactly 1.
    assert.equal(measured.centre.clippedFraction, 1);
    assert.equal(measured.annulus.clipped, false);
    assert.equal(measured.annulus.clippedPixels, 0);
    assert.equal(measured.annulus.clippedFraction, 0);
  });
});

test("I3: a single saturated channel is enough to flag a pixel clipped, not just a saturated white", async () => {
  await withPageInstrument(async ({ measureDiscRegions }) => {
    const width = 128;
    const height = 128;
    const centerX = 64;
    const centerYFromTop = 64;
    const limbPx = 40;
    // Blue alone saturates; red/green stay mid-tone. A byte-max check on the
    // WHOLE pixel (e.g. requiring all three channels at 255) would miss this.
    const frame = syntheticFrame(width, height, () => [120, 120, 255]);
    const centerYFromBottom = height - 1 - centerYFromTop;
    const measured = measureDiscRegions(
      frame,
      centerX,
      centerYFromBottom,
      limbPx,
      SUN_DISC_DAWN_REGIONS,
    );
    assert.equal(measured.centre.clipped, true);
  });
});

test("E4: the page instrument closes over NO Node-scope binding of the probe", () => {
  const source = probeSource();
  const block = extractMarkedBlock(
    source,
    "// ==BEGIN sun-disc-dawn-page-instrument==",
    "// ==END sun-disc-dawn-page-instrument==",
  );
  const topLevel = new Set();
  for (const match of source.matchAll(
    /^(?:export\s+)?(?:async\s+)?(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/gmu,
  )) {
    topLevel.add(match[1]);
  }
  for (const match of source.matchAll(/^import\s+([\s\S]*?)\s+from\s+/gmu)) {
    for (const name of match[1].replace(/[{}]/g, " ").split(/[\s,]+/)) {
      if (/^[A-Za-z_$][\w$]*$/.test(name)) {
        topLevel.add(name);
      }
    }
  }
  assert.ok(topLevel.size > 20, "the top-level census looks empty");
  const used = new Set();
  for (const token of tokenizer(block, { ecmaVersion: "latest" })) {
    if (token.type.label === "name") {
      used.add(token.value);
    }
  }
  const leaked = [...used].filter((name) => topLevel.has(name)).sort();
  assert.deepEqual(
    leaked,
    [],
    `a Node-scope symbol inside page.evaluate is a ReferenceError in the browser: ${leaked.join(", ")}`,
  );
});

test("E5 MUTATION control: a leaked Node-scope symbol IS detected", () => {
  const source = probeSource().replace(
    "  const RECIPROCAL_255 = 1 / 255;",
    "  const RECIPROCAL_255 = defaultOutputRoot ? 1 / 255 : 1 / 255;",
  );
  const block = extractMarkedBlock(
    source,
    "// ==BEGIN sun-disc-dawn-page-instrument==",
    "// ==END sun-disc-dawn-page-instrument==",
  );
  const used = new Set();
  for (const token of tokenizer(block, { ecmaVersion: "latest" })) {
    if (token.type.label === "name") {
      used.add(token.value);
    }
  }
  assert.ok(used.has("defaultOutputRoot"));
});

// ---------------------------------------------------------------------------
// F. The fleet contract, executed over the real probe source
// ---------------------------------------------------------------------------

test("F1: the probe carries the canonical fused-snapshot block and fuses every read", () => {
  const source = probeSource();
  assert.deepEqual(checkEmbeddedFusedSnapshotIsCanonical(source), []);
  assert.deepEqual(checkFusedCaptureUsage(source), []);
});

test("F2 MUTATION control: a drifted capture block is detected", () => {
  const drifted = probeSource().replace(
    '      const dataUrl = canvas.toDataURL("image/png");',
    '      await new Promise((r) => requestAnimationFrame(r));\n      const dataUrl = canvas.toDataURL("image/png");',
  );
  assert.notEqual(drifted, probeSource());
  assert.notDeepEqual(checkEmbeddedFusedSnapshotIsCanonical(drifted), []);
});

test("F3: the probe claims no allowlist row on either fleet ratchet", () => {
  assert.ok(
    !Object.hasOwn(PROBE_CONTRACT_ALLOWLIST, "probe-sun-disc-dawn.mjs"),
    "the machine-safety allowlist is closed and shrink-only",
  );
  assert.ok(
    !PURPOSE_HEADER_ALLOWLIST.includes("probe-sun-disc-dawn.mjs"),
    "the header allowlist is closed and shrink-only",
  );
  assert.ok(
    !PURPOSE_HEADER_ALLOWLIST.includes("lib/sun-disc-dawn-gate.mjs"),
    "the header allowlist is closed and shrink-only",
  );
});

/**
 * Failures in the sweep's readiness contract, as a pure function of the source.
 *
 * @param {string} source The probe source.
 * @returns {string[]} Contract failures; empty when the contract holds.
 */
function checkSweepReadinessContract(source) {
  const failures = [];
  if (/tilesLoaded\s*===\s*true\s*\)\s*\{\s*break/u.test(source)) {
    failures.push("the sweep settles by exiting on tilesLoaded alone");
  }
  if (!/globeReadiness = await awaitGlobeReady\(/u.test(source)) {
    failures.push("the sweep never spends the readiness gate");
  }
  if (
    !/RUN_WATCHDOG_MS = Math\.max\([\s\S]{0,120}?SUN_DISC_DAWN_READINESS_WORST_CASE_MS/u.test(
      source,
    )
  ) {
    failures.push("the run fuse is not derived from the readiness budget");
  }
  return failures;
}

test("P1: the sweep waits on the globe pipeline, not on tile residency", () => {
  assert.deepEqual(checkSweepReadinessContract(probeSource()), []);
});

test("P2 MUTATION control: the old tilesLoaded settle is detected if it returns", () => {
  const settle =
    "    for (let frame = 0; frame < config.readiness.settleFrames; frame++) {";
  const regressed = probeSource().replace(
    settle,
    [
      settle,
      "      if (scene.globe.tilesLoaded === true) {",
      "        break;",
      "      }",
    ].join("\n"),
  );
  assert.notEqual(regressed, probeSource());
  assert.deepEqual(checkSweepReadinessContract(regressed), [
    "the sweep settles by exiting on tilesLoaded alone",
  ]);
});

test("P3: the readiness budget is bounded and both legs fit the registered fuse", () => {
  assert.equal(
    SUN_DISC_DAWN_READINESS_WORST_CASE_MS,
    SUN_DISC_DAWN_RENDERERS.length * SUN_DISC_DAWN_READINESS.initialTimeoutMs,
  );
  assert.ok(SUN_DISC_DAWN_READINESS.initialTimeoutMs >= 30_000);
  assert.ok(SUN_DISC_DAWN_READINESS.pollMs > 0);
  assert.ok(SUN_DISC_DAWN_READINESS.settleFrames >= 1);
});

// ---------------------------------------------------------------------------
// G. Mutation teeth — one weakening and one inertness form per family
// ---------------------------------------------------------------------------

function replaceExactlyOnce(source, anchor, replacement) {
  const count = source.split(anchor).length - 1;
  assert.equal(count, 1, `mutation anchor count for ${JSON.stringify(anchor)}`);
  const mutated = source.replace(anchor, replacement);
  assert.notEqual(mutated, source, "mutation did not change source");
  return mutated;
}

async function withMutant(transform, use) {
  const file = path.join(HERE, "lib", `${TEMP_PREFIX}${randomUUID()}.mjs`);
  const mutated = transform(gateSource());
  try {
    fs.writeFileSync(file, mutated, { flag: "wx" });
    const module = await import(
      `${pathToFileURL(file).href}?mutation=${randomUUID()}`
    );
    return await use(module);
  } finally {
    try {
      fs.unlinkSync(file);
    } catch (error) {
      assert.equal(error?.code, "ENOENT", `mutant cleanup failed: ${error}`);
    }
    assert.equal(fs.existsSync(file), false, `${file} survived cleanup`);
  }
}

const TEETH = [
  {
    id: "ratio/weakened-worst-case",
    family: "ratio:webgpu:below-bar",
    anchor:
      "      lowest === null || entry.value < lowest.value ? entry : lowest,",
    replacement:
      "      lowest === null || entry.value > lowest.value ? entry : lowest,",
    evidence: () => evidenceOf(healthyLeg(), mixedParityLeg()),
    bar: () => ({ ...DERIVED_BAR, maximumParityDelta: 10 }),
  },
  {
    id: "ratio/inert-comparison",
    family: "ratio:webgpu:below-bar",
    anchor: "  const pass = worst.value >= bound;",
    replacement: "  const pass = !(false && worst.value < bound);",
    evidence: () => evidenceOf(healthyLeg(), extinctedLeg()),
    bar: () => ({ ...DERIVED_BAR, maximumParityDelta: 10 }),
  },
  {
    id: "chroma/weakened-blue-term",
    family: "chroma:webgpu:below-bar",
    anchor: "  const centreBlueOverRed = centre.meanB / centre.meanR;",
    replacement: "  const centreBlueOverRed = annulus.meanB / annulus.meanR;",
    evidence: () => evidenceOf(healthyLeg(), extinctedLeg()),
    bar: () => ({
      ...DERIVED_BAR,
      minimumCentreAnnulusRatio: 0.05,
      maximumParityDelta: 10,
    }),
  },
  {
    id: "chroma/inert-ratio",
    family: "chroma:webgpu:below-bar",
    anchor: "  return centreBlueOverRed / annulusBlueOverRed;",
    replacement:
      "  return false && centreBlueOverRed < annulusBlueOverRed ? centreBlueOverRed / annulusBlueOverRed : 1;",
    evidence: () => evidenceOf(healthyLeg(), extinctedLeg()),
    bar: () => ({
      ...DERIVED_BAR,
      minimumCentreAnnulusRatio: 0.05,
      maximumParityDelta: 10,
    }),
  },
  {
    id: "parity/weakened-worst-case",
    family: "parity:above-bar",
    anchor:
      "      highest === null || entry.value > highest.value ? entry : highest,",
    replacement:
      "      highest === null || entry.value < highest.value ? entry : highest,",
    evidence: () => evidenceOf(healthyLeg(), mixedParityLeg()),
    bar: () => ({
      ...DERIVED_BAR,
      minimumCentreAnnulusRatio: 0.05,
      minimumCentreAnnulusChromaRatio: 0.05,
    }),
  },
  {
    id: "parity/inert-comparison",
    family: "parity:above-bar",
    anchor: "  const pass = worst.value <= bound;",
    replacement: "  const pass = !(false && worst.value > bound);",
    evidence: () => evidenceOf(healthyLeg(), extinctedLeg()),
    bar: () => ({
      ...DERIVED_BAR,
      minimumCentreAnnulusRatio: 0.05,
      minimumCentreAnnulusChromaRatio: 0.05,
    }),
  },
];

/** A leg whose parity delta is large on ONE sample only. */
function mixedParityLeg() {
  return healthyLeg().map((sample, index) =>
    index === 8
      ? makeSample(index, {
          discBytes: SWEEP_EXTINCTION[index].rgb.map((c) => c * 255),
        })
      : sample,
  );
}

for (const tooth of TEETH) {
  test(`G1 ${tooth.id}: the family is RED before the mutation`, () => {
    const result = evaluateSunDiscDawnSweep(tooth.evidence(), {
      bar: tooth.bar(),
    });
    assert.equal(result.status, "FAIL", JSON.stringify(result.failures));
    assert.ok(
      result.failures.includes(tooth.family),
      `${tooth.family} missing from ${JSON.stringify(result.failures)}`,
    );
  });

  test(`G2 ${tooth.id}: the mutation turns it GREEN, so the predicate is live`, async () => {
    await withMutant(
      (source) => replaceExactlyOnce(source, tooth.anchor, tooth.replacement),
      async (module) => {
        const result = module.evaluateSunDiscDawnSweep(tooth.evidence(), {
          bar: tooth.bar(),
        });
        assert.ok(
          !result.failures.includes(tooth.family),
          `${tooth.family} survived the mutation: ${JSON.stringify(result.failures)}`,
        );
      },
    );
  });
}

test("G3 coverage/weakened-band: relaxing the required band un-blinds a short sweep", async () => {
  const short = extinctedLeg().map((sample, index) =>
    makeSample(index, {
      altitude: sample.observed.sunAltitudeDegrees - 3,
      discBytes: SWEEP_EXTINCTION[index].rgb.map((c) => c * 255),
    }),
  );
  await withMutant(
    (source) =>
      replaceExactlyOnce(
        source,
        "  requiredHighAltitudeDegrees: 9.5,",
        "  requiredHighAltitudeDegrees: -90,",
      ),
    async (module) => {
      const result = module.evaluateSunDiscDawnSweep(evidenceOf(short, short), {
        bar: DERIVED_BAR,
      });
      assert.ok(
        !result.structural.some((reason) =>
          reason.endsWith("altitude-coverage"),
        ),
        JSON.stringify(result.structural),
      );
    },
  );
});

test("G4 coverage/inert-family: making the coverage family unreachable un-blinds it", async () => {
  // A ONE-degree shift, not three: it still fails the registered upper bound,
  // and it leaves ten rows above the local horizon so the sweep can reach a
  // scored verdict once the coverage family is made unreachable. A three-degree
  // shift puts every row below the horizon, and an unscored sweep folds
  // NOT-PROVEN rather than FAIL, which would test the wrong thing.
  const short = extinctedLeg().map((sample, index) =>
    makeSample(index, {
      altitude: sample.observed.sunAltitudeDegrees - 1,
      discBytes: SWEEP_EXTINCTION[index].rgb.map((c) => c * 255),
    }),
  );
  const before = evaluateSunDiscDawnSweep(evidenceOf(short, short), {
    bar: DERIVED_BAR,
  });
  assert.equal(before.status, "STRUCTURAL");
  await withMutant(
    (source) =>
      replaceExactlyOnce(
        source,
        "    structural.push(...coverageReasons(evidence));",
        "    structural.push(...(false ? coverageReasons(evidence) : []));",
      ),
    async (module) => {
      const result = module.evaluateSunDiscDawnSweep(evidenceOf(short, short), {
        bar: DERIVED_BAR,
      });
      assert.deepEqual(result.structural, []);
      assert.equal(result.status, "FAIL");
    },
  );
});

test("G5 sampling/weakened-population: dropping the pixel floor un-blinds a starved region", async () => {
  const starved = extinctedLeg().map((sample, index) =>
    index === 6
      ? makeSample(index, {
          centrePixels: 4,
          discBytes: SWEEP_EXTINCTION[index].rgb.map((c) => c * 255),
        })
      : sample,
  );
  await withMutant(
    (source) =>
      replaceExactlyOnce(
        source,
        "  minimumRegionPixels: 48,",
        "  minimumRegionPixels: 0,",
      ),
    async (module) => {
      const result = module.evaluateSunDiscDawnSweep(
        evidenceOf(extinctedLeg(), starved),
        { bar: DERIVED_BAR },
      );
      assert.deepEqual(result.structural, []);
      assert.equal(result.status, "FAIL");
    },
  );
});

test("G6 sampling/inert-family: making the per-sample reader unreachable un-blinds it", async () => {
  const starved = extinctedLeg().map((sample, index) =>
    index === 6
      ? makeSample(index, {
          limbPx: 3,
          discBytes: SWEEP_EXTINCTION[index].rgb.map((c) => c * 255),
        })
      : sample,
  );
  await withMutant(
    (source) =>
      replaceExactlyOnce(
        source,
        "        structural.push(\n" +
          "          ...sampleStructuralReasons(renderer, index, sample, expectedExposure),\n" +
          "        );",
        "        structural.push(\n" +
          "          ...(false\n" +
          "            ? sampleStructuralReasons(renderer, index, sample, expectedExposure)\n" +
          "            : []),\n" +
          "        );",
      ),
    async (module) => {
      const result = module.evaluateSunDiscDawnSweep(
        evidenceOf(extinctedLeg(), starved),
        { bar: DERIVED_BAR },
      );
      assert.deepEqual(result.structural, []);
      assert.equal(result.status, "FAIL");
    },
  );
});

function starvedParityEvidence() {
  const starved = extinctedLeg().map((sample, index) =>
    index === 6
      ? makeSample(index, {
          centrePixels: 4,
          discBytes: SWEEP_EXTINCTION[index].rgb.map((c) => c * 255),
        })
      : sample,
  );
  return evidenceOf(extinctedLeg(), starved);
}

test("G7a precedence/scoring-guard: a blind sweep is never scored at all", async () => {
  const before = evaluateSunDiscDawnSweep(starvedParityEvidence(), {
    bar: DERIVED_BAR,
  });
  assert.equal(before.status, "STRUCTURAL");
  assert.deepEqual(before.families, []);
  assert.deepEqual(before.failures, []);
  await withMutant(
    (source) =>
      replaceExactlyOnce(
        source,
        "  const scoreable = structural.length === 0;",
        "  const scoreable = true;",
      ),
    async (module) => {
      const result = module.evaluateSunDiscDawnSweep(starvedParityEvidence(), {
        bar: DERIVED_BAR,
      });
      assert.ok(
        result.families.length > 0,
        "the guard is what kept the blind sweep unscored",
      );
      assert.ok(result.failures.length > 0);
      assert.equal(
        result.status,
        "STRUCTURAL",
        "scoring a blind sweep must still not produce a verdict",
      );
    },
  );
});

test("G7b precedence/fold-guard: STRUCTURAL outranks a scored FAIL, and that is what decides it", async () => {
  await withMutant(
    (source) => {
      const scored = replaceExactlyOnce(
        source,
        "  const scoreable = structural.length === 0;",
        "  const scoreable = true;",
      );
      return replaceExactlyOnce(
        scored,
        [
          "  const blind =",
          "    structural.length > 0 || families.length === 0 || unproven.length > 0;",
        ].join("\n"),
        [
          "  const blind =",
          "    (false && structural.length > 0) || families.length === 0 || unproven.length > 0;",
        ].join("\n"),
      );
    },
    async (module) => {
      const result = module.evaluateSunDiscDawnSweep(starvedParityEvidence(), {
        bar: DERIVED_BAR,
      });
      assert.equal(
        result.status,
        "FAIL",
        "the structural term in the fold is what produced STRUCTURAL",
      );
      assert.ok(result.structural.length > 0);
    },
  );
});

test("G8 bar/derived-pending is load-bearing: filling in a bound changes the verdict", async () => {
  await withMutant(
    (source) =>
      replaceExactlyOnce(
        source,
        "  minimumCentreAnnulusRatio: null,\n  minimumCentreAnnulusChromaRatio: null,\n  maximumParityDelta: null,",
        "  minimumCentreAnnulusRatio: 1,\n  minimumCentreAnnulusChromaRatio: 0.9,\n  maximumParityDelta: 0.02,",
      ),
    async (module) => {
      const result = module.evaluateSunDiscDawnSweep(
        evidenceOf(healthyLeg(), healthyLeg()),
      );
      assert.equal(
        result.status,
        "PASS",
        "the shipped null bounds are what hold the run at STRUCTURAL",
      );
      const shipped = evaluateSunDiscDawnSweep(
        evidenceOf(healthyLeg(), healthyLeg()),
      );
      assert.equal(shipped.status, "STRUCTURAL");
    },
  );
});

test("G10 horizon/inert-term: without it the engine's own flag scores a below-horizon sample", async () => {
  const legs = healthyLeg({
    perSample: { 0: { sunVisible: true, visible: true } },
  });
  const before = evaluateSunDiscDawnSweep(evidenceOf(legs, legs), {
    bar: DERIVED_BAR,
  });
  assert.equal(before.measurements.webgl[0].scored, false);
  await withMutant(
    (source) =>
      replaceExactlyOnce(
        source,
        "    sunAboveLocalHorizon(sample?.observed) === true",
        "    !(false && sunAboveLocalHorizon(sample?.observed) !== true)",
      ),
    async (module) => {
      const result = module.evaluateSunDiscDawnSweep(evidenceOf(legs, legs), {
        bar: DERIVED_BAR,
      });
      assert.equal(
        result.measurements.webgl[0].scored,
        true,
        "the horizon term is what excluded the below-horizon sample",
      );
    },
  );
});

test("G11 readiness/inert-read: without it a globe-less leg is scored as if it had one", async () => {
  const blind = healthyLeg({ globeReady: false });
  const evidence = evidenceOf(healthyLeg(), blind);
  const before = evaluateSunDiscDawnSweep(evidence, { bar: DERIVED_BAR });
  assert.equal(before.status, "STRUCTURAL");
  await withMutant(
    (source) =>
      replaceExactlyOnce(
        source,
        "  if (observed.globeReady !== true) {",
        "  if (false && observed.globeReady !== true) {",
      ),
    async (module) => {
      const result = module.evaluateSunDiscDawnSweep(evidence, {
        bar: DERIVED_BAR,
      });
      assert.deepEqual(result.structural, []);
      assert.equal(result.status, "PASS");
    },
  );
});

test("G9: the sweep registration the probe ships is the one the gate scores", () => {
  assert.equal(SUN_DISC_DAWN_SWEEP.sampleCount, SWEEP_EXTINCTION.length);
  assert.deepEqual([...SUN_DISC_DAWN_RENDERERS], ["webgl", "webgpu"]);
  assert.equal(SUN_DISC_DAWN_SWEEP.stepMinutes, 5);
  assert.equal(SUN_DISC_DAWN_SWEEP.startIso, "2026-08-24T22:10:00Z");
});

// ---------------------------------------------------------------------------
// J. A clipped sample is refused, not silently included (C12-38 instrument)
// ---------------------------------------------------------------------------

test("J1: a clipped centre region refuses the whole sweep to STRUCTURAL", () => {
  const legs = healthyLeg({ perSample: { 7: { centreClipped: true } } });
  const evidence = evidenceOf(legs, legs);
  const result = evaluateSunDiscDawnSweep(evidence, { bar: DERIVED_BAR });
  assert.equal(result.status, "STRUCTURAL");
  assert.ok(
    result.structural.includes("webgl:sample7:centre-clipped"),
    JSON.stringify(result.structural),
  );
});

test("J2: a clipped annulus region is refused the same way as a clipped centre", () => {
  const legs = healthyLeg({ perSample: { 9: { annulusClipped: true } } });
  const evidence = evidenceOf(legs, legs);
  const result = evaluateSunDiscDawnSweep(evidence, { bar: DERIVED_BAR });
  assert.equal(result.status, "STRUCTURAL");
  assert.ok(
    result.structural.includes("webgl:sample9:annulus-clipped"),
    JSON.stringify(result.structural),
  );
});

test("J3: pre-existing fixtures are unaffected — clip refusal is opt-in on an explicit `clipped: true`, not re-derived from raw bytes", () => {
  // `healthyLeg()`'s default disc is [255,255,255] over a bright dawn sky, so
  // several of its own composited bytes ARE 255 without anyone setting
  // `clipped`. If the check read `meanR/meanG/meanB` directly instead of the
  // explicit field, every one of this file's existing PASS fixtures would
  // have started failing the moment this row landed.
  const result = evaluateSunDiscDawnSweep(
    evidenceOf(healthyLeg(), healthyLeg()),
    {
      bar: DERIVED_BAR,
    },
  );
  assert.deepEqual(result.structural, []);
  assert.equal(result.status, "PASS");
});

test("J4 MUTATION: a clipped sample must be refused, not silently included", async () => {
  const legs = healthyLeg({ perSample: { 7: { centreClipped: true } } });
  const evidence = evidenceOf(legs, legs);
  const before = evaluateSunDiscDawnSweep(evidence, { bar: DERIVED_BAR });
  assert.equal(before.status, "STRUCTURAL");
  await withMutant(
    (source) =>
      replaceExactlyOnce(
        source,
        "    if (record.clipped === true) {\n      reasons.push(`${where}:${region}-clipped`);\n    }",
        "    if (false && record.clipped === true) {\n      reasons.push(`${where}:${region}-clipped`);\n    }",
      ),
    async (module) => {
      const result = module.evaluateSunDiscDawnSweep(evidence, {
        bar: DERIVED_BAR,
      });
      assert.deepEqual(
        result.structural,
        [],
        "the clipped sample survived silently once the check was made inert",
      );
      assert.equal(result.status, "PASS");
    },
  );
});

// ---------------------------------------------------------------------------
// K. Deriving the FAIL bar from an acquired WebGL sweep, never from WebGPU
// ---------------------------------------------------------------------------

test("K1: the derivation refuses rather than guess, with too few readable WebGL samples", () => {
  const sparse = [
    { scored: true, centreAnnulusRatio: 1.2, centreAnnulusChromaRatio: 1.1 },
    {
      scored: false,
      centreAnnulusRatio: null,
      centreAnnulusChromaRatio: null,
    },
  ];
  assert.ok(sparse.length < SUN_DISC_DAWN_BAR_DERIVATION_MINIMUM_SAMPLES);
  const derivation = deriveSunDiscDawnBarFromWebGLSweep(sparse);
  assert.equal(derivation.usable, false);
  assert.equal(derivation.bar, null);
  assert.equal(
    derivation.reason,
    "sun-disc-dawn-bar:too-few-readable-webgl-samples",
  );
});

test("K2: the derived ratio bound is the sweep's own worst scored reading net of the margin, capped at the physical 1.0 floor", () => {
  const measurements = [
    { scored: true, centreAnnulusRatio: 1.4, centreAnnulusChromaRatio: 1.3 },
    { scored: true, centreAnnulusRatio: 1.1, centreAnnulusChromaRatio: 0.95 },
    { scored: true, centreAnnulusRatio: 0.98, centreAnnulusChromaRatio: 0.9 },
    {
      scored: false,
      centreAnnulusRatio: null,
      centreAnnulusChromaRatio: null,
    },
  ];
  const derivation = deriveSunDiscDawnBarFromWebGLSweep(measurements);
  assert.equal(derivation.usable, true);
  const margin = SUN_DISC_DAWN_BAR_DERIVATION_MARGIN;
  assert.ok(
    Math.abs(derivation.bar.minimumCentreAnnulusRatio - 0.98 * (1 - margin)) <
      1e-12,
  );
  assert.ok(
    Math.abs(
      derivation.bar.minimumCentreAnnulusChromaRatio - 0.9 * (1 - margin),
    ) < 1e-12,
  );
  assert.equal(
    derivation.bar.maximumParityDelta,
    SUN_DISC_DAWN_BAR_DERIVATION_PARITY_DELTA,
  );
  assert.equal(derivation.bar.status, "DERIVED-FROM-WEBGL-SWEEP");
  assert.equal(derivation.terms.scoredSamples, 3);
});

test("K2b: the luminance floor never exceeds 1.0 even when every reading sits above it; the chroma floor carries no such cap", () => {
  const measurements = [
    { scored: true, centreAnnulusRatio: 1.6, centreAnnulusChromaRatio: 1.5 },
    { scored: true, centreAnnulusRatio: 1.5, centreAnnulusChromaRatio: 1.4 },
    { scored: true, centreAnnulusRatio: 1.45, centreAnnulusChromaRatio: 1.35 },
  ];
  const derivation = deriveSunDiscDawnBarFromWebGLSweep(measurements);
  assert.equal(derivation.bar.minimumCentreAnnulusRatio, 1.0);
  assert.ok(
    derivation.bar.minimumCentreAnnulusChromaRatio > 1.0,
    `expected the uncapped chroma floor above 1.0, got ${derivation.bar.minimumCentreAnnulusChromaRatio}`,
  );
});

test("K3: a bar derived from a healthy WebGL sweep accepts a healthy WebGPU leg and rejects an inverted one", () => {
  const webglOnly = evaluateSunDiscDawnSweep(
    evidenceOf(healthyLeg(), healthyLeg()),
    { bar: DERIVED_BAR },
  );
  const derivation = deriveSunDiscDawnBarFromWebGLSweep(
    webglOnly.measurements.webgl,
  );
  assert.equal(derivation.usable, true);

  const healthyPass = evaluateSunDiscDawnSweep(
    evidenceOf(healthyLeg(), healthyLeg()),
    { bar: derivation.bar },
  );
  assert.equal(healthyPass.status, "PASS");

  const invertedFail = evaluateSunDiscDawnSweep(
    evidenceOf(healthyLeg(), extinctedLeg()),
    { bar: derivation.bar },
  );
  assert.equal(invertedFail.status, "FAIL");
});

test("K4 MUTATION: without the margin term a noise-free derivation would demand exactly the sweep's worst reading, with zero slack", async () => {
  const measurements = [
    { scored: true, centreAnnulusRatio: 0.98, centreAnnulusChromaRatio: 0.9 },
    { scored: true, centreAnnulusRatio: 1.2, centreAnnulusChromaRatio: 1.1 },
    { scored: true, centreAnnulusRatio: 1.3, centreAnnulusChromaRatio: 1.2 },
  ];
  const before = deriveSunDiscDawnBarFromWebGLSweep(measurements);
  assert.ok(before.bar.minimumCentreAnnulusRatio < 0.98);
  await withMutant(
    (source) =>
      replaceExactlyOnce(
        source,
        "1.0, worstRatio * (1 - marginRel));",
        "1.0, worstRatio * (1 - 0));",
      ),
    async (module) => {
      const mutated = module.deriveSunDiscDawnBarFromWebGLSweep(measurements);
      assert.equal(mutated.bar.minimumCentreAnnulusRatio, 0.98);
    },
  );
});

// K5/K6: review finding BLOCKING-1, 2026-09-02. Reproduced by the reviewer
// against the real retained pre-fix artifact: a WebGL source that has ALREADY
// inverted the shipped law derives a bar at the defect's own magnitude, and
// every family — including the one built to catch that inversion — passes.
// `worstRatio 0.037` in that reproduction stood in for a defective disc-centre
// reading at the row's own discriminator sample; K5 pins the same shape with
// the discriminator explicitly at index 7.

test("K5: a discriminator sample that has already inverted the shipped law refuses the derivation, not just loosens it", () => {
  const measurements = [
    {
      index: 2,
      scored: true,
      centreAnnulusRatio: 1.3,
      centreAnnulusChromaRatio: 1.2,
    },
    {
      index: 5,
      scored: true,
      centreAnnulusRatio: 1.25,
      centreAnnulusChromaRatio: 1.15,
    },
    // The pre-registered discriminator (+5.11 deg), inverted — the C12-38
    // defect's own shape, not a low-altitude extinction reading.
    {
      index: SUN_DISC_DAWN_BAR_DERIVATION_DISCRIMINATOR_INDEX,
      scored: true,
      centreAnnulusRatio: 0.037,
      centreAnnulusChromaRatio: 0.9,
    },
    {
      index: 9,
      scored: true,
      centreAnnulusRatio: 1.1,
      centreAnnulusChromaRatio: 1.05,
    },
  ];
  const derivation = deriveSunDiscDawnBarFromWebGLSweep(measurements);
  assert.equal(derivation.usable, false);
  assert.equal(derivation.bar, null);
  assert.equal(
    derivation.reason,
    "sun-disc-dawn-bar:webgl-source-below-limb-law-floor",
  );
  assert.equal(derivation.terms.discriminatorIndex, 7);
  assert.equal(derivation.terms.discriminatorRatio, 0.037);

  // Confirms the finding's own reproduction is closed: this exact source no
  // longer certifies the defect through rescoreSunDiscDawnArtifact either.
  const artifact = {
    measurements: { webgl: measurements, webgpu: measurements },
    sessions: [
      { renderer: "webgl", samples: [] },
      { renderer: "webgpu", samples: [] },
    ],
  };
  const rescored = rescoreSunDiscDawnArtifact(artifact);
  assert.equal(rescored.rescored, false);
  assert.equal(rescored.evaluation, null);
});

test("K5b: a source whose worst reading dips under 1 AWAY from the discriminator still derives normally — the refusal is scoped, not a blanket floor", () => {
  // Same shape as K2 (worst reading 0.98, no index at all — the existing
  // in-isolation derivation contract) plus an explicit, healthy discriminator
  // reading, proving the new refusal does not fire on ordinary near-1 noise.
  const measurements = [
    {
      index: 1,
      scored: true,
      centreAnnulusRatio: 1.4,
      centreAnnulusChromaRatio: 1.3,
    },
    {
      index: 3,
      scored: true,
      centreAnnulusRatio: 1.1,
      centreAnnulusChromaRatio: 0.95,
    },
    {
      index: 4,
      scored: true,
      centreAnnulusRatio: 0.98,
      centreAnnulusChromaRatio: 0.9,
    },
    {
      index: SUN_DISC_DAWN_BAR_DERIVATION_DISCRIMINATOR_INDEX,
      scored: true,
      centreAnnulusRatio: 1.2,
      centreAnnulusChromaRatio: 1.1,
    },
  ];
  const derivation = deriveSunDiscDawnBarFromWebGLSweep(measurements);
  assert.equal(derivation.usable, true);
  const margin = SUN_DISC_DAWN_BAR_DERIVATION_MARGIN;
  assert.ok(
    Math.abs(derivation.bar.minimumCentreAnnulusRatio - 0.98 * (1 - margin)) <
      1e-12,
  );
});

test("K6 MUTATION: the discriminator floor refusal must fire, not silently derive a bar at the defect's own magnitude", async () => {
  const measurements = [
    {
      index: 2,
      scored: true,
      centreAnnulusRatio: 1.3,
      centreAnnulusChromaRatio: 1.2,
    },
    {
      index: SUN_DISC_DAWN_BAR_DERIVATION_DISCRIMINATOR_INDEX,
      scored: true,
      centreAnnulusRatio: 0.037,
      centreAnnulusChromaRatio: 0.9,
    },
    {
      index: 9,
      scored: true,
      centreAnnulusRatio: 1.1,
      centreAnnulusChromaRatio: 1.05,
    },
  ];
  const before = deriveSunDiscDawnBarFromWebGLSweep(measurements);
  assert.equal(before.usable, false);
  await withMutant(
    (source) =>
      replaceExactlyOnce(
        source,
        "  if (\n" +
          '    typeof discriminatorRatio === "number" &&\n' +
          "    Number.isFinite(discriminatorRatio) &&\n" +
          "    discriminatorRatio < 1.0 // the physical floor the luminance argument above rests on\n" +
          "  ) {",
        "  if (\n" +
          "    false &&\n" +
          '    typeof discriminatorRatio === "number" &&\n' +
          "    Number.isFinite(discriminatorRatio) &&\n" +
          "    discriminatorRatio < 1.0 // the physical floor the luminance argument above rests on\n" +
          "  ) {",
      ),
    async (module) => {
      const mutated = module.deriveSunDiscDawnBarFromWebGLSweep(measurements);
      assert.equal(
        mutated.usable,
        true,
        "the inverted discriminator sample derived a usable bar once the refusal was made inert",
      );
      assert.ok(
        mutated.bar.minimumCentreAnnulusRatio < 0.04,
        `expected the bar to collapse to the defect's own magnitude, got ${mutated.bar.minimumCentreAnnulusRatio}`,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// L. Rescoring an acquired artifact against its own derived bar
// ---------------------------------------------------------------------------

function fakeArtifact(webglSamples, webgpuSamples, bar = DERIVED_BAR) {
  const evaluation = evaluateSunDiscDawnSweep(
    evidenceOf(webglSamples, webgpuSamples),
    { bar },
  );
  return {
    measurements: evaluation.measurements,
    sessions: [
      { renderer: "webgl", samples: webglSamples },
      { renderer: "webgpu", samples: webgpuSamples },
    ],
  };
}

test("L1: rescoreSunDiscDawnArtifact reconstructs the paired evidence and matches a direct re-evaluation", () => {
  const artifact = fakeArtifact(healthyLeg(), extinctedLeg());
  const result = rescoreSunDiscDawnArtifact(artifact);
  assert.equal(result.rescored, true);
  assert.equal(result.evaluation.status, "FAIL");

  const direct = evaluateSunDiscDawnSweep(
    evidenceOf(healthyLeg(), extinctedLeg()),
    { bar: result.derivation.bar },
  );
  assert.deepEqual(result.evaluation, direct);
});

test("L2: rescoreSunDiscDawnArtifact propagates a refused derivation rather than guessing a bar", () => {
  const artifact = {
    measurements: {
      webgl: [
        {
          scored: true,
          centreAnnulusRatio: 1.2,
          centreAnnulusChromaRatio: 1.1,
        },
      ],
      webgpu: [],
    },
    sessions: [],
  };
  const result = rescoreSunDiscDawnArtifact(artifact);
  assert.equal(result.rescored, false);
  assert.equal(result.evaluation, null);
  assert.equal(result.derivation.usable, false);
});

// ---------------------------------------------------------------------------
// M. The exposure leg is CHECKED, not just published (C12-38 fix round,
//    review finding BLOCKING-2, 2026-09-02)
// ---------------------------------------------------------------------------
//
// Review's own reproduction: mutating the probe so the exposure leg is never
// applied left `sun-disc-dawn-gate.spec.mjs` at 80/80 green, because nothing
// read `observed.exposure` — published per sample, consumed by no predicate.
// A leg whose HDR write was silently refused therefore acquired a clipped SDR
// sweep beside a tonemapped one and the parity family compared two different
// tone curves with no reason raised. M1/M3 pin the fix; M2 pins that a
// deliberate `--exposure` retry (`options.expectedExposure`) is not itself
// read as that same fault.

test("M1: a leg whose observed exposure does not match the expected config refuses the whole sweep to STRUCTURAL", () => {
  const legs = healthyLeg({
    perSample: {
      3: { exposure: { highDynamicRange: false, value: 1 } },
    },
  });
  const result = evaluateSunDiscDawnSweep(evidenceOf(legs, healthyLeg()), {
    bar: DERIVED_BAR,
  });
  assert.equal(result.status, "STRUCTURAL");
  assert.ok(
    result.structural.includes("webgl:sample3:exposure-leg-not-applied"),
    JSON.stringify(result.structural),
  );
});

test("M2: a run acquired at a deliberate --exposure override is not penalized once the gate is told what that run used", () => {
  const override = Object.freeze({ highDynamicRange: true, value: 0.06 });
  const legs = healthyLeg({ exposure: override });
  const result = evaluateSunDiscDawnSweep(evidenceOf(legs, legs), {
    bar: DERIVED_BAR,
    expectedExposure: override,
  });
  assert.deepEqual(result.structural, []);
  assert.equal(result.status, "PASS");

  // The other direction: the SAME override evidence scored against the
  // module default (i.e. the executor forgot to pass expectedExposure) is
  // correctly refused, proving M2's PASS came from the option, not from the
  // check being a no-op.
  const unaware = evaluateSunDiscDawnSweep(evidenceOf(legs, legs), {
    bar: DERIVED_BAR,
  });
  assert.equal(unaware.status, "STRUCTURAL");
  assert.ok(
    unaware.structural.some((reason) =>
      reason.endsWith(":exposure-leg-not-applied"),
    ),
  );
});

test("M3 MUTATION: an unapplied exposure leg must be refused, not silently included", async () => {
  const legs = healthyLeg({
    perSample: {
      3: { exposure: { highDynamicRange: false, value: 1 } },
    },
  });
  const evidence = evidenceOf(legs, healthyLeg());
  const before = evaluateSunDiscDawnSweep(evidence, { bar: DERIVED_BAR });
  assert.equal(before.status, "STRUCTURAL");
  await withMutant(
    (source) =>
      replaceExactlyOnce(
        source,
        "  if (\n" +
          "    observed.exposure?.highDynamicRange !== expectedExposure.highDynamicRange ||\n" +
          "    observed.exposure?.value !== expectedExposure.value\n" +
          "  ) {\n" +
          "    reasons.push(`${where}:exposure-leg-not-applied`);\n" +
          "  }",
        "  if (\n" +
          "    false &&\n" +
          "    (observed.exposure?.highDynamicRange !== expectedExposure.highDynamicRange ||\n" +
          "      observed.exposure?.value !== expectedExposure.value)\n" +
          "  ) {\n" +
          "    reasons.push(`${where}:exposure-leg-not-applied`);\n" +
          "  }",
      ),
    async (module) => {
      const result = module.evaluateSunDiscDawnSweep(evidence, {
        bar: DERIVED_BAR,
      });
      assert.deepEqual(
        result.structural,
        [],
        "the unapplied exposure leg survived silently once the check was made inert",
      );
      assert.equal(result.status, "PASS");
    },
  );
});

test("M4: rescoreSunDiscDawnArtifact reads exposureConfig off the artifact so a --exposure run is not misscored", () => {
  const override = Object.freeze({ highDynamicRange: true, value: 0.06 });
  const legs = healthyLeg({ exposure: override });
  const evaluation = evaluateSunDiscDawnSweep(evidenceOf(legs, legs), {
    bar: DERIVED_BAR,
    expectedExposure: override,
  });
  const artifact = {
    measurements: evaluation.measurements,
    exposureConfig: override,
    sessions: [
      { renderer: "webgl", samples: legs },
      { renderer: "webgpu", samples: legs },
    ],
  };
  const result = rescoreSunDiscDawnArtifact(artifact);
  assert.equal(result.rescored, true);
  assert.deepEqual(result.evaluation.structural, []);
});

// ---------------------------------------------------------------------------
// N. The --exposure retry knob (review finding FIX, non-blocking, 2026-09-02)
// ---------------------------------------------------------------------------
//
// The probe's own clip refusal was zero-tolerance with no way for an executor
// to retry at a lower exposure short of editing a frozen constant. This
// section pins the pure config/argument builders the retry knob is made of;
// the browser-launching `runSunDiscDawnProbe` path itself is exercised only
// by a real run, per this file's own precedent for E/P-series helpers.

test("N1: buildPageConfig defaults to the pre-registered exposure and forces HDR regardless of the override", () => {
  const defaultConfig = buildPageConfig();
  assert.deepEqual(defaultConfig.exposure, SUN_DISC_DAWN_EXPOSURE);

  const overridden = buildPageConfig({ value: 0.06 });
  assert.equal(overridden.exposure.highDynamicRange, true);
  assert.equal(overridden.exposure.value, 0.06);
  assert.notEqual(overridden.exposure.value, SUN_DISC_DAWN_EXPOSURE.value);

  // Every other field is untouched by the override.
  assert.equal(overridden.site, SUN_DISC_DAWN_SITE);
  assert.equal(overridden.sweep, SUN_DISC_DAWN_SWEEP);
});

test("N2: parseExposureValue accepts a finite positive number and refuses anything a live scene write could not use", () => {
  assert.equal(parseExposureValue("0.06"), 0.06);
  assert.equal(parseExposureValue("1"), 1);
  for (const bad of ["0", "-1", "abc", "NaN", "Infinity", ""]) {
    assert.throws(
      () => parseExposureValue(bad),
      /--exposure must be a finite positive number/,
      `expected ${JSON.stringify(bad)} to be refused`,
    );
  }
});

test("N3: parseArguments wires --exposure through to exposureValue and defaults it to undefined", () => {
  assert.equal(parseArguments([]).exposureValue, undefined);
  assert.equal(parseArguments(["--exposure", "0.06"]).exposureValue, 0.06);
  assert.throws(() => parseArguments(["--exposure"]), /requires a value/);
});
