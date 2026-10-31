// probe-landing-cells-merge-pipelines.spec.mjs - report merging and the pipeline wait record. Pure Node: no browser, no GPU.
// @purpose Asserts the --merge-reports merge (P10), the pipelines-pending capture record, owner labels and streak contention (P13), and the per-cell wait and scene-page rules of the merge (P14 R1, R2a, R2b) of probe-landing-cells.
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
import { fileURLToPath } from "node:url";
import { mkLaneTmp, removeLaneTmp } from "../lib/lane-tmp.mjs";
import { PROBE_EXIT_CODES, ProbeRefusal } from "./lib/probe-runtime.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import { mergeLandingReports } from "./lib/metrics/merge-landing-reports.mjs";
import {
  compareArms,
  descriptor,
  groupArms,
  landingVerdicts,
  pagesWithMergedRuns,
  readComparisonInputs,
  readMergeReports,
} from "./probe-landing-cells.mjs";
import {
  writePng,
  pfRecord,
  reportOf,
  pfVerdicts,
  landingRunners,
} from "./fixtures/probe-landing-cells-support.mjs";

// A per-run root under this lane's namespace: two runs of this spec at once
// (two lanes, or a lane and the seat) must not share, or delete, each other's
// fixtures.
let TEMP_ROOT = "";

before(() => {
  TEMP_ROOT = mkLaneTmp("probe-landing-cells-merge-");
});

after(() => {
  removeLaneTmp(TEMP_ROOT);
});

const { p13Run } = landingRunners(() => TEMP_ROOT);

const MERGE_MODULE = fileURLToPath(
  new URL("./lib/metrics/merge-landing-reports.mjs", import.meta.url),
);

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
