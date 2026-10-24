// water-multi-biome-perf-compile.spec.mjs
// @purpose Benchmarks WGSL shader preprocessing and Naga compilation latency across all 4 GlobeTerrain quality tiers, CPU hydro-optical and littoral SDF water-mask throughput, and quantitative multi-biome optical separation baselines.
// @status ACTIVE

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";
import {
  preprocess,
  ShaderDefine,
  ShaderDefineHi,
} from "./lib/wgsl-variant.mjs";

enableEngineTsResolution();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const importEngine = async (p) =>
  await import(
    pathToFileURL(path.join(ROOT, "packages/engine/Source", p)).href
  );

const {
  buildProceduralBathymetryTensor,
  evaluateCase2BioOpticalIOP,
  evaluateFetchLimitedWaveSpectrum,
  parseBundledBathymetryTensor,
  WMTSBathymetryTensorTileProvider,
  wmtsCoordAtLonLat,
  wmtsTileRectangle,
} = await importEngine("Scene/BathymetryTensorMap.ts");
const {
  CloudTiledWaterAndBathymetryProvider,
  CompositeWaterClassificationProvider,
  GlobalCoastlineWaterClassificationProvider,
  LakeWaterClassificationProvider,
  PMTilesWaterAndBathymetryProvider,
  RiverWaterClassificationProvider,
} = await importEngine("Scene/WaterClassificationProvider.ts");
const {
  default: GlobeWater,
  WaterRegionCollection,
  WaterType,
} = await importEngine("Scene/GlobeWater.js");

const nagaDir = path.join(ROOT, "Tools/shader-pipeline/naga-wasm-tools");
const naga = await import(
  pathToFileURL(path.join(nagaDir, "naga_wasm_tools.js")).href
);
await naga.default({
  module_or_path: fs.readFileSync(
    path.join(nagaDir, "naga_wasm_tools_bg.wasm"),
  ),
});

const GLOBE_WGSL_PATH = path.join(
  ROOT,
  "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
);
const OCEAN_WGSL_PATH = path.join(
  ROOT,
  "packages/engine/Source/Shaders/WebGPU/Ocean/OceanSurface.wgsl",
);
const COASTLINE_ASSET_PATH = path.join(
  ROOT,
  "packages/engine/Source/Assets/WaterMask/ne50mCoastlines.bin",
);
const LAKE_ASSET_PATH = path.join(
  ROOT,
  "packages/engine/Source/Assets/WaterMask/ne10mLakes.bin",
);
const RIVER_ASSET_PATH = path.join(
  ROOT,
  "packages/engine/Source/Assets/WaterMask/ne10mRivers.bin",
);

const globeWgslRaw = fs.readFileSync(GLOBE_WGSL_PATH, "utf8");
const oceanWgslRaw = fs.readFileSync(OCEAN_WGSL_PATH, "utf8");

// Timings are reported through t.diagnostic and never asserted against a wall-clock
// number: the gate runs in parallel with 100+ other specs, so an absolute threshold
// would encode one machine's speed. Bounds below are counts, equality or ratios.
function reportTiming(t, label, ms) {
  t.diagnostic(`${label}: ${ms.toFixed(3)} ms`);
}

function minElapsedMs(runs, fn) {
  let best = Infinity;
  let value;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    value = fn();
    best = Math.min(best, performance.now() - t0);
  }
  return { ms: best, value };
}

// Per-call cost at 4N iterations must stay within 8x the per-call cost at N: a
// relative bound that catches super-linear growth without naming a speed.
function assertLinearWork(t, label, iterations, fn) {
  let sink = 0;
  const perCallUs = (n) => {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      sink += fn(i);
    }
    return ((performance.now() - t0) * 1000) / n;
  };
  const base = perCallUs(iterations);
  const scaled = perCallUs(iterations * 4);
  t.diagnostic(
    `${label}: ${base.toFixed(3)} us/call at ${iterations}, ${scaled.toFixed(3)} us/call at ${iterations * 4}`,
  );
  assert.ok(Number.isFinite(sink), `${label} must produce finite results`);
  assert.ok(
    scaled <= 8 * base,
    `Expected ${label} to scale linearly (${scaled.toFixed(3)} us/call at 4N vs ${base.toFixed(3)} us/call at N)`,
  );
}

