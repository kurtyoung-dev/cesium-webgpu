// landing-perf-metrics.spec.mjs - lane KT round 2 (Anfalas). Pure Node: no browser, no GPU.
// @purpose Asserts performance metrics PF-1 to PF-4 and band arithmetic match the BEHAVIOUR_CELOS.md specification.
// @status ACTIVE
//
// Covers behaviours M1-M7 written from BEHAVIOUR_CELOS.md.
// M6 and M7 assert Round 2 behaviours (D1 and D4); the M6 cases marked ROUND 3 are
// the lead's additions for Ettenmoors pass 2 (N-1, N-3, N-4). M8 (the machine-CPU
// sampler) and M9 (the contention guard) are the lead's ROUND 4 additions for the
// seat's item F3, written from the item text.
// Every assertion drives the real metric functions with pure in-memory inputs.

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_STUTTER_FACTOR,
  PF1_STATISTICS,
  frameTimeVerdict,
  summarizeFrameTimes,
} from "./lib/metrics/frame-time-distribution.mjs";
import {
  residencyVerdict,
  summarizeResidency,
} from "./lib/metrics/gpu-memory-residency.mjs";
import {
  CLOUD_PASS_RE,
  passCostVerdict,
  summarizePassCost,
} from "./lib/metrics/gpu-pass-cost.mjs";
import {
  PERF_VERDICTS,
  SEAT_DEFAULT_BANDS,
  bandFraction,
  ceilingVerdict,
  compareToBase,
  contentionGuard,
  guardStatistic,
  longestRunAbove,
  median,
  repeatSpread,
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
import {
  CLOUDLESS_STARTUP_FIELD,
  DEFAULT_STARTUP_FIELD,
  STARTUP_FIELDS,
  startupVerdict,
  summarizeStartup,
} from "./lib/metrics/startup-compile.mjs";

const makeCensusSnapshot = (
  installed,
  texLiveBytes = 0,
  bufLiveBytes = 0,
  texUnknown = 0,
  bufUnknown = 0,
) => {
  if (!installed) {
    return { installed: false, textures: null, buffers: null };
  }
  return {
    installed: true,
    textures: {
      created: 1,
      destroyed: 0,
      liveBytes: texLiveBytes,
      unknownSize: texUnknown,
    },
    buffers: {
      created: 1,
      destroyed: 0,
      liveBytes: bufLiveBytes,
      unknownSize: bufUnknown,
    },
  };
};

const makeRawStartupRecord = ({
  viewerReadyAtMs = 200,
  stagedAtMs = 300,
  firstFrameAtMs = 500,
  firstCloudFrameAtMs = 1200,
  tilesLoadedAtMs = 1800,
  outcome = "settled",
  compile = { shaderModules: { syncMs: 10, count: 1 } },
} = {}) => ({
  startup: {
    viewerReadyAtMs,
    stagedAtMs,
    firstFrameAtMs,
    firstCloudFrameAtMs,
    tilesLoadedAtMs,
    outcome,
  },
  compile,
});

const makePassCostResult = ({
  available = true,
  enabled = true,
  reason,
  frameAvgMs = 10.0,
  frameCount = 60,
  passes = {},
  sampleLedgerBalanced = true,
  coverageRatio = 1.0,
} = {}) => ({
  available,
  enabled,
  reason,
  frameAvgMs,
  frameCount,
  passes,
  sampleLedgerBalanced,
  coverageRatio,
});

// ---------------------------------------------------------------------------
// M1: Band arithmetic and comparison
// ---------------------------------------------------------------------------

test("M1: SEAT_DEFAULT_BANDS and PERF_VERDICTS expose expected frozen constants", () => {
  // Lead correction (Celos, round 4, F3): the seat's item adds the contention
  // guard's two pre-registered thresholds and its verdict.
  // Lead correction (Celos, round 5, K5-6): the sample clause's streak length.
  assert.deepEqual(SEAT_DEFAULT_BANDS, {
    floorFraction: 0.03,
    repeatFactor: 2,
    startupBandFloor: 0.1,
    startupCeilingMs: 2500,
    allocationBytes: 0,
    contendedCpuPct: 60,
    cpuArmDeltaPct: 20,
    contendedRunSamples: 10,
  });
  assert.ok(Object.isFrozen(SEAT_DEFAULT_BANDS));

  assert.deepEqual(PERF_VERDICTS, {
    WITHIN: "within",
    OVER: "over",
    UNMEASURED: "unmeasured",
    UNMEASURED_CONTENDED: "unmeasured-contended",
  });
  assert.ok(Object.isFrozen(PERF_VERDICTS));
});

test("M1: resolveBands applies pre-registered overrides on top of seat defaults", () => {
  const custom = resolveBands({
    floorFraction: 0.05,
    startupCeilingMs: 3000,
  });
  assert.equal(custom.floorFraction, 0.05);
  assert.equal(custom.repeatFactor, 2);
  assert.equal(custom.startupCeilingMs, 3000);
  assert.equal(custom.allocationBytes, 0);
  assert.ok(Object.isFrozen(custom));

  const defaults = resolveBands();
  assert.deepEqual(defaults, SEAT_DEFAULT_BANDS);
  assert.ok(Object.isFrozen(defaults));
});

test("M1: resolveBands rejects an unknown key with TypeError", () => {
  assert.throws(() => resolveBands({ unrecognizedKey: 10 }), TypeError);
});

test("M1: resolveBands rejects a negative value with TypeError", () => {
  assert.throws(() => resolveBands({ floorFraction: -0.01 }), TypeError);
});

test("M1: resolveBands rejects a non-finite value with TypeError", () => {
  assert.throws(() => resolveBands({ floorFraction: NaN }), TypeError);
  assert.throws(() => resolveBands({ startupCeilingMs: Infinity }), TypeError);
});

test("M1: repeatSpread computes relative spread (max - min) / min and handles edge cases", () => {
  assert.equal(repeatSpread([100, 105]), 0.05);
  assert.equal(repeatSpread([50, 75, 100]), 1.0);
  assert.equal(repeatSpread([100]), null);
  assert.equal(repeatSpread([]), null);
  assert.equal(repeatSpread([0, 10]), null);
  assert.equal(repeatSpread([0, 0]), 0);
});

test("M1: bandFraction uses floor and sets bandSource floor for single-repeat base", () => {
  const result = bandFraction({ baseRepeats: [100] });
  assert.equal(result.bandFraction, 0.03);
  assert.equal(result.baseSpread, null);
  assert.equal(result.source, "floor");

  const comparison = compareToBase({
    metric: "PF-1",
    statistic: "p50",
    baseRepeats: [100],
    tipRepeats: [102],
  });
  assert.equal(comparison.bandFraction, 0.03);
  assert.equal(comparison.bandSource, "floor");
  assert.equal(comparison.verdict, "within");
});

test("M1: bandFraction sets bandSource repeat when noisy base exceeds floor", () => {
  // base repeats [100, 105] -> spread = 0.05. repeatFactor 2 -> 0.10 > 0.03 floor.
  const result = bandFraction({ baseRepeats: [100, 105] });
  assert.equal(result.bandFraction, 0.1);
  assert.equal(result.baseSpread, 0.05);
  assert.equal(result.source, "repeat");

  // quiet base [100, 101] -> spread = 0.01. repeatFactor 2 -> 0.02 <= 0.03 floor.
  const quiet = bandFraction({ baseRepeats: [100, 101] });
  assert.equal(quiet.bandFraction, 0.03);
  assert.equal(quiet.baseSpread, 0.01);
  assert.equal(quiet.source, "floor");
});

test("M1: compareToBase boundary case exactly at limit is within", () => {
  // base = [100], floor = 0.03, limit = 100 * 1.03 = 103.
  const record = compareToBase({
    metric: "PF-1",
    statistic: "p50",
    baseRepeats: [100],
    tipRepeats: [103],
  });
  assert.equal(record.base, 100);
  assert.equal(record.tip, 103);
  assert.equal(record.limit, 103);
  assert.equal(record.verdict, "within");
});

test("M1: compareToBase boundary case just above limit is over", () => {
  // base = [100], floor = 0.03, limit = 100 * 1.03 = 103, tip = 103.001.
  const record = compareToBase({
    metric: "PF-1",
    statistic: "p50",
    baseRepeats: [100],
    tipRepeats: [103.001],
  });
  assert.equal(record.base, 100);
  assert.equal(record.tip, 103.001);
  assert.equal(record.limit, 103);
  assert.equal(record.verdict, "over");
  assert.ok(record.reasons.length > 0);
});

test("M1: compareToBase returns unmeasured when base or tip arm is missing or non-finite", () => {
  const missingBase = compareToBase({
    metric: "PF-1",
    statistic: "p50",
    baseRepeats: [],
    tipRepeats: [100],
  });
  assert.equal(missingBase.verdict, "unmeasured");
  assert.equal(missingBase.base, null);

  const missingTip = compareToBase({
    metric: "PF-1",
    statistic: "p50",
    baseRepeats: [100],
    tipRepeats: [],
  });
  assert.equal(missingTip.verdict, "unmeasured");
  assert.equal(missingTip.tip, null);

  const nonFinite = compareToBase({
    metric: "PF-1",
    statistic: "p50",
    baseRepeats: [NaN],
    tipRepeats: [undefined],
  });
  assert.equal(nonFinite.verdict, "unmeasured");
});

test("M1: median computes median of finite numbers and handles nulls", () => {
  assert.equal(median([10, 30, 20]), 20);
  assert.equal(median([10, 20, 30, 40]), 25);
  assert.equal(median([10, NaN, 20]), 15);
  assert.equal(median([]), null);
  assert.equal(median(null), null);
});

// ---------------------------------------------------------------------------
// M2: Ceiling rule (PF-3)
// ---------------------------------------------------------------------------

test("M2: ceilingVerdict under ceiling is within when tip median in band and all repeats strictly under ceiling", () => {
  // ceiling is 2500 ms; base median 1000 ms, PF-3 band 10 %, limit 1100 ms.
  const record = ceilingVerdict({
    metric: "PF-3",
    statistic: "navigationToFirstCloudFrameMs",
    baseRepeats: [1000],
    tipRepeats: [1000, 1020],
  });
  assert.equal(record.verdict, "within");
  assert.equal(record.baseOverCeiling, false);
  assert.equal(record.rule, "ceiling-and-band");
  assert.equal(record.tipMax, 1020);
});

test("M2: ceilingVerdict under ceiling is over when any tip repeat reaches or exceeds ceiling", () => {
  // tip median is 1000 ms (within band limit 1100 ms), but one repeat is 2500 ms (at ceiling).
  const record = ceilingVerdict({
    metric: "PF-3",
    statistic: "navigationToFirstCloudFrameMs",
    baseRepeats: [1000, 1000, 1000],
    tipRepeats: [1000, 1000, 2500],
  });
  assert.equal(record.verdict, "over");
  assert.equal(record.baseOverCeiling, false);
  assert.equal(record.tipMax, 2500);
  assert.ok(
    record.reasons.some((r) => r.includes("not under the 2500 ms ceiling")),
  );
});

test("M2: ceilingVerdict under ceiling is over when tip median exceeds band", () => {
  // all tip repeats are well under ceiling (1150 ms < 2500 ms), but exceed the 1100 ms band limit.
  const record = ceilingVerdict({
    metric: "PF-3",
    statistic: "navigationToFirstCloudFrameMs",
    baseRepeats: [1000],
    tipRepeats: [1150],
  });
  assert.equal(record.verdict, "over");
  assert.equal(record.baseOverCeiling, false);
});

// PF-3 fixtures (row DX-KIT-PF3-STARTUP-CEILING-WEBGL): the kit2 Edge leg's
// same-build WebGL arms, navigation to first frame in milliseconds.
const KIT2_2D_BASE = [1984.6, 2010.6];
const KIT2_2D_TIP = [1963, 2035.7];
const KIT2_CV_BASE = [1955, 2020.5];
const KIT2_CV_TIP = [2224, 1950];

const pf3 = (baseRepeats, tipRepeats, bands) =>
  ceilingVerdict({
    metric: "PF-3",
    statistic: "navigationToFirstFrameMs",
    baseRepeats,
    tipRepeats,
    bands,
  });

test("M2: PF-3 reads the kit2 2D same-build WebGL arms as within", () => {
  const record = pf3(KIT2_2D_BASE, KIT2_2D_TIP);
  assert.equal(record.verdict, "within");
  assert.equal(record.rule, "ceiling-and-band");
  assert.equal(record.baseOverCeiling, false);
  assert.equal(record.ceilingMs, 2500);
  assert.deepEqual(record.reasons, []);
});

test("M2: PF-3 reads the kit2 Columbus-view same-build WebGL arms as within", () => {
  const record = pf3(KIT2_CV_BASE, KIT2_CV_TIP);
  assert.equal(record.verdict, "within");
  assert.equal(record.tipMax, 2224);
  assert.equal(record.rule, "ceiling-and-band");
  assert.deepEqual(record.reasons, []);
});

test("M2: PF-3 reads a true startup regression (tip 2600, 2700 ms against the 2D base) as over", () => {
  const record = pf3(KIT2_2D_BASE, [2600, 2700]);
  assert.equal(record.verdict, "over");
  assert.ok(
    record.reasons.some((r) => r.includes("not under the 2500 ms ceiling")),
  );
  assert.ok(record.reasons.some((r) => r.includes("exceeds base")));
});

test("M2: PF-3 reads a tip repeat past the 2.5 s ceiling (tip 2450, 2600 ms against the 2D base) as over with the ceiling reason", () => {
  const record = pf3(KIT2_2D_BASE, [2450, 2600]);
  assert.equal(record.verdict, "over");
  assert.equal(record.tipMax, 2600);
  assert.ok(
    record.reasons.some((r) => r.includes("not under the 2500 ms ceiling")),
  );
});

test("M2: PF-3 reads a ceiling-only breach (band passes, one tip repeat reaches the ceiling) as over solely by the ceiling reason", () => {
  // base median 2305 ms, b = 0.10, limit 2535.5 ms; tip median 2450 ms passes
  // the band, but the 2510 ms repeat is not under 2500 ms.
  const record = pf3([2300, 2310], [2390, 2510]);
  assert.equal(record.baseOverCeiling, false);
  assert.equal(record.rule, "ceiling-and-band");
  assert.equal(record.verdict, "over");
  assert.equal(record.reasons.length, 1);
  assert.ok(record.reasons[0].includes("not under the 2500 ms ceiling"));

  // The ceiling is strict: a tip repeat exactly at 2500 ms is not under it.
  assert.equal(pf3([2300, 2310], [2400, 2500]).verdict, "over");
  assert.equal(pf3([2300, 2310], [2400, 2499]).verdict, "within");
});

test("M2: PF-3 with a base at or over the ceiling applies the banded compare and no ceiling clause", () => {
  // base median 2605 ms is over the 2500 ms ceiling; tip is 1 % above it.
  const baseRepeats = [2600, 2610];
  const baseMedian = 2605;
  const within = pf3(baseRepeats, [baseMedian * 1.01]);
  assert.equal(within.baseOverCeiling, true);
  assert.equal(within.rule, "base-over-ceiling-banded");
  assert.equal(within.verdict, "within");
  assert.ok(within.tipMax >= within.ceilingMs);
  assert.ok(within.limit > baseMedian);
  assert.ok(
    within.reasons.some((r) => r.includes("at or over the 2500 ms ceiling")),
  );
  assert.ok(within.reasons.some((r) => r.includes("banded compare")));

  // a tip well over the band still reads over.
  const wellOver = pf3(baseRepeats, [baseMedian * 1.2]);
  assert.equal(wellOver.baseOverCeiling, true);
  assert.equal(wellOver.rule, "base-over-ceiling-banded");
  assert.equal(wellOver.verdict, "over");
  assert.ok(wellOver.reasons.some((r) => r.includes("exceeds base")));
  assert.ok(!wellOver.reasons.some((r) => r.includes("not under the")));

  // a base exactly at the ceiling counts as at the ceiling (>=).
  const atBase = pf3([2500], [2500]);
  assert.equal(atBase.baseOverCeiling, true);
  assert.equal(atBase.rule, "base-over-ceiling-banded");
  assert.equal(atBase.verdict, "within");

  // the band edge: within at base x 1.10, over just past it.
  assert.equal(pf3([2600], [2860]).verdict, "within");
  assert.equal(pf3([2600], [2860.5]).verdict, "over");
});

test("M2: PF-3 band floor is startupBandFloor (10 %), not the 3 % floor PF-1 and PF-2 read", () => {
  // base [2000, 2010]: spread 0.005, 2 x 0.005 = 0.01, so the floor sets b.
  // tip median 2150 ms is 7.2 % above the base median 2005 ms: within at 10 %,
  // over at 3 %.
  const record = pf3([2000, 2010], [2140, 2160]);
  assert.equal(record.verdict, "within");
  assert.equal(record.bandFraction, 0.1);
  assert.equal(record.bandSource, "startup-floor");
  assert.equal(record.limit, 2005 * 1.1);
  assert.equal(record.bands.startupBandFloor, 0.1);
  assert.equal(record.bands.floorFraction, 0.03);

  // the same data read with the PF-1/PF-2 comparison is over at the 3 % floor.
  const pf12 = compareToBase({
    metric: "PF-1",
    statistic: "p95",
    baseRepeats: [2000, 2010],
    tipRepeats: [2140, 2160],
  });
  assert.equal(pf12.verdict, "over");
  assert.equal(pf12.bandFraction, 0.03);
  assert.equal(pf12.bandSource, "floor");

  // a pre-registered startupBandFloor override is honoured and reported as given.
  const tight = pf3([2000, 2010], [2140, 2160], { startupBandFloor: 0.03 });
  assert.equal(tight.verdict, "over");
  assert.equal(tight.bandFraction, 0.03);
  assert.equal(tight.bands.startupBandFloor, 0.03);
  const loose = pf3([2000, 2010], [2400, 2410], { startupBandFloor: 0.25 });
  assert.equal(loose.bandFraction, 0.25);
  assert.equal(loose.bands.startupBandFloor, 0.25);
});

test("M2: PF-3 keeps the repeat term when 2 x base-arm spread exceeds the startup floor", () => {
  // base [1000, 1100]: spread 0.1, 2 x 0.1 = 0.2 > 0.10.
  const record = pf3([1000, 1100], [1000, 1100]);
  assert.equal(record.bandSource, "repeat");
  assert.ok(Math.abs(record.bandFraction - 0.2) < 1e-12);
  assert.equal(record.verdict, "within");
});

test("M2: bandFraction and compareToBase keep the 3 % floor unless startup is asked for", () => {
  const plain = bandFraction({ baseRepeats: [100, 101] });
  assert.equal(plain.bandFraction, 0.03);
  assert.equal(plain.source, "floor");
  const startup = bandFraction({ baseRepeats: [100, 101], startup: true });
  assert.equal(startup.bandFraction, 0.1);
  assert.equal(startup.source, "startup-floor");

  // an override of the startup floor never moves PF-1/PF-2.
  const compared = compareToBase({
    metric: "PF-2",
    baseRepeats: [100, 101],
    tipRepeats: [102],
    bands: { startupBandFloor: 0.5 },
  });
  assert.equal(compared.bandFraction, 0.03);
  assert.equal(compared.bandSource, "floor");
});

test("M1: resolveBands accepts and validates startupBandFloor", () => {
  assert.equal(resolveBands({ startupBandFloor: 0.2 }).startupBandFloor, 0.2);
  assert.equal(resolveBands().startupBandFloor, 0.1);
  assert.throws(() => resolveBands({ startupBandFloor: -0.1 }), TypeError);
  assert.throws(() => resolveBands({ startupBandFloor: NaN }), TypeError);
});

test("M2: worstVerdict orders over > unmeasured > within and defaults to unmeasured", () => {
  assert.equal(
    worstVerdict([{ verdict: "within" }, { verdict: "within" }]),
    "within",
  );
  assert.equal(
    worstVerdict([{ verdict: "within" }, { verdict: "unmeasured" }]),
    "unmeasured",
  );
  assert.equal(
    worstVerdict([
      { verdict: "within" },
      { verdict: "unmeasured" },
      { verdict: "over" },
    ]),
    "over",
  );
  assert.equal(worstVerdict([]), "unmeasured");
  assert.equal(worstVerdict(null), "unmeasured");
});

// ---------------------------------------------------------------------------
// M3: PF-1 frame time distribution
// ---------------------------------------------------------------------------

test("M3: summarizeFrameTimes computes p50, p95, p99, max, mean, and stutterCount", () => {
  // 100 frames: 96 at 16.0 ms, 2 at 20.0 ms, 2 at 35.0 ms (> 2 * 16.0 = 32.0).
  const frames = [...Array(96).fill(16.0), 20.0, 20.0, 35.0, 35.0];
  const summary = summarizeFrameTimes(frames);
  assert.equal(summary.n, 100);
  assert.equal(summary.p50, 16.0);
  assert.ok(summary.p95 >= 16.0);
  assert.ok(summary.p99 >= 20.0);
  assert.equal(summary.max, 35.0);
  assert.equal(summary.stutterCount, 2);
  assert.equal(summary.stutterFactor, DEFAULT_STUTTER_FACTOR);
  assert.ok(Math.abs(summary.mean - 16.46) < 1e-4);
});

test("M3: summarizeFrameTimes on empty or non-finite run gives n: 0 and nulls", () => {
  assert.deepEqual(summarizeFrameTimes([]), {
    n: 0,
    p50: null,
    p95: null,
    p99: null,
    max: null,
    mean: null,
    stutterCount: null,
    stutterFactor: 2,
  });
  assert.deepEqual(summarizeFrameTimes([NaN, undefined]), {
    n: 0,
    p50: null,
    p95: null,
    p99: null,
    max: null,
    mean: null,
    stutterCount: null,
    stutterFactor: 2,
  });
});

test("M3: frameTimeVerdict computes worst of p50, p95, and p99 under M1", () => {
  assert.deepEqual(PF1_STATISTICS, ["p50", "p95", "p99"]);

  const cleanBase = [[16, 16, 16, 16]];
  const cleanTip = [[16, 16, 16, 16]];
  const cleanResult = frameTimeVerdict({
    baseRuns: cleanBase,
    tipRuns: cleanTip,
  });
  assert.equal(cleanResult.metric, "PF-1");
  assert.equal(cleanResult.verdict, "within");
  assert.ok(cleanResult.statistics.p50);
  assert.ok(cleanResult.statistics.p95);
  assert.ok(cleanResult.statistics.p99);
  assert.deepEqual(cleanResult.stutter, { base: [0], tip: [0] });

  // When p99 is over, the verdict becomes over.
  const degradingTip = [[16, 16, 16, 50]];
  const degradingResult = frameTimeVerdict({
    baseRuns: cleanBase,
    tipRuns: degradingTip,
  });
  assert.equal(degradingResult.statistics.p99.verdict, "over");
  assert.equal(degradingResult.verdict, "over");
});

// ---------------------------------------------------------------------------
// M4: PF-2 GPU pass cost
// ---------------------------------------------------------------------------

test("M4: summarizePassCost reduces non-object, unavailable, or disabled result to available: false with nulls", () => {
  const fromNull = summarizePassCost(null);
  assert.equal(fromNull.available, false);
  assert.equal(fromNull.frameAvgMs, null);
  assert.equal(fromNull.cloudTotalMs, null);
  assert.deepEqual(fromNull.passes, {});

  const unavailable = summarizePassCost({
    available: false,
    reason: "no timestamp query on adapter",
  });
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.reason, "no timestamp query on adapter");

  const disabled = summarizePassCost({ enabled: false });
  assert.equal(disabled.available, false);
});

