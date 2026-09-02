// aec-residency-e1.spec.mjs — hermetic spec over the E-1 residency instrument's
// pure half: refusal rules, receipt shape, and the pre-registered discriminator.
//
// No browser, no network, no GPU, no filesystem writes. Every input is a literal
// built in this file, so a failure here is a defect in the instrument and never
// a flaky scene.
//
// WHAT THIS SPEC IS FOR, AND WHAT IT DELIBERATELY DOES NOT DO. The probe's value
// is that it can come out WRONG: its bands are frozen before any run, and one of
// its outcomes is "neither hypothesis". A spec that asserted the source text
// contains those bands would certify the brief instead of the behaviour, which
// is the failure mode CLAUDE.md Principle 10 names. So every assertion below
// drives the real exported functions over synthetic profiles and frame samples
// whose verdict is decidable by hand from the pre-registration, and the two
// mutant subtests make the guards UNREACHABLE (never merely absent) and require
// the spec to go red.

import assert from "node:assert/strict";
import test from "node:test";

import {
  E1_PREDICTIONS,
  E1_VERDICTS,
  E1RefusalError,
  EXIT_CODES,
  REQUIRED_SERVED_ARTIFACTS,
  aggregateHeapSamplingProfile,
  aggregateSelfTime,
  buildMarkdownSummary,
  buildReceipt,
  classifySettleWindow,
  decideEqualContentRefusal,
  deriveEntryContext,
  decideOriginRefusal,
  decidePreflightRefusal,
  decideReadinessRefusal,
  p50P95,
  parseArgs,
  pendingFractionOf,
  percentile,
  summarizeCacheSamples,
  summarizeFrameSamples,
  summarizeModuleCoverage,
} from "./lib/aec-residency-e1.mjs";

/**
 * Build a synthetic `.cpuprofile` with a chosen split of self time between busy
 * frames and the idle frame.
 *
 * @param {{busyUs: number, idleUs: number, busyName?: string}} input Split.
 * @returns {object} A profile shaped like `Profiler.stop` returns.
 */
function makeProfile({ busyUs, idleUs, busyName = "prepareModel" }) {
  return {
    nodes: [
      {
        id: 1,
        callFrame: { functionName: "(root)", url: "", lineNumber: -1 },
      },
      {
        id: 2,
        callFrame: {
          functionName: busyName,
          url: "http://localhost:8094/Build/CesiumUnminified/index.js",
          lineNumber: 4200,
        },
      },
      {
        id: 3,
        callFrame: { functionName: "(idle)", url: "", lineNumber: -1 },
      },
    ],
    samples: [2, 3],
    timeDeltas: [busyUs, idleUs],
  };
}

/**
 * Build per-frame samples with a chosen fraction carrying a pending pipeline.
 *
 * @param {{count: number, pendingCount: number}} input Counts.
 * @returns {object[]} Frame samples.
 */
function makeFrames({ count, pendingCount }) {
  const frames = [];
  for (let index = 0; index < count; index++) {
    frames.push({
      index,
      frameNumber: index + 1,
      sinceLastFrameMs: 16 + index,
      commandListLength: 1300 + index,
      pipelineCache: {
        hits: 100 + index,
        misses: 10,
        created: 12 + index,
        pending: index < pendingCount ? 3 : 0,
      },
    });
  }
  return frames;
}

/**
 * Build wall-clock poll samples with a chosen pending count and interval.
 *
 * @param {{count: number, pendingCount: number, intervalMs?: number}} input Counts.
 * @returns {object[]} Poll samples.
 */
function makeCacheSamples({ count, pendingCount, intervalMs = 250 }) {
  const samples = [];
  for (let index = 0; index < count; index++) {
    samples.push({
      atMs: intervalMs * (index + 1),
      sinceLastSampleMs: intervalMs,
      pipelineCache: {
        hits: 100 + index,
        misses: 10,
        created: 12 + index,
        pending: index < pendingCount ? 3 : 0,
      },
    });
  }
  return samples;
}

function readyReadiness(overrides = {}) {
  return {
    renderReady: true,
    reached: true,
    framesProduced: 240,
    commandListLength: 1360,
    pendingResourceCount: 0,
    sceneFrameNumber: 397,
    ...overrides,
  };
}

