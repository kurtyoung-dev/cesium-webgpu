// @purpose Contract + mutants for the C11-146 route-evidence policy: provenance fingerprinting, artifact assessment, first-red preservation, CLI wiring.
// @status ACTIVE

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  C11_146_ARTIFACT_PREFIX,
  C11_146_PROVENANCE_FILES,
  C11_146_RENDERERS,
  C11_146_RUNTIME_PATH,
  C11_146_SERVER_ORIGIN,
  C11_146_WORKLOAD_ID,
  assessC11146RouteArtifact,
  c11146FirstRedDecision,
  collectC11146LocalProvenance,
  fingerprintC11146Bytes,
  preserveC11146FirstRed,
  writeC11146UniqueJson,
} from "./lib/c11-146-route-evidence.mjs";
import {
  FIRST_COMPLETE_FRAME_STABLE_FRAMES,
  SETTLE_ATTRIBUTION_RULE,
} from "./lib/settle-attribution.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(HERE, "..", "..");
const FIXTURE_RUN_ID = "11111111-1111-4111-8111-111111111111";
const CLI_SOURCE = fs.readFileSync(
  path.join(HERE, "assess-c11-146-route.mjs"),
  "utf8",
);
const POLICY_SOURCE = fs.readFileSync(
  path.join(HERE, "lib", "c11-146-route-evidence.mjs"),
  "utf8",
);

function identity(name) {
  return fingerprintC11146Bytes(Buffer.from(`identity:${name}\n`), name);
}

function makeSnapshot() {
  const files = Object.fromEntries(
    Object.entries(C11_146_PROVENANCE_FILES).map(([name, filePath]) => [
      name,
      { ...identity(name), path: path.resolve(REPOSITORY_ROOT, filePath) },
    ]),
  );
  return {
    schemaVersion: 1,
    kind: "c11-146-route-provenance-snapshot",
    runId: FIXTURE_RUN_ID,
    generatedAt: "2026-08-12T00:00:00.000Z",
    baseUrl: C11_146_SERVER_ORIGIN,
    repository: {
      commit: "a".repeat(40),
      branch: "main",
      dirty: true,
      ok: true,
    },
    local: {
      schemaVersion: 1,
      generatedAt: "2026-08-12T00:00:00.000Z",
      files,
      failures: [],
      ok: true,
    },
    servedRuntime: {
      url: `${C11_146_SERVER_ORIGIN}${C11_146_RUNTIME_PATH}`,
      status: 200,
      ok: true,
      ...files.runtimeEntry,
    },
  };
}

function makeAttribution() {
  return {
    available: true,
    window: { startMs: 100, endMs: 1100, durationMs: 1000 },
    longTasks: { count: 0, totalMs: 0, longestMs: 0, fraction: 0 },
    bound: "gpu-submit",
    creditable: false,
    reason: "zero main-thread long tasks in the settle window",
    rule: SETTLE_ATTRIBUTION_RULE,
  };
}

function makeTrackMetrics() {
  return {
    aligned: true,
    traceSampleCount: 1000,
    evidenceSampleCount: 1000,
    expectedSegmentCount: 8,
    observedSegments: [0, 1, 2, 3, 4, 5, 6, 7],
    coveredAllSegments: true,
    observedProgressRange: { min: 0, max: 0.9995 },
    completedRoute: true,
    expectedHeightRange: { min: 300, max: 18_000_000 },
    observedHeightRange: { min: 301, max: 18_000_000 },
    segments: Array.from({ length: 8 }, (_, index) => ({
      index,
      name: `segment-${index}`,
      sampleCount: 125,
    })),
  };
}

