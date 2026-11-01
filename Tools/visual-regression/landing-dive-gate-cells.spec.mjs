// landing-dive-gate-cells.spec.mjs - the five dive-gate landing cells (E-DG-*): table, rigs, page step, verdict, probe plumbing.
// @purpose Pins the dive-gate landing cells by what a reader of the report sees: each of the five cells plans a dive and a control page on both renderers, is opt-in, carries its pre-registered gate, and (the four terrain cells) opens its page online; each rig loads and stages; the cell page places the camera through the Cesium module URL, wheels N notches and lands the receipt in the page record; the verdict passes only when the observed gate is the registered one and is NOT RUN when the dive could not be read; and a probe run over a fake browser writes pages with `diveGate` and `network` and `...:dive-gate` verdicts.
// @status ACTIVE
//
// NO BROWSER. Two stand-ins feed the cases, and both run the REAL page
// functions (`pagePlaceDiveCamera`, `pageReadDiveState`, `pageRenderFrames`)
// against the shared fake world (`fixtures/dive-gate-fake-world.mjs`): a viewer
// whose `globeHeight` is undefined until `initializeFrame()` runs, whose wheel
// moves the camera only there, and whose water facade applies the engine's gate
// (`canDiveAtSurfaceHeight`: collision disabled and |height| <= 110 m), with a
// stub Cesium module behind the module URL. The first is a page over that
// world; the second is the landing probe's fake browser, wrapped by
// `withDiveGateAnswers`. Neither answers a height or the gate itself, so a frame
// driver that never reaches `initializeFrame()` reads what the Edge leg read
// (`globe-height-undefined`, a camera that never moved): the first cases below
// pin that negative. That the real controller behaves like the world is the Edge
// job's.

import assert from "node:assert/strict";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import { mkLaneTmp, removeLaneTmp } from "../lib/lane-tmp.mjs";
import {
  STUB_CESIUM_LOG,
  STUB_CESIUM_MODULE_URL,
  makeDiveGateFakeWorld,
} from "./fixtures/dive-gate-fake-world.mjs";
import {
  landingRunners,
  verdictById,
  withDiveGateAnswers,
} from "./fixtures/probe-landing-cells-support.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import {
  DEFAULT_CESIUM_MODULE_URL,
  diveGateVerdict,
  runDiveGateCellPage,
} from "./lib/globe-dive-gate-steps.mjs";
import { landingStagePayload } from "./lib/landing-cell-stage.mjs";
import {
  DEFAULT_CELLS,
  LANDING_CELLS,
  planLandingCells,
  rigForPage,
} from "./lib/landing-cell-table.mjs";
import { landingVerdicts } from "./lib/landing-verdicts.mjs";
import { loadRigs, validateRig } from "./lib/rig-registry.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STEPS_PATH = path.join(HERE, "lib", "globe-dive-gate-steps.mjs");
const FRAMES_PATH = path.join(HERE, "lib", "landing-page-frames.mjs");
const TABLE_PATH = path.join(HERE, "lib", "landing-cell-table.mjs");

/** The five cells: the rig each runs, the gate its dive page registers, whether it streams terrain and the surface height a fake reads there. */
const CELLS = Object.freeze({
  "E-DG-geiranger": {
    rig: "dive-gate-geiranger-wall",
    dive: "allow",
    online: true,
    surface: 43,
  },
  "E-DG-ontario": {
    rig: "dive-gate-lake-ontario-mask",
    dive: "allow",
    online: true,
    surface: 41,
  },
  "E-DG-deathvalley": {
    rig: "dive-gate-death-valley",
    dive: "refuse",
    online: true,
    surface: -118,
  },
  "E-DG-ellipsoid": {
    rig: "dive-gate-ellipsoid-sea-level",
    dive: "allow",
    online: false,
    surface: 0,
  },
  "E-DG-upsampled": {
    rig: "dive-gate-upsampled-ocean",
    dive: "allow",
    online: true,
    surface: 12,
  },
});

const STUB_MODULE_URL = STUB_CESIUM_MODULE_URL;

let TEMP_ROOT;
before(() => {
  TEMP_ROOT = mkLaneTmp("landing-dive-gate-cells-");
});
after(() => {
  removeLaneTmp(TEMP_ROOT);
});
const { p14Run } = landingRunners(() => TEMP_ROOT);

const rigsById = async () =>
  new Map((await loadRigs()).map((rig) => [rig.id, rig]));

/** The rig a planned page stages (variant dials laid over the rig's own). */
async function pageRig(cell, page) {
  const rigs = await rigsById();
  return rigForPage(rigs.get(CELLS[cell].rig), { cell, page });
}

/**
 * The shared fake world for a surface height, as the spec's cases use it.
 *
 * @param {number|undefined} surface Terrain height under the camera.
 * @param {object} [options] {@link makeDiveGateFakeWorld} options (`facade`, ...).
 * @returns {object} The world with `page`, `settle` and `seen`.
 */
function makeDiveWorld(surface, options = {}) {
  return makeDiveGateFakeWorld({ surface, ...options });
}