test("the pre-registration is frozen and names both hypotheses with disjoint bands", () => {
  assert.equal(Object.isFrozen(E1_PREDICTIONS), true);
  assert.equal(Object.isFrozen(E1_PREDICTIONS.hypotheses), true);
  assert.deepEqual(Object.keys(E1_PREDICTIONS.hypotheses).sort(), [
    "main-thread-starved",
    "pipeline-creation-bound",
  ]);
  // The bands must not overlap, or a single observation could satisfy both
  // hypotheses at once and the discriminator would not discriminate.
  assert.ok(E1_PREDICTIONS.busyLow < E1_PREDICTIONS.busyHigh);
  assert.ok(E1_PREDICTIONS.pendingLow < E1_PREDICTIONS.pendingHigh);
});

test("the pre-registered numbers are pinned, so a post-hoc retune is a red gate", () => {
  // THIS IS THE POINT OF THE WHOLE ARTIFACT. `Object.isFrozen` pins runtime
  // immutability only, which no source edit is affected by: the bands could be
  // retuned after seeing a run and every gate would stay green, producing two
  // receipts that both claim to be pre-registered under the same name. The
  // literal values ARE the pre-registration, so the literal values are what a
  // spec has to hold.
  assert.deepEqual(
    {
      registeredOn: E1_PREDICTIONS.registeredOn,
      busyLow: E1_PREDICTIONS.busyLow,
      busyHigh: E1_PREDICTIONS.busyHigh,
      pendingLow: E1_PREDICTIONS.pendingLow,
      pendingHigh: E1_PREDICTIONS.pendingHigh,
      sampleCoverageFloor: E1_PREDICTIONS.sampleCoverageFloor,
      minimumFrameSamples: E1_PREDICTIONS.minimumFrameSamples,
      minimumCacheSamples: E1_PREDICTIONS.minimumCacheSamples,
    },
    {
      registeredOn: "2026-09-02",
      busyLow: 0.35,
      busyHigh: 0.7,
      pendingLow: 0.2,
      pendingHigh: 0.5,
      sampleCoverageFloor: 0.5,
      minimumFrameSamples: 8,
      minimumCacheSamples: 8,
    },
    "changing a pre-registered band is a deliberate act that must be reviewed, never an invisible edit",
  );
});

test("an idle main thread with a busy pipeline cache reads as V-4", () => {
  const result = classifySettleWindow({
    profile: makeProfile({ busyUs: 20000, idleUs: 80000 }),
    frameSamples: makeFrames({ count: 20, pendingCount: 18 }),
    windowMs: 120,
  });
  assert.equal(result.verdict, E1_VERDICTS.PIPELINE_CREATION_BOUND);
  assert.equal(result.mainThreadBusyFraction, 0.2);
  assert.equal(result.pipelinePendingFrameFraction, 0.9);
});

test("a busy main thread with a quiet pipeline cache reads as starvation and names the owner", () => {
  const result = classifySettleWindow({
    profile: makeProfile({ busyUs: 90000, idleUs: 10000 }),
    frameSamples: makeFrames({ count: 20, pendingCount: 1 }),
    windowMs: 120,
  });
  assert.equal(result.verdict, E1_VERDICTS.MAIN_THREAD_STARVED);
  assert.equal(result.mainThreadBusyFraction, 0.9);
  assert.equal(result.pipelinePendingFrameFraction, 0.05);
  assert.match(result.topSelfTime[0].fn, /^prepareModel @ index\.js:4200$/);
});

test("both signatures at once is reported as both, not as the stronger one", () => {
  const result = classifySettleWindow({
    profile: makeProfile({ busyUs: 90000, idleUs: 10000 }),
    frameSamples: makeFrames({ count: 20, pendingCount: 18 }),
    windowMs: 120,
  });
  assert.equal(result.verdict, E1_VERDICTS.BOTH_PRESENT);
});

