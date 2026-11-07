// landing-weather-dial-cells.spec.mjs - the landing cells for the four WebGPU-only weather dials and their weather-on variants.
//
// @purpose Node spec for the landing cells E-WX-workers, E-WX-interpolation, E-WX-vertical, E-WX-populations, E-ON-<family>-wx, E-T-wx and E-LL-wx: each rig is its dial-off twin plus exactly its dial (and what its header says), the cells plan onto their rigs and pages, a fake-browser run of the real probe stages every page through the REAL page stager, harness and CloudVolumetrics so each dial reads back from the instance, an instance lacking a dial makes the stage report the key and the cell NOT RUN with no capture, the stage payload of every base rig is byte-identical to the banked fixture, the populations-on frame is judged against the populations-off frame by the pre-registered coverage rule as a cross-page verdict (FAIL on a black deck, PASS on a bright one, UNMEASURED on an empty single layer), the transition owner is read in the page census, and the E-T clock step runs before the terminal action; with inertness mutants for the payload identity, the variant overlay, the verdict wiring, the FAIL branch, the owner check and the clock step.
// @status ACTIVE
//
// The only thing the fake browser stands in for is the page: the stager
// (`stageLandingCellInPage`), the cloud probe harness and `CloudVolumetrics`
// run as written against the fake Cesium module and a fake viewer, so every
// read-back is the harness reading the instance, never a canned answer. The
// fake page never answers the quantity under test: it returns the frames and
// the census the spec gives it, and nothing it was not given.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import CloudVolumetrics from "../../packages/engine/Source/Scene/CloudVolumetrics.js";
import { mkLaneTmp, removeLaneTmp } from "../lib/lane-tmp.mjs";
import { encodeRgbaPng } from "../lib/png-rgba.mjs";
import {
  FAKE_CESIUM_URL,
  createFakeViewer,
} from "./fixtures/landing-cell-stage-support.mjs";
import { landingRunners } from "./fixtures/probe-landing-cells-support.mjs";
import { installCloudProbeHarness } from "./lib/cloud-probe-harness.mjs";
import { cloudRigStagePayload } from "./lib/cloud-rig-stage.mjs";
import { runDeviceLossSteps } from "./lib/device-loss-steps.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import { makeFakeBrowser } from "./lib/landing-fake-browser.mjs";
import { readCellInitRecords } from "./lib/landing-init-scripts.mjs";
import * as stageModule from "./lib/landing-cell-stage.mjs";
import {
  CLOUD_LAYOUT_LABELS,
  DEFAULT_CELLS,
  LANDING_CELLS,
  WEATHER_TRANSITION_OWNER_LABELS,
  planLandingCells,
  rigForPage,
} from "./lib/landing-cell-table.mjs";
import {
  crossPageVerdicts,
  weatherDialComparisons,
} from "./lib/metrics/landing-cross-page.mjs";
import { loadRigs, rigById, validateRig } from "./lib/rig-registry.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const lib = (name) => path.join(here, "lib", name);
const PROBE_MODULE = path.join(here, "probe-landing-cells.mjs");
const STAGE_MODULE = lib("landing-cell-stage.mjs");
const CLOUD_STAGE_MODULE = lib("cloud-rig-stage.mjs");
const TABLE_MODULE = lib("landing-cell-table.mjs");
const CROSS_PAGE_MODULE = lib("metrics/landing-cross-page.mjs");
const DEVICE_LOSS_MODULE = lib("device-loss-steps.mjs");
const DECK_MODULE = lib("metrics/deck-coverage.mjs");
const INIT_SCRIPTS_MODULE = lib("landing-init-scripts.mjs");
const FIXTURE = path.join(
  here,
  "fixtures",
  "cloud-rig-stage-payloads.base.json",
);

let tempRoot;
before(() => {
  tempRoot = mkLaneTmp("landing-wx-");
});
after(() => {
  removeLaneTmp(tempRoot);
});
const { p14Run } = landingRunners(() => tempRoot);

const rigs = await loadRigs();
const rigsById = new Map(rigs.map((rig) => [rig.id, rig]));
const get = (id) => rigById(rigs, id);

// ---------------------------------------------------------------------------
// The twins: each new rig, the dial-off rig it copies, and exactly what differs.
// ---------------------------------------------------------------------------

const W3 = "w3-ew-ground";
const EG = "cloud-underside-noon-cov055";
const FLIGHT = "cloud-flight-multideck-hdr-1080p";
const W4_UNION = [
  "cloudSpatialOccupancy",
  "cloudWeatherVolumeBounds",
  "cloudDensityCache",
  "cloudPrimaryDensityCache",
  "cloudDeepShadowCache",
  "cloudDirectionalLighting",
  "cloudContributionLighting",
];
const IDENTITY = ["declaredBy", "description", "id"];

/**
 * `dials`: the dials the rig sets that its twin does not, or sets otherwise.
 * `keys`: the top-level fields beyond the identity text that differ.
 * `paths`: the stage payload paths that differ from the twin's payload.
 */
const TWINS = Object.freeze({
  "cloud-wx-workers": {
    twin: W3,
    keys: ["dials"],
    dials: { cloudWeatherWorkers: true },
    paths: ["volumetric.cloudWeatherWorkers"],
  },
  "cloud-wx-interpolation": {
    twin: W3,
    keys: ["dials"],
    dials: {
      cloudWeatherInterpolation: true,
      clockSteps: ["2026-06-21T18:10:15Z"],
      settleFramesPerStep: 240,
    },
    paths: ["volumetric.cloudWeatherInterpolation", "stepDials"],
  },
  "cloud-wx-vertical": {
    twin: W3,
    keys: ["dials"],
    dials: { cloudVerticalWeather: true },
    paths: ["volumetric.cloudVerticalWeather"],
  },
  "cloud-wx-populations": {
    twin: EG,
    keys: ["camera", "dials", "experimental", "readiness"],
    dials: { cloudWeatherMap: true },
    paths: [
      "camera.pitch",
      "volumetric.cloudWeatherMap",
      "experimental.cloudIndependentWeatherLayers",
    ],
  },
  "cloud-eon-occupancy-wx": {
    twin: "cloud-eon-occupancy",
    keys: ["dials", "readiness"],
    dials: { cloudWeatherMap: true },
    paths: ["volumetric.cloudWeatherMap"],
  },
  "cloud-eon-density-wx": {
    twin: "cloud-eon-density",
    keys: ["dials", "readiness"],
    dials: { cloudWeatherMap: true },
    paths: ["volumetric.cloudWeatherMap"],
  },
  "cloud-eon-shadow-wx": {
    twin: "cloud-eon-shadow",
    keys: ["dials", "readiness"],
    dials: { cloudWeatherMap: true },
    paths: ["volumetric.cloudWeatherMap"],
  },
  "cloud-eon-lighting-wx": {
    twin: "cloud-eon-lighting",
    keys: ["dials", "readiness"],
    dials: { cloudWeatherMap: true },
    paths: ["volumetric.cloudWeatherMap"],
  },
  "cloud-flight-multideck-hdr-1080p-wx": {
    twin: FLIGHT,
    keys: ["dials", "experimental"],
    dials: {
      cloudWeatherMap: true,
      cloudWeatherWorkers: true,
      cloudWeatherInterpolation: true,
      cloudVerticalWeather: true,
      clockSteps: ["2026-06-21T21:50:15Z"],
      settleFramesPerStep: 240,
    },
    paths: [
      "volumetric.cloudWeatherMap",
      "volumetric.cloudWeatherWorkers",
      "volumetric.cloudWeatherInterpolation",
      "volumetric.cloudVerticalWeather",
      "stepDials",
      "experimental.cloudIndependentWeatherLayers",
    ],
  },
  "cloud-wx-all-dials": {
    twin: EG,
    keys: ["dials", "experimental", "readiness"],
    dials: {
      cloudWeatherMap: true,
      cloudWeatherWorkers: true,
      cloudWeatherInterpolation: true,
      cloudVerticalWeather: true,
    },
    paths: [
      "volumetric.cloudWeatherMap",
      "volumetric.cloudWeatherWorkers",
      "volumetric.cloudWeatherInterpolation",
      "volumetric.cloudVerticalWeather",
      ...[...W4_UNION, "cloudIndependentWeatherLayers"].map(
        (dial) => `experimental.${dial}`,
      ),
    ],
  },
});

const differingKeys = (a, b) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]))
    .sort();

/** The dials `rig` sets that `twin` does not, or sets to another value. */
function dialsBeyond(rig, twin) {
  return Object.fromEntries(
    differingKeys(rig.dials, twin.dials).map((key) => [key, rig.dials[key]]),
  );
}

/** Paths of the plain-object leaves of `value` (arrays are leaves). */
function leaves(value, prefix = "", out = new Map()) {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0
  ) {
    for (const [key, child] of Object.entries(value)) {
      leaves(child, prefix === "" ? key : `${prefix}.${key}`, out);
    }
  } else {
    out.set(prefix, JSON.stringify(value));
  }
  return out;
}

/** The sorted leaf paths at which two payloads differ (`rigId` excluded). */
function changedPaths(a, b) {
  const left = leaves({ ...a, rigId: undefined });
  const right = leaves({ ...b, rigId: undefined });
  return [...new Set([...left.keys(), ...right.keys()])]
    .filter((key) => left.get(key) !== right.get(key))
    .filter((key) => key !== "rigId")
    .sort();
}

// ---------------------------------------------------------------------------
// Helpers: a real CloudVolumetrics behind the real harness and stager.
// ---------------------------------------------------------------------------

/**
 * The page function a clock step reads after each step (`lib/clock-steps.mjs`):
 * the base fake does not know it. It answers a frame number and no sun, which
 * no assertion here reads.
 */
const SUN_STATE = Object.freeze({ frameNumber: 1, sunDirectionWC: null });

/** A fake viewer whose cloud collection carries `volumetric`. */
function cloudViewer(volumetric) {
  const viewer = createFakeViewer();
  viewer.scene.globe.defaultCloudCollection = {
    enableVolumetric: false,
    renderMode: 0,
    volumetric,
  };
  return viewer;
}

