// display-conditions-globedepth-verdicts.spec.mjs — the verdict half of
// `probe-display-conditions-globedepth.mjs`, exercised without a browser.
//
// @purpose Pins the AR-890 loop's observable behaviour: occurrences are counted per run and never de-duplicated, the hit rate aggregates runs rather than a set union, the probe's own resize stressor is attributed but never gates, the WebGL leg is a real asserted control, and a run with a destroyed-texture occurrence in the shipped configuration drives a non-zero exit code.
// @status ACTIVE
//
// WHY THIS EXISTS. `AR-890`'s whole point is that a single load proves
// nothing and that a de-duplicated set states no rate. `sandcastle-smoke.mjs`
// folds its errors through `new Set(errors)` (`:553`, published at `:563`), so
// its receipt records the fault once however often it fired. The probe this
// spec covers must not inherit that, and "must not inherit it" is a behaviour:
// feed the same message three times and the count is three. Every assertion
// below is over the probe's real exported functions and the runtime's real
// exit-code table — none of them reads the probe's source text, because a
// source-shape assertion would pass over a counter that had stopped counting.
//
// The probe module guards its `runProbe` call with `isEntryPoint`, so
// importing it here does not launch Edge. That guard is the runtime's stated
// contract for exactly this use.
//
// TWO PROPERTIES THAT ARE EASY TO GET BACKWARDS, so they are pinned explicitly.
// (1) The verdict must read the SHIPPED-configuration phases only. The probe's
// `resize` phase reproduces a condition a different, NOT STARTED row already
// owns (`NEW-WEBGPU-SCENE-PASS-MSAA-FLIP-TRANSITION`), so a verdict that
// summed it would put `AR-890`'s "zero after `AR-887`" clause behind that
// row's fix and make it structurally unreachable — `E4` is the assertion that
// says it is reachable. (2) The WebGL leg is an ASSERTED control, not a claimed
// one: `D7` fails a run whose WebGL leg produced this fault family, because a
// WebGL context cannot.

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_RUNS,
  MAX_MISMATCH_PCT,
  MIN_DISTINCT_COARSE_COLORS,
  aggregateHitRate,
  countFaultOccurrences,
  decideAggregateVerdict,
  decideRunVerdict,
  partitionOccurrences,
  sumPhaseOccurrences,
} from "./probe-display-conditions-globedepth.mjs";
import { exitCodeForOutcome } from "./lib/probe-refusal.mjs";

/** The receipt line Éowyn job 3 leg 2b recorded, verbatim. */
const JOB3_MESSAGE =
  'console.error: [WebGPU:GlobePass] GPU VALIDATION ERROR: Destroyed texture [Texture "GlobeDepth-DepthCopy_color_rgba8unorm"] used in a submit.\n - While calling [Queue].Submit([[CommandBuffer from CommandEncoder "Scene Frame Command Encoder"]';

/** The same fault as the gate's persistent handler reports it. */
const UNCAPTURED_MESSAGE =
  '[webgpu] uncaptured GPU error: Destroyed texture [Texture "GlobeDepth-DepthCopy_color_rgba8unorm"] used in a submit.';

/** A zero occurrence record, the shape `countFaultOccurrences` returns. */
const NONE = Object.freeze({ destroyedTexture: 0, validation: 0, total: 0 });

/**
 * Build one run record of the shape `decideRunVerdict` and `aggregateHitRate`
 * consume, so each test states only what it varies.
 *
 * `shipped` is what the run saw in the phases that reproduce the demo as it
 * ships; `stressor` is what it saw under this probe's own resize stressor.
 * The leg's all-phase `occurrences` is their sum, exactly as `runLeg` builds
 * it, so a test that varies one of them cannot silently disagree with the
 * total the receipt reports.
 *
 * @param {object} options Overrides.
 * @returns {object} A run record.
 */
function runCell({
  run = 0,
  shipped = NONE,
  stressor = NONE,
  webglShipped = NONE,
  mismatchPct = 0.4,
  distinctCoarseColors = 64,
  deviceLost = null,
} = {}) {
  return {
    run,
    legs: {
      webgl: {
        renderer: "webgl",
        distinctCoarseColors: 64,
        shippedOccurrences: webglShipped,
      },
      webgpu: {
        renderer: "webgpu",
        occurrences: sumPhaseOccurrences([
          { occurrences: shipped },
          { occurrences: stressor },
        ]),
        shippedOccurrences: shipped,
        stressorOccurrences: stressor,
        deviceLost,
        distinctCoarseColors,
        diff: { comparable: true, mismatchPct },
      },
    },
  };
}