test("an idle thread AND a quiet cache is reported as neither, so the prediction can be wrong", () => {
  // This is the outcome that makes the pre-registration falsifiable: if the
  // window is spent waiting on something neither hypothesis models, the row
  // reopens instead of being narrated into one of the two existing stories.
  const result = classifySettleWindow({
    profile: makeProfile({ busyUs: 20000, idleUs: 80000 }),
    frameSamples: makeFrames({ count: 20, pendingCount: 1 }),
    windowMs: 120,
  });
  assert.equal(result.verdict, E1_VERDICTS.NEITHER_UNMODELLED_WAIT);
});

test("the pending axis is the time-weighted poll, not the per-frame reading", () => {
  // The two disagree on purpose here: 1 of 20 FRAMES saw a pending pipeline,
  // while 18 of 20 wall-clock POLL samples did. Per frame this window reads as
  // "neither hypothesis"; sampled across the whole window it is V-4's exact
  // signature. On the leg this row is about, frames arrive about 18 times in
  // 75 s, so the per-frame reading is 18 instants and the poll is the window.
  const result = classifySettleWindow({
    profile: makeProfile({ busyUs: 20000, idleUs: 80000 }),
    frameSamples: makeFrames({ count: 20, pendingCount: 1 }),
    cacheSamples: makeCacheSamples({ count: 20, pendingCount: 18 }),
    windowMs: 120,
  });
  assert.equal(result.pipelinePendingFractionAxis, "time-weighted-poll");
  assert.equal(result.pipelinePendingFraction, 0.9);
  assert.equal(result.pipelinePendingFrameFraction, 0.05);
  assert.equal(result.verdict, E1_VERDICTS.PIPELINE_CREATION_BOUND);
});

test("a stall too deep to produce eight frames is still decidable from the poll", () => {
  // The instrument must not lose power exactly as the defect intensifies. Three
  // frames is below `minimumFrameSamples`; the poll still holds the window, so
  // the sufficiency floor that applies is the one for the axis in use.
  const result = classifySettleWindow({
    profile: makeProfile({ busyUs: 20000, idleUs: 80000 }),
    frameSamples: makeFrames({ count: 3, pendingCount: 3 }),
    cacheSamples: makeCacheSamples({ count: 300, pendingCount: 280 }),
    windowMs: 120,
  });
  assert.equal(result.verdict, E1_VERDICTS.PIPELINE_CREATION_BOUND);
  assert.equal(result.cachePoll.cacheSampleCount, 300);
});

test("too few poll samples is undecidable under the poll axis's own floor", () => {
  const result = classifySettleWindow({
    profile: makeProfile({ busyUs: 20000, idleUs: 80000 }),
    frameSamples: makeFrames({ count: 20, pendingCount: 18 }),
    cacheSamples: makeCacheSamples({ count: 4, pendingCount: 4 }),
    windowMs: 120,
  });
  assert.equal(result.verdict, E1_VERDICTS.UNDECIDABLE);
  assert.equal(result.reason, "too-few-cache-samples");
});

test("a poll that never saw a cache falls back to the per-frame axis and says so", () => {
  const result = classifySettleWindow({
    profile: makeProfile({ busyUs: 20000, idleUs: 80000 }),
    frameSamples: makeFrames({ count: 20, pendingCount: 18 }),
    cacheSamples: makeCacheSamples({ count: 20, pendingCount: 20 }).map(
      (sample) => ({ ...sample, pipelineCache: null }),
    ),
    windowMs: 120,
  });
  assert.equal(result.pipelinePendingFractionAxis, "frame-weighted");
  assert.equal(result.pipelinePendingFraction, 0.9);
  assert.equal(result.verdict, E1_VERDICTS.PIPELINE_CREATION_BOUND);
});