test("1. Shader preprocessing & Naga WGSL compile across all 4 quality tiers (timings reported, structure asserted)", (t) => {
  const tiers = [
    {
      name: "Tier 0 (Classic WebGL-parity water)",
      definesLo: 0,
      definesHi: 0,
    },
    {
      name: "Tier 1 (Enhanced Ocean + Multi-Biome Surface Hydro-Optics)",
      definesLo: 0,
      definesHi: ShaderDefineHi.ENHANCED_OCEAN,
    },
    {
      name: "Tier 2 (Enhanced Ocean + Underwater & Benthic Optics)",
      definesLo: 0,
      definesHi:
        ShaderDefineHi.ENHANCED_OCEAN | ShaderDefineHi.UNDERWATER_OPTICS,
    },
    {
      name: "Tier 2 Production (Enhanced Ocean + Underwater + LogDepth + GeodeticNormal)",
      definesLo: ShaderDefine.LOG_DEPTH,
      definesHi:
        ShaderDefineHi.ENHANCED_OCEAN |
        ShaderDefineHi.UNDERWATER_OPTICS |
        ShaderDefineHi.GEODETIC_NORMAL,
    },
  ];

  // Warm up Naga WASM JIT on a full GlobeTerrain variant before measuring steady-state latency
  naga.validate_wgsl(
    preprocess(
      globeWgslRaw,
      0,
      ShaderDefineHi.ENHANCED_OCEAN | ShaderDefineHi.UNDERWATER_OPTICS,
    ),
  );

  const compileMsByTier = [];
  const preprocessedByTier = [];
  for (const tier of tiers) {
    const pre = minElapsedMs(2, () =>
      preprocess(globeWgslRaw, tier.definesLo, tier.definesHi),
    );
    const preprocessed = pre.value;
    reportTiming(t, `preprocess ${tier.name}`, pre.ms);
    assert.equal(
      preprocess(globeWgslRaw, tier.definesLo, tier.definesHi),
      preprocessed,
      `Expected preprocessing to be deterministic for ${tier.name}`,
    );

    const compile = minElapsedMs(2, () => {
      assert.doesNotThrow(() => {
        naga.validate_wgsl(preprocessed);
      }, `Expected zero Naga validation errors for ${tier.name}`);
    });
    reportTiming(t, `naga validate ${tier.name}`, compile.ms);
    compileMsByTier.push(compile.ms);
    preprocessedByTier.push(preprocessed);
  }

  // The tiers are distinct programs: a define bit that selected nothing would make two
  // tiers byte-identical.
  assert.notEqual(
    preprocessedByTier[0],
    preprocessedByTier[1],
    "Expected ENHANCED_OCEAN to change the preprocessed GlobeTerrain program",
  );
  assert.notEqual(
    preprocessedByTier[1],
    preprocessedByTier[2],
    "Expected UNDERWATER_OPTICS to change the preprocessed GlobeTerrain program",
  );
  // Relative bound: the heaviest tier validates within 12x of the lightest one.
  assert.ok(
    Math.max(...compileMsByTier) <= 12 * Math.min(...compileMsByTier),
    `Expected tier validation cost to stay within 12x across tiers, got ${compileMsByTier.map((ms) => ms.toFixed(1)).join(", ")} ms`,
  );

  const oceanPreprocessed = preprocess(oceanWgslRaw, 0, 0);
  const ocean = minElapsedMs(2, () => {
    assert.doesNotThrow(() => {
      naga.validate_wgsl(oceanPreprocessed);
    }, "Expected OceanSurface.wgsl to pass Naga validation");
  });
  reportTiming(t, "naga validate OceanSurface.wgsl", ocean.ms);

  // Verify SFU transcendental call budget in GlobeTerrain.wgsl
  const stripped = globeWgslRaw
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const sfuMatches =
    stripped.match(/\b(exp|pow|sin|cos|atan2|asin|acos|log|log2|sqrt)\s*\(/g) ||
    [];
  assert.ok(
    sfuMatches.length <= 245,
    `Expected GlobeTerrain.wgsl SFU transcendental count <= 245, got ${sfuMatches.length}`,
  );
});

test("2. CPU cost scaling for Case-2 IOPs, fetch-limited wave spectrum, and bathymetry sampling (timings reported, scaling asserted)", (t) => {
  const iterations = 5000;
  const tensor = buildProceduralBathymetryTensor(360, 181);
  const mockScene = { primitives: { add() {}, remove() {} } };
  const gw = new GlobeWater(mockScene, {});

  // V8 JIT warmup
  let sink = 0;
  for (let i = 0; i < 120; i++) {
    sink += evaluateCase2BioOpticalIOP({
      cdomConcentration: 1.0,
    }).duckweedMatCoverage;
    sink += evaluateFetchLimitedWaveSpectrum({
      fetchMeters: 1500,
      windSpeedMetersPerSecond: 10,
    }).significantWaveHeightMeters;
    sink += tensor.sample(0, 0).depthMeters;
    sink += gw.evaluateBiomeOptics(WaterType.SWAMP).bioOpticalIOP
      .duckweedMatCoverage;
  }

  assert.ok(Number.isFinite(sink));

  assertLinearWork(t, "evaluateCase2BioOpticalIOP", iterations, () => {
    const iop = evaluateCase2BioOpticalIOP({
      cdomConcentration: 1.4,
      chlorophyllConcentration: 1.2,
      mineralSpmConcentration: 0.25,
      stagnantMarginFactor: 0.85,
    });
    return iop.gordonSubsurfaceAlbedo.r + iop.duckweedMatCoverage;
  });

  assertLinearWork(t, "evaluateFetchLimitedWaveSpectrum", iterations, (i) => {
    const wave = evaluateFetchLimitedWaveSpectrum({
      fetchMeters: 1500.0 + (i % 500),
      windSpeedMetersPerSecond: 11.0,
    });
    return wave.significantWaveHeightMeters + wave.peakWavelengthMeters;
  });

  assertLinearWork(t, "BathymetryTensorMap.sample", iterations, (i) => {
    const s = tensor.sample(
      ((-80.82 + (i % 10) * 0.01) * Math.PI) / 180.0,
      (26.74 * Math.PI) / 180.0,
    );
    return s.depthMeters + s.tidalRangeMeters;
  });

  assertLinearWork(t, "GlobeWater.evaluateBiomeOptics", iterations, () => {
    const b = gw.evaluateBiomeOptics(WaterType.SWAMP);
    return b.bioOpticalIOP.duckweedMatCoverage;
  });
});

test("3. Littoral Euclidean SDF water-mask coverage across 28 global water subtype bookmarks (latency reported, relative bound asserted)", (t) => {
  const coastBuf = fs.readFileSync(COASTLINE_ASSET_PATH);
  const coastProvider = new GlobalCoastlineWaterClassificationProvider(
    coastBuf.buffer.slice(
      coastBuf.byteOffset,
      coastBuf.byteOffset + coastBuf.byteLength,
    ),
  );
  const lakeBuf = fs.readFileSync(LAKE_ASSET_PATH);
  const lakeProvider = new LakeWaterClassificationProvider(
    lakeBuf.buffer.slice(
      lakeBuf.byteOffset,
      lakeBuf.byteOffset + lakeBuf.byteLength,
    ),
  );
  const riverBuf = fs.readFileSync(RIVER_ASSET_PATH);
  const riverProvider = new RiverWaterClassificationProvider(
    riverBuf.buffer.slice(
      riverBuf.byteOffset,
      riverBuf.byteOffset + riverBuf.byteLength,
    ),
  );

  const d2r = Math.PI / 180.0;
  // 20 Inland Lake, Inland Sea, Swamp, Glacial, Rift & Hypersaline Bookmarks (5x original 4)
  const biomeBookmarks = [
    // Ancient Tectonic Rift Lakes (WaterType.ANCIENT_RIFT_LAKE)
    {
      name: "Lake Baikal Rift Shore (baikalRift)",
      subtype: WaterType.ANCIENT_RIFT_LAKE,
      lon: 106.48,
      lat: 52.65,
      spanDeg: 0.06,
      minWaterTexels: 1500,
      minShoreSdfTexels: 300,
    },
    {
      name: "Lake Tanganyika Rift Shore (tanganyikaRift)",
      subtype: WaterType.ANCIENT_RIFT_LAKE,
      lon: 29.35,
      lat: -5.9,
      spanDeg: 0.08,
      minWaterTexels: 1800,
      minShoreSdfTexels: 150,
    },
    {
      name: "Lake Malawi / Nyasa Rift (malawiRift)",
      subtype: WaterType.ANCIENT_RIFT_LAKE,
      lon: 34.28,
      lat: -11.65,
      spanDeg: 0.06,
      minWaterTexels: 400,
      minShoreSdfTexels: 400,
    },
    {
      name: "Issyk-Kul Tian Shan Rift (issykKulRift)",
      subtype: WaterType.ANCIENT_RIFT_LAKE,
      lon: 77.25,
      lat: 42.62,
      spanDeg: 0.06,
      minWaterTexels: 1800,
      minShoreSdfTexels: 300,
    },
    // Swamps & Wetlands (WaterType.SWAMP, WaterType.WETLAND)
    {
      name: "Everglades / Okeechobee Cypress Swamp (evergladesSwamp)",
      subtype: WaterType.SWAMP,
      lon: -80.82,
      lat: 26.74,
      spanDeg: 0.06,
      minWaterTexels: 1500,
      minShoreSdfTexels: 300,
    },
    {
      name: "Atchafalaya Cypress Bayou (atchafalayaBayou)",
      subtype: WaterType.SWAMP,
      lon: -91.52,
      lat: 29.85,
      spanDeg: 0.08,
      minWaterTexels: 200,
      minShoreSdfTexels: 400,
    },
    {
      name: "Okeechobee Littoral Sawgrass Wetland (okeechobeeWetland)",
      subtype: WaterType.WETLAND,
      lon: -80.72,
      lat: 26.88,
      spanDeg: 0.06,
      minWaterTexels: 1500,
      minShoreSdfTexels: 100,
    },
    // Glacial Rock-Flour & Alpine Lakes (WaterType.DEEP_GLACIAL_LAKE)
    {
      name: "Canadian Rockies Kootenay Glacial Fjord Lake (rockiesGlacial)",
      subtype: WaterType.DEEP_GLACIAL_LAKE,
      lon: -116.88,
      lat: 49.65,
      spanDeg: 0.05,
      minWaterTexels: 1200,
      minShoreSdfTexels: 500,
    },
    {
      name: "Patagonia Lago Argentino Glacial Lake (patagoniaGlacial)",
      subtype: WaterType.DEEP_GLACIAL_LAKE,
      lon: -72.85,
      lat: -50.25,
      spanDeg: 0.06,
      minWaterTexels: 1500,
      minShoreSdfTexels: 800,
    },
    {
      name: "New Zealand Lake Pukaki Rock-Flour Basin (pukakiGlacial)",
      subtype: WaterType.DEEP_GLACIAL_LAKE,
      lon: 170.16,
      lat: -44.12,
      spanDeg: 0.06,
      minWaterTexels: 1500,
      minShoreSdfTexels: 800,
    },
    {
      name: "Lake Tahoe Oligotrophic Alpine Basin (tahoeAlpine)",
      subtype: WaterType.DEEP_GLACIAL_LAKE,
      lon: -120.08,
      lat: 39.08,
      spanDeg: 0.06,
      minWaterTexels: 2000,
      minShoreSdfTexels: 300,
    },
    // Hypersaline Brine Basins (WaterType.HYPERSALINE_LAKE)
    {
      name: "Dead Sea Hypersaline Brine Basin (deadSeaBrine)",
      subtype: WaterType.HYPERSALINE_LAKE,
      lon: 35.41,
      lat: 31.5,
      spanDeg: 0.05,
      minWaterTexels: 1500,
      minShoreSdfTexels: 300,
    },
    {
      name: "Great Salt Lake Evaporite Basin (greatSaltLakeBrine)",
      subtype: WaterType.HYPERSALINE_LAKE,
      lon: -112.22,
      lat: 40.95,
      spanDeg: 0.06,
      minWaterTexels: 1200,
      minShoreSdfTexels: 800,
    },
    {
      name: "Lake Urmia Hypersaline Basin (urmiaBrine)",
      subtype: WaterType.HYPERSALINE_LAKE,
      lon: 45.35,
      lat: 37.65,
      spanDeg: 0.08,
      minWaterTexels: 2000,
      minShoreSdfTexels: 80,
    },
    // Continental Freshwater Lakes (WaterType.LAKE)
    {
      name: "Lake Michigan Southern Basin (michiganFreshLake)",
      subtype: WaterType.LAKE,
      lon: -87.58,
      lat: 41.88,
      spanDeg: 0.06,
      minWaterTexels: 2000,
      minShoreSdfTexels: 400,
    },
    {
      name: "Great Slave Lake Boreal Basin (greatSlaveLake)",
      subtype: WaterType.LAKE,
      lon: -114.35,
      lat: 62.42,
      spanDeg: 0.06,
      minWaterTexels: 1000,
      minShoreSdfTexels: 400,
    },
    {
      name: "Lake Superior Apostle Islands (superiorFreshLake)",
      subtype: WaterType.LAKE,
      lon: -90.65,
      lat: 46.92,
      spanDeg: 0.06,
      minWaterTexels: 2000,
      minShoreSdfTexels: 800,
    },
    {
      name: "Lake Victoria Equatorial Basin (victoriaFreshLake)",
      subtype: WaterType.LAKE,
      lon: 32.48,
      lat: 0.02,
      spanDeg: 0.06,
      minWaterTexels: 2000,
      minShoreSdfTexels: 600,
    },
    {
      name: "Lake Titicaca Altiplano Basin (titicacaFreshLake)",
      subtype: WaterType.LAKE,
      lon: -69.18,
      lat: -16.15,
      spanDeg: 0.06,
      minWaterTexels: 2000,
      minShoreSdfTexels: 100,
    },
    {
      name: "Lake Geneva / Lac Leman (genevaFreshLake)",
      subtype: WaterType.LAKE,
      lon: 6.55,
      lat: 46.42,
      spanDeg: 0.06,
      minWaterTexels: 1500,
      minShoreSdfTexels: 400,
    },
  ];

  // Warm up V8 JIT for LakeWaterClassificationProvider.augmentWaterMask before timing individual bookmarks
  lakeProvider.augmentWaterMask(
    new Uint8Array([0]),
    {
      west: 106.42 * d2r,
      south: 52.59 * d2r,
      east: 106.54 * d2r,
      north: 52.71 * d2r,
    },
    64,
  );

  const lakeSdfMsByBookmark = [];
  for (const bm of biomeBookmarks) {
    const rect = {
      west: (bm.lon - bm.spanDeg) * d2r,
      south: (bm.lat - bm.spanDeg) * d2r,
      east: (bm.lon + bm.spanDeg) * d2r,
      north: (bm.lat + bm.spanDeg) * d2r,
    };
    const { ms: elapsedMs, value: mask } = minElapsedMs(2, () =>
      lakeProvider.augmentWaterMask(new Uint8Array([0]), rect, 64),
    );
    lakeSdfMsByBookmark.push(elapsedMs);

    assert.ok(mask, `Expected non-null lake water mask at ${bm.name}`);
    assert.equal(mask.length, 64 * 64);

    let waterTexels = 0;
    let shoreSdfTexels = 0;
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] >= 128) waterTexels++;
      if (mask[i] > 20 && mask[i] < 235) shoreSdfTexels++;
    }

    assert.ok(
      waterTexels >= bm.minWaterTexels,
      `Expected >= ${bm.minWaterTexels} water texels at ${bm.name}, got ${waterTexels}`,
    );
    assert.ok(
      shoreSdfTexels >= bm.minShoreSdfTexels,
      `Expected >= ${bm.minShoreSdfTexels} littoral SDF gradient texels (20 < mask < 235) at ${bm.name}, got ${shoreSdfTexels}`,
    );
    reportTiming(t, `lake SDF mask at ${bm.name}`, elapsedMs);
  }

  // Every bookmark rasterizes the same 64x64 grid, so the cost is a constant of the
  // grid size: the slowest bookmark must stay within 20x of the median (1 ms floor
  // for timer resolution).
  const sortedLakeSdfMs = [...lakeSdfMsByBookmark].sort((a, b) => a - b);
  const medianLakeSdfMs =
    sortedLakeSdfMs[Math.floor(sortedLakeSdfMs.length / 2)];
  assert.equal(lakeSdfMsByBookmark.length, biomeBookmarks.length);
  assert.ok(
    sortedLakeSdfMs[sortedLakeSdfMs.length - 1] <=
      20 * Math.max(medianLakeSdfMs, 1),
    `Expected lake SDF cost to be uniform across bookmarks, slowest ${sortedLakeSdfMs[sortedLakeSdfMs.length - 1].toFixed(2)} ms vs median ${medianLakeSdfMs.toFixed(2)} ms`,
  );

  // Verify Arctic Sea Ice, Antarctic Sea Ice, Caspian/Mediterranean Inland Seas & Estuaries in GlobalCoastlineWaterClassificationProvider
  const coastalSubtypes = [
    {
      name: "Arctic Pack Ice — Svalbard Isfjorden (arcticSvalbard)",
      lon: 15.35,
      lat: 78.25,
      spanDeg: 0.08,
      minWater: 1500,
    },
    {
      name: "Greenland Glacial Icefjord — Ilulissat (arcticIlulissat)",
      lon: -51.12,
      lat: 69.22,
      spanDeg: 0.08,
      minWater: 2000,
    },
    {
      name: "Antarctic Peninsula Sea Ice (antarcticPeninsula)",
      lon: -64.05,
      lat: -64.77,
      spanDeg: 0.12,
      minWater: 1500,
    },
    {
      name: "Caspian Inland Sea Absheron Shelf (caspianInlandSea)",
      lon: 50.36,
      lat: 40.32,
      spanDeg: 0.08,
      minWater: 2000,
    },
    {
      name: "North Caspian Sea Volga Shelf (caspianVolgaDelta)",
      lon: 47.95,
      lat: 45.68,
      spanDeg: 0.08,
      minWater: 2000,
    },
    {
      name: "Mediterranean Aegean Sea — Santorini (mediterraneanSantorini)",
      lon: 25.42,
      lat: 36.4,
      spanDeg: 0.08,
      minWater: 1500,
    },
    {
      name: "Chesapeake Bay Estuary (chesapeakeEstuary)",
      lon: -76.32,
      lat: 37.0,
      spanDeg: 0.1,
      minWater: 1500,
    },
  ];
  for (const cb of coastalSubtypes) {
    const rect = {
      west: (cb.lon - cb.spanDeg) * d2r,
      south: (cb.lat - cb.spanDeg) * d2r,
      east: (cb.lon + cb.spanDeg) * d2r,
      north: (cb.lat + cb.spanDeg) * d2r,
    };
    const cMask = coastProvider.generateWaterMask(rect, 64);
    assert.ok(
      cMask && cMask.length === 64 * 64,
      `Expected 64x64 coastal mask at ${cb.name}`,
    );
    let cWater = 0;
    for (let i = 0; i < cMask.length; i++) {
      if (cMask[i] >= 128) cWater++;
    }
    assert.ok(
      cWater >= cb.minWater,
      `Expected >= ${cb.minWater} coastal water texels at ${cb.name}, got ${cWater}`,
    );
  }

  // Verify Blackwater River, River Area, and River Centerline mask coverage & SDF gradient
  const riverSubtypes = [
    {
      name: "Rio Negro Blackwater River (rioNegroBlackwater)",
      lon: -60.02,
      lat: -3.12,
      spanDeg: 0.08,
      minActive: 800,
    },
    {
      name: "Mississippi River Meander (mississippiRiver)",
      lon: -90.06,
      lat: 29.94,
      spanDeg: 0.06,
      minActive: 600,
    },
    {
      name: "Nile River Corridor (nileRiver)",
      lon: 31.23,
      lat: 30.05,
      spanDeg: 0.06,
      minActive: 600,
    },
    {
      name: "Danube Delta Reed Wetland Channels (danubeWetland)",
      lon: 29.55,
      lat: 45.15,
      spanDeg: 0.08,
      minActive: 500,
    },
  ];
  for (const rb of riverSubtypes) {
    const rRect = {
      west: (rb.lon - rb.spanDeg) * d2r,
      south: (rb.lat - rb.spanDeg) * d2r,
      east: (rb.lon + rb.spanDeg) * d2r,
      north: (rb.lat + rb.spanDeg) * d2r,
    };
    const rMask = riverProvider.augmentWaterMask(
      new Uint8Array([0]),
      rRect,
      64,
    );
    assert.ok(rMask, `Expected non-null river water mask at ${rb.name}`);
    let rActive = 0;
    for (let i = 0; i < rMask.length; i++) {
      if (rMask[i] > 32) rActive++;
    }
    assert.ok(
      rActive >= rb.minActive,
      `Expected >= ${rb.minActive} active river SDF texels at ${rb.name}, got ${rActive}`,
    );
  }
});

