#!/usr/bin/env node
/**
 * Draco time-dynamic point-cloud browser gate.
 * @purpose Verify that a served Draco decoder lets a time-dynamic point cloud become ready and render with feature-scale cross-backend parity inside a bounded wait.
 * @status ACTIVE
 *
 * The probe is acquisition only. Its exported browser-free functions own the
 * counter validation and verdict fold. An authorized machine lane supplies an
 * already-served build; this file neither builds Cesium nor starts a server.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import sharp from "sharp";

import {
  FUSED_SNAPSHOT_BEGIN,
  FUSED_SNAPSHOT_CAPTURE_SOURCE,
  FUSED_SNAPSHOT_END,
  checkEmbeddedFusedSnapshotIsCanonical,
  checkFusedCaptureUsage,
} from "./lib/same-task-capture.mjs";
import {
  fingerprintEvidenceFile,
  validateServedEntryIdentities,
} from "./lib/build-source-identity.mjs";
import { exitCodeForS5Status } from "./lib/verdict-exit-gate.mjs";
import {
  armWebGPUDevices,
  attachConsoleErrorGate,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";

export const POINTCLOUD_DRACO_TIMEDYNAMIC_SCHEMA =
  "pointcloud-draco-timedynamic/v1";

export const POINTCLOUD_DRACO_TIMEDYNAMIC_CONFIG = Object.freeze({
  width: 600,
  height: 600,
  readinessBudgetMs: 60_000,
  maximumReadinessRenders: 4_000,
  decoderMinimumBytes: 1_024,
  decoderMagicHex: "0061736d",
  foregroundRgbSum: 24,
  downsampleFactor: 4,
  channelDifference: 40,
  // This is the standing feature-scale point-cloud comparison. Global colour
  // gains stay visible in the report but are scored by the dedicated tint gate.
  maximumNormalizedMismatchFraction: 0.16,
});

const FRAME_DATES = Object.freeze([
  "2018-07-19T15:18:00Z",
  "2018-07-19T15:18:00.5Z",
  "2018-07-19T15:18:01Z",
  "2018-07-19T15:18:01.5Z",
  "2018-07-19T15:18:02Z",
  "2018-07-19T15:18:02.5Z",
]);
const FRAME_URLS = Object.freeze(
  Array.from(
    { length: 5 },
    (_, index) =>
      `/Specs/Data/Cesium3DTiles/PointCloud/PointCloudTimeDynamicDraco/${index}.pnts`,
  ),
);
const RENDERERS = Object.freeze(["webgl", "webgpu"]);

const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(toolDirectory, "../..");
const probeSourcePath = fileURLToPath(import.meta.url);
const buildEntryPath = path.join(
  repositoryRoot,
  "Build/CesiumUnminified/index.js",
);
const BUILD_ENTRY_ROUTE = "/Build/CesiumUnminified/index.js";
const defaultBase = process.env.PROBE_BASE ?? "http://localhost:8080";
const defaultOutputRoot = path.resolve(
  process.env.POINTCLOUD_DRACO_TIMEDYNAMIC_OUTPUT_DIR ??
    path.join(toolDirectory, "output/pointcloud-draco-timedynamic"),
);
const DECODER_FETCH_TIMEOUT_MS = 20_000;
const BROWSER_LAUNCH_TIMEOUT_MS = 60_000;
const NAVIGATION_TIMEOUT_MS = 60_000;
const PAGE_MEASUREMENT_TIMEOUT_MS =
  POINTCLOUD_DRACO_TIMEDYNAMIC_CONFIG.readinessBudgetMs + 30_000;
const SERVED_ENTRY_TIMEOUT_MS = 10_000;
const SESSION_CLOSE_TIMEOUT_MS = 15_000;
const BROWSER_CLOSE_TIMEOUT_MS = 30_000;
const SETUP_OPERATIONS_PER_BACKEND = 3;
const SETUP_TIMEOUT_MS = 10_000;
const NAVIGATION_OPERATIONS_PER_BACKEND = 2;
const DIAGNOSTIC_OPERATIONS_PER_BACKEND = 2;
const DIAGNOSTIC_TIMEOUT_MS = 10_000;
const SESSION_CLOSE_OPERATIONS_PER_BACKEND = 2;
const BROWSER_CLOSE_OPERATIONS = 2;
const WORST_CASE_RUN_MS =
  RENDERERS.length *
    (SETUP_OPERATIONS_PER_BACKEND * SETUP_TIMEOUT_MS +
      NAVIGATION_OPERATIONS_PER_BACKEND * NAVIGATION_TIMEOUT_MS +
      PAGE_MEASUREMENT_TIMEOUT_MS +
      SERVED_ENTRY_TIMEOUT_MS +
      DIAGNOSTIC_OPERATIONS_PER_BACKEND * DIAGNOSTIC_TIMEOUT_MS +
      SESSION_CLOSE_OPERATIONS_PER_BACKEND * SESSION_CLOSE_TIMEOUT_MS) +
  BROWSER_CLOSE_OPERATIONS * BROWSER_CLOSE_TIMEOUT_MS;
// Both backends run serially, so the enclosing watchdog must preserve every
// inner deadline plus enough time to begin orderly cleanup.
const RUN_WATCHDOG_MS = WORST_CASE_RUN_MS + 30_000;
// The hard fuse stays armed while orderly cleanup and immutable publication run.
const PROCESS_WATCHDOG_MS =
  DECODER_FETCH_TIMEOUT_MS +
  BROWSER_LAUNCH_TIMEOUT_MS +
  RUN_WATCHDOG_MS +
  BROWSER_CLOSE_TIMEOUT_MS +
  60_000;
const WORST_CASE_PROCESS_MS =
  DECODER_FETCH_TIMEOUT_MS + BROWSER_LAUNCH_TIMEOUT_MS + WORST_CASE_RUN_MS;
export const POINTCLOUD_DRACO_TIMEDYNAMIC_BUDGET = Object.freeze({
  backendCount: RENDERERS.length,
  decoderFetchTimeoutMs: DECODER_FETCH_TIMEOUT_MS,
  browserLaunchTimeoutMs: BROWSER_LAUNCH_TIMEOUT_MS,
  setupOperationsPerBackend: SETUP_OPERATIONS_PER_BACKEND,
  setupTimeoutMs: SETUP_TIMEOUT_MS,
  navigationOperationsPerBackend: NAVIGATION_OPERATIONS_PER_BACKEND,
  navigationTimeoutMs: NAVIGATION_TIMEOUT_MS,
  pageMeasurementTimeoutMs: PAGE_MEASUREMENT_TIMEOUT_MS,
  servedEntryTimeoutMs: SERVED_ENTRY_TIMEOUT_MS,
  diagnosticOperationsPerBackend: DIAGNOSTIC_OPERATIONS_PER_BACKEND,
  diagnosticTimeoutMs: DIAGNOSTIC_TIMEOUT_MS,
  sessionCloseOperationsPerBackend: SESSION_CLOSE_OPERATIONS_PER_BACKEND,
  sessionCloseTimeoutMs: SESSION_CLOSE_TIMEOUT_MS,
  browserCloseOperations: BROWSER_CLOSE_OPERATIONS,
  browserCloseTimeoutMs: BROWSER_CLOSE_TIMEOUT_MS,
  worstCaseRunMs: WORST_CASE_RUN_MS,
  runWatchdogMs: RUN_WATCHDOG_MS,
  worstCaseProcessMs: WORST_CASE_PROCESS_MS,
  processWatchdogMs: PROCESS_WATCHDOG_MS,
});

if (WORST_CASE_PROCESS_MS >= PROCESS_WATCHDOG_MS) {
  throw new Error("point-cloud Draco budgets exceed the process watchdog");
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const stableJson = (value) => `${JSON.stringify(value, null, 2)}\n`;

function serializeError(value) {
  const error = value instanceof Error ? value : new Error(String(value));
  return {
    name: error.name,
    message: error.message,
    stack: error.stack ?? null,
    watchdog: error.pointcloudDracoWatchdog ?? null,
  };
}

function validateLoopbackBase(value) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("--base must be an uncredentialed loopback HTTP URL");
  }
  return { href: url.href, origin: url.origin };
}

function markerCount(source, marker) {
  let count = 0;
  let cursor = 0;
  while ((cursor = source.indexOf(marker, cursor)) >= 0) {
    count++;
    cursor += marker.length;
  }
  return count;
}

export function inspectPointcloudDracoCaptureContract(source) {
  const canonicalFailures = checkEmbeddedFusedSnapshotIsCanonical(source);
  const usageFailures = checkFusedCaptureUsage(source);
  const beginCount = markerCount(source, FUSED_SNAPSHOT_BEGIN);
  const endCount = markerCount(source, FUSED_SNAPSHOT_END);
  return {
    canonical: canonicalFailures.length === 0,
    singleBlock: beginCount === 1 && endCount === 1,
    usageValid: usageFailures.length === 0,
    beginCount,
    endCount,
    canonicalSourceSha256: sha256(
      Buffer.from(FUSED_SNAPSHOT_CAPTURE_SOURCE, "utf8"),
    ),
    failures: [
      ...canonicalFailures,
      ...usageFailures,
      ...(beginCount === 1 && endCount === 1
        ? []
        : [
            `fused snapshot markers must occur exactly once (BEGIN=${beginCount}, END=${endCount})`,
          ]),
    ],
  };
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isFiniteNonNegative(value) {
  return Number.isFinite(value) && value >= 0;
}

function foldEvaluation(harnessErrors, structural, failures, derived = {}) {
  const status =
    harnessErrors.length > 0
      ? "ERROR"
      : structural.length > 0
        ? "STRUCTURAL"
        : failures.length > 0
          ? "FAIL"
          : "PASS";
  return {
    status,
    exitCode: exitCodeForS5Status(status),
    harnessErrors,
    structural,
    failures,
    derived,
  };
}

export function servedDecoderStructuralReasons(
  decoder,
  config = POINTCLOUD_DRACO_TIMEDYNAMIC_CONFIG,
) {
  const reasons = [];
  if (!decoder || typeof decoder !== "object") {
    return ["decoder:served-response-missing"];
  }
  if (decoder.status !== 200) {
    reasons.push(`decoder:served-status-${String(decoder.status)}`);
  }
  if (decoder.redirected !== false) {
    reasons.push("decoder:served-response-redirected");
  }
  if (
    !isNonNegativeInteger(decoder.bodyBytes) ||
    decoder.bodyBytes <= config.decoderMinimumBytes
  ) {
    reasons.push("decoder:served-body-not-nontrivial");
  }
  if (decoder.magicHex !== config.decoderMagicHex) {
    reasons.push("decoder:served-body-not-wasm");
  }
  if (decoder.persisted !== true) {
    reasons.push("decoder:served-body-not-persisted");
  }
  if (!/^[0-9a-f]{64}$/u.test(decoder.sha256 ?? "")) {
    reasons.push("decoder:served-body-hash-invalid");
  }
  return reasons;
}

export function servedFixtureStructuralReasons(fixtureResponses) {
  if (!Array.isArray(fixtureResponses) || fixtureResponses.length === 0) {
    return ["fixtures:served-responses-missing"];
  }
  const reasons = [];
  for (let index = 0; index < fixtureResponses.length; index++) {
    const response = fixtureResponses[index];
    let pathname;
    try {
      pathname = new URL(response?.url, "http://localhost").pathname;
    } catch {
      reasons.push(`fixtures:response-${index}-url-invalid`);
      continue;
    }
    if (!pathname.endsWith(".pnts")) {
      reasons.push(`fixtures:response-${index}-not-pnts`);
      continue;
    }
    if (response?.status !== 200) {
      reasons.push(
        `${response?.renderer ?? `response-${index}`}:fixture-status-${String(response?.status)}:${pathname}`,
      );
    }
  }
  return reasons;
}

function servedEntryIdentityStructuralReasons(identity) {
  const reasons = Array.isArray(identity?.reasons)
    ? identity.reasons.filter(Boolean).map(String)
    : [];
  if (identity?.ok === true && reasons.length === 0) {
    return [];
  }
  return reasons.length > 0
    ? reasons.map((reason) => `build-entry:${reason}`)
    : ["build-entry:served-identity-unproven"];
}

function validatePixels(summary, backend, structural, failures, config) {
  if (!summary || typeof summary !== "object") {
    structural.push(`${backend}:pixels:summary-missing`);
    return;
  }
  const expectedPixels = config.width * config.height;
  if (
    summary.width !== config.width ||
    summary.height !== config.height ||
    summary.totalPixels !== expectedPixels ||
    !isNonNegativeInteger(summary.nonBackgroundPixels) ||
    summary.nonBackgroundPixels > expectedPixels ||
    !Array.isArray(summary.channelSums) ||
    summary.channelSums.length !== 3 ||
    !summary.channelSums.every(
      (sum) =>
        isFiniteNonNegative(sum) && sum <= summary.nonBackgroundPixels * 255,
    )
  ) {
    structural.push(`${backend}:pixels:counters-invalid`);
    return;
  }
  if (summary.nonBackgroundPixels === 0) {
    failures.push(`${backend}:pixels:no-rendered-content`);
  }
}

function validateRuntime(runtime, backend, structural, failures, config) {
  if (!runtime || typeof runtime !== "object") {
    structural.push(`${backend}:runtime:missing`);
    return;
  }
  if (runtime.rendererType !== backend) {
    structural.push(`${backend}:runtime:backend-identity-unproven`);
  }
  if (runtime.intervalCount !== 5 || runtime.fixtureUriCount !== 5) {
    structural.push(`${backend}:runtime:interval-topology-invalid`);
  }
  if (backend === "webgpu") {
    if (
      !isNonNegativeInteger(runtime.gpuGateArmedDevices) ||
      runtime.gpuGateArmedDevices === 0
    ) {
      structural.push("webgpu:runtime:error-gate-unarmed");
    }
  }

  const shapeValid =
    Number.isInteger(runtime.readyRenderIteration) &&
    runtime.readyRenderIteration >= -1 &&
    Number.isInteger(runtime.readyIntervalIndex) &&
    runtime.readyIntervalIndex >= -1 &&
    Number.isInteger(runtime.readySceneFrameNumber) &&
    runtime.readySceneFrameNumber >= -1 &&
    isNonNegativeInteger(runtime.readinessRenderCount) &&
    isFiniteNonNegative(runtime.readinessElapsedMs) &&
    runtime.readinessBudgetMs === config.readinessBudgetMs &&
    isFiniteNonNegative(runtime.boundingSphereRadius) &&
    isFiniteNonNegative(runtime.totalMemoryUsageInBytes) &&
    isNonNegativeInteger(runtime.requestedFrameCount) &&
    isNonNegativeInteger(runtime.readyFrameCount) &&
    isNonNegativeInteger(runtime.frameFailedCount);
  if (!shapeValid) {
    structural.push(`${backend}:runtime:readiness-counters-invalid`);
    return;
  }

  const reachedInsideBudget =
    runtime.readyRenderIteration >= 0 &&
    runtime.readyIntervalIndex >= 0 &&
    runtime.readyIntervalIndex < 5 &&
    runtime.readySceneFrameNumber >= 0 &&
    runtime.readinessElapsedMs <= runtime.readinessBudgetMs &&
    runtime.boundingSphereRadius > 0 &&
    runtime.totalMemoryUsageInBytes > 0 &&
    runtime.readyFrameCount > 0;
  if (!reachedInsideBudget) {
    failures.push(
      `${backend}:runtime:readiness-timeout:${runtime.readinessElapsedMs}/${runtime.readinessBudgetMs}ms`,
    );
  }
  if (runtime.frameFailedCount > 0) {
    failures.push(`${backend}:runtime:frame-load-failures`);
  }
}

function validateParity(parity, structural, failures, config) {
  if (!parity || typeof parity !== "object") {
    structural.push("parity:counters-missing");
    return {};
  }
  const countersValid =
    isNonNegativeInteger(parity.comparedCells) &&
    isNonNegativeInteger(parity.rawMismatchedCells) &&
    isNonNegativeInteger(parity.normalizedMismatchedCells) &&
    parity.rawMismatchedCells <= parity.comparedCells &&
    parity.normalizedMismatchedCells <= parity.comparedCells &&
    Array.isArray(parity.channelGains) &&
    parity.channelGains.length === 3 &&
    parity.channelGains.every(isFiniteNonNegative) &&
    Array.isArray(parity.webglChannelMeans) &&
    parity.webglChannelMeans.length === 3 &&
    parity.webglChannelMeans.every(isFiniteNonNegative) &&
    Array.isArray(parity.webgpuChannelMeans) &&
    parity.webgpuChannelMeans.length === 3 &&
    parity.webgpuChannelMeans.every(isFiniteNonNegative);
  if (!countersValid) {
    structural.push("parity:counters-invalid");
    return {};
  }
  if (parity.comparedCells === 0) {
    failures.push("parity:no-lit-cells");
    return {
      rawMismatchFraction: null,
      normalizedMismatchFraction: null,
    };
  }
  const rawMismatchFraction = parity.rawMismatchedCells / parity.comparedCells;
  const normalizedMismatchFraction =
    parity.normalizedMismatchedCells / parity.comparedCells;
  if (normalizedMismatchFraction >= config.maximumNormalizedMismatchFraction) {
    failures.push("parity:normalized-mismatch-over-limit");
  }
  return { rawMismatchFraction, normalizedMismatchFraction };
}

/**
 * Fold only persisted counters. A bounded readiness miss is a product FAIL;
 * absence of the served decoder is a prerequisite STRUCTURAL result.
 */
