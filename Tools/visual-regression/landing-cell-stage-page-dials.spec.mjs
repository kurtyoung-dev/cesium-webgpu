// landing-cell-stage-page-dials.spec.mjs - a part of the landing-cell-stage spec. Pure Node: no browser, no GPU.
// @purpose Drives stageLandingCellInPage on a fake viewer: the dial application and read-back (S4), the cloud-harness presence and error handling (S5), clamping accessors and the terrain provider read-back.
// @status ACTIVE
//
// One part of the landing-cell-stage spec, split by concern (row DX-KIT-LANDING-SPECS-OVER-SIZE); the test names and
// bodies are unchanged. The fixtures it shares with its siblings live in fixtures/landing-cell-stage-support.mjs.
// The S4 terrain cases marked ROUND 3 are the lead's addition for Ettenmoors pass 2 (N-2).

import assert from "node:assert/strict";
import test from "node:test";
import { stageLandingCellInPage } from "./lib/landing-cell-stage.mjs";
import {
  FAKE_CESIUM_URL,
  createFakeViewer,
} from "./fixtures/landing-cell-stage-support.mjs";

test.afterEach(() => {
  delete globalThis.viewer;
  delete globalThis.__cloudProbe;
  delete globalThis._webgpuGlobeDebugMode;
  delete globalThis.__webgpuGlobeFragmentDebugRegistry;
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