/** Run `body` with `viewer` as the page's viewer and the real harness installed. */
async function withRealHarness(viewer, body) {
  globalThis.viewer = viewer;
  try {
    installCloudProbeHarness();
    return await body();
  } finally {
    delete globalThis.__cloudProbe;
    delete globalThis.viewer;
  }
}

/**
 * Wrap a fake browser so its pages run `stageLandingCellInPage` for real: the
 * function the probe handed to `page.evaluate`, the real harness and a real
 * `CloudVolumetrics`. Every other page function stays the base fake's. What
 * the probe sent and the instance each page staged are logged in `seen`.
 */
function withRealStage(seen, makeVolumetric = () => new CloudVolumetrics()) {
  return (browser) => ({
    isConnected: () => browser.isConnected(),
    close: () => browser.close(),
    async newContext(options) {
      const context = await browser.newContext(options);
      return {
        ...context,
        async newPage() {
          const page = await context.newPage();
          return {
            ...page,
            async evaluate(fn, arg) {
              if (fn.name === "pageReadSunState") {
                return SUN_STATE;
              }
              if (fn.name !== "stageLandingCellInPage") {
                return page.evaluate(fn, arg);
              }
              const volumetric = makeVolumetric();
              seen.push({ payload: arg, volumetric });
              return withRealHarness(cloudViewer(volumetric), () =>
                fn({ ...arg, moduleUrl: FAKE_CESIUM_URL }),
              );
            },
          };
        },
      };
    },
  });
}

/** A copy of a real instance with `key` removed from the object the page sees. */
function volumetricWithout(key) {
  const real = new CloudVolumetrics();
  const lacking = {};
  for (const name of Object.getOwnPropertyNames(real)) {
    if (name !== key) {
      Object.defineProperty(
        lacking,
        name,
        Object.getOwnPropertyDescriptor(real, name),
      );
    }
  }
  return lacking;
}

/** A real instance whose experimental namespace lacks `key`. */
function volumetricWithoutExperimental(key) {
  const real = new CloudVolumetrics();
  const experimental = {};
  for (const name of Object.keys(real.experimental)) {
    if (name !== key) {
      Object.defineProperty(
        experimental,
        name,
        Object.getOwnPropertyDescriptor(real.experimental, name),
      );
    }
  }
  const lacking = {};
  for (const name of Object.getOwnPropertyNames(real)) {
    if (name !== "experimental") {
      Object.defineProperty(
        lacking,
        name,
        Object.getOwnPropertyDescriptor(real, name),
      );
    }
  }
  lacking.experimental = experimental;
  return lacking;
}

const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");

/** sha256 of the payload JSON, or `throws:<code>`, as the banked fixture records. */
function payloadHash(build, rig) {
  try {
    return sha(JSON.stringify(build(rig)));
  } catch (error) {
    return `throws:${error.reason ?? error.name}`;
  }
}

/** A solid RGBA PNG. */
function solidPng(rgb, width = 16, height = 16) {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    pixels.set([...rgb, 255], i * 4);
  }
  return Buffer.from(encodeRgbaPng(pixels, width, height));
}

const OWNER = WEATHER_TRANSITION_OWNER_LABELS[0];

/** The owners E-T-wx's --owner-labels names, and the file that labels each. */
const ET_WX_OWNERS = Object.freeze([
  [OWNER, "WebGPUCloudWeatherTransition.ts"],
  ["Cloud geographic material flow", "WebGPUCloudMaterialFlow.ts"],
  ["WeatherMap", "WebGPUProceduralCloudRenderer.ts"],
]);
const ET_WX_OWNER_LABELS = ET_WX_OWNERS.map(([label]) => label);

const BRIGHT_PNG = solidPng([200, 200, 200]);
const BLACK_PNG = solidPng([0, 0, 0]);

/**
 * The page world the engagement read sees (`engagementWorld` of the fake
 * browser): the engine's request flags as a real page holds them. `populations`
 * is the populations flag, a function of whether the staged page's dial is on
 * (the truthful default: the engine requests the march when the dial is on),
 * a boolean, or `null` for a cache without the field; `vertical` and
 * `workers` are booleans or `null`.
 */
const worldOf =
  ({ populations = (dial) => dial, vertical = true, workers = true } = {}) =>
  ({ payload }) => {
    const dial = payload?.experimental?.cloudIndependentWeatherLayers === true;
    const populationsFlag =
      typeof populations === "function" ? populations(dial) : populations;
    const cache = {};
    if (populationsFlag !== null) {
      cache.weatherPopulationsRequested = populationsFlag;
    }
    if (vertical !== null) {
      cache.weatherVerticalRequested = vertical;
    }
    return {
      viewer: {
        scene: {
          context: { _cloudCache: cache },
          globe: {
            defaultCloudCollection: {
              _weatherState: {
                _owned: workers === null ? {} : { useWorkers: workers },
              },
            },
          },
        },
      },
    };
  };

/** An engine that engages every feature its dials ask for. */
const ENGAGED = worldOf();

/** The census a page answers when one weather worker was created. */
const WEATHER_WORKER_CENSUS = Object.freeze({
  installed: true,
  workers: [
    {
      weather: true,
      blob: false,
      url: "http://localhost:8094/Build/Workers/createCloudWeather.js",
      attributedBy: "url",
      type: "module",
      terminateCalls: 0,
    },
  ],
  failed: [],
});

/** A fake-browser wrapper whose pages answer the weather-worker census with `census`. */
const withWorkerCensus = (census) => (browser) => ({
  isConnected: () => browser.isConnected(),
  close: () => browser.close(),
  async newContext(options) {
    const context = await browser.newContext(options);
    return {
      ...context,
      async newPage() {
        const page = await context.newPage();
        return {
          ...page,
          async evaluate(fn, arg) {
            return fn.name === "pageReadWorkerCensus"
              ? census
              : page.evaluate(fn, arg);
          },
        };
      },
    };
  },
});

/**
 * The mutant must be caught by the behaviour assertion itself: the unmutated
 * module passes `behaviour` first (so a red is the mutant's), then the same
 * `behaviour` run against the mutant throws an AssertionError. A TypeError or
 * any other failure is not a red by behaviour.
 */
async function assertRed(behaviour, real, mutated) {
  await behaviour(real);
  await assert.rejects(
    async () => behaviour(mutated),
    (error) => error instanceof assert.AssertionError,
  );
}

// ---------------------------------------------------------------------------
// (a) The rigs.
// ---------------------------------------------------------------------------

for (const [id, expected] of Object.entries(TWINS)) {
  test(`a: ${id} is ${expected.twin} plus exactly ${Object.keys(expected.dials).join(", ")}, and is valid`, () => {
    const rig = get(id);
    const twin = get(expected.twin);
    assert.ok(rig, `${id} is registered`);
    assert.ok(twin, `${expected.twin} is registered`);
    assert.equal(rigs.filter((entry) => entry.id === id).length, 1);
    assert.deepEqual(validateRig(rig), []);
    assert.equal(Object.isFrozen(rig), true);
    assert.deepEqual(
      differingKeys(rig, twin),
      [...IDENTITY, ...expected.keys].sort(),
    );
    assert.deepEqual(dialsBeyond(rig, twin), expected.dials);
    assert.deepEqual(rig.tags, twin.tags);
    assert.deepEqual(rig.renderers, twin.renderers);
    assert.deepEqual(rig.viewport, twin.viewport);
    assert.equal(rig.clock, twin.clock);
    assert.equal(rig.page, twin.page);
    assert.equal(rig.declaredBy.split(" ")[0].startsWith(expected.twin), true);
  });
}

test("a: the dials a rig turns on are real CloudVolumetrics dials, default off, and true on the rig", () => {
  const real = new CloudVolumetrics();
  const dials = [
    "cloudWeatherWorkers",
    "cloudWeatherInterpolation",
    "cloudVerticalWeather",
  ];
  for (const dial of dials) {
    assert.ok(dial in real, `${dial} is a CloudVolumetrics property`);
    assert.equal(real[dial], false, `${dial} defaults off`);
  }
  assert.equal(real.experimental.cloudIndependentWeatherLayers, false);
  assert.equal(get("cloud-wx-workers").dials.cloudWeatherWorkers, true);
  assert.equal(
    get("cloud-wx-interpolation").dials.cloudWeatherInterpolation,
    true,
  );
  assert.equal(get("cloud-wx-vertical").dials.cloudVerticalWeather, true);
  assert.equal(
    get("cloud-wx-populations").experimental.cloudIndependentWeatherLayers,
    true,
  );
  for (const [id, expected] of Object.entries(TWINS)) {
    const rig = get(id);
    assert.equal(
      rig.dials.cloudWeatherMap,
      true,
      `${id}: the weather map is on`,
    );
    for (const key of Object.keys(rig.experimental ?? {})) {
      assert.ok(key in real.experimental, `${id}: ${key} is a real dial`);
    }
    for (const key of Object.keys(rig.dials).filter((name) =>
      /^cloud[A-Z]/.test(name),
    )) {
      assert.ok(key in real, `${id}: ${key} is a real dial`);
    }
    assert.ok(expected.twin);
  }
});

test("a: the populations rig's lowest frame row is above the horizon, where the E-G pitch's is not", () => {
  const rig = get("cloud-wx-populations");
  const twin = get(EG);
  const lowestRowDegrees = (candidate) => {
    const { width, height } = candidate.viewport;
    const aspect = width / height;
    // The frustum's fov is the horizontal one for an aspect above 1
    // (PerspectiveFrustum: fovy = 2 atan(tan(fov / 2) / aspect)).
    const fovy = 2 * Math.atan(Math.tan(Math.PI / 6) / aspect);
    return ((candidate.camera.pitch - fovy / 2) * 180) / Math.PI;
  };
  const horizonDip =
    (Math.acos(6378137 / (6378137 + rig.camera.height)) * 180) / Math.PI;
  assert.ok(lowestRowDegrees(rig) > 0, `${lowestRowDegrees(rig)} degrees`);
  assert.ok(lowestRowDegrees(rig) > -horizonDip);
  assert.ok(lowestRowDegrees(twin) < -horizonDip);
  for (const dial of ["skyBoxShow", "skyAtmosphereShow", "sunShow"]) {
    assert.equal(rig.dials[dial], false, dial);
  }
  assert.equal(rig.dials.backgroundColor, "rgb(0,0,0)");
});

