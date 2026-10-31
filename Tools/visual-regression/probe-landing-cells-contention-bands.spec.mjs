// probe-landing-cells-contention-bands.spec.mjs - teardown, contention, pixel band and owner labels. Pure Node: no browser, no GPU.
// @purpose Asserts the Round 4 teardown terminal (P8), the CPU contention reading (P9), the WebGL pixel band (P11) and the --owner-labels forms (P12) of probe-landing-cells.
// @status ACTIVE
//
// One part of the probe-landing-cells spec, split by concern (row DX-KIT-LANDING-SPECS-OVER-SIZE); the
// test names and bodies are unchanged. The fixtures it shares with its siblings live in
// fixtures/probe-landing-cells-support.mjs. Written from _lane-out/BEHAVIOUR_CELOS.md and the lead
// additions named on each test.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import { mkLaneTmp, removeLaneTmp } from "../lib/lane-tmp.mjs";
import {
  PROBE_EXIT_CODES,
  ProbeRefusal,
  runProbe,
} from "./lib/probe-runtime.mjs";
import { makeFakeBrowser } from "./lib/landing-fake-browser.mjs";
import {
  WEBGL_PIXEL_FLOOR_FACTOR,
  compareArms,
  descriptor,
  groupArms,
  landingVerdicts,
  pixelBand,
  readOwnerLabels,
} from "./probe-landing-cells.mjs";
import { writePng, pfRecord } from "./fixtures/probe-landing-cells-support.mjs";

// A per-run root under this lane's namespace: two runs of this spec at once
// (two lanes, or a lane and the seat) must not share, or delete, each other's
// fixtures.
let TEMP_ROOT = "";

before(() => {
  TEMP_ROOT = mkLaneTmp("probe-landing-cells-bands-");
});

after(() => {
  removeLaneTmp(TEMP_ROOT);
});

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