test("A. occurrences are counted, never de-duplicated", async (t) => {
  await t.test("A1: the same message three times counts three", () => {
    const counted = countFaultOccurrences([
      JOB3_MESSAGE,
      JOB3_MESSAGE,
      JOB3_MESSAGE,
    ]);
    assert.equal(counted.destroyedTexture, 3);
    assert.equal(counted.total, 3);
  });

  await t.test(
    "A2: the destroyed-texture family is counted apart from the general one, and a message in both counts once in the total",
    () => {
      const counted = countFaultOccurrences([
        JOB3_MESSAGE,
        "console.error: GPUValidationError: [Invalid RenderPipeline] is invalid due to a previous error.",
      ]);
      assert.equal(counted.destroyedTexture, 1);
      assert.equal(counted.validation, 2);
      assert.equal(counted.total, 2);
    },
  );

  await t.test("A3: the gate's persistent report counts too", () => {
    const counted = countFaultOccurrences([
      UNCAPTURED_MESSAGE,
      UNCAPTURED_MESSAGE,
    ]);
    assert.equal(counted.destroyedTexture, 2);
    assert.equal(counted.validation, 2);
    assert.equal(counted.total, 2);
  });

  await t.test(
    "A4 NEGATIVE CONTROL: unrelated traffic, including a benign mention of the texture, is not counted",
    () => {
      const counted = countFaultOccurrences([
        "console.warning: [WebGPU:GlobePass] 12 globe commands, renderPass=true",
        'GlobeDepth-DepthCopy-Pipeline created for [Texture "GlobeDepth-DepthCopy_color_rgba8unorm"]',
        "pageerror: Cannot read properties of undefined (reading 'subscribe')",
        "",
      ]);
      assert.equal(counted.total, 0);
      assert.equal(counted.destroyedTexture, 0);
      assert.equal(counted.validation, 0);
      assert.deepEqual(counted.samples, []);
    },
  );

  await t.test("A5: an empty or missing message list counts zero", () => {
    assert.equal(countFaultOccurrences([]).total, 0);
    assert.equal(countFaultOccurrences(undefined).total, 0);
  });

  await t.test("A6: at most five verbatim samples are carried", () => {
    const counted = countFaultOccurrences(Array(9).fill(JOB3_MESSAGE));
    assert.equal(counted.total, 9);
    assert.equal(counted.samples.length, 5);
  });
});

test("B. phase counts sum across a run without collapsing", async (t) => {
  await t.test("B1: two phases that each fired once sum to two", () => {
    const summed = sumPhaseOccurrences([
      { phase: "steady", occurrences: countFaultOccurrences([JOB3_MESSAGE]) },
      {
        phase: "resize",
        occurrences: countFaultOccurrences([UNCAPTURED_MESSAGE]),
      },
      { phase: "capture", occurrences: countFaultOccurrences([]) },
    ]);
    assert.equal(summed.destroyedTexture, 2);
    assert.equal(summed.total, 2);
  });

  await t.test(
    "B2: the resize stressor is split out of the shipped configuration, and neither loses a count",
    () => {
      const phases = [
        { phase: "steady", occurrences: countFaultOccurrences([JOB3_MESSAGE]) },
        {
          phase: "resize",
          occurrences: countFaultOccurrences([
            UNCAPTURED_MESSAGE,
            UNCAPTURED_MESSAGE,
          ]),
        },
        {
          phase: "capture",
          occurrences: countFaultOccurrences([UNCAPTURED_MESSAGE]),
        },
      ];
      const split = partitionOccurrences(phases);
      assert.equal(split.all.total, 4);
      assert.equal(split.shipped.total, 2, "steady + capture, not resize");
      assert.equal(split.stressor.total, 2, "resize only");
      assert.equal(
        split.shipped.total + split.stressor.total,
        split.all.total,
        "the split must not lose or double-count an occurrence",
      );
    },
  );
});

