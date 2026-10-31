// landing-perf-metrics-residency.spec.mjs - the PF-4 residency metric. Pure Node: no browser, no GPU.
// @purpose Asserts the PF-4 GPU memory residency and growth metric (M6, Rounds 2 and 3) matches the BEHAVIOUR_CELOS.md specification.
// @status ACTIVE
//
// Covers behaviours M6 of the original landing-perf-metrics spec, which was split by concern
// (row DX-KIT-LANDING-SPECS-OVER-SIZE); the test names and bodies are unchanged. Every assertion drives
// the real metric functions with pure in-memory inputs.

import assert from "node:assert/strict";
import test from "node:test";
import {
  residencyVerdict,
  summarizeResidency,
} from "./lib/metrics/gpu-memory-residency.mjs";

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
