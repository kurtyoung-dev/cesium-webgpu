// landing-perf-metrics-contention.spec.mjs - the machine-CPU sampler and contention guard. Pure Node: no browser, no GPU.
// @purpose Asserts the machine-CPU sampler (M8), the pre-registered contention guard on PF-1 to PF-3 (M9) and its 10-sample streak clause (M10) match the seat's item F3 and ruling S5.
// @status ACTIVE
//
// Covers behaviours M8-M10 of the original landing-perf-metrics spec, which was split by concern
// (row DX-KIT-LANDING-SPECS-OVER-SIZE); the test names and bodies are unchanged. Every assertion drives
// the real metric functions with pure in-memory inputs.

import assert from "node:assert/strict";
import test from "node:test";
import { frameTimeVerdict } from "./lib/metrics/frame-time-distribution.mjs";
import { passCostVerdict } from "./lib/metrics/gpu-pass-cost.mjs";
import {
  compareToBase,
  contentionGuard,
  guardStatistic,
  longestRunAbove,
  resolveBands,
  worstVerdict,
} from "./lib/metrics/perf-band.mjs";
import {
  busyPercent,
  mergeCpuSeries,
  readCpuTimes,
  startCpuSampler,
  summarizeCpuSamples,
} from "./lib/cpu-sampler.mjs";
import { startupVerdict } from "./lib/metrics/startup-compile.mjs";
import {
  makeRawStartupRecord,
  makePassCostResult,
} from "./fixtures/landing-perf-metrics-inputs.mjs";

// ---------------------------------------------------------------------------
// M8 (ROUND 4, F3): the machine-CPU sampler. Lead addition (Celos, round 4).
// ---------------------------------------------------------------------------

function fakeClockAndTimers() {
  const state = { now: Date.parse("2026-10-22T00:00:00.000Z"), tick: null };
  return {
    state,
    now: () => state.now,
    timers: {
      setInterval(fn) {
        state.tick = fn;
        return { unref() {} };
      },
      clearInterval() {
        state.tick = null;
      },
    },
    advance(ms) {
      state.now += ms;
      state.tick?.();
    },
  };
}

test("M8: (ROUND 4, F3) readCpuTimes sums busy and total over every logical CPU", () => {
  const times = readCpuTimes([
    { times: { user: 100, nice: 0, sys: 50, irq: 10, idle: 840 } },
    { times: { user: 300, nice: 0, sys: 100, irq: 0, idle: 600 } },
  ]);
  assert.deepEqual(times, { busy: 560, total: 2000 });
});

test("M8: (ROUND 4, F3) busyPercent is 100 x busy delta / total delta, null when nothing moved", () => {
  assert.equal(
    busyPercent({ busy: 0, total: 0 }, { busy: 75, total: 100 }),
    75,
  );
  assert.equal(
    busyPercent({ busy: 5, total: 10 }, { busy: 5, total: 10 }),
    null,
  );
});

test("M8: (ROUND 4, F3) the sampler takes one sample per interval and a last one at stop, with mean, p95 and max", () => {
  const clock = fakeClockAndTimers();
  // Busy share per interval: 20 %, 40 %, 60 %, then 80 % at stop.
  const readings = [
    { busy: 0, total: 0 },
    { busy: 20, total: 100 },
    { busy: 60, total: 200 },
    { busy: 120, total: 300 },
    { busy: 200, total: 400 },
  ];
  let index = 0;
  const sampler = startCpuSampler({
    intervalMs: 1000,
    readTimes: () => readings[index++],
    now: clock.now,
    timers: clock.timers,
  });
  clock.advance(1000);
  clock.advance(1000);
  clock.advance(1000);
  const result = sampler.stop();
  assert.deepEqual(
    result.samples.map((sample) => sample.pct),
    [20, 40, 60, 80],
  );
  assert.equal(result.n, 4);
  assert.equal(result.mean, 50);
  assert.equal(result.max, 80);
  assert.ok(Math.abs(result.p95 - 77) < 1e-9, `p95 ${result.p95}`);
  assert.equal(result.startedAt, "2026-10-22T00:00:00.000Z");
  assert.equal(result.endedAt, "2026-10-22T00:00:03.000Z");
  assert.equal(result.intervalMs, 1000);
  // stop() is idempotent and the timer is gone.
  assert.equal(sampler.stop(), result);
  assert.equal(clock.state.tick, null);
});