function makeRun(renderer) {
  const completion = {
    detected: true,
    stableFrames: FIRST_COMPLETE_FRAME_STABLE_FRAMES,
    frameNumber: renderer === "webgl" ? 12 : 15,
    selectedTileCount: renderer === "webgl" ? 4 : 5,
    tracedFrames: 9,
    traceTruncated: false,
    agreesWithTrace: true,
  };
  const attribution = makeAttribution();
  return {
    result: "pass",
    failures: [],
    structural: false,
    structuralReasons: [],
    renderer,
    actualRenderer: renderer,
    workloadId: C11_146_WORKLOAD_ID,
    repetition: 1,
    requestedMeasurement: {
      mode: "duration",
      durationMs: 20_000,
      nominalFrames: 600,
    },
    measurement: {
      mode: "duration",
      durationMs: 20_000,
      nominalFrames: 600,
      elapsedMs: 20_005,
      renderedFrames: 1000,
    },
    startup: {
      navigationUrl: `${C11_146_SERVER_ORIGIN}/Apps/CesiumViewer/index.html?renderer=${renderer}&offline=true`,
      navigationToFirstObservedFrameMs: 1000,
      setupToFirstCompleteFrameMs: renderer === "webgl" ? 100 : 2200,
      navigationToFirstCompleteFrameMs: renderer === "webgl" ? 1100 : 3200,
      firstCompleteFrame: completion,
      settleAttribution: attribution,
    },
    sceneCompletionEvidence: structuredClone(completion),
    settleAttribution: structuredClone(attribution),
    trackMetrics: makeTrackMetrics(),
    quality: {
      status: "clean",
      attributionOnly: false,
      certificationEligible: true,
      measurementValid: true,
      validForAggregation: true,
      validForCpuAggregation: true,
      validForGpuAggregation: false,
      reasons: [],
      warnings: [],
    },
    gpuProvenance: {
      backend: renderer,
      rendererString:
        renderer === "webgl"
          ? "WebGL 2: ANGLE NVIDIA GeForce"
          : "WebGPU - NVIDIA GeForce",
      adapterInfo:
        renderer === "webgpu"
          ? { vendor: "nvidia", architecture: "pascal" }
          : null,
      complete: true,
    },
    pageErrors: [],
    consoleErrors: [],
    externalRequests: [],
    deviceErrors: [],
    featureFindings: {
      requiresPostPerformanceReview: false,
      pageErrors: [],
      consoleErrors: [],
      externalRequests: [],
      deviceErrors: [],
    },
  };
}

function makeFixture() {
  const startSnapshot = makeSnapshot();
  const endSnapshot = structuredClone(startSnapshot);
  endSnapshot.generatedAt = "2026-08-12T00:05:00.000Z";
  endSnapshot.local.generatedAt = "2026-08-12T00:05:00.000Z";
  const artifact = {
    schemaVersion: 1,
    kind: "fork-performance-campaign",
    generatedAt: "2026-08-12T00:04:00.000Z",
    manifest: {
      path: startSnapshot.local.files.manifest.path,
      id: "fork-remediation-phase0-v1",
      schemaVersion: 1,
    },
    source: {
      commit: startSnapshot.repository.commit,
      branch: startSnapshot.repository.branch,
      dirty: true,
      runtimeBundle: identity("legacy-Cesium.js"),
      tooling: {
        runner: startSnapshot.local.files.runner,
        manifest: startSnapshot.local.files.manifest,
        cameraTrack: startSnapshot.local.files.cameraTrack,
      },
    },
    protocol: {
      browser: "msedge",
      viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
      fixedClock: "2026-06-21T08:00:00Z",
      warmupFrames: 120,
      measuredFrames: 600,
      settleStableFrames: 30,
      settleTimeoutMs: 45_000,
      gpuReadbackDelayMs: 300,
      resolutionScale: 1,
      repetitions: 1,
      measuredFramesOverride: null,
      apiInstrumentation: false,
      gpuTimestamps: false,
      cpuOwnerAttribution: false,
      browserIsolation: "fresh-process-per-run",
      selectedRenderers: [...C11_146_RENDERERS],
      selectedWorkloads: [C11_146_WORKLOAD_ID],
      skippedWorkloads: [],
      skippedWorkloadRenderers: [],
      runSchedule: [{ repetition: 1, order: [...C11_146_RENDERERS] }],
      workloadSchedules: {
        [C11_146_WORKLOAD_ID]: [
          { repetition: 1, order: [...C11_146_RENDERERS] },
        ],
      },
    },
    browserVersion: "151.0.0.0",
    runs: C11_146_RENDERERS.map(makeRun),
    result: "pass",
  };
  return {
    artifact,
    startSnapshot,
    endSnapshot,
    artifactIdentity: identity(
      path.join(
        HERE,
        "output",
        "performance",
        `${C11_146_ARTIFACT_PREFIX}.run-${FIXTURE_RUN_ID}.raw.json`,
      ),
    ),
    runId: FIXTURE_RUN_ID,
  };
}

