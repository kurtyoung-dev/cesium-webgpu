// globe-dive-gate-steps.spec.mjs — the dive-gate step records what the controller did and turns it into a receipt.
// @purpose Pins lib/globe-dive-gate-steps.mjs: against a fake viewer the step places the camera and the flag, wheels in through the page's mouse, reads the gate, the dive depth and the clamp per notch from `_water` (never the creating accessor), and the receipt says allow / refuse / mixed with the clamp and depth facts, or a named reason when the record cannot be read.
// @status ACTIVE
//
// NO BROWSER. The page is the shared fake world's (`fixtures/dive-gate-fake-world.mjs`):
// its `evaluate` runs the step's REAL page functions, and the settle runs the real
// frame driver (`lib/landing-page-frames.mjs`), against a fake viewer that behaves
// as the engine does: `globeHeight` is undefined until `initializeFrame()` runs,
// the wheel moves the camera only when `initializeFrame()` runs the controller
// update (clamped at `globeHeight + minimumZoomDistance`, or stopping 14 m above
// the surface with depth counting where `canDiveAtSurfaceHeight` allows it: flag
// set and |globeHeight| <= 110), and `render()` changes neither. The world answers
// no quantity under test, so these cases certify that the step drives frames that
// reach the controller, relays the gate, the depth and the clamp faithfully, and
// that the receipt decides from them; that the real controller behaves like the
// world is the Edge job's to show, and `globe-water-facade.spec.mjs` pins the real
// rule.

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  STUB_CESIUM_LOG,
  STUB_CESIUM_MODULE_URL,
  makeDiveGateFakeWorld,
} from "./fixtures/dive-gate-fake-world.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import * as steps from "./lib/globe-dive-gate-steps.mjs";

const STEPS_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "lib",
  "globe-dive-gate-steps.mjs",
);

const FAKE_CESIUM_URL = STUB_CESIUM_MODULE_URL;

/**
 * A shared fake world with this spec's fixed 60 m wheel notch.
 *
 * @param {object} setup Setup.
 * @param {number|undefined} setup.globeHeight Terrain height under the camera.
 * @param {number} [setup.startHeight] The camera height before any placement.
 * @param {boolean} [setup.hasFacade] Whether the globe has a water facade.
 * @param {boolean} [setup.sinks] A controller bug: the clamp never holds.
 * @param {boolean} [setup.enableInputs] `false`: the controller ignores input.
 * @returns {object} The world (`counts` is its `seen`).
 */
function makeWorld({
  globeHeight,
  startHeight = 200,
  hasFacade = true,
  sinks = false,
  enableInputs = true,
}) {
  const world = makeDiveGateFakeWorld({
    surface: globeHeight,
    startHeight,
    facade: hasFacade,
    sinks,
    enableInputs,
    wheelStepMeters: 60,
  });
  return { ...world, counts: world.seen };
}

const step = (overrides = {}) => ({
  lon: 6.9,
  lat: 62.1,
  height: 200,
  disableWaterCollision: true,
  wheelNotches: 5,
  moduleUrl: FAKE_CESIUM_URL,
  ...overrides,
});

test("allow: a sea-level surface with the collision off counts depth, and the camera stops above the surface", async () => {
  const world = makeWorld({ globeHeight: 0 });
  const { record, outcome } = await steps.runDiveGateSteps({
    page: world.page,
    step: step(),
    settle: world.settle,
  });
  assert.equal(outcome.readable, true);
  assert.equal(outcome.receipt.gate, "allow");
  assert.equal(outcome.receipt.collisionDisabled, true);
  assert.equal(outcome.receipt.globeHeight, 0);
  assert.equal(outcome.receipt.notches, 5);
  assert.equal(outcome.receipt.diveDepthGrew, true);
  assert.ok(outcome.receipt.diveDepthMax >= 10);
  assert.equal(outcome.receipt.clampHeld, true);
  assert.deepEqual(outcome.receipt.clampBreaches, []);
  assert.equal(outcome.receipt.minCameraHeight, 14);
  assert.equal(outcome.receipt.depthWhileRefused, false);
  assert.equal(record.steps.length, 5);
  assert.ok(record.steps.every((entry) => entry.gateAllows === true));
});

