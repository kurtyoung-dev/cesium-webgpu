// probe-landing-cells.spec.mjs - lane KT round 2 (Enedwaith). Pure Node: no browser, no GPU.
// @purpose Drives probe-landing-cells pure helpers on a stub: cell planning (P1), blocking dials (P2) and the landing verdicts including the owner census reporting (P3, P3b).
// @status ACTIVE
//
// Written from _lane-out/BEHAVIOUR_CELOS.md covering behaviours P1-P7, P3b.
// ROUND 2 behaviours P3b and P7 are expected to fail on the current code.
// P8-P12 are the lead's ROUND 4 additions (Celos) for the seat's items F1, F3,
// F4, F5 and F6, written from the item text and the 2026-10-22 E11 run; P13
// the lead's ROUND 5 additions for K5-2, K5-3, K5-6 and Ettenmoors' N-1.
// P14 is lane LINDISSE's (lead), written from the salvage-night Edge receipt's
// NOT RUN items: the per-cell pipeline wait, the onmessage sentinel in the
// identity cells, the ocean-kernel cell and the Chukotka cross-renderer cell.
// P1, P10 and P13 moved with the per-cell wait (E-D now waits by default).
// P15 is the 2D / Columbus banding lane's (Ibal): the stage cells and the variant
// pairing of the cross-renderer metric.

//
// SPLIT BY CONCERN (row DX-KIT-LANDING-SPECS-OVER-SIZE): this file keeps P1-P3b; the other groups live in
// probe-landing-cells-run-compare, -contention-bands, -merge-pipelines, -identity-sentinel and -kernel-cross-renderer
// (.spec.mjs), which share fixtures/probe-landing-cells-support.mjs. Test names and bodies are unchanged.

import assert from "node:assert/strict";
import test from "node:test";
import { ProbeRefusal } from "./lib/probe-runtime.mjs";
import { loadRigs } from "./lib/rig-registry.mjs";
import {
  DEFAULT_CELLS,
  LANDING_CELLS,
  blockingDials,
  landingVerdicts,
  planLandingCells,
} from "./probe-landing-cells.mjs";

const rigs = await loadRigs();
const rigsById = new Map(rigs.map((r) => [r.id, r]));

// ---------------------------------------------------------------------------
// P1: planLandingCells
// ---------------------------------------------------------------------------

test("P1: planLandingCells refuses unknown cell name with cell-unknown", () => {
  assert.throws(
    () => planLandingCells({ cells: "non-existent-cell" }, rigsById),
    (err) => {
      assert.ok(err instanceof ProbeRefusal);
      assert.equal(err.reason, "cell-unknown");
      return true;
    },
  );
});

test("P1: planLandingCells refuses cell whose rig is absent with cell-rig-absent", () => {
  assert.throws(
    () => planLandingCells({ cells: "E-O" }, new Map()),
    (err) => {
      assert.ok(err instanceof ProbeRefusal);
      assert.equal(err.reason, "cell-rig-absent");
      return true;
    },
  );
});

test("P1: planLandingCells plans each cell on each renderer declared by rig, WebGL first", () => {
  const plan = planLandingCells({ cells: "E-D" }, rigsById);
  assert.equal(plan.length, 2);
  assert.equal(plan[0].cell, "E-D");
  assert.equal(plan[0].renderer, "webgl");
  assert.equal(plan[0].page, "scene");
  assert.equal(plan[1].cell, "E-D");
  assert.equal(plan[1].renderer, "webgpu");
  assert.equal(plan[1].page, "scene");
});

test("P1: planLandingCells respects --renderer filter", () => {
  const planWebgl = planLandingCells(
    { cells: "E-D", renderers: ["webgl"] },
    rigsById,
  );
  assert.equal(planWebgl.length, 1);
  assert.equal(planWebgl[0].renderer, "webgl");

  const planWebgpu = planLandingCells(
    { cells: "E-D", renderers: ["webgpu"] },
    rigsById,
  );
  assert.equal(planWebgpu.length, 1);
  assert.equal(planWebgpu[0].renderer, "webgpu");
});

test("P1: planLandingCells plans E-T cell as two pages: teardown then forced-loss", () => {
  const plan = planLandingCells(
    { cells: "E-T-water", renderers: ["webgpu"] },
    rigsById,
  );
  assert.equal(plan.length, 2);
  assert.equal(plan[0].cell, "E-T-water");
  assert.equal(plan[0].page, "teardown");
  assert.equal(plan[1].cell, "E-T-water");
  assert.equal(plan[1].page, "forced-loss");
});