/** Just the `page` and `settle` a cell page run takes, over a fresh world. */
const livePage = (surface, options) => {
  const { page, settle } = makeDiveWorld(surface, options);
  return { page, settle };
};

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

test("each dive-gate cell plans a dive and a control page on both renderers, and is opt-in", async () => {
  const rigs = await rigsById();
  for (const [cell, expect] of Object.entries(CELLS)) {
    assert.ok(!DEFAULT_CELLS.includes(cell), `${cell} must not be a default`);
    assert.equal(LANDING_CELLS[cell].kind, "dive-gate");
    assert.equal(LANDING_CELLS[cell].rig, expect.rig);
    const plan = planLandingCells({ cells: cell }, rigs);
    assert.deepEqual(
      plan.map((entry) => `${entry.renderer}:${entry.page}`),
      ["webgl:dive", "webgl:control", "webgpu:dive", "webgpu:control"],
      `${cell} plans two pages on each renderer`,
    );
    assert.ok(plan.every((entry) => entry.kind === "dive-gate"));
  }
});

test("the four terrain cells open their page online; the ellipsoid cell stays offline", () => {
  for (const [cell, expect] of Object.entries(CELLS)) {
    assert.equal(
      LANDING_CELLS[cell].online === true,
      expect.online,
      `${cell} online`,
    );
  }
});

test("a dive page disables the collision and registers the cell's gate; a control page keeps it on and registers refuse", async () => {
  for (const [cell, expect] of Object.entries(CELLS)) {
    const dive = (await pageRig(cell, "dive")).dials;
    const control = (await pageRig(cell, "control")).dials;
    assert.equal(dive.diveCollisionDisabled, true, `${cell} dive collision`);
    assert.equal(dive.diveGateExpected, expect.dive, `${cell} dive gate`);
    assert.equal(control.diveCollisionDisabled, false, `${cell} control`);
    assert.equal(control.diveGateExpected, "refuse", `${cell} control gate`);
    // The variant leaves the step data alone.
    assert.deepEqual(control.diveGateStep, dive.diveGateStep);
  }
});

// ---------------------------------------------------------------------------
// The rigs
// ---------------------------------------------------------------------------

test("each rig loads, is a water rig, and the stage accepts its dials as step dials", async () => {
  const rigs = await loadRigs();
  for (const [cell, expect] of Object.entries(CELLS)) {
    const rig = rigs.find((candidate) => candidate.id === expect.rig);
    assert.ok(rig, `${expect.rig} is in the registry`);
    validateRig(rig);
    assert.ok(rig.tags.includes("water"));
    assert.deepEqual(rig.renderers, ["webgl", "webgpu"]);
    for (const page of ["dive", "control"]) {
      const payload = landingStagePayload(rigForPage(rig, { cell, page }));
      for (const dial of [
        "diveGateStep",
        "diveCollisionDisabled",
        "diveGateExpected",
      ]) {
        assert.ok(
          payload.stepDials.includes(dial),
          `${cell}:${page} passes ${dial} over as a step dial`,
        );
      }
      assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload);
    }
    const step = rig.dials.diveGateStep;
    for (const field of ["lon", "lat", "height"]) {
      assert.ok(Number.isFinite(step[field]), `${expect.rig} step ${field}`);
    }
    assert.ok(step.wheelNotches > 0);
    // The stage puts the camera where the step does, so the first frame is
    // the one the wheel starts from.
    assert.equal(rig.camera.lon, step.lon);
    assert.equal(rig.camera.lat, step.lat);
    assert.equal(rig.camera.height, step.height);
  }
  const ellipsoid = rigs.find(
    (rig) =>
      rig.dials?.terrain === "ellipsoid" && rig.id.startsWith("dive-gate-"),
  );
  assert.ok(ellipsoid, "the ellipsoid cell stages the ellipsoid terrain");
  assert.equal(ellipsoid.id, CELLS["E-DG-ellipsoid"].rig);
});

// ---------------------------------------------------------------------------
// The cell page
// ---------------------------------------------------------------------------

test("every cell's pages read the registered gate through the real placement and wheel, and pass", async () => {
  for (const [cell, expect] of Object.entries(CELLS)) {
    for (const page of ["dive", "control"]) {
      const rig = await pageRig(cell, page);
      const world = makeDiveWorld(expect.surface);
      const result = await runDiveGateCellPage({
        page: world.page,
        // The stub module stands in for the build the real page serves.
        rig: {
          ...rig,
          dials: {
            ...rig.dials,
            diveGateStep: {
              ...rig.dials.diveGateStep,
              moduleUrl: STUB_MODULE_URL,
            },
          },
        },
        settle: world.settle,
      });
      const verdict = diveGateVerdict(`${cell}:webgl:${page}:run0`, result);
      assert.equal(
        verdict.pass,
        true,
        `${cell}:${page} ${JSON.stringify(verdict)}`,
      );
      assert.equal(verdict.observed, page === "dive" ? expect.dive : "refuse");
      assert.equal(verdict.expected, verdict.observed);
    }
  }
});