test("M8: (ROUND 4, F3) a window whose counters never moved has no sample and null statistics", () => {
  const clock = fakeClockAndTimers();
  const sampler = startCpuSampler({
    readTimes: () => ({ busy: 5, total: 10 }),
    now: clock.now,
    timers: clock.timers,
  });
  const result = sampler.stop();
  assert.equal(result.samples.length, 0);
  assert.equal(result.mean, null);
  assert.equal(result.p95, null);
  assert.equal(result.max, null);
  assert.deepEqual(summarizeCpuSamples([]), {
    n: 0,
    mean: null,
    p95: null,
    max: null,
  });
});

test("M8: (ROUND 4, F3) mergeCpuSeries orders samples in time and spans the earliest start to the latest end", () => {
  const merged = mergeCpuSeries([
    {
      samples: [{ at: "2026-10-22T00:00:05.000Z", pct: 30 }],
      startedAt: "2026-10-22T00:00:04.000Z",
      endedAt: "2026-10-22T00:00:06.000Z",
      intervalMs: 1000,
    },
    null,
    {
      samples: [{ at: "2026-10-22T00:00:01.000Z", pct: 10 }],
      startedAt: "2026-10-22T00:00:00.000Z",
      endedAt: "2026-10-22T00:00:02.000Z",
      intervalMs: 1000,
    },
  ]);
  assert.deepEqual(
    merged.samples.map((sample) => sample.pct),
    [10, 30],
  );
  assert.equal(merged.mean, 20);
  assert.equal(merged.startedAt, "2026-10-22T00:00:00.000Z");
  assert.equal(merged.endedAt, "2026-10-22T00:00:06.000Z");
  assert.equal(mergeCpuSeries([null, undefined]), null);
});

// ---------------------------------------------------------------------------
// M9 (ROUND 4, F3): the pre-registered contention guard on PF-1..PF-3.
// Lead addition (Celos, round 4).
// ---------------------------------------------------------------------------

test("M9: (ROUND 4, F3) contentionGuard is clear under 60 % per run and within 20 points between arms", () => {
  const guard = contentionGuard({ baseCpu: [30, 40], tipCpu: [45, 50] });
  assert.equal(guard.status, "clear");
  assert.equal(guard.baseMeanCpu, 35);
  assert.equal(guard.tipMeanCpu, 47.5);
  assert.equal(guard.armDeltaPct, 12.5);
  assert.equal(guard.contendedCpuPct, 60);
  assert.equal(guard.cpuArmDeltaPct, 20);
});

test("M9: (ROUND 4, F3) one run above 60 % on either arm is contended", () => {
  assert.equal(
    contentionGuard({ baseCpu: [30, 30], tipCpu: [30, 60.5] }).status,
    "contended",
  );
  assert.equal(
    contentionGuard({ baseCpu: [61, 30], tipCpu: [40, 40] }).status,
    "contended",
  );
  // Exactly at the threshold is not above it.
  assert.equal(
    contentionGuard({ baseCpu: [60, 50], tipCpu: [60, 50] }).status,
    "clear",
  );
});

test("M9: (ROUND 4, F3) arms whose mean CPU differs by more than 20 points are contended", () => {
  const guard = contentionGuard({ baseCpu: [5, 5], tipCpu: [30, 30] });
  assert.equal(guard.status, "contended");
  assert.equal(guard.armDeltaPct, 25);
  assert.ok(guard.reasons.some((reason) => reason.includes("25 points")));
  assert.equal(
    contentionGuard({ baseCpu: [10, 10], tipCpu: [30, 30] }).status,
    "clear",
  );
});

test("M9: (ROUND 4, F3) a run with no CPU reading leaves the guard unread", () => {
  assert.equal(
    contentionGuard({ baseCpu: [10, null], tipCpu: [10, 10] }).status,
    "unread",
  );
  assert.equal(
    contentionGuard({ baseCpu: undefined, tipCpu: [10] }).status,
    "unread",
  );
});

test("M9: (ROUND 4, F3) the thresholds are pre-registered bands a wave may override", () => {
  const bands = { contendedCpuPct: 80, cpuArmDeltaPct: 40 };
  assert.equal(
    contentionGuard({ baseCpu: [70, 70], tipCpu: [75, 75], bands }).status,
    "clear",
  );
  assert.equal(resolveBands(bands).contendedCpuPct, 80);
});

