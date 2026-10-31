// probe-water-cells.spec.mjs - lane KT-2 (Nardol). Pure Node: no browser, no GPU.
//
// @purpose Drives the real rigs and probe-water-cells.mjs and asserts the water cells' contract: the eight new rigs say what the round-3 EDGE_LEG_WATER.md rows say and their OFF twins differ in the water flags alone, the cell table plans pages cell-major with WebGL first and ON before OFF, stageGaps separates blocking dials from absent water dials, summarizeWaterRecords measures effect, parity and repeat percentages from synthetic images at the right tolerances, waterVerdicts applies the sheet's bands (2a, 2b, 2c with the orbit-disc floor at 2 % by seat ruling S6, 2e, 2f, 2g, 1f) on the AFTER arm only, every leg-2 rig pins the wave epoch to the sheet's instant and the probe stages it only where the stage has a handler (2g NOT RUN with the reason otherwise, and with an ON page's own NOT RUN reason or "page refused before staging" ahead of the run count), 1f parity with canvases of different sizes per renderer is NOT RUN naming both sizes, a page whose gate was never read is 2e NOT RUN "gate not read" with its refusal carried, the descriptor refuses an undeclared arm and a bad base report, and a page on a stub browser is NOT RUN under --arm after when a water dial it needs did not apply but captures under --arm before; and, end to end through descriptor.cells on the stub browser and a stub Sandcastle 2 run frame, that an unsettled leg-2 page, chrome left over the canvas and a demo-capture refusal are each a cell-level NOT RUN that leaves the arm's other pages in the receipt (an origin breach still ends the arm), that a device fault or a page error reaches 2e on leg-2 and 1f pages, that a fault-free WebGPU page whose error gate armed no device is 2e NOT RUN, and that the served-build assertion names 1f's Sandcastle 2 files only when 1f is a requested cell.
// @status ACTIVE
//
// Written from _lane-out/BEHAVIOUR_ALDBURG.md and the round-3 EDGE_LEG_WATER.md
// (leg 2 table), not from the probe's source or the lead's rigs. Rig values
// are transcribed from the sheet's table here, so a rig that drifts from the
// sheet fails; image-based cases use 100x100 synthetic captures, where each
// changed pixel is 0.01 percent, with per-channel deltas chosen on either side
// of the tolerance (8 for the mask effect, 16 for parity and the demo repeat).
// The E section is written from the reviewer's pass-1 residuals (B1 to B3).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { encodeRgbaPng } from "../lib/png-rgba.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import {
  stageLandingCellInPage,
  landingStagePayload,
} from "./lib/landing-cell-stage.mjs";
import { ProbeRefusal } from "./lib/probe-runtime.mjs";
import { loadRigs, replayKeyFor, validateRig } from "./lib/rig-registry.mjs";
import { OriginRewriteRefusal } from "./lib/sandcastle2-origin-rewrite.mjs";
import { readRendererStateInPage } from "./lib/sandcastle2-renderer-gate.mjs";
import {
  WATER_CELLS,
  WATER_DEMO_ID,
  WAVE_EPOCH_DIAL,
  descriptor,
  mismatchPct,
  planWaterCells,
  stageGaps,
  stageHandlesDial,
  summarizeWaterRecords,
  waterStagePlan,
  waterVerdicts,
  waveEpochReadback,
} from "./probe-water-cells.mjs";

// One fresh directory per run: a fixed path would be shared by every clone
// running this runner at once, and one run's cleanup would delete another's.
const TEMP_ROOT = fs.mkdtempSync(
  path.join(os.tmpdir(), "probe-water-cells-spec-"),
);

after(() => {
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
});

const rigs = await loadRigs();
const rigsById = new Map(rigs.map((rig) => [rig.id, rig]));
const rigOf = (id) => {
  const rig = rigsById.get(id);
  assert.ok(rig, `rig ${id} is not in the registry`);
  return rig;
};

// ---------------------------------------------------------------------------
// R: the eight rigs
// ---------------------------------------------------------------------------

const WATER_FLAGS = [
  "globalWaterMask",
  "lakeWaterMask",
  "riverWaterMask",
  "enableEnhancedOcean",
];
const CLOCK = "2026-06-21T16:00:00Z";

// The sheet's leg-2 table: camera (lon, lat, height m, heading, pitch rad),
// the flags the sheet names, the settle frames.
const SHEET = {
  "water-great-lakes": {
    camera: {
      lon: -84.5,
      lat: 44.5,
      height: 900000,
      heading: 0,
      pitch: -1.5707963,
    },
    on: { globalWaterMask: true, lakeWaterMask: true },
    frames: 120,
  },
  "water-coast-50km": {
    camera: {
      lon: -122.45,
      lat: 37.75,
      height: 50000,
      heading: 0,
      pitch: -1.2,
    },
    on: { globalWaterMask: true },
    frames: 120,
  },
  "water-orbit-disc": {
    camera: {
      lon: -40.0,
      lat: 15.0,
      height: 20000000,
      heading: 0,
      pitch: -1.5707963,
    },
    on: { globalWaterMask: true },
    frames: 240,
  },
};

const allFalse = Object.fromEntries(WATER_FLAGS.map((flag) => [flag, false]));
const flagsOf = (rig) =>
  Object.fromEntries(WATER_FLAGS.map((flag) => [flag, rig.dials[flag]]));

for (const [id, row] of Object.entries(SHEET)) {
  test(`R1: ${id} carries its leg-2 row of the sheet value for value, with all four flags declared`, () => {
    const rig = rigOf(id);
    assert.deepEqual(validateRig(rig), [], `${id} has violations`);
    assert.ok(rig.tags.includes("water"));
    for (const [key, value] of Object.entries(row.camera)) {
      assert.equal(rig.camera[key], value, `${id} camera.${key}`);
    }
    assert.equal(rig.camera.roll ?? 0, 0);
    assert.equal(rig.clock, CLOCK);
    assert.equal(rig.dials.terrain, "ellipsoid");
    assert.equal(rig.dials.imagery, "naturalEarth");
    assert.equal(rig.dials.pinClock, true);
    assert.deepEqual(rig.viewport, { width: 1280, height: 720 });
    assert.equal(rig.readiness.frames, row.frames);
    assert.deepEqual([...rig.renderers].sort(), ["webgl", "webgpu"]);
    assert.deepEqual(flagsOf(rig), { ...allFalse, ...row.on });
  });

  test(`R2: ${id}-off is identical to ${id} except that all four water flags are false`, () => {
    const on = rigOf(id);
    const off = rigOf(`${id}-off`);
    assert.deepEqual(validateRig(off), [], `${id}-off has violations`);
    assert.ok(off.tags.includes("water"));
    assert.deepEqual(off.camera, on.camera);
    assert.equal(off.clock, on.clock);
    assert.deepEqual(off.viewport, on.viewport);
    assert.deepEqual(off.readiness, on.readiness);
    assert.deepEqual([...off.renderers].sort(), [...on.renderers].sort());
    assert.deepEqual(flagsOf(off), allFalse);
    const differing = Object.keys({ ...on.dials, ...off.dials }).filter(
      (key) => JSON.stringify(on.dials[key]) !== JSON.stringify(off.dials[key]),
    );
    assert.ok(differing.length > 0, "the pair must differ somewhere");
    for (const key of differing) {
      assert.ok(
        WATER_FLAGS.includes(key),
        `${key} differs but is not a water flag`,
      );
    }
    assert.notEqual(
      replayKeyFor(on),
      replayKeyFor(off),
      "replay keys must differ",
    );
  });
}

test("R3: water-great-lakes-lakeonly is water-great-lakes with the lake flag alone", () => {
  const full = rigOf("water-great-lakes");
  const lake = rigOf("water-great-lakes-lakeonly");
  assert.deepEqual(validateRig(lake), []);
  assert.ok(lake.tags.includes("water"));
  assert.equal(lake.dials.globalWaterMask, false);
  assert.equal(lake.dials.lakeWaterMask, true);
  assert.equal(lake.dials.riverWaterMask, false);
  assert.equal(lake.dials.enableEnhancedOcean, false);
  assert.deepEqual(lake.camera, full.camera);
  assert.equal(lake.clock, full.clock);
  assert.deepEqual(lake.viewport, full.viewport);
  assert.deepEqual(lake.readiness, full.readiness);
  assert.deepEqual([...lake.renderers].sort(), [...full.renderers].sort());
  const { globalWaterMask: _a, ...lakeRest } = lake.dials;
  const { globalWaterMask: _b, ...fullRest } = full.dials;
  assert.deepEqual(lakeRest, fullRest);
});

test("R3: water-great-lakes-off is also the OFF twin of the lake-only rig, differing in the water flags alone", () => {
  const lake = rigOf("water-great-lakes-lakeonly");
  const off = rigOf("water-great-lakes-off");
  assert.deepEqual(off.camera, lake.camera);
  assert.equal(off.clock, lake.clock);
  assert.deepEqual(off.viewport, lake.viewport);
  assert.deepEqual(off.readiness, lake.readiness);
  for (const key of Object.keys({ ...lake.dials, ...off.dials })) {
    if (!WATER_FLAGS.includes(key)) {
      assert.deepEqual(lake.dials[key], off.dials[key], `dial ${key}`);
    }
  }
  assert.notEqual(replayKeyFor(lake), replayKeyFor(off));
});

const LEG2_RIG_IDS = [
  ...Object.keys(SHEET),
  ...Object.keys(SHEET).map((id) => `${id}-off`),
  "water-great-lakes-lakeonly",
];

test("R4: each of the six leg-2 rigs and the lake-only rig stages as the probe hands it over, and the payload's water part is the four flags", () => {
  for (const id of LEG2_RIG_IDS) {
    const rig = rigOf(id);
    // The rig as the probe stages it: without the epoch dial where the stage
    // has no handler for it (the stage refuses a dial it does not know).
    const payload = landingStagePayload(waterStagePlan(rig).rig);
    const flags = Object.fromEntries(
      Object.entries(payload.water).filter(([key]) =>
        WATER_FLAGS.includes(key),
      ),
    );
    assert.deepEqual(flags, flagsOf(rig), `${id} water part`);
    // A stage with the handler may file the epoch with the water dials.
    assert.deepEqual(
      Object.keys(payload.water)
        .filter((key) => key !== WAVE_EPOCH_DIAL)
        .sort(),
      [...WATER_FLAGS].sort(),
    );
  }
});

test("R7 (A2-1): every leg-2 rig and OFF twin pins the wave epoch to the sheet's instant, the twins at the same value; the 1f rig carries none", () => {
  for (const id of LEG2_RIG_IDS) {
    assert.equal(
      rigOf(id).dials[WAVE_EPOCH_DIAL],
      CLOCK,
      `${id} ${WAVE_EPOCH_DIAL}`,
    );
  }
  for (const [cell, spec] of Object.entries(WATER_CELLS)) {
    if (spec.kind === "mask-pair") {
      assert.equal(
        rigOf(spec.on).dials[WAVE_EPOCH_DIAL],
        rigOf(spec.off).dials[WAVE_EPOCH_DIAL],
        `${cell}: ON and OFF epochs`,
      );
    }
  }
  assert.equal(
    Object.hasOwn(
      rigOf("sandcastle2-globe-materials-water-mask").dials,
      WAVE_EPOCH_DIAL,
    ),
    false,
  );
});

test("R7 (A2-1): 2g is declared on the three cells the sheet bands with it, and not on the lake-only cell", () => {
  const declared = Object.entries(WATER_CELLS)
    .filter(([, spec]) => spec.waveEpochRepeat === true)
    .map(([cell]) => cell)
    .sort();
  assert.deepEqual(declared, ["coast-50km", "great-lakes", "orbit-disc"]);
});

