#!/usr/bin/env node
/**
 * Point-sprite tint repeat parity probe.
 * @purpose Measure seven raw ds4 WebGL/WebGPU point-cloud color-gain samples in one browser session and reject out-of-band or strictly monotone drift.
 * @status ACTIVE
 *
 * The browser lane acquires immutable PNGs only through the canonical fused
 * snapshot transaction. Node publishes every PNG once, rereads it, and derives
 * all verdict counters from the persisted bytes. The gain is observed
 * WebGL-over-WebGPU channel energy on raw 4x4 box-downsampled cells; it is never
 * fed back into the pixels as a normalization step.
 *
 * This gate does not score point shape, attenuation-only rendering, point
 * primitives, other point-cloud frames, cross-process drift, or the source of
 * a tint. It establishes only the bounded seven-sample same-session contract
 * described by its counters.
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
const defaultBase = process.env.PROBE_BASE ?? "http://localhost:8080";
const defaultOutputRoot = path.resolve(
  process.env.POINT_SPRITE_TINT_REPEAT_OUTPUT_DIR ??
    path.join(toolDirectory, "output/point-sprite-tint-repeat"),
);

export const POINT_SPRITE_TINT_REPEAT_SCHEMA = "point-sprite-tint-repeat-v1";

export const POINT_SPRITE_TINT_REPEAT_CONFIG = Object.freeze({
  width: 600,
  height: 600,
  repeatCount: 7,
  downsampleFactor: 4,
  skippedSourceRows: 60,
  gainMinimum: 0.97,
  gainMaximum: 1.03,
});

const CHANNEL_NAMES = Object.freeze(["red", "green", "blue"]);
const RENDERERS = Object.freeze(["webgl", "webgpu"]);
const NAVIGATION_STAGES_PER_BACKEND = 2;
const NAVIGATION_TIMEOUT_MS = 60_000;
const PAGE_INITIALIZATION_TIMEOUT_MS = 100_000;
const SERVED_ENTRY_TIMEOUT_MS = 15_000;
const BACKEND_SETUP_MARGIN_MS = 5_000;
const BACKEND_INITIALIZATION_TIMEOUT_MS =
  NAVIGATION_STAGES_PER_BACKEND * NAVIGATION_TIMEOUT_MS +
  PAGE_INITIALIZATION_TIMEOUT_MS +
  SERVED_ENTRY_TIMEOUT_MS +
  BACKEND_SETUP_MARGIN_MS;
const CAPTURE_TIMEOUT_MS = 10_000;
const DIAGNOSTICS_TIMEOUT_MS = 10_000;
const CONTEXT_CREATION_TIMEOUT_MS = 15_000;
const BROWSER_LAUNCH_TIMEOUT_MS = 60_000;
const SESSION_CLOSE_TIMEOUT_MS = 15_000;
const BROWSER_CLOSE_TIMEOUT_MS = 30_000;
const CLEANUP_WORST_CASE_MS =
  RENDERERS.length * SESSION_CLOSE_TIMEOUT_MS +
  SESSION_CLOSE_TIMEOUT_MS +
  2 * BROWSER_CLOSE_TIMEOUT_MS;
const WORST_CASE_RUN_MS =
  CONTEXT_CREATION_TIMEOUT_MS +
  RENDERERS.length *
    (BACKEND_INITIALIZATION_TIMEOUT_MS +
      POINT_SPRITE_TINT_REPEAT_CONFIG.repeatCount * CAPTURE_TIMEOUT_MS +
      DIAGNOSTICS_TIMEOUT_MS) +
  CLEANUP_WORST_CASE_MS;
const RUN_WATCHDOG_MS = 840_000;
// The terminating fuse remains armed while bounded cleanup and immutable
// publication run. An orderly rejection cannot end a wedged browser loop.
const PROCESS_WATCHDOG_MS =
  BROWSER_LAUNCH_TIMEOUT_MS +
  RUN_WATCHDOG_MS +
  BROWSER_CLOSE_TIMEOUT_MS +
  60_000;
const WORST_CASE_PROCESS_MS = BROWSER_LAUNCH_TIMEOUT_MS + WORST_CASE_RUN_MS;

export const POINT_SPRITE_TINT_REPEAT_BUDGET = Object.freeze({
  backendCount: RENDERERS.length,
  repeatCount: POINT_SPRITE_TINT_REPEAT_CONFIG.repeatCount,
  navigationStagesPerBackend: NAVIGATION_STAGES_PER_BACKEND,
  navigationTimeoutMs: NAVIGATION_TIMEOUT_MS,
  pageInitializationTimeoutMs: PAGE_INITIALIZATION_TIMEOUT_MS,
  servedEntryTimeoutMs: SERVED_ENTRY_TIMEOUT_MS,
  backendSetupMarginMs: BACKEND_SETUP_MARGIN_MS,
  backendInitializationTimeoutMs: BACKEND_INITIALIZATION_TIMEOUT_MS,
  captureTimeoutMs: CAPTURE_TIMEOUT_MS,
  diagnosticsTimeoutMs: DIAGNOSTICS_TIMEOUT_MS,
  contextCreationTimeoutMs: CONTEXT_CREATION_TIMEOUT_MS,
  cleanupWorstCaseMs: CLEANUP_WORST_CASE_MS,
  browserLaunchTimeoutMs: BROWSER_LAUNCH_TIMEOUT_MS,
  worstCaseRunMs: WORST_CASE_RUN_MS,
  runWatchdogMs: RUN_WATCHDOG_MS,
  worstCaseProcessMs: WORST_CASE_PROCESS_MS,
  processWatchdogMs: PROCESS_WATCHDOG_MS,
});

if (WORST_CASE_RUN_MS >= RUN_WATCHDOG_MS) {
  throw new Error("point-sprite tint inner budgets exceed the run watchdog");
}
if (WORST_CASE_PROCESS_MS >= PROCESS_WATCHDOG_MS) {
  throw new Error("point-sprite tint budgets exceed the process watchdog");
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const stableJson = (value) => `${JSON.stringify(value, null, 2)}\n`;

function serializeError(value) {
  const error = value instanceof Error ? value : new Error(String(value));
  return {
    name: String(error.name ?? "Error"),
    message: String(error.message ?? value),
    stack: error.stack === undefined ? null : String(error.stack),
    watchdog: error.pointSpriteTintWatchdog ?? null,
  };
}

function serializeHarnessError(value) {
  if (typeof value === "string") {
    return value;
  }
  const error =
    value !== null && typeof value === "object"
      ? value
      : new Error(String(value));
  return {
    name: String(error.name ?? "Error"),
    message: String(error.message ?? value),
    stack: error.stack === undefined ? null : String(error.stack),
  };
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

export function inspectPointSpriteTintCaptureContract(source) {
  const canonicalFailures = checkEmbeddedFusedSnapshotIsCanonical(source);
  const usageFailures = checkFusedCaptureUsage(source);
  const beginCount = markerCount(source, FUSED_SNAPSHOT_BEGIN);
  const endCount = markerCount(source, FUSED_SNAPSHOT_END);
  const singleBlock = beginCount === 1 && endCount === 1;
  return {
    canonical: canonicalFailures.length === 0,
    singleBlock,
    usageValid: usageFailures.length === 0,
    beginCount,
    endCount,
    canonicalSourceBytes: Buffer.byteLength(
      FUSED_SNAPSHOT_CAPTURE_SOURCE,
      "utf8",
    ),
    canonicalSourceSha256: sha256(FUSED_SNAPSHOT_CAPTURE_SOURCE),
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

function validChannelSums(value) {
  return (
    Array.isArray(value) &&
    value.length === CHANNEL_NAMES.length &&
    value.every(isFiniteNonNegative)
  );
}

function strictMonotoneDirection(values) {
  if (
    !Array.isArray(values) ||
    values.length !== POINT_SPRITE_TINT_REPEAT_CONFIG.repeatCount ||
    !values.every(Number.isFinite)
  ) {
    return { increasing: false, decreasing: false, direction: null };
  }
  const increasing = values
    .slice(1)
    .every((value, index) => value > values[index]);
  const decreasing = values
    .slice(1)
    .every((value, index) => value < values[index]);
  return {
    increasing,
    decreasing,
    direction: increasing ? "increasing" : decreasing ? "decreasing" : null,
  };
}

/**
 * Evaluate persisted raw ds4 counters without launching or reading anything.
 * Narrated booleans and precomputed gains are intentionally ignored: the
 * decision is re-derived from channel sums and sample cardinality.
 *
 * @param {object} input Browser-free counter input.
 * @returns {object} Verdict, exit tier, raw counters, and derived gain sequence.
 */