test("M9: (ROUND 4, F3) a contended PF-1 statistic that would read over reads unmeasured-contended, never over", () => {
  const contention = contentionGuard({ baseCpu: [20, 20], tipCpu: [75, 20] });
  const base = [new Array(50).fill(10), new Array(50).fill(10)];
  const tip = [new Array(50).fill(20), new Array(50).fill(20)];
  const uncontended = frameTimeVerdict({ baseRuns: base, tipRuns: tip });
  assert.equal(uncontended.verdict, "over");
  const result = frameTimeVerdict({ baseRuns: base, tipRuns: tip, contention });
  assert.equal(result.verdict, "unmeasured-contended");
  for (const statistic of ["p50", "p95", "p99"]) {
    assert.equal(result.statistics[statistic].verdict, "unmeasured-contended");
    assert.equal(result.statistics[statistic].verdictIfUncontended, "over");
    assert.equal(result.statistics[statistic].contention, "contended");
  }
});

test("M9: (ROUND 4, F3) a contended PF-1 statistic that would read within never reads within", () => {
  const contention = contentionGuard({ baseCpu: [20, 20], tipCpu: [45, 45] });
  const runs = [new Array(50).fill(10), new Array(50).fill(10)];
  const result = frameTimeVerdict({
    baseRuns: runs,
    tipRuns: runs,
    contention,
  });
  assert.equal(result.verdict, "unmeasured-contended");
  assert.equal(result.statistics.p50.verdictIfUncontended, "within");
});

test("M9: (ROUND 4, F3) a clear guard leaves PF-1 over as over, and an unread one makes it unmeasured", () => {
  const base = [new Array(50).fill(10), new Array(50).fill(10)];
  const tip = [new Array(50).fill(20), new Array(50).fill(20)];
  const clear = contentionGuard({ baseCpu: [20, 22], tipCpu: [25, 21] });
  assert.equal(
    frameTimeVerdict({ baseRuns: base, tipRuns: tip, contention: clear })
      .verdict,
    "over",
  );
  const unread = contentionGuard({ baseCpu: [20, 22], tipCpu: [25, null] });
  const result = frameTimeVerdict({
    baseRuns: base,
    tipRuns: tip,
    contention: unread,
  });
  assert.equal(result.verdict, "unmeasured");
  assert.equal(result.statistics.p95.verdictIfUncontended, "over");
});

test("M9: (ROUND 4, F3) PF-2 frame total and PF-3 startup (even a failed tip startup) read unmeasured-contended", () => {
  const contention = contentionGuard({ baseCpu: [20, 20], tipCpu: [90, 90] });
  const pf2 = passCostVerdict({
    baseRuns: [
      makePassCostResult({ frameAvgMs: 1 }),
      makePassCostResult({ frameAvgMs: 1 }),
    ],
    tipRuns: [
      makePassCostResult({ frameAvgMs: 4 }),
      makePassCostResult({ frameAvgMs: 4 }),
    ],
    contention,
  });
  assert.equal(pf2.total.verdict, "unmeasured-contended");
  assert.equal(pf2.total.verdictIfUncontended, "over");
  assert.equal(pf2.verdict, "unmeasured-contended");

  const pf3 = startupVerdict({
    baseRuns: [makeRawStartupRecord(), makeRawStartupRecord()],
    tipRuns: [
      makeRawStartupRecord({ firstCloudFrameAtMs: 4000 }),
      makeRawStartupRecord({ firstCloudFrameAtMs: null, outcome: "deadline" }),
    ],
    contention,
  });
  assert.equal(pf3.startup.verdict, "unmeasured-contended");
  assert.equal(pf3.startup.verdictIfUncontended, "over");
  assert.equal(pf3.compile.verdict, "unmeasured-contended");
  assert.equal(pf3.verdict, "unmeasured-contended");
});

test("M9: (ROUND 4, F3) guardStatistic without a guard leaves the record as it was", () => {
  const record = compareToBase({
    metric: "PF-1",
    statistic: "p50",
    baseRepeats: [10, 10],
    tipRepeats: [20, 20],
  });
  const copy = JSON.parse(JSON.stringify(record));
  assert.deepEqual(guardStatistic(record, undefined), copy);
});

test("M9: (ROUND 4, F3) worstVerdict ranks unmeasured-contended under over and above unmeasured", () => {
  assert.equal(
    worstVerdict([
      { verdict: "unmeasured" },
      { verdict: "unmeasured-contended" },
    ]),
    "unmeasured-contended",
  );
  assert.equal(
    worstVerdict([{ verdict: "over" }, { verdict: "unmeasured-contended" }]),
    "over",
  );
});

// ---------------------------------------------------------------------------
// M10: (ROUND 5, K5-6) the sample clause: any run of either arm with 10
// consecutive 1 Hz samples above 60 % reads contended, beside the mean and
// arm-delta clauses. Lead addition (Celos, round 5), from seat ruling S5.
// ---------------------------------------------------------------------------