export function evaluatePointcloudDracoTimedynamic(input) {
  const harnessErrors = Array.isArray(input?.harnessErrors)
    ? input.harnessErrors.filter(Boolean).map(String)
    : ["input:harness-errors-invalid"];
  const structural = [];
  const failures = [];
  if (input?.schema !== POINTCLOUD_DRACO_TIMEDYNAMIC_SCHEMA) {
    structural.push("input:schema-invalid");
  }
  if (input?.captureContract?.canonical !== true) {
    structural.push("capture:canonical-source-unproven");
  }
  if (input?.captureContract?.singleBlock !== true) {
    structural.push("capture:marker-cardinality-unproven");
  }
  if (input?.captureContract?.usageValid !== true) {
    structural.push("capture:usage-unproven");
  }
  if (input?.captureContract?.writeOnce !== true) {
    structural.push("evidence:write-once-unproven");
  }
  if (input?.cleanup?.complete !== true) {
    harnessErrors.push("cleanup:incomplete");
  }

  const config = POINTCLOUD_DRACO_TIMEDYNAMIC_CONFIG;
  const decoderStructural = servedDecoderStructuralReasons(
    input?.decoder,
    config,
  );
  structural.push(...decoderStructural);
  // A missing decoder is established before a browser leg is scored. Requiring
  // backend counters here would turn that known prerequisite miss into noise.
  if (structural.length > 0) {
    return foldEvaluation(harnessErrors, structural, failures);
  }

  structural.push(
    ...servedEntryIdentityStructuralReasons(input?.servedEntryIdentity),
    ...servedFixtureStructuralReasons(input?.fixtureResponses),
  );
  // Provenance and fixture transport are prerequisites; product counters cannot
  // score bytes that differ from disk or a point fixture that never arrived.
  if (structural.length > 0) {
    return foldEvaluation(harnessErrors, structural, failures);
  }

  validateRuntime(input?.webgl?.runtime, "webgl", structural, failures, config);
  validateRuntime(
    input?.webgpu?.runtime,
    "webgpu",
    structural,
    failures,
    config,
  );
  validatePixels(input?.webgl?.pixels, "webgl", structural, failures, config);
  validatePixels(input?.webgpu?.pixels, "webgpu", structural, failures, config);
  const derived = validateParity(input?.parity, structural, failures, config);
  return foldEvaluation(harnessErrors, structural, failures, derived);
}

