// C11-146 / S8-7 — settle-window attribution rule + first-complete-frame metric.
//
// This is the GUARD that stops the boot/TTFF cluster booking wins it did not
// earn, so it has to be provable without a browser. Two claims are pinned here:
//
//   * A settle window with zero main-thread long tasks is GPU-submit bound, and
//     a main-thread closure/churn fix must NOT book stable-time credit against
//     it — the exact failure mode S8-7 was filed for (WebGPU's +1.3–1.7 s
//     tile-stable is GPU-submit-traffic bound with zero main-thread long tasks).
//   * "First complete frame" means every SELECTED tile is drawing its own
//     loaded geometry, held for N frames. A single complete frame mid-stream is
//     flicker, not completion.
//
// The runner's own wiring is checked structurally too: the historical
// `frameNumber > 0` proxy must survive unchanged (never re-derive a baseline),
// and the new metric must be additive.
//
// Run: node --test Tools/visual-regression/settle-attribution.spec.mjs

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  FIRST_COMPLETE_FRAME_STABLE_FRAMES,
  MAIN_THREAD_BOUND_FRACTION,
  SETTLE_ATTRIBUTION_RULE,
  classifySettleAttribution,
  classifySettleDelta,
  findFirstCompleteFrame,
  sumLongTasksInWindow,
} from "./lib/settle-attribution.mjs";

const directory = dirname(fileURLToPath(import.meta.url));

const frame = (tSinceSetupMs, selectedTileCount, completeTileCount) => ({
  frameNumber: Math.round(tSinceSetupMs),
  tSinceSetupMs,
  selectedTileCount,
  completeTileCount,
});

// ───────────────────────── long-task windowing ─────────────────────────

test("long tasks are clipped to the window, not counted whole", () => {
  const tasks = [
    { startTime: 0, duration: 100 }, // entirely before
    { startTime: 150, duration: 100 }, // straddles the start
    { startTime: 300, duration: 50 }, // fully inside
    { startTime: 480, duration: 100 }, // straddles the end
    { startTime: 900, duration: 60 }, // entirely after
  ];
  const summary = sumLongTasksInWindow(tasks, 200, 500);
  assert.equal(summary.count, 3);
  // 50 (clipped head) + 50 (inside) + 20 (clipped tail)
  assert.equal(summary.totalMs, 120);
  assert.equal(summary.longestMs, 50);

  assert.deepEqual(sumLongTasksInWindow([], 0, 100), {
    count: 0,
    totalMs: 0,
    longestMs: 0,
  });
  assert.deepEqual(sumLongTasksInWindow(undefined, 0, 100), {
    count: 0,
    totalMs: 0,
    longestMs: 0,
  });
});

// ──────────────────────── the attribution rule ────────────────────────

test("THE RULE: a settle window with no long tasks is GPU-submit bound and not creditable", () => {
  const attribution = classifySettleAttribution({
    longTasks: [],
    windowStartMs: 1000,
    windowEndMs: 2600, // the 1.6 s tile-stable lag S8-7 describes
    available: true,
  });
  assert.equal(attribution.bound, "gpu-submit");
  assert.equal(attribution.creditable, false);
  assert.match(attribution.reason, /GPU-submit bound/);
  assert.equal(attribution.longTasks.totalMs, 0);
  assert.equal(attribution.window.durationMs, 1600);
  assert.equal(attribution.rule, SETTLE_ATTRIBUTION_RULE);
});

test("a long-task-dominated settle window is main-thread bound and creditable", () => {
  const attribution = classifySettleAttribution({
    longTasks: [
      { startTime: 1000, duration: 300 },
      { startTime: 1500, duration: 400 },
    ],
    windowStartMs: 1000,
    windowEndMs: 2000,
    available: true,
  });
  assert.equal(attribution.bound, "main-thread");
  assert.equal(attribution.creditable, true);
  assert.equal(attribution.longTasks.totalMs, 700);
  assert.equal(attribution.longTasks.fraction, 0.7);
  assert.ok(attribution.longTasks.fraction >= MAIN_THREAD_BOUND_FRACTION);
});

test("a thin sliver of main-thread work is 'mixed', and says credit needs evidence", () => {
  const attribution = classifySettleAttribution({
    longTasks: [{ startTime: 1000, duration: 60 }],
    windowStartMs: 1000,
    windowEndMs: 2000,
    available: true,
  });
  assert.equal(attribution.bound, "mixed");
  assert.equal(attribution.creditable, true);
  assert.match(attribution.reason, /accompanying long-task reduction/);
});

test("unobservable or degenerate windows are 'unknown' and NOT creditable", () => {
  const unobserved = classifySettleAttribution({
    longTasks: [],
    windowStartMs: 0,
    windowEndMs: 1000,
    available: false,
  });
  assert.equal(unobserved.bound, "unknown");
  assert.equal(unobserved.creditable, false, "no evidence is not permission");
  assert.match(unobserved.reason, /unavailable/);

  const degenerate = classifySettleAttribution({
    longTasks: [],
    windowStartMs: 500,
    windowEndMs: 500,
    available: true,
  });
  assert.equal(degenerate.bound, "unknown");
  assert.equal(degenerate.creditable, false);
});