test("M4: summarizePassCost sums passes matching /cloud/i into cloudTotalMs and records accounting", () => {
  assert.ok(CLOUD_PASS_RE.test("cloud-volumetric-pass"));
  assert.ok(CLOUD_PASS_RE.test("VolumetricCloudsRender"));
  assert.ok(!CLOUD_PASS_RE.test("globe-depth-pass"));

  const raw = makePassCostResult({
    enabled: true,
    frameAvgMs: 12.0,
    frameCount: 120,
    sampleLedgerBalanced: true,
    coverageRatio: 0.99,
    passes: {
      "cloud-volumetric": { avgMs: 2.5 },
      "cloud-shadows": { avgMs: 1.5 },
      "globe-surface": { avgMs: 6.0 },
    },
  });
  const summary = summarizePassCost(raw);
  assert.equal(summary.available, true);
  assert.equal(summary.frameAvgMs, 12.0);
  assert.equal(summary.frameCount, 120);
  assert.equal(summary.cloudTotalMs, 4.0);
  assert.deepEqual(summary.cloudPasses, {
    "cloud-volumetric": 2.5,
    "cloud-shadows": 1.5,
  });
  assert.equal(summary.passes["globe-surface"], 6.0);
  assert.equal(summary.ledgerBalanced, true);
  assert.equal(summary.coverageRatio, 0.99);

  // Scene without cloud passes has null cloudTotalMs.
  const noCloudRaw = makePassCostResult({
    passes: { "globe-surface": { avgMs: 5.0 } },
  });
  const noCloudSummary = summarizePassCost(noCloudRaw);
  assert.equal(noCloudSummary.cloudTotalMs, null);
  assert.deepEqual(noCloudSummary.cloudPasses, {});
});

