// @purpose Pins the composite water classification provider: tile composition, copy-on-write region and bathymetry application, cache invalidation and bounds, and the scene-side water-mask hand-off in GlobeSurfaceTile.
// @status ACTIVE

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import nodeTest from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";

enableEngineTsResolution();

const {
  default: LakeWaterClassificationProvider,
  CompositeWaterClassificationProvider,
  GlobalCoastlineWaterClassificationProvider,
} = await import("../../packages/engine/Source/Scene/WaterClassificationProvider.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const COAST_ASSET = path.resolve(
  here,
  "../../packages/engine/Source/Assets/WaterMask/ne50mCoastlines.bin",
);
const LAKE_ASSET = path.resolve(
  here,
  "../../packages/engine/Source/Assets/WaterMask/ne10mLakes.bin",
);
const RAD = Math.PI / 180.0;

// GlobeSurfaceTile statically reaches Renderer/ShaderSource.js, which imports these
// shader modules; the shader build writes them and a fresh checkout has none, so on
// that tree the import is ERR_MODULE_NOT_FOUND. Every test that needs GlobeSurfaceTile
// is skipped there with this reason instead of failing the whole file at import.
const GENERATED_ENGINE_INPUTS = [
  "Shaders/Builtin/CzmBuiltins.js",
  "Shaders/BufferPolylineMaterialVS.js",
  "Shaders/BufferPolylineMaterialFS.js",
  "Shaders/PolylineCommon.js",
  "Shaders/BufferPolygonMaterialVS.js",
  "Shaders/BufferPolygonMaterialFS.js",
];

function missingGeneratedInputs(exists = fs.existsSync) {
  return GENERATED_ENGINE_INPUTS.filter(
    (rel) => !exists(path.resolve(here, "../../packages/engine/Source", rel)),
  );
}

function unbuiltSkipReason(missing) {
  return missing.length === 0
    ? false
    : `the engine shader build has not run (${missing.length} generated modules absent, first ${missing[0]}); run the build to enable it`;
}

const SKIP_UNBUILT = unbuiltSkipReason(missingGeneratedInputs());

// The tests that execute GlobeSurfaceTile, by the number their title starts with. Matching
// on the title keeps every test body, and its formatting, exactly as it was.
const NEEDS_BUILD = /^(?:9|10|11|19|19b|19c|20|20b|22c). /;
function test(name, ...rest) {
  const fn = rest.pop();
  const options = rest[0] ?? {};
  return nodeTest(
    name,
    NEEDS_BUILD.test(name) ? { ...options, skip: SKIP_UNBUILT } : options,
    fn,
  );
}

// Compares typed arrays without letting assert print a megabyte diff on failure.
function assertSameBytes(actual, expected, message = "bytes differ") {
  assert.equal(actual.length, expected.length, message + " (length)");
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) {
      assert.fail(
        `${message}: first difference at ${i} (${actual[i]} !== ${expected[i]})`,
      );
    }
  }
}

function createComposite() {
  const coastBuf = fs.readFileSync(COAST_ASSET);
  const lakeBuf = fs.readFileSync(LAKE_ASSET);
  const coastProvider = new GlobalCoastlineWaterClassificationProvider(
    coastBuf.buffer.slice(
      coastBuf.byteOffset,
      coastBuf.byteOffset + coastBuf.byteLength,
    ),
  );
  const lakeProvider = new LakeWaterClassificationProvider(
    lakeBuf.buffer.slice(
      lakeBuf.byteOffset,
      lakeBuf.byteOffset + lakeBuf.byteLength,
    ),
  );
  return new CompositeWaterClassificationProvider([
    coastProvider,
    lakeProvider,
  ]);
}

test("1. CompositeWaterClassificationProvider ready is true when both are ready", () => {
  const composite = createComposite();
  assert.equal(composite.ready, true);
  assert.equal(composite.providers.length, 2);
});

test("2. Open ocean tile fast path produces 1-byte all-water mask [255]", () => {
  const composite = createComposite();
  const rect = {
    west: -140.0 * RAD,
    south: 0.0 * RAD,
    east: -138.0 * RAD,
    north: 2.0 * RAD,
  };
  const mask = composite.generateWaterMask(rect, 256);
  assert.equal(mask.length, 1);
  assert.equal(mask[0], 255);
});

test("3. Deep continental land without lakes produces 1-byte all-land mask [0]", () => {
  const composite = createComposite();
  const rect = {
    west: -99.0 * RAD,
    south: 38.0 * RAD,
    east: -98.0 * RAD,
    north: 39.0 * RAD,
  };
  const mask = composite.generateWaterMask(rect, 256);
  assert.equal(mask.length, 1);
  assert.equal(mask[0], 0);
});

test("4. Coastal ocean tile produces 256x256 mask with land and ocean pixels", () => {
  const composite = createComposite();
  const rect = {
    west: -159.8 * RAD,
    south: 21.8 * RAD,
    east: -159.2 * RAD,
    north: 22.3 * RAD,
  };
  const mask = composite.generateWaterMask(rect, 256);
  assert.equal(mask.length, 256 * 256);
  let waterCount = 0;
  let landCount = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 255) waterCount++;
    else if (mask[i] === 0) landCount++;
  }
  assert.ok(
    waterCount > 1000,
    `Expected water pixels in Kauai: got ${waterCount}`,
  );
  assert.ok(
    landCount > 1000,
    `Expected land pixels in Kauai: got ${landCount}`,
  );
});

test("5. Inland Lake Michigan tile composites lake water onto continent land", () => {
  const composite = createComposite();
  // Lake Michigan eastern shoreline tile: lon -87.0..-86.0, lat 43.0..44.0
  const rect = {
    west: -87.0 * RAD,
    south: 43.0 * RAD,
    east: -86.0 * RAD,
    north: 44.0 * RAD,
  };
  assert.equal(composite.intersectsRectangle(rect), true);
  const mask = composite.generateWaterMask(rect, 256);
  assert.equal(mask.length, 256 * 256);
  let waterCount = 0;
  let landCount = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 255) waterCount++;
    else if (mask[i] === 0) landCount++;
  }
  assert.ok(
    waterCount > 5000,
    `Expected lake water pixels in Lake Michigan: got ${waterCount}`,
  );
  assert.ok(
    landCount > 5000,
    `Expected surrounding land pixels in Lake Michigan: got ${landCount}`,
  );
});

// ---------------------------------------------------------------------------
// Water-lane fixes DE-01 .. DE-12 (Derndingle). Each test asserts observable
// behaviour; the inertness mutants that turn them red are listed in the lane
// report. Tests 6-8 and 13-17 execute the real engine code.
// ---------------------------------------------------------------------------

const SCENE_DIR = path.resolve(here, "../../packages/engine/Source/Scene");
const RENDERER_WEBGPU_DIR = path.resolve(
  here,
  "../../packages/engine/Source/Renderer/WebGPU",
);

const { default: GlobeSurfaceTile, resolveWaterMaskForTile } = SKIP_UNBUILT
  ? {}
  : await import("../../packages/engine/Source/Scene/GlobeSurfaceTile.js");
const { default: TerrainState } =
  await import("../../packages/engine/Source/Scene/TerrainState.js");
const { default: QuadtreeTileLoadState } =
  await import("../../packages/engine/Source/Scene/QuadtreeTileLoadState.js");
