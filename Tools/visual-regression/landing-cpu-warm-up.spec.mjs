// landing-cpu-warm-up.spec.mjs - the machine-CPU warm-up before a landing PF run's first page. Pure Node: no browser, no GPU, no real sleep.
// @purpose Asserts lib/cpu-warm-up.mjs by what a receipt reader sees: when the warm-up releases, times out or skips, the note and samples it records, the PF verdicts it marks, and (through runProbe over the fake browser) the report's top-level warmUp.
// @status ACTIVE
//
// The sampler and the clock are injected: the fake clock advances one interval per sample, so no test compares
// two live machine readings and none sleeps.

import assert from "node:assert/strict";
import path from "node:path";
import test, { after, before } from "node:test";
import { mkLaneTmp, removeLaneTmp } from "../lib/lane-tmp.mjs";
import {
  WARM_UP_DEFAULTS,
  liveSamplerReads,
  markPfVerdicts,
  warmUpBeforeFirstArm,
} from "./lib/cpu-warm-up.mjs";
import { descriptor } from "./probe-landing-cells.mjs";
import { landingRunners } from "./fixtures/probe-landing-cells-support.mjs";

const INTERVAL = 1000;
const E_D_PLAN = [{ cell: "E-D" }, { cell: "E-D" }];

/**
 * Deps over a fixed series: each call returns the next value (the last one
 * repeats) and advances the fake clock one interval.
 */
function seriesDeps(series, extra = {}) {
  let clock = 5000;
  let calls = 0;
  const deps = {
    settleSamples: 3,
    intervalMs: INTERVAL,
    timeoutMs: 20000,
    ...extra,
    sampleCpu: async () => {
      const value = series[Math.min(calls, series.length - 1)];
      calls += 1;
      clock += INTERVAL;
      return value;
    },
    now: () => clock,
  };
  return { deps, calls: () => calls };
}

const run = (
  series,
  { options = { perf: true }, plan = E_D_PLAN, bands = {}, extra } = {},
) => {
  const seeded = seriesDeps(series, extra);
  return warmUpBeforeFirstArm({
    options,
    plan,
    bands,
    deps: seeded.deps,
  }).then((record) => ({ record, calls: seeded.calls }));
};

let TEMP_ROOT = "";
before(() => {
  TEMP_ROOT = mkLaneTmp("landing-cpu-warm-up-");
});
after(() => {
  removeLaneTmp(TEMP_ROOT);
});

test("warm-up defaults are 5 quiet samples, a 1 s interval and a 120 s time-out", () => {
  assert.deepEqual(WARM_UP_DEFAULTS, {
    settleSamples: 5,
    intervalMs: 1000,
    timeoutMs: 120000,
  });
  assert.equal(Object.isFrozen(WARM_UP_DEFAULTS), true);
});

test("releases on the sample that ends the first run of settleSamples quiet readings", async () => {
  // 80, 70 busy; 55, 50, 40 quiet (the third quiet one is sample index 4).
  const { record, calls } = await run([80, 70, 55, 50, 40, 10, 10]);
  assert.equal(record.status, "released");
  assert.equal(calls(), 5, "the sampler is not called after the release");
  assert.equal(record.sampleCount, 5);
  assert.deepEqual(
    record.samples.map((s) => s.pct),
    [80, 70, 55, 50, 40],
  );
  assert.deepEqual(
    record.samples.map((s) => s.atMs),
    [1000, 2000, 3000, 4000, 5000],
  );
  assert.equal(record.durationMs, 5000);
  assert.equal(record.releasedAtPct, 40);
  assert.equal(record.thresholdPct, 60);
  assert.equal(record.settleSamples, 3);
  assert.equal(record.intervalMs, INTERVAL);
  assert.equal(record.timeoutMs, 20000);
  assert.equal(
    record.note,
    "warm-up: released after 5 samples (5000 ms) at 40 %",
  );
});

test("a busy sample after quiet ones restarts the count", async () => {
  const { record } = await run([10, 10, 90, 10, 10, 10]);
  assert.equal(record.status, "released");
  assert.equal(record.sampleCount, 6);
  assert.equal(record.releasedAtPct, 10);
});

