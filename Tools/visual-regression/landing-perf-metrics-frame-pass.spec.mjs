// landing-perf-metrics-frame-pass.spec.mjs - the PF-1 and PF-2 metrics. Pure Node: no browser, no GPU.
// @purpose Asserts the PF-1 frame-time distribution (M3) and PF-2 GPU pass-cost (M4) metric functions match the BEHAVIOUR_CELOS.md specification.
// @status ACTIVE
//
// Covers behaviours M3-M4 of the original landing-perf-metrics spec, which was split by concern
// (row DX-KIT-LANDING-SPECS-OVER-SIZE); the test names and bodies are unchanged. Every assertion drives
// the real metric functions with pure in-memory inputs.

import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_STUTTER_FACTOR,
  PF1_STATISTICS,
  frameTimeVerdict,
  summarizeFrameTimes,
} from "./lib/metrics/frame-time-distribution.mjs";
import {
  CLOUD_PASS_RE,
  passCostVerdict,
  summarizePassCost,
} from "./lib/metrics/gpu-pass-cost.mjs";
import { makePassCostResult } from "./fixtures/landing-perf-metrics-inputs.mjs";

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
