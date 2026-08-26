#!/usr/bin/env node
/**
 * Point-cloud color-format and translucency parity probe.
 * @purpose Proves that the dedicated point-cloud renderer decodes RGB, RGBA, RGB565, and constant color at cross-backend parity while preserving source alpha.
 * @status ACTIVE
 *
 * The browser lane acquires immutable PNGs only. All verdict arithmetic runs
 * in Node after every PNG has been exclusively written, reread, hashed, and
 * decoded from the reread bytes. Each negative control substitutes one parsed
 * color descriptor before backend realization, then freshly captures all four
 * formats so collateral effects are observable rather than inferred.
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

const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(toolDirectory, "../..");
const probeSourcePath = fileURLToPath(import.meta.url);
const buildEntryPath = path.join(
  repositoryRoot,
  "Build/CesiumUnminified/index.js",
);
const runtimeEntryPath = "/Build/CesiumUnminified/index.js";
const defaultBase = process.env.PROBE_BASE ?? "http://localhost:8080";
const defaultOutputRoot = path.resolve(
  process.env.POINTCLOUD_COLOR_OUTPUT_DIR ??
    path.join(toolDirectory, "output/pointcloud-color-formats"),
);

const VIEWPORT = Object.freeze({ width: 600, height: 600 });
const BACKEND_COUNT = 2;
const NAVIGATION_STAGES_PER_BACKEND = 2;
const SESSION_CLOSE_STAGES_PER_BACKEND = 2;
const BROWSER_CLOSE_STAGES = 2;
const WEBGPU_ARM_OPERATIONS = 1;
const DIAGNOSTICS_OPERATIONS = 1;
const BACKEND_SESSION_SETUP_TIMEOUT_MS = 30_000;
const NAVIGATION_TIMEOUT_MS = 60_000;
const READINESS_TIMEOUT_MS = 30_000;
const COLOR_LEG_TIMEOUT_MS = 45_000;
const PAGE_MEASUREMENT_SETUP_TIMEOUT_MS = 30_000;
const WEBGPU_ARM_TIMEOUT_MS = 15_000;
const DIAGNOSTICS_TIMEOUT_MS = 15_000;
const SERVED_ENTRY_TIMEOUT_MS = 15_000;
const RUN_WATCHDOG_MS = 1_740_000;
const BROWSER_LAUNCH_TIMEOUT_MS = 60_000;
const SESSION_CLOSE_TIMEOUT_MS = 15_000;
const BROWSER_CLOSE_TIMEOUT_MS = 30_000;
const PROCESS_WATCHDOG_MS =
  BROWSER_LAUNCH_TIMEOUT_MS +
  RUN_WATCHDOG_MS +
  BROWSER_CLOSE_TIMEOUT_MS +
  60_000;

export const POINTCLOUD_COLOR_GATE_LIMITS = Object.freeze({
  mismatchFraction: 0.16,
  mismatchDownsampleFactor: 4,
  mismatchChannelTolerance: 40,
  gainMinimum: 0.97,
  gainMaximum: 1.03,
  coverageFractionDelta: 0.1,
  minimumAlphaDependentFraction: 0.15,
  minimumMeanTransmission: 0.05,
  alphaFractionDelta: 0.15,
  alphaTransmissionDelta: 0.05,
});

export const POINTCLOUD_COLOR_FORMATS = Object.freeze([
  Object.freeze({
    id: "rgb",
    label: "RGB",
    uri: "/Specs/Data/Cesium3DTiles/PointCloud/PointCloudRGB/pointCloudRGB.pnts",
    translucent: false,
  }),
  Object.freeze({
    id: "rgba",
    label: "RGBA",
    uri: "/Specs/Data/Cesium3DTiles/PointCloud/PointCloudRGBA/pointCloudRGBA.pnts",
    translucent: true,
  }),
  Object.freeze({
    id: "rgb565",
    label: "RGB565",
    uri: "/Specs/Data/Cesium3DTiles/PointCloud/PointCloudRGB565/pointCloudRGB565.pnts",
    translucent: false,
  }),
  Object.freeze({
    id: "constant",
    label: "CONSTANT_RGBA",
    uri: "/Specs/Data/Cesium3DTiles/PointCloud/PointCloudConstantColor/pointCloudConstantColor.pnts",
    translucent: true,
  }),
]);

const formatCount = POINTCLOUD_COLOR_FORMATS.length;
const positiveLegCount = BACKEND_COUNT * formatCount;
const controlLegCount = formatCount * formatCount;
const totalLegCount = positiveLegCount + controlLegCount;
const webglLegCount = formatCount;
const webgpuLegCount = formatCount + controlLegCount;
const pageMeasurementTimeoutMs = Object.freeze({
  webgl:
    PAGE_MEASUREMENT_SETUP_TIMEOUT_MS + webglLegCount * COLOR_LEG_TIMEOUT_MS,
  webgpu:
    PAGE_MEASUREMENT_SETUP_TIMEOUT_MS + webgpuLegCount * COLOR_LEG_TIMEOUT_MS,
});
const worstCaseRunMs =
  BACKEND_COUNT * BACKEND_SESSION_SETUP_TIMEOUT_MS +
  BACKEND_COUNT * NAVIGATION_STAGES_PER_BACKEND * NAVIGATION_TIMEOUT_MS +
  pageMeasurementTimeoutMs.webgl +
  pageMeasurementTimeoutMs.webgpu +
  WEBGPU_ARM_OPERATIONS * WEBGPU_ARM_TIMEOUT_MS +
  DIAGNOSTICS_OPERATIONS * DIAGNOSTICS_TIMEOUT_MS +
  BACKEND_COUNT * SERVED_ENTRY_TIMEOUT_MS +
  BACKEND_COUNT * SESSION_CLOSE_STAGES_PER_BACKEND * SESSION_CLOSE_TIMEOUT_MS +
  BROWSER_CLOSE_STAGES * BROWSER_CLOSE_TIMEOUT_MS;
const worstCaseProcessMs = BROWSER_LAUNCH_TIMEOUT_MS + worstCaseRunMs;

export const POINTCLOUD_COLOR_PROBE_BUDGETS = Object.freeze({
  backendCount: BACKEND_COUNT,
  navigationStagesPerBackend: NAVIGATION_STAGES_PER_BACKEND,
  sessionCloseStagesPerBackend: SESSION_CLOSE_STAGES_PER_BACKEND,
  browserCloseStages: BROWSER_CLOSE_STAGES,
  webgpuArmOperations: WEBGPU_ARM_OPERATIONS,
  diagnosticsOperations: DIAGNOSTICS_OPERATIONS,
  formatCount,
  positiveLegCount,
  controlLegCount,
  totalLegCount,
  webglLegCount,
  webgpuLegCount,
  browserLaunchTimeoutMs: BROWSER_LAUNCH_TIMEOUT_MS,
  backendSessionSetupTimeoutMs: BACKEND_SESSION_SETUP_TIMEOUT_MS,
  navigationTimeoutMs: NAVIGATION_TIMEOUT_MS,
  readinessTimeoutMs: READINESS_TIMEOUT_MS,
  colorLegTimeoutMs: COLOR_LEG_TIMEOUT_MS,
  pageMeasurementSetupTimeoutMs: PAGE_MEASUREMENT_SETUP_TIMEOUT_MS,
  pageMeasurementTimeoutMs,
  webgpuArmTimeoutMs: WEBGPU_ARM_TIMEOUT_MS,
  diagnosticsTimeoutMs: DIAGNOSTICS_TIMEOUT_MS,
  servedEntryTimeoutMs: SERVED_ENTRY_TIMEOUT_MS,
  sessionCloseTimeoutMs: SESSION_CLOSE_TIMEOUT_MS,
  browserCloseTimeoutMs: BROWSER_CLOSE_TIMEOUT_MS,
  worstCaseRunMs,
  runWatchdogMs: RUN_WATCHDOG_MS,
  worstCaseProcessMs,
  processWatchdogMs: PROCESS_WATCHDOG_MS,
});

if (worstCaseRunMs >= RUN_WATCHDOG_MS) {
  throw new Error("point-cloud color inner budgets exceed the run watchdog");
}
if (worstCaseProcessMs >= PROCESS_WATCHDOG_MS) {
  throw new Error("point-cloud color budgets exceed the process watchdog");
}

const FORMAT_IDS = Object.freeze(POINTCLOUD_COLOR_FORMATS.map(({ id }) => id));
const TRANSLUCENT_IDS = new Set(
  POINTCLOUD_COLOR_FORMATS.filter(({ translucent }) => translucent).map(
    ({ id }) => id,
  ),
);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const stableJson = (value) => `${JSON.stringify(value, null, 2)}\n`;

function serializeError(value) {
  const error = value instanceof Error ? value : new Error(String(value));
  return {
    name: error.name,
    message: error.message,
    stack: error.stack ?? null,
    watchdog: error.pointCloudColorWatchdog ?? null,
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

export function inspectPointCloudColorCaptureContract(source) {
  const canonicalFailures = checkEmbeddedFusedSnapshotIsCanonical(source);
  const usageFailures = checkFusedCaptureUsage(source);
  const beginCount = markerCount(source, FUSED_SNAPSHOT_BEGIN);
  const endCount = markerCount(source, FUSED_SNAPSHOT_END);
  const singleBlock = beginCount === 1 && endCount === 1;
  return {
    canonical: canonicalFailures.length === 0,
    canonicalSourceBytes: Buffer.byteLength(
      FUSED_SNAPSHOT_CAPTURE_SOURCE,
      "utf8",
    ),
    singleBlock,
    usageValid: usageFailures.length === 0,
    beginCount,
    endCount,
    failures: [
      ...canonicalFailures,
      ...usageFailures,
      ...(singleBlock
        ? []
        : [
            `fused snapshot markers must occur exactly once (BEGIN=${beginCount}, END=${endCount})`,
          ]),
    ],
  };
}

function isFiniteNonNegative(value) {
  return Number.isFinite(value) && value >= 0;
}

function deriveFrameCounter(counter, label, structural) {
  if (
    !counter ||
    !Number.isInteger(counter.nonBackgroundPixelCount) ||
    counter.nonBackgroundPixelCount < 0 ||
    !Number.isInteger(counter.channelSampleCount) ||
    counter.channelSampleCount < 0 ||
    !Array.isArray(counter.channelSums) ||
    counter.channelSums.length !== 3 ||
    !counter.channelSums.every(
      (sum) =>
        isFiniteNonNegative(sum) && sum <= counter.channelSampleCount * 255,
    )
  ) {
    structural.push(`${label} frame counters are absent or malformed`);
    return null;
  }
  if (counter.channelSampleCount !== counter.nonBackgroundPixelCount) {
    structural.push(
      `${label} channel sample count does not equal its non-background pixel count`,
    );
    return null;
  }
  const divisor = counter.channelSampleCount;
  return {
    ...counter,
    channelMeans:
      divisor > 0
        ? counter.channelSums.map((sum) => sum / divisor)
        : [null, null, null],
  };
}

function deriveMismatchCounter(counter, label, structural) {
  if (
    !counter ||
    !Number.isInteger(counter.mismatchedCellCount) ||
    counter.mismatchedCellCount < 0 ||
    !Number.isInteger(counter.comparedCellCount) ||
    counter.comparedCellCount < 0 ||
    counter.mismatchedCellCount > counter.comparedCellCount
  ) {
    structural.push(`${label} mismatch counters are absent or malformed`);
    return null;
  }
  return {
    ...counter,
    mismatchFraction:
      counter.comparedCellCount > 0
        ? counter.mismatchedCellCount / counter.comparedCellCount
        : null,
  };
}

function deriveAlphaCounter(counter, label, structural) {
  if (
    !counter ||
    !Number.isInteger(counter.visiblePixelCount) ||
    counter.visiblePixelCount < 0 ||
    !Number.isInteger(counter.alphaDependentPixelCount) ||
    counter.alphaDependentPixelCount < 0 ||
    counter.alphaDependentPixelCount > counter.visiblePixelCount ||
    !isFiniteNonNegative(counter.transmissionSum) ||
    counter.transmissionSum > counter.visiblePixelCount
  ) {
    structural.push(`${label} alpha counters are absent or malformed`);
    return null;
  }
  return {
    ...counter,
    alphaDependentFraction:
      counter.visiblePixelCount > 0
        ? counter.alphaDependentPixelCount / counter.visiblePixelCount
        : null,
    meanTransmission:
      counter.visiblePixelCount > 0
        ? counter.transmissionSum / counter.visiblePixelCount
        : null,
  };
}

function deriveRuntimeCounter(counter, label, structural) {
  if (
    !counter ||
    typeof counter.ready !== "boolean" ||
    !Number.isInteger(counter.readyIteration) ||
    counter.readyIteration < -1 ||
    !Number.isInteger(counter.renderIterations) ||
    counter.renderIterations < 1 ||
    !isFiniteNonNegative(counter.waitedMs) ||
    !Number.isInteger(counter.pointsLength) ||
    counter.pointsLength < 0 ||
    typeof counter.featureRendererPresent !== "boolean"
  ) {
    structural.push(`${label} runtime counters are absent or malformed`);
    return null;
  }
  return counter;
}

function foldStatuses(statuses) {
  if (statuses.includes("ERROR")) return "ERROR";
  if (statuses.includes("FAIL")) return "FAIL";
  if (statuses.includes("STRUCTURAL")) return "STRUCTURAL";
  return "PASS";
}

function evaluateColorLeg(id, input) {
  const structural = [];
  const failures = [];
  const webgl = deriveFrameCounter(input?.webgl, `${id}/webgl`, structural);
  const webgpu = deriveFrameCounter(input?.webgpu, `${id}/webgpu`, structural);
  const mismatch = deriveMismatchCounter(
    input?.mismatch,
    `${id}/cross-backend`,
    structural,
  );
  let webglAlpha = null;
  let webgpuAlpha = null;
  const webglRuntime = deriveRuntimeCounter(
    input?.runtime?.webgl,
    `${id}/webgl`,
    structural,
  );
  const webgpuRuntime = deriveRuntimeCounter(
    input?.runtime?.webgpu,
    `${id}/webgpu`,
    structural,
  );

  if (TRANSLUCENT_IDS.has(id)) {
    webglAlpha = deriveAlphaCounter(
      input?.alpha?.webgl,
      `${id}/webgl`,
      structural,
    );
    webgpuAlpha = deriveAlphaCounter(
      input?.alpha?.webgpu,
      `${id}/webgpu`,
      structural,
    );
  }

  if (structural.length === 0) {
    if (webgl.nonBackgroundPixelCount === 0) {
      structural.push(`${id} WebGL reference contains no point-cloud pixels`);
    }
    if (!webglRuntime.ready || webglRuntime.pointsLength !== 1000) {
      structural.push(
        `${id} WebGL reference did not ready the expected 1000-point fixture`,
      );
    }
    if (mismatch.comparedCellCount === 0) {
      structural.push(`${id} has no lit pixels over which to compare formats`);
    }
    if (TRANSLUCENT_IDS.has(id) && webglAlpha.visiblePixelCount === 0) {
      structural.push(`${id} WebGL reference exposes no alpha-bearing pixels`);
    }
  }

  const gains = [null, null, null];
  if (structural.length === 0) {
    if (webgpu.nonBackgroundPixelCount === 0) {
      failures.push(`${id} WebGPU rendered zero point-cloud pixels`);
    }
    if (!webgpuRuntime.ready || webgpuRuntime.pointsLength !== 1000) {
      failures.push(
        `${id} WebGPU did not ready the expected 1000-point fixture`,
      );
    }
    if (!webgpuRuntime.featureRendererPresent) {
      failures.push(
        `${id} WebGPU did not realize the dedicated point-cloud feature renderer`,
      );
    }
    const referenceCoverage = webgl.nonBackgroundPixelCount;
    const coverageDelta =
      referenceCoverage > 0
        ? Math.abs(webgpu.nonBackgroundPixelCount - referenceCoverage) /
          referenceCoverage
        : Number.POSITIVE_INFINITY;
    if (coverageDelta > POINTCLOUD_COLOR_GATE_LIMITS.coverageFractionDelta) {
      failures.push(
        `${id} cross-backend non-background coverage delta ${coverageDelta} exceeds ${POINTCLOUD_COLOR_GATE_LIMITS.coverageFractionDelta}`,
      );
    }
    if (
      mismatch.mismatchFraction === null ||
      mismatch.mismatchFraction > POINTCLOUD_COLOR_GATE_LIMITS.mismatchFraction
    ) {
      failures.push(
        `${id} mismatch fraction ${String(mismatch.mismatchFraction)} exceeds ${POINTCLOUD_COLOR_GATE_LIMITS.mismatchFraction}`,
      );
    }
    for (let channel = 0; channel < 3; channel++) {
      const denominator = webgpu.channelMeans[channel];
      gains[channel] =
        Number.isFinite(denominator) && denominator > 0
          ? webgl.channelMeans[channel] / denominator
          : null;
      if (
        gains[channel] === null ||
        gains[channel] < POINTCLOUD_COLOR_GATE_LIMITS.gainMinimum ||
        gains[channel] > POINTCLOUD_COLOR_GATE_LIMITS.gainMaximum
      ) {
        failures.push(
          `${id} channel ${channel} gain ${String(gains[channel])} is outside [${POINTCLOUD_COLOR_GATE_LIMITS.gainMinimum}, ${POINTCLOUD_COLOR_GATE_LIMITS.gainMaximum}]`,
        );
      }
    }

    if (TRANSLUCENT_IDS.has(id)) {
      if (webgpuAlpha.visiblePixelCount === 0) {
        failures.push(`${id} WebGPU exposes no alpha-bearing pixels`);
      }
      if (webgpuAlpha.alphaDependentPixelCount === 0) {
        failures.push(`${id} WebGPU has no background-responsive pixels`);
      }
      for (const [backend, alpha] of [
        ["webgl", webglAlpha],
        ["webgpu", webgpuAlpha],
      ]) {
        if (
          alpha.alphaDependentFraction <
          POINTCLOUD_COLOR_GATE_LIMITS.minimumAlphaDependentFraction
        ) {
          failures.push(
            `${id} ${backend} alpha-dependent pixel fraction ${alpha.alphaDependentFraction} is below ${POINTCLOUD_COLOR_GATE_LIMITS.minimumAlphaDependentFraction}`,
          );
        }
        if (
          alpha.meanTransmission <
          POINTCLOUD_COLOR_GATE_LIMITS.minimumMeanTransmission
        ) {
          failures.push(
            `${id} ${backend} mean background transmission ${alpha.meanTransmission} is below ${POINTCLOUD_COLOR_GATE_LIMITS.minimumMeanTransmission}`,
          );
        }
      }
      const fractionDelta = Math.abs(
        webglAlpha.alphaDependentFraction - webgpuAlpha.alphaDependentFraction,
      );
      const transmissionDelta = Math.abs(
        webglAlpha.meanTransmission - webgpuAlpha.meanTransmission,
      );
      if (
        !Number.isFinite(fractionDelta) ||
        fractionDelta > POINTCLOUD_COLOR_GATE_LIMITS.alphaFractionDelta
      ) {
        failures.push(
          `${id} alpha-dependent pixel fraction delta ${fractionDelta} exceeds ${POINTCLOUD_COLOR_GATE_LIMITS.alphaFractionDelta}`,
        );
      }
      if (
        !Number.isFinite(transmissionDelta) ||
        transmissionDelta > POINTCLOUD_COLOR_GATE_LIMITS.alphaTransmissionDelta
      ) {
        failures.push(
          `${id} background transmission delta ${transmissionDelta} exceeds ${POINTCLOUD_COLOR_GATE_LIMITS.alphaTransmissionDelta}`,
        );
      }
    }
  }

  const status =
    structural.length > 0
      ? "STRUCTURAL"
      : failures.length > 0
        ? "FAIL"
        : "PASS";
  return {
    status,
    structural,
    failures,
    counters: {
      webgl,
      webgpu,
      mismatch,
      gains,
      runtime: { webgl: webglRuntime, webgpu: webgpuRuntime },
      ...(TRANSLUCENT_IDS.has(id)
        ? { alpha: { webgl: webglAlpha, webgpu: webgpuAlpha } }
        : {}),
    },
  };
}

/**
 * Evaluate the browser-free color-format gate from raw counters.
 *
 * @param {object} input Raw capture, lifecycle, and error counters.
 * @returns {object} Status, exit tier, per-format folds, and raw reasons.
 */