const {
  getGlobalBundledBathymetryTensor,
  setGlobalBundledBathymetryTensor,
  parseBundledBathymetryTensor,
  sampleBathymetryTensor,
  encodeDepth,
  encodeJerlovType,
  encodeSubstrate,
  encodeTidalRange,
  GLOBAL_WMTS_BATHYMETRY_SURVEYS,
} = await import("../../packages/engine/Source/Scene/BathymetryTensorMap.js");
const { uploadBathymetryTensorTexture } =
  await import("../../packages/engine/Source/Renderer/WebGPU/WebGPUBathymetryTensorTexture.js");
const { CloudTiledWaterAndBathymetryProvider, MAGIC_CWT1 } =
  await import("../../packages/engine/Source/Scene/WaterClassificationProvider.js");

const KAUAI = {
  west: -159.8 * RAD,
  south: 21.8 * RAD,
  east: -159.2 * RAD,
  north: 22.3 * RAD,
};

function regionAt(lonDeg, latDeg, halfDeg = 0.04) {
  return {
    west: (lonDeg - halfDeg) * RAD,
    south: (latDeg - halfDeg) * RAD,
    east: (lonDeg + halfDeg) * RAD,
    north: (latDeg + halfDeg) * RAD,
    waterType: "lake",
    maxDepthMeters: 30,
  };
}

function texelAt(rect, mask, lonDeg, latDeg) {
  const size = Math.round(Math.sqrt(mask.length));
  const col = Math.floor(
    (((lonDeg * RAD - rect.west) / (rect.east - rect.west)) * size) | 0,
  );
  const row = Math.floor(
    (((rect.north - latDeg * RAD) / (rect.north - rect.south)) * size) | 0,
  );
  return mask[row * size + col];
}