// ---------------------------------------------------------------------------
// (b) The cells.
// ---------------------------------------------------------------------------

const CELL_RIGS = Object.freeze({
  "E-WX-workers": ["cloud-wx-workers", "capture"],
  "E-WX-interpolation": ["cloud-wx-interpolation", "clock-steps"],
  "E-WX-vertical": ["cloud-wx-vertical", "capture"],
  "E-WX-populations": ["cloud-wx-populations", "capture"],
  "E-ON-occupancy-wx": ["cloud-eon-occupancy-wx", "capture"],
  "E-ON-density-wx": ["cloud-eon-density-wx", "capture"],
  "E-ON-shadow-wx": ["cloud-eon-shadow-wx", "capture"],
  "E-ON-lighting-wx": ["cloud-eon-lighting-wx", "capture"],
  "E-T-wx": ["cloud-flight-multideck-hdr-1080p-wx", "device-loss"],
  "E-LL-wx": ["cloud-wx-all-dials", "capture"],
});

test("b: every new cell rides its rig, is not a default cell, and the title names it", async () => {
  for (const [cell, [rig, kind]] of Object.entries(CELL_RIGS)) {
    assert.equal(LANDING_CELLS[cell].rig, rig, cell);
    assert.equal(LANDING_CELLS[cell].kind, kind, cell);
    assert.ok(!DEFAULT_CELLS.includes(cell), cell);
  }
  const probe = await importMutated(PROBE_MODULE, []);
  for (const cell of Object.keys(CELL_RIGS)) {
    assert.ok(probe.descriptor.title.includes(cell), `title names ${cell}`);
  }
});

test("b: the E-ON-wx cells and E-LL-wx carry the census fields of E-ON and E-LL; E-LL-wx also the default-limits device", () => {
  for (const family of ["occupancy", "density", "shadow", "lighting"]) {
    assert.equal(
      LANDING_CELLS[`E-ON-${family}-wx`].layoutCensus,
      CLOUD_LAYOUT_LABELS,
    );
    assert.equal(LANDING_CELLS[`E-ON-${family}-wx`].deviceLimits, undefined);
  }
  assert.equal(LANDING_CELLS["E-LL-wx"].layoutCensus, CLOUD_LAYOUT_LABELS);
  assert.equal(
    LANDING_CELLS["E-LL-wx"].deviceLimits,
    LANDING_CELLS["E-LL"].deviceLimits,
  );
  assert.equal(LANDING_CELLS["E-LL-wx"].deviceLimits, "webgpu-default");
});

test("b: the owner labels the cells name are labels the engine allocates", () => {
  const engineSource = (file) =>
    fs.readFileSync(
      path.join(
        here,
        "..",
        "..",
        "packages",
        "engine",
        "Source",
        "Renderer",
        "WebGPU",
        file,
      ),
      "utf8",
    );
  for (const [label, file] of [
    ...ET_WX_OWNERS,
    ["Cloud weather volume bounds", "WebGPUCloudWeatherBounds.ts"],
  ]) {
    assert.ok(
      engineSource(file).includes(`label: "${label}"`),
      `${file} labels a resource "${label}"`,
    );
  }
  assert.equal(
    LANDING_CELLS["E-WX-interpolation"].transitionOwner,
    WEATHER_TRANSITION_OWNER_LABELS,
  );
});

test("b: planLandingCells puts the dial cells on the renderers of their twins, populations on two WebGPU pages, E-T-wx on its two pages", () => {
  const plan = (cell) =>
    planLandingCells({ cells: cell }, rigsById).map((entry) => [
      entry.renderer,
      entry.page,
    ]);
  for (const cell of ["E-WX-workers", "E-WX-interpolation", "E-WX-vertical"]) {
    assert.deepEqual(plan(cell), [
      ["webgl", "scene"],
      ["webgpu", "scene"],
    ]);
  }
  assert.deepEqual(plan("E-WX-populations"), [
    ["webgpu", "single-layer"],
    ["webgpu", "populations"],
  ]);
  assert.deepEqual(plan("E-T-wx"), [
    ["webgpu", "teardown"],
    ["webgpu", "forced-loss"],
  ]);
  for (const cell of [
    "E-ON-occupancy-wx",
    "E-ON-density-wx",
    "E-ON-shadow-wx",
    "E-ON-lighting-wx",
    "E-LL-wx",
  ]) {
    assert.deepEqual(plan(cell), [["webgpu", "scene"]]);
  }
});

/** The overlay behaviour: a variant lays its experimental block over the rig's. */
function behaviourOverlay(rigForPageFn) {
  const rig = get("cloud-wx-populations");
  const off = rigForPageFn(rig, {
    cell: "E-WX-populations",
    page: "single-layer",
  });
  const on = rigForPageFn(rig, {
    cell: "E-WX-populations",
    page: "populations",
  });
  assert.deepEqual(off.experimental, { cloudIndependentWeatherLayers: false });
  assert.deepEqual(on.experimental, { cloudIndependentWeatherLayers: true });
  assert.deepEqual(off.dials, rig.dials);
  assert.deepEqual(on.dials, rig.dials);
  assert.equal(off.camera, rig.camera);
  // The rig record is not modified.
  assert.deepEqual(rig.experimental, { cloudIndependentWeatherLayers: true });
  // A variant without an experimental key leaves the block as the rig has it
  // and adds none to a rig that has none.
  const ocean = get("ocean-fft-patch-rebase");
  const stockham = rigForPageFn(ocean, {
    cell: "E-FFT-ifft",
    page: "stockham",
  });
  assert.deepEqual(stockham, {
    ...ocean,
    dials: { ...ocean.dials, waterOceanIfftKernel: "stockham" },
  });
  assert.equal(Object.hasOwn(stockham, "experimental"), false);
  // A cell without variants stages the rig as it is.
  assert.equal(rigForPageFn(ocean, { cell: "E-D", page: "scene" }), ocean);
}

test("b: rigForPage lets a variant overlay the experimental block, and changes no existing variant's rig", () => {
  behaviourOverlay(rigForPage);
});

test("b: mutant, the variant overlay drops the experimental key, goes red", async () => {
  const mutated = await importMutated(TABLE_MODULE, [
    [
      "  if (experimental !== undefined) {",
      "  if (false && experimental !== undefined) {",
    ],
  ]);
  assert.throws(
    () => behaviourOverlay(mutated.rigForPage),
    assert.AssertionError,
  );
});

// ---------------------------------------------------------------------------
// (c) A fake-browser run of the probe with the real stager.
// ---------------------------------------------------------------------------

/**
 * The real stager, on pages whose census holds the transition owner: an
 * interpolation page that held a snapshot pair, so the cell's own owner verdict
 * has what it reads.
 */
const withRealStageAndOwner = (seen) => (browser) =>
  withRealStage(seen)(
    withCensus([{ label: OWNER, created: 1, destroyed: 0 }])(browser),
  );

const VOLUMETRIC_DIALS = Object.freeze([
  "cloudWeatherWorkers",
  "cloudWeatherInterpolation",
  "cloudVerticalWeather",
]);

for (const [cell, dial] of [
  ["E-WX-workers", "cloudWeatherWorkers"],
  ["E-WX-interpolation", "cloudWeatherInterpolation"],
  ["E-WX-vertical", "cloudVerticalWeather"],
]) {
  test(`c: ${cell} stages its dial on every page, reads it back from the instance, and leaves the other weather dials at their defaults`, async () => {
    const seen = [];
    const { code, report } = await p14Run(
      `run-${cell}`,
      [
        "--cells",
        cell,
        ...(cell === "E-WX-workers" ? ["--readers", "weather-worker"] : []),
      ],
      { engagementWorld: ENGAGED },
      undefined,
      cell === "E-WX-interpolation"
        ? withRealStageAndOwner(seen)
        : cell === "E-WX-workers"
          ? (browser) =>
              withRealStage(seen)(
                withWorkerCensus(WEATHER_WORKER_CENSUS)(browser),
              )
          : withRealStage(seen),
    );
    assert.equal(code, 0);
    assert.deepEqual(
      report.pages.map((page) => page.renderer),
      ["webgl", "webgpu"],
    );
    assert.equal(seen.length, 2);
    report.pages.forEach((page, index) => {
      assert.equal(page.notRun, null);
      assert.equal(seen[index].payload.volumetric[dial], true);
      assert.equal(
        seen[index].volumetric[dial],
        true,
        `${dial} on the instance`,
      );
      assert.deepEqual(page.stage.notApplied, []);
      assert.equal(page.stage.cloud.ok, true);
      assert.equal(
        page.stage.cloud.truth.config[dial],
        true,
        `${dial} read back`,
      );
      assert.equal(page.stage.cloud.truth.config.cloudWeatherMap, true);
      for (const other of VOLUMETRIC_DIALS.filter((name) => name !== dial)) {
        assert.equal(
          seen[index].volumetric[other],
          false,
          `${other} stays off`,
        );
      }
      assert.equal(seen[index].volumetric.cloudWeatherTransitionSeconds, 30);
      assert.equal(
        seen[index].volumetric.experimental.cloudIndependentWeatherLayers,
        false,
      );
      assert.ok(page.capture, `${page.renderer}: the PNG is described`);
    });
  });
}

test("c: E-WX-interpolation walks its clock step on both renderers and captures before and after it", async () => {
  const { code, report, log } = await p14Run(
    "run-interp-steps",
    ["--cells", "E-WX-interpolation"],
    {},
    undefined,
    withRealStageAndOwner([]),
  );
  assert.equal(code, 0);
  assert.deepEqual(log.clockSets, [
    "2026-06-21T18:10:15Z",
    "2026-06-21T18:10:15Z",
  ]);
  for (const page of report.pages) {
    assert.deepEqual(
      page.steps.steps.map((step) => [step.name, step.ok]),
      [["2026-06-21T18:10:15Z", true]],
    );
    assert.ok(page.captureStart);
    assert.ok(page.capture);
    assert.notEqual(page.captureStart.path, page.capture.path);
  }
});

