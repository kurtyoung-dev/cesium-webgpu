// landing-cell-stage.spec.mjs - lane KT round 2 (Nurn). Pure Node: no browser, no GPU.
//
// @purpose Exercises landing-cell-stage.mjs in Node against real rigs and synthetic payloads, asserting payload construction, dial vocabulary and partition, camera validation, harness checks, and page-side dial read-back.
// @status ACTIVE
//
// Written from BEHAVIOUR_CELOS.md covering behaviours S1, S2, S3, S4, and S5.
// The S4 terrain cases marked ROUND 3 are the lead's addition for Ettenmoors pass 2 (N-2).
// S8 (the FFT-ocean dial, DX-KIT-WATER-OCEAN-DIAL, and the globeShow and SSR
// scene dials) is the lane A salvage lead's addition (Andustar).
// S6 (the wave-epoch dial, K5-1) and S7 (the pending-pipeline wait, K5-2) are
// the lead's ROUND 5 additions (Celos), written from the seat's item text.
// S9 (the waterOceanIfftKernel and sceneMode dials) is lane LINDISSE's addition (Zimrahin).
// S10 (the 2D and Columbus identity rigs stage the mode, then their pinned camera) is lane TAR-ALDARION's A2 addition.
// S11 (the globeFragmentDebug dial) is the 2D / Columbus banding lane's addition (Ibal).
// Base: a999954e2b. Drives real exported functions with Node-compatible fakes.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  GLOBE_FRAGMENT_DEBUG_MODE_NAMES,
  GLOBE_FRAGMENT_DEBUG_OFF,
} from "./lib/globe-fragment-debug-dial.mjs";
import {
  LANDING_GLOBE_DIALS,
  LANDING_IFFT_KERNEL_VALUES,
  LANDING_SCENE_DIALS,
  LANDING_SCENE_MODE_VALUES,
  LANDING_WATER_DIALS,
  PIPELINE_WAIT_DEFAULTS,
  landingStagePayload,
  readPendingPipelines,
  stageLandingCell,
  stageLandingCellInPage,
} from "./lib/landing-cell-stage.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import { ProbeRefusal } from "./lib/probe-refusal.mjs";
import { loadRigs, rigById } from "./lib/rig-registry.mjs";
import { LANDING_CELLS, blockingDials } from "./probe-landing-cells.mjs";

const FAKE_CESIUM_MODULE_SOURCE = `
export class JulianDate {
  constructor(iso) {
    this.iso = iso;
  }
  static fromIso8601(iso) {
    return new JulianDate(iso);
  }
  static toIso8601(jd) {
    return jd ? jd.iso : "2026-06-21T00:00:00Z";
  }
}

export class Color {
  constructor(css) {
    this.css = css;
  }
  static fromCssColorString(css) {
    return new Color(css);
  }
  toCssColorString() {
    return this.css;
  }
  equals(other) {
    return other != null && this.css === other.css;
  }
}

export class Cartesian3 {
  constructor(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
  static fromDegrees(lon, lat, height) {
    return new Cartesian3(lon, lat, height);
  }
}

export const Math = {
  toDegrees(rad) {
    return rad * (180 / globalThis.Math.PI);
  },
};

export class EllipsoidTerrainProvider {}

export class Material {
  static fromType(type) {
    return { type };
  }
}

export class TileMapServiceImageryProvider {
  static async fromUrl(url) {
    return { url };
  }
}
`;

const FAKE_CESIUM_URL =
  "data:text/javascript," + encodeURIComponent(FAKE_CESIUM_MODULE_SOURCE);

function createFakeViewer(overrides = {}) {
  const imageryLayers = overrides.imageryLayers ?? [{ id: "base-layer" }];
  return {
    useDefaultRenderLoop: true,
    clock: {
      shouldAnimate: true,
      currentTime: { iso: "2026-06-21T00:00:00Z" },
    },
    scene: {
      context: { rendererType: "webgpu", isWebGPU: true },
      requestRenderMode: true,
      highDynamicRange: false,
      msaaSamples: 1,
      backgroundColor: null,
      skyBox: { show: false },
      skyAtmosphere: { show: false, multipleScattering: false },
      sun: { show: false },
      moon: { show: false },
      screenSpaceCameraController: { enableInputs: false },
      imageryLayers: {
        _layers: imageryLayers,
        get length() {
          return this._layers.length;
        },
        removeAll() {
          this._layers = [];
        },
        addImageryProvider(provider) {
          this._layers.push(provider);
        },
      },
      globe: {
        enableLighting: false,
        showWaterEffect: false,
        showGroundAtmosphere: false,
        baseColor: null,
        terrainProvider: null,
        material: undefined,
        globalWaterMask: false,
        lakeWaterMask: false,
        riverWaterMask: false,
        enableEnhancedOcean: false,
        water: { qualityPreset: "LOW" },
        defaultCloudCollection: { enableVolumetric: true },
      },
    },
    camera: {
      setView(opts) {
        this.lastSetView = opts;
      },
      positionCartographic: {
        longitude: 0.17453292519943295,
        latitude: 0.3490658503988659,
        height: 300,
      },
    },
  };
}

test.afterEach(() => {
  delete globalThis.viewer;
  delete globalThis.__cloudProbe;
  delete globalThis._webgpuGlobeDebugMode;
  delete globalThis.__webgpuGlobeFragmentDebugRegistry;
});

// -----------------------------------------------------------------------------
// S1: landingStagePayload payload round-tripping and dial partitioning
// -----------------------------------------------------------------------------

test("S1: landingStagePayload returns JSON-round-trippable payload for every LANDING_CELLS rig", async () => {
  const rigs = await loadRigs();
  for (const [cellName, cell] of Object.entries(LANDING_CELLS)) {
    const rig = rigById(rigs, cell.rig);
    assert.ok(
      rig,
      `rig ${cell.rig} for cell ${cellName} must exist in rig registry`,
    );
    const payload = landingStagePayload(rig);
    const roundTripped = JSON.parse(JSON.stringify(payload));
    assert.deepEqual(
      roundTripped,
      payload,
      `payload for cell ${cellName} (${cell.rig}) must round-trip through JSON`,
    );
  }
});

test("S1: every rig dial lands in exactly one of scene, globe, water, volumetric, stepDials or cloudsEnabled", async () => {
  const rigs = await loadRigs();
  const testedRigIds = new Set();
  for (const cell of Object.values(LANDING_CELLS)) {
    if (testedRigIds.has(cell.rig)) {
      continue;
    }
    testedRigIds.add(cell.rig);
    const rig = rigById(rigs, cell.rig);
    assert.ok(rig, `rig ${cell.rig} must exist`);
    const payload = landingStagePayload(rig);
    for (const dialKey of Object.keys(rig.dials ?? {})) {
      const inScene = dialKey in payload.scene;
      const inGlobe = dialKey in payload.globe;
      const inWater = dialKey in payload.water;
      const inVolumetric = dialKey in payload.volumetric;
      const inStepDials = payload.stepDials.includes(dialKey);
      const inCloudsEnabled =
        dialKey === "cloudsEnabled" && payload.cloudsEnabled !== null;
      const categoryCount =
        Number(inScene) +
        Number(inGlobe) +
        Number(inWater) +
        Number(inVolumetric) +
        Number(inStepDials) +
        Number(inCloudsEnabled);
      assert.equal(
        categoryCount,
        1,
        `rig ${rig.id} dial ${dialKey} must land in exactly one category (got ${categoryCount})`,
      );
    }
  }
});

// -----------------------------------------------------------------------------
// S2: vocabulary, imagery/terrain values, and camera validation
// -----------------------------------------------------------------------------

test("S2: rig with dial outside stage vocabulary throws ProbeRefusal naming the dial", () => {
  const rig = {
    id: "unsupported-dial-rig",
    dials: { unsupportedCustomDial: true },
  };
  assert.throws(
    () => landingStagePayload(rig),
    (err) => {
      assert.ok(
        err instanceof ProbeRefusal,
        "must throw ProbeRefusal for unsupported dial",
      );
      assert.equal(err.reason, "rig-dial-unsupported");
      assert.ok(
        err.message.includes("unsupportedCustomDial"),
        "error message must name the unsupported dial",
      );
      assert.ok(
        Array.isArray(err.details?.unsupported) &&
          err.details.unsupported.includes("unsupportedCustomDial"),
        "details.unsupported must name the unsupported dial",
      );
      return true;
    },
  );
});

test("S2: cloud dial matching /^cloud[A-Z]/ is admitted into volumetric rather than refused", () => {
  const rig = {
    id: "custom-cloud-rig",
    dials: { cloudCustomParam: 42 },
  };
  const payload = landingStagePayload(rig);
  assert.equal(payload.volumetric.cloudCustomParam, 42);
});

test("S2: rig with unsupported imagery value throws ProbeRefusal naming imagery", () => {
  const rig = {
    id: "unsupported-imagery-rig",
    dials: { imagery: "invalidImageryProvider" },
  };
  assert.throws(
    () => landingStagePayload(rig),
    (err) => {
      assert.ok(err instanceof ProbeRefusal);
      assert.equal(err.reason, "rig-dial-unsupported");
      assert.ok(
        err.message.includes("imagery"),
        "error message must name imagery",
      );
      return true;
    },
  );
});

test("S2: rig with unsupported terrain value throws ProbeRefusal naming terrain", () => {
  const rig = {
    id: "unsupported-terrain-rig",
    dials: { terrain: "invalidTerrainProvider" },
  };
  assert.throws(
    () => landingStagePayload(rig),
    (err) => {
      assert.ok(err instanceof ProbeRefusal);
      assert.equal(err.reason, "rig-dial-unsupported");
      assert.ok(
        err.message.includes("terrain"),
        "error message must name terrain",
      );
      return true;
    },
  );
});

test("S2: rig with non-boolean cloudsEnabled throws ProbeRefusal", () => {
  const rig = {
    id: "bad-cloudsEnabled-rig",
    dials: { cloudsEnabled: "yes" },
  };
  assert.throws(
    () => landingStagePayload(rig),
    (err) => {
      assert.ok(err instanceof ProbeRefusal);
      assert.equal(err.reason, "rig-dial-unsupported");
      return true;
    },
  );
});