test("M4: passCostVerdict is worst of frame total and cloud total, and lists onlyBase / onlyTip", () => {
  const baseRun = makePassCostResult({
    frameAvgMs: 10.0,
    passes: {
      "cloud-pass": { avgMs: 2.0 },
      "base-exclusive-pass": { avgMs: 1.0 },
    },
  });
  const tipRun = makePassCostResult({
    frameAvgMs: 10.2,
    passes: {
      "cloud-pass": { avgMs: 2.05 },
      "tip-exclusive-pass": { avgMs: 1.0 },
    },
  });

  const result = passCostVerdict({
    baseRuns: [baseRun],
    tipRuns: [tipRun],
  });
  assert.equal(result.metric, "PF-2");
  assert.equal(result.verdict, "within");
  assert.deepEqual(result.onlyBase, ["base-exclusive-pass"]);
  assert.deepEqual(result.onlyTip, ["tip-exclusive-pass"]);
  assert.ok(result.passes["cloud-pass"]);

  // When cloud pass in tip degrades over the band limit, verdict becomes over.
  const slowCloudTip = makePassCostResult({
    frameAvgMs: 10.2,
    passes: {
      "cloud-pass": { avgMs: 3.5 },
    },
  });
  const slowResult = passCostVerdict({
    baseRuns: [baseRun],
    tipRuns: [slowCloudTip],
  });
  assert.equal(slowResult.cloudTotal.verdict, "over");
  assert.equal(slowResult.verdict, "over");
});