test("the placement goes through the module URL, the wheel is driven N notches and the receipt lands in the record", async () => {
  globalThis[STUB_CESIUM_LOG] = [];
  const rig = await pageRig("E-DG-geiranger", "dive");
  const step = {
    ...rig.dials.diveGateStep,
    wheelNotches: 4,
    moduleUrl: STUB_MODULE_URL,
  };
  const world = makeDiveWorld(43);
  const { diveGate } = await runDiveGateCellPage({
    page: world.page,
    rig: { ...rig, dials: { ...rig.dials, diveGateStep: step } },
    settle: world.settle,
  });
  assert.deepEqual(globalThis[STUB_CESIUM_LOG], [
    { lon: step.lon, lat: step.lat, height: step.height },
  ]);
  assert.equal(world.seen.wheels.length, 4);
  assert.equal(diveGate.record.placement.moduleUrl, STUB_MODULE_URL);
  assert.equal(diveGate.expected, "allow");
  assert.equal(diveGate.outcome.readable, true);
  assert.equal(diveGate.outcome.receipt.gate, "allow");
  assert.equal(diveGate.outcome.receipt.notches, 4);
  assert.equal(diveGate.outcome.receipt.clampHeld, true);
  assert.equal(diveGate.step.disableWaterCollision, true);
});

test("a rig that names no module URL imports the build the viewer page serves", async () => {
  const rig = await pageRig("E-DG-ellipsoid", "dive");
  const world = makeDiveWorld(0);
  const { diveGate } = await runDiveGateCellPage({
    page: world.page,
    rig,
    settle: world.settle,
  });
  // Node cannot import the browser's path: the reason names it.
  assert.equal(diveGate.record.placement.moduleUrl, DEFAULT_CESIUM_MODULE_URL);
  assert.equal(diveGate.outcome.readable, false);
  assert.match(
    diveGate.outcome.detail,
    /\/Build\/CesiumUnminified\/index\.js/u,
  );
});

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

test("a page without a dive has no verdict", () => {
  assert.equal(diveGateVerdict("x", {}), null);
  assert.equal(diveGateVerdict("x", { diveGate: null }), null);
});

test("a placement that failed, or a missing module, is NOT RUN with the reason", async () => {
  const rig = await pageRig("E-DG-ellipsoid", "dive");
  const noFacade = await runDiveGateCellPage({
    ...livePage(0, { facade: false }),
    rig: {
      ...rig,
      dials: {
        ...rig.dials,
        diveGateStep: { ...rig.dials.diveGateStep, moduleUrl: STUB_MODULE_URL },
      },
    },
  });
  const facadeless = diveGateVerdict(
    "E-DG-ellipsoid:webgl:dive:run0",
    noFacade,
  );
  assert.equal(facadeless.id, "E-DG-ellipsoid:webgl:dive:run0:dive-gate");
  assert.equal(facadeless.pass, false);
  assert.equal(facadeless.notRun, true);
  assert.match(facadeless.reason, /^no-water-facade: /u);

  const noModule = await runDiveGateCellPage({
    ...livePage(0),
    rig: {
      ...rig,
      dials: {
        ...rig.dials,
        diveGateStep: {
          ...rig.dials.diveGateStep,
          moduleUrl: "data:text/javascript,export const Other = 1",
        },
      },
    },
  });
  const moduleless = diveGateVerdict("c", noModule);
  assert.equal(moduleless.notRun, true);
  assert.equal(moduleless.pass, false);
  assert.match(
    moduleless.reason,
    /^placement-failed: .*Cartesian3\.fromDegrees/u,
  );

  const noStep = await runDiveGateCellPage({
    ...livePage(0),
    rig: { id: "bare", dials: { diveGateExpected: "allow" } },
  });
  const stepless = diveGateVerdict("c", noStep);
  assert.equal(stepless.notRun, true);
  assert.match(stepless.reason, /^step-missing: /u);
});

test("allow expected and allow observed passes; refuse observed where allow was expected fails", async () => {
  const rig = await pageRig("E-DG-ellipsoid", "dive");
  const withModule = (extra = {}) => ({
    ...rig,
    dials: {
      ...rig.dials,
      diveGateStep: { ...rig.dials.diveGateStep, moduleUrl: STUB_MODULE_URL },
      ...extra,
    },
  });
  const allowed = diveGateVerdict(
    "c",
    await runDiveGateCellPage({
      ...livePage(0),
      rig: withModule(),
    }),
  );
  assert.equal(allowed.pass, true);
  assert.equal(allowed.notRun, undefined);
  assert.equal(allowed.expected, "allow");
  assert.equal(allowed.observed, "allow");
  assert.equal(allowed.clampHeld, true);

  // The collision left on (the control's flag) where the rig registered
  // allow: the engine refuses, and that is a failure, not a NOT RUN.
  const refused = diveGateVerdict(
    "c",
    await runDiveGateCellPage({
      ...livePage(0),
      rig: withModule({ diveCollisionDisabled: false }),
    }),
  );
  assert.equal(refused.pass, false);
  assert.equal(refused.notRun, undefined);
  assert.equal(refused.expected, "allow");
  assert.equal(refused.observed, "refuse");

  // No registered gate: nothing to judge against, NOT RUN.
  const unregistered = diveGateVerdict(
    "c",
    await runDiveGateCellPage({
      ...livePage(0),
      rig: withModule({ diveGateExpected: undefined }),
    }),
  );
  assert.equal(unregistered.notRun, true);
  assert.equal(unregistered.pass, false);
  assert.match(unregistered.reason, /^expected-gate-missing: /u);
});

