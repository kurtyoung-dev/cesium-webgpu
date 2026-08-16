// C13-08 rendered-tail probe contract.
// @purpose Contract for the rendered-tail browser probe: cyclic CoverageJSON parse, fused capture, policy rejecting duplicated antimeridian band.
// @status ACTIVE
//
// This does not claim GPU pixels. It proves the browser fixture exercises the
// cyclic parser, the capture stays fused, and the evidence policy rejects both
// a duplicated antimeridian band and a WebGL billboard regression.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";
import {
  checkEmbeddedCaptureIsCanonical,
  checkFusedCaptureUsage,
} from "./lib/same-task-capture.mjs";
import {
  assessWebGLRegionalTail,
  assessWebGPURegionalTail,
  createAntimeridianCoverageJson,
} from "./lib/weather-regional-tail-evidence.mjs";

enableEngineTsResolution();
const { parseCoverageJson } =
  await import("../../packages/engine/Source/Scene/Weather/CoverageJsonParser.ts");
const { packWeatherFieldDetailed } =
  await import("../../packages/engine/Source/Scene/Weather/WeatherTexPacker.ts");
const { GLOBAL_WEATHER_BOUNDS } =
  await import("../../packages/engine/Source/Scene/Weather/WeatherTypes.ts");

const here = path.dirname(fileURLToPath(import.meta.url));
const probeSource = fs
  .readFileSync(path.join(here, "probe-weather-regional-tails.mjs"), "utf8")
  .replace(/\r\n/g, "\n");

const packStats = Object.freeze({
  global: false,
  observedTexels: 600,
  filledTexels: 32168,
  registration: "node",
  fillKind: "procedural",
});

const field = Object.freeze({
  westDegrees: 170,
  eastDegrees: 190,
  southDegrees: -10,
  northDegrees: 10,
  registration: "node",
  gridWidth: 5,
  gridHeight: 3,
});

function metric(brightFraction, side = brightFraction) {
  return {
    brightPixels: Math.round(brightFraction * 10000),
    brightFraction,
    leftBrightFraction: side,
    rightBrightFraction: side,
    meanLuminance: brightFraction * 255,
    centerColumnStepMax: 2,
    columnStepP95: 2,
    packStats,
  };
}

function validWebGPURecord() {
  return {
    renderer: "webgpu",
    routeRequests: 1,
    errors: [],
    field,
    provider: {
      hasData: true,
      version: 1,
      lastError: null,
      packStats,
    },
    control: {
      east: metric(0.03),
      west: metric(0.03),
      seam: metric(0.03),
      far: metric(0.05),
    },
    regional: {
      east: metric(0.2),
      west: metric(0.2),
      seam: metric(0.2),
      far: metric(0.05),
    },
    comparisons: {
      east: { significantMismatchFraction: 0.2, meanAbsoluteRgbDelta: 20 },
      west: { significantMismatchFraction: 0.2, meanAbsoluteRgbDelta: 20 },
      seam: { significantMismatchFraction: 0.2, meanAbsoluteRgbDelta: 20 },
      far: { significantMismatchFraction: 0, meanAbsoluteRgbDelta: 0 },
    },
  };
}

function validWebGLRecord() {
  return {
    renderer: "webgl",
    routeRequests: 1,
    errors: [],
    field,
    provider: {
      hasData: true,
      version: 1,
      lastError: null,
      packStats,
    },
    control: { brightPixels: 1000 },
    regional: { brightPixels: 1000, packStats },
    comparison: {
      significantMismatchFraction: 0,
      meanAbsoluteRgbDelta: 0,
    },
    volumetricRequestCount: 0,
  };
}

