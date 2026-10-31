// landing-startup-pipeline-wait.spec.mjs — PF-3 reads startup without the
// pending-pipeline wait and reads a WebGL band floor sized from same-build arms.
//
// @purpose Asserts that the PF-3 startup statistic excludes each repeat's recorded pipeline wait and reports the wait separately (per repeat and per arm), that a WebGPU arm whose wait is 3.5 s reads within the 2.5 s ceiling on its startup alone, that the same-build WebGL 2D figures of the KIT3 Edge receipt read within while a real 20 % regression reads over, that a base written before the wait was recorded falls back to the raw interval and says so, and that the page records of groupArms carry the wait into compareArms.
// @status ACTIVE
//
// Written from the observable contract over synthetic page records: the
// verdicts come from the real `startupVerdict`, `groupArms` and `compareArms`.
// The figures are the KIT3 receipt's (EDGE_RECEIPT_EOWYN_KIT3.md section 4):
// E-ID-2d WebGL 2167.6 ms against 2453.1 ms on one build, WebGPU startup
// containing a pending-pipeline wait of seconds.
//
// RUN: node --test Tools/visual-regression/landing-startup-pipeline-wait.spec.mjs

import assert from "node:assert/strict";
import test from "node:test";

import { compareArms } from "./lib/landing-verdicts.mjs";
import { groupArms } from "./lib/metrics/merge-landing-reports.mjs";
import {
  STARTUP_BAND_FLOOR_WEBGL,
  startupBandsFor,
} from "./lib/metrics/perf-band.mjs";
import { startupVerdict } from "./lib/metrics/startup-compile.mjs";

// The same compile tally on every run, so the compile statistic reads within.
const COMPILE = { shaderModules: { count: 3, syncMs: 12 } };

// One raw startup record: first frame at `firstFrameMs` after navigation, with
// `waitMs` of pending-pipeline wait inside it (undefined: not recorded).
const raw = (firstFrameMs, waitMs) => ({
  startup: {
    viewerReadyAtMs: 1500,
    stagedAtMs: firstFrameMs - 40,
    firstFrameAtMs: firstFrameMs,
    firstCloudFrameAtMs: null,
    tilesLoadedAtMs: firstFrameMs,
    outcome: "done",
  },
  compile: COMPILE,
  ...(waitMs === undefined ? {} : { pipelineWaitMs: waitMs }),
});

const verdict = (baseRuns, tipRuns, extra = {}) =>
  startupVerdict({ baseRuns, tipRuns, ...extra });

test("W1: a WebGPU arm with a 3.5 s pipeline wait and 1.6 s of startup reads within the 2.5 s ceiling, the wait reported beside it", () => {
  const result = verdict([raw(5132, 3500)], [raw(5100, 3500)], {
    renderer: "webgpu",
  });
  assert.equal(result.verdict, "within");
  assert.equal(result.field, "navigationToFirstFrameMs");
  assert.equal(result.startup.rule, "ceiling-and-band");
  assert.equal(result.startup.baseOverCeiling, false);
  assert.equal(result.startup.tip, 1600);
  assert.equal(result.startup.base, 1632);
  assert.equal(result.startup.tipMax, 1600);
  assert.equal(result.pipelineWait.basis, "wait-excluded");
  assert.equal(result.pipelineWait.tip.median, 3500);
  assert.deepEqual(result.pipelineWait.base.perRepeat, [3500]);
  assert.equal(result.startup.waitBasis, "wait-excluded");
});

test("W2: a longer wait with the same startup does not move the verdict", () => {
  const result = verdict([raw(5132, 3500)], [raw(6100, 4500)], {
    renderer: "webgpu",
  });
  assert.equal(result.verdict, "within");
  assert.equal(result.startup.tip, 1600);
  assert.equal(result.pipelineWait.tip.median, 4500);
  assert.equal(result.pipelineWait.base.median, 3500);
});

test("W3: a WebGPU startup that itself passes the ceiling reads over, whatever the wait", () => {
  const result = verdict([raw(5132, 3500)], [raw(6200, 3500)], {
    renderer: "webgpu",
  });
  assert.equal(result.startup.tip, 2700);
  assert.equal(result.verdict, "over");
});

test("W4: the same-build WebGL 2D figures of the KIT3 receipt (2167.6 against 2453.1) read within", () => {
  const result = verdict([raw(2167.6, 0)], [raw(2453.1, 0)], {
    renderer: "webgl",
  });
  assert.equal(result.verdict, "within");
  assert.equal(result.startup.bandSource, "startup-floor");
  assert.equal(result.startup.bandFraction, STARTUP_BAND_FLOOR_WEBGL);
  assert.ok(STARTUP_BAND_FLOOR_WEBGL > (2453.1 - 2167.6) / 2167.6);
  assert.equal(result.pipelineWait.tip.median, 0);
});

test("W5: the WebGPU floor stays 10 %, so the same 13.2 % move on a WebGPU arm reads over", () => {
  const result = verdict([raw(2167.6, 0)], [raw(2453.1, 0)], {
    renderer: "webgpu",
  });
  assert.equal(result.startup.bandFraction, 0.1);
  assert.equal(result.verdict, "over");
});