test("c: E-WX-populations stages the two variant pages with the dial off and on, each read back from its own instance", async () => {
  const seen = [];
  const { code, report } = await p14Run(
    "run-populations",
    ["--cells", "E-WX-populations"],
    // The real stager answers the stage, so the fake page never sees the
    // payload: the engine's flag follows the page's place instead (the second
    // page is the one with the dial on).
    populationsFrames(BRIGHT_PNG, BRIGHT_PNG, ({ pageIndex }) =>
      worldOf({ populations: pageIndex === 1 })({}),
    ),
    undefined,
    withRealStage(seen),
  );
  assert.equal(code, 0);
  assert.deepEqual(
    report.pages.map((page) => page.page),
    ["single-layer", "populations"],
  );
  assert.notEqual(seen[0].volumetric, seen[1].volumetric);
  for (const [index, want] of [false, true].entries()) {
    assert.deepEqual(seen[index].payload.experimental, {
      cloudIndependentWeatherLayers: want,
    });
    assert.equal(
      seen[index].volumetric.experimental.cloudIndependentWeatherLayers,
      want,
    );
    assert.deepEqual(
      report.pages[index].stage.dials[
        "experimental.cloudIndependentWeatherLayers"
      ],
      { requested: want, observed: want, applied: true },
    );
    assert.deepEqual(report.pages[index].stage.notApplied, []);
    assert.equal(
      report.pages[index].stage.cloud.truth.config.cloudWeatherMap,
      true,
    );
  }
});

for (const family of ["occupancy", "density", "shadow", "lighting"]) {
  test(`c: E-ON-${family}-wx reads its experimental dials back applied with the weather map on, and installs the layout census`, async () => {
    const cell = `E-ON-${family}-wx`;
    const seen = [];
    const { code, report, log } = await p14Run(
      `run-${cell}`,
      ["--cells", cell],
      {},
      undefined,
      withRealStage(seen),
    );
    assert.equal(code, 0);
    const [page] = report.pages;
    assert.deepEqual(page.stage.notApplied, []);
    assert.equal(page.stage.cloud.truth.config.cloudWeatherMap, true);
    for (const dial of Object.keys(
      get(`cloud-eon-${family}-wx`).experimental,
    )) {
      assert.deepEqual(page.stage.dials[`experimental.${dial}`], {
        requested: true,
        observed: true,
        applied: true,
      });
      assert.equal(seen[0].volumetric.experimental[dial], true);
    }
    assert.equal(page.layoutCensus.installed, true);
    assert.equal(log.layoutReads.length, 1);
  });
}

test("c: E-LL-wx applies all eight experimental dials and the three weather dials on the default-limits device and reads the layout census", async () => {
  const seen = [];
  const { code, report, log } = await p14Run(
    "run-E-LL-wx",
    ["--cells", "E-LL-wx"],
    {},
    undefined,
    withRealStage(seen),
  );
  assert.equal(code, 0);
  const [page] = report.pages;
  assert.deepEqual(page.stage.notApplied, []);
  for (const dial of [...W4_UNION, "cloudIndependentWeatherLayers"]) {
    assert.equal(page.stage.dials[`experimental.${dial}`].applied, true, dial);
    assert.equal(seen[0].volumetric.experimental[dial], true, dial);
  }
  for (const dial of VOLUMETRIC_DIALS) {
    assert.equal(page.stage.cloud.truth.config[dial], true, dial);
  }
  assert.equal(page.deviceLimits.mode, "webgpu-default");
  assert.equal(page.layoutCensus.installed, true);
  assert.equal(log.layoutReads.length, 1);
  assert.equal(log.limitReads.length, 1);
});

test("c: E-T-wx stages both device-loss pages with the four dials on, walks the clock step before the terminal action, and names the owner labels", async () => {
  const labels = ET_WX_OWNER_LABELS;
  const seen = [];
  const { code, report, log } = await p14Run(
    "run-E-T-wx",
    ["--cells", "E-T-wx", "--owner-labels", labels.join(",")],
    {},
    undefined,
    withRealStage(seen),
  );
  assert.equal(code, 0);
  assert.equal(seen.length, 2);
  assert.deepEqual(log.clockSets, [
    "2026-06-21T21:50:15Z",
    "2026-06-21T21:50:15Z",
  ]);
  report.pages.forEach((page, index) => {
    assert.deepEqual(page.stage.notApplied, []);
    for (const dial of VOLUMETRIC_DIALS) {
      assert.equal(page.stage.cloud.truth.config[dial], true, dial);
      assert.equal(seen[index].volumetric[dial], true, dial);
    }
    assert.equal(page.stage.cloud.truth.config.cloudWeatherMap, true);
    assert.equal(
      seen[index].volumetric.experimental.cloudIndependentWeatherLayers,
      true,
    );
    const names = page.deviceLoss.steps.map((step) => step.name);
    assert.deepEqual(names, ["clock-steps"]);
    assert.equal(page.deviceLoss.steps[0].ok, true);
    assert.deepEqual(page.deviceLoss.owners.labels, labels);
  });
  assert.deepEqual(
    report.pages.map((page) => page.page),
    ["teardown", "forced-loss"],
  );
  assert.deepEqual(log.deviceLossCalls.slice(0, 1), ["pageDestroyViewer"]);
});

/** The clock-step behaviour of `runDeviceLossSteps` on a fake page. */
async function behaviourClockStep(runSteps) {
  const log = {
    events: [],
    scripts: [],
    urls: [],
    selectors: [],
    contexts: [],
    clockSets: [],
    deviceLossCalls: [],
  };
  const context = await makeFakeBrowser(log).newContext({});
  const fakePage = await context.newPage();
  const page = {
    ...fakePage,
    evaluate: async (fn, arg) =>
      fn.name === "pageReadSunState" ? SUN_STATE : fakePage.evaluate(fn, arg),
  };
  const settled = [];
  const result = await runSteps({
    page,
    rig: {
      dials: { clockSteps: ["2026-06-21T21:50:15Z"], settleFramesPerStep: 7 },
    },
    settle: async (frames) => {
      settled.push(frames);
    },
    mode: "teardown",
    readCensus: async () => null,
    ownerLabels: [],
  });
  assert.deepEqual(log.clockSets, ["2026-06-21T21:50:15Z"]);
  assert.deepEqual(settled, [7]);
  assert.deepEqual(
    result.steps.map((step) => [step.name, step.ok]),
    [["clock-steps", true]],
  );
  // A rig without clock steps runs none.
  const quiet = await runSteps({
    page,
    rig: { dials: {} },
    settle: async () => {},
    mode: "teardown",
    readCensus: async () => null,
    ownerLabels: [],
  });
  assert.deepEqual(quiet.steps, []);
}

test("c: runDeviceLossSteps sets the clock to each step, settles the rig's frames after it, and runs none for a rig without steps", async () => {
  await behaviourClockStep(runDeviceLossSteps);
});

test("c: mutant, the clock step block made unreachable, goes red", async () => {
  const mutated = await importMutated(DEVICE_LOSS_MODULE, [
    [
      "  if (alive && Array.isArray(dials.clockSteps)) {",
      "  if (false && alive && Array.isArray(dials.clockSteps)) {",
    ],
  ]);
  await assert.rejects(
    behaviourClockStep(mutated.runDeviceLossSteps),
    assert.AssertionError,
  );
});

// ---------------------------------------------------------------------------
// (d) A page whose CloudVolumetrics lacks a dial: the stage names it, NOT RUN.
// ---------------------------------------------------------------------------

for (const [cell, key] of [
  ["E-WX-workers", "cloudWeatherWorkers"],
  ["E-WX-interpolation", "cloudWeatherInterpolation"],
  ["E-WX-vertical", "cloudVerticalWeather"],
]) {
  test(`d: ${cell} on a CloudVolumetrics without ${key} is NOT RUN, names the key, and captures nothing`, async () => {
    const seen = [];
    const { code, report, verdicts } = await p14Run(
      `lacks-${cell}`,
      ["--cells", cell],
      {},
      undefined,
      withRealStage(seen, () => volumetricWithout(key)),
    );
    assert.equal(code, 1);
    assert.equal(seen.length, 2);
    for (const page of report.pages) {
      assert.match(page.notRun, /cloudsEnabled/);
      assert.equal(page.stage.cloud.ok, false);
      assert.match(page.stage.cloud.reason, new RegExp(`property ${key}`));
      assert.match(page.stage.dials.cloudsEnabled.reason, new RegExp(key));
      assert.equal(page.stage.dials.cloudsEnabled.applied, false);
      assert.equal(Object.hasOwn(page, "capture"), false);
      assert.equal(Object.hasOwn(page, "captureStart"), false);
    }
    const stage = verdicts.filter((verdict) => verdict.id.endsWith(":stage"));
    assert.equal(stage.length, 2);
    assert.ok(
      stage.every((verdict) => verdict.pass === false && verdict.notRun),
    );
  });
}

test("d: E-WX-populations on a namespace without cloudIndependentWeatherLayers is NOT RUN on both pages, naming the key, with no capture and no verdict", async () => {
  const { code, report, verdicts } = await p14Run(
    "lacks-populations",
    ["--cells", "E-WX-populations"],
    {},
    undefined,
    withRealStage([], () =>
      volumetricWithoutExperimental("cloudIndependentWeatherLayers"),
    ),
  );
  assert.equal(code, 1);
  for (const page of report.pages) {
    assert.match(page.notRun, /experimental\.cloudIndependentWeatherLayers/);
    assert.match(
      page.stage.dials["experimental.cloudIndependentWeatherLayers"].reason,
      /cloudIndependentWeatherLayers/,
    );
    assert.equal(Object.hasOwn(page, "capture"), false);
  }
  const coverage = verdicts.find((verdict) =>
    verdict.id.includes("populations-coverage"),
  );
  assert.equal(coverage.pass, false);
  assert.equal(coverage.notRun, true);
  assert.match(coverage.reason, /no capture on/);
});

