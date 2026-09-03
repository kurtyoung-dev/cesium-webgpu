import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";

import {
  EXIT_CODES,
  EXTRA_LEVERS,
  REQUIRED_SERVED_ARTIFACTS,
  RESIDENCY_STABLE_FRAME_COUNT,
  STREAMING_LEVERS,
  aggregatePerPass,
  buildCellReport,
  buildLegMatrix,
  buildMarkdownSummary,
  buildRunOrder,
  decideCellRefusal,
  decideLegDescriptorRefusal,
  decideOriginRefusal,
  decidePreflightRefusal,
  extractPipelineCacheMetrics,
  p50P95,
  parseArgs,
} from "./probe-aec-perf.mjs";

// DM-10. probe-aec-perf.mjs now carries a relative import
// (`./lib/aec-residency-e1.mjs`), and a `data:` URL module has no base
// location a relative specifier can resolve against (Node throws
// ERR_UNSUPPORTED_RESOLVE_REQUEST). The whole-file mutation tests below
// therefore import the (possibly mutated) source from a throwaway SIBLING
// file instead of a `data:` URL, so `./lib/...` still resolves the same way
// it does for the real module, and delete the file in a `finally` whether
// the import succeeds or throws.
async function importAsScratchModule(source) {
  const scratchUrl = new URL(
    `./_dm10-scratch-${randomUUID()}.mjs`,
    import.meta.url,
  );
  writeFileSync(scratchUrl, source);
  try {
    return await import(scratchUrl.href);
  } finally {
    unlinkSync(scratchUrl);
  }
}

function makeAcceptedRaw(leg) {
  const hasLever = leg.lever !== null;
  const tilesetOption = leg.application?.target === "tileset-options";
  const sseValue =
    leg.lever === "maximumScreenSpaceError" ? leg.application.value : 16;

  return {
    ok: true,
    rendererType: "WebGL",
    audit: {
      sequence: hasLever
        ? [
            {
              order: 1,
              name: "lever-configured",
              details: {
                readbackMatches: true,
              },
            },
          ]
        : [],
      leverConfiguredAt: hasLever ? 1 : null,
      firstTilesetCreationStartedAt: 2,
      firstTilesetAddedAt: 4,
      engineReadbacks: tilesetOption
        ? [
            {
              title: "Architecture",
              order: 3,
              property: leg.application.property,
              value: leg.application.value,
            },
          ]
        : [],
      addedAtByTitle: {
        Architecture: 4,
      },
      firstTraversal: {
        sceneFrameNumber: 8,
        maximumScreenSpaceErrorByTileset: [
          {
            title: "Architecture",
            value: sseValue,
            source: "engine-readback-at-first-traversal",
          },
        ],
      },
    },
    readiness: {
      timeToRenderReadyMs: 125.25,
      framesToRenderReady: 7,
      sceneFrameNumber: 12,
      criterion: "streaming-tileset-residency",
      renderReady: true,
      framesProduced: 7,
      commandListLength: 4,
      reached: true,
      stableFrameCount: RESIDENCY_STABLE_FRAME_COUNT,
      requiredStableFrameCount: RESIDENCY_STABLE_FRAME_COUNT,
      tilesetResidencyAtReadiness: [
        {
          title: "Architecture",
          tilesLoaded: true,
          selected: 12,
          pendingRequests: 0,
          geometryBytes: 4096,
          texturesBytes: 8192,
          batchTableBytes: 0,
        },
      ],
    },
    debugSnapshot: {
      scene: {
        frameNumber: 12,
      },
    },
    frameState: {
      commandList: [],
    },
    frameTimes: [1, 2, 3, 4],
    memory: {
      usedJSHeapMB: 64.125,
    },
    errors: [],
  };
}

function makeCellReportInput() {
  const leg = buildLegMatrix()[0];
  const raw = makeAcceptedRaw(leg);

  raw.debugSnapshot = {
    scene: {
      pipelineCacheStats: {
        hits: 11,
        misses: 2,
        created: 4,
        pending: 1,
      },
    },
  };

  return {
    entry: {
      run: 1,
      backend: "webgl",
      leg,
    },
    raw,
    perPassSamples: {
      snapshot: null,
      frameState: {
        commandList: [
          { pass: "OPAQUE" },
          { pass: "TRANSLUCENT" },
          { pass: "OPAQUE" },
          { pass: "PICK" },
          { pass: "PICK" },
          { pass: "PICK" },
        ],
      },
    },
    validatedPick: {
      x: 320,
      y: 240,
    },
    pickValidation: {
      x: 320,
      y: 240,
      hit: true,
      type: "Cesium3DTileFeature",
    },
    pickTable: [
      {
        sample: 1,
        x: 320,
        y: 240,
        wallMs: 0.25,
        hit: true,
        type: "Cesium3DTileFeature",
      },
      {
        sample: 2,
        x: 320,
        y: 240,
        wallMs: 0.5,
        hit: false,
        type: null,
      },
    ],
    imagePath: "/tmp/aec/images/run1-baseline-webgl.png",
    consoleLines: ["log: settled"],
  };
}