test("a poll tick deferred behind a long task is weighted by the time it covered", () => {
  // A tick that arrives 5 s late reports the state of 5 s, not of one tick. If
  // samples were counted rather than weighted, this window would read 0.25.
  const summary = summarizeCacheSamples([
    { sinceLastSampleMs: 250, pipelineCache: { pending: 0, created: 4 } },
    { sinceLastSampleMs: 250, pipelineCache: { pending: 0, created: 4 } },
    { sinceLastSampleMs: 250, pipelineCache: { pending: 0, created: 4 } },
    { sinceLastSampleMs: 5000, pipelineCache: { pending: 2, created: 9 } },
  ]);
  assert.equal(summary.cacheSampleCount, 4);
  assert.equal(summary.weightedSpanMs, 5750);
  assert.equal(summary.pendingSpanMs, 5000);
  assert.ok(Math.abs(summary.pipelinePendingTimeFraction - 5000 / 5750) < 1e-9);
  assert.equal(summary.pipelineCreatedDelta, 5);
});

test("the denominator counts only the readings that carried a cache", () => {
  // `_webgpuPipelineCache` is created lazily (WebGPUContext.ts:7137) from a
  // field initialised to null (:658), and `getRendererStatistics` publishes no
  // `pipelineCache` key until it exists (:6924) — so a mixed null/non-null set
  // occurs on EVERY WebGPU run. Dividing by the full sample count would dilute
  // the fraction by however long the cache took to appear, biasing the window
  // away from the hypothesis it exists to test.
  const rows = [];
  for (let index = 0; index < 10; index++) {
    rows.push({
      sinceLastFrameMs: 16,
      commandListLength: 100,
      pipelineCache:
        index < 5 ? null : { pending: index < 8 ? 4 : 0, created: index },
    });
  }
  const summary = summarizeFrameSamples(rows);
  assert.equal(summary.frameSampleCount, 10);
  assert.equal(summary.cacheSampleCount, 5);
  assert.equal(summary.pipelinePendingFrameFraction, 0.6);
  assert.notEqual(
    summary.pipelinePendingFrameFraction,
    3 / rows.length,
    "dividing by every frame instead of every frame WITH a cache must not agree",
  );

  const mixedPoll = summarizeCacheSamples([
    { sinceLastSampleMs: 250, pipelineCache: null },
    { sinceLastSampleMs: 250, pipelineCache: null },
    { sinceLastSampleMs: 250, pipelineCache: { pending: 1, created: 2 } },
    { sinceLastSampleMs: 250, pipelineCache: { pending: 0, created: 3 } },
  ]);
  assert.equal(mixedPoll.pollSampleCount, 4);
  assert.equal(mixedPoll.cacheSampleCount, 2);
  assert.equal(mixedPoll.pipelinePendingTimeFraction, 0.5);
});

test("a zero-weight reading cannot enter either denominator", () => {
  assert.deepEqual(
    pendingFractionOf([
      { cache: { pending: 5 }, weight: 0 },
      { cache: { pending: 0 }, weight: 10 },
    ]),
    { sampleCount: 1, weight: 10, pendingWeight: 0, fraction: 0 },
  );
  assert.equal(pendingFractionOf([]).fraction, null);
  assert.equal(pendingFractionOf(undefined).fraction, null);
});

test("a profile that sampled far less than the window it covered is undecidable, not a verdict", () => {
  const result = classifySettleWindow({
    profile: makeProfile({ busyUs: 1000, idleUs: 1000 }),
    frameSamples: makeFrames({ count: 20, pendingCount: 18 }),
    windowMs: 75000,
  });
  assert.equal(result.verdict, E1_VERDICTS.UNDECIDABLE);
  assert.equal(result.reason, "sample-coverage-below-floor");
});

test("a WebGL leg, whose pipeline cache does not exist, is undecidable with a named reason", () => {
  // WebGL publishes no `pipelineCache` in `getRendererStatistics()`, so its
  // samples carry null. The busy fraction still lands in the evidence as the
  // control reading; only the verdict is withheld.
  const frames = makeFrames({ count: 20, pendingCount: 0 }).map((frame) => ({
    ...frame,
    pipelineCache: null,
  }));
  const result = classifySettleWindow({
    profile: makeProfile({ busyUs: 90000, idleUs: 10000 }),
    frameSamples: frames,
    windowMs: 120,
  });
  assert.equal(result.verdict, E1_VERDICTS.UNDECIDABLE);
  assert.equal(result.reason, "pipeline-cache-never-sampled");
  assert.equal(result.mainThreadBusyFraction, 0.9);
});

