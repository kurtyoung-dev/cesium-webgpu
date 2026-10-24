// environmental-tensor-raster.spec.mjs — verification spec for planetary environmental tensor raster and CLOD.
// @purpose Verifies multi-channel environmental tensor packing, quantization error bounds, polar and antimeridian continuity, and CLOD blending.
// @status ACTIVE
//
// Pins the multi-attribute atmospheric and marine environmental tensor map
// for whole-earth low-LOD/CLOD fallback and shader sampling.
//
// Run: node --test Tools/visual-regression/environmental-tensor-raster.spec.mjs

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

const {
  STANDARD_MSLP_HPA,
  encodeWindVector,
  decodeWindVector,
  encodePressureAnomaly,
  decodePressureAnomaly,
  encodeTemperature,
  decodeTemperature,
  encodeBeaufortScale,
  decodeBeaufortScale,
  encodeSignificantWaveHeight,
  decodeSignificantWaveHeight,
  sampleEnvironmentalTensor,
  blendEnvironmentalLOD,
  buildProceduralEnvironmentalTensor,
} = await importEngine("Scene/Weather/EnvironmentalTensorMap.ts");

test("1. Wind vector encoding achieves sub-0.25 m/s quantization precision across full range", () => {
  const testVectors = [
    { u: 0.0, v: 0.0 },
    { u: 12.5, v: -8.3 },
    { u: -45.0, v: 22.0 },
    { u: -60.0, v: 60.0 },
    { u: 35.4, v: 18.2 },
  ];

  for (const { u, v } of testVectors) {
    const enc = encodeWindVector(u, v);
    assert.ok(enc.r >= 0 && enc.r <= 255, "R channel must be in 8-bit range");
    assert.ok(enc.g >= 0 && enc.g <= 255, "G channel must be in 8-bit range");

    const dec = decodeWindVector(enc.r, enc.g);
    const errU = Math.abs(dec.u - u);
    const errV = Math.abs(dec.v - v);

    // Maximum quantization error: 120 m/s span / 255 steps ~ 0.47 m/s (max half-step 0.235 m/s)
    assert.ok(
      errU <= 0.25,
      `Zonal wind U error must be <= 0.25 m/s (got ${errU} m/s for u=${u})`,
    );
    assert.ok(
      errV <= 0.25,
      `Meridional wind V error must be <= 0.25 m/s (got ${errV} m/s for v=${v})`,
    );

    const expectedSpeed = Math.sqrt(u * u + v * v);
    assert.ok(
      Math.abs(dec.speed - expectedSpeed) <= 0.35,
      `Speed error must be bounded by root-sum-square quantization`,
    );
  }
});

test("2. Barometric pressure anomaly encodes storm surge with millimetric precision", () => {
  // Standard atmospheric pressure (1013.25 hPa) -> anomaly = 0.0 hPa
  const encStandard = encodePressureAnomaly(0.0);
  const decStandard = decodePressureAnomaly(encStandard);
  assert.ok(
    Math.abs(decStandard.pressureHpa - STANDARD_MSLP_HPA) < 0.3,
    "Standard pressure must decode within 0.3 hPa",
  );
  assert.ok(
    Math.abs(decStandard.stormSurgeMeters) < 0.003,
    "Standard pressure storm surge must be within 3 mm of zero",
  );

  // Severe cyclonic hurricane depression (-65.0 hPa -> 948.25 hPa)
  const encCyclone = encodePressureAnomaly(-65.0);
  const decCyclone = decodePressureAnomaly(encCyclone);
  assert.ok(
    Math.abs(decCyclone.deltaHpa - -65.0) < 0.3,
    "Cyclone anomaly must decode within 0.3 hPa",
  );
  // Expected surge = +0.65 m
  assert.ok(
    Math.abs(decCyclone.stormSurgeMeters - 0.65) < 0.003,
    "Cyclone storm surge must decode to +0.65 m within 3 mm",
  );
});

test("3. Marine and thermal channels preserve physical bounds", () => {
  // Temperature: -40 C (polar) and +35 C (equatorial desert)
  const encCold = encodeTemperature(-40.0);
  const encHot = encodeTemperature(35.0);
  assert.ok(Math.abs(decodeTemperature(encCold) - -40.0) < 0.25);
  assert.ok(Math.abs(decodeTemperature(encHot) - 35.0) < 0.25);

  // Beaufort scale: 0 to 12
  for (let b = 0; b <= 12; b += 2) {
    const encB = encodeBeaufortScale(b);
    const decB = decodeBeaufortScale(encB);
    assert.ok(
      Math.abs(decB - b) < 0.05,
      `Beaufort scale must round-trip accurately for B=${b}`,
    );
  }

  // Significant wave height: 0 to 20 m
  for (const hs of [0.0, 1.5, 4.0, 8.5, 16.0]) {
    const encHs = encodeSignificantWaveHeight(hs);
    const decHs = decodeSignificantWaveHeight(encHs);
    assert.ok(
      Math.abs(decHs - hs) < 0.05,
      `Significant wave height must round-trip for Hs=${hs} m`,
    );
  }
});