test("landingVerdicts carries the dive-gate verdict of a dive page and of nothing else", async () => {
  const rig = await pageRig("E-DG-deathvalley", "dive");
  const diveGate = (
    await runDiveGateCellPage({
      ...livePage(-118),
      rig: {
        ...rig,
        dials: {
          ...rig.dials,
          diveGateStep: {
            ...rig.dials.diveGateStep,
            moduleUrl: STUB_MODULE_URL,
          },
        },
      },
    })
  ).diveGate;
  const base = {
    run: 0,
    cell: "E-DG-deathvalley",
    rig: "dive-gate-death-valley",
    renderer: "webgl",
    page: "dive",
    notRun: null,
    gate: { deviceLost: null },
  };
  const verdicts = landingVerdicts(
    [
      { ...base, kind: "dive-gate", diveGate },
      { ...base, page: "scene", kind: "capture" },
    ],
    null,
  );
  const id = "E-DG-deathvalley:webgl:dive:run0:dive-gate";
  assert.equal(verdictById(verdicts, id)?.pass, true);
  assert.equal(verdictById(verdicts, id).observed, "refuse");
  assert.equal(
    verdicts.filter((verdict) => verdict.id.endsWith(":dive-gate")).length,
    1,
  );
});

// ---------------------------------------------------------------------------
// The probe, over the fake browser
// ---------------------------------------------------------------------------

test("a probe run over E-DG-ellipsoid writes four pages carrying diveGate and network, and passing dive-gate verdicts", async () => {
  const diveLog = { placements: [], moves: [], wheels: [] };
  const { code, report, log, verdicts } = await p14Run(
    "ellipsoid",
    ["--cells", "E-DG-ellipsoid"],
    {},
    undefined,
    (browser) => withDiveGateAnswers(browser, { diveLog, globeHeight: 0 }),
  );
  assert.equal(code, 0, JSON.stringify(verdicts.filter((v) => !v.pass)));
  const pages = report.pages ?? report.runtime?.pages ?? [];
  assert.equal(pages.length, 4);
  for (const page of pages) {
    assert.equal(page.kind, "dive-gate");
    assert.equal(page.network, "offline");
    assert.ok(page.diveGate, `${page.renderer}:${page.page} carries diveGate`);
    assert.equal(
      page.diveGate.expected,
      page.page === "dive" ? "allow" : "refuse",
    );
    assert.equal(page.diveGate.outcome.receipt.gate, page.diveGate.expected);
  }
  const ids = verdicts
    .filter((verdict) => verdict.id.endsWith(":dive-gate"))
    .map((verdict) => verdict.id)
    .sort();
  assert.equal(ids.length, 4);
  assert.ok(ids.every((id) => verdictById(verdicts, id).pass === true));
  assert.ok(ids.some((id) => id.includes(":webgpu:control:")));
  assert.ok(log.urls.every((url) => String(url).includes("offline=true")));
  assert.deepEqual(
    diveLog.placements.map((arg) => arg.disableWaterCollision),
    [true, false, true, false],
  );
  assert.equal(diveLog.wheels.length, 4 * 12);
});

test("a probe run over a terrain cell opens its pages online; a page read over the wrong ground is void and fails the run, never a pass", async () => {
  // Badwater read 100 m below the ellipsoid: inside the gate's band, so the
  // dive allows, but off the cell's registered window: a rig finding.
  const { code, report, log, verdicts } = await p14Run(
    "deathvalley-wrong",
    ["--cells", "E-DG-deathvalley", "--renderer", "webgl"],
    {},
    undefined,
    (browser) => withDiveGateAnswers(browser, { globeHeight: -100 }),
  );
  const pages = report.pages ?? report.runtime?.pages ?? [];
  assert.ok(pages.every((page) => page.network === "online"));
  assert.ok(log.urls.every((url) => !String(url).includes("offline=true")));
  const dive = verdicts.find((verdict) =>
    verdict.id.endsWith(":dive:run0:dive-gate"),
  );
  assert.equal(dive.pass, false);
  assert.equal(dive.notRun, true);
  assert.equal(dive.expected, "refuse");
  assert.equal(dive.observed, "allow");
  assert.deepEqual(dive.globeHeightWindow, { min: -135, max: -111 });
  assert.match(dive.reason, /^globe-height-off-window: .*rig finding/u);
  assert.notEqual(code, 0, "a void page fails the run");

  // Terrain that never streamed reads the bare ellipsoid: void on an online
  // page, whatever gate it shows.
  const flat = await p14Run(
    "deathvalley-flat",
    ["--cells", "E-DG-deathvalley", "--renderer", "webgl"],
    {},
    undefined,
    (browser) => withDiveGateAnswers(browser, { globeHeight: 0 }),
  );
  for (const verdict of flat.verdicts.filter((v) =>
    v.id.endsWith(":dive-gate"),
  )) {
    assert.equal(verdict.pass, false, verdict.id);
    assert.equal(verdict.notRun, true, verdict.id);
    assert.match(verdict.reason, /^terrain-not-streamed: /u, verdict.id);
  }
  assert.notEqual(flat.code, 0);

  // Badwater read below the band: both pages refuse, as registered.
  const right = await p14Run(
    "deathvalley-right",
    ["--cells", "E-DG-deathvalley", "--renderer", "webgl"],
    {},
    undefined,
    (browser) => withDiveGateAnswers(browser, { globeHeight: -118 }),
  );
  assert.equal(right.code, 0);
});