function assess(fixture) {
  return assessC11146RouteArtifact(fixture);
}

test("an exact clean moving-altitude pair is accepted", () => {
  const fixture = makeFixture();
  assert.equal(path.isAbsolute(fixture.artifact.manifest.path), true);
  assert.equal(
    fixture.artifact.manifest.path,
    fixture.artifact.source.tooling.manifest.path,
  );
  const result = assess(fixture);
  assert.equal(result.status, "ACCEPTED", result.structuralFailures.join("\n"));
  assert.equal(result.exitCode, 0);
  assert.equal(result.accepted, true);
  assert.deepEqual(
    result.runSummaries.map((entry) => entry.renderer),
    C11_146_RENDERERS,
  );
  assert.deepEqual(
    result.runSummaries.map((entry) => entry.lagMs),
    [100, 2200],
  );
  assert.equal(result.provenance.runtimeAuthority.path, C11_146_RUNTIME_PATH);
  assert.equal(
    result.provenance.fileIdentities.settleAttribution.sha256.length,
    64,
  );
});

const structuralMutants = [
  [
    "wrong workload",
    (f) => (f.artifact.protocol.selectedWorkloads[0] = "other"),
  ],
  ["missing WebGPU run", (f) => f.artifact.runs.pop()],
  ["extra run", (f) => f.artifact.runs.push(makeRun("webgl"))],
  ["missing browser version", (f) => (f.artifact.browserVersion = null)],
  ["skipped workload", (f) => f.artifact.protocol.skippedWorkloads.push("x")],
  [
    "measured-frame override",
    (f) => (f.artifact.protocol.measuredFramesOverride = 600),
  ],
  [
    "missing CPU attribution lane flag",
    (f) => (f.artifact.protocol.cpuOwnerAttribution = null),
  ],
  [
    "API instrumentation enabled",
    (f) => (f.artifact.protocol.apiInstrumentation = true),
  ],
  ["GPU timestamps enabled", (f) => (f.artifact.protocol.gpuTimestamps = true)],
  ["wrong viewport width", (f) => (f.artifact.protocol.viewport.width = 1279)],
  [
    "wrong fixed clock",
    (f) => (f.artifact.protocol.fixedClock = "2026-06-21T08:00:01Z"),
  ],
  [
    "wrong resolution scale",
    (f) => (f.artifact.protocol.resolutionScale = 0.5),
  ],
  [
    "wrong settle protocol",
    (f) => (f.artifact.protocol.settleStableFrames = 29),
  ],
  [
    "wrong global run schedule",
    (f) => f.artifact.protocol.runSchedule[0].order.reverse(),
  ],
  [
    "missing workload schedule",
    (f) => delete f.artifact.protocol.workloadSchedules[C11_146_WORKLOAD_ID],
  ],
  [
    "wrong manifest path",
    (f) => (f.artifact.manifest.path = "performance-workloads.json"),
  ],
  [
    "manifest display/tool path mismatch",
    (f) =>
      (f.artifact.manifest.path = path.resolve(
        REPOSITORY_ROOT,
        "other",
        "performance-workloads.json",
      )),
  ],
  [
    "manifest suffix alias",
    (f) => {
      const alias = path.resolve(
        os.tmpdir(),
        "c11-146-alias",
        C11_146_PROVENANCE_FILES.manifest,
      );
      f.startSnapshot.local.files.manifest.path = alias;
      f.endSnapshot.local.files.manifest.path = alias;
      f.artifact.manifest.path = alias;
    },
  ],
  [
    "malformed equal fingerprints",
    (f) => {
      f.startSnapshot.local.files.runner.sha256 = "";
      f.endSnapshot.local.files.runner.sha256 = "";
    },
  ],
  [
    "identity path alias",
    (f) => {
      f.startSnapshot.local.files.runner.path = "other/runner.mjs";
      f.endSnapshot.local.files.runner.path = "other/runner.mjs";
    },
  ],
  ["snapshot run-ID drift", (f) => (f.endSnapshot.runId = "another-run")],
  [
    "artifact predates preflight",
    (f) => (f.artifact.generatedAt = "2026-08-11T23:59:59.999Z"),
  ],
  [
    "artifact postdates postflight",
    (f) => (f.artifact.generatedAt = "2026-08-12T00:05:00.001Z"),
  ],
  [
    "noncanonical artifact timestamp",
    (f) => (f.artifact.generatedAt = "2026-08-12T00:04:00Z"),
  ],
  [
    "raw filename is not bound to run ID",
    (f) => (f.artifactIdentity.path = path.join(HERE, "stale.raw.json")),
  ],
  [
    "served runtime from another origin",
    (f) =>
      (f.endSnapshot.servedRuntime.url = `http://127.0.0.1:8080${C11_146_RUNTIME_PATH}`),
  ],
  [
    "repository dirty-state drift",
    (f) => (f.endSnapshot.repository.dirty = false),
  ],
  ["missing raw identity", (f) => (f.artifactIdentity = null)],
  [
    "runner identity drift",
    (f) => (f.endSnapshot.local.files.runner.sha256 = "0".repeat(64)),
  ],
  [
    "manifest artifact mismatch",
    (f) => (f.artifact.source.tooling.manifest.sha256 = "1".repeat(64)),
  ],
  [
    "camera-track artifact mismatch",
    (f) => f.artifact.source.tooling.cameraTrack.byteLength++,
  ],
  [
    "settle policy drift",
    (f) =>
      (f.endSnapshot.local.files.settleAttribution.sha256 = "2".repeat(64)),
  ],
  [
    "viewer entry drift",
    (f) => (f.endSnapshot.local.files.viewerEntry.sha256 = "4".repeat(64)),
  ],
  [
    "workload-selection drift",
    (f) =>
      (f.endSnapshot.local.files.workloadSelection.sha256 = "5".repeat(64)),
  ],
  [
    "served runtime mismatch",
    (f) => (f.endSnapshot.servedRuntime.sha256 = "3".repeat(64)),
  ],
  [
    "repository HEAD drift",
    (f) => (f.endSnapshot.repository.commit = "b".repeat(40)),
  ],
  [
    "completion not detected",
    (f) => (f.artifact.runs[0].startup.firstCompleteFrame.detected = false),
  ],
  [
    "wrong stable-frame count",
    (f) => (f.artifact.runs[0].startup.firstCompleteFrame.stableFrames = 1),
  ],
  [
    "empty selected set",
    (f) =>
      (f.artifact.runs[0].startup.firstCompleteFrame.selectedTileCount = 0),
  ],
  [
    "invalid completion frame",
    (f) => (f.artifact.runs[0].startup.firstCompleteFrame.frameNumber = 0),
  ],
  [
    "insufficient traced frames",
    (f) => (f.artifact.runs[0].startup.firstCompleteFrame.tracedFrames = 2),
  ],
  [
    "truncated trace",
    (f) =>
      (f.artifact.runs[0].startup.firstCompleteFrame.traceTruncated = true),
  ],
  [
    "trace disagreement",
    (f) =>
      (f.artifact.runs[0].startup.firstCompleteFrame.agreesWithTrace = false),
  ],
  [
    "negative lag",
    (f) => (f.artifact.runs[0].startup.navigationToFirstCompleteFrameMs = 900),
  ],
  [
    "navigation detached from served origin",
    (f) =>
      (f.artifact.runs[0].startup.navigationUrl =
        "http://127.0.0.1:8080/Apps/CesiumViewer/index.html?renderer=webgl&offline=true"),
  ],
  [
    "run structural reason retained",
    (f) => {
      f.artifact.runs[0].structural = true;
      f.artifact.runs[0].structuralReasons.push("instrument gap");
    },
  ],
  [
    "structural failing run",
    (f) => {
      f.artifact.result = "fail";
      f.artifact.runs[0].result = "fail";
      f.artifact.runs[0].structural = true;
      f.artifact.runs[0].failures.push("instrument gap");
      f.artifact.runs[0].structuralReasons.push("instrument gap");
    },
  ],
  [
    "structural error run",
    (f) => {
      f.artifact.result = "fail";
      f.artifact.runs[0].result = "error";
      f.artifact.runs[0].structural = true;
      f.artifact.runs[0].failures.push("[structural] instrument gap");
      f.artifact.runs[0].structuralReasons.push("[structural] instrument gap");
    },
  ],
  [
    "minimal caught structural error run",
    (f) => {
      f.artifact.result = "fail";
      f.artifact.runs[0] = {
        result: "error",
        failures: ["[structural] instrument gap"],
        structural: true,
        structuralReasons: ["[structural] instrument gap"],
        renderer: "webgl",
        workloadId: C11_146_WORKLOAD_ID,
        repetition: 1,
        requestedMeasurement: {
          mode: "duration",
          durationMs: 20_000,
          nominalFrames: 600,
        },
        measuredFrames: 0,
        pageErrors: [],
        consoleErrors: [],
        externalRequests: [],
      };
    },
  ],
  [
    "unavailable attribution",
    (f) => (f.artifact.runs[0].startup.settleAttribution.available = false),
  ],
  [
    "wrong attribution rule",
    (f) => (f.artifact.runs[0].startup.settleAttribution.rule = "weaker rule"),
  ],
  [
    "degenerate attribution window",
    (f) => (f.artifact.runs[0].startup.settleAttribution.window.endMs = 100),
  ],
  [
    "inconsistent attribution bound",
    (f) => (f.artifact.runs[0].startup.settleAttribution.bound = "main-thread"),
  ],
  [
    "missing route segment",
    (f) => f.artifact.runs[0].trackMetrics.segments.pop(),
  ],
  [
    "short route segment",
    (f) => (f.artifact.runs[0].trackMetrics.segments[3].sampleCount = 29),
  ],
  [
    "route sample accounting mismatch",
    (f) => f.artifact.runs[0].trackMetrics.traceSampleCount--,
  ],
  [
    "route tail missing",
    (f) => (f.artifact.runs[0].trackMetrics.observedProgressRange.max = 0.8),
  ],
  [
    "altitude envelope missing",
    (f) => (f.artifact.runs[0].trackMetrics.observedHeightRange.min = 1000),
  ],
  [
    "incomplete GPU provenance",
    (f) => (f.artifact.runs[1].gpuProvenance.complete = false),
  ],
  [
    "wrong resolved renderer",
    (f) => (f.artifact.runs[1].actualRenderer = "webgl"),
  ],
];

