// landing-cell-stage-ocean-dials.spec.mjs - a part of the landing-cell-stage spec. Pure Node: no browser, no GPU.
// @purpose Drives the waterOceanEnabled dial (S8, DX-KIT-WATER-OCEAN-DIAL) and the globeShow, SSR and deferred-lighting scene dials of landing-cell-stage, with inertness mutants.
// @status ACTIVE
//
// One part of the landing-cell-stage spec, split by concern (row DX-KIT-LANDING-SPECS-OVER-SIZE); the test names and
// bodies are unchanged. The fixtures it shares with its siblings live in fixtures/landing-cell-stage-support.mjs.
// S8 (the FFT-ocean dial and the globeShow and SSR scene dials) is the lane A salvage lead's addition (Andustar).

import assert from "node:assert/strict";
import test from "node:test";
import {
  LANDING_WATER_DIALS,
  landingStagePayload,
  stageLandingCellInPage,
} from "./lib/landing-cell-stage.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import { ProbeRefusal } from "./lib/probe-refusal.mjs";
import { loadRigs, rigById } from "./lib/rig-registry.mjs";
import { blockingDials } from "./probe-landing-cells.mjs";
import {
  FAKE_CESIUM_URL,
  STAGE_MODULE,
  createFakeViewer,
  oceanViewer,
} from "./fixtures/landing-cell-stage-support.mjs";

test.afterEach(() => {
  delete globalThis.viewer;
  delete globalThis.__cloudProbe;
  delete globalThis._webgpuGlobeDebugMode;
  delete globalThis.__webgpuGlobeFragmentDebugRegistry;
});

// -----------------------------------------------------------------------------
// S8: (DX-KIT-WATER-OCEAN-DIAL, lane A salvage) waterOceanEnabled - the
// product's FFT ocean switch, read back by the primitive the facade builds -
// plus the globeShow and SSR scene dials the FFT and SSR probes' rigs use.
// Lead addition (Andustar).
// -----------------------------------------------------------------------------

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