test("R5: the sandcastle rig for cell 1f is tagged sandcastle, valid, and pinned to the sheet's clock", () => {
  const rig = rigOf("sandcastle2-globe-materials-water-mask");
  assert.deepEqual(validateRig(rig), []);
  assert.deepEqual(rig.tags, ["sandcastle"]);
  assert.equal(rig.clock, CLOCK);
  assert.equal(rig.readiness.frames, 240);
  assert.deepEqual(rig.viewport, { width: 1280, height: 720 });
});

test("R6: the new rigs are counted under their tags: seven water and one sandcastle among them", () => {
  const water = rigs
    .filter((rig) => rig.tags.includes("water"))
    .map((rig) => rig.id);
  for (const id of [
    "water-great-lakes",
    "water-great-lakes-off",
    "water-great-lakes-lakeonly",
    "water-coast-50km",
    "water-coast-50km-off",
    "water-orbit-disc",
    "water-orbit-disc-off",
  ]) {
    assert.ok(water.includes(id), `${id} is not tagged water`);
  }
  assert.ok(
    rigs
      .filter((rig) => rig.tags.includes("sandcastle"))
      .some((rig) => rig.id === "sandcastle2-globe-materials-water-mask"),
  );
});

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

// ---------------------------------------------------------------------------
// S: summarizeWaterRecords, on synthetic captures
// ---------------------------------------------------------------------------

const SIZE = 100;
const PIXELS = SIZE * SIZE;

/** A flat grey image whose first pixels carry per-channel deltas. */
function image(spans = []) {
  const data = new Uint8ClampedArray(PIXELS * 4);
  for (let i = 0; i < PIXELS; i += 1) {
    data[i * 4] = 100;
    data[i * 4 + 1] = 100;
    data[i * 4 + 2] = 100;
    data[i * 4 + 3] = 255;
  }
  let cursor = 0;
  for (const { count, channel = 0, delta } of spans) {
    for (let i = 0; i < count; i += 1) {
      data[(cursor + i) * 4 + channel] += delta;
    }
    cursor += count;
  }
  return { width: SIZE, height: SIZE, data };
}

function makeStore() {
  const files = new Map();
  return {
    put(name, img) {
      files.set(name, img);
      return { path: name, sha256: name };
    },
    loadImage: (file) => {
      assert.ok(files.has(file), `unexpected image load: ${file}`);
      return files.get(file);
    },
  };
}

function record(store, cell, variant, renderer, run, img, extra = {}) {
  const base = {
    run,
    cell,
    kind: WATER_CELLS[cell].kind,
    variant,
    rig: `${cell}-${variant}`,
    renderer,
    notRun: null,
  };
  if (img !== null) {
    base.capture = store.put(`${cell}/${variant}/${renderer}/${run}`, img);
  }
  return { ...base, ...extra };
}

const near = (actual, expected, label) =>
  assert.ok(
    typeof actual === "number" && Math.abs(actual - expected) < 1e-9,
    `${label}: expected ${expected}, got ${actual}`,
  );

test("S0: mismatchPct is null for different sizes and counts channels beyond the tolerance only", () => {
  const a = image();
  assert.equal(mismatchPct(a, { ...a, width: SIZE - 1 }, 8), null);
  assert.equal(mismatchPct(null, a, 8), null);
  near(
    mismatchPct(a, image([{ count: 50, delta: 8 }]), 8),
    0,
    "delta 8 at tol 8",
  );
  near(
    mismatchPct(a, image([{ count: 50, delta: 9 }]), 8),
    0.5,
    "delta 9 at tol 8",
  );
});

test("S1: effectPct is the share of pixels with any channel more than 8/255 apart, OFF vs ON on one renderer, per run", () => {
  const store = makeStore();
  const off = image();
  // run 0: 200 px red +9, 100 px green +9 (any channel counts), 100 px red +8
  // (not counted) = 300 px = 3 percent.
  const on0 = image([
    { count: 200, channel: 0, delta: 9 },
    { count: 100, channel: 1, delta: 9 },
    { count: 100, channel: 0, delta: 8 },
  ]);
  // run 1: 500 px = 5 percent.
  const on1 = image([{ count: 500, channel: 2, delta: 40 }]);
  const records = [];
  for (const renderer of ["webgl", "webgpu"]) {
    records.push(record(store, "coast-50km", "off", renderer, 0, off));
    records.push(record(store, "coast-50km", "on", renderer, 0, on0));
    records.push(record(store, "coast-50km", "off", renderer, 1, off));
    records.push(record(store, "coast-50km", "on", renderer, 1, on1));
  }
  const entry = summarizeWaterRecords(records, { loadImage: store.loadImage })[
    "coast-50km"
  ];
  for (const renderer of ["webgl", "webgpu"]) {
    assert.equal(entry.effectPct[renderer].length, 2);
    near(entry.effectPct[renderer][0], 3, `${renderer} run 0`);
    near(entry.effectPct[renderer][1], 5, `${renderer} run 1`);
  }
});

test("S2: parityOnPct and parityOffPct are the WebGL-vs-WebGPU mismatch at tolerance 16, per run, in percent", () => {
  const store = makeStore();
  // 100 px at +16 are within the tolerance, 100 px at +17 are not: 1 percent.
  const gpuOn = image([
    { count: 100, delta: 16 },
    { count: 100, delta: 17 },
  ]);
  const records = [
    record(store, "orbit-disc", "on", "webgl", 0, image()),
    record(store, "orbit-disc", "on", "webgpu", 0, gpuOn),
    record(store, "orbit-disc", "off", "webgl", 0, image()),
    record(
      store,
      "orbit-disc",
      "off",
      "webgpu",
      0,
      image([{ count: 300, delta: 40 }]),
    ),
  ];
  const entry = summarizeWaterRecords(records, { loadImage: store.loadImage })[
    "orbit-disc"
  ];
  assert.equal(entry.parityOnPct.length, 1);
  near(entry.parityOnPct[0], 1, "parityOn");
  near(entry.parityOffPct[0], 3, "parityOff");
});

test("S3: offRepeatPct is OFF run 0 against OFF run 1 at tolerance 8 per renderer, and null with a single run", () => {
  const store = makeStore();
  const single = [];
  const double = [];
  for (const renderer of ["webgl", "webgpu"]) {
    const off0 = record(store, "great-lakes", "off", renderer, 0, image());
    const on0 = record(store, "great-lakes", "on", renderer, 0, image());
    single.push(off0, on0);
    // 100 px at +9 count, 100 px at +8 do not: 1 percent.
    const off1 = record(
      store,
      "great-lakes",
      "off",
      renderer,
      1,
      image([
        { count: 100, delta: 9 },
        { count: 100, delta: 8 },
      ]),
    );
    const on1 = record(store, "great-lakes", "on", renderer, 1, image());
    double.push(off0, on0, off1, on1);
  }
  const one = summarizeWaterRecords(single, { loadImage: store.loadImage })[
    "great-lakes"
  ];
  assert.equal(one.offRepeatPct.webgl, null);
  assert.equal(one.offRepeatPct.webgpu, null);
  const two = summarizeWaterRecords(double, { loadImage: store.loadImage })[
    "great-lakes"
  ];
  near(two.offRepeatPct.webgl, 1, "webgl");
  near(two.offRepeatPct.webgpu, 1, "webgpu");
});

test("S4: a missing or NOT RUN capture yields null, never 0", () => {
  const store = makeStore();
  const records = [
    record(store, "coast-50km", "off", "webgl", 0, image()),
    record(
      store,
      "coast-50km",
      "on",
      "webgl",
      0,
      image([{ count: 100, delta: 50 }]),
    ),
    // WebGPU ON page was NOT RUN: it has no capture.
    record(store, "coast-50km", "off", "webgpu", 0, image()),
    record(store, "coast-50km", "on", "webgpu", 0, null, {
      notRun: "the stage did not apply x",
    }),
  ];
  const entry = summarizeWaterRecords(records, { loadImage: store.loadImage })[
    "coast-50km"
  ];
  near(entry.effectPct.webgl[0], 1, "webgl effect");
  assert.equal(entry.effectPct.webgpu[0], null);
  assert.equal(entry.parityOnPct[0], null);
  near(entry.parityOffPct[0], 0, "off parity is measured");
  assert.equal(entry.notRun.length, 1);
});

test("S4: a capture on a page that is also marked NOT RUN is not measured", () => {
  const store = makeStore();
  const records = [
    record(store, "coast-50km", "off", "webgl", 0, image()),
    record(
      store,
      "coast-50km",
      "on",
      "webgl",
      0,
      image([{ count: 100, delta: 50 }]),
      {
        notRun: "late failure",
      },
    ),
  ];
  const entry = summarizeWaterRecords(records, { loadImage: store.loadImage })[
    "coast-50km"
  ];
  assert.equal(entry.effectPct.webgl[0], null);
});

test("S5: for 1f repeatPct is run 0 against run 1 at tolerance 16 (null with one run) and parityPct is per run", () => {
  const store = makeStore();
  const runs = (count) => {
    const out = [];
    for (let run = 0; run < count; run += 1) {
      out.push(
        record(
          store,
          "1f",
          "demo",
          "webgl",
          run,
          run === 0
            ? image()
            : image([
                { count: 100, delta: 16 },
                { count: 200, delta: 17 },
              ]),
        ),
        record(
          store,
          "1f",
          "demo",
          "webgpu",
          run,
          image([{ count: 400, delta: 30 }]),
        ),
      );
    }
    return out;
  };
  const one = summarizeWaterRecords(runs(1), { loadImage: store.loadImage })[
    "1f"
  ];
  assert.equal(one.repeatPct.webgl, null);
  assert.equal(one.repeatPct.webgpu, null);
  assert.equal(one.parityPct.length, 1);
  near(one.parityPct[0], 4, "parity run 0");
  const two = summarizeWaterRecords(runs(2), { loadImage: store.loadImage })[
    "1f"
  ];
  near(two.repeatPct.webgl, 2, "webgl repeat");
  near(two.repeatPct.webgpu, 0, "webgpu repeat");
  assert.equal(two.parityPct.length, 2);
  // run 1: the WebGL image is +16 on 100 px and +17 on 200 px, the WebGPU
  // image +30 on 400 px: 14 and 13 apart (within 16) and then 100 px that are
  // 30 apart, which is 1 percent.
  near(two.parityPct[1], 1, "parity run 1");
});

// ---------------------------------------------------------------------------
// V: waterVerdicts
// ---------------------------------------------------------------------------

const cleanGate = {
  deviceLost: null,
  errorCount: 0,
  errors: [],
  armedDevices: 1,
  pageErrorCount: 0,
};

/** Records for one mask cell, one page each, all clean; images are flat. */
function flatMaskRecords(store, cell, { absent = [] } = {}) {
  const out = [];
  for (const renderer of ["webgl", "webgpu"]) {
    for (const variant of ["off", "on"]) {
      out.push(
        record(store, cell, variant, renderer, 0, image(), {
          gate: cleanGate,
          waterDialsAbsent: variant === "on" ? absent : [],
        }),
      );
    }
  }
  return out;
}

/** A real summary structure with the measured numbers overlaid. */
function maskSummary(cell, { absent = [], overlay = {} } = {}) {
  const store = makeStore();
  const records = flatMaskRecords(store, cell, { absent });
  const summary = summarizeWaterRecords(records, {
    loadImage: store.loadImage,
  });
  Object.assign(summary[cell], overlay);
  return { summary, records, store };
}

const verdict = (verdicts, cell, suffix) =>
  verdicts.find((v) => v.id.startsWith(`${cell}:`) && v.id.endsWith(suffix));
const verdictsWhere = (verdicts, cell, fragment) =>
  verdicts.filter(
    (v) => v.id.startsWith(`${cell}:`) && v.id.includes(fragment),
  );