test("M4: passCostVerdict evaluates frame total alone when neither arm has a cloud pass", () => {
  const baseCloudless = makePassCostResult({
    frameAvgMs: 8.0,
    passes: { "globe-pass": { avgMs: 8.0 } },
  });
  const tipCloudless = makePassCostResult({
    frameAvgMs: 8.1,
    passes: { "globe-pass": { avgMs: 8.1 } },
  });

  const result = passCostVerdict({
    baseRuns: [baseCloudless],
    tipRuns: [tipCloudless],
  });
  assert.equal(result.cloudless, true);
  assert.equal(result.total.verdict, "within");
  assert.equal(result.verdict, "within");
});

// ---------------------------------------------------------------------------
// M5: PF-3 startup intervals and fallback
// ---------------------------------------------------------------------------

test("M5: summarizeStartup calculates intervals from raw timestamps and compile sums", () => {
  const raw = makeRawStartupRecord({
    viewerReadyAtMs: 300,
    stagedAtMs: 500,
    firstFrameAtMs: 800,
    firstCloudFrameAtMs: 1200,
    tilesLoadedAtMs: 1800,
    outcome: "settled",
    compile: {
      shaderModules: { syncMs: 50, count: 5 },
      renderPipelines: { syncMs: 100, count: 2 },
      computePipelines: { syncMs: 30, count: 1 },
      renderPipelinesAsync: { totalSettleMs: 200, count: 3 },
      computePipelinesAsync: { totalSettleMs: 50, count: 1 },
      firstCreateAtMs: 350,
      lastSettleAtMs: 700,
    },
  });

  const summary = summarizeStartup(raw);
  assert.equal(summary.navigationToViewerMs, 300);
  assert.equal(summary.navigationToFirstFrameMs, 800);
  assert.equal(summary.navigationToFirstCloudFrameMs, 1200);
  assert.equal(summary.viewerToFirstCloudFrameMs, 900); // 1200 - 300
  assert.equal(summary.stageToFirstCloudFrameMs, 700); // 1200 - 500
  assert.equal(summary.navigationToTilesLoadedMs, 1800);
  assert.equal(summary.outcome, "settled");

  assert.equal(summary.compile.syncMs, 180);
  assert.equal(summary.compile.asyncMs, 250);
  assert.equal(summary.compile.totalMs, 430);
  assert.equal(summary.compile.spanMs, 350); // 700 - 350
  assert.equal(summary.compile.shaderModules, 5);
  assert.equal(summary.compile.renderPipelines, 5); // 2 sync + 3 async
  assert.equal(summary.compile.computePipelines, 2); // 1 sync + 1 async
});

