// landing-dive-gate-clock.spec.mjs - the five dive-gate rigs render a pinned daylight instant, not the wall clock at load.
// @purpose Pins that each dive-gate rig names the daylight instant 2026-06-21T18:00:00Z, that the stage payload carries it, that the real in-page stage applies it and reads it back (requested equal to observed, clock frozen) for the dive and control page variants, and that a rig with no clock, or a stage whose clock application is unreachable, is caught by the same assertions; and that the dive-gate verdict entry carries `clockHeld` from that staged clock (true pinned, false on the wall clock, null with no stage clock).
// @status ACTIVE
//
// THE FINDING. The Edge leg that first ran the dive-gate cells captured night frames: the five rigs carried `clock: null`, so the stage froze the wall clock
// at load. The weather-map and E-W rigs pin this same instant. A page record's `stage.clock` ({requested, observed, frozen}) is what a reader checks.
//
// THE FAKE. `fixtures/landing-cell-stage-support.mjs` fakes `JulianDate` as a string holder, so its ISO round trip returns the same text it was given; the
// real engine's `JulianDate.toIso8601(t, 0)` rounds to whole seconds, which an instant on a whole second survives. The fake starts the viewer's clock
// animating at another instant, so `frozen` and `observed` are answers the stage's own clock application produces, not the fake's.

import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  landingStagePayload,
  stageLandingCellInPage,
} from "./lib/landing-cell-stage.mjs";
import { rigForPage } from "./lib/landing-cell-table.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import { loadRigs, rigById } from "./lib/rig-registry.mjs";
import { LANDING_CELLS } from "./probe-landing-cells.mjs";
import {
  FAKE_CESIUM_URL,
  STAGE_MODULE,
  createFakeViewer,
} from "./fixtures/landing-cell-stage-support.mjs";

const PIN = "2026-06-21T18:00:00Z";
const FAKE_START = "2026-06-21T00:00:00Z";

const DIVE_CELLS = Object.entries(LANDING_CELLS).filter(
  ([, cell]) => cell.kind === "dive-gate",
);
const DIVE_RIG_IDS = [
  "dive-gate-death-valley",
  "dive-gate-ellipsoid-sea-level",
  "dive-gate-geiranger-wall",
  "dive-gate-lake-ontario-mask",
  "dive-gate-upsampled-ocean",
];

test.afterEach(() => {
  delete globalThis.viewer;
  delete globalThis.__cloudProbe;
  delete globalThis._webgpuGlobeDebugMode;
  delete globalThis.__webgpuGlobeFragmentDebugRegistry;
});

/** The pin case: the payload the Node side builds names the instant. */
function assertPayloadPinned(rig) {
  assert.equal(
    landingStagePayload(rig).clock,
    PIN,
    `rig ${rig.id}: the stage payload must carry the pinned clock`,
  );
}

/** The read-back case: what the page record's `stage.clock` shows. */
function assertClockHeld(staged, label) {
  assert.deepEqual(
    staged.clock,
    { requested: PIN, observed: PIN, frozen: true },
    `${label}: the page record's stage.clock`,
  );
}

async function stageWith(stageModule, rig, startIso = FAKE_START) {
  const viewer = createFakeViewer();
  viewer.clock.currentTime = { iso: startIso };
  globalThis.viewer = viewer;
  const payload = landingStagePayload(rig);
  return {
    viewer,
    staged: await stageModule.stageLandingCellInPage({
      ...payload,
      moduleUrl: FAKE_CESIUM_URL,
    }),
  };
}

test("the dive-gate cells map onto exactly the five dive-gate rigs", () => {
  assert.deepEqual(DIVE_CELLS.map(([, cell]) => cell.rig).sort(), DIVE_RIG_IDS);
});

test("each dive-gate rig pins the daylight instant and the stage payload carries it", async () => {
  const rigs = await loadRigs();
  for (const id of DIVE_RIG_IDS) {
    const rig = rigById(rigs, id);
    assert.ok(rig, `rig ${id} must load`);
    assert.equal(rig.clock, PIN, `rig ${id}`);
    assert.match(
      rig.description,
      /pinned to the daylight instant 2026-06-21T18:00:00Z/,
    );
    assertPayloadPinned(rig);
  }
});

test("the real in-page stage applies the pin and reads it back frozen, on each rig", async () => {
  const rigs = await loadRigs();
  for (const id of DIVE_RIG_IDS) {
    const { viewer, staged } = await stageWith(
      { stageLandingCellInPage },
      rigById(rigs, id),
    );
    assertClockHeld(staged, id);
    assert.equal(viewer.clock.shouldAnimate, false, id);
    assert.equal(viewer.clock.currentTime.iso, PIN, id);
  }
});