test("V1: every page gets a :stage verdict that fails when the page was NOT RUN", () => {
  const store = makeStore();
  const ok = record(store, "coast-50km", "on", "webgl", 0, image(), {
    gate: cleanGate,
  });
  const bad = record(store, "coast-50km", "on", "webgpu", 0, null, {
    notRun: "the AFTER tree did not take globalWaterMask",
    gate: cleanGate,
  });
  const summary = summarizeWaterRecords([ok, bad], {
    loadImage: store.loadImage,
  });
  const verdicts = waterVerdicts([ok, bad], summary, null, { arm: "before" });
  const stageGl = verdicts.find(
    (v) => v.id.includes("webgl") && v.id.endsWith(":stage"),
  );
  const stageGpu = verdicts.find(
    (v) => v.id.includes("webgpu") && v.id.endsWith(":stage"),
  );
  assert.equal(stageGl.pass, true);
  assert.equal(stageGpu.pass, false);
  assert.equal(stageGpu.notRun, true);
});

test("V2: :2e-no-device-fault fails on a lost device, an uncaptured error or a page error, and passes clean", () => {
  const cases = [
    ["clean", cleanGate, true],
    [
      "device lost",
      { ...cleanGate, deviceLost: "device lost: reason=unknown" },
      false,
    ],
    [
      "uncaptured error",
      { ...cleanGate, errorCount: 1, errors: ["validation"] },
      false,
    ],
    ["page error", { ...cleanGate, pageErrorCount: 1 }, false],
  ];
  for (const [label, gate, pass] of cases) {
    const store = makeStore();
    const rec = record(store, "orbit-disc", "on", "webgpu", 0, image(), {
      gate,
    });
    const summary = summarizeWaterRecords([rec], {
      loadImage: store.loadImage,
    });
    const verdicts = waterVerdicts([rec], summary, null, { arm: "before" });
    const fault = verdicts.find((v) => v.id.endsWith(":2e-no-device-fault"));
    assert.ok(fault, `${label}: no 2e verdict`);
    assert.equal(fault.pass, pass, label);
  }
});

test("V2: a fault-free WebGPU page whose error gate armed no device fails 2e as NOT RUN; WebGL needs no armed device; a fault is a fault either way", () => {
  const cases = [
    // [label, renderer, gate, pass, notRun]
    [
      "webgpu, armed 0",
      "webgpu",
      { ...cleanGate, armedDevices: 0 },
      false,
      true,
    ],
    [
      "webgpu, armed missing",
      "webgpu",
      { ...cleanGate, armedDevices: undefined },
      false,
      true,
    ],
    ["webgpu, armed 1", "webgpu", cleanGate, true, undefined],
    [
      "webgl, armed 0",
      "webgl",
      { ...cleanGate, armedDevices: 0 },
      true,
      undefined,
    ],
    [
      "webgpu, armed 0, a page error",
      "webgpu",
      { ...cleanGate, armedDevices: 0, pageErrorCount: 1 },
      false,
      undefined,
    ],
  ];
  for (const [label, renderer, gate, pass, notRun] of cases) {
    const store = makeStore();
    const rec = record(store, "orbit-disc", "on", renderer, 0, image(), {
      gate,
    });
    const summary = summarizeWaterRecords([rec], {
      loadImage: store.loadImage,
    });
    const verdicts = waterVerdicts([rec], summary, null, { arm: "before" });
    const fault = verdicts.find((v) => v.id.endsWith(":2e-no-device-fault"));
    assert.equal(fault.pass, pass, label);
    assert.equal(fault.notRun, notRun, label);
    if (notRun) {
      assert.equal(fault.reason, "error gate not armed", label);
    }
  }
});

test("V3: the mask-effect bands (2b, 2c) are judged on the AFTER arm only", () => {
  const { summary, records } = maskSummary("coast-50km", {
    overlay: { effectPct: { webgl: [9], webgpu: [9] } },
  });
  const before = waterVerdicts(records, summary, null, { arm: "before" });
  assert.equal(
    verdict(before, "coast-50km", ":2b-effect-agreement"),
    undefined,
  );
  assert.equal(
    verdictsWhere(before, "coast-50km", ":2c-effect-floor").length,
    0,
  );
  const afterV = waterVerdicts(records, summary, null, { arm: "after" });
  assert.ok(verdict(afterV, "coast-50km", ":2b-effect-agreement"));
  assert.equal(
    verdictsWhere(afterV, "coast-50km", ":2c-effect-floor").length,
    2,
  );
});

test("V3: a cell with a water dial absent on the ON rig is not judged on 2b or 2c, even on AFTER", () => {
  const { summary, records } = maskSummary("coast-50km", {
    absent: ["globalWaterMask"],
    overlay: { effectPct: { webgl: [9], webgpu: [9] } },
  });
  const verdicts = waterVerdicts(records, summary, null, { arm: "after" });
  assert.equal(
    verdict(verdicts, "coast-50km", ":2b-effect-agreement"),
    undefined,
  );
  assert.equal(
    verdictsWhere(verdicts, "coast-50km", ":2c-effect-floor").length,
    0,
  );
});

function judge2b(gl, gpu) {
  const { summary, records } = maskSummary("coast-50km", {
    overlay: { effectPct: { webgl: [gl], webgpu: [gpu] } },
  });
  return verdict(
    waterVerdicts(records, summary, null, { arm: "after" }),
    "coast-50km",
    ":2b-effect-agreement",
  );
}

test("V4: 2b passes iff |gl - gpu| <= max(0.1 x the larger, 0.3 pp)", () => {
  // relative arm dominates: larger 10.9, allowed 1.09
  assert.equal(judge2b(10, 10.9).pass, true);
  assert.equal(judge2b(10, 11.2).pass, false);
  // absolute arm dominates: larger 0.75, 10 percent is 0.075, allowed 0.3
  assert.equal(judge2b(0.5, 0.75).pass, true);
  assert.equal(judge2b(0.5, 0.9).pass, false);
  // symmetric
  assert.equal(judge2b(10.9, 10).pass, true);
  assert.equal(judge2b(11.2, 10).pass, false);
});

test("V4: 2b uses the median over runs", () => {
  const { summary, records } = maskSummary("coast-50km", {
    overlay: { effectPct: { webgl: [10, 50, 10.5], webgpu: [10.2, 0, 10.4] } },
  });
  const v = verdict(
    waterVerdicts(records, summary, null, { arm: "after" }),
    "coast-50km",
    ":2b-effect-agreement",
  );
  assert.equal(v.pass, true);
});

function judge2c(cell, gl, gpu) {
  const { summary, records } = maskSummary(cell, {
    overlay: { effectPct: { webgl: [gl], webgpu: [gpu] } },
  });
  const verdicts = waterVerdicts(records, summary, null, { arm: "after" });
  return {
    webgl: verdict(verdicts, cell, ":2c-effect-floor:webgl"),
    webgpu: verdict(verdicts, cell, ":2c-effect-floor:webgpu"),
  };
}

test("V5: 2c passes iff the median effect is at least the cell's floor: 0.5 for great-lakes", () => {
  assert.equal(judge2c("great-lakes", 0.5, 0.49).webgl.pass, true);
  assert.equal(judge2c("great-lakes", 0.5, 0.49).webgpu.pass, false);
  assert.equal(judge2c("great-lakes", 0.49, 3).webgl.pass, false);
});

test("V5: 2c floor is 5 for coast-50km", () => {
  const cell = "coast-50km";
  assert.equal(judge2c(cell, 5, 4.9).webgl.pass, true, `${cell} 5.0`);
  assert.equal(judge2c(cell, 5, 4.9).webgpu.pass, false, `${cell} 4.9`);
  assert.equal(
    judge2c(cell, 0.5, 0.5).webgl.pass,
    false,
    `${cell} 0.5 is below 5`,
  );
});

test("V5 (A3-1, seat ruling S6): 2c floor is 2 for orbit-disc, so Edge round 2's 3.325 / 3.269 % pass on both renderers", () => {
  assert.equal(WATER_CELLS["orbit-disc"].effectFloorPct, 2);
  const measured = judge2c("orbit-disc", 3.325, 3.269);
  assert.equal(measured.webgl.pass, true, "3.325 % on WebGL");
  assert.equal(measured.webgpu.pass, true, "3.269 % on WebGPU");
  assert.equal(measured.webgl.floorPct, 2);
  const edge = judge2c("orbit-disc", 2, 1.99);
  assert.equal(edge.webgl.pass, true, "2.0 is at the floor");
  assert.equal(edge.webgpu.pass, false, "1.99 is below 2");
});

test("V5: 2c judges the median of the runs, not an extreme", () => {
  const { summary, records } = maskSummary("great-lakes", {
    overlay: { effectPct: { webgl: [100, 0.1, 0.6], webgpu: [0.6, 0.6, 0.6] } },
  });
  const verdicts = waterVerdicts(records, summary, null, { arm: "after" });
  assert.equal(
    verdict(verdicts, "great-lakes", ":2c-effect-floor:webgl").pass,
    true,
  );
  const low = maskSummary("great-lakes", {
    overlay: { effectPct: { webgl: [100, 0.1, 0.2], webgpu: [0.6, 0.6, 0.6] } },
  });
  const lowVerdicts = waterVerdicts(low.records, low.summary, null, {
    arm: "after",
  });
  assert.equal(
    verdict(lowVerdicts, "great-lakes", ":2c-effect-floor:webgl").pass,
    false,
  );
});

function judge2f(effect, offRepeat) {
  const { summary, records } = maskSummary("great-lakes-lakeonly", {
    overlay: {
      effectPct: { webgl: [effect], webgpu: [effect] },
      offRepeatPct: { webgl: offRepeat, webgpu: offRepeat },
    },
  });
  const verdicts = waterVerdicts(records, summary, null, { arm: "after" });
  return {
    webgl: verdict(
      verdicts,
      "great-lakes-lakeonly",
      ":2f-effect-ceiling:webgl",
    ),
    webgpu: verdict(
      verdicts,
      "great-lakes-lakeonly",
      ":2f-effect-ceiling:webgpu",
    ),
    verdicts,
  };
}

test("V6: 2f passes iff the median effect is at most the OFF repeat (0 when null) plus 0.05 pp", () => {
  assert.equal(judge2f(0.04, null).webgl.pass, true);
  assert.equal(judge2f(0.06, null).webgl.pass, false);
  assert.equal(judge2f(0.24, 0.2).webgl.pass, true);
  assert.equal(judge2f(0.26, 0.2).webgl.pass, false);
  assert.equal(judge2f(0.26, 0.2).webgpu.pass, false);
  assert.equal(judge2f(0, 0).webgl.pass, true);
});

test("V6: the lake-only cell emits 2f and no 2b or 2c", () => {
  const { verdicts } = judge2f(0.01, null);
  assert.equal(
    verdict(verdicts, "great-lakes-lakeonly", ":2b-effect-agreement"),
    undefined,
  );
  assert.equal(
    verdictsWhere(verdicts, "great-lakes-lakeonly", ":2c-effect-floor").length,
    0,
  );
});

test("V6: 2f is judged on AFTER only", () => {
  const { summary, records } = maskSummary("great-lakes-lakeonly", {
    overlay: { effectPct: { webgl: [5], webgpu: [5] } },
  });
  const before = waterVerdicts(records, summary, null, { arm: "before" });
  assert.equal(
    verdictsWhere(before, "great-lakes-lakeonly", ":2f-effect-ceiling").length,
    0,
  );
});

test("V6: a median effect that is null fails 2f and 2c", () => {
  const { summary, records } = maskSummary("great-lakes-lakeonly", {
    overlay: { effectPct: { webgl: [null], webgpu: [null] } },
  });
  const verdicts = waterVerdicts(records, summary, null, { arm: "after" });
  assert.equal(
    verdict(verdicts, "great-lakes-lakeonly", ":2f-effect-ceiling:webgl").pass,
    false,
  );
});