function downsampleRgba(image, factor) {
  const width = Math.floor(image.width / factor);
  const height = Math.floor(image.height / factor);
  const data = new Float64Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sums = [0, 0, 0];
      for (let offsetY = 0; offsetY < factor; offsetY++) {
        for (let offsetX = 0; offsetX < factor; offsetX++) {
          const source =
            ((y * factor + offsetY) * image.width + x * factor + offsetX) * 4;
          sums[0] += image.data[source];
          sums[1] += image.data[source + 1];
          sums[2] += image.data[source + 2];
        }
      }
      const destination = (y * width + x) * 3;
      const samples = factor * factor;
      data[destination] = sums[0] / samples;
      data[destination + 1] = sums[1] / samples;
      data[destination + 2] = sums[2] / samples;
    }
  }
  return { width, height, data };
}

function summarizeFullResolution(image, config) {
  let nonBackgroundPixels = 0;
  const channelSums = [0, 0, 0];
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const sum =
      image.data[offset] + image.data[offset + 1] + image.data[offset + 2];
    if (sum > config.foregroundRgbSum) {
      nonBackgroundPixels++;
      channelSums[0] += image.data[offset];
      channelSums[1] += image.data[offset + 1];
      channelSums[2] += image.data[offset + 2];
    }
  }
  return {
    width: image.width,
    height: image.height,
    totalPixels: image.width * image.height,
    nonBackgroundPixels,
    channelSums,
    channelMeans: channelSums.map((sum) =>
      nonBackgroundPixels > 0 ? sum / nonBackgroundPixels : 0,
    ),
  };
}