export function evaluatePointSpriteTintRepeat(input) {
  const harnessErrors = Array.isArray(input?.harnessErrors)
    ? input.harnessErrors.filter(Boolean).map(serializeHarnessError)
    : ["input:harness-errors-invalid"];
  const structural = [];
  const failures = [];
  const scoredSamples = [];
  const finishEvaluation = (status, channelSequences = []) => ({
    schema: POINT_SPRITE_TINT_REPEAT_SCHEMA,
    status,
    exitCode: exitCodeForS5Status(status),
    thresholds: {
      repeatCount: POINT_SPRITE_TINT_REPEAT_CONFIG.repeatCount,
      gainInclusive: [
        POINT_SPRITE_TINT_REPEAT_CONFIG.gainMinimum,
        POINT_SPRITE_TINT_REPEAT_CONFIG.gainMaximum,
      ],
      downsampleFactor: POINT_SPRITE_TINT_REPEAT_CONFIG.downsampleFactor,
      strictlyMonotoneAcrossAllRepeatsFails: true,
    },
    provenance: input?.provenance ?? null,
    harnessErrors,
    structural,
    failures,
    samples: scoredSamples,
    channelSequences,
  });

  if (input?.schema !== POINT_SPRITE_TINT_REPEAT_SCHEMA) {
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

  if (input?.session?.browserLaunches !== 1) {
    structural.push("session:single-browser-launch-unproven");
  }
  if (input?.session?.contexts !== 1) {
    structural.push("session:single-context-unproven");
  }
  if (input?.session?.pages !== 2) {
    structural.push("session:dual-backend-pages-unproven");
  }

  const servedEntryIdentity = input?.provenance?.servedEntryIdentity;
  if (servedEntryIdentity?.ok !== true) {
    const identityReasons = Array.isArray(servedEntryIdentity?.reasons)
      ? servedEntryIdentity.reasons
      : ["served runtime entry identity is unavailable"];
    structural.push(
      ...identityReasons.map((reason) => `provenance:${String(reason)}`),
    );
  }

  for (const backend of RENDERERS) {
    const runtime = input?.runtime?.[backend];
    if (runtime?.rendererType !== backend) {
      structural.push(`${backend}:backend-identity-unproven`);
    }
    if (runtime?.ready !== true) {
      structural.push(`${backend}:point-cloud-readiness-unproven`);
    }
    if (
      backend === "webgpu" &&
      (!Number.isInteger(runtime?.gpuGateArmedDevices) ||
        runtime.gpuGateArmedDevices < 1)
    ) {
      structural.push("webgpu:error-gate-unarmed");
    }
  }
  const topLevelStructuralCount = structural.length;
  if (servedEntryIdentity?.ok !== true) {
    return finishEvaluation(harnessErrors.length > 0 ? "ERROR" : "STRUCTURAL");
  }

  const samples = input?.samples;
  if (
    !Array.isArray(samples) ||
    samples.length !== POINT_SPRITE_TINT_REPEAT_CONFIG.repeatCount
  ) {
    structural.push(
      `samples:expected-${POINT_SPRITE_TINT_REPEAT_CONFIG.repeatCount}`,
    );
  }

  for (
    let sampleIndex = 0;
    sampleIndex < (samples?.length ?? 0);
    sampleIndex++
  ) {
    const sample = samples[sampleIndex];
    const sampleStructural = [];
    const sampleFailures = [];
    const dimensions = sample?.dimensions;
    const raw = sample?.rawDs4;

    if (sample?.index !== sampleIndex) {
      sampleStructural.push("index-invalid");
    }
    for (const backend of RENDERERS) {
      const size = dimensions?.[backend];
      if (
        size?.width !== POINT_SPRITE_TINT_REPEAT_CONFIG.width ||
        size?.height !== POINT_SPRITE_TINT_REPEAT_CONFIG.height
      ) {
        sampleStructural.push(`${backend}-capture-size-invalid`);
      }
      const frame = sample?.captureFrames?.[backend];
      if (
        !Number.isInteger(frame?.before) ||
        !Number.isInteger(frame?.after) ||
        frame.after !== frame.before + 1 ||
        frame.sequence !== sampleIndex
      ) {
        sampleStructural.push(`${backend}-fused-frame-unproven`);
      }
    }
    if (
      dimensions?.webgl?.width !== dimensions?.webgpu?.width ||
      dimensions?.webgl?.height !== dimensions?.webgpu?.height
    ) {
      sampleStructural.push("capture-size-mismatch");
    }
    if (
      !Number.isInteger(sample?.webglNonBackgroundPixels) ||
      sample.webglNonBackgroundPixels <= 0 ||
      sample.webglNonBackgroundPixels >
        POINT_SPRITE_TINT_REPEAT_CONFIG.width *
          POINT_SPRITE_TINT_REPEAT_CONFIG.height
    ) {
      sampleStructural.push("webgl-reference-empty");
    }
    if (
      !Number.isInteger(sample?.webgpuNonBackgroundPixels) ||
      sample.webgpuNonBackgroundPixels < 0 ||
      sample.webgpuNonBackgroundPixels >
        POINT_SPRITE_TINT_REPEAT_CONFIG.width *
          POINT_SPRITE_TINT_REPEAT_CONFIG.height
    ) {
      sampleStructural.push("webgpu-pixel-count-invalid");
    } else if (sample.webgpuNonBackgroundPixels === 0) {
      sampleFailures.push("webgpu-subject-empty");
    }

    const expectedDownsampleWidth = Math.floor(
      POINT_SPRITE_TINT_REPEAT_CONFIG.width /
        POINT_SPRITE_TINT_REPEAT_CONFIG.downsampleFactor,
    );
    const expectedDownsampleHeight = Math.floor(
      POINT_SPRITE_TINT_REPEAT_CONFIG.height /
        POINT_SPRITE_TINT_REPEAT_CONFIG.downsampleFactor,
    );
    const expectedSkippedRows = Math.ceil(
      POINT_SPRITE_TINT_REPEAT_CONFIG.skippedSourceRows /
        POINT_SPRITE_TINT_REPEAT_CONFIG.downsampleFactor,
    );
    if (
      raw?.factor !== POINT_SPRITE_TINT_REPEAT_CONFIG.downsampleFactor ||
      raw?.width !== expectedDownsampleWidth ||
      raw?.height !== expectedDownsampleHeight ||
      raw?.skippedRows !== expectedSkippedRows
    ) {
      sampleStructural.push("raw-ds4-shape-invalid");
    }
    if (!Number.isInteger(raw?.litCellCount) || raw.litCellCount <= 0) {
      sampleStructural.push("raw-ds4-lit-cells-absent");
    }
    if (!validChannelSums(raw?.webglChannelSums)) {
      sampleStructural.push("webgl-channel-sums-invalid");
    }
    if (!validChannelSums(raw?.webgpuChannelSums)) {
      sampleStructural.push("webgpu-channel-sums-invalid");
    }
    if (
      Number.isInteger(raw?.litCellCount) &&
      raw.litCellCount > 0 &&
      validChannelSums(raw?.webglChannelSums) &&
      raw.webglChannelSums.some((sum) => sum > raw.litCellCount * 255)
    ) {
      sampleStructural.push("webgl-channel-sums-out-of-range");
    }
    if (
      Number.isInteger(raw?.litCellCount) &&
      raw.litCellCount > 0 &&
      validChannelSums(raw?.webgpuChannelSums) &&
      raw.webgpuChannelSums.some((sum) => sum > raw.litCellCount * 255)
    ) {
      sampleStructural.push("webgpu-channel-sums-out-of-range");
    }

    const gains = [null, null, null];
    const means = { webgl: [null, null, null], webgpu: [null, null, null] };
    if (
      sampleStructural.length === 0 &&
      validChannelSums(raw.webglChannelSums) &&
      validChannelSums(raw.webgpuChannelSums)
    ) {
      for (let channel = 0; channel < CHANNEL_NAMES.length; channel++) {
        const channelName = CHANNEL_NAMES[channel];
        const referenceSum = raw.webglChannelSums[channel];
        const subjectSum = raw.webgpuChannelSums[channel];
        means.webgl[channel] = referenceSum / raw.litCellCount;
        means.webgpu[channel] = subjectSum / raw.litCellCount;
        if (referenceSum <= 0) {
          sampleStructural.push(`${channelName}-reference-energy-absent`);
          continue;
        }
        if (subjectSum <= 0) {
          sampleFailures.push(`${channelName}-subject-energy-absent`);
          continue;
        }
        const gain = referenceSum / subjectSum;
        gains[channel] = gain;
        if (
          gain < POINT_SPRITE_TINT_REPEAT_CONFIG.gainMinimum ||
          gain > POINT_SPRITE_TINT_REPEAT_CONFIG.gainMaximum
        ) {
          sampleFailures.push(`${channelName}-gain-out-of-band`);
        }
      }
    }

    structural.push(
      ...sampleStructural.map((reason) => `sample-${sampleIndex}:${reason}`),
    );
    failures.push(
      ...sampleFailures.map((reason) => `sample-${sampleIndex}:${reason}`),
    );
    scoredSamples.push({
      index: sampleIndex,
      dimensions: dimensions ?? null,
      captureFrames: sample?.captureFrames ?? null,
      webglNonBackgroundPixels: sample?.webglNonBackgroundPixels ?? null,
      webgpuNonBackgroundPixels: sample?.webgpuNonBackgroundPixels ?? null,
      rawDs4: raw ?? null,
      channelMeans: means,
      gains,
    });
  }

  const channelSequences = CHANNEL_NAMES.map((name, channel) => {
    const values = scoredSamples.map((sample) => sample.gains[channel]);
    const monotone = strictMonotoneDirection(values);
    if (monotone.direction !== null) {
      failures.push(`${name}-gain-strictly-${monotone.direction}`);
    }
    return { name, values, ...monotone };
  });

  const status =
    harnessErrors.length > 0
      ? "ERROR"
      : topLevelStructuralCount > 0
        ? "STRUCTURAL"
        : failures.length > 0
          ? "FAIL"
          : structural.length > 0
            ? "STRUCTURAL"
            : "PASS";
  return finishEvaluation(status, channelSequences);
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
  operations.writeFileSync(file, canonical, { flag: "wx" });
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
    !bytes.subarray(0, 8).equals(signature)
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
        POINT_SPRITE_TINT_REPEAT_CONFIG.width *
        POINT_SPRITE_TINT_REPEAT_CONFIG.height,
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
    info.channels !== 4 ||
    data.length !== info.width * info.height * info.channels
  ) {
    throw new Error(`${label} persisted PNG is not complete RGBA data`);
  }
  return {
    width: info.width,
    height: info.height,
    data: new Uint8ClampedArray(data),
  };
}