function judge2a(afterParity, beforeParity) {
  const after = maskSummary("orbit-disc", {
    overlay: { parityOnPct: afterParity },
  });
  const before = maskSummary("orbit-disc", {
    overlay: { parityOnPct: beforeParity },
  });
  return verdict(
    waterVerdicts(after.records, after.summary, before.summary, {
      arm: "after",
    }),
    "orbit-disc",
    ":2a-parity",
  );
}

test("V7: 2a passes iff the after median parity is at most BEFORE's median + 1.0 + 3 x the after spread", () => {
  assert.equal(judge2a([2.9], [2]).pass, true);
  assert.equal(judge2a([3.1], [2]).pass, false);
  // spread 0.5 -> bound 2 + 1 + 1.5 = 4.5; median of [3.5, 4.0] is 3.75
  assert.equal(judge2a([3.5, 4.0], [2]).pass, true);
  // spread 2 -> bound 2 + 1 + 6 = 9; median of [3.1, 5.1] is 4.1
  assert.equal(judge2a([3.1, 5.1], [2]).pass, true);
  // spread 0.2 -> bound 3.6; median of [3.8, 4.0] is 3.9
  assert.equal(judge2a([3.8, 4.0], [2]).pass, false);
});

test("V7: 2a is emitted only on AFTER with a base", () => {
  const after = maskSummary("orbit-disc", { overlay: { parityOnPct: [1] } });
  const before = maskSummary("orbit-disc", { overlay: { parityOnPct: [1] } });
  assert.equal(
    verdict(
      waterVerdicts(after.records, after.summary, null, { arm: "after" }),
      "orbit-disc",
      ":2a-parity",
    ),
    undefined,
  );
  assert.equal(
    verdict(
      waterVerdicts(after.records, after.summary, before.summary, {
        arm: "before",
      }),
      "orbit-disc",
      ":2a-parity",
    ),
    undefined,
  );
});

test("V8: a base report that never measured the cell yields <cell>:base-absent, failing with notRun", () => {
  const after = maskSummary("orbit-disc", { overlay: { parityOnPct: [1] } });
  const other = maskSummary("coast-50km", {});
  const verdicts = waterVerdicts(after.records, after.summary, other.summary, {
    arm: "after",
  });
  const absent = verdicts.find((v) => v.id === "orbit-disc:base-absent");
  assert.ok(absent, `verdicts: ${verdicts.map((v) => v.id).join(", ")}`);
  assert.equal(absent.pass, false);
  assert.equal(absent.notRun, true);
});

// 1f: AFTER-vs-BEFORE on captured PNGs.

function demoRecords(store, prefix, specs) {
  const out = [];
  for (const [renderer, run, img] of specs) {
    const rec = {
      run,
      cell: "1f",
      kind: "sandcastle2-demo",
      variant: "demo",
      rig: "sandcastle2-globe-materials-water-mask",
      renderer,
      notRun: null,
      gate: cleanGate,
    };
    if (img !== null) {
      rec.capture = store.put(`${prefix}/${renderer}/${run}`, img);
    }
    out.push(rec);
  }
  return out;
}

function judge1f({
  after,
  before,
  afterRepeat,
  beforeRepeat,
  afterParity,
  beforeParity,
}) {
  const store = makeStore();
  const afterRecords = demoRecords(store, "after", after);
  const beforeRecords = demoRecords(store, "before", before);
  const afterSummary = summarizeWaterRecords(afterRecords, {
    loadImage: store.loadImage,
  });
  const beforeSummary = summarizeWaterRecords(beforeRecords, {
    loadImage: store.loadImage,
  });
  if (afterRepeat) {
    Object.assign(afterSummary["1f"].repeatPct, afterRepeat);
  }
  if (beforeRepeat) {
    Object.assign(beforeSummary["1f"].repeatPct, beforeRepeat);
  }
  if (afterParity) {
    afterSummary["1f"].parityPct = afterParity;
  }
  if (beforeParity) {
    beforeSummary["1f"].parityPct = beforeParity;
  }
  return waterVerdicts(afterRecords, afterSummary, beforeSummary, {
    arm: "after",
    loadImage: store.loadImage,
  });
}

const flat = () => image();
const moved = (count, delta = 17) => image([{ count, delta }]);

test("V9: 1f after-vs-before passes iff the first-run mismatch (tolerance 16) is at most max(0.05, 2 x the larger repeat)", () => {
  const same = [
    ["webgl", 0, flat()],
    ["webgpu", 0, flat()],
  ];
  const v = (count, extra = {}) =>
    judge1f({
      after: [
        ["webgl", 0, moved(count)],
        ["webgpu", 0, moved(count)],
      ],
      before: same,
      ...extra,
    });
  // 4 px = 0.04 percent <= 0.05
  assert.equal(verdict(v(4), "1f", ":after-vs-before:webgl").pass, true);
  assert.equal(verdict(v(4), "1f", ":after-vs-before:webgpu").pass, true);
  // 6 px = 0.06 percent > 0.05
  assert.equal(verdict(v(6), "1f", ":after-vs-before:webgl").pass, false);
  // a tolerance-16 difference is not a difference
  assert.equal(
    verdict(
      judge1f({
        after: [
          ["webgl", 0, moved(2000, 16)],
          ["webgpu", 0, moved(2000, 16)],
        ],
        before: same,
      }),
      "1f",
      ":after-vs-before:webgl",
    ).pass,
    true,
  );
  // the larger repeat of either tree widens the band: 2 x 0.04 = 0.08
  assert.equal(
    verdict(
      v(6, { afterRepeat: { webgl: 0.04, webgpu: 0.04 } }),
      "1f",
      ":after-vs-before:webgl",
    ).pass,
    true,
  );
  assert.equal(
    verdict(
      v(6, { beforeRepeat: { webgl: 0.04, webgpu: 0.04 } }),
      "1f",
      ":after-vs-before:webgl",
    ).pass,
    true,
  );
  assert.equal(
    verdict(
      v(9, { beforeRepeat: { webgl: 0.04, webgpu: 0.04 } }),
      "1f",
      ":after-vs-before:webgl",
    ).pass,
    false,
  );
});

test("V9: 1f after-vs-before compares the FIRST runs only", () => {
  const verdicts = judge1f({
    after: [
      ["webgl", 0, flat()],
      ["webgl", 1, moved(3000)],
      ["webgpu", 0, flat()],
      ["webgpu", 1, moved(3000)],
    ],
    before: [
      ["webgl", 0, flat()],
      ["webgl", 1, flat()],
      ["webgpu", 0, flat()],
      ["webgpu", 1, flat()],
    ],
    afterRepeat: { webgl: 0, webgpu: 0 },
  });
  assert.equal(verdict(verdicts, "1f", ":after-vs-before:webgl").pass, true);
  assert.equal(verdict(verdicts, "1f", ":after-vs-before:webgpu").pass, true);
});

test("V9: 1f with a capture missing on either side fails with notRun, for that renderer only", () => {
  const verdicts = judge1f({
    after: [
      ["webgl", 0, flat()],
      ["webgpu", 0, flat()],
    ],
    before: [
      ["webgl", 0, null],
      ["webgpu", 0, flat()],
    ],
  });
  const gl = verdict(verdicts, "1f", ":after-vs-before:webgl");
  assert.equal(gl.pass, false);
  assert.equal(gl.notRun, true);
  assert.equal(verdict(verdicts, "1f", ":after-vs-before:webgpu").pass, true);
});

test("V9: parity-as-before compares the parity medians within the same band", () => {
  const same = [
    ["webgl", 0, flat()],
    ["webgpu", 0, flat()],
  ];
  const run = (afterParity, beforeParity, repeat) =>
    verdict(
      judge1f({
        after: same,
        before: same,
        afterParity,
        beforeParity,
        afterRepeat: repeat,
        beforeRepeat: repeat,
      }),
      "1f",
      ":parity-as-before",
    );
  assert.equal(run([0.5], [0.54]).pass, true);
  assert.equal(run([0.5], [0.6]).pass, false);
  assert.equal(run([0.6], [0.5]).pass, false);
  // repeat 0.04 on both renderers -> band 0.08
  assert.equal(run([0.5], [0.57], { webgl: 0.04, webgpu: 0.04 }).pass, true);
});

test("V9: 1f is not judged without a base or on the BEFORE arm", () => {
  const store = makeStore();
  const records = demoRecords(store, "a", [
    ["webgl", 0, flat()],
    ["webgpu", 0, flat()],
  ]);
  const summary = summarizeWaterRecords(records, {
    loadImage: store.loadImage,
  });
  for (const [base, arm] of [
    [null, "after"],
    [summary, "before"],
  ]) {
    const verdicts = waterVerdicts(records, summary, base, {
      arm,
      loadImage: store.loadImage,
    });
    assert.equal(verdictsWhere(verdicts, "1f", ":after-vs-before").length, 0);
    assert.equal(verdictsWhere(verdicts, "1f", ":parity-as-before").length, 0);
  }
});

// 1f parity with canvases of different sizes per renderer (A2-2; Edge round 2
// measured 1280x687 on WebGL and 1280x520 on WebGPU on both trees).

const sized = (width, height) => ({
  width,
  height,
  data: new Uint8ClampedArray(width * height * 4).fill(200),
});

test("V11 (A2-2): parity-as-before with different canvas sizes per renderer is NOT RUN, 'canvas size differs', naming both sizes; never a FAIL with null values", () => {
  const split = () => [
    ["webgl", 0, sized(1280, 687)],
    ["webgpu", 0, sized(1280, 520)],
    ["webgl", 1, sized(1280, 687)],
    ["webgpu", 1, sized(1280, 520)],
  ];
  const verdicts = judge1f({ after: split(), before: split() });
  const parity = verdict(verdicts, "1f", ":parity-as-before");
  assert.equal(parity.pass, false);
  assert.equal(parity.notRun, true, "NOT RUN, not a measured FAIL");
  assert.ok(
    parity.reason.startsWith("canvas size differs: "),
    String(parity.reason),
  );
  for (const text of ["AFTER", "BEFORE", "1280x687", "1280x520"]) {
    assert.ok(parity.reason.includes(text), `${text} in ${parity.reason}`);
  }
  assert.deepEqual(parity.sizes.after[0], {
    webgl: "1280x687",
    webgpu: "1280x520",
  });
  // The same-renderer terms still measure: each renderer's canvas is one size
  // on both trees.
  assert.equal(verdict(verdicts, "1f", ":after-vs-before:webgl").pass, true);
  assert.equal(verdict(verdicts, "1f", ":after-vs-before:webgpu").pass, true);
});

test("V11 (A2-2): a size split on AFTER alone names AFTER's sizes, and a missing capture is named as such", () => {
  const verdicts = judge1f({
    after: [
      ["webgl", 0, sized(40, 30)],
      ["webgpu", 0, sized(40, 20)],
    ],
    before: [
      ["webgl", 0, sized(40, 30)],
      ["webgpu", 0, sized(40, 30)],
    ],
  });
  const parity = verdict(verdicts, "1f", ":parity-as-before");
  assert.equal(parity.notRun, true);
  assert.equal(
    parity.reason,
    "canvas size differs: AFTER webgl 40x30 vs webgpu 40x20",
  );
  const gap = verdict(
    judge1f({
      after: [
        ["webgl", 0, flat()],
        ["webgpu", 0, null],
      ],
      before: [
        ["webgl", 0, flat()],
        ["webgpu", 0, flat()],
      ],
    }),
    "1f",
    ":parity-as-before",
  );
  assert.equal(gap.notRun, true);
  assert.equal(
    gap.reason,
    "no WebGL and WebGPU capture pair of one size on AFTER",
  );
});

test("V11 (A2-2): canvases of one size still measure parity-as-before and record no reason", () => {
  const same = [
    ["webgl", 0, flat()],
    ["webgpu", 0, flat()],
  ];
  const parity = verdict(
    judge1f({ after: same, before: same }),
    "1f",
    ":parity-as-before",
  );
  assert.equal(parity.pass, true);
  assert.equal(parity.notRun, undefined);
  assert.equal(parity.reason, undefined);
});

