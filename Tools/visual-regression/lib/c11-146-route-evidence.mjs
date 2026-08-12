// C11-146 — fail-closed moving-altitude route evidence.
//
// The performance runner records first-complete-frame and settle attribution,
// but its generic campaign verdict intentionally covers the broader performance
// protocol. This module owns the narrower C11-146 acceptance contract so a
// missing metric, a trace disagreement, or unbound runtime bytes cannot inherit
// a generic campaign PASS.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { classifyPerformanceCampaignExit } from "./c11-205-evidence.mjs";
import {
  FIRST_COMPLETE_FRAME_STABLE_FRAMES,
  MAIN_THREAD_BOUND_FRACTION,
  SETTLE_ATTRIBUTION_RULE,
} from "./settle-attribution.mjs";

export const C11_146_WORKLOAD_ID = "moving-camera-altitude-track-3d";
export const C11_146_RENDERERS = Object.freeze(["webgl", "webgpu"]);
export const C11_146_ROUTE_SEGMENT_COUNT = 8;
export const C11_146_ROUTE_DURATION_MS = 20_000;
export const C11_146_MIN_SEGMENT_SAMPLES = 30;
export const C11_146_RUNTIME_PATH = "/Build/CesiumUnminified/index.js";
export const C11_146_SERVER_ORIGIN = "http://localhost:8080";
export const C11_146_VIEWER_PATH = "/Apps/CesiumViewer/index.html";
export const C11_146_ARTIFACT_PREFIX = "c11-146-first-complete-route";

const C11_146_REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

export const C11_146_PROVENANCE_FILES = Object.freeze({
  runner: "Tools/visual-regression/run-performance-campaign.mjs",
  manifest: "Tools/visual-regression/performance-workloads.json",
  cameraTrack: "Tools/visual-regression/lib/globe-camera-track.mjs",
  settleAttribution: "Tools/visual-regression/lib/settle-attribution.mjs",
  campaignUtils: "Tools/visual-regression/lib/performance-campaign-utils.mjs",
  exitClassifier: "Tools/visual-regression/lib/c11-205-evidence.mjs",
  manifestSchema: "Tools/visual-regression/performance-workloads.schema.json",
  manifestValidator:
    "Tools/visual-regression/lib/performance-workload-manifest.mjs",
  viewerUrl: "Tools/visual-regression/lib/performance-viewer-url.mjs",
  workloadSelection:
    "Tools/visual-regression/lib/performance-workload-selection.mjs",
  viewerHtml: "Apps/CesiumViewer/index.html",
  viewerEntry: "Apps/CesiumViewer/CesiumViewer.js",
  viewerStartupOptions: "Apps/CesiumViewer/CesiumViewerStartupOptions.js",
  viewerStartMode: "Apps/CesiumViewer/CesiumViewerStartMode.js",
  viewerLoadingIndicator: "Apps/CesiumViewer/CesiumViewerLoadingIndicator.js",
  runtimeEntry: "Build/CesiumUnminified/index.js",
  assessor: "Tools/visual-regression/lib/c11-146-route-evidence.mjs",
  cli: "Tools/visual-regression/assess-c11-146-route.mjs",
});

const expectedSegments = Object.freeze(
  Array.from({ length: C11_146_ROUTE_SEGMENT_COUNT }, (_, index) => index),
);

function normalizePath(value) {
  return String(value).replaceAll("\\", "/");
}