/** A stage module's payload and page stager carry each weather dial to a real instance. */
async function behaviourStageCarriesDials(stage) {
  for (const [id, dial] of [
    ["cloud-wx-workers", "cloudWeatherWorkers"],
    ["cloud-wx-interpolation", "cloudWeatherInterpolation"],
    ["cloud-wx-vertical", "cloudVerticalWeather"],
  ]) {
    const payload = {
      ...stage.landingStagePayload(get(id)),
      moduleUrl: FAKE_CESIUM_URL,
    };
    assert.equal(
      payload.volumetric[dial],
      true,
      `${id}: the payload carries ${dial}`,
    );
    const instance = new CloudVolumetrics();
    await withRealHarness(cloudViewer(instance), async () => {
      const answer = await stage.stageLandingCellInPage(payload);
      assert.deepEqual(answer.notApplied, []);
      assert.equal(answer.cloud.truth.config[dial], true, `${id}: read back`);
      assert.equal(instance[dial], true, `${id}: on the instance`);
    });
  }
}

test("c: the stage payload and the page stager carry each weather dial to the instance", async () => {
  await behaviourStageCarriesDials(stageModule);
});

test("c: mutant, the stage payload drops the volumetric dials, goes red", async () => {
  const mutated = await importMutated(STAGE_MODULE, [
    [
      "    volumetric,\n    cloudsEnabled: cloudsEnabled ??",
      "    volumetric: {},\n    cloudsEnabled: cloudsEnabled ??",
    ],
  ]);
  await assert.rejects(
    behaviourStageCarriesDials(mutated),
    assert.AssertionError,
  );
});

test("c: mutant, the page stager hands the harness no volumetric dials, goes red", async () => {
  const mutated = await importMutated(STAGE_MODULE, [
    ["          volumetric: payload.volumetric,", "          volumetric: {},"],
  ]);
  await assert.rejects(
    behaviourStageCarriesDials(mutated),
    assert.AssertionError,
  );
});

/** The probe-level NOT RUN behaviour for an instance lacking cloudWeatherWorkers. */
async function behaviourMissingDialNotRun(name, probe) {
  const { code, report } = await p14Run(
    name,
    ["--cells", "E-WX-workers", "--renderer", "webgpu"],
    {},
    probe,
    withRealStage([], () => volumetricWithout("cloudWeatherWorkers")),
  );
  const [page] = report.pages;
  assert.equal(code, 1);
  assert.match(page.notRun, /cloudsEnabled/);
  assert.match(page.stage.cloud.reason, /cloudWeatherWorkers/);
  assert.equal(Object.hasOwn(page, "capture"), false);
}

test("d: the probe turns a stage that did not apply into NOT RUN before any capture", async () => {
  await behaviourMissingDialNotRun("lacks-real", undefined);
});

test("d: mutant, the probe no longer stops on an unapplied dial, goes red", async () => {
  const mutated = await importMutated(PROBE_MODULE, [
    [
      "      if (blocking.length > 0) {",
      "      if (false && blocking.length > 0) {",
    ],
  ]);
  await assert.rejects(
    behaviourMissingDialNotRun("lacks-mut", mutated.descriptor),
    assert.AssertionError,
  );
});

// ---------------------------------------------------------------------------
// (e) Identity of the serialised stage.
// ---------------------------------------------------------------------------

/** The banked hashes against `landingStage` and `cloudStage`, rig by rig. */
function behaviourPayloadIdentity(landingStage, cloudStage) {
  const banked = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  const ids = Object.keys(banked.rigs);
  assert.ok(ids.length >= 80, `${ids.length} banked rigs`);
  let measured = 0;
  for (const id of ids) {
    const rig = get(id);
    assert.ok(rig, `${id} is still registered`);
    assert.equal(
      payloadHash(landingStage, rig),
      banked.rigs[id].landing,
      `${id}: landing stage payload`,
    );
    assert.equal(
      payloadHash(cloudStage, rig),
      banked.rigs[id].cloud,
      `${id}: cloud stage payload`,
    );
    if (!String(banked.rigs[id].cloud).startsWith("throws:")) {
      measured++;
    }
  }
  assert.ok(measured > 0, "some banked cloud payloads are not refusals");
}

test("e: every banked rig's landing and cloud stage payloads hash as they did before the weather rigs joined", () => {
  behaviourPayloadIdentity(
    stageModule.landingStagePayload,
    cloudRigStagePayload,
  );
});

test("e: no weather rig is in the banked fixture, and each new rig's payload differs from its twin's by exactly its dial", () => {
  const banked = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  for (const [id, expected] of Object.entries(TWINS)) {
    assert.equal(Object.hasOwn(banked.rigs, id), false, id);
    const rig = get(id);
    const twin = get(expected.twin);
    assert.deepEqual(
      changedPaths(
        stageModule.landingStagePayload(rig),
        stageModule.landingStagePayload(twin),
      ),
      [...expected.paths].sort(),
      id,
    );
    // The cloud stager refuses or accepts both alike; where it accepts, it
    // differs only at the paths the landing payload does.
    const ours = payloadHash(cloudRigStagePayload, rig);
    const theirs = payloadHash(cloudRigStagePayload, twin);
    if (ours.startsWith("throws:") || theirs.startsWith("throws:")) {
      assert.equal(ours, theirs, id);
    } else {
      const wanted = expected.paths.filter((name) => name !== "stepDials");
      assert.deepEqual(
        changedPaths(cloudRigStagePayload(rig), cloudRigStagePayload(twin)),
        [...wanted].sort(),
        `${id}: cloud payload`,
      );
    }
  }
});

test("e: mutant, a default cloudWeatherWorkers injected into every landing payload, turns the identity case red", async () => {
  const mutated = await importMutated(STAGE_MODULE, [
    [
      "    volumetric,\n    cloudsEnabled: cloudsEnabled ??",
      "    volumetric: { cloudWeatherWorkers: false, ...volumetric },\n    cloudsEnabled: cloudsEnabled ??",
    ],
  ]);
  assert.throws(
    () =>
      behaviourPayloadIdentity(
        mutated.landingStagePayload,
        cloudRigStagePayload,
      ),
    assert.AssertionError,
  );
});

test("e: mutant, a default cloudWeatherWorkers injected into every cloud payload, turns the identity case red", async () => {
  const mutated = await importMutated(CLOUD_STAGE_MODULE, [
    [
      "  Object.assign(volumetric, overrides.volumetric ?? {});",
      "  Object.assign(volumetric, { cloudWeatherWorkers: false }, overrides.volumetric ?? {});",
    ],
  ]);
  assert.throws(
    () =>
      behaviourPayloadIdentity(
        stageModule.landingStagePayload,
        mutated.cloudRigStagePayload,
      ),
    assert.AssertionError,
  );
});

// ---------------------------------------------------------------------------
// (f) Populations: the measured rule as a cross-page verdict.
// ---------------------------------------------------------------------------

const populationsFrames = (offBytes, onBytes, engagementWorld = ENGAGED) => ({
  screenshotFor: ({ payload }) =>
    payload?.experimental?.cloudIndependentWeatherLayers === true
      ? onBytes
      : offBytes,
  engagementWorld,
});

const coverageVerdict = (verdicts) =>
  verdicts.find(
    (verdict) =>
      verdict.id === "E-WX-populations:webgpu:populations-coverage:run0",
  );

/** The probe-level behaviour of the black / bright / empty decks. */
async function behaviourPopulationsRun(name, probe) {
  const black = await p14Run(
    `${name}-black`,
    ["--cells", "E-WX-populations"],
    populationsFrames(BRIGHT_PNG, BLACK_PNG),
    probe,
  );
  const blackVerdict = coverageVerdict(black.verdicts);
  assert.ok(blackVerdict, "the populations verdict exists");
  assert.equal(blackVerdict.pass, false);
  assert.equal(blackVerdict.outcome, "FAIL");
  assert.equal(black.code, 1);
  assert.equal(
    black.report.weatherDial.find(
      (entry) => entry.rule === "populations-coverage",
    ).verdict.id,
    blackVerdict.id,
  );

  const bright = await p14Run(
    `${name}-bright`,
    ["--cells", "E-WX-populations"],
    populationsFrames(BRIGHT_PNG, BRIGHT_PNG),
    probe,
  );
  const brightVerdict = coverageVerdict(bright.verdicts);
  assert.equal(brightVerdict.pass, true);
  assert.equal(brightVerdict.outcome, "PASS");
  assert.equal(bright.code, 0);

  const empty = await p14Run(
    `${name}-empty`,
    ["--cells", "E-WX-populations"],
    populationsFrames(BLACK_PNG, BLACK_PNG),
    probe,
  );
  const emptyVerdict = coverageVerdict(empty.verdicts);
  assert.equal(emptyVerdict.pass, false);
  assert.equal(emptyVerdict.notRun, true);
  assert.equal(emptyVerdict.outcome, "UNMEASURED");
  assert.equal(empty.code, 1);
}

test("f: over the real probe, a black populations frame beside a bright single layer is FAIL, two bright frames PASS, an empty single layer UNMEASURED (not a pass)", async () => {
  await behaviourPopulationsRun("pop", undefined);
});

test("f: the populations verdict is not attached to a cell without populationsCoverage", async () => {
  const { verdicts } = await p14Run(
    "pop-other",
    ["--cells", "E-WX-vertical"],
    populationsFrames(BRIGHT_PNG, BLACK_PNG),
  );
  assert.equal(
    verdicts.filter((verdict) => verdict.id.includes("populations-coverage"))
      .length,
    0,
  );
});

test("f: mutant, the probe's verdict call site no longer passes the weather-dial comparisons, goes red", async () => {
  const mutated = await importMutated(PROBE_MODULE, [
    [
      "      ...crossPageVerdicts({\n        weatherDial: weatherDialComparisons(pages),\n",
      "      ...crossPageVerdicts({\n",
    ],
  ]);
  await assert.rejects(
    behaviourPopulationsRun("pop-mut-wiring", mutated.descriptor),
    assert.AssertionError,
  );
});