test("C. the aggregate is a hit RATE over runs, not a set union", async (t) => {
  const cells = [
    runCell({ run: 0 }),
    runCell({
      run: 1,
      shipped: { destroyedTexture: 2, validation: 2, total: 2 },
    }),
    runCell({ run: 2 }),
    runCell({
      run: 3,
      shipped: { destroyedTexture: 1, validation: 1, total: 1 },
    }),
  ];

  await t.test(
    "C1: three occurrences across two of four runs reports 2/4, not 1",
    () => {
      const aggregate = aggregateHitRate(cells);
      assert.equal(aggregate.runs, 4);
      assert.equal(aggregate.runsWithHit, 2);
      assert.equal(aggregate.hitRate, 0.5);
      assert.equal(aggregate.occurrences, 3);
      assert.equal(aggregate.destroyedTextureOccurrences, 3);
    },
  );

  await t.test("C2: per-run counts survive into the receipt", () => {
    const aggregate = aggregateHitRate(cells);
    assert.deepEqual(
      aggregate.perRun.map((entry) => entry.occurrences),
      [0, 2, 0, 1],
    );
  });

  await t.test("C3: a loop with no runs reports a zero rate, not NaN", () => {
    const aggregate = aggregateHitRate([]);
    assert.equal(aggregate.runs, 0);
    assert.equal(aggregate.hitRate, 0);
    assert.equal(aggregate.shippedHitRate, 0);
  });

  await t.test(
    "C4: a run that fired only under the resize stressor is counted, but apart from the shipped rate",
    () => {
      const mixed = [
        runCell({ run: 0 }),
        runCell({
          run: 1,
          stressor: { destroyedTexture: 3, validation: 3, total: 3 },
        }),
        runCell({
          run: 2,
          shipped: { destroyedTexture: 1, validation: 1, total: 1 },
        }),
      ];
      const aggregate = aggregateHitRate(mixed);
      assert.equal(aggregate.runs, 3);
      assert.equal(aggregate.runsWithHit, 2, "both runs fired at some point");
      assert.equal(
        aggregate.runsWithShippedHit,
        1,
        "only one fired in the shipped configuration",
      );
      assert.equal(aggregate.runsWithStressorHit, 1);
      assert.equal(aggregate.occurrences, 4);
      assert.equal(aggregate.shippedOccurrences, 1);
      assert.equal(aggregate.stressorOccurrences, 3);
      assert.deepEqual(
        aggregate.perRun.map((entry) => [entry.shipped, entry.stressor]),
        [
          [0, 0],
          [0, 3],
          [1, 0],
        ],
      );
    },
  );
});

test("D. a run's two clauses are independent", async (t) => {
  await t.test("D1: a clean capture does not excuse an occurrence", () => {
    const verdict = decideRunVerdict(
      runCell({
        shipped: { destroyedTexture: 1, validation: 1, total: 1 },
        mismatchPct: 0.4,
      }),
    );
    assert.equal(verdict.pass, false);
    assert.match(verdict.reasons.join(" "), /GlobeDepth-DepthCopy/);
  });

  await t.test("D2: zero occurrences do not excuse a drifted capture", () => {
    const verdict = decideRunVerdict(
      runCell({ mismatchPct: MAX_MISMATCH_PCT + 0.5 }),
    );
    assert.equal(verdict.pass, false);
    assert.match(verdict.reasons.join(" "), /differs from webgl/);
  });

  await t.test("D3: both clean passes", () => {
    const verdict = decideRunVerdict(runCell({}));
    assert.equal(verdict.pass, true);
    assert.deepEqual(verdict.reasons, []);
  });

  await t.test("D4: a canvas that never drew fails rather than passing", () => {
    const verdict = decideRunVerdict(
      runCell({ distinctCoarseColors: MIN_DISTINCT_COARSE_COLORS - 1 }),
    );
    assert.equal(verdict.pass, false);
    assert.match(verdict.reasons.join(" "), /nothing drew/);
  });

  await t.test("D5: a lost device fails the run", () => {
    const verdict = decideRunVerdict(
      runCell({ deviceLost: "[webgpu] device lost: reason=unknown" }),
    );
    assert.equal(verdict.pass, false);
    assert.match(verdict.reasons.join(" "), /device lost/);
  });

  await t.test(
    "D6: a hit that fired ONLY under the resize stressor does not fail the run — that condition has a different owner",
    () => {
      const cell = runCell({
        stressor: { destroyedTexture: 4, validation: 4, total: 4 },
      });
      assert.equal(
        cell.legs.webgpu.occurrences.total,
        4,
        "the receipt still carries the occurrence",
      );
      const verdict = decideRunVerdict(cell);
      assert.equal(verdict.pass, true);
      assert.deepEqual(verdict.reasons, []);
    },
  );

  await t.test(
    "D7 CONTROL: a validation occurrence on the WebGL leg fails the run — a WebGL context cannot produce this family",
    () => {
      const verdict = decideRunVerdict(
        runCell({
          webglShipped: { destroyedTexture: 0, validation: 1, total: 1 },
        }),
      );
      assert.equal(verdict.pass, false);
      assert.match(verdict.reasons.join(" "), /webgl control/);
    },
  );

  await t.test(
    "D8: a leg record with no shipped-phase count fails CLOSED — a missing measurement is not a clean one",
    () => {
      const cell = runCell({});
      delete cell.legs.webgpu.shippedOccurrences;
      const verdict = decideRunVerdict(cell);
      assert.equal(verdict.pass, false);
      assert.match(
        verdict.reasons.join(" "),
        /no shipped-phase occurrence count/,
      );
    },
  );
});

