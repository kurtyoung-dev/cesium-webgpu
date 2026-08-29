import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  EXIT_CODES,
  EXTRA_LEVERS,
  REQUIRED_SERVED_ARTIFACTS,
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

    const mutantUrl =
      "data:text/javascript;base64," +
      Buffer.from(mutantSource).toString("base64");
    const mutant = await import(mutantUrl);
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