/** Two page records for the populations cell with the given frames on disk. */
function populationsPages(name, offBytes, onBytes, engagement = {}) {
  const dir = path.join(tempRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  const record = (page, bytes, read) => {
    const file = path.join(dir, `${page}.png`);
    fs.writeFileSync(file, bytes);
    return {
      run: 0,
      cell: "E-WX-populations",
      renderer: "webgpu",
      page,
      notRun: null,
      capture: { name: page, path: file },
      ...(read === undefined ? {} : { engagement: read }),
    };
  };
  return [
    record("single-layer", offBytes, engagement.off),
    record("populations", onBytes, engagement.on),
  ];
}

/** The FAIL-branch behaviour over frames on disk, judged by `judge`. */
function behaviourBlackDeckFails(judge) {
  const pages = populationsPages("pop-direct", BRIGHT_PNG, BLACK_PNG);
  const verdicts = crossPageVerdicts({
    weatherDial: weatherDialComparisons(pages, judge ? { judge } : {}),
  });
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].pass, false);
  assert.equal(verdicts[0].outcome, "FAIL");
  assert.match(verdicts[0].reason, /covers 0 px/);
}

test("f: the black deck fails when the comparison is judged by the real rule", () => {
  behaviourBlackDeckFails(undefined);
});

for (const [name, from, to] of [
  [
    "the covered-pixel FAIL branch",
    "  if (coveredRatio < MIN_COVERED_RATIO) {",
    "  if (false && coveredRatio < MIN_COVERED_RATIO) {",
  ],
  [
    "the outcome fold to FAIL",
    '    outcome: reasons.length > 0 ? "FAIL" : "PASS",',
    '    outcome: false && reasons.length > 0 ? "FAIL" : "PASS",',
  ],
]) {
  test(`f: mutant, ${name} made unreachable, turns the black-deck case red`, async () => {
    const mutated = await importMutated(DECK_MODULE, [[from, to]]);
    assert.throws(
      () => behaviourBlackDeckFails(mutated.populationsCoverageVerdict),
      assert.AssertionError,
    );
  });
}

test("f: a missing or unreadable frame is NOT RUN, never a pass", () => {
  const pages = populationsPages("pop-missing", BRIGHT_PNG, BRIGHT_PNG);
  delete pages[1].capture;
  const [entry] = weatherDialComparisons(pages);
  assert.equal(entry.verdict.pass, false);
  assert.equal(entry.verdict.notRun, true);
  assert.match(entry.verdict.reason, /no capture on populations/);
  const unreadable = populationsPages("pop-unreadable", BRIGHT_PNG, BRIGHT_PNG);
  fs.writeFileSync(unreadable[1].capture.path, Buffer.from("not a png"));
  const [bad] = weatherDialComparisons(unreadable);
  assert.equal(bad.verdict.pass, false);
  assert.equal(bad.verdict.notRun, true);
});

// ---------------------------------------------------------------------------
// (g) Interpolation: the transition owner, read in the page census.
// ---------------------------------------------------------------------------

const censusWith = (rows) => ({
  byLabel: Object.fromEntries(
    rows.map((row) => [
      `texture:${row.label}`,
      { kind: "texture", freedByDevice: 0, liveBytes: 0, ...row },
    ]),
  ),
});

const interpolationPage = (census, overrides = {}) => ({
  run: 0,
  cell: "E-WX-interpolation",
  renderer: "webgpu",
  page: "scene",
  notRun: null,
  census,
  ...overrides,
});

/** The owner behaviour over synthetic page records. */
function behaviourOwner(compare) {
  const seenOwner = compare([
    interpolationPage(censusWith([{ label: OWNER, created: 1, destroyed: 0 }])),
  ]);
  assert.equal(seenOwner.length, 1);
  assert.equal(seenOwner[0].verdict.pass, true);
  assert.equal(seenOwner[0].verdict.owners[0].created, 1);
  const absent = compare([
    interpolationPage(
      censusWith([{ label: "WeatherMap", created: 1, destroyed: 0 }]),
    ),
  ]);
  assert.equal(absent[0].verdict.pass, false);
  assert.match(absent[0].verdict.reason, /Cloud previous weather snapshot/);
  assert.match(absent[0].verdict.reason, /no snapshot pair/);
  const empty = compare([interpolationPage(censusWith([]))]);
  assert.equal(empty[0].verdict.pass, false);
  const notRun = compare([
    interpolationPage(undefined, {
      notRun: "the stage did not apply cloudsEnabled",
    }),
  ]);
  assert.equal(notRun[0].verdict.pass, false);
  assert.equal(notRun[0].verdict.notRun, true);
  // The WebGL page is the control: it is not judged for the owner.
  assert.deepEqual(
    compare([interpolationPage(censusWith([]), { renderer: "webgl" })]),
    [],
  );
  // A cell that names no transition owner is not judged.
  assert.deepEqual(
    compare([interpolationPage(censusWith([]), { cell: "E-ON-occupancy-wx" })]),
    [],
  );
}

test("g: the transition owner is judged on the WebGPU page's census: created passes, never created fails naming the label, no census is NOT RUN", () => {
  behaviourOwner((pages) => weatherDialComparisons(pages));
});

test("g: mutant, the owner check never finds an absent owner, goes red", async () => {
  const mutated = await importMutated(CROSS_PAGE_MODULE, [
    [
      "const absent = rows.filter((row) => !row.seen || !(row.created > 0));",
      "const absent = rows.filter((row) => false && (!row.seen || !(row.created > 0)));",
    ],
  ]);
  assert.throws(
    () => behaviourOwner((pages) => mutated.weatherDialComparisons(pages)),
    assert.AssertionError,
  );
});

/** A fake-browser wrapper whose WebGPU pages answer the census with `rows`. */
function withCensus(rows) {
  return (browser) => ({
    isConnected: () => browser.isConnected(),
    close: () => browser.close(),
    async newContext(options) {
      const context = await browser.newContext(options);
      return {
        ...context,
        async newPage() {
          const page = await context.newPage();
          let renderer = "webgl";
          return {
            ...page,
            async goto(url) {
              renderer = String(url).includes("renderer=webgpu")
                ? "webgpu"
                : "webgl";
              return page.goto(url);
            },
            async evaluate(fn, arg) {
              if (fn.name === "pageReadSunState") {
                return SUN_STATE;
              }
              if (String(fn).includes("__gpuDeviceCensus")) {
                return {
                  textures: { created: 0, destroyed: 0 },
                  buffers: { created: 0, destroyed: 0 },
                  compile: { shaderModules: { count: 0, syncMs: 0 } },
                  ...censusWith(renderer === "webgpu" ? rows : []),
                };
              }
              return page.evaluate(fn, arg);
            },
          };
        },
      };
    },
  });
}

test("g: over the real probe, the owner in the WebGPU census passes the cell; without it the cell fails and the WebGL page is not judged", async () => {
  const withOwner = await p14Run(
    "owner-seen",
    ["--cells", "E-WX-interpolation"],
    {},
    undefined,
    withCensus([{ label: OWNER, created: 1, destroyed: 0 }]),
  );
  const seenVerdicts = withOwner.verdicts.filter((verdict) =>
    verdict.id.includes("transition-owner"),
  );
  assert.deepEqual(
    seenVerdicts.map((verdict) => [verdict.id, verdict.pass]),
    [["E-WX-interpolation:webgpu:scene:transition-owner:run0", true]],
  );
  assert.equal(withOwner.code, 0);
  const without = await p14Run(
    "owner-absent",
    ["--cells", "E-WX-interpolation"],
    {},
    undefined,
    withCensus([]),
  );
  const absentVerdicts = without.verdicts.filter((verdict) =>
    verdict.id.includes("transition-owner"),
  );
  assert.equal(absentVerdicts.length, 1);
  assert.equal(absentVerdicts[0].pass, false);
  assert.equal(without.code, 1);
});

// ---------------------------------------------------------------------------
// (h) Engagement: the engine's own request flags, read at capture.
// ---------------------------------------------------------------------------

const flagRead = (name, value) => ({ [name]: { available: true, value } });
const POPULATIONS_SEAM =
  "viewer.scene.context._cloudCache.weatherPopulationsRequested";
const populationsUnread = {
  populationsRequested: {
    available: false,
    reason: `NOT AVAILABLE: ${POPULATIONS_SEAM} (viewer.scene.context._cloudCache is not an object)`,
  },
};

/**
 * The populations rule over page records that carry engagement reads, judged by
 * `compare` (`weatherDialComparisons`, real or mutated). The frames are
 * IDENTICAL and bright in every case that is not about the floors, so what
 * decides the verdict is the engine's request flag: identical frames with the
 * flag false FAIL, and identical frames with the flag true pass the pixel
 * floors only (they say nothing about the march, which is why the flag is the
 * first condition).
 */
