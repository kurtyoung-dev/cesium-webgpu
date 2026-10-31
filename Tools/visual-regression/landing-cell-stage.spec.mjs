// landing-cell-stage.spec.mjs - lane KT round 2 (Nurn). Pure Node: no browser, no GPU.
//
// @purpose Exercises landing-cell-stage.mjs in Node against real rigs and synthetic payloads, asserting payload construction, dial vocabulary and partition, the globeMaterial dial and the cloudsEnabled derivation; the dial-application, ocean, kernel and mode groups live in the sibling parts.
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
//
// SPLIT BY CONCERN (row DX-KIT-LANDING-SPECS-OVER-SIZE): this file keeps S1, S2, S2b, the globeMaterial cases of S8 and S3;
// the other groups live in landing-cell-stage-page-dials, landing-cell-stage-epoch-pipelines, landing-cell-stage-ocean-dials, landing-cell-stage-kernel-mode, landing-cell-stage-identity-debug
// (.spec.mjs), which share fixtures/landing-cell-stage-support.mjs. Test names and bodies are unchanged.

import assert from "node:assert/strict";
import test from "node:test";
import {
  landingStagePayload,
  stageLandingCellInPage,
} from "./lib/landing-cell-stage.mjs";
import { ProbeRefusal } from "./lib/probe-refusal.mjs";
import { loadRigs, rigById } from "./lib/rig-registry.mjs";
import { LANDING_CELLS } from "./probe-landing-cells.mjs";
import {
  FAKE_CESIUM_MODULE_SOURCE,
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