test("S2: camera with non-finite degrees throws TypeError", () => {
  const invalidCameras = [
    { lon: NaN, lat: 0, height: 100 },
    { lon: 0, lat: Infinity, height: 100 },
    { lon: 0, lat: 0, height: "100" },
    { lon: 0, lat: 0, height: 100, heading: NaN },
    { lon: 0, lat: 0, height: 100, pitch: undefined },
    { lon: 0, lat: 0, height: 100, roll: -Infinity },
  ];
  for (const camera of invalidCameras) {
    assert.throws(
      () => landingStagePayload({ id: "invalid-cam-rig", camera }),
      TypeError,
    );
  }
});

test("S2: camera that is null is accepted without error", () => {
  const payload = landingStagePayload({ id: "null-cam-rig", camera: null });
  assert.equal(payload.camera, null);
});

test("S2b: imagery 'none' is accepted in stage payload and clears imagery layers in page", async () => {
  const payload = landingStagePayload({
    id: "imagery-none-rig",
    dials: { imagery: "none" },
  });
  assert.equal(payload.globe.imagery, "none");

  const viewer = createFakeViewer();
  assert.equal(viewer.scene.imageryLayers.length, 1);
  globalThis.viewer = viewer;
  const staged = await stageLandingCellInPage({
    ...payload,
    moduleUrl: FAKE_CESIUM_URL,
  });
  assert.equal(staged.dials.imagery.requested, "none");
  assert.equal(staged.dials.imagery.observed, 0);
  assert.equal(staged.dials.imagery.applied, true);
  assert.equal(viewer.scene.imageryLayers.length, 0);
});

// -----------------------------------------------------------------------------
// S8: globeMaterial: the globe's material, applied and read back as its type
// -----------------------------------------------------------------------------

function materialPayload(id, dials) {
  return landingStagePayload({ id, camera: null, clock: null, dials });
}

test("S8: globeMaterial is a globe dial, carried in payload.globe", () => {
  const payload = materialPayload("material-payload-rig", {
    globeShowWaterEffect: false,
    globeMaterial: "WaterMask",
  });
  assert.equal(payload.globe.globeMaterial, "WaterMask");
  assert.equal(payload.globe.globeShowWaterEffect, false);
  assert.equal(payload.water.globeMaterial, undefined);
  assert.equal(payload.scene.globeMaterial, undefined);
});

test("S8: a globeMaterial value outside WaterMask/none is refused in Node, naming it", () => {
  assert.throws(
    () => materialPayload("material-refused-rig", { globeMaterial: "Grid" }),
    (err) => {
      assert.ok(err instanceof ProbeRefusal);
      assert.equal(err.reason, "rig-dial-unsupported");
      assert.ok(
        err.message.includes('globeMaterial="Grid"'),
        `message must name globeMaterial="Grid", got: ${err.message}`,
      );
      return true;
    },
  );
});

test("S8: in the page, WaterMask sets globe.material and reads back applied", async () => {
  const viewer = createFakeViewer();
  globalThis.viewer = viewer;
  const staged = await stageLandingCellInPage({
    ...materialPayload("material-set-rig", { globeMaterial: "WaterMask" }),
    moduleUrl: FAKE_CESIUM_URL,
  });
  assert.equal(viewer.scene.globe.material.type, "WaterMask");
  assert.deepEqual(staged.dials.globeMaterial, {
    requested: "WaterMask",
    observed: "WaterMask",
    applied: true,
  });
  assert.ok(!staged.notApplied.includes("globeMaterial"));
});

test("S8: in the page, none clears a material the globe held and reads back applied", async () => {
  const viewer = createFakeViewer();
  viewer.scene.globe.material = { type: "Grid" };
  globalThis.viewer = viewer;
  const staged = await stageLandingCellInPage({
    ...materialPayload("material-none-rig", { globeMaterial: "none" }),
    moduleUrl: FAKE_CESIUM_URL,
  });
  assert.equal(viewer.scene.globe.material, undefined);
  assert.deepEqual(staged.dials.globeMaterial, {
    requested: "none",
    observed: "none",
    applied: true,
  });
});

test("S8: globeMaterial WaterMask with globeShowWaterEffect false applies both", async () => {
  const viewer = createFakeViewer();
  viewer.scene.globe.showWaterEffect = true;
  globalThis.viewer = viewer;
  const staged = await stageLandingCellInPage({
    ...materialPayload("material-both-rig", {
      globeShowWaterEffect: false,
      globeMaterial: "WaterMask",
    }),
    moduleUrl: FAKE_CESIUM_URL,
  });
  assert.equal(viewer.scene.globe.showWaterEffect, false);
  assert.equal(viewer.scene.globe.material.type, "WaterMask");
  assert.equal(staged.dials.globeShowWaterEffect.applied, true);
  assert.equal(staged.dials.globeMaterial.applied, true);
  assert.deepEqual(staged.notApplied, []);
});

test("S8: a Cesium build without Material reads globeMaterial applied: false with a reason", async () => {
  const viewer = createFakeViewer();
  globalThis.viewer = viewer;
  const noMaterialSource = FAKE_CESIUM_MODULE_SOURCE.replace(
    "export class Material {",
    "class NotExportedMaterial {",
  );
  const staged = await stageLandingCellInPage({
    ...materialPayload("material-missing-rig", { globeMaterial: "WaterMask" }),
    moduleUrl: "data:text/javascript," + encodeURIComponent(noMaterialSource),
  });
  assert.equal(staged.dials.globeMaterial.applied, false);
  assert.equal(staged.dials.globeMaterial.observed, "none");
  assert.ok(staged.dials.globeMaterial.reason);
  assert.ok(staged.notApplied.includes("globeMaterial"));
  assert.equal(viewer.scene.globe.material, undefined);
});

// -----------------------------------------------------------------------------
// S3: cloudsEnabled derivation and needsCloudHarness flag
// -----------------------------------------------------------------------------

test("S3: cloudsEnabled is the rig boolean when given", () => {
  const pTrue = landingStagePayload({
    id: "clouds-true",
    dials: { cloudsEnabled: true },
  });
  assert.equal(pTrue.cloudsEnabled, true);
  assert.equal(pTrue.needsCloudHarness, true);

  const pFalse = landingStagePayload({
    id: "clouds-false",
    dials: { cloudsEnabled: false },
  });
  assert.equal(pFalse.cloudsEnabled, false);
  assert.equal(pFalse.needsCloudHarness, true);
});

test("S3: cloudsEnabled is true when rig has any cloud* dial and no cloudsEnabled", () => {
  const pCov = landingStagePayload({
    id: "cloud-cov",
    dials: { cloudCoverage: 0.6 },
  });
  assert.equal(pCov.cloudsEnabled, true);
  assert.equal(pCov.needsCloudHarness, true);
  assert.equal(pCov.volumetric.cloudCoverage, 0.6);

  const pMulti = landingStagePayload({
    id: "cloud-multi",
    dials: { cloudType: 0, cloudDensity: 0.35, cloudLayerBottom: 1500 },
  });
  assert.equal(pMulti.cloudsEnabled, true);
  assert.equal(pMulti.needsCloudHarness, true);
});

test("S3: cloudsEnabled is null and needsCloudHarness is false when neither is present", () => {
  const pNone = landingStagePayload({
    id: "no-clouds",
    dials: { msaaSamples: 4, globeEnableLighting: true },
  });
  assert.equal(pNone.cloudsEnabled, null);
  assert.equal(pNone.needsCloudHarness, false);
  assert.deepEqual(pNone.volumetric, {});
});

test("S3: explicit cloudsEnabled boolean overrides presence of cloud* dials", () => {
  const pOverride = landingStagePayload({
    id: "cloud-override",
    dials: { cloudCoverage: 0.6, cloudsEnabled: false },
  });
  assert.equal(pOverride.cloudsEnabled, false);
  assert.equal(pOverride.needsCloudHarness, true);
  assert.equal(pOverride.volumetric.cloudCoverage, 0.6);
});

// -----------------------------------------------------------------------------
// S4: stageLandingCellInPage dial application and read-back
// -----------------------------------------------------------------------------

test("S4: stageLandingCellInPage records requested, observed, applied for each dial", async () => {
  globalThis.viewer = createFakeViewer();
  const payload = {
    rigId: "test-s4-records",
    moduleUrl: FAKE_CESIUM_URL,
    camera: null,
    clock: "2026-06-21T12:00:00Z",
    scene: {
      highDynamicRange: true,
      msaaSamples: 4,
      skyBoxShow: true,
      pinClock: true,
    },
    globe: {
      globeEnableLighting: true,
      showGroundAtmosphere: true,
    },
    water: {
      waterQualityPreset: "HIGH",
    },
    volumetric: {},
    cloudsEnabled: null,
    needsCloudHarness: false,
    stepDials: [],
  };
  const staged = await stageLandingCellInPage(payload);
  const allDialKeys = [
    ...Object.keys(payload.scene),
    ...Object.keys(payload.globe),
    ...Object.keys(payload.water),
  ];
  for (const key of allDialKeys) {
    assert.ok(key in staged.dials, `dials must record entry for ${key}`);
    const record = staged.dials[key];
    assert.ok("requested" in record, `${key} must have requested`);
    assert.ok("observed" in record, `${key} must have observed`);
    assert.equal(
      typeof record.applied,
      "boolean",
      `${key}.applied must be boolean`,
    );
  }
});

test("S4: dial whose target property is missing reads applied: false with reason and is in notApplied", async () => {
  const viewer = createFakeViewer();
  delete viewer.scene.msaaSamples;
  delete viewer.scene.globe.showWaterEffect;
  delete viewer.scene.globe.water;
  globalThis.viewer = viewer;

  const payload = {
    rigId: "test-s4-missing",
    moduleUrl: FAKE_CESIUM_URL,
    camera: null,
    clock: null,
    scene: { msaaSamples: 4 },
    globe: { globeShowWaterEffect: true },
    water: { waterQualityPreset: "HIGH" },
    volumetric: {},
    cloudsEnabled: null,
    needsCloudHarness: false,
    stepDials: [],
  };

  const staged = await stageLandingCellInPage(payload);
  for (const key of [
    "msaaSamples",
    "globeShowWaterEffect",
    "waterQualityPreset",
  ]) {
    const entry = staged.dials[key];
    assert.ok(entry, `dial ${key} must be recorded`);
    assert.equal(entry.applied, false, `${key} must not be applied`);
    assert.equal(
      typeof entry.reason,
      "string",
      `${key} must have string reason`,
    );
    assert.ok(entry.reason.length > 0, `${key} reason must not be empty`);
    assert.ok(
      staged.notApplied.includes(key),
      `notApplied must contain ${key}`,
    );
  }
});

