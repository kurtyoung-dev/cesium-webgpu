// probe-landing-cells.spec.mjs - lane KT round 2 (Enedwaith). Pure Node: no browser, no GPU.
// @purpose Drives probe-landing-cells pure helpers and runProbe on a stub browser, asserting planning, refusal, blocking dials, comparison, verdicts, and ROUND 2 offline query and teardown owner census reporting.
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

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import { encodeRgbaPng } from "../lib/png-rgba.mjs";
import {
  PROBE_EXIT_CODES,
  ProbeRefusal,
  runProbe,
  sha256,
} from "./lib/probe-runtime.mjs";
import { loadRigs } from "./lib/rig-registry.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import { makeFakeBrowser, makeSmallPng } from "./lib/landing-fake-browser.mjs";
import { landingStagePayload } from "./lib/landing-cell-stage.mjs";
import {
  PIPELINE_WAIT_MODES,
  pipelineWaitMismatches,
  pipelineWaitPlan,
  rigForPage,
  waitedForCell,
} from "./lib/landing-cell-table.mjs";
import { GLOBE_FRAGMENT_DEBUG_MODE_NAMES } from "./lib/globe-fragment-debug-dial.mjs";
import {
  crossPageVerdicts,
  crossRendererComparisons,
  kernelIdentityComparisons,
} from "./lib/metrics/landing-cross-page.mjs";
import { mergeLandingReports } from "./lib/metrics/merge-landing-reports.mjs";
import {
  DEFAULT_CELLS,
  LANDING_CELLS,
  WEBGL_PIXEL_FLOOR_FACTOR,
  allWaited,
  blockingDials,
  compareArms,
  descriptor,
  groupArms,
  landingVerdicts,
  pagesWithMergedRuns,
  pixelBand,
  planLandingCells,
  readComparisonInputs,
  readMergeReports,
  readOwnerLabels,
} from "./probe-landing-cells.mjs";

const TEMP_ROOT = path.join(os.tmpdir(), "cesium-lane", "enedwaith");

before(() => {
  fs.mkdirSync(TEMP_ROOT, { recursive: true });
});

after(() => {
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
});

// The fake browser lives in lib/landing-fake-browser.mjs (lane TAR-ALDARION).
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
  // E-2D-stages and E-CV-stages add six variant pages per renderer each.
  assert.equal(plan.length, 59);
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

// ---------------------------------------------------------------------------
// P4: runProbe integration with descriptor
// ---------------------------------------------------------------------------

test("P4: runProbe with clean stub returns exit code 0, array of cells, and receipt with arms key", async () => {
  const testDir = path.join(TEMP_ROOT, "p4-clean");
  fs.mkdirSync(testDir, { recursive: true });
  const out = path.join(testDir, "out");
  const log = {
    events: [],
    scripts: [],
    urls: [],
    selectors: [],
    contexts: [],
  };
  const fakeBrowser = makeFakeBrowser(log);

  const code = await runProbe(descriptor, {
    argv: [
      "--repository-root",
      testDir,
      "--output",
      out,
      "--runs",
      "1",
      "--cells",
      "E-O",
      "--no-serve-built",
    ],
    launch: async () => fakeBrowser,
    preflight: async () => ({ ok: true, records: [] }),
  });

  assert.equal(code, PROBE_EXIT_CODES.OK, "clean stub run must exit 0");

  const reportPath = path.join(out, "landing-cells-report.json");
  assert.ok(
    fs.existsSync(reportPath),
    "landing-cells-report.json must be written",
  );
  const receipt = JSON.parse(fs.readFileSync(reportPath, "utf8"));

  assert.ok(Array.isArray(receipt.pages), "receipt pages must be an array");
  assert.equal(receipt.pages.length, 1);
  assert.ok(
    Object.hasOwn(receipt.arms, "E-O|webgpu|scene"),
    "receipt.arms must have key E-O|webgpu|scene",
  );
  assert.equal(receipt.arms["E-O|webgpu|scene"].runs, 1);
  assert.equal(receipt.arms["E-O|webgpu|scene"].notRun.length, 0);
});

test("P4: runProbe with unapplied non-water dial returns exit code 1", async () => {
  const testDir = path.join(TEMP_ROOT, "p4-unapplied");
  fs.mkdirSync(testDir, { recursive: true });
  const out = path.join(testDir, "out");
  const log = {
    events: [],
    scripts: [],
    urls: [],
    selectors: [],
    contexts: [],
  };
  const fakeBrowser = makeFakeBrowser(log, { notApplied: ["msaaSamples"] });

  const code = await runProbe(descriptor, {
    argv: [
      "--repository-root",
      testDir,
      "--output",
      out,
      "--runs",
      "1",
      "--cells",
      "E-O",
      "--no-serve-built",
    ],
    launch: async () => fakeBrowser,
    preflight: async () => ({ ok: true, records: [] }),
  });

  assert.equal(code, 1, "unapplied dial run must exit 1");

  const reportPath = path.join(out, "landing-cells-report.json");
  assert.ok(fs.existsSync(reportPath));
  const receipt = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.equal(receipt.arms["E-O|webgpu|scene"].notRun.length, 1);
});

// ---------------------------------------------------------------------------
// P5: compareArms
// ---------------------------------------------------------------------------

test("P5: compareArms reports base absent when arm key is missing in base", () => {
  const tipArms = {
    "E-O|webgpu|scene": {
      captures: [],
      inputs: { pf1: [], pf2: [], pf3: [], pf4: [] },
      deviceLoss: [],
    },
  };
  const baseArms = {};
  const comparison = compareArms(tipArms, baseArms, {});
  assert.deepEqual(comparison["E-O|webgpu|scene"], { base: "absent" });
});

test("P5: compareArms diffs PNGs with tolerance 0 and reports changedPx === 0 for identical captures", () => {
  const testDir = path.join(TEMP_ROOT, "p5-identical");
  fs.mkdirSync(testDir, { recursive: true });
  const pngBase = path.join(testDir, "base.png");
  const pngTip = path.join(testDir, "tip.png");
  const buffer = makeSmallPng(4, 4, false);
  fs.writeFileSync(pngBase, buffer);
  fs.writeFileSync(pngTip, buffer);

  const key = "E-O|webgpu|scene";
  const tipArms = {
    [key]: {
      captures: [{ name: "tip-shot", path: pngTip }],
      inputs: { pf1: [], pf2: [], pf3: [], pf4: [] },
      deviceLoss: [],
    },
  };
  const baseArms = {
    [key]: {
      captures: [{ name: "base-shot", path: pngBase }],
      inputs: { pf1: [], pf2: [], pf3: [], pf4: [] },
      deviceLoss: [],
    },
  };

  const comparison = compareArms(tipArms, baseArms, {});
  const pixels = comparison[key].pixels;
  assert.ok(pixels);
  assert.equal(pixels.measured, true);
  assert.equal(pixels.tolerance, 0);
  assert.equal(pixels.changedPx, 0);
  assert.equal(pixels.base, "base-shot");
  assert.equal(pixels.tip, "tip-shot");
});

test("P5: compareArms diffs PNGs with tolerance 0 and reports changedPx > 0 for different captures", () => {
  const testDir = path.join(TEMP_ROOT, "p5-diff");
  fs.mkdirSync(testDir, { recursive: true });
  const pngBase = path.join(testDir, "base.png");
  const pngTip = path.join(testDir, "tip.png");
  fs.writeFileSync(pngBase, makeSmallPng(4, 4, false));
  fs.writeFileSync(pngTip, makeSmallPng(4, 4, true));

  const key = "E-O|webgpu|scene";
  const tipArms = {
    [key]: {
      captures: [{ name: "tip-shot", path: pngTip }],
      inputs: { pf1: [], pf2: [], pf3: [], pf4: [] },
      deviceLoss: [],
    },
  };
  const baseArms = {
    [key]: {
      captures: [{ name: "base-shot", path: pngBase }],
      inputs: { pf1: [], pf2: [], pf3: [], pf4: [] },
      deviceLoss: [],
    },
  };

  const comparison = compareArms(tipArms, baseArms, {});
  const pixels = comparison[key].pixels;
  assert.ok(pixels);
  assert.equal(pixels.measured, true);
  assert.equal(pixels.tolerance, 0);
  assert.equal(pixels.changedPx, 1);
});

test("P5: compareArms reports unmeasured when image dimensions differ", () => {
  const testDir = path.join(TEMP_ROOT, "p5-mismatch");
  fs.mkdirSync(testDir, { recursive: true });
  const pngBase = path.join(testDir, "base.png");
  const pngTip = path.join(testDir, "tip.png");
  fs.writeFileSync(pngBase, makeSmallPng(4, 4, false));
  fs.writeFileSync(pngTip, makeSmallPng(8, 8, false));

  const key = "E-O|webgpu|scene";
  const tipArms = {
    [key]: {
      captures: [{ name: "tip-shot", path: pngTip }],
      inputs: { pf1: [], pf2: [], pf3: [], pf4: [] },
      deviceLoss: [],
    },
  };
  const baseArms = {
    [key]: {
      captures: [{ name: "base-shot", path: pngBase }],
      inputs: { pf1: [], pf2: [], pf3: [], pf4: [] },
      deviceLoss: [],
    },
  };

  const comparison = compareArms(tipArms, baseArms, {});
  const pixels = comparison[key].pixels;
  assert.ok(pixels);
  assert.equal(pixels.measured, false);
  assert.match(pixels.reason, /size 4x4 vs 8x8/);
});

// ---------------------------------------------------------------------------
// P6: readComparisonInputs
// ---------------------------------------------------------------------------

