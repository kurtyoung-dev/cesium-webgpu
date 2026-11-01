// landing-pf2-bimodal.spec.mjs - how PF-2 reads a statistic whose repeats fall into two modes. Pure Node: no browser, no GPU, no live sampler.
// @purpose Asserts, by what a reader of the PF-2 record, the verdict entry, the exit code and the Markdown summary sees, that a statistic whose base and tip repeats fall into two modes names both modes and which arm drew which; that the band's over stands (FAIL, exit 1) whenever the base arm never drew the slow mode, as on the banked KIT8 pair, a clean 5x or 8x regression and a slow mode only the tip drew; that it reads unmeasured-bimodal (marked, exit 0) only when the base arm drew the slow mode too, as on the banked KIT6 and KIT7 pairs, keeping the band's own reading beside it; that a unimodal set, a genuine uniform regression and a set too small or too smooth to split keep the band's own record verbatim; that contention still takes precedence with the modes kept; and that the summary prints the row's result with a Marks line naming both modes.
// @status ACTIVE
//
// The fixtures (fixtures/pf2-bimodal/) are the per-repeat gpuPassCost results of the KIT8 4-prime, KIT6
// 5-floor and KIT7 4-warm-up Edge reports (arm A the base, arm B the tip, one served build), reduced to the
// fields the metric reads; each names its source report and JSON path. The cut across them: the widest spread
// inside a mode is 2.05x and the narrowest gap between the modes' means is 8.1x, so the ratio of 4 the piece
// carries sits between. The synthetic sets below are chosen, not measured, and say why.
//
// RUN: CESIUM_LANE=<lane> node --test Tools/visual-regression/landing-pf2-bimodal.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { compareArms, landingVerdicts } from "./lib/landing-verdicts.mjs";
import { buildLandingCellsSummary } from "./lib/landing-cells-summary.mjs";
import { passCostVerdict } from "./lib/metrics/gpu-pass-cost.mjs";
import {
  PERF_VERDICTS,
  compareToBase,
  isUnmeasuredVerdict,
  worstVerdict,
} from "./lib/metrics/perf-band.mjs";
import {
  BIMODAL_MIN_VALUES,
  BIMODAL_MODE_RATIO,
  splitTwoModes,
} from "./lib/metrics/two-mode-split.mjs";
import {
  PROBE_EXIT_CODES,
  UNMEASURED_REASONS,
  exitCodeForOutcome,
  isMarkedUnmeasured,
  verdictResultLabel,
} from "./lib/probe-refusal.mjs";

const load = (name) =>
  JSON.parse(
    fs.readFileSync(
      new URL(`./fixtures/pf2-bimodal/${name}.json`, import.meta.url),
      "utf8",
    ),
  );

// KIT8's base arm never drew the slow mode, so its band reading (`over`, a red
// the ledger carries) stands; KIT6 and KIT7 drew the slow mode on the base arm
// too, so the band cannot read the build there.
const PAIRS = {
  "kit8-4-prime": {
    reads: PERF_VERDICTS.OVER,
    bandAloneRead: "over",
    lowArms: ["base", "base"],
    highArms: ["tip", "tip"],
    armSeparated: true,
    arms: "each arm drew one mode only (the base arm only the low mode, the tip arm only the high mode), so a real change is not ruled out",
    tail: "the base arm never drew the slow mode, so the band's over stands",
  },
  "kit6-5-floor": {
    reads: PERF_VERDICTS.UNMEASURED_BIMODAL,
    bandAloneRead: "within",
    lowArms: ["tip"],
    highArms: ["base", "tip", "base"],
    armSeparated: false,
    arms: "the tip arm drew both modes, the base arm only the high mode",
    tail: "the band alone read within",
  },
  "kit7-4-warm-up": {
    reads: PERF_VERDICTS.UNMEASURED_BIMODAL,
    bandAloneRead: "within",
    lowArms: ["tip"],
    highArms: ["base", "tip", "base"],
    armSeparated: false,
    arms: "the tip arm drew both modes, the base arm only the high mode",
    tail: "the band alone read within",
  },
};

const runsOf = (pair) => ({ baseRuns: pair.base.pf2, tipRuns: pair.tip.pf2 });