test("M5: startupVerdict falls back to navigationToFirstFrameMs when cloud frame is absent on both arms", () => {
  const baseCloudless = makeRawStartupRecord({
    firstCloudFrameAtMs: null,
    firstFrameAtMs: 600,
  });
  const tipCloudless = makeRawStartupRecord({
    firstCloudFrameAtMs: null,
    firstFrameAtMs: 610,
  });

  const result = startupVerdict({
    baseRuns: [baseCloudless],
    tipRuns: [tipCloudless],
  });
  assert.equal(result.field, CLOUDLESS_STARTUP_FIELD);
  assert.equal(result.fieldFallback, true);
  assert.equal(result.metric, "PF-3");
  assert.equal(result.verdict, "within");
});

test("M5: startupVerdict uses explicitly requested field without fallback", () => {
  const base = makeRawStartupRecord({
    firstCloudFrameAtMs: 1200,
    viewerReadyAtMs: 200,
  });
  const tip = makeRawStartupRecord({
    firstCloudFrameAtMs: 1210,
    viewerReadyAtMs: 200,
  });

  const result = startupVerdict({
    baseRuns: [base],
    tipRuns: [tip],
    field: "viewerToFirstCloudFrameMs",
  });
  assert.equal(result.field, "viewerToFirstCloudFrameMs");
  assert.equal(result.fieldFallback, false);
  assert.equal(result.verdict, "within");
});

test("M5: startupVerdict throws TypeError on unknown field", () => {
  assert.ok(STARTUP_FIELDS.includes(DEFAULT_STARTUP_FIELD));
  assert.ok(STARTUP_FIELDS.includes(CLOUDLESS_STARTUP_FIELD));
  assert.throws(
    () =>
      startupVerdict({
        baseRuns: [],
        tipRuns: [],
        field: "nonExistentStartupField",
      }),
    TypeError,
  );
});

// ---------------------------------------------------------------------------
// M6: PF-4 GPU memory residency and growth (ROUND 2)
// ---------------------------------------------------------------------------