test("E. the loop drives the process exit code", async (t) => {
  await t.test(
    "E1: one hit anywhere in the loop exits non-zero, today's expected outcome",
    () => {
      const cells = [
        runCell({ run: 0 }),
        runCell({
          run: 1,
          shipped: { destroyedTexture: 1, validation: 1, total: 1 },
        }),
      ].map((cell) => ({ ...cell, verdict: decideRunVerdict(cell) }));
      const aggregate = decideAggregateVerdict(cells);
      assert.equal(aggregate.pass, false);
      const verdicts = [...cells.map((cell) => cell.verdict), aggregate];
      assert.notEqual(
        exitCodeForOutcome({ refusal: null, errored: false, verdicts }),
        0,
      );
    },
  );

  await t.test("E2: a clean loop exits zero, the outcome AR-887 owes", () => {
    const cells = [runCell({ run: 0 }), runCell({ run: 1 })].map((cell) => ({
      ...cell,
      verdict: decideRunVerdict(cell),
    }));
    const aggregate = decideAggregateVerdict(cells);
    assert.equal(aggregate.pass, true);
    const verdicts = [...cells.map((cell) => cell.verdict), aggregate];
    assert.equal(
      exitCodeForOutcome({ refusal: null, errored: false, verdicts }),
      0,
    );
  });

  await t.test("E3: an empty loop is a failure, not a silent pass", () => {
    const aggregate = decideAggregateVerdict([]);
    assert.equal(aggregate.pass, false);
  });

  await t.test(
    "E4: a loop whose ONLY hits are resize-phase exits ZERO and reports them as attribution — so AR-890's 'zero after AR-887' clause is reachable without the other owner's fix",
    () => {
      const cells = [
        runCell({ run: 0 }),
        runCell({
          run: 1,
          stressor: { destroyedTexture: 2, validation: 2, total: 2 },
        }),
      ].map((cell) => ({ ...cell, verdict: decideRunVerdict(cell) }));
      const aggregate = decideAggregateVerdict(cells);
      assert.equal(aggregate.pass, true);
      assert.equal(aggregate.aggregate.runsWithHit, 1);
      assert.equal(aggregate.aggregate.runsWithShippedHit, 0);
      assert.match(
        String(aggregate.attribution),
        /NEW-WEBGPU-SCENE-PASS-MSAA-FLIP-TRANSITION/,
      );
      const verdicts = [...cells.map((cell) => cell.verdict), aggregate];
      assert.equal(
        exitCodeForOutcome({ refusal: null, errored: false, verdicts }),
        0,
      );
    },
  );

  await t.test(
    "E5: a clean loop carries no attribution line, so the summary never invents one",
    () => {
      const cells = [runCell({ run: 0 })].map((cell) => ({
        ...cell,
        verdict: decideRunVerdict(cell),
      }));
      assert.equal(decideAggregateVerdict(cells).attribution, null);
    },
  );
});

test("F. the run count actually delivers the confidence the header claims", async (t) => {
  await t.test(
    "F1: DEFAULT_RUNS detects a 22.1 % per-run rate at 95 % confidence",
    () => {
      assert.ok(
        Math.pow(1 - 0.221, DEFAULT_RUNS) <= 0.05,
        `${DEFAULT_RUNS} runs miss a 22.1 % rate with probability ${Math.pow(1 - 0.221, DEFAULT_RUNS)}, above 0.05`,
      );
    },
  );

  await t.test(
    "F2: it is the SMALLEST run count that does, so the loop is not padded",
    () => {
      assert.ok(Math.pow(1 - 0.221, DEFAULT_RUNS - 1) > 0.05);
    },
  );
});