test("a probe run whose placement fails reports NOT RUN with the reason and fails the run", async () => {
  const { code, verdicts } = await p14Run(
    "placement-fails",
    ["--cells", "E-DG-ellipsoid", "--renderer", "webgl"],
    {},
    undefined,
    (browser) => withDiveGateAnswers(browser, { placementFails: true }),
  );
  const dive = verdicts.find((verdict) =>
    verdict.id.endsWith(":dive:run0:dive-gate"),
  );
  assert.equal(dive.pass, false);
  assert.equal(dive.notRun, true);
  assert.match(
    dive.reason,
    /^placement-failed: the globe has no water facade/u,
  );
  assert.notEqual(code, 0);
});

// ---------------------------------------------------------------------------
// INERTNESS
// ---------------------------------------------------------------------------

async function ellipsoidDive(steps, table = null) {
  const rigs = await rigsById();
  const entry = { cell: "E-DG-ellipsoid", page: "dive" };
  const rig = (table?.rigForPage ?? rigForPage)(
    rigs.get("dive-gate-ellipsoid-sea-level"),
    entry,
  );
  return steps.runDiveGateCellPage({
    ...livePage(0),
    rig: {
      ...rig,
      dials: {
        ...rig.dials,
        diveGateStep: { ...rig.dials.diveGateStep, moduleUrl: STUB_MODULE_URL },
      },
    },
  });
}

test("INERTNESS: with the module import unreachable, the placement fails and the dive is NOT RUN", async () => {
  const live = await ellipsoidDive({ runDiveGateCellPage });
  assert.equal(diveGateVerdict("c", live).pass, true);
  const mutated = await importMutated(STEPS_PATH, [
    [
      "Cesium = await import(moduleUrl);",
      "Cesium = false && (await import(moduleUrl));",
    ],
  ]);
  const dead = diveGateVerdict("c", await ellipsoidDive(mutated));
  assert.equal(dead.notRun, true);
  assert.equal(dead.pass, false);
});

test("INERTNESS: with the verdict comparison unreachable, a wrong gate no longer fails", async () => {
  const wrong = await runDiveGateCellPage({
    ...livePage(0),
    rig: {
      id: "r",
      dials: {
        diveGateStep: {
          lon: 1,
          lat: 2,
          height: 3,
          wheelNotches: 2,
          moduleUrl: STUB_MODULE_URL,
        },
        diveCollisionDisabled: false,
        diveGateExpected: "allow",
      },
    },
  });
  assert.equal(diveGateVerdict("c", wrong).pass, false);
  const mutated = await importMutated(STEPS_PATH, [
    [
      "pass: receipt.gate === expected,",
      "pass: true || receipt.gate === expected,",
    ],
  ]);
  assert.equal(mutated.diveGateVerdict("c", wrong).pass, true);
});

test("INERTNESS: with the dive variant's collision flag unreachable, the dive page no longer reads allow", async () => {
  const table = await importMutated(TABLE_PATH, [
    [
      "    dive: Object.freeze({\n      diveCollisionDisabled: true,",
      "    dive: Object.freeze({\n      diveCollisionDisabled: false,",
    ],
  ]);
  const live = await ellipsoidDive({ runDiveGateCellPage });
  assert.equal(diveGateVerdict("c", live).observed, "allow");
  const dead = diveGateVerdict(
    "c",
    await ellipsoidDive({ runDiveGateCellPage }, table),
  );
  assert.equal(dead.observed, "refuse");
  assert.equal(dead.pass, false);
});

test("a gate mismatch with the surface inside the registered window is the controller's red, not void", () => {
  const record = {
    network: "online",
    diveGate: {
      step: { globeHeightWindow: { min: 21, max: 61 } },
      expected: "allow",
      outcome: {
        readable: true,
        receipt: {
          gate: "refuse",
          clampHeld: true,
          collisionDisabled: true,
          globeHeight: 41,
          notches: 12,
          diveDepthMax: 0,
          depthWhileRefused: false,
        },
      },
    },
  };
  const verdict = diveGateVerdict("E-DG-ontario:webgpu:dive:run0", record);
  assert.equal(verdict.pass, false);
  assert.equal(verdict.notRun, undefined);
  assert.equal(verdict.observed, "refuse");
  assert.deepEqual(verdict.globeHeightWindow, { min: 21, max: 61 });
  // The same reading on the table and with the registered gate passes.
  record.diveGate.outcome.receipt.gate = "allow";
  assert.equal(diveGateVerdict("x", record).pass, true);
});

