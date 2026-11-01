// probe-water-cells.spec.mjs - lane KT-2 (Nardol). Pure Node: no browser, no GPU.
//
// @purpose Drives the real rigs and asserts the water cells' rig contract: the eight new rigs say what the round-3 EDGE_LEG_WATER.md rows say, their OFF twins differ in the water flags alone, every leg-2 rig stages as the probe hands it over and pins the wave epoch to the sheet's instant, and the new rigs are counted under their tags.
// @status ACTIVE
//
// Written from _lane-out/BEHAVIOUR_ALDBURG.md and the round-3 EDGE_LEG_WATER.md
// (leg 2 table), not from the probe's source or the lead's rigs. Rig values
// are transcribed from the sheet's table here, so a rig that drifts from the
// sheet fails; image-based cases use 100x100 synthetic captures, where each
// changed pixel is 0.01 percent, with per-channel deltas chosen on either side
// of the tolerance (8 for the mask effect, 16 for parity and the demo repeat).
// The E section is written from the reviewer's pass-1 residuals (B1 to B3).
//
// SPLIT BY SUBJECT (row DX-KIT-WATER-CELLS-SPEC-OVERSIZE): the water-cells spec was one 2,904-line file. This
// file keeps the rig contract (R1-R7); the other subjects live in probe-water-cells-plan-stage, -summary, -bands,
// -demo-1f, -wave-epoch, -descriptor-pages, -e2e-cells and -e2e-served (.spec.mjs), which share
// fixtures/probe-water-cells-support.mjs. Test names and bodies are unchanged.

import assert from "node:assert/strict";
import test from "node:test";

import { landingStagePayload } from "./lib/landing-cell-stage.mjs";
import { replayKeyFor, validateRig } from "./lib/rig-registry.mjs";
import {
  WATER_CELLS,
  WAVE_EPOCH_DIAL,
  waterStagePlan,
} from "./probe-water-cells.mjs";
import { rigs, rigOf, CLOCK } from "./fixtures/probe-water-cells-support.mjs";

const WATER_FLAGS = [
  "globalWaterMask",
  "lakeWaterMask",
  "riverWaterMask",
  "enableEnhancedOcean",
];

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