export function scorePointCloudColorFormats(input) {
  const structural = [];
  const harnessErrors = Array.isArray(input?.harnessErrors)
    ? input.harnessErrors.filter((entry) => entry !== null && entry !== "")
    : ["harness error list is absent"];
  const captureContract = input?.captureContract;
  if (
    !captureContract?.canonical ||
    !captureContract?.singleBlock ||
    !captureContract?.usageValid ||
    !captureContract?.writeOnce
  ) {
    structural.push("canonical write-once capture contract is incomplete");
  }
  if (input?.cleanup?.complete !== true) {
    structural.push("browser lifecycle did not reach bounded quiescence");
  }
  if (
    input?.backend?.webglRendererType !== "webgl" ||
    input?.backend?.webgpuRendererType !== "webgpu" ||
    !Number.isInteger(input?.backend?.webgpuErrorGateArmedDevices) ||
    input.backend.webgpuErrorGateArmedDevices < 1
  ) {
    structural.push(
      "requested backend identity or WebGPU device-error instrumentation is absent",
    );
  }
  const legs = {};
  for (const id of FORMAT_IDS) {
    legs[id] = evaluateColorLeg(id, input?.legs?.[id]);
  }

  const legStatuses = Object.values(legs).map(({ status }) => status);
  let status;
  if (harnessErrors.length > 0) {
    status = "ERROR";
  } else if (structural.length > 0) {
    status = "STRUCTURAL";
  } else {
    status = foldStatuses(legStatuses);
  }
  return {
    status,
    exitCode: exitCodeForS5Status(status),
    structural: [
      ...structural,
      ...Object.entries(legs).flatMap(([id, leg]) =>
        leg.structural.map((reason) => `${id}:${reason}`),
      ),
    ],
    failures: Object.entries(legs).flatMap(([id, leg]) =>
      leg.failures.map((reason) => `${id}:${reason}`),
    ),
    harnessErrors,
    legs,
  };
}