test("P1: planLandingCells plans default cells when options omitted", () => {
  const plan = planLandingCells({}, rigsById);
  const cellNames = new Set(plan.map((entry) => entry.cell));
  for (const defaultCell of DEFAULT_CELLS) {
    assert.ok(
      cellNames.has(defaultCell),
      `missing default cell ${defaultCell}`,
    );
  }
});

test("P1: planLandingCells plans the full table to one page per renderer a rig declares, two for a device-loss cell", () => {
  const allCellNames = Object.keys(LANDING_CELLS).join(",");
  const plan = planLandingCells({ cells: allCellNames }, rigsById);
  let expected = 0;
  for (const { rig: rigId, kind, variants } of Object.values(LANDING_CELLS)) {
    const renderers = rigsById.get(rigId).renderers.length;
    const pages =
      kind === "device-loss" ? 2 : variants ? Object.keys(variants).length : 1;
    expected += renderers * pages;
  }
  assert.equal(plan.length, expected);
  // The literal as well as the derivation: 25 pages before E-M-water, which
  // adds one page per renderer; lane LINDISSE adds E-ID-2d, E-ID-cv and
  // E-C-chukotka (two renderers each) and E-FFT-ifft (WebGPU, two kernels);
  // E-2D-stages and E-CV-stages add six variant pages per renderer each; the
  // four E-W weather-state cells add one page per renderer each.
  assert.equal(plan.length, 67);
});

test("P1: E-M-water is a capture cell on both renderers and is not in the default cells", () => {
  assert.equal(LANDING_CELLS["E-M-water"].rig, "globe-material-water-mask");
  assert.equal(LANDING_CELLS["E-M-water"].kind, "capture");
  assert.ok(!DEFAULT_CELLS.includes("E-M-water"));
  const plan = planLandingCells({ cells: "E-M-water" }, rigsById);
  assert.deepEqual(
    plan.map((entry) => [entry.renderer, entry.page]),
    [
      ["webgl", "scene"],
      ["webgpu", "scene"],
    ],
  );
});

// ---------------------------------------------------------------------------
// P2: blockingDials
// ---------------------------------------------------------------------------

test("P2: blockingDials returns every not-applied dial except water dials", () => {
  const staged = {
    notApplied: [
      "globalWaterMask",
      "cloudDensity",
      "lakeWaterMask",
      "msaaSamples",
      "riverWaterMask",
      "enableEnhancedOcean",
      "highDynamicRange",
      "waterQualityPreset",
    ],
  };
  const blocking = blockingDials(staged);
  assert.deepEqual(blocking, [
    "cloudDensity",
    "msaaSamples",
    "highDynamicRange",
  ]);
});

test("P2: blockingDials returns empty array when only water dials are not applied", () => {
  const staged = {
    notApplied: [
      "globalWaterMask",
      "lakeWaterMask",
      "riverWaterMask",
      "enableEnhancedOcean",
      "waterQualityPreset",
    ],
  };
  assert.deepEqual(blockingDials(staged), []);
});

test("P2: blockingDials returns empty array when staged is empty or null", () => {
  assert.deepEqual(blockingDials({}), []);
  assert.deepEqual(blockingDials(null), []);
  assert.deepEqual(blockingDials({ notApplied: [] }), []);
});

// ---------------------------------------------------------------------------
// P3: landingVerdicts
// ---------------------------------------------------------------------------

test("P3: landingVerdicts yields failing stage verdict and nothing else for a page not run", () => {
  const record = {
    cell: "E-O",
    renderer: "webgpu",
    page: "scene",
    run: 0,
    notRun: "the stage did not apply msaaSamples",
  };
  const verdicts = landingVerdicts([record], null);
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].id, "E-O:webgpu:scene:run0:stage");
  assert.equal(verdicts[0].pass, false);
  assert.equal(verdicts[0].notRun, true);
  assert.equal(verdicts[0].reason, "the stage did not apply msaaSamples");
});

test("P3: landingVerdicts passes stage for a clean run", () => {
  const record = {
    cell: "E-O",
    renderer: "webgpu",
    page: "scene",
    run: 0,
    notRun: null,
    gate: { deviceLost: null },
  };
  const verdicts = landingVerdicts([record], null);
  const stage = verdicts.find((v) => v.id.endsWith(":stage"));
  assert.ok(stage);
  assert.equal(stage.pass, true);
  assert.equal(stage.notRun, false);
});