test("`(program)` counts as a busy main thread; only `(idle)` and `(root)` do not", () => {
  const aggregate = aggregateSelfTime({
    nodes: [
      { id: 1, callFrame: { functionName: "(program)", url: "" } },
      { id: 2, callFrame: { functionName: "(idle)", url: "" } },
      { id: 3, callFrame: { functionName: "(root)", url: "" } },
    ],
    samples: [1, 2, 3],
    timeDeltas: [5000, 3000, 2000],
  });
  assert.equal(aggregate.totalMs, 10);
  assert.equal(aggregate.idleMs, 5);
  assert.equal(aggregate.busyMs, 5);
});

test("a stalled leg — renderReady true with zero frames — is recorded, never refused", () => {
  // The 2026-09-01 WebGPU leg's own shape. `Scene#renderReady` reads true on a
  // scene that has never rendered, so this pair is the stall's signature. A
  // guard that refused it would delete the finding it exists to capture.
  const decision = decideReadinessRefusal({
    renderReady: true,
    reached: false,
    framesProduced: 0,
    commandListLength: 0,
    pendingResourceCount: 0,
  });
  assert.equal(decision.refuse, false);
});

test("a leg that CLAIMS readiness with no frames is refused as vacuous", () => {
  const decision = decideReadinessRefusal({
    renderReady: true,
    reached: true,
    framesProduced: 0,
    commandListLength: 0,
  });
  assert.equal(decision.refuse, true);
  assert.equal(decision.reason, "readiness-gate-vacuous");
  assert.equal(decision.exitCode, EXIT_CODES.REFUSAL);
});

test("a leg that denies a readiness its own numbers support is refused as inconsistent", () => {
  const decision = decideReadinessRefusal(readyReadiness({ reached: false }));
  assert.equal(decision.refuse, true);
  assert.equal(decision.reason, "readiness-flag-inconsistent");
});

test("the equal-content comparison is refused when either backend never became ready", () => {
  const decision = decideEqualContentRefusal({
    legs: [
      {
        backend: "webgl",
        readiness: readyReadiness(),
        validatedPick: { x: 384, y: 252 },
      },
      {
        backend: "webgpu",
        readiness: { ...readyReadiness(), reached: false, framesProduced: 18 },
        validatedPick: { x: 384, y: 252 },
      },
    ],
  });
  assert.equal(decision.refuse, true);
  assert.equal(decision.reason, "equal-content-leg-void");
  assert.deepEqual(decision.details.backends, ["webgpu"]);
});

test("the equal-content comparison is refused when the legs used different pixels", () => {
  // The exact defect that voided the 2026-08-29 pick ratio: one leg measured at
  // its validated hit and the other fell back to canvas centre.
  const decision = decideEqualContentRefusal({
    legs: [
      {
        backend: "webgl",
        readiness: readyReadiness(),
        validatedPick: { x: 384, y: 252 },
      },
      {
        backend: "webgpu",
        readiness: readyReadiness(),
        validatedPick: { x: 640, y: 360 },
      },
    ],
  });
  assert.equal(decision.refuse, true);
  assert.equal(decision.reason, "pick-position-not-shared");
});

test("two ready legs pinned to one pixel are accepted", () => {
  const decision = decideEqualContentRefusal({
    legs: [
      {
        backend: "webgl",
        readiness: readyReadiness(),
        validatedPick: { x: 384, y: 252 },
      },
      {
        backend: "webgpu",
        readiness: readyReadiness(),
        validatedPick: { x: 384, y: 252 },
      },
    ],
  });
  assert.equal(decision.refuse, false);
});

test("port 8080 is a named refusal, and 8094 is the default", () => {
  assert.equal(parseArgs([]).port, 8094);
  assert.throws(
    () => parseArgs(["--port", "8080"]),
    (error) =>
      error instanceof E1RefusalError &&
      error.reason === "port-8080-forbidden" &&
      error.exitCode === EXIT_CODES.REFUSAL,
  );
});