test("every dive-gate rig registers a globeHeight window before the leg, Death Valley's wholly below the band", async () => {
  const rigs = await rigsById();
  for (const { rig } of Object.values(CELLS)) {
    const window = rigs.get(rig).dials.diveGateStep.globeHeightWindow;
    assert.ok(window && window.min < window.max, rig);
  }
  const badwater = rigs.get("dive-gate-death-valley").dials.diveGateStep
    .globeHeightWindow;
  assert.ok(badwater.max < -110);
});

test("--perf over a dive-gate cell runs no PF window on its pages and does not wait", async () => {
  const { report } = await p14Run(
    "ellipsoid-perf",
    ["--cells", "E-DG-ellipsoid", "--perf"],
    {},
    undefined,
    (browser) => withDiveGateAnswers(browser, { globeHeight: 0 }),
  );
  const pages = report.pages ?? report.runtime?.pages ?? [];
  assert.equal(pages.length, 4);
  for (const page of pages) {
    assert.equal(page.perf, undefined, `${page.renderer} ${page.page}`);
  }
  assert.equal(report.warmUp.status, "not-a-pf-run");
});

// ---------------------------------------------------------------------------
// The wheel reaches the controller: the frame driver is a widget frame
// ---------------------------------------------------------------------------

/** The rig a cell page stages, with the stub Cesium module behind its module URL. */
async function stubbedRig(cell, page) {
  const rig = await pageRig(cell, page);
  return {
    ...rig,
    dials: {
      ...rig.dials,
      diveGateStep: { ...rig.dials.diveGateStep, moduleUrl: STUB_MODULE_URL },
    },
  };
}

/** The frame driver and the placement as they were before the widget frame: render only. */
async function preFixModules() {
  return {
    frames: await importMutated(FRAMES_PATH, [
      [
        "viewer.scene.initializeFrame();",
        "false && viewer.scene.initializeFrame();",
      ],
    ]),
    steps: await importMutated(STEPS_PATH, [
      ["scene.initializeFrame();", "false && scene.initializeFrame();"],
    ]),
  };
}

/** The floor a dive page's camera is held at: the dive stop where the gate allows, else the stock clamp. */
const floorOf = (expect, page) =>
  expect.surface + (page === "dive" && expect.dive === "allow" ? 14 : 1);

/** Strictly descending while above the floor, then flat on it. */
function assertDescendsToFloor(series, floor, label) {
  assert.equal(series.length, 13, `${label}: initial plus 12 notches`);
  for (let i = 0; i + 1 < series.length; i++) {
    if (series[i] > floor) {
      assert.ok(
        series[i + 1] < series[i],
        `${label}: notch ${i} left the camera at ${series[i]} m, above the ${floor} m floor`,
      );
    } else {
      assert.equal(series[i + 1], series[i], `${label}: flat on the floor`);
    }
  }
  assert.equal(series.at(-1), floor, `${label}: ended on the floor`);
}

test("NEGATIVE FIRST: with the render-only frame driver and placement, every dive-gate page reads globe-height-undefined and the camera never moves, as the Edge leg saw", async () => {
  const preFix = await preFixModules();
  for (const [cell, expect] of Object.entries(CELLS)) {
    for (const page of ["dive", "control"]) {
      const rig = await stubbedRig(cell, page);
      const world = makeDiveGateFakeWorld({
        surface: expect.surface,
        frameDriver: preFix.frames.pageRenderFrames,
      });
      const result = await preFix.steps.runDiveGateCellPage({
        page: world.page,
        rig,
        settle: world.settle,
      });
      const label = `${cell}:${page}`;
      const start = rig.dials.diveGateStep.height;
      assert.equal(result.diveGate.outcome.readable, false, label);
      assert.equal(result.diveGate.outcome.reason, "globe-height-undefined");
      assert.equal(
        world.seen.wheels.length,
        12,
        `${label}: the wheel was sent`,
      );
      assert.equal(world.seen.initializeFrames, 0, label);
      assert.deepEqual(
        result.diveGate.outcome.cameraHeights,
        new Array(13).fill(start),
        `${label}: the camera never moved`,
      );
      const verdict = diveGateVerdict(`${cell}:webgl:${page}:run0`, result);
      assert.equal(verdict.notRun, true, label);
      assert.equal(verdict.pass, false, label);
      assert.match(verdict.reason, /^globe-height-undefined: /u);
      assert.deepEqual(verdict.cameraHeights, new Array(13).fill(start));
    }
  }
});