test("S4: dial whose property exists and reads back requested value reads applied: true", async () => {
  globalThis.viewer = createFakeViewer();
  const payload = {
    rigId: "test-s4-applied",
    moduleUrl: FAKE_CESIUM_URL,
    camera: null,
    clock: null,
    scene: { highDynamicRange: true },
    globe: { globeEnableLighting: true },
    water: { globalWaterMask: true },
    volumetric: {},
    cloudsEnabled: null,
    needsCloudHarness: false,
    stepDials: [],
  };
  const staged = await stageLandingCellInPage(payload);
  for (const key of [
    "highDynamicRange",
    "globeEnableLighting",
    "globalWaterMask",
  ]) {
    const entry = staged.dials[key];
    assert.ok(entry, `dial ${key} must be recorded`);
    assert.equal(entry.applied, true, `${key} must be applied`);
    assert.equal(entry.observed, true, `${key} observed must match requested`);
    assert.ok(
      !staged.notApplied.includes(key),
      `notApplied must not contain ${key}`,
    );
  }
});

test("S4: leaves viewer.useDefaultRenderLoop and viewer.clock.shouldAnimate false even when rig requests loop", async () => {
  globalThis.viewer = createFakeViewer();
  globalThis.viewer.useDefaultRenderLoop = true;
  globalThis.viewer.clock.shouldAnimate = true;

  const payload = {
    rigId: "test-s4-render-loop",
    moduleUrl: FAKE_CESIUM_URL,
    camera: null,
    clock: "2026-06-21T12:00:00Z",
    scene: { useDefaultRenderLoop: true },
    globe: {},
    water: {},
    volumetric: {},
    cloudsEnabled: null,
    needsCloudHarness: false,
    stepDials: [],
  };

  const staged = await stageLandingCellInPage(payload);
  assert.equal(
    globalThis.viewer.useDefaultRenderLoop,
    false,
    "useDefaultRenderLoop must be false",
  );
  assert.equal(
    globalThis.viewer.clock.shouldAnimate,
    false,
    "clock.shouldAnimate must be false",
  );
  assert.equal(staged.clock.frozen, true, "clock.frozen must be true");
  assert.equal(
    staged.dials.useDefaultRenderLoop.applied,
    false,
    "useDefaultRenderLoop dial must have applied: false",
  );
  assert.equal(typeof staged.dials.useDefaultRenderLoop.reason, "string");
  assert.ok(staged.notApplied.includes("useDefaultRenderLoop"));
});

test("S4: camera setView is executed and observed camera coordinates match cartographic degrees", async () => {
  globalThis.viewer = createFakeViewer();
  const payload = {
    rigId: "test-s4-cam",
    moduleUrl: FAKE_CESIUM_URL,
    camera: { lon: 10, lat: 20, height: 300, heading: 0, pitch: -0.2, roll: 0 },
    clock: null,
    scene: {},
    globe: {},
    water: {},
    volumetric: {},
    cloudsEnabled: null,
    needsCloudHarness: false,
    stepDials: [],
  };
  const staged = await stageLandingCellInPage(payload);
  assert.equal(staged.camera.applied, true);
  assert.deepEqual(staged.camera.requested, payload.camera);
  assert.deepEqual(staged.camera.observed, { lon: 10, lat: 20, height: 300 });
});

// -----------------------------------------------------------------------------
// S5: cloud harness presence and error handling
// -----------------------------------------------------------------------------

test("S5: with needsCloudHarness and no __cloudProbe, cloudsEnabled reads applied: false with reason", async () => {
  delete globalThis.__cloudProbe;
  globalThis.viewer = createFakeViewer();

  const payload = {
    rigId: "test-s5-no-harness",
    moduleUrl: FAKE_CESIUM_URL,
    camera: null,
    clock: null,
    scene: {},
    globe: {},
    water: {},
    volumetric: { cloudType: 0 },
    cloudsEnabled: true,
    needsCloudHarness: true,
    stepDials: [],
  };

  const staged = await stageLandingCellInPage(payload);
  assert.ok(staged.dials.cloudsEnabled, "cloudsEnabled dial record must exist");
  assert.equal(staged.dials.cloudsEnabled.applied, false);
  assert.equal(typeof staged.dials.cloudsEnabled.reason, "string");
  assert.ok(staged.dials.cloudsEnabled.reason.length > 0);
  assert.ok(staged.notApplied.includes("cloudsEnabled"));
  assert.ok(staged.cloud !== null);
  assert.equal(staged.cloud.ok, false);
  assert.equal(
    staged.cloud.reason,
    "the cloud probe harness is not installed on this page",
  );
});

test("S5: with needsCloudHarness and harness configure throwing, cloudsEnabled reads applied: false with reason", async () => {
  globalThis.__cloudProbe = {
    configure() {
      throw new Error("cloud configuration boom");
    },
  };
  globalThis.viewer = createFakeViewer();

  const payload = {
    rigId: "test-s5-throwing-harness",
    moduleUrl: FAKE_CESIUM_URL,
    camera: null,
    clock: null,
    scene: {},
    globe: {},
    water: {},
    volumetric: { cloudCoverage: 0.5 },
    cloudsEnabled: true,
    needsCloudHarness: true,
    stepDials: [],
  };

  const staged = await stageLandingCellInPage(payload);
  assert.ok(staged.dials.cloudsEnabled, "cloudsEnabled dial record must exist");
  assert.equal(staged.dials.cloudsEnabled.applied, false);
  assert.ok(
    staged.dials.cloudsEnabled.reason.includes("cloud configuration boom"),
  );
  assert.ok(staged.notApplied.includes("cloudsEnabled"));
  assert.ok(staged.cloud !== null);
  assert.equal(staged.cloud.ok, false);
  assert.ok(staged.cloud.reason.includes("cloud configuration boom"));
});

test("S5: with needsCloudHarness and successful harness configure, cloudsEnabled reads applied: true", async () => {
  let configuredWith = null;
  globalThis.__cloudProbe = {
    configure(opts) {
      configuredWith = opts;
      return { ok: true, opts };
    },
  };
  globalThis.viewer = createFakeViewer();
  globalThis.viewer.scene.globe.defaultCloudCollection = {
    enableVolumetric: true,
  };

  const payload = {
    rigId: "test-s5-harness-ok",
    moduleUrl: FAKE_CESIUM_URL,
    camera: null,
    clock: null,
    scene: {},
    globe: {},
    water: {},
    volumetric: { cloudCoverage: 0.6 },
    cloudsEnabled: true,
    needsCloudHarness: true,
    stepDials: [],
  };

  const staged = await stageLandingCellInPage(payload);
  assert.ok(staged.dials.cloudsEnabled, "cloudsEnabled dial record must exist");
  assert.equal(staged.dials.cloudsEnabled.applied, true);
  assert.equal(staged.dials.cloudsEnabled.observed, true);
  assert.ok(!staged.notApplied.includes("cloudsEnabled"));
  assert.ok(staged.cloud !== null);
  assert.equal(staged.cloud.ok, true);
  assert.deepEqual(configuredWith, {
    volumetric: { cloudCoverage: 0.6 },
    enableVolumetric: true,
    requireWebGPU: false,
  });
});

test("S4: scene dial whose property exists but accessor clamps or ignores assignment reads applied: false", async () => {
  const viewer = createFakeViewer();
  let msaa = 1;
  Object.defineProperty(viewer.scene, "msaaSamples", {
    get() {
      return msaa;
    },
    set(_val) {
      // Accessor clamps assignment to 1
      msaa = 1;
    },
    configurable: true,
    enumerable: true,
  });
  const hdr = false;
  Object.defineProperty(viewer.scene, "highDynamicRange", {
    get() {
      return hdr;
    },
    set(_val) {
      // Accessor ignores assignment
    },
    configurable: true,
    enumerable: true,
  });
  globalThis.viewer = viewer;

  const payload = {
    rigId: "test-s4-scene-accessor-mismatch",
    moduleUrl: FAKE_CESIUM_URL,
    camera: null,
    clock: null,
    scene: {
      msaaSamples: 4,
      highDynamicRange: true,
    },
    globe: {},
    water: {},
    volumetric: {},
    cloudsEnabled: null,
    needsCloudHarness: false,
    stepDials: [],
  };

  const staged = await stageLandingCellInPage(payload);

  const msaaEntry = staged.dials.msaaSamples;
  assert.ok(msaaEntry, "msaaSamples dial record must exist");
  assert.equal(
    msaaEntry.applied,
    false,
    "msaaSamples must have applied: false",
  );
  assert.equal(msaaEntry.requested, 4, "msaaSamples requested must be 4");
  assert.equal(
    msaaEntry.observed,
    1,
    "msaaSamples observed must equal read-back value 1",
  );
  assert.ok(
    staged.notApplied.includes("msaaSamples"),
    "notApplied must contain msaaSamples",
  );

  const hdrEntry = staged.dials.highDynamicRange;
  assert.ok(hdrEntry, "highDynamicRange dial record must exist");
  assert.equal(
    hdrEntry.applied,
    false,
    "highDynamicRange must have applied: false",
  );
  assert.equal(
    hdrEntry.requested,
    true,
    "highDynamicRange requested must be true",
  );
  assert.equal(
    hdrEntry.observed,
    false,
    "highDynamicRange observed must equal read-back value false",
  );
  assert.ok(
    staged.notApplied.includes("highDynamicRange"),
    "notApplied must contain highDynamicRange",
  );
});