test("V11 (A2-2): a BEFORE report written before paritySizes existed gives its sizes from its own captures", () => {
  const store = makeStore();
  const split = (prefix) =>
    demoRecords(store, prefix, [
      ["webgl", 0, sized(1280, 687)],
      ["webgpu", 0, sized(1280, 520)],
    ]);
  const afterRecords = split("after");
  const beforeRecords = split("before");
  const summarize = (records) =>
    summarizeWaterRecords(records, { loadImage: store.loadImage });
  const afterSummary = summarize(afterRecords);
  const beforeSummary = summarize(beforeRecords);
  delete beforeSummary["1f"].paritySizes;
  const parity = verdict(
    waterVerdicts(afterRecords, afterSummary, beforeSummary, {
      arm: "after",
      loadImage: store.loadImage,
    }),
    "1f",
    ":parity-as-before",
  );
  assert.equal(parity.notRun, true);
  assert.equal(
    parity.reason,
    "canvas size differs: AFTER webgl 1280x687 vs webgpu 1280x520; BEFORE webgl 1280x687 vs webgpu 1280x520",
  );
});

// 2g: the pinned-epoch repeat of each ON rig (A2-1).

const epochApplied = { requested: CLOCK, observed: CLOCK, applied: true };

/** ON pages of a mask cell on both renderers, `images[renderer]` per run. */
function epochRecords(store, cell, images, waveEpoch = () => epochApplied) {
  const out = [];
  for (const [renderer, runs] of Object.entries(images)) {
    runs.forEach((img, run) => {
      out.push(
        record(store, cell, "on", renderer, run, img, {
          gate: cleanGate,
          waterDialsAbsent: [],
          waveEpoch: waveEpoch(renderer, run),
        }),
      );
    });
  }
  return out;
}

function judge2g(cell, images, { arm = "after", waveEpoch } = {}) {
  const store = makeStore();
  const records = epochRecords(store, cell, images, waveEpoch);
  const summary = summarizeWaterRecords(records, {
    loadImage: store.loadImage,
  });
  return {
    summary,
    verdicts: waterVerdicts(records, summary, null, {
      arm,
      loadImage: store.loadImage,
    }),
  };
}

test("V10 (A2-1): 2g passes iff ON run 0 against run 1 at tolerance 16 is at most 0.05 pp, per renderer and rig", () => {
  const twice = (second) => ({
    webgl: [flat(), second],
    webgpu: [flat(), flat()],
  });
  const at = (second) =>
    judge2g("coast-50km", twice(second)).verdicts.filter((v) =>
      v.id.includes(":2g-wave-epoch-repeat:"),
    );
  const five = at(moved(5));
  assert.deepEqual(five.map((v) => v.id).sort(), [
    "coast-50km:2g-wave-epoch-repeat:webgl",
    "coast-50km:2g-wave-epoch-repeat:webgpu",
  ]);
  const gl = five.find((v) => v.renderer === "webgl");
  assert.equal(gl.pass, true, "5 px = 0.05 pp is within");
  near(gl.repeatPct, 0.05, "repeat");
  assert.equal(gl.rig, "water-coast-50km");
  assert.equal(gl.epoch, CLOCK);
  assert.equal(gl.bandPp, 0.05);
  const six = at(moved(6)).find((v) => v.renderer === "webgl");
  assert.equal(six.pass, false, "6 px = 0.06 pp is over");
  assert.equal(six.notRun, undefined, "a measured repeat is not NOT RUN");
  assert.equal(
    at(moved(6)).find((v) => v.renderer === "webgpu").pass,
    true,
    "renderers are judged apart",
  );
  assert.equal(
    at(moved(4000, 16)).find((v) => v.renderer === "webgl").pass,
    true,
    "a tolerance-16 difference is not a difference",
  );
});

test("V10 (A2-1): an epoch that read back applied false makes 2g NOT RUN on that renderer, with the readback's reason", () => {
  const { verdicts } = judge2g(
    "orbit-disc",
    { webgl: [flat(), flat()], webgpu: [flat(), flat()] },
    {
      waveEpoch: (renderer, run) =>
        renderer === "webgpu" && run === 1
          ? {
              requested: CLOCK,
              observed: null,
              applied: false,
              reason: "stub: no handler",
            }
          : epochApplied,
    },
  );
  const gpu = verdict(verdicts, "orbit-disc", ":2g-wave-epoch-repeat:webgpu");
  assert.equal(gpu.pass, false);
  assert.equal(gpu.notRun, true);
  assert.ok(gpu.reason.startsWith("waterSimulationEpoch applied: false"));
  assert.ok(gpu.reason.includes("run1: stub: no handler"), gpu.reason);
  assert.equal(
    verdict(verdicts, "orbit-disc", ":2g-wave-epoch-repeat:webgl").pass,
    true,
  );
  const missing = judge2g(
    "great-lakes",
    { webgl: [flat(), flat()] },
    { waveEpoch: () => undefined },
  ).verdicts.find((v) => v.id.includes(":2g-"));
  assert.equal(missing.notRun, true);
  assert.ok(missing.reason.includes("no wave-epoch readback"), missing.reason);
});

test("V10 (A2-1, A3-2): 2g on a single-run arm is NOT RUN asking for --runs 2 or more, never 'two captured ON runs'", () => {
  const { verdicts } = judge2g("great-lakes", { webgl: [flat()] });
  const gl = verdict(verdicts, "great-lakes", ":2g-wave-epoch-repeat:webgl");
  assert.equal(gl.notRun, true);
  assert.equal(gl.reason, "2g needs --runs 2 or more (this arm ran 1)");
  assert.equal(gl.repeatPct, null);
  const store = makeStore();
  const records = epochRecords(store, "great-lakes", { webgl: [flat()] });
  const declared = verdict(
    waterVerdicts(
      records,
      summarizeWaterRecords(records, { loadImage: store.loadImage }),
      null,
      { arm: "after", runs: 1, loadImage: store.loadImage },
    ),
    "great-lakes",
    ":2g-wave-epoch-repeat:webgl",
  );
  assert.equal(declared.reason, "2g needs --runs 2 or more (this arm ran 1)");
});

// A3-2 (N8): 2g names the cause that kept it from being measured.

/** The 2g verdict on WebGL for ON pages built by `pages(store)`. */
function judge2gPages(pages, runs) {
  const store = makeStore();
  const records = pages(store);
  const verdicts = waterVerdicts(
    records,
    summarizeWaterRecords(records, { loadImage: store.loadImage }),
    null,
    { arm: "after", runs, loadImage: store.loadImage },
  );
  return verdict(verdicts, "coast-50km", ":2g-wave-epoch-repeat:webgl");
}

const onPage = (store, run, extra) =>
  record(store, "coast-50km", "on", "webgl", run, flat(), {
    gate: cleanGate,
    waterDialsAbsent: [],
    waveEpoch: epochApplied,
    ...extra,
  });

test("V13 (A3-2): an ON page NOT RUN for another reason makes 2g NOT RUN with that page's own reason, not the run count", () => {
  const unsettled = "the scene did not settle (stub)";
  const chrome =
    "capture-chrome-over-canvas: water-coast-50km: stub chrome left over the canvas";
  for (const reason of [unsettled, chrome]) {
    const g = judge2gPages(
      (store) => [
        onPage(store, 0),
        { ...onPage(store, 1), capture: undefined, notRun: reason },
      ],
      2,
    );
    assert.equal(g.notRun, true);
    assert.equal(g.pass, false);
    assert.equal(g.reason, `ON page NOT RUN (run1: ${reason})`);
    assert.ok(!g.reason.includes("--runs"), g.reason);
  }
});

test("V13 (A3-2): a page refused before staging reads 'page refused before staging', not 'no wave-epoch readback'", () => {
  const g = judge2gPages(
    (store) => [
      onPage(store, 0),
      {
        ...onPage(store, 1),
        capture: undefined,
        waveEpoch: undefined,
        notRun: "stub-refusal: refused before the stage ran",
      },
    ],
    2,
  );
  assert.equal(g.notRun, true);
  assert.equal(
    g.reason,
    "page refused before staging (run1: stub-refusal: refused before the stage ran)",
  );
  assert.ok(!g.reason.includes("no wave-epoch readback"), g.reason);
  assert.ok(!g.reason.includes("applied: false"), g.reason);
});

test("V13 (A3-2): 'two captured ON runs' appears only when --runs >= 2 was given and fewer than two ON runs were captured", () => {
  const short = judge2gPages((store) => [onPage(store, 0)], 2);
  assert.equal(short.notRun, true);
  assert.equal(
    short.reason,
    "2g needs two captured ON runs at the pinned epoch (--runs 2, 1 captured)",
  );
  const single = judge2gPages((store) => [onPage(store, 0)], 1);
  assert.ok(!single.reason.includes("two captured ON runs"), single.reason);
  const measured = judge2gPages(
    (store) => [onPage(store, 0), onPage(store, 1)],
    2,
  );
  assert.equal(measured.pass, true);
  assert.equal(measured.reason, undefined);
  // The descriptor hands the arm's --runs to the verdicts.
  const one = [onPage(makeStore(), 0)];
  const through = (runs) =>
    verdict(
      descriptor.verdicts(one, { options: { arm: "after", runs } }),
      "coast-50km",
      ":2g-wave-epoch-repeat:webgl",
    ).reason;
  assert.equal(
    through(2),
    "2g needs two captured ON runs at the pinned epoch (--runs 2, 1 captured)",
  );
  assert.equal(through(1), "2g needs --runs 2 or more (this arm ran 1)");
});

test("V10 (A2-1): 2g is judged on AFTER only, and never on the lake-only cell", () => {
  const images = { webgl: [flat(), moved(500)], webgpu: [flat(), flat()] };
  assert.equal(
    verdictsWhere(
      judge2g("coast-50km", images, { arm: "before" }).verdicts,
      "coast-50km",
      ":2g-",
    ).length,
    0,
  );
  const lakeonly = judge2g("great-lakes-lakeonly", images);
  assert.equal(
    verdictsWhere(lakeonly.verdicts, "great-lakes-lakeonly", ":2g-").length,
    0,
  );
  assert.equal(
    lakeonly.summary["great-lakes-lakeonly"].waveEpochRepeat,
    undefined,
  );
});

// 2e on a page whose gate was never read (A2-3).

test("V12 (A2-3): a fault-free page whose gate was never read is 2e NOT RUN, 'gate not read (page refused)', the refusal carried, on either renderer", () => {
  const store = makeStore();
  const refusalRecordOf = {
    reason: "demo-renderer-gate",
    message: "stub",
    details: { demoId: WATER_DEMO_ID },
  };
  const records = ["webgl", "webgpu"].map((renderer) => ({
    run: 0,
    cell: "1f",
    kind: "sandcastle2-demo",
    variant: "demo",
    rig: "sandcastle2-globe-materials-water-mask",
    renderer,
    notRun: "demo-renderer-gate: stub",
    refusal: refusalRecordOf,
    gate: {
      deviceLost: null,
      errorCount: 0,
      errors: [],
      armedDevices: 0,
      pageErrors: [],
      pageErrorCount: 0,
      notRead: "page refused",
    },
  }));
  const summary = summarizeWaterRecords(records, {
    loadImage: store.loadImage,
  });
  const verdicts = waterVerdicts(records, summary, null, { arm: "before" });
  for (const rec of records) {
    const fault = verdicts.find(
      (v) => v.id === `1f:demo:${rec.renderer}:run0:2e-no-device-fault`,
    );
    assert.equal(fault.pass, false, rec.renderer);
    assert.equal(fault.notRun, true);
    assert.equal(fault.reason, "gate not read (page refused)");
    assert.deepEqual(fault.refusal, refusalRecordOf);
  }
  // A page error is measured even when the gate was not: a fault, not NOT RUN.
  const faulty = {
    ...records[1],
    gate: { ...records[1].gate, pageErrors: ["x"], pageErrorCount: 1 },
  };
  const fault = waterVerdicts([faulty], summary, null, {
    arm: "before",
  }).find((v) => v.id.endsWith(":2e-no-device-fault"));
  assert.equal(fault.pass, false);
  assert.equal(fault.notRun, undefined);
});