/** A raw gpuPassCost() result as the profiler returns it, for the synthetic sets. */
const rawRun = (frameAvgMs, passAvgMs = frameAvgMs / 2) => ({
  enabled: true,
  frameAvgMs,
  frameCount: 60,
  passes: { "Scene Framebuffer Render Pass": { avgMs: passAvgMs } },
  sampleLedgerBalanced: true,
  coverageRatio: 0.6,
});

const verdictFor = (baseFrames, tipFrames, extra = {}) =>
  passCostVerdict({
    baseRuns: baseFrames.map((value) => rawRun(value)),
    tipRuns: tipFrames.map((value) => rawRun(value)),
    ...extra,
  });

/** The banded statistics a PF-2 record carries, total first. */
const statisticsOf = (pf2) => [
  pf2.total,
  pf2.cloudTotal,
  ...Object.values(pf2.passes),
];

for (const [name, expected] of Object.entries(PAIRS)) {
  test(`${name}: the frame total reads ${expected.reads} with both modes named and which arm drew which`, () => {
    const pair = load(name);
    const pf2 = passCostVerdict(runsOf(pair));
    assert.equal(pf2.verdict, expected.reads);
    assert.equal(pf2.total.verdict, expected.reads);

    const { low, high } = pf2.total.modes;
    assert.deepEqual(
      low.values.map((entry) => entry.arm),
      expected.lowArms,
    );
    assert.deepEqual(
      high.values.map((entry) => entry.arm),
      expected.highArms,
    );
    // Every banked frame total is in exactly one mode, under its own arm and run.
    const banked = (arm, side) =>
      side.pf2.map((run, index) => ({
        arm,
        run: index + 1,
        value: run.frameAvgMs,
      }));
    const all = [...banked("base", pair.base), ...banked("tip", pair.tip)];
    const listed = [...low.values, ...high.values];
    assert.equal(listed.length, all.length);
    for (const entry of all) {
      assert.ok(
        listed.some(
          (seen) =>
            seen.arm === entry.arm &&
            seen.run === entry.run &&
            seen.value === entry.value,
        ),
        `${entry.arm} run ${entry.run} is listed in a mode`,
      );
    }
    assert.ok(Math.max(...low.values.map((e) => e.value)) < 1);
    assert.ok(Math.min(...high.values.map((e) => e.value)) > 2);
    assert.ok(pf2.total.modes.ratio > 8);
    assert.equal(pf2.total.modes.armSeparated, expected.armSeparated);

    // The band's own reading: replaced and kept beside it on a bimodal record,
    // the verdict itself where it stands.
    const alone = compareToBase({
      metric: "PF-2",
      statistic: "frameAvgMs",
      baseRepeats: pair.base.pf2.map((run) => run.frameAvgMs),
      tipRepeats: pair.tip.pf2.map((run) => run.frameAvgMs),
    });
    assert.equal(alone.verdict, expected.bandAloneRead);
    if (expected.reads === PERF_VERDICTS.UNMEASURED_BIMODAL) {
      assert.equal(pf2.total.verdictIfUnimodal, alone.verdict);
    } else {
      assert.equal(pf2.total.verdictIfUnimodal, undefined);
      assert.equal(pf2.total.limit, alone.limit);
    }

    // The reason names both modes, their values, which arm drew which mode and
    // what the band's reading became.
    const reason = pf2.total.modesReason;
    assert.ok(reason.endsWith(`; ${expected.arms}; ${expected.tail}`), reason);
    assert.match(reason, /low mean 0\.\d+ \(/);
    assert.match(reason, /high mean [2-9]\.\d+ \(/);
    for (const entry of listed) {
      assert.ok(
        reason.includes(`${entry.arm} run ${entry.run} `),
        `${entry.arm} run ${entry.run} named`,
      );
    }
    assert.ok(pf2.total.reasons.includes(reason));
  });
}

test("KIT8: every pass the three-pass window timed keeps its over, with its modes beside it", () => {
  const pf2 = passCostVerdict(runsOf(load("kit8-4-prime")));
  const passes = Object.values(pf2.passes);
  assert.deepEqual(
    passes.map((record) => record.verdict),
    [PERF_VERDICTS.OVER, PERF_VERDICTS.OVER, PERF_VERDICTS.OVER],
  );
  for (const record of passes) {
    assert.equal(record.modes.armSeparated, true, record.statistic);
    assert.match(record.modesReason, /the band's over stands$/);
  }
});

test("a unimodal set keeps the band's own record verbatim", () => {
  const base = [0.45, 0.52];
  const tip = [0.5, 0.58];
  const pf2 = verdictFor(base, tip);
  assert.deepEqual(
    pf2.total,
    compareToBase({
      metric: "PF-2",
      statistic: "frameAvgMs",
      baseRepeats: base,
      tipRepeats: tip,
    }),
  );
  assert.equal(pf2.verdict, PERF_VERDICTS.WITHIN);
  assert.equal(pf2.total.modes, undefined);
  assert.equal(pf2.total.verdictIfUnimodal, undefined);
});

test("a genuine uniform regression (+60 %) is not two modes and still reads over", () => {
  // 0.50 / 0.55 against 0.80 / 0.90: the cut lands between the arms but the
  // means differ by 1.6x, far under the 4x two-mode ratio.
  const base = [0.5, 0.55];
  const tip = [0.8, 0.9];
  const pf2 = verdictFor(base, tip);
  assert.deepEqual(
    pf2.total,
    compareToBase({
      metric: "PF-2",
      statistic: "frameAvgMs",
      baseRepeats: base,
      tipRepeats: tip,
    }),
  );
  assert.equal(pf2.verdict, PERF_VERDICTS.OVER);
});

test("sets the split cannot read keep the band verbatim", () => {
  const cases = {
    "fewer values than the minimum": [[0.45], [4.5, 4.8]],
    "a zero cannot be a ratio": [
      [0, 0.5],
      [4, 4.5],
    ],
    "the gap across the cut is no wider than the spread inside the high mode": [
      [1, 2.5],
      [6, 15],
    ],
    "means within the ratio": [
      [1, 2],
      [3, 4.5],
    ],
  };
  assert.equal(BIMODAL_MIN_VALUES, 4);
  for (const [why, [base, tip]] of Object.entries(cases)) {
    const pf2 = verdictFor(base, tip);
    assert.deepEqual(
      pf2.total,
      compareToBase({
        metric: "PF-2",
        statistic: "frameAvgMs",
        baseRepeats: base,
        tipRepeats: tip,
      }),
      why,
    );
    assert.notEqual(pf2.verdict, PERF_VERDICTS.UNMEASURED_BIMODAL, why);
  }
});

test("a set with a base arm that produced nothing is not split (the band cannot read it either)", () => {
  const pf2 = passCostVerdict({
    baseRuns: [],
    tipRuns: [rawRun(0.45), rawRun(0.5), rawRun(4.5), rawRun(4.8)],
  });
  assert.equal(pf2.total.verdict, PERF_VERDICTS.UNMEASURED);
  assert.equal(pf2.total.modes, undefined);
});

test("the split names its constants: ratio 4, minimum four values, a one-run mode is a mode", () => {
  assert.equal(BIMODAL_MODE_RATIO, 4);
  const modes = splitTwoModes([
    { arm: "base", run: 1, value: 0.45 },
    { arm: "base", run: 2, value: 3 },
    { arm: "tip", run: 1, value: 3.5 },
    { arm: "tip", run: 2, value: 4 },
  ]);
  assert.equal(modes.low.values.length, 1);
  assert.equal(modes.high.values.length, 3);
  assert.equal(
    splitTwoModes([
      { arm: "base", run: 1, value: 0.45 },
      { arm: "tip", run: 1, value: 3 },
      { arm: "tip", run: 2, value: 4 },
    ]),
    null,
  );
});

test("contention keeps precedence: a contended arm reads unmeasured-contended with the modes kept", () => {
  const pair = load("kit8-4-prime");
  const pf2 = passCostVerdict({
    ...runsOf(pair),
    contention: {
      status: "contended",
      reasons: ["arm mean CPU 72 %"],
    },
  });
  assert.equal(pf2.verdict, PERF_VERDICTS.UNMEASURED_CONTENDED);
  assert.equal(pf2.total.verdict, PERF_VERDICTS.UNMEASURED_CONTENDED);
  assert.equal(pf2.total.verdictIfUncontended, PERF_VERDICTS.OVER);
  assert.equal(pf2.total.modes.low.values.length, 2);
  assert.equal(pf2.total.modes.high.values.length, 2);
  // A bimodal reading under contention keeps the same precedence.
  const kit6 = passCostVerdict({
    ...runsOf(load("kit6-5-floor")),
    contention: { status: "contended", reasons: ["arm mean CPU 72 %"] },
  });
  assert.equal(kit6.total.verdict, PERF_VERDICTS.UNMEASURED_CONTENDED);
  assert.equal(
    kit6.total.verdictIfUncontended,
    PERF_VERDICTS.UNMEASURED_BIMODAL,
  );
  assert.equal(kit6.total.verdictIfUnimodal, "within");
});

test("worstVerdict ranks over, contended, bimodal, plain unmeasured, within", () => {
  const of = (...verdicts) =>
    worstVerdict(verdicts.map((verdict) => ({ verdict })));
  const { OVER, WITHIN, UNMEASURED, UNMEASURED_CONTENDED, UNMEASURED_BIMODAL } =
    PERF_VERDICTS;
  assert.equal(of(WITHIN, UNMEASURED_BIMODAL), UNMEASURED_BIMODAL);
  assert.equal(of(UNMEASURED, UNMEASURED_BIMODAL), UNMEASURED_BIMODAL);
  assert.equal(
    of(UNMEASURED_BIMODAL, UNMEASURED_CONTENDED),
    UNMEASURED_CONTENDED,
  );
  assert.equal(of(UNMEASURED_BIMODAL, OVER), OVER);
  assert.equal(of(WITHIN, WITHIN), WITHIN);
  assert.equal(of(), UNMEASURED);
});

test("isUnmeasuredVerdict is true for every unmeasured word and nothing else", () => {
  for (const word of [
    PERF_VERDICTS.UNMEASURED,
    PERF_VERDICTS.UNMEASURED_CONTENDED,
    PERF_VERDICTS.UNMEASURED_BIMODAL,
  ]) {
    assert.equal(isUnmeasuredVerdict(word), true, word);
  }
  for (const word of [
    PERF_VERDICTS.WITHIN,
    PERF_VERDICTS.OVER,
    "not-applicable",
    undefined,
    null,
  ]) {
    assert.equal(isUnmeasuredVerdict(word), false, String(word));
  }
});

// --- through compareArms and landingVerdicts ---------------------------------

const ARM_KEY = "E-ID-cv|webgpu|scene";
/** An arm as groupArms builds it; PF-1 is a flat, identical frame series on both sides, so it passes. */
const armOf = (side) => ({
  renderer: "webgpu",
  inputs: {
    pf1: [Array.from({ length: 120 }, () => 16.7)],
    pf2: side.pf2,
    pf3: [],
    pf4: [],
    cpu: side.cpu,
    cpuSamples: side.cpuSamples,
  },
  captures: [],
  deviceLoss: [],
});

const comparisonOf = (name) => {
  const pair = load(name);
  return compareArms(
    { [ARM_KEY]: armOf(pair.tip) },
    { [ARM_KEY]: armOf(pair.base) },
    {},
  );
};

const pf2EntryOf = (verdicts) =>
  verdicts.find((verdict) => verdict.id === `${ARM_KEY}:PF-2`);

/** A synthetic arm pair on a quiet machine (20 % every sample), for the cases the banked pairs do not cover. */
const syntheticComparison = (baseFrames, tipFrames, bands = {}) => {
  const side = (frames) => ({
    pf2: frames.map((value) => rawRun(value)),
    cpu: frames.map(() => 20),
    cpuSamples: frames.map(() => [20, 20, 20]),
  });
  return compareArms(
    { [ARM_KEY]: armOf(side(tipFrames)) },
    { [ARM_KEY]: armOf(side(baseFrames)) },
    bands,
  );
};

const fold = (list) =>
  exitCodeForOutcome({ refusal: null, errored: false, verdicts: list });

/** The verdicts of a comparison without its PF-4 row (no residency runs here). */
const pfVerdictsOf = (comparison) =>
  landingVerdicts([], comparison).filter(
    (verdict) => !verdict.id.endsWith(":PF-4"),
  );

test("KIT8 through compareArms and landingVerdicts: the PF-2 entry keeps its over, fails, and carries the modes", () => {
  const comparison = comparisonOf("kit8-4-prime");
  assert.equal(comparison[ARM_KEY].contention.status, "clear");
  const verdicts = landingVerdicts([], comparison);
  const entry = pf2EntryOf(verdicts);
  assert.equal(entry.pass, false);
  assert.equal(entry.verdict, PERF_VERDICTS.OVER);
  assert.equal(entry.notRun, undefined);
  assert.equal(entry.unmeasured, undefined);
  assert.equal(entry.verdictIfUnimodal, undefined);
  assert.ok(entry.modes.low.mean < 1 && entry.modes.high.mean > 4);
  assert.match(
    entry.reason,
    /low mean 0\.525 \(base run 1 0\.4582, base run 2 0\.5918\)/,
  );
  assert.match(
    entry.reason,
    /high mean 4\.51 \(tip run 1 4\.221, tip run 2 4\.8\)/,
  );
  assert.match(entry.reason, /the band's over stands$/);
  assert.equal(isMarkedUnmeasured(entry), false);
  assert.equal(verdictResultLabel(entry), "FAIL");
  // The other PF rows are untouched by it.
  assert.equal(
    verdicts.find((verdict) => verdict.id === `${ARM_KEY}:PF-1`).pass,
    true,
  );
});

test("the exit fold reads 1 for KIT8, a clean 8x, a clean 5x, a three-run 8x and a tip-only slow draw: a slow mode only the tip drew still fails", () => {
  const cases = {
    "KIT8 4-prime (a red the ledger carries)": comparisonOf("kit8-4-prime"),
    "clean 8x": syntheticComparison([0.5, 0.55], [4.0, 4.4]),
    "clean 5x": syntheticComparison([0.5, 0.52], [2.5, 2.6]),
    "three-run 8x": syntheticComparison([0.5, 0.52, 0.55], [4.0, 4.1, 4.4]),
    "tip-only slow draw": syntheticComparison([0.5, 0.55], [0.52, 4.4]),
    "tip-only slow draw, three runs": syntheticComparison(
      [0.5, 0.52, 0.55],
      [0.5, 4.2, 4.4],
    ),
  };
  for (const [why, comparison] of Object.entries(cases)) {
    const verdicts = pfVerdictsOf(comparison);
    const entry = pf2EntryOf(verdicts);
    assert.equal(entry.verdict, PERF_VERDICTS.OVER, why);
    assert.equal(typeof entry.modes, "object", why);
    assert.match(entry.reason, /the band's over stands$/, why);
    assert.deepEqual(
      verdicts.filter((verdict) => verdict.pass !== true).map((v) => v.id),
      [`${ARM_KEY}:PF-2`],
      why,
    );
    assert.equal(fold(verdicts), PROBE_EXIT_CODES.FAILURE, why);
  }
  // The tip-only draw names the arm that drew both modes, not "an arm".
  assert.match(
    pf2EntryOf(pfVerdictsOf(cases["tip-only slow draw"])).reason,
    /; the tip arm drew both modes, the base arm only the low mode; the base arm never drew the slow mode, so the band's over stands$/,
  );
});

test("a slow mode the base arm drew too is marked unmeasured-bimodal and the fold reads 0, whether the band read within or over", () => {
  // With the seat bands, a base arm that drew both modes widens its own band,
  // so the band reads within (base 0.5 / 4.4 against tip 4.2 / 4.3). Under a
  // band override with no repeat factor the same pair reads over; the base
  // build drew the slow mode itself either way.
  const cases = {
    within: syntheticComparison([0.5, 4.4], [4.2, 4.3]),
    over: syntheticComparison([0.5, 4.4], [4.2, 4.3], { repeatFactor: 0 }),
  };
  for (const [bandRead, comparison] of Object.entries(cases)) {
    const verdicts = pfVerdictsOf(comparison);
    const entry = pf2EntryOf(verdicts);
    assert.equal(entry.verdict, PERF_VERDICTS.UNMEASURED_BIMODAL, bandRead);
    assert.equal(entry.verdictIfUnimodal, bandRead);
    assert.equal(entry.notRun, true, bandRead);
    assert.equal(entry.unmeasured, UNMEASURED_REASONS.BIMODAL, bandRead);
    assert.equal(isMarkedUnmeasured(entry), true, bandRead);
    assert.equal(verdictResultLabel(entry), "UNMEASURED (bimodal)", bandRead);
    assert.ok(
      entry.reason.endsWith(
        `; the base arm drew both modes, the tip arm only the high mode; the band alone read ${bandRead}`,
      ),
      entry.reason,
    );
    assert.equal(fold(verdicts), PROBE_EXIT_CODES.OK, bandRead);
    assert.equal(
      fold([...verdicts, { id: "other:PF-3", pass: false, verdict: "over" }]),
      PROBE_EXIT_CODES.FAILURE,
      bandRead,
    );
  }
  assert.equal(UNMEASURED_REASONS.BIMODAL, "bimodal");
});

test("KIT6 and KIT7 through compareArms read contended on their own CPU series, with the modes kept", () => {
  for (const name of ["kit6-5-floor", "kit7-4-warm-up"]) {
    const comparison = comparisonOf(name);
    const pf2 = comparison[ARM_KEY].pf2;
    assert.equal(comparison[ARM_KEY].contention.status, "contended", name);
    assert.equal(pf2.verdict, PERF_VERDICTS.UNMEASURED_CONTENDED, name);
    assert.equal(pf2.total.modes.low.values.length, 1, name);
    const entry = pf2EntryOf(landingVerdicts([], comparison));
    assert.equal(entry.unmeasured, UNMEASURED_REASONS.CONTENDED, name);
    assert.equal(entry.modes, undefined, name);
  }
});

/** The summary's PF-2 row and Marks line for one comparison. */
const summaryOf = (comparison) => {
  const verdicts = landingVerdicts([], comparison);
  const summary = buildLandingCellsSummary(
    { comparison },
    {
      generatedAt: "t",
      origin: "o",
      servedBuildAssertion: "a",
      exitCode: exitCodeForOutcome({ verdicts }),
      verdicts,
    },
    "title",
  );
  const lines = summary.split("\n");
  const row = lines.find((line) =>
    line.startsWith(`| ${ARM_KEY.replaceAll("|", "\\|")}:PF-2 |`),
  );
  const marks = lines.slice(lines.indexOf("## Marks") + 2);
  const mark = marks.find((line) => line.includes(`${ARM_KEY}:PF-2`));
  return { row, mark };
};

test("the summary prints KIT8's PF-2 as FAIL with a Marks line naming both modes and which arm drew which", () => {
  const { row, mark } = summaryOf(comparisonOf("kit8-4-prime"));
  assert.ok(row.endsWith("| FAIL |"), row);
  assert.ok(mark.startsWith("- FAIL `"), mark);
  assert.match(
    mark,
    /low mean 0\.525 \(base run 1 0\.4582, base run 2 0\.5918\)/,
  );
  assert.match(mark, /high mean 4\.51 \(tip run 1 4\.221, tip run 2 4\.8\)/);
  assert.match(
    mark,
    /each arm drew one mode only \(the base arm only the low mode, the tip arm only the high mode\), so a real change is not ruled out; the base arm never drew the slow mode, so the band's over stands/,
  );
  // No figure in the line carries five or more fractional digits.
  assert.doesNotMatch(mark, /\d\.\d{5,}/);
});

test("the summary prints a base-drew-slow PF-2 as UNMEASURED (bimodal) with its Marks line", () => {
  const { row, mark } = summaryOf(syntheticComparison([0.5, 4.4], [4.2, 4.3]));
  assert.ok(row.endsWith("| UNMEASURED (bimodal) |"), row);
  assert.ok(mark.startsWith("- UNMEASURED (bimodal) `"), mark);
  assert.match(mark, /the base arm drew both modes/);
  assert.match(mark, /the band alone read within/);
});

test("every statistic a bimodal PF-2 reports keeps the modes with its own verdict word", () => {
  const pf2 = passCostVerdict(runsOf(load("kit6-5-floor")));
  const bimodal = statisticsOf(pf2).filter(
    (statistic) => statistic.verdict === PERF_VERDICTS.UNMEASURED_BIMODAL,
  );
  assert.ok(bimodal.length > 0);
  for (const record of bimodal) {
    assert.ok(record.modes.low.values.length > 0, record.statistic);
    assert.ok(record.modes.high.values.length > 0, record.statistic);
    assert.equal(typeof record.verdictIfUnimodal, "string", record.statistic);
  }
});