for (const [name, mutate] of structuralMutants) {
  test(`structural mutant is rejected: ${name}`, () => {
    const fixture = makeFixture();
    mutate(fixture);
    const result = assess(fixture);
    assert.equal(result.accepted, false, `${name} passed vacuously`);
    assert.equal(result.exitCode, 3, JSON.stringify(result, null, 2));
    assert.ok(result.structuralFailures.length > 0);
  });
}

const productMutants = [
  ["campaign result failure", (f) => (f.artifact.result = "fail")],
  ["campaign error lane", (f) => (f.artifact.errors = ["reported red"])],
  ["run result failure", (f) => (f.artifact.runs[0].result = "fail")],
  [
    "nonstructural error run",
    (f) => {
      f.artifact.result = "fail";
      f.artifact.runs[0].result = "error";
      f.artifact.runs[0].failures.push("browser error");
    },
  ],
  [
    "product failure dominates a structural run",
    (f) => {
      f.artifact.result = "fail";
      f.artifact.runs[0].result = "fail";
      f.artifact.runs[0].structural = true;
      f.artifact.runs[0].failures.push("instrument gap");
      f.artifact.runs[0].structuralReasons.push("instrument gap");
      f.artifact.runs[1].result = "fail";
      f.artifact.runs[1].failures.push("product red");
    },
  ],
  ["invalid quality", (f) => (f.artifact.runs[0].quality.status = "invalid")],
  [
    "non-aggregatable quality",
    (f) => (f.artifact.runs[0].quality.validForAggregation = false),
  ],
  ["page error", (f) => f.artifact.runs[0].pageErrors.push("page red")],
  [
    "console error",
    (f) => f.artifact.runs[0].consoleErrors.push("console red"),
  ],
  [
    "external request",
    (f) =>
      f.artifact.runs[0].externalRequests.push({
        url: "https://example.invalid",
      }),
  ],
  ["device error", (f) => f.artifact.runs[1].deviceErrors.push("device red")],
  [
    "post-review error",
    (f) =>
      (f.artifact.runs[0].featureFindings.requiresPostPerformanceReview = true),
  ],
];