// ---------------------------------------------------------------------------
// D: the descriptor's refusals
// ---------------------------------------------------------------------------

const refusal = (reason) => (error) => {
  assert.ok(
    error instanceof ProbeRefusal,
    `expected a ProbeRefusal, got ${error}`,
  );
  assert.equal(error.reason, reason);
  return true;
};

function cellsArgs(overrides = {}) {
  return {
    browser: null,
    run: 0,
    options: {
      arm: "before",
      cells: "coast-50km",
      renderers: ["webgl"],
      ...overrides.options,
    },
    origin: "http://localhost:8080",
    outputDirectory: overrides.outputDirectory ?? path.join(TEMP_ROOT, "d-out"),
    captures: [],
  };
}

test("D1: an undeclared or unknown arm refuses arm-undeclared", async () => {
  for (const arm of ["", undefined, "both", "BEFORE"]) {
    await assert.rejects(
      descriptor.cells(cellsArgs({ options: { arm } })),
      refusal("arm-undeclared"),
      `arm ${JSON.stringify(arm)}`,
    );
  }
});

test("D1: --base-report with --arm before refuses base-report-on-before-arm", async () => {
  await assert.rejects(
    descriptor.cells(
      cellsArgs({
        options: { arm: "before", baseReport: path.join(TEMP_ROOT, "x.json") },
      }),
    ),
    refusal("base-report-on-before-arm"),
  );
});

test("D1: a base report in the run's own output directory refuses base-report-same-output", async () => {
  const dir = path.join(TEMP_ROOT, "same-out");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "water-cells-report.json");
  fs.writeFileSync(file, JSON.stringify({ arm: "before", summary: {} }));
  await assert.rejects(
    descriptor.cells(
      cellsArgs({
        options: { arm: "after", baseReport: file },
        outputDirectory: dir,
      }),
    ),
    refusal("base-report-same-output"),
  );
});

test("D1: a base report that is not a BEFORE water-cells report refuses base-report-invalid", async () => {
  const dir = path.join(TEMP_ROOT, "invalid");
  fs.mkdirSync(dir, { recursive: true });
  const bodies = {
    "after-arm.json": { arm: "after", summary: {} },
    "no-summary.json": { arm: "before" },
    "array.json": [],
    "null.json": null,
  };
  for (const [name, body] of Object.entries(bodies)) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify(body));
    await assert.rejects(
      descriptor.cells(
        cellsArgs({
          options: { arm: "after", baseReport: file },
          outputDirectory: path.join(TEMP_ROOT, "invalid-out"),
        }),
      ),
      refusal("base-report-invalid"),
      name,
    );
  }
});

test("D1: a base report that cannot be read refuses base-report-unreadable", async () => {
  const dir = path.join(TEMP_ROOT, "unreadable");
  fs.mkdirSync(dir, { recursive: true });
  const broken = path.join(dir, "broken.json");
  fs.writeFileSync(broken, "{not json");
  for (const file of [path.join(dir, "missing.json"), broken]) {
    await assert.rejects(
      descriptor.cells(
        cellsArgs({
          options: { arm: "after", baseReport: file },
          outputDirectory: path.join(TEMP_ROOT, "unreadable-out"),
        }),
      ),
      refusal("base-report-unreadable"),
      file,
    );
  }
});

// ---------------------------------------------------------------------------
// N: pages on a stub browser
// ---------------------------------------------------------------------------

/** A stub page's event listeners, so a spec can deliver a `pageerror`. */
function makeListeners() {
  const listeners = new Map();
  return {
    on(event, fn) {
      if (!listeners.has(event)) {
        listeners.set(event, new Set());
      }
      listeners.get(event).add(fn);
    },
    off(event, fn) {
      listeners.get(event)?.delete(fn);
    },
    emit(event, payload) {
      for (const fn of [...(listeners.get(event) ?? [])]) {
        fn(payload);
      }
    },
  };
}

const STUB_PNG = Buffer.from(encodeRgbaPng(new Uint8Array(8 * 8 * 4), 8, 8));

function stubLocator() {
  return {
    async count() {
      return 1;
    },
    nth: () => ({
      async screenshot() {
        return STUB_PNG;
      },
    }),
    async screenshot() {
      return STUB_PNG;
    },
  };
}

/**
 * A stub browser for leg-2 pages. The page learns its renderer from the URL
 * and its rig from the stage call; the error gate counts a device only after
 * the page's arming call on a WebGPU page, so a page that never arms reads
 * `armedDevices: 0`. Each hook answers per rig (and renderer for `gate`):
 * `notApplied`, `settle` (an override of the settle's answer), `leftovers`
 * (what the chrome strip left), `gate` ({errors, deviceLost}) and `pageError`
 * (a message delivered as a `pageerror` when the rig is staged).
 */
function makeFakeBrowser(
  log,
  {
    notApplied = () => [],
    settle = () => null,
    leftovers = () => [],
    gate = () => null,
    pageError = () => null,
  } = {},
) {
  const makePage = () => {
    const events = makeListeners();
    const state = { renderer: null, rigId: null, armed: 0 };
    return {
      on: events.on,
      off: events.off,
      // The demo seam's opener delivers a page error on this page.
      emitForSpec: events.emit,
      async goto(url) {
        log.urls.push(String(url));
        state.renderer = new URL(String(url)).searchParams.get("renderer");
      },
      async waitForFunction() {},
      async evaluate(fn, arg) {
        if (fn === stageLandingCellInPage) {
          state.rigId = arg.rigId;
          const message = pageError(arg.rigId);
          if (message) {
            events.emit("pageerror", new Error(message));
          }
          return {
            rigId: arg.rigId,
            dials: {},
            notApplied: notApplied(arg.rigId),
          };
        }
        if (typeof fn === "string") {
          return { removed: 0, leftovers: leftovers(state.rigId) };
        }
        const src = String(fn);
        if (src.includes("_globalWaterMaskLoadPending")) {
          return (
            settle(state.rigId, arg) ?? {
              tilesSettled: true,
              tileFrames: 40,
              frames: arg.frames,
              tilesLoaded: true,
              datasetPending: false,
              elapsedMs: 5,
            }
          );
        }
        if (src.includes("__captureLiveness")) {
          return { gateArmed: true, deviceLost: null, frameNumber: 7 };
        }
        if (src.includes("__armWebGPUDevice")) {
          const armed = state.renderer === "webgpu" ? 1 : 0;
          state.armed += armed;
          return { armed, found: armed, total: state.armed };
        }
        if (src.includes("__webgpuGate")) {
          const answer = gate(state.rigId, state.renderer) ?? {};
          return {
            errors: answer.errors ?? [],
            deviceLost: answer.deviceLost ?? null,
            armedDevices: state.armed,
          };
        }
        throw new Error(`unstubbed evaluate: ${src.slice(0, 120)}`);
      },
      locator: stubLocator,
    };
  };
  return {
    async newContext() {
      log.contexts += 1;
      return {
        async addInitScript() {},
        async newPage() {
          return makePage();
        },
        async close() {},
      };
    },
  };
}

async function runPages({ arm, cells, notApplied, noIon, outName }) {
  const log = { urls: [], contexts: 0 };
  const outputDirectory = path.join(TEMP_ROOT, outName);
  const records = await descriptor.cells({
    browser: makeFakeBrowser(log, { notApplied }),
    run: 0,
    options: { arm, cells, renderers: ["webgl"], noIon },
    origin: "http://localhost:8080",
    outputDirectory,
    captures: [],
  });
  return { records, log };
}

const byVariant = (records, variant) =>
  records.find((r) => r.variant === variant);

test("N1: under --arm after, an ON page whose true water dial did not apply is NOT RUN; its OFF twin still captures", async () => {
  const { records } = await runPages({
    arm: "after",
    cells: "coast-50km",
    outName: "n1",
    notApplied: (rigId) =>
      rigId === "water-coast-50km" ? ["globalWaterMask"] : [],
  });
  const on = byVariant(records, "on");
  const off = byVariant(records, "off");
  assert.equal(typeof on.notRun, "string");
  assert.ok(on.notRun.includes("globalWaterMask"), on.notRun);
  assert.ok(!on.capture, "a NOT RUN page captures nothing");
  assert.equal(off.notRun, null);
  assert.ok(off.capture);
});

test("N1: under --arm before the same ON page still captures", async () => {
  const { records } = await runPages({
    arm: "before",
    cells: "coast-50km",
    outName: "n1b",
    notApplied: (rigId) =>
      rigId === "water-coast-50km" ? ["globalWaterMask"] : [],
  });
  const on = byVariant(records, "on");
  assert.equal(on.notRun, null);
  assert.ok(on.capture);
  const summary = summarizeWaterRecords(records)["coast-50km"];
  assert.deepEqual(summary.waterDialsAbsent, ["globalWaterMask"]);
});

test("N1: a non-water dial that did not apply blocks the page under either arm", async () => {
  for (const arm of ["before", "after"]) {
    const { records } = await runPages({
      arm,
      cells: "coast-50km",
      outName: `n1c-${arm}`,
      notApplied: () => ["terrain"],
    });
    for (const rec of records) {
      assert.equal(typeof rec.notRun, "string", `${arm} ${rec.variant}`);
      assert.ok(rec.notRun.includes("terrain"), rec.notRun);
      assert.ok(!rec.capture);
    }
  }
});

test("N1: a water dial the rig set to false that did not apply neither blocks nor stops a capture, even under --arm after", async () => {
  const { records } = await runPages({
    arm: "after",
    cells: "coast-50km",
    outName: "n1d",
    notApplied: (rigId) =>
      rigId === "water-coast-50km-off"
        ? ["globalWaterMask", "enableEnhancedOcean"]
        : [],
  });
  const off = byVariant(records, "off");
  assert.equal(off.notRun, null);
  assert.ok(off.capture);
});

test("N1: a clean page opens the rig's page on the requested renderer and captures it", async () => {
  const { records, log } = await runPages({
    arm: "after",
    cells: "orbit-disc",
    outName: "n1e",
  });
  assert.equal(records.length, 2);
  assert.ok(records.every((r) => r.notRun === null && r.capture));
  assert.equal(log.urls.length, 2);
  assert.ok(
    log.urls.every((u) => u.includes("renderer=webgl")),
    log.urls.join("\n"),
  );
  assert.ok(fs.existsSync(records[0].capture.path));
});

test("N2: cell 1f with ion declared unavailable (--no-ion) is NOT RUN: ion on every renderer, opens no page and captures nothing", async () => {
  const log = { urls: [], contexts: 0 };
  const records = await descriptor.cells({
    browser: makeFakeBrowser(log),
    run: 0,
    options: {
      arm: "before",
      cells: "1f",
      renderers: ["webgl", "webgpu"],
      noIon: true,
    },
    origin: "http://localhost:8080",
    outputDirectory: path.join(TEMP_ROOT, "n2"),
    captures: [],
  });
  assert.equal(records.length, 2);
  for (const rec of records) {
    assert.equal(rec.notRun, "NOT_RUN: ion");
    assert.ok(!rec.capture);
    assert.equal(rec.demo.status, "NOT_RUN");
    assert.equal(
      rec.demo.record.demoId,
      "globe-materials-water-mask-elevation-map",
    );
    assert.equal(rec.demo.record.frames, 240);
    assert.equal(rec.demo.record.renderer, rec.renderer);
    assert.equal(rec.demo.record.origin, "http://localhost:8080");
  }
  assert.equal(log.urls.length, 0, "no page may be navigated");
  const summaryMap = summarizeWaterRecords(records);
  const summary = summaryMap["1f"];
  assert.equal(summary.notRun.length, 2);
  assert.equal(summary.repeatPct.webgl, null);
  const verdicts = waterVerdicts(records, summaryMap, null, { arm: "before" });
  assert.ok(
    verdicts
      .filter((v) => v.id.endsWith(":stage"))
      .every((v) => v.pass === false && v.notRun === true),
  );
});