function countNonBackgroundPixels(image) {
  let count = 0;
  for (let offset = 0; offset < image.data.length; offset += 4) {
    if (
      image.data[offset] + image.data[offset + 1] + image.data[offset + 2] >
      24
    ) {
      count++;
    }
  }
  return count;
}

function downsampleRgb(image, factor) {
  const width = Math.floor(image.width / factor);
  const height = Math.floor(image.height / factor);
  const data = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sums = [0, 0, 0];
      for (let yy = 0; yy < factor; yy++) {
        for (let xx = 0; xx < factor; xx++) {
          const source =
            ((y * factor + yy) * image.width + (x * factor + xx)) * 4;
          sums[0] += image.data[source];
          sums[1] += image.data[source + 1];
          sums[2] += image.data[source + 2];
        }
      }
      const destination = (y * width + x) * 3;
      const divisor = factor * factor;
      data[destination] = sums[0] / divisor;
      data[destination + 1] = sums[1] / divisor;
      data[destination + 2] = sums[2] / divisor;
    }
  }
  return { width, height, data };
}

export function summarizePointSpriteRawDs4Pair(webgl, webgpu) {
  const dimensions = {
    webgl: { width: webgl.width, height: webgl.height },
    webgpu: { width: webgpu.width, height: webgpu.height },
  };
  const summary = {
    dimensions,
    webglNonBackgroundPixels: countNonBackgroundPixels(webgl),
    webgpuNonBackgroundPixels: countNonBackgroundPixels(webgpu),
    rawDs4: null,
  };
  if (webgl.width !== webgpu.width || webgl.height !== webgpu.height) {
    return summary;
  }
  const factor = POINT_SPRITE_TINT_REPEAT_CONFIG.downsampleFactor;
  const reference = downsampleRgb(webgl, factor);
  const subject = downsampleRgb(webgpu, factor);
  const skippedRows = Math.ceil(
    POINT_SPRITE_TINT_REPEAT_CONFIG.skippedSourceRows / factor,
  );
  const webglChannelSums = [0, 0, 0];
  const webgpuChannelSums = [0, 0, 0];
  let litCellCount = 0;
  for (let y = skippedRows; y < reference.height; y++) {
    for (let x = 0; x < reference.width; x++) {
      const offset = (y * reference.width + x) * 3;
      const referenceLight =
        reference.data[offset] +
        reference.data[offset + 1] +
        reference.data[offset + 2];
      const subjectLight =
        subject.data[offset] +
        subject.data[offset + 1] +
        subject.data[offset + 2];
      if (referenceLight > 24 || subjectLight > 24) {
        litCellCount++;
        for (let channel = 0; channel < CHANNEL_NAMES.length; channel++) {
          webglChannelSums[channel] += reference.data[offset + channel];
          webgpuChannelSums[channel] += subject.data[offset + channel];
        }
      }
    }
  }
  summary.rawDs4 = {
    factor,
    width: reference.width,
    height: reference.height,
    skippedRows,
    litCellCount,
    webglChannelSums,
    webgpuChannelSums,
  };
  return summary;
}