test("P6: readComparisonInputs records bandsFile path and sha256", () => {
  const testDir = path.join(TEMP_ROOT, "p6-bands");
  fs.mkdirSync(testDir, { recursive: true });
  const bandsPath = path.join(testDir, "bands.json");
  const bandsData = JSON.stringify({ repeatFactor: 2.5 });
  fs.writeFileSync(bandsPath, bandsData);

  const result = readComparisonInputs({ bands: bandsPath });
  assert.ok(result.bandsFile);
  assert.equal(result.bandsFile.path, path.resolve(bandsPath));
  assert.equal(
    result.bandsFile.sha256,
    sha256(Buffer.from(bandsData)),
    "sha256 must match bytes of bands file",
  );
  assert.equal(result.bands.repeatFactor, 2.5);
});

test("P6: readComparisonInputs refuses base report with no arms with base-report-invalid", () => {
  const testDir = path.join(TEMP_ROOT, "p6-bad-base");
  fs.mkdirSync(testDir, { recursive: true });
  const baseReportPath = path.join(testDir, "bad-report.json");
  fs.writeFileSync(baseReportPath, JSON.stringify({ notArms: {} }));

  assert.throws(
    () => readComparisonInputs({ baseReport: baseReportPath }),
    (err) => {
      assert.ok(err instanceof ProbeRefusal);
      assert.equal(err.reason, "base-report-invalid");
      return true;
    },
  );
});

test("P6: readComparisonInputs parses valid base report and resolves bands", () => {
  const testDir = path.join(TEMP_ROOT, "p6-valid-base");
  fs.mkdirSync(testDir, { recursive: true });
  const baseReportPath = path.join(testDir, "valid-report.json");
  const baseReport = { arms: { "E-O|webgpu|scene": {} } };
  fs.writeFileSync(baseReportPath, JSON.stringify(baseReport));

  const result = readComparisonInputs({ baseReport: baseReportPath });
  assert.deepEqual(result.base, baseReport);
  assert.ok(result.bands);
  assert.equal(result.bandsFile, null);
});

// ---------------------------------------------------------------------------
// P7: page query parameters (ROUND 2)
// ---------------------------------------------------------------------------

test("P7: every page opened has renderer in its query", async () => {
  const testDir = path.join(TEMP_ROOT, "p7-renderer");
  fs.mkdirSync(testDir, { recursive: true });
  const out = path.join(testDir, "out");
  const log = {
    events: [],
    scripts: [],
    urls: [],
    selectors: [],
    contexts: [],
  };
  const fakeBrowser = makeFakeBrowser(log);

  const code = await runProbe(descriptor, {
    argv: [
      "--repository-root",
      testDir,
      "--output",
      out,
      "--runs",
      "1",
      "--cells",
      "E-O",
      "--no-serve-built",
    ],
    launch: async () => fakeBrowser,
    preflight: async () => ({ ok: true, records: [] }),
  });

  assert.equal(code, PROBE_EXIT_CODES.OK);
  assert.ok(log.urls.length > 0, "at least one page navigation recorded");
  for (const pageUrl of log.urls) {
    const parsed = new URL(pageUrl);
    assert.equal(
      parsed.searchParams.get("renderer"),
      "webgpu",
      `query must have renderer=webgpu: ${pageUrl}`,
    );
  }
});

test("P7: (ROUND 2) every page opened has offline=true in its query", async () => {
  const testDir = path.join(TEMP_ROOT, "p7-offline");
  fs.mkdirSync(testDir, { recursive: true });
  const out = path.join(testDir, "out");
  const log = {
    events: [],
    scripts: [],
    urls: [],
    selectors: [],
    contexts: [],
  };
  const fakeBrowser = makeFakeBrowser(log);

  const code = await runProbe(descriptor, {
    argv: [
      "--repository-root",
      testDir,
      "--output",
      out,
      "--runs",
      "1",
      "--cells",
      "E-O",
      "--no-serve-built",
    ],
    launch: async () => fakeBrowser,
    preflight: async () => ({ ok: true, records: [] }),
  });

  assert.equal(code, PROBE_EXIT_CODES.OK);
  assert.ok(log.urls.length > 0, "at least one page navigation recorded");
  for (const pageUrl of log.urls) {
    const parsed = new URL(pageUrl);
    assert.equal(
      parsed.searchParams.get("offline"),
      "true",
      `query must include offline=true: ${pageUrl}`,
    );
  }
});

// ---------------------------------------------------------------------------
// ROUND 4 (lead additions, Celos): F1 terminal, F3 contention, F4 merge,
// F5 pixel band, F6 owner labels.
// ---------------------------------------------------------------------------

/** A PNG whose first `changed` pixels are white. */
function writePng(file, changed = 0, width = 8, height = 8) {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < changed; i++) {
    pixels.set([255, 255, 255, 255], i * 4);
  }
  fs.writeFileSync(file, Buffer.from(encodeRgbaPng(pixels, width, height)));
  return file;
}

function census(liveBytes) {
  return {
    installed: true,
    textures: { created: 1, destroyed: 0, liveBytes, unknownSize: 0 },
    buffers: { created: 0, destroyed: 0, liveBytes: 0, unknownSize: 0 },
  };
}

/** One scene page record carrying every PF input and its machine CPU. */
function pfRecord({
  run,
  renderer = "webgpu",
  frameMs = 10,
  passMs = 1,
  firstFrameAtMs = 1500,
  cpu = 20,
  capture = null,
}) {
  return {
    run,
    cell: "E-D",
    rig: "default-3d-pinned",
    kind: "capture",
    renderer,
    page: "scene",
    notRun: null,
    startup: {
      viewerReadyAtMs: 200,
      stagedAtMs: 300,
      firstFrameAtMs,
      firstCloudFrameAtMs: null,
      tilesLoadedAtMs: null,
      outcome: "settled",
    },
    compileAtStartup: { shaderModules: { count: 1, syncMs: 10 } },
    perf: {
      frameTimes: { frameMs: new Array(60).fill(frameMs) },
      passCost: {
        available: true,
        enabled: true,
        frameAvgMs: passMs,
        frameCount: 60,
        passes: {},
        sampleLedgerBalanced: true,
      },
      census: { start: census(1000), end: census(1000) },
    },
    capture,
    cpu: cpu === null ? null : { mean: cpu, samples: [] },
    gate: { deviceLost: null },
  };
}

/** A landing-cells report as the runtime writes it (envelope "runtime"). */
function reportOf(pages, { md5 = "a".repeat(32), runs = 1 } = {}) {
  return {
    probe: "landing-cells",
    generatedAt: "2026-10-22T00:00:00.000Z",
    preflight: {
      ok: true,
      artifacts: descriptor.servedArtifacts.map((artifact) => ({
        path: artifact,
        disk: { md5 },
      })),
    },
    options: { runs },
    windows: { frames: 120, warmup: 30, passFrames: 60 },
    perf: true,
    pages,
    arms: groupArms(pages),
  };
}

function pfVerdicts(comparison) {
  const out = {};
  for (const [key, arm] of Object.entries(comparison)) {
    out[key] = ["pf1", "pf2", "pf3", "pf4"].map((pf) => [
      pf,
      arm[pf]?.verdict ?? null,
    ]);
  }
  return out;
}

// P8 (F1) -------------------------------------------------------------------

function teardownArm(threw) {
  return {
    renderer: "webgl",
    captures: [],
    inputs: { pf1: [], pf2: [], pf3: [], pf4: [], cpu: [] },
    deviceLoss: [
      {
        terminal: { action: "viewer.destroy", destroyed: false, threw },
        consoleErrors: { other: [] },
        deviceLost: null,
      },
    ],
  };
}

test("P8: (ROUND 4, F1) the teardown comparison reports threw: true with the message when viewer.destroy throws", () => {
  const key = "E-T-water|webgl|teardown";
  const message = "Failed to execute 'removeChild' on 'Node'";
  const comparison = compareArms(
    { [key]: teardownArm(message) },
    { [key]: teardownArm(message) },
    {},
  );
  const terminal = comparison[key].terminal;
  assert.equal(terminal.base[0].threw, true);
  assert.equal(terminal.tip[0].threw, true);
  assert.equal(terminal.tip[0].message, message);
  assert.equal(terminal.same, true);
});

test("P8: (ROUND 4, F1) a tip teardown that throws where the base returned is not the same terminal", () => {
  const key = "E-T-water|webgl|teardown";
  const comparison = compareArms(
    { [key]: teardownArm("boom") },
    { [key]: teardownArm(null) },
    {},
  );
  assert.equal(comparison[key].terminal.base[0].threw, false);
  assert.equal(comparison[key].terminal.tip[0].threw, true);
  assert.equal(comparison[key].terminal.same, false);
  const verdict = landingVerdicts([], comparison).find((v) =>
    v.id.endsWith(":terminal-as-base"),
  );
  assert.equal(verdict.pass, false);
});

// P9 (F3) -------------------------------------------------------------------

test("P9: (ROUND 4, F3) a contended arm reads unmeasured-contended on PF-1..PF-3 and never over, and its verdicts are NOT RUN", () => {
  // Tip is twice as slow on every PF statistic; one tip run had 75 % CPU.
  const base = groupArms([pfRecord({ run: 0 }), pfRecord({ run: 1 })]);
  const tip = groupArms([
    pfRecord({ run: 0, frameMs: 20, passMs: 2, firstFrameAtMs: 3000, cpu: 75 }),
    pfRecord({ run: 1, frameMs: 20, passMs: 2, firstFrameAtMs: 3000, cpu: 20 }),
  ]);
  const comparison = compareArms(tip, base, {});
  const arm = comparison["E-D|webgpu|scene"];
  assert.equal(arm.contention.status, "contended");
  assert.equal(arm.pf1.verdict, "unmeasured-contended");
  assert.equal(arm.pf2.verdict, "unmeasured-contended");
  assert.equal(arm.pf3.verdict, "unmeasured-contended");
  assert.equal(arm.pf1.statistics.p50.verdictIfUncontended, "over");
  // PF-4 is not guarded (the census does not depend on the machine).
  assert.equal(arm.pf4.verdict, "within");
  const verdicts = landingVerdicts([], comparison);
  for (const metric of ["PF-1", "PF-2", "PF-3"]) {
    const verdict = verdicts.find((v) => v.id.endsWith(`:${metric}`));
    assert.equal(verdict.pass, false);
    assert.equal(verdict.notRun, true);
    assert.equal(verdict.verdict, "unmeasured-contended");
  }
});

