// landing-cell-stage-identity-debug.spec.mjs - a part of the landing-cell-stage spec. Pure Node: no browser, no GPU.
// @purpose Drives the 2D and Columbus identity rigs' mode-then-camera staging (S10) and the globeFragmentDebug dial (S11) of landing-cell-stage, with inertness mutants.
// @status ACTIVE
//
// One part of the landing-cell-stage spec, split by concern (row DX-KIT-LANDING-SPECS-OVER-SIZE); the test names and
// bodies are unchanged. The fixtures it shares with its siblings live in fixtures/landing-cell-stage-support.mjs.
// S10 is lane TAR-ALDARION's A2 addition; S11 is the 2D / Columbus banding lane's addition (Ibal).

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
  landingStagePayload,
  stageLandingCellInPage,
} from "./lib/landing-cell-stage.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import { ProbeRefusal } from "./lib/probe-refusal.mjs";
import { loadRigs, rigById } from "./lib/rig-registry.mjs";
import { blockingDials } from "./probe-landing-cells.mjs";
import {
  FAKE_SCENE_MODE_URL,
  STAGE_MODULE,
  createFakeViewer,
  kernelPayload,
  sceneModeViewer,
} from "./fixtures/landing-cell-stage-support.mjs";

test.afterEach(() => {
  delete globalThis.viewer;
  delete globalThis.__cloudProbe;
  delete globalThis._webgpuGlobeDebugMode;
  delete globalThis.__webgpuGlobeFragmentDebugRegistry;
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
