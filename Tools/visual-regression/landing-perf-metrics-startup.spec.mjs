// landing-perf-metrics-startup.spec.mjs - the PF-3 startup metric. Pure Node: no browser, no GPU.
// @purpose Asserts the PF-3 startup intervals, the navigation fallback (M5) and the Round 2 repeat preservation and outcome gating (M7) of the startup metric match the BEHAVIOUR_CELOS.md specification.
// @status ACTIVE
//
// Covers behaviours M5 and M7 of the original landing-perf-metrics spec, which was split by concern
// (row DX-KIT-LANDING-SPECS-OVER-SIZE); the test names and bodies are unchanged. Every assertion drives
// the real metric functions with pure in-memory inputs.

import assert from "node:assert/strict";
import test from "node:test";
import {
  CLOUDLESS_STARTUP_FIELD,
  DEFAULT_STARTUP_FIELD,
  STARTUP_FIELDS,
  startupVerdict,
  summarizeStartup,
} from "./lib/metrics/startup-compile.mjs";
import { makeRawStartupRecord } from "./fixtures/landing-perf-metrics-inputs.mjs";

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