test("refuse over land: the stock clamp holds the camera at the floor and no depth is counted", async () => {
  const world = makeWorld({ globeHeight: 3000, startHeight: 3200 });
  const { outcome } = await steps.runDiveGateSteps({
    page: world.page,
    step: step({ height: 3200 }),
    settle: world.settle,
  });
  assert.equal(outcome.readable, true);
  assert.equal(outcome.receipt.gate, "refuse");
  assert.equal(outcome.receipt.collisionDisabled, true);
  assert.equal(outcome.receipt.globeHeight, 3000);
  assert.equal(outcome.receipt.diveDepthGrew, false);
  assert.equal(outcome.receipt.clampHeld, true);
  assert.equal(outcome.receipt.minCameraHeight, 3001);
  assert.equal(outcome.receipt.depthWhileRefused, false);
});

test("refuse with the collision on: sea level alone does not open the gate", async () => {
  const world = makeWorld({ globeHeight: 0 });
  const { outcome } = await steps.runDiveGateSteps({
    page: world.page,
    step: step({ disableWaterCollision: false }),
    settle: world.settle,
  });
  assert.equal(outcome.readable, true);
  assert.equal(outcome.receipt.gate, "refuse");
  assert.equal(outcome.receipt.collisionDisabled, false);
  assert.equal(outcome.receipt.diveDepthMax, 0);
  assert.equal(outcome.receipt.minCameraHeight, 1);
  assert.equal(outcome.receipt.clampHeld, true);
});

test("a clamp that does not hold is reported with the notches it failed at", async () => {
  const world = makeWorld({
    globeHeight: 3000,
    startHeight: 3200,
    sinks: true,
  });
  const { outcome } = await steps.runDiveGateSteps({
    page: world.page,
    step: step({ height: 3200, wheelNotches: 6 }),
    settle: world.settle,
  });
  assert.equal(outcome.readable, true);
  assert.equal(outcome.receipt.gate, "refuse");
  assert.equal(outcome.receipt.clampHeld, false);
  // 3200 - 60n is above 3001 for n <= 3; notches 3.. (0-based) are below it.
  assert.deepEqual(outcome.receipt.clampBreaches, [3, 4, 5]);
  assert.equal(outcome.receipt.minCameraHeight, 3200 - 6 * 60);
});

test("depth counted while the gate refused is reported, not folded into the gate", () => {
  const read = (extra) => ({
    waterFacade: true,
    disableWaterCollision: true,
    cameraHeight: 50,
    globeHeight: 3000,
    minimumZoomDistance: 1,
    gateAllows: false,
    diveDepthMeters: 0,
    ...extra,
  });
  const outcome = steps.buildDiveGateReceipt({
    placement: { disableWaterCollision: true },
    placed: { ok: true },
    initial: read({ cameraHeight: 3100 }),
    steps: [
      { notch: 0, ...read({ cameraHeight: 3100 }) },
      { notch: 1, ...read({ cameraHeight: 3050, diveDepthMeters: 12 }) },
    ],
  });
  assert.equal(outcome.receipt.gate, "refuse");
  assert.equal(outcome.receipt.depthWhileRefused, true);
});

test("a gate that changes mid-zoom is 'mixed'", () => {
  const read = (gateAllows, extra = {}) => ({
    waterFacade: true,
    disableWaterCollision: true,
    cameraHeight: 100,
    globeHeight: 0,
    minimumZoomDistance: 1,
    gateAllows,
    diveDepthMeters: 0,
    ...extra,
  });
  const outcome = steps.buildDiveGateReceipt({
    placement: { disableWaterCollision: true },
    placed: { ok: true },
    initial: read(true, { cameraHeight: 100 }),
    steps: [
      { notch: 0, ...read(true, { cameraHeight: 80 }) },
      { notch: 1, ...read(false, { globeHeight: 400, cameraHeight: 60 }) },
    ],
  });
  assert.equal(outcome.receipt.gate, "mixed");
  assert.deepEqual(outcome.receipt.globeHeightRange, [0, 400]);
});

test("the wheel is aimed at the canvas centre and the page settles around it", async () => {
  const world = makeWorld({ globeHeight: 0 });
  await steps.runDiveGateSteps({
    page: world.page,
    step: step({
      wheelNotches: 3,
      settleFramesBeforeFirst: 7,
      settleFramesPerNotch: 4,
    }),
    settle: world.settle,
  });
  assert.deepEqual(world.counts.moves, [[410, 220]]);
  assert.deepEqual(world.counts.wheels, [
    steps.DEFAULT_WHEEL_DELTA_Y,
    steps.DEFAULT_WHEEL_DELTA_Y,
    steps.DEFAULT_WHEEL_DELTA_Y,
  ]);
  assert.deepEqual(world.counts.settles, [7, 4, 4, 4]);
  assert.deepEqual(world.counts.placedAt, { lon: 6.9, lat: 62.1, height: 200 });
});