function readCoastBuffer() {
  const buf = fs.readFileSync(COAST_ASSET);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

test("6. DE-01 a region never writes into the coastline provider's cached tile (copy-on-write), and removing it restores the water", () => {
  const coast = new GlobalCoastlineWaterClassificationProvider(
    readCoastBuffer(),
  );
  const coastMask = coast.generateWaterMask(KAUAI, 256);
  assert.equal(coastMask.length, 256 * 256);
  const pristine = coastMask.slice();

  // Land texel in the middle of Kauai.
  assert.equal(texelAt(KAUAI, pristine, -159.5, 22.05), 0);
  const regions = { _regions: [regionAt(-159.5, 22.05)], version: 1 };
  const composite = new CompositeWaterClassificationProvider([coast], {
    waterRegions: regions,
  });
  const withRegion = composite.generateWaterMask(KAUAI, 256);

  assert.ok(withRegion !== coastMask, "must not alias the input");
  assertSameBytes(
    coastMask,
    pristine,
    "the coastline provider's cached mask must be byte-identical",
  );
  assert.ok(
    coastMask._rgbaHydroData === undefined,
    "coastMask._rgbaHydroData must be undefined",
  );
  assert.equal(
    texelAt(KAUAI, withRegion, -159.5, 22.05),
    255,
    "the region must be painted into the composite's own copy",
  );

  // Remove the region: the same tile now reproduces the untouched coast mask.
  regions._regions.length = 0;
  regions.version = 2;
  const without = composite.generateWaterMask(KAUAI, 256);
  assertSameBytes(without, pristine);
  assert.ok(
    without._rgbaHydroData === undefined,
    "without._rgbaHydroData must be undefined",
  );
  assert.equal(texelAt(KAUAI, without, -159.5, 22.05), 0);
});

test("7. DE-01 a caller's terrain mask (and its hydro data) is never mutated by augmentWaterMask", () => {
  const terrainMask = new Uint8Array(256 * 256);
  terrainMask.fill(255, 0, 256 * 128);
  const prevRgba = new Uint8Array(256 * 256 * 4).fill(7);
  terrainMask._rgbaHydroData = prevRgba;
  const maskSnapshot = terrainMask.slice();
  const rgbaSnapshot = prevRgba.slice();

  const composite = new CompositeWaterClassificationProvider([], {
    waterRegions: { _regions: [regionAt(-159.5, 22.05, 0.2)], version: 1 },
  });
  const out = composite.augmentWaterMask(terrainMask, KAUAI, 256);

  assert.ok(out, "a region overlapping the tile must produce a mask");
  assert.ok(out !== terrainMask, "must be a distinct object");
  assertSameBytes(terrainMask, maskSnapshot);
  assert.ok(
    terrainMask._rgbaHydroData === prevRgba,
    "must be the identical object",
  );
  assertSameBytes(prevRgba, rgbaSnapshot);
  assert.ok(out._rgbaHydroData !== prevRgba, "must be a distinct object");
  assert.ok(
    out.some((v, i) => v !== terrainMask[i]),
    "the region must change the composite's own copy",
  );
});

test("8. DE-02 the regions signature follows the collection's version, and without one sees an edit anywhere in the list", () => {
  const coast = new GlobalCoastlineWaterClassificationProvider(
    readCoastBuffer(),
  );
  const make = (extra) => ({
    _regions: [
      regionAt(-159.62, 22.1),
      regionAt(-159.5, 22.05),
      regionAt(-159.38, 22.0),
    ],
    ...extra,
  });

  // (a) versioned: bumping the version alone invalidates the cache ...
  const versioned = make({ version: 1 });
  const composite = new CompositeWaterClassificationProvider([coast], {
    waterRegions: versioned,
  });
  const first = composite.generateWaterMask(KAUAI, 256);
  assert.ok(
    composite.generateWaterMask(KAUAI, 256) === first,
    "must be the identical object",
  );
  versioned.version = 2;
  const second = composite.generateWaterMask(KAUAI, 256);
  assert.ok(second !== first, "a version bump must rebuild the tile");

  // ... and an in-place edit of the MIDDLE region is seen once the version moves.
  assert.equal(texelAt(KAUAI, second, -159.5, 22.05), 255);
  versioned._regions[1] = regionAt(-159.3, 21.95);
  versioned.version = 3;
  const third = composite.generateWaterMask(KAUAI, 256);
  assert.equal(texelAt(KAUAI, third, -159.3, 21.95), 255);
  assert.equal(texelAt(KAUAI, third, -159.5, 22.05), 0);

  // (b) unversioned: the signature covers every region, not just first and last.
  const plain = make({});
  const composite2 = new CompositeWaterClassificationProvider([coast], {
    waterRegions: plain,
  });
  composite2.generateWaterMask(KAUAI, 256);
  plain._regions[1] = regionAt(-159.3, 21.95);
  const edited = composite2.generateWaterMask(KAUAI, 256);
  assert.equal(texelAt(KAUAI, edited, -159.3, 21.95), 255);
  assert.equal(texelAt(KAUAI, edited, -159.5, 22.05), 0);
});

function makeSettledTile(provider, countRef) {
  const surfaceTile = new GlobeSurfaceTile();
  surfaceTile.terrainState = TerrainState.READY;
  surfaceTile.terrainData = {
    waterMask: undefined,
    wasCreatedByUpsampling: () => false,
  };
  surfaceTile._findAncestorTileWithTerrainData = () => {
    countRef.calls++;
    return undefined;
  };
  const tile = {
    state: QuadtreeTileLoadState.DONE,
    data: surfaceTile,
    rectangle: KAUAI,
    x: 0,
    y: 0,
    level: 5,
    parent: undefined,
    renderable: true,
    upsampledFromParent: false,
    _loadedCallbacks: {},
  };
  const quadtree = {
    tileProvider: { waterClassificationProvider: provider },
  };
  const terrainProvider = { hasWaterMask: false };
  return { tile, surfaceTile, quadtree, terrainProvider };
}

test("9. DE-03 a settled tile with a lake-style provider stops re-entering the water block (no per-frame ancestor search)", () => {
  // Lake/River style: no generateWaterMask, and this tile touches no water.
  const provider = {
    ready: true,
    intersectsRectangle: () => false,
    augmentWaterMask: () => undefined,
  };
  const counter = { calls: 0 };
  const { tile, quadtree, terrainProvider } = makeSettledTile(
    provider,
    counter,
  );
  const step = () =>
    GlobeSurfaceTile.processStateMachine(
      tile,
      {},
      terrainProvider,
      undefined,
      undefined,
      quadtree,
      [],
      true,
    );

  step(); // first frame may search once
  counter.calls = 0;
  for (let frame = 0; frame < 300; frame++) {
    step();
  }
  assert.equal(counter.calls, 0, "steady-state frames must not search");

  // A swapped provider is still picked up.
  const other = { ...provider };
  quadtree.tileProvider.waterClassificationProvider = other;
  step();
  assert.ok(counter.calls > 0, "a new provider must re-evaluate the tile");
});

test("10. DE-04 generating a tile water mask never writes to the shared terrain data", () => {
  const writes = [];
  const terrainData = new Proxy(
    { waterMask: undefined },
    {
      set(target, key, value) {
        writes.push(String(key));
        target[key] = value;
        return true;
      },
      defineProperty(target, key, descriptor) {
        writes.push(String(key));
        return Reflect.defineProperty(target, key, descriptor);
      },
    },
  );
  const surfaceTile = new GlobeSurfaceTile();
  surfaceTile.terrainData = terrainData;
  const generated = new Uint8Array([255]);
  let generateCalls = 0;
  const provider = {
    ready: true,
    generateWaterMask: () => {
      generateCalls++;
      return generated;
    },
    intersectsRectangle: () => true,
    augmentWaterMask: () => undefined,
  };

  const mask = resolveWaterMaskForTile(surfaceTile, KAUAI, provider);
  assert.ok(mask === generated, "must be the identical object");
  assert.deepEqual(writes, [], "terrainData must not be written");
  assert.equal(terrainData.waterMask, undefined);
  assert.equal(terrainData._generatedWaterMask, undefined);
  assert.ok(
    surfaceTile._generatedWaterMask === generated,
    "must be the identical object",
  );

  // A second evaluation (provider upgrade) regenerates instead of reusing a
  // stale mask left behind on the terrain data.
  resolveWaterMaskForTile(surfaceTile, KAUAI, provider);
  assert.equal(generateCalls, 2);

  // Provider off: the terrain's own (absent) mask is what remains.
  assert.equal(
    resolveWaterMaskForTile(surfaceTile, KAUAI, undefined),
    undefined,
  );
  surfaceTile.freeResources();
  assert.equal(surfaceTile._generatedWaterMask, undefined);
});

test("11. DE-12 releasing a tile's water-mask texture destroys it only on the last reference", () => {
  let destroyed = 0;
  let cleaned = 0;
  const shared = {
    referenceCount: 2,
    destroy: () => destroyed++,
    _webgpuTextureCacheCleanup: () => cleaned++,
  };
  const a = new GlobeSurfaceTile();
  const b = new GlobeSurfaceTile();
  a.waterMaskTexture = shared;
  b.waterMaskTexture = shared;
  a.freeResources();
  assert.equal(a.waterMaskTexture, undefined);
  assert.equal(destroyed, 0);
  assert.equal(shared.referenceCount, 1);
  b.freeResources();
  assert.equal(destroyed, 1);
  assert.equal(cleaned, 1);
});

test("12. DE-06 uploading a replacement bathymetry tensor destroys the texture it replaces", () => {
  const created = [];
  const device = {
    createTexture: (desc) => {
      const texture = { ...desc, destroyed: false };
      texture.destroy = () => {
        texture.destroyed = true;
      };
      created.push(texture);
      return texture;
    },
    createSampler: (desc) => ({ ...desc }),
    queue: { writeTexture: () => {} },
  };
  const tensorOf = (w, h) => ({
    width: w,
    height: h,
    bathymetryBytes: new Uint8Array(w * h * 4),
  });
  const first = uploadBathymetryTensorTexture(device, tensorOf(8, 4));
  assert.equal(created.length, 1);
  assert.equal(created[0].destroyed, false);
  // The default (cached) lookup returns the same handle and creates nothing.
  assert.ok(
    uploadBathymetryTensorTexture(device) === first,
    "must be the identical object",
  );
  assert.equal(created.length, 1);

  const second = uploadBathymetryTensorTexture(device, tensorOf(16, 8));
  assert.equal(created.length, 2);
  assert.equal(created[0].destroyed, true, "the replaced texture is destroyed");
  assert.equal(created[1].destroyed, false);
  assert.ok(second !== first, "must be a distinct object");
  assert.equal(second.width, 16);
  assert.ok(
    uploadBathymetryTensorTexture(device) === second,
    "must be the identical object",
  );
  assert.equal(
    fs.existsSync(
      path.join(RENDERER_WEBGPU_DIR, "WebGPUBathymetryTensorTexture.ts"),
    ),
    true,
  );
  assert.equal(
    /GPUTextureUsage|createTexture/.test(
      fs.readFileSync(path.join(SCENE_DIR, "BathymetryTensorMap.ts"), "utf8"),
    ),
    false,
    "Scene code must not contain WebGPU device code",
  );
});

function importProbe(moduleFile) {
  const resolverUrl = pathToFileURL(
    path.join(here, "lib/engine-ts-resolver.mjs"),
  ).href;
  const moduleUrl = pathToFileURL(moduleFile).href;
  const code = `
    import { enableEngineTsResolution } from ${JSON.stringify(resolverUrl)};
    enableEngineTsResolution();
    let calls = 0;
    for (const k of ["sin","cos","sqrt","exp","log","pow","atan2","hypot","tan","asin","acos","atan","cbrt"]) {
      const original = Math[k];
      Math[k] = function (...a) { calls++; return original.apply(Math, a); };
    }
    const m = await import(${JSON.stringify(moduleUrl)});
    console.log(JSON.stringify({
      calls,
      sdf: m.getCoastalSdfScratchSize?.(),
      lake: m.getPaddedLakeScratchBytes?.(),
    }));
  `;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout.trim().split("\n").pop());
}

test("13. DE-07 importing the water modules runs no warm-up and allocates no SDF or padded-lake scratch", () => {
  const bathy = importProbe(path.join(SCENE_DIR, "BathymetryTensorMap.ts"));
  assert.ok(
    bathy.calls < 20,
    `BathymetryTensorMap import ran ${bathy.calls} transcendental calls (warm-up loop?)`,
  );
  const coast = importProbe(
    path.join(SCENE_DIR, "GlobalCoastlineWaterClassificationProvider.ts"),
  );
  assert.equal(coast.sdf, 0, "SDF scratch must be empty until first use");
  assert.ok(coast.calls < 20, `coast import ran ${coast.calls} math calls`);
  const water = importProbe(
    path.join(SCENE_DIR, "WaterClassificationProvider.ts"),
  );
  assert.equal(water.lake, 0, "padded lake scratch must be empty until used");
  assert.ok(water.calls < 20, `water import ran ${water.calls} math calls`);
});