test("M6: summarizeResidency returns null bytes when census is not installed", () => {
  const uninstalled = summarizeResidency(makeCensusSnapshot(false));
  assert.equal(uninstalled.installed, false);
  assert.equal(uninstalled.liveBytes, null);
  assert.equal(uninstalled.textureLiveBytes, null);
  assert.equal(uninstalled.bufferLiveBytes, null);
  assert.equal(uninstalled.liveTextures, null);
  assert.equal(uninstalled.liveBuffers, null);

  const fromNull = summarizeResidency(null);
  assert.equal(fromNull.installed, false);
  assert.equal(fromNull.liveBytes, null);

  const installed = summarizeResidency(makeCensusSnapshot(true, 500, 300));
  assert.equal(installed.installed, true);
  assert.equal(installed.liveBytes, 800);
  assert.equal(installed.textureLiveBytes, 500);
  assert.equal(installed.bufferLiveBytes, 300);
});

test("M6: residencyVerdict is within when tip median live bytes <= base + allocationBytes", () => {
  const baseRuns = [
    {
      start: makeCensusSnapshot(true, 100_000_000),
      end: makeCensusSnapshot(true, 100_000_000),
    },
  ];
  const tipRuns = [
    {
      start: makeCensusSnapshot(true, 100_000_000),
      end: makeCensusSnapshot(true, 105_000_000),
    },
  ];

  const withAllocation = residencyVerdict({
    baseRuns,
    tipRuns,
    bands: { allocationBytes: 10_000_000 },
  });
  assert.equal(withAllocation.residency.verdict, "within");
  assert.equal(withAllocation.residency.limit, 110_000_000);
});

test("M6: residencyVerdict is over when tip median live bytes > base + allocationBytes", () => {
  const baseRuns = [
    {
      start: makeCensusSnapshot(true, 100_000_000),
      end: makeCensusSnapshot(true, 100_000_000),
    },
  ];
  const tipRuns = [
    {
      start: makeCensusSnapshot(true, 100_000_000),
      end: makeCensusSnapshot(true, 105_000_000),
    },
  ];

  const zeroAllocation = residencyVerdict({
    baseRuns,
    tipRuns,
    bands: { allocationBytes: 0 },
  });
  assert.equal(zeroAllocation.residency.verdict, "over");
});

test("M6: (ROUND 2) growth verdict with base [0, 0, 0] and tip [0, 0, 50 MB] reads over", () => {
  // Statement example: base growths [0, 0, 0], tip growths [0, 0, 50 MB].
  // Base spread is 0; allowance is max(0, 0) + 0 = 0.
  // One tip repeat leaking 50 MB must fail growth and PF-4.
  const baseRuns = [
    {
      start: makeCensusSnapshot(true, 100_000_000),
      end: makeCensusSnapshot(true, 100_000_000),
    },
    {
      start: makeCensusSnapshot(true, 100_000_000),
      end: makeCensusSnapshot(true, 100_000_000),
    },
    {
      start: makeCensusSnapshot(true, 100_000_000),
      end: makeCensusSnapshot(true, 100_000_000),
    },
  ];
  const tipRuns = [
    {
      start: makeCensusSnapshot(true, 100_000_000),
      end: makeCensusSnapshot(true, 100_000_000),
    },
    {
      start: makeCensusSnapshot(true, 100_000_000),
      end: makeCensusSnapshot(true, 100_000_000),
    },
    {
      start: makeCensusSnapshot(true, 100_000_000),
      end: makeCensusSnapshot(true, 150_000_000),
    },
  ];

  const result = residencyVerdict({ baseRuns, tipRuns });
  assert.equal(result.growth.verdict, "over");
  assert.equal(result.verdict, "over");
});

test("M6: (ROUND 2) growth verdict with base [0, 0] and tip [0, 50 MB] reads over", () => {
  // Statement example: base growths [0, 0], tip growths [0, 50 MB].
  const baseRuns = [
    {
      start: makeCensusSnapshot(true, 100_000_000),
      end: makeCensusSnapshot(true, 100_000_000),
    },
    {
      start: makeCensusSnapshot(true, 100_000_000),
      end: makeCensusSnapshot(true, 100_000_000),
    },
  ];
  const tipRuns = [
    {
      start: makeCensusSnapshot(true, 100_000_000),
      end: makeCensusSnapshot(true, 100_000_000),
    },
    {
      start: makeCensusSnapshot(true, 100_000_000),
      end: makeCensusSnapshot(true, 150_000_000),
    },
  ];

  const result = residencyVerdict({ baseRuns, tipRuns });
  assert.equal(result.growth.verdict, "over");
  assert.equal(result.verdict, "over");
});

test("M6: (ROUND 2) growth verdict with base [0, 1000] and tip [500, 1000] reads within", () => {
  // Statement example: base [0, 1000] and tip [500, 1000] read within.
  // Base spread: 1000 - 0 = 1000. Largest base growth: 1000. Allowance: 1000 + 1000 = 2000.
  const baseRuns = [
    {
      start: makeCensusSnapshot(true, 100_000),
      end: makeCensusSnapshot(true, 100_000),
    },
    {
      start: makeCensusSnapshot(true, 100_000),
      end: makeCensusSnapshot(true, 101_000),
    },
  ];
  const tipRuns = [
    {
      start: makeCensusSnapshot(true, 100_000),
      end: makeCensusSnapshot(true, 100_500),
    },
    {
      start: makeCensusSnapshot(true, 100_000),
      end: makeCensusSnapshot(true, 101_000),
    },
  ];

  const result = residencyVerdict({ baseRuns, tipRuns });
  assert.equal(result.growth.allowance, 2000);
  assert.equal(result.growth.verdict, "within");
  // Lead correction (Celos, round 2): the statement's example is the GROWTH
  // verdict. PF-4 overall also reads residency, and these fixtures end the tip
  // median 250 B above base with allocationBytes 0, so overall reads over.
  assert.equal(result.residency.verdict, "over");
  assert.equal(result.verdict, "over");
});