/** Derive the raw numerators and denominators used by the parity decision. */
export function summarizePointcloudDracoParity(
  webglImage,
  webgpuImage,
  config = POINTCLOUD_DRACO_TIMEDYNAMIC_CONFIG,
) {
  for (const [name, image] of [
    ["webgl", webglImage],
    ["webgpu", webgpuImage],
  ]) {
    if (
      !image ||
      image.width !== config.width ||
      image.height !== config.height ||
      !image.data ||
      image.data.length !== config.width * config.height * 4
    ) {
      throw new Error(`${name} persisted capture has invalid RGBA dimensions`);
    }
  }

  const webgl = summarizeFullResolution(webglImage, config);
  const webgpu = summarizeFullResolution(webgpuImage, config);
  const reducedWebgl = downsampleRgba(webglImage, config.downsampleFactor);
  const reducedWebgpu = downsampleRgba(webgpuImage, config.downsampleFactor);
  let comparedCells = 0;
  let rawMismatchedCells = 0;
  const webglSums = [0, 0, 0];
  const webgpuSums = [0, 0, 0];
  const comparedOffsets = [];
  for (let offset = 0; offset < reducedWebgl.data.length; offset += 3) {
    const webglLight =
      reducedWebgl.data[offset] +
      reducedWebgl.data[offset + 1] +
      reducedWebgl.data[offset + 2];
    const webgpuLight =
      reducedWebgpu.data[offset] +
      reducedWebgpu.data[offset + 1] +
      reducedWebgpu.data[offset + 2];
    if (
      webglLight <= config.foregroundRgbSum &&
      webgpuLight <= config.foregroundRgbSum
    ) {
      continue;
    }
    comparedCells++;
    comparedOffsets.push(offset);
    for (let channel = 0; channel < 3; channel++) {
      webglSums[channel] += reducedWebgl.data[offset + channel];
      webgpuSums[channel] += reducedWebgpu.data[offset + channel];
    }
    if (
      [0, 1, 2].some(
        (channel) =>
          Math.abs(
            reducedWebgl.data[offset + channel] -
              reducedWebgpu.data[offset + channel],
          ) > config.channelDifference,
      )
    ) {
      rawMismatchedCells++;
    }
  }
  const channelGains = [0, 1, 2].map((channel) =>
    webgpuSums[channel] > 1e-9 ? webglSums[channel] / webgpuSums[channel] : 1,
  );
  let normalizedMismatchedCells = 0;
  for (const offset of comparedOffsets) {
    if (
      [0, 1, 2].some(
        (channel) =>
          Math.abs(
            reducedWebgl.data[offset + channel] -
              reducedWebgpu.data[offset + channel] * channelGains[channel],
          ) > config.channelDifference,
      )
    ) {
      normalizedMismatchedCells++;
    }
  }
  const webglChannelMeans = webglSums.map((sum) =>
    comparedCells > 0 ? sum / comparedCells : 0,
  );
  const webgpuChannelMeans = webgpuSums.map((sum) =>
    comparedCells > 0 ? sum / comparedCells : 0,
  );
  return {
    webgl,
    webgpu,
    parity: {
      comparedCells,
      rawMismatchedCells,
      normalizedMismatchedCells,
      rawMismatchFraction:
        comparedCells > 0 ? rawMismatchedCells / comparedCells : null,
      normalizedMismatchFraction:
        comparedCells > 0 ? normalizedMismatchedCells / comparedCells : null,
      channelGains,
      webglChannelMeans,
      webgpuChannelMeans,
    },
  };
}

function readExact(file, expected, label, operations = fs) {
  const actual = operations.readFileSync(file);
  const bytes = Buffer.isBuffer(actual) ? actual : Buffer.from(actual);
  if (!bytes.equals(Buffer.from(expected))) {
    throw new Error(`${label} bytes differ from the run-owned canonical bytes`);
  }
  return bytes;
}

function writeOnceExact(file, bytes, label, operations = fs) {
  const canonical = Buffer.from(bytes);
  try {
    operations.writeFileSync(file, canonical, { flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    readExact(file, canonical, label, operations);
  }
  readExact(file, canonical, label, operations);
  return readExact(file, canonical, label, operations);
}

function createRunPaths(runId, outputRoot = defaultOutputRoot) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      runId,
    )
  ) {
    throw new Error("runId must be a UUID v4");
  }
  const root = path.resolve(outputRoot);
  const directory = path.join(root, runId);
  if (path.dirname(directory) !== root) {
    throw new Error("run directory escaped the configured output root");
  }
  return {
    root,
    directory,
    artifact: path.join(directory, `${runId}.json`),
    decoder: path.join(directory, "served-draco-decoder-response.bin"),
  };
}

function prepareRunDirectory(paths, operations = fs) {
  operations.mkdirSync(paths.root, { recursive: true });
  operations.mkdirSync(paths.directory, { recursive: false });
}

function pngBytes(dataUrl, label) {
  const prefix = "data:image/png;base64,";
  if (typeof dataUrl !== "string" || !dataUrl.startsWith(prefix)) {
    throw new Error(`${label} is not a PNG data URL`);
  }
  const encoded = dataUrl.slice(prefix.length);
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) {
    throw new Error(`${label} is not canonical base64`);
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (
    bytes.length <= signature.length ||
    !bytes.subarray(0, signature.length).equals(signature)
  ) {
    throw new Error(`${label} did not decode to a complete PNG`);
  }
  return bytes;
}

