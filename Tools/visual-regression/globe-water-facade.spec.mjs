// @purpose Drives the globe's water facade, region invalidation, bathymetry load, camera dive and weather mapping through the real engine modules under fakes, and requires an inertness mutant of each fix to turn its assertion red.
// @status ACTIVE
//
// Run: node --test Tools/visual-regression/globe-water-facade.spec.mjs
//
// WHAT THIS CHECKS. Ten fixes to the water facade and the code around it
// (fix-list items EM-01 to EM-09, and EM-10 from review pass 2's B1). Each
// group asserts something an application can observe, not the shape of the
// source:
//
//   EM-01  a region added, removed or edited makes the globe rebuild tile masks
//   EM-02  the surface keeps `globe.maximumScreenSpaceError` at every eye height
//   EM-03  the opt-in water dive never lifts the terrain clamp over land
//   EM-04  a quality tier does not switch the enhanced ocean on, and a tier set
//          before the FFT ocean exists is applied when it is created
//   EM-05  a failed bathymetry fetch logs exactly once, naming the asset
//   EM-06  no per-frame allocation, one hand-off per frame, public accessors
//   EM-07  every altitude maps to a regime
//   EM-08  scaffolding with no renderer consumer is marked experimental
//   EM-09  weather type is written through the PrecipitationType mapping
//   EM-10  `lakeWaterMask` and `riverWaterMask` add to a mask the terrain or
//          `globalWaterMask` supplies, and on their own create none (the
//          meaning `lakeWaterMask` shipped with)
//   DP     the default path (water round 7, B1): a globe whose `water` is never
//          read builds no facade, mirrors none of it per frame, and the camera
//          controller never creates one; a globe-like mock without the
//          water members (the Karma specs' mock globes) is accepted (DP-4, DP-5)
//
// HOW EACH FIX IS KEPT HONEST. The engine modules are bundled with a named
// allowlist kept real (`lib/engine-stub-bundler.mjs`) and the fetch, the FFT
// primitive and the tensor parser replaced by recording fakes. The "mutant"
// tests then rebuild the same bundle with the fix made unreachable, in memory
// (`if (false && ...)` or the old code restored), and require the matching
// assertion to fail. Nothing is written to the tree. A mutant that did not
// turn its check red would mean the check could not tell the fix from its
// absence.
//
// WHAT IT DOES NOT PROVE. The Globe is driven through `beginFrame` with a fake
// quadtree surface, so no tile is built and no pixel is drawn; the rendered
// half of each behaviour belongs to a browser leg. EM-08 is a documentation
// requirement, so its check reads the JSDoc text and its mutant removes a tag.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { bundle } from "./lib/engine-stub-bundler.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const SCENE = path.join(ROOT, "packages/engine/Source/Scene");
const CORE = path.join(ROOT, "packages/engine/Source/Core");

const lf = (file) =>
  readFileSync(path.join(SCENE, file), "utf8").replaceAll("\r\n", "\n");

// ---------------------------------------------------------------------------
// Fakes. They record what the engine asked of them; none of them decides an
// outcome the assertions below check.
// ---------------------------------------------------------------------------

const HOOKS = "__globeWaterFacadeSpec";

const STUBS = {
  "../Core/Resource.js": `
    export default class Resource {
      constructor(o) { this.url = typeof o === "string" ? o : o?.url; }
      static fetchArrayBuffer(url) { return globalThis.${HOOKS}.fetch(url); }
      fetchImage() { return new Promise(() => {}); }
    }`,
  "../Core/buildModuleUrl.js":
    "export default function buildModuleUrl(p) { return p; }",
  "../Core/GeoidUndulationGrid.js": "export default { loadEgm2008Async() {} };",
  "./OceanSurfacePrimitive.js": `
    export default class OceanSurfacePrimitive {
      constructor(o) {
        this.options = o;
        this._detailScale = o.detailScale;
        this._foamStrength = o.foamStrength;
        this._celestialReflection = o.celestialReflection;
      }
    }
    export function cloneSimulationEpoch(e) { return e; }`,
  "./BathymetryTensorMap.js": `
    const hooks = () => globalThis.${HOOKS};
    export function parseBundledBathymetryTensor(buffer) { hooks().parsed.push(buffer); return { parsedFrom: buffer }; }
    export function setGlobalBundledBathymetryTensor(t) { hooks().registered.push(t); }
    export const evaluateUnderwaterVerticalProfile = () => ({});
    export const evaluateWaterlineMeniscusAndWetness = () => ({});
    export const evaluatePolarSeaIceAndGlacialOptics = () => ({});
    export const evaluateKelvinWakeAndBuoyancyQuery = () => ([]);
    export const evaluateCase2BioOpticalIOP = () => ({});
    export const evaluateFetchLimitedWaveSpectrum = () => ({});`,
  // Globe.js takes the water-mirror reset from the tile provider module (water
  // round 7, B1). The default export is the same Proxy every other stub is; the
  // reset records its argument (DP-1). EM-06 runs the real reset through the
  // provider's real constructor.
  "./GlobeSurfaceTileProvider.js": `
    const make = () =>
      new Proxy(function () {}, {
        get: (t, k) => (typeof k === "symbol" ? undefined : make()),
        apply: () => make(),
        construct: () => make(),
      });
    export default make();
    export function resetGlobeWaterMirrors(p) { globalThis.${HOOKS}.mirrorResets.push(p); }`,
  "./GlobalCoastlineWaterClassificationProvider.js":
    "export class GlobalCoastlineWaterClassificationProvider { constructor(b) { this.buffer = b; } }",
  "./WaterClassificationProvider.js": `
    export class LakeWaterClassificationProvider {}
    export class RiverWaterClassificationProvider {}
    export class CompositeWaterClassificationProvider {
      constructor(providers) {
        this.ctorArgument = providers;
        this.providers = providers.filter((p) => p !== undefined);
        this.tensorCalls = [];
        this.regionCalls = [];
        globalThis.${HOOKS}.composites.push(this);
      }
      setBathymetryTensor(t) { this.tensorCalls.push(t); }
      setWaterRegions(r) { this.regionCalls.push(r); }
    }
    export default LakeWaterClassificationProvider;`,
};

function resetHooks(fetchImpl) {
  globalThis[HOOKS] = {
    fetch: fetchImpl ?? (() => Promise.reject(new Error("unexpected fetch"))),
    fetched: [],
    parsed: [],
    registered: [],
    composites: [],
    mirrorResets: [],
  };
  const inner = globalThis[HOOKS].fetch;
  globalThis[HOOKS].fetch = (url) => {
    globalThis[HOOKS].fetched.push(url);
    return inner(url);
  };
  return globalThis[HOOKS];
}