test("M6: (ROUND 2) growth verdict with base [1000, 3000] and tip [2000, 6000] reads over on our additional example", () => {
  // Additional example: base [1000, 3000] -> max base = 3000, base spread = 2000.
  // Allowance = 3000 + 2000 = 5000.
  // Tip [2000, 6000] has worst growth 6000 > 5000 allowance -> over.
  const baseRuns = [
    {
      start: makeCensusSnapshot(true, 100_000),
      end: makeCensusSnapshot(true, 101_000),
    },
    {
      start: makeCensusSnapshot(true, 100_000),
      end: makeCensusSnapshot(true, 103_000),
    },
  ];
  const tipRuns = [
    {
      start: makeCensusSnapshot(true, 100_000),
      end: makeCensusSnapshot(true, 102_000),
    },
    {
      start: makeCensusSnapshot(true, 100_000),
      end: makeCensusSnapshot(true, 106_000),
    },
  ];

  const result = residencyVerdict({ baseRuns, tipRuns });
  assert.equal(result.growth.verdict, "over");
  assert.equal(result.verdict, "over");
});

// Lead addition (Celos, round 3, Ettenmoors pass 2 N-1): the live COUNTS
// subtract what went with a destroyed device, as the live bytes do (kills E-16).
test("M6: (ROUND 3, N-1) summarizeResidency live counts subtract freedByDevice", () => {
  const snapshot = {
    installed: true,
    textures: {
      created: 10,
      destroyed: 3,
      freedByDevice: 2,
      liveBytes: 5000,
      unknownSize: 0,
    },
    buffers: {
      created: 5,
      destroyed: 1,
      freedByDevice: 4,
      liveBytes: 0,
      unknownSize: 0,
    },
  };
  const summary = summarizeResidency(snapshot);
  assert.equal(summary.liveTextures, 5); // 10 - 3 - 2
  assert.equal(summary.liveBuffers, 0); // 5 - 1 - 4
  assert.equal(summary.liveBytes, 5000);
});

// Lead addition (Celos, round 3, seat ruling on N-3): base growths are clamped
// at 0 before the largest and the spread, so a base window that FREES memory
// buys the tip no leak room. The reviewer's measured case.
test("M6: (ROUND 3, N-3) base growths [-50 MB, 0] and tip [0, +50 MB] read growth over", () => {
  const baseRuns = [
    {
      start: makeCensusSnapshot(true, 150_000_000),
      end: makeCensusSnapshot(true, 100_000_000),
    },
    {
      start: makeCensusSnapshot(true, 100_000_000),
      end: makeCensusSnapshot(true, 100_000_000),
    },
  ];
  const tipRuns = [
    {
      start: makeCensusSnapshot(true, 100_000_000),
      end: makeCensusSnapshot(true, 100_000_000),
    },
    {
      start: makeCensusSnapshot(true, 100_000_000),
      end: makeCensusSnapshot(true, 150_000_000),
    },
  ];
  const result = residencyVerdict({ baseRuns, tipRuns });
  assert.deepEqual(result.growth.base, [-50_000_000, 0]);
  assert.equal(result.growth.allowance, 0);
  assert.equal(result.growth.baseSpread, 0);
  assert.equal(result.growth.verdict, "over");
  assert.equal(result.verdict, "over");
});

test("M6: (ROUND 3, N-3) an all-negative base allows the tip no growth, and a tip that also frees reads within", () => {
  const baseRuns = [
    {
      start: makeCensusSnapshot(true, 120_000),
      end: makeCensusSnapshot(true, 100_000),
    },
    {
      start: makeCensusSnapshot(true, 110_000),
      end: makeCensusSnapshot(true, 100_000),
    },
  ];
  const freeingTip = [
    {
      start: makeCensusSnapshot(true, 105_000),
      end: makeCensusSnapshot(true, 100_000),
    },
  ];
  const freeing = residencyVerdict({ baseRuns, tipRuns: freeingTip });
  assert.equal(freeing.growth.allowance, 0);
  assert.equal(freeing.growth.verdict, "within");
  const growingTip = [
    {
      start: makeCensusSnapshot(true, 99_000),
      end: makeCensusSnapshot(true, 100_000),
    },
  ];
  const growing = residencyVerdict({ baseRuns, tipRuns: growingTip });
  assert.equal(growing.growth.verdict, "over");
});

// Lead addition (Celos, round 3, packet defect 8 / pass 2 N-4): a window whose
// census read is missing is never dropped; it makes PF-4 unmeasured (the D4
// rule), unless the windows that were read already read over.
const steadyWindow = () => ({
  start: makeCensusSnapshot(true, 100_000),
  end: makeCensusSnapshot(true, 100_000),
});

test("M6: (ROUND 3, N-4) a tip window with an uninstalled census reads unmeasured, not within", () => {
  const baseRuns = [steadyWindow(), steadyWindow()];
  const tipRuns = [
    steadyWindow(),
    {
      start: makeCensusSnapshot(false),
      end: makeCensusSnapshot(false),
    },
  ];
  const result = residencyVerdict({ baseRuns, tipRuns });
  assert.equal(result.growth.verdict, "unmeasured");
  assert.equal(result.residency.verdict, "unmeasured");
  assert.equal(result.verdict, "unmeasured");
  assert.deepEqual(result.growth.missingWindows, ["tip window 1"]);
  assert.deepEqual(result.residency.missingWindows, ["tip window 1"]);
  assert.ok(
    result.growth.reasons.some((reason) => reason.includes("tip window 1")),
    "the missing window is named in the reasons",
  );
  assert.equal(result.runs.tip.length, 2, "the window is kept, not dropped");
});

test("M6: (ROUND 3, N-4) a missing run (null) or a missing start read on either arm reads unmeasured", () => {
  const nullBase = residencyVerdict({
    baseRuns: [steadyWindow(), null],
    tipRuns: [steadyWindow(), steadyWindow()],
  });
  assert.equal(nullBase.verdict, "unmeasured");
  assert.deepEqual(nullBase.growth.missingWindows, ["base window 1"]);

  // Only the START read is missing: the end bytes exist, so residency is
  // measured, but the window has no growth.
  const noStart = residencyVerdict({
    baseRuns: [steadyWindow(), steadyWindow()],
    tipRuns: [
      steadyWindow(),
      { start: null, end: makeCensusSnapshot(true, 100_000) },
    ],
  });
  assert.equal(noStart.residency.verdict, "within");
  assert.equal(noStart.growth.verdict, "unmeasured");
  assert.deepEqual(noStart.growth.missingWindows, ["tip window 1"]);
  assert.equal(noStart.verdict, "unmeasured");
});