function behaviourPopulationsEngagement(compare) {
  const verdictOf = (name, off, on, bytes = [BRIGHT_PNG, BRIGHT_PNG]) => {
    const entries = compare(
      populationsPages(name, bytes[0], bytes[1], { off, on }),
    );
    assert.equal(entries.length, 1);
    return entries[0].verdict;
  };

  // Flag true on populations, false on single-layer, identical frames: the
  // verdict is the floors' alone, and they pass.
  const ok = verdictOf(
    "eng-ok",
    flagRead("populationsRequested", false),
    flagRead("populationsRequested", true),
  );
  assert.equal(ok.pass, true);
  assert.equal(ok.outcome, "PASS");
  assert.equal(Object.hasOwn(ok, "notRun"), false);
  assert.deepEqual(ok.engagement, {
    "single-layer": { populationsRequested: { expected: false, value: false } },
    populations: { populationsRequested: { expected: true, value: true } },
  });

  // Identical frames, flag false on populations: the march did not run.
  const idle = verdictOf(
    "eng-idle",
    flagRead("populationsRequested", false),
    flagRead("populationsRequested", false),
  );
  assert.equal(idle.pass, false);
  assert.equal(idle.outcome, "FAIL");
  assert.equal(Object.hasOwn(idle, "notRun"), false);
  assert.match(idle.reason, /the population march did not run/);

  // Identical frames, flag true on the single-layer page: it ran there.
  const wrong = verdictOf(
    "eng-wrong",
    flagRead("populationsRequested", true),
    flagRead("populationsRequested", true),
  );
  assert.equal(wrong.pass, false);
  assert.equal(wrong.outcome, "FAIL");
  assert.match(wrong.reason, /ran on the single-layer page/);

  // A flag the page could not read is NOT AVAILABLE naming the seam, never a
  // pass; so is a record with no engagement field.
  const unread = verdictOf(
    "eng-unread",
    flagRead("populationsRequested", false),
    populationsUnread,
  );
  assert.equal(unread.pass, false);
  assert.equal(unread.notRun, true);
  assert.equal(unread.outcome, "NOT AVAILABLE");
  assert.ok(unread.reason.includes(POPULATIONS_SEAM));
  const absent = verdictOf("eng-absent", undefined, undefined);
  assert.equal(absent.pass, false);
  assert.equal(absent.notRun, true);
  assert.equal(absent.outcome, "NOT AVAILABLE");
  assert.ok(absent.reason.includes(POPULATIONS_SEAM));

  // The pixel floors stay the second condition: the flags are right and the
  // populations deck is black, so the verdict is the floors' FAIL.
  const black = verdictOf(
    "eng-black",
    flagRead("populationsRequested", false),
    flagRead("populationsRequested", true),
    [BRIGHT_PNG, BLACK_PNG],
  );
  assert.equal(black.pass, false);
  assert.equal(black.outcome, "FAIL");
  assert.match(black.reason, /covers 0 px/);
  assert.doesNotMatch(black.reason, /population march/);

  // A measured red outranks a read that could not be made: the floors fail
  // while the flag is unread, and the flag is false while the single layer is
  // empty (UNMEASURED floors).
  const floorsAndUnread = verdictOf(
    "eng-floors-unread",
    flagRead("populationsRequested", false),
    populationsUnread,
    [BRIGHT_PNG, BLACK_PNG],
  );
  assert.equal(floorsAndUnread.outcome, "FAIL");
  const idleOnEmpty = verdictOf(
    "eng-idle-empty",
    flagRead("populationsRequested", false),
    flagRead("populationsRequested", false),
    [BLACK_PNG, BLACK_PNG],
  );
  assert.equal(idleOnEmpty.outcome, "FAIL");
  assert.match(idleOnEmpty.reason, /the population march did not run/);

  // Flags right and the single layer empty: still UNMEASURED, still not a pass.
  const empty = verdictOf(
    "eng-empty",
    flagRead("populationsRequested", false),
    flagRead("populationsRequested", true),
    [BLACK_PNG, BLACK_PNG],
  );
  assert.equal(empty.outcome, "UNMEASURED");
  assert.equal(empty.notRun, true);
  assert.equal(empty.pass, false);
}

test("h: the populations verdict needs the engine's request flag true on the populations page and false on the single-layer page; identical frames with the flag false FAIL, with the flag true they pass the floors only", () => {
  behaviourPopulationsEngagement((pages) => weatherDialComparisons(pages));
});

const POPULATIONS_ENGAGEMENT_MUTANTS = Object.freeze([
  [
    "the flag check dropped from the verdict (the fold sees no page)",
    "            const engaged = foldEngagement([onEngaged, offEngaged]);",
    "            const engaged = foldEngagement(false ? [onEngaged, offEngaged] : []);",
  ],
  [
    "a failed flag no longer fails the verdict",
    '              engaged.outcome === "FAIL" || result.outcome === "FAIL"',
    '              false && engaged.outcome === "FAIL" || result.outcome === "FAIL"',
  ],
  [
    "an unread flag no longer makes the verdict NOT AVAILABLE",
    '                : engaged.outcome === "NOT AVAILABLE"',
    '                : false && engaged.outcome === "NOT AVAILABLE"',
  ],
  [
    "the pixel floors no longer fail the verdict",
    '|| result.outcome === "FAIL"\n                ? "FAIL"',
    '|| false && result.outcome === "FAIL"\n                ? "FAIL"',
  ],
]);

for (const [name, from, to] of POPULATIONS_ENGAGEMENT_MUTANTS) {
  test(`h: mutant, ${name}, goes red by the populations engagement case`, async () => {
    const mutated = await importMutated(CROSS_PAGE_MODULE, [[from, to]]);
    await assertRed(
      (module) =>
        behaviourPopulationsEngagement((pages) =>
          module.weatherDialComparisons(pages),
        ),
      { weatherDialComparisons },
      mutated,
    );
  });
}

/** The populations engagement cases over the REAL probe and the fake page's world. */
async function behaviourPopulationsProbeEngagement(name, probe) {
  const run = (suffix, world) =>
    p14Run(
      `${name}-${suffix}`,
      ["--cells", "E-WX-populations"],
      populationsFrames(BRIGHT_PNG, BRIGHT_PNG, world),
      probe,
    );
  // The engine requests the march exactly where the dial is on: the identical
  // frames pass the floors.
  const truthful = await run("truthful", ENGAGED);
  assert.equal(coverageVerdict(truthful.verdicts).pass, true);
  assert.equal(truthful.code, 0);
  // The dial is on but the engine requests nothing (no packed layers): the
  // identical bright frames FAIL.
  const idle = await run("idle", worldOf({ populations: false }));
  const idleVerdict = coverageVerdict(idle.verdicts);
  assert.equal(idleVerdict.pass, false);
  assert.equal(idleVerdict.outcome, "FAIL");
  assert.match(idleVerdict.reason, /the population march did not run/);
  assert.equal(idle.code, 1);
  // The engine requests it on the page whose dial is off.
  const wrong = await run("wrong", worldOf({ populations: true }));
  assert.match(
    coverageVerdict(wrong.verdicts).reason,
    /ran on the single-layer page/,
  );
  assert.equal(wrong.code, 1);
  // A cache without the field: NOT AVAILABLE naming the seam.
  const unread = await run("unread", worldOf({ populations: null }));
  const unreadVerdict = coverageVerdict(unread.verdicts);
  assert.equal(unreadVerdict.notRun, true);
  assert.equal(unreadVerdict.outcome, "NOT AVAILABLE");
  assert.ok(unreadVerdict.reason.includes(POPULATIONS_SEAM));
  assert.equal(unread.code, 1);
  // The page record carries the reads.
  assert.deepEqual(
    truthful.report.pages.map((page) => page.engagement),
    [
      flagRead("populationsRequested", false),
      flagRead("populationsRequested", true),
    ],
  );
}

test("h: over the real probe, the populations cell reads the engine's flag on both pages and judges it", async () => {
  await behaviourPopulationsProbeEngagement("eng-pop", undefined);
});

const enginePage = (cell, page, engagement, overrides = {}) => ({
  run: 0,
  cell,
  renderer: "webgpu",
  page,
  notRun: null,
  ...(engagement === undefined ? {} : { engagement }),
  ...overrides,
});
const rule = (entries, name) => entries.filter((entry) => entry.rule === name);
const workerRecord = (overrides = {}) => ({
  available: true,
  phase: "capture",
  created: 1,
  terminated: 0,
  alive: true,
  workersSeen: 1,
  unattributedBlobWorkers: 0,
  constructionFailures: 0,
  workers: [],
  ...overrides,
});

/** E-WX-vertical and E-WX-workers over page records, judged by `compare`. */
function behaviourEngagementCells(compare) {
  // Vertical: true on the WebGPU page passes.
  const vertical = (engagement, overrides) =>
    compare([enginePage("E-WX-vertical", "scene", engagement, overrides)]);
  const passed = vertical(flagRead("verticalRequested", true));
  assert.equal(passed.length, 1);
  assert.equal(passed[0].rule, "engagement");
  assert.equal(
    passed[0].verdict.id,
    "E-WX-vertical:webgpu:scene:engagement:run0",
  );
  assert.equal(passed[0].verdict.pass, true);
  assert.equal(passed[0].verdict.outcome, "PASS");
  // False fails: the vertical march was not requested.
  const failed = vertical(flagRead("verticalRequested", false));
  assert.equal(failed[0].verdict.pass, false);
  assert.equal(failed[0].verdict.outcome, "FAIL");
  assert.equal(Object.hasOwn(failed[0].verdict, "notRun"), false);
  assert.match(failed[0].verdict.reason, /vertical weather march did not run/);
  // Unread, or no engagement field: NOT AVAILABLE naming the seam.
  for (const engagement of [
    {
      verticalRequested: {
        available: false,
        reason:
          "NOT AVAILABLE: viewer.scene.context._cloudCache.weatherVerticalRequested",
      },
    },
    undefined,
  ]) {
    const unread = vertical(engagement);
    assert.equal(unread[0].verdict.pass, false);
    assert.equal(unread[0].verdict.notRun, true);
    assert.equal(unread[0].verdict.outcome, "NOT AVAILABLE");
    assert.ok(unread[0].verdict.reason.includes("weatherVerticalRequested"));
  }
  // The WebGL page is not judged on engagement.
  assert.deepEqual(
    vertical(flagRead("verticalRequested", false), { renderer: "webgl" }),
    [],
  );
  // A page that did not run says so.
  const notRun = vertical(undefined, { notRun: "the stage did not apply" });
  assert.equal(notRun[0].verdict.notRun, true);
  assert.equal(notRun[0].verdict.reason, "the stage did not apply");

  // Workers: the flag and the created worker are two verdicts on the page.
  const workers = (engagement, readers, overrides) =>
    compare([
      enginePage("E-WX-workers", "scene", engagement, {
        ...(readers === undefined ? {} : { readers }),
        ...overrides,
      }),
    ]);
  const both = workers(flagRead("workersEnabled", true), {
    weatherWorker: workerRecord(),
  });
  assert.deepEqual(
    both.map((entry) => [entry.rule, entry.verdict.pass]),
    [
      ["engagement", true],
      ["weather-worker-created", true],
    ],
  );
  assert.equal(
    both[1].verdict.id,
    "E-WX-workers:webgpu:scene:weather-worker-created:run0",
  );
  assert.equal(both[1].verdict.created, 1);
  // The provider not using workers fails the flag half.
  const off = workers(flagRead("workersEnabled", false), {
    weatherWorker: workerRecord(),
  });
  assert.equal(rule(off, "engagement")[0].verdict.pass, false);
  assert.equal(rule(off, "engagement")[0].verdict.outcome, "FAIL");
  assert.match(
    rule(off, "engagement")[0].verdict.reason,
    /does not use workers/,
  );
  assert.equal(rule(off, "weather-worker-created")[0].verdict.pass, true);
  // Without --readers weather-worker the worker half is NOT RUN, and says why.
  const noReader = workers(flagRead("workersEnabled", true), undefined);
  assert.equal(rule(noReader, "engagement")[0].verdict.pass, true);
  const noReaderVerdict = rule(noReader, "weather-worker-created")[0].verdict;
  assert.equal(noReaderVerdict.pass, false);
  assert.equal(noReaderVerdict.notRun, true);
  assert.equal(noReaderVerdict.reason, "run with --readers weather-worker");
  // A reader that could not answer is NOT RUN with its own reason.
  const unavailable = rule(
    workers(flagRead("workersEnabled", true), {
      weatherWorker: {
        available: false,
        reason: "NOT AVAILABLE: globalThis.Worker",
      },
    }),
    "weather-worker-created",
  )[0].verdict;
  assert.equal(unavailable.notRun, true);
  assert.equal(unavailable.reason, "NOT AVAILABLE: globalThis.Worker");
  // No worker created and none unattributed: FAIL, a measured red.
  const none = rule(
    workers(flagRead("workersEnabled", true), {
      weatherWorker: workerRecord({ created: 0 }),
    }),
    "weather-worker-created",
  )[0].verdict;
  assert.equal(none.pass, false);
  assert.equal(Object.hasOwn(none, "notRun"), false);
  assert.match(none.reason, /no weather worker was created/);
  // A blob worker whose shim could not be read may be the weather worker: a
  // zero is not a count, and neither is a count beside an unattributed one.
  for (const created of [0, 1]) {
    const gap = rule(
      workers(flagRead("workersEnabled", true), {
        weatherWorker: workerRecord({ created, unattributedBlobWorkers: 2 }),
      }),
      "weather-worker-created",
    )[0].verdict;
    assert.equal(gap.pass, false);
    assert.equal(gap.notRun, true);
    assert.match(gap.reason, /2 blob worker\(s\) could not be attributed/);
  }
  // The WebGL page is not judged for either half.
  assert.deepEqual(
    workers(
      flagRead("workersEnabled", false),
      { weatherWorker: workerRecord({ created: 0 }) },
      { renderer: "webgl" },
    ),
    [],
  );
}

