// landing-dive-gate-frames.spec.mjs - the ellipsoid dive cell's frames are marked gate-only on the receipt; the other four dive cells' frames stay comparable.
// @purpose Pins that the rig dive-gate-ellipsoid-sea-level declares `frames: "gate-only"` (no other dive-gate rig does), that the registry accepts only that value, that the declaration is documentary (the stage payload and the replay key do not move), that every `:dive-gate` verdict entry of E-DG-ellipsoid carries `frames: {comparable: false, reason: "not-comparable: gate-only cell"}` on a passing, a control, a NOT RUN and a step-less page alike while the E-DG-geiranger entries carry none, and that the gate fields (pass, expected, observed, clampHeld, clockHeld) are what they were without the mark.
// @status ACTIVE
//
// THE FINDING. The four E-DG-ellipsoid frames (dive and control, WebGL and WebGPU) are one byte-identical flat field: the open ocean under naturalEarth imagery
// has no texture or horizon at 7.9 m or at 1.0 m. No stage dial or imagery the kit declares draws a height-dependent reference on both renderers (the fragment
// debug modes are WebGPU-only), so the cell is gate-only: the gate verdict is its whole acceptance and the receipt says its frame compare was removed.
//
// NO BROWSER. The cases run the real `runDiveGateCellPage` over the shared fake world and the real probe over the landing fake browser; neither answers the gate.
// The mark is read on the verdict entry a reader of the report sees. The base-versus-tip `pixels` record and the Markdown summary are other files' (see the lane report).

import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { mkLaneTmp, removeLaneTmp } from "../lib/lane-tmp.mjs";
import { liveSamplerReads } from "./lib/cpu-warm-up.mjs";
import {
  STUB_CESIUM_MODULE_URL,
  makeDiveGateFakeWorld,
} from "./fixtures/dive-gate-fake-world.mjs";
import {
  landingRunners,
  withDiveGateAnswers,
} from "./fixtures/probe-landing-cells-support.mjs";
import {
  GATE_ONLY_FRAMES_REASON,
  diveGateVerdict,
  framesMarkOf,
  runDiveGateCellPage,
} from "./lib/globe-dive-gate-steps.mjs";
import { landingStagePayload } from "./lib/landing-cell-stage.mjs";
import { rigForPage } from "./lib/landing-cell-table.mjs";
import { loadRigs, replayKeyFor, validateRig } from "./lib/rig-registry.mjs";

const ELLIPSOID = "dive-gate-ellipsoid-sea-level";
const OTHER_DIVE_RIGS = [
  "dive-gate-death-valley",
  "dive-gate-geiranger-wall",
  "dive-gate-lake-ontario-mask",
  "dive-gate-upsampled-ocean",
];
const GATE_ONLY_MARK = Object.freeze({
  comparable: false,
  removed: "frame-compare",
  reason: "not-comparable: gate-only cell",
  declaredBy: `rig ${ELLIPSOID} frames: "gate-only"`,
});
const PINNED = { clock: { requested: "T", observed: "T", frozen: true } };

let TEMP_ROOT;
let SAMPLER_READS_AT_START;
before(() => {
  TEMP_ROOT = mkLaneTmp("landing-dive-gate-frames-");
  SAMPLER_READS_AT_START = liveSamplerReads();
});
after(() => {
  removeLaneTmp(TEMP_ROOT);
  assert.equal(
    liveSamplerReads(),
    SAMPLER_READS_AT_START,
    "this spec must not reach the live CPU sampler",
  );
});
const { p14Run } = landingRunners(() => TEMP_ROOT);

const rigsById = async () =>
  new Map((await loadRigs()).map((rig) => [rig.id, rig]));

/** A rig with the stub Cesium module behind its step data. */
function stubbed(rig) {
  return {
    ...rig,
    dials: {
      ...rig.dials,
      diveGateStep: {
        ...rig.dials.diveGateStep,
        moduleUrl: STUB_CESIUM_MODULE_URL,
      },
    },
  };
}

