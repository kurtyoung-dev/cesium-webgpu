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
  SUN_DISC_DAWN_BAR,
  SUN_DISC_DAWN_LIMB_COEFFICIENTS,
  SUN_DISC_DAWN_LIMB_REFERENCE_RATIO,
  SUN_DISC_DAWN_REGIONS,
  SUN_DISC_DAWN_RENDERERS,
  SUN_DISC_DAWN_SWEEP,
  SUN_DISC_DAWN_VIEWPORT,
  centreAnnulusChromaRatio,
  centreAnnulusRatio,
  evaluateSunDiscDawnSweep,
  meanLimbIntensity,
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

function luminanceOf([r, g, b]) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function composite(discBytes, alpha) {
  return DAWN_SKY_BYTES.map(
    (sky, channel) => alpha * discBytes[channel] + (1 - alpha) * sky,
  );
}

function regionRecord(bytes, pixels) {
  return {
    pixels,
    meanR: bytes[0],
    meanG: bytes[1],
    meanB: bytes[2],
    meanLuminance: luminanceOf(bytes),
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
      geometryValid: options.geometryValid ?? true,
      centerX: 640,
      centerY: 360,
      limbPx: options.limbPx ?? 64,
      skyAtmosphereVisible: options.skyAtmosphereVisible ?? true,
      sunBloomActive: true,
      bakeHaloGain: 0,
      discRadiance: 1,
      useHdr: false,
      limbDarkening: { ...SUN_DISC_DAWN_LIMB_COEFFICIENTS },
      extinction: { r: entry.rgb[0], g: entry.rgb[1], b: entry.rgb[2] },
      frame: { ...SUN_DISC_DAWN_VIEWPORT },
      regionWindow: null,
    },
    regions: visible
      ? {
          centre: regionRecord(centreBytes, options.centrePixels ?? pixels),
          annulus: regionRecord(annulusBytes, options.annulusPixels ?? pixels),
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
  assert.equal(legs[0].observed.sunVisible, false);
  assert.equal(legs[1].observed.sunVisible, true);
  const result = evaluateSunDiscDawnSweep(evidenceOf(legs, healthyLeg()), {
    bar: DERIVED_BAR,
  });
  assert.deepEqual(result.structural, []);
  assert.equal(result.status, "PASS");
  assert.equal(result.measurements.webgl[0].scored, false);
  assert.equal(result.measurements.webgl[0].centreAnnulusRatio, null);
  assert.equal(result.measurements.webgl[1].scored, true);
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
    "export { measureDiscRegions, localAltitudeAzimuth, relativeLuminance };";
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
  const short = extinctedLeg().map((sample, index) =>
    makeSample(index, {
      altitude: sample.observed.sunAltitudeDegrees - 3,
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
        "        structural.push(...sampleStructuralReasons(renderer, index, sample));",
        "        structural.push(...(false ? sampleStructuralReasons(renderer, index, sample) : []));",
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

test("G9: the sweep registration the probe ships is the one the gate scores", () => {
  assert.equal(SUN_DISC_DAWN_SWEEP.sampleCount, SWEEP_EXTINCTION.length);
  assert.deepEqual([...SUN_DISC_DAWN_RENDERERS], ["webgl", "webgpu"]);
  assert.equal(SUN_DISC_DAWN_SWEEP.stepMinutes, 5);
  assert.equal(SUN_DISC_DAWN_SWEEP.startIso, "2026-08-24T22:10:00Z");
});