test("runCell captures exactly one Playwright canvas element screenshot", () => {
  const moduleUrl = new URL("./probe-aec-perf.mjs", import.meta.url);
  const source = readFileSync(moduleUrl, "utf8");
  const elementScreenshotCall =
    'await page.locator("canvas").first().screenshot({ path: imagePath });';

  assert.equal(source.split(elementScreenshotCall).length - 1, 1);
  assert.doesNotMatch(source, /await page\.screenshot\(/u);
  assert.match(
    source,
    /path\.join\(\s*outputDirectory,\s*"images",\s*`\$\{cellName\(entry\)\}\.png`,\s*\)/u,
  );
});

test("each lever owns a dedicated page-load descriptor before tileset creation", () => {
  const matrix = buildLegMatrix();
  const expectedLevers = [...STREAMING_LEVERS, ...EXTRA_LEVERS];
  const baseline = matrix[0];
  const leverLegs = matrix.filter((leg) => leg.lever !== null);

  assert.equal(baseline.id, "baseline");
  assert.equal(baseline.lever, null);
  assert.equal(baseline.application, null);
  assert.deepEqual(
    leverLegs.map((leg) => leg.lever),
    expectedLevers,
  );
  assert.equal(leverLegs.length, expectedLevers.length);
  assert.equal(
    new Set(leverLegs.map((leg) => leg.pageLoadId)).size,
    expectedLevers.length,
  );

  for (const leg of leverLegs) {
    assert.equal(leg.pageLoad, "dedicated-new-page");
    assert.equal(leg.application.phase, "before-tileset-creation");
    assert.equal(leg.application.property, leg.lever);
    assert.deepEqual(decideLegDescriptorRefusal(leg), {
      refuse: false,
      exitCode: EXIT_CODES.OK,
      reason: null,
    });
  }

  const lateApplication = {
    ...leverLegs[0],
    application: {
      ...leverLegs[0].application,
      phase: "post-settle",
    },
  };
  const decision = decideLegDescriptorRefusal(lateApplication);

  assert.equal(decision.refuse, true);
  assert.equal(decision.exitCode, EXIT_CODES.REFUSAL);
  assert.equal(decision.reason, "lever-applied-after-tileset-creation");
});

test("--runs is interleaved by leg and --reverse reverses each backend pair", () => {
  const legs = [
    {
      id: "first",
      label: "First",
      lever: null,
      pageLoad: "dedicated-new-page",
      application: null,
    },
    {
      id: "second",
      label: "Second",
      lever: null,
      pageLoad: "dedicated-new-page",
      application: null,
    },
  ];

  const forward = buildRunOrder({ runs: 2, legs }).map(
    ({ run, leg, backend }) => `${run}:${leg.id}:${backend}`,
  );
  assert.deepEqual(forward, [
    "1:first:webgl",
    "1:first:webgpu",
    "1:second:webgl",
    "1:second:webgpu",
    "2:first:webgl",
    "2:first:webgpu",
    "2:second:webgl",
    "2:second:webgpu",
  ]);

  const reverse = buildRunOrder({
    runs: 1,
    reverse: true,
    legs,
  }).map(({ run, leg, backend }) => `${run}:${leg.id}:${backend}`);
  assert.deepEqual(reverse, [
    "1:first:webgpu",
    "1:first:webgl",
    "1:second:webgpu",
    "1:second:webgl",
  ]);
});

test("parseArgs defaults to port 8094 and names the exit-3 refusal for 8080", () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.port, 8094);
  assert.equal(defaults.runs, 1);
  assert.equal(defaults.reverse, false);

  const configured = parseArgs(["--runs", "3", "--reverse"]);
  assert.equal(configured.port, 8094);
  assert.equal(configured.runs, 3);
  assert.equal(configured.reverse, true);

  assert.throws(
    () => parseArgs(["--port", "8080"]),
    (error) => {
      assert.equal(error.name, "AECProbeRefusal");
      assert.equal(error.exitCode, EXIT_CODES.REFUSAL);
      assert.equal(error.reason, "port-8080-forbidden");
      return true;
    },
  );
});

// Fix-round F3: --settle-deadline-ms is its own knob, decoupled from
// --timeout-ms, so the residency window can be raised independently of the
// rest of the per-cell timeout for a scene that is measured to need more of
// it on one backend (see the module header's Q-141 citation).
test("parseArgs decouples --settle-deadline-ms from --timeout-ms, defaulting to it when omitted", () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.timeoutMs, 120000);
  assert.equal(
    defaults.settleDeadlineMs,
    defaults.timeoutMs,
    "omitting --settle-deadline-ms must fall back to --timeout-ms, not a separate hardcoded default",
  );

  const onlyTimeout = parseArgs(["--timeout-ms", "45000"]);
  assert.equal(onlyTimeout.timeoutMs, 45000);
  assert.equal(
    onlyTimeout.settleDeadlineMs,
    45000,
    "the fallback must track whatever --timeout-ms actually resolved to",
  );

  const both = parseArgs([
    "--timeout-ms",
    "45000",
    "--settle-deadline-ms",
    "180000",
  ]);
  assert.equal(both.timeoutMs, 45000);
  assert.equal(
    both.settleDeadlineMs,
    180000,
    "an explicit --settle-deadline-ms must win over the --timeout-ms fallback, not be overwritten by it",
  );
});

test("origin mismatch is a named exit-code-3 refusal", () => {
  const decision = decideOriginRefusal({
    requestedOrigin: "http://localhost:8094",
    actualUrl: "http://localhost:8095/Apps/Sandcastle2/",
  });

  assert.equal(decision.refuse, true);
  assert.equal(decision.exitCode, EXIT_CODES.REFUSAL);
  assert.equal(decision.reason, "origin-mismatch");
});