test("4. Environmental tensor sampling enforces antimeridian and polar continuity", () => {
  const tensors = buildProceduralEnvironmentalTensor(360, 180);

  // Test antimeridian continuity across +179.9 deg and -179.9 deg at 30 deg N
  const latRad = (30.0 * Math.PI) / 180.0;
  const lonEast = (179.9 * Math.PI) / 180.0;
  const lonWest = (-179.9 * Math.PI) / 180.0;

  const sampleEast = sampleEnvironmentalTensor(tensors, lonEast, latRad);
  const sampleWest = sampleEnvironmentalTensor(tensors, lonWest, latRad);

  // Values should be nearly identical across the antimeridian seam
  assert.ok(
    Math.abs(sampleEast.windSpeed - sampleWest.windSpeed) < 1.0,
    "Wind speed must be continuous across antimeridian",
  );
  assert.ok(
    Math.abs(sampleEast.pressureHpa - sampleWest.pressureHpa) < 2.0,
    "Pressure must be continuous across antimeridian",
  );
  assert.ok(
    Math.abs(sampleEast.cloudCoverage - sampleWest.cloudCoverage) < 0.08,
    "Cloud coverage must be continuous across antimeridian",
  );

  // Test polar single-valued convergence at 89.9 deg N across varying longitudes
  const latPole = (89.9 * Math.PI) / 180.0;
  const sampleP0 = sampleEnvironmentalTensor(tensors, 0.0, latPole);
  const sampleP90 = sampleEnvironmentalTensor(tensors, Math.PI / 2, latPole);
  const sampleP180 = sampleEnvironmentalTensor(tensors, Math.PI, latPole);

  // Temperature at pole must agree within 0.5 C regardless of azimuth
  assert.ok(
    Math.abs(sampleP0.temperatureC - sampleP90.temperatureC) < 0.5,
    "Polar cap temperature must be azimuthally uniform",
  );
  assert.ok(
    Math.abs(sampleP0.temperatureC - sampleP180.temperatureC) < 0.5,
    "Polar cap temperature must be azimuthally uniform",
  );
});

test("5. CLOD blending smoothly transitions between base tensor and high-detail observation", () => {
  const baseState = {
    windU: 10.0,
    windV: 0.0,
    windSpeed: 10.0,
    windHeadingRad: 0.0,
    pressureHpa: 1013.25,
    stormSurgeMeters: 0.0,
    temperatureC: 20.0,
    cloudCoverage: 0.2,
    beaufortScale: 5.0,
    significantWaveHeightM: 2.0,
    precipitationRate: 0.0,
  };

  const highDetailState = {
    windU: 25.0,
    windV: 15.0,
    windSpeed: Math.sqrt(25 * 25 + 15 * 15),
    windHeadingRad: Math.atan2(15, 25),
    pressureHpa: 980.0,
    stormSurgeMeters: 0.3325,
    temperatureC: 15.0,
    cloudCoverage: 0.9,
    beaufortScale: 9.0,
    significantWaveHeightM: 6.5,
    precipitationRate: 0.8,
  };

  // Alpha = 0: exactly base state
  const blend0 = blendEnvironmentalLOD(baseState, highDetailState, 0.0);
  assert.equal(blend0.windU, 10.0);
  assert.equal(blend0.pressureHpa, 1013.25);
  assert.equal(blend0.cloudCoverage, 0.2);

  // Alpha = 1: exactly high detail state
  const blend1 = blendEnvironmentalLOD(baseState, highDetailState, 1.0);
  assert.equal(blend1.windU, 25.0);
  assert.equal(blend1.pressureHpa, 980.0);
  assert.equal(blend1.cloudCoverage, 0.9);

  // Alpha = 0.5: exactly halfway
  const blendHalf = blendEnvironmentalLOD(baseState, highDetailState, 0.5);
  assert.equal(blendHalf.windU, 17.5);
  assert.equal(blendHalf.windV, 7.5);
  assert.equal(blendHalf.pressureHpa, (1013.25 + 980.0) / 2);
  assert.equal(blendHalf.stormSurgeMeters, (0.0 + 0.3325) / 2);
  assert.equal(blendHalf.temperatureC, 17.5);
  assert.equal(blendHalf.cloudCoverage, 0.55);
});

test("6. Procedural environmental tensor adheres to physical general circulation", () => {
  const tensors = buildProceduralEnvironmentalTensor(360, 180);
  assert.equal(tensors.width, 360);
  assert.equal(tensors.height, 180);
  assert.equal(tensors.atmosphericBytes.length, 360 * 180 * 4);
  assert.equal(tensors.marineBytes.length, 360 * 180 * 4);

  // Sample equator (lat = 0) vs South Pole (lat = -80 deg)
  const equator = sampleEnvironmentalTensor(tensors, 0.0, 0.0);
  const polar = sampleEnvironmentalTensor(
    tensors,
    0.0,
    (-80.0 * Math.PI) / 180.0,
  );

  // Equator must be warm (>15C), poles must be cold (< -15C)
  assert.ok(
    equator.temperatureC > 15.0,
    `Equatorial temperature should be > 15C (got ${equator.temperatureC})`,
  );
  assert.ok(
    polar.temperatureC < -15.0,
    `Polar temperature should be < -15C (got ${polar.temperatureC})`,
  );

  // Tropical trade winds should be predominantly easterly (windU < 0)
  assert.ok(
    equator.windU < 0.0,
    `Tropical trade winds must blow westward/easterly (got windU=${equator.windU})`,
  );
});