test("h: E-WX-vertical and E-WX-workers are judged on the WebGPU page's engine flags, and the workers cell also on a created weather worker", () => {
  behaviourEngagementCells((pages) => weatherDialComparisons(pages));
});

const ENGAGEMENT_CELL_MUTANTS = Object.freeze([
  [
    "the engagement verdicts of cells without a populations pair made unreachable",
    "    if (spec?.engagement && !spec.populationsCoverage) {",
    "    if (false && spec?.engagement && !spec.populationsCoverage) {",
  ],
  [
    "an unread flag no longer makes the verdict NOT RUN",
    '              ...(judged.outcome === "NOT AVAILABLE" ? { notRun: true } : {}),',
    '              ...(false && judged.outcome === "NOT AVAILABLE" ? { notRun: true } : {}),',
  ],
  [
    "the worker-created verdict made unreachable",
    '        if (spec.engagement.includes("workersEnabled")) {',
    '        if (false && spec.engagement.includes("workersEnabled")) {',
  ],
  [
    "the no-worker-created FAIL made unreachable",
    "  if (created < 1) {",
    "  if (false && created < 1) {",
  ],
  [
    "the unattributed-worker NOT RUN made unreachable",
    "  if (unattributedBlobWorkers > 0) {",
    "  if (false && unattributedBlobWorkers > 0) {",
  ],
]);

for (const [name, from, to] of ENGAGEMENT_CELL_MUTANTS) {
  test(`h: mutant, ${name}, goes red by the engagement cell case`, async () => {
    const mutated = await importMutated(CROSS_PAGE_MODULE, [[from, to]]);
    await assertRed(
      (module) =>
        behaviourEngagementCells((pages) =>
          module.weatherDialComparisons(pages),
        ),
      { weatherDialComparisons },
      mutated,
    );
  });
}

/** E-WX-vertical and E-WX-workers over the REAL probe and the fake page's world. */
async function behaviourEngagementProbe(name, probe) {
  const run = (suffix, cell, world, extra = [], wrap) =>
    p14Run(
      `${name}-${suffix}`,
      ["--cells", cell, ...extra],
      { engagementWorld: world },
      probe,
      wrap,
    );
  const engagementVerdicts = (verdicts, cell) =>
    verdicts.filter(
      (verdict) =>
        verdict.id.startsWith(`${cell}:webgpu`) &&
        (verdict.id.includes(":engagement:") ||
          verdict.id.includes(":weather-worker-created:")),
    );
  const good = await run("vertical-good", "E-WX-vertical", ENGAGED);
  assert.deepEqual(
    engagementVerdicts(good.verdicts, "E-WX-vertical").map((v) => [
      v.id,
      v.pass,
    ]),
    [["E-WX-vertical:webgpu:scene:engagement:run0", true]],
  );
  assert.equal(good.code, 0);
  for (const page of good.report.pages) {
    assert.deepEqual(page.engagement, flagRead("verticalRequested", true));
  }
  const bad = await run(
    "vertical-bad",
    "E-WX-vertical",
    worldOf({ vertical: false }),
  );
  assert.equal(
    engagementVerdicts(bad.verdicts, "E-WX-vertical")[0].outcome,
    "FAIL",
  );
  assert.equal(bad.code, 1);
  const unread = await run(
    "vertical-unread",
    "E-WX-vertical",
    worldOf({ vertical: null }),
  );
  assert.equal(
    engagementVerdicts(unread.verdicts, "E-WX-vertical")[0].notRun,
    true,
  );
  assert.equal(unread.code, 1);

  const census = withWorkerCensus(WEATHER_WORKER_CENSUS);
  const workers = await run(
    "workers-good",
    "E-WX-workers",
    ENGAGED,
    ["--readers", "weather-worker"],
    census,
  );
  assert.deepEqual(
    engagementVerdicts(workers.verdicts, "E-WX-workers").map((v) => [
      v.id,
      v.pass,
    ]),
    [
      ["E-WX-workers:webgpu:scene:engagement:run0", true],
      ["E-WX-workers:webgpu:scene:weather-worker-created:run0", true],
    ],
  );
  assert.equal(workers.code, 0);
  // Run without the reader, the worker half is NOT RUN: the run does not pass.
  const noReader = await run("workers-no-reader", "E-WX-workers", ENGAGED);
  const created = engagementVerdicts(noReader.verdicts, "E-WX-workers").find(
    (v) => v.id.includes("weather-worker-created"),
  );
  assert.equal(created.notRun, true);
  assert.equal(created.reason, "run with --readers weather-worker");
  assert.equal(noReader.code, 1);
}

test("h: over the real probe, the vertical and workers cells read the engine's flags and judge them", async () => {
  await behaviourEngagementProbe("eng-cells", undefined);
});

test("h: mutant, the probe's verdict call site no longer passes the weather-dial comparisons, goes red by the engagement probe case", async () => {
  const mutated = await importMutated(PROBE_MODULE, [
    [
      "      ...crossPageVerdicts({\n        weatherDial: weatherDialComparisons(pages),\n",
      "      ...crossPageVerdicts({\n",
    ],
  ]);
  await assertRed(
    (probe) => behaviourEngagementProbe("eng-cells-mut", probe.descriptor),
    { descriptor: undefined },
    mutated,
  );
});

/** The record builder the probe calls per page, asserted against `readRecords`. */
async function behaviourEngagementRecord(readRecords) {
  const browser = makeFakeBrowser(
    { events: [], scripts: [], urls: [], selectors: [], contexts: [] },
    { engagementWorld: ENGAGED },
  );
  const page = await (await browser.newContext({})).newPage();
  // A cell that names flags gets them under `engagement`, as the page has them.
  assert.deepEqual(await readRecords(page, LANDING_CELLS["E-WX-vertical"]), {
    engagement: flagRead("verticalRequested", true),
  });
  assert.deepEqual(await readRecords(page, LANDING_CELLS["E-WX-workers"]), {
    engagement: flagRead("workersEnabled", true),
  });
  assert.deepEqual(await readRecords(page, LANDING_CELLS["E-WX-populations"]), {
    engagement: flagRead("populationsRequested", false),
  });
  // A cell without the field gets no new record field.
  for (const cell of ["E-D", "E-WX-interpolation", "E-ON-occupancy-wx"]) {
    assert.equal(
      Object.hasOwn(await readRecords(page, LANDING_CELLS[cell]), "engagement"),
      false,
      cell,
    );
  }
}

test("h: only the three cells that name engagement flags read them", async () => {
  await behaviourEngagementRecord(readCellInitRecords);
  assert.deepEqual(
    Object.entries(LANDING_CELLS)
      .filter(([, cell]) => cell.engagement !== undefined)
      .map(([name, cell]) => [name, cell.engagement]),
    [
      ["E-WX-workers", ["workersEnabled"]],
      ["E-WX-vertical", ["verticalRequested"]],
      ["E-WX-populations", ["populationsRequested"]],
    ],
  );
});

test("h: mutant, the engagement read made unreachable, goes red by the record case", async () => {
  const mutated = await importMutated(INIT_SCRIPTS_MODULE, [
    [
      "  if (wantsEngagement(cell)) {",
      "  if (false && wantsEngagement(cell)) {",
    ],
  ]);
  await assertRed(
    (module) => behaviourEngagementRecord(module.readCellInitRecords),
    { readCellInitRecords },
    mutated,
  );
});