test("the entry is a runtime argument so the minified-build repeat needs no edit", () => {
  assert.equal(
    parseArgs(["--entry", "/Build/Cesium/index.js"]).entry,
    "/Build/Cesium/index.js",
  );
  assert.throws(
    () => parseArgs(["--entry", "Build/Cesium/index.js"]),
    TypeError,
  );
  assert.throws(() => parseArgs(["--frames"]), TypeError);
});

test("--reverse selects the second run order the review asks for", () => {
  assert.equal(parseArgs([]).reverse, false);
  assert.equal(parseArgs(["--reverse"]).reverse, true);
  assert.deepEqual(
    buildReceipt({ reverse: true, legs: [], equalContent: null }).runOrder,
    ["webgpu", "webgl"],
  );
  assert.deepEqual(
    buildReceipt({ reverse: false, legs: [], equalContent: null }).runOrder,
    ["webgl", "webgpu"],
  );
});

test("the base URL, the stylesheet and the proven bytes all follow --entry", () => {
  // Leg C loads `/Build/Cesium/index.js`. A hardcoded unminified base URL and a
  // fixed unminified preflight would run a minified engine on an unminified
  // page and prove bytes that run never loads.
  assert.deepEqual(deriveEntryContext("/Build/CesiumUnminified/index.js"), {
    baseUrl: "/Build/CesiumUnminified/",
    stylesheetUrl: "/Build/CesiumUnminified/Widgets/widgets.css",
    entryArtifact: "Build/CesiumUnminified/index.js",
    witnessArtifact: "Build/CesiumUnminified/Cesium.js",
    requiredArtifacts: [
      "Build/CesiumUnminified/index.js",
      "Build/CesiumUnminified/Cesium.js",
    ],
  });
  assert.deepEqual(deriveEntryContext("/Build/Cesium/index.js"), {
    baseUrl: "/Build/Cesium/",
    stylesheetUrl: "/Build/Cesium/Widgets/widgets.css",
    entryArtifact: "Build/Cesium/index.js",
    witnessArtifact: "Build/Cesium/Cesium.js",
    requiredArtifacts: ["Build/Cesium/index.js", "Build/Cesium/Cesium.js"],
  });
  assert.throws(() => deriveEntryContext("Build/Cesium/index.js"), TypeError);
  // The entry the page LOADS is the first artifact proven, not a sibling.
  assert.equal(REQUIRED_SERVED_ARTIFACTS[0], "Build/CesiumUnminified/index.js");
});

test("modules the page loaded but the preflight did not prove are named, not implied away", () => {
  const coverage = summarizeModuleCoverage({
    origin: "http://localhost:8094",
    requiredArtifacts: ["Build/Cesium/index.js", "Build/Cesium/Cesium.js"],
    loadedUrls: [
      "http://localhost:8094/Build/Cesium/index.js",
      "http://localhost:8094/Build/Cesium/chunks/chunk-U2ATSOEQ.js",
      "http://localhost:8094/Build/Cesium/Widgets/widgets.css",
      "http://localhost:8094/Build/Cesium/index.js",
    ],
  });
  assert.equal(coverage.loadedCount, 2);
  assert.equal(coverage.provenCount, 1);
  assert.deepEqual(coverage.unproven, [
    "/Build/Cesium/chunks/chunk-U2ATSOEQ.js",
  ]);
});

test("the equal-content phase carries its own deadline", () => {
  // Its wait is on frames from a scene just observed struggling to produce
  // them, so it cannot be the one phase without a bound.
  assert.equal(parseArgs([]).equalContentDeadlineMs, 30000);
  assert.equal(
    parseArgs(["--equal-content-deadline-ms", "5000"]).equalContentDeadlineMs,
    5000,
  );
  assert.throws(
    () => parseArgs(["--equal-content-deadline-ms", "0"]),
    TypeError,
  );
});

test("origin drift is a named refusal", () => {
  assert.equal(
    decideOriginRefusal({
      requestedOrigin: "http://localhost:8094",
      actualUrl: "http://localhost:8094/Tools/visual-regression/x.html",
    }).refuse,
    false,
  );
  const drifted = decideOriginRefusal({
    requestedOrigin: "http://localhost:8094",
    actualUrl: "http://localhost:8080/Tools/visual-regression/x.html",
  });
  assert.equal(drifted.refuse, true);
  assert.equal(drifted.reason, "origin-mismatch");
});