test("W6: a real 20 % regression reads over on both renderers", () => {
  const webgl = verdict([raw(2000, 0)], [raw(2400, 0)], { renderer: "webgl" });
  assert.equal(webgl.verdict, "over");
  assert.equal(webgl.startup.tipMax < 2500, true);
  const webgpu = verdict([raw(5100, 3500)], [raw(5420, 3500)], {
    renderer: "webgpu",
  });
  assert.equal(webgpu.startup.base, 1600);
  assert.equal(webgpu.startup.tip, 1920);
  assert.equal(webgpu.verdict, "over");
});

test("W7: a base written before the wait was recorded falls back to the raw interval on both arms, and the verdict says so", () => {
  const result = verdict([raw(5132, undefined)], [raw(5100, 3500)], {
    renderer: "webgpu",
  });
  assert.equal(result.pipelineWait.basis, "raw-fallback");
  assert.match(result.pipelineWait.reason, /not recorded for base repeat 0/);
  assert.equal(result.startup.waitBasis, "raw-fallback");
  assert.ok(result.startup.reasons.some((line) => /not recorded/.test(line)));
  assert.equal(result.startup.tip, 5100, "the tip is not adjusted alone");
  assert.equal(result.startup.base, 5132);
  assert.equal(result.startup.rule, "base-over-ceiling-banded");
  assert.deepEqual(result.pipelineWait.base.perRepeat, [null]);
});

test("W8: an interval that does not contain the wait is read as it is", () => {
  const result = verdict([raw(5132, 3500)], [raw(5100, 3500)], {
    renderer: "webgpu",
    field: "navigationToViewerMs",
  });
  assert.equal(result.pipelineWait.basis, "not-applicable");
  assert.equal(result.startup.tip, 1500);
});

test("W9: a repeat that never reached the first frame is still not dropped when the wait is excluded", () => {
  const failed = {
    ...raw(0, 3500),
    startup: {
      viewerReadyAtMs: 1500,
      stagedAtMs: 1600,
      firstFrameAtMs: null,
      firstCloudFrameAtMs: null,
      tilesLoadedAtMs: null,
      outcome: "deadline",
    },
  };
  const result = verdict([raw(5132, 3500)], [failed], { renderer: "webgpu" });
  assert.equal(result.verdict, "over");
});

test("W10: startupBandsFor gives WebGL its own floor unless the wave pre-registered one", () => {
  assert.equal(STARTUP_BAND_FLOOR_WEBGL, 0.15);
  assert.equal(startupBandsFor("webgl", undefined).startupBandFloor, 0.15);
  assert.equal(
    startupBandsFor("webgl", { startupBandFloor: 0.25 }).startupBandFloor,
    0.25,
  );
  assert.equal(startupBandsFor("webgpu", undefined), undefined);
  assert.deepEqual(startupBandsFor("webgpu", { repeatFactor: 3 }), {
    repeatFactor: 3,
  });
});

// A page record as the landing probe writes it.
const page = (renderer, run, firstFrameMs, pipelines) => ({
  cell: "E-ID-2d",
  rig: "default-2d-pinned",
  renderer,
  page: "scene",
  run,
  notRun: null,
  startup: raw(firstFrameMs).startup,
  compileAtStartup: COMPILE,
  cpu: { mean: 10, samples: [{ pct: 10 }, { pct: 12 }] },
  ...(pipelines === undefined ? {} : { pipelines }),
});

test("W11: groupArms carries the recorded wait into compareArms; no wait is 0, an older record is unrecorded", () => {
  const key = "E-ID-2d|webgpu|scene";
  const base = groupArms([
    page("webgpu", 0, 5132, { waitedMs: 3500 }),
    page("webgpu", 1, 5100, { waitedMs: 3480 }),
  ]);
  const tip = groupArms([page("webgpu", 0, 5200, { waitedMs: 3550 })]);
  const { pf3 } = compareArms(tip, base, {})[key];
  assert.equal(pf3.pipelineWait.basis, "wait-excluded");
  assert.equal(pf3.pipelineWait.base.median, 3490);
  assert.equal(pf3.pipelineWait.tip.median, 3550);
  assert.equal(pf3.startup.tip, 1650);
  assert.equal(pf3.verdict, "within");

  const noWait = groupArms([page("webgl", 0, 2300, null)]);
  assert.equal(noWait["E-ID-2d|webgl|scene"].inputs.pf3[0].pipelineWaitMs, 0);
  const old = groupArms([page("webgl", 0, 2300)]);
  assert.equal(
    old["E-ID-2d|webgl|scene"].inputs.pf3[0].pipelineWaitMs,
    undefined,
  );
  const mixed = compareArms(noWait, old, {})["E-ID-2d|webgl|scene"];
  assert.equal(mixed.pf3.pipelineWait.basis, "raw-fallback");
});

test("W12: compareArms gives a WebGL arm the WebGL floor, so the 13.2 % same-build move reads within there", () => {
  const webgl = (firstFrameMs) =>
    groupArms([page("webgl", 0, firstFrameMs, null)]);
  const read = compareArms(webgl(2453.1), webgl(2167.6), {})[
    "E-ID-2d|webgl|scene"
  ];
  assert.equal(read.pf3.verdict, "within");
  assert.equal(read.pf3.startup.bandFraction, STARTUP_BAND_FLOOR_WEBGL);
});