test("the browser fixture derives one wrapped 170..190-degree regional field", () => {
  const parsed = parseCoverageJson(createAntimeridianCoverageJson(), {
    parameterName: "TCDC",
    units: "percent",
    bounds: GLOBAL_WEATHER_BOUNDS,
  });
  const deg = (radians) => (radians * 180) / Math.PI;
  assert.deepEqual(
    {
      west: deg(parsed.bounds.west),
      east: deg(parsed.bounds.east),
      south: deg(parsed.bounds.south),
      north: deg(parsed.bounds.north),
      registration: parsed.registration,
    },
    {
      west: 170,
      east: 190,
      south: -10,
      north: 10,
      registration: "node",
    },
  );
  const packed = packWeatherFieldDetailed(parsed, 256, 128);
  assert.equal(packed.global, false);
  assert.ok(packed.observedTexels > 0);
  assert.ok(packed.filledTexels > 0);
});

test("the probe carries the canonical fused-capture implementation", () => {
  assert.deepEqual(checkEmbeddedCaptureIsCanonical(probeSource), []);
  assert.deepEqual(checkFusedCaptureUsage(probeSource), []);
});

test("the probe owns both end-to-end tails rather than a manual bounds control", () => {
  for (const marker of [
    "new C.EdrWeatherSource",
    "page.route",
    "C.WeatherProvider(source)",
    'renderer === "webgpu"',
    'runBackend(browser, "webgl")',
    "fieldEvidence.value",
    "provider.getPackedTexture(256, 128)",
    "context.requestVolumetricClouds",
    "compareImages(control.far.image, regional.far.image)",
  ]) {
    assert.ok(
      probeSource.includes(marker),
      `missing probe contract: ${marker}`,
    );
  }
  assert.ok(
    probeSource.includes("await capture.captureNow()"),
    "pixel captures must be awaited",
  );
});

test("the WebGPU evidence policy accepts a continuous, singly placed band", () => {
  const assessment = assessWebGPURegionalTail(validWebGPURecord());
  assert.equal(assessment.ok, true);
  assert.ok(Object.values(assessment.checks).every(Boolean));
});

test("MUTATION — duplicating the observed band into the far view is rejected", () => {
  const record = validWebGPURecord();
  record.comparisons.far = {
    significantMismatchFraction: 0.25,
    meanAbsoluteRgbDelta: 30,
  };
  const assessment = assessWebGPURegionalTail(record);
  assert.equal(assessment.ok, false);
  assert.equal(assessment.checks.farViewUsesProceduralFill, false);
});

test("MUTATION — losing either side of the seam is rejected", () => {
  const record = validWebGPURecord();
  record.regional.west = metric(0.03);
  record.regional.seam.rightBrightFraction = 0.03;
  const assessment = assessWebGPURegionalTail(record);
  assert.equal(assessment.ok, false);
  assert.equal(assessment.checks.westSideObserved, false);
  assert.equal(assessment.checks.seamRightObserved, false);
});

test("MUTATION — a sharp centre-meridian wall is rejected", () => {
  const record = validWebGPURecord();
  record.regional.seam.centerColumnStepMax = 80;
  record.regional.seam.columnStepP95 = 2;
  const assessment = assessWebGPURegionalTail(record);
  assert.equal(assessment.ok, false);
  assert.equal(assessment.checks.seamCenterHasNoWall, false);
});

test("the WebGL evidence policy accepts an inert regional provider", () => {
  const assessment = assessWebGLRegionalTail(validWebGLRecord());
  assert.equal(assessment.ok, true);
  assert.ok(Object.values(assessment.checks).every(Boolean));
});

test("MUTATION — weather state changing WebGL billboards is rejected", () => {
  const record = validWebGLRecord();
  record.comparison = {
    significantMismatchFraction: 0.15,
    meanAbsoluteRgbDelta: 12,
  };
  const assessment = assessWebGLRegionalTail(record);
  assert.equal(assessment.ok, false);
  assert.equal(assessment.checks.billboardPixelsPreserved, false);
});

test("MUTATION — WebGL volumetric publication is rejected", () => {
  const record = validWebGLRecord();
  record.volumetricRequestCount = 1;
  const assessment = assessWebGLRegionalTail(record);
  assert.equal(assessment.ok, false);
  assert.equal(assessment.checks.noVolumetricPublication, false);
});
