// globe-dive-gate-steps.spec.mjs — the dive-gate step records what the controller did and turns it into a receipt.
// @purpose Pins lib/globe-dive-gate-steps.mjs: against a fake viewer the step places the camera and the flag, wheels in through the page's mouse, reads the gate, the dive depth and the clamp per notch from `_water` (never the creating accessor), and the receipt says allow / refuse / mixed with the clamp and depth facts, or a named reason when the record cannot be read.
// @status ACTIVE
//
// NO BROWSER. The page is a fake whose `evaluate` runs the step's page
// functions against a fake viewer, and whose `mouse.wheel` stands in for the
// controller: it applies the gate and the terrain clamp the way
// `ScreenSpaceCameraController` does (`canDiveAtSurfaceHeight` is `flag &&
// |globeHeight| <= 110`; the clamp floor is `globeHeight +
// minimumZoomDistance`). The fake is the SOURCE of readings, so what these
// cases certify is that the step relays the gate, the depth and the clamp
// faithfully and that the receipt decides from them; that the real controller
// behaves like the fake is the Edge job's to show (cells declared in the
// module's report), and `globe-water-facade.spec.mjs` pins the real rule.

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { importMutated } from "./lib/import-mutated.mjs";
import * as steps from "./lib/globe-dive-gate-steps.mjs";

const STEPS_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "lib",
  "globe-dive-gate-steps.mjs",
);

/**
 * A viewer, a page and the counters the cases read.
 *
 * @param {object} setup Setup.
 * @param {number|undefined} setup.globeHeight Terrain height under the camera.
 * @param {number} [setup.startHeight] Height the placement requests.
 * @param {boolean} [setup.hasFacade] Whether the globe has a water facade.
 * @param {boolean} [setup.sinks] A controller bug: the clamp never holds.
 * @returns {object} The world.
 */
function makeWorld({
  globeHeight,
  startHeight = 200,
  hasFacade = true,
  sinks = false,
}) {
  const counts = { accessorHits: 0, wheels: [], moves: [], settles: [] };
  const water = {
    disableWaterCollision: false,
    diveDepthMeters: 0,
    canDiveAtSurfaceHeight(height) {
      return (
        this.disableWaterCollision === true &&
        Number.isFinite(height) &&
        Math.abs(height) <= 110
      );
    },
  };
  const camera = {
    height: 0,
    get positionCartographic() {
      return { height: this.height };
    },
    setView({ destination }) {
      this.height = destination.height;
      counts.placedAt = destination;
    },
  };
  const scene = {
    camera,
    get globeHeight() {
      return globeHeight;
    },
    screenSpaceCameraController: { minimumZoomDistance: 1 },
    canvas: {
      getBoundingClientRect: () => ({
        left: 10,
        top: 20,
        width: 800,
        height: 400,
      }),
    },
    render() {},
    globe: {
      get water() {
        counts.accessorHits++;
        return water;
      },
      get _water() {
        return hasFacade ? water : undefined;
      },
    },
  };
  const page = {
    evaluate: async (fn, arg) => {
      const saved = { viewer: globalThis.viewer, Cesium: globalThis.Cesium };
      globalThis.viewer = { scene };
      globalThis.Cesium = {
        Cartesian3: {
          fromDegrees: (lon, lat, height) => ({ lon, lat, height }),
        },
      };
      try {
        return fn(arg);
      } finally {
        globalThis.viewer = saved.viewer;
        globalThis.Cesium = saved.Cesium;
      }
    },
    mouse: {
      move: async (x, y) => counts.moves.push([x, y]),
      wheel: async (_dx, deltaY) => {
        counts.wheels.push(deltaY);
        if (deltaY >= 0) {
          return;
        }
        const surface = globeHeight ?? 0;
        if (sinks) {
          camera.height -= 60;
          return;
        }
        if (water.canDiveAtSurfaceHeight(globeHeight)) {
          // The virtual dive: the camera stops 14 m above the surface and
          // the depth counts instead.
          const floor = surface + 14;
          if (camera.height - 60 > floor) {
            camera.height -= 60;
          } else {
            camera.height = floor;
            water.diveDepthMeters += 10;
          }
          return;
        }
        camera.height = Math.max(camera.height - 60, surface + 1);
      },
    },
  };
  const settle = async (frames) => counts.settles.push(frames);
  return { page, settle, water, camera, counts };
}

const step = (overrides = {}) => ({
  lon: 6.9,
  lat: 62.1,
  height: 200,
  disableWaterCollision: true,
  wheelNotches: 5,
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
    initial: read(true),
    steps: [
      { notch: 0, ...read(true) },
      { notch: 1, ...read(false, { globeHeight: 400 }) },
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
    initial: state,
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