test("4. Quantitative multi-biome optical separation baselines across all 12 WaterType subtypes", () => {
  const mockScene = { primitives: { add() {}, remove() {} } };
  const gw = new GlobeWater(mockScene, {});

  const openOcean = gw.evaluateBiomeOptics(WaterType.OCEAN, {
    windSpeedMetersPerSecond: 12.0,
  });
  const inlandSea = gw.evaluateBiomeOptics(WaterType.SEA, {
    windSpeedMetersPerSecond: 10.0,
  });
  const freshLake = gw.evaluateBiomeOptics(WaterType.LAKE);
  const riverArea = gw.evaluateBiomeOptics(WaterType.RIVER_AREA);
  const riverChannel = gw.evaluateBiomeOptics(WaterType.RIVER_LINE);
  const wetlandMarsh = gw.evaluateBiomeOptics(WaterType.WETLAND);
  const swampWetland = gw.evaluateBiomeOptics(WaterType.SWAMP);
  const glacialLake = gw.evaluateBiomeOptics(WaterType.DEEP_GLACIAL_LAKE);
  const riftLake = gw.evaluateBiomeOptics(WaterType.ANCIENT_RIFT_LAKE);
  const hypersalineBrine = gw.evaluateBiomeOptics(WaterType.HYPERSALINE_LAKE);
  const blackwaterRiver = gw.evaluateBiomeOptics(WaterType.BLACKWATER_RIVER);
  const turbidEstuary = gw.evaluateBiomeOptics(WaterType.ESTUARY);

  // Verify all 12 WaterType subtypes return valid, finite optical profiles
  for (const profile of [
    openOcean,
    inlandSea,
    freshLake,
    riverArea,
    riverChannel,
    wetlandMarsh,
    swampWetland,
    glacialLake,
    riftLake,
    hypersalineBrine,
    blackwaterRiver,
    turbidEstuary,
  ]) {
    assert.ok(
      Number.isFinite(profile.bioOpticalIOP.sigmaA.b) &&
        Number.isFinite(profile.bioOpticalIOP.sigmaBb.g) &&
        Number.isFinite(profile.waveSpectrum.significantWaveHeightMeters),
      `Expected finite bio-optical and wave spectrum properties for ${profile.waterType}`,
    );
  }

  // 1. Open Ocean & Inland Sea vs Swamp/Wetland:
  assert.ok(
    swampWetland.bioOpticalIOP.sigmaA.b >
      openOcean.bioOpticalIOP.sigmaA.b * 25.0,
    `Expected Swamp blue absorption (${swampWetland.bioOpticalIOP.sigmaA.b}) > 25x Open Ocean (${openOcean.bioOpticalIOP.sigmaA.b})`,
  );
  assert.ok(
    wetlandMarsh.bioOpticalIOP.sigmaA.b >
      freshLake.bioOpticalIOP.sigmaA.b * 2.0,
    "Expected Wetland Marsh blue CDOM absorption > 2x Freshwater Lake",
  );
  assert.ok(
    inlandSea.waveSpectrum.significantWaveHeightMeters >
      freshLake.waveSpectrum.significantWaveHeightMeters,
    "Expected Inland Sea significant wave height > Freshwater Lake",
  );
  assert.ok(
    swampWetland.bioOpticalIOP.gordonSubsurfaceAlbedo.r >
      swampWetland.bioOpticalIOP.gordonSubsurfaceAlbedo.b,
    "Expected Swamp Gordon subsurface albedo to be warm amber (R > B)",
  );
  assert.ok(
    swampWetland.bioOpticalIOP.duckweedMatCoverage > 0.35 &&
      swampWetland.waveSpectrum.glassMirrorCalmFactor > 0.75,
    "Expected Swamp to activate duckweed mat coverage and glass-mirror calm damping",
  );

  // 2. Glacial Rock-Flour Lake vs Ancient Tectonic Rift Lake:
  assert.ok(
    glacialLake.bioOpticalIOP.sigmaBb.g >
      riftLake.bioOpticalIOP.sigmaBb.g * 8.0,
    `Expected Glacial Lake green Tyndall backscatter (${glacialLake.bioOpticalIOP.sigmaBb.g}) > 8x Rift Lake (${riftLake.bioOpticalIOP.sigmaBb.g})`,
  );
  assert.ok(
    glacialLake.bioOpticalIOP.gordonSubsurfaceAlbedo.g >
      riftLake.bioOpticalIOP.gordonSubsurfaceAlbedo.g * 3.0,
    "Expected Glacial Lake green subsurface albedo > 3x Rift Lake",
  );

  // 3. Hypersaline Brine (Dead Sea / Great Salt Lake) vs Freshwater/Ocean:
  assert.ok(
    hypersalineBrine.bioOpticalIOP.refractiveIndex > 1.35 &&
      hypersalineBrine.bioOpticalIOP.haliteSaltCrustFactor > 0.85,
    `Expected Hypersaline refractive index > 1.35 (got ${hypersalineBrine.bioOpticalIOP.refractiveIndex}) and haliteSaltCrustFactor > 0.85`,
  );

  // 4. Turbid Estuary vs Open Ocean & Blackwater River vs River Area/Line:
  assert.ok(
    turbidEstuary.bioOpticalIOP.sigmaBb.r >
      openOcean.bioOpticalIOP.sigmaBb.r * 5.0,
    "Expected Turbid Estuary red sediment backscatter > 5x Open Ocean",
  );
  assert.ok(
    blackwaterRiver.bioOpticalIOP.sigmaA.b >
      riverChannel.bioOpticalIOP.sigmaA.b * 3.0 &&
      blackwaterRiver.bioOpticalIOP.sigmaA.b >
        riverArea.bioOpticalIOP.sigmaA.b * 3.0,
    "Expected Blackwater River blue tannin absorption > 3x standard River Area and River Line",
  );

  // 5. Continental River vs Open Ocean wave spectrum:
  assert.ok(
    riverChannel.waveSpectrum.octaveWeights.swell150m === 0.0 &&
      openOcean.waveSpectrum.octaveWeights.swell150m === 1.0,
    "Expected River to suppress 150m open-ocean swell while Open Ocean retains full 150m swell",
  );
});