test("preflight failure and every missing or mismatched artifact are named refusals", () => {
  const failed = decidePreflightRefusal({
    ok: false,
    origin: "http://localhost:8094",
    artifacts: [],
  });

  assert.equal(failed.refuse, true);
  assert.equal(failed.exitCode, EXIT_CODES.REFUSAL);
  assert.equal(failed.reason, "served-build-preflight-failed");

  const matchingArtifacts = REQUIRED_SERVED_ARTIFACTS.map((artifact) => ({
    path: artifact,
    match: true,
  }));
  assert.deepEqual(
    decidePreflightRefusal({
      ok: true,
      artifacts: matchingArtifacts,
    }),
    {
      refuse: false,
      exitCode: EXIT_CODES.OK,
      reason: null,
    },
  );

  for (const artifact of REQUIRED_SERVED_ARTIFACTS) {
    const missing = decidePreflightRefusal({
      ok: true,
      artifacts: matchingArtifacts.filter(
        (candidate) => candidate.path !== artifact,
      ),
    });
    assert.equal(missing.refuse, true);
    assert.equal(missing.exitCode, EXIT_CODES.REFUSAL);
    assert.equal(missing.reason, "served-build-preflight-incomplete");
    assert.deepEqual(missing.details.missingOrUnmatched, [artifact]);

    const mismatched = decidePreflightRefusal({
      ok: true,
      artifacts: matchingArtifacts.map((candidate) => ({
        ...candidate,
        match: candidate.path === artifact ? false : candidate.match,
      })),
    });
    assert.equal(mismatched.refuse, true);
    assert.equal(mismatched.exitCode, EXIT_CODES.REFUSAL);
    assert.equal(mismatched.reason, "served-build-preflight-incomplete");
    assert.deepEqual(mismatched.details.missingOrUnmatched, [artifact]);
  }
});

test("cell decision requires lever configuration before creation and renderReady metrics", () => {
  const leg = buildLegMatrix().find(
    (candidate) => candidate.lever === "maximumScreenSpaceError",
  );
  const accepted = decideCellRefusal({
    leg,
    raw: makeAcceptedRaw(leg),
  });

  assert.deepEqual(accepted, {
    refuse: false,
    exitCode: EXIT_CODES.OK,
    reason: null,
  });

  const lateRaw = makeAcceptedRaw(leg);
  lateRaw.audit.leverConfiguredAt = lateRaw.audit.firstTilesetCreationStartedAt;
  const late = decideCellRefusal({ leg, raw: lateRaw });

  assert.equal(late.refuse, true);
  assert.equal(late.exitCode, EXIT_CODES.REFUSAL);
  assert.equal(late.reason, "lever-was-inert-during-streaming");

  const invalidReadinessRaw = makeAcceptedRaw(leg);
  invalidReadinessRaw.readiness.framesToRenderReady = null;
  const invalidReadiness = decideCellRefusal({
    leg,
    raw: invalidReadinessRaw,
  });

  assert.equal(invalidReadiness.refuse, true);
  assert.equal(invalidReadiness.exitCode, EXIT_CODES.REFUSAL);
  assert.equal(invalidReadiness.reason, "render-ready-metrics-invalid");
});

test("p50 and p95 use deterministic nearest-rank percentiles", () => {
  const fixture = [
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
  ];

  assert.deepEqual(p50P95(fixture), {
    samples: 20,
    p50: 10,
    p95: 19,
  });
});

test("per-pass aggregation preserves three passes and ignores summed totals", () => {
  const snapshot = {
    scene: {
      commandCountsByPass: {
        OPAQUE: 2,
        TRANSLUCENT: 1,
        PICK: 3,
        total: 99,
      },
    },
  };
  const contradictoryFrameState = {
    commandList: [
      { pass: "OPAQUE" },
      { pass: "OPAQUE" },
      { pass: "OPAQUE" },
      { pass: "OPAQUE" },
    ],
  };

  assert.deepEqual(aggregatePerPass(snapshot, contradictoryFrameState), {
    source: "debug-snapshot",
    counts: {
      OPAQUE: 2,
      PICK: 3,
      TRANSLUCENT: 1,
    },
  });
});

test("runtime cell-report seam carries distinct raw per-pass counts and image path", () => {
  const cell = buildCellReport(makeCellReportInput());

  assert.deepEqual(cell.perPassCommands, {
    source: "frameState.commandList",
    counts: {
      OPAQUE: 2,
      PICK: 3,
      TRANSLUCENT: 1,
    },
  });
  assert.equal(Object.hasOwn(cell.perPassCommands.counts, "total"), false);
  assert.equal(Object.hasOwn(cell, "totalCommands"), false);
  assert.equal(JSON.stringify(cell.perPassCommands).includes('"total"'), false);
  assert.equal(cell.imagePath, "/tmp/aec/images/run1-baseline-webgl.png");
});

test("pipeline-cache extraction emits all four required metrics", () => {
  assert.deepEqual(
    extractPipelineCacheMetrics({
      scene: {
        pipelineCacheStats: {
          hits: 11,
          misses: 2,
          created: 4,
          pending: 1,
        },
      },
    }),
    {
      hits: 11,
      misses: 2,
      created: 4,
      pending: 1,
    },
  );
});

test("Markdown summary includes every required measurement field", () => {
  const cell = buildCellReport(makeCellReportInput());
  const markdown = buildMarkdownSummary({
    generatedAt: "2026-08-29T12:00:00.000Z",
    origin: "http://localhost:8094",
    options: {
      runs: 1,
      reverse: false,
    },
    validatedPick: {
      x: 320,
      y: 240,
    },
    cells: [cell],
  });

  for (const heading of [
    "renderReady ms",
    "Frames",
    "Scene.frameNumber",
    "Frame p50 ms",
    "Frame p95 ms",
    "Commands per pass",
    "Cache H/M/C/P",
    "Heap MB",
    "Pick hits",
    "Pick p50/p95 ms",
  ]) {
    assert.equal(markdown.includes(heading), true, `missing ${heading}`);
  }

  assert.equal(markdown.includes('"OPAQUE":2'), true);
  assert.equal(markdown.includes('"TRANSLUCENT":1'), true);
  assert.equal(markdown.includes('"PICK":3'), true);
  assert.equal(markdown.includes("11/2/4/1"), true);
  assert.equal(markdown.includes("1/2"), true);
  assert.equal(markdown.includes("0.25/0.5"), true);
});