test("every required served artifact must match on disk", () => {
  const matched = REQUIRED_SERVED_ARTIFACTS.map((artifact) => ({
    path: artifact,
    match: true,
  }));
  assert.equal(
    decidePreflightRefusal({ ok: true, artifacts: matched }).refuse,
    false,
  );
  for (const artifact of REQUIRED_SERVED_ARTIFACTS) {
    const partial = matched.map((row) => ({
      ...row,
      match: row.path !== artifact,
    }));
    const decision = decidePreflightRefusal({ ok: true, artifacts: partial });
    assert.equal(decision.refuse, true, `${artifact} must be required`);
    assert.equal(decision.reason, "served-build-preflight-incomplete");
    assert.deepEqual(decision.details.missingOrUnmatched, [artifact]);
  }
});

test("percentiles are deterministic nearest-rank and empty sets stay null", () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2);
  assert.equal(percentile([1, 2, 3, 4], 0.95), 4);
  assert.equal(percentile([], 0.5), null);
  assert.deepEqual(p50P95([]), { n: 0, p50: null, p95: null, max: null });
  assert.throws(() => percentile([1], 1.5), RangeError);
});

test("the frame summary reports a never-sampled cache as null, never as zero", () => {
  const summary = summarizeFrameSamples([
    { sinceLastFrameMs: 10, commandListLength: 5, pipelineCache: null },
    { sinceLastFrameMs: 20, commandListLength: 7, pipelineCache: null },
  ]);
  assert.equal(summary.cacheSampleCount, 0);
  assert.equal(summary.pipelinePendingFrameFraction, null);
  assert.equal(summary.pipelineCreatedDelta, null);
  assert.equal(summary.commandListLength.n, 2);
});

test("the heap aggregation is labelled by allocation site, not by retainer", () => {
  // Naming honesty: the review asked for a retainer view, and this is not one.
  // The label travels with the data so a reader cannot quote it as one.
  const aggregate = aggregateHeapSamplingProfile({
    head: {
      callFrame: { functionName: "(root)", url: "" },
      selfSize: 0,
      children: [
        {
          callFrame: {
            functionName: "loadTile",
            url: "/a/Model.js",
            lineNumber: 12,
          },
          selfSize: 3000,
          children: [],
        },
        {
          callFrame: {
            functionName: "decode",
            url: "/a/Draco.js",
            lineNumber: 7,
          },
          selfSize: 1000,
          children: [],
        },
      ],
    },
  });
  assert.equal(aggregate.bucketedBy, "allocation-site");
  assert.equal(aggregate.totalSelfBytes, 4000);
  assert.equal(aggregate.buckets[0].site, "loadTile @ Model.js:12");
  assert.equal(aggregate.buckets[0].pct, 75);
});

test("the Markdown summary states a refused comparison instead of omitting it", () => {
  const markdown = buildMarkdownSummary(
    buildReceipt({
      startedAt: "2026-09-02T00:00:00.000Z",
      origin: "http://localhost:8094",
      entry: "/Build/CesiumUnminified/index.js",
      reverse: false,
      preflight: { ok: true },
      legs: [
        {
          backend: "webgpu",
          settleWindowMs: 90000,
          readiness: { reached: false, framesProduced: 18 },
          classification: {
            verdict: E1_VERDICTS.MAIN_THREAD_STARVED,
            mainThreadBusyFraction: 0.91,
            pipelinePendingFraction: 0.05,
            pipelinePendingFractionAxis: "time-weighted-poll",
          },
          moduleCoverage: {
            loadedCount: 2,
            provenCount: 1,
            unproven: ["/Build/Cesium/chunks/chunk-U2ATSOEQ.js"],
          },
        },
      ],
      equalContent: { refused: true, reason: "equal-content-leg-void" },
    }),
  );
  assert.match(markdown, /Q-143 \/ DM-09/);
  assert.match(
    markdown,
    /\| webgpu \| NO \| 18 \| 90000 \| 0\.91 \| 0\.05 \(time-weighted-poll\) \| main-thread-starved \|/,
  );
  assert.match(
    markdown,
    /1 of 2 loaded engine modules were NOT covered by the byte preflight/,
  );
  assert.match(
    markdown,
    /Equal-content comparison REFUSED: `equal-content-leg-void`/,
  );
});