test("a reading exactly at the threshold is quiet; just above it is not", async () => {
  const atThreshold = await run([60, 60, 60]);
  assert.equal(atThreshold.record.status, "released");
  assert.equal(atThreshold.record.sampleCount, 3);

  const justAbove = await run([60, 60, 60.01, 60, 60, 60]);
  assert.equal(justAbove.record.status, "released");
  assert.equal(
    justAbove.record.sampleCount,
    6,
    "60.01 reset the streak so the release needs three more",
  );

  const alwaysAbove = await run([60.01], { extra: { timeoutMs: 8000 } });
  assert.equal(alwaysAbove.record.status, "timed-out");
});

test("a series that is never quiet times out at timeoutMs, returns, and records its samples", async () => {
  const { record, calls } = await run([95, 80, 77.456], {
    extra: { timeoutMs: 6000 },
  });
  assert.equal(record.status, "timed-out");
  assert.equal(
    calls(),
    6,
    "one sample per interval until the clock reaches the time-out",
  );
  assert.equal(record.sampleCount, 6);
  assert.equal(record.samples[0].pct, 95);
  assert.equal(record.releasedAtPct, 77.456);
  assert.equal(record.durationMs, 6000);
  assert.equal(record.note, "warm-up: timed out at 77.46 %");
});

test("a null sample (counters did not move) is not quiet and resets the streak", async () => {
  const { record } = await run([10, 10, null, 10, 10, 10]);
  assert.equal(record.status, "released");
  assert.equal(record.sampleCount, 6);
  assert.equal(record.samples[2].pct, null);

  const onlyNull = await run([null], { extra: { timeoutMs: 4000 } });
  assert.equal(onlyNull.record.status, "timed-out");
  assert.equal(onlyNull.record.releasedAtPct, null);
  assert.equal(onlyNull.record.note, "warm-up: timed out at n/a %");
});

test("the threshold follows the guard: --bands contendedCpuPct moves it", async () => {
  const stock = await run([50, 50, 50]);
  assert.equal(stock.record.status, "released");
  assert.equal(stock.record.thresholdPct, 60);

  const tight = await run([50], {
    bands: { contendedCpuPct: 40 },
    extra: { timeoutMs: 5000 },
  });
  assert.equal(tight.record.thresholdPct, 40);
  assert.equal(tight.record.status, "timed-out", "50 % is above a 40 % guard");

  const loose = await run([70, 70, 70], { bands: { contendedCpuPct: 80 } });
  assert.equal(loose.record.status, "released");
  assert.equal(loose.record.sampleCount, 3);
});

test("--no-warm-up skips: the sampler is never called and the note says so", async () => {
  const { record, calls } = await run([99], {
    options: { perf: true, noWarmUp: true },
  });
  assert.equal(record.status, "skipped");
  assert.equal(calls(), 0);
  assert.equal(record.sampleCount, 0);
  assert.equal(record.releasedAtPct, null);
  assert.equal(record.note, "warm-up: skipped (--no-warm-up)");
});

test("a plan with no PF cell and no --perf is not a PF run: no sampling", async () => {
  const { record, calls } = await run([99], { options: {}, plan: E_D_PLAN });
  assert.equal(record.status, "not-a-pf-run");
  assert.equal(calls(), 0);
  assert.equal(record.note, "warm-up: not a PF run");
});

test("a cell that forces its own PF window is a PF run unless --no-cell-perf", async () => {
  const plan = [{ cell: "E-FFT-ifft" }];
  const forced = await run([10, 10, 10], { options: {}, plan });
  assert.equal(forced.record.status, "released");
  assert.equal(forced.calls(), 3);

  const opted = await run([99], { options: { noCellPerf: true }, plan });
  assert.equal(opted.record.status, "not-a-pf-run");
  assert.equal(opted.calls(), 0);

  // --perf still makes it a PF run for every cell.
  const perf = await run([10, 10, 10], {
    options: { perf: true, noCellPerf: true },
    plan: E_D_PLAN,
  });
  assert.equal(perf.record.status, "released");
});