test("mutant subtest: summing passes at the runtime report seam goes red", async (t) => {
  await t.test("string-mutated buildCellReport is killed", async () => {
    const moduleUrl = new URL("./probe-aec-perf.mjs", import.meta.url);
    const originalSource = readFileSync(moduleUrl, "utf8").replace(
      /^#![^\n]*\n/u,
      "",
    );
    // Whitespace-tolerant: the probe is prettier-formatted, so the call may wrap.
    const needle =
      / {2}const perPassCommands = aggregatePerPass\(\s*perPassSamples\.snapshot,\s*perPassSamples\.frameState,?\s*\);/u;
    const replacement = `  const perPassCommands = {
    source: "mutant-summed-passes",
    counts: {
      total: Object.values(
        aggregatePerPass(
          perPassSamples.snapshot,
          perPassSamples.frameState,
        ).counts,
      ).reduce((sum, count) => sum + count, 0),
    },
  };`;
    const mutantSource = originalSource.replace(needle, replacement);

    assert.notEqual(
      mutantSource,
      originalSource,
      "runtime report-seam mutation needle must remain live",
    );

    const mutant = await importAsScratchModule(mutantSource);
    const mutantCell = mutant.buildCellReport(makeCellReportInput());
    const expectedCounts = {
      OPAQUE: 2,
      PICK: 3,
      TRANSLUCENT: 1,
    };

    assert.equal(mutantCell.perPassCommands.counts.total, 6);
    assert.throws(
      () => assert.deepEqual(mutantCell.perPassCommands.counts, expectedCounts),
      {
        name: "AssertionError",
      },
    );
  });
});

// Q141-live-run-refusal (2026-09-02): the harness's readiness loop breaks the
// instant scene.renderReady is true, and on a cold page that happens after
// exactly one forced frame -- nothing is GPU-pending before any tile has
// been selected for upload. captureFirstTraversal must therefore read
// *that same frame's* traversal statistics, not the previous frame's, or it
// only ever gets one call and that call is always stale. Confirmed live
// against the real served build and the real 8-tileset AEC leg in
// Tools/visual-regression/output/aec-perf-diagnosis-2026-09-02/.