test("the pin survives the dive and control page variants of every dive-gate cell", async () => {
  const rigs = await loadRigs();
  assert.equal(DIVE_CELLS.length, 5);
  for (const [cellName, cell] of DIVE_CELLS) {
    const rig = rigById(rigs, cell.rig);
    for (const page of ["dive", "control"]) {
      const pageRig = rigForPage(rig, { cell: cellName, page });
      assert.notEqual(
        pageRig,
        rig,
        `${cellName}/${page}: the variant overlay must have produced a new rig`,
      );
      assert.equal(
        pageRig.dials.diveCollisionDisabled,
        page === "dive",
        `${cellName}/${page}: the overlay's own dial is applied`,
      );
      assertPayloadPinned(pageRig);
      const { staged } = await stageWith({ stageLandingCellInPage }, pageRig);
      assertClockHeld(staged, `${cellName}/${page}`);
    }
  }
});

test("a dive-gate rig that leaves the clock null fails the pin case (the pre-change rig)", async () => {
  const rigs = await loadRigs();
  for (const id of DIVE_RIG_IDS) {
    const preChange = { ...rigById(rigs, id), clock: null };
    assert.throws(
      () => assertPayloadPinned(preChange),
      (error) =>
        error instanceof assert.AssertionError &&
        error.actual === null &&
        error.expected === PIN,
      `rig ${id}`,
    );
  }
});

test("inertness: a stage whose clock application is unreachable fails the read-back case", async () => {
  const mutant = await importMutated(STAGE_MODULE, [
    ["if (payload.clock !== null) {", "if (false && payload.clock !== null) {"],
  ]);
  const rigs = await loadRigs();
  const rig = rigById(rigs, DIVE_RIG_IDS[0]);
  const { staged } = await stageWith(mutant, rig);
  assert.equal(
    staged.clock.requested,
    PIN,
    "the request still reaches the stage",
  );
  assert.equal(staged.clock.observed, FAKE_START, "the clock was never set");
  assert.throws(() => assertClockHeld(staged, "mutant"), assert.AssertionError);
});

// ---------------------------------------------------------------------------
// clockHeld on the verdict entry (lead): the staged clock, read where a reader
// of the verdicts looks.
// ---------------------------------------------------------------------------

const STEPS_MODULE = fileURLToPath(
  new URL("./lib/globe-dive-gate-steps.mjs", import.meta.url),
);

/** A dive page record over a staged clock, its outcome unreadable or not. */
function divePageRecord(staged) {
  return {
    stage: staged,
    diveGate: {
      expected: "allow",
      step: null,
      outcome: { readable: false, reason: "no-steps", detail: "none" },
    },
  };
}

test("the dive-gate verdict says clockHeld true when the stage read back the rig's pin, false for the wall clock", async () => {
  const steps = await import(pathToFileURL(STEPS_MODULE).href);
  const rigs = await loadRigs();
  for (const id of DIVE_RIG_IDS) {
    const rig = rigById(rigs, id);
    const { staged } = await stageWith({ stageLandingCellInPage }, rig);
    const held = steps.diveGateVerdict(`${id}:webgpu:dive:run0`, {
      ...divePageRecord(staged),
    });
    assert.equal(held.clockHeld, true, `${id}: pinned and frozen`);
    const { staged: wall } = await stageWith(
      { stageLandingCellInPage },
      { ...rig, clock: null },
    );
    const unheld = steps.diveGateVerdict(
      `${id}:webgpu:dive:run0`,
      divePageRecord(wall),
    );
    assert.equal(unheld.clockHeld, false, `${id}: wall clock`);
  }
  assert.equal(
    steps.diveGateVerdict("x", { diveGate: divePageRecord(null).diveGate })
      .clockHeld,
    null,
    "a page record with no stage clock reads null, not false",
  );
});

test("inertness: with the clockHeld read unreachable the verdict no longer says the pin held", async () => {
  const mutant = await importMutated(STEPS_MODULE, [
    [
      'typeof clock.requested === "string" &&',
      'false && typeof clock.requested === "string" &&',
    ],
  ]);
  const rigs = await loadRigs();
  const { staged } = await stageWith(
    { stageLandingCellInPage },
    rigById(rigs, DIVE_RIG_IDS[0]),
  );
  assert.equal(
    mutant.diveGateVerdict("m", divePageRecord(staged)).clockHeld,
    false,
  );
});