test("S4: globe dial whose property exists but accessor ignores assignment reads applied: false", async () => {
  const viewer = createFakeViewer();
  const lighting = false;
  Object.defineProperty(viewer.scene.globe, "enableLighting", {
    get() {
      return lighting;
    },
    set(_val) {
      // Accessor ignores assignment
    },
    configurable: true,
    enumerable: true,
  });
  globalThis.viewer = viewer;

  const payload = {
    rigId: "test-s4-globe-accessor-mismatch",
    moduleUrl: FAKE_CESIUM_URL,
    camera: null,
    clock: null,
    scene: {},
    globe: {
      globeEnableLighting: true,
    },
    water: {},
    volumetric: {},
    cloudsEnabled: null,
    needsCloudHarness: false,
    stepDials: [],
  };

  const staged = await stageLandingCellInPage(payload);

  const lightingEntry = staged.dials.globeEnableLighting;
  assert.ok(lightingEntry, "globeEnableLighting dial record must exist");
  assert.equal(
    lightingEntry.applied,
    false,
    "globeEnableLighting must have applied: false",
  );
  assert.equal(
    lightingEntry.requested,
    true,
    "globeEnableLighting requested must be true",
  );
  assert.equal(
    lightingEntry.observed,
    false,
    "globeEnableLighting observed must equal read-back value false",
  );
  assert.ok(
    staged.notApplied.includes("globeEnableLighting"),
    "notApplied must contain globeEnableLighting",
  );
});

// Lead addition (Celos, round 3, Ettenmoors pass 2 N-2): the terrain dial's
// read-back must read what the globe HOLDS after the assignment, so a globe
// that ignores or replaces the provider reads applied: false (kills E-19).
const terrainPayload = (rigId) => ({
  rigId,
  moduleUrl: FAKE_CESIUM_URL,
  camera: null,
  clock: null,
  scene: {},
  globe: { terrain: "ellipsoid" },
  water: {},
  volumetric: {},
  cloudsEnabled: null,
  needsCloudHarness: false,
  stepDials: [],
});

test("S4: (ROUND 3, N-2) terrain dial on a globe that ignores the terrainProvider assignment reads applied: false", async () => {
  const viewer = createFakeViewer();
  class WorldTerrainStub {}
  const held = new WorldTerrainStub();
  Object.defineProperty(viewer.scene.globe, "terrainProvider", {
    get() {
      return held;
    },
    set(_value) {
      // The globe keeps its provider: the assignment is ignored.
    },
    configurable: true,
    enumerable: true,
  });
  globalThis.viewer = viewer;

  const staged = await stageLandingCellInPage(
    terrainPayload("test-s4-terrain-ignored"),
  );
  const entry = staged.dials.terrain;
  assert.ok(entry, "terrain dial record must exist");
  assert.equal(entry.requested, "ellipsoid");
  assert.equal(entry.applied, false, "terrain must read applied: false");
  assert.equal(entry.observed, "WorldTerrainStub");
  assert.ok(staged.notApplied.includes("terrain"));
});

test("S4: (ROUND 3, N-2) terrain dial on a globe that refuses the assignment (clears it) reads applied: false", async () => {
  const viewer = createFakeViewer();
  Object.defineProperty(viewer.scene.globe, "terrainProvider", {
    get() {
      return undefined;
    },
    set(_value) {
      // The globe refuses the provider and holds none.
    },
    configurable: true,
    enumerable: true,
  });
  globalThis.viewer = viewer;

  const staged = await stageLandingCellInPage(
    terrainPayload("test-s4-terrain-refused"),
  );
  assert.equal(staged.dials.terrain.applied, false);
  assert.equal(staged.dials.terrain.observed, null);
  assert.ok(staged.notApplied.includes("terrain"));
});

test("S4: (ROUND 3, N-2) terrain dial on a globe that keeps the assignment reads applied: true", async () => {
  globalThis.viewer = createFakeViewer();
  const staged = await stageLandingCellInPage(
    terrainPayload("test-s4-terrain-kept"),
  );
  assert.equal(staged.dials.terrain.applied, true);
  assert.equal(staged.dials.terrain.observed, "EllipsoidTerrainProvider");
  assert.ok(!staged.notApplied.includes("terrain"));
});

// -----------------------------------------------------------------------------
// S6: (ROUND 5, K5-1) waterSimulationEpoch: the ocean's wave epoch, applied by
// the stage before any frame and read back as the ISO instant observed.
// Lead addition (Celos, round 5).
// -----------------------------------------------------------------------------

const EPOCH = "2026-07-18T20:10:00Z";

function epochPayload(id, value = EPOCH) {
  return landingStagePayload({
    id,
    camera: null,
    clock: "2026-07-18T20:10:00Z",
    dials: { waterSimulationEpoch: value },
  });
}

function epochPagePayload(id) {
  return { ...epochPayload(id), moduleUrl: FAKE_CESIUM_URL };
}

// An ocean facade shaped like GlobeWaterOcean: the setter keeps a copy.
function epochOcean(setter) {
  return {
    _epoch: undefined,
    sets: [],
    get simulationEpoch() {
      return this._epoch;
    },
    set simulationEpoch(v) {
      this.sets.push(v);
      this._epoch = setter ? setter(v) : v && { iso: v.iso };
    },
  };
}

test("S6: (ROUND 5, K5-1) waterSimulationEpoch is a water dial, carried as the ISO instant", () => {
  assert.ok(LANDING_WATER_DIALS.includes("waterSimulationEpoch"));
  const payload = epochPayload("test-s6-payload");
  assert.deepEqual(payload.water, { waterSimulationEpoch: EPOCH });
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload);
});

test("S6: (ROUND 5, K5-1) a value that is not an ISO-8601 UTC instant is refused in Node", () => {
  for (const bad of [
    "2026-07-18 20:10",
    1784405400000,
    null,
    "2026-07-18T20:10:00+01:00",
  ]) {
    assert.throws(
      () => epochPayload("test-s6-bad", bad),
      (error) =>
        error instanceof ProbeRefusal &&
        error.reason === "rig-dial-unsupported" &&
        /waterSimulationEpoch=/.test(error.message),
      `${JSON.stringify(bad)} must be refused`,
    );
  }
});

test("S6: (ROUND 5, K5-1) the stage sets ocean.simulationEpoch as a JulianDate and reads it back applied", async () => {
  const viewer = createFakeViewer();
  const ocean = epochOcean();
  viewer.scene.globe.water = { qualityPreset: "LOW", ocean };
  globalThis.viewer = viewer;
  const staged = await stageLandingCellInPage(
    epochPagePayload("test-s6-applied"),
  );
  assert.equal(ocean.sets.length, 1, "the epoch is assigned exactly once");
  assert.equal(typeof ocean.sets[0], "object");
  assert.equal(
    ocean.sets[0].iso,
    EPOCH,
    "assigned as a JulianDate of the instant",
  );
  assert.deepEqual(staged.dials.waterSimulationEpoch, {
    requested: EPOCH,
    observed: EPOCH,
    applied: true,
  });
  assert.ok(!staged.notApplied.includes("waterSimulationEpoch"));
});

test("S6: (ROUND 5, K5-1) a tree without water.ocean.simulationEpoch reads applied: false, not blocking", async () => {
  for (const water of [
    { qualityPreset: "LOW" },
    { qualityPreset: "LOW", ocean: {} },
    undefined,
  ]) {
    const viewer = createFakeViewer();
    viewer.scene.globe.water = water;
    globalThis.viewer = viewer;
    const staged = await stageLandingCellInPage(
      epochPagePayload("test-s6-absent"),
    );
    const dial = staged.dials.waterSimulationEpoch;
    assert.equal(dial.applied, false);
    assert.equal(dial.requested, EPOCH);
    assert.equal(dial.observed, undefined);
    assert.match(dial.reason, /simulationEpoch is not a property here/);
    assert.ok(staged.notApplied.includes("waterSimulationEpoch"));
    assert.deepEqual(
      blockingDials(staged),
      [],
      "a water dial the tree lacks is the BEFORE arm's answer, not a NOT RUN",
    );
  }
});

test("S6: (ROUND 5, K5-1) an ocean that ignores or moves the epoch reads applied: false with what it holds", async () => {
  const cases = [
    { setter: () => undefined, observed: undefined },
    {
      setter: () => ({ iso: "2026-07-18T20:10:01Z" }),
      observed: "2026-07-18T20:10:01Z",
    },
  ];
  for (const { setter, observed } of cases) {
    const viewer = createFakeViewer();
    viewer.scene.globe.water = { ocean: epochOcean(setter) };
    globalThis.viewer = viewer;
    const staged = await stageLandingCellInPage(
      epochPagePayload("test-s6-moved"),
    );
    assert.equal(staged.dials.waterSimulationEpoch.applied, false);
    assert.equal(staged.dials.waterSimulationEpoch.observed, observed);
    assert.equal(staged.dials.waterSimulationEpoch.requested, EPOCH);
  }
});

// -----------------------------------------------------------------------------
// S7: (ROUND 5, K5-2) waitForPendingPipelines: opt-in; drives frames until the
// render pipeline cache reads 0 pending or the deadline, and records it.
// Lead addition (Celos, round 5).
// -----------------------------------------------------------------------------

// A page whose evaluate runs the page function in Node against a fake WebGPU
// viewer whose pipeline cache drains by the given schedule, one entry per
// frame rendered (the last entry repeats; null = no statistics published yet).
function pipelinePage({ schedule, webgpu = true, statistics = true }) {
  const viewer = createFakeViewer();
  const state = { renders: 0, evaluates: 0 };
  viewer.scene.render = () => {
    state.renders++;
  };
  viewer.scene.context = {
    rendererType: webgpu ? "webgpu" : "webgl",
    isWebGPU: webgpu,
    ...(statistics
      ? {
          getRendererStatistics: () => {
            const pending =
              schedule[Math.min(state.renders, schedule.length - 1)];
            return pending === null
              ? {}
              : { pipelineCache: { pending, created: 10 + state.renders } };
          },
        }
      : {}),
  };
  const page = {
    async evaluate(fn, arg) {
      state.evaluates++;
      globalThis.viewer = viewer;
      return fn(
        arg && arg.moduleUrl ? { ...arg, moduleUrl: FAKE_CESIUM_URL } : arg,
      );
    },
  };
  return { page, state };
}