test("14. DE-08 parsing the bundled bathymetry tensor does not register a global", () => {
  setGlobalBundledBathymetryTensor(undefined);
  const buf = fs.readFileSync(
    path.resolve(
      here,
      "../../packages/engine/Source/Assets/WaterMask/globalBathymetryTensor.bin",
    ),
  );
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const a = parseBundledBathymetryTensor(ab);
  const b = parseBundledBathymetryTensor(ab);
  assert.ok(a !== b, "must be a distinct object");
  assert.ok(
    getGlobalBundledBathymetryTensor() === undefined,
    "getGlobalBundledBathymetryTensor() must be undefined",
  );
  setGlobalBundledBathymetryTensor(a);
  assert.ok(
    getGlobalBundledBathymetryTensor() === a,
    "must be the identical object",
  );
  parseBundledBathymetryTensor(ab);
  assert.ok(
    getGlobalBundledBathymetryTensor() === a,
    "must be the identical object",
  );
  setGlobalBundledBathymetryTensor(undefined);
});

test("15. DE-12 sampling blends depth and tide but never invents a category between two texels", () => {
  const reef = encodeSubstrate(2);
  const abyssal = encodeSubstrate(4);
  const bytes = new Uint8Array([
    encodeDepth(10),
    encodeJerlovType(1),
    reef,
    encodeTidalRange(0),
    encodeDepth(4000),
    encodeJerlovType(9),
    abyssal,
    encodeTidalRange(8),
  ]);
  const tensor = { width: 2, height: 1, bathymetryBytes: bytes };
  const seen = new Set();
  const jerlov = new Set();
  let midDepth = 0;
  for (let i = 0; i <= 40; i++) {
    const lon = -Math.PI + (i / 40) * 2 * Math.PI;
    const s = sampleBathymetryTensor(tensor, lon, 0);
    seen.add(s.substrateType);
    jerlov.add(s.jerlovType);
    if (i === 20) {
      midDepth = s.depthMeters;
    }
  }
  assert.deepEqual([...seen].sort(), [2, 4], "no blended rock class (3)");
  assert.deepEqual([...jerlov].sort(), [1, 9], "no blended Jerlov class");
  assert.ok(midDepth > 100 && midDepth < 3900, "depth stays interpolated");
});

test("16. DE-09/DE-10 the bathymetry prior is labelled procedural and the unconsumed providers are experimental", () => {
  const bathySrc = fs.readFileSync(
    path.join(SCENE_DIR, "BathymetryTensorMap.ts"),
    "utf8",
  );
  const wcpSrc = fs.readFileSync(
    path.join(SCENE_DIR, "WaterClassificationProvider.ts"),
    "utf8",
  );
  // Text tripwires (the labels are documentation, not behaviour).
  assert.equal(/authoritative/i.test(bathySrc), false);
  assert.match(bathySrc, /PROCEDURAL depth and optics prior, not survey data/);
  const catalogDoc = bathySrc.slice(
    bathySrc.lastIndexOf(
      "/**",
      bathySrc.indexOf("export const GLOBAL_WMTS_BATHYMETRY_SURVEYS"),
    ),
    bathySrc.indexOf("export const GLOBAL_WMTS_BATHYMETRY_SURVEYS"),
  );
  assert.match(catalogDoc, /SYNTHETIC/);
  assert.match(catalogDoc, /@experimental/);
  for (const name of [
    "PMTilesWaterAndBathymetryProvider",
    "CloudTiledWaterAndBathymetryProvider",
  ]) {
    const at = wcpSrc.indexOf(`export class ${name}`);
    const doc = wcpSrc.slice(wcpSrc.lastIndexOf("/**", at), at);
    assert.match(doc, /@experimental/, `${name} must be @experimental`);
    assert.match(doc, /No runtime consumer/, `${name} must name the gap`);
  }
  assert.ok(GLOBAL_WMTS_BATHYMETRY_SURVEYS.length > 0);
});

test("17. DE-12 the composite tile cache is bounded by bytes, and a malformed CWT1 directory header is refused", () => {
  // 600 distinct 256x256 tiles, each with a 256 KiB rgba companion (320 KiB):
  // the count bound alone (1024) would hold ~190 MB.
  const sub = {
    ready: true,
    intersectsRectangle: () => true,
    generateWaterMask: () => new Uint8Array(256 * 256).fill(255),
    augmentWaterMask: () => undefined,
  };
  const composite = new CompositeWaterClassificationProvider([sub], {
    waterRegions: { _regions: [regionAt(0, 0, 90)], version: 1 },
  });
  for (let i = 0; i < 600; i++) {
    const west = i * 1e-3;
    composite.generateWaterMask(
      { west, south: 0, east: west + 5e-4, north: 5e-4 },
      256,
    );
  }
  assert.ok(
    composite.cachedTileBytes <= 64 * 1024 * 1024,
    `cache holds ${composite.cachedTileBytes} bytes`,
  );
  assert.ok(composite.cachedTileCount < 600, "old tiles must be evicted");
  assert.ok(composite.cachedTileCount > 0);

  const header = (cols, rows, total) => {
    const ab = new ArrayBuffer(16 + 16 * 4);
    const view = new DataView(ab);
    view.setUint32(0, MAGIC_CWT1, true);
    view.setUint16(4, cols, true);
    view.setUint16(6, rows, true);
    view.setUint32(8, 16, true);
    view.setUint32(12, total, true);
    return ab;
  };
  assert.throws(
    () =>
      new CloudTiledWaterAndBathymetryProvider({
        directoryOrArchiveBuffer: header(2, 2, 5),
      }),
    /invalid directory header/,
  );
  assert.throws(
    () =>
      new CloudTiledWaterAndBathymetryProvider({
        directoryOrArchiveBuffer: header(0, 2, 4),
      }),
    /invalid directory header/,
  );
  const ok = new CloudTiledWaterAndBathymetryProvider({
    directoryOrArchiveBuffer: header(2, 2, 4),
  });
  assert.equal(ok.ready, true);
});

// ---------------------------------------------------------------------------
// DE-13 (repair round 2, review B2): `globe.lakeWaterMask` keeps painting what
// it shipped with. The LWM2 asset added Natural Earth playas (type 5) and
// widened reef strips (type 8); until the maintainer rules on MQ-10 the lake
// provider skips both. Each case takes a polygon from the shipped asset, and its
// control is the same bytes with only that polygon's type byte set to 1 (lake):
// the control must paint water, so the type code is the only thing keeping the
// excluded tile dry.
// ---------------------------------------------------------------------------

const EXCLUDED_LAKE_TYPES = new Set([5, 8]);

/** Every polygon header of the shipped LWM2 lake asset, parsed to its end of file. */
function lakeAssetPolygons(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint32(0, true), 0x324d574c, "the lake asset is LWM2");
  const count = view.getUint32(4, true);
  const polygons = [];
  let o = 8;
  for (let p = 0; p < count; p++) {
    const polygon = {
      typeByteOffset: o + 16,
      west: view.getFloat32(o, true),
      south: view.getFloat32(o + 4, true),
      east: view.getFloat32(o + 8, true),
      north: view.getFloat32(o + 12, true),
      type: view.getUint8(o + 16),
    };
    const rings = view.getUint16(o + 18, true);
    o += 20;
    for (let r = 0; r < rings; r++) {
      o += 4 + view.getUint32(o, true) * 4;
    }
    polygons.push(polygon);
  }
  assert.equal(o, bytes.byteLength, "the lake asset parses to its end");
  return polygons;
}

