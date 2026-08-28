// scene-derived-lighting-seam.spec.mjs
// @purpose Pins the atmosphere-derived scene lighting to the renderer seam: the shared scene code publishes one light for every backend, and the derived override reproduces the arithmetic it replaced.
// @status ACTIVE
//
// Two things are pinned here, and they fail for different reasons:
//
//   - THE ARITHMETIC. The derived sun colour, sun intensity and sky
//     irradiance are compared against values captured from the PREVIOUS
//     implementation, before the override moved behind the seam. They are
//     literals below, not recomputed from the module under test, so a change
//     in the maths cannot quietly re-bless itself.
//
//   - THE SEAM. The shared scene code must publish `frameState.light` without
//     asking which backend is running. A backend opts into the derived light
//     by registering an alternate scene renderer; a backend that registers
//     none must see the scene's own light, unchanged, for every input.
//
// Run: node --test Tools/visual-regression/scene-derived-lighting-seam.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const engineSource = path.join(root, "packages/engine/Source");
const engineOverlay = process.env.CESIUM_ENGINE_SOURCE_OVERLAY
  ? path.resolve(process.env.CESIUM_ENGINE_SOURCE_OVERLAY)
  : undefined;
const enginePath = (p) => {
  if (engineOverlay) {
    const candidate = path.join(engineOverlay, p);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return path.join(engineSource, p);
};
const readEngine = (p) => fs.readFileSync(enginePath(p), "utf8");
const importEngine = (p) => import(pathToFileURL(enginePath(p)).href);

// Captured from the implementation that lived inline in the scene's frame-state
// update, BEFORE it moved behind the renderer seam. Any drift here is a change
// in rendered lighting, not a refactor.
const GOLDENS = [
  {
    name: "noon-equator",
    sunDirection: [1, 0, 0],
    cameraPosition: [6378137, 0, 0],
    altitude: 0,
    lightIntensity: 50,
    baseIntensity: 2,
    sunColor: [1, 0.9398695329445353, 0.8695854438385677],
    sunIntensity: 1.8956340148641775,
    skyIrradiance: [0.19850446428571428, 0.21691964285714285, 0.24],
  },
  {
    name: "dawn-equator",
    sunDirection: [0.05, 0, 0.9987],
    cameraPosition: [6378137, 0, 0],
    altitude: 0,
    lightIntensity: 50,
    baseIntensity: 2,
    sunColor: [1, 0.3868128772597088, 0.11762566214350467],
    sunIntensity: 0.2761994641168958,
    skyIrradiance: [
      0.09140266321768097, 0.09876882517273745, 0.1080010814897416,
    ],
  },
  {
    name: "below-horizon",
    sunDirection: [-0.5, 0, 0.866],
    cameraPosition: [6378137, 0, 0],
    altitude: 0,
    lightIntensity: 50,
    baseIntensity: 2,
    sunColor: [1, 0.7154658367024932, 0.4702624735874569],
    sunIntensity: 0,
    skyIrradiance: [0.027140178571428572, 0.027876785714285715, 0.0288],
  },
  {
    name: "high-altitude",
    sunDirection: [1, 0, 0],
    cameraPosition: [6478137, 0, 0],
    altitude: 100000,
    lightIntensity: 50,
    baseIntensity: 2,
    sunColor: [1, 0.999999640360018, 0.999999189611423],
    sunIntensity: 1.999999472528001,
    skyIrradiance: [0.19850446428571428, 0.21691964285714285, 0.24],
  },
  {
    name: "polar-lowsun",
    sunDirection: [0, 0.2, 0.9798],
    cameraPosition: [0, 0, 6356752],
    altitude: 0,
    lightIntensity: 50,
    baseIntensity: 2,
    sunColor: [1, 0.9386706474615407, 0.8670879721716643],
    sunIntensity: 1.8935333894879203,
    skyIrradiance: [0.19850446428571428, 0.21691964285714285, 0.24],
  },
  {
    name: "custom-intensities",
    sunDirection: [0.7071, 0, 0.7071],
    cameraPosition: [6378137, 0, 0],
    altitude: 1000,
    lightIntensity: 12.5,
    baseIntensity: 5.5,
    sunColor: [1, 0.9250249611036989, 0.8389429815937793],
    sunIntensity: 5.167789149110287,
    skyIrradiance: [0.19850446428571428, 0.21691964285714285, 0.24],
  },
];

async function loadModules() {
  const [{ applySceneAtmosphereDerivedLighting }, Cartesian3, SunLight] =
    await Promise.all([
      importEngine("Scene/AtmosphereDerivedLighting.js"),
      importEngine("Core/Cartesian3.js").then((m) => m.default),
      importEngine("Scene/SunLight.js").then((m) => m.default),
    ]);
  return { applySceneAtmosphereDerivedLighting, Cartesian3, SunLight };
}

function makeScene({ Cartesian3, SunLight }, golden, overrides = {}) {
  const light = new SunLight();
  light.intensity = golden.baseIntensity;
  return {
    aerialPerspective: true,
    light,
    camera: {
      positionWC: new Cartesian3(...golden.cameraPosition),
      positionCartographic: { height: golden.altitude },
    },
    skyAtmosphere: { atmosphereLightIntensity: golden.lightIntensity },
    _context: {
      uniformState: {
        sunDirectionWC: new Cartesian3(...golden.sunDirection),
      },
    },
    _atmosphereDerivedLight: new SunLight(),
    _atmosphereSkyIrradiance: new Cartesian3(0.2, 0.2, 0.2),
    ...overrides,
  };
}

// A frame state as the scene publishes it: its own light, no derived ambient.
function makeFrameState(scene) {
  return { light: scene.light, atmosphereSkyIrradiance: undefined };
}

test("derived lighting reproduces the pre-seam arithmetic exactly", async () => {
  const mods = await loadModules();
  for (const golden of GOLDENS) {
    const scene = makeScene(mods, golden);
    const frameState = makeFrameState(scene);

    const applied = mods.applySceneAtmosphereDerivedLighting(scene, frameState);
    assert.equal(applied, true, `${golden.name} should apply`);

    const light = frameState.light;
    assert.equal(
      light,
      scene._atmosphereDerivedLight,
      `${golden.name}: the derived light must be the reused scratch light`,
    );
    assert.deepEqual(
      [light.color.red, light.color.green, light.color.blue],
      golden.sunColor,
      `${golden.name}: sun colour drifted from the pre-seam value`,
    );
    assert.equal(
      light.color.alpha,
      1.0,
      `${golden.name}: derived light alpha must stay opaque`,
    );
    assert.equal(
      light.intensity,
      golden.sunIntensity,
      `${golden.name}: sun intensity drifted from the pre-seam value`,
    );

    const ambient = frameState.atmosphereSkyIrradiance;
    assert.equal(
      ambient,
      scene._atmosphereSkyIrradiance,
      `${golden.name}: the ambient must be the reused scratch vector`,
    );
    assert.deepEqual(
      [ambient.x, ambient.y, ambient.z],
      golden.skyIrradiance,
      `${golden.name}: sky irradiance drifted from the pre-seam value`,
    );
  }
});

test("the scratch light and ambient are reused, never reallocated", async () => {
  const mods = await loadModules();
  const golden = GOLDENS[0];
  const scene = makeScene(mods, golden);
  const frameState = makeFrameState(scene);

  mods.applySceneAtmosphereDerivedLighting(scene, frameState);
  const firstLight = frameState.light;
  const firstAmbient = frameState.atmosphereSkyIrradiance;

  const second = makeFrameState(scene);
  mods.applySceneAtmosphereDerivedLighting(scene, second);

  assert.equal(second.light, firstLight, "a frame must not allocate a light");
  assert.equal(
    second.atmosphereSkyIrradiance,
    firstAmbient,
    "a frame must not allocate an ambient vector",
  );
});

test("outside its domain the derivation leaves the frame state untouched", async () => {
  const mods = await loadModules();
  const golden = GOLDENS[0];

  const cases = [
    ["aerial perspective off", { aerialPerspective: false }],
    ["aerial perspective unset", { aerialPerspective: undefined }],
    [
      "a custom, non-sun light",
      {
        light: { color: { red: 1, green: 1, blue: 1, alpha: 1 }, intensity: 3 },
      },
    ],
    ["no sun direction", { _context: { uniformState: {} } }],
    ["no uniform state", { _context: {} }],
    ["no context", { _context: undefined }],
    ["no camera position", { camera: { positionCartographic: { height: 0 } } }],
    ["no camera", { camera: undefined }],
  ];

  for (const [label, overrides] of cases) {
    const scene = makeScene(mods, golden, overrides);
    const frameState = makeFrameState(scene);
    const sceneLight = scene.light;

    const applied = mods.applySceneAtmosphereDerivedLighting(scene, frameState);

    assert.equal(applied, false, `${label}: must report no application`);
    assert.equal(
      frameState.light,
      sceneLight,
      `${label}: the scene's own light must survive`,
    );
    assert.equal(
      frameState.atmosphereSkyIrradiance,
      undefined,
      `${label}: no derived ambient may be published`,
    );
  }
});

// The seam itself. A backend that registers no alternate scene renderer must
// never reach the derivation — which is a property of the CALL SITE, so it is
// checked against the shared scene source rather than by running it. Standing
// up a real scene needs a GPU, so this is a reachability argument, not a
// behavioural one, and is written to fail loudly if the call site regains a
// backend test or loses its optional guards.
test("shared scene code publishes one light without asking the backend", () => {
  const scene = readEngine("Scene/Scene.js").replace(/\r\n/g, "\n");

  const updateFrameState = scene.slice(scene.indexOf("  updateFrameState() {"));
  assert.ok(
    updateFrameState.startsWith("  updateFrameState() {"),
    "updateFrameState must still exist to be checked",
  );
  const body = updateFrameState.slice(
    0,
    updateFrameState.indexOf("\n  }\n") + 1,
  );

  assert.ok(
    !/this\.isWebGPU/.test(body),
    "frame-state setup must not branch on the backend",
  );
  assert.ok(
    /frameState\.light = this\.light;/.test(body),
    "the scene must publish its own light for every backend",
  );
  assert.ok(
    /this\._alternateSceneRenderer\?\.updateDerivedLighting\?\.\(\s*this,\s*frameState,?\s*\)/.test(
      body,
    ),
    "the derived light must be offered through the optional renderer seam, " +
      "guarded on both the renderer and the method",
  );
});

test("the derivation is reachable only from a backend renderer", () => {
  const callers = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
      } else if (/\.(js|ts)$/.test(entry.name)) {
        const src = fs.readFileSync(p, "utf8");
        if (
          src.includes("applySceneAtmosphereDerivedLighting") &&
          !p.endsWith(path.join("Scene", "AtmosphereDerivedLighting.js"))
        ) {
          callers.push(path.relative(engineSource, p).replace(/\\/g, "/"));
        }
      }
    }
  };
  walk(engineSource);

  assert.ok(callers.length > 0, "the derivation must have a caller");
  for (const caller of callers) {
    assert.ok(
      caller.startsWith("Renderer/"),
      `${caller} imports the derived lighting; only renderer code may, or a ` +
        `backend without a scene renderer would see a changed light`,
    );
  }
});