/**
 * Structural reasons contributed by the LOCAL build-entry fingerprint.
 *
 * Kept as a pure function, not an inline spread, so the preflight half of the
 * provenance contract is reachable from Node. An inline spread is only ever
 * asserted by reading the source text, and source text cannot distinguish a
 * live reason from a dead one.
 *
 * @param {{ok?: boolean, reasons?: string[]}|null|undefined} validation Local identity.
 * @returns {string[]} Structural reasons, empty when the local entry is proven.
 */
export function pointCloudColorLocalEntryReasons(validation) {
  const reasons = Array.isArray(validation?.reasons)
    ? validation.reasons.filter(Boolean).map(String)
    : [];
  return validation?.ok === true && reasons.length === 0 ? [] : reasons;
}

/**
 * Structural reasons contributed by the SERVED build-entry identity.
 *
 * A served identity that is not `ok` but carries no reason would otherwise
 * produce a STRUCTURAL verdict that explains nothing, which is the narrated
 * failure this probe family exists to reject. That case gets an explicit reason.
 *
 * @param {{ok?: boolean, reasons?: string[]}|null|undefined} validation Served identity.
 * @returns {string[]} Structural reasons, empty when the served entry is proven.
 */
export function pointCloudColorServedEntryReasons(validation) {
  if (validation === null || validation === undefined) {
    return [];
  }
  const reasons = Array.isArray(validation.reasons)
    ? validation.reasons.filter(Boolean).map(String)
    : [];
  if (validation.ok === true && reasons.length === 0) {
    return [];
  }
  return reasons.length > 0 ? reasons : ["served-entry-identity-unproven"];
}