test("the camera is placed through the Cesium module at the URL given, and the record names that URL", async () => {
  globalThis[STUB_CESIUM_LOG] = [];
  const world = makeWorld({ globeHeight: 0 });
  const { record, outcome } = await steps.runDiveGateSteps({
    page: world.page,
    step: step({ lon: -77.9, lat: 43.7, height: 150, wheelNotches: 2 }),
    settle: world.settle,
  });
  assert.deepEqual(globalThis[STUB_CESIUM_LOG], [
    { lon: -77.9, lat: 43.7, height: 150 },
  ]);
  assert.deepEqual(world.counts.placedAt, {
    lon: -77.9,
    lat: 43.7,
    height: 150,
  });
  assert.equal(record.placement.moduleUrl, FAKE_CESIUM_URL);
  assert.equal(record.placed.moduleUrl, FAKE_CESIUM_URL);
  assert.equal(outcome.readable, true);
});

test("a module that cannot be imported, or that has no Cartesian3, is a placement reason naming the URL", async () => {
  const missing = "data:text/javascript,throw new Error('no build here')";
  const world = makeWorld({ globeHeight: 0 });
  const failed = await steps.runDiveGateSteps({
    page: world.page,
    step: step({ moduleUrl: missing }),
    settle: world.settle,
  });
  assert.equal(failed.outcome.readable, false);
  assert.equal(failed.outcome.reason, "placement-failed");
  assert.match(failed.outcome.detail, /could not be imported/u);
  assert.ok(failed.outcome.detail.includes(missing));
  assert.deepEqual(
    world.counts.wheels,
    [],
    "no wheel after a failed placement",
  );

  const empty = "data:text/javascript,export const Other = {}";
  const bare = await steps.runDiveGateSteps({
    page: world.page,
    step: step({ moduleUrl: empty }),
    settle: world.settle,
  });
  assert.equal(bare.outcome.reason, "placement-failed");
  assert.match(bare.outcome.detail, /has no Cartesian3.fromDegrees/u);
});

test("only the placement touches the creating accessor; reading uses _water", async () => {
  const world = makeWorld({ globeHeight: 0 });
  await steps.runDiveGateSteps({
    page: world.page,
    step: step({ wheelNotches: 4 }),
    settle: world.settle,
  });
  assert.equal(world.counts.accessorHits, 1, "placement only");
  const before = world.counts.accessorHits;
  await world.page.evaluate(steps.pageReadDiveState);
  assert.equal(world.counts.accessorHits, before, "a read creates nothing");
});

test("unreadable: no water facade is a reason, not a receipt", async () => {
  const world = makeWorld({ globeHeight: 0, hasFacade: false });
  const { outcome } = await steps.runDiveGateSteps({
    page: world.page,
    step: step(),
    settle: world.settle,
  });
  assert.equal(outcome.readable, false);
  assert.equal(outcome.reason, "no-water-facade");
  assert.equal(outcome.receipt, undefined);
});

test("unreadable: a terrain height that never arrived is a reason", async () => {
  const world = makeWorld({ globeHeight: undefined });
  const { outcome } = await steps.runDiveGateSteps({
    page: world.page,
    step: step(),
    settle: world.settle,
  });
  assert.equal(outcome.readable, false);
  assert.equal(outcome.reason, "globe-height-undefined");
});