const boxesMeet = (a, b) =>
  a.west <= b.east &&
  a.east >= b.west &&
  a.south <= b.north &&
  a.north >= b.south;

function lakeProviderOver(bytes) {
  const copy = new Uint8Array(bytes);
  return new LakeWaterClassificationProvider(copy.buffer);
}

function waterTexels(mask) {
  let n = 0;
  for (let i = 0; mask !== undefined && i < mask.length; i++) {
    if (mask[i] > 0) {
      n++;
    }
  }
  return n;
}

/**
 * The first polygon of `type` whose box meets no kept polygon's box, and which
 * paints water once its type byte reads 1: a tile over its box is a tile only
 * that polygon can wet.
 */
function isolatedTileOfType(bytes, polygons, type) {
  const kept = polygons.filter((p) => !EXCLUDED_LAKE_TYPES.has(p.type));
  for (const polygon of polygons) {
    if (polygon.type !== type || kept.some((k) => boxesMeet(k, polygon))) {
      continue;
    }
    const rect = {
      west: polygon.west,
      south: polygon.south,
      east: polygon.east,
      north: polygon.north,
    };
    const asLake = new Uint8Array(bytes);
    asLake[polygon.typeByteOffset] = 1;
    const control = lakeProviderOver(asLake).augmentWaterMask(
      new Uint8Array([0]),
      rect,
      256,
    );
    if (waterTexels(control) > 0) {
      return { polygon, rect, controlTexels: waterTexels(control) };
    }
  }
  return undefined;
}

const lakeBytes = new Uint8Array(fs.readFileSync(LAKE_ASSET));
const lakePolygons = lakeAssetPolygons(lakeBytes);

for (const [type, label] of [
  [5, "playa"],
  [8, "reef"],
]) {
  test(`18${type === 5 ? "a" : "b"}. DE-13 a ${label} tile (type ${type}) from the shipped asset stays dry under lakeWaterMask; the same polygon typed as a lake paints water`, () => {
    const found = isolatedTileOfType(lakeBytes, lakePolygons, type);
    assert.ok(
      found !== undefined,
      `the shipped asset must hold an isolated ${label} polygon that paints when typed as a lake`,
    );
    const provider = lakeProviderOver(lakeBytes);
    assert.equal(
      provider.intersectsRectangle(found.rect),
      false,
      `a tile over only a ${label} polygon must not claim lake water`,
    );
    const mask = provider.augmentWaterMask(
      new Uint8Array([0]),
      found.rect,
      256,
    );
    assert.equal(
      waterTexels(mask),
      0,
      `the ${label} tile painted ${waterTexels(mask)} texels; its lake-typed control paints ${found.controlTexels}`,
    );
  });
}

test("18c. DE-13 the lake provider keeps every polygon except types 5 and 8, and the asset still carries them", () => {
  const counts = new Map();
  for (const p of lakePolygons) {
    counts.set(p.type, (counts.get(p.type) ?? 0) + 1);
  }
  assert.ok((counts.get(5) ?? 0) > 0, "the asset carries playa polygons");
  assert.ok((counts.get(8) ?? 0) > 0, "the asset carries reef polygons");
  const provider = lakeProviderOver(lakeBytes);
  assert.equal(
    provider._polygons.length,
    lakePolygons.length - (counts.get(5) ?? 0) - (counts.get(8) ?? 0),
  );
  assert.ok(
    provider._polygons.every((p) => !EXCLUDED_LAKE_TYPES.has(p.waterTypeCode)),
    "no playa or reef polygon may reach the rasteriser",
  );
});

// ---------------------------------------------------------------------------
// P3-B1 (round 4, fix (c)) and P3-N1: what a tile RECEIVES under a mirrored lake
// layer over a terrain mask, executed on the real `processStateMachine`.
// ---------------------------------------------------------------------------

const { default: Texture } =
  await import("../../packages/engine/Source/Renderer/Texture.js");
const { importMutated } = await import("./lib/import-mutated.mjs");
const GLOBE_SURFACE_TILE = path.resolve(SCENE_DIR, "GlobeSurfaceTile.js");

// Lake Salvador and Barataria Bay, Louisiana: the review's probe tile (pass 3 B1).
const SALVADOR = {
  west: -90.3 * RAD,
  south: 29.3 * RAD,
  east: -89.9 * RAD,
  north: 29.8 * RAD,
};
// Its real ancestor: the tile is the ancestor's south-east quadrant.
const SALVADOR_ANCESTOR = {
  west: -90.7 * RAD,
  south: 29.3 * RAD,
  east: -89.9 * RAD,
  north: 30.3 * RAD,
};
const SEA_EDGE_LAT = 29.55; // the ancestor's terrain mask is sea south of this

/** A 256² terrain mask, north row first, sea (255) south of SEA_EDGE_LAT. */
function ancestorSeaMask() {
  const n = 256;
  const mask = new Uint8Array(n * n);
  for (let row = 0; row < n; row++) {
    const lat =
      SALVADOR_ANCESTOR.north / RAD -
      ((row + 0.5) / n) *
        ((SALVADOR_ANCESTOR.north - SALVADOR_ANCESTOR.south) / RAD);
    if (lat < SEA_EDGE_LAT) {
      mask.fill(255, row * n, (row + 1) * n);
    }
  }
  return mask;
}

/**
 * Drives `processStateMachine` (of `module`, the real file or a mutated copy)
 * for one tile with a terrain mask (`terrainProvider.hasWaterMask`) and the lake
 * provider mirrored the way `Globe.beginFrame` mirrors it, and returns what the
 * tile received. `Texture.create` is replaced for the call only, so the bytes
 * handed to the GPU are what the test reads.
 */
function receive(module, { provider, rectangle, terrainData, parent }) {
  const created = [];
  const realCreate = Texture.create;
  Texture.create = (options) => {
    const texture = {
      referenceCount: 0,
      bytes: options.source?.arrayBufferView,
      width: options.source?.width,
      destroy() {},
    };
    created.push(texture);
    return texture;
  };
  const hadImageBitmap = "ImageBitmap" in globalThis;
  if (!hadImageBitmap) {
    globalThis.ImageBitmap = class ImageBitmap {};
  }
  try {
    const SurfaceTile = module.default;
    const surfaceTile = new SurfaceTile();
    surfaceTile.terrainState = TerrainState.READY;
    surfaceTile.terrainData = terrainData;
    const tile = {
      state: QuadtreeTileLoadState.LOADING,
      data: surfaceTile,
      rectangle,
      x: 0,
      y: 0,
      level: 14,
      parent,
      renderable: false,
      upsampledFromParent: true,
      _loadedCallbacks: {},
    };
    const context = {
      cache: {
        tile_waterMaskData: {
          allWaterTexture: { referenceCount: 1, allWater: true },
          sampler: {},
        },
      },
    };
    const quadtree = {
      tileProvider: {
        hasWaterMask: true,
        waterClassificationProvider: provider,
      },
    };
    module.default.processStateMachine(
      tile,
      { context },
      { hasWaterMask: true },
      undefined,
      undefined,
      quadtree,
      [],
      true,
    );
    return { surfaceTile, created };
  } finally {
    Texture.create = realCreate;
    if (!hadImageBitmap) {
      delete globalThis.ImageBitmap;
    }
  }
}