/**
 * Decide whether a colour run may proceed to capture and scoring.
 *
 * The whole routing decision — not just its inputs — is pure and exported, so
 * the browser-gate contract can execute it. Draco and tint already route their
 * provenance through their evaluators; this is the same seam for colour, which
 * previously made the decision inline in the runner where no Node gate reached
 * it.
 *
 * @param {object} input Provenance and capture-contract inputs.
 * @returns {{status: string, exitCode: number, structural: string[]}} The gate.
 */
export function evaluatePointCloudColorRunGate(input) {
  const structural = [
    ...(Array.isArray(input?.captureFailures) ? input.captureFailures : []),
    ...pointCloudColorLocalEntryReasons(input?.localEntryValidation),
    ...pointCloudColorServedEntryReasons(input?.servedEntryValidation),
  ];
  if (structural.length === 0) {
    return { status: "PROCEED", exitCode: 0, structural: [] };
  }
  const harnessErrors = Array.isArray(input?.harnessErrors)
    ? input.harnessErrors
    : [];
  const status = harnessErrors.length > 0 ? "ERROR" : "STRUCTURAL";
  return { status, exitCode: exitCodeForS5Status(status), structural };
}

/**
 * Require every decoder mutant to redden exactly its target format.
 *
 * @param {Record<string, object>} scenarios One full raw-counter input per target.
 * @returns {object} Whether all four controls are isolated and operative.
 */
export function scorePointCloudColorControls(scenarios) {
  const failures = [];
  const results = {};
  for (const target of FORMAT_IDS) {
    const scenario = scenarios?.[target];
    const evaluation = scorePointCloudColorFormats(scenario);
    const redLegs = FORMAT_IDS.filter(
      (id) => evaluation.legs[id].status === "FAIL",
    );
    const greenLegs = FORMAT_IDS.filter(
      (id) => evaluation.legs[id].status === "PASS",
    );
    const mutation = scenario?.controlMutation;
    const mutationValid =
      mutation?.target === target &&
      mutation?.preRealization === true &&
      Number.isInteger(mutation?.changedUnits) &&
      mutation.changedUnits > 0;
    const isolated =
      mutationValid &&
      evaluation.status === "FAIL" &&
      redLegs.length === 1 &&
      redLegs[0] === target &&
      greenLegs.length === FORMAT_IDS.length - 1;
    if (!isolated) {
      failures.push(
        `${target} control expected one pre-realization decoder substitution, red=[${target}], and three green legs; observed mutationValid=${mutationValid} status=${evaluation.status} red=[${redLegs.join(",")}] green=[${greenLegs.join(",")}]`,
      );
    }
    results[target] = {
      isolated,
      mutationValid,
      mutation,
      redLegs,
      greenLegs,
      evaluation,
    };
  }
  return { valid: failures.length === 0, failures, results };
}

function writeOnceAndReread(file, bytes, label, operations = fs) {
  const canonical = Buffer.from(bytes);
  operations.writeFileSync(file, canonical, { flag: "wx" });
  const reread = Buffer.from(operations.readFileSync(file));
  if (!reread.equals(canonical)) {
    throw new Error(`${label} bytes changed across exclusive publication`);
  }
  return { bytes: reread, sha256: sha256(reread) };
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
      limitInputPixels: VIEWPORT.width * VIEWPORT.height,
    })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch (error) {
    throw new Error(`${label} persisted PNG decode failed`, { cause: error });
  }
  const { data, info } = decoded;
  if (
    info.width !== VIEWPORT.width ||
    info.height !== VIEWPORT.height ||
    info.channels !== 4 ||
    data.length !== info.width * info.height * 4
  ) {
    throw new Error(`${label} persisted PNG is not the configured viewport`);
  }
  return {
    width: info.width,
    height: info.height,
    data: new Uint8ClampedArray(data),
  };
}

async function persistCaptureSessions(paths, sessions, operations = fs) {
  const records = {};
  const images = {};
  for (const session of sessions) {
    records[session.renderer] = {};
    images[session.renderer] = {};
    for (const [name, dataUrl] of Object.entries(
      session.measurement?.captures ?? {},
    )) {
      if (!/^[a-z][a-zA-Z0-9]+$/u.test(name)) {
        throw new Error(`unsafe capture name ${name}`);
      }
      const sourceBytes = pngBytes(dataUrl, `${session.renderer}/${name}`);
      const file = path.join(
        paths.directory,
        `${session.renderer}-${name}.png`,
      );
      if (path.dirname(file) !== paths.directory) {
        throw new Error(
          `${session.renderer}/${name} escaped the run directory`,
        );
      }
      const published = writeOnceAndReread(
        file,
        sourceBytes,
        `${session.renderer}/${name}`,
        operations,
      );
      images[session.renderer][name] = await decodePngRgba(
        published.bytes,
        `${session.renderer}/${name}`,
      );
      records[session.renderer][name] = {
        file: path.basename(file),
        bytes: published.bytes.length,
        sha256: published.sha256,
        rgbaRederivedFromReread: true,
      };
    }
  }
  return { records, images };
}

function frameCounter(image) {
  let nonBackgroundPixelCount = 0;
  const channelSums = [0, 0, 0];
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const red = image.data[offset];
    const green = image.data[offset + 1];
    const blue = image.data[offset + 2];
    if (red + green + blue <= 24) continue;
    nonBackgroundPixelCount++;
    channelSums[0] += red;
    channelSums[1] += green;
    channelSums[2] += blue;
  }
  return {
    nonBackgroundPixelCount,
    channelSampleCount: nonBackgroundPixelCount,
    channelSums,
  };
}

function downsampleRgb(image, factor) {
  const width = Math.floor(image.width / factor);
  const height = Math.floor(image.height / factor);
  const data = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sums = [0, 0, 0];
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const sourceOffset =
            ((y * factor + dy) * image.width + x * factor + dx) * 4;
          sums[0] += image.data[sourceOffset];
          sums[1] += image.data[sourceOffset + 1];
          sums[2] += image.data[sourceOffset + 2];
        }
      }
      const destinationOffset = (y * width + x) * 3;
      const divisor = factor * factor;
      data[destinationOffset] = sums[0] / divisor;
      data[destinationOffset + 1] = sums[1] / divisor;
      data[destinationOffset + 2] = sums[2] / divisor;
    }
  }
  return { width, height, data };
}