test("with the widget frame, every cell's pages read a finite globe height, a descending camera and the registered gate", async () => {
  for (const [cell, expect] of Object.entries(CELLS)) {
    for (const page of ["dive", "control"]) {
      const rig = await stubbedRig(cell, page);
      const world = makeDiveWorld(expect.surface);
      const result = await runDiveGateCellPage({
        page: world.page,
        rig,
        settle: world.settle,
      });
      const label = `${cell}:${page}`;
      const { outcome } = result.diveGate;
      assert.equal(
        outcome.readable,
        true,
        `${label} ${JSON.stringify(outcome)}`,
      );
      assert.equal(outcome.receipt.globeHeight, expect.surface, label);
      assert.ok(Number.isFinite(world.scene.globeHeight), label);
      assertDescendsToFloor(
        outcome.receipt.cameraHeights,
        floorOf(expect, page),
        label,
      );
      assert.equal(
        outcome.receipt.cameraHeights[0],
        rig.dials.diveGateStep.height,
      );
      assert.equal(
        outcome.receipt.gate,
        page === "dive" ? expect.dive : "refuse",
      );
      assert.equal(outcome.receipt.clampHeld, true, label);
      assert.equal(
        world.seen.clockTicks,
        0,
        `${label}: the clock stays frozen`,
      );
      assert.equal(
        world.seen.initializeFrames,
        world.seen.renders.length,
        `${label}: every render is a widget frame`,
      );
      const verdict = diveGateVerdict(`${cell}:webgl:${page}:run0`, result);
      assert.equal(verdict.pass, true, `${label} ${JSON.stringify(verdict)}`);
      assert.deepEqual(verdict.cameraHeights, outcome.receipt.cameraHeights);
    }
  }
});

test("Death Valley's dive page refuses (Badwater is below the band); the other cells' dive pages allow and count depth", async () => {
  const deathValley = await stubbedRig("E-DG-deathvalley", "dive");
  const world = makeDiveWorld(CELLS["E-DG-deathvalley"].surface);
  const { diveGate } = await runDiveGateCellPage({
    page: world.page,
    rig: deathValley,
    settle: world.settle,
  });
  assert.equal(diveGate.outcome.receipt.gate, "refuse");
  assert.equal(diveGate.outcome.receipt.diveDepthGrew, false);
  assert.equal(diveGate.expected, "refuse");
  assert.equal(deathValley.dials.diveCollisionDisabled, true);
  for (const cell of Object.keys(CELLS).filter(
    (c) => c !== "E-DG-deathvalley",
  )) {
    const rig = await stubbedRig(cell, "dive");
    const other = makeDiveWorld(CELLS[cell].surface);
    const result = await runDiveGateCellPage({
      page: other.page,
      rig,
      settle: other.settle,
    });
    assert.equal(result.diveGate.outcome.receipt.gate, "allow", cell);
    assert.equal(result.diveGate.outcome.receipt.diveDepthGrew, true, cell);
  }
});

test("a controller that ignores the wheel is NOT RUN as wheel-unread on the cell page, naming where the camera stayed", async () => {
  const rig = await stubbedRig("E-DG-ellipsoid", "dive");
  const world = makeDiveWorld(0, { enableInputs: false });
  const result = await runDiveGateCellPage({
    page: world.page,
    rig,
    settle: world.settle,
  });
  const verdict = diveGateVerdict("E-DG-ellipsoid:webgl:dive:run0", result);
  assert.equal(world.seen.wheels.length, 12);
  assert.equal(verdict.notRun, true);
  assert.equal(verdict.pass, false);
  assert.match(
    verdict.reason,
    /^wheel-unread: the camera stayed at 150 m over 12 notches$/u,
  );
  assert.deepEqual(verdict.cameraHeights, new Array(13).fill(150));
});

test("with only the frame driver render-only, the globe height is read but the wheel never moves the camera: wheel-unread", async () => {
  const preFix = await preFixModules();
  const rig = await stubbedRig("E-DG-ellipsoid", "dive");
  const world = makeDiveGateFakeWorld({
    surface: 0,
    frameDriver: preFix.frames.pageRenderFrames,
  });
  const result = await runDiveGateCellPage({
    page: world.page,
    rig,
    settle: world.settle,
  });
  assert.equal(result.diveGate.outcome.reason, "wheel-unread");
});

test("a probe run over each cell, with the widget frame, reads :dive-gate PASS on the dive and control pages with the camera descending", async () => {
  for (const [cell, expect] of Object.entries(CELLS)) {
    const { code, verdicts } = await p14Run(
      `widget-frame-${cell}`,
      ["--cells", cell, "--renderer", "webgl"],
      {},
      undefined,
      (browser) =>
        withDiveGateAnswers(browser, { globeHeight: expect.surface }),
    );
    const dive = verdicts.filter((verdict) =>
      verdict.id.endsWith(":dive-gate"),
    );
    assert.equal(dive.length, 2, cell);
    assert.equal(
      code,
      0,
      `${cell} ${JSON.stringify(verdicts.filter((v) => !v.pass))}`,
    );
    for (const verdict of dive) {
      assert.equal(verdict.pass, true, verdict.id);
      assert.equal(verdict.globeHeight, expect.surface, verdict.id);
      const page = verdict.id.includes(":dive:") ? "dive" : "control";
      assertDescendsToFloor(
        verdict.cameraHeights,
        floorOf(expect, page),
        verdict.id,
      );
      assert.equal(
        verdict.observed,
        page === "dive" ? expect.dive : "refuse",
        verdict.id,
      );
    }
  }
});