/** The upsampled Salvador tile under its real ancestor, with the shipped lakes. */
function salvadorCase(module) {
  const ancestorTexture = { referenceCount: 1, ancestor: true };
  const parent = {
    rectangle: SALVADOR_ANCESTOR,
    parent: undefined,
    data: {
      terrainData: {
        waterMask: ancestorSeaMask(),
        wasCreatedByUpsampling: () => false,
      },
      waterMaskTexture: ancestorTexture,
    },
  };
  const result = receive(module, {
    provider: realLakeProvider(),
    rectangle: SALVADOR,
    terrainData: { waterMask: undefined, wasCreatedByUpsampling: () => true },
    parent,
  });
  return { ...result, ancestorTexture };
}

let _realLake;
function realLakeProvider() {
  if (!_realLake) {
    const bytes = fs.readFileSync(LAKE_ASSET);
    _realLake = new LakeWaterClassificationProvider(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
  }
  return _realLake;
}

/**
 * The B1 law on what the tile received: the ancestor's sea is kept and the lake
 * is painted. Throws with the first finding, so a mutant can be run through it.
 */
function assertSeaKeptAndLakePainted({
  surfaceTile,
  created,
  ancestorTexture,
}) {
  assert.notEqual(
    surfaceTile.waterMaskTexture,
    ancestorTexture,
    "the ancestor's texture has no lakes in it; the tile needs its own mask",
  );
  assert.equal(created.length, 1, "one texture for the tile");
  const bytes = created[0].bytes;
  const size = created[0].width;
  assert.equal(bytes.length, size * size);
  // Independent references: the lakes the provider paints on an all-land
  // tile, and where the ancestor's terrain mask says sea (by latitude).
  const lakesOnly = realLakeProvider().augmentWaterMask(
    new Uint8Array([0]),
    SALVADOR,
    size,
  );
  assert.ok(lakesOnly && lakesOnly.length === size * size, "lakes intersect");
  const dLat = (SALVADOR.north - SALVADOR.south) / RAD / size;
  let seaTexels = 0;
  let seaKept = 0;
  let lakeTexels = 0;
  let lakeKept = 0;
  let lakeOnLand = 0;
  for (let row = 0; row < size; row++) {
    const lat = SALVADOR.north / RAD - (row + 0.5) * dLat;
    // One ancestor texel (0.0039 degrees) of margin either side of the edge.
    const sea = lat < SEA_EDGE_LAT - 0.004;
    const land = lat > SEA_EDGE_LAT + 0.004;
    for (let column = 0; column < size; column++) {
      const i = row * size + column;
      if (sea) {
        seaTexels++;
        seaKept += bytes[i] === 255 ? 1 : 0;
      }
      if (lakesOnly[i] >= 128) {
        lakeTexels++;
        lakeKept += bytes[i] >= lakesOnly[i] ? 1 : 0;
        lakeOnLand += land ? 1 : 0;
      }
    }
  }
  assert.ok(seaTexels > size * 10, "the tile has ancestor sea (control)");
  assert.equal(seaKept, seaTexels, "every ancestor sea texel stays water");
  assert.ok(lakeOnLand > 50, "a lake sits on the ancestor's land (control)");
  assert.equal(lakeKept, lakeTexels, "every lake texel is painted");
}

test("19. P3-B1 an upsampled tile touching a lake keeps the terrain's sea water from its ancestor and gains the lake", () => {
  const received = salvadorCase({ default: GlobeSurfaceTile });
  assertSeaKeptAndLakePainted(received);
  const t = received.surfaceTile.waterMaskTranslationAndScale;
  assert.deepEqual(
    [t.x, t.y, t.z, t.w],
    [0, 0, 1, 1],
    "the mask is this tile's",
  );
});

test("19b. P3-B1 (mutants) the base adoption (Q4) and a lakes-only base are both DETECTED", async () => {
  // Q4: the intersecting-layer arm made unreachable; the tile adopts the
  // ancestor's texture as base did and the lake is lost.
  const q4 = await importMutated(GLOBE_SURFACE_TILE, [
    [
      "      !providerGenerates &&\n      waterClassificationProvider.intersectsRectangle(tile.rectangle)",
      "      !providerGenerates &&\n      (false && waterClassificationProvider.intersectsRectangle(tile.rectangle))",
    ],
  ]);
  assert.throws(() => assertSeaKeptAndLakePainted(salvadorCase(q4)));
  // The ancestor base dropped: the round-3 lakes-only mask; the sea is lost.
  const lakesOnly = await importMutated(GLOBE_SURFACE_TILE, [
    [
      "    waterMask = upsampleAncestorWaterMask(\n      ancestorWaterMask.mask,",
      "    waterMask = new Uint8Array([0]) ?? upsampleAncestorWaterMask(\n      ancestorWaterMask.mask,",
    ],
  ]);
  assert.throws(
    () => assertSeaKeptAndLakePainted(salvadorCase(lakesOnly)),
    /every ancestor sea texel stays water/,
  );
});

test("19c. P3-B1 an upsampled tile no layer touches adopts its ancestor's texture, as base did", () => {
  const ancestorTexture = { referenceCount: 1, ancestor: true };
  const parent = {
    rectangle: SALVADOR_ANCESTOR,
    parent: undefined,
    data: {
      terrainData: {
        waterMask: ancestorSeaMask(),
        wasCreatedByUpsampling: () => false,
      },
      waterMaskTexture: ancestorTexture,
    },
  };
  const { surfaceTile, created } = receive(
    { default: GlobeSurfaceTile },
    {
      provider: {
        ready: true,
        intersectsRectangle: () => false,
        augmentWaterMask: () => undefined,
      },
      rectangle: SALVADOR,
      terrainData: {
        waterMask: undefined,
        wasCreatedByUpsampling: () => true,
      },
      parent,
    },
  );
  assert.equal(surfaceTile.waterMaskTexture, ancestorTexture);
  assert.equal(ancestorTexture.referenceCount, 2);
  assert.equal(created.length, 0);
});

/** The P3-N1 law: an all-land one-byte tile under a mirrored layer gets no texture. */
function assertAllLandTileHasNoTexture(module) {
  const { surfaceTile, created } = receive(module, {
    provider: {
      ready: true,
      intersectsRectangle: () => false,
      augmentWaterMask: () => undefined,
    },
    rectangle: SALVADOR,
    terrainData: {
      waterMask: new Uint8Array([0]),
      wasCreatedByUpsampling: () => false,
    },
    parent: undefined,
  });
  assert.equal(created.length, 0, "no texture is created");
  assert.equal(
    surfaceTile.waterMaskTexture,
    undefined,
    "an all-land tile keeps the base path: no texture, so no reflective-ocean variant",
  );
}

test("20. P3-N1 an all-land tile under a mirrored layer gets no water-mask texture, as at base", () => {
  assertAllLandTileHasNoTexture({ default: GlobeSurfaceTile });
});

test("20b. P3-N1 (mutant Q3-inverse) a texture for every all-land tile with a provider is DETECTED", async () => {
  const mutant = await importMutated(GLOBE_SURFACE_TILE, [
    [
      "    if (waterMask[0] !== 0) {\n      texture = waterMaskData.allWaterTexture;",
      "    if (waterMask[0] !== 0 || defined(waterClassificationProvider)) {\n      texture = waterMaskData.allWaterTexture;",
    ],
  ]);
  assert.throws(() => assertAllLandTileHasNoTexture(mutant));
});

// ───── water round 5, FND-1: the Great Lakes shore on the shipped data ─────
//
// The Edge job's great-lakes cell (lakeWaterMask + globalWaterMask, 900 km)
// drew a serrated lake shore on both renderers. This is the level-6 tile of
// Lake Michigan's west shore that camera loads (128 texels, about 3 screen
// pixels per texel there), built from the shipped coastline and lake assets.

/** RMS of the field's discrete Laplacian over the shore band (texels 64..191). */
function shoreRoughness(mask, size) {
  let sum = 0;
  let count = 0;
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const v = mask[y * size + x];
      if (v < 64 || v > 191) {
        continue;
      }
      const lap =
        mask[y * size + x - 1] +
        mask[y * size + x + 1] +
        mask[(y - 1) * size + x] +
        mask[(y + 1) * size + x] -
        4 * v;
      sum += lap * lap;
      count++;
    }
  }
  return { rms: Math.sqrt(sum / Math.max(count, 1)), count };
}