test("M6: (ROUND 3, N-4) over on the windows that were read stands over a missing window", () => {
  const baseRuns = [steadyWindow(), steadyWindow()];
  const tipRuns = [
    {
      start: makeCensusSnapshot(true, 100_000),
      end: makeCensusSnapshot(true, 150_000),
    },
    { start: makeCensusSnapshot(false), end: makeCensusSnapshot(false) },
  ];
  const result = residencyVerdict({ baseRuns, tipRuns });
  assert.equal(result.growth.verdict, "over");
  assert.deepEqual(result.growth.missingWindows, ["tip window 1"]);
  assert.equal(result.verdict, "over");
});

test("M6: (ROUND 3, N-4) every window read reports no missing windows", () => {
  const result = residencyVerdict({
    baseRuns: [steadyWindow(), steadyWindow()],
    tipRuns: [steadyWindow(), steadyWindow()],
  });
  assert.deepEqual(result.growth.missingWindows, []);
  assert.deepEqual(result.residency.missingWindows, []);
  assert.equal(result.verdict, "within");
});

// ---------------------------------------------------------------------------
// M7: PF-3 repeat preservation and outcome gating (ROUND 2)
// ---------------------------------------------------------------------------

test("M7: (ROUND 2) tip repeat lacking interval with outcome deadline makes startup verdict over", () => {
  // Statement example: base 3 repeats at 1500 ms, tip [1500, 1500, null with outcome deadline].
  const baseRuns = [
    makeRawStartupRecord({ firstCloudFrameAtMs: 1500 }),
    makeRawStartupRecord({ firstCloudFrameAtMs: 1500 }),
    makeRawStartupRecord({ firstCloudFrameAtMs: 1500 }),
  ];
  const tipRuns = [
    makeRawStartupRecord({ firstCloudFrameAtMs: 1500 }),
    makeRawStartupRecord({ firstCloudFrameAtMs: 1500 }),
    makeRawStartupRecord({
      firstCloudFrameAtMs: null,
      outcome: "deadline",
    }),
  ];

  const result = startupVerdict({ baseRuns, tipRuns });
  assert.equal(result.startup.verdict, "over");
  assert.equal(result.verdict, "over");
  assert.ok(
    result.startup.reasons.some(
      (r) => r.includes("2") && r.includes("deadline"),
    ),
  );
});

test("M7: (ROUND 2) tip repeat lacking interval with outcome frame-cap makes startup verdict over", () => {
  const baseRuns = [
    makeRawStartupRecord({ firstCloudFrameAtMs: 1200 }),
    makeRawStartupRecord({ firstCloudFrameAtMs: 1200 }),
  ];
  const tipRuns = [
    makeRawStartupRecord({
      firstCloudFrameAtMs: null,
      outcome: "frame-cap",
    }),
    makeRawStartupRecord({ firstCloudFrameAtMs: 1200 }),
  ];

  const result = startupVerdict({ baseRuns, tipRuns });
  assert.equal(result.startup.verdict, "over");
  assert.equal(result.verdict, "over");
  assert.ok(
    result.startup.reasons.some(
      (r) => r.includes("0") && r.includes("frame-cap"),
    ),
  );
});

test("M7: (ROUND 2) tip repeat lacking interval with outcome render-error makes startup verdict over", () => {
  const baseRuns = [
    makeRawStartupRecord({ firstCloudFrameAtMs: 1000 }),
    makeRawStartupRecord({ firstCloudFrameAtMs: 1000 }),
  ];
  const tipRuns = [
    makeRawStartupRecord({ firstCloudFrameAtMs: 1000 }),
    makeRawStartupRecord({
      firstCloudFrameAtMs: null,
      outcome: "render-error",
    }),
  ];

  const result = startupVerdict({ baseRuns, tipRuns });
  assert.equal(result.startup.verdict, "over");
  assert.equal(result.verdict, "over");
  assert.ok(
    result.startup.reasons.some(
      (r) => r.includes("1") && r.includes("render-error"),
    ),
  );
});

test("M7: (ROUND 2) tip repeat lacking interval with unrecognised or no outcome makes startup verdict unmeasured", () => {
  const baseRuns = [
    makeRawStartupRecord({ firstCloudFrameAtMs: 1000 }),
    makeRawStartupRecord({ firstCloudFrameAtMs: 1000 }),
  ];
  const tipRuns = [
    makeRawStartupRecord({ firstCloudFrameAtMs: 1000 }),
    makeRawStartupRecord({
      firstCloudFrameAtMs: null,
      outcome: "user-cancelled",
    }),
  ];

  const result = startupVerdict({ baseRuns, tipRuns });
  assert.equal(result.startup.verdict, "unmeasured");
  assert.equal(result.verdict, "unmeasured");
});

test("M7: (ROUND 2) base repeat lacking interval makes startup verdict unmeasured", () => {
  const baseRuns = [
    makeRawStartupRecord({ firstCloudFrameAtMs: 1000 }),
    makeRawStartupRecord({
      firstCloudFrameAtMs: null,
      outcome: "settled",
    }),
  ];
  const tipRuns = [
    makeRawStartupRecord({ firstCloudFrameAtMs: 1000 }),
    makeRawStartupRecord({ firstCloudFrameAtMs: 1000 }),
  ];

  const result = startupVerdict({ baseRuns, tipRuns });
  assert.equal(result.startup.verdict, "unmeasured");
  assert.equal(result.verdict, "unmeasured");
});

test("M7: (ROUND 2) over wins over unmeasured when base lacks interval and tip has deadline outcome", () => {
  // Additional example: base lacks interval (would be unmeasured), but tip lacks interval with deadline (makes it over).
  // Over must win over unmeasured.
  // Lead correction (Celos, round 2): a base repeat WITH a cloud frame keeps
  // M5's cloudless fallback from choosing navigationToFirstFrameMs, which
  // every repeat here has; M7 applies after M5 has chosen the field.
  const baseRuns = [
    makeRawStartupRecord({ firstCloudFrameAtMs: 1200, outcome: "done" }),
    makeRawStartupRecord({
      firstCloudFrameAtMs: null,
      outcome: "settled",
    }),
  ];
  const tipRuns = [
    makeRawStartupRecord({
      firstCloudFrameAtMs: null,
      outcome: "deadline",
    }),
  ];

  const result = startupVerdict({ baseRuns, tipRuns });
  assert.equal(result.startup.verdict, "over");
  assert.equal(result.verdict, "over");
});

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