for (const [name, mutate] of productMutants) {
  test(`product/protocol mutant exits 1: ${name}`, () => {
    const fixture = makeFixture();
    mutate(fixture);
    const result = assess(fixture);
    assert.equal(result.accepted, false, `${name} passed vacuously`);
    assert.equal(result.exitCode, 1, JSON.stringify(result, null, 2));
    assert.ok(result.productFailures.length > 0);
  });
}

test("campaign and wrapper exceptions exit 2", () => {
  const artifactError = makeFixture();
  artifactError.artifact.result = "error";
  artifactError.artifact.errors = ["synthetic campaign exception"];
  assert.equal(assess(artifactError).exitCode, 2);

  const wrapperError = assessC11146RouteArtifact({
    ...makeFixture(),
    exception: "synthetic wrapper exception",
  });
  assert.equal(wrapperError.exitCode, 2);
  assert.match(wrapperError.errors.join("\n"), /wrapper exception/);
});

test("runner exit taxonomy cannot collapse structural or product reds to green", () => {
  for (const [status, expected] of [
    [0, 0],
    [1, 1],
    [2, 2],
    [3, 3],
  ]) {
    const result = assessC11146RouteArtifact({
      ...makeFixture(),
      wrapperProcess: { status, error: null },
    });
    assert.equal(result.exitCode, expected, `runner exit ${status}`);
  }
});