test("P9: (ROUND 4, F3) arms 20+ points apart in mean CPU are contended; a quiet pair keeps its over", () => {
  const base = groupArms([
    pfRecord({ run: 0, cpu: 5 }),
    pfRecord({ run: 1, cpu: 5 }),
  ]);
  const slowTip = (cpu) =>
    groupArms([
      pfRecord({ run: 0, frameMs: 20, cpu }),
      pfRecord({ run: 1, frameMs: 20, cpu }),
    ]);
  const apart = compareArms(slowTip(30), base, {})["E-D|webgpu|scene"];
  assert.equal(apart.contention.status, "contended");
  assert.equal(apart.pf1.verdict, "unmeasured-contended");
  const quiet = compareArms(slowTip(10), base, {})["E-D|webgpu|scene"];
  assert.equal(quiet.contention.status, "clear");
  assert.equal(quiet.pf1.verdict, "over");
});

test("P9: (ROUND 4, F3) a base report with no CPU reading (written before round 4) reads unmeasured", () => {
  const base = groupArms([
    pfRecord({ run: 0, cpu: null }),
    pfRecord({ run: 1, cpu: null }),
  ]);
  const tip = groupArms([pfRecord({ run: 0 }), pfRecord({ run: 1 })]);
  const arm = compareArms(tip, base, {})["E-D|webgpu|scene"];
  assert.equal(arm.contention.status, "unread");
  assert.equal(arm.pf1.verdict, "unmeasured");
  assert.equal(arm.pf1.statistics.p50.verdictIfUncontended, "within");
});

test("P9: (ROUND 4, F3) every page record and the receipt carry the machine CPU series", async () => {
  const testDir = path.join(TEMP_ROOT, "p9-cpu");
  fs.mkdirSync(testDir, { recursive: true });
  const out = path.join(testDir, "out");
  const log = {
    events: [],
    scripts: [],
    urls: [],
    selectors: [],
    contexts: [],
  };
  const code = await runProbe(descriptor, {
    argv: [
      "--repository-root",
      testDir,
      "--output",
      out,
      "--runs",
      "1",
      "--cells",
      "E-O",
      "--no-serve-built",
    ],
    launch: async () => makeFakeBrowser(log),
    preflight: async () => ({ ok: true, records: [] }),
  });
  assert.equal(code, PROBE_EXIT_CODES.OK);
  const receipt = JSON.parse(
    fs.readFileSync(path.join(out, "landing-cells-report.json"), "utf8"),
  );
  for (const series of [receipt.cpuSeries, receipt.pages[0].cpu]) {
    assert.ok(series, "a CPU series must be recorded");
    assert.ok(Array.isArray(series.samples));
    for (const field of ["mean", "p95", "max", "startedAt", "endedAt"]) {
      assert.ok(Object.hasOwn(series, field), `series has ${field}`);
    }
  }
  assert.equal(receipt.arms["E-O|webgpu|scene"].inputs.cpu.length, 1);
});

// P10 (F4) ------------------------------------------------------------------

test("P10: (ROUND 4, F4) merging two --runs 1 reports equals one --runs 2 report in every PF verdict and pixel band", () => {
  const dir = path.join(TEMP_ROOT, "p10-merge");
  fs.mkdirSync(dir, { recursive: true });
  const shot = (name, changed) => ({
    name,
    path: writePng(path.join(dir, `${name}.png`), changed),
  });
  // Base runs, base runs on WebGL, then tip runs; numbers differ per run so
  // a merge that dropped, reordered or duplicated a run would move a verdict.
  const baseRuns = [
    [
      pfRecord({
        run: 0,
        frameMs: 10,
        passMs: 1,
        cpu: 20,
        capture: shot("b0", 0),
      }),
      pfRecord({
        run: 0,
        renderer: "webgl",
        frameMs: 9,
        cpu: 20,
        capture: shot("bg0", 0),
      }),
    ],
    [
      pfRecord({
        run: 0,
        frameMs: 11,
        passMs: 1.2,
        cpu: 30,
        capture: shot("b1", 0),
      }),
      pfRecord({
        run: 0,
        renderer: "webgl",
        frameMs: 9.5,
        cpu: 30,
        capture: shot("bg1", 3),
      }),
    ],
  ];
  const tipRuns = [
    [
      pfRecord({
        run: 0,
        frameMs: 10.5,
        passMs: 1.1,
        cpu: 25,
        capture: shot("t0", 0),
      }),
      pfRecord({
        run: 0,
        renderer: "webgl",
        frameMs: 12,
        cpu: 25,
        capture: shot("tg0", 5),
      }),
    ],
    [
      pfRecord({
        run: 0,
        frameMs: 13,
        passMs: 1.5,
        cpu: 22,
        capture: shot("t1", 0),
      }),
      pfRecord({
        run: 0,
        renderer: "webgl",
        frameMs: 12,
        cpu: 22,
        capture: shot("tg1", 6),
      }),
    ],
  ];
  const asRun = (pages, run) => pages.map((page) => ({ ...page, run }));
  const twoRun = (runs) =>
    reportOf([...asRun(runs[0], 0), ...asRun(runs[1], 1)], { runs: 2 });
  const merged = (runs) =>
    mergeLandingReports([reportOf(runs[0]), reportOf(runs[1])]);

  // Merged base against a two-run tip, and a merged tip against a two-run base.
  const reference = compareArms(
    twoRun(tipRuns).arms,
    twoRun(baseRuns).arms,
    {},
  );
  const mergedBase = compareArms(
    twoRun(tipRuns).arms,
    merged(baseRuns).arms,
    {},
  );
  const mergedTip = compareArms(
    merged(tipRuns).arms,
    twoRun(baseRuns).arms,
    {},
  );
  assert.deepEqual(pfVerdicts(mergedBase), pfVerdicts(reference));
  assert.deepEqual(pfVerdicts(mergedTip), pfVerdicts(reference));
  // The whole comparison, statistics, floors and pixel bands included.
  assert.deepEqual(mergedBase, reference);
  assert.deepEqual(mergedTip, reference);
  // Non-vacuous: the reference carries both PF and pixel readings.
  const webgl = reference["E-D|webgl|scene"];
  assert.equal(webgl.pixels.band.floorPx, 3);
  assert.equal(merged(baseRuns).arms["E-D|webgpu|scene"].runs, 2);
  assert.deepEqual(
    merged(baseRuns).pages.map((page) => page.run),
    [0, 0, 1, 1],
  );
});

test("P10: (ROUND 4, F4) reports of different trees, windows or perf settings are never merged", () => {
  const pages = [pfRecord({ run: 0 })];
  assert.throws(
    () =>
      mergeLandingReports([
        reportOf(pages, { md5: "a".repeat(32) }),
        reportOf(pages, { md5: "b".repeat(32) }),
      ]),
    /different tree/,
  );
  const otherWindows = {
    ...reportOf(pages),
    windows: { frames: 60, warmup: 30, passFrames: 60 },
  };
  assert.throws(
    () => mergeLandingReports([reportOf(pages), otherWindows]),
    /windows/,
  );
  assert.throws(
    () =>
      mergeLandingReports([
        reportOf(pages),
        { ...reportOf(pages), perf: false },
      ]),
    /perf/,
  );
  assert.throws(
    () => mergeLandingReports([{ arms: {} }]),
    /not a landing-cells report/,
  );
});