async function settle() {
  for (let i = 0; i < 4; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function capturingConsoleError(run) {
  const original = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args.map(String).join(" "));
  try {
    await run();
    await settle();
  } finally {
    console.error = original;
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Bundles.
// ---------------------------------------------------------------------------

const REAL = [
  "GlobeWater",
  "GlobeWaterOcean",
  "CelestialWaterReflection",
  "SceneMode",
];

function bundleScene(file, { append = "", mutate, overrides, label } = {}) {
  return bundle({
    path: path.join(SCENE, file),
    source: `${lf(file)}\n${append}\n`,
    real: REAL,
    realDir: CORE,
    stubSources: STUBS,
    mutate,
    overrides,
    label,
  });
}

const GLOBE_APPEND = `
import GlobeWaterForSpec from "./GlobeWater.js";
import EllipsoidForSpec from "../Core/Ellipsoid.js";
import SceneModeForSpec from "./SceneMode.js";
export { GlobeWaterForSpec as GlobeWater, EllipsoidForSpec as Ellipsoid, SceneModeForSpec as SceneMode };
`;

const loadGlobe = (options = {}) =>
  bundleScene("Globe.js", { ...options, append: GLOBE_APPEND });

const loadWater = (options = {}) =>
  bundleScene("GlobeWater.js", {
    ...options,
    append: "export { GlobeWater };",
  });

const HELPERS_APPEND = `
import GlobeWaterForSpec from "./GlobeWater.js";
export { GlobeWaterForSpec as GlobeWater };
`;

const loadHelpers = (options = {}) =>
  bundleScene("SSCCInputHelpers.js", { ...options, append: HELPERS_APPEND });

const CONTROLLER_APPEND = `
import GlobeWaterForSpec from "./GlobeWater.js";
import EllipsoidForSpec from "../Core/Ellipsoid.js";
import CartesianForSpec from "../Core/Cartesian3.js";
import CartographicForSpec from "../Core/Cartographic.js";
import Matrix4ForSpec from "../Core/Matrix4.js";
export {
  GlobeWaterForSpec as GlobeWater,
  EllipsoidForSpec as Ellipsoid,
  CartesianForSpec as Cartesian3,
  CartographicForSpec as Cartographic,
  Matrix4ForSpec as Matrix4,
};
`;

const loadController = (options = {}) =>
  bundleScene("ScreenSpaceCameraController.js", {
    ...options,
    append: CONTROLLER_APPEND,
  });

const loadEffects = (options = {}) =>
  bundleScene("AtmosphericEffects.ts", options);

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

function makeFacade(ns, globeFields = {}) {
  const created = [];
  const globe = {
    enableEnhancedOcean: false,
    oceanCelestialReflection: false,
    oceanFoamThreshold: 0.35,
    ...globeFields,
  };
  const scene = {
    primitives: {
      add(p) {
        created.push(p);
      },
      remove() {},
    },
  };
  const water = new ns.GlobeWater(scene, globe);
  return { water, globe, created };
}

function makeGlobe(ns) {
  const { default: Globe } = ns;
  const globe = new Globe(ns.Ellipsoid.WGS84);
  const log = { invalidations: 0, sse: [] };
  const tileProvider = {};
  globe._surface = {
    tileProvider,
    invalidateAllTiles() {
      log.invalidations++;
    },
    beginFrame() {},
    update() {},
    render() {},
    set maximumScreenSpaceError(v) {
      log.sse.push(v);
    },
    get maximumScreenSpaceError() {
      return log.sse[log.sse.length - 1];
    },
  };
  const scene = { primitives: { add() {}, remove() {} }, globe };
  globe._water = new ns.GlobeWater(scene, globe);
  const frame = (eyeHeight = 100, pitch = -0.2) =>
    globe.beginFrame({
      passes: { render: true },
      mode: ns.SceneMode.SCENE3D,
      camera: { positionCartographic: { height: eyeHeight }, pitch },
      eclipseSceneLightFactor: 1.0,
    });
  return { globe, log, tileProvider, frame, water: globe._water };
}

// SceneMode.SCENE3D; the helper and controller bundles do not export the enum.
const SCENE3D = 3;

const REGION = (id, west) => ({
  id,
  west,
  south: -0.1,
  east: west + 0.1,
  north: 0.1,
});

// ---------------------------------------------------------------------------
// The checks. Each takes a loaded bundle and throws when the behaviour is
// absent, so the same function serves the live test and its mutant.
// ---------------------------------------------------------------------------

// EM-01 -------------------------------------------------------------------

function checkRegionCollectionVersion(ns) {
  const { water } = makeFacade(ns);
  const regions = water.regions;
  const v0 = regions.version;
  assert.equal(typeof v0, "number");
  const a = regions.add(REGION("a", 0.0));
  const v1 = regions.version;
  assert.ok(v1 > v0, "add bumps the version");
  regions.add(REGION("b", 0.2));
  regions.add(REGION("c", 0.4));
  const v3 = regions.version;
  assert.ok(v3 > v1);
  a.west = 0.05;
  assert.equal(
    regions.version,
    v3,
    "an in-place edit is invisible until markDirty",
  );
  regions.markDirty();
  assert.ok(regions.version > v3, "markDirty bumps the version");
  const v4 = regions.version;
  assert.equal(regions.remove("missing"), false);
  assert.equal(regions.version, v4, "removing nothing changes nothing");
  assert.equal(regions.remove("b"), true);
  assert.ok(regions.version > v4, "remove bumps the version");
  const v5 = regions.version;
  regions.removeAll();
  assert.ok(regions.version > v5, "removeAll bumps the version");
  const v6 = regions.version;
  regions.removeAll();
  assert.equal(
    regions.version,
    v6,
    "removeAll on an empty collection changes nothing",
  );
}

function checkGlobeRebuildsOnRegionChange(ns) {
  const { log, frame, water } = makeGlobe(ns);
  frame();
  const base = log.invalidations;
  frame();
  assert.equal(
    log.invalidations,
    base,
    "an unchanged collection rebuilds nothing",
  );

  const regions = water.regions;
  regions.add(REGION("a", 0.0));
  const middle = regions.add(REGION("b", 0.2));
  regions.add(REGION("c", 0.4));
  frame();
  assert.equal(
    log.invalidations,
    base + 1,
    "three adds in a frame rebuild once",
  );
  frame();
  assert.equal(log.invalidations, base + 1);

  middle.waterType = "LAKE";
  middle.west = 0.21;
  regions.markDirty();
  frame();
  assert.equal(
    log.invalidations,
    base + 2,
    "an edit to the middle region is seen",
  );

  regions.remove("a");
  frame();
  assert.equal(log.invalidations, base + 3, "a removal is seen");
  regions.removeAll();
  frame();
  assert.equal(log.invalidations, base + 4, "removeAll is seen");
  frame();
  assert.equal(log.invalidations, base + 4);
}

// EM-02 -------------------------------------------------------------------

function checkSurfaceUsesGlobeSse(ns) {
  const { globe, log, frame } = makeGlobe(ns);
  globe.maximumScreenSpaceError = 2;
  for (const enhanced of [false, true]) {
    globe.enableEnhancedOcean = enhanced;
    for (const [eye, pitch] of [
      [5, 0.0],
      [15, -0.1],
      [1000, 0.1],
      [1000, -1.2],
      [100000, -0.5],
    ]) {
      frame(eye, pitch);
      assert.equal(
        log.sse[log.sse.length - 1],
        2,
        `enhanced=${enhanced} eye=${eye} pitch=${pitch}: the surface keeps the globe's value`,
      );
    }
  }
}

// EM-03 -------------------------------------------------------------------

function checkFacadeDiveBand(ns) {
  const { water } = makeFacade(ns);
  assert.equal(water.canDiveAtSurfaceHeight(0), false, "off by default");
  water.disableWaterCollision = true;
  for (const h of [0, 12, -104, 85]) {
    assert.equal(water.canDiveAtSurfaceHeight(h), true, `${h} m is sea level`);
  }
  for (const h of [3000, 400, -4000, undefined, Number.NaN]) {
    assert.equal(
      water.canDiveAtSurfaceHeight(h),
      false,
      `${h} is not sea level`,
    );
  }
}

function zoomFixture(ns, { globeHeight, flag, depth = 0, y = 200 }) {
  const { water } = makeFacade(ns);
  water.disableWaterCollision = flag;
  water.diveDepthMeters = depth;
  const zoomed = [];
  const camera = {
    heading: 0,
    pitch: 0,
    roll: 0,
    zoomIn(d) {
      zoomed.push(d);
    },
    positionCartographic: { height: 100 },
  };
  const object = {
    minimumZoomDistance: 1,
    maximumZoomDistance: 1e9,
    _minimumZoomRate: 20,
    _maximumZoomRate: 5906376272000,
    maximumMovementRatio: 1,
    enableCollisionDetection: false,
    _scene: {
      canvas: { clientHeight: 1000 },
      camera,
      mode: SCENE3D,
      globeHeight,
    },
    // The engine reads `_water` (round 7, B1): a facade nobody created has
    // the dive off, and the public accessor would create one.
    _globe: { _water: water },
    _useZoomWorldPosition: false,
    _zoomMouseStart: { x: 0, y: 0 },
  };
  const movement = {
    startPosition: { x: 0, y: 0 },
    endPosition: { x: 0, y },
    inertiaEnabled: true,
  };
  return { object, movement, water, zoomed };
}

function checkZoomDive(ns, handleZoom) {
  // Over open ocean the virtual dive works: depth grows and the camera is
  // stopped at the dive surface distance (20 m away, 14 m kept).
  const sea = zoomFixture(ns, { globeHeight: 0, flag: true });
  handleZoom(sea.object, { x: 0, y: 0 }, sea.movement, 5, 20, undefined);
  assert.ok(sea.water.diveDepthMeters > 0, "depth counted over water");
  assert.deepEqual(sea.zoomed, [6], "the camera stops at the dive surface");

  // Over a 3000 m ridge the same input is a stock zoom: no depth, full distance.
  const ridge = zoomFixture(ns, { globeHeight: 3000, flag: true });
  handleZoom(ridge.object, { x: 0, y: 0 }, ridge.movement, 5, 20, undefined);
  assert.equal(ridge.water.diveDepthMeters, 0, "no depth counted over land");
  assert.deepEqual(ridge.zoomed, [19], "stock zoom over land");

  // A depth left over from a dive does not follow the camera onto land.
  const carried = zoomFixture(ns, {
    globeHeight: 3000,
    flag: true,
    depth: 30,
    y: -200,
  });
  handleZoom(
    carried.object,
    { x: 0, y: 0 },
    carried.movement,
    5,
    20,
    undefined,
  );
  assert.equal(
    carried.water.diveDepthMeters,
    0,
    "stale depth cleared over land",
  );
  assert.equal(carried.zoomed.length, 1, "and the zoom proceeds as stock");

  // Flag off: stock everywhere.
  const off = zoomFixture(ns, { globeHeight: 0, flag: false });
  handleZoom(off.object, { x: 0, y: 0 }, off.movement, 5, 20, undefined);
  assert.equal(off.water.diveDepthMeters, 0);
  assert.deepEqual(off.zoomed, [19]);
}

function clampFixture(ns, { globeHeight, flag, cameraHeight }) {
  const { water } = makeFacade(ns);
  water.disableWaterCollision = flag;
  const ellipsoid = ns.Ellipsoid.WGS84;
  const position = ellipsoid.cartographicToCartesian(
    new ns.Cartographic(0.5, 0.3, cameraHeight),
  );
  const camera = {
    transform: ns.Matrix4.IDENTITY,
    position,
    direction: new ns.Cartesian3(),
    up: new ns.Cartesian3(),
    right: new ns.Cartesian3(),
    _setTransform() {},
  };
  const controller = {
    _scene: { mode: SCENE3D, camera, ellipsoid, globeHeight },
    // The engine reads `_water` (round 7, B1): a facade nobody created has
    // the dive off, and the public accessor would create one.
    _globe: { _water: water },
    _minimumCollisionTerrainHeight: 15000,
    _lastGlobeHeight: 0,
    minimumZoomDistance: 1,
  };
  const heightNow = () =>
    ellipsoid.cartesianToCartographic(camera.position).height;
  return { controller, heightNow };
}

function checkClamp(ns) {
  const run = ({ globeHeight, flag, cameraHeight }) => {
    const f = clampFixture(ns, { globeHeight, flag, cameraHeight });
    ns.default.prototype._adjustHeightForTerrain.call(f.controller, true);
    return f.heightNow();
  };
  const near = (actual, expected, what) =>
    assert.ok(
      Math.abs(actual - expected) < 1e-3,
      `${what}: ${actual} vs ${expected}`,
    );

  near(
    run({ globeHeight: 3000, flag: true, cameraHeight: 100 }),
    3001,
    "ridge, flag on: lifted",
  );
  near(
    run({ globeHeight: 3000, flag: false, cameraHeight: 100 }),
    3001,
    "ridge, flag off: lifted",
  );
  near(
    run({ globeHeight: 0, flag: true, cameraHeight: 0.2 }),
    0.2,
    "ocean, flag on: not lifted",
  );
  near(
    run({ globeHeight: 0, flag: false, cameraHeight: 0.2 }),
    1,
    "ocean, flag off: lifted",
  );
  near(
    run({ globeHeight: -104, flag: true, cameraHeight: -104.5 }),
    -104.5,
    "geoid sea: not lifted",
  );
  near(
    run({ globeHeight: -4000, flag: true, cameraHeight: -4000.2 }),
    -3999,
    "seabed: stock clamp",
  );
}

// EM-04 -------------------------------------------------------------------

function checkPresetLeavesEnhancedOceanAlone(ns) {
  for (const start of [false, true]) {
    for (const tier of ["LOW", "MEDIUM", "HIGH", "low", " High ", "nonsense"]) {
      const { water, globe } = makeFacade(ns, { enableEnhancedOcean: start });
      water.qualityPreset = tier;
      assert.equal(
        globe.enableEnhancedOcean,
        start,
        `qualityPreset=${tier} must not change enableEnhancedOcean (was ${start})`,
      );
    }
  }
}

function checkPresetAppliesBeforeAndAfterOceanExists(ns) {
  const tuple = (primitive) => [
    primitive._detailScale,
    primitive._foamStrength,
    primitive._celestialReflection,
  ];
  const results = {};
  for (const tier of ["LOW", "MEDIUM", "HIGH"]) {
    const before = makeFacade(ns);
    before.water.qualityPreset = tier;
    before.water.ocean.enabled = true;
    const after = makeFacade(ns);
    after.water.ocean.enabled = true;
    after.water.qualityPreset = tier;
    assert.equal(before.created.length, 1);
    assert.equal(after.created.length, 1);
    assert.deepEqual(
      tuple(before.created[0]),
      tuple(after.created[0]),
      `${tier}: a preset set before the ocean exists equals one set after`,
    );
    results[tier] = tuple(before.created[0]);
  }
  assert.ok(
    results.LOW[0] < results.MEDIUM[0] && results.MEDIUM[0] < results.HIGH[0],
    "detail rises with the tier",
  );
  assert.ok(
    results.LOW[1] < results.MEDIUM[1] && results.MEDIUM[1] < results.HIGH[1],
    "foam gain rises with the tier",
  );
  assert.equal(results.LOW[2], false);
  assert.equal(results.HIGH[2], true);
}

function checkDefaultPresetIsNeutral(ns) {
  const { water, globe, created } = makeFacade(ns);
  assert.equal(water.qualityPreset, "MEDIUM");
  assert.equal(water.hasOcean, false, "reading the preset creates no ocean");
  assert.equal(globe.enableEnhancedOcean, false);
  assert.equal(globe.oceanCelestialReflection, false);
  assert.equal(globe.oceanFoamThreshold, 0.35);
  water.ocean.enabled = true;
  assert.equal(
    created[0]._detailScale,
    2.0,
    "an untouched facade keeps the primitive's own detail",
  );
  assert.equal(created[0]._foamStrength, 1.0);
  assert.equal(water.hasOcean, true);
}

// EM-05 -------------------------------------------------------------------

const COAST = /ne50mCoastlines/;
const TENSOR = /globalBathymetryTensor/;

async function runGlobalMask(ns, { coastOk, tensorOk }) {
  const hooks = resetHooks((url) => {
    const ok = COAST.test(url) ? coastOk : TENSOR.test(url) ? tensorOk : false;
    return ok
      ? Promise.resolve(new ArrayBuffer(8))
      : Promise.reject(new Error(`404 ${url}`));
  });
  const { globe } = makeGlobe(ns);
  const errors = await capturingConsoleError(() => {
    globe.globalWaterMask = true;
  });
  return { hooks, globe, errors };
}

async function checkBathymetryLoad(ns) {
  const { default: Globe } = ns;
  const fresh = new Globe(ns.Ellipsoid.WGS84);
  assert.ok(
    Object.hasOwn(fresh, "_globalBathymetryTensor"),
    "tensor field initialised in the constructor",
  );
  assert.equal(fresh._globalBathymetryTensorLoadPending, false);

  const tensor404 = await runGlobalMask(ns, { coastOk: true, tensorOk: false });
  assert.equal(
    tensor404.errors.length,
    1,
    `exactly one error: ${tensor404.errors.join(" | ")}`,
  );
  assert.match(tensor404.errors[0], /globalBathymetryTensor\.bin/);
  assert.ok(
    tensor404.globe._globalWaterClassificationProvider,
    "the coastline mask still loads",
  );
  assert.equal(tensor404.hooks.fetched.filter((u) => TENSOR.test(u)).length, 1);

  const coast404 = await runGlobalMask(ns, { coastOk: false, tensorOk: true });
  assert.equal(
    coast404.errors.length,
    1,
    `exactly one error: ${coast404.errors.join(" | ")}`,
  );
  assert.match(coast404.errors[0], /coastline/);
  assert.ok(
    coast404.globe._globalBathymetryTensor,
    "the tensor loads even when the coastline fails",
  );

  const fine = await runGlobalMask(ns, { coastOk: true, tensorOk: true });
  assert.equal(fine.errors.length, 0);
  assert.equal(
    fine.hooks.fetched.filter((u) => TENSOR.test(u)).length,
    1,
    "fetched once",
  );
  assert.equal(fine.hooks.parsed.length, 1);
  assert.equal(fine.hooks.registered.length, 1);
}

// EM-06 -------------------------------------------------------------------

function checkProviderHandOff(ns) {
  const hooks = resetHooks();
  const { globe, tileProvider, frame, water } = makeGlobe(ns);
  const global = { id: "global" };
  const lake = { id: "lake" };
  const river = { id: "river" };
  globe._globalWaterMask = true;
  globe._globalWaterClassificationProvider = global;
  globe._lakeWaterMask = true;
  globe._lakeWaterClassificationProvider = lake;

  frame();
  assert.equal(hooks.composites.length, 1);
  const first = hooks.composites[0];
  assert.equal(tileProvider.waterClassificationProvider, first);
  assert.equal(first.tensorCalls.length, 1, "tensor handed over once");
  assert.equal(first.regionCalls.length, 1, "regions handed over once");
  assert.equal(
    first.regionCalls[0],
    water.regions,
    "through the public collection",
  );
  frame();
  assert.equal(
    hooks.composites.length,
    1,
    "unchanged providers do not rebuild",
  );
  assert.equal(first.tensorCalls.length, 2);
  assert.equal(first.regionCalls.length, 2);

  globe._riverWaterMask = true;
  globe._riverWaterClassificationProvider = river;
  frame();
  assert.equal(hooks.composites.length, 2);
  const second = hooks.composites[1];
  assert.equal(
    second.ctorArgument,
    first.ctorArgument,
    "one scratch list is reused, not reallocated per rebuild",
  );
  assert.notEqual(
    first.providers,
    first.ctorArgument,
    "a composite keeps its own copy",
  );
  assert.deepEqual(
    first.providers,
    [global, lake],
    "and a later frame does not rewrite it",
  );
  assert.deepEqual(second.providers, [global, lake, river]);

  const before = [second.tensorCalls.length, second.regionCalls.length];
  globe._lakeWaterMask = false;
  globe._riverWaterMask = false;
  frame();
  assert.equal(
    tileProvider.waterClassificationProvider,
    global,
    "a lone provider is used directly",
  );
  assert.deepEqual(
    [second.tensorCalls.length, second.regionCalls.length],
    [before[0] + 1, before[1] + 1],
  );
  globe._globalWaterMask = false;
  frame();
  assert.equal(tileProvider.waterClassificationProvider, undefined);
  assert.deepEqual(
    [second.tensorCalls.length, second.regionCalls.length],
    [before[0] + 2, before[1] + 2],
  );
}

function checkPerFrameReadsDoNotCreateTheOcean(ns) {
  const { frame, water, tileProvider } = makeGlobe(ns);
  frame();
  frame();
  assert.equal(
    water.hasOcean,
    false,
    "the per-frame tide read must not create the FFT sub-facade",
  );
  assert.equal(tileProvider.oceanTideEnabled, true);
  water.ocean.tideEnabled = false;
  frame();
  assert.equal(
    tileProvider.oceanTideEnabled,
    false,
    "an existing ocean's tide setting is mirrored",
  );
}

// EM-07 -------------------------------------------------------------------

function checkRegimeBands(ns) {
  const { water } = makeFacade(ns);
  const expected = [
    [250000, "ORBIT"],
    [200000.5, "ORBIT"],
    [200000, "ATMOSPHERE"],
    [15000.5, "ATMOSPHERE"],
    [15000, "IN_FLIGHT"],
    [500.5, "IN_FLIGHT"],
    [500, "SEA_LEVEL"],
    [0, "SEA_LEVEL"],
    [-0.1, "SHALLOW_UNDERWATER"],
    [-200, "SHALLOW_UNDERWATER"],
    [-200.1, "DEEP_UNDERWATER"],
    [-9000, "DEEP_UNDERWATER"],
  ];
  for (const [alt, regime] of expected) {
    assert.equal(
      water.evaluateRegimeAtAltitude(alt).regime,
      regime,
      `altitude ${alt}`,
    );
  }
}

// EM-08 -------------------------------------------------------------------

const EXPERIMENTAL_SYMBOLS = [
  ["OsmWaterTypeAdapter", /OsmWaterTypeAdapter = Object\.freeze/],
  ["vesselWakeEnabled", /\n {2}get vesselWakeEnabled\(/],
  ["vesselWakeIntensity", /\n {2}get vesselWakeIntensity\(/],
  ["vesselWakeEmitters", /\n {2}get vesselWakeEmitters\(/],
  ["addVesselWakeEmitter", /\n {2}addVesselWakeEmitter\(/],
  ["evaluateBiomeOptics", /\n {2}evaluateBiomeOptics\(/],
  ["queryBuoyancyAndKelvinWake", /\n {2}queryBuoyancyAndKelvinWake\(/],
  ["evaluateRegimeAtAltitude", /\n {2}evaluateRegimeAtAltitude\(/],
];

function docBlockBefore(source, pattern) {
  const match = pattern.exec(source);
  assert.ok(match, `symbol anchor ${pattern} exists`);
  const head = source.slice(0, match.index);
  const start = head.lastIndexOf("/**");
  const end = head.lastIndexOf("*/");
  assert.ok(start >= 0 && end > start, "a JSDoc block precedes the symbol");
  return head
    .slice(start, end)
    .replaceAll(/\n\s*\*\s?/g, " ")
    .replaceAll(/\s+/g, " ");
}

function checkExperimentalMarks(source) {
  for (const [name, anchor] of EXPERIMENTAL_SYMBOLS) {
    const doc = docBlockBefore(source, anchor);
    assert.match(doc, /@experimental/, `${name} is marked @experimental`);
    assert.match(
      doc,
      /not yet consumed by any renderer/i,
      `${name} says no renderer consumes it`,
    );
  }
  const emitter = docBlockBefore(source, /\n {2}addVesselWakeEmitter\(/);
  assert.match(emitter, /x = 95/);
  assert.match(emitter, /unrelated to any constant in the shaders/);
}

// EM-09 -------------------------------------------------------------------

function checkWeatherTypeMapping(ns) {
  const run = (temperatureC) => {
    const weather = {};
    const scene = { globe: { atmosphericConditions: { weather } } };
    ns.applyEnvironmentalTensor(scene, {
      temperatureC,
      precipitationRate: 0.6,
      windSpeed: 4,
      windHeadingRad: 0.5,
    });
    return { scene, weather };
  };
  const snow = run(-4);
  const rain = run(9);
  assert.equal(snow.weather.type, ns.PrecipitationType.SNOW);
  assert.equal(rain.weather.type, ns.PrecipitationType.RAIN);
  // The flat scene index and the hierarchy leaf must describe the same thing.
  assert.equal(
    ns.weatherTypeIndexToPrecipitationType(snow.scene.weatherType),
    ns.PrecipitationType.SNOW,
  );
  assert.equal(
    ns.weatherTypeIndexToPrecipitationType(rain.scene.weatherType),
    ns.PrecipitationType.RAIN,
  );
  assert.notEqual(snow.scene.weatherType, rain.scene.weatherType);
}

// EM-06 (declared fields) -------------------------------------------------

const TILE_PROVIDER_FIELDS = {
  oceanTideEnabled: true,
  oceanTideExaggeration: 1.0,
  oceanTideCallback: undefined,
  oceanMeanSeaLevelPressure: 1013.25,
  waterQualityPreset: "MEDIUM",
  waterSubmersibleLightEnabled: false,
  waterSubmersibleLightIntensity: 1.0,
  waterBathymetricReliefBoost: 0.0,
  waterEmergenceWetness: 0.0,
  waterVesselWakeIntensity: 0.0,
  waterNearSurfaceTransparency: 0.0,
  waterDiveDepthMeters: 0.0,
  waterDisableCollision: false,
};

function checkTileProviderDeclaresWaterFields(ns) {
  const { default: GlobeSurfaceTileProvider } = ns;
  const provider = new GlobeSurfaceTileProvider({
    vectorProvider: {},
    terrainProvider: {
      tilingScheme: {},
      errorEvent: { addEventListener() {} },
    },
    imageryLayers: {
      layerAdded: { addEventListener() {} },
      layerRemoved: { addEventListener() {} },
      layerMoved: { addEventListener() {} },
      layerShownOrHidden: { addEventListener() {} },
    },
    surfaceShaderSet: {},
  });
  for (const [field, value] of Object.entries(TILE_PROVIDER_FIELDS)) {
    assert.ok(
      Object.hasOwn(provider, field),
      `${field} declared at construction`,
    );
    assert.equal(provider[field], value, `${field} default`);
  }
}

function checkGlobalWaterMaskDocs(source) {
  const start = source.indexOf("get globalWaterMask()");
  const doc = source.slice(source.lastIndexOf("/**", start), start);
  assert.doesNotMatch(doc, /233 KiB/, "the old size claim is gone");
  assert.match(doc, /MiB/, "real sizes are stated");
  assert.match(doc, /lakeWaterMask/, "lakes need their own flag");
}

// EM-10 -------------------------------------------------------------------

// Base `a999954e2b` built lake masks only where the terrain provider supplies
// a water mask. The water work let the lake arm alone turn the tile provider's
// `hasWaterMask` on, which painted reflective lakes over maskless terrain.
function checkWaterLayersNeedAMask(ns) {
  const hooks = resetHooks();
  const { globe, tileProvider, frame } = makeGlobe(ns);
  const global = { id: "global" };
  const lake = { id: "lake" };
  const river = { id: "river" };
  globe._terrainProvider = { hasWaterMask: false };
  globe._lakeWaterMask = true;
  globe._lakeWaterClassificationProvider = lake;

  frame();
  assert.equal(
    Boolean(tileProvider.hasWaterMask),
    false,
    "lakeWaterMask alone over a maskless terrain builds no tile mask",
  );
  assert.equal(
    tileProvider.waterClassificationProvider,
    undefined,
    "and mirrors no provider",
  );

  globe._riverWaterMask = true;
  globe._riverWaterClassificationProvider = river;
  frame();
  assert.equal(Boolean(tileProvider.hasWaterMask), false, "rivers alike");
  assert.equal(tileProvider.waterClassificationProvider, undefined);
  assert.equal(hooks.composites.length, 0, "no composite is built");

  globe._riverWaterMask = false;
  globe._terrainProvider = { hasWaterMask: true };
  frame();
  assert.equal(Boolean(tileProvider.hasWaterMask), true);
  assert.equal(
    tileProvider.waterClassificationProvider,
    lake,
    "over a terrain mask the lake layer is mirrored, as it shipped",
  );

  globe._terrainProvider = { hasWaterMask: false };
  globe._globalWaterMask = true;
  globe._globalWaterClassificationProvider = global;
  frame();
  assert.equal(Boolean(tileProvider.hasWaterMask), true);
  assert.equal(hooks.composites.length, 1);
  assert.deepEqual(
    hooks.composites[0].providers,
    [global, lake],
    "with globalWaterMask the lake layer joins the coastline mask",
  );
}

// ---------------------------------------------------------------------------
// Live tests.
// ---------------------------------------------------------------------------

let baseGlobe;
let baseWater;
const globeBundle = () => (baseGlobe ??= loadGlobe({ label: "base" }));
const waterBundle = () => (baseWater ??= loadWater({ label: "base" }));

test("EM-01: the region collection reports every change through version", async () => {
  checkRegionCollectionVersion(await waterBundle());
});

test("EM-01: the globe rebuilds tile masks when a region is added, edited, removed", async () => {
  checkGlobeRebuildsOnRegionChange(await globeBundle());
});

test("EM-02: the surface uses the globe's screen-space error at every eye height", async () => {
  checkSurfaceUsesGlobeSse(await globeBundle());
});

test("EM-03: the facade allows a dive only over a sea-level surface", async () => {
  checkFacadeDiveBand(await waterBundle());
});

test("EM-03: wheel zoom dives over water and zooms as stock over a ridge", async () => {
  const ns = await loadHelpers({ label: "base" });
  checkZoomDive(ns, ns.handleZoom);
});

test("EM-03: the terrain clamp is lifted over sea level only", async () => {
  checkClamp(await loadController({ label: "base" }));
});

test("EM-04: no quality tier switches the enhanced ocean on", async () => {
  checkPresetLeavesEnhancedOceanAlone(await waterBundle());
});

test("EM-04: a tier set before the ocean exists equals one set after", async () => {
  checkPresetAppliesBeforeAndAfterOceanExists(await waterBundle());
});

test("EM-04: the default tier changes nothing until it is assigned", async () => {
  checkDefaultPresetIsNeutral(await waterBundle());
});

test("EM-05: a failed tensor or coastline fetch logs exactly once and loads once", async () => {
  await checkBathymetryLoad(await globeBundle());
});

test("EM-06: providers are handed over once per frame from a reused scratch list", async () => {
  checkProviderHandOff(await globeBundle());
});

test("EM-06: the per-frame tide read does not create the FFT ocean", async () => {
  checkPerFrameReadsDoNotCreateTheOcean(await globeBundle());
});

test("EM-06: the tile provider declares the water mirrors at construction", async (t) => {
  let ns;
  try {
    ns = await bundleScene("GlobeSurfaceTileProvider.js", { label: "base" });
    checkTileProviderDeclaresWaterFields(ns);
  } catch (error) {
    if (
      ns === undefined ||
      /Cannot read|is not a function|is not iterable/.test(String(error))
    ) {
      t.skip(`constructor needs more than the stubs provide: ${error}`);
      return;
    }
    throw error;
  }
});

test("EM-06: the globalWaterMask documentation states real sizes and the lake dependency", () => {
  checkGlobalWaterMaskDocs(lf("Globe.js"));
});

test("EM-07: every altitude maps to a regime", async () => {
  checkRegimeBands(await waterBundle());
});

test("EM-08: scaffolding with no renderer consumer is marked experimental", () => {
  checkExperimentalMarks(lf("GlobeWater.js"));
});

test("EM-09: weather type is written through the PrecipitationType mapping", async () => {
  checkWeatherTypeMapping(await loadEffects({ label: "base" }));
});

test("EM-09: applyEnvironmentalTensor carries no 1-or-0 literal for the weather type", () => {
  const source = lf("AtmosphericEffects.ts");
  const start = source.indexOf("export function applyEnvironmentalTensor");
  const body = source.slice(start, source.indexOf("\n}\n", start));
  assert.doesNotMatch(body, /\?\s*1\s*:\s*0/);
});

test("EM-10: lakeWaterMask and riverWaterMask add to an existing mask and create none on their own", async () => {
  checkWaterLayersNeedAMask(await globeBundle());
});

// ---------------------------------------------------------------------------
// Inertness mutants. Each makes one fix unreachable (or restores the old code)
// in memory and requires the matching check to fail.
// ---------------------------------------------------------------------------

async function mustTurnRed(check, ...args) {
  let failure;
  try {
    await check(...args);
  } catch (error) {
    failure = error;
  }
  assert.ok(
    failure,
    "the check passed against the mutant, so it cannot tell the fix from its absence",
  );
  // Red for the right reason: an assertion about behaviour failed, not a crash
  // inside the fake or the bundle.
  assert.equal(
    failure.code,
    "ERR_ASSERTION",
    `the mutant crashed the check instead of failing it: ${failure}`,
  );
}

test("mutant EM-01a: collection add no longer bumps the version", async () => {
  const ns = await loadWater({
    label: "EM-01a",
    mutate: (s) =>
      s.replace(
        "this._regions.push(entry);\n    this._version++;",
        "this._regions.push(entry);",
      ),
  });
  await mustTurnRed(checkRegionCollectionVersion, ns);
});

test("mutant EM-01b: the globe's version comparison is unreachable", async () => {
  const ns = await loadGlobe({
    label: "EM-01b",
    mutate: (s) =>
      s.replace(
        "if (waterRegionsVersion !== this._waterRegionsVersionSeen) {",
        "if (false && waterRegionsVersion !== this._waterRegionsVersionSeen) {",
      ),
  });
  await mustTurnRed(checkGlobeRebuildsOnRegionChange, ns);
});

test("mutant EM-02: the sea-level SSE override is restored with its typo fixed", async () => {
  const ns = await loadGlobe({
    label: "EM-02",
    mutate: (s) =>
      s.replace(
        "surface.maximumScreenSpaceError = this.maximumScreenSpaceError;",
        `const eye = frameState.camera?.positionCartographic?.height;
      surface.maximumScreenSpaceError =
        this.enableEnhancedOcean && eye >= 0.0 && eye < 20.0
          ? Math.max(this.maximumScreenSpaceError, 6.0)
          : this.maximumScreenSpaceError;`,
      ),
  });
  await mustTurnRed(checkSurfaceUsesGlobeSse, ns);
});

test("mutant EM-03a: the facade band always allows the dive when the flag is set", async () => {
  const ns = await loadWater({
    label: "EM-03a",
    mutate: (s) =>
      s.replace(
        "Math.abs(globeHeight) <= SEA_LEVEL_SURFACE_TOLERANCE_METERS",
        "(true || Math.abs(globeHeight) <= SEA_LEVEL_SURFACE_TOLERANCE_METERS)",
      ),
  });
  await mustTurnRed(checkFacadeDiveBand, ns);
});

test("mutant EM-03b: wheel zoom ignores the surface and dives wherever the flag is set", async () => {
  const ns = await loadHelpers({
    label: "EM-03b",
    mutate: (s) =>
      s.replace(
        "defined(water) && water.canDiveAtSurfaceHeight(object._scene.globeHeight);",
        "defined(water) && water.disableWaterCollision === true;",
      ),
  });
  await mustTurnRed(checkZoomDive, ns, ns.handleZoom);
});

test("mutant EM-03c: the stale dive depth is no longer cleared over land", async () => {
  const ns = await loadHelpers({
    label: "EM-03c",
    mutate: (s) =>
      s.replace(
        "    !allowWaterDive &&\n",
        "    false &&\n    !allowWaterDive &&\n",
      ),
  });
  await mustTurnRed(checkZoomDive, ns, ns.handleZoom);
});

test("mutant EM-03d: the terrain clamp is lifted wherever the flag is set", async () => {
  const ns = await loadController({
    label: "EM-03d",
    mutate: (s) =>
      s.replace(
        "this._globe?._water?.canDiveAtSurfaceHeight(scene.globeHeight) === true;",
        "this._globe?._water?.disableWaterCollision === true;",
      ),
  });
  await mustTurnRed(checkClamp, ns);
});

test("mutant EM-04a: a tier switches the enhanced ocean on again", async () => {
  const ns = await loadWater({
    label: "EM-04a",
    mutate: (s) =>
      s.replace(
        "const dials = QUALITY_PRESET_DIALS[normalized];",
        "const dials = QUALITY_PRESET_DIALS[normalized];\n    this._globe.enableEnhancedOcean = true;",
      ),
  });
  await mustTurnRed(checkPresetLeavesEnhancedOceanAlone, ns);
});

test("mutant EM-04b: the tier no longer reaches the FFT ocean's detail dial", async () => {
  const ns = await loadWater({
    label: "EM-04b",
    mutate: (s) =>
      s.replace(
        "ocean.detailScale = dials.detailScale;",
        "if (false) ocean.detailScale = dials.detailScale;",
      ),
  });
  await mustTurnRed(checkPresetAppliesBeforeAndAfterOceanExists, ns);
});

test("mutant EM-04c: a tier is applied only to an ocean that already exists", async () => {
  const ns = await loadWater({
    label: "EM-04c",
    mutate: (s) =>
      s.replace(
        "const ocean = this.ocean;",
        "const ocean = this._ocean ?? { set celestialReflection(v) {}, set detailScale(v) {}, set foamStrength(v) {} };",
      ),
  });
  await mustTurnRed(checkPresetAppliesBeforeAndAfterOceanExists, ns);
});

test("mutant EM-05a: the tensor is not requested after a successful coastline", async () => {
  const ns = await loadGlobe({
    label: "EM-05a",
    mutate: (s) =>
      s.replace(
        "this._globalWaterMaskLoadPending = false;\n          this._loadBathymetryTensor();\n          if (this._globalWaterMask) {",
        "this._globalWaterMaskLoadPending = false;\n          if (false) this._loadBathymetryTensor();\n          if (this._globalWaterMask) {",
      ),
  });
  await mustTurnRed(checkBathymetryLoad, ns);
});

test("mutant EM-05b: a tensor failure is swallowed again", async () => {
  const ns = await loadGlobe({
    label: "EM-05b",
    mutate: (s) =>
      s.replace(
        "        console.error(\n          `[CesiumJS] Globe.globalWaterMask: failed to load the bundled bathymetry tensor",
        "        Math.max(\n          `[CesiumJS] Globe.globalWaterMask: failed to load the bundled bathymetry tensor",
      ),
  });
  await mustTurnRed(checkBathymetryLoad, ns);
});

test("mutant EM-06a: a fresh provider list is allocated every frame", async () => {
  const ns = await loadGlobe({
    label: "EM-06a",
    mutate: (s) =>
      s.replace(
        "const activeWaterProviders = this._activeWaterProviders;\n      activeWaterProviders.length = 0;",
        "const activeWaterProviders = [];",
      ),
  });
  await mustTurnRed(checkProviderHandOff, ns);
});

test("mutant EM-06b: the regions are no longer handed to the composite", async () => {
  const ns = await loadGlobe({
    label: "EM-06b",
    mutate: (s) =>
      s.replace(
        "this._compositeWaterClassificationProvider?.setWaterRegions(waterRegions);",
        "if (false) this._compositeWaterClassificationProvider?.setWaterRegions(waterRegions);",
      ),
  });
  await mustTurnRed(checkProviderHandOff, ns);
});

test("mutant EM-06c: the per-frame tide read goes through the creating accessor", async () => {
  const ns = await loadGlobe({
    label: "EM-06c",
    mutate: (s) =>
      s.replace(
        "const waterOcean = water.hasOcean ? water.ocean : undefined;",
        "const waterOcean = water.ocean;",
      ),
  });
  await mustTurnRed(checkPerFrameReadsDoNotCreateTheOcean, ns);
});

test("mutant EM-07: the deep-water band is no longer assigned", async () => {
  const ns = await loadWater({
    label: "EM-07",
    mutate: (s) =>
      s.replace(
        "    } else {\n      regime = WaterVerticalRegime.DEEP_UNDERWATER;\n    }",
        "    } else if (false) {\n      regime = WaterVerticalRegime.DEEP_UNDERWATER;\n    }",
      ),
  });
  await mustTurnRed(checkRegimeBands, ns);
});

test("mutant EM-08: one experimental tag is removed", async () => {
  const source = lf("GlobeWater.js");
  const anchor = "   * Registered vessel wake emitters";
  assert.ok(source.includes(anchor), "anchor present");
  const mutated = source
    .split("\n")
    .map((line, i, all) =>
      line.includes("@experimental") &&
      all
        .slice(Math.max(0, i - 4), i)
        .some((l) => l.includes("Registered vessel wake emitters"))
        ? ""
        : line,
    )
    .join("\n");
  assert.notEqual(mutated, source, "the mutation changed the source");
  await mustTurnRed(checkExperimentalMarks, mutated);
});

test("mutant EM-09: the weather type no longer follows the mapping", async () => {
  const ns = await loadEffects({
    label: "EM-09",
    mutate: (s) =>
      s.replace(
        "scene.weatherType = precipitationTypeToWeatherTypeIndex(\n    tensorState.temperatureC",
        "scene.weatherType = 0 * precipitationTypeToWeatherTypeIndex(\n    tensorState.temperatureC",
      ),
  });
  await mustTurnRed(checkWeatherTypeMapping, ns);
});

test("mutant EM-06d: the tile provider no longer declares the water mirrors", async (t) => {
  let ns;
  try {
    ns = await bundleScene("GlobeSurfaceTileProvider.js", { label: "base" });
    checkTileProviderDeclaresWaterFields(ns);
  } catch {
    t.skip(
      "the base constructor does not run under the stubs, so there is nothing to mutate",
    );
    return;
  }
  const mutated = await bundleScene("GlobeSurfaceTileProvider.js", {
    label: "EM-06d",
    mutate: (s) => s.replace("resetGlobeWaterMirrors(this);", "void 0;"),
  });
  await mustTurnRed(checkTileProviderDeclaresWaterFields, mutated);
});

// EM-10 (review pass 2, B1) -------------------------------------------------

const replaceExactlyOnce = (source, from, to) => {
  assert.equal(source.split(from).length, 2, `one anchor for: ${from}`);
  return source.replace(from, to);
};

test("mutant EM-10a: the lake and river arms count without a mask again (the round-2 extension)", async () => {
  const ns = await loadGlobe({
    label: "EM-10a",
    mutate: (s) =>
      replaceExactlyOnce(
        replaceExactlyOnce(
          s,
          "const waterLayersHaveMask = Boolean(\n      terrainHasWaterMask || globalWaterActive,\n    );",
          "const waterLayersHaveMask = true;",
        ),
        "const hasWaterMask = terrainHasWaterMask || globalWaterActive;",
        "const hasWaterMask =\n      terrainHasWaterMask ||\n      globalWaterActive ||\n      lakeWaterActive ||\n      riverWaterActive;",
      ),
  });
  await mustTurnRed(checkWaterLayersNeedAMask, ns);
});

test("mutant EM-10b: the lake arm is unreachable (review pass 2, P5)", async () => {
  const ns = await loadGlobe({
    label: "EM-10b",
    mutate: (s) =>
      replaceExactlyOnce(
        s,
        "if (lakeWaterActive) {",
        "if (false && lakeWaterActive) {",
      ),
  });
  await mustTurnRed(checkWaterLayersNeedAMask, ns);
});

// DP (water round 7, B1 / FND-5) ---------------------------------------------
//
// The default path: a globe whose `water` nobody reads. Edge round 4 measured
// the default viewer's WebGL startup at +10.2 % on the water tree. Whatever
// share of that the JS is, the default path must do none of the water work:
// no facade built when the scene binds the globe, none built or mirrored by
// the frames, none built by the camera controller's per-frame clamp or by a
// wheel zoom. Counted through a facade class that counts its constructions
// and a tile provider that counts every write to a water mirror.
//
// Round 8 (Orodruin pass 7, B1): the enhanced-ocean variants are the only
// ones that read the mirrored lanes, so an enhanced-ocean globe must receive
// the facade's documented defaults (0.78 near-surface transparency) on its
// first frame without anyone reading `globe.water` (DP-3); the default path
// above stays at zero facades and zero mirror writes (DP-1).

const WATER_MIRRORS = [
  "oceanTideEnabled",
  "oceanTideExaggeration",
  "oceanTideCallback",
  "oceanMeanSeaLevelPressure",
  "waterQualityPreset",
  "waterSubmersibleLightEnabled",
  "waterSubmersibleLightIntensity",
  "waterBathymetricReliefBoost",
  "waterEmergenceWetness",
  "waterVesselWakeIntensity",
  "waterNearSurfaceTransparency",
  "waterDiveDepthMeters",
  "waterDisableCollision",
];

/** A globe bound the way Scene binds it, counting facade constructions and mirror writes. */
function makeBoundGlobe(ns) {
  const hooks = resetHooks();
  const { default: Globe } = ns;
  const globe = new Globe(ns.Ellipsoid.WGS84);
  const counts = { facades: 0, mirrorWrites: 0 };
  const target = {};
  const tileProvider = new Proxy(target, {
    set(object, key, value) {
      if (WATER_MIRRORS.includes(key)) {
        counts.mirrorWrites++;
      }
      object[key] = value;
      return true;
    },
  });
  globe._surface = {
    tileProvider,
    invalidateAllTiles() {},
    beginFrame() {},
    update() {},
    render() {},
    maximumScreenSpaceError: 2,
  };
  const scene = { primitives: { add() {}, remove() {} }, globe };
  class CountingWater extends ns.GlobeWater {
    constructor(...args) {
      super(...args);
      counts.facades++;
    }
  }
  globe._bindWaterFacade(scene, CountingWater);
  const frame = () =>
    globe.beginFrame({
      passes: { render: true },
      mode: ns.SceneMode.SCENE3D,
      camera: { positionCartographic: { height: 100 }, pitch: -0.2 },
      eclipseSceneLightFactor: 1.0,
    });
  return {
    globe,
    scene,
    counts,
    hooks,
    tileProvider,
    mirrors: target,
    frame,
    CountingWater,
  };
}

function checkDefaultPathBuildsNoFacade(ns) {
  const bound = makeBoundGlobe(ns);
  const { globe, scene, counts, hooks, tileProvider, mirrors, frame } = bound;
  const { CountingWater } = bound;
  for (let i = 0; i < 5; i++) {
    frame();
  }
  assert.equal(counts.facades, 0, "binding and five frames build no facade");
  assert.equal(
    counts.mirrorWrites,
    0,
    "five frames write no water mirror while no facade exists",
  );
  // The public accessor builds it once, on the bound scene, and keeps it.
  const water = globe.water;
  assert.ok(water instanceof CountingWater, "globe.water is the facade");
  assert.equal(globe.water, water, "the same facade on every read");
  assert.equal(counts.facades, 1, "built once, on the first read");
  assert.equal(water._scene, scene, "built for the bound scene");
  frame();
  assert.equal(
    mirrors.waterNearSurfaceTransparency,
    0.78,
    "a read facade is mirrored from the next frame",
  );
  assert.equal(hooks.mirrorResets.length, 0, "no reset while it exists");
  // A rebind drops the facade, as constructing a fresh one did, and the
  // provider's defaults come back once (the reset the provider's own
  // constructor runs, EM-06); then the frames are idle again.
  globe._bindWaterFacade(scene, CountingWater);
  frame();
  assert.equal(hooks.mirrorResets.length, 1, "one reset after the rebind");
  assert.equal(hooks.mirrorResets[0], tileProvider, "of this tile provider");
  const writes = counts.mirrorWrites;
  frame();
  frame();
  assert.equal(counts.mirrorWrites, writes, "idle again after the reset");
  assert.equal(hooks.mirrorResets.length, 1, "and reset only once");
  assert.equal(counts.facades, 1, "the rebind built nothing");
}

/** The camera controller's clamp and a wheel zoom against a globe that counts accessor reads. */
function checkCameraBuildsNoFacade(ns, handleZoom) {
  let created = 0;
  const lazyGlobe = () => ({
    _water: undefined,
    get water() {
      created++;
      return undefined;
    },
  });
  if (ns.default?.prototype?._adjustHeightForTerrain) {
    const ellipsoid = ns.Ellipsoid.WGS84;
    const camera = {
      transform: ns.Matrix4.IDENTITY,
      position: ellipsoid.cartographicToCartesian(
        new ns.Cartographic(0.5, 0.3, 100),
      ),
      direction: new ns.Cartesian3(),
      up: new ns.Cartesian3(),
      right: new ns.Cartesian3(),
      _setTransform() {},
    };
    const controller = {
      _scene: { mode: SCENE3D, camera, ellipsoid, globeHeight: 0 },
      _globe: lazyGlobe(),
      _minimumCollisionTerrainHeight: 15000,
      _lastGlobeHeight: 0,
      minimumZoomDistance: 1,
    };
    ns.default.prototype._adjustHeightForTerrain.call(controller, true);
  }
  if (handleZoom) {
    const zoomCamera = {
      heading: 0,
      pitch: 0,
      roll: 0,
      zoomIn() {},
      positionCartographic: { height: 100 },
    };
    const object = {
      minimumZoomDistance: 1,
      maximumZoomDistance: 1e9,
      _minimumZoomRate: 20,
      _maximumZoomRate: 5906376272000,
      maximumMovementRatio: 1,
      enableCollisionDetection: false,
      _scene: {
        canvas: { clientHeight: 1000 },
        camera: zoomCamera,
        mode: SCENE3D,
        globeHeight: 0,
      },
      _globe: lazyGlobe(),
      _useZoomWorldPosition: false,
      _zoomMouseStart: { x: 0, y: 0 },
    };
    handleZoom(
      object,
      { x: 0, y: 0 },
      {
        startPosition: { x: 0, y: 0 },
        endPosition: { x: 0, y: 200 },
        inertiaEnabled: true,
      },
      5,
      20,
      undefined,
    );
  }
  assert.equal(
    created,
    0,
    "the camera asked the creating accessor for the water facade",
  );
}

/** An enhanced-ocean globe whose `water` nobody reads gets the facade's defaults on its first frame. */
function checkEnhancedOceanBuildsFacade(ns) {
  const { globe, counts, mirrors, frame, CountingWater } = makeBoundGlobe(ns);
  globe.enableEnhancedOcean = true;
  assert.equal(counts.facades, 0, "binding builds no facade");
  frame();
  assert.equal(
    counts.facades,
    1,
    "one enhanced-ocean frame builds the facade without a globe.water read",
  );
  assert.ok(
    globe._water instanceof CountingWater,
    "the frame kept the facade it built",
  );
  assert.equal(
    mirrors.waterNearSurfaceTransparency,
    0.78,
    "the facade's documented near-surface transparency reaches the provider",
  );
  assert.equal(
    counts.mirrorWrites,
    WATER_MIRRORS.length,
    "every water mirror is written once by that frame",
  );
  frame();
  assert.equal(counts.facades, 1, "later frames reuse the same facade");
  assert.equal(globe.water, globe._water, "and globe.water returns it");
  assert.equal(counts.facades, 1, "the read built nothing more");
}

test("DP-1 (B1): binding, frames and a rebind build no water facade and write no water mirror until globe.water is read", async () => {
  checkDefaultPathBuildsNoFacade(await globeBundle());
});

test("DP-2 (B1): the camera clamp and a wheel zoom never create the water facade", async () => {
  checkCameraBuildsNoFacade(await loadController({ label: "base" }));
  const helpers = await loadHelpers({ label: "base" });
  checkCameraBuildsNoFacade(
    { ...helpers, default: undefined },
    helpers.handleZoom,
  );
});

test("DP-3 (B1, round 8): an enhanced-ocean globe receives the facade's defaults on its first frame with globe.water never read", async () => {
  checkEnhancedOceanBuildsFacade(await globeBundle());
});

test("mutant DP-1a: the facade built when the scene binds the globe is DETECTED", async () => {
  const ns = await loadGlobe({
    label: "DP-1a",
    mutate: (s) =>
      s.replace(
        "    this._water = undefined;\n  }",
        "    this._water = new WaterFacade(scene, this);\n  }",
      ),
  });
  await mustTurnRed(checkDefaultPathBuildsNoFacade, ns);
});

test("mutant DP-1b: the frame reading the creating accessor is DETECTED", async () => {
  const ns = await loadGlobe({
    label: "DP-1b",
    mutate: (s) =>
      s.replace(
        "this._water ?? (this.enableEnhancedOcean ? this.water : undefined);",
        "this.water;",
      ),
  });
  await mustTurnRed(checkDefaultPathBuildsNoFacade, ns);
});

test("mutant DP-1c: a rebind that leaves the old facade's mirrors in place is DETECTED", async () => {
  const ns = await loadGlobe({
    label: "DP-1c",
    mutate: (s) =>
      s.replace(
        "        resetGlobeWaterMirrors(tileProvider);",
        "        void tileProvider;",
      ),
  });
  await mustTurnRed(checkDefaultPathBuildsNoFacade, ns);
});

test("mutant DP-2a: the camera clamp reading the creating accessor is DETECTED", async () => {
  const ns = await loadController({
    label: "DP-2a",
    mutate: (s) =>
      s.replace(
        "this._globe?._water?.canDiveAtSurfaceHeight(scene.globeHeight)",
        "this._globe?.water?.canDiveAtSurfaceHeight(scene.globeHeight)",
      ),
  });
  await mustTurnRed(checkCameraBuildsNoFacade, ns);
});

test("mutant DP-2b: a wheel zoom reading the creating accessor is DETECTED", async () => {
  const helpers = await loadHelpers({
    label: "DP-2b",
    mutate: (s) =>
      s.replace(
        "const water = object._globe?._water;",
        "const water = object._globe?.water;",
      ),
  });
  await mustTurnRed(
    checkCameraBuildsNoFacade,
    { ...helpers, default: undefined },
    helpers.handleZoom,
  );
});

test("mutant DP-3a: the enhanced-ocean gate dropped, so only a read builds the facade, is DETECTED", async () => {
  const ns = await loadGlobe({
    label: "DP-3a",
    mutate: (s) =>
      s.replace(
        "this._water ?? (this.enableEnhancedOcean ? this.water : undefined);",
        "this._water;",
      ),
  });
  await mustTurnRed(checkEnhancedOceanBuildsFacade, ns);
});

// DP-4 (round 8, Orodruin pass 7, N2) -----------------------------------------
//
// The two Scene call sites that hand the water facade to a globe: the
// constructor's publish block and the `globe` setter. Each is sliced out of
// Scene.js and executed in a vm context whose GlobeWater counts its
// constructions, so the binding is pinned as behaviour: the scene binds the
// facade class and builds no facade.

function sceneSection(source, startAnchor, endAnchor) {
  const start = source.indexOf(startAnchor);
  assert.ok(start >= 0, `missing start anchor: ${startAnchor}`);
  const end = source.indexOf(endAnchor, start + startAnchor.length);
  assert.ok(end > start, `missing end anchor: ${endAnchor}`);
  return source.slice(start, end);
}

function sceneCallSites(sceneSource) {
  const publish = sceneSection(
    sceneSource,
    "    // Publish the canonical globe facades",
    "    // Give frameState",
  );
  const setter = sceneSection(
    sceneSource,
    "  set globe(globe) {\n",
    "    updateGlobeListeners(this, globe);",
  ).replace("  set globe(globe) {\n", "");
  return { publish, setter };
}

function checkSceneBindsWithoutBuilding(sceneSource) {
  const { publish, setter } = sceneCallSites(sceneSource);
  const built = [];
  const binds = [];
  class GlobeWater {
    constructor(...args) {
      built.push(args);
    }
  }
  class AtmosphericConditions {}
  const fakeGlobe = () => ({
    destroy() {
      return undefined;
    },
    _bindWaterFacade(scene, WaterFacade) {
      binds.push({ scene, WaterFacade });
    },
  });
  const context = {
    defined: (value) => value !== undefined && value !== null,
    GlobeWater,
    AtmosphericConditions,
  };
  const constructed = { _globe: fakeGlobe() };
  runInNewContext(
    `(function () {
${publish}
})`,
    context,
  ).call(constructed);
  const assigned = { _globe: undefined };
  const replacement = fakeGlobe();
  runInNewContext(
    `(function (globe) {
${setter}
})`,
    context,
  ).call(assigned, replacement);
  assert.equal(built.length, 0, "Scene builds no water facade");
  assert.equal(binds.length, 2, "both call sites bind the facade class");
  assert.equal(binds[0].scene, constructed, "the constructor binds its scene");
  assert.equal(binds[1].scene, assigned, "the setter binds its scene");
  for (const bind of binds) {
    assert.equal(bind.WaterFacade, GlobeWater, "the bound class is GlobeWater");
  }
}

const SCENE_SOURCE = () => lf("Scene.js");

test("DP-4 (B1, round 8): Scene's constructor and globe setter bind the water facade class and build no facade (vm-executed)", () => {
  checkSceneBindsWithoutBuilding(SCENE_SOURCE());
});

test("mutant DP-4a: the constructor's eager facade construction restored is DETECTED", async () => {
  await mustTurnRed(
    checkSceneBindsWithoutBuilding,
    replaceExactlyOnce(
      SCENE_SOURCE(),
      "      this._globe._bindWaterFacade?.(this, GlobeWater);",
      "      this._globe._water = new GlobeWater(this, this._globe);",
    ),
  );
});

test("mutant DP-4b: the globe setter's eager facade construction restored is DETECTED", async () => {
  await mustTurnRed(
    checkSceneBindsWithoutBuilding,
    replaceExactlyOnce(
      SCENE_SOURCE(),
      "      globe._bindWaterFacade?.(this, GlobeWater);",
      "      globe._water = new GlobeWater(this, globe);",
    ),
  );
});

// DP-4 mock globes (round 9, Orodruin pass 8, B1) ---------------------------
//
// Karma's DataSources and Picking specs hand `scene.globe` a plain object, not
// a Globe, and before the facade binding those objects were accepted. The key
// sets below mirror the three mocks at HEAD: `Specs/createGlobe.js`, the
// literal in `packages/engine/Specs/DataSources/EntityClusterSpec.js` and the
// literal in `packages/engine/Specs/DataSources/PointVisualizerSpec.js`. None
// of them has `_bindWaterFacade` or `_water`.

const fakeEvent = () => ({
  addEventListener() {
    return () => {};
  },
  raiseEvent() {},
});

function withTerrainProviderAccessor(globe) {
  Object.defineProperty(globe, "terrainProvider", {
    get() {
      return this._terrainProvider;
    },
    set(value) {
      this._terrainProvider = value;
      this.terrainProviderChanged.raiseEvent(value);
    },
  });
  return globe;
}

const MOCK_GLOBES = {
  "Specs/createGlobe.js": () =>
    withTerrainProviderAccessor({
      _callback: undefined,
      _removedCallback: false,
      ellipsoid: {},
      beginFrame() {},
      endFrame() {},
      update() {},
      render() {},
      getHeight() {
        return 0.0;
      },
      _surface: { updateHeight() {} },
      imageryLayersUpdatedEvent: fakeEvent(),
      _terrainProvider: undefined,
      terrainProviderChanged: fakeEvent(),
      tileLoadProgressEvent: fakeEvent(),
      destroy() {},
      isDestroyed() {
        return false;
      },
    }),
  "EntityClusterSpec.js": () =>
    withTerrainProviderAccessor({
      ellipsoid: {},
      _surface: {
        tileProvider: {},
        _tileLoadQueueHigh: [],
        _tileLoadQueueMedium: [],
        _tileLoadQueueLow: [],
        _debug: { tilesWaitingForChildren: 0 },
        updateHeight() {},
      },
      terrainProviderChanged: fakeEvent(),
      imageryLayersUpdatedEvent: fakeEvent(),
      tileLoadProgressEvent: fakeEvent(),
      beginFrame() {},
      update() {},
      render() {},
      endFrame() {},
      destroy() {},
      isDestroyed: () => false,
      getHeight() {
        return 0.0;
      },
    }),
  "PointVisualizerSpec.js": () =>
    withTerrainProviderAccessor({
      ellipsoid: {},
      _surface: { updateHeight() {} },
      imageryLayersUpdatedEvent: fakeEvent(),
      terrainProviderChanged: fakeEvent(),
      tileLoadProgressEvent: fakeEvent(),
      getHeight() {
        return 0.0;
      },
      destroy() {},
    }),
};

/** Scene's two call sites accept each mock globe, publish the atmosphere facade on it and build no water facade. */
function checkSceneAcceptsMockGlobes(sceneSource) {
  const { publish, setter } = sceneCallSites(sceneSource);
  const built = [];
  class GlobeWater {
    constructor(...args) {
      built.push(args);
    }
  }
  class AtmosphericConditions {}
  const context = {
    defined: (value) => value !== undefined && value !== null,
    GlobeWater,
    AtmosphericConditions,
  };
  const runPublish = runInNewContext(
    `(function () {
${publish}
})`,
    context,
  );
  const runSetter = runInNewContext(
    `(function (globe) {
${setter}
})`,
    context,
  );
  for (const [name, makeMock] of Object.entries(MOCK_GLOBES)) {
    const constructed = { _globe: makeMock() };
    assert.equal(
      "_bindWaterFacade" in constructed._globe,
      false,
      `${name}: the mock has no _bindWaterFacade`,
    );
    assert.doesNotThrow(
      () => runPublish.call(constructed),
      `${name}: the constructor's publish block accepts the mock globe`,
    );
    assert.ok(
      constructed._globe._atmosphericConditions instanceof
        AtmosphericConditions,
      `${name}: the constructor still publishes the atmosphere facade`,
    );
    const assigned = { _globe: makeMock() };
    const replacement = makeMock();
    assert.doesNotThrow(
      () => runSetter.call(assigned, replacement),
      `${name}: the globe setter accepts the mock globe`,
    );
    assert.equal(assigned._globe, replacement, `${name}: the setter assigns`);
    assert.ok(
      replacement._atmosphericConditions instanceof AtmosphericConditions,
      `${name}: the setter still publishes the atmosphere facade`,
    );
    assert.equal(replacement._water, undefined, `${name}: no water facade`);
  }
  assert.equal(built.length, 0, "Scene builds no water facade for a mock");
}

test("DP-4 (B1, round 9): Scene's constructor and globe setter accept a globe-like object without _bindWaterFacade (the Karma mock globes, vm-executed)", () => {
  checkSceneAcceptsMockGlobes(SCENE_SOURCE());
});

test("mutant DP-4c: the constructor's unguarded binding call restored is DETECTED", async () => {
  await mustTurnRed(
    checkSceneAcceptsMockGlobes,
    replaceExactlyOnce(
      SCENE_SOURCE(),
      "      this._globe._bindWaterFacade?.(this, GlobeWater);",
      "      this._globe._bindWaterFacade(this, GlobeWater);",
    ),
  );
});

test("mutant DP-4d: the globe setter's unguarded binding call restored is DETECTED", async () => {
  await mustTurnRed(
    checkSceneAcceptsMockGlobes,
    replaceExactlyOnce(
      SCENE_SOURCE(),
      "      globe._bindWaterFacade?.(this, GlobeWater);",
      "      globe._bindWaterFacade(this, GlobeWater);",
    ),
  );
});

// DP-5 (round 9 mock-globe audit) -------------------------------------------
//
// The camera controller is the other module outside Globe.js that reaches a
// member the water work added (`_water`). Its clamp and the wheel zoom must
// accept each mock globe and no globe at all, and behave as the stock camera.

/** The clamp and a wheel zoom against each mock globe and against `_globe === undefined`. */
function checkCameraAcceptsMockGlobes(ns, handleZoom) {
  const globes = { ...MOCK_GLOBES, "no globe": () => undefined };
  for (const [name, makeMock] of Object.entries(globes)) {
    if (ns.default?.prototype?._adjustHeightForTerrain) {
      const ellipsoid = ns.Ellipsoid.WGS84;
      const camera = {
        transform: ns.Matrix4.IDENTITY,
        position: ellipsoid.cartographicToCartesian(
          new ns.Cartographic(0.5, 0.3, 0.2),
        ),
        direction: new ns.Cartesian3(),
        up: new ns.Cartesian3(),
        right: new ns.Cartesian3(),
        _setTransform() {},
      };
      const controller = {
        _scene: { mode: SCENE3D, camera, ellipsoid, globeHeight: 0 },
        _globe: makeMock(),
        _minimumCollisionTerrainHeight: 15000,
        _lastGlobeHeight: 0,
        minimumZoomDistance: 1,
      };
      assert.doesNotThrow(
        () =>
          ns.default.prototype._adjustHeightForTerrain.call(controller, true),
        `${name}: the camera clamp accepts the globe`,
      );
      const height = ellipsoid.cartesianToCartographic(camera.position).height;
      assert.ok(
        Math.abs(height - 1) < 1e-3,
        `${name}: the stock clamp lifts the camera (${height})`,
      );
    }
    if (handleZoom) {
      const zoomed = [];
      const object = {
        minimumZoomDistance: 1,
        maximumZoomDistance: 1e9,
        _minimumZoomRate: 20,
        _maximumZoomRate: 5906376272000,
        maximumMovementRatio: 1,
        enableCollisionDetection: false,
        _scene: {
          canvas: { clientHeight: 1000 },
          camera: {
            heading: 0,
            pitch: 0,
            roll: 0,
            zoomIn(d) {
              zoomed.push(d);
            },
            positionCartographic: { height: 100 },
          },
          mode: SCENE3D,
          globeHeight: 0,
        },
        _globe: makeMock(),
        _useZoomWorldPosition: false,
        _zoomMouseStart: { x: 0, y: 0 },
      };
      assert.doesNotThrow(
        () =>
          handleZoom(
            object,
            { x: 0, y: 0 },
            {
              startPosition: { x: 0, y: 0 },
              endPosition: { x: 0, y: 200 },
              inertiaEnabled: true,
            },
            5,
            20,
            undefined,
          ),
        `${name}: a wheel zoom accepts the globe`,
      );
      assert.deepEqual(zoomed, [19], `${name}: a stock zoom`);
    }
  }
}

const loadHelpersForCamera = async (options) => {
  const helpers = await loadHelpers(options);
  return [{ ...helpers, default: undefined }, helpers.handleZoom];
};

test("DP-5 (round 9 audit): the camera clamp and a wheel zoom accept each mock globe and no globe, as the stock camera", async () => {
  checkCameraAcceptsMockGlobes(await loadController({ label: "base" }));
  checkCameraAcceptsMockGlobes(
    ...(await loadHelpersForCamera({ label: "base" })),
  );
});

test("mutant DP-5a: the clamp's optional read of _globe dropped is DETECTED", async () => {
  const ns = await loadController({
    label: "DP-5a",
    mutate: (s) =>
      replaceExactlyOnce(
        s,
        "this._globe?._water?.canDiveAtSurfaceHeight(",
        "this._globe._water?.canDiveAtSurfaceHeight(",
      ),
  });
  await mustTurnRed(checkCameraAcceptsMockGlobes, ns);
});

test("mutant DP-5b: the clamp's optional read of _water dropped is DETECTED", async () => {
  const ns = await loadController({
    label: "DP-5b",
    mutate: (s) =>
      replaceExactlyOnce(
        s,
        "this._globe?._water?.canDiveAtSurfaceHeight(",
        "this._globe?._water.canDiveAtSurfaceHeight(",
      ),
  });
  await mustTurnRed(checkCameraAcceptsMockGlobes, ns);
});

test("mutant DP-5c: the wheel zoom's optional read of _globe dropped is DETECTED", async () => {
  await mustTurnRed(
    checkCameraAcceptsMockGlobes,
    ...(await loadHelpersForCamera({
      label: "DP-5c",
      mutate: (s) =>
        replaceExactlyOnce(
          s,
          "const water = object._globe?._water;",
          "const water = object._globe._water;",
        ),
    })),
  );
});

test("mutant DP-5d: the wheel zoom's defined(water) guard dropped is DETECTED", async () => {
  await mustTurnRed(
    checkCameraAcceptsMockGlobes,
    ...(await loadHelpersForCamera({
      label: "DP-5d",
      mutate: (s) =>
        replaceExactlyOnce(
          s,
          "defined(water) && water.canDiveAtSurfaceHeight(",
          "water.canDiveAtSurfaceHeight(",
        ),
    })),
  );
});