/** The page record of one page of a dive-gate cell over a fake world at `surface`. */
async function divePageRecord(rigId, cell, page, surface) {
  const rig = rigForPage((await rigsById()).get(rigId), { cell, page });
  const world = makeDiveGateFakeWorld({ surface });
  const { diveGate } = await runDiveGateCellPage({
    page: world.page,
    rig: stubbed(rig),
    settle: world.settle,
  });
  return { kind: "dive-gate", diveGate, stage: PINNED };
}

// ---------------------------------------------------------------------------
// The declaration
// ---------------------------------------------------------------------------

test("only the ellipsoid dive rig declares frames gate-only, and every dive rig validates", async () => {
  const rigs = await rigsById();
  assert.equal(rigs.get(ELLIPSOID).frames, "gate-only");
  for (const id of OTHER_DIVE_RIGS) {
    assert.equal(rigs.get(id).frames, undefined, `${id} declares no frames`);
  }
  for (const id of [ELLIPSOID, ...OTHER_DIVE_RIGS]) {
    assert.deepEqual(validateRig(rigs.get(id)), [], id);
  }
});

test("the registry accepts frames gate-only and refuses any other value", async () => {
  const rig = (await rigsById()).get(ELLIPSOID);
  for (const bad of ["comparable", "", true, null, "Gate-Only"]) {
    const failures = validateRig({ ...rig, frames: bad });
    assert.ok(
      failures.some((failure) => /frames must be "gate-only"/u.test(failure)),
      `frames ${JSON.stringify(bad)} must be refused, got ${JSON.stringify(failures)}`,
    );
  }
  assert.deepEqual(validateRig({ ...rig, frames: "gate-only" }), []);
});

test("the declaration is documentary: the stage payload and the replay key do not carry it", async () => {
  const rig = (await rigsById()).get(ELLIPSOID);
  const { frames: declared, ...without } = rig;
  assert.equal(declared, "gate-only");
  for (const page of ["dive", "control"]) {
    const staged = rigForPage(rig, { cell: "E-DG-ellipsoid", page });
    const stagedWithout = rigForPage(without, { cell: "E-DG-ellipsoid", page });
    const payload = landingStagePayload(staged);
    assert.deepEqual(payload, landingStagePayload(stagedWithout), page);
    // A dial that changes nothing on the page is not sent to it.
    assert.equal(JSON.stringify(payload).includes("gate-only"), false, page);
    // The dive-gate dials ride unchanged.
    assert.deepEqual(
      payload.stepDials.slice().sort(),
      ["diveCollisionDisabled", "diveGateExpected", "diveGateStep"],
      page,
    );
  }
  assert.equal(replayKeyFor(rig), replayKeyFor(without));
});

test("framesMarkOf marks a gate-only rig with what was removed and why, and nothing else", async () => {
  const rigs = await rigsById();
  assert.deepEqual(framesMarkOf(rigs.get(ELLIPSOID)), GATE_ONLY_MARK);
  assert.equal(GATE_ONLY_MARK.reason, GATE_ONLY_FRAMES_REASON);
  for (const id of OTHER_DIVE_RIGS) {
    assert.equal(framesMarkOf(rigs.get(id)), null, id);
  }
  assert.equal(framesMarkOf(undefined), null);
  assert.equal(framesMarkOf({ id: "x", frames: "something" }), null);
});

// ---------------------------------------------------------------------------
// The verdict entry
// ---------------------------------------------------------------------------

test("a passing ellipsoid dive page's :dive-gate entry carries the frames mark; the gate fields are what they were", async () => {
  const record = await divePageRecord(ELLIPSOID, "E-DG-ellipsoid", "dive", 0);
  const id = "E-DG-ellipsoid:webgl:dive:run0";
  const marked = diveGateVerdict(id, record);
  assert.deepEqual(marked.frames, GATE_ONLY_MARK);
  assert.equal(marked.id, `${id}:dive-gate`);
  assert.equal(marked.pass, true);
  assert.equal(marked.expected, "allow");
  assert.equal(marked.observed, "allow");
  assert.equal(marked.clockHeld, true);
  assert.equal(typeof marked.clampHeld, "boolean");

  // The same page record with the mark taken off: every other field is identical.
  const plain = diveGateVerdict(id, {
    ...record,
    diveGate: { ...record.diveGate, frames: null },
  });
  assert.equal(Object.hasOwn(plain, "frames"), false);
  const { frames, ...rest } = marked;
  assert.ok(frames);
  assert.deepEqual(rest, plain);
});