test("P10: (ROUND 4, F4) --merge-reports refuses a prior report served from another tree", () => {
  const dir = path.join(TEMP_ROOT, "p10-refuse");
  fs.mkdirSync(path.join(dir, "Build", "CesiumUnminified"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(dir, "Build", "CesiumUnminified", "Cesium.js"),
    "tree A",
  );
  const prior = path.join(dir, "prior.json");
  fs.writeFileSync(prior, JSON.stringify(reportOf([pfRecord({ run: 0 })])));
  assert.throws(
    () =>
      readMergeReports({
        mergeReports: prior,
        repositoryRoot: dir,
        frames: 120,
        warmup: 30,
        passFrames: 60,
        perf: true,
        runs: 1,
      }),
    (error) => {
      assert.ok(error instanceof ProbeRefusal);
      assert.equal(error.reason, "merge-report-invalid");
      assert.match(error.message, /different tree/);
      return true;
    },
  );
});

test("P10: (ROUND 4, F4) --merge-reports puts the prior runs first and renumbers this invocation's after them", () => {
  const dir = path.join(TEMP_ROOT, "p10-fold");
  fs.mkdirSync(dir, { recursive: true });
  const prior = path.join(dir, "prior.json");
  const priorReport = reportOf([pfRecord({ run: 0, frameMs: 10 })]);
  priorReport.preflight = { ok: true, records: [] };
  fs.writeFileSync(prior, JSON.stringify(priorReport));
  const options = {
    mergeReports: prior,
    repositoryRoot: dir,
    frames: 120,
    warmup: 30,
    passFrames: 60,
    perf: true,
    runs: 1,
    // The prior report did not wait; E-D now waits by default (lane LINDISSE).
    noWaitPipelines: true,
  };
  const priors = readMergeReports(options);
  assert.equal(priors.length, 1);
  const pages = pagesWithMergedRuns(
    [pfRecord({ run: 0, frameMs: 12 })],
    options,
    priors,
  );
  assert.deepEqual(
    pages.map((page) => [page.run, page.perf.frameTimes.frameMs[0]]),
    [
      [0, 10],
      [1, 12],
    ],
  );
  assert.equal(groupArms(pages)["E-D|webgpu|scene"].runs, 2);
});

// P11 (F5) ------------------------------------------------------------------

test("P11: (ROUND 4, F5) a WebGL arm is within at changedPx <= 2 x the larger same-build repeat floor", () => {
  const dir = path.join(TEMP_ROOT, "p11-band");
  fs.mkdirSync(dir, { recursive: true });
  const arm = (name, changedRepeat) => ({
    captures: [
      { name: `${name}0`, path: writePng(path.join(dir, `${name}0.png`), 0) },
      {
        name: `${name}1`,
        path: writePng(path.join(dir, `${name}1.png`), changedRepeat),
      },
    ],
  });
  const baseArm = arm("base", 3);
  const tipArm = arm("tip", 2);
  assert.equal(WEBGL_PIXEL_FLOOR_FACTOR, 2);
  const at = pixelBand({ renderer: "webgl", changedPx: 6, baseArm, tipArm });
  assert.equal(at.floorPx, 3);
  assert.equal(at.limitPx, 6);
  assert.equal(at.verdict, "within");
  const over = pixelBand({ renderer: "webgl", changedPx: 7, baseArm, tipArm });
  assert.equal(over.verdict, "over");
});

test("P11: (ROUND 4, F5) a WebGPU arm keeps changedPx 0; a WebGL arm with no repeat is unmeasured unless identical", () => {
  assert.equal(
    pixelBand({ renderer: "webgpu", changedPx: 1, baseArm: {}, tipArm: {} })
      .verdict,
    "over",
  );
  assert.equal(
    pixelBand({ renderer: "webgpu", changedPx: 0, baseArm: {}, tipArm: {} })
      .verdict,
    "within",
  );
  const lone = { captures: [{ name: "x", path: "unused.png" }] };
  assert.equal(
    pixelBand({ renderer: "webgl", changedPx: 4, baseArm: lone, tipArm: lone })
      .verdict,
    "unmeasured",
  );
  assert.equal(
    pixelBand({ renderer: "webgl", changedPx: 0, baseArm: lone, tipArm: lone })
      .verdict,
    "within",
  );
});

test("P11: (ROUND 4, F5) compareArms carries the band and its verdict on a WebGL arm's pixels", () => {
  const dir = path.join(TEMP_ROOT, "p11-compare");
  fs.mkdirSync(dir, { recursive: true });
  const shots = (name, a, b) => [
    { name: `${name}0`, path: writePng(path.join(dir, `${name}0.png`), a) },
    { name: `${name}1`, path: writePng(path.join(dir, `${name}1.png`), b) },
  ];
  const key = "E-H|webgl|scene";
  const make = (captures) => ({
    renderer: "webgl",
    captures,
    inputs: { pf1: [], pf2: [], pf3: [], pf4: [], cpu: [] },
    deviceLoss: [],
  });
  const comparison = compareArms(
    { [key]: make(shots("tip", 4, 4)) },
    { [key]: make(shots("base", 0, 2)) },
    {},
  );
  const pixels = comparison[key].pixels;
  assert.equal(pixels.changedPx, 4);
  assert.equal(pixels.band.rule, "webgl-repeat-floor");
  assert.equal(pixels.band.floorPx, 2);
  assert.equal(pixels.band.limitPx, 4);
  assert.equal(pixels.verdict, "within");
});

// P12 (F6) ------------------------------------------------------------------

test("P12: (ROUND 4, F6) --owner-labels accepts the three forms and refuses a malformed one before the first page", () => {
  assert.deepEqual(
    readOwnerLabels({
      ownerLabels: "Global BathymetryTensorMap LUT,prefix:Globe ,re:^Ocean",
    }),
    ["Global BathymetryTensorMap LUT", "prefix:Globe ", "re:^Ocean"],
  );
  assert.throws(
    () => readOwnerLabels({ ownerLabels: "re:(" }),
    (error) => {
      assert.ok(error instanceof ProbeRefusal);
      assert.equal(error.reason, "owner-label-invalid");
      return true;
    },
  );
});

// P13 (ROUND 5, K5-1..K5-6) ---------------------------------------------------
// Lead additions (Celos, round 5), written from the seat's item text.

function p13Log() {
  return {
    events: [],
    scripts: [],
    urls: [],
    selectors: [],
    contexts: [],
    waits: [],
  };
}

async function p13Run(name, extraArgs, pipelines) {
  const testDir = path.join(TEMP_ROOT, name);
  fs.mkdirSync(testDir, { recursive: true });
  const out = path.join(testDir, "out");
  const log = p13Log();
  const code = await runProbe(descriptor, {
    argv: [
      "--repository-root",
      testDir,
      "--output",
      out,
      "--runs",
      "1",
      "--cells",
      "E-O",
      "--no-serve-built",
      ...extraArgs,
    ],
    launch: async () => makeFakeBrowser(log, { pipelines }),
    preflight: async () => ({ ok: true, records: [] }),
  });
  const receipt = JSON.parse(
    fs.readFileSync(path.join(out, "landing-cells-report.json"), "utf8"),
  );
  return { code, receipt, log };
}

test("P13: (ROUND 5, K5-2) a capture taken with pipelines pending is recorded on the capture and listed in the receipt", async () => {
  const { code, receipt, log } = await p13Run("p13-pending", [], {
    pending: 5,
  });
  assert.equal(code, PROBE_EXIT_CODES.OK);
  assert.equal(receipt.waitForPendingPipelines, false);
  assert.equal(log.waits.length, 0, "no wait unless --wait-pipelines");
  const page = receipt.pages[0];
  assert.equal(page.pipelines, null);
  assert.equal(page.capture.pipelinesPending, 5);
  assert.deepEqual(receipt.capturesWhilePipelinesPending, [
    {
      page: "E-O:webgpu:scene:run0",
      capture: page.capture.name,
      pending: 5,
    },
  ]);
});

test("P13: (ROUND 5, K5-2) --wait-pipelines makes the stage wait and records the wait and the pending count at capture", async () => {
  const { code, receipt, log } = await p13Run(
    "p13-wait",
    ["--wait-pipelines"],
    { pending: 0 },
  );
  assert.equal(code, PROBE_EXIT_CODES.OK);
  assert.equal(receipt.waitForPendingPipelines, true);
  assert.equal(log.waits.length, 1, "one wait per page");
  assert.equal(typeof log.waits[0].readerSource, "string");
  const page = receipt.pages[0];
  assert.equal(page.pipelines.requested, true);
  assert.equal(page.pipelines.pendingAtStart, 5);
  assert.equal(page.pipelines.framesWaited, 7);
  assert.equal(page.pipelines.timedOut, false);
  assert.equal(page.pipelines.pendingAtCapture, 0);
  assert.deepEqual(receipt.capturesWhilePipelinesPending, []);
});

test("P13: (ROUND 5, K5-2) a run that waited is never compared or merged with one that did not", () => {
  const dir = path.join(TEMP_ROOT, "p13-mismatch");
  fs.mkdirSync(dir, { recursive: true });
  const baseReport = path.join(dir, "base.json");
  // A base whose E-D page waited, read by a run that waives the wait (lane
  // LINDISSE: the check is per cell, and E-D waits by default).
  fs.writeFileSync(
    baseReport,
    JSON.stringify({
      arms: {},
      pages: [pfRecord({ run: 0 })],
      waitForPendingPipelines: true,
    }),
  );
  assert.throws(
    () => readComparisonInputs({ baseReport, noWaitPipelines: true }),
    (error) =>
      error instanceof ProbeRefusal &&
      error.reason === "base-report-invalid" &&
      /waitForPendingPipelines/.test(error.message),
  );
  assert.doesNotThrow(() =>
    readComparisonInputs({ baseReport, waitPipelines: true }),
  );
  assert.doesNotThrow(() => readComparisonInputs({ baseReport }));
  const pages = [pfRecord({ run: 0 })];
  assert.throws(
    () =>
      mergeLandingReports([
        reportOf(pages),
        { ...reportOf(pages), waitForPendingPipelines: true },
      ]),
    /waitForPendingPipelines/,
  );
});

test("P13: (ROUND 5, N-1) a report --merge-reports wrote merges again with its runs numbered in order", () => {
  const once = mergeLandingReports([
    reportOf([pfRecord({ run: 0, frameMs: 10 })]),
    reportOf([pfRecord({ run: 0, frameMs: 11 })]),
  ]);
  // What the probe writes after a merge: options.runs is the invocation's 1.
  const written = { ...reportOf(once.pages), options: { runs: 1 } };
  const twice = mergeLandingReports([
    written,
    reportOf([pfRecord({ run: 0, frameMs: 12 })]),
  ]);
  assert.deepEqual(
    twice.pages.map((page) => [page.run, page.perf.frameTimes.frameMs[0]]),
    [
      [0, 10],
      [1, 11],
      [2, 12],
    ],
  );
  assert.equal(twice.mergedFrom[1].firstRun, 2);
});

test("P13: (ROUND 5, K5-3) a live pipeline row is reported in a teardown's owners but never fails owners-destroyed", () => {
  const record = (after) => ({
    cell: "E-T-water",
    renderer: "webgpu",
    page: "teardown",
    run: 0,
    notRun: null,
    deviceLoss: {
      deviceLost: null,
      consoleErrors: { pageErrors: [] },
      owners: { after },
    },
  });
  const pipelineRow = {
    label: "Globe terrain (ocean)",
    kind: "renderPipeline",
    seen: true,
    created: 2,
    destroyed: 0,
    freedByDevice: 0,
    live: 2,
  };
  const textureRow = {
    label: "Global BathymetryTensorMap LUT",
    kind: "texture",
    seen: true,
    created: 1,
    destroyed: 0,
    freedByDevice: 1,
    live: 0,
  };
  const verdict = landingVerdicts(
    [record([pipelineRow, textureRow])],
    null,
  ).find((v) => v.id.endsWith(":owners-destroyed"));
  assert.equal(verdict.pass, true);
  assert.deepEqual(verdict.live, []);
  assert.deepEqual(
    verdict.owners.map((row) => [row.kind, row.live]),
    [
      ["renderPipeline", 2],
      ["texture", 0],
    ],
  );
  // A live texture still fails it.
  const failing = landingVerdicts(
    [record([pipelineRow, { ...textureRow, freedByDevice: 0, live: 1 }])],
    null,
  ).find((v) => v.id.endsWith(":owners-destroyed"));
  assert.equal(failing.pass, false);
  assert.deepEqual(
    failing.live.map((row) => row.kind),
    ["texture"],
  );
});

test("P13: (ROUND 5, K5-6) a tip run with 10 consecutive busy samples is contended though its mean is clear", () => {
  const streak = (record, values) => ({
    ...record,
    cpu: {
      mean: values.reduce((a, b) => a + b, 0) / values.length,
      samples: values.map((pct, index) => ({ at: String(index), pct })),
    },
  });
  const quiet = new Array(30).fill(20);
  const busy = [...new Array(10).fill(80), ...new Array(20).fill(20)];
  const base = groupArms([
    streak(pfRecord({ run: 0 }), quiet),
    streak(pfRecord({ run: 1 }), quiet),
  ]);
  const tip = groupArms([
    streak(pfRecord({ run: 0 }), quiet),
    streak(pfRecord({ run: 1 }), busy),
  ]);
  const arm = compareArms(tip, base, {})["E-D|webgpu|scene"];
  assert.ok(arm.contention.tipMeanCpu < 60);
  assert.equal(arm.contention.status, "contended");
  assert.deepEqual(arm.contention.tipLongestRun, [0, 10]);
  assert.equal(arm.pf1.verdict, "unmeasured-contended");
});

test("P13: (ROUND 5, K5-6) a base report is regrouped from its pages, so its arms carry the CPU samples", () => {
  const dir = path.join(TEMP_ROOT, "p13-regroup");
  fs.mkdirSync(dir, { recursive: true });
  const busy = [...new Array(12).fill(90), 20];
  const page = {
    ...pfRecord({ run: 0 }),
    cpu: {
      mean: 30,
      samples: busy.map((pct, index) => ({ at: String(index), pct })),
    },
  };
  // Arms as a round-4 probe wrote them: no cpuSamples.
  const arms = groupArms([page]);
  delete arms["E-D|webgpu|scene"].inputs.cpuSamples;
  const baseReport = path.join(dir, "base.json");
  fs.writeFileSync(baseReport, JSON.stringify({ arms, pages: [page] }));
  const { base } = readComparisonInputs({ baseReport, noWaitPipelines: true });
  assert.deepEqual(base.arms["E-D|webgpu|scene"].inputs.cpuSamples, [busy]);
  const tip = groupArms([
    { ...pfRecord({ run: 0 }), cpu: { mean: 30, samples: [] } },
  ]);
  const arm = compareArms(tip, base.arms, {})["E-D|webgpu|scene"];
  assert.equal(arm.contention.status, "contended");
  assert.deepEqual(arm.contention.baseLongestRun, [12]);
});

// P14 (lane LINDISSE) --------------------------------------------------------
// Lead additions, written from the salvage-night Edge receipt's NOT RUN items
// (1-3, 5, 6) and its cold-capture findings (cells 1a and 2a).

const CROSS_MODULE = fileURLToPath(
  new URL("./lib/metrics/landing-cross-page.mjs", import.meta.url),
);
const TABLE_MODULE = fileURLToPath(
  new URL("./lib/landing-cell-table.mjs", import.meta.url),
);
const PROBE_MODULE = fileURLToPath(
  new URL("./probe-landing-cells.mjs", import.meta.url),
);

function p14Log() {
  return {
    ...p13Log(),
    sentinelReads: [],
    readbacks: [],
    evolvedReadbacks: [],
    clockSets: [],
    controls: [],
  };
}

async function p14Run(name, extraArgs, fakeOptions = {}, probe = descriptor) {
  const testDir = path.join(TEMP_ROOT, name);
  fs.mkdirSync(testDir, { recursive: true });
  const out = path.join(testDir, "out");
  const log = p14Log();
  const code = await runProbe(probe, {
    argv: [
      "--repository-root",
      testDir,
      "--output",
      out,
      "--runs",
      "1",
      "--no-serve-built",
      ...extraArgs,
    ],
    launch: async () => makeFakeBrowser(log, fakeOptions),
    preflight: async () => ({ ok: true, records: [] }),
  });
  const report = JSON.parse(
    fs.readFileSync(path.join(out, "landing-cells-report.json"), "utf8"),
  );
  const verdicts = report.verdicts ?? report.runtime?.verdicts ?? [];
  return { code, report, log, verdicts };
}

const verdictById = (verdicts, id) => verdicts.find((v) => v.id === id);

function readback(kernel, hash, overrides = {}) {
  return {
    available: true,
    accessor: "primitive._webgpuCache.displacementTexture",
    format: "rgba16float",
    width: 4,
    height: 4,
    sampleCount: 64,
    hash,
    min: -1,
    max: 1,
    mean: 0,
    nonFinite: 0,
    nonZero: 60,
    kernel,
    frameNumber: 12,
    simulationSeconds: 3,
    computePipelinesReady: true,
    ...overrides,
  };
}

const SAME_FIELDS = Object.freeze({
  displacements: [readback("stockham", "aa"), readback("pingpong", "aa")],
});

test("P14: the new cells name their rigs and pages and stay out of the default set", () => {
  const plan = (cells) =>
    planLandingCells({ cells }, rigsById).map((entry) => [
      entry.renderer,
      entry.page,
    ]);
  assert.deepEqual(plan("E-FFT-ifft"), [
    ["webgpu", "stockham"],
    ["webgpu", "pingpong"],
  ]);
  for (const cell of ["E-C-chukotka", "E-ID-2d", "E-ID-cv"]) {
    assert.deepEqual(plan(cell), [
      ["webgl", "scene"],
      ["webgpu", "scene"],
    ]);
  }
  assert.equal(LANDING_CELLS["E-FFT-ifft"].rig, "ocean-fft-patch-rebase");
  assert.equal(
    LANDING_CELLS["E-C-chukotka"].rig,
    "water-antimeridian-chukotka",
  );
  assert.equal(LANDING_CELLS["E-ID-2d"].rig, "default-2d-pinned");
  assert.equal(LANDING_CELLS["E-ID-cv"].rig, "default-columbus-pinned");
  for (const cell of ["E-D", "E-D-HDR", "E-ID-2d", "E-ID-cv"]) {
    assert.equal(LANDING_CELLS[cell].identity, true, cell);
  }
  for (const cell of ["E-FFT-ifft", "E-C-chukotka", "E-ID-2d", "E-ID-cv"]) {
    assert.ok(!DEFAULT_CELLS.includes(cell), cell);
  }
});

test("P14: a variant page stages its rig with the variant's dials, which the stage accepts; the 2D and CV rigs stage their scene mode", () => {
  const rig = rigsById.get("ocean-fft-patch-rebase");
  const before = JSON.stringify(rig);
  const pingpong = rigForPage(rig, { cell: "E-FFT-ifft", page: "pingpong" });
  assert.equal(pingpong.dials.waterOceanIfftKernel, "pingpong");
  assert.equal(pingpong.dials.waterOceanEnabled, true, "rig dials kept");
  assert.equal(JSON.stringify(rig), before, "the rig record is untouched");
  assert.equal(rigForPage(rig, { cell: "E-D", page: "scene" }), rig);
  assert.equal(
    landingStagePayload(pingpong).water.waterOceanIfftKernel,
    "pingpong",
  );
  assert.equal(
    landingStagePayload(rigsById.get("default-2d-pinned")).scene.sceneMode,
    "SCENE2D",
  );
  assert.equal(
    landingStagePayload(rigsById.get("default-columbus-pinned")).scene
      .sceneMode,
    "COLUMBUS_VIEW",
  );
  assert.doesNotThrow(() =>
    landingStagePayload(rigsById.get("water-antimeridian-chukotka")),
  );
});

test("P14: the pipeline wait is per cell: identity, E-M-water, Chukotka and ocean cells wait by default; the flags force or waive it; both together refuse", () => {
  const all = Object.keys(LANDING_CELLS).join(",");
  const byDefault = pipelineWaitPlan({ cells: all });
  assert.equal(byDefault.mode, PIPELINE_WAIT_MODES.CELL_DEFAULT);
  for (const cell of [
    "E-D",
    "E-D-HDR",
    "E-ID-2d",
    "E-ID-cv",
    "E-M-water",
    "E-C-chukotka",
    "E-FFT-ifft",
  ]) {
    assert.equal(byDefault.byCell[cell], true, cell);
  }
  for (const cell of ["E-O", "E-F", "E-G", "R-14", "E-T-water"]) {
    assert.equal(byDefault.byCell[cell], false, cell);
  }
  const forced = pipelineWaitPlan({ cells: all, waitPipelines: true });
  assert.equal(forced.mode, PIPELINE_WAIT_MODES.FORCED);
  assert.ok(Object.values(forced.byCell).every((w) => w === true));
  const waived = pipelineWaitPlan({ cells: all, noWaitPipelines: true });
  assert.equal(waived.mode, PIPELINE_WAIT_MODES.WAIVED);
  assert.ok(Object.values(waived.byCell).every((w) => w === false));
  assert.throws(
    () => readComparisonInputs({ waitPipelines: true, noWaitPipelines: true }),
    (error) =>
      error instanceof ProbeRefusal &&
      error.reason === "pipeline-wait-conflict",
  );
  assert.equal(allWaited({ "E-D": true, "E-ID-2d": true }), true);
  assert.equal(allWaited({ "E-D": true, "E-O": false }), false);
  assert.equal(allWaited({}), false);
});

test("P14: a report's wait is read per cell, falling back to the run-wide flag, and two reports mismatch only on a cell both cover", () => {
  assert.equal(waitedForCell({ waitForPendingPipelines: true }, "E-D"), true);
  assert.equal(
    waitedForCell(
      { waitForPendingPipelines: true, pipelineWaitByCell: { "E-D": false } },
      "E-D",
    ),
    false,
  );
  const old = { pages: [pfRecord({ run: 0 })] };
  const now = { pipelineWaitByCell: { "E-D": true, "E-O": false } };
  assert.deepEqual(pipelineWaitMismatches(old, now), ["E-D"]);
  assert.deepEqual(
    pipelineWaitMismatches(
      { pipelineWaitByCell: { "E-O": true } },
      { pipelineWaitByCell: { "E-D": false } },
    ),
    [],
  );
  const pages = [pfRecord({ run: 0 })];
  assert.throws(
    () =>
      mergeLandingReports([
        { ...reportOf(pages), pipelineWaitByCell: { "E-D": true } },
        { ...reportOf(pages), pipelineWaitByCell: { "E-D": false } },
      ]),
    /waitForPendingPipelines/,
  );
  const merged = mergeLandingReports([
    { ...reportOf(pages), pipelineWaitByCell: { "E-D": true } },
    { ...reportOf(pages), pipelineWaitByCell: { "E-D": true } },
  ]);
  assert.deepEqual(merged.pipelineWaitByCell, { "E-D": true });
});

test("P14: (mutant) a table whose wait default is unreachable leaves E-D unwaited", async () => {
  const mutated = await importMutated(TABLE_MODULE, [
    [
      "        LANDING_CELLS[cell].waitPipelines === true);",
      "        false && LANDING_CELLS[cell].waitPipelines === true);",
    ],
  ]);
  assert.equal(pipelineWaitPlan({ cells: "E-D" }).byCell["E-D"], true);
  assert.equal(mutated.pipelineWaitPlan({ cells: "E-D" }).byCell["E-D"], false);
});

test("P14: an identity cell waits by default, installs the onmessage sentinel before load and judges it; --no-wait-pipelines is recorded", async () => {
  const run = await p14Run("p14-identity", ["--cells", "E-D"]);
  assert.equal(run.code, PROBE_EXIT_CODES.OK);
  assert.equal(run.log.waits.length, 2, "one wait per renderer");
  assert.deepEqual(run.report.pipelineWait, {
    mode: "cell-default",
    byCell: { "E-D": true },
  });
  assert.equal(run.report.waitForPendingPipelines, true);
  assert.ok(
    run.log.scripts.some(
      (script) =>
        typeof script === "function" &&
        script.name === "installOnmessageSentinel",
    ),
    "the sentinel is an init script",
  );
  assert.equal(run.log.sentinelReads.length, 2);
  for (const renderer of ["webgl", "webgpu"]) {
    const verdict = verdictById(
      run.verdicts,
      `E-D:${renderer}:scene:run0:onmessage-unchanged`,
    );
    assert.ok(verdict, renderer);
    assert.equal(verdict.pass, true);
  }
  const waived = await p14Run("p14-identity-waived", [
    "--cells",
    "E-D",
    "--no-wait-pipelines",
  ]);
  assert.equal(waived.log.waits.length, 0);
  assert.equal(waived.report.pipelineWait.mode, "waived");
  assert.equal(waived.report.pipelineWaitByCell["E-D"], false);
});

test("P14: a hijacked window.onmessage fails the identity cell, even when the stage did not apply", async () => {
  const hijacked = {
    installed: true,
    before: null,
    after: {
      type: "function",
      name: "workerHandler",
      source: "function workerHandler(){}",
    },
    changed: true,
    assignments: 1,
    stacks: ["Error: onmessage assigned"],
  };
  const run = await p14Run("p14-hijack", ["--cells", "E-ID-2d"], {
    onmessage: hijacked,
    notApplied: ["sceneMode"],
  });
  assert.notEqual(run.code, PROBE_EXIT_CODES.OK);
  const verdict = verdictById(
    run.verdicts,
    "E-ID-2d:webgpu:scene:run0:onmessage-unchanged",
  );
  assert.equal(verdict.pass, false);
  assert.equal(verdict.after.name, "workerHandler");
  assert.equal(
    verdictById(run.verdicts, "E-ID-2d:webgpu:scene:run0:stage").notRun,
    true,
  );
});

test("P14: a non-identity cell neither installs nor judges the sentinel", async () => {
  const run = await p14Run("p14-no-sentinel", ["--cells", "E-O"]);
  assert.equal(run.log.sentinelReads.length, 0);
  assert.ok(
    !run.log.scripts.some((s) => s?.name === "installOnmessageSentinel"),
  );
  assert.ok(!run.verdicts.some((v) => v.id.endsWith(":onmessage-unchanged")));
  assert.equal(run.report.pipelineWaitByCell["E-O"], false);
});

test("P14: E-FFT-ifft reads the displacement back after each kernel's capture and passes when the two fields are identical", async () => {
  const run = await p14Run(
    "p14-kernels",
    ["--cells", "E-FFT-ifft"],
    SAME_FIELDS,
  );
  assert.equal(run.code, PROBE_EXIT_CODES.OK);
  assert.deepEqual(
    run.log.readbacks.map((arg) => arg.frames),
    [8, 8],
  );
  assert.deepEqual(
    run.report.pages.map((page) => [page.page, page.capture.name]),
    [
      ["stockham", "E-FFT-ifft-webgpu-run0-stockham"],
      ["pingpong", "E-FFT-ifft-webgpu-run0-pingpong"],
    ],
  );
  assert.ok(
    run.report.pages.every((page) => page.perf),
    "the PF-1 / PF-2 window runs without --perf",
  );
  const verdict = verdictById(
    run.verdicts,
    "E-FFT-ifft:webgpu:run0:ifft-kernel-identity",
  );
  assert.equal(verdict.pass, true);
  assert.equal(run.report.kernelIdentity[0].comparison.identical, true);
  assert.equal(run.report.pipelineWaitByCell["E-FFT-ifft"], true);
});

test("P14: E-FFT-ifft fails on different fields and is NOT RUN when a readback is unavailable", async () => {
  const differ = await p14Run("p14-kernels-differ", ["--cells", "E-FFT-ifft"], {
    displacements: [readback("stockham", "aa"), readback("pingpong", "bb")],
  });
  const failed = verdictById(
    differ.verdicts,
    "E-FFT-ifft:webgpu:run0:ifft-kernel-identity",
  );
  assert.equal(failed.pass, false);
  assert.equal(failed.notRun, undefined);
  assert.notEqual(differ.code, PROBE_EXIT_CODES.OK);
  const missing = await p14Run(
    "p14-kernels-missing",
    ["--cells", "E-FFT-ifft"],
    {
      displacements: [
        readback("stockham", "aa"),
        { available: false, reason: "compute pipelines are not ready" },
      ],
    },
  );
  const notRun = verdictById(
    missing.verdicts,
    "E-FFT-ifft:webgpu:run0:ifft-kernel-identity",
  );
  assert.equal(notRun.pass, false);
  assert.equal(notRun.notRun, true);
});

test("P14: E-C-chukotka diffs the WebGPU capture against the same run's WebGL capture and records the band as unregistered", async () => {
  const run = await p14Run("p14-chukotka", ["--cells", "E-C-chukotka"]);
  assert.equal(run.code, PROBE_EXIT_CODES.OK);
  const [entry] = run.report.crossRenderer;
  assert.equal(entry.cell, "E-C-chukotka");
  assert.equal(entry.measured, true);
  assert.equal(entry.changedPx, 0);
  assert.match(entry.band, /first capture registers/);
  assert.equal(
    verdictById(run.verdicts, "E-C-chukotka:cross-renderer:run0:measured").pass,
    true,
  );
});

test("P14: the cross-renderer diff is NOT RUN without both captures, and the kernel pairs are judged per run", () => {
  const page = (renderer, capture) => ({
    cell: "E-C-chukotka",
    run: 0,
    renderer,
    page: "scene",
    notRun: capture ? null : "the stage did not apply terrain",
    capture,
  });
  const shot = (name) => ({ name, path: `${name}.png` });
  const diff = () => ({
    measured: true,
    changedPx: 42,
    mismatchPct: 0.5,
    bbox: null,
  });
  const measured = crossRendererComparisons(
    [page("webgl", shot("a")), page("webgpu", shot("b"))],
    { diff },
  );
  assert.equal(measured[0].changedPx, 42);
  assert.equal(measured[0].webgl, "a");
  const missing = crossRendererComparisons(
    [page("webgl", shot("a")), page("webgpu", null)],
    { diff },
  );
  assert.equal(missing[0].measured, false);
  assert.match(missing[0].reason, /webgpu \(the stage did not apply terrain\)/);
  const [verdict] = crossPageVerdicts({ crossRenderer: missing });
  assert.equal(verdict.pass, false);
  assert.equal(verdict.notRun, true);
  assert.deepEqual(
    crossRendererComparisons(
      [
        { ...page("webgl", shot("a")), cell: "E-D" },
        { ...page("webgpu", shot("b")), cell: "E-D" },
      ],
      { diff },
    ),
    [],
    "only crossRenderer cells are diffed",
  );
  const kernelPage = (run, name, hash) => ({
    cell: "E-FFT-ifft",
    run,
    renderer: "webgpu",
    page: name,
    displacement: readback(name, hash),
  });
  const pairs = kernelIdentityComparisons([
    kernelPage(0, "stockham", "aa"),
    kernelPage(0, "pingpong", "aa"),
    kernelPage(1, "stockham", "aa"),
    kernelPage(1, "pingpong", "cc"),
  ]);
  assert.deepEqual(
    pairs.map((pair) => [pair.run, pair.verdict.pass]),
    [
      [0, true],
      [1, false],
    ],
  );
});

const STAGES_CELLS = [
  ["E-2D-stages", "default-2d-pinned"],
  ["E-CV-stages", "default-columbus-pinned"],
];
const STAGE_PAGES = [
  "control",
  "no-drape",
  "fade",
  "atmo",
  "composite",
  "view-dir",
];

test("P15: the 2D and Columbus stage cells vary the globe fragment-debug dial over their pinned rigs, six pages per renderer, outside the default cells", () => {
  const modes = [
    "bypass-none",
    "bypass-drape",
    "fade-amount",
    "atmo-color",
    "post-composite-color",
    "view-dir",
  ];
  for (const [cell, rigId] of STAGES_CELLS) {
    const entry = LANDING_CELLS[cell];
    assert.equal(entry.rig, rigId);
    assert.equal(entry.kind, "capture");
    assert.equal(entry.crossRenderer, true);
    assert.equal(entry.waitPipelines, true);
    assert.ok(!DEFAULT_CELLS.includes(cell));
    assert.deepEqual(Object.keys(entry.variants), STAGE_PAGES);
    assert.deepEqual(
      Object.values(entry.variants).map((dials) => dials.globeFragmentDebug),
      modes,
    );
    for (const mode of modes) {
      assert.ok(GLOBE_FRAGMENT_DEBUG_MODE_NAMES.includes(mode), mode);
    }
    const plan = planLandingCells({ cells: cell }, rigsById);
    assert.deepEqual(
      plan.map((p) => [p.renderer, p.page]),
      ["webgl", "webgpu"].flatMap((renderer) =>
        STAGE_PAGES.map((page) => [renderer, page]),
      ),
    );
    // A variant page stages the rig with its mode laid over the rig's dials.
    const rig = rigsById.get(rigId);
    const staged = rigForPage(rig, { cell, page: "fade" });
    const payload = landingStagePayload(staged);
    assert.equal(payload.globe.globeFragmentDebug, "fade-amount");
    assert.equal(payload.scene.sceneMode, rig.dials.sceneMode);
    assert.equal(rig.dials.globeFragmentDebug, undefined, "rig untouched");
  }
});

// A page record of the cross-renderer metric; the capture name tells which
// pair a diff received.
const crossPage = (cell, run, renderer, page) => ({
  cell,
  run,
  renderer,
  page,
  capture: { name: `${renderer}-${page}-${run}`, path: "x.png" },
});
const stubDiff = () => {
  const calls = [];
  const diff = (a, b) => {
    calls.push([a.name, b.name]);
    return {
      measured: true,
      changedPx: calls.length,
      mismatchPct: 0.1,
      bbox: null,
    };
  };
  return { diff, calls };
};

test("P15: a cell without variants pairs exactly as before (literal derived by running the unchanged function)", () => {
  const { diff } = stubDiff();
  const page = (run, renderer, capture, extra = {}) => ({
    cell: "E-C-chukotka",
    run,
    renderer,
    page: "scene",
    capture,
    ...extra,
  });
  const out = crossRendererComparisons(
    [
      page(0, "webgl", { name: "a0" }),
      page(0, "webgpu", { name: "b0" }),
      page(1, "webgl", { name: "a1" }),
      page(1, "webgpu", null, { notRun: "no terrain" }),
    ],
    { diff },
  );
  assert.deepEqual(out, [
    {
      cell: "E-C-chukotka",
      run: 0,
      band: "unregistered (first capture registers)",
      webgl: "a0",
      webgpu: "b0",
      measured: true,
      changedPx: 1,
      mismatchPct: 0.1,
      bbox: null,
    },
    {
      cell: "E-C-chukotka",
      run: 1,
      band: "unregistered (first capture registers)",
      measured: false,
      reason: "no capture on webgpu (no terrain)",
    },
  ]);
  assert.deepEqual(
    crossPageVerdicts({ crossRenderer: out }).map((v) => v.id),
    [
      "E-C-chukotka:cross-renderer:run0:measured",
      "E-C-chukotka:cross-renderer:run1:measured",
    ],
  );
});

const stagePages = (cell, runs, { without = [] } = {}) =>
  runs.flatMap((run) =>
    ["webgl", "webgpu"].flatMap((renderer) =>
      STAGE_PAGES.filter(
        (name) => !(renderer === "webgpu" && without.includes(name)),
      ).map((name) => crossPage(cell, run, renderer, name)),
    ),
  );

async function assertVariantPairing(comparisons) {
  for (const [cell] of STAGES_CELLS) {
    const { diff, calls } = stubDiff();
    const out = comparisons(stagePages(cell, [0, 1]), { diff });
    assert.equal(out.length, 12, cell);
    assert.deepEqual(
      out.map((entry) => [entry.run, entry.page]),
      [0, 1].flatMap((run) => STAGE_PAGES.map((name) => [run, name])),
    );
    // Each entry paired the WebGL page of the same name with the WebGPU one.
    assert.deepEqual(
      calls,
      [0, 1].flatMap((run) =>
        STAGE_PAGES.map((name) => [
          `webgl-${name}-${run}`,
          `webgpu-${name}-${run}`,
        ]),
      ),
    );
    for (const entry of out) {
      assert.equal(entry.cell, cell);
      assert.equal(entry.measured, true);
      assert.equal(entry.webgl, `webgl-${entry.page}-${entry.run}`);
      assert.equal(entry.webgpu, `webgpu-${entry.page}-${entry.run}`);
    }
  }
}

test("P15: a variant cell pairs each WebGPU page with the WebGL page of the same name, per run, in table order", async () => {
  await assertVariantPairing(crossRendererComparisons);
});

test("P15: a missing WebGPU variant page is NOT RUN for that page only; verdict ids are unique per variant", () => {
  const { diff } = stubDiff();
  const out = crossRendererComparisons(
    stagePages("E-2D-stages", [0, 1], { without: ["atmo"] }),
    { diff },
  );
  assert.equal(out.length, 12);
  const unmeasured = out.filter((entry) => entry.measured !== true);
  assert.deepEqual(
    unmeasured.map((entry) => [entry.run, entry.page]),
    [
      [0, "atmo"],
      [1, "atmo"],
    ],
  );
  for (const entry of unmeasured) {
    assert.match(entry.reason, /no capture on webgpu \(no page\)/);
  }
  const verdicts = crossPageVerdicts({ crossRenderer: out });
  const ids = verdicts.map((verdict) => verdict.id);
  assert.equal(new Set(ids).size, 12, "one id per variant and run");
  assert.ok(ids.includes("E-2D-stages:fade:cross-renderer:run1:measured"));
  assert.deepEqual(
    verdicts
      .filter((verdict) => verdict.pass !== true)
      .map((verdict) => [verdict.id, verdict.notRun]),
    [
      ["E-2D-stages:atmo:cross-renderer:run0:measured", true],
      ["E-2D-stages:atmo:cross-renderer:run1:measured", true],
    ],
  );
});

test("P15: inertness mutant - variant cells collapsed to the first page per renderer turn the pairing checks red", async () => {
  const mutated = await importMutated(CROSS_MODULE, [
    ["? Object.keys(LANDING_CELLS[cell].variants)", "? [null]"],
  ]);
  await assert.rejects(
    assertVariantPairing(mutated.crossRendererComparisons),
    (error) => error instanceof assert.AssertionError,
  );
});

test("P14: (mutants) each wiring clause made unreachable loses the behaviour its test pins", async () => {
  const mutants = [
    {
      label: "sentinel never installed",
      anchor:
        "      if (cell.identity === true) {\n        // Before any page script",
      replacement:
        "      if (false && cell.identity === true) {\n        // Before any page script",
      cells: "E-D",
      lost: (run) =>
        !run.log.scripts.some((s) => s?.name === "installOnmessageSentinel"),
    },
    {
      label: "sentinel never read",
      anchor: "      if (cell.identity === true) {\n        record.onmessage",
      replacement:
        "      if (false && cell.identity === true) {\n        record.onmessage",
      cells: "E-D",
      lost: (run) =>
        !run.verdicts.some((v) => v.id.endsWith(":onmessage-unchanged")),
    },
    {
      label: "per-cell wait ignored",
      anchor:
        "          pipelineWaitPlan(options).byCell[entry.cell] === true,",
      replacement:
        "          false && pipelineWaitPlan(options).byCell[entry.cell] === true,",
      cells: "E-D",
      lost: (run) => run.log.waits.length === 0,
    },
    {
      label: "readback skipped",
      anchor: '        if (cell.readback === "ocean-displacement") {',
      replacement:
        '        if (false && cell.readback === "ocean-displacement") {',
      cells: "E-FFT-ifft",
      lost: (run) => run.log.readbacks.length === 0,
    },
    {
      label: "forced perf ignored",
      anchor:
        "          (cell.perf === true && options.noCellPerf !== true)) &&",
      replacement:
        "          (false && cell.perf === true && options.noCellPerf !== true)) &&",
      cells: "E-FFT-ifft",
      lost: (run) => run.report.pages.every((page) => !page.perf),
    },
    {
      label: "cross-page verdicts dropped",
      anchor: "      ...crossPageVerdicts({",
      replacement: "      ...[].concat(false && crossPageVerdicts({",
      close: true,
      cells: "E-FFT-ifft",
      lost: (run) =>
        !run.verdicts.some((v) => v.id.endsWith(":ifft-kernel-identity")),
    },
  ];
  for (const [index, mutant] of mutants.entries()) {
    const args = ["--cells", mutant.cells];
    const real = await p14Run(`p14-mut-real-${index}`, args, SAME_FIELDS);
    assert.equal(mutant.lost(real), false, `${mutant.label}: real keeps it`);
    const pairs = [[mutant.anchor, mutant.replacement]];
    if (mutant.close) {
      pairs.push([
        "        kernelIdentity: kernelIdentityComparisons(pages),\n      }),\n    ];",
        "        kernelIdentity: kernelIdentityComparisons(pages),\n      }) || []),\n    ];",
      ]);
    }
    const mutated = await importMutated(PROBE_MODULE, pairs);
    const run = await p14Run(
      `p14-mut-${index}`,
      args,
      SAME_FIELDS,
      mutated.descriptor,
    );
    assert.equal(mutant.lost(run), true, `${mutant.label}: mutant loses it`);
  }
});

// P14 round 2 (lane LINDISSE, review Tar-Palantir P1: R1, R2, R3a and the
// --no-cell-perf flag the seat asked for).

const MERGE_MODULE = fileURLToPath(
  new URL("./lib/metrics/merge-landing-reports.mjs", import.meta.url),
);

test("P14 R1: a per-cell wait mismatch names each report's own wait for the cell, and both refusals name the remedy", async () => {
  const pages = [pfRecord({ run: 0 })];
  const first = {
    ...reportOf(pages),
    waitForPendingPipelines: false,
    pipelineWaitByCell: { "E-D": true, "E-O": false },
  };
  const second = { ...reportOf(pages), pipelineWaitByCell: { "E-D": false } };
  const message = (merge) => {
    try {
      merge([first, second], { labels: ["first", "second"] });
    } catch (error) {
      return String(error.message);
    }
    return "";
  };
  const real = message(mergeLandingReports);
  assert.match(real, /E-D: second false, first true/);
  assert.match(real, /--no-wait-pipelines/);
  const mutated = await importMutated(MERGE_MODULE, [
    [
      "${name(0)} ${waitedForCell(first, cell)}",
      "${name(0)} ${first.waitForPendingPipelines === true}",
    ],
  ]);
  assert.doesNotMatch(
    message(mutated.mergeLandingReports),
    /E-D: second false, first true/,
    "the mutant prints the run-wide flag and is caught",
  );
  const dir = path.join(TEMP_ROOT, "p14-r1-base");
  fs.mkdirSync(dir, { recursive: true });
  const baseReport = path.join(dir, "base.json");
  fs.writeFileSync(baseReport, JSON.stringify({ arms: {}, pages }));
  assert.throws(
    () => readComparisonInputs({ baseReport, cells: "E-D" }),
    (error) =>
      error.reason === "base-report-invalid" &&
      /--no-wait-pipelines/.test(error.message) &&
      /re-capture the base/.test(error.message),
  );
});

test("P14 R2a: a variant page feeds PF-3 and the CPU guard like a scene page; an E-T page does not", async () => {
  const variant = {
    ...pfRecord({ run: 0 }),
    cell: "E-FFT-ifft",
    page: "stockham",
  };
  const teardown = {
    ...pfRecord({ run: 0 }),
    cell: "E-T-water",
    page: "teardown",
  };
  const check = (group) => {
    const arms = group([variant, teardown]);
    const kernel = arms["E-FFT-ifft|webgpu|stockham"];
    assert.equal(kernel.inputs.pf3.length, 1);
    assert.equal(kernel.inputs.cpu.length, 1);
    const tear = arms["E-T-water|webgpu|teardown"];
    assert.equal(tear.inputs.pf3.length, 0);
    assert.equal(tear.inputs.cpu.length, 0);
  };
  check(groupArms);
  const mutated = await importMutated(MERGE_MODULE, [
    [
      'const isScenePage = (page) => page !== "teardown" && page !== "forced-loss";',
      'const isScenePage = (page) => page === "scene";',
    ],
  ]);
  assert.throws(
    () => check(mutated.groupArms),
    (error) => error instanceof assert.AssertionError,
  );
});

test("P14 R2b: --merge-reports in the default wait mode merges with a prior report whose identity cell waited", async () => {
  const dir = path.join(TEMP_ROOT, "p14-r2b");
  fs.mkdirSync(dir, { recursive: true });
  const prior = path.join(dir, "prior.json");
  const priorReport = {
    ...reportOf([pfRecord({ run: 0, frameMs: 10 })]),
    waitForPendingPipelines: true,
    pipelineWaitByCell: { "E-D": true },
  };
  priorReport.preflight = { ok: true, records: [] };
  fs.writeFileSync(prior, JSON.stringify(priorReport));
  const options = {
    mergeReports: prior,
    repositoryRoot: dir,
    frames: 120,
    warmup: 30,
    passFrames: 60,
    perf: true,
    runs: 1,
    cells: "E-D",
  };
  const priors = readMergeReports(options);
  assert.equal(priors.length, 1);
  const own = [pfRecord({ run: 0, frameMs: 12 })];
  assert.deepEqual(
    pagesWithMergedRuns(own, options, priors).map((page) => page.run),
    [0, 1],
  );
  const mutated = await importMutated(MERGE_MODULE, [
    ["    pipelineWaitByCell: pipelineWaitPlan(options).byCell,\n", ""],
  ]);
  assert.throws(
    () =>
      mutated.pagesWithMergedRuns(
        own,
        options,
        priors,
        descriptor.servedArtifacts,
      ),
    /waitForPendingPipelines/,
    "without the per-cell record this invocation reads E-D as unwaited",
  );
});

test("P14 R3a: E-FFT-ifft reads the field with values, reports maxAbsDelta and the differing count, and writes no values", async () => {
  const run = await p14Run("p14-r3a", ["--cells", "E-FFT-ifft"], {
    displacements: [
      readback("stockham", "aa", { values: [0, 1, 2, 3] }),
      readback("pingpong", "bb", { values: [0, 1, 2.5, 3] }),
    ],
  });
  assert.equal(run.log.readbacks[0].includeValues, true);
  const [pair] = run.report.kernelIdentity;
  assert.equal(pair.comparison.identical, false);
  assert.equal(pair.comparison.maxAbsDelta, 0.5);
  assert.equal(pair.comparison.differingValues, 1);
  for (const page of run.report.pages) {
    assert.equal("values" in page.displacement, false, page.page);
  }
});

test("P14: --no-cell-perf drops the PF window E-FFT-ifft forces and keeps its readback identity", async () => {
  const run = await p14Run(
    "p14-no-cell-perf",
    ["--cells", "E-FFT-ifft", "--no-cell-perf"],
    SAME_FIELDS,
  );
  assert.equal(run.code, PROBE_EXIT_CODES.OK);
  assert.ok(run.report.pages.every((page) => !page.perf));
  assert.equal(run.log.readbacks.length, 2);
  assert.equal(
    verdictById(run.verdicts, "E-FFT-ifft:webgpu:run0:ifft-kernel-identity")
      .pass,
    true,
  );
});

test("P14 round 2: (mutants) the values read, the values kept out of the report and the --no-cell-perf flag each made inert lose their behaviour", async () => {
  const fields = () => ({
    displacements: [
      readback("stockham", "aa", { values: [0, 1] }),
      readback("pingpong", "aa", { values: [0, 1] }),
    ],
  });
  const mutants = [
    {
      label: "values not read",
      anchor: "              includeValues: true,",
      replacement: "              includeValues: false,",
      args: [],
      lost: (run) => run.log.readbacks[0].includeValues !== true,
    },
    {
      label: "values written",
      anchor: "          record.displacement = keepValuesOutOfReport(",
      replacement: "          record.displacement = ((record) => record)(",
      args: [],
      lost: (run) =>
        run.report.pages.some((page) => "values" in page.displacement),
    },
    {
      label: "--no-cell-perf inert",
      anchor: "(cell.perf === true && options.noCellPerf !== true)) &&",
      replacement: "(cell.perf === true && true)) &&",
      args: ["--no-cell-perf"],
      lost: (run) => run.report.pages.some((page) => page.perf),
    },
  ];
  for (const [index, mutant] of mutants.entries()) {
    const args = ["--cells", "E-FFT-ifft", ...mutant.args];
    const real = await p14Run(`p14-r2-real-${index}`, args, fields());
    assert.equal(mutant.lost(real), false, `${mutant.label}: real keeps it`);
    const mutated = await importMutated(PROBE_MODULE, [
      [mutant.anchor, mutant.replacement],
    ]);
    const run = await p14Run(
      `p14-r2-mut-${index}`,
      args,
      fields(),
      mutated.descriptor,
    );
    assert.equal(mutant.lost(run), true, `${mutant.label}: mutant loses it`);
  }
});