test("markPfVerdicts names both arms' warm-up on PF-1..PF-4 and changes nothing else", () => {
  const verdicts = [
    { id: "E-D:webgpu:PF-1", pass: true, verdict: "within" },
    { id: "E-D:webgpu:PF-2", pass: false, verdict: "regressed" },
    {
      id: "E-D:webgl:PF-3",
      pass: false,
      verdict: "unmeasured-contended",
      notRun: true,
      reason: "machine busy",
    },
    { id: "E-D:webgpu:PF-4", pass: true, verdict: "within" },
    { id: "E-D:webgpu:stage", pass: true },
    { id: "E-D:webgpu:no-uncaught-error", pass: true },
    { id: "E-D:webgpu:PF-10-extra", pass: true },
  ];
  const frozen = JSON.parse(JSON.stringify(verdicts));
  const marked = markPfVerdicts(verdicts, {
    tip: { note: "warm-up: released after 5 samples (5000 ms) at 40 %" },
    base: { note: "warm-up: timed out at 77 %" },
  });
  assert.deepEqual(verdicts, frozen, "the input is not mutated");
  assert.notEqual(marked, verdicts);
  assert.equal(marked.length, verdicts.length);
  const expected = {
    tip: "warm-up: released after 5 samples (5000 ms) at 40 %",
    base: "warm-up: timed out at 77 %",
  };
  for (const index of [0, 1, 2, 3]) {
    const { warmUp, ...rest } = marked[index];
    assert.deepEqual(
      warmUp,
      expected,
      `${verdicts[index].id} carries both notes`,
    );
    assert.deepEqual(
      rest,
      verdicts[index],
      `${verdicts[index].id} otherwise unchanged`,
    );
  }
  for (const index of [4, 5, 6]) {
    assert.deepEqual(marked[index], verdicts[index]);
    assert.equal("warmUp" in marked[index], false);
  }
});

test("markPfVerdicts says not recorded for an absent record (a base report from before the warm-up)", () => {
  const [marked, other] = markPfVerdicts(
    [
      { id: "E-D:webgpu:PF-1", pass: true },
      { id: "x:stage", pass: true },
    ],
    { tip: { note: "warm-up: skipped (--no-warm-up)" }, base: null },
  );
  assert.deepEqual(marked.warmUp, {
    tip: "warm-up: skipped (--no-warm-up)",
    base: "warm-up: not recorded",
  });
  assert.equal("warmUp" in other, false);
  const [none] = markPfVerdicts([{ id: "E-D:webgpu:PF-2", pass: true }], {
    tip: null,
    base: undefined,
  });
  assert.deepEqual(none.warmUp, {
    tip: "warm-up: not recorded",
    base: "warm-up: not recorded",
  });
});

// Through the probe: the receipt and the verdicts a reader opens. ----------------

const { p14Run } = landingRunners(() => TEMP_ROOT);

/** Runs the probe with `deps` on the descriptor, restoring it afterwards. */
async function probeWith(name, extraArgs, deps) {
  const had = Object.hasOwn(descriptor, "warmUpDeps");
  const previous = descriptor.warmUpDeps;
  descriptor.warmUpDeps = deps;
  try {
    return await p14Run(name, extraArgs);
  } finally {
    if (had) {
      descriptor.warmUpDeps = previous;
    } else {
      delete descriptor.warmUpDeps;
    }
  }
}

test("through runProbe --perf: the report's top-level warmUp carries status, samples and note", async () => {
  const seeded = seriesDeps([90, 20, 20, 20]);
  const { report, code } = await probeWith(
    "perf-warm-up",
    ["--perf", "--cells", "E-O"],
    seeded.deps,
  );
  assert.equal(code, 0);
  assert.equal(seeded.calls(), 4);
  const warmUp = report.warmUp ?? report.runtime?.warmUp;
  assert.ok(warmUp, "the receipt carries a top-level warmUp");
  assert.equal(warmUp.status, "released");
  assert.deepEqual(
    warmUp.samples.map((s) => s.pct),
    [90, 20, 20, 20],
  );
  assert.equal(warmUp.sampleCount, 4);
  assert.equal(
    warmUp.note,
    "warm-up: released after 4 samples (4000 ms) at 20 %",
  );
  const marked = (report.verdicts ?? report.runtime?.verdicts ?? []).filter(
    (v) => /:PF-[1-4]$/.test(v.id) && v.warmUp,
  );
  for (const verdict of marked) {
    assert.equal(verdict.warmUp.tip, warmUp.note);
    assert.equal(verdict.warmUp.base, "warm-up: not recorded");
  }
});

test("through runProbe --perf --no-warm-up: the report says skipped and the sampler never ran", async () => {
  const seeded = seriesDeps([90]);
  const { report } = await probeWith(
    "perf-no-warm-up",
    ["--perf", "--no-warm-up", "--cells", "E-O"],
    seeded.deps,
  );
  assert.equal(seeded.calls(), 0);
  const warmUp = report.warmUp ?? report.runtime?.warmUp;
  assert.equal(warmUp.status, "skipped");
  assert.equal(warmUp.sampleCount, 0);
  assert.equal(warmUp.note, "warm-up: skipped (--no-warm-up)");
});

