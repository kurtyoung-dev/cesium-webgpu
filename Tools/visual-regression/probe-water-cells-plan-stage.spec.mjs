// probe-water-cells-plan-stage.spec.mjs - lane KT-2 (Nardol). Pure Node: no browser, no GPU.
//
// @purpose Asserts planWaterCells plans pages cell-major with WebGL first and ON before OFF, stageGaps separates blocking dials from absent water dials, and the wave epoch dial reaches the stage only where the stage has a handler (stageHandlesDial, waterStagePlan, waveEpochReadback).
// @status ACTIVE
//
// One subject of the water-cells spec, split out of probe-water-cells.spec.mjs (row DX-KIT-WATER-CELLS-SPEC-OVERSIZE);
// the shared stub browser, run frame and fixtures live in fixtures/probe-water-cells-support.mjs.

import assert from "node:assert/strict";
import test from "node:test";

import { landingStagePayload } from "./lib/landing-cell-stage.mjs";
import { ProbeRefusal } from "./lib/probe-runtime.mjs";
import {
  WATER_CELLS,
  WAVE_EPOCH_DIAL,
  planWaterCells,
  stageGaps,
  stageHandlesDial,
  waterStagePlan,
  waveEpochReadback,
} from "./probe-water-cells.mjs";
import {
  rigsById,
  rigOf,
  CLOCK,
} from "./fixtures/probe-water-cells-support.mjs";

// ---------------------------------------------------------------------------
// P: planWaterCells
// ---------------------------------------------------------------------------

test("P1: the table has the five cells", () => {
  assert.deepEqual(Object.keys(WATER_CELLS).sort(), [
    "1f",
    "coast-50km",
    "great-lakes",
    "great-lakes-lakeonly",
    "orbit-disc",
  ]);
});

test("P1: a mask cell plans its pages WebGL before WebGPU and ON before OFF", () => {
  const plan = planWaterCells({ cells: "great-lakes" }, rigsById);
  assert.deepEqual(
    plan.map((p) => [p.renderer, p.rigId]),
    [
      ["webgl", "water-great-lakes"],
      ["webgl", "water-great-lakes-off"],
      ["webgpu", "water-great-lakes"],
      ["webgpu", "water-great-lakes-off"],
    ],
  );
  assert.ok(plan.every((p) => p.cell === "great-lakes"));
});

test("P1: the lake-only cell pairs its rig with water-great-lakes-off", () => {
  const plan = planWaterCells({ cells: "great-lakes-lakeonly" }, rigsById);
  assert.deepEqual([...new Set(plan.map((p) => p.rigId))].sort(), [
    "water-great-lakes-lakeonly",
    "water-great-lakes-off",
  ]);
});

test("P1: cell 1f plans the demo rig on each renderer, one page each", () => {
  const plan = planWaterCells({ cells: "1f" }, rigsById);
  assert.deepEqual(
    plan.map((p) => [p.renderer, p.rigId]),
    [
      ["webgl", "sandcastle2-globe-materials-water-mask"],
      ["webgpu", "sandcastle2-globe-materials-water-mask"],
    ],
  );
});

test("P1: pages are cell-major in --cells order", () => {
  const plan = planWaterCells({ cells: "orbit-disc,coast-50km" }, rigsById);
  assert.deepEqual(
    plan.map((p) => p.cell),
    [
      "orbit-disc",
      "orbit-disc",
      "orbit-disc",
      "orbit-disc",
      "coast-50km",
      "coast-50km",
      "coast-50km",
      "coast-50km",
    ],
  );
});

test("P1: --renderer filters the pages", () => {
  const gl = planWaterCells(
    { cells: "coast-50km", renderers: ["webgl"] },
    rigsById,
  );
  assert.deepEqual([...new Set(gl.map((p) => p.renderer))], ["webgl"]);
  assert.equal(gl.length, 2);
  const gpu = planWaterCells(
    { cells: "coast-50km", renderers: ["webgpu"] },
    rigsById,
  );
  assert.deepEqual([...new Set(gpu.map((p) => p.renderer))], ["webgpu"]);
});

test("P1: the default plan covers every cell", () => {
  const plan = planWaterCells({}, rigsById);
  assert.deepEqual(
    [...new Set(plan.map((p) => p.cell))].sort(),
    Object.keys(WATER_CELLS).sort(),
  );
});

test("P1: an unknown cell refuses cell-unknown and an absent rig refuses cell-rig-absent", () => {
  assert.throws(
    () => planWaterCells({ cells: "no-such-cell" }, rigsById),
    (error) => error instanceof ProbeRefusal && error.reason === "cell-unknown",
  );
  assert.throws(
    () => planWaterCells({ cells: "coast-50km" }, new Map()),
    (error) =>
      error instanceof ProbeRefusal && error.reason === "cell-rig-absent",
  );
});

// ---------------------------------------------------------------------------
// G: stageGaps
// ---------------------------------------------------------------------------

test("G1: a non-water dial that did not apply blocks", () => {
  const gaps = stageGaps(rigOf("water-great-lakes"), {
    notApplied: ["terrain"],
  });
  assert.deepEqual(gaps.blocking, ["terrain"]);
  assert.deepEqual(gaps.waterAbsent, []);
});

test("G1: a water dial the rig set to true is reported absent and does not block", () => {
  const gaps = stageGaps(rigOf("water-great-lakes"), {
    notApplied: ["globalWaterMask", "lakeWaterMask"],
  });
  assert.deepEqual(gaps.blocking, []);
  assert.deepEqual([...gaps.waterAbsent].sort(), [
    "globalWaterMask",
    "lakeWaterMask",
  ]);
});