const LAKE_MICHIGAN_TILE = {
  west: -87.1875 * RAD,
  south: 42.1875 * RAD,
  east: -84.375 * RAD,
  north: 45.0 * RAD,
};

test("21. FND-1 the Lake Michigan tile's shore band is smooth, not a texel staircase, and its texel contract holds", () => {
  const composite = createComposite();
  const mask = composite.generateWaterMask(LAKE_MICHIGAN_TILE, 128);
  assert.equal(mask.length, 128 * 128);
  const { rms, count } = shoreRoughness(mask, 128);
  assert.ok(count > 400, `shore band texels: ${count}`);
  // Measured on this tile: 5.49 with the smoothing, 16.66 without it (the
  // staircase corners of the texel-centre field).
  assert.ok(rms < 10, `shore band roughness ${rms.toFixed(2)}`);
  // The texel contract the shaders rely on: exact land and water outside the
  // band, and both present (the lake and its shore are in this tile).
  let land = 0;
  let water = 0;
  for (const v of mask) {
    land += v === 0 ? 1 : 0;
    water += v === 255 ? 1 : 0;
  }
  assert.ok(land > 1000 && water > 1000, `land ${land}, water ${water}`);
  // The RGBA payload carries the same luminance, so both renderers read the
  // same shore (WebGL uploads `mask`, WebGPU the R of `_rgbaHydroData`).
  const rgba = mask._rgbaHydroData;
  assert.ok(rgba && rgba.length === 128 * 128 * 4);
  for (let i = 0; i < 128 * 128; i++) {
    if (rgba[i * 4] !== mask[i]) {
      assert.fail(`texel ${i}: R ${rgba[i * 4]} vs luminance ${mask[i]}`);
    }
  }
});

// ───── water round 5, FND-7: every water mask texture is labelled at creation ─────
//
// The Edge job's device census (it wraps `device.createTexture`) saw no water
// owner on the AFTER WebGPU pages. A mask the coastline provider generated was
// uploaded by the WebGL compatibility stub under its generic `GLStub_Texture`
// label, and `getOrCreateWaterMaskTexture` served that native view, so no
// `Globe ...` texture was ever created for it. A mask a water provider built is
// now tagged on the scene side and given its own texture under a stable label.

const { bundle } = await import("./lib/engine-stub-bundler.mjs");

function importWaterMaskTextures(overrides = []) {
  return bundle({
    path: path.join(RENDERER_WEBGPU_DIR, "__water-mask-label-spec.ts"),
    source:
      'export { getOrCreateWaterMaskTexture } from "./WebGPUGlobeSurfaceTextures.js";',
    real: ["WebGPUGlobeSurfaceTextures.ts"],
    preseed: [path.join(RENDERER_WEBGPU_DIR, "WebGPUGlobeSurfaceTextures.ts")],
    overrides,
  });
}

/** What `getOrCreateWaterMaskTexture` creates and serves for one stub-backed mask. */
function uploadWaterMask(ns, source) {
  const created = [];
  const nativeView = { native: true };
  const device = {
    createTexture(descriptor) {
      const texture = {
        label: descriptor.label,
        format: descriptor.format,
        size: descriptor.size,
        mipLevelCount: descriptor.mipLevelCount ?? 1,
        createView: () => ({ of: descriptor.label }),
        destroy() {},
      };
      created.push(texture);
      return texture;
    },
    queue: { writeTexture() {}, copyExternalImageToTexture() {} },
  };
  const restore = [];
  for (const name of [
    "ImageBitmap",
    "HTMLCanvasElement",
    "HTMLImageElement",
    "GPUTextureUsage",
  ]) {
    if (!(name in globalThis)) {
      globalThis[name] =
        name === "GPUTextureUsage"
          ? { TEXTURE_BINDING: 4, COPY_DST: 2, RENDER_ATTACHMENT: 16 }
          : class {};
      restore.push(name);
    }
  }
  try {
    const view = ns.getOrCreateWaterMaskTexture(
      { _device: device, _waterMaskTextureCache: new Map() },
      {
        _id: 7,
        _context: { device },
        _texture: { _webgpuTexture: { texture: {}, view: nativeView } },
        _webgpuSource: source,
      },
    );
    return { view, nativeView, labels: created.map((t) => t.label), created };
  } finally {
    restore.forEach((name) => delete globalThis[name]);
  }
}

/** The label findings over one bundled module: empty when every provider mask is labelled. */
function waterMaskLabelFindings(ns) {
  const out = [];
  const r8 = uploadWaterMask(ns, {
    width: 4,
    height: 4,
    arrayBufferView: new Uint8Array(16),
    waterProviderMask: true,
  });
  if (r8.view === r8.nativeView || r8.labels[0] !== "Globe water mask wm_7") {
    out.push(`a generated r8 mask: labels ${JSON.stringify(r8.labels)}`);
  }
  const rgba = uploadWaterMask(ns, {
    width: 4,
    height: 4,
    arrayBufferView: new Uint8Array(16),
    rgbaArrayBufferView: new Uint8Array(64),
    waterProviderMask: true,
  });
  if (rgba.labels[0] !== "Globe water hydro mask wm_7") {
    out.push(`a composite mask: labels ${JSON.stringify(rgba.labels)}`);
  }
  const terrain = uploadWaterMask(ns, {
    width: 4,
    height: 4,
    arrayBufferView: new Uint8Array(16),
    waterProviderMask: false,
  });
  if (terrain.view !== terrain.nativeView || terrain.labels.length !== 0) {
    out.push(
      `a terrain's own mask left the base path: ${JSON.stringify(terrain.labels)}`,
    );
  }
  return out;
}

test("22. FND-7 a mask a water provider built gets its own texture under a stable water label at creation; a terrain's own mask keeps the base path", async () => {
  assert.deepEqual(waterMaskLabelFindings(await importWaterMaskTextures()), []);
});