test("local provenance collector records every supplied file and fails closed", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "c11-146-files-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "a.mjs"), "export const a = 1;\n");
  fs.writeFileSync(path.join(directory, "b.json"), "{}\n");
  const good = collectC11146LocalProvenance({
    root: directory,
    files: { one: "a.mjs", two: "b.json" },
  });
  assert.equal(good.ok, true, good.failures.join("\n"));
  assert.match(good.files.one.sha256, /^[0-9A-F]{64}$/);
  const missing = collectC11146LocalProvenance({
    root: directory,
    files: { absent: "missing.js" },
  });
  assert.equal(missing.ok, false);
  assert.match(missing.failures.join("\n"), /missing\.js/);
});

test("default provenance freezes the live route helpers and Viewer boot graph", () => {
  const required = [
    "manifestSchema",
    "manifestValidator",
    "viewerUrl",
    "workloadSelection",
    "viewerHtml",
    "viewerEntry",
    "viewerStartupOptions",
    "viewerStartMode",
    "viewerLoadingIndicator",
  ];
  for (const name of required) {
    const relativePath = C11_146_PROVENANCE_FILES[name];
    assert.equal(typeof relativePath, "string", `${name} is absent`);
    assert.equal(
      fs.existsSync(path.resolve(REPOSITORY_ROOT, relativePath)),
      true,
      `${name} does not exist`,
    );
  }
  const provenance = collectC11146LocalProvenance({ root: REPOSITORY_ROOT });
  assert.equal(provenance.ok, true, provenance.failures.join("\n"));
  assert.deepEqual(Object.keys(provenance.files), [
    ...Object.keys(C11_146_PROVENANCE_FILES),
  ]);
  for (const name of required) {
    assert.match(provenance.files[name].sha256, /^[0-9A-F]{64}$/);
  }
});