const quiet = (n) => Array.from({ length: n }, () => 20);
const burst = (before, run, after, level = 61) => [
  ...quiet(before),
  ...Array.from({ length: run }, () => level),
  ...quiet(after),
];

test("M10: (ROUND 5, K5-6) longestRunAbove counts the longest strictly-above streak", () => {
  assert.equal(longestRunAbove([61, 61, 60, 61, 61, 61, 10], 60), 3);
  assert.equal(longestRunAbove([], 60), 0);
  assert.equal(longestRunAbove([61, null, 61], 60), 1);
  assert.equal(longestRunAbove(undefined, 60), null);
});

test("M10: (ROUND 5, K5-6) ten consecutive samples above 60 % in one run read contended though every mean is clear", () => {
  // Means: 20 / 20 (base) and 20 / 33.7 (tip): both mean clauses clear.
  const tipSamples = [quiet(30), burst(5, 10, 15)];
  const guard = contentionGuard({
    baseCpu: [20, 20],
    tipCpu: [20, 33.7],
    baseSamples: [quiet(30), quiet(30)],
    tipSamples,
  });
  assert.equal(guard.status, "contended");
  assert.equal(guard.sampleClause, "read");
  assert.deepEqual(guard.baseLongestRun, [0, 0]);
  assert.deepEqual(guard.tipLongestRun, [0, 10]);
  assert.equal(guard.contendedRunSamples, 10);
  assert.ok(
    guard.reasons.some((reason) => /10 or more consecutive/.test(reason)),
    JSON.stringify(guard.reasons),
  );
  // The base arm alone trips it the same way.
  assert.equal(
    contentionGuard({
      baseCpu: [20, 20],
      tipCpu: [20, 20],
      baseSamples: [burst(0, 12, 0, 99), quiet(5)],
      tipSamples: [quiet(5), quiet(5)],
    }).status,
    "contended",
  );
});

test("M10: (ROUND 5, K5-6) nine consecutive, or ten broken by one quiet sample, stay clear", () => {
  const clear = (tip) =>
    contentionGuard({
      baseCpu: [20],
      tipCpu: [20],
      baseSamples: [quiet(20)],
      tipSamples: [tip],
    });
  assert.equal(clear(burst(2, 9, 2)).status, "clear");
  assert.equal(
    clear([...burst(0, 5, 0), 60, ...burst(0, 5, 0)]).status,
    "clear",
    "a sample AT the threshold breaks the streak (above means strictly above)",
  );
  // The 2026-10-23 pass-1 A1 page that motivated the clause: 4 samples above
  // 60 % in a 11-sample page (E-D-HDR WebGL run 1, mean 55.7 %).
  assert.equal(clear(burst(3, 4, 4, 90)).status, "clear");
});

test("M10: (ROUND 5, K5-6) the streak length is a pre-registered band", () => {
  const bands = resolveBands({ contendedRunSamples: 4 });
  assert.equal(bands.contendedRunSamples, 4);
  assert.equal(
    contentionGuard({
      baseCpu: [20],
      tipCpu: [20],
      baseSamples: [quiet(10)],
      tipSamples: [burst(3, 4, 4, 90)],
      bands,
    }).status,
    "contended",
  );
});

test("M10: (ROUND 5, K5-6) a run with no sample list reads unmeasured; no lists at all leaves the clause unread", () => {
  const missing = contentionGuard({
    baseCpu: [20, 20],
    tipCpu: [20, 20],
    baseSamples: [quiet(5), null],
    tipSamples: [quiet(5), quiet(5)],
  });
  assert.equal(missing.status, "unread");
  assert.ok(
    missing.reasons.some((reason) => /base run 1 samples/.test(reason)),
  );
  const none = contentionGuard({ baseCpu: [20], tipCpu: [20] });
  assert.equal(none.status, "clear");
  assert.equal(none.sampleClause, "not-supplied");
  assert.deepEqual(none.baseLongestRun, []);
});

test("M10: (ROUND 5, K5-6) a streak-contended guard makes PF statistics unmeasured-contended", () => {
  const contention = contentionGuard({
    baseCpu: [20, 20],
    tipCpu: [20, 20],
    baseSamples: [quiet(12), quiet(12)],
    tipSamples: [quiet(12), burst(0, 10, 2, 80)],
  });
  const record = guardStatistic(
    compareToBase({
      metric: "PF-1",
      statistic: "p50",
      baseRepeats: [10, 10],
      tipRepeats: [10, 10],
    }),
    contention,
  );
  assert.equal(record.verdict, "unmeasured-contended");
  assert.equal(record.verdictIfUncontended, "within");
});