test("through runProbe without --perf: a non-PF cell writes not-a-pf-run and takes no sample", async () => {
  const seeded = seriesDeps([90]);
  const { report } = await probeWith(
    "no-perf-warm-up",
    ["--cells", "E-O"],
    seeded.deps,
  );
  assert.equal(seeded.calls(), 0);
  const warmUp = report.warmUp ?? report.runtime?.warmUp;
  assert.equal(warmUp.status, "not-a-pf-run");
  assert.equal(warmUp.note, "warm-up: not a PF run");
});

test("through runProbe with --base-report: every PF verdict names the tip's and the base's warm-up", async () => {
  const baseSeries = seriesDeps([90, 90, 20, 20, 20]);
  const base = await probeWith(
    "pair-base",
    ["--perf", "--cells", "E-D", "--no-wait-pipelines"],
    baseSeries.deps,
  );
  const baseNote = "warm-up: released after 5 samples (5000 ms) at 20 %";
  assert.equal(base.report.warmUp.note, baseNote);

  const tipSeries = seriesDeps([10]);
  const tip = await probeWith(
    "pair-tip",
    [
      "--perf",
      "--cells",
      "E-D",
      "--no-wait-pipelines",
      "--base-report",
      path.join(TEMP_ROOT, "pair-base", "out", "landing-cells-report.json"),
    ],
    tipSeries.deps,
  );
  const tipNote = "warm-up: released after 3 samples (3000 ms) at 10 %";
  assert.equal(tip.report.warmUp.note, tipNote);
  const pf = tip.verdicts.filter((v) => /:PF-[1-4]$/.test(v.id));
  assert.ok(pf.length > 0, "the paired run produced PF verdicts");
  for (const verdict of pf) {
    assert.deepEqual(
      verdict.warmUp,
      { tip: tipNote, base: baseNote },
      verdict.id,
    );
  }
  for (const verdict of tip.verdicts.filter((v) => !/:PF-[1-4]$/.test(v.id))) {
    assert.equal("warmUp" in verdict, false, verdict.id);
  }
});

test("this spec leaves the descriptor as it found it", () => {
  assert.equal(descriptor.warmUpDeps, undefined);
});

// The seam: a fake-browser run never reads the machine. ------------------------

test("a fake-browser PF run takes the instant warm-up its launched browser carries, never the machine's CPU", async () => {
  for (const [name, args] of [
    ["seam-perf", ["--cells", "E-O", "--perf"]],
    ["seam-cell-perf", ["--cells", "E-FFT-ifft"]],
  ]) {
    const { report } = await p14Run(name, args);
    assert.equal(report.warmUp.status, "released", name);
    assert.equal(report.warmUp.sampler, "injected", name);
    assert.equal(report.warmUp.durationMs, 0, name);
    assert.deepEqual(report.warmUp.samples, [{ atMs: 0, pct: 0 }], name);
  }
  assert.equal(liveSamplerReads(), 0);
});

test("a run whose every page is a dive-gate or device-loss page runs no PF window, so --perf does not make it wait", async () => {
  const none = await run([10], {
    plan: [
      { cell: "E-DG-ellipsoid", kind: "dive-gate" },
      { cell: "E-T-water", kind: "device-loss" },
    ],
  });
  assert.equal(none.record.status, "not-a-pf-run");
  assert.equal(none.calls(), 0);
  const mixed = await run([10, 10, 10], {
    plan: [
      { cell: "E-DG-ellipsoid", kind: "dive-gate" },
      { cell: "E-D", kind: "capture" },
    ],
  });
  assert.equal(mixed.record.status, "released");
});

test("the run's work budget covers a full warm-up time-out on top of its pages", () => {
  const one = descriptor.workBudgetMs({ cells: "E-D" });
  const perCell = descriptor.workBudgetMs({ cells: "E-D,E-O" }) - one;
  assert.ok(perCell > 0);
  assert.equal(one - perCell, WARM_UP_DEFAULTS.timeoutMs);
});

test("no test in this spec read the live machine CPU", () => {
  assert.equal(liveSamplerReads(), 0);
});
