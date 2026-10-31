// landing-perf-metrics.spec.mjs - lane KT round 2 (Anfalas). Pure Node: no browser, no GPU.
// @purpose Asserts the PF band arithmetic (M1: SEAT_DEFAULT_BANDS, resolveBands, bandFraction, compareToBase, median) and the PF-3 startup ceiling and worstVerdict ordering (M2) match the BEHAVIOUR_CELOS.md specification.
// @status ACTIVE
//
// Covers behaviours M1-M2 of the original landing-perf-metrics spec, which was split by concern
// (row DX-KIT-LANDING-SPECS-OVER-SIZE); the test names and bodies are unchanged. Every assertion drives
// the real metric functions with pure in-memory inputs.

import assert from "node:assert/strict";
import test from "node:test";
import {
  PERF_VERDICTS,
  SEAT_DEFAULT_BANDS,
  bandFraction,
  ceilingVerdict,
  compareToBase,
  median,
  repeatSpread,
  resolveBands,
  worstVerdict,
} from "./lib/metrics/perf-band.mjs";

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
