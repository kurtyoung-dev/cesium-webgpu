// landing-cell-stage-kernel-mode.spec.mjs - a part of the landing-cell-stage spec. Pure Node: no browser, no GPU.
// @purpose Drives the waterOceanIfftKernel and sceneMode dials (S9) of landing-cell-stage on fake ocean and scene-mode facades, with inertness mutants for each clause and refusal.
// @status ACTIVE
//
// One part of the landing-cell-stage spec, split by concern (row DX-KIT-LANDING-SPECS-OVER-SIZE); the test names and
// bodies are unchanged. The fixtures it shares with its siblings live in fixtures/landing-cell-stage-support.mjs.
// S9 is lane LINDISSE's addition (Zimrahin).

import assert from "node:assert/strict";
import test from "node:test";
import {
  LANDING_IFFT_KERNEL_VALUES,
  LANDING_SCENE_DIALS,
  LANDING_SCENE_MODE_VALUES,
  LANDING_WATER_DIALS,
  landingStagePayload,
  stageLandingCellInPage,
} from "./lib/landing-cell-stage.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import { ProbeRefusal } from "./lib/probe-refusal.mjs";
import { blockingDials } from "./probe-landing-cells.mjs";
import {
  FAKE_CESIUM_URL,
  FAKE_SCENE_MODE_URL,
  STAGE_MODULE,
  createFakeViewer,
  kernelPayload,
  kernelViewer,
  sceneModeViewer,
} from "./fixtures/landing-cell-stage-support.mjs";

test.afterEach(() => {
  delete globalThis.viewer;
  delete globalThis.__cloudProbe;
  delete globalThis._webgpuGlobeDebugMode;
  delete globalThis.__webgpuGlobeFragmentDebugRegistry;
});

// -----------------------------------------------------------------------------
// S9: the two dials the ocean-kernel Edge cells need (lane LINDISSE):
// waterOceanIfftKernel (the FFT ocean's inverse-FFT kernel, read back on the
// facade and on the primitive) and sceneMode (3D, 2D, Columbus view).
// -----------------------------------------------------------------------------

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