test("unreadable: a failed placement, no notches and a missing gate are named", async () => {
  const noCesium = {
    evaluate: async () => ({
      ok: false,
      reason: "the page has no Cesium namespace",
    }),
    mouse: { move: async () => {}, wheel: async () => {} },
  };
  const placed = await steps.runDiveGateSteps({
    page: noCesium,
    step: step(),
    settle: async () => {},
  });
  assert.equal(placed.outcome.reason, "placement-failed");
  assert.match(placed.outcome.detail, /no Cesium namespace/u);

  const world = makeWorld({ globeHeight: 0 });
  const none = await steps.runDiveGateSteps({
    page: world.page,
    step: step({ wheelNotches: 0 }),
    settle: world.settle,
  });
  assert.equal(none.outcome.reason, "no-steps");

  const state = {
    waterFacade: true,
    cameraHeight: 100,
    globeHeight: 0,
    minimumZoomDistance: 1,
    gateAllows: null,
    diveDepthMeters: 0,
  };
  const noGate = steps.buildDiveGateReceipt({
    placement: {},
    placed: { ok: true },
    initial: { ...state, cameraHeight: 120 },
    steps: [{ notch: 0, ...state }],
  });
  assert.equal(noGate.reason, "gate-readout-missing");
});

// ---------------------------------------------------------------------------
// INERTNESS: each decision made unreachable turns the cases above red.
// ---------------------------------------------------------------------------

async function allowCase(module) {
  const world = makeWorld({ globeHeight: 0 });
  return (
    await module.runDiveGateSteps({
      page: world.page,
      step: step(),
      settle: world.settle,
    })
  ).outcome.receipt;
}

async function breachCase(module) {
  const world = makeWorld({ globeHeight: 3000, sinks: true });
  return (
    await module.runDiveGateSteps({
      page: world.page,
      step: step({ height: 3200, wheelNotches: 6 }),
      settle: world.settle,
    })
  ).outcome.receipt;
}

test("INERTNESS: with the allow decision unreachable, the allow case no longer reads allow", async () => {
  assert.equal((await allowCase(steps)).gate, "allow");
  const mutated = await importMutated(STEPS_PATH, [
    [
      'allowed === steps.length ? "allow"',
      'false && allowed === steps.length ? "allow"',
    ],
  ]);
  assert.notEqual((await allowCase(mutated)).gate, "allow");
});

test("INERTNESS: with the refuse decision unreachable, a refused dive no longer reads refuse", async () => {
  const mutated = await importMutated(STEPS_PATH, [
    ['allowed === 0 ? "refuse"', 'false && allowed === 0 ? "refuse"'],
  ]);
  const world = makeWorld({ globeHeight: 3000 });
  const { outcome } = await mutated.runDiveGateSteps({
    page: world.page,
    step: step({ height: 3200 }),
    settle: world.settle,
  });
  assert.notEqual(outcome.receipt.gate, "refuse");
});

test("INERTNESS: with the clamp detection unreachable, a sinking camera still reads clampHeld", async () => {
  assert.equal((await breachCase(steps)).clampHeld, false);
  const mutated = await importMutated(STEPS_PATH, [
    [
      "step.cameraHeight <\n      step.globeHeight + step.minimumZoomDistance - CLAMP_TOLERANCE_METERS,",
      "false &&\n      step.cameraHeight <\n      step.globeHeight + step.minimumZoomDistance - CLAMP_TOLERANCE_METERS,",
    ],
  ]);
  assert.equal((await breachCase(mutated)).clampHeld, true);
});

test("INERTNESS: with the unreadable-facade guard unreachable, a missing facade yields a receipt", async () => {
  const mutated = await importMutated(STEPS_PATH, [
    [
      "states.some((state) => state.waterFacade !== true)",
      "false && states.some((state) => state.waterFacade !== true)",
    ],
  ]);
  const world = makeWorld({ globeHeight: 0, hasFacade: false });
  const { outcome } = await mutated.runDiveGateSteps({
    page: world.page,
    step: step(),
    settle: world.settle,
  });
  assert.notEqual(outcome.reason, "no-water-facade");
});

// ---------------------------------------------------------------------------
// The wheel has to reach the controller: frames are widget frames
// ---------------------------------------------------------------------------

test("the receipt carries the camera height series, the initial read then each notch, descending to the floor", async () => {
  const world = makeWorld({ globeHeight: 0 });
  const { outcome } = await steps.runDiveGateSteps({
    page: world.page,
    step: step(),
    settle: world.settle,
  });
  // 200 m placed, 60 m a notch, the dive stops 14 m above the surface.
  assert.deepEqual(outcome.receipt.cameraHeights, [200, 140, 80, 20, 14, 14]);
  const verdict = steps.diveGateVerdict("c", {
    diveGate: { expected: "allow", step: {}, outcome },
  });
  assert.equal(verdict.pass, true);
  assert.deepEqual(verdict.cameraHeights, outcome.receipt.cameraHeights);
});