const PIPELINE_RIG = { id: "test-s7", camera: null, clock: null, dials: {} };

test.before(() => {
  globalThis.requestAnimationFrame ??= (callback) => setImmediate(callback);
});

test("S7: (ROUND 5, K5-2) off by default: no wait, no frame, pipelines null", async () => {
  const { page, state } = pipelinePage({ schedule: [5] });
  const result = await stageLandingCell({ page, rig: PIPELINE_RIG });
  assert.equal(result.pipelines, null);
  assert.equal(state.renders, 0);
  assert.equal(state.evaluates, 1);
});

test("S7: (ROUND 5, K5-2) on: frames are driven until the cache reads 0 pending, and recorded", async () => {
  const { page, state } = pipelinePage({ schedule: [5, 5, 3, 1, 0] });
  const { pipelines } = await stageLandingCell({
    page,
    rig: PIPELINE_RIG,
    waitForPendingPipelines: true,
  });
  assert.equal(pipelines.requested, true);
  assert.equal(pipelines.available, true);
  assert.equal(pipelines.pendingAtStart, 5);
  assert.equal(pipelines.pendingAtEnd, 0);
  assert.equal(pipelines.pendingMax, 5);
  assert.equal(pipelines.timedOut, false);
  assert.equal(pipelines.framesWaited, state.renders);
  // Four frames to drain, then settleReads - 1 more frames reading 0.
  assert.equal(
    pipelines.framesWaited,
    4 + PIPELINE_WAIT_DEFAULTS.settleReads - 1,
  );
  assert.ok(pipelines.waitedMs >= 0);
});

test("S7: (ROUND 5, K5-2) a cache that reads 0 before any frame is not yet drained: frames render first", async () => {
  const { page, state } = pipelinePage({ schedule: [0] });
  const { pipelines } = await stageLandingCell({
    page,
    rig: PIPELINE_RIG,
    waitForPendingPipelines: true,
  });
  assert.equal(pipelines.timedOut, false);
  assert.ok(state.renders >= 1);
  assert.equal(pipelines.framesWaited, PIPELINE_WAIT_DEFAULTS.settleReads);
});

test("S7: (ROUND 5, K5-2) statistics not yet published read as not drained", async () => {
  const { page } = pipelinePage({ schedule: [null, null, 2, 0] });
  const { pipelines } = await stageLandingCell({
    page,
    rig: PIPELINE_RIG,
    waitForPendingPipelines: { settleReads: 1 },
  });
  assert.equal(pipelines.pendingAtStart, null);
  assert.equal(pipelines.pendingAtEnd, 0);
  assert.equal(pipelines.framesWaited, 3);
  assert.equal(pipelines.timedOut, false);
});

test("S7: (ROUND 5, K5-2) a cache that never drains times out at the frame cap, recording what is still pending", async () => {
  const { page, state } = pipelinePage({ schedule: [5] });
  const { pipelines } = await stageLandingCell({
    page,
    rig: PIPELINE_RIG,
    waitForPendingPipelines: { maxFrames: 4, deadlineMs: 1e9 },
  });
  assert.equal(pipelines.timedOut, true);
  assert.equal(pipelines.framesWaited, 4);
  assert.equal(state.renders, 4);
  assert.equal(pipelines.pendingAtEnd, 5);
});

test("S7: (ROUND 5, K5-2) on WebGL there is no pipeline cache: nothing renders and the record says why", async () => {
  const { page, state } = pipelinePage({ schedule: [5], webgpu: false });
  const { pipelines } = await stageLandingCell({
    page,
    rig: PIPELINE_RIG,
    waitForPendingPipelines: true,
  });
  assert.equal(pipelines.available, false);
  assert.equal(pipelines.framesWaited, 0);
  assert.equal(pipelines.timedOut, false);
  assert.equal(state.renders, 0);
  assert.match(pipelines.reason, /WebGPU-only/);
  const now = await readPendingPipelines(page);
  assert.equal(now.available, false);
  assert.equal(now.pending, null);
});

test("S7: (ROUND 5, K5-2) readPendingPipelines reads the cache's pending and created counts", async () => {
  const { page } = pipelinePage({ schedule: [7] });
  assert.deepEqual(await readPendingPipelines(page), {
    available: true,
    rendererType: "webgpu",
    pending: 7,
    created: 10,
  });
  const bare = pipelinePage({ schedule: [7], statistics: false });
  const none = await readPendingPipelines(bare.page);
  assert.equal(none.available, false);
  assert.match(none.reason, /getRendererStatistics/);
});

// -----------------------------------------------------------------------------
// S8: (DX-KIT-WATER-OCEAN-DIAL, lane A salvage) waterOceanEnabled - the
// product's FFT ocean switch, read back by the primitive the facade builds -
// plus the globeShow and SSR scene dials the FFT and SSR probes' rigs use.
// Lead addition (Andustar).
// -----------------------------------------------------------------------------

const STAGE_MODULE = fileURLToPath(
  new URL("./lib/landing-cell-stage.mjs", import.meta.url),
);

// An ocean facade shaped like Scene/GlobeWaterOcean.js: setting `enabled`
// true builds one primitive and adds it to scene.primitives, false removes it.
// `build: false` is a facade that keeps the flag but builds nothing.
function fftOcean(scene, { build = true } = {}) {
  return {
    _enabled: false,
    _primitive: undefined,
    get enabled() {
      return this._enabled;
    },
    set enabled(value) {
      value = value === true;
      if (value === this._enabled) {
        return;
      }
      this._enabled = value;
      if (value && build) {
        this._primitive = { kind: "OceanSurfacePrimitive" };
        scene.primitives.push(this._primitive);
      } else if (!value && this._primitive) {
        scene.primitives.splice(scene.primitives.indexOf(this._primitive), 1);
        this._primitive = undefined;
      }
    },
    get primitive() {
      return this._primitive;
    },
  };
}

function oceanViewer(options) {
  const viewer = createFakeViewer();
  viewer.scene.primitives = [];
  viewer.scene.globe.show = true;
  viewer.scene.enableSSR = false;
  viewer.scene.deferredLighting = false;
  viewer.scene.globe.water = {
    qualityPreset: "LOW",
    ocean: fftOcean(viewer.scene, options),
  };
  return viewer;
}

function oceanPagePayload(value) {
  return {
    ...landingStagePayload({
      id: "test-s8-ocean",
      camera: null,
      clock: null,
      dials: { waterOceanEnabled: value },
    }),
    moduleUrl: FAKE_CESIUM_URL,
  };
}

// The behaviour the dial promises, as one check a mutant can be held to: on a
// page whose ocean facade works, turning the dial on leaves exactly one ocean
// primitive in the scene and reads applied, and turning it off removes it.
async function assertOceanDialDrivesThePrimitive(stage) {
  const viewer = oceanViewer();
  globalThis.viewer = viewer;
  const on = await stage(oceanPagePayload(true));
  assert.equal(viewer.scene.primitives.length, 1, "the ocean primitive exists");
  assert.deepEqual(on.dials.waterOceanEnabled, {
    requested: true,
    observed: true,
    applied: true,
    primitive: true,
  });
  const off = await stage(oceanPagePayload(false));
  assert.equal(viewer.scene.primitives.length, 0, "the primitive is removed");
  assert.equal(off.dials.waterOceanEnabled.applied, true);
  assert.equal(off.dials.waterOceanEnabled.primitive, false);
}

test("S8: waterOceanEnabled is a water dial; a non-boolean value is refused in Node", () => {
  assert.ok(LANDING_WATER_DIALS.includes("waterOceanEnabled"));
  assert.deepEqual(oceanPagePayload(true).water, { waterOceanEnabled: true });
  for (const bad of ["true", 1, null]) {
    assert.throws(
      () => oceanPagePayload(bad),
      (error) =>
        error instanceof ProbeRefusal &&
        error.reason === "rig-dial-unsupported" &&
        /waterOceanEnabled=/.test(error.message),
      `${JSON.stringify(bad)} must be refused`,
    );
  }
});

test("S8: the dial turns the FFT ocean on and off and reads the primitive back", async () => {
  await assertOceanDialDrivesThePrimitive(stageLandingCellInPage);
});

test("S8: a facade that keeps the flag but builds no primitive reads applied: false", async () => {
  const viewer = oceanViewer({ build: false });
  globalThis.viewer = viewer;
  const staged = await stageLandingCellInPage(oceanPagePayload(true));
  const dial = staged.dials.waterOceanEnabled;
  assert.equal(dial.observed, true);
  assert.equal(dial.primitive, false);
  assert.equal(dial.applied, false);
  assert.match(dial.reason, /no ocean primitive exists/);
  assert.ok(staged.notApplied.includes("waterOceanEnabled"));
});

test("S8: a tree without water.ocean.enabled reads applied: false, not blocking", async () => {
  for (const water of [{ qualityPreset: "LOW", ocean: {} }, undefined]) {
    const viewer = createFakeViewer();
    viewer.scene.globe.water = water;
    globalThis.viewer = viewer;
    const staged = await stageLandingCellInPage(oceanPagePayload(true));
    const dial = staged.dials.waterOceanEnabled;
    assert.equal(dial.applied, false);
    assert.match(dial.reason, /enabled is not a property here/);
    assert.deepEqual(blockingDials(staged), []);
  }
});

test("S8: inertness mutant - with the waterOceanEnabled branch unreachable the dial check goes red", async () => {
  const mutated = await importMutated(STAGE_MODULE, [
    [
      `} else if (key === "waterOceanEnabled") {`,
      `} else if (false && key === "waterOceanEnabled") {`,
    ],
  ]);
  await assert.rejects(
    assertOceanDialDrivesThePrimitive(mutated.stageLandingCellInPage),
    (error) => error instanceof assert.AssertionError,
    "the mutant must fail the dial check by assertion, not by a harness error",
  );
});