function comparablePath(value) {
  const normalized = normalizePath(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function pathsEquivalent(left, right) {
  return comparablePath(left) === comparablePath(right);
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function approximatelyEqual(left, right, tolerance = 0.001) {
  return finite(left) && finite(right) && Math.abs(left - right) <= tolerance;
}

function sameArray(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function validFingerprint(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    Number.isInteger(value.byteLength) &&
    value.byteLength >= 0 &&
    /^[0-9A-F]{64}$/i.test(value.sha256 ?? "")
  );
}

function fingerprintMatches(left, right) {
  return (
    validFingerprint(left) &&
    validFingerprint(right) &&
    left.byteLength === right.byteLength &&
    String(left.sha256 ?? "").toUpperCase() ===
      String(right.sha256 ?? "").toUpperCase()
  );
}

function identityPathMatches(identity, expectedRelativePath) {
  const actual = comparablePath(identity?.path ?? "");
  const expectedRelative = comparablePath(expectedRelativePath);
  const expectedAbsolute = comparablePath(
    path.resolve(C11_146_REPOSITORY_ROOT, expectedRelativePath),
  );
  return actual === expectedRelative || actual === expectedAbsolute;
}

function canonicalIsoTimestamp(value) {
  if (typeof value !== "string") {
    return Number.NaN;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
    ? milliseconds
    : Number.NaN;
}

function expectedRawArtifactBasename(runId) {
  return `${C11_146_ARTIFACT_PREFIX}.run-${runId}.raw.json`;
}

function messageList(value, fallback) {
  if (Array.isArray(value)) {
    return value.map(String).join("; ") || fallback;
  }
  return value === null || value === undefined ? fallback : String(value);
}

function routeUrl(renderer) {
  const url = new URL(C11_146_VIEWER_PATH, C11_146_SERVER_ORIGIN);
  url.searchParams.set("renderer", renderer);
  url.searchParams.set("offline", "true");
  return url.href;
}

export function fingerprintC11146Bytes(bytes, label = undefined) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return {
    ...(label === undefined ? {} : { path: normalizePath(label) }),
    byteLength: buffer.byteLength,
    sha256: createHash("sha256").update(buffer).digest("hex").toUpperCase(),
  };
}

function readFileIdentity(filePath, failures) {
  try {
    const bytes = fs.readFileSync(filePath);
    const stats = fs.statSync(filePath);
    return {
      ...fingerprintC11146Bytes(bytes, filePath),
      mtimeMs: stats.mtimeMs,
    };
  } catch (error) {
    failures.push(
      `${normalizePath(filePath)}: ${String(error?.message ?? error)}`,
    );
    return null;
  }
}

/**
 * Fingerprint every local file that can change the C11-146 verdict or the
 * runtime it observes. It records failures instead of throwing so a structural
 * artifact can still be written when a build/input is absent.
 */
export function collectC11146LocalProvenance({
  root = process.cwd(),
  files = C11_146_PROVENANCE_FILES,
} = {}) {
  const failures = [];
  const identities = Object.fromEntries(
    Object.entries(files).map(([name, relativePath]) => {
      const absolutePath = path.isAbsolute(relativePath)
        ? relativePath
        : path.resolve(root, relativePath);
      return [name, readFileIdentity(absolutePath, failures)];
    }),
  );
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    files: identities,
    failures,
    ok:
      failures.length === 0 &&
      Object.values(identities).every((identity) => identity !== null),
  };
}

function pushFailure(list, message) {
  if (!list.includes(message)) {
    list.push(message);
  }
}

function compareLocalFile(name, start, end, failures) {
  const startIdentity = start?.files?.[name];
  const endIdentity = end?.files?.[name];
  if (!startIdentity || !endIdentity) {
    pushFailure(failures, `${name} identity is missing at start or end`);
    return;
  }
  const expectedPath = C11_146_PROVENANCE_FILES[name];
  if (
    !identityPathMatches(startIdentity, expectedPath) ||
    !identityPathMatches(endIdentity, expectedPath)
  ) {
    pushFailure(failures, `${name} identity path is not ${expectedPath}`);
  }
  if (!fingerprintMatches(startIdentity, endIdentity)) {
    pushFailure(failures, `${name} changed while the route was running`);
  }
  if (!pathsEquivalent(startIdentity.path, endIdentity.path)) {
    pushFailure(failures, `${name} path changed while the route was running`);
  }
}

function compareArtifactTool(name, artifact, start, failures) {
  const reported = artifact?.source?.tooling?.[name];
  const expected = start?.files?.[name];
  if (!reported || !expected) {
    pushFailure(
      failures,
      `${name} identity is missing from the campaign artifact or preflight`,
    );
    return;
  }
  const expectedPath = C11_146_PROVENANCE_FILES[name];
  if (
    !identityPathMatches(reported, expectedPath) ||
    !identityPathMatches(expected, expectedPath)
  ) {
    pushFailure(
      failures,
      `${name} campaign/preflight path is not ${expectedPath}`,
    );
  }
  if (!fingerprintMatches(reported, expected)) {
    pushFailure(
      failures,
      `${name} identity in the campaign artifact differs from preflight`,
    );
  }
  if (!pathsEquivalent(reported.path, expected.path)) {
    pushFailure(
      failures,
      `${name} path in the campaign artifact differs from preflight`,
    );
  }
}

function evaluateServedRuntime(
  label,
  served,
  localRuntime,
  snapshotBaseUrl,
  failures,
) {
  if (!served || served.ok !== true || served.status !== 200) {
    pushFailure(
      failures,
      `${label} served ${C11_146_RUNTIME_PATH} response is missing or unsuccessful`,
    );
    return;
  }
  let servedUrl;
  try {
    servedUrl = new URL(served.url);
  } catch {
    servedUrl = null;
  }
  if (
    servedUrl?.origin !== C11_146_SERVER_ORIGIN ||
    servedUrl?.origin !== snapshotBaseUrl
  ) {
    pushFailure(
      failures,
      `${label} served runtime did not come from the authoritative local origin`,
    );
  }
  if (servedUrl?.pathname !== C11_146_RUNTIME_PATH) {
    pushFailure(
      failures,
      `${label} served runtime URL does not target ${C11_146_RUNTIME_PATH}`,
    );
  }
  if (!fingerprintMatches(served, localRuntime)) {
    pushFailure(
      failures,
      `${label} served index.js bytes differ from the local runtime entry`,
    );
  }
}

/**
 * Bind stable pre/post local inputs, the exact served ESM response, and the
 * identities embedded in the raw performance artifact.
 */
export function evaluateC11146Provenance({
  startSnapshot,
  endSnapshot,
  artifact,
}) {
  const failures = [];
  if (
    startSnapshot?.schemaVersion !== 1 ||
    endSnapshot?.schemaVersion !== 1 ||
    startSnapshot?.kind !== "c11-146-route-provenance-snapshot" ||
    endSnapshot?.kind !== "c11-146-route-provenance-snapshot"
  ) {
    pushFailure(failures, "pre/post provenance snapshot envelopes are invalid");
  }
  if (
    typeof startSnapshot?.runId !== "string" ||
    startSnapshot.runId.length === 0 ||
    startSnapshot.runId !== endSnapshot?.runId
  ) {
    pushFailure(failures, "pre/post provenance snapshot run IDs do not match");
  }
  if (
    startSnapshot?.baseUrl !== C11_146_SERVER_ORIGIN ||
    endSnapshot?.baseUrl !== C11_146_SERVER_ORIGIN
  ) {
    pushFailure(
      failures,
      `pre/post snapshots must bind ${C11_146_SERVER_ORIGIN}`,
    );
  }
  const start = startSnapshot?.local;
  const end = endSnapshot?.local;
  if (start?.schemaVersion !== 1 || start?.ok !== true) {
    pushFailure(
      failures,
      `preflight local provenance is invalid: ${messageList(start?.failures, "missing")}`,
    );
  }
  if (end?.schemaVersion !== 1 || end?.ok !== true) {
    pushFailure(
      failures,
      `postflight local provenance is invalid: ${messageList(end?.failures, "missing")}`,
    );
  }

  for (const name of Object.keys(C11_146_PROVENANCE_FILES)) {
    compareLocalFile(name, start, end, failures);
  }

  compareArtifactTool("runner", artifact, start, failures);
  compareArtifactTool("manifest", artifact, start, failures);
  compareArtifactTool("cameraTrack", artifact, start, failures);

  const startRepository = startSnapshot?.repository;
  const endRepository = endSnapshot?.repository;
  if (
    startRepository?.ok !== true ||
    endRepository?.ok !== true ||
    !/^[0-9a-f]{40,64}$/i.test(startRepository?.commit ?? "") ||
    !/^[0-9a-f]{40,64}$/i.test(endRepository?.commit ?? "") ||
    startRepository.commit !== endRepository.commit
  ) {
    pushFailure(failures, "repository HEAD changed during the route");
  }
  if (
    typeof startRepository?.branch !== "string" ||
    startRepository.branch.length === 0 ||
    startRepository.branch !== endRepository?.branch ||
    artifact?.source?.branch !== startRepository?.branch
  ) {
    pushFailure(failures, "repository branch identity is missing or changed");
  }
  if (artifact?.source?.commit !== startRepository?.commit) {
    pushFailure(
      failures,
      "campaign artifact commit differs from the preflight repository HEAD",
    );
  }
  if (
    typeof startRepository?.dirty !== "boolean" ||
    startRepository.dirty !== endRepository?.dirty ||
    artifact?.source?.dirty !== startRepository.dirty
  ) {
    pushFailure(
      failures,
      "repository dirty-state identity is missing or changed during the route",
    );
  }

  evaluateServedRuntime(
    "preflight",
    startSnapshot?.servedRuntime,
    start?.files?.runtimeEntry,
    startSnapshot?.baseUrl,
    failures,
  );
  evaluateServedRuntime(
    "postflight",
    endSnapshot?.servedRuntime,
    end?.files?.runtimeEntry,
    endSnapshot?.baseUrl,
    failures,
  );
  if (
    !fingerprintMatches(
      startSnapshot?.servedRuntime,
      endSnapshot?.servedRuntime,
    )
  ) {
    pushFailure(failures, "served index.js bytes changed during the route");
  }

  return {
    schemaVersion: 1,
    ok: failures.length === 0,
    failures,
    fileIdentities: start?.files ?? null,
    endFileIdentities: end?.files ?? null,
    repository: {
      start: startRepository ?? null,
      end: endRepository ?? null,
    },
    runtimeAuthority: {
      path: C11_146_RUNTIME_PATH,
      local: start?.files?.runtimeEntry ?? null,
      servedStart: startSnapshot?.servedRuntime ?? null,
      servedEnd: endSnapshot?.servedRuntime ?? null,
      note: "The ESM index.js identity is authoritative; the generic runner's legacy Cesium.js runtimeBundle field is retained only as an advisory.",
    },
    legacyReportedRuntime: artifact?.source?.runtimeBundle ?? null,
  };
}

function addCheck(state, kind, id, passed, detail) {
  const check = { id, kind, passed: passed === true, detail };
  state.checks.push(check);
  if (!check.passed) {
    const target =
      kind === "error"
        ? state.errors
        : kind === "product"
          ? state.productFailures
          : state.structuralFailures;
    pushFailure(target, `${id}: ${detail}`);
  }
}

function emptyArrayLane(
  state,
  runLabel,
  lane,
  value,
  nonemptyKind = "product",
) {
  addCheck(
    state,
    Array.isArray(value) ? nonemptyKind : "structural",
    `${runLabel}.${lane}`,
    Array.isArray(value) && value.length === 0,
    Array.isArray(value)
      ? `${value.length} entries; expected 0`
      : "lane is missing or not an array",
  );
}

function assessCompletion(state, run, runLabel) {
  const completion = run?.startup?.firstCompleteFrame;
  addCheck(
    state,
    "structural",
    `${runLabel}.completion.detected`,
    completion?.detected === true,
    "first-complete-frame must be detected",
  );
  addCheck(
    state,
    "structural",
    `${runLabel}.completion.stability`,
    completion?.stableFrames === FIRST_COMPLETE_FRAME_STABLE_FRAMES,
    `stableFrames must equal ${FIRST_COMPLETE_FRAME_STABLE_FRAMES}`,
  );
  addCheck(
    state,
    "structural",
    `${runLabel}.completion.selected`,
    Number.isInteger(completion?.selectedTileCount) &&
      completion.selectedTileCount > 0,
    "selectedTileCount must be a positive integer",
  );
  addCheck(
    state,
    "structural",
    `${runLabel}.completion.frame`,
    Number.isInteger(completion?.frameNumber) && completion.frameNumber > 0,
    "completion frameNumber must be a positive integer",
  );
  addCheck(
    state,
    "structural",
    `${runLabel}.completion.traceFrames`,
    Number.isInteger(completion?.tracedFrames) &&
      completion.tracedFrames >= FIRST_COMPLETE_FRAME_STABLE_FRAMES,
    `tracedFrames must cover at least ${FIRST_COMPLETE_FRAME_STABLE_FRAMES} frames`,
  );
  addCheck(
    state,
    "structural",
    `${runLabel}.completion.trace`,
    completion?.traceTruncated === false &&
      completion?.agreesWithTrace === true,
    "completion trace must be complete and agree with Node re-derivation",
  );
  addCheck(
    state,
    "structural",
    `${runLabel}.completion.rootAgreement`,
    JSON.stringify(completion ?? null) ===
      JSON.stringify(run?.sceneCompletionEvidence ?? null),
    "startup and root completion evidence must agree exactly",
  );

  const firstObserved = run?.startup?.navigationToFirstObservedFrameMs;
  const setupToComplete = run?.startup?.setupToFirstCompleteFrameMs;
  const navigationToComplete = run?.startup?.navigationToFirstCompleteFrameMs;
  const lag = navigationToComplete - firstObserved;
  addCheck(
    state,
    "structural",
    `${runLabel}.completion.timings`,
    finite(firstObserved) &&
      firstObserved >= 0 &&
      finite(setupToComplete) &&
      setupToComplete >= 0 &&
      finite(navigationToComplete) &&
      navigationToComplete >= firstObserved &&
      finite(lag) &&
      approximatelyEqual(lag, setupToComplete, 0.01),
    "first-observed/first-complete timings must be finite, nonnegative, and use the same timebase",
  );
  return finite(lag) ? lag : null;
}

function assessAttribution(state, run, runLabel) {
  const attribution = run?.startup?.settleAttribution;
  const window = attribution?.window;
  const longTasks = attribution?.longTasks;
  const duration = window?.endMs - window?.startMs;
  addCheck(
    state,
    "structural",
    `${runLabel}.attribution.available`,
    attribution?.available === true && attribution?.bound !== "unknown",
    "settle attribution must be observable and resolve to a known bound",
  );
  addCheck(
    state,
    "structural",
    `${runLabel}.attribution.window`,
    finite(window?.startMs) &&
      finite(window?.endMs) &&
      window.endMs > window.startMs &&
      finite(window?.durationMs) &&
      window.durationMs > 0 &&
      approximatelyEqual(duration, window.durationMs, 0.01),
    "settle window must be finite, positive, and internally conserved",
  );
  addCheck(
    state,
    "structural",
    `${runLabel}.attribution.rule`,
    attribution?.rule === SETTLE_ATTRIBUTION_RULE,
    "artifact must carry the exact landed settle-attribution rule",
  );
  const longTaskShape =
    Number.isInteger(longTasks?.count) &&
    longTasks.count >= 0 &&
    finite(longTasks?.totalMs) &&
    longTasks.totalMs >= 0 &&
    finite(longTasks?.longestMs) &&
    longTasks.longestMs >= 0 &&
    finite(longTasks?.fraction) &&
    longTasks.fraction >= 0 &&
    approximatelyEqual(
      longTasks.fraction,
      longTasks.totalMs / window?.durationMs,
      0.000001,
    );
  addCheck(
    state,
    "structural",
    `${runLabel}.attribution.longTasks`,
    longTaskShape,
    "long-task count/time/fraction must be finite and conserve the settle window",
  );

  let classificationConsistent = false;
  if (longTaskShape && longTasks.count === 0) {
    classificationConsistent =
      longTasks.totalMs === 0 &&
      attribution?.bound === "gpu-submit" &&
      attribution?.creditable === false;
  } else if (longTaskShape && longTasks.count > 0) {
    const expectedBound =
      longTasks.fraction >= MAIN_THREAD_BOUND_FRACTION
        ? "main-thread"
        : "mixed";
    classificationConsistent =
      longTasks.totalMs > 0 &&
      attribution?.bound === expectedBound &&
      attribution?.creditable === true;
  }
  addCheck(
    state,
    "structural",
    `${runLabel}.attribution.classification`,
    classificationConsistent,
    "bound and creditable fields must agree with the landed classifier",
  );
  addCheck(
    state,
    "structural",
    `${runLabel}.attribution.rootAgreement`,
    JSON.stringify(attribution ?? null) ===
      JSON.stringify(run?.settleAttribution ?? null),
    "startup and root settle-attribution evidence must agree exactly",
  );
}

function assessRoute(state, run, runLabel) {
  const route = run?.trackMetrics;
  const segments = route?.segments;
  const segmentSampleCount = Array.isArray(segments)
    ? segments.reduce(
        (sum, segment) => sum + (segment?.sampleCount ?? Number.NaN),
        0,
      )
    : Number.NaN;
  const segmentShape =
    Array.isArray(segments) &&
    segments.length === C11_146_ROUTE_SEGMENT_COUNT &&
    segments.every(
      (segment, index) =>
        segment?.index === index &&
        Number.isInteger(segment?.sampleCount) &&
        segment.sampleCount >= C11_146_MIN_SEGMENT_SAMPLES,
    );
  addCheck(
    state,
    "structural",
    `${runLabel}.route.coverage`,
    route?.aligned === true &&
      route?.expectedSegmentCount === C11_146_ROUTE_SEGMENT_COUNT &&
      sameArray(route?.observedSegments, expectedSegments) &&
      route?.coveredAllSegments === true &&
      route?.completedRoute === true &&
      segmentShape &&
      Number.isInteger(route?.traceSampleCount) &&
      route.traceSampleCount > 0 &&
      route.traceSampleCount === route?.evidenceSampleCount &&
      segmentSampleCount === route.traceSampleCount,
    `route must align and cover all ${C11_146_ROUTE_SEGMENT_COUNT} segments with at least ${C11_146_MIN_SEGMENT_SAMPLES} samples each`,
  );
  addCheck(
    state,
    "structural",
    `${runLabel}.route.progress`,
    finite(route?.observedProgressRange?.min) &&
      route.observedProgressRange.min <= 0.001 &&
      finite(route?.observedProgressRange?.max) &&
      route.observedProgressRange.max >= 0.99,
    "route progress must span the pre-registered start and tail",
  );
  const expectedHeight = route?.expectedHeightRange;
  const observedHeight = route?.observedHeightRange;
  addCheck(
    state,
    "structural",
    `${runLabel}.route.altitude`,
    expectedHeight?.min === 300 &&
      expectedHeight?.max === 18_000_000 &&
      finite(observedHeight?.min) &&
      observedHeight.min <= expectedHeight.min * 1.1 &&
      finite(observedHeight?.max) &&
      observedHeight.max >= expectedHeight.max * 0.999,
    "route must observe the exact 300 m to 18,000 km altitude envelope",
  );
  addCheck(
    state,
    "structural",
    `${runLabel}.route.measurement`,
    run?.requestedMeasurement?.mode === "duration" &&
      run.requestedMeasurement.durationMs === C11_146_ROUTE_DURATION_MS &&
      run?.measurement?.mode === "duration" &&
      run.measurement.durationMs === C11_146_ROUTE_DURATION_MS &&
      finite(run.measurement.elapsedMs) &&
      run.measurement.elapsedMs >= C11_146_ROUTE_DURATION_MS &&
      Number.isInteger(run.measurement.renderedFrames) &&
      run.measurement.renderedFrames > 0 &&
      run.measurement.renderedFrames === route?.traceSampleCount,
    `measurement must execute the full ${C11_146_ROUTE_DURATION_MS} ms route`,
  );
}

function assessRendererProvenance(state, run, runLabel, renderer) {
  const provenance = run?.gpuProvenance;
  const adapterInfo = provenance?.adapterInfo;
  const webgpuAdapterNamed =
    adapterInfo &&
    [
      adapterInfo.vendor,
      adapterInfo.architecture,
      adapterInfo.device,
      adapterInfo.description,
    ].some((value) => typeof value === "string" && value.length > 0);
  addCheck(
    state,
    "structural",
    `${runLabel}.rendererProvenance`,
    run?.actualRenderer === renderer &&
      provenance?.complete === true &&
      provenance?.backend === renderer &&
      typeof provenance?.rendererString === "string" &&
      provenance.rendererString.length > 0 &&
      (renderer !== "webgpu" || webgpuAdapterNamed === true),
    "resolved backend and physical GPU provenance must be complete and renderer-specific",
  );
}

function assessRun(state, run, renderer) {
  const runLabel = `${renderer}:repetition-1`;
  const runFailureKind = run?.structural === true ? "structural" : "product";
  if (run?.result === "error") {
    addCheck(
      state,
      runFailureKind,
      `${runLabel}.result`,
      false,
      messageList(run?.failures, "run errored"),
    );
  } else {
    addCheck(
      state,
      runFailureKind,
      `${runLabel}.result`,
      run?.result === "pass",
      `run result is ${String(run?.result)}`,
    );
  }
  addCheck(
    state,
    "structural",
    `${runLabel}.identity`,
    run?.renderer === renderer &&
      run?.workloadId === C11_146_WORKLOAD_ID &&
      run?.repetition === 1,
    "run must have the exact renderer, workload, and repetition identity",
  );
  addCheck(
    state,
    "structural",
    `${runLabel}.navigation`,
    run?.startup?.navigationUrl === routeUrl(renderer),
    `browser navigation must be the exact offline ${renderer} route on ${C11_146_SERVER_ORIGIN}`,
  );
  addCheck(
    state,
    "structural",
    `${runLabel}.structuralLane`,
    run?.structural === false &&
      Array.isArray(run?.structuralReasons) &&
      run.structuralReasons.length === 0,
    "run structural flag/reasons must be present and clean",
  );
  addCheck(
    state,
    runFailureKind,
    `${runLabel}.quality`,
    run?.quality?.status === "clean" &&
      run?.quality?.attributionOnly === false &&
      run?.quality?.certificationEligible === true &&
      run?.quality?.measurementValid === true &&
      run?.quality?.validForAggregation === true &&
      run?.quality?.validForCpuAggregation === true &&
      Array.isArray(run?.quality?.reasons) &&
      run.quality.reasons.length === 0,
    "route quality must be clean, causal, and CPU-valid",
  );
  emptyArrayLane(state, runLabel, "failures", run?.failures, runFailureKind);
  emptyArrayLane(
    state,
    runLabel,
    "pageErrors",
    run?.pageErrors,
    runFailureKind,
  );
  emptyArrayLane(
    state,
    runLabel,
    "consoleErrors",
    run?.consoleErrors,
    runFailureKind,
  );
  emptyArrayLane(
    state,
    runLabel,
    "externalRequests",
    run?.externalRequests,
    runFailureKind,
  );
  emptyArrayLane(
    state,
    runLabel,
    "deviceErrors",
    run?.deviceErrors,
    runFailureKind,
  );
  addCheck(
    state,
    runFailureKind,
    `${runLabel}.featureFindings`,
    run?.featureFindings?.requiresPostPerformanceReview === false &&
      Array.isArray(run?.featureFindings?.pageErrors) &&
      run.featureFindings.pageErrors.length === 0 &&
      Array.isArray(run?.featureFindings?.consoleErrors) &&
      run.featureFindings.consoleErrors.length === 0 &&
      Array.isArray(run?.featureFindings?.externalRequests) &&
      run.featureFindings.externalRequests.length === 0 &&
      Array.isArray(run?.featureFindings?.deviceErrors) &&
      run.featureFindings.deviceErrors.length === 0,
    "post-performance-review error lanes must all be present and empty",
  );

  const lagMs = assessCompletion(state, run, runLabel);
  assessAttribution(state, run, runLabel);
  assessRoute(state, run, runLabel);
  assessRendererProvenance(state, run, runLabel, renderer);
  return {
    renderer,
    lagMs,
    firstObservedMs: run?.startup?.navigationToFirstObservedFrameMs ?? null,
    firstCompleteMs: run?.startup?.navigationToFirstCompleteFrameMs ?? null,
    selectedTileCount:
      run?.startup?.firstCompleteFrame?.selectedTileCount ?? null,
    attributionBound: run?.startup?.settleAttribution?.bound ?? null,
    settleWindowMs: run?.startup?.settleAttribution?.window?.durationMs ?? null,
  };
}

function assessProtocol(state, artifact) {
  const protocol = artifact?.protocol;
  const campaignClassification = classifyPerformanceCampaignExit(artifact);
  const campaignResultKind =
    campaignClassification.exitCode === 3
      ? "structural"
      : campaignClassification.exitCode === 2
        ? "error"
        : "product";
  addCheck(
    state,
    campaignResultKind,
    "artifact.result",
    artifact?.result === "pass",
    `campaign result must be pass, received ${String(artifact?.result)} (${campaignClassification.verdict})`,
  );
  const manifestIdentity = artifact?.source?.tooling?.manifest;
  addCheck(
    state,
    "structural",
    "protocol.identity",
    artifact?.schemaVersion === 1 &&
      artifact?.kind === "fork-performance-campaign" &&
      artifact?.manifest?.id === "fork-remediation-phase0-v1" &&
      artifact?.manifest?.schemaVersion === 1 &&
      identityPathMatches(
        { path: artifact?.manifest?.path },
        C11_146_PROVENANCE_FILES.manifest,
      ) &&
      pathsEquivalent(artifact?.manifest?.path, manifestIdentity?.path),
    "artifact schema/kind/default-manifest identity must be exact",
  );
  addCheck(
    state,
    "structural",
    "protocol.selection",
    sameArray(protocol?.selectedWorkloads, [C11_146_WORKLOAD_ID]) &&
      sameArray(protocol?.selectedRenderers, C11_146_RENDERERS) &&
      protocol?.repetitions === 1 &&
      protocol?.measuredFramesOverride === null &&
      protocol?.browserIsolation === "fresh-process-per-run",
    "selection must be one fresh-process WebGL/WebGPU repetition of the authoritative workload",
  );
  addCheck(
    state,
    "structural",
    "protocol.exclusions",
    sameArray(protocol?.skippedWorkloads, []) &&
      sameArray(protocol?.skippedWorkloadRenderers, []),
    "authoritative workload and renderer selection must have no skipped lanes",
  );
  addCheck(
    state,
    "structural",
    "protocol.browserVersion",
    typeof artifact?.browserVersion === "string" &&
      artifact.browserVersion.trim().length > 0,
    "the physical browser version must be recorded",
  );
  addCheck(
    state,
    "structural",
    "protocol.cleanLane",
    protocol?.browser === "msedge" &&
      protocol?.apiInstrumentation === false &&
      protocol?.gpuTimestamps === false &&
      protocol?.cpuOwnerAttribution === false &&
      protocol?.warmupFrames === 120 &&
      protocol?.measuredFrames === 600 &&
      protocol?.settleStableFrames === 30 &&
      protocol?.settleTimeoutMs === 45_000 &&
      protocol?.gpuReadbackDelayMs === 300 &&
      protocol?.resolutionScale === 1 &&
      protocol?.fixedClock === "2026-06-21T08:00:00Z" &&
      protocol?.viewport?.width === 1280 &&
      protocol?.viewport?.height === 720 &&
      protocol?.viewport?.deviceScaleFactor === 1,
    "lane must use the pre-registered clean Edge viewport/clock configuration",
  );
  addCheck(
    state,
    "structural",
    "protocol.schedule",
    protocol?.runSchedule?.length === 1 &&
      protocol.runSchedule[0]?.repetition === 1 &&
      sameArray(protocol.runSchedule[0]?.order, C11_146_RENDERERS) &&
      protocol?.workloadSchedules !== null &&
      typeof protocol?.workloadSchedules === "object" &&
      sameArray(Object.keys(protocol.workloadSchedules), [
        C11_146_WORKLOAD_ID,
      ]) &&
      protocol.workloadSchedules[C11_146_WORKLOAD_ID]?.length === 1 &&
      protocol.workloadSchedules[C11_146_WORKLOAD_ID][0]?.repetition === 1 &&
      sameArray(
        protocol.workloadSchedules[C11_146_WORKLOAD_ID][0]?.order,
        C11_146_RENDERERS,
      ),
    "run schedule must be the exact first WebGL→WebGPU pair",
  );
  addCheck(
    state,
    "product",
    "artifact.errorLane",
    artifact?.errors === undefined ||
      (Array.isArray(artifact.errors) && artifact.errors.length === 0),
    "a non-error campaign artifact must not retain campaign errors",
  );
}

function classifyAssessment(state) {
  if (state.errors.length > 0) {
    return { status: "ERROR", exitCode: 2, accepted: false };
  }
  if (state.productFailures.length > 0) {
    return { status: "FAIL", exitCode: 1, accepted: false };
  }
  if (state.structuralFailures.length > 0) {
    return { status: "STRUCTURAL", exitCode: 3, accepted: false };
  }
  return { status: "ACCEPTED", exitCode: 0, accepted: true };
}

/**
 * Assess one raw performance artifact plus the pre/post wrapper snapshots.
 */
export function assessC11146RouteArtifact({
  artifact,
  startSnapshot,
  endSnapshot,
  artifactIdentity = null,
  wrapperProcess = null,
  exception = null,
  runId = null,
} = {}) {
  const state = {
    checks: [],
    errors: [],
    productFailures: [],
    structuralFailures: [],
  };
  if (exception) {
    addCheck(state, "error", "wrapper.exception", false, String(exception));
  }
  if (wrapperProcess) {
    const status = wrapperProcess.status;
    if (wrapperProcess.error) {
      addCheck(
        state,
        "error",
        "wrapper.process",
        false,
        String(wrapperProcess.error),
      );
    } else if (status === 2) {
      addCheck(
        state,
        "error",
        "wrapper.process",
        false,
        "performance runner exited 2",
      );
    } else if (status === 1) {
      addCheck(
        state,
        "product",
        "wrapper.process",
        false,
        "performance runner exited 1",
      );
    } else if (status === 3) {
      addCheck(
        state,
        "structural",
        "wrapper.process",
        false,
        "performance runner exited 3",
      );
    } else {
      addCheck(
        state,
        "structural",
        "wrapper.process",
        status === 0,
        `performance runner exit must be 0, received ${String(status)}`,
      );
    }
  }

  const provenance = evaluateC11146Provenance({
    startSnapshot,
    endSnapshot,
    artifact,
  });
  addCheck(
    state,
    "structural",
    "provenance",
    provenance.ok,
    provenance.failures.join("; ") || "exact local/served provenance",
  );
  addCheck(
    state,
    "structural",
    "assessment.runIdentity",
    typeof runId === "string" &&
      runId.length > 0 &&
      runId === startSnapshot?.runId &&
      runId === endSnapshot?.runId,
    "assessment and pre/post snapshot run IDs must agree",
  );
  const startTimestamp = canonicalIsoTimestamp(startSnapshot?.generatedAt);
  const artifactTimestamp = canonicalIsoTimestamp(artifact?.generatedAt);
  const endTimestamp = canonicalIsoTimestamp(endSnapshot?.generatedAt);
  addCheck(
    state,
    "structural",
    "assessment.timeline",
    finite(startTimestamp) &&
      finite(artifactTimestamp) &&
      finite(endTimestamp) &&
      startTimestamp <= artifactTimestamp &&
      artifactTimestamp <= endTimestamp,
    "preflight, raw artifact, and postflight timestamps must be canonical and ordered",
  );
  const rawArtifactBasename = path.posix.basename(
    normalizePath(artifactIdentity?.path ?? ""),
  );
  addCheck(
    state,
    "structural",
    "artifact.byteIdentity",
    validFingerprint(artifactIdentity) &&
      typeof artifactIdentity?.path === "string" &&
      artifactIdentity.path.length > 0 &&
      typeof runId === "string" &&
      rawArtifactBasename === expectedRawArtifactBasename(runId),
    "raw artifact bytes must carry a complete SHA-256/length identity and the wrapper run-ID filename",
  );

  if (!artifact || typeof artifact !== "object") {
    addCheck(
      state,
      "structural",
      "artifact",
      false,
      "raw performance artifact is missing or malformed",
    );
  } else if (artifact.result === "error") {
    addCheck(
      state,
      "error",
      "artifact.result",
      false,
      messageList(artifact.errors, "campaign errored"),
    );
  } else {
    assessProtocol(state, artifact);
  }

  const runs = Array.isArray(artifact?.runs) ? artifact.runs : [];
  addCheck(
    state,
    "structural",
    "runs.exactSet",
    runs.length === C11_146_RENDERERS.length &&
      C11_146_RENDERERS.every(
        (renderer) =>
          runs.filter(
            (run) => run?.renderer === renderer && run?.repetition === 1,
          ).length === 1,
      ),
    "artifact must contain exactly one WebGL and one WebGPU repetition-1 run",
  );
  const runSummaries = [];
  if (runs.length === C11_146_RENDERERS.length) {
    for (const renderer of C11_146_RENDERERS) {
      const run = runs.find(
        (candidate) =>
          candidate?.renderer === renderer && candidate?.repetition === 1,
      );
      if (run) {
        runSummaries.push(assessRun(state, run, renderer));
      }
    }
  }

  const classification = classifyAssessment(state);
  return {
    schemaVersion: 1,
    kind: "c11-146-route-assessment",
    campaign: "C11-146",
    runId,
    generatedAt: new Date().toISOString(),
    ...classification,
    verdict:
      classification.exitCode === 0
        ? "metric fired with exact attributable route evidence"
        : classification.status,
    artifact: artifactIdentity,
    provenance,
    runSummaries,
    checks: state.checks,
    errors: state.errors,
    productFailures: state.productFailures,
    structuralFailures: state.structuralFailures,
    exitContract: {
      accepted: 0,
      productOrProtocolFailure: 1,
      exception: 2,
      structuralOrProvenanceFailure: 3,
    },
  };
}

export function c11146FirstRedDecision({ exitCode, existedBefore }) {
  const exists = existedBefore === true;
  return {
    existedBefore: exists,
    written: exitCode !== 0 && !exists,
    preserved: exists,
  };
}

export function writeC11146UniqueJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return fingerprintC11146Bytes(fs.readFileSync(filePath), filePath);
}

/**
 * Preserve the first non-green assessment with an atomic create-new write.
 * The returned payload is what the unique assessment file should contain.
 */
export function preserveC11146FirstRed(filePath, assessment) {
  const base = {
    path: normalizePath(filePath),
    policy: "write-once-create-new",
  };
  if (assessment?.exitCode === 0) {
    const existedBefore = fs.existsSync(filePath);
    return {
      payload: {
        ...assessment,
        firstRed: {
          ...base,
          existedBefore,
          written: false,
          preserved: existedBefore,
        },
      },
      identity: existedBefore ? readFileIdentity(filePath, []) : null,
    };
  }

  const candidate = {
    ...assessment,
    firstRed: {
      ...base,
      ...c11146FirstRedDecision({
        exitCode: assessment.exitCode,
        existedBefore: false,
      }),
    },
  };
  try {
    const identity = writeC11146UniqueJson(filePath, candidate);
    return { payload: candidate, identity };
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
    const failures = [];
    const identity = readFileIdentity(filePath, failures);
    if (!identity || failures.length > 0) {
      throw new Error(
        `existing first-red artifact could not be fingerprinted: ${failures.join("; ")}`,
        { cause: error },
      );
    }
    return {
      payload: {
        ...assessment,
        firstRed: {
          ...base,
          ...c11146FirstRedDecision({
            exitCode: assessment.exitCode,
            existedBefore: true,
          }),
        },
      },
      identity,
    };
  }
}

export default {
  C11_146_WORKLOAD_ID,
  C11_146_RENDERERS,
  C11_146_ROUTE_SEGMENT_COUNT,
  C11_146_ROUTE_DURATION_MS,
  C11_146_MIN_SEGMENT_SAMPLES,
  C11_146_RUNTIME_PATH,
  C11_146_SERVER_ORIGIN,
  C11_146_VIEWER_PATH,
  C11_146_ARTIFACT_PREFIX,
  C11_146_PROVENANCE_FILES,
  fingerprintC11146Bytes,
  collectC11146LocalProvenance,
  evaluateC11146Provenance,
  assessC11146RouteArtifact,
  c11146FirstRedDecision,
  writeC11146UniqueJson,
  preserveC11146FirstRed,
};