function mismatchCounter(webgl, webgpu) {
  if (webgl.width !== webgpu.width || webgl.height !== webgpu.height) {
    return null;
  }
  const factor = POINTCLOUD_COLOR_GATE_LIMITS.mismatchDownsampleFactor;
  const tolerance = POINTCLOUD_COLOR_GATE_LIMITS.mismatchChannelTolerance;
  const webglDs4 = downsampleRgb(webgl, factor);
  const webgpuDs4 = downsampleRgb(webgpu, factor);
  let mismatchedCellCount = 0;
  let comparedCellCount = 0;
  for (let offset = 0; offset < webglDs4.data.length; offset += 3) {
    const referenceLit =
      webglDs4.data[offset] +
        webglDs4.data[offset + 1] +
        webglDs4.data[offset + 2] >
      24;
    const candidateLit =
      webgpuDs4.data[offset] +
        webgpuDs4.data[offset + 1] +
        webgpuDs4.data[offset + 2] >
      24;
    if (!referenceLit && !candidateLit) continue;
    comparedCellCount++;
    if (
      Math.abs(webglDs4.data[offset] - webgpuDs4.data[offset]) > tolerance ||
      Math.abs(webglDs4.data[offset + 1] - webgpuDs4.data[offset + 1]) >
        tolerance ||
      Math.abs(webglDs4.data[offset + 2] - webgpuDs4.data[offset + 2]) >
        tolerance
    ) {
      mismatchedCellCount++;
    }
  }
  return {
    downsampleFactor: factor,
    channelTolerance: tolerance,
    mismatchedCellCount,
    comparedCellCount,
  };
}

function alphaCounter(black, white) {
  if (black.width !== white.width || black.height !== white.height) {
    return null;
  }
  let visiblePixelCount = 0;
  let alphaDependentPixelCount = 0;
  let transmissionSum = 0;
  for (let offset = 0; offset < black.data.length; offset += 4) {
    const blackEnergy =
      black.data[offset] + black.data[offset + 1] + black.data[offset + 2];
    const whiteDeficit =
      765 -
      (white.data[offset] + white.data[offset + 1] + white.data[offset + 2]);
    if (blackEnergy <= 24 && whiteDeficit <= 24) continue;
    visiblePixelCount++;
    const transmission = Math.max(
      0,
      Math.min(
        1,
        ((white.data[offset] - black.data[offset]) / 255 +
          (white.data[offset + 1] - black.data[offset + 1]) / 255 +
          (white.data[offset + 2] - black.data[offset + 2]) / 255) /
          3,
      ),
    );
    transmissionSum += transmission;
    if (transmission > 0.02 && transmission < 0.98) {
      alphaDependentPixelCount++;
    }
  }
  return { visiblePixelCount, alphaDependentPixelCount, transmissionSum };
}

function captureName(id, kind, background) {
  return `${id}${kind[0].toUpperCase()}${kind.slice(1)}${background[0].toUpperCase()}${background.slice(1)}`;
}

function buildLegCounters(images, runtimes, candidateKind = "positive") {
  const legs = {};
  for (const format of POINTCLOUD_COLOR_FORMATS) {
    const webglBlack =
      images.webgl[captureName(format.id, "positive", "black")];
    const webgpuBlack =
      images.webgpu[captureName(format.id, candidateKind, "black")];
    const leg = {
      webgl: frameCounter(webglBlack),
      webgpu: frameCounter(webgpuBlack),
      mismatch: mismatchCounter(webglBlack, webgpuBlack),
      runtime: {
        webgl: runtimes.webgl[`${format.id}:positive`],
        webgpu: runtimes.webgpu[`${format.id}:${candidateKind}`],
      },
    };
    if (format.translucent) {
      const webglWhite =
        images.webgl[captureName(format.id, "positive", "white")];
      const webgpuWhite =
        images.webgpu[captureName(format.id, candidateKind, "white")];
      leg.alpha = {
        webgl: alphaCounter(webglBlack, webglWhite),
        webgpu: alphaCounter(webgpuBlack, webgpuWhite),
      };
    }
    legs[format.id] = leg;
  }
  return legs;
}