test("S8: rig ocean-fft-patch-rebase is live through the dial: its payload carries waterOceanEnabled and stages it", async () => {
  const rigs = await loadRigs();
  const rig = rigById(rigs, "ocean-fft-patch-rebase");
  const payload = landingStagePayload(rig);
  assert.equal(payload.water.waterOceanEnabled, true);
  const viewer = oceanViewer();
  globalThis.viewer = viewer;
  const staged = await stageLandingCellInPage({
    ...payload,
    moduleUrl: FAKE_CESIUM_URL,
  });
  assert.equal(staged.dials.waterOceanEnabled.applied, true);
  assert.equal(viewer.scene.primitives.length, 1);
});

// The four scene dials as one check, so the mutants below can be held to it.
async function assertSceneSwitchesApply(stage) {
  const viewer = oceanViewer();
  globalThis.viewer = viewer;
  const staged = await stage({
    ...landingStagePayload({
      id: "test-s8-ssr",
      camera: null,
      clock: null,
      dials: {
        globeShow: false,
        enableSSR: true,
        deferredLighting: true,
        ssrReflectionStrength: 1,
      },
    }),
    moduleUrl: FAKE_CESIUM_URL,
  });
  assert.equal(viewer.scene.globe.show, false);
  assert.equal(viewer.scene.enableSSR, true);
  assert.equal(viewer.scene.deferredLighting, true);
  assert.equal(viewer.scene.ssrReflectionStrength, 1);
  for (const key of [
    "globeShow",
    "enableSSR",
    "deferredLighting",
    "ssrReflectionStrength",
  ]) {
    assert.equal(staged.dials[key].applied, true, key);
  }
}

test("S8: globeShow, enableSSR, deferredLighting and ssrReflectionStrength apply and read back", async () => {
  await assertSceneSwitchesApply(stageLandingCellInPage);
});

test("S8: inertness mutants - each scene switch made unreachable turns the check red", async () => {
  for (const [anchor, replacement] of [
    [
      `      assign(key, globe, "show", value);`,
      `      if (false) assign(key, globe, "show", value);`,
    ],
    [
      `      assign(key, scene, "enableSSR", value);`,
      `      if (false) assign(key, scene, "enableSSR", value);`,
    ],
    [
      `      assign(key, scene, "deferredLighting", value);`,
      `      if (false) assign(key, scene, "deferredLighting", value);`,
    ],
    [
      `      scene.ssrReflectionStrength = value;`,
      `      if (false) scene.ssrReflectionStrength = value;`,
    ],
  ]) {
    const mutated = await importMutated(STAGE_MODULE, [[anchor, replacement]]);
    await assert.rejects(
      assertSceneSwitchesApply(mutated.stageLandingCellInPage),
      (error) => error instanceof assert.AssertionError,
      `mutant ${replacement.trim()} must fail by assertion`,
    );
  }
});

// -----------------------------------------------------------------------------
// S9: the two dials the ocean-kernel Edge cells need (lane LINDISSE):
// waterOceanIfftKernel (the FFT ocean's inverse-FFT kernel, read back on the
// facade and on the primitive) and sceneMode (3D, 2D, Columbus view).
// -----------------------------------------------------------------------------

const FAKE_SCENE_MODE_SOURCE =
  FAKE_CESIUM_MODULE_SOURCE +
  `
export const SceneMode = Object.freeze({
  MORPHING: 0,
  COLUMBUS_VIEW: 1,
  SCENE2D: 2,
  SCENE3D: 3,
  getMorphTime() {
    return 0;
  },
});
`;
const FAKE_SCENE_MODE_URL =
  "data:text/javascript," + encodeURIComponent(FAKE_SCENE_MODE_SOURCE);

// A facade shaped like Scene/GlobeWaterOcean.js: the kernel setter accepts the
// two names only and forwards to the primitive; the primitive is created with
// the facade's kernel. `forward: false` is a facade that forgets to forward.
function kernelOcean(scene, { forward = true } = {}) {
  return {
    _enabled: false,
    _ifftKernel: "stockham",
    _primitive: undefined,
    get enabled() {
      return this._enabled;
    },
    set enabled(value) {
      value = value === true;
      if (value === this._enabled) {
        return;
      }
      this._enabled = value;
      if (value) {
        this._primitive = { ifftKernel: this._ifftKernel };
        scene.primitives.push(this._primitive);
      } else if (this._primitive) {
        scene.primitives.splice(scene.primitives.indexOf(this._primitive), 1);
        this._primitive = undefined;
      }
    },
    get primitive() {
      return this._primitive;
    },
    get ifftKernel() {
      return this._ifftKernel;
    },
    set ifftKernel(value) {
      if (value === "stockham" || value === "pingpong") {
        this._ifftKernel = value;
        if (forward && this._primitive) {
          this._primitive.ifftKernel = value;
        }
      }
    },
  };
}

function kernelViewer(options) {
  const viewer = oceanViewer();
  viewer.scene.globe.water.ocean = kernelOcean(viewer.scene, options);
  return viewer;
}

function kernelPayload(dials, moduleUrl = FAKE_CESIUM_URL) {
  return {
    ...landingStagePayload({
      id: "test-s9-kernel",
      camera: null,
      clock: null,
      dials,
    }),
    moduleUrl,
  };
}

// The kernel dial's promise, as one check a mutant can be held to: on a page
// whose facade works, the dial reads back on the facade AND the primitive,
// whichever side of waterOceanEnabled the rig lists it.
async function assertKernelDialApplies(stage) {
  for (const dials of [
    { waterOceanEnabled: true, waterOceanIfftKernel: "pingpong" },
    { waterOceanIfftKernel: "pingpong", waterOceanEnabled: true },
  ]) {
    const viewer = kernelViewer();
    globalThis.viewer = viewer;
    const staged = await stage(kernelPayload(dials));
    assert.deepEqual(
      staged.dials.waterOceanIfftKernel,
      {
        requested: "pingpong",
        observed: "pingpong",
        applied: true,
        primitiveKernel: "pingpong",
      },
      `key order ${Object.keys(dials).join(", ")}`,
    );
    assert.equal(viewer.scene.primitives[0].ifftKernel, "pingpong");
    assert.equal(staged.dials.waterOceanEnabled.applied, true);
    assert.deepEqual(staged.notApplied, []);
  }
}

test("S9: the dial vocabularies are exactly the kernel names and the SceneMode names", () => {
  assert.deepEqual([...LANDING_IFFT_KERNEL_VALUES], ["stockham", "pingpong"]);
  assert.deepEqual(
    [...LANDING_SCENE_MODE_VALUES],
    ["SCENE3D", "SCENE2D", "COLUMBUS_VIEW"],
  );
  assert.ok(LANDING_WATER_DIALS.includes("waterOceanIfftKernel"));
  assert.ok(LANDING_SCENE_DIALS.includes("sceneMode"));
});

test("S9: waterOceanIfftKernel is a water dial and sceneMode a scene dial in the payload", () => {
  const payload = kernelPayload({
    waterOceanIfftKernel: "stockham",
    sceneMode: "SCENE2D",
  });
  assert.deepEqual(payload.water, { waterOceanIfftKernel: "stockham" });
  assert.deepEqual(payload.scene, { sceneMode: "SCENE2D" });
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload);
});

test("S9: a kernel outside stockham/pingpong and a mode outside the three names are refused in Node", () => {
  const refusal = (pattern) => (error) =>
    error instanceof ProbeRefusal &&
    error.reason === "rig-dial-unsupported" &&
    pattern.test(error.message);
  for (const bad of ["Stockham", "fft", true, null, 1]) {
    assert.throws(
      () => kernelPayload({ waterOceanIfftKernel: bad }),
      refusal(/waterOceanIfftKernel=/),
      `kernel ${JSON.stringify(bad)} must be refused`,
    );
  }
  for (const bad of ["2D", "scene3d", "MORPHING", null, 3]) {
    assert.throws(
      () => kernelPayload({ sceneMode: bad }),
      refusal(/sceneMode=/),
      `mode ${JSON.stringify(bad)} must be refused`,
    );
  }
});

test("S9: the kernel reads back on the facade and the primitive, in either key order", async () => {
  await assertKernelDialApplies(stageLandingCellInPage);
});

test("S9: a kernel dial with no primitive reads applied: false, not blocking", async () => {
  const viewer = kernelViewer();
  globalThis.viewer = viewer;
  const staged = await stageLandingCellInPage(
    kernelPayload({ waterOceanIfftKernel: "pingpong" }),
  );
  const dial = staged.dials.waterOceanIfftKernel;
  assert.equal(dial.applied, false);
  assert.equal(dial.observed, "pingpong");
  assert.equal(dial.primitiveKernel, undefined);
  assert.match(dial.reason, /no ocean primitive exists/);
  assert.deepEqual(blockingDials(staged), []);
});

test("S9: a primitive that does not take the kernel reads applied: false naming it", async () => {
  const viewer = kernelViewer({ forward: false });
  globalThis.viewer = viewer;
  const staged = await stageLandingCellInPage(
    kernelPayload({
      waterOceanEnabled: true,
      waterOceanIfftKernel: "pingpong",
    }),
  );
  const dial = staged.dials.waterOceanIfftKernel;
  assert.equal(dial.observed, "pingpong");
  assert.equal(dial.primitiveKernel, "stockham");
  assert.equal(dial.applied, false);
  assert.match(dial.reason, /primitive reads kernel stockham, not pingpong/);
});

test("S9: a tree without ocean.ifftKernel reads applied: false, not blocking", async () => {
  for (const water of [{ qualityPreset: "LOW", ocean: {} }, undefined]) {
    const viewer = createFakeViewer();
    viewer.scene.globe.water = water;
    globalThis.viewer = viewer;
    const staged = await stageLandingCellInPage(
      kernelPayload({ waterOceanIfftKernel: "pingpong" }),
    );
    const dial = staged.dials.waterOceanIfftKernel;
    assert.equal(dial.applied, false);
    assert.match(dial.reason, /ifftKernel is not a property here/);
    assert.deepEqual(blockingDials(staged), []);
  }
});