async function decodePngRgba(bytes, label) {
  let decoded;
  try {
    decoded = await sharp(bytes, {
      failOn: "error",
      limitInputPixels:
        POINTCLOUD_DRACO_TIMEDYNAMIC_CONFIG.width *
        POINTCLOUD_DRACO_TIMEDYNAMIC_CONFIG.height,
    })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch (error) {
    throw new Error(
      `${label} persisted PNG decode failed: ${error?.message ?? error}`,
      { cause: error },
    );
  }
  const { data, info } = decoded;
  if (
    info.width !== POINTCLOUD_DRACO_TIMEDYNAMIC_CONFIG.width ||
    info.height !== POINTCLOUD_DRACO_TIMEDYNAMIC_CONFIG.height ||
    info.channels !== 4 ||
    data.length !== info.width * info.height * 4
  ) {
    throw new Error(`${label} persisted PNG has unexpected dimensions`);
  }
  return {
    width: info.width,
    height: info.height,
    data: new Uint8ClampedArray(data),
  };
}

async function fetchServedDecoder(base, paths, operations = fs) {
  const requestedUrl = new URL(
    "/Build/CesiumUnminified/ThirdParty/draco_decoder.wasm",
    base.origin,
  ).href;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DECODER_FETCH_TIMEOUT_MS);
  let response;
  let bytes;
  try {
    response = await fetch(requestedUrl, {
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
    });
    bytes = Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
  const reread = writeOnceExact(
    paths.decoder,
    bytes,
    "served decoder response",
    operations,
  );
  return {
    requestedUrl,
    responseUrl: response.url,
    status: response.status,
    statusText: response.statusText,
    redirected: response.redirected,
    contentType: response.headers.get("content-type"),
    contentLengthHeader: response.headers.get("content-length"),
    bodyBytes: reread.length,
    magicHex: reread.subarray(0, 4).toString("hex"),
    file: path.basename(paths.decoder),
    persisted: true,
    sha256: sha256(reread),
  };
}

async function persistCaptureImages(paths, sessions, operations = fs) {
  const records = {};
  const decoded = {};
  for (const session of sessions) {
    const backend = session.renderer;
    const bytes = pngBytes(
      session.measurement?.captureDataUrl,
      `${backend} capture`,
    );
    const file = path.join(paths.directory, `${backend}.png`);
    if (path.dirname(file) !== paths.directory) {
      throw new Error(`${backend} capture escaped the run directory`);
    }
    const reread = writeOnceExact(
      file,
      bytes,
      `${backend} capture`,
      operations,
    );
    records[backend] = {
      file: path.basename(file),
      bytes: reread.length,
      sha256: sha256(reread),
      rgbaRederived: false,
    };
    decoded[backend] = await decodePngRgba(reread, `${backend} capture`);
    records[backend].rgbaRederived = true;
  }
  return { records, decoded };
}

async function boundedOperation(operation, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs} ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function closeBounded(instance, label, timeoutMs) {
  if (!instance) {
    return { label, attempted: false, closed: true, timedOut: false };
  }
  let timer;
  try {
    return {
      label,
      attempted: true,
      ...(await Promise.race([
        Promise.resolve()
          .then(() => instance.close())
          .then(
            () => ({ closed: true, timedOut: false }),
            (error) => ({
              closed: false,
              timedOut: false,
              error: serializeError(error),
            }),
          ),
        new Promise((resolve) => {
          timer = setTimeout(
            () => resolve({ closed: false, timedOut: true }),
            timeoutMs,
          );
        }),
      ])),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function boundedPageCheckpoint(owned, timeoutMs = 2_000) {
  const page = owned.page;
  if (!page || page.isClosed()) {
    return { phase: owned.phase, pageAvailable: false };
  }
  let timer;
  try {
    return await Promise.race([
      page
        .evaluate(() => ({
          phase: window.__pointcloudDracoProgress?.phase ?? "unknown",
          renderer: window.__pointcloudDracoProgress?.renderer ?? null,
          frameNumber: window.viewer?.scene?.frameState?.frameNumber ?? null,
        }))
        .then(
          (checkpoint) => ({ ...checkpoint, pageAvailable: true }),
          (error) => ({
            phase: owned.phase,
            pageAvailable: true,
            error: serializeError(error),
          }),
        ),
      new Promise((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              phase: owned.phase,
              pageAvailable: true,
              timedOut: true,
            }),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function cleanupOwned(owned) {
  const page = owned.page;
  const context = owned.context;
  const browser = owned.browser;
  const pageClose = await closeBounded(
    page,
    "watchdog page",
    SESSION_CLOSE_TIMEOUT_MS,
  );
  const contextClose = await closeBounded(
    context,
    "watchdog context",
    SESSION_CLOSE_TIMEOUT_MS,
  );
  const browserClose = await closeBounded(
    browser,
    "watchdog browser",
    BROWSER_CLOSE_TIMEOUT_MS,
  );
  if (pageClose.closed && owned.page === page) owned.page = undefined;
  if (contextClose.closed && owned.context === context) {
    owned.context = undefined;
  }
  if (browserClose.closed && owned.browser === browser) {
    owned.browser = undefined;
  }
  const pendingRequests = owned.pending?.size ?? 0;
  return {
    pageClose,
    contextClose,
    browserClose,
    pendingRequests,
    cleanupComplete:
      pageClose.closed &&
      contextClose.closed &&
      browserClose.closed &&
      pendingRequests === 0,
  };
}

export async function withPointcloudDracoWatchdog(
  operation,
  onTimeout,
  timeoutMs = RUN_WATCHDOG_MS,
) {
  let timer;
  let timingOut = false;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(operation)
        .then(
          (value) => (timingOut ? new Promise(() => {}) : value),
          (error) =>
            timingOut ? new Promise(() => {}) : Promise.reject(error),
        ),
      new Promise((_, reject) => {
        timer = setTimeout(async () => {
          timingOut = true;
          let timeoutEvidence;
          try {
            timeoutEvidence = await onTimeout();
          } catch (cleanupError) {
            const aggregate = new AggregateError(
              [
                new Error(
                  `point-cloud Draco watchdog expired after ${timeoutMs} ms`,
                ),
                cleanupError,
              ],
              "point-cloud Draco watchdog cleanup failed",
            );
            aggregate.pointcloudDracoWatchdog = {
              timeoutMs,
              cleanupComplete: false,
            };
            reject(aggregate);
            return;
          }
          const error = new Error(
            timeoutEvidence?.cleanupComplete
              ? `point-cloud Draco watchdog expired after ${timeoutMs} ms`
              : `point-cloud Draco watchdog expired after ${timeoutMs} ms and cleanup remained unproven`,
          );
          error.pointcloudDracoWatchdog = { timeoutMs, ...timeoutEvidence };
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function runBackend(browser, renderer, base, owned) {
  const session = {
    renderer,
    measurement: null,
    servedEntries: [],
    cleanup: null,
  };
  let context;
  let page;
  const pending = new Set();
  const externalRequests = [];
  const fixtureResponses = [];
  const servedEntryTasks = [];
  try {
    owned.phase = `${renderer}:context`;
    context = await boundedOperation(
      browser.newContext({
        viewport: {
          width: POINTCLOUD_DRACO_TIMEDYNAMIC_CONFIG.width,
          height: POINTCLOUD_DRACO_TIMEDYNAMIC_CONFIG.height,
        },
        deviceScaleFactor: 1,
      }),
      SETUP_TIMEOUT_MS,
      `${renderer} browser context creation`,
    );
    owned.context = context;
    page = await boundedOperation(
      context.newPage(),
      SETUP_TIMEOUT_MS,
      `${renderer} page creation`,
    );
    owned.page = page;
    owned.pending = pending;
    await boundedOperation(
      page.addInitScript(errorGateInit),
      SETUP_TIMEOUT_MS,
      `${renderer} error-gate installation`,
    );
    const consoleErrors = attachConsoleErrorGate(page);

    page.on("request", (request) => {
      pending.add(request);
      const url = request.url();
      try {
        const parsed = new URL(url);
        if (
          parsed.origin !== base.origin &&
          parsed.protocol !== "data:" &&
          parsed.protocol !== "blob:"
        ) {
          externalRequests.push(url);
        }
      } catch {
        externalRequests.push(url);
      }
    });
    page.on("response", (response) => {
      const url = response.url();
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        return;
      }
      if (
        parsed.pathname.includes("/PointCloudTimeDynamicDraco/") &&
        parsed.pathname.endsWith(".pnts")
      ) {
        fixtureResponses.push({ renderer, url, status: response.status() });
      }
      if (
        parsed.origin === base.origin &&
        parsed.pathname === BUILD_ENTRY_ROUTE
      ) {
        const status = response.status();
        servedEntryTasks.push(
          response.body().then(
            (bytes) => ({
              sessionLabel: renderer,
              ok: response.ok(),
              status,
              byteLength: bytes.byteLength,
              sha256: sha256(bytes),
            }),
            (error) => ({
              sessionLabel: renderer,
              ok: false,
              status,
              byteLength: null,
              sha256: null,
              error: serializeError(error),
            }),
          ),
        );
      }
    });
    page.on("requestfinished", (request) => pending.delete(request));
    page.on("requestfailed", (request) => pending.delete(request));

    owned.phase = `${renderer}:navigate`;
    await page.goto(
      `${base.href.replace(/\/$/u, "")}/Apps/CesiumViewer/index.html?renderer=${renderer}&offline=true`,
      { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS },
    );
    await page.waitForFunction(() => Boolean(window.viewer), null, {
      timeout: NAVIGATION_TIMEOUT_MS,
    });
    const armResult = await boundedOperation(
      renderer === "webgpu"
        ? armWebGPUDevices(page)
        : { armed: 0, found: 0, total: 0 },
      DIAGNOSTIC_TIMEOUT_MS,
      `${renderer} WebGPU error-gate arming`,
    );

    owned.phase = `${renderer}:measure`;
    const acquirePageMeasurement = async ({
      renderer,
      dates,
      uris,
      config,
    }) => {
      window.__pointcloudDracoProgress = { renderer, phase: "setup" };
      const C = await import("/Build/CesiumUnminified/index.js");
      const viewer = window.viewer;
      viewer.useDefaultRenderLoop = false;
      const scene = viewer.scene;
      scene.requestRenderMode = false;
      scene.skyBox.show = false;
      scene.skyAtmosphere.show = false;
      scene.sun.show = false;
      scene.moon.show = false;
      scene.fog.enabled = false;
      scene.backgroundColor = C.Color.BLACK;
      scene.globe.show = false;

      const intervals = C.TimeIntervalCollection.fromIso8601DateArray({
        iso8601Dates: dates,
        dataCallback: (_interval, index) => ({ uri: uris[index] }),
      });
      const captureTime = C.JulianDate.fromIso8601(dates[0]);
      viewer.clock.startTime = captureTime.clone();
      viewer.clock.currentTime = captureTime.clone();
      viewer.clock.stopTime = C.JulianDate.fromIso8601(dates.at(-1));
      viewer.clock.clockRange = C.ClockRange.LOOP_STOP;
      viewer.clock.multiplier = 0;
      viewer.clock.canAnimate = true;
      viewer.clock.shouldAnimate = false;

      const pointCloud = new C.TimeDynamicPointCloud({
        intervals,
        clock: viewer.clock,
        style: new C.Cesium3DTileStyle({ pointSize: 8 }),
        shading: { attenuation: false, eyeDomeLighting: false },
      });
      scene.primitives.add(pointCloud);
      const frameFailures = [];
      pointCloud.frameFailed.addEventListener((failure) => {
        frameFailures.push({
          uri: failure?.uri ?? null,
          message: failure?.message ?? "unknown frame failure",
        });
      });

      const fixtureSphere = new C.BoundingSphere(
        new C.Cartesian3(
          1215012.8828876738,
          -4736313.051199594,
          4081605.22126042,
        ),
        4.1,
      );
      viewer.camera.viewBoundingSphere(
        fixtureSphere,
        new C.HeadingPitchRange(0.3, -0.25, fixtureSphere.radius * 4.0),
      );
      viewer.camera.lookAtTransform(C.Matrix4.IDENTITY);
      const renderNow = () => {
        scene.requestRender();
        scene.render(captureTime);
      };

      window.__pointcloudDracoProgress.phase = "readiness";
      const readinessStart = performance.now();
      let readinessRenderCount = 0;
      let readyRenderIteration = -1;
      let readyIntervalIndex = -1;
      let readySceneFrameNumber = -1;
      let readyElapsedMs = null;
      while (
        performance.now() - readinessStart < config.readinessBudgetMs &&
        readinessRenderCount < config.maximumReadinessRenders
      ) {
        renderNow();
        const renderIteration = readinessRenderCount++;
        await new Promise((resolve) => setTimeout(resolve, 16));
        const frame = pointCloud._lastRenderedFrame;
        const intervalIndex = pointCloud._frames.indexOf(frame);
        const sphere = pointCloud.boundingSphere;
        const elapsed = performance.now() - readinessStart;
        if (
          elapsed <= config.readinessBudgetMs &&
          intervalIndex >= 0 &&
          frame?.ready === true &&
          frame.pointCloud?.ready === true &&
          sphere &&
          Number.isFinite(sphere.radius) &&
          sphere.radius > 0 &&
          pointCloud.totalMemoryUsageInBytes > 0
        ) {
          readyRenderIteration = renderIteration;
          readyIntervalIndex = intervalIndex;
          readySceneFrameNumber = scene.frameState.frameNumber;
          readyElapsedMs = elapsed;
          break;
        }
      }
      const readinessElapsedMs = Math.round(
        readyElapsedMs ?? performance.now() - readinessStart,
      );

      if (readyRenderIteration >= 0) {
        window.__pointcloudDracoProgress.phase = "settle";
        for (let index = 0; index < 8; index++) {
          renderNow();
          await new Promise((resolve) => setTimeout(resolve, 16));
        }
      }

      // ==BEGIN fused-snapshot-capture==
      const makeFusedSnapshotCapture = (scene, canvas, timeFn) => {
        const tmp = document.createElement("canvas");
        const ctx = tmp.getContext("2d", { willReadFrequently: true });
        const decode = async (dataUrl) => {
          const image = new Image();
          const loaded = new Promise((resolve, reject) => {
            image.onload = resolve;
            image.onerror = () => reject(new Error("fused PNG decode failed"));
          });
          image.src = dataUrl;
          await loaded;
          tmp.width = image.naturalWidth;
          tmp.height = image.naturalHeight;
          ctx.drawImage(image, 0, 0);
          return ctx.getImageData(0, 0, tmp.width, tmp.height);
        };
        const captureSnapshot = async () => {
          scene.render(timeFn());
          const dataUrl = canvas.toDataURL("image/png");
          const imageData = await decode(dataUrl);
          return { dataUrl, imageData };
        };
        return { captureSnapshot };
      };
      // ==END fused-snapshot-capture==

      window.__pointcloudDracoProgress.phase = "capture";
      const { captureSnapshot } = makeFusedSnapshotCapture(
        scene,
        scene.canvas,
        () => captureTime,
      );
      const snapshot = await captureSnapshot();
      const frames = pointCloud._frames.map((frame, index) => ({
        index,
        requested: Boolean(frame),
        ready: frame?.ready === true,
        pointCloudReady: frame?.pointCloud?.ready === true,
        uri: frame?.uri ?? uris[index],
      }));
      const sphere = pointCloud.boundingSphere;
      window.__pointcloudDracoProgress.phase = "measurement-complete";
      return {
        captureDataUrl: snapshot.dataUrl,
        runtime: {
          rendererType: String(scene.context?.rendererType ?? "").toLowerCase(),
          intervalCount: intervals.length,
          fixtureUriCount: uris.length,
          readinessBudgetMs: config.readinessBudgetMs,
          readinessElapsedMs,
          readinessRenderCount,
          readyRenderIteration,
          readyIntervalIndex,
          readySceneFrameNumber,
          boundingSphereRadius:
            sphere && Number.isFinite(sphere.radius) ? sphere.radius : 0,
          totalMemoryUsageInBytes: pointCloud.totalMemoryUsageInBytes,
          requestedFrameCount: frames.filter((frame) => frame.requested).length,
          readyFrameCount: frames.filter((frame) => frame.ready).length,
          frameFailedCount: frameFailures.length,
          frameNumberAtCapture: scene.frameState.frameNumber,
          frames,
          frameFailures,
        },
      };
    };
    const measurement = await boundedOperation(
      page.evaluate(acquirePageMeasurement, {
        renderer,
        dates: FRAME_DATES,
        uris: FRAME_URLS,
        config: POINTCLOUD_DRACO_TIMEDYNAMIC_CONFIG,
      }),
      PAGE_MEASUREMENT_TIMEOUT_MS,
      `${renderer} point-cloud measurement`,
    );
    session.servedEntries = await boundedOperation(
      Promise.all(servedEntryTasks),
      SERVED_ENTRY_TIMEOUT_MS,
      `${renderer} served build-entry identity`,
    );

    owned.phase = `${renderer}:diagnostics`;
    const gpuGate = await boundedOperation(
      renderer === "webgpu"
        ? collectGateErrors(page)
        : { errors: [], deviceLost: null, armedDevices: 0 },
      DIAGNOSTIC_TIMEOUT_MS,
      `${renderer} GPU diagnostics collection`,
    );
    measurement.runtime.gpuGateArmedDevices = gpuGate.armedDevices;
    measurement.harnessErrors = [
      ...consoleErrors,
      ...gpuGate.errors,
      ...(gpuGate.deviceLost ? [gpuGate.deviceLost] : []),
      ...externalRequests.map(
        (url) => `non-loopback request escaped offline scene: ${url}`,
      ),
    ];
    measurement.diagnostics = {
      armResult,
      gpuGate,
      externalRequests: [...new Set(externalRequests)].sort(),
      fixtureResponses,
      pendingRequestsBeforeClose: pending.size,
    };
    session.measurement = measurement;
    return session;
  } finally {
    owned.phase = `${renderer}:cleanup`;
    const pageClose = await closeBounded(
      page,
      `${renderer} page`,
      SESSION_CLOSE_TIMEOUT_MS,
    );
    const contextClose = await closeBounded(
      context,
      `${renderer} context`,
      SESSION_CLOSE_TIMEOUT_MS,
    );
    if (pageClose.closed && owned.page === page) owned.page = undefined;
    if (contextClose.closed && owned.context === context) {
      owned.context = undefined;
    }
    const pendingRequests = pending.size;
    session.cleanup = {
      pageClose,
      contextClose,
      pendingRequests,
      complete:
        pageClose.closed && contextClose.closed && pendingRequests === 0,
    };
  }
}

async function acquireBothBackends(browser, options, owned) {
  const result = { sessions: [], cleanup: { complete: false } };
  try {
    for (const renderer of RENDERERS) {
      result.sessions.push(
        await runBackend(browser, renderer, options.base, owned),
      );
    }
    return result;
  } finally {
    owned.phase = "browser-cleanup";
    const browserClose = await closeBounded(
      browser,
      "fleet browser",
      BROWSER_CLOSE_TIMEOUT_MS,
    );
    if (browserClose.closed && owned.browser === browser) {
      owned.browser = undefined;
    }
    let lastResortClose = {
      attempted: false,
      closed: browserClose.closed,
    };
    // The direct close is the source-contract anchor and remains protected by
    // the terminating fuse if the browser ignores the bounded close result.
    if (!browserClose.closed && owned.browser === browser) {
      try {
        await boundedOperation(
          browser.close(),
          BROWSER_CLOSE_TIMEOUT_MS,
          "last-resort fleet browser close",
        );
        lastResortClose = { attempted: true, closed: true };
        owned.browser = undefined;
      } catch (error) {
        lastResortClose = {
          attempted: true,
          closed: false,
          error: serializeError(error),
        };
      }
    }
    result.cleanup = {
      browserClose,
      lastResortClose,
      sessions: result.sessions.map((session) => session.cleanup),
      complete:
        browserClose.closed &&
        result.sessions.length === RENDERERS.length &&
        result.sessions.every((session) => session.cleanup?.complete === true),
    };
  }
}

function artifactWithStatus(status, fields) {
  return {
    schema: POINTCLOUD_DRACO_TIMEDYNAMIC_SCHEMA,
    ...fields,
    status,
    exitCode: exitCodeForS5Status(status),
  };
}

const unmeasured = Object.freeze([
  "Only the first interval is held for the parity capture; interval transitions, eviction, and playback cadence are not scored.",
  "The feature-scale parity fold normalizes global channel gain; the raw gains and mismatch counters are reported but absolute tint is scored by the repeat-tint gate.",
  "Decoder provisioning proves the browser build resource served for this run, not the presence of an ignored source-tree file.",
]);

export async function runPointcloudDracoTimedynamicProbe(options = {}) {
  const operations = options.operations ?? fs;
  const runId = options.runId ?? randomUUID();
  const paths = createRunPaths(runId, options.outputRoot);
  prepareRunDirectory(paths, operations);
  const startedAt = new Date().toISOString();
  const source = operations.readFileSync(probeSourcePath, "utf8");
  const capturePreflight = inspectPointcloudDracoCaptureContract(source);
  const localEntry = fingerprintEvidenceFile(buildEntryPath, operations);
  const owned = {
    browser: undefined,
    context: undefined,
    page: undefined,
    pending: new Set(),
    phase: "preflight",
  };
  let artifact;
  let decoder;
  let servedEntryIdentity = null;
  let imageRecords = {};
  let quiescent = true;
  try {
    owned.phase = "decoder-precondition";
    decoder = await fetchServedDecoder(options.base, paths, operations);
    const decoderStructural = servedDecoderStructuralReasons(decoder);
    if (capturePreflight.failures.length > 0 || decoderStructural.length > 0) {
      const evaluation = evaluatePointcloudDracoTimedynamic({
        schema: POINTCLOUD_DRACO_TIMEDYNAMIC_SCHEMA,
        captureContract: { ...capturePreflight, writeOnce: true },
        decoder,
        cleanup: { complete: true },
        harnessErrors: [],
      });
      artifact = artifactWithStatus(evaluation.status, {
        runId,
        startedAt,
        completedAt: new Date().toISOString(),
        captureContract: { ...capturePreflight, writeOnce: true },
        decoder,
        provenance: { localEntry, servedEntryIdentity },
        evaluation,
        images: {},
        sessions: [],
        cleanup: { complete: true },
        unmeasured,
      });
    } else {
      owned.phase = "browser-launch";
      const browser = await chromium.launch({
        channel: "msedge",
        headless: !options.headed,
        args: ["--enable-unsafe-webgpu"],
        timeout: BROWSER_LAUNCH_TIMEOUT_MS,
      });
      owned.browser = browser;
      quiescent = false;
      const acquisition = await withPointcloudDracoWatchdog(
        () => acquireBothBackends(browser, options, owned),
        async () => {
          const checkpoint = await boundedPageCheckpoint(owned);
          const cleanup = await cleanupOwned(owned);
          return { checkpoint, ...cleanup };
        },
        options.watchdogMs ?? RUN_WATCHDOG_MS,
      );
      quiescent =
        acquisition.cleanup.complete === true &&
        !owned.browser &&
        !owned.context &&
        !owned.page &&
        (owned.pending?.size ?? 0) === 0;
      const byRenderer = Object.fromEntries(
        acquisition.sessions.map((session) => [session.renderer, session]),
      );
      const harnessErrors = acquisition.sessions.flatMap((session) =>
        (session.measurement?.harnessErrors ?? []).map(
          (reason) => `${session.renderer}:${reason}`,
        ),
      );
      const fixtureResponses = acquisition.sessions.flatMap(
        (session) => session.measurement?.diagnostics?.fixtureResponses ?? [],
      );
      servedEntryIdentity = validateServedEntryIdentities({
        entries: acquisition.sessions.flatMap(
          (session) => session.servedEntries,
        ),
        expectedLabels: RENDERERS,
        localEntry,
      });
      const baseEvaluationInput = {
        schema: POINTCLOUD_DRACO_TIMEDYNAMIC_SCHEMA,
        captureContract: { ...capturePreflight, writeOnce: true },
        decoder,
        cleanup: acquisition.cleanup,
        harnessErrors,
        fixtureResponses,
        servedEntryIdentity,
      };
      const sessions = acquisition.sessions.map((session) => ({
        renderer: session.renderer,
        runtime: session.measurement.runtime,
        diagnostics: session.measurement.diagnostics,
        servedEntries: session.servedEntries,
        cleanup: session.cleanup,
      }));
      const fixtureStructural =
        servedFixtureStructuralReasons(fixtureResponses);
      if (!servedEntryIdentity.ok || fixtureStructural.length > 0) {
        const evaluation =
          evaluatePointcloudDracoTimedynamic(baseEvaluationInput);
        artifact = artifactWithStatus(evaluation.status, {
          runId,
          startedAt,
          completedAt: new Date().toISOString(),
          captureContract: { ...capturePreflight, writeOnce: true },
          decoder,
          provenance: { localEntry, servedEntryIdentity },
          evaluation,
          images: {},
          sessions,
          cleanup: acquisition.cleanup,
          unmeasured,
        });
      } else {
        const persisted = await persistCaptureImages(
          paths,
          acquisition.sessions,
          operations,
        );
        imageRecords = persisted.records;
        const pixelSummary = summarizePointcloudDracoParity(
          persisted.decoded.webgl,
          persisted.decoded.webgpu,
        );
        const evaluation = evaluatePointcloudDracoTimedynamic({
          ...baseEvaluationInput,
          webgl: {
            runtime: byRenderer.webgl?.measurement?.runtime,
            pixels: pixelSummary.webgl,
          },
          webgpu: {
            runtime: byRenderer.webgpu?.measurement?.runtime,
            pixels: pixelSummary.webgpu,
          },
          parity: pixelSummary.parity,
        });
        artifact = artifactWithStatus(evaluation.status, {
          runId,
          startedAt,
          completedAt: new Date().toISOString(),
          captureContract: { ...capturePreflight, writeOnce: true },
          decoder,
          provenance: { localEntry, servedEntryIdentity },
          evaluation,
          images: imageRecords,
          pixels: {
            webgl: pixelSummary.webgl,
            webgpu: pixelSummary.webgpu,
            parity: pixelSummary.parity,
          },
          sessions,
          cleanup: acquisition.cleanup,
          unmeasured,
        });
      }
    }
  } catch (error) {
    let terminalCleanup;
    let terminalCleanupError;
    try {
      terminalCleanup = await cleanupOwned(owned);
      quiescent =
        terminalCleanup.cleanupComplete === true &&
        !owned.browser &&
        !owned.context &&
        !owned.page;
    } catch (cleanupError) {
      quiescent = false;
      terminalCleanupError = serializeError(cleanupError);
    }
    artifact = artifactWithStatus("ERROR", {
      runId,
      startedAt,
      completedAt: new Date().toISOString(),
      captureContract: { ...capturePreflight, writeOnce: true },
      decoder: decoder ?? null,
      provenance: { localEntry, servedEntryIdentity },
      evaluation: null,
      images: imageRecords,
      sessions: [],
      cleanup: terminalCleanup ?? { complete: false },
      harnessErrors: [
        serializeError(error),
        ...(terminalCleanupError ? [terminalCleanupError] : []),
      ],
      unmeasured,
    });
  }

  const artifactBytes = Buffer.from(stableJson(artifact));
  const reread = writeOnceExact(
    paths.artifact,
    artifactBytes,
    "final evidence",
    operations,
  );
  return {
    artifact,
    quiescent,
    publication: {
      file: paths.artifact,
      bytes: reread.length,
      sha256: sha256(reread),
    },
  };
}

function usage() {
  console.log(
    "Usage: node Tools/visual-regression/probe-pointcloud-draco-timedynamic.mjs " +
      "[--base URL] [--output-directory DIR] [--headed]\n\n" +
      "Requires an already-running loopback server and a current Build/CesiumUnminified build.",
  );
}

function parseArguments(argv) {
  const parsed = {
    base: validateLoopbackBase(defaultBase),
    outputRoot: defaultOutputRoot,
    headed: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const nextValue = () => {
      const value = argv[++index];
      if (!value) throw new Error(`${argument} requires a value`);
      return value;
    };
    if (argument === "--base") {
      parsed.base = validateLoopbackBase(nextValue());
    } else if (argument === "--output-directory") {
      parsed.outputRoot = path.resolve(nextValue());
    } else if (argument === "--headed") {
      parsed.headed = true;
    } else if (argument === "--help") {
      usage();
      process.exit(exitCodeForS5Status("PASS"));
    } else {
      throw new Error(`unknown argument ${argument}`);
    }
  }
  return parsed;
}

async function main() {
  // The orderly watchdog rejects only when the event loop returns. This fuse
  // is the final authority over a wedged browser, cleanup, or publication.
  const processWatchdog = setTimeout(() => {
    console.error(
      `[pointcloud-draco-timedynamic] process watchdog fired after ${PROCESS_WATCHDOG_MS} ms`,
    );
    process.exit(exitCodeForS5Status("ERROR"));
  }, PROCESS_WATCHDOG_MS);
  processWatchdog.unref?.();
  let quiescent = false;
  try {
    const result = await runPointcloudDracoTimedynamicProbe(
      parseArguments(process.argv.slice(2)),
    );
    quiescent = result.quiescent === true;
    console.log(
      JSON.stringify(
        {
          status: result.artifact.status,
          exitCode: result.artifact.exitCode,
          runId: result.artifact.runId,
          decoder: result.artifact.decoder,
          readiness: result.artifact.sessions?.map((session) => ({
            renderer: session.renderer,
            intervalIndex: session.runtime.readyIntervalIndex,
            renderIteration: session.runtime.readyRenderIteration,
            elapsedMs: session.runtime.readinessElapsedMs,
            budgetMs: session.runtime.readinessBudgetMs,
            nonBackgroundPixels:
              result.artifact.pixels?.[session.renderer]?.nonBackgroundPixels ??
              null,
          })),
          evidence: result.publication,
        },
        null,
        2,
      ),
    );
    process.exitCode = exitCodeForS5Status(result.artifact.status);
  } catch (error) {
    console.error(
      "[pointcloud-draco-timedynamic] uncaught probe failure",
      error,
    );
    process.exitCode = exitCodeForS5Status("ERROR");
  } finally {
    if (quiescent) clearTimeout(processWatchdog);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