// ---------------------------------------------------------------------------
// E: the stop rules end to end - stub pages through descriptor.cells, judged
// by waterVerdicts (Ravenhill pass 1, B1 to B3)
// ---------------------------------------------------------------------------

/**
 * The demo-capture seam for cell 1f: an opener that hands the real piece a
 * stub run frame. The frame reports the requested renderer (or
 * `contextRenderer`), counts a device in its error gate only after the
 * piece's arming call on WebGPU, answers the gate with `gateErrors` /
 * `deviceLost`, and the settle with `settle` when given. `pageError` is
 * delivered on the top page while the demo opens; `originBreach` makes the
 * opener throw the origin guard's own refusal.
 */
function makeDemoDependencies(log, scenario = {}) {
  return {
    async open(page, urlOptions) {
      log.opened.push(urlOptions);
      if (scenario.originBreach) {
        throw new OriginRewriteRefusal(
          "ORIGIN_MISMATCH",
          "the run frame settled on another origin",
        );
      }
      if (scenario.pageError) {
        page.emitForSpec("pageerror", new Error(scenario.pageError));
      }
      const state = { armed: 0 };
      const rendererType = scenario.contextRenderer ?? urlOptions.renderer;
      const frame = {
        async waitForFunction() {},
        async evaluate(fn, arg) {
          if (fn === readRendererStateInPage) {
            return {
              contexts: [{ id: "ctx-stub", rendererType }],
              frameNumbers: [900],
              note: "",
            };
          }
          if (typeof fn === "string") {
            return undefined;
          }
          if (arg && arg.timeoutMs !== undefined) {
            return {
              tokenPresent: true,
              terrainResolved: true,
              terrainProvider: "CesiumTerrainProvider",
              hasWaterMask: true,
              waitedMs: 5,
            };
          }
          if (arg && arg.iso !== undefined) {
            return scenario.clockAnswer ?? { applied: true, observed: arg.iso };
          }
          if (arg && arg.frames !== undefined) {
            return (
              scenario.settle ?? {
                outcome: "done",
                frames: arg.frames,
                settledFrames: arg.frames,
                frameNumber: 900,
                tilesLoaded: true,
              }
            );
          }
          const src = String(fn);
          if (src.includes("__captureLiveness")) {
            return { gateArmed: true, deviceLost: null, frameNumber: 901 };
          }
          if (src.includes("__armWebGPUDevice")) {
            const armed = rendererType === "webgpu" ? 1 : 0;
            state.armed += armed;
            return { found: armed, armed, gateInstalled: true };
          }
          if (src.includes("__webgpuGate")) {
            return {
              errors: scenario.gateErrors ?? [],
              deviceLost: scenario.deviceLost ?? null,
              armedDevices: state.armed,
            };
          }
          throw new Error(`unstubbed frame evaluate: ${src.slice(0, 120)}`);
        },
        locator: stubLocator,
      };
      return {
        url: "http://localhost:8080/stub",
        finalUrl: "http://localhost:8080/stub",
        bucketFrame: frame,
        bucketFinalUrl: "http://localhost:8081/stub",
        assertNoOriginBreach() {},
      };
    },
  };
}

/**
 * Run `descriptor.cells` on the stub browser (and, for 1f, the stub run
 * frame), then summarise and judge the records as the runtime would.
 */
async function runE({
  outName,
  cells,
  renderers = ["webgpu"],
  arm = "before",
  hooks = {},
  demo = {},
}) {
  const log = { urls: [], contexts: 0, opened: [] };
  const records = await descriptor.cells({
    browser: makeFakeBrowser(log, hooks),
    run: 0,
    options: { arm, cells, renderers },
    origin: "http://localhost:8080",
    outputDirectory: path.join(TEMP_ROOT, outName),
    captures: [],
    demoCaptureDependencies: makeDemoDependencies(log, demo),
  });
  const verdicts = waterVerdicts(
    records,
    summarizeWaterRecords(records),
    null,
    {
      arm,
    },
  );
  return { records, verdicts, log };
}

const pageVerdict = (verdicts, rec, suffix) =>
  verdicts.find(
    (v) =>
      v.id ===
      `${rec.cell}:${rec.variant}:${rec.renderer}:run${rec.run}:${suffix}`,
  );

test("E1: a leg-2 page whose settle answers tilesSettled false is NOT RUN, captures nothing and fails :stage", async () => {
  const { records, verdicts } = await runE({
    outName: "e1-unsettled",
    cells: "orbit-disc",
    hooks: {
      settle: (rigId, arg) =>
        rigId === "water-orbit-disc"
          ? {
              tilesSettled: false,
              tileFrames: 6000,
              frames: arg.frames,
              tilesLoaded: false,
              datasetPending: false,
              elapsedMs: 180000,
            }
          : null,
    },
  });
  const on = byVariant(records, "on");
  const off = byVariant(records, "off");
  assert.ok(on.notRun?.includes("did not settle"), String(on.notRun));
  assert.ok(!on.capture, "an unsettled page captures nothing");
  const stage = pageVerdict(verdicts, on, "stage");
  assert.equal(stage.pass, false);
  assert.equal(stage.notRun, true);
  assert.equal(off.notRun, null);
  assert.ok(off.capture, "the settled twin still captures");
});

test("E1: a leg-2 page that settled its tiles but drew fewer than readiness.frames is NOT RUN", async () => {
  const { records, verdicts } = await runE({
    outName: "e1-short",
    cells: "coast-50km",
    hooks: {
      settle: (rigId, arg) =>
        rigId === "water-coast-50km"
          ? {
              tilesSettled: true,
              tileFrames: 40,
              frames: arg.frames - 1,
              tilesLoaded: true,
              datasetPending: false,
              elapsedMs: 180000,
            }
          : null,
    },
  });
  const on = byVariant(records, "on");
  assert.ok(on.notRun?.includes("did not settle"), String(on.notRun));
  assert.ok(!on.capture);
  assert.equal(pageVerdict(verdicts, on, "stage").pass, false);
});

const LEG2_FAULTS = [
  [
    "an uncaptured GPU error",
    { gate: () => ({ errors: ["[webgpu] uncaptured GPU error: E-STUB"] }) },
    (fault) =>
      assert.deepEqual(fault.gate.errors, [
        "[webgpu] uncaptured GPU error: E-STUB",
      ]),
  ],
  [
    "a lost device",
    { gate: () => ({ deviceLost: "[webgpu] device lost: reason=unknown" }) },
    (fault) =>
      assert.equal(
        fault.gate.deviceLost,
        "[webgpu] device lost: reason=unknown",
      ),
  ],
  [
    "a page error",
    { pageError: () => "E-STUB page exception" },
    (fault) => {
      assert.equal(fault.gate.pageErrorCount, 1);
      assert.ok(fault.gate.pageErrors[0].includes("E-STUB page exception"));
    },
  ],
];

test("E2: a clean WebGPU leg-2 page arms its device and passes 2e on what the gate read", async () => {
  const { records, verdicts } = await runE({
    outName: "e2-clean",
    cells: "orbit-disc",
  });
  assert.equal(records.length, 2);
  for (const rec of records) {
    assert.ok(rec.capture);
    assert.equal(
      rec.gate.armedDevices,
      1,
      "the page's arming reached the gate",
    );
    const fault = pageVerdict(verdicts, rec, "2e-no-device-fault");
    assert.equal(fault.pass, true, rec.variant);
    assert.equal(fault.notRun, undefined);
  }
});

for (const [label, hooks, check] of LEG2_FAULTS) {
  test(`E2: ${label} on a WebGPU leg-2 page fails 2e through descriptor.cells`, async () => {
    const { records, verdicts } = await runE({
      outName: `e2-${label.replaceAll(" ", "-")}`,
      cells: "orbit-disc",
      hooks,
    });
    for (const rec of records) {
      const fault = pageVerdict(verdicts, rec, "2e-no-device-fault");
      assert.equal(fault.pass, false, `${label} ${rec.variant}`);
      assert.equal(fault.notRun, undefined, "a fault is measured, not NOT RUN");
      check(fault);
    }
  });
}

test("E2: a WebGL leg-2 page passes 2e with no armed device, and still fails on a page error", async () => {
  const clean = await runE({
    outName: "e2-webgl-clean",
    cells: "orbit-disc",
    renderers: ["webgl"],
  });
  for (const rec of clean.records) {
    assert.equal(rec.gate.armedDevices, 0);
    assert.equal(
      pageVerdict(clean.verdicts, rec, "2e-no-device-fault").pass,
      true,
    );
  }
  const faulty = await runE({
    outName: "e2-webgl-pageerror",
    cells: "orbit-disc",
    renderers: ["webgl"],
    hooks: { pageError: () => "E-STUB webgl exception" },
  });
  for (const rec of faulty.records) {
    assert.equal(
      pageVerdict(faulty.verdicts, rec, "2e-no-device-fault").pass,
      false,
    );
  }
});

test("E3: a clean 1f page on WebGPU is captured through the piece, its run-frame gate armed, and passes 2e", async () => {
  const { records, verdicts, log } = await runE({
    outName: "e3-clean",
    cells: "1f",
  });
  assert.equal(records.length, 1);
  const [rec] = records;
  assert.equal(rec.notRun, null);
  assert.ok(rec.capture && fs.existsSync(rec.capture.path));
  assert.equal(log.opened[0].id, WATER_DEMO_ID);
  assert.equal(rec.gate.armedDevices, 1, "the piece's arming reached the gate");
  const fault = pageVerdict(verdicts, rec, "2e-no-device-fault");
  assert.equal(fault.pass, true);
});

const DEMO_FAULTS = [
  [
    "an uncaptured GPU error in the run frame",
    { gateErrors: ["[webgpu] uncaptured GPU error: D-STUB"] },
    (fault) =>
      assert.deepEqual(fault.gate.errors, [
        "[webgpu] uncaptured GPU error: D-STUB",
      ]),
  ],
  [
    "a lost device in the run frame",
    { deviceLost: "[webgpu] device lost: reason=unknown D-STUB" },
    (fault) =>
      assert.equal(
        fault.gate.deviceLost,
        "[webgpu] device lost: reason=unknown D-STUB",
      ),
  ],
  [
    "a page error while the demo opens",
    { pageError: "D-STUB demo exception" },
    (fault) => {
      assert.equal(fault.gate.pageErrorCount, 1);
      assert.ok(fault.gate.pageErrors[0].includes("D-STUB demo exception"));
    },
  ],
];

for (const [label, demo, check] of DEMO_FAULTS) {
  test(`E3: ${label} fails 1f's 2e through descriptor.cells`, async () => {
    const { records, verdicts } = await runE({
      outName: `e3-${label.replaceAll(" ", "-")}`,
      cells: "1f",
      demo,
    });
    const [rec] = records;
    assert.ok(rec.capture, "the fault does not stop the capture");
    const fault = pageVerdict(verdicts, rec, "2e-no-device-fault");
    assert.equal(fault.pass, false, label);
    assert.equal(fault.notRun, undefined, "a fault is measured, not NOT RUN");
    check(fault);
  });
}

const DEMO_REFUSALS = [
  ["demo-renderer-gate", { contextRenderer: "webgl" }],
  [
    "demo-not-settled",
    {
      settle: {
        outcome: "frame-cap",
        frames: 12000,
        settledFrames: 3,
        frameNumber: 12000,
        tilesLoaded: false,
      },
    },
  ],
];