test("delta rule: a settle win without a long-task reduction is not bookable", () => {
  const gpuBound = (settleMs) => ({
    settleMs,
    attribution: classifySettleAttribution({
      longTasks: [],
      windowStartMs: 0,
      windowEndMs: settleMs,
      available: true,
    }),
  });

  // The S8-7 scenario: settle got faster, but nothing on the main thread did.
  const notBookable = classifySettleDelta({
    baseline: gpuBound(1700),
    candidate: gpuBound(1400),
  });
  assert.equal(notBookable.improved, true);
  assert.equal(notBookable.bookable, false);
  assert.match(notBookable.reason, /no main-thread long-task reduction/);

  // A real main-thread reduction alongside the settle win IS bookable.
  const withLongTasks = (settleMs, longTaskMs) => ({
    settleMs,
    attribution: classifySettleAttribution({
      longTasks: [{ startTime: 0, duration: longTaskMs }],
      windowStartMs: 0,
      windowEndMs: settleMs,
      available: true,
    }),
  });
  const bookable = classifySettleDelta({
    baseline: withLongTasks(1700, 600),
    candidate: withLongTasks(1400, 300),
  });
  assert.equal(bookable.bookable, true);
  assert.equal(bookable.longTaskDeltaMs, -300);

  // A regression is never bookable, whatever the long tasks did.
  const regressed = classifySettleDelta({
    baseline: withLongTasks(1400, 600),
    candidate: withLongTasks(1700, 100),
  });
  assert.equal(regressed.improved, false);
  assert.equal(regressed.bookable, false);
});

// ──────────────────── the first-complete-frame metric ────────────────────

test("first-complete-frame requires a stable run and reports its FIRST frame", () => {
  const trace = [
    frame(10, 0, 0), // nothing selected yet
    frame(20, 40, 12), // streaming
    frame(30, 40, 40), // complete — but flicker until proven
    frame(40, 42, 39), // a new tile came in: incomplete again
    frame(50, 42, 42),
    frame(60, 42, 42),
    frame(70, 42, 42), // third consecutive complete frame
    frame(80, 42, 42),
  ];
  const found = findFirstCompleteFrame(trace, { stableFrames: 3 });
  assert.ok(found, "a stable run must be detected");
  assert.equal(found.tSinceSetupMs, 50, "report the run's first frame");
  assert.equal(found.index, 4);
  assert.equal(found.stableFrames, 3);
});

test("a single complete frame amid streaming is flicker, not completion", () => {
  const flickering = [
    frame(10, 40, 40),
    frame(20, 41, 30),
    frame(30, 41, 41),
    frame(40, 43, 20),
    frame(50, 43, 43),
  ];
  assert.equal(findFirstCompleteFrame(flickering, { stableFrames: 3 }), null);
  // With no anti-flicker requirement the same trace "completes" immediately —
  // which is exactly the false-early complete the run length exists to reject.
  assert.equal(
    findFirstCompleteFrame(flickering, { stableFrames: 1 })?.tSinceSetupMs,
    10,
  );
});

test("an empty selection never counts as complete", () => {
  const empty = [frame(10, 0, 0), frame(20, 0, 0), frame(30, 0, 0)];
  assert.equal(findFirstCompleteFrame(empty, { stableFrames: 3 }), null);
  assert.equal(findFirstCompleteFrame([], { stableFrames: 3 }), null);
  assert.equal(findFirstCompleteFrame(undefined), null);
});

test("first-complete lags the first observed frame — that is the whole point", () => {
  // `frameNumber > 0` fires at the first frame (t=10 here) while the scene is
  // still upsampled fill; perceived completion is 900 ms later.
  const trace = [];
  for (let t = 10; t <= 900; t += 10) {
    trace.push(frame(t, 48, t < 900 ? 20 : 48));
  }
  for (let t = 910; t <= 940; t += 10) {
    trace.push(frame(t, 48, 48));
  }
  const found = findFirstCompleteFrame(trace, {
    stableFrames: FIRST_COMPLETE_FRAME_STABLE_FRAMES,
  });
  assert.equal(found.tSinceSetupMs, 900);
  assert.ok(
    found.tSinceSetupMs - trace[0].tSinceSetupMs > 800,
    "the metric must be able to lag the first-frame proxy substantially",
  );
});

// ───────────────────────── runner wiring anchors ─────────────────────────

test("the runner reports the new metric ADDITIVELY, keeping the old proxy", async () => {
  const source = await readFile(
    resolve(directory, "run-performance-campaign.mjs"),
    "utf8",
  );
  // Trap 1: never overwrite a historical metric — the C9-30 / Gate-A anchors
  // are stated against `frameNumber > 0`.
  assert.match(source, /frameNumber > 0/);
  assert.match(source, /navigationToFirstObservedFrameMs: firstObservedFrame/);
  assert.match(source, /navigationToStableMs:/);
  // ...and the new ones are present alongside it.
  assert.match(source, /navigationToFirstCompleteFrameMs:/);
  assert.match(source, /setupToFirstCompleteFrameMs: firstCompleteFrameMs/);
  assert.match(source, /settleAttribution,/);
  assert.match(source, /classifySettleAttribution\(\{/);
  assert.match(source, /findFirstCompleteFrame\(/);
  // The completion scan must not run through the measured window.
  assert.match(source, /removeCompletionListener\(\);/);
});
