// bathymetry-environmental-tensor-coupling.spec.mjs — verification spec for bathymetric and environmental tensor coupling.
// @purpose Verifies bathymetry tensor quantization, Jerlov classification, CLOD blending, and end-to-end coupling with GlobeWaterOcean and AtmosphericEffects.
// @status ACTIVE
//
// Pins the multi-attribute bathymetry raster and the end-to-end wiring of
// environmental and bathymetric tensors to the ocean surface and atmospheric pipeline.
//
// Run: node --test Tools/visual-regression/bathymetry-environmental-tensor-coupling.spec.mjs

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
  BATHYMETRY_MAX_DEPTH_M,
  JerlovWaterType,
  SeabedSubstrateType,
  encodeDepth,
  decodeDepth,
  encodeJerlovType,
  decodeJerlovType,
  encodeSubstrate,
  decodeSubstrate,
  encodeTidalRange,
  decodeTidalRange,
  sampleBathymetryTensor,
  blendBathymetryLOD,
  buildProceduralBathymetryTensor,
} = await importEngine("Scene/BathymetryTensorMap.ts");

const { buildProceduralEnvironmentalTensor, sampleEnvironmentalTensor } =
  await importEngine("Scene/Weather/EnvironmentalTensorMap.ts");

const { default: GlobeWaterOcean } = await importEngine(
  "Scene/GlobeWaterOcean.js",
);
const { default: OceanSurfacePrimitive } = await importEngine(
  "Scene/OceanSurfacePrimitive.js",
);
const { applyEnvironmentalTensor, PrecipitationType } = await importEngine(
  "Scene/AtmosphericEffects.ts",
);

test("1. Square-root bathymetry encoding achieves fine coastal resolution", () => {
  // Test shallow waters (0-200 m shelf)
  for (let d = 0; d <= 200; d += 10) {
    const enc = encodeDepth(d);
    const dec = decodeDepth(enc);
    const err = Math.abs(dec - d);
    // Shelf quantization error must stay under 6.0 m with 8-bit quantization across 11,000 m range
    assert.ok(
      err <= 6.0,
      `Coastal depth ${d} m error ${err} m exceeds 6.0 m tolerance`,
    );
  }

  // Test full oceanic range up to 11000 m
  const deepValues = [500, 1000, 2500, 4000, 6000, 8500, 11000];
  for (const d of deepValues) {
    const enc = encodeDepth(d);
    const dec = decodeDepth(enc);
    const relErr = Math.abs(dec - d) / Math.max(d, 1.0);
    assert.ok(
      relErr < 0.05,
      `Deep ocean depth ${d} m relative error ${relErr} exceeds 5%`,
    );
  }
});

test("2. Jerlov water types and seabed substrate preserve discrete classifications", () => {
  for (let j = 0; j <= 9; j++) {
    const enc = encodeJerlovType(j);
    const dec = decodeJerlovType(enc);
    assert.equal(dec, j, `Jerlov type ${j} must round-trip exactly`);
  }

  for (let s = 0; s <= 4; s++) {
    const enc = encodeSubstrate(s);
    const dec = decodeSubstrate(enc);
    assert.equal(dec, s, `Substrate type ${s} must round-trip exactly`);
  }

  // Tidal range (0 to 16 m)
  for (let t = 0.0; t <= 16.0; t += 1.0) {
    const enc = encodeTidalRange(t);
    const dec = decodeTidalRange(enc);
    assert.ok(
      Math.abs(dec - t) < 0.1,
      `Tidal range ${t} m error must be sub-decimetric`,
    );
  }
});