test("unique JSON output refuses overwrite and preserves original bytes", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "c11-146-unique-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, "run.json");
  const first = { runId: "first", status: "STRUCTURAL", exitCode: 3 };
  writeC11146UniqueJson(output, first);
  const original = fs.readFileSync(output, "utf8");
  assert.throws(
    () => writeC11146UniqueJson(output, { runId: "second" }),
    (error) => error?.code === "EEXIST",
  );
  assert.equal(fs.readFileSync(output, "utf8"), original);
});

test("first-red lifecycle is create-new, write-once, and preserves prior evidence", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "c11-146-red-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const firstRed = path.join(directory, "first-red.json");
  const redA = {
    campaign: "C11-146",
    runId: "red-a",
    status: "STRUCTURAL",
    exitCode: 3,
  };
  const first = preserveC11146FirstRed(firstRed, redA);
  assert.equal(first.payload.firstRed.written, true);
  assert.equal(first.payload.firstRed.preserved, false);
  const original = fs.readFileSync(firstRed, "utf8");

  const later = preserveC11146FirstRed(firstRed, {
    ...redA,
    runId: "red-b",
    status: "FAIL",
    exitCode: 1,
  });
  assert.equal(later.payload.firstRed.written, false);
  assert.equal(later.payload.firstRed.preserved, true);
  assert.equal(fs.readFileSync(firstRed, "utf8"), original);

  const green = preserveC11146FirstRed(firstRed, {
    ...redA,
    runId: "green",
    status: "ACCEPTED",
    exitCode: 0,
  });
  assert.equal(green.payload.firstRed.written, false);
  assert.equal(green.payload.firstRed.preserved, true);
  assert.equal(fs.readFileSync(firstRed, "utf8"), original);
});

test("a first green creates no physical first-red", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "c11-146-green-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const firstRed = path.join(directory, "first-red.json");
  const result = preserveC11146FirstRed(firstRed, {
    campaign: "C11-146",
    status: "ACCEPTED",
    exitCode: 0,
  });
  assert.equal(result.payload.firstRed.written, false);
  assert.equal(result.payload.firstRed.preserved, false);
  assert.equal(fs.existsSync(firstRed), false);
});

test("first-red decision table is explicit", () => {
  assert.deepEqual(
    c11146FirstRedDecision({ exitCode: 3, existedBefore: false }),
    { existedBefore: false, written: true, preserved: false },
  );
  assert.deepEqual(
    c11146FirstRedDecision({ exitCode: 1, existedBefore: true }),
    { existedBefore: true, written: false, preserved: true },
  );
  assert.deepEqual(
    c11146FirstRedDecision({ exitCode: 0, existedBefore: false }),
    { existedBefore: false, written: false, preserved: false },
  );
});

test("CLI owns exact clean route, served ESM, timeout, and unique evidence wiring", () => {
  for (const pattern of [
    /"--manifest",\s*path\.resolve\(HERE, "performance-workloads\.json"\)/,
    /"--workload",\s*C11_146_WORKLOAD_ID/,
    /"--renderer",\s*"both"/,
    /"--repetitions",\s*"1"/,
    /"--no-gpu-timestamps"/,
    /timeout:\s*timeoutMs/,
    /fetchRuntimeIdentity\(baseUrl\)/,
    /C11_146_SERVER_ORIGIN/,
    /rawArtifact:\s*paths\.raw/,
    /preserveC11146FirstRed/,
    /writeC11146UniqueJson/,
  ]) {
    assert.match(CLI_SOURCE, pattern);
  }
  assert.doesNotMatch(CLI_SOURCE, /from "playwright"/);
  assert.match(POLICY_SOURCE, /flag: "wx"/);
  assert.match(POLICY_SOURCE, /Build\/CesiumUnminified\/index\.js/);
  assert.doesNotMatch(
    POLICY_SOURCE,
    /runtimeEntry:\s*"Build\/CesiumUnminified\/Cesium\.js"/,
  );
});