test("S9: inertness mutants - each clause of the kernel dial made unreachable turns the check red", async () => {
  for (const [anchor, replacement] of [
    // The deferral: the kernel dial processed in the rig's key order.
    [
      `    ([a], [b]) =>
      (a === "waterOceanIfftKernel") - (b === "waterOceanIfftKernel"),`,
      `    () => 0,`,
    ],
    // The branch itself: the dial falls through to the globe's generic assign.
    [
      `} else if (key === "waterOceanIfftKernel") {`,
      `} else if (false && key === "waterOceanIfftKernel") {`,
    ],
  ]) {
    const mutated = await importMutated(STAGE_MODULE, [[anchor, replacement]]);
    await assert.rejects(
      assertKernelDialApplies(mutated.stageLandingCellInPage),
      (error) => error instanceof assert.AssertionError,
      `mutant ${replacement.trim()} must fail by assertion`,
    );
  }
});

test("S9: inertness mutants - the primitive checks made unreachable turn the negative cases red", async () => {
  const noPrimitive = async (stage) => {
    globalThis.viewer = kernelViewer();
    const staged = await stage(
      kernelPayload({ waterOceanIfftKernel: "pingpong" }),
    );
    const dial = staged.dials.waterOceanIfftKernel;
    assert.equal(dial.applied, false);
    assert.match(dial.reason, /no ocean primitive exists/);
  };
  const notForwarded = async (stage) => {
    globalThis.viewer = kernelViewer({ forward: false });
    const staged = await stage(
      kernelPayload({
        waterOceanEnabled: true,
        waterOceanIfftKernel: "pingpong",
      }),
    );
    assert.equal(staged.dials.waterOceanIfftKernel.applied, false);
  };
  await noPrimitive(stageLandingCellInPage);
  await notForwarded(stageLandingCellInPage);
  const noPrimitiveMutant = await importMutated(STAGE_MODULE, [
    [`if (!hasPrimitive) {`, `if (false && !hasPrimitive) {`],
  ]);
  await assert.rejects(
    noPrimitive(noPrimitiveMutant.stageLandingCellInPage),
    (error) => error instanceof assert.AssertionError,
  );
  const forwardMutant = await importMutated(STAGE_MODULE, [
    [
      `} else if (!same(entry.primitiveKernel, value)) {`,
      `} else if (false && !same(entry.primitiveKernel, value)) {`,
    ],
  ]);
  await assert.rejects(
    notForwarded(forwardMutant.stageLandingCellInPage),
    (error) => error instanceof assert.AssertionError,
  );
});

test("S9: the Node-side kernel and mode refusals are live (inertness mutants)", async () => {
  for (const [anchor, replacement, dials] of [
    [
      `!LANDING_IFFT_KERNEL_VALUES.includes(water.waterOceanIfftKernel)`,
      `false && !LANDING_IFFT_KERNEL_VALUES.includes(water.waterOceanIfftKernel)`,
      { waterOceanIfftKernel: "fft" },
    ],
    [
      `!LANDING_SCENE_MODE_VALUES.includes(scene.sceneMode)`,
      `false && !LANDING_SCENE_MODE_VALUES.includes(scene.sceneMode)`,
      { sceneMode: "2D" },
    ],
  ]) {
    const mutated = await importMutated(STAGE_MODULE, [[anchor, replacement]]);
    assert.doesNotThrow(
      () =>
        mutated.landingStagePayload({
          id: "m",
          camera: null,
          clock: null,
          dials,
        }),
      "the mutant lets the bad value through, so the refusal test is live",
    );
    assert.throws(
      () => landingStagePayload({ id: "m", camera: null, clock: null, dials }),
      ProbeRefusal,
    );
  }
});

// A scene whose morphTo* methods change `mode` like a duration-0 morph does.
// `morphs: false` leaves the mode alone; `throws` makes the morph throw.
function sceneModeViewer({ morphs = true, throws = null } = {}) {
  const viewer = oceanViewer();
  const scene = viewer.scene;
  scene.mode = 3;
  const morphTo = (mode) => () => {
    if (throws) {
      throw new Error(throws);
    }
    if (morphs) {
      scene.mode = mode;
    }
  };
  scene.morphTo3D = morphTo(3);
  scene.morphTo2D = morphTo(2);
  scene.morphToColumbusView = morphTo(1);
  return viewer;
}

async function assertSceneModeMorphs(stage) {
  for (const [name, mode] of [
    ["SCENE2D", 2],
    ["COLUMBUS_VIEW", 1],
    ["SCENE3D", 3],
  ]) {
    const viewer = sceneModeViewer();
    viewer.scene.mode = name === "SCENE3D" ? 2 : 3;
    globalThis.viewer = viewer;
    const staged = await stage(
      kernelPayload({ sceneMode: name }, FAKE_SCENE_MODE_URL),
    );
    assert.equal(viewer.scene.mode, mode, name);
    assert.deepEqual(staged.dials.sceneMode, {
      requested: name,
      observed: name,
      applied: true,
    });
    assert.deepEqual(staged.notApplied, []);
  }
}

test("S9: sceneMode morphs with duration 0 and reads the mode back by name", async () => {
  await assertSceneModeMorphs(stageLandingCellInPage);
});

test("S9: a morph with duration 0 is what is called", async () => {
  const viewer = sceneModeViewer();
  const durations = [];
  const original = viewer.scene.morphTo2D;
  viewer.scene.morphTo2D = (duration) => {
    durations.push(duration);
    original(duration);
  };
  globalThis.viewer = viewer;
  await stageLandingCellInPage(
    kernelPayload({ sceneMode: "SCENE2D" }, FAKE_SCENE_MODE_URL),
  );
  assert.deepEqual(durations, [0]);
});

test("S9: a morph that leaves the mode unchanged reads applied: false, blocking", async () => {
  const viewer = sceneModeViewer({ morphs: false });
  globalThis.viewer = viewer;
  const staged = await stageLandingCellInPage(
    kernelPayload({ sceneMode: "SCENE2D" }, FAKE_SCENE_MODE_URL),
  );
  assert.deepEqual(staged.dials.sceneMode, {
    requested: "SCENE2D",
    observed: "SCENE3D",
    applied: false,
  });
  assert.deepEqual(blockingDials(staged), ["sceneMode"]);
});

test("S9: a morph that throws reads applied: false with its message", async () => {
  const viewer = sceneModeViewer({ throws: "no 2D here" });
  globalThis.viewer = viewer;
  const staged = await stageLandingCellInPage(
    kernelPayload({ sceneMode: "SCENE2D" }, FAKE_SCENE_MODE_URL),
  );
  const dial = staged.dials.sceneMode;
  assert.equal(dial.applied, false);
  assert.match(dial.reason, /scene mode morph failed: no 2D here/);
});

test("S9: a Cesium build without SceneMode reads applied: false with a reason", async () => {
  const viewer = sceneModeViewer();
  globalThis.viewer = viewer;
  const staged = await stageLandingCellInPage(
    kernelPayload({ sceneMode: "SCENE2D" }, FAKE_CESIUM_URL),
  );
  assert.equal(staged.dials.sceneMode.applied, false);
  assert.match(staged.dials.sceneMode.reason, /exports no SceneMode/);
});

test("S9: inertness mutants - the morph call and the read-back comparison made unreachable turn the check red", async () => {
  const unchanged = async (stage) => {
    globalThis.viewer = sceneModeViewer({ morphs: false });
    const staged = await stage(
      kernelPayload({ sceneMode: "SCENE2D" }, FAKE_SCENE_MODE_URL),
    );
    assert.equal(staged.dials.sceneMode.applied, false);
  };
  await unchanged(stageLandingCellInPage);
  for (const [anchor, replacement, check] of [
    [`scene[morph](0);`, `if (false) scene[morph](0);`, assertSceneModeMorphs],
    [
      `!!modes && same(scene.mode, modes[value]),`,
      `!!modes && (true || same(scene.mode, modes[value])),`,
      unchanged,
    ],
  ]) {
    const mutated = await importMutated(STAGE_MODULE, [[anchor, replacement]]);
    await assert.rejects(
      check(mutated.stageLandingCellInPage),
      (error) => error instanceof assert.AssertionError,
      `mutant ${replacement} must fail by assertion`,
    );
  }
});

// -----------------------------------------------------------------------------
// S10: the 2D and Columbus identity rigs stage their mode FIRST, then pin the
// rig's camera in that mode (DX-KIT-2D-CV-RIG-PINNED-CAMERA, lane A2). The
// order is observed through the fake page: a log of the morph and the
// setView, each stamped with the scene mode current when it ran.
// -----------------------------------------------------------------------------

const MODE_RIGS = Object.freeze([
  { id: "default-2d-pinned", morph: "morphTo2D", mode: 2 },
  { id: "default-columbus-pinned", morph: "morphToColumbusView", mode: 1 },
]);

function orderedModeViewer() {
  const viewer = sceneModeViewer();
  const events = [];
  for (const morph of ["morphTo3D", "morphTo2D", "morphToColumbusView"]) {
    const original = viewer.scene[morph];
    viewer.scene[morph] = (duration) => {
      original(duration);
      events.push({ call: morph, duration, modeAfter: viewer.scene.mode });
    };
  }
  viewer.camera.setView = function setView(options) {
    this.lastSetView = options;
    events.push({
      call: "setView",
      mode: viewer.scene.mode,
      destination: { ...options.destination },
      orientation: { ...options.orientation },
    });
  };
  return { viewer, events };
}

// The behaviour the rig promises, as one check a mutant can be held to.
async function assertRigStagesModeThenCamera(stage, rig, expected) {
  const { viewer, events } = orderedModeViewer();
  globalThis.viewer = viewer;
  const payload = {
    ...landingStagePayload(rig),
    moduleUrl: FAKE_SCENE_MODE_URL,
  };
  const staged = await stage(payload);
  assert.deepEqual(
    events.map((event) => event.call),
    [expected.morph, "setView"],
    `${rig.id}: the mode morph, then the camera`,
  );
  assert.equal(events[0].duration, 0, `${rig.id}: a zero-duration morph`);
  assert.equal(events[0].modeAfter, expected.mode, `${rig.id}: mode reached`);
  // The fake `Cartesian3.fromDegrees` keeps (lon, lat, height) as (x, y, z).
  assert.equal(
    events[1].mode,
    expected.mode,
    `${rig.id}: setView ran in the mode, not before it`,
  );
  assert.deepEqual(events[1].destination, {
    x: rig.camera.lon,
    y: rig.camera.lat,
    z: rig.camera.height,
  });
  assert.deepEqual(events[1].orientation, {
    heading: rig.camera.heading,
    pitch: rig.camera.pitch,
    roll: rig.camera.roll,
  });
  assert.equal(staged.camera.applied, true);
  assert.deepEqual(staged.camera.requested, payload.camera);
  assert.deepEqual(staged.camera.requested, { ...rig.camera });
  assert.deepEqual(staged.dials.sceneMode, {
    requested: rig.dials.sceneMode,
    observed: rig.dials.sceneMode,
    applied: true,
  });
  assert.deepEqual(staged.notApplied, []);
}