async function runBounded(operation, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
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

async function awaitServedEntry(task, renderer) {
  if (!task) return null;
  let timer;
  try {
    return await Promise.race([
      task,
      new Promise((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              sessionLabel: renderer,
              ok: false,
              status: null,
              byteLength: 0,
              sha256: null,
              error: "served runtime entry body timed out",
            }),
          SERVED_ENTRY_TIMEOUT_MS,
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
          phase: window.__pointCloudColorProgress?.phase ?? "unknown",
          renderer: window.__pointCloudColorProgress?.renderer ?? null,
          format: window.__pointCloudColorProgress?.format ?? null,
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

async function withPointCloudColorWatchdog(
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
                  `point-cloud color watchdog expired after ${timeoutMs} ms`,
                ),
                cleanupError,
              ],
              "point-cloud color watchdog cleanup failed",
            );
            aggregate.pointCloudColorWatchdog = {
              timeoutMs,
              cleanupComplete: false,
            };
            reject(aggregate);
            return;
          }
          const error = new Error(
            timeoutEvidence?.cleanupComplete
              ? `point-cloud color watchdog expired after ${timeoutMs} ms`
              : `point-cloud color watchdog expired after ${timeoutMs} ms and cleanup remained unproven`,
          );
          error.pointCloudColorWatchdog = { timeoutMs, ...timeoutEvidence };
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
    servedEntry: null,
    cleanup: null,
  };
  let context;
  let page;
  let servedEntryTask;
  const pending = new Set();
  const externalRequests = [];
  try {
    owned.phase = `${renderer}:context`;
    await runBounded(
      async () => {
        context = await browser.newContext({
          viewport: VIEWPORT,
          deviceScaleFactor: 1,
        });
        owned.context = context;
        page = await context.newPage();
        owned.page = page;
        owned.pending = pending;
        await page.addInitScript(errorGateInit);
      },
      BACKEND_SESSION_SETUP_TIMEOUT_MS,
      `${renderer} browser-session setup`,
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
      let url;
      try {
        url = new URL(response.url());
      } catch {
        return;
      }
      if (
        servedEntryTask ||
        url.origin !== base.origin ||
        url.pathname !== runtimeEntryPath
      ) {
        return;
      }
      const status = response.status();
      servedEntryTask = response.body().then(
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
          byteLength: 0,
          sha256: null,
          error: serializeError(error),
        }),
      );
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
    if (renderer === "webgpu") {
      await runBounded(
        () => armWebGPUDevices(page),
        WEBGPU_ARM_TIMEOUT_MS,
        "WebGPU device instrumentation",
      );
    }

    owned.phase = `${renderer}:measure`;
    const acquirePageMeasurement = async ({ renderer, formats, budgets }) => {
      window.__pointCloudColorProgress = {
        renderer,
        phase: "setup",
        format: null,
      };
      const runBeforeDeadline = async (operation, deadline, message) => {
        const remainingMs = deadline - performance.now();
        if (remainingMs <= 0) throw new Error(message);
        let timer;
        try {
          return await Promise.race([
            Promise.resolve().then(operation),
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(message)),
                Math.ceil(remainingMs),
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      const setupDeadline =
        performance.now() + budgets.pageMeasurementSetupTimeoutMs;
      const setupTimeoutMessage =
        "point-cloud color page setup exceeded its deadline";
      const C = await runBeforeDeadline(
        () => import("/Build/CesiumUnminified/index.js"),
        setupDeadline,
        setupTimeoutMessage,
      );
      const viewer = window.viewer;
      const scene = viewer.scene;
      viewer.useDefaultRenderLoop = false;
      viewer.clock.shouldAnimate = false;
      scene.requestRenderMode = false;
      scene.skyBox.show = false;
      scene.skyAtmosphere.show = false;
      scene.sun.show = false;
      scene.moon.show = false;
      scene.fog.enabled = false;
      scene.globe.show = false;
      scene.backgroundColor = C.Color.BLACK;
      scene.postProcessStages.fxaa.enabled = false;
      const pageRuntimeErrors = [];
      scene.renderError.addEventListener((_scene, error) => {
        pageRuntimeErrors.push(error?.stack ?? error?.message ?? String(error));
      });
      for (const selector of [
        ".cesium-viewer-toolbar",
        ".cesium-viewer-animationContainer",
        ".cesium-viewer-timelineContainer",
        ".cesium-viewer-bottom",
        ".cesium-viewer-fullscreenContainer",
        ".cesium-widget-credits",
      ]) {
        document
          .querySelectorAll(selector)
          .forEach((element) => (element.style.display = "none"));
      }

      const fixedTime = C.JulianDate.fromIso8601("2026-08-02T18:00:00Z");
      viewer.clock.currentTime = fixedTime.clone();
      viewer.clock.startTime = fixedTime.clone();
      viewer.clock.stopTime = C.JulianDate.addSeconds(
        fixedTime,
        1,
        new C.JulianDate(),
      );
      const fixedSphere = new C.BoundingSphere(
        new C.Cartesian3(
          1215012.8828876738,
          -4736313.051199594,
          4081605.22126042,
        ),
        4.1,
      );
      const pointStyle = new C.Cesium3DTileStyle({ pointSize: 8 });
      const setCamera = () => {
        viewer.camera.viewBoundingSphere(
          fixedSphere,
          new C.HeadingPitchRange(0.3, -0.25, fixedSphere.radius * 4),
        );
        viewer.camera.lookAtTransform(C.Matrix4.IDENTITY);
      };

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

      const { captureSnapshot } = makeFusedSnapshotCapture(
        scene,
        scene.canvas,
        () => fixedTime,
      );

      if (performance.now() > setupDeadline) {
        throw new Error(setupTimeoutMessage);
      }
      const runBeforeLegDeadline = (operation, deadline, label) =>
        runBeforeDeadline(
          operation,
          deadline,
          `${label} exceeded its point-cloud color leg deadline`,
        );

      const mutateParsedColor = (format, pointCloud) => {
        const parsed = pointCloud?._parsedContent;
        const colors = parsed?.colors;
        const pointCount = pointCloud?._pointsLength;
        if (!parsed || !colors || pointCount !== 1000) {
          throw new Error(
            `${format.id} parsed color descriptor is absent or has the wrong point count`,
          );
        }
        const realizedBeforeMutation = Boolean(
          pointCloud._featureRenderer ||
          pointCloud._webgpuCache ||
          pointCloud._drawCommand,
        );
        if (realizedBeforeMutation) {
          throw new Error(
            `${format.id} control reached backend realization before decoder substitution`,
          );
        }

        let changedUnits = 0;
        let mutation;
        if (format.id === "rgb") {
          const original = colors.typedArray;
          if (!(original instanceof Uint8Array) || original.length !== 3000) {
            throw new Error("RGB decoder output is not 1000 packed triples");
          }
          const wrong = new Uint8Array(original);
          for (let index = 0; index < pointCount; index++) {
            const greenOffset = index * 3 + 1;
            const boostedGreen = Math.min(
              255,
              Math.round(original[greenOffset] * 1.15),
            );
            if (boostedGreen !== original[greenOffset]) changedUnits++;
            wrong[greenOffset] = boostedGreen;
          }
          colors.typedArray = wrong;
          mutation = "boost-decoded-rgb-green";
        } else if (format.id === "rgba") {
          const original = colors.typedArray;
          if (!(original instanceof Uint8Array) || original.length !== 4000) {
            throw new Error("RGBA decoder output is not 1000 packed quads");
          }
          const wrong = new Uint8Array(original);
          for (let index = 0; index < pointCount; index++) {
            const alphaOffset = index * 4 + 3;
            if (wrong[alphaOffset] !== 255) changedUnits++;
            wrong[alphaOffset] = 255;
          }
          colors.typedArray = wrong;
          mutation = "force-decoded-alpha-one";
        } else if (format.id === "rgb565") {
          const original = colors.typedArray;
          if (!(original instanceof Uint16Array) || original.length !== 1000) {
            throw new Error("RGB565 decoder output is not 1000 packed words");
          }
          const wrong = new Uint16Array(original.length);
          for (let index = 0; index < pointCount; index++) {
            const packed = original[index];
            const green = (packed >>> 5) & 0x3f;
            const boostedGreen = Math.min(0x3f, Math.round(green * 1.15));
            wrong[index] = (packed & 0xf81f) | (boostedGreen << 5);
            if (wrong[index] !== packed) changedUnits++;
          }
          colors.typedArray = wrong;
          mutation = "boost-decoded-rgb565-green";
        } else if (format.id === "constant") {
          const original = colors.constantColor;
          if (!original) {
            throw new Error(
              "CONSTANT_RGBA decoder output has no constant color",
            );
          }
          const replacement = { red: 1, green: 0, blue: 1, alpha: 1 };
          for (const channel of ["red", "green", "blue", "alpha"]) {
            if (original[channel] !== replacement[channel]) changedUnits++;
            original[channel] = replacement[channel];
            pointCloud._constantColor[channel] = replacement[channel];
          }
          mutation = "ignore-constant-rgba";
        } else {
          throw new Error(`unknown point-cloud color format ${format.id}`);
        }
        if (changedUnits === 0) {
          throw new Error(
            `${format.id} decoder substitution changed zero units`,
          );
        }
        return {
          mutation,
          changedUnits,
          pointCount,
          preRealization: !realizedBeforeMutation,
        };
      };

      const makeIntervals = (uri) =>
        C.TimeIntervalCollection.fromIso8601DateArray({
          iso8601Dates: ["2026-08-02T18:00:00Z", "2026-08-02T18:00:01Z"],
          dataCallback: () => ({ uri }),
        });

      const captures = {};
      const runtime = {};
      const mutations = {};
      const captureCloud = async (format, kind, substituteDecoder) => {
        window.__pointCloudColorProgress.format = format.id;
        window.__pointCloudColorProgress.phase = `${format.id}:${kind}:load`;
        const cloud = new C.TimeDynamicPointCloud({
          intervals: makeIntervals(format.uri),
          clock: viewer.clock,
          style: pointStyle,
          shading: {
            attenuation: false,
            eyeDomeLighting: false,
          },
        });
        scene.primitives.add(cloud);
        const started = performance.now();
        const readinessDeadline = started + budgets.readinessTimeoutMs;
        const legDeadline = started + budgets.colorLegTimeoutMs;
        let readyIteration = -1;
        let renderIterations = 1;
        let parsedPointCloud;
        let mutation = null;
        try {
          setCamera();
          scene.render(fixedTime);
          while (performance.now() < readinessDeadline) {
            parsedPointCloud = cloud._frames.find(
              (frame) => frame?.pointCloud?._parsedContent,
            )?.pointCloud;
            if (parsedPointCloud) break;
            await runBeforeLegDeadline(
              () => new Promise((resolve) => requestAnimationFrame(resolve)),
              legDeadline,
              `${format.id}/${kind} parsed-content readiness`,
            );
          }
          if (substituteDecoder) {
            mutation = mutateParsedColor(format, parsedPointCloud);
            mutations[format.id] = {
              ...mutation,
              scenario: kind,
            };
          }
          while (performance.now() < readinessDeadline) {
            setCamera();
            scene.render(fixedTime);
            renderIterations++;
            if (cloud.boundingSphere) {
              readyIteration = renderIterations - 1;
              break;
            }
            await runBeforeLegDeadline(
              () => new Promise((resolve) => requestAnimationFrame(resolve)),
              legDeadline,
              `${format.id}/${kind} bounding-sphere readiness`,
            );
          }
          for (let frame = 0; frame < 8 && readyIteration >= 0; frame++) {
            setCamera();
            scene.render(fixedTime);
            await runBeforeLegDeadline(
              () => new Promise((resolve) => requestAnimationFrame(resolve)),
              legDeadline,
              `${format.id}/${kind} settle`,
            );
          }
          await runBeforeLegDeadline(
            () => scene.context?._device?.queue?.onSubmittedWorkDone?.(),
            legDeadline,
            `${format.id}/${kind} GPU drain`,
          );
          scene.backgroundColor = C.Color.clone(C.Color.BLACK);
          setCamera();
          window.__pointCloudColorProgress.phase = `${format.id}:${kind}:black`;
          const black = await runBeforeLegDeadline(
            captureSnapshot,
            legDeadline,
            `${format.id}/${kind} black capture`,
          );
          captures[
            `${format.id}${kind[0].toUpperCase()}${kind.slice(1)}Black`
          ] = black.dataUrl;
          if (format.translucent) {
            scene.backgroundColor = C.Color.clone(C.Color.WHITE);
            setCamera();
            window.__pointCloudColorProgress.phase = `${format.id}:${kind}:white`;
            const white = await runBeforeLegDeadline(
              captureSnapshot,
              legDeadline,
              `${format.id}/${kind} white capture`,
            );
            captures[
              `${format.id}${kind[0].toUpperCase()}${kind.slice(1)}White`
            ] = white.dataUrl;
          }
          runtime[`${format.id}:${kind}`] = {
            ready: readyIteration >= 0,
            readyIteration,
            renderIterations,
            waitedMs: Math.round(performance.now() - started),
            totalMemoryUsageInBytes: cloud.totalMemoryUsageInBytes,
            radius: cloud.boundingSphere?.radius ?? null,
            pointsLength:
              cloud._lastRenderedFrame?.pointCloud?._pointsLength ?? 0,
            featureRendererPresent: Boolean(
              cloud._lastRenderedFrame?.pointCloud?._featureRenderer,
            ),
            parsedBeforeRealization: Boolean(parsedPointCloud),
            mutation,
          };
        } finally {
          scene.primitives.remove(cloud);
          if (!cloud.isDestroyed()) cloud.destroy();
          scene.backgroundColor = C.Color.clone(C.Color.BLACK);
        }
      };

      for (const format of formats) {
        await captureCloud(format, "positive", false);
      }
      if (renderer === "webgpu") {
        for (const target of formats) {
          const scenario = `control${target.id[0].toUpperCase()}${target.id.slice(1)}`;
          for (const format of formats) {
            await captureCloud(format, scenario, format.id === target.id);
          }
        }
      }

      window.__pointCloudColorProgress.phase = "measurement-complete";
      return {
        captures,
        runtime: {
          rendererType: String(scene.context.rendererType).toLowerCase(),
          measurements: runtime,
          mutations,
          frameNumber: scene.frameState.frameNumber,
        },
        harnessErrors: pageRuntimeErrors,
      };
    };

    const measurement = await runBounded(
      () =>
        page.evaluate(acquirePageMeasurement, {
          renderer,
          formats: POINTCLOUD_COLOR_FORMATS,
          budgets: {
            readinessTimeoutMs: READINESS_TIMEOUT_MS,
            colorLegTimeoutMs: COLOR_LEG_TIMEOUT_MS,
            pageMeasurementSetupTimeoutMs: PAGE_MEASUREMENT_SETUP_TIMEOUT_MS,
          },
        }),
      pageMeasurementTimeoutMs[renderer],
      `${renderer} point-cloud color measurement`,
    );

    owned.phase = `${renderer}:diagnostics`;
    const gpuGate =
      renderer === "webgpu"
        ? await runBounded(
            () => collectGateErrors(page),
            DIAGNOSTICS_TIMEOUT_MS,
            "WebGPU error-gate diagnostics",
          )
        : { errors: [], deviceLost: null, armedDevices: 0 };
    measurement.runtime.gpuGateArmedDevices = gpuGate.armedDevices;
    measurement.harnessErrors = [
      ...(measurement.harnessErrors ?? []),
      ...consoleErrors,
      ...gpuGate.errors,
      ...(gpuGate.deviceLost ? [gpuGate.deviceLost] : []),
      ...externalRequests.map(
        (url) => `non-loopback request escaped offline scene: ${url}`,
      ),
    ];
    measurement.diagnostics = {
      gpuGate,
      externalRequests: [...new Set(externalRequests)].sort(),
      pendingRequestsBeforeClose: pending.size,
    };
    session.servedEntry = await awaitServedEntry(servedEntryTask, renderer);
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
    for (const renderer of ["webgl", "webgpu"]) {
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
    if (!browserClose.closed && owned.browser === browser) {
      try {
        await runBounded(
          async () => await browser.close(),
          BROWSER_CLOSE_TIMEOUT_MS,
          "fleet browser last resort",
        );
        lastResortClose = { attempted: true, closed: true, timedOut: false };
        owned.browser = undefined;
      } catch (error) {
        lastResortClose = {
          attempted: true,
          closed: false,
          timedOut: false,
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
        result.sessions.length === 2 &&
        result.sessions.every((session) => session.cleanup?.complete === true),
    };
  }
}

function artifactWithStatus(status, fields) {
  return {
    schema: "pointcloud-color-formats/v1",
    ...fields,
    status,
    exitCode: exitCodeForS5Status(status),
  };
}

export async function runPointCloudColorFormatsProbe(options = {}) {
  const operations = options.operations ?? fs;
  const runId = options.runId ?? randomUUID();
  const paths = createRunPaths(runId, options.outputRoot ?? defaultOutputRoot);
  prepareRunDirectory(paths, operations);
  const base = options.base ?? validateLoopbackBase(defaultBase);
  const startedAt = new Date().toISOString();
  const source = operations.readFileSync(probeSourcePath, "utf8");
  const capturePreflight = inspectPointCloudColorCaptureContract(source);
  const localEntry = fingerprintEvidenceFile(buildEntryPath, operations);
  const localEntryValidation = validateServedEntryIdentities({
    entries: [],
    expectedLabels: [],
    localEntry,
  });
  const preflightGate = evaluatePointCloudColorRunGate({
    captureFailures: capturePreflight.failures,
    localEntryValidation,
    servedEntryValidation: null,
    harnessErrors: [],
  });
  const owned = {
    browser: undefined,
    context: undefined,
    page: undefined,
    pending: new Set(),
    phase: "preflight",
  };
  let artifact;
  let imageRecords = {};
  let quiescent = true;
  let provenance = {
    localEntry,
    servedEntries: [],
    validation: localEntryValidation,
  };
  try {
    if (preflightGate.status !== "PROCEED") {
      artifact = artifactWithStatus(preflightGate.status, {
        runId,
        startedAt,
        completedAt: new Date().toISOString(),
        captureContract: { ...capturePreflight, writeOnce: true },
        structural: preflightGate.structural,
        failures: [],
        harnessErrors: [],
        images: {},
        provenance,
        budgets: POINTCLOUD_COLOR_PROBE_BUDGETS,
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
      const acquisition = await withPointCloudColorWatchdog(
        () => acquireBothBackends(browser, { ...options, base }, owned),
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

      const servedEntries = acquisition.sessions.map(
        (session) => session.servedEntry,
      );
      const servedEntryValidation = validateServedEntryIdentities({
        entries: servedEntries,
        expectedLabels: ["webgl", "webgpu"],
        localEntry,
      });
      provenance = {
        localEntry,
        servedEntries,
        validation: servedEntryValidation,
      };

      const servedHarnessErrors = acquisition.sessions.flatMap((session) =>
        (session.measurement?.harnessErrors ?? []).map(
          (reason) => `${session.renderer}:${reason}`,
        ),
      );
      const servedGate = evaluatePointCloudColorRunGate({
        captureFailures: [],
        localEntryValidation: null,
        servedEntryValidation,
        harnessErrors: servedHarnessErrors,
      });
      if (servedGate.status !== "PROCEED") {
        const harnessErrors = servedHarnessErrors;
        const sessions = acquisition.sessions.map((session) => ({
          renderer: session.renderer,
          servedEntry: session.servedEntry,
          runtime: session.measurement.runtime,
          diagnostics: session.measurement.diagnostics,
          cleanup: session.cleanup,
        }));
        artifact = artifactWithStatus(servedGate.status, {
          runId,
          startedAt,
          completedAt: new Date().toISOString(),
          captureContract: { ...capturePreflight, writeOnce: true },
          structural: servedGate.structural,
          failures: [],
          harnessErrors,
          images: {},
          sessions,
          provenance,
          budgets: POINTCLOUD_COLOR_PROBE_BUDGETS,
          cleanup: acquisition.cleanup,
        });
      } else {
        const persisted = await persistCaptureSessions(
          paths,
          acquisition.sessions,
          operations,
        );
        imageRecords = persisted.records;
        const byRenderer = Object.fromEntries(
          acquisition.sessions.map((session) => [session.renderer, session]),
        );
        const harnessErrors = acquisition.sessions.flatMap((session) =>
          (session.measurement?.harnessErrors ?? []).map(
            (reason) => `${session.renderer}:${reason}`,
          ),
        );
        const common = {
          captureContract: {
            canonical: capturePreflight.canonical,
            singleBlock: capturePreflight.singleBlock,
            usageValid: capturePreflight.usageValid,
            writeOnce: true,
          },
          cleanup: acquisition.cleanup,
          harnessErrors,
          backend: {
            webglRendererType:
              byRenderer.webgl?.measurement?.runtime?.rendererType ?? null,
            webgpuRendererType:
              byRenderer.webgpu?.measurement?.runtime?.rendererType ?? null,
            webgpuErrorGateArmedDevices:
              byRenderer.webgpu?.measurement?.runtime?.gpuGateArmedDevices ?? 0,
          },
        };
        const runtimes = {
          webgl: byRenderer.webgl?.measurement?.runtime?.measurements ?? {},
          webgpu: byRenderer.webgpu?.measurement?.runtime?.measurements ?? {},
        };
        const positiveInput = {
          ...common,
          legs: buildLegCounters(persisted.images, runtimes, "positive"),
        };
        const positive = scorePointCloudColorFormats(positiveInput);
        const controlInputs = {};
        for (const target of FORMAT_IDS) {
          const scenario = `control${target[0].toUpperCase()}${target.slice(1)}`;
          const legs = buildLegCounters(persisted.images, runtimes, scenario);
          const mutation =
            byRenderer.webgpu?.measurement?.runtime?.mutations?.[target];
          controlInputs[target] = {
            ...common,
            legs,
            controlMutation: mutation
              ? { ...mutation, target }
              : { target, changedUnits: 0, preRealization: false },
          };
        }
        const controls = scorePointCloudColorControls(controlInputs);
        const status =
          positive.status === "ERROR"
            ? "ERROR"
            : positive.status === "FAIL"
              ? "FAIL"
              : positive.status === "STRUCTURAL"
                ? "STRUCTURAL"
                : controls.valid
                  ? "PASS"
                  : "STRUCTURAL";
        const sessions = acquisition.sessions.map((session) => ({
          renderer: session.renderer,
          servedEntry: session.servedEntry,
          runtime: session.measurement.runtime,
          diagnostics: session.measurement.diagnostics,
          cleanup: session.cleanup,
        }));
        artifact = artifactWithStatus(status, {
          runId,
          startedAt,
          completedAt: new Date().toISOString(),
          captureContract: { ...capturePreflight, writeOnce: true },
          structural: [
            ...positive.structural,
            ...(!controls.valid ? controls.failures : []),
          ],
          failures: positive.failures,
          harnessErrors: positive.harnessErrors,
          limits: POINTCLOUD_COLOR_GATE_LIMITS,
          positive,
          controls,
          images: imageRecords,
          sessions,
          provenance,
          budgets: POINTCLOUD_COLOR_PROBE_BUDGETS,
          cleanup: acquisition.cleanup,
          honestLimitations: [
            "The gate compares rendered aggregate color and coverage; it does not recover each source point's color identity from the framebuffer.",
            "The alpha witness measures background transmission for visible pixels; fully transparent source points leave no framebuffer sample to count.",
            "The gate covers the dedicated TimeDynamicPointCloud path at one camera and point size; it does not certify the separate tileset model path.",
          ],
          mutationEvidence:
            byRenderer.webgpu?.measurement?.runtime?.mutations ?? {},
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
      structural: [],
      failures: [],
      harnessErrors: [
        serializeError(error),
        ...(terminalCleanupError ? [terminalCleanupError] : []),
      ],
      images: imageRecords,
      provenance,
      budgets: POINTCLOUD_COLOR_PROBE_BUDGETS,
      cleanup: terminalCleanup ?? { complete: false },
    });
  }

  const artifactBytes = Buffer.from(stableJson(artifact));
  const publication = writeOnceAndReread(
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
      bytes: publication.bytes.length,
      sha256: publication.sha256,
    },
  };
}

function usage() {
  console.log(
    "Usage: node Tools/visual-regression/probe-pointcloud-color-formats.mjs " +
      "[--base URL] [--output-directory DIR] [--headed]",
  );
}

function parseArguments(argv) {
  const parsed = {
    base: validateLoopbackBase(defaultBase),
    outputRoot: defaultOutputRoot,
    headed: false,
    help: false,
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
      parsed.help = true;
    } else {
      throw new Error(`unknown argument ${argument}`);
    }
  }
  return parsed;
}

async function main() {
  const processWatchdog = setTimeout(() => {
    console.error(
      `[pointcloud-color-formats] process watchdog fired after ${PROCESS_WATCHDOG_MS} ms`,
    );
    process.exit(exitCodeForS5Status("ERROR"));
  }, PROCESS_WATCHDOG_MS);
  processWatchdog.unref?.();
  let quiescent = false;
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      usage();
      quiescent = true;
      process.exitCode = exitCodeForS5Status("PASS");
      return;
    }
    const result = await runPointCloudColorFormatsProbe(options);
    quiescent = result.quiescent === true;
    console.log(
      JSON.stringify(
        {
          status: result.artifact.status,
          exitCode: result.artifact.exitCode,
          runId: result.artifact.runId,
          evidence: result.publication,
        },
        null,
        2,
      ),
    );
    process.exitCode = exitCodeForS5Status(result.artifact.status);
  } catch (error) {
    console.error("[pointcloud-color-formats] uncaught probe failure", error);
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