test("P3: landingVerdicts fails no-unexpected-device-loss when device was lost", () => {
  const record = {
    cell: "E-O",
    renderer: "webgpu",
    page: "scene",
    run: 0,
    notRun: null,
    gate: { deviceLost: "lost" },
  };
  const verdicts = landingVerdicts([record], null);
  const lossVerdict = verdicts.find((v) =>
    v.id.endsWith(":no-unexpected-device-loss"),
  );
  assert.ok(lossVerdict);
  assert.equal(lossVerdict.pass, false);
  assert.equal(lossVerdict.deviceLost, "lost");
});

test("P3: landingVerdicts passes no-unexpected-device-loss when no device was lost", () => {
  const record = {
    cell: "E-O",
    renderer: "webgpu",
    page: "scene",
    run: 0,
    notRun: null,
    gate: { deviceLost: null },
  };
  const verdicts = landingVerdicts([record], null);
  const lossVerdict = verdicts.find((v) =>
    v.id.endsWith(":no-unexpected-device-loss"),
  );
  assert.ok(lossVerdict);
  assert.equal(lossVerdict.pass, true);
  assert.equal(lossVerdict.deviceLost, null);
});

test("P3: landingVerdicts fails owners-destroyed on teardown when seen owner rows have live > 0", () => {
  const record = {
    cell: "E-T-water",
    renderer: "webgpu",
    page: "teardown",
    run: 0,
    notRun: null,
    deviceLoss: {
      deviceLost: null,
      consoleErrors: { pageErrors: [] },
      owners: {
        after: [
          { label: "Owner1", seen: true, created: 5, destroyed: 3, live: 2 },
        ],
      },
    },
  };
  const verdicts = landingVerdicts([record], null);
  const ownersVerdict = verdicts.find((v) =>
    v.id.endsWith(":owners-destroyed"),
  );
  assert.ok(ownersVerdict);
  assert.equal(ownersVerdict.pass, false);
  assert.equal(ownersVerdict.live.length, 1);
});

test("P3: landingVerdicts passes owners-destroyed on teardown when seen owner rows have live === 0", () => {
  const record = {
    cell: "E-T-water",
    renderer: "webgpu",
    page: "teardown",
    run: 0,
    notRun: null,
    deviceLoss: {
      deviceLost: null,
      consoleErrors: { pageErrors: [] },
      owners: {
        after: [
          { label: "Owner1", seen: true, created: 5, destroyed: 5, live: 0 },
        ],
      },
    },
  };
  const verdicts = landingVerdicts([record], null);
  const ownersVerdict = verdicts.find((v) =>
    v.id.endsWith(":owners-destroyed"),
  );
  assert.ok(ownersVerdict);
  assert.equal(ownersVerdict.pass, true);
  assert.equal(ownersVerdict.live.length, 0);
});

test("P3: landingVerdicts does not fail owners-destroyed for unseen owner rows with live === 0", () => {
  const record = {
    cell: "E-T-water",
    renderer: "webgpu",
    page: "teardown",
    run: 0,
    notRun: null,
    deviceLoss: {
      deviceLost: null,
      consoleErrors: { pageErrors: [] },
      owners: {
        after: [
          {
            label: "UnseenOwner",
            seen: false,
            created: 0,
            destroyed: 0,
            live: 0,
          },
        ],
      },
    },
  };
  const verdicts = landingVerdicts([record], null);
  const ownersVerdict = verdicts.find((v) =>
    v.id.endsWith(":owners-destroyed"),
  );
  assert.ok(ownersVerdict);
  assert.equal(ownersVerdict.pass, true);
});

test("P3: landingVerdicts produces no PF verdicts when comparison is absent", () => {
  const record = {
    cell: "E-O",
    renderer: "webgpu",
    page: "scene",
    run: 0,
    notRun: null,
    gate: { deviceLost: null },
  };
  const verdicts = landingVerdicts([record], null);
  const pfVerdicts = verdicts.filter((v) => v.id.includes(":PF-"));
  assert.equal(pfVerdicts.length, 0);
});

test("P3: landingVerdicts passes PF verdicts only on within and fails on over or unmeasured", () => {
  const comparison = {
    "E-O|webgpu|scene": {
      pf1: { metric: "PF-1", verdict: "within" },
      pf2: { metric: "PF-2", verdict: "over" },
      pf3: { metric: "PF-3", verdict: "unmeasured" },
    },
  };
  const verdicts = landingVerdicts([], comparison);
  const pf1 = verdicts.find((v) => v.id.endsWith(":PF-1"));
  assert.ok(pf1);
  assert.equal(pf1.pass, true);
  assert.equal(pf1.verdict, "within");

  const pf2 = verdicts.find((v) => v.id.endsWith(":PF-2"));
  assert.ok(pf2);
  assert.equal(pf2.pass, false);
  assert.equal(pf2.verdict, "over");

  const pf3 = verdicts.find((v) => v.id.endsWith(":PF-3"));
  assert.ok(pf3);
  assert.equal(pf3.pass, false);
  assert.equal(pf3.verdict, "unmeasured");
});

