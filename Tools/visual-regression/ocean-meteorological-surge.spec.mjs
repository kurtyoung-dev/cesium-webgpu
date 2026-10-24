// ocean-meteorological-surge.spec.mjs — verification spec for Beaufort wind scaling and storm surge.
// @purpose Verifies Beaufort scale parameterization, atmospheric pressure coupling, inverse barometer storm surge, and sea-level offset composition.
// @status ACTIVE
//
// Pins the Beaufort wind scale coupling, inverse barometer effect (IBE),
// and storm surge sea-level anchor composition.
//
// Run: node --test Tools/visual-regression/ocean-meteorological-surge.spec.mjs

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";

enableEngineTsResolution();

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const enginePath = (p) => path.join(root, "packages/engine/Source", p);
const importEngine = async (p) =>
  await import(pathToFileURL(enginePath(p)).href);

const { default: Cartesian3 } = await importEngine("Core/Cartesian3.js");
const { default: Ellipsoid } = await importEngine("Core/Ellipsoid.js");
const { default: JulianDate } = await importEngine("Core/JulianDate.js");
const { default: VerticalDatum } = await importEngine("Core/VerticalDatum.js");
const { computeSeaLevelOffset } = await importEngine(
  "Scene/OceanSurfacePrimitive.js",
);
const { default: GlobeWaterOcean } = await importEngine(
  "Scene/GlobeWaterOcean.js",
);

test("1. Beaufort wind scale formula matches empirical meteorology", () => {
  // Empirical relation: B = clamp((U10 / 0.836)^(2/3), 0, 12)
  // Inverse: U10 = 0.836 * B^(3/2)
  function toBeaufort(u10) {
    return Math.min(12.0, Math.pow(Math.max(0.0, u10) / 0.836, 2.0 / 3.0));
  }
  function toWindSpeed(b) {
    return 0.836 * Math.pow(Math.max(0.0, Math.min(12.0, b)), 1.5);
  }

  // Calm (B = 0)
  assert.equal(toBeaufort(0.0), 0.0);
  assert.equal(toWindSpeed(0.0), 0.0);

  // Moderate breeze (B = 4: standard 5.5 - 7.9 m/s)
  const u4 = toWindSpeed(4.0);
  assert.ok(
    u4 > 5.5 && u4 < 8.0,
    `B=4 wind speed should fall in moderate breeze range (got ${u4})`,
  );
  assert.ok(Math.abs(toBeaufort(u4) - 4.0) < 1e-6);

  // Strong gale (B = 9: standard 20.8 - 24.4 m/s)
  const u9 = toWindSpeed(9.0);
  assert.ok(
    u9 > 20.0 && u9 < 25.0,
    `B=9 wind speed should fall in strong gale range (got ${u9})`,
  );
  assert.ok(Math.abs(toBeaufort(u9) - 9.0) < 1e-6);

  // Hurricane force (B = 12: > 32.7 m/s)
  const u12 = toWindSpeed(12.0);
  assert.ok(
    u12 > 32.7,
    `B=12 wind speed must exceed hurricane threshold (got ${u12})`,
  );
  assert.ok(Math.abs(toBeaufort(u12) - 12.0) < 1e-6);

  // Clamping at B=12
  assert.equal(toBeaufort(100.0), 12.0);
});

test("2. GlobeWaterOcean beaufortScale couples bi-directionally with windSpeed", () => {
  const ocean = new GlobeWaterOcean({});

  // Default wind speed 12 m/s -> Beaufort ~5.9 (Fresh/Strong breeze)
  assert.ok(
    ocean.beaufortScale > 5.5 && ocean.beaufortScale < 6.2,
    `Default 12 m/s should map to B~5.9 (got ${ocean.beaufortScale})`,
  );

  // Set Beaufort scale to 8 (Gale)
  ocean.beaufortScale = 8.0;
  assert.ok(Math.abs(ocean.beaufortScale - 8.0) < 1e-4);
  assert.ok(
    ocean.windSpeed > 18.0 && ocean.windSpeed < 20.0,
    `B=8 should set wind speed to ~18.9 m/s (got ${ocean.windSpeed})`,
  );

  // Set wind speed directly to 0 (Calm)
  ocean.windSpeed = 0.0;
  assert.equal(ocean.beaufortScale, 0.0);
});

test("3. Inverse Barometer Effect calculates accurate sea surface elevation", () => {
  // delta_h = (1013.25 - P_msl) * 0.01 m
  const ocean = new GlobeWaterOcean({});

  // Standard atmospheric pressure: zero surge
  assert.equal(ocean.meanSeaLevelPressure, 1013.25);
  assert.equal(ocean.stormSurgeMeters, 0.0);

  // Deep tropical depression / cyclone (940 hPa)
  ocean.meanSeaLevelPressure = 940.0;
  const expectedSurge = (1013.25 - 940.0) * 0.01; // +0.7325 m
  assert.ok(
    Math.abs(ocean.stormSurgeMeters - expectedSurge) < 1e-6,
    `Surge should be +0.7325m (got ${ocean.stormSurgeMeters})`,
  );

  // Strong subtropical high (1035 hPa)
  ocean.meanSeaLevelPressure = 1035.0;
  const expectedDepression = (1013.25 - 1035.0) * 0.01; // -0.2175 m
  assert.ok(
    Math.abs(ocean.stormSurgeMeters - expectedDepression) < 1e-6,
    `Depression should be -0.2175m (got ${ocean.stormSurgeMeters})`,
  );
});

test("4. computeSeaLevelOffset composes storm surge cleanly with datum and vertical exaggeration", () => {
  const ellipsoid = Ellipsoid.WGS84;
  const anchor = new Cartesian3(6378137.0, 0.0, 0.0);
  const time = JulianDate.fromIso8601("2026-07-03T00:00:00Z");

  const primitive = {
    _verticalDatum: VerticalDatum.ELLIPSOID,
    _tideEnabled: false,
    _tideExaggeration: 1.0,
    _meanSeaLevelPressure: 1013.25,
    _surgeHeightM: 0.0,
    _tideHeightM: 0.0,
    _geoidUndulationM: 0.0,
    _anchorHeightM: 0.0,
  };

  const frameState = {
    time: time,
    verticalExaggeration: 1.0,
    verticalExaggerationRelativeHeight: 0.0,
  };

  // At standard pressure, offset is strictly 0.0
  const h0 = computeSeaLevelOffset(primitive, anchor, frameState, ellipsoid);
  assert.equal(
    h0,
    0.0,
    "Standard pressure must produce 0.0 offset on ellipsoid",
  );
  assert.equal(primitive._surgeHeightM, 0.0);

  // Under cyclonic storm depression (950 hPa): surge = +0.6325m
  primitive._meanSeaLevelPressure = 950.0;
  const hStorm = computeSeaLevelOffset(
    primitive,
    anchor,
    frameState,
    ellipsoid,
  );
  assert.ok(
    Math.abs(hStorm - 0.6325) < 1e-6,
    `Storm surge offset should be +0.6325m (got ${hStorm})`,
  );
  assert.ok(Math.abs(primitive._surgeHeightM - 0.6325) < 1e-6);

  // With 2x vertical exaggeration
  frameState.verticalExaggeration = 2.0;
  const hExaggerated = computeSeaLevelOffset(
    primitive,
    anchor,
    frameState,
    ellipsoid,
  );
  assert.ok(
    Math.abs(hExaggerated - 0.6325 * 2.0) < 1e-6,
    `Vertical exaggeration should scale storm surge lid (got ${hExaggerated})`,
  );
});