test("S10: the 2D and Columbus identity rigs stage the mode first and then their pinned camera", async () => {
  const rigs = await loadRigs();
  for (const entry of MODE_RIGS) {
    await assertRigStagesModeThenCamera(
      stageLandingCellInPage,
      rigById(rigs, entry.id),
      entry,
    );
  }
});

test("S10: inertness mutants - a rig without its camera, a stage that skips the camera, a stage that skips the morph", async () => {
  const rigs = await loadRigs();
  const noCameraMutant = await importMutated(STAGE_MODULE, [
    [
      `if (payload.camera !== null) {`,
      `if (false && payload.camera !== null) {`,
    ],
  ]);
  const noMorphMutant = await importMutated(STAGE_MODULE, [
    [`scene[morph](0);`, `if (false) scene[morph](0);`],
  ]);
  for (const entry of MODE_RIGS) {
    const rig = rigById(rigs, entry.id);
    // The unmutated stage passes the same scenario.
    await assertRigStagesModeThenCamera(stageLandingCellInPage, rig, entry);
    await assert.rejects(
      assertRigStagesModeThenCamera(
        stageLandingCellInPage,
        { ...rig, camera: null },
        { ...entry },
      ),
      (error) =>
        error instanceof TypeError || error instanceof assert.AssertionError,
      `${entry.id} with camera: null must fail`,
    );
    await assert.rejects(
      assertRigStagesModeThenCamera(
        noCameraMutant.stageLandingCellInPage,
        rig,
        entry,
      ),
      (error) => error instanceof assert.AssertionError,
      `${entry.id}: a stage that never places the camera must fail`,
    );
    await assert.rejects(
      assertRigStagesModeThenCamera(
        noMorphMutant.stageLandingCellInPage,
        rig,
        entry,
      ),
      (error) => error instanceof assert.AssertionError,
      `${entry.id}: a stage that never morphs must fail`,
    );
  }
});

// -----------------------------------------------------------------------------
// S11: the globeFragmentDebug dial - sets the WebGPU globe's debug-mode global
// before the stage returns and reads it back against the registry the WebGPU
// chunk publishes; on WebGL it is a recorded no-op that never fails a stage.
// -----------------------------------------------------------------------------

const FRAGMENT_DEBUG_SOURCE = fileURLToPath(
  new URL(
    "../../packages/engine/Source/Renderer/WebGPU/WebGPUGlobeFragmentDebug.ts",
    import.meta.url,
  ),
);

const fragmentDebugPayload = (value) =>
  kernelPayload({ globeFragmentDebug: value });

const fragmentDebugViewer = (rendererType) => {
  const viewer = createFakeViewer();
  viewer.scene.context = {
    rendererType,
    isWebGPU: rendererType === "webgpu",
  };
  return viewer;
};

const registryOf = (...names) => names.map((name) => ({ name, sentinel: 1 }));

test("S11: the mode names equal the name entries of the WebGPU registry source", () => {
  const source = fs.readFileSync(FRAGMENT_DEBUG_SOURCE, "utf8");
  const start = source.indexOf("export const GLOBE_FRAGMENT_DEBUG_MODES");
  const end = source.indexOf("const _MODE_BY_NAME");
  assert.ok(start >= 0 && end > start, "the registry array is where expected");
  const names = [
    ...source.slice(start, end).matchAll(/^\s*name:\s*"([^"]+)"/gm),
  ].map((match) => match[1]);
  assert.ok(names.length > 0);
  assert.deepEqual([...GLOBE_FRAGMENT_DEBUG_MODE_NAMES], names);
  assert.ok(Object.isFrozen(GLOBE_FRAGMENT_DEBUG_MODE_NAMES));
  assert.ok(LANDING_GLOBE_DIALS.includes("globeFragmentDebug"));
});

test("S11: the payload carries every listed mode and none as a globe dial, and refuses any other value", () => {
  for (const value of [
    ...GLOBE_FRAGMENT_DEBUG_MODE_NAMES,
    GLOBE_FRAGMENT_DEBUG_OFF,
  ]) {
    assert.deepEqual(fragmentDebugPayload(value).globe, {
      globeFragmentDebug: value,
    });
  }
  for (const bad of [
    "Fade-Amount",
    "fade_amount",
    "",
    "bypass",
    null,
    1,
    true,
    ["uv"],
  ]) {
    assert.throws(
      () => fragmentDebugPayload(bad),
      (error) =>
        error instanceof ProbeRefusal &&
        error.reason === "rig-dial-unsupported" &&
        /globeFragmentDebug=/.test(error.message),
      `${JSON.stringify(bad)} must be refused`,
    );
  }
});

// The dial's promise as one check a mutant can be held to.
async function assertFragmentDebugDial(stage) {
  const run = async (rendererType, registry, value, before = null) => {
    globalThis.viewer = fragmentDebugViewer(rendererType);
    globalThis._webgpuGlobeDebugMode = before;
    if (registry === undefined) {
      delete globalThis.__webgpuGlobeFragmentDebugRegistry;
    } else {
      globalThis.__webgpuGlobeFragmentDebugRegistry = registry;
    }
    const staged = await stage(fragmentDebugPayload(value));
    return { staged, dial: staged.dials.globeFragmentDebug };
  };
  // WebGPU with the mode in the registry: the global is set and read back.
  let { staged, dial } = await run(
    "webgpu",
    registryOf("uv", "fade-amount"),
    "fade-amount",
  );
  assert.equal(globalThis._webgpuGlobeDebugMode, "fade-amount");
  assert.deepEqual(dial, {
    requested: "fade-amount",
    observed: "fade-amount",
    applied: true,
  });
  assert.deepEqual(blockingDials(staged), []);
  // "none" clears a mode that was set.
  ({ dial } = await run("webgpu", registryOf("uv"), "none", "uv"));
  assert.equal(globalThis._webgpuGlobeDebugMode, null);
  assert.deepEqual(dial, {
    requested: "none",
    observed: "none",
    applied: true,
  });
  // A pragma-stripped build publishes no registry: the dial is blocking.
  ({ staged, dial } = await run("webgpu", undefined, "fade-amount"));
  assert.equal(dial.applied, false);
  assert.match(dial.reason, /registry is absent/);
  assert.deepEqual(blockingDials(staged), ["globeFragmentDebug"]);
  // A registry that lacks the mode asked for is blocking too.
  ({ staged, dial } = await run("webgpu", registryOf("uv"), "view-dir"));
  assert.equal(dial.applied, false);
  assert.match(dial.reason, /view-dir is not in the fragment-debug registry/);
  assert.deepEqual(blockingDials(staged), ["globeFragmentDebug"]);
  // A global that does not hold the mode (read-back differs) is not applied.
  globalThis.viewer = fragmentDebugViewer("webgpu");
  globalThis.__webgpuGlobeFragmentDebugRegistry = registryOf("fade-amount");
  Object.defineProperty(globalThis, "_webgpuGlobeDebugMode", {
    configurable: true,
    get: () => null,
    set: () => {},
  });
  staged = await stage(fragmentDebugPayload("fade-amount"));
  dial = staged.dials.globeFragmentDebug;
  delete globalThis._webgpuGlobeDebugMode;
  assert.equal(dial.applied, false);
  assert.equal(dial.observed, "none");
  // WebGL: recorded as applied and not applicable, never blocking.
  ({ staged, dial } = await run("webgl", undefined, "fade-amount"));
  assert.equal(dial.applied, true);
  assert.equal(dial.observed, "not-applicable");
  assert.match(dial.reason, /WebGL globe has no fragment-debug registry/);
  assert.deepEqual(staged.notApplied, []);
  assert.deepEqual(blockingDials(staged), []);
}

test("S11: the dial sets the debug-mode global on WebGPU against the registry, and never fails a WebGL stage", async () => {
  await assertFragmentDebugDial(stageLandingCellInPage);
});

test("S11: inertness mutants - the global write, the read-back comparison, the registry check and the WebGL branch made unreachable turn the check red; the Node refusal is live", async () => {
  for (const [anchor, replacement] of [
    [
      `root._webgpuGlobeDebugMode = mode;`,
      `if (false) root._webgpuGlobeDebugMode = mode;`,
    ],
    [`observed === value && listed,`, `listed,`],
    [
      `mode === null || (hasRegistry && registry.some((m) => m.name === mode));`,
      `true;`,
    ],
    [
      `if (rendererType !== "webgpu") {
        note(
          key,
          value,
          "not-applicable",
          true,`,
      `if (rendererType !== "webgpu") {
        note(
          key,
          value,
          "not-applicable",
          false,`,
    ],
  ]) {
    const mutated = await importMutated(STAGE_MODULE, [[anchor, replacement]]);
    await assert.rejects(
      assertFragmentDebugDial(mutated.stageLandingCellInPage),
      (error) => error instanceof assert.AssertionError,
      `mutant ${replacement.slice(0, 50)} must fail by assertion`,
    );
  }
  const refusal = await importMutated(STAGE_MODULE, [
    [
      `!isGlobeFragmentDebugValue(globe.globeFragmentDebug)`,
      `false && !isGlobeFragmentDebugValue(globe.globeFragmentDebug)`,
    ],
  ]);
  assert.doesNotThrow(() =>
    refusal.landingStagePayload({
      id: "m",
      camera: null,
      clock: null,
      dials: { globeFragmentDebug: "no-such-mode" },
    }),
  );
});