// ---------------------------------------------------------------------------
// P3b: teardown owner destruction accounting
// ---------------------------------------------------------------------------

test("P3b: owners-destroyed passes when all seen owner rows have live 0 via explicit destroy", () => {
  const record = {
    cell: "E-T-water",
    renderer: "webgpu",
    page: "teardown",
    run: 0,
    notRun: null,
    deviceLoss: {
      deviceLost: null,
      consoleErrors: { pageErrors: [] },
      owners: {
        after: [
          {
            label: "WaterBuffer",
            seen: true,
            created: 4,
            destroyed: 4,
            freedByDevice: 0,
            live: 0,
          },
        ],
      },
    },
  };
  const verdicts = landingVerdicts([record], null);
  const verdict = verdicts.find((v) => v.id.endsWith(":owners-destroyed"));
  assert.ok(verdict);
  assert.equal(verdict.pass, true);
});

test("P3b: owners-destroyed passes when all seen owner rows have live 0 via freedByDevice", () => {
  const record = {
    cell: "E-T-water",
    renderer: "webgpu",
    page: "teardown",
    run: 0,
    notRun: null,
    deviceLoss: {
      deviceLost: null,
      consoleErrors: { pageErrors: [] },
      owners: {
        after: [
          {
            label: "WaterTexture",
            seen: true,
            created: 4,
            destroyed: 0,
            freedByDevice: 4,
            live: 0,
          },
        ],
      },
    },
  };
  const verdicts = landingVerdicts([record], null);
  const verdict = verdicts.find((v) => v.id.endsWith(":owners-destroyed"));
  assert.ok(verdict);
  assert.equal(verdict.pass, true);
});

test("P3b: owners-destroyed fails when any seen owner row has live > 0", () => {
  const record = {
    cell: "E-T-water",
    renderer: "webgpu",
    page: "teardown",
    run: 0,
    notRun: null,
    deviceLoss: {
      deviceLost: null,
      consoleErrors: { pageErrors: [] },
      owners: {
        after: [
          {
            label: "LeakingResource",
            seen: true,
            created: 5,
            destroyed: 2,
            freedByDevice: 1,
            live: 2,
          },
        ],
      },
    },
  };
  const verdicts = landingVerdicts([record], null);
  const verdict = verdicts.find((v) => v.id.endsWith(":owners-destroyed"));
  assert.ok(verdict);
  assert.equal(verdict.pass, false);
});

test("P3b: (ROUND 2) owners-destroyed verdict carries destroyed and freedByDevice per seen row", () => {
  const record = {
    cell: "E-T-water",
    renderer: "webgpu",
    page: "teardown",
    run: 0,
    notRun: null,
    deviceLoss: {
      deviceLost: null,
      consoleErrors: { pageErrors: [] },
      owners: {
        after: [
          {
            label: "ExplicitDestroyOwner",
            seen: true,
            created: 3,
            destroyed: 3,
            freedByDevice: 0,
            live: 0,
          },
          {
            label: "DeviceFreedOwner",
            seen: true,
            created: 4,
            destroyed: 0,
            freedByDevice: 4,
            live: 0,
          },
        ],
      },
    },
  };
  const verdicts = landingVerdicts([record], null);
  const verdict = verdicts.find((v) => v.id.endsWith(":owners-destroyed"));
  assert.ok(verdict);

  const rows = verdict.owners ?? verdict.rows;
  assert.ok(
    Array.isArray(rows),
    "owners-destroyed verdict must carry an array of seen owner rows (owners or rows)",
  );
  const explicit = rows.find((r) => r.label === "ExplicitDestroyOwner");
  assert.ok(explicit, "must carry explicit destroy owner row");
  assert.equal(explicit.destroyed, 3);
  assert.equal(explicit.freedByDevice, 0);

  const deviceFreed = rows.find((r) => r.label === "DeviceFreedOwner");
  assert.ok(deviceFreed, "must carry device freed owner row");
  assert.equal(deviceFreed.destroyed, 0);
  assert.equal(deviceFreed.freedByDevice, 4);
});