test("5. GlobeTerrain.wgsl multiBiomeGate & biomeOpticalAuthority structural verification", () => {
  const multiBiomeGateIdx = globeWgslRaw.indexOf("let multiBiomeGate =");
  const imageryWaterGateIdx = globeWgslRaw.indexOf("let imageryWaterGate =");
  const openWaterMaskIdx = globeWgslRaw.indexOf("let openWaterMask =");

  assert.ok(
    multiBiomeGateIdx > 0 && multiBiomeGateIdx < openWaterMaskIdx,
    "Expected multiBiomeGate to be hoisted before openWaterMask in GlobeTerrain.wgsl",
  );
  assert.ok(
    multiBiomeGateIdx < imageryWaterGateIdx,
    "Expected multiBiomeGate to be hoisted before imageryWaterGate in GlobeTerrain.wgsl",
  );

  for (const token of [
    "glacialFjordBody",
    "riftGrabenBody",
    "hypersalineBrineBody",
    "duckweedColor",
    "biomeOpticalAuthority",
  ]) {
    assert.ok(
      globeWgslRaw.includes(token),
      `Expected GlobeTerrain.wgsl to include multi-biome optical term '${token}'`,
    );
  }
});

test("6. Phase 14 Sea-Level 60 FPS guards, speculative Tier-2 prewarm, concentric 3-bar surf, and global biome generalization", () => {
  assert.match(
    globeWgslRaw,
    /if\s*\(swampCdomWeight\s*\+\s*hypersalineWeight\s*\+\s*riftLakeWeight\s*>\s*1\.0e-4\)/,
    "GlobeTerrain.wgsl must guard the 8-trig biome noise evaluation on non-zero biome weight",
  );
  assert.match(
    globeWgslRaw,
    /if\s*\(camEyeH\s*<\s*16\.0\s*\|\|\s*camEyeH\s*>\s*40\.0\)\s*\{\s*return\s+surfaceColor;\s*\}/,
    "computeSubmergedVolumeComposite must early-out via camera-uniform branch outside [16m, 40m]",
  );
  assert.match(
    globeWgslRaw,
    /\(waterDepth\s*<\s*55\.0\s*\|\|\s*camAlt\s*>\s*15\.5\)/,
    "benthicOptics call site must skip submerged/caustic evaluation at sea level (14m) over deep ocean",
  );
  assert.match(
    globeWgslRaw,
    /let\s+laceTrig\s*=\s*sin\(lacePhase\);/,
    "computeFoam must evaluate cellular lace via vectorized vec4 sin(lacePhase)",
  );
  for (const token of [
    "crest3",
    "globalAlpineGlacial",
    "globalTropicalWetland",
    "uplandRapidsGate",
    "baySeaLevelGate",
  ]) {
    assert.ok(
      globeWgslRaw.includes(token),
      `Expected GlobeTerrain.wgsl to include '${token}'`,
    );
  }

  const pipelinesSrc = fs.readFileSync(
    path.join(
      ROOT,
      "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfacePipelines.ts",
    ),
    "utf8",
  );
  assert.match(
    pipelinesSrc,
    /export function scheduleUnderwaterTier2Warm\([\s\S]*?const\s+tier2Host\s*=\s*withOceanTier\(host,\s*true,\s*true\);/,
    "scheduleUnderwaterTier2Warm must warm Tier-2 (UNDERWATER_OPTICS) pipelines ahead of the eye reaching the sea",
  );

  const globeJsSrc = fs.readFileSync(
    path.join(ROOT, "packages/engine/Source/Scene/Globe.js"),
    "utf8",
  );
  // The sea-level screen-space-error floor read a misspelled field and would have
  // coarsened land terrain had it ever run (FIX_LIST EM-02); it is gone, and the
  // globe's own spec asserts the surface error is left alone.
  assert.doesNotMatch(
    globeJsSrc,
    /seaLevelGrazingSse/,
    "Globe.beginFrame must not carry the dead sea-level screen-space-error floor",
  );
});

test("7. Phases 15-17: 3-cascade OceanSurface.wgsl & radial CDLOD grid, Subnautica wavy meniscus & swaying kelp, and GPU 19.47-deg Kelvin vessel wakes & channel-tangent river advection", () => {
  const oceanRendererSrc = fs.readFileSync(
    path.join(
      ROOT,
      "packages/engine/Source/Renderer/WebGPU/WebGPUOceanRenderer.ts",
    ),
    "utf8",
  );
  assert.match(
    oceanRendererSrc,
    /cdlodRadialX\s*=\s*Math\.sign\(tx\)\s*\*\s*\(0\.35\s*\*\s*Math\.abs\(tx\)\s*\+\s*0\.65\s*\*\s*tx\s*\*\s*tx\)\s*\*\s*0\.5/,
    "WebGPUOceanRenderer.createGrid must apply radial quadratic CDLOD vertex grading",
  );

  const oceanSurfaceWgslPath = path.join(
    ROOT,
    "packages/engine/Source/Shaders/WebGPU/Ocean/OceanSurface.wgsl",
  );
  const oceanSurfaceRaw = fs.readFileSync(oceanSurfaceWgslPath, "utf8");
  for (const token of [
    "fn sampleMultiBandDisp(",
    "fn computeKelvinVesselWake(",
    "gordonScatter",
    "cascadeFoamLace",
  ]) {
    assert.ok(
      oceanSurfaceRaw.includes(token),
      `Expected OceanSurface.wgsl to include '${token}'`,
    );
  }

  for (const definesLo of [0, ShaderDefine.LOG_DEPTH]) {
    const src = preprocess(oceanWgslRaw, definesLo, 0);
    assert.doesNotThrow(() => {
      naga.validate_wgsl(src);
    }, `Naga validation failed for OceanSurface(${definesLo})`);
  }

  for (const token of [
    "fn computeKelvinVesselWake(",
    "meniscusWaveLine",
    "meniscusDropletRivulets",
    "kelpCanopySway",
    "kelpChlorophyllColor",
    "riverChannelTangent",
    "strahlerChannelGate",
  ]) {
    assert.ok(
      globeWgslRaw.includes(token),
      `Expected GlobeTerrain.wgsl to include '${token}'`,
    );
  }
});

test("8. End-to-end CPU/GPU wiring: case-insensitive qualityPreset, WaterRegionCollection overrides, camera emergence timer, hdrControl.zw, and TMA finite-depth uniforms", () => {
  const globeMock = {
    enableEnhancedOcean: false,
    oceanCelestialReflection: false,
    oceanFoamThreshold: 0.65,
  };
  const water = new GlobeWater({}, globeMock);

  // 1. Case-insensitive qualityPreset normalization
  water.qualityPreset = "low";
  assert.strictEqual(water.qualityPreset, "LOW");
  assert.strictEqual(globeMock.oceanFoamThreshold, 0.72);
  water.qualityPreset = "high";
  assert.strictEqual(water.qualityPreset, "HIGH");
  assert.strictEqual(globeMock.oceanFoamThreshold, 0.58);
  water.qualityPreset = "medium";
  assert.strictEqual(water.qualityPreset, "MEDIUM");
  assert.strictEqual(globeMock.oceanFoamThreshold, 0.65);

  // 2. Camera emergence wetness timer & automatic evaluateRegimeAtAltitude wiring
  const submergedWet = water.updateCameraEmergenceState(-8.0, 10.0);
  assert.strictEqual(submergedWet, 1.0);
  const emergingWet = water.updateCameraEmergenceState(1.2, 10.75);
  assert.ok(
    emergingWet > 0.55 && emergingWet < 0.65,
    `Expected exponential emergence wetness ~0.606 at dt=0.75s, got ${emergingWet}`,
  );
  const regimeEmerging = water.evaluateRegimeAtAltitude(1.2);
  assert.ok(
    regimeEmerging.waterlineMeniscus.emergenceWetnessFactor > 0.1,
    "evaluateRegimeAtAltitude must read tracked _timeSinceEmergenceSeconds when not overridden",
  );
  const driedWet = water.updateCameraEmergenceState(1.2, 20.0);
  assert.strictEqual(driedWet, 0.0);

  // 3. WaterRegionCollection spatial override wiring in evaluateRegimeAtAltitude & evaluateBiomeOptics
  water.regions.add({
    id: "custom_brine_basin",
    west: 0.5,
    south: 0.4,
    east: 0.7,
    north: 0.6,
    waterType: WaterType.HYPERSALINE_LAKE,
    jerlovType: 4,
    waveAmplitudeScale: 0.22,
  });
  const biomeMatched = water.evaluateBiomeOptics(WaterType.OCEAN, {
    longitudeRadians: 0.6,
    latitudeRadians: 0.5,
  });
  assert.strictEqual(biomeMatched.waterType, WaterType.HYPERSALINE_LAKE);
  assert.strictEqual(biomeMatched.jerlovType, 4);
  assert.strictEqual(biomeMatched.waveAmplitudeScale, 0.22);

  // 4. Verify WebGPUOceanRenderer and OceanTimeSpectrum TMA finite-depth wiring
  const oceanRendererSrc = fs.readFileSync(
    path.join(
      ROOT,
      "packages/engine/Source/Renderer/WebGPU/WebGPUOceanRenderer.ts",
    ),
    "utf8",
  );
  assert.match(
    oceanRendererSrc,
    /iff\[10\]\s*=\s*p\._bathymetryDepthM\s*\?\?\s*0\.0/,
    "WebGPUOceanRenderer must pack _bathymetryDepthM into iff[10]",
  );
  assert.match(
    oceanRendererSrc,
    /tf\[5\]\s*=\s*p\._bathymetryDepthM\s*\?\?\s*0\.0/,
    "WebGPUOceanRenderer must pack _bathymetryDepthM into tf[5]",
  );
  assert.match(
    oceanRendererSrc,
    /od\[46\]\s*=\s*p\._bathymetryDepthM\s*\?\?\s*0\.0/,
    "WebGPUOceanRenderer must pack _bathymetryDepthM into od[46]",
  );
});

// ---------------------------------------------------------------------------
// 14. WMTS-Style Global Tensor Streaming, 2D Spatial Grid Indexing & CLOD Upsampling
// ---------------------------------------------------------------------------
test("WMTSBathymetryTensorTileProvider and water classification providers stream and cache tiles per quadtree LOD", () => {
  // 1. Verify WMTS tile coordinate & rectangle round-trip in EPSG:4326 (2x1 root)
  const bahamasLon = (-76.5 * Math.PI) / 180.0;
  const bahamasLat = (24.2 * Math.PI) / 180.0;
  for (const level of [0, 3, 6, 10]) {
    const coord = wmtsCoordAtLonLat(bahamasLon, bahamasLat, level);
    assert.strictEqual(coord.level, level);
    const rect = wmtsTileRectangle(coord.x, coord.y, level);
    assert.ok(
      bahamasLon >= rect.west - 1e-12 && bahamasLon <= rect.east + 1e-12,
      `Bahamas longitude must fall inside WMTS tile (${level}, ${coord.x}, ${coord.y})`,
    );
    assert.ok(
      bahamasLat >= rect.south - 1e-12 && bahamasLat <= rect.north + 1e-12,
      `Bahamas latitude must fall inside WMTS tile (${level}, ${coord.x}, ${coord.y})`,
    );
  }

  // 2. Verify 2D spatial grid index skips unrelated surveys on open-ocean tiles
  const wmtsProvider = new WMTSBathymetryTensorTileProvider({
    tileSize: 16,
    maxCachedTiles: 16,
  });

  // Mid-Pacific abyssal ocean (-140 deg W, 0 deg N) at LOD 6 -> 0 regional surveys evaluated
  const pacificCoord = wmtsCoordAtLonLat((-140.0 * Math.PI) / 180.0, 0.0, 6);
  const pacificTile = wmtsProvider.requestTileTensor(
    pacificCoord.x,
    pacificCoord.y,
    pacificCoord.level,
  );
  assert.strictEqual(
    pacificTile.surveysEvaluated,
    0,
    "Open-ocean mid-Pacific WMTS tile must evaluate 0 regional surveys via 2D spatial grid index",
  );
  assert.strictEqual(
    pacificTile.bathymetryBytes.byteLength,
    16 * 16 * 4,
    "16x16 RGBA8 tensor tile must be 1024 bytes",
  );

  // Bahamas carbonate bank at LOD 6 -> evaluates matching regional survey and produces shallow sandy tensor
  const bahamasCoord = wmtsCoordAtLonLat(bahamasLon, bahamasLat, 6);
  const bahamasTile = wmtsProvider.requestTileTensor(
    bahamasCoord.x,
    bahamasCoord.y,
    bahamasCoord.level,
  );
  assert.ok(
    bahamasTile.surveysEvaluated >= 1 && bahamasTile.surveysEvaluated <= 4,
    `Bahamas WMTS tile should only evaluate nearby spatial cell surveys, got ${bahamasTile.surveysEvaluated}`,
  );
  const bahamasSample = wmtsProvider.sampleAtLonLat(bahamasLon, bahamasLat, 6);
  assert.ok(
    bahamasSample.depthMeters < 50.0,
    `Bahamas carbonate bank sample should be shallow (<50m), got ${bahamasSample.depthMeters}m`,
  );
  assert.ok(
    bahamasSample.substrateType === 0 || bahamasSample.substrateType === 2,
    `Bahamas carbonate bank should have SAND (0) or CORAL_REEF (2) substrateType, got ${bahamasSample.substrateType}`,
  );

  // 3. Verify Cache Hit O(1) identity & Bounded LRU Eviction (maxCachedTiles = 16)
  const bahamasTileCached = wmtsProvider.requestTileTensor(
    bahamasCoord.x,
    bahamasCoord.y,
    bahamasCoord.level,
  );
  assert.strictEqual(
    bahamasTileCached,
    bahamasTile,
    "Requesting the same (level, x, y) WMTS tensor tile must return the cached LRU entry",
  );

  for (let x = 0; x < 20; x++) {
    wmtsProvider.requestTileTensor(x, 10, 5);
  }
  assert.strictEqual(
    wmtsProvider.cachedTileCount,
    16,
    "WMTSBathymetryTensorTileProvider must enforce maxCachedTiles LRU eviction cap",
  );

  // 4. Verify Parent-to-Child Quadtree CLOD Tensor Upsampling
  const parentCoord = wmtsCoordAtLonLat(bahamasLon, bahamasLat, 5);
  const parentTile = wmtsProvider.requestTileTensor(
    parentCoord.x,
    parentCoord.y,
    5,
  );
  const childCoord = wmtsCoordAtLonLat(bahamasLon, bahamasLat, 7);
  const upsampledChild = wmtsProvider.upsampleParentTileTensor(
    parentTile,
    childCoord.x,
    childCoord.y,
    7,
  );
  assert.strictEqual(
    upsampledChild.upsampledFromParent,
    true,
    "upsampleParentTileTensor must mark child tile as upsampledFromParent",
  );
  assert.ok(
    upsampledChild.bathymetryBytes instanceof Uint8Array &&
      upsampledChild.bathymetryBytes.byteLength === 16 * 16 * 4,
    "upsampleParentTileTensor must synthesize a 16x16 RGBA8 child tensor from its cached ancestor tile",
  );

  // 5. Verify GlobalCoastlineWaterClassificationProvider & CompositeWaterClassificationProvider
  //    2D spatial grid indexing and LRU quadtree tile mask caching
  const coastBuf = fs.readFileSync(COASTLINE_ASSET_PATH);
  const coastlineProvider = new GlobalCoastlineWaterClassificationProvider(
    coastBuf.buffer.slice(
      coastBuf.byteOffset,
      coastBuf.byteOffset + coastBuf.byteLength,
    ),
  );
  const lakeBuf = fs.readFileSync(LAKE_ASSET_PATH);
  const riverBuf = fs.readFileSync(RIVER_ASSET_PATH);
  const lakeProvider = new LakeWaterClassificationProvider(
    lakeBuf.buffer.slice(
      lakeBuf.byteOffset,
      lakeBuf.byteOffset + lakeBuf.byteLength,
    ),
  );
  const riverProvider = new RiverWaterClassificationProvider(
    riverBuf.buffer.slice(
      riverBuf.byteOffset,
      riverBuf.byteOffset + riverBuf.byteLength,
    ),
  );
  const compositeProvider = new CompositeWaterClassificationProvider([
    coastlineProvider,
    lakeProvider,
    riverProvider,
  ]);

  const tileRect = wmtsTileRectangle(bahamasCoord.x, bahamasCoord.y, 6);
  const mask1 = coastlineProvider.generateWaterMask(tileRect, 16, 16);
  const mask2 = coastlineProvider.generateWaterMask(tileRect, 16, 16);
  assert.strictEqual(
    mask1,
    mask2,
    "GlobalCoastlineWaterClassificationProvider must return cached SDF water mask on repeated quadtree tile requests",
  );
  assert.ok(
    coastlineProvider.cachedTileCount >= 1,
    "Coastline provider must track cached quadtree tile masks",
  );

  const compMask1 = compositeProvider.generateWaterMask(tileRect, 16, 16);
  const compMask2 = compositeProvider.generateWaterMask(tileRect, 16, 16);
  assert.strictEqual(
    compMask1,
    compMask2,
    "CompositeWaterClassificationProvider must return cached composite SDF water mask on repeated quadtree tile requests",
  );

  // 6. Verify WGSL shader has WMTS-coherent longitude sector culling & shore early-out gates
  const globeTerrainWgsl = fs.readFileSync(GLOBE_WGSL_PATH, "utf8");
  assert.match(
    globeTerrainWgsl,
    /if\s*\(\s*lonDeg\s*<\s*-20\.0\s*\)/,
    "GlobeTerrain.wgsl must partition planetary bathymetry/biome evaluation into Western Hemisphere sector (lonDeg < -20.0)",
  );
  assert.match(
    globeTerrainWgsl,
    /else\s+if\s*\(\s*lonDeg\s*>=\s*-10\.0\s*&&\s*lonDeg\s*<=\s*60\.0\s*\)/,
    "GlobeTerrain.wgsl must partition planetary bathymetry/biome evaluation into Euro-African/Middle East sector (-10.0 <= lonDeg <= 60.0)",
  );

  // 7. Verify all 24 new US & international unique water feature locations stream via WMTS
  //    spatial grid indexing and are exposed in the Sandcastle2 showcase (83 global sites)
  const newGlobalLandmarks = [
    { key: "miamiIntracoastal", lon: -80.145, lat: 25.825 },
    { key: "sanibelCaloosahatchee", lon: -82.035, lat: 26.475 },
    { key: "tampaBayEstuary", lon: -82.655, lat: 27.625 },
    { key: "sanFranciscoBay", lon: -122.465, lat: 37.82 },
    { key: "lakeGeorgeNY", lon: -73.625, lat: 43.565 },
    { key: "lakePlacidNY", lon: -73.982, lat: 44.298 },
    { key: "ohioMississippiConfluence", lon: -89.133, lat: 36.982 },
    { key: "vancouverIslandFjord", lon: -125.905, lat: 49.152 },
    { key: "bayOfFundyTides", lon: -64.35, lat: 45.32 },
    { key: "veniceLagoonCanals", lon: 12.332, lat: 45.438 },
    { key: "lakeComoItaly", lon: 9.262, lat: 46.002 },
    { key: "norwayGeirangerfjord", lon: 7.095, lat: 62.105 },
    { key: "waddenSeaTidalFlats", lon: 8.42, lat: 54.88 },
    { key: "plitviceTravertine", lon: 15.61, lat: 44.88 },
    { key: "riaFormosaLagoon", lon: -7.86, lat: 36.99 },
    { key: "haLongBayKarst", lon: 107.085, lat: 20.845 },
    { key: "okavangoDelta", lon: 22.92, lat: -19.28 },
    { key: "keralaBackwaters", lon: 76.38, lat: 9.62 },
    { key: "rajaAmpatLagoon", lon: 130.02, lat: -0.16 },
    { key: "sharkBayAustralia", lon: 113.82, lat: -25.92 },
    { key: "milfordSoundFjord", lon: 167.89, lat: -44.64 },
    { key: "lencoisMaranhenses", lon: -43.12, lat: -2.48 },
    { key: "yangtzeThreeGorges", lon: 110.82, lat: 30.98 },
    { key: "tonleSapBasin", lon: 104.05, lat: 12.88 },
  ];

  const sandcastleMain = fs.readFileSync(
    path.join(
      ROOT,
      "packages/sandcastle/gallery/webgpu-global-water-weather/main.js",
    ),
    "utf8",
  );
  const sandcastleHtml = fs.readFileSync(
    path.join(
      ROOT,
      "packages/sandcastle/gallery/webgpu-global-water-weather/index.html",
    ),
    "utf8",
  );

  const globalProvider = new WMTSBathymetryTensorTileProvider({
    tileSize: 16,
    maxCachedTiles: 64,
  });

  for (const lm of newGlobalLandmarks) {
    assert.ok(
      sandcastleMain.includes(`${lm.key}: {`),
      `Sandcastle main.js must include landmark '${lm.key}'`,
    );
    assert.ok(
      sandcastleHtml.includes(`value="${lm.key}"`),
      `Sandcastle index.html must include option for '${lm.key}'`,
    );
    const lonRad = (lm.lon * Math.PI) / 180.0;
    const latRad = (lm.lat * Math.PI) / 180.0;
    const c = wmtsCoordAtLonLat(lonRad, latRad, 6);
    const t = globalProvider.requestTileTensor(c.x, c.y, c.level);
    assert.ok(
      t.surveysEvaluated >= 1 && t.surveysEvaluated <= 6,
      `WMTS tile for '${lm.key}' must evaluate its spatially-indexed regional survey(s), got ${t.surveysEvaluated}`,
    );
    const s = globalProvider.sampleAtLonLat(lonRad, latRad, 6);
    assert.ok(
      s.depthMeters > 0.2,
      `WMTS sample at '${lm.key}' must have positive water depth, got ${s.depthMeters}m`,
    );
  }

  // 8. Verify Full Diurnal Cycle (Dawn, Sunrise East Rose-Gold, Solar Noon Zenith, Golden Hour, Sunset West Copper-Amber, Blue Hour Twilight), Moon (Moonglade / Nocturnal), and Cloud Shadow water response
  for (const token of [
    "let eastWestSunriseFactor =",
    "let twilightBlueHourGate =",
    "let sunHorizonWarmth =",
    "let solarNoonGate =",
    "let sunriseDirectTint =",
    "let sunsetDirectTint =",
    "let solarDirectTint =",
    "let horizonWaveFacetGlow =",
    "let twilightWaveGlow =",
    "let noonWaveSparkle =",
    "let sunriseHorizonTint =",
    "let sunsetHorizonTint =",
    "let goldenHorizonTint =",
    "let twilightSkyTint =",
    "let lunarGladeRadiance =",
    "let nightSkyTint =",
  ]) {
    assert.ok(
      globeTerrainWgsl.includes(token),
      `Expected GlobeTerrain.wgsl to include diurnal/celestial lighting term '${token}'`,
    );
  }
  assert.match(
    globeTerrainWgsl,
    /min\(\s*glintExcess\s*,\s*oceanColor\s*\*\s*0\.72\s*\)\s*\*\s*cloudOcclusion/,
    "GlobeTerrain.wgsl must attenuate direct solar glint and caustics under cloud shadows while preserving overcast sky reflection",
  );
  assert.ok(
    sandcastleMain.includes("window.setLocalSolarHour") &&
      sandcastleHtml.includes('id="solarTimeSlider"'),
    "Sandcastle showcase must expose continuous Local Solar Time slider and latitude-aware diurnal presets",
  );

  // 9. Verify LWM2 hydrological attributes, 4-channel rgba8unorm _rgbaHydroData, 4-tap B-spline SDF, and golden-angle wave normal rotation
  const lakeView = new DataView(
    lakeBuf.buffer,
    lakeBuf.byteOffset,
    lakeBuf.byteLength,
  );
  const coastView = new DataView(
    coastBuf.buffer,
    coastBuf.byteOffset,
    coastBuf.byteLength,
  );
  assert.equal(
    lakeView.getUint32(0, true),
    0x324d574c,
    "ne10mLakes.bin must use LWM2 header (0x324d574c)",
  );
  assert.equal(
    coastView.getUint32(0, true),
    0x324d574c,
    "ne50mCoastlines.bin must use LWM2 header (0x324d574c)",
  );

  const d2r = Math.PI / 180.0;
  // Great Barrier Reef tile (contains coral reef polygons from ne_10m_reefs.geojson -> waterTypeCode 8)
  const gbrRect = {
    west: 147.2 * d2r,
    south: -18.8 * d2r,
    east: 148.2 * d2r,
    north: -17.8 * d2r,
  };
  // The asset still classifies the reef polygons there as type 8 (the offline
  // tensor builder reads them), but globe.lakeWaterMask skips types 5 and 8
  // until the maintainer rules on MQ-10, so the lake provider leaves the tile dry.
  let reefPolygonsInTile = 0;
  for (let p = 0, o = 8, n = lakeView.getUint32(4, true); p < n; p++) {
    const meets =
      lakeView.getFloat32(o, true) <= gbrRect.east &&
      lakeView.getFloat32(o + 8, true) >= gbrRect.west &&
      lakeView.getFloat32(o + 4, true) <= gbrRect.north &&
      lakeView.getFloat32(o + 12, true) >= gbrRect.south;
    if (meets && lakeView.getUint8(o + 16) === 8) {
      reefPolygonsInTile++;
    }
    const rings = lakeView.getUint16(o + 18, true);
    o += 20;
    for (let r = 0; r < rings; r++) {
      o += 4 + lakeView.getUint32(o, true) * 4;
    }
  }
  assert.ok(
    reefPolygonsInTile > 0,
    "Expected ne10mLakes.bin to classify Great Barrier Reef polygons as waterTypeCode 8 (CoralReef)",
  );
  assert.equal(
    lakeProvider.augmentWaterMask(new Uint8Array([0]), gbrRect, 64),
    undefined,
    "globe.lakeWaterMask must not paint the reef polygons (types 5 and 8 are skipped until MQ-10)",
  );
  // Lake Michigan tile: the lake provider attaches 4-channel hydro data.
  const lakeTileMask = lakeProvider.augmentWaterMask(
    new Uint8Array([0]),
    {
      west: -87.0 * d2r,
      south: 43.0 * d2r,
      east: -86.0 * d2r,
      north: 44.0 * d2r,
    },
    64,
  );
  assert.ok(
    lakeTileMask && lakeTileMask._rgbaHydroData?.length === 64 * 64 * 4,
    "LakeWaterClassificationProvider must attach 4-channel _rgbaHydroData on lake tiles",
  );
  let sawLakeCode = false;
  for (let i = 0; i < 64 * 64; i++) {
    const g = lakeTileMask._rgbaHydroData[i * 4 + 1];
    const a = lakeTileMask._rgbaHydroData[i * 4 + 3];
    if ((g & 0x0f) >= 1 && (g & 0x0f) <= 7) sawLakeCode = true;
    assert.ok(
      a >= 1 && a <= 249,
      `Expected alpha channel in [1..249] for rgba8unorm marker, got ${a}`,
    );
  }
  assert.ok(
    sawLakeCode,
    "Expected a lake water type code on the Lake Michigan tile",
  );

  // Amazon river tile: verify _rgbaHydroData encodes waterTypeCode 9, Strahler order, and non-zero flow tangent (tx, ty)
  const amazonRect = {
    west: -60.1 * d2r,
    south: -3.25 * d2r,
    east: -59.85 * d2r,
    north: -3.05 * d2r,
  };
  const amazonMask = riverProvider.augmentWaterMask(
    new Uint8Array([0]),
    amazonRect,
    64,
  );
  assert.ok(
    amazonMask && amazonMask._rgbaHydroData?.length === 64 * 64 * 4,
    "RiverWaterClassificationProvider must attach 4-channel _rgbaHydroData on river tiles",
  );
  let sawRiverTangent = false;
  for (let i = 0; i < 64 * 64; i++) {
    const g = amazonMask._rgbaHydroData[i * 4 + 1];
    const b = amazonMask._rgbaHydroData[i * 4 + 2];
    const a = amazonMask._rgbaHydroData[i * 4 + 3];
    if ((g & 0x0f) === 9 && g >>> 4 >= 6 && (b !== 128 || a !== 125)) {
      sawRiverTangent = true;
      break;
    }
  }
  assert.ok(
    sawRiverTangent,
    "Expected RiverWaterClassificationProvider _rgbaHydroData to encode waterTypeCode 9, Strahler order >= 6, and downstream tangent vector",
  );

  for (const token of [
    "let hasHydroRgba = wmMetaBilinear.a < 0.99;",
    "let hydroTypeCode = packedHydroG & 15u;",
    "let decodedRiverTangent =",
    "let scaleA: f32 = 1.6180340;",
    "let scaleB: f32 = 2.4142136;",
    "let submergedSeagrassKeep =",
  ]) {
    assert.ok(
      globeTerrainWgsl.includes(token),
      `Expected GlobeTerrain.wgsl to include '${token}'`,
    );
  }
});

test("10. Phase 20: Bundled globalBathymetryTensor.bin, WaterRegionCollection GPU encoding, PMTilesWaterAndBathymetryProvider, and vessel wakes", () => {
  const d2r = Math.PI / 180.0;
  const bathyBinPath = path.join(
    ROOT,
    "packages/engine/Source/Assets/WaterMask/globalBathymetryTensor.bin",
  );
  assert.ok(
    fs.existsSync(bathyBinPath),
    "Expected bundled globalBathymetryTensor.bin to exist",
  );
  const bathyBuf = fs.readFileSync(bathyBinPath);
  const bathyTensor = parseBundledBathymetryTensor(
    bathyBuf.buffer.slice(
      bathyBuf.byteOffset,
      bathyBuf.byteOffset + bathyBuf.byteLength,
    ),
  );
  assert.equal(bathyTensor.width, 720);
  assert.equal(bathyTensor.height, 360);
  assert.equal(bathyTensor.bathymetryBytes.byteLength, 720 * 360 * 4);

  // Verify pelagic ocean vs continental shelf vs coral reef in globalBathymetryTensor.bin
  const sampleAt = (lonDeg, latDeg) => {
    const col = Math.floor(((lonDeg + 180.0) / 360.0) * 720) % 720;
    const row = Math.min(
      359,
      Math.max(0, Math.floor(((90.0 - latDeg) / 180.0) * 360)),
    );
    const idx = (row * 720 + col) * 4;
    const r = bathyTensor.bathymetryBytes[idx];
    const g = bathyTensor.bathymetryBytes[idx + 1];
    const b = bathyTensor.bathymetryBytes[idx + 2];
    const a = bathyTensor.bathymetryBytes[idx + 3];
    return {
      depthMeters: (r / 255.0) * (r / 255.0) * 11000.0,
      clarity: g / 255.0,
      substrate: b / 255.0,
      tidal: a / 255.0,
    };
  };
  const marianaPelagic = sampleAt(160.0, 15.0);
  const bahamasShelf = sampleAt(-77.5, 24.2);
  assert.ok(
    marianaPelagic.depthMeters > 2500.0,
    `Expected abyssal Pacific depth > 2500m, got ${marianaPelagic.depthMeters.toFixed(1)}m`,
  );
  assert.ok(
    bahamasShelf.depthMeters < marianaPelagic.depthMeters,
    "Expected continental/island shelf to be shallower than abyssal Pacific",
  );

  // Verify CompositeWaterClassificationProvider encodes ocean bathymetry and WaterRegionCollection overrides into _rgbaHydroData
  const coastBin = fs.readFileSync(
    path.join(
      ROOT,
      "packages/engine/Source/Assets/WaterMask/ne50mCoastlines.bin",
    ),
  );
  const coastProvider = new GlobalCoastlineWaterClassificationProvider(
    coastBin.buffer.slice(
      coastBin.byteOffset,
      coastBin.byteOffset + coastBin.byteLength,
    ),
  );
  const regions = new WaterRegionCollection();
  regions.add({
    id: "custom-hypersaline-test",
    west: -140.5 * d2r,
    south: 19.5 * d2r,
    east: -139.5 * d2r,
    north: 20.5 * d2r,
    waterType: WaterType.HYPERSALINE_LAKE,
    jerlovType: 4,
  });
  const composite = new CompositeWaterClassificationProvider([coastProvider], {
    bathymetryTensor: bathyTensor,
    waterRegions: regions,
  });
  const openOceanTile = composite.generateWaterMask({
    west: -140.2 * d2r,
    south: 19.8 * d2r,
    east: -139.8 * d2r,
    north: 20.2 * d2r,
  });
  assert.ok(
    openOceanTile && openOceanTile._rgbaHydroData,
    "Expected CompositeWaterClassificationProvider to attach _rgbaHydroData with bathymetry & region overrides",
  );
  assert.equal(
    openOceanTile._rgbaHydroData[1] & 0x0f,
    4,
    "Expected WaterRegionCollection HYPERSALINE_LAKE override to encode waterTypeCode 4 in _rgbaHydroData",
  );

  // Verify PMTilesWaterAndBathymetryProvider Z8-Z14 streaming & CLOD parent upsampling
  const pmtiles = new PMTilesWaterAndBathymetryProvider({
    tileSize: 16,
    minStreamingLevel: 8,
    maxStreamingLevel: 14,
  });
  const parentRgba = new Uint8Array(16 * 16 * 4);
  for (let i = 0; i < 16 * 16; i++) {
    parentRgba[i * 4] = 220;
    parentRgba[i * 4 + 1] = (9 << 4) | 2;
    parentRgba[i * 4 + 2] = 160;
    parentRgba[i * 4 + 3] = 200;
  }
  const coordZ8 = wmtsCoordAtLonLat(0.01, 0.01, 8);
  assert.ok(coordZ8 && coordZ8.level === 8);
  pmtiles.putTile(coordZ8.level, coordZ8.x, coordZ8.y, parentRgba);
  const childCoordZ9 = wmtsCoordAtLonLat(0.01, 0.01, 9);
  const childRectZ9 = wmtsTileRectangle(
    childCoordZ9.x,
    childCoordZ9.y,
    childCoordZ9.level,
  );
  const upsampled = pmtiles.generateWaterMask(childRectZ9);
  assert.ok(
    upsampled && upsampled._rgbaHydroData,
    "Expected PMTilesWaterAndBathymetryProvider to CLOD-upsample parent tile when child Z9 tile is not yet cached",
  );
  assert.equal(upsampled._rgbaHydroData[1] & 0x0f, 2);

  // Verify GlobeWater dynamic Kelvin vessel wake controls
  const mockGlobe = {
    showWaterEffect: true,
    enableEnhancedOcean: true,
  };
  const water = new GlobeWater({}, mockGlobe);
  assert.equal(water.vesselWakeEnabled, false);
  const emitter = water.addVesselWakeEmitter({
    x: 80.0,
    y: 140.0,
    vx: 7.5,
    vy: 5.0,
    lengthMeters: 36.0,
  });
  assert.equal(water.vesselWakeEnabled, true);
  assert.equal(water.vesselWakeEmitters.length, 1);
  assert.equal(emitter.lengthMeters, 36.0);
  water.vesselWakeIntensity = 1.5;
  assert.equal(water.vesselWakeIntensity, 1.5);
  water.clearVesselWakeEmitters();
  assert.equal(water.vesselWakeEmitters.length, 0);
});

test("11. Phase 21: CloudTiledWaterAndBathymetryProvider HTTP Range per-tile streaming, < 2% of the archive transferred, and per-frame budget guard", async (t) => {
  const d2r = Math.PI / 180.0;
  const archivePath = path.join(
    ROOT,
    "packages/engine/Source/Assets/WaterMask/globalHydrographyTileArchive.bin",
  );
  // The archive is a derivative of the other WaterMask bins with no runtime consumer;
  // it may be held out of the tracked set (FIX_LIST MQ-1), in which case this test has
  // nothing to stream and says so instead of failing.
  if (!fs.existsSync(archivePath)) {
    t.skip(
      "globalHydrographyTileArchive.bin is not in the tree (held untracked, MQ-1)",
    );
    return;
  }
  const fullArchive = fs.readFileSync(archivePath);
  const dirSize = 16 + 36 * 18 * 16; // 10,384 bytes (10.1 KiB)
  const dirHeader = fullArchive.buffer.slice(
    fullArchive.byteOffset,
    fullArchive.byteOffset + dirSize,
  );

  let rangeRequests = 0;
  let rangeBytesFetched = 0;
  const cloudProvider = new CloudTiledWaterAndBathymetryProvider({
    directoryOrArchiveBuffer: dirHeader,
    rangeFetcher: async (offset, length) => {
      rangeRequests++;
      rangeBytesFetched += length;
      return fullArchive.buffer.slice(
        fullArchive.byteOffset + offset,
        fullArchive.byteOffset + offset + length,
      );
    },
  });

  assert.equal(cloudProvider.ready, true);
  assert.equal(cloudProvider.gridCols, 36);
  assert.equal(cloudProvider.gridRows, 18);

  // Stream ONLY the cell covering Lake Baikal (106.5 E, 52.6 N) via simulated HTTP Range request
  const baikalCell = cloudProvider.lonLatToCellCoord(106.5 * d2r, 52.6 * d2r);
  const decodedCell = await cloudProvider.prefetchCell(
    baikalCell.col,
    baikalCell.row,
  );
  assert.ok(decodedCell, "Expected Lake Baikal 10x10-deg cell to stream");
  assert.equal(rangeRequests, 1);
  // The directory is handed in, so it is counted once and every other byte is a range read.
  assert.equal(
    cloudProvider.bytesStreamed,
    dirSize + rangeBytesFetched,
    "Expected bytesStreamed to equal the directory plus the range bytes fetched",
  );
  assert.ok(
    cloudProvider.bytesStreamed < 0.02 * fullArchive.length,
    `Expected 1 regional cell + directory to transfer < 2% of the ${(fullArchive.length / 1048576).toFixed(2)} MiB archive, transferred ${(cloudProvider.bytesStreamed / 1024).toFixed(1)} KiB (${((100 * cloudProvider.bytesStreamed) / fullArchive.length).toFixed(2)}%)`,
  );

  // Rasterize Lake Baikal tile from the streamed cell and verify _rgbaHydroData tectonic rift classification (code 3)
  const baikalRect = {
    west: 106.42 * d2r,
    south: 52.59 * d2r,
    east: 106.54 * d2r,
    north: 52.69 * d2r,
  };
  const t0 = performance.now();
  const baikalMask = cloudProvider.generateWaterMask(baikalRect, 64);
  const elapsedMs = performance.now() - t0;
  assert.ok(
    baikalMask && baikalMask._rgbaHydroData?.length === 64 * 64 * 4,
    "Expected CloudTiledWaterAndBathymetryProvider to produce 4-channel _rgbaHydroData",
  );
  reportTiming(t, "per-tile cloud cell rasterization", elapsedMs);
  let sawRift = false;
  for (let i = 0; i < 64 * 64; i++) {
    if ((baikalMask._rgbaHydroData[i * 4 + 1] & 0x0f) === 3) {
      sawRift = true;
      break;
    }
  }
  assert.ok(
    sawRift,
    "Expected streamed CWT1 cell to preserve waterTypeCode 3 (TectonicRift) for Lake Baikal",
  );

  // Verify per-frame rasterization budget guard prevents frame spikes during rapid camera motion
  cloudProvider.frameBudgetEnabled = true;
  cloudProvider.beginFrameBudget(1);
  const tileA = cloudProvider.generateWaterMask(
    {
      west: 106.1 * d2r,
      south: 52.1 * d2r,
      east: 106.2 * d2r,
      north: 52.2 * d2r,
    },
    64,
  );
  const tileB = cloudProvider.generateWaterMask(
    {
      west: 106.2 * d2r,
      south: 52.2 * d2r,
      east: 106.3 * d2r,
      north: 52.3 * d2r,
    },
    64,
  );
  assert.equal(tileA.length, 64 * 64);
  assert.equal(
    tileB.length,
    1,
    "Expected second uncached tile in same frame to return fast 1x1 preview when frame budget of 1 tile is reached",
  );
  cloudProvider.beginFrameBudget(1);
  const tileBUpgraded = cloudProvider.generateWaterMask(
    {
      west: 106.2 * d2r,
      south: 52.2 * d2r,
      east: 106.3 * d2r,
      north: 52.3 * d2r,
    },
    64,
  );
  assert.equal(
    tileBUpgraded.length,
    64 * 64,
    "Expected tileB to upgrade to full 64x64 resolution on the next frame budget reset",
  );
});

test("12. Zoom performance, orbital river LOD culling, and close-zoom coastal bay SDF blending guards", () => {
  const coastBuf = fs.readFileSync(COASTLINE_ASSET_PATH);
  const coastline = new GlobalCoastlineWaterClassificationProvider(
    coastBuf.buffer.slice(
      coastBuf.byteOffset,
      coastBuf.byteOffset + coastBuf.byteLength,
    ),
  );
  const riverBuf = fs.readFileSync(RIVER_ASSET_PATH);
  const rivers = new RiverWaterClassificationProvider(
    riverBuf.buffer.slice(
      riverBuf.byteOffset,
      riverBuf.byteOffset + riverBuf.byteLength,
    ),
  );
  const composite = new CompositeWaterClassificationProvider([
    coastline,
    rivers,
  ]);

  const d2r = Math.PI / 180.0;
  // 1. Verify per-frame setWaterRegions([], ...) does not wipe _tileCache when regions are unchanged
  const kauaiBayRect = {
    west: -159.54 * d2r,
    south: 22.19 * d2r,
    east: -159.47 * d2r,
    north: 22.24 * d2r,
  };
  const mask1 = composite.generateWaterMask(kauaiBayRect, 128);
  assert.equal(mask1.length, 128 * 128);
  assert.equal(
    mask1._rgbaHydroData,
    undefined,
    "Pure coastal bay tile without inland lakes/rivers/regions must stay 1-channel r8unorm without allocating 256KB RGBA bathymetry",
  );
  const cacheSizeBefore = composite._tileCache.size;
  assert.ok(cacheSizeBefore >= 1);
  composite.setWaterRegions([]);
  composite.setWaterRegions([]);
  assert.equal(
    composite._tileCache.size,
    cacheSizeBefore,
    "Repeated setWaterRegions calls with identical regions must be an O(1) no-op and preserve _tileCache",
  );

  // 2. Verify coarse orbital tiles (> 0.22 rad / 12.6 deg) skip polyline river rasterization
  const orbitalNorthAmericaRect = {
    west: -105.0 * d2r,
    south: 30.0 * d2r,
    east: -80.0 * d2r,
    north: 50.0 * d2r,
  };
  assert.equal(
    rivers.intersectsRectangle(orbitalNorthAmericaRect),
    false,
    "RiverWaterClassificationProvider must cull polyline rivers on coarse orbital tiles (> 0.22 rad)",
  );

  // 3. Verify GlobeTerrain.wgsl enforces >= 0.22 close-zoom coastBand floor and coastalHomogenizeGate
  assert.match(
    globeWgslRaw,
    /let\s+coastBand\s*=\s*clamp\(max\(maskScreenGrad\s*\*\s*1\.5,\s*0\.22\),\s*0\.22,\s*0\.5\);/,
    "GlobeTerrain.wgsl must enforce a 0.22 floor on coastBand so close-zoom coastal bays feather smoothly across the SDF ramp",
  );
  assert.match(
    globeWgslRaw,
    /let\s+coastalHomogenizeGate\s*=\s*max\(/,
    "GlobeTerrain.wgsl must gate inFlightDepthColumn and oceanColumnHomogenize via coastalHomogenizeGate to preserve coastal reef imagery",
  );
  assert.match(
    globeWgslRaw,
    /let\s+riverAltitudeFade\s*=\s*select\(/,
    "GlobeTerrain.wgsl must attenuate inland river centerlines (hydroTypeCode == 9u) with altitude via riverAltitudeFade",
  );
});