test("the placement leaves a widget frame behind: the globe height is read straight after setView, at the frozen clock", async () => {
  const world = makeWorld({ globeHeight: 43 });
  assert.equal(world.scene.globeHeight, undefined, "the world starts stale");
  const placed = await world.page.evaluate(steps.pagePlaceDiveCamera, {
    ...step({ lon: 7.2, lat: 62.1, height: 150 }),
  });
  assert.equal(placed.ok, true);
  const state = await world.page.evaluate(steps.pageReadDiveState);
  assert.equal(state.globeHeight, 43);
  assert.equal(world.counts.initializeFrames, 1);
  assert.deepEqual(world.counts.renders, [world.viewer.clock.currentTime]);
  assert.equal(world.counts.clockTicks, 0);
});

test("INERTNESS: with the placement's widget frame unreachable, the globe height is still stale after setView", async () => {
  const mutated = await importMutated(STEPS_PATH, [
    ["scene.initializeFrame();", "false && scene.initializeFrame();"],
  ]);
  const world = makeWorld({ globeHeight: 43 });
  await world.page.evaluate(mutated.pagePlaceDiveCamera, {
    ...step({ height: 150 }),
  });
  const state = await world.page.evaluate(mutated.pageReadDiveState);
  assert.equal(state.globeHeight, null);
  assert.equal(world.counts.initializeFrames, 0);
});

test("unreadable: a camera that never moved over the wheel is wheel-unread, never a pass, and the reason names where it stayed", async () => {
  const world = makeWorld({ globeHeight: 0, enableInputs: false });
  const { record, outcome } = await steps.runDiveGateSteps({
    page: world.page,
    step: step(),
    settle: world.settle,
  });
  assert.equal(world.counts.wheels.length, 5, "the wheel was delivered");
  assert.equal(outcome.readable, false);
  assert.equal(outcome.reason, "wheel-unread");
  assert.equal(outcome.detail, "the camera stayed at 200 m over 5 notches");
  assert.deepEqual(outcome.cameraHeights, [200, 200, 200, 200, 200, 200]);
  assert.equal(record.steps.length, 5);
  const verdict = steps.diveGateVerdict("c", {
    diveGate: { expected: "allow", step: {}, outcome },
  });
  assert.equal(verdict.notRun, true);
  assert.equal(verdict.pass, false);
  assert.match(verdict.reason, /^wheel-unread: the camera stayed at 200 m/u);
  assert.deepEqual(verdict.cameraHeights, outcome.cameraHeights);
});

test("a camera that moved even once over the wheel is read; the unread terrain height still comes first", async () => {
  const read = (cameraHeight) => ({
    waterFacade: true,
    disableWaterCollision: true,
    cameraHeight,
    globeHeight: 0,
    minimumZoomDistance: 1,
    gateAllows: true,
    diveDepthMeters: 0,
  });
  const moved = steps.buildDiveGateReceipt({
    placement: { disableWaterCollision: true },
    placed: { ok: true },
    initial: read(150),
    steps: [
      { notch: 0, ...read(150) },
      { notch: 1, ...read(149.5) },
    ],
  });
  assert.equal(moved.readable, true);
  assert.deepEqual(moved.receipt.cameraHeights, [150, 150, 149.5]);

  // Neither the terrain height nor the camera moved: the older reason wins.
  const world = makeWorld({ globeHeight: undefined, enableInputs: false });
  const { outcome } = await steps.runDiveGateSteps({
    page: world.page,
    step: step(),
    settle: world.settle,
  });
  assert.equal(outcome.reason, "globe-height-undefined");
  assert.match(outcome.detail, /camera heights \[200,200,200,200,200,200\] m/u);
});

test("INERTNESS: with the wheel-unread check unreachable, a camera that never moved reads as a receipt", async () => {
  const mutated = await importMutated(STEPS_PATH, [
    [
      "if (cameraHeights.every((height) => height === cameraHeights[0])) {",
      "if (false && cameraHeights.every((height) => height === cameraHeights[0])) {",
    ],
  ]);
  const world = makeWorld({ globeHeight: 0, enableInputs: false });
  const { outcome } = await mutated.runDiveGateSteps({
    page: world.page,
    step: step(),
    settle: world.settle,
  });
  assert.equal(outcome.readable, true, "the live check would have refused it");
});