function extractReadinessLoopSource() {
  const moduleUrl = new URL("./probe-aec-perf.mjs", import.meta.url);
  const source = readFileSync(moduleUrl, "utf8");
  const needle =
    /function sceneFrameNumber\(\) \{[\s\S]*?scene\.postRender\.removeEventListener\(captureFirstTraversal\);/u;
  const matches = source.match(new RegExp(needle, "gu"));

  assert.equal(
    matches?.length,
    1,
    "readiness-loop extraction needle must match exactly once",
  );

  return matches[0];
}

// Fix-round F2: extends extractReadinessLoopSource's needle through the
// `if (!becameReady) { return {...}; }` block that follows it, so a test can
// assert on the PRODUCER's own `refusalReason` literal instead of hand-
// feeding that string to decideCellRefusal and only proving the pass-through.
// Kept as a separate needle/helper (rather than widening
// extractReadinessLoopSource itself) because every OTHER existing test's
// fixture also has becameReady === false, and folding the refusal block into
// the shared helper's return value would silently change what those tests
// observe.
function extractReadinessLoopWithRefusalSource() {
  const moduleUrl = new URL("./probe-aec-perf.mjs", import.meta.url);
  const source = readFileSync(moduleUrl, "utf8");
  const needle =
    /function sceneFrameNumber\(\) \{[\s\S]*?scene\.postRender\.removeEventListener\(captureFirstTraversal\);\r?\n\r?\n {2}if \(!becameReady\) \{[\s\S]*?\r?\n {2}\}\r?\n/u;
  const matches = source.match(new RegExp(needle, "gu"));

  assert.equal(
    matches?.length,
    1,
    "readiness-loop+refusal extraction needle must match exactly once",
  );

  return matches[0];
}

test("captureFirstTraversal is wired to postRender, not postUpdate", () => {
  const loopSource = extractReadinessLoopSource();

  assert.match(
    loopSource,
    /scene\.postRender\.addEventListener\(captureFirstTraversal\);/u,
  );
  assert.match(
    loopSource,
    /scene\.postRender\.removeEventListener\(captureFirstTraversal\);/u,
  );
  assert.doesNotMatch(loopSource, /scene\.postUpdate\./u);
});

// Builds a fake Scene whose event order matches the real engine's proven
// order (see the diagnosis README): forceRender() raises postUpdate BEFORE
// writing this frame's tileset statistics, then raises postRender AFTER.
// Its tilesets never carry `tilesLoaded`, so under DM-10's streaming
// criterion becameReady never goes true here on its own merits; the
// postRender/postUpdate test below additionally pins the loop to exactly one
// forceRender() call with a stepped performance mock (see
// makeSteppedPerformance) so that "one opportunity to observe a traversal"
// is this fixture's deliberate scenario, not a side effect of the bug DM-10
// fixes elsewhere in this same loop.
function buildFakeScene() {
  const listeners = { postUpdate: new Set(), postRender: new Set() };
  const tilesets = [
    {
      title: "Google",
      tileset: { statistics: {}, maximumScreenSpaceError: 16 },
    },
    {
      title: "Architecture",
      tileset: { statistics: {}, maximumScreenSpaceError: 16 },
    },
  ];
  let renderReadyValue = false;
  let frameNumber = 0;

  const scene = {
    frameNumber: 0,
    postUpdate: {
      addEventListener: (fn) => listeners.postUpdate.add(fn),
      removeEventListener: (fn) => listeners.postUpdate.delete(fn),
    },
    postRender: {
      addEventListener: (fn) => listeners.postRender.add(fn),
      removeEventListener: (fn) => listeners.postRender.delete(fn),
    },
    requestRender() {},
    forceRender() {
      for (const fn of [...listeners.postUpdate]) {
        fn();
      }
      frameNumber += 1;
      scene.frameNumber = frameNumber;
      for (const entry of tilesets) {
        entry.tileset.statistics = { visited: 27, selected: 0 };
      }
      renderReadyValue = true;
      for (const fn of [...listeners.postRender]) {
        fn();
      }
    },
    get renderReady() {
      return renderReadyValue;
    },
  };

  return { scene, tilesets };
}

// DM-10 fixture: a fake scene whose renderReady is vacuously true from frame
// one -- exactly the trap DM-10 documents -- so only the streaming-residency
// loop's own tileset-status reads can gate becameReady. Each plan entry is
// `{ title, loadAfterFrame, pendingClearAfterFrame, selectedWhenLoaded }`; a
// tileset reports tilesLoaded once `scene.frameNumber >= loadAfterFrame`, and
// never does when loadAfterFrame is Infinity.
//
// `pendingClearAfterFrame` is independent of `loadAfterFrame` and defaults to
// it (so a plan that omits the field keeps the previous lockstep behaviour
// byte-for-byte). It exists to reproduce
// `Cesium3DTilesetStatistics.js:15-16`'s real decoupling: a tileset whose
// requests have all returned reports `numberOfPendingRequests === 0` while
// its content is still being parsed/uploaded and `tilesLoaded` is still
// false. A fixture that always flips both fields on the same frame cannot
// tell a criterion that reads `tilesLoaded` apart from one that reads
// `numberOfPendingRequests === 0` -- fix-round F1.
function buildResidencyFakeScene(plans) {
  const listeners = { postUpdate: new Set(), postRender: new Set() };
  const tilesets = plans.map((plan, index) => ({
    title: plan.title ?? `Tileset${index}`,
    tileset: {
      maximumScreenSpaceError: 16,
      tilesLoaded: false,
      statistics: { visited: 0, selected: 0, numberOfPendingRequests: 1 },
    },
  }));
  let frameNumber = 0;

  const scene = {
    frameNumber: 0,
    renderReady: true,
    frameState: { commandList: [{ pass: "OPAQUE" }] },
    postUpdate: {
      addEventListener: (fn) => listeners.postUpdate.add(fn),
      removeEventListener: (fn) => listeners.postUpdate.delete(fn),
    },
    postRender: {
      addEventListener: (fn) => listeners.postRender.add(fn),
      removeEventListener: (fn) => listeners.postRender.delete(fn),
    },
    requestRender() {},
    forceRender() {
      for (const fn of [...listeners.postUpdate]) {
        fn();
      }
      frameNumber += 1;
      scene.frameNumber = frameNumber;
      tilesets.forEach((entry, index) => {
        const plan = plans[index];
        const loaded =
          Number.isFinite(plan.loadAfterFrame) &&
          frameNumber >= plan.loadAfterFrame;
        const pendingClearFrame = Number.isFinite(plan.pendingClearAfterFrame)
          ? plan.pendingClearAfterFrame
          : plan.loadAfterFrame;
        const pendingCleared =
          Number.isFinite(pendingClearFrame) &&
          frameNumber >= pendingClearFrame;
        entry.tileset.tilesLoaded = loaded;
        entry.tileset.statistics = {
          visited: 27,
          selected: loaded
            ? (plan.selectedWhenLoaded ?? 10)
            : Math.min(frameNumber, (plan.selectedWhenLoaded ?? 10) - 1),
          numberOfPendingRequests: pendingCleared ? 0 : 1,
        };
      });
      for (const fn of [...listeners.postRender]) {
        fn();
      }
    },
  };

  return { scene, tilesets };
}

/** Deterministic performance.now() stand-in: replays a fixed value sequence. */
function makeSteppedPerformance(values) {
  let index = 0;
  return {
    now() {
      const value = index < values.length ? values[index] : values.at(-1);
      index += 1;
      return value;
    },
  };
}

async function runExtractedReadinessLoop(loopSource, options = {}) {
  const audit = { sequence: [], firstTraversal: null };
  let sequenceNumber = 0;
  function mark(name) {
    sequenceNumber += 1;
    audit.sequence.push({ order: sequenceNumber, name });
    return sequenceNumber;
  }

  const fixture =
    options.scene && options.tilesets
      ? { scene: options.scene, tilesets: options.tilesets }
      : buildFakeScene();
  const Cesium = { JulianDate: { clone: (value) => value } };
  const viewer = { clock: { currentTime: "fixed-time" } };
  // The extracted loop reads `input.settleDeadlineMs` (fix-round F3 renamed
  // it off the general-purpose `timeoutMs` field so the residency window has
  // its own knob); this helper's own `options.timeoutMs` parameter name is
  // kept as-is across every call site in this file and mapped onto the
  // module's actual field name here, at the one point that matters.
  const input = { settleDeadlineMs: options.timeoutMs ?? 50 };
  const perf = options.performance ?? globalThis.performance;

  // data: URL + dynamic import, matching the mutant-subtest pattern already
  // used above in this file, runs the extracted source as real module code
  // instead of the Function constructor (no-new-func). The extracted region
  // carries no import statements of its own (unlike the whole-file mutant
  // test above), so a data: URL resolves it fine.
  const moduleSource = `export async function runLoop(Cesium, scene, viewer, input, audit, mark, tilesets, performance) {
${loopSource}
  return {
    firstTraversal: audit.firstTraversal,
    becameReady: becameReady,
    framesToRenderReady: framesToRenderReady,
    stableFrameCount: stableFrameCount,
    tilesetResidencyAtReadiness: lastResidency,
  };
}
`;
  const moduleUrl =
    "data:text/javascript;base64," +
    Buffer.from(moduleSource).toString("base64");
  const mod = await import(moduleUrl);

  return mod.runLoop(
    Cesium,
    fixture.scene,
    viewer,
    input,
    audit,
    mark,
    fixture.tilesets,
    perf,
  );
}

// Fix-round F2. Runs extractReadinessLoopWithRefusalSource's needle, which
// carries the `if (!becameReady) { return {...}; }` block after the loop.
// That block references `window.__aecErrors` and `startedAt` -- both
// declared in the browser harness's outer scope (window.__aecBuild, above
// where this needle starts), not inside the needle itself -- so this wrapper
// supplies minimal stand-ins rather than the real return value being
// undefined or throwing ReferenceError. Callers must pass a fixture whose
// tilesets never settle (`becameReady` stays false for the run's whole
// duration), or the spliced-in `return` never executes and this resolves to
// `undefined`.
async function runExtractedReadinessLoopWithRefusal(loopSource, options = {}) {
  const audit = { sequence: [], firstTraversal: null };
  let sequenceNumber = 0;
  function mark(name) {
    sequenceNumber += 1;
    audit.sequence.push({ order: sequenceNumber, name });
    return sequenceNumber;
  }

  const fixture = { scene: options.scene, tilesets: options.tilesets };
  const Cesium = { JulianDate: { clone: (value) => value } };
  const viewer = { clock: { currentTime: "fixed-time" } };
  const input = { settleDeadlineMs: options.timeoutMs ?? 50 };
  const perf = options.performance ?? globalThis.performance;

  const moduleSource = `export async function runLoop(Cesium, scene, viewer, input, audit, mark, tilesets, performance) {
  const window = { __aecErrors: [] };
  const startedAt = 0;
${loopSource}
}
`;
  const moduleUrl =
    "data:text/javascript;base64," +
    Buffer.from(moduleSource).toString("base64");
  const mod = await import(moduleUrl);

  return mod.runLoop(
    Cesium,
    fixture.scene,
    viewer,
    input,
    audit,
    mark,
    fixture.tilesets,
    perf,
  );
}

test("readiness-loop behaviour: postRender observes this frame's traversal, postUpdate misses it", async () => {
  const realLoopSource = extractReadinessLoopSource();
  // Pinned to exactly one forceRender() call (performance.now() reports
  // 0, 0, then a value past any deadline) so this fixture's "one
  // opportunity" is deliberate, independent of the residency criterion.
  const onlyOneFrame = () => makeSteppedPerformance([0, 0, 1_000_000]);
  const result = await runExtractedReadinessLoop(realLoopSource, {
    performance: onlyOneFrame(),
  });

  assert.notEqual(result.firstTraversal, null);
  assert.equal(result.firstTraversal.sceneFrameNumber, 1);
  assert.deepEqual(
    result.firstTraversal.maximumScreenSpaceErrorByTileset.map(
      (row) => row.title,
    ),
    ["Google", "Architecture"],
  );

  const mutantLoopSource = realLoopSource
    .replaceAll(
      "scene.postRender.addEventListener(captureFirstTraversal);",
      "scene.postUpdate.addEventListener(captureFirstTraversal);",
    )
    .replaceAll(
      "scene.postRender.removeEventListener(captureFirstTraversal);",
      "scene.postUpdate.removeEventListener(captureFirstTraversal);",
    );

  assert.notEqual(
    mutantLoopSource,
    realLoopSource,
    "postRender -> postUpdate mutation needle must remain live",
  );

  const mutantResult = await runExtractedReadinessLoop(mutantLoopSource, {
    performance: onlyOneFrame(),
  });
  assert.equal(
    mutantResult.firstTraversal,
    null,
    "reverting to postUpdate must reproduce the first-traversal-not-observed refusal",
  );
});

// ---------------------------------------------------------------------------
// DM-10: the streaming-tileset-residency readiness criterion itself.
// ---------------------------------------------------------------------------

test("DM-10: the readiness loop withholds becameReady until every tileset settles for RESIDENCY_STABLE_FRAME_COUNT consecutive frames", async () => {
  const realLoopSource = extractReadinessLoopSource();
  const loadAfterFrame = 4;
  const fixture = buildResidencyFakeScene([
    { title: "Google", loadAfterFrame, selectedWhenLoaded: 12 },
    { title: "Architecture", loadAfterFrame, selectedWhenLoaded: 8 },
  ]);

  const result = await runExtractedReadinessLoop(realLoopSource, {
    scene: fixture.scene,
    tilesets: fixture.tilesets,
    timeoutMs: 5000,
  });

  // Deterministic: stableFrameCount reaches 1 on the first frame where every
  // tileset is simultaneously loaded AND the selected total has stopped
  // changing (frame `loadAfterFrame`), then needs
  // RESIDENCY_STABLE_FRAME_COUNT - 1 more consecutive frames.
  const expectedReadyFrame = loadAfterFrame + RESIDENCY_STABLE_FRAME_COUNT - 1;

  assert.equal(result.becameReady, true);
  assert.equal(result.framesToRenderReady, expectedReadyFrame);
  assert.equal(result.stableFrameCount, RESIDENCY_STABLE_FRAME_COUNT);
  assert.equal(
    result.tilesetResidencyAtReadiness.every((row) => row.tilesLoaded === true),
    true,
  );
});

test("DM-10: the readiness loop never sets becameReady for tilesets that never finish loading", async () => {
  const realLoopSource = extractReadinessLoopSource();
  const fixture = buildResidencyFakeScene([
    { title: "Google", loadAfterFrame: Infinity },
    { title: "Architecture", loadAfterFrame: Infinity },
  ]);

  const result = await runExtractedReadinessLoop(realLoopSource, {
    scene: fixture.scene,
    tilesets: fixture.tilesets,
    timeoutMs: 30,
  });

  assert.equal(result.becameReady, false);
  assert.equal(
    result.tilesetResidencyAtReadiness.every(
      (row) => row.tilesLoaded === false,
    ),
    true,
  );
});

// Fix-round F1: `numberOfPendingRequests === 0` is NOT the same condition as
// `tilesLoaded === true` (Cesium3DTilesetStatistics.js:15-16 tracks
// pendingRequests and the parse/upload phase separately), so a fixture that
// always clears both on the same frame cannot tell a criterion that reads
// `tilesLoaded` apart from one that only checks pendingRequests. This
// fixture clears pendingRequests on frame 1 while `tilesLoaded` never goes
// true, reproducing that still-processing phase for the whole run.
// `selectedWhenLoaded: 1` keeps the not-yet-loaded `selected` count pinned
// at `Math.min(frameNumber, 0) === 0` on every frame (see
// buildResidencyFakeScene), so the loop's OWN selected-total stability reset
// does not add extra warmup frames on top of RESIDENCY_STABLE_FRAME_COUNT --
// a criterion that accepted on pendingRequests alone would report
// becameReady by frame `pendingClearAfterFrame + RESIDENCY_STABLE_FRAME_COUNT
// - 1 === 3`. Driven by a deterministic stepped performance.now() (not real
// wall-clock timing, which this repo's `setTimeout(resolve, 0)` yield makes
// too slow and too machine-dependent to reliably clear a handful of frames
// inside a short real-time budget -- confirmed empirically while writing
// this test) so the frame count this assertion depends on cannot vary by
// machine or load.
test("DM-10: the readiness loop does not accept once pending requests clear but tilesLoaded stays false", async () => {
  const realLoopSource = extractReadinessLoopSource();
  const fixture = buildResidencyFakeScene([
    {
      title: "Google",
      pendingClearAfterFrame: 1,
      loadAfterFrame: Infinity,
      selectedWhenLoaded: 1,
    },
    {
      title: "Architecture",
      pendingClearAfterFrame: 1,
      loadAfterFrame: Infinity,
      selectedWhenLoaded: 1,
    },
  ]);

  // Six forced frames: comfortably past frame 3, the frame at which a
  // pendingRequests-only criterion would have reported becameReady.
  const sixFrames = makeSteppedPerformance([0, 1, 2, 3, 4, 5, 6, 999999]);
  const result = await runExtractedReadinessLoop(realLoopSource, {
    scene: fixture.scene,
    tilesets: fixture.tilesets,
    timeoutMs: 1000,
    performance: sixFrames,
  });

  assert.equal(
    result.framesToRenderReady,
    6,
    "the stepped performance stub must drive exactly six forced frames",
  );
  assert.equal(
    result.becameReady,
    false,
    "pendingRequests reaching zero must not be sufficient on its own -- tilesLoaded must also be read",
  );
  assert.equal(
    result.tilesetResidencyAtReadiness.every(
      (row) => row.pendingRequests === 0,
    ),
    true,
    "the fixture must actually have cleared pending requests during this run, or it failed to exercise the still-processing phase",
  );
  assert.equal(
    result.tilesetResidencyAtReadiness.every(
      (row) => row.tilesLoaded === false,
    ),
    true,
  );
});

test("DM-10 inertness mutant: dropping the residency requirement falsely reports readiness on a scene that never loads", async () => {
  const realLoopSource = extractReadinessLoopSource();
  const needle =
    /const contentResident =\s*scene\.renderReady === true &&\s*allTilesetsLoaded &&\s*pendingTotal === 0 &&\s*lastCommandListLength >= 1;/u;

  assert.match(
    realLoopSource,
    needle,
    "inertness-mutant needle must remain live",
  );

  // Makes the residency requirement UNREACHABLE: contentResident degrades to
  // the pre-DM-10 renderReady-only criterion, which is exactly the defect
  // this row exists to close.
  const mutantLoopSource = realLoopSource.replace(
    needle,
    "const contentResident = scene.renderReady === true; // DM-10 inertness mutant: residency requirement made unreachable",
  );
  assert.notEqual(
    mutantLoopSource,
    realLoopSource,
    "inertness-mutant replacement must actually change the source",
  );

  const neverLoads = () =>
    buildResidencyFakeScene([
      { title: "Google", loadAfterFrame: Infinity },
      { title: "Architecture", loadAfterFrame: Infinity },
    ]);

  const real = neverLoads();
  const realResult = await runExtractedReadinessLoop(realLoopSource, {
    scene: real.scene,
    tilesets: real.tilesets,
    timeoutMs: 30,
  });
  assert.equal(
    realResult.becameReady,
    false,
    "the real check must not be fooled by a scene that never loads",
  );

  const mutant = neverLoads();
  const mutantResult = await runExtractedReadinessLoop(mutantLoopSource, {
    scene: mutant.scene,
    tilesets: mutant.tilesets,
    timeoutMs: 5000,
  });
  assert.equal(
    mutantResult.becameReady,
    true,
    "the mutant must falsely report readiness once the residency requirement is unreachable",
  );
  assert.equal(
    mutantResult.tilesetResidencyAtReadiness.every(
      (row) => row.tilesLoaded === false,
    ),
    true,
    "the mutant is caught DESPITE zero tiles ever loading -- proving the real check is load-bearing",
  );
});

test("DM-10: decideCellRefusal refuses a not-yet-settled residency, a missing criterion, and a vacuous readiness flag", () => {
  const leg = buildLegMatrix()[0];

  const notSettledRaw = makeAcceptedRaw(leg);
  notSettledRaw.readiness.tilesetResidencyAtReadiness = [
    {
      title: "Architecture",
      tilesLoaded: false,
      selected: 4,
      pendingRequests: 2,
    },
  ];
  const notSettled = decideCellRefusal({ leg, raw: notSettledRaw });
  assert.equal(notSettled.refuse, true);
  assert.equal(notSettled.exitCode, EXIT_CODES.REFUSAL);
  assert.equal(notSettled.reason, "residency-not-settled-at-readiness");

  const missingCriterionRaw = makeAcceptedRaw(leg);
  delete missingCriterionRaw.readiness.criterion;
  const missingCriterion = decideCellRefusal({
    leg,
    raw: missingCriterionRaw,
  });
  assert.equal(missingCriterion.refuse, true);
  assert.equal(missingCriterion.exitCode, EXIT_CODES.REFUSAL);
  assert.equal(missingCriterion.reason, "residency-receipt-missing");

  const vacuousRaw = makeAcceptedRaw(leg);
  vacuousRaw.readiness.framesProduced = 0;
  vacuousRaw.readiness.commandListLength = 0;
  const vacuous = decideCellRefusal({ leg, raw: vacuousRaw });
  assert.equal(vacuous.refuse, true);
  assert.equal(vacuous.exitCode, EXIT_CODES.REFUSAL);
  assert.equal(vacuous.reason, "readiness-gate-vacuous");
});

test("DM-10: a residency settle timeout from the page is a named exit-3 refusal", () => {
  const leg = buildLegMatrix()[0];
  const raw = {
    ok: false,
    refusalReason: "residency-settle-timeout",
    audit: null,
  };
  const decision = decideCellRefusal({ leg, raw });

  assert.equal(decision.refuse, true);
  assert.equal(decision.exitCode, EXIT_CODES.REFUSAL);
  assert.equal(decision.reason, "residency-settle-timeout");
});

// Fix-round F2: the test above hand-feeds `refusalReason` and only proves
// decideCellRefusal's pass-through. This test instead runs the readiness
// loop's OWN `if (!becameReady) { return {...}; }` block on a scene that
// never loads and reads `refusalReason` off what the harness itself
// produces, so a rename or typo of the literal at its one call site is
// caught here even though decideCellRefusal's own pass-through logic is
// unchanged.
test("DM-10: the readiness loop's own never-loads return carries the named residency-settle-timeout reason", async () => {
  const loopWithRefusalSource = extractReadinessLoopWithRefusalSource();
  const fixture = buildResidencyFakeScene([
    { title: "Google", loadAfterFrame: Infinity },
    { title: "Architecture", loadAfterFrame: Infinity },
  ]);

  const refusal = await runExtractedReadinessLoopWithRefusal(
    loopWithRefusalSource,
    { scene: fixture.scene, tilesets: fixture.tilesets, timeoutMs: 30 },
  );

  assert.notEqual(
    refusal,
    undefined,
    "the never-loads fixture must hit the loop's own early refusal return",
  );
  assert.equal(refusal.ok, false);
  assert.equal(refusal.refusalReason, "residency-settle-timeout");
  assert.equal(refusal.readiness.criterion, "streaming-tileset-residency");
  assert.equal(refusal.readiness.reached, false);
  assert.equal(
    refusal.readiness.tilesetResidencyAtReadiness.every(
      (row) => row.tilesLoaded === false,
    ),
    true,
  );

  // Mutant: rename the harness's own literal, exactly the drift F2 exists to
  // catch, and require THIS test (not just the pass-through test above) to
  // go red.
  const mutantSource = loopWithRefusalSource.replace(
    'refusalReason: "residency-settle-timeout",',
    'refusalReason: "render-ready-timeout",',
  );
  assert.notEqual(
    mutantSource,
    loopWithRefusalSource,
    "F2 rename-needle must remain live",
  );

  const mutantFixture = buildResidencyFakeScene([
    { title: "Google", loadAfterFrame: Infinity },
    { title: "Architecture", loadAfterFrame: Infinity },
  ]);
  const mutantRefusal = await runExtractedReadinessLoopWithRefusal(
    mutantSource,
    {
      scene: mutantFixture.scene,
      tilesets: mutantFixture.tilesets,
      timeoutMs: 30,
    },
  );
  assert.notEqual(
    mutantRefusal.refusalReason,
    "residency-settle-timeout",
    "the rename mutant must be observable through this test",
  );
});

test("DM-10: the cell report carries the streaming-tileset-residency criterion and per-tileset residency", () => {
  const cell = buildCellReport(makeCellReportInput());

  assert.equal(cell.readinessCriterion, "streaming-tileset-residency");
  assert.equal(cell.residencyStableFrameCount, RESIDENCY_STABLE_FRAME_COUNT);
  assert.equal(Array.isArray(cell.tilesetResidencyAtReadiness), true);
  assert.equal(cell.tilesetResidencyAtReadiness.length > 0, true);
  assert.equal(cell.tilesetResidencyAtReadiness[0].tilesLoaded, true);
});