test("3. Procedural bathymetry exhibits antimeridian and polar continuity", () => {
  const bathy = buildProceduralBathymetryTensor(360, 180);

  // Antimeridian continuity at equator (lon = +PI vs -PI)
  const sampleEast = sampleBathymetryTensor(bathy, Math.PI - 1e-4, 0.0);
  const sampleWest = sampleBathymetryTensor(bathy, -Math.PI + 1e-4, 0.0);
  assert.ok(
    Math.abs(sampleEast.depthMeters - sampleWest.depthMeters) < 25.0,
    "Depth must be continuous across antimeridian",
  );
  assert.equal(
    sampleEast.jerlovType,
    sampleWest.jerlovType,
    "Jerlov water type must match across antimeridian",
  );

  // Polar continuity at 89.9 deg N across multiple longitudes
  const latPole = (89.9 * Math.PI) / 180.0;
  const sampleP0 = sampleBathymetryTensor(bathy, 0.0, latPole);
  const sampleP90 = sampleBathymetryTensor(bathy, Math.PI / 2, latPole);
  const sampleP180 = sampleBathymetryTensor(bathy, Math.PI, latPole);

  assert.ok(
    Math.abs(sampleP0.depthMeters - sampleP90.depthMeters) < 2.0,
    "Polar depth must be azimuthally uniform",
  );
  assert.ok(
    Math.abs(sampleP0.depthMeters - sampleP180.depthMeters) < 2.0,
    "Polar depth must be azimuthally uniform",
  );
});

test("4. CLOD blending smoothly interpolates bathymetric surveys", () => {
  const coarseState = {
    depthMeters: 4000.0,
    jerlovType: JerlovWaterType.TYPE_IB,
    substrateType: SeabedSubstrateType.ABYSSAL_SEDIMENT,
    tidalRangeMeters: 0.5,
  };

  const surveyState = {
    depthMeters: 150.0,
    jerlovType: JerlovWaterType.COASTAL_3,
    substrateType: SeabedSubstrateType.SAND,
    tidalRangeMeters: 3.2,
  };

  const blendedMid = blendBathymetryLOD(coarseState, surveyState, 0.5);
  assert.ok(
    Math.abs(blendedMid.depthMeters - 2075.0) < 1.0,
    "Depth blends linearly",
  );
  assert.ok(
    Math.abs(blendedMid.tidalRangeMeters - 1.85) < 0.1,
    "Tidal range blends linearly",
  );
});

test("5. GlobeWaterOcean and OceanSurfacePrimitive wire with EnvironmentalTensorMap", () => {
  const tensors = buildProceduralEnvironmentalTensor(360, 180);
  const mockScene = { primitives: { add() {}, remove() {} }, globe: {} };
  const ocean = new GlobeWaterOcean(mockScene);
  // Build the REAL primitive: the claim is that the tensor reaches the
  // spectrum, which only a primitive has. The ellipsoid datum keeps the enable
  // path from starting a geoid fetch.
  ocean.verticalDatum = "ELLIPSOID";
  ocean.enabled = true;
  const primitive = ocean.primitive;
  assert.ok(primitive !== undefined, "enabling must create the primitive");
  primitive._paramsDirty = false;

  // Apply tensor at latitude 45 deg N (westerlies storm zone)
  const lon = 0.0;
  const lat = (45.0 * Math.PI) / 180.0;
  const applied = ocean.applyEnvironmentalTensor(tensors, lon, lat);

  assert.ok(applied !== undefined, "Applied state must be returned");
  assert.ok(ocean.windSpeed > 0.0, "Wind speed must be positive");
  assert.ok(
    ocean.meanSeaLevelPressure >= 900.0 && ocean.meanSeaLevelPressure <= 1050.0,
    "Pressure must be physical",
  );

  // The sampled state reached the primitive's spectrum fields.
  assert.equal(
    primitive._windSpeed,
    applied.windSpeed,
    "the primitive must carry the sampled wind speed",
  );
  if (applied.windHeadingRad !== undefined) {
    assert.ok(
      Math.abs(primitive._windDirX - Math.cos(applied.windHeadingRad)) < 1e-9 &&
        Math.abs(primitive._windDirZ - Math.sin(applied.windHeadingRad)) < 1e-9,
      "the primitive must carry the sampled wind heading",
    );
  }
  assert.equal(primitive._paramsDirty, true, "the spectrum must be dirtied");

  // The primitive method alone does the same job.
  const alone = new OceanSurfacePrimitive();
  alone._paramsDirty = false;
  alone.applyEnvironmentalTensor({ windSpeed: 21.0, windHeadingRad: 1.0 });
  assert.equal(alone._windSpeed, 21.0);
  assert.ok(Math.abs(alone._windDirX - Math.cos(1.0)) < 1e-9);
  assert.ok(Math.abs(alone._windDirZ - Math.sin(1.0)) < 1e-9);
  assert.equal(alone._paramsDirty, true);

  // Verify storm surge calculation derived from pressure
  const expectedSurge = (1013.25 - ocean.meanSeaLevelPressure) * 0.01;
  assert.ok(
    Math.abs(ocean.stormSurgeMeters - expectedSurge) < 1e-5,
    "Ocean storm surge offset must match barometric formula",
  );
});