async function withOperationTimeout(operation, timeoutMs, label) {
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

function captureServedEntryIdentity(page, sessionLabel, base) {
  let captured = false;
  const result = new Promise((resolve) => {
    page.on("response", (response) => {
      let url;
      try {
        url = new URL(response.url());
      } catch {
        return;
      }
      if (
        captured ||
        url.origin !== base.origin ||
        url.pathname !== "/Build/CesiumUnminified/index.js"
      ) {
        return;
      }
      captured = true;
      void response.body().then(
        (bytes) =>
          resolve({
            sessionLabel,
            url: response.url(),
            ok: response.ok(),
            status: response.status(),
            byteLength: bytes.byteLength,
            sha256: sha256(bytes),
          }),
        (error) =>
          resolve({
            sessionLabel,
            ok: false,
            status: response.status(),
            byteLength: 0,
            sha256: null,
            error: serializeError(error),
          }),
      );
    });
    page.once("close", () => {
      if (!captured) {
        resolve({
          sessionLabel,
          ok: false,
          status: null,
          byteLength: 0,
          sha256: null,
          error: "page closed before served runtime identity was captured",
        });
      }
    });
  });
  return result;
}

async function awaitServedEntryIdentity(task, sessionLabel) {
  let timer;
  try {
    return await Promise.race([
      task,
      new Promise((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              sessionLabel,
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

async function initializePointSpritePage(args) {
  window.__pointSpriteTintProgress = {
    renderer: args.renderer,
    phase: "setup",
  };
  const C = await import("/Build/CesiumUnminified/index.js");
  const viewer = window.viewer;
  viewer.useDefaultRenderLoop = false;
  viewer.clock.shouldAnimate = false;
  const scene = viewer.scene;
  const runtimeErrors = [];
  scene.renderError.addEventListener((_scene, error) => {
    runtimeErrors.push(error?.stack ?? error?.message ?? String(error));
  });
  scene.requestRenderMode = false;
  scene.skyBox.show = false;
  scene.skyAtmosphere.show = false;
  if (scene.sun) scene.sun.show = false;
  if (scene.moon) scene.moon.show = false;
  scene.fog.enabled = false;
  scene.backgroundColor = C.Color.BLACK;
  scene.globe.show = false;
  scene.imageryLayers.removeAll();
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

  const intervals = C.TimeIntervalCollection.fromIso8601DateArray({
    iso8601Dates: args.dates,
    dataCallback: (_interval, index) => ({ uri: args.uris[index] }),
  });
  const start = C.JulianDate.fromIso8601(args.dates[0]);
  viewer.clock.startTime = start;
  viewer.clock.currentTime = start;
  viewer.clock.stopTime = C.JulianDate.fromIso8601(
    args.dates[args.dates.length - 1],
  );
  viewer.clock.clockRange = C.ClockRange.LOOP_STOP;
  const pointCloud = new C.TimeDynamicPointCloud({
    intervals,
    clock: viewer.clock,
    style: new C.Cesium3DTileStyle({ pointSize: 8 }),
    shading: {
      attenuation: true,
      maximumAttenuation: 10,
      eyeDomeLighting: false,
    },
  });
  scene.primitives.add(pointCloud);
  const fixedSphere = new C.BoundingSphere(
    new C.Cartesian3(1215012.9, -4736312.85, 4081606.1),
    4.1,
  );
  const captureTime = C.JulianDate.clone(start);
  const placeCamera = () => {
    viewer.camera.viewBoundingSphere(
      fixedSphere,
      new C.HeadingPitchRange(0.3, -0.25, fixedSphere.radius * 4.0),
    );
    viewer.camera.lookAtTransform(C.Matrix4.IDENTITY);
  };
  const renderLoadingFrame = () => {
    placeCamera();
    scene.requestRender();
    scene.render(captureTime);
  };

  window.__pointSpriteTintProgress.phase = "readiness";
  const readinessStarted = performance.now();
  let readinessFrames = 0;
  let ready = false;
  while (
    readinessFrames < 600 &&
    performance.now() - readinessStarted < 90_000
  ) {
    renderLoadingFrame();
    readinessFrames++;
    if (pointCloud.boundingSphere) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
  let settleFrames = 0;
  if (ready) {
    for (; settleFrames < 60; settleFrames++) {
      renderLoadingFrame();
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
    await scene.context?._device?.queue?.onSubmittedWorkDone?.();
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

  const { captureSnapshot } = makeFusedSnapshotCapture(
    scene,
    scene.canvas,
    () => captureTime,
  );
  let sequence = 0;
  const captureRepeat = async () => {
    placeCamera();
    const before = scene.frameState.frameNumber;
    const snapshot = await captureSnapshot();
    const result = {
      dataUrl: snapshot.dataUrl,
      before,
      after: scene.frameState.frameNumber,
      sequence,
    };
    sequence++;
    return result;
  };
  window.__pointSpriteTintRepeatCapture = captureRepeat;
  window.__pointSpriteTintRuntimeErrors = runtimeErrors;
  window.__pointSpriteTintProgress.phase = "ready-for-repeats";
  return {
    ready,
    rendererType: String(scene.context?.rendererType ?? "").toLowerCase(),
    waitedMs: Math.round(performance.now() - readinessStarted),
    readinessFrames,
    settleFrames,
    boundingSphereAvailable: Boolean(pointCloud.boundingSphere),
    canvas: { width: scene.canvas.width, height: scene.canvas.height },
    frameNumber: scene.frameState.frameNumber,
  };
}

async function capturePointSpriteRepeat(page, expectedSequence) {
  return await withOperationTimeout(
    () =>
      page.evaluate(async (expected) => {
        const capture = window.__pointSpriteTintRepeatCapture;
        if (typeof capture !== "function") {
          throw new Error("point-sprite repeat capture is unavailable");
        }
        window.__pointSpriteTintProgress.phase = `capture-${expected}`;
        const result = await capture();
        if (result.sequence !== expected) {
          throw new Error(
            `point-sprite capture sequence ${result.sequence} did not equal ${expected}`,
          );
        }
        return result;
      }, expectedSequence),
    CAPTURE_TIMEOUT_MS,
    `point-sprite capture ${expectedSequence}`,
  );
}

async function closeBounded(instance, label, timeoutMs) {
  if (!instance) {
    return { label, attempted: false, closed: true, timedOut: false };
  }
  if (typeof instance.isClosed === "function" && instance.isClosed()) {
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
  const page = [...owned.pages][0];
  if (!page || page.isClosed()) {
    return { phase: owned.phase, pageAvailable: false };
  }
  let timer;
  try {
    return await Promise.race([
      page
        .evaluate(() => ({
          phase: window.__pointSpriteTintProgress?.phase ?? "unknown",
          renderer: window.__pointSpriteTintProgress?.renderer ?? null,
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
  const pageCloses = [];
  for (const page of [...owned.pages]) {
    const result = await closeBounded(
      page,
      "watchdog page",
      SESSION_CLOSE_TIMEOUT_MS,
    );
    pageCloses.push(result);
    if (result.closed) owned.pages.delete(page);
  }
  const context = owned.context;
  const contextClose = await closeBounded(
    context,
    "watchdog context",
    SESSION_CLOSE_TIMEOUT_MS,
  );
  if (contextClose.closed && owned.context === context) {
    owned.context = undefined;
  }
  const browser = owned.browser;
  const browserClose = await closeBounded(
    browser,
    "watchdog browser",
    BROWSER_CLOSE_TIMEOUT_MS,
  );
  if (browserClose.closed && owned.browser === browser) {
    owned.browser = undefined;
  }
  const pendingRequests = owned.pending.size;
  return {
    pageCloses,
    contextClose,
    browserClose,
    pendingRequests,
    cleanupComplete:
      pageCloses.every((result) => result.closed) &&
      contextClose.closed &&
      browserClose.closed &&
      pendingRequests === 0,
  };
}

export async function withPointSpriteTintWatchdog(
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
                  `point-sprite tint watchdog expired after ${timeoutMs} ms`,
                ),
                cleanupError,
              ],
              "point-sprite tint watchdog cleanup failed",
            );
            aggregate.pointSpriteTintWatchdog = {
              timeoutMs,
              cleanupComplete: false,
            };
            reject(aggregate);
            return;
          }
          const error = new Error(
            timeoutEvidence?.cleanupComplete
              ? `point-sprite tint watchdog expired after ${timeoutMs} ms`
              : `point-sprite tint watchdog expired after ${timeoutMs} ms and cleanup remained unproven`,
          );
          error.pointSpriteTintWatchdog = { timeoutMs, ...timeoutEvidence };
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function createBackendSession(context, renderer, base, owned) {
  owned.phase = `${renderer}:page`;
  const page = await context.newPage();
  owned.pages.add(page);
  const servedEntryPromise = captureServedEntryIdentity(page, renderer, base);
  const consoleErrors = attachConsoleErrorGate(page);
  const externalRequests = [];
  await page.addInitScript(errorGateInit);
  page.on("request", (request) => {
    owned.pending.add(request);
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
  page.on("requestfinished", (request) => owned.pending.delete(request));
  page.on("requestfailed", (request) => owned.pending.delete(request));

  owned.phase = `${renderer}:navigate`;
  await page.goto(
    `${base.href.replace(/\/$/u, "")}/Apps/CesiumViewer/index.html?renderer=${renderer}&offline=true`,
    { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS },
  );
  await page.waitForFunction(() => Boolean(window.viewer), null, {
    timeout: NAVIGATION_TIMEOUT_MS,
  });
  const armResult =
    renderer === "webgpu"
      ? await armWebGPUDevices(page)
      : { armed: 0, found: 0, total: 0 };
  owned.phase = `${renderer}:setup`;
  const dates = [
    "2018-07-19T15:18:00Z",
    "2018-07-19T15:18:00.5Z",
    "2018-07-19T15:18:01Z",
    "2018-07-19T15:18:01.5Z",
    "2018-07-19T15:18:02Z",
    "2018-07-19T15:18:02.5Z",
  ];
  const uris = [0, 1, 2, 3, 4].map(
    (index) =>
      `/Apps/SampleData/Cesium3DTiles/PointCloud/PointCloudTimeDynamic/${index}.pnts`,
  );
  const runtime = await withOperationTimeout(
    () =>
      page.evaluate(initializePointSpritePage, {
        renderer,
        dates,
        uris,
      }),
    PAGE_INITIALIZATION_TIMEOUT_MS,
    `${renderer} point-sprite page initialization`,
  );
  const servedEntry = await awaitServedEntryIdentity(
    servedEntryPromise,
    renderer,
  );
  return {
    renderer,
    page,
    consoleErrors,
    externalRequests,
    armResult,
    runtime,
    servedEntry,
    captures: [],
    diagnostics: null,
  };
}

async function acquireBothBackends(browser, options, owned) {
  const result = {
    sessions: [],
    cleanup: { complete: false },
    sessionCounters: { browserLaunches: 1, contexts: 1, pages: 0 },
  };
  let context;
  try {
    owned.phase = "context";
    context = await withOperationTimeout(
      () =>
        browser.newContext({
          viewport: {
            width: POINT_SPRITE_TINT_REPEAT_CONFIG.width,
            height: POINT_SPRITE_TINT_REPEAT_CONFIG.height,
          },
          deviceScaleFactor: 1,
        }),
      CONTEXT_CREATION_TIMEOUT_MS,
      "point-sprite browser context creation",
    );
    owned.context = context;
    for (const renderer of RENDERERS) {
      result.sessions.push(
        await withOperationTimeout(
          () => createBackendSession(context, renderer, options.base, owned),
          BACKEND_INITIALIZATION_TIMEOUT_MS,
          `${renderer} backend initialization`,
        ),
      );
    }
    result.sessionCounters.pages = result.sessions.length;

    for (
      let repeat = 0;
      repeat < POINT_SPRITE_TINT_REPEAT_CONFIG.repeatCount;
      repeat++
    ) {
      for (const session of result.sessions) {
        owned.phase = `${session.renderer}:capture-${repeat}`;
        session.captures.push(
          await capturePointSpriteRepeat(session.page, repeat),
        );
      }
    }

    for (const session of result.sessions) {
      owned.phase = `${session.renderer}:diagnostics`;
      const diagnostics = await withOperationTimeout(
        async () => {
          const gpuGate = await collectGateErrors(session.page);
          const runtimeErrors = await session.page.evaluate(
            () => window.__pointSpriteTintRuntimeErrors?.slice() ?? [],
          );
          return { gpuGate, runtimeErrors };
        },
        DIAGNOSTICS_TIMEOUT_MS,
        `${session.renderer} point-sprite diagnostics`,
      );
      const { gpuGate, runtimeErrors } = diagnostics;
      session.runtime.gpuGateArmedDevices = gpuGate.armedDevices;
      session.diagnostics = {
        gpuGate,
        armResult: session.armResult,
        runtimeErrors,
        externalRequests: [...new Set(session.externalRequests)].sort(),
        pendingRequestsBeforeClose: owned.pending.size,
      };
    }
    return result;
  } finally {
    owned.phase = "browser-cleanup";
    const pageCloses = [];
    for (const session of result.sessions) {
      const pageClose = await closeBounded(
        session.page,
        `${session.renderer} page`,
        SESSION_CLOSE_TIMEOUT_MS,
      );
      pageCloses.push(pageClose);
      if (pageClose.closed) owned.pages.delete(session.page);
    }
    const contextClose = await closeBounded(
      context,
      "fleet context",
      SESSION_CLOSE_TIMEOUT_MS,
    );
    if (contextClose.closed && owned.context === context) {
      owned.context = undefined;
    }
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
    // The literal finally close is both the source-contract anchor and the
    // last reclamation attempt. The process fuse remains armed if it wedges.
    if (!browserClose.closed && owned.browser === browser) {
      try {
        await withOperationTimeout(
          async () => await browser.close(),
          BROWSER_CLOSE_TIMEOUT_MS,
          "last-resort browser close",
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
    const pendingRequests = owned.pending.size;
    result.cleanup = {
      pageCloses,
      contextClose,
      browserClose,
      lastResortClose,
      pendingRequests,
      complete:
        pageCloses.length === 2 &&
        pageCloses.every((entry) => entry.closed) &&
        contextClose.closed &&
        browserClose.closed &&
        pendingRequests === 0,
    };
  }
}

async function persistAndSummarizeCaptures(
  paths,
  acquisition,
  images,
  operations = fs,
) {
  const byRenderer = Object.fromEntries(
    acquisition.sessions.map((session) => [session.renderer, session]),
  );
  const decoded = { webgl: [], webgpu: [] };
  for (const renderer of RENDERERS) {
    const session = byRenderer[renderer];
    images[renderer] = [];
    for (let repeat = 0; repeat < session.captures.length; repeat++) {
      const capture = session.captures[repeat];
      const bytes = pngBytes(capture.dataUrl, `${renderer}/repeat-${repeat}`);
      const file = path.join(
        paths.directory,
        `${renderer}-repeat-${String(repeat + 1).padStart(2, "0")}.png`,
      );
      if (path.dirname(file) !== paths.directory) {
        throw new Error(
          `${renderer}/repeat-${repeat} escaped the run directory`,
        );
      }
      const reread = writeOnceExact(
        file,
        bytes,
        `${renderer}/repeat-${repeat}`,
        operations,
      );
      const record = {
        repeat,
        file: path.basename(file),
        bytes: reread.length,
        sha256: sha256(reread),
        rgbaRederived: false,
      };
      images[renderer].push(record);
      const image = await decodePngRgba(reread, `${renderer}/repeat-${repeat}`);
      decoded[renderer].push(image);
      record.rgbaRederived = true;
    }
  }

  const samples = [];
  for (
    let repeat = 0;
    repeat < POINT_SPRITE_TINT_REPEAT_CONFIG.repeatCount;
    repeat++
  ) {
    const summary = summarizePointSpriteRawDs4Pair(
      decoded.webgl[repeat],
      decoded.webgpu[repeat],
    );
    samples.push({
      index: repeat,
      ...summary,
      captureFrames: {
        webgl: {
          before: byRenderer.webgl.captures[repeat].before,
          after: byRenderer.webgl.captures[repeat].after,
          sequence: byRenderer.webgl.captures[repeat].sequence,
        },
        webgpu: {
          before: byRenderer.webgpu.captures[repeat].before,
          after: byRenderer.webgpu.captures[repeat].after,
          sequence: byRenderer.webgpu.captures[repeat].sequence,
        },
      },
    });
  }
  return { images, samples };
}

function sessionArtifact(session) {
  return {
    renderer: session.renderer,
    servedEntry: session.servedEntry,
    runtime: session.runtime,
    captures: session.captures.map(({ before, after, sequence }) => ({
      before,
      after,
      sequence,
    })),
    diagnostics: session.diagnostics,
  };
}

function emptyEvaluationInput(
  captureContract,
  harnessErrors,
  cleanup,
  provenance,
) {
  return {
    schema: POINT_SPRITE_TINT_REPEAT_SCHEMA,
    captureContract: { ...captureContract, writeOnce: true },
    cleanup,
    provenance,
    harnessErrors,
    session: { browserLaunches: 0, contexts: 0, pages: 0 },
    runtime: { webgl: null, webgpu: null },
    samples: [],
  };
}

export async function runPointSpriteTintRepeatProbe(options = {}) {
  const operations = options.operations ?? fs;
  const runId = options.runId ?? randomUUID();
  const paths = createRunPaths(runId, options.outputRoot);
  prepareRunDirectory(paths, operations);
  const startedAt = new Date().toISOString();
  const source = operations.readFileSync(probeSourcePath, "utf8");
  const capturePreflight = inspectPointSpriteTintCaptureContract(source);
  const localEntry = fingerprintEvidenceFile(buildEntryPath, operations);
  const localEntryValidation = validateServedEntryIdentities({
    entries: [],
    expectedLabels: [],
    localEntry,
  });
  let servedEntryIdentity = validateServedEntryIdentities({
    entries: [],
    expectedLabels: RENDERERS,
    localEntry,
  });
  const owned = {
    browser: undefined,
    context: undefined,
    pages: new Set(),
    pending: new Set(),
    phase: "preflight",
  };
  let artifact;
  const imageRecords = {};
  let quiescent = true;
  try {
    if (
      capturePreflight.failures.length > 0 ||
      localEntryValidation.ok !== true
    ) {
      const evaluation = evaluatePointSpriteTintRepeat(
        emptyEvaluationInput(
          capturePreflight,
          [],
          { complete: true },
          { localEntry, servedEntryIdentity },
        ),
      );
      artifact = {
        schema: POINT_SPRITE_TINT_REPEAT_SCHEMA,
        runId,
        startedAt,
        completedAt: new Date().toISOString(),
        captureContract: { ...capturePreflight, writeOnce: true },
        provenance: { localEntry, servedEntryIdentity },
        evaluation,
        images: {},
        sessions: [],
        cleanup: { complete: true },
        notMeasured: [
          "point shape or raw pixel mismatch",
          "attenuation-only and point-primitive scenes",
          "other point-cloud frames",
          "cross-process or long-duration drift",
          "the rendering stage responsible for a tint",
        ],
      };
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
      const acquisition = await withPointSpriteTintWatchdog(
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
        owned.pages.size === 0 &&
        owned.pending.size === 0;
      servedEntryIdentity = validateServedEntryIdentities({
        entries: acquisition.sessions.map((session) => session.servedEntry),
        expectedLabels: RENDERERS,
        localEntry,
      });
      const byRenderer = Object.fromEntries(
        acquisition.sessions.map((session) => [session.renderer, session]),
      );
      const harnessErrors = acquisition.sessions.flatMap((session) => [
        ...session.consoleErrors,
        ...(session.diagnostics?.gpuGate?.errors ?? []),
        ...(session.diagnostics?.gpuGate?.deviceLost
          ? [session.diagnostics.gpuGate.deviceLost]
          : []),
        ...(session.diagnostics?.runtimeErrors ?? []),
        ...(session.diagnostics?.externalRequests ?? []).map(
          (url) => `non-loopback request escaped offline scene: ${url}`,
        ),
      ]);
      // Capture bytes cannot become scoreable evidence until the served build
      // entry has been proven identical to the on-disk build.
      const persisted =
        servedEntryIdentity.ok === true
          ? await persistAndSummarizeCaptures(
              paths,
              acquisition,
              imageRecords,
              operations,
            )
          : { images: {}, samples: [] };
      const evaluation = evaluatePointSpriteTintRepeat({
        schema: POINT_SPRITE_TINT_REPEAT_SCHEMA,
        captureContract: { ...capturePreflight, writeOnce: true },
        cleanup: acquisition.cleanup,
        provenance: { localEntry, servedEntryIdentity },
        harnessErrors,
        session: acquisition.sessionCounters,
        runtime: {
          webgl: byRenderer.webgl?.runtime,
          webgpu: byRenderer.webgpu?.runtime,
        },
        samples: persisted.samples,
      });
      artifact = {
        schema: POINT_SPRITE_TINT_REPEAT_SCHEMA,
        runId,
        startedAt,
        completedAt: new Date().toISOString(),
        status: evaluation.status,
        exitCode: evaluation.exitCode,
        captureContract: { ...capturePreflight, writeOnce: true },
        provenance: { localEntry, servedEntryIdentity },
        evaluation,
        images: persisted.images,
        sessions: acquisition.sessions.map(sessionArtifact),
        cleanup: acquisition.cleanup,
        notMeasured: [
          "point shape or raw pixel mismatch",
          "attenuation-only and point-primitive scenes",
          "other point-cloud frames",
          "cross-process or long-duration drift",
          "the rendering stage responsible for a tint",
        ],
      };
    }
  } catch (error) {
    let terminalCleanup;
    let cleanupError;
    try {
      terminalCleanup = await cleanupOwned(owned);
      quiescent =
        terminalCleanup.cleanupComplete === true &&
        !owned.browser &&
        !owned.context &&
        owned.pages.size === 0;
    } catch (value) {
      quiescent = false;
      cleanupError = serializeError(value);
    }
    const harnessErrors = [
      serializeError(error),
      ...(cleanupError ? [cleanupError] : []),
    ];
    const evaluation = evaluatePointSpriteTintRepeat(
      emptyEvaluationInput(
        capturePreflight,
        harnessErrors,
        {
          complete: terminalCleanup?.cleanupComplete === true,
        },
        {
          localEntry,
          servedEntryIdentity,
        },
      ),
    );
    artifact = {
      schema: POINT_SPRITE_TINT_REPEAT_SCHEMA,
      runId,
      startedAt,
      completedAt: new Date().toISOString(),
      status: evaluation.status,
      exitCode: evaluation.exitCode,
      captureContract: { ...capturePreflight, writeOnce: true },
      provenance: { localEntry, servedEntryIdentity },
      evaluation,
      images: imageRecords,
      sessions: [],
      cleanup: terminalCleanup ?? { complete: false },
      notMeasured: [
        "point shape or raw pixel mismatch",
        "attenuation-only and point-primitive scenes",
        "other point-cloud frames",
        "cross-process or long-duration drift",
        "the rendering stage responsible for a tint",
      ],
    };
  }

  if (!artifact.status) {
    artifact.status = artifact.evaluation.status;
    artifact.exitCode = artifact.evaluation.exitCode;
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
    "Usage: node Tools/visual-regression/probe-point-sprite-tint-repeat.mjs " +
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
  // The process fuse is the final bound when a GPU or browser operation stops
  // returning to the event loop. It stays armed until publication is complete.
  const processWatchdog = setTimeout(() => {
    console.error(
      `[point-sprite-tint-repeat] process watchdog fired after ${PROCESS_WATCHDOG_MS} ms`,
    );
    process.exit(exitCodeForS5Status("ERROR"));
  }, PROCESS_WATCHDOG_MS);
  processWatchdog.unref?.();
  let quiescent = false;
  try {
    const result = await runPointSpriteTintRepeatProbe(
      parseArguments(process.argv.slice(2)),
    );
    quiescent = result.quiescent === true;
    console.log(
      JSON.stringify(
        {
          status: result.artifact.status,
          exitCode: result.artifact.exitCode,
          runId: result.artifact.runId,
          gains: result.artifact.evaluation.samples.map(
            (sample) => sample.gains,
          ),
          monotone: result.artifact.evaluation.channelSequences.map(
            ({ name, direction }) => ({ name, direction }),
          ),
          evidence: result.publication,
        },
        null,
        2,
      ),
    );
    process.exitCode = exitCodeForS5Status(result.artifact.status);
  } catch (error) {
    console.error("[point-sprite-tint-repeat] uncaught probe failure", error);
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