test("22b. FND-7 (mutant) the provider masks served from the stub's own texture (GLStub_Texture) again is DETECTED", async () => {
  const mutant = await importWaterMaskTextures([
    {
      basename: "WebGPUGlobeSurfaceTextures.ts",
      label: "fnd7-native",
      mutate: (source) => {
        const anchor =
          "const isWaterProviderMask = texelSource?.waterProviderMask === true;";
        assert.equal(source.split(anchor).length - 1, 1, "mutation anchor");
        return source.replace(
          anchor,
          () => "const isWaterProviderMask = false;",
        );
      },
    },
  ]);
  assert.notEqual(waterMaskLabelFindings(mutant).length, 0);
});

const { webglToWebGPUTextureFormat, bytesPerTexel } = await import(
  pathToFileURL(path.join(RENDERER_WEBGPU_DIR, "WebGLStateConverters.ts")).href
);

/** GPU bytes the globe renderer allocates for one provider mask of side `size`. */
function providerMaskRendererBytes(ns, size, rgba) {
  const upload = uploadWaterMask(ns, {
    width: size,
    height: size,
    arrayBufferView: new Uint8Array(size * size),
    rgbaArrayBufferView: rgba ? new Uint8Array(size * size * 4) : undefined,
    waterProviderMask: true,
  });
  return upload.created.reduce((bytes, t) => {
    assert.equal(t.mipLevelCount, 1, `${t.label}: one mip`);
    const [w, h] = t.size;
    return bytes + w * h * bytesPerTexel(t.format);
  }, 0);
}

test("22d. N4 the cost of the labelled upload, pinned: one r8 copy of a provider mask beside the stub's, one rgba copy of a composite mask", async () => {
  // Water round 6 (review pass 5, N4). `GlobeSurfaceTile` creates every water
  // mask through `Texture.create` (LUMINANCE, UNSIGNED_BYTE, a LINEAR sampler
  // with no mips), which the WebGPU compatibility stub realises as a
  // `GLStub_Texture` of the format below. Since FND-7 the renderer draws a
  // provider mask from its own labelled texture instead, so a 256 x 256 r8
  // provider mask holds 64 KiB in the stub's copy and 64 KiB in the labelled
  // one (128 KiB; round 4 drew the stub's and held 64 KiB). The stub's copy
  // stays: dropping it means a backend branch in GlobeSurfaceTile.js (scene code
  // stays backend-agnostic) or a stub-level deferred allocation, a Texture
  // contract change recorded as NEW-WATER-MASK-STUB-COPY. This pins the cost so
  // a third copy, a wider format or a mip chain cannot ride in unseen.
  const stubFormat = webglToWebGPUTextureFormat(0x1909, 0x1909, 0x1401);
  assert.equal(stubFormat, "r8unorm", "the stub's copy of a LUMINANCE mask");
  const stubBytes = 256 * 256 * bytesPerTexel(stubFormat);
  assert.equal(stubBytes, 65536);
  const ns = await importWaterMaskTextures();
  assert.equal(providerMaskRendererBytes(ns, 256, false), 65536);
  assert.equal(stubBytes + providerMaskRendererBytes(ns, 256, false), 131072);
  assert.equal(providerMaskRendererBytes(ns, 256, true), 262144);
  // Mutant: the r8 provider mask uploaded as rgba is DETECTED.
  const wide = await importWaterMaskTextures([
    {
      basename: "WebGPUGlobeSurfaceTextures.ts",
      label: "n4-wide",
      mutate: (source) => {
        const anchor =
          '          size: [width, height],\n          format: "r8unorm",\n';
        const text = source.replace(/\r\n/g, "\n");
        assert.equal(text.split(anchor).length - 1, 1, "mutation anchor");
        return text.replace(
          anchor,
          () =>
            '          size: [width, height],\n          format: "rgba8unorm",\n',
        );
      },
    },
  ]);
  assert.notEqual(providerMaskRendererBytes(wide, 256, false), 65536);
});

/** The `waterProviderMask` tag the scene side puts on a tile's mask, for one source and module. */
function providerMaskTags(module) {
  const lakes = createComposite().providers[1];
  // A provider-built mask: the Salvador lakes composited over the terrain mask.
  const built = receive(module, {
    provider: lakes,
    rectangle: SALVADOR_ANCESTOR,
    terrainData: {
      waterMask: ancestorSeaMask(),
      wasCreatedByUpsampling: () => false,
    },
  });
  // A terrain's own mask with no layer touching the tile (open Pacific).
  const own = receive(module, {
    provider: lakes,
    rectangle: {
      west: -150 * RAD,
      south: 10 * RAD,
      east: -149 * RAD,
      north: 11 * RAD,
    },
    terrainData: {
      waterMask: ancestorSeaMask(),
      wasCreatedByUpsampling: () => false,
    },
  });
  return {
    built: built.surfaceTile.waterMaskTexture?._webgpuSource?.waterProviderMask,
    own: own.surfaceTile.waterMaskTexture?._webgpuSource?.waterProviderMask,
  };
}

test("22c. FND-7 the scene side tags a provider-built mask, and only that, for the labelled upload", async () => {
  const module = await import(pathToFileURL(GLOBE_SURFACE_TILE).href);
  assert.deepEqual(providerMaskTags(module), { built: true, own: false });
  const mutant = await importMutated(GLOBE_SURFACE_TILE, [
    [
      "waterProviderMask: waterMask !== surfaceTile.terrainData?.waterMask,",
      "waterProviderMask: false,",
    ],
  ]);
  assert.notDeepEqual(providerMaskTags(mutant), { built: true, own: false });
});

// ---------------------------------------------------------------------------
// The unbuilt-tree guard (DX-WATER-RUNNER-UNBUILT-TREE): a checkout without the
// shader build skips the GlobeSurfaceTile tests, with a reason, instead of dying at
// import; a built tree runs every test above unchanged.
// ---------------------------------------------------------------------------

test("23. the unbuilt-tree guard names the generated modules, skips with a reason, and never skips a built tree", () => {
  assert.deepEqual(
    missingGeneratedInputs(() => true),
    [],
  );
  assert.equal(unbuiltSkipReason([]), false);
  const missing = missingGeneratedInputs(() => false);
  assert.deepEqual(missing, GENERATED_ENGINE_INPUTS);
  assert.match(unbuiltSkipReason(missing), /build has not run/);
  assert.match(unbuiltSkipReason(missing), /CzmBuiltins\.js/);
});

test(
  "23b. (mutant) forcing the GlobeSurfaceTile import on a tree without the generated modules fails with ERR_MODULE_NOT_FOUND, so the skip is the live path",
  {
    skip: SKIP_UNBUILT
      ? false
      : "this tree is built, so the unbuilt-tree failure cannot be reproduced here",
  },
  () => {
    const resolver = pathToFileURL(
      path.join(here, "lib/engine-ts-resolver.mjs"),
    ).href;
    const target = pathToFileURL(
      path.resolve(
        here,
        "../../packages/engine/Source/Scene/GlobeSurfaceTile.js",
      ),
    ).href;
    const run = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { enableEngineTsResolution } from ${JSON.stringify(resolver)};
         enableEngineTsResolution();
         await import(${JSON.stringify(target)});`,
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(run.status, 0, "the forced import must fail");
    assert.match(run.stderr, /ERR_MODULE_NOT_FOUND/);
    const named = GENERATED_ENGINE_INPUTS.some((rel) =>
      run.stderr.split(path.sep).join("/").includes(`Source/${rel}`),
    );
    assert.ok(named, "the failure must name one of the generated modules");
  },
);