test("6. GlobeWaterOcean and OceanSurfacePrimitive wire with BathymetryTensorMap", () => {
  const bathy = buildProceduralBathymetryTensor(360, 180);
  const mockScene = { primitives: { add() {}, remove() {} }, globe: {} };
  const ocean = new GlobeWaterOcean(mockScene);

  const applied = ocean.applyBathymetryTensor(bathy, 0.0, 0.0);
  assert.ok(applied !== undefined, "Bathymetry applied state must be defined");
  assert.ok(
    ocean.bathymetryDepthMeters >= 0.0 &&
      ocean.bathymetryDepthMeters <= BATHYMETRY_MAX_DEPTH_M,
    "Ocean depth must be in physical range",
  );
  assert.ok(
    ocean.bathymetryJerlovType >= 0 && ocean.bathymetryJerlovType <= 9,
    "Jerlov type must be in range 0-9",
  );
});

test("7. AtmosphericEffects wires environmental tensor into weather and precipitation", () => {
  const tensors = buildProceduralEnvironmentalTensor(360, 180);
  const coldPolarState = sampleEnvironmentalTensor(
    tensors,
    0.0,
    (80.0 * Math.PI) / 180.0,
  );
  // Force high precipitation on cold polar state to test snow transition
  coldPolarState.precipitationRate = 0.8;
  coldPolarState.temperatureC = -15.0;

  const mockScene = {
    globe: {
      atmosphericConditions: {
        weather: {
          humidity: 0.5,
          airQuality: 1.0,
          temperature: 20.0,
          dewpoint: 10.0,
          type: 0,
          intensity: 0.0,
        },
      },
    },
    weatherWindSpeed: 0.0,
    weatherIntensity: 0.0,
    weatherType: 0,
    weatherWindDirection: null,
  };

  applyEnvironmentalTensor(mockScene, coldPolarState);

  // With T = -15C and precip > 0.05, weather type must be SNOW
  assert.equal(
    mockScene.globe.atmosphericConditions.weather.type,
    PrecipitationType.SNOW,
    "Sub-freezing precipitation must resolve to SNOW",
  );
  assert.equal(
    mockScene.weatherType,
    1, // 1 = snow in legacy flat enum
    "Legacy flat weather type must be 1 (snow)",
  );
  assert.equal(
    mockScene.weatherIntensity,
    0.8,
    "Precipitation intensity matches tensor",
  );
  assert.equal(
    mockScene.weatherWindSpeed,
    coldPolarState.windSpeed,
    "Wind speed matches tensor",
  );
});

test("8. P3-N2 (P15) the scene wind direction uses the same heading convention as the ocean primitive", () => {
  // `windHeadingRad` reaches two consumers: `applyEnvironmentalTensor` (scene
  // weather) and `OceanSurfacePrimitive.applyEnvironmentalTensor` (the FFT
  // spectrum). Both must read it the same way, x = cos and the second axis =
  // sin, or the weather and the waves blow in different directions.
  for (const heading of [0.3, 1.0, 2.2, -1.1]) {
    const scene = {
      globe: undefined,
      weatherWindSpeed: 0.0,
      weatherIntensity: 0.0,
      weatherType: 0,
      weatherWindDirection: null,
    };
    applyEnvironmentalTensor(scene, {
      windSpeed: 9.0,
      windHeadingRad: heading,
      precipitationRate: 0.0,
      temperatureC: 15.0,
    });
    const ocean = new OceanSurfacePrimitive();
    ocean.applyEnvironmentalTensor({ windSpeed: 9.0, windHeadingRad: heading });
    assert.ok(
      Math.abs(scene.weatherWindDirection.x - ocean._windDirX) < 1e-12 &&
        Math.abs(scene.weatherWindDirection.y - ocean._windDirZ) < 1e-12,
      `heading ${heading}: scene (${scene.weatherWindDirection.x}, ${scene.weatherWindDirection.y}) vs ocean (${ocean._windDirX}, ${ocean._windDirZ})`,
    );
    assert.equal(scene.weatherWindDirection.z, 0.0);
  }
});