test("the control page of the ellipsoid cell is marked too, expected refuse", async () => {
  const record = await divePageRecord(
    ELLIPSOID,
    "E-DG-ellipsoid",
    "control",
    0,
  );
  const verdict = diveGateVerdict("E-DG-ellipsoid:webgpu:control:run0", record);
  assert.deepEqual(verdict.frames, GATE_ONLY_MARK);
  assert.equal(verdict.expected, "refuse");
  assert.equal(verdict.pass, true);
});

test("a NOT RUN ellipsoid page (height off the registered window) keeps the mark beside its reason", async () => {
  const record = await divePageRecord(
    ELLIPSOID,
    "E-DG-ellipsoid",
    "dive",
    -100,
  );
  const verdict = diveGateVerdict("E-DG-ellipsoid:webgl:dive:run0", record);
  assert.equal(verdict.notRun, true);
  assert.equal(verdict.pass, false);
  assert.match(verdict.reason, /^globe-height-off-window: /u);
  assert.deepEqual(verdict.frames, GATE_ONLY_MARK);
});

test("an ellipsoid page whose step data is missing still carries the mark", async () => {
  const rig = (await rigsById()).get(ELLIPSOID);
  const { diveGateStep: dropped, ...dials } = rig.dials;
  assert.ok(dropped);
  const { diveGate } = await runDiveGateCellPage({
    page: makeDiveGateFakeWorld({ surface: 0 }).page,
    rig: { ...rig, dials },
    settle: async () => {},
  });
  const verdict = diveGateVerdict("E-DG-ellipsoid:webgl:dive:run0", {
    kind: "dive-gate",
    diveGate,
  });
  assert.equal(verdict.notRun, true);
  assert.deepEqual(verdict.frames, GATE_ONLY_MARK);
});

test("a geiranger dive page's :dive-gate entry carries no frames mark", async () => {
  const record = await divePageRecord(
    "dive-gate-geiranger-wall",
    "E-DG-geiranger",
    "dive",
    43,
  );
  const verdict = diveGateVerdict("E-DG-geiranger:webgl:dive:run0", record);
  assert.equal(verdict.pass, true);
  assert.equal(Object.hasOwn(verdict, "frames"), false);
  assert.equal(record.diveGate.frames, null);
});

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

test("a probe run over E-DG-ellipsoid marks all four :dive-gate entries; E-DG-geiranger marks none", async () => {
  const ellipsoid = await p14Run(
    "frames-ellipsoid",
    ["--cells", "E-DG-ellipsoid"],
    {},
    undefined,
    (browser) => withDiveGateAnswers(browser, { globeHeight: 0 }),
  );
  assert.equal(ellipsoid.code, 0);
  const marked = ellipsoid.verdicts.filter((verdict) =>
    verdict.id.endsWith(":dive-gate"),
  );
  assert.equal(marked.length, 4);
  for (const verdict of marked) {
    assert.equal(verdict.pass, true, verdict.id);
    assert.deepEqual(verdict.frames, GATE_ONLY_MARK, verdict.id);
  }

  const geiranger = await p14Run(
    "frames-geiranger",
    ["--cells", "E-DG-geiranger"],
    {},
    undefined,
    (browser) => withDiveGateAnswers(browser, { globeHeight: 43 }),
  );
  assert.equal(geiranger.code, 0);
  const plain = geiranger.verdicts.filter((verdict) =>
    verdict.id.endsWith(":dive-gate"),
  );
  assert.equal(plain.length, 4);
  for (const verdict of plain) {
    assert.equal(Object.hasOwn(verdict, "frames"), false, verdict.id);
  }
});