test("G1: a water dial the rig set to false that did not apply is neither", () => {
  const gaps = stageGaps(rigOf("water-great-lakes"), {
    notApplied: ["riverWaterMask", "enableEnhancedOcean"],
  });
  assert.deepEqual(gaps.blocking, []);
  assert.deepEqual(gaps.waterAbsent, []);
});

test("G1: nothing unapplied is no gap", () => {
  const gaps = stageGaps(rigOf("water-coast-50km"), { notApplied: [] });
  assert.deepEqual(gaps, { blocking: [], waterAbsent: [] });
});

test("G2 (A2-1): a wave epoch that did not apply neither blocks the page nor counts as an absent water dial", () => {
  const gaps = stageGaps(rigOf("water-coast-50km"), {
    notApplied: [WAVE_EPOCH_DIAL],
  });
  assert.deepEqual(gaps, { blocking: [], waterAbsent: [] });
  const mixed = stageGaps(rigOf("water-coast-50km"), {
    notApplied: [WAVE_EPOCH_DIAL, "terrain", "globalWaterMask"],
  });
  assert.deepEqual(mixed.blocking, ["terrain"]);
  assert.deepEqual(mixed.waterAbsent, ["globalWaterMask"]);
});

// ---------------------------------------------------------------------------
// W: the wave epoch dial on its way to the stage (A2-1)
// ---------------------------------------------------------------------------

const refusingPayload = () => {
  throw new ProbeRefusal("rig-dial-unsupported", "stub: unknown dial");
};
const acceptingPayload = () => ({});

test("W1: stageHandlesDial is false on a rig-dial-unsupported refusal, true on acceptance, and rethrows anything else", () => {
  assert.equal(
    stageHandlesDial(WAVE_EPOCH_DIAL, CLOCK, refusingPayload),
    false,
  );
  assert.equal(
    stageHandlesDial(WAVE_EPOCH_DIAL, CLOCK, acceptingPayload),
    true,
  );
  assert.throws(
    () =>
      stageHandlesDial(WAVE_EPOCH_DIAL, CLOCK, () => {
        throw new TypeError("stub: bad camera");
      }),
    TypeError,
  );
  // On the real stage the answer is whatever its payload builder says.
  let real = true;
  try {
    landingStagePayload({
      id: "w1",
      camera: null,
      dials: { [WAVE_EPOCH_DIAL]: CLOCK },
    });
  } catch (error) {
    assert.equal(error.reason, "rig-dial-unsupported");
    real = false;
  }
  assert.equal(stageHandlesDial(WAVE_EPOCH_DIAL, CLOCK), real);
});

test("W2: waterStagePlan drops the epoch only for a stage without its handler, and leaves the rig record untouched", () => {
  const rig = rigOf("water-coast-50km");
  const without = waterStagePlan(rig, { handles: () => false });
  assert.equal(Object.hasOwn(without.rig.dials, WAVE_EPOCH_DIAL), false);
  assert.deepEqual(without.epoch, { requested: CLOCK, stageHandles: false });
  assert.equal(rig.dials[WAVE_EPOCH_DIAL], CLOCK, "the rig is not mutated");
  const { [WAVE_EPOCH_DIAL]: _epoch, ...rest } = rig.dials;
  assert.deepEqual(without.rig.dials, rest, "every other dial is kept");
  assert.equal(without.rig.id, rig.id);
  const withHandler = waterStagePlan(rig, { handles: () => true });
  assert.equal(withHandler.rig, rig, "a stage with the handler gets the rig");
  assert.deepEqual(withHandler.epoch, { requested: CLOCK, stageHandles: true });
  const demo = rigOf("sandcastle2-globe-materials-water-mask");
  assert.deepEqual(waterStagePlan(demo, { handles: () => false }), {
    rig: demo,
    epoch: null,
  });
});

test("W3: waveEpochReadback reports the stage's own answer where it staged the dial, and applied false with the reason otherwise", () => {
  assert.equal(waveEpochReadback(null, {}), null);
  const unhandled = waveEpochReadback(
    { requested: CLOCK, stageHandles: false },
    { dials: {} },
  );
  assert.equal(unhandled.applied, false);
  assert.equal(unhandled.requested, CLOCK);
  assert.ok(unhandled.reason.includes("no waterSimulationEpoch handler"));
  const silent = waveEpochReadback(
    { requested: CLOCK, stageHandles: true },
    { dials: {} },
  );
  assert.equal(silent.applied, false);
  assert.ok(silent.reason.includes("no waterSimulationEpoch readback"));
  const applied = waveEpochReadback(
    { requested: CLOCK, stageHandles: true },
    {
      dials: {
        [WAVE_EPOCH_DIAL]: { requested: CLOCK, observed: CLOCK, applied: true },
      },
    },
  );
  assert.deepEqual(applied, {
    requested: CLOCK,
    observed: CLOCK,
    applied: true,
  });
  const absent = waveEpochReadback(
    { requested: CLOCK, stageHandles: true },
    {
      dials: {
        [WAVE_EPOCH_DIAL]: {
          requested: CLOCK,
          observed: null,
          applied: false,
          reason: "globe.water.ocean is absent",
        },
      },
    },
  );
  assert.equal(absent.applied, false);
  assert.equal(absent.reason, "globe.water.ocean is absent");
});