for (const [reason, demo] of DEMO_REFUSALS) {
  test(`E4: a 1f refusal (${reason}) is a cell-level NOT RUN with its reason; the arm's leg-2 pages keep their records`, async () => {
    const { records, verdicts } = await runE({
      outName: `e4-${reason}`,
      cells: "orbit-disc,1f",
      demo,
    });
    assert.equal(records.length, 3, "two leg-2 pages and the 1f page");
    const leg2 = records.filter((r) => r.cell === "orbit-disc");
    assert.ok(leg2.every((r) => r.notRun === null && r.capture));
    const demoRecord = records.find((r) => r.cell === "1f");
    assert.ok(
      demoRecord.notRun.startsWith(`${reason}: `),
      String(demoRecord.notRun),
    );
    assert.equal(demoRecord.refusal.reason, reason);
    assert.equal(typeof demoRecord.refusal.message, "string");
    assert.ok(demoRecord.refusal.details, "the refusal's details are kept");
    assert.ok(!demoRecord.capture);
    const stage = pageVerdict(verdicts, demoRecord, "stage");
    assert.equal(stage.pass, false);
    assert.equal(stage.notRun, true);
    const fault = pageVerdict(verdicts, demoRecord, "2e-no-device-fault");
    if (reason === "demo-not-settled") {
      // A2-3: the piece read the gate before refusing; 2e is judged on it.
      assert.ok(
        demoRecord.refusal.details.gate,
        "the refusal carries the gate",
      );
      assert.equal(demoRecord.gate.armedDevices, 1);
      assert.equal(demoRecord.gate.notRead, undefined);
      assert.equal(fault.pass, true, "a clean gate read before the refusal");
      assert.equal(fault.notRun, undefined);
    } else {
      // A2-3: the gate was never read - NOT RUN with that reason, the
      // refusal carried, never "error gate not armed".
      assert.equal(fault.pass, false);
      assert.equal(fault.notRun, true, "an unread gate is no measurement");
      assert.equal(fault.reason, "gate not read (page refused)");
      assert.equal(fault.refusal.reason, reason);
    }
    const receipt = descriptor.receipt(records, {
      options: { arm: "before", cells: "orbit-disc,1f" },
    });
    assert.equal(receipt.pages.length, 3);
    assert.equal(receipt.summary["orbit-disc"].captures.length, 2);
    assert.equal(receipt.summary["1f"].notRun.length, 1);
  });
}

test("E4: an origin breach is not a cell-level refusal: it still ends the arm", async () => {
  await assert.rejects(
    runE({
      outName: "e4-breach",
      cells: "orbit-disc,1f",
      demo: { originBreach: true },
    }),
    (error) => error instanceof OriginRewriteRefusal,
  );
});

test("E5: chrome the strip could not remove makes the page NOT RUN (capture-chrome-over-canvas), not a voided arm", async () => {
  const { records, verdicts } = await runE({
    outName: "e5-chrome",
    cells: "orbit-disc",
    hooks: {
      leftovers: (rigId) =>
        rigId === "water-orbit-disc" ? [".cesium-viewer-toolbar"] : [],
    },
  });
  const on = byVariant(records, "on");
  const off = byVariant(records, "off");
  assert.ok(
    on.notRun?.startsWith("capture-chrome-over-canvas: "),
    String(on.notRun),
  );
  assert.equal(on.refusal.reason, "capture-chrome-over-canvas");
  assert.deepEqual(on.refusal.details.widgets.leftovers, [
    ".cesium-viewer-toolbar",
  ]);
  assert.ok(!on.capture, "chrome over the canvas is never captured");
  assert.equal(pageVerdict(verdicts, on, "stage").pass, false);
  assert.equal(off.notRun, null);
  assert.ok(off.capture);
});

const SANDCASTLE2_FILES = [
  "Apps/Sandcastle2/standalone.html",
  "Apps/Sandcastle2/templates/bucket.html",
  "Apps/Sandcastle2/templates/Sandcastle.js",
  `Apps/Sandcastle2/gallery/${WATER_DEMO_ID}/index.html`,
  `Apps/Sandcastle2/gallery/${WATER_DEMO_ID}/main.js`,
];
const ENGINE_FILES = [
  "Build/CesiumUnminified/Cesium.js",
  "Build/CesiumUnminified/index.js",
  "packages/engine/Build/Unminified/index.js",
];

/** @param {object} subject A water descriptor (real or mutated). */
function assertDemandsSandcastle2WhenOneFIsRequested(subject) {
  assert.equal(typeof subject.servedArtifacts, "function");
  for (const options of [
    { cells: "1f" },
    { cells: "coast-50km, 1f" },
    { cells: Object.keys(WATER_CELLS).join(",") },
    {},
  ]) {
    const served = subject.servedArtifacts(options);
    for (const file of [...ENGINE_FILES, ...SANDCASTLE2_FILES]) {
      assert.ok(served.includes(file), `${JSON.stringify(options)}: ${file}`);
    }
  }
}

/** @param {object} subject A water descriptor (real or mutated). */
function assertDemandsNoSandcastle2WithoutOneF(subject) {
  for (const cells of [
    "coast-50km",
    "great-lakes,orbit-disc",
    "great-lakes-lakeonly",
  ]) {
    assert.deepEqual(subject.servedArtifacts({ cells }), ENGINE_FILES, cells);
  }
}

test("E6: descriptor.servedArtifacts names the Sandcastle 2 files cell 1f loads when 1f is requested, and by default", () => {
  // The default --cells is every WATER_CELLS key, 1f among them.
  assert.ok(Object.keys(WATER_CELLS).includes("1f"));
  assertDemandsSandcastle2WhenOneFIsRequested(descriptor);
  assert.equal(
    rigOf(WATER_CELLS["1f"].rig).dials.galleryId,
    WATER_DEMO_ID,
    "the asserted demo is the one the 1f rig opens",
  );
});

test("E6b: a run without cell 1f does not demand any Sandcastle 2 artifact", () => {
  assertDemandsNoSandcastle2WithoutOneF(descriptor);
});

test("E6c (MUTANT): a descriptor that always demands the Sandcastle 2 files, or never does, is caught", async () => {
  const waterPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "probe-water-cells.mjs",
  );
  const anchor = 'return names.includes("1f")';
  const always = await importMutated(waterPath, [
    [anchor, 'return (true || names.includes("1f"))'],
  ]);
  assert.throws(() => assertDemandsNoSandcastle2WithoutOneF(always.descriptor));
  const never = await importMutated(waterPath, [
    [anchor, 'return (false && names.includes("1f"))'],
  ]);
  assert.throws(() =>
    assertDemandsSandcastle2WhenOneFIsRequested(never.descriptor),
  );
});

// ---------------------------------------------------------------------------
// E (round 2): the gate behind a refused 1f page (A2-3) and the wave epoch
// end to end (A2-1), through descriptor.cells on the stub browser
// ---------------------------------------------------------------------------

test("E7 (A2-3): a 1f page whose settle stopped short on a lost device FAILS 2e on the gate the piece read before refusing", async () => {
  const { records, verdicts } = await runE({
    outName: "e7-lost-mid-settle",
    cells: "1f",
    demo: {
      deviceLost: "[webgpu] device lost: reason=unknown E7-STUB",
      settle: {
        outcome: "deadline",
        frames: 40,
        settledFrames: 12,
        frameNumber: 940,
        tilesLoaded: false,
      },
    },
  });
  const [rec] = records;
  assert.ok(rec.notRun.startsWith("demo-not-settled: "), rec.notRun);
  assert.equal(
    rec.refusal.details.gate.deviceLost,
    "[webgpu] device lost: reason=unknown E7-STUB",
  );
  const fault = pageVerdict(verdicts, rec, "2e-no-device-fault");
  assert.equal(fault.pass, false);
  assert.equal(fault.notRun, undefined, "the loss is measured, not NOT RUN");
  assert.equal(
    fault.gate.deviceLost,
    "[webgpu] device lost: reason=unknown E7-STUB",
  );
});

test("E7 (A2-3): a 1f clock the piece could not pin carries the gate it read, and 2e is judged on it", async () => {
  const { records, verdicts } = await runE({
    outName: "e7-clock",
    cells: "1f",
    demo: {
      clockAnswer: { applied: false, reason: "stub: no clock" },
      gateErrors: ["[webgpu] uncaptured GPU error: E7-CLOCK"],
    },
  });
  const [rec] = records;
  assert.ok(rec.notRun.startsWith("demo-clock-not-pinned: "), rec.notRun);
  assert.deepEqual(rec.refusal.details.gate.errors, [
    "[webgpu] uncaptured GPU error: E7-CLOCK",
  ]);
  const fault = pageVerdict(verdicts, rec, "2e-no-device-fault");
  assert.equal(fault.pass, false);
  assert.equal(fault.notRun, undefined);
  assert.deepEqual(fault.gate.errors, [
    "[webgpu] uncaptured GPU error: E7-CLOCK",
  ]);
});

test("E7 (A2-3): a 1f page NOT RUN for ion reports 2e as 'gate not read', never 'error gate not armed'", async () => {
  const log = { urls: [], contexts: 0, opened: [] };
  const records = await descriptor.cells({
    browser: makeFakeBrowser(log),
    run: 0,
    options: { arm: "before", cells: "1f", renderers: ["webgpu"], noIon: true },
    origin: "http://localhost:8080",
    outputDirectory: path.join(TEMP_ROOT, "e7-ion"),
    captures: [],
  });
  const verdicts = waterVerdicts(
    records,
    summarizeWaterRecords(records),
    null,
    {
      arm: "before",
    },
  );
  const fault = pageVerdict(verdicts, records[0], "2e-no-device-fault");
  assert.equal(fault.notRun, true);
  assert.equal(fault.reason, "gate not read (page NOT_RUN: ion)");
});

test("E8 (A2-1): on this tree's stage the epoch blocks no page, reads back applied false, and 2g is NOT RUN per renderer while the other bands still run", async () => {
  const log = { urls: [], contexts: 0, opened: [] };
  const records = [];
  for (const run of [0, 1]) {
    records.push(
      ...(await descriptor.cells({
        browser: makeFakeBrowser(log),
        run,
        options: {
          arm: "after",
          cells: "coast-50km",
          renderers: ["webgl", "webgpu"],
        },
        origin: "http://localhost:8080",
        outputDirectory: path.join(TEMP_ROOT, `e8-run${run}`),
        captures: [],
      })),
    );
  }
  assert.equal(records.length, 8);
  for (const rec of records) {
    assert.equal(rec.notRun, null, `${rec.variant} ${rec.renderer}`);
    assert.ok(rec.capture);
    // The stub stage answers no epoch readback; the stage at this tree has no
    // handler for the dial at all. Either way the page reads applied false.
    assert.equal(rec.waveEpoch.requested, CLOCK);
    assert.equal(rec.waveEpoch.applied, false);
    assert.ok(
      /no waterSimulationEpoch (handler|readback)/.test(rec.waveEpoch.reason),
      rec.waveEpoch.reason,
    );
  }
  const verdicts = waterVerdicts(
    records,
    summarizeWaterRecords(records),
    null,
    {
      arm: "after",
    },
  );
  for (const renderer of ["webgl", "webgpu"]) {
    const g = verdicts.find(
      (v) => v.id === `coast-50km:2g-wave-epoch-repeat:${renderer}`,
    );
    assert.ok(g, `2g on ${renderer}`);
    assert.equal(g.pass, false);
    assert.equal(g.notRun, true);
    assert.ok(g.reason.startsWith("waterSimulationEpoch applied: false"));
    assert.equal(g.rig, "water-coast-50km");
    assert.equal(g.repeatPct, 0, "the repeat is still measured and recorded");
  }
  assert.ok(verdicts.some((v) => v.id === "coast-50km:2b-effect-agreement"));
});
