// landing-cell-stage.spec.mjs - lane KT round 2 (Nurn). Pure Node: no browser, no GPU.
//
// @purpose Exercises landing-cell-stage.mjs in Node against real rigs and synthetic payloads, asserting payload construction, dial vocabulary and partition, camera validation, harness checks, and page-side dial read-back.
// @status ACTIVE
//
// Written from BEHAVIOUR_CELOS.md covering behaviours S1, S2, S3, S4, and S5.
// The S4 terrain cases marked ROUND 3 are the lead's addition for Ettenmoors pass 2 (N-2).
// S6 (the wave-epoch dial, K5-1) and S7 (the pending-pipeline wait, K5-2) are
// the lead's ROUND 5 additions (Celos), written from the seat's item text.
// Base: a999954e2b. Drives real exported functions with Node-compatible fakes.

import assert from "node:assert/strict";
import test from "node:test";

import {
  LANDING_WATER_DIALS,
  PIPELINE_WAIT_DEFAULTS,
  landingStagePayload,
  readPendingPipelines,
  stageLandingCell,
  stageLandingCellInPage,
} from "./lib/landing-cell-stage.mjs";
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