test("a probe run whose page functions are the render-only ones reads NOT RUN globe-height-undefined on every dive-gate page, never a pass", async () => {
  // The probe imports its frame driver itself, and importMutated rewrites only
  // the mutated module's own imports, so the mutated page functions are handed
  // to the fake browser, which runs them in place of the probe's by name: the
  // same page-side path (page.evaluate of the page function against the world).
  const preFix = await preFixModules();
  for (const [cell, expect] of Object.entries(CELLS)) {
    const { code, verdicts } = await p14Run(
      `render-only-${cell}`,
      ["--cells", cell, "--renderer", "webgl"],
      {},
      undefined,
      (browser) =>
        withDiveGateAnswers(browser, {
          globeHeight: expect.surface,
          functionOverrides: {
            pageRenderFrames: preFix.frames.pageRenderFrames,
            pagePlaceDiveCamera: preFix.steps.pagePlaceDiveCamera,
          },
        }),
    );
    const dive = verdicts.filter((verdict) =>
      verdict.id.endsWith(":dive-gate"),
    );
    assert.equal(dive.length, 2, cell);
    for (const verdict of dive) {
      assert.equal(verdict.pass, false, verdict.id);
      assert.equal(verdict.notRun, true, verdict.id);
      assert.match(verdict.reason, /^globe-height-undefined: /u, verdict.id);
      assert.equal(new Set(verdict.cameraHeights).size, 1, verdict.id);
    }
    assert.notEqual(code, 0, `${cell} fails the run`);
  }
});

test("INERTNESS: with the wheel-unread check unreachable, a controller that ignores the wheel passes the cell page", async () => {
  const mutated = await importMutated(STEPS_PATH, [
    [
      "if (cameraHeights.every((height) => height === cameraHeights[0])) {",
      "if (false && cameraHeights.every((height) => height === cameraHeights[0])) {",
    ],
  ]);
  const rig = await stubbedRig("E-DG-ellipsoid", "dive");
  const world = makeDiveWorld(0, { enableInputs: false });
  const result = await mutated.runDiveGateCellPage({
    page: world.page,
    rig,
    settle: world.settle,
  });
  const verdict = mutated.diveGateVerdict("c", result);
  assert.equal(verdict.pass, true, "the live check would have made it NOT RUN");
});

test("INERTNESS: with the camera series dropped from the verdict entry, a passing dive-gate verdict no longer carries it", async () => {
  const mutated = await importMutated(STEPS_PATH, [
    [
      "    globeHeight: receipt.globeHeight,\n    cameraHeights: receipt.cameraHeights,\n    notches: receipt.notches,",
      "    globeHeight: receipt.globeHeight,\n    notches: receipt.notches,",
    ],
  ]);
  const rig = await stubbedRig("E-DG-ellipsoid", "dive");
  const world = makeDiveWorld(0);
  const result = await mutated.runDiveGateCellPage({
    page: world.page,
    rig,
    settle: world.settle,
  });
  const verdict = mutated.diveGateVerdict("c", result);
  assert.equal(verdict.pass, true);
  assert.equal(verdict.cameraHeights, undefined);
  assert.ok(Array.isArray(diveGateVerdict("c", result).cameraHeights));
});

test("INERTNESS: with the frame driver's initializeFrame unreachable, the cell page is NOT RUN and no cell passes", async () => {
  const frames = await importMutated(FRAMES_PATH, [
    [
      "viewer.scene.initializeFrame();",
      "false && viewer.scene.initializeFrame();",
    ],
  ]);
  const rig = await stubbedRig("E-DG-geiranger", "dive");
  const world = makeDiveGateFakeWorld({
    surface: 43,
    frameDriver: frames.pageRenderFrames,
  });
  const result = await runDiveGateCellPage({
    page: world.page,
    rig,
    settle: world.settle,
  });
  const verdict = diveGateVerdict("c", result);
  assert.equal(verdict.pass, false);
  assert.equal(verdict.notRun, true);
});

test("INERTNESS: with the placement's initializeFrame unreachable, the globe height is stale straight after the placement, though a whole cell page still reads", async () => {
  const steps = await importMutated(STEPS_PATH, [
    ["scene.initializeFrame();", "false && scene.initializeFrame();"],
  ]);
  const rig = await stubbedRig("E-DG-geiranger", "dive");
  const world = makeDiveWorld(43);
  const arg = { ...rig.dials.diveGateStep, disableWaterCollision: true };
  await world.page.evaluate(steps.pagePlaceDiveCamera, arg);
  assert.equal(world.scene.globeHeight, undefined);
  // The settle after the placement runs widget frames, so the end-to-end run
  // survives this mutant: the placement's own frame is pinned by
  // globe-dive-gate-steps.spec.mjs, not by the end-to-end run.
  const other = makeDiveWorld(43);
  const result = await steps.runDiveGateCellPage({
    page: other.page,
    rig,
    settle: other.settle,
  });
  assert.equal(result.diveGate.outcome.readable, true);
});