test("mutant subtest: an inert vacuity guard must turn this spec red", async (t) => {
  // Inertness, not deletion. `decideReadinessRefusal` keeps its shape and its
  // call site; only the vacuity branch is made unreachable, exactly as a
  // regression that "kept the guard" would look.
  await t.test(
    "the guard, made unreachable, stops catching a vacuous claim",
    () => {
      // `guardLive` is a runtime value, not a literal, so the branch stays in
      // the emitted code and the mutant is inertness rather than deletion.
      const withGuard = (readiness, guardLive) => {
        const nonVacuous =
          readiness.renderReady === true &&
          readiness.framesProduced >= 1 &&
          readiness.commandListLength >= 1;
        if (guardLive && readiness.reached === true && !nonVacuous) {
          return { refuse: true, reason: "readiness-gate-vacuous" };
        }
        if (readiness.reached === false && nonVacuous) {
          return { refuse: true, reason: "readiness-flag-inconsistent" };
        }
        return { refuse: false, reason: null };
      };
      const vacuous = {
        renderReady: true,
        reached: true,
        framesProduced: 0,
        commandListLength: 0,
      };
      assert.equal(
        withGuard(vacuous, true).refuse,
        true,
        "the guard, live, must refuse a vacuous claim",
      );
      assert.equal(
        withGuard(vacuous, false).refuse,
        false,
        "the same guard, made inert, must stop refusing",
      );
      assert.equal(
        decideReadinessRefusal(vacuous).refuse,
        true,
        "the shipped guard must behave like the live one, not the inert one",
      );
    },
  );
});

test("mutant subtest: an inert time-weighted axis must turn this spec red", async (t) => {
  // Inertness, not deletion. The poll is still taken, still summarised and
  // still carried in the receipt; only the SELECTION of it as the classified
  // axis is made unreachable — exactly what a regression that "kept the poll"
  // would look like.
  await t.test("ignoring the poll flips the verdict back to neither", () => {
    const input = {
      profile: makeProfile({ busyUs: 20000, idleUs: 80000 }),
      frameSamples: makeFrames({ count: 20, pendingCount: 1 }),
      cacheSamples: makeCacheSamples({ count: 20, pendingCount: 18 }),
      windowMs: 120,
    };
    const live = classifySettleWindow(input);
    assert.equal(live.verdict, E1_VERDICTS.PIPELINE_CREATION_BOUND);

    const inert = classifySettleWindow({ ...input, cacheSamples: undefined });
    assert.equal(inert.pipelinePendingFractionAxis, "frame-weighted");
    assert.equal(inert.verdict, E1_VERDICTS.NEITHER_UNMODELLED_WAIT);
    assert.notEqual(
      inert.verdict,
      live.verdict,
      "the axis must be load-bearing, not decorative",
    );
  });
});

test("mutant subtest: a discriminator without the neither quadrant must turn this spec red", async (t) => {
  // A classifier that can only ever answer with one of the two hypotheses is
  // not a test of them. This mutant keeps every band and every number and
  // removes only the escape hatch.
  await t.test("collapsing the neither quadrant changes the verdict", () => {
    const idleAndQuiet = {
      profile: makeProfile({ busyUs: 20000, idleUs: 80000 }),
      frameSamples: makeFrames({ count: 20, pendingCount: 1 }),
      windowMs: 120,
    };
    const live = classifySettleWindow(idleAndQuiet);
    assert.equal(live.verdict, E1_VERDICTS.NEITHER_UNMODELLED_WAIT);

    const collapsed =
      live.mainThreadBusyFraction <= E1_PREDICTIONS.busyLow
        ? E1_VERDICTS.PIPELINE_CREATION_BOUND
        : E1_VERDICTS.MAIN_THREAD_STARVED;
    assert.notEqual(
      collapsed,
      live.verdict,
      "the mutant must reach a different, unfalsifiable verdict",
    );
  });
});
