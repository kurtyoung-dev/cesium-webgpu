#!/usr/bin/env node
/**
 * C12-33-SHIMMER-ENVELOPE-CERTIFICATION in real Microsoft Edge.
 * @purpose C12-33 paired normal/force-lod0 motion-shimmer envelope, seam-image review, and WebGL/WebGPU parity; does not claim observed mip or texture-LOD selection.
 * @status ACTIVE
 *
 * This is deliberately a moving visual lane, not an idle soak. Both viewers
 * stay on a pinned clock while the camera follows the Moon in its local frame.
 * Four routes cover a close view, the equirectangular seam at disc center, the
 * seam at the limb, and the historical ~16 px minification case. Every sample
 * is a Playwright CANVAS-ELEMENT PNG; no canvas readback is trusted.
 *
 * The probe records spatial high-frequency energy, adjacent-frame shimmer,
 * and matched-camera WebGL/WebGPU parity. Those quality metrics remain
 * explicitly INCONCLUSIVE until known-good and known-bad evidence supports
 * defensible thresholds. Structural failures (wrong renderer, incomplete mip
 * chains, an undrained WebGPU mip queue, a stationary camera, missing pixels,
 * shader/pick compilation failure, or browser/GPU faults) fail immediately.
 *
 * Usage:
 *   node Tools/visual-regression/probe-moon-mip-motion-edge.mjs
 *
 * Environment:
 *   PROBE_BASE=http://localhost:8080
 *   PROBE_HEADED=1
 *   C12_MOON_MIP_SAMPLES=13
 *   C12_MOON_MIP_CONTROL=normal|force-lod0
 *   C12_MOON_MIP_RUN_ID=pair-01-normal
 */

import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  parse,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import sharp from "sharp";
import {
  armWebGPUDevices,
  attachConsoleErrorGate,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";
import { stableStringify } from "./lib/visual-gate-policy.mjs";

let activeInvocationRunId = null;
let activeInvocationControlMode = null;
let activeInvocationOutputPath = null;

// Machine-safety watchdog (Batch 861+ fleet sweep). A probe that wedges holds a
// headless Edge + GPU process alive indefinitely; `unref` keeps the timer from
// extending a healthy run. The timeout is itself evidence: it publishes an
// ERROR artifact before terminating so an orchestration failure cannot look
// like an absent or merely inconclusive run.
const WATCHDOG_MS = 900_000;
const watchdog = setTimeout(() => {
  const error = new Error(
    `[probe-moon-mip-motion-edge] watchdog fired after ${WATCHDOG_MS} ms`,
  );
  void emitFatalProbeArtifact(error, "WATCHDOG").finally(() => {
    console.error(error.message);
    // A watchdog firing is the harness failing to finish, not the product
    // failing its bar; leaving with 1 reported an apparatus timeout as a
    // measured red.
    process.exit(EXIT_CODES.HARNESS);
  });
}, WATCHDOG_MS);
watchdog.unref?.();

export const FIXED_TIME_ISO = "2026-07-02T16:22:00Z";
export const C12_33_SHIMMER_ENVELOPE_CERTIFICATION =
  "C12-33-SHIMMER-ENVELOPE-CERTIFICATION";
export const C12_33_DOES_NOT_MEASURE = Object.freeze([
  "observed mip or texture-LOD selection across camera motion",
]);
export const MOON_MIP_PREREGISTRATION_DESIGN_ID = "sign-test-v1";
export const C12_33_FILED_DESIGN_DISCREPANCY =
  "R-24 ordered a sixteen-cell ratio design with a pre-registered r; the shipped frozen design is the four-cell sign test with an absolute 1e-9 gate; this custody hash binds the shipped design; adopting the R-24 design requires implementing it AND a maintainer-supplied r, at which point designId bumps and the hash changes visibly.";
export const MOON_MIP_NUMERIC_IDENTITY_TOLERANCE = 1e-12;
export const PAIRED_SENSITIVITY_MINIMUM_EFFECT_MULTIPLIER = 1000;
export const PAIRED_SENSITIVITY_MINIMUM_EFFECT =
  MOON_MIP_NUMERIC_IDENTITY_TOLERANCE *
  PAIRED_SENSITIVITY_MINIMUM_EFFECT_MULTIPLIER;
export const PAIRED_SENSITIVITY_COMPARISON = ">=";

// The 0/1/2/3 verdict tiers, named.
//
// The inconclusive tier used to be 2, the code reserved for "the harness
// broke". It is not a harness fault: an uncalibrated threshold set or an
// unattested seam inspection means the lane could not see its subject, which
// the contract calls STRUCTURAL and gives 3. Sharing 2 with a genuine crash
// made a run that never measured anything read as a flaky one to every runner
// that scores by exit status, and left the watchdog — an actual harness fault —
// leaving with 1, where a product FAIL lives.
export const EXIT_CODES = Object.freeze({
  PASS: 0,
  FAIL: 1,
  HARNESS: 2,
  STRUCTURAL: 3,
});
export const MOON_MIP_CONTROL_MODES = Object.freeze(["normal", "force-lod0"]);
export const MOON_MIP_SAMPLE_COUNT = 13;

// Calibrate only from multiple known-good runs plus a deliberately broken
// mip-0 control. Until then, raw metrics are evidence, not promotion limits.
export const CALIBRATED_THRESHOLDS = null;

export const MANUAL_INSPECTION_REQUIREMENT = Object.freeze({
  required: true,
  status: "PENDING",
  requiredLaneIds: Object.freeze(["seam-centered", "seam-at-limb"]),
  checks: Object.freeze([
    "Inspect the seam-centered sequence for a center-line discontinuity, blur, halo, or crawling line.",
    "Inspect every seam-at-limb sample for limb-local flashes or a seam entering or leaving the silhouette.",
    "Compare matched WebGL and WebGPU captures without resampling the source PNGs.",
  ]),
  evidence: Object.freeze([]),
});

const BACKEND_IDS = Object.freeze(["webgl", "webgpu"]);
const RUNTIME_RESOURCE_DEFINITIONS = Object.freeze({
  adapter: Object.freeze({
    label: "split-view-adapter",
    localPath: "Apps/WebGPUTest/split-screen-comparison.html",
  }),
  bundle: Object.freeze({
    label: "cesium-global-bundle",
    localPath: "Build/CesiumUnminified/Cesium.js",
  }),
  index: Object.freeze({
    label: "cesium-module-index",
    localPath: "Build/CesiumUnminified/index.js",
  }),
  moonAlbedo: Object.freeze({
    label: "moon-albedo",
    localPath:
      "Build/CesiumUnminified/Assets/Textures/Moon/lroc_color_poles_2k.jpg",
  }),
  moonNormal: Object.freeze({
    label: "moon-normal",
    localPath: "Build/CesiumUnminified/Assets/Textures/Moon/ldem_normal_1k.png",
  }),
});
const ADAPTER_IDENTITY_KEYS = Object.freeze([
  "kind",
  "loadedCesiumScriptUrl",
  "globalCesiumObjectPresent",
  "globalMoonConstructorPresent",
  "webglMoonUsesGlobalConstructor",
  "webgpuMoonUsesGlobalConstructor",
  "distinctMoonInstances",
  "webglSceneUsesGlobalConstructor",
  "webgpuSceneUsesGlobalConstructor",
]);
const THRESHOLD_SCHEMA_VERSION = 1;
const BACKEND_TEMPORAL_THRESHOLD_KEYS = Object.freeze([
  "maxNormalizedMeanAbsoluteLumaDelta",
  "maxNormalizedP95PairLumaDelta",
  "maxNormalizedMeanHighPassDelta",
  "maxNormalizedP95HighPassDelta",
  "maxSpatialHighFrequencyCoefficientOfVariation",
]);
const BACKEND_SPATIAL_THRESHOLD_KEYS = Object.freeze([
  "minNormalizedSpatialHighFrequencyMean",
  "maxNormalizedSpatialHighFrequencyMean",
  "minNormalizedLaplacianEnergyMean",
  "maxNormalizedLaplacianEnergyMean",
]);
const PARITY_THRESHOLD_KEYS = Object.freeze([
  "minMaskIntersectionOverUnionMean",
  "maxNormalizedMeanAbsoluteLumaError",
  "maxNormalizedP95AbsoluteLumaError",
  "maxChangedPixelFractionMean",
]);

export const PAIRED_SENSITIVITY_METRICS = Object.freeze([
  "normalizedP95PairLumaDelta",
  "normalizedP95HighPassDelta",
  "spatialHighFrequencyCoefficientOfVariation",
  "normalizedSpatialHighFrequencyMean",
  "normalizedLaplacianEnergyMean",
]);

// C12-33 calibration authority is intentionally fixed in source. Callers may
// select a control mode for an invocation, but they cannot choose easier
// lanes, backends, or measurements when the ten-run calibration set is folded.
export const PAIRED_SENSITIVITY_REQUIREMENTS = Object.freeze([
  Object.freeze({
    laneId: "minified-16px",
    backend: "webgl",
    metric: "normalizedP95HighPassDelta",
  }),
  Object.freeze({
    laneId: "minified-16px",
    backend: "webgl",
    metric: "spatialHighFrequencyCoefficientOfVariation",
  }),
  Object.freeze({
    laneId: "minified-16px",
    backend: "webgpu",
    metric: "normalizedP95HighPassDelta",
  }),
  Object.freeze({
    laneId: "minified-16px",
    backend: "webgpu",
    metric: "spatialHighFrequencyCoefficientOfVariation",
  }),
]);

export const MOON_MIP_MOTION_LANES = Object.freeze([
  Object.freeze({
    id: "close",
    description: "near-side close detail; seam remains on the hidden side",
    localCameraDirection: Object.freeze([1, 0, 0]),
    targetDiscDiameterPx: 240,
    angularSweepRadians: 0.012,
    seamPlacement: "hidden",
  }),
  Object.freeze({
    id: "seam-centered",
    description: "equirectangular U seam crosses the center of the disc",
    localCameraDirection: Object.freeze([-1, 0, 0]),
    targetDiscDiameterPx: 240,
    angularSweepRadians: 0.012,
    seamPlacement: "center",
  }),
  Object.freeze({
    id: "seam-at-limb",
    description: "equirectangular U seam tracks the visible limb",
    localCameraDirection: Object.freeze([0, -1, 0]),
    targetDiscDiameterPx: 240,
    angularSweepRadians: 0.012,
    seamPlacement: "limb",
  }),
  Object.freeze({
    id: "minified-16px",
    description: "default-scale ~16 px disc under continuous camera motion",
    localCameraDirection: Object.freeze([1, 0, 0]),
    targetDiscDiameterPx: 16,
    angularSweepRadians: 0.04,
    seamPlacement: "hidden",
  }),
]);

/**
 * Return the complete source-frozen design document bound by report custody.
 * Object keys are canonicalized separately; array order remains declaration
 * order because lane and sensitivity-cell order are part of the design.
 */
export function moonMipPreregistrationDocument() {
  return {
    designId: MOON_MIP_PREREGISTRATION_DESIGN_ID,
    calibratedThresholds: CALIBRATED_THRESHOLDS,
    thresholdSchemaVersion: THRESHOLD_SCHEMA_VERSION,
    pairedSensitivityRequirements: PAIRED_SENSITIVITY_REQUIREMENTS.map(
      (requirement) => ({ ...requirement }),
    ),
    absoluteGate: {
      numericIdentityTolerance: MOON_MIP_NUMERIC_IDENTITY_TOLERANCE,
      multiplier: PAIRED_SENSITIVITY_MINIMUM_EFFECT_MULTIPLIER,
      minimumControlMinusNormal: PAIRED_SENSITIVITY_MINIMUM_EFFECT,
      comparison: PAIRED_SENSITIVITY_COMPARISON,
    },
    thresholdKeys: {
      temporal: [...BACKEND_TEMPORAL_THRESHOLD_KEYS],
      spatial: [...BACKEND_SPATIAL_THRESHOLD_KEYS],
      parity: [...PARITY_THRESHOLD_KEYS],
    },
    lanes: MOON_MIP_MOTION_LANES.map((lane) => ({
      ...lane,
      localCameraDirection: [...lane.localCameraDirection],
    })),
  };
}

export function canonicalMoonMipPreregistrationJson() {
  return stableStringify(moonMipPreregistrationDocument());
}

export function computeMoonMipPreregistrationSha256() {
  return sha256Bytes(
    Buffer.from(canonicalMoonMipPreregistrationJson(), "utf8"),
  );
}

export const MOON_MIP_PREREGISTRATION_SHA256 =
  computeMoonMipPreregistrationSha256();

const toolDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = resolve(toolDirectory, "..", "..");
function generatedRunId() {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
}

export function parseRunId(value = process.env.C12_MOON_MIP_RUN_ID) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }
  const normalized = String(value).trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,94}[A-Za-z0-9])?$/u.test(normalized)) {
    throw new Error(
      "C12_MOON_MIP_RUN_ID must be 1-96 path-safe letters, digits, dots, underscores, or hyphens",
    );
  }
  return normalized;
}

function defaultOutputPath(controlMode, runId) {
  return resolve(
    toolDirectory,
    "output",
    "performance",
    `campaign12-c12-33-moon-mip-motion-edge-${controlMode}-${runId}.json`,
  );
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function portableRepositoryPath(path) {
  const portable = relative(repositoryDirectory, path).replaceAll("\\", "/");
  if (
    portable.length === 0 ||
    portable === ".." ||
    portable.startsWith("../") ||
    isAbsolute(portable)
  ) {
    throw new Error(`path is outside the repository: ${path}`);
  }
  return portable;
}

export function portableEvidencePath(outputPath, evidencePath) {
  const portable = relative(dirname(outputPath), evidencePath).replaceAll(
    "\\",
    "/",
  );
  if (
    portable.length === 0 ||
    portable === ".." ||
    portable.startsWith("../") ||
    isAbsolute(portable)
  ) {
    throw new Error(
      `evidence path must remain beneath the report directory: ${evidencePath}`,
    );
  }
  return portable;
}

export function isPortableEvidencePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !value.includes("\\") &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:/u.test(value) &&
    posix.normalize(value) === value &&
    value
      .split("/")
      .every(
        (component) =>
          component !== "." && component !== ".." && component !== "",
      )
  );
}

async function mkdirWithoutSymbolicAncestors(directory) {
  const canonical = resolve(directory);
  const root = parse(canonical).root;
  const components = relative(root, canonical).split(sep).filter(Boolean);
  let current = root;
  let missing = false;
  for (const component of components) {
    current = join(current, component);
    if (missing) {
      continue;
    }
    try {
      const descriptor = await lstat(current, { bigint: true });
      if (descriptor.isSymbolicLink()) {
        throw new Error(
          `symbolic output ancestor is forbidden before mkdir: ${current}`,
        );
      }
      if (!descriptor.isDirectory()) {
        throw new Error(`output ancestor is not a directory: ${current}`);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      missing = true;
    }
  }
  await mkdir(canonical, { recursive: true });
  current = root;
  for (const component of components) {
    current = join(current, component);
    const descriptor = await lstat(current, { bigint: true });
    if (descriptor.isSymbolicLink() || !descriptor.isDirectory()) {
      throw new Error(`output directory topology is unsafe: ${current}`);
    }
  }
  if (resolve(await realpath(canonical)) !== canonical) {
    throw new Error("output directory topology is not canonical");
  }
}

async function emitFatalProbeArtifact(error, failureKind = "ERROR") {
  let controlMode = activeInvocationControlMode ?? "invalid-control";
  if (activeInvocationControlMode === null) {
    try {
      controlMode = parseControlMode();
    } catch (_controlError) {
      // The originating failure remains authoritative in result.failures.
    }
  }
  let runId = activeInvocationRunId ?? generatedRunId();
  if (activeInvocationRunId === null) {
    try {
      runId = parseRunId() ?? runId;
    } catch (_runIdError) {
      // The originating failure remains authoritative in result.failures.
    }
  }
  const outputPath =
    activeInvocationOutputPath ??
    resolve(process.argv[2] ?? defaultOutputPath(controlMode, runId));
  const fatalReport = {
    schemaVersion: 1,
    campaign: "C12-33",
    probe: "probe-moon-mip-motion-edge",
    certificationClaim: C12_33_SHIMMER_ENVELOPE_CERTIFICATION,
    doesNotMeasure: [...C12_33_DOES_NOT_MEASURE],
    designId: MOON_MIP_PREREGISTRATION_DESIGN_ID,
    preregistrationSha256: MOON_MIP_PREREGISTRATION_SHA256,
    filedDiscrepancy: C12_33_FILED_DESIGN_DISCREPANCY,
    runId,
    capturedAt: new Date().toISOString(),
    status: "ERROR",
    exitCode: EXIT_CODES.FAIL,
    certificationEligible: false,
    measurementStatus: "FATAL_FAIL",
    failureKind,
    requestedControlMode: process.env.C12_MOON_MIP_CONTROL ?? "normal",
    result: {
      verdict: "FAIL",
      exitCode: EXIT_CODES.FAIL,
      failures: [String(error?.stack ?? error)],
      inconclusive: [],
    },
  };
  try {
    await mkdirWithoutSymbolicAncestors(dirname(outputPath));
    await writeFile(outputPath, `${JSON.stringify(fatalReport, null, 2)}\n`, {
      flag: "wx",
    });
  } catch (_writeError) {
    // Never clobber an existing evidence artifact. The original failure is
    // still emitted to stderr by the caller.
  }
  return fatalReport;
}

function exactObjectKeys(value, requiredKeys, path, failures) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failures.push(`${path} must be an object`);
    return false;
  }
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...requiredKeys].sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    failures.push(
      `${path} keys must be exactly ${expectedKeys.join(", ")}; received ${actualKeys.join(", ") || "none"}`,
    );
    return false;
  }
  return true;
}

function validateFiniteThreshold(value, path, failures, maximum = Infinity) {
  if (!Number.isFinite(value) || value < 0 || value > maximum) {
    failures.push(
      `${path} must be a finite number in [0, ${Number.isFinite(maximum) ? maximum : "Infinity"}]`,
    );
  }
}

/**
 * Validate the complete per-lane/per-backend threshold document. A non-null
 * threshold object is promotion authority, so missing, misspelled, or
 * non-finite fields fail closed instead of silently disabling a comparison.
 */
export function validateCalibratedThresholds(thresholds) {
  if (thresholds === null) {
    return [];
  }
  const failures = [];
  if (
    !exactObjectKeys(
      thresholds,
      ["schemaVersion", "lanes"],
      "thresholds",
      failures,
    )
  ) {
    return failures;
  }
  if (thresholds.schemaVersion !== THRESHOLD_SCHEMA_VERSION) {
    failures.push(
      `thresholds.schemaVersion must equal ${THRESHOLD_SCHEMA_VERSION}`,
    );
  }

  const requiredLaneIds = MOON_MIP_MOTION_LANES.map((lane) => lane.id);
  if (
    !exactObjectKeys(
      thresholds.lanes,
      requiredLaneIds,
      "thresholds.lanes",
      failures,
    )
  ) {
    return failures;
  }
  for (const laneId of requiredLaneIds) {
    const lane = thresholds.lanes[laneId];
    if (
      !exactObjectKeys(
        lane,
        [...BACKEND_IDS, "parity"],
        `thresholds.lanes.${laneId}`,
        failures,
      )
    ) {
      continue;
    }
    for (const backend of BACKEND_IDS) {
      const backendThresholds = lane[backend];
      if (
        !exactObjectKeys(
          backendThresholds,
          ["temporal", "spatial"],
          `thresholds.lanes.${laneId}.${backend}`,
          failures,
        )
      ) {
        continue;
      }
      if (
        exactObjectKeys(
          backendThresholds.temporal,
          BACKEND_TEMPORAL_THRESHOLD_KEYS,
          `thresholds.lanes.${laneId}.${backend}.temporal`,
          failures,
        )
      ) {
        for (const key of BACKEND_TEMPORAL_THRESHOLD_KEYS) {
          validateFiniteThreshold(
            backendThresholds.temporal[key],
            `thresholds.lanes.${laneId}.${backend}.temporal.${key}`,
            failures,
          );
        }
      }
      if (
        exactObjectKeys(
          backendThresholds.spatial,
          BACKEND_SPATIAL_THRESHOLD_KEYS,
          `thresholds.lanes.${laneId}.${backend}.spatial`,
          failures,
        )
      ) {
        for (const key of BACKEND_SPATIAL_THRESHOLD_KEYS) {
          validateFiniteThreshold(
            backendThresholds.spatial[key],
            `thresholds.lanes.${laneId}.${backend}.spatial.${key}`,
            failures,
          );
        }
        if (
          backendThresholds.spatial.minNormalizedSpatialHighFrequencyMean >
          backendThresholds.spatial.maxNormalizedSpatialHighFrequencyMean
        ) {
          failures.push(
            `thresholds.lanes.${laneId}.${backend}.spatial spatial high-frequency minimum exceeds its maximum`,
          );
        }
        if (
          backendThresholds.spatial.minNormalizedLaplacianEnergyMean >
          backendThresholds.spatial.maxNormalizedLaplacianEnergyMean
        ) {
          failures.push(
            `thresholds.lanes.${laneId}.${backend}.spatial laplacian minimum exceeds its maximum`,
          );
        }
      }
    }

    if (
      exactObjectKeys(
        lane.parity,
        PARITY_THRESHOLD_KEYS,
        `thresholds.lanes.${laneId}.parity`,
        failures,
      )
    ) {
      validateFiniteThreshold(
        lane.parity.minMaskIntersectionOverUnionMean,
        `thresholds.lanes.${laneId}.parity.minMaskIntersectionOverUnionMean`,
        failures,
        1,
      );
      validateFiniteThreshold(
        lane.parity.maxChangedPixelFractionMean,
        `thresholds.lanes.${laneId}.parity.maxChangedPixelFractionMean`,
        failures,
        1,
      );
      for (const key of [
        "maxNormalizedMeanAbsoluteLumaError",
        "maxNormalizedP95AbsoluteLumaError",
      ]) {
        validateFiniteThreshold(
          lane.parity[key],
          `thresholds.lanes.${laneId}.parity.${key}`,
          failures,
        );
      }
    }
  }
  return failures;
}

function mean(values) {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values, fraction) {
  if (values.length === 0) {
    return null;
  }
  const ordered = values.slice().sort((left, right) => left - right);
  const index = Math.min(
    ordered.length - 1,
    Math.max(0, Math.ceil(fraction * ordered.length) - 1),
  );
  return ordered[index];
}

function standardDeviation(values, average = mean(values)) {
  if (values.length === 0 || average === null) {
    return null;
  }
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
      values.length,
  );
}

function rounded(value, digits = 6) {
  if (!Number.isFinite(value)) {
    return null;
  }
  return Number(value.toFixed(digits));
}

function luminance(data, offset) {
  return (
    0.2126 * data[offset] +
    0.7152 * data[offset + 1] +
    0.0722 * data[offset + 2]
  );
}

/**
 * Analyze decoded compositor pixels. Underscore-prefixed arrays are retained
 * only for pairwise metrics and are stripped before JSON serialization.
 */
export function analyzeRgbaFrame({ data, width, height }) {
  if (!data || data.length !== width * height * 4) {
    throw new Error("RGBA frame dimensions do not match its byte length");
  }

  const pixelCount = width * height;
  const luma = new Float64Array(pixelCount);
  const mask = new Uint8Array(pixelCount);
  let coveredPixels = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let coveredLuminance = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = y * width + x;
      const offset = pixel * 4;
      const value = luminance(data, offset);
      luma[pixel] = value;
      // The probe disables globe, skybox, atmosphere, and sun-disc rendering,
      // leaving an exact black background around the illuminated Moon.
      if (
        data[offset + 3] > 0 &&
        Math.max(data[offset], data[offset + 1], data[offset + 2]) > 10
      ) {
        mask[pixel] = 1;
        coveredPixels++;
        coveredLuminance += value;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  const visited = new Uint8Array(pixelCount);
  const componentStack = new Int32Array(coveredPixels);
  let principalComponentPixels = 0;
  let principalComponentBounds = null;
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    if (mask[pixel] === 0 || visited[pixel] !== 0) {
      continue;
    }

    let stackLength = 1;
    componentStack[0] = pixel;
    visited[pixel] = 1;
    let componentPixels = 0;
    let componentMinX = width;
    let componentMinY = height;
    let componentMaxX = -1;
    let componentMaxY = -1;
    while (stackLength > 0) {
      const current = componentStack[--stackLength];
      const x = current % width;
      const y = (current - x) / width;
      componentPixels++;
      componentMinX = Math.min(componentMinX, x);
      componentMinY = Math.min(componentMinY, y);
      componentMaxX = Math.max(componentMaxX, x);
      componentMaxY = Math.max(componentMaxY, y);

      if (x > 0 && mask[current - 1] !== 0 && visited[current - 1] === 0) {
        visited[current - 1] = 1;
        componentStack[stackLength++] = current - 1;
      }
      if (
        x + 1 < width &&
        mask[current + 1] !== 0 &&
        visited[current + 1] === 0
      ) {
        visited[current + 1] = 1;
        componentStack[stackLength++] = current + 1;
      }
      if (
        y > 0 &&
        mask[current - width] !== 0 &&
        visited[current - width] === 0
      ) {
        visited[current - width] = 1;
        componentStack[stackLength++] = current - width;
      }
      if (
        y + 1 < height &&
        mask[current + width] !== 0 &&
        visited[current + width] === 0
      ) {
        visited[current + width] = 1;
        componentStack[stackLength++] = current + width;
      }
    }

    if (componentPixels > principalComponentPixels) {
      principalComponentPixels = componentPixels;
      principalComponentBounds = Object.freeze({
        minX: componentMinX,
        minY: componentMinY,
        maxX: componentMaxX,
        maxY: componentMaxY,
        width: componentMaxX - componentMinX + 1,
        height: componentMaxY - componentMinY + 1,
      });
    }
  }

  let gradientSum = 0;
  let laplacianSum = 0;
  let interiorLuminance = 0;
  let interiorPixels = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const pixel = y * width + x;
      if (
        mask[pixel] === 0 ||
        mask[pixel - 1] === 0 ||
        mask[pixel + 1] === 0 ||
        mask[pixel - width] === 0 ||
        mask[pixel + width] === 0
      ) {
        continue;
      }
      const center = luma[pixel];
      const left = luma[pixel - 1];
      const right = luma[pixel + 1];
      const up = luma[pixel - width];
      const down = luma[pixel + width];
      gradientSum += Math.abs(right - center) + Math.abs(down - center);
      laplacianSum += Math.abs(4 * center - left - right - up - down);
      interiorLuminance += center;
      interiorPixels++;
    }
  }

  const meanInteriorLuminance =
    interiorPixels > 0 ? interiorLuminance / interiorPixels : 0;
  const gradientEnergy =
    interiorPixels > 0 ? gradientSum / (2 * interiorPixels) : 0;
  const laplacianEnergy =
    interiorPixels > 0 ? laplacianSum / interiorPixels : 0;
  const bounds =
    maxX >= minX
      ? Object.freeze({
          minX,
          minY,
          maxX,
          maxY,
          width: maxX - minX + 1,
          height: maxY - minY + 1,
        })
      : null;

  return {
    width,
    height,
    coveredPixels,
    strayLitPixels: coveredPixels - principalComponentPixels,
    principalComponentBounds,
    coveredFraction: coveredPixels / pixelCount,
    coveredMeanLuminance:
      coveredPixels > 0 ? coveredLuminance / coveredPixels : 0,
    interiorPixels,
    meanInteriorLuminance,
    gradientEnergy,
    laplacianEnergy,
    normalizedSpatialHighFrequency:
      gradientEnergy / Math.max(1, meanInteriorLuminance),
    normalizedLaplacianEnergy:
      laplacianEnergy / Math.max(1, meanInteriorLuminance),
    illuminatedBounds: bounds,
    discDiameterPx: bounds ? Math.max(bounds.width, bounds.height) : 0,
    _rgba: data,
    _luma: luma,
    _mask: mask,
  };
}

function assertComparableFrames(left, right) {
  if (left.width !== right.width || left.height !== right.height) {
    throw new Error(
      `frame dimensions differ (${left.width}x${left.height} vs ${right.width}x${right.height})`,
    );
  }
}

function temporalPair(left, right) {
  assertComparableFrames(left, right);
  const width = left.width;
  const height = left.height;
  const absoluteDeltas = [];
  const highPassDeltas = [];
  let lumaReference = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const pixel = y * width + x;
      const neighbors = [
        pixel,
        pixel - 1,
        pixel + 1,
        pixel - width,
        pixel + width,
      ];
      if (
        neighbors.some(
          (index) => left._mask[index] === 0 || right._mask[index] === 0,
        )
      ) {
        continue;
      }
      const leftValue = left._luma[pixel];
      const rightValue = right._luma[pixel];
      absoluteDeltas.push(Math.abs(rightValue - leftValue));
      lumaReference += 0.5 * (leftValue + rightValue);

      const leftHighPass =
        4 * leftValue -
        left._luma[pixel - 1] -
        left._luma[pixel + 1] -
        left._luma[pixel - width] -
        left._luma[pixel + width];
      const rightHighPass =
        4 * rightValue -
        right._luma[pixel - 1] -
        right._luma[pixel + 1] -
        right._luma[pixel - width] -
        right._luma[pixel + width];
      highPassDeltas.push(Math.abs(rightHighPass - leftHighPass));
    }
  }

  const reference = lumaReference / Math.max(1, absoluteDeltas.length);
  const meanAbsoluteLumaDelta = mean(absoluteDeltas) ?? 0;
  const meanHighPassDelta = mean(highPassDeltas) ?? 0;
  return {
    comparedPixels: absoluteDeltas.length,
    meanAbsoluteLumaDelta,
    p95AbsoluteLumaDelta: percentile(absoluteDeltas, 0.95) ?? 0,
    normalizedMeanAbsoluteLumaDelta:
      meanAbsoluteLumaDelta / Math.max(1, reference),
    meanHighPassDelta,
    normalizedMeanHighPassDelta: meanHighPassDelta / Math.max(1, reference),
  };
}

export function computeTemporalSeries(frames) {
  const pairs = [];
  for (let index = 1; index < frames.length; index++) {
    pairs.push(temporalPair(frames[index - 1], frames[index]));
  }
  const meanDeltas = pairs.map((pair) => pair.meanAbsoluteLumaDelta);
  const normalizedDeltas = pairs.map(
    (pair) => pair.normalizedMeanAbsoluteLumaDelta,
  );
  const normalizedHighPass = pairs.map(
    (pair) => pair.normalizedMeanHighPassDelta,
  );
  const spatialValues = frames.map(
    (frame) => frame.normalizedSpatialHighFrequency,
  );
  const spatialMean = mean(spatialValues) ?? 0;
  return {
    pairCount: pairs.length,
    comparedPixelsMin:
      pairs.length > 0
        ? Math.min(...pairs.map((pair) => pair.comparedPixels))
        : 0,
    meanAbsoluteLumaDelta: mean(meanDeltas) ?? 0,
    p95PairMeanAbsoluteLumaDelta: percentile(meanDeltas, 0.95) ?? 0,
    normalizedMeanAbsoluteLumaDelta: mean(normalizedDeltas) ?? 0,
    normalizedP95PairLumaDelta: percentile(normalizedDeltas, 0.95) ?? 0,
    normalizedMeanHighPassDelta: mean(normalizedHighPass) ?? 0,
    normalizedP95HighPassDelta: percentile(normalizedHighPass, 0.95) ?? 0,
    spatialHighFrequencyMean: spatialMean,
    spatialHighFrequencyP95: percentile(spatialValues, 0.95) ?? 0,
    spatialHighFrequencyCoefficientOfVariation:
      (standardDeviation(spatialValues, spatialMean) ?? 0) /
      Math.max(1e-9, spatialMean),
    pairs,
  };
}

function parityPair(webgl, webgpu) {
  assertComparableFrames(webgl, webgpu);
  let intersection = 0;
  let union = 0;
  let absoluteLuma = 0;
  let absoluteRgb = 0;
  let changed = 0;
  let referenceLuma = 0;
  const pixelCount = webgl.width * webgl.height;

  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const inWebgl = webgl._mask[pixel] !== 0;
    const inWebgpu = webgpu._mask[pixel] !== 0;
    if (inWebgl || inWebgpu) {
      union++;
    }
    if (!inWebgl || !inWebgpu) {
      continue;
    }
    intersection++;
    const offset = pixel * 4;
    const red = Math.abs(webgl._rgba[offset] - webgpu._rgba[offset]);
    const green = Math.abs(webgl._rgba[offset + 1] - webgpu._rgba[offset + 1]);
    const blue = Math.abs(webgl._rgba[offset + 2] - webgpu._rgba[offset + 2]);
    const lumaDelta = Math.abs(webgl._luma[pixel] - webgpu._luma[pixel]);
    absoluteRgb += (red + green + blue) / 3;
    absoluteLuma += lumaDelta;
    referenceLuma += 0.5 * (webgl._luma[pixel] + webgpu._luma[pixel]);
    if (red + green + blue > 36) {
      changed++;
    }
  }

  const reference = referenceLuma / Math.max(1, intersection);
  return {
    comparedPixels: intersection,
    maskIntersectionOverUnion: intersection / Math.max(1, union),
    meanAbsoluteRgbError: absoluteRgb / Math.max(1, intersection),
    meanAbsoluteLumaError: absoluteLuma / Math.max(1, intersection),
    normalizedMeanAbsoluteLumaError:
      absoluteLuma / Math.max(1, intersection) / Math.max(1, reference),
    changedPixelFraction: changed / Math.max(1, intersection),
    spatialHighFrequencyRatio:
      webgpu.normalizedSpatialHighFrequency /
      Math.max(1e-9, webgl.normalizedSpatialHighFrequency),
  };
}

export function computeParitySeries(webglFrames, webgpuFrames) {
  if (webglFrames.length !== webgpuFrames.length) {
    throw new Error("WebGL/WebGPU parity series lengths differ");
  }
  const samples = webglFrames.map((frame, index) =>
    parityPair(frame, webgpuFrames[index]),
  );
  const keyMean = (key) => mean(samples.map((sample) => sample[key])) ?? 0;
  return {
    sampleCount: samples.length,
    comparedPixelsMin:
      samples.length > 0
        ? Math.min(...samples.map((sample) => sample.comparedPixels))
        : 0,
    maskIntersectionOverUnionMean: keyMean("maskIntersectionOverUnion"),
    meanAbsoluteRgbError: keyMean("meanAbsoluteRgbError"),
    meanAbsoluteLumaError: keyMean("meanAbsoluteLumaError"),
    normalizedMeanAbsoluteLumaError: keyMean("normalizedMeanAbsoluteLumaError"),
    normalizedP95AbsoluteLumaError:
      percentile(
        samples.map((sample) => sample.normalizedMeanAbsoluteLumaError),
        0.95,
      ) ?? 0,
    changedPixelFractionMean: keyMean("changedPixelFraction"),
    spatialHighFrequencyRatioMean: keyMean("spatialHighFrequencyRatio"),
    samples,
  };
}

export function decideVerdict(
  hardFailures,
  qualityFailures,
  calibratedThresholds = CALIBRATED_THRESHOLDS,
  manualInspection = MANUAL_INSPECTION_REQUIREMENT,
) {
  const thresholdSchemaFailures = validateCalibratedThresholds(
    calibratedThresholds,
  ).map((failure) => `invalid calibrated-threshold schema: ${failure}`);
  if (
    manualInspection?.required !== true ||
    !["PENDING", "PASS", "FAIL"].includes(manualInspection?.status)
  ) {
    thresholdSchemaFailures.push(
      "mandatory Moon seam PNG inspection declaration is missing or invalid",
    );
  } else if (
    manualInspection.status === "PASS" &&
    (!Array.isArray(manualInspection.evidence) ||
      manualInspection.evidence.length === 0)
  ) {
    thresholdSchemaFailures.push(
      "mandatory Moon seam PNG inspection PASS lacks retained evidence",
    );
  }
  const allHardFailures = [...hardFailures, ...thresholdSchemaFailures];
  if (allHardFailures.length > 0) {
    return {
      verdict: "FAIL",
      exitCode: EXIT_CODES.FAIL,
      failures: allHardFailures,
      inconclusive: [],
    };
  }
  if (
    manualInspection?.required === true &&
    manualInspection.status === "FAIL"
  ) {
    return {
      verdict: "FAIL",
      exitCode: EXIT_CODES.FAIL,
      failures: ["mandatory Moon seam PNG inspection reported a failure"],
      inconclusive: [],
    };
  }
  if (calibratedThresholds === null) {
    return {
      verdict: "INCONCLUSIVE",
      exitCode: EXIT_CODES.STRUCTURAL,
      failures: [],
      inconclusive: [
        "Moon mip motion thresholds are intentionally uncalibrated; retain raw known-good and deliberately broken mip-0 evidence before promotion.",
      ],
    };
  }
  if (qualityFailures.length > 0) {
    return {
      verdict: "FAIL",
      exitCode: EXIT_CODES.FAIL,
      failures: qualityFailures,
      inconclusive: [],
    };
  }
  if (
    manualInspection?.required === true &&
    manualInspection.status !== "PASS"
  ) {
    return {
      verdict: "INCONCLUSIVE",
      exitCode: EXIT_CODES.STRUCTURAL,
      failures: [],
      inconclusive: [
        "Moon seam PNG inspection is mandatory and has not been attested PASS.",
      ],
    };
  }
  return {
    verdict: "PASS",
    exitCode: EXIT_CODES.PASS,
    failures: [],
    inconclusive: [],
  };
}

export function deriveMeasurementStatus(
  result,
  calibratedThresholds = CALIBRATED_THRESHOLDS,
  manualInspection = MANUAL_INSPECTION_REQUIREMENT,
) {
  if (result?.verdict === "FAIL") {
    return calibratedThresholds === null
      ? "STRUCTURAL_OR_MANUAL_FAIL"
      : "CALIBRATED_FAIL";
  }
  if (calibratedThresholds === null) {
    return "CALIBRATION_PENDING";
  }
  if (
    manualInspection?.required === true &&
    manualInspection.status !== "PASS"
  ) {
    return "MANUAL_INSPECTION_PENDING";
  }
  return result?.verdict === "PASS"
    ? "CALIBRATED_PASS"
    : "CALIBRATION_INCONCLUSIVE";
}

export function classifyRawReport(result) {
  const hardFailures = Array.isArray(result?.hardFailures)
    ? result.hardFailures
    : [];
  const qualityFailures = Array.isArray(result?.qualityFailures)
    ? result.qualityFailures
    : [];
  if (hardFailures.length > 0) {
    // A hard failure means the run never got a usable look at its subject, so
    // it leaves with the blindness tier. Reporting it as 1 put it in the same
    // bucket as a subject that was measured and missed its bar.
    return {
      status: "STRUCTURAL",
      exitCode: EXIT_CODES.STRUCTURAL,
      certificationEligible: false,
    };
  }
  if (qualityFailures.length > 0 || result?.verdict === "FAIL") {
    return {
      status: "FAIL",
      exitCode: EXIT_CODES.FAIL,
      certificationEligible: false,
    };
  }
  return {
    status: "NON_CERTIFYING",
    exitCode: EXIT_CODES.STRUCTURAL,
    certificationEligible: false,
  };
}

function publicFrameMetric(metric, pngPath, pngBuffer) {
  return {
    pngPath,
    pngSha256: createHash("sha256").update(pngBuffer).digest("hex"),
    width: metric.width,
    height: metric.height,
    coveredPixels: metric.coveredPixels,
    strayLitPixels: metric.strayLitPixels,
    principalComponentBounds: metric.principalComponentBounds,
    coveredFraction: rounded(metric.coveredFraction),
    coveredMeanLuminance: rounded(metric.coveredMeanLuminance),
    interiorPixels: metric.interiorPixels,
    meanInteriorLuminance: rounded(metric.meanInteriorLuminance),
    gradientEnergy: rounded(metric.gradientEnergy),
    laplacianEnergy: rounded(metric.laplacianEnergy),
    normalizedSpatialHighFrequency: rounded(
      metric.normalizedSpatialHighFrequency,
    ),
    normalizedLaplacianEnergy: rounded(metric.normalizedLaplacianEnergy),
    illuminatedBounds: metric.illuminatedBounds,
    discDiameterPx: metric.discDiameterPx,
  };
}

async function analyzePng(buffer) {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return analyzeRgbaFrame({
    data,
    width: info.width,
    height: info.height,
  });
}

function localPathForServedUrl(servedUrl, baseUrl) {
  const served = new URL(servedUrl, baseUrl);
  const base = new URL(baseUrl);
  if (served.origin !== base.origin) {
    throw new Error(
      `certifying runtime resource left the probe origin: ${served.href}`,
    );
  }
  const decodedPath = decodeURIComponent(served.pathname).replace(/^\/+/, "");
  const localPath = resolve(repositoryDirectory, decodedPath);
  portableRepositoryPath(localPath);
  return localPath;
}

async function matchedRuntimeResourceIdentity(label, servedUrl, baseUrl) {
  const canonicalUrl = new URL(servedUrl, baseUrl);
  const response = await fetch(canonicalUrl, {
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(
      `${label} served identity returned HTTP ${response.status}: ${canonicalUrl.href}`,
    );
  }
  const servedBytes = Buffer.from(await response.arrayBuffer());
  const localPath = localPathForServedUrl(canonicalUrl, baseUrl);
  const localBytes = await readFile(localPath);
  const servedSha256 = sha256Bytes(servedBytes);
  const localSha256 = sha256Bytes(localBytes);
  if (
    servedBytes.byteLength !== localBytes.byteLength ||
    servedSha256 !== localSha256
  ) {
    throw new Error(`${label} served bytes differ from the local repository`);
  }
  return {
    label,
    served: {
      url: canonicalUrl.href,
      byteLength: servedBytes.byteLength,
      sha256: servedSha256,
    },
    local: {
      path: portableRepositoryPath(localPath),
      byteLength: localBytes.byteLength,
      sha256: localSha256,
    },
    servedMatchesLocal: true,
  };
}

async function producerSourceIdentity() {
  const producerSourcePath = fileURLToPath(import.meta.url);
  const producerSourceBytes = await readFile(producerSourcePath);
  return {
    path: portableRepositoryPath(producerSourcePath),
    byteLength: producerSourceBytes.byteLength,
    sha256: sha256Bytes(producerSourceBytes),
  };
}

async function runtimeIdentity(baseUrl, viewerUrl, setup, producerSource) {
  const bundleUrl = setup?.adapterIdentity?.loadedCesiumScriptUrl;
  if (typeof bundleUrl !== "string" || bundleUrl.length === 0) {
    throw new Error(
      "split-view adapter did not expose its loaded Cesium bundle URL",
    );
  }
  const entries = {
    adapter: await matchedRuntimeResourceIdentity(
      "split-view-adapter",
      viewerUrl,
      baseUrl,
    ),
    bundle: await matchedRuntimeResourceIdentity(
      "cesium-global-bundle",
      bundleUrl,
      baseUrl,
    ),
    index: await matchedRuntimeResourceIdentity(
      "cesium-module-index",
      new URL("/Build/CesiumUnminified/index.js", baseUrl),
      baseUrl,
    ),
    moonAlbedo: await matchedRuntimeResourceIdentity(
      "moon-albedo",
      setup.albedoUrl,
      baseUrl,
    ),
    moonNormal: await matchedRuntimeResourceIdentity(
      "moon-normal",
      setup.normalUrl,
      baseUrl,
    ),
  };
  const adapterIdentity = setup.adapterIdentity;
  return {
    schemaVersion: 2,
    entries,
    adapterIdentity,
    producerSource,
    identitySha256: sha256Bytes(
      Buffer.from(
        JSON.stringify({ entries, adapterIdentity, producerSource }),
        "utf8",
      ),
    ),
  };
}

export function parseSampleCount(
  value = process.env.C12_MOON_MIP_SAMPLES ?? MOON_MIP_SAMPLE_COUNT,
) {
  const parsed = Number(value);
  if (parsed !== MOON_MIP_SAMPLE_COUNT) {
    throw new Error(
      `C12_MOON_MIP_SAMPLES must equal the pre-registered count ${MOON_MIP_SAMPLE_COUNT}`,
    );
  }
  return parsed;
}

export function parseControlMode(
  value = process.env.C12_MOON_MIP_CONTROL ?? "normal",
) {
  const normalized = String(value).trim().toLowerCase();
  if (!MOON_MIP_CONTROL_MODES.includes(normalized)) {
    throw new Error(
      `C12_MOON_MIP_CONTROL must be one of ${MOON_MIP_CONTROL_MODES.join(
        ", ",
      )}; received ${JSON.stringify(value)}`,
    );
  }
  return normalized;
}

export function summarizeSpatial(frames) {
  const diameters = frames.map((frame) => frame.discDiameterPx);
  const spatial = frames.map((frame) => frame.normalizedSpatialHighFrequency);
  const laplacian = frames.map((frame) => frame.normalizedLaplacianEnergy);
  return {
    discDiameterPxMedian: percentile(diameters, 0.5) ?? 0,
    discDiameterPxMin: diameters.length > 0 ? Math.min(...diameters) : 0,
    discDiameterPxMax: diameters.length > 0 ? Math.max(...diameters) : 0,
    normalizedSpatialHighFrequencyMean: mean(spatial) ?? 0,
    normalizedSpatialHighFrequencyP95: percentile(spatial, 0.95) ?? 0,
    normalizedLaplacianEnergyMean: mean(laplacian) ?? 0,
    normalizedLaplacianEnergyP95: percentile(laplacian, 0.95) ?? 0,
  };
}

export function cameraMotionSummary(motion, backend) {
  if (!Array.isArray(motion)) {
    return {
      stepCount: 0,
      totalDistanceMeters: Number.NaN,
      minStepDistanceMeters: Number.NaN,
      maxStepDistanceMeters: Number.NaN,
      frameAdvance: Number.NaN,
    };
  }
  const positions = motion.map(
    (sample) => sample?.[backend]?.cameraWorldPosition,
  );
  const validPositions = positions.every(
    (position) =>
      Array.isArray(position) &&
      position.length === 3 &&
      position.every(Number.isFinite),
  );
  const frameNumbers = motion.map((sample) => sample?.[backend]?.frameNumber);
  if (
    !validPositions ||
    frameNumbers.some((value) => !Number.isFinite(value))
  ) {
    return {
      stepCount: Math.max(0, motion.length - 1),
      totalDistanceMeters: Number.NaN,
      minStepDistanceMeters: Number.NaN,
      maxStepDistanceMeters: Number.NaN,
      frameAdvance: Number.NaN,
    };
  }
  const stepDistances = [];
  for (let index = 1; index < positions.length; index++) {
    const previous = positions[index - 1];
    const current = positions[index];
    stepDistances.push(
      Math.hypot(
        current[0] - previous[0],
        current[1] - previous[1],
        current[2] - previous[2],
      ),
    );
  }
  return {
    stepCount: stepDistances.length,
    totalDistanceMeters: stepDistances.reduce(
      (sum, distance) => sum + distance,
      0,
    ),
    minStepDistanceMeters:
      stepDistances.length > 0 ? Math.min(...stepDistances) : 0,
    maxStepDistanceMeters:
      stepDistances.length > 0 ? Math.max(...stepDistances) : 0,
    frameAdvance:
      motion.length > 1
        ? motion.at(-1)[backend].frameNumber - motion[0][backend].frameNumber
        : 0,
  };
}

function expectedCameraLocalDirection(lane, sampleIndex, sampleCount) {
  const fraction = sampleIndex / (sampleCount - 1);
  const angle = lane.angularSweepRadians * (2 * fraction - 1);
  const [x, y] = lane.localCameraDirection;
  const rotated = [
    x * Math.cos(angle) - y * Math.sin(angle),
    x * Math.sin(angle) + y * Math.cos(angle),
    0,
  ];
  const magnitude = Math.hypot(...rotated);
  return rotated.map((component) => component / magnitude);
}

function vectorDistance(left, right) {
  return Math.hypot(
    ...left.map((component, index) => component - right[index]),
  );
}

function numericSummaryMatches(
  actual,
  expected,
  keys,
  tolerance = MOON_MIP_NUMERIC_IDENTITY_TOLERANCE,
) {
  return keys.every(
    (key) =>
      Number.isFinite(actual?.[key]) &&
      Number.isFinite(expected?.[key]) &&
      Math.abs(actual[key] - expected[key]) <= tolerance,
  );
}

function recomputeTemporalSummary(frames, pairs) {
  const meanDeltas = pairs.map((pair) => pair.meanAbsoluteLumaDelta);
  const normalizedDeltas = pairs.map(
    (pair) => pair.normalizedMeanAbsoluteLumaDelta,
  );
  const normalizedHighPass = pairs.map(
    (pair) => pair.normalizedMeanHighPassDelta,
  );
  const spatialValues = frames.map(
    (frame) => frame.normalizedSpatialHighFrequency,
  );
  const spatialMean = mean(spatialValues) ?? 0;
  return {
    pairCount: pairs.length,
    comparedPixelsMin:
      pairs.length > 0
        ? Math.min(...pairs.map((pair) => pair.comparedPixels))
        : 0,
    meanAbsoluteLumaDelta: mean(meanDeltas) ?? 0,
    p95PairMeanAbsoluteLumaDelta: percentile(meanDeltas, 0.95) ?? 0,
    normalizedMeanAbsoluteLumaDelta: mean(normalizedDeltas) ?? 0,
    normalizedP95PairLumaDelta: percentile(normalizedDeltas, 0.95) ?? 0,
    normalizedMeanHighPassDelta: mean(normalizedHighPass) ?? 0,
    normalizedP95HighPassDelta: percentile(normalizedHighPass, 0.95) ?? 0,
    spatialHighFrequencyMean: spatialMean,
    spatialHighFrequencyP95: percentile(spatialValues, 0.95) ?? 0,
    spatialHighFrequencyCoefficientOfVariation:
      (standardDeviation(spatialValues, spatialMean) ?? 0) /
      Math.max(1e-9, spatialMean),
  };
}

function recomputeParitySummary(samples) {
  const keyMean = (key) => mean(samples.map((sample) => sample[key])) ?? 0;
  return {
    sampleCount: samples.length,
    comparedPixelsMin:
      samples.length > 0
        ? Math.min(...samples.map((sample) => sample.comparedPixels))
        : 0,
    maskIntersectionOverUnionMean: keyMean("maskIntersectionOverUnion"),
    meanAbsoluteRgbError: keyMean("meanAbsoluteRgbError"),
    meanAbsoluteLumaError: keyMean("meanAbsoluteLumaError"),
    normalizedMeanAbsoluteLumaError: keyMean("normalizedMeanAbsoluteLumaError"),
    normalizedP95AbsoluteLumaError:
      percentile(
        samples.map((sample) => sample.normalizedMeanAbsoluteLumaError),
        0.95,
      ) ?? 0,
    changedPixelFractionMean: keyMean("changedPixelFraction"),
    spatialHighFrequencyRatioMean: keyMean("spatialHighFrequencyRatio"),
  };
}

function exactRuntimeUrl(viewerUrl, localPath, { adapter = false } = {}) {
  try {
    const viewer = new URL(viewerUrl);
    if (adapter) {
      return viewer.href;
    }
    return new URL(`/${localPath}`, viewer.origin).href;
  } catch (_error) {
    return null;
  }
}

export function validateStructuralEvidence(report) {
  const failures = [];
  if (report?.filedDiscrepancy !== C12_33_FILED_DESIGN_DISCREPANCY) {
    failures.push("filed R-24 design discrepancy is missing or changed");
  }
  const ready = report.readiness?.diagnostics;
  if (report.setup?.sameJavaScriptRealm !== true) {
    failures.push(
      "split viewers were not proven to share one JavaScript realm",
    );
  }
  const runtimeIdentity = report.runtimeIdentity;
  const runtimeEntries = runtimeIdentity?.entries;
  const requiredRuntimeEntries = Object.keys(RUNTIME_RESOURCE_DEFINITIONS);
  exactObjectKeys(
    runtimeIdentity,
    [
      "schemaVersion",
      "entries",
      "adapterIdentity",
      "producerSource",
      "identitySha256",
    ],
    "runtimeIdentity",
    failures,
  );
  if (runtimeIdentity?.schemaVersion !== 2) {
    failures.push("runtime identity schemaVersion must equal 2");
  }
  exactObjectKeys(
    runtimeEntries,
    requiredRuntimeEntries,
    "runtimeIdentity.entries",
    failures,
  );
  let expectedViewerUrl = null;
  try {
    const parsedViewerUrl = new URL(report.viewerUrl);
    if (
      parsedViewerUrl.pathname !==
        "/Apps/WebGPUTest/split-screen-comparison.html" ||
      parsedViewerUrl.search !== "?baseLayer=false" ||
      parsedViewerUrl.hash !== ""
    ) {
      failures.push("viewerUrl is not the fixed split-view adapter URL");
    }
    expectedViewerUrl = parsedViewerUrl.href;
  } catch (_error) {
    failures.push("viewerUrl is not an absolute canonical URL");
  }
  for (const entryId of requiredRuntimeEntries) {
    const entry = runtimeEntries?.[entryId];
    const definition = RUNTIME_RESOURCE_DEFINITIONS[entryId];
    exactObjectKeys(
      entry,
      ["label", "served", "local", "servedMatchesLocal"],
      `runtimeIdentity.entries.${entryId}`,
      failures,
    );
    exactObjectKeys(
      entry?.served,
      ["url", "byteLength", "sha256"],
      `runtimeIdentity.entries.${entryId}.served`,
      failures,
    );
    exactObjectKeys(
      entry?.local,
      ["path", "byteLength", "sha256"],
      `runtimeIdentity.entries.${entryId}.local`,
      failures,
    );
    const expectedUrl = exactRuntimeUrl(
      report.viewerUrl,
      definition.localPath,
      {
        adapter: entryId === "adapter",
      },
    );
    if (
      entry?.label !== definition.label ||
      entry?.local?.path !== definition.localPath ||
      entry?.served?.url !== expectedUrl ||
      entry?.servedMatchesLocal !== true ||
      !/^[0-9a-f]{64}$/u.test(entry?.served?.sha256 ?? "") ||
      entry?.served?.sha256 !== entry?.local?.sha256 ||
      entry?.served?.byteLength !== entry?.local?.byteLength ||
      !Number.isInteger(entry?.served?.byteLength) ||
      entry.served.byteLength <= 0 ||
      typeof entry?.served?.url !== "string" ||
      entry.served.url.length === 0 ||
      !isPortableEvidencePath(entry?.local?.path)
    ) {
      failures.push(
        `${entryId} did not retain its exact label/path/URL and matching served/local byte identity`,
      );
    }
  }
  const producerSource = runtimeIdentity?.producerSource;
  exactObjectKeys(
    producerSource,
    ["path", "byteLength", "sha256"],
    "runtimeIdentity.producerSource",
    failures,
  );
  if (
    producerSource?.path !==
      portableRepositoryPath(fileURLToPath(import.meta.url)) ||
    !Number.isInteger(producerSource?.byteLength) ||
    producerSource.byteLength <= 0 ||
    !/^[0-9a-f]{64}$/u.test(producerSource?.sha256 ?? "")
  ) {
    failures.push(
      "runtime identity did not retain the producer source path and byte hash",
    );
  }
  if (!/^[0-9a-f]{64}$/u.test(report.runtimeIdentity?.identitySha256 ?? "")) {
    failures.push("runtime identity digest was missing or malformed");
  } else if (
    report.runtimeIdentity.identitySha256 !==
    sha256Bytes(
      Buffer.from(
        JSON.stringify({
          entries: report.runtimeIdentity.entries,
          adapterIdentity: report.runtimeIdentity.adapterIdentity,
          producerSource: report.runtimeIdentity.producerSource,
        }),
        "utf8",
      ),
    )
  ) {
    failures.push(
      "runtime identity digest did not bind its resources, adapter, and producer source",
    );
  }
  const adapterIdentity = runtimeIdentity?.adapterIdentity;
  exactObjectKeys(
    adapterIdentity,
    ADAPTER_IDENTITY_KEYS,
    "runtimeIdentity.adapterIdentity",
    failures,
  );
  if (
    adapterIdentity?.kind !== RUNTIME_RESOURCE_DEFINITIONS.adapter.localPath ||
    adapterIdentity?.loadedCesiumScriptUrl !==
      exactRuntimeUrl(
        report.viewerUrl,
        RUNTIME_RESOURCE_DEFINITIONS.bundle.localPath,
      )
  ) {
    failures.push("split-view adapter kind/script URL provenance is invalid");
  }
  for (const flag of ADAPTER_IDENTITY_KEYS.slice(2)) {
    if (adapterIdentity?.[flag] !== true) {
      failures.push(`split-view adapter identity did not prove ${flag}`);
    }
  }
  if (
    !exactObjectKeys(
      report.setup?.adapterIdentity,
      ADAPTER_IDENTITY_KEYS,
      "setup.adapterIdentity",
      failures,
    ) ||
    ADAPTER_IDENTITY_KEYS.some(
      (key) => report.setup?.adapterIdentity?.[key] !== adapterIdentity?.[key],
    )
  ) {
    failures.push(
      "setup.adapterIdentity is not the exact digest-bound runtime adapter identity",
    );
  }
  if (
    report.setup?.albedoUrl !== runtimeEntries?.moonAlbedo?.served?.url ||
    report.setup?.normalUrl !== runtimeEntries?.moonNormal?.served?.url ||
    report.setup?.fixedTimeIso !== FIXED_TIME_ISO ||
    report.setup?.lightingFixture !== "camera-coincident-directional-light" ||
    report.setup?.catalogStarFieldDisabled !== true ||
    expectedViewerUrl === null
  ) {
    failures.push(
      "setup asset/clock/lighting/scene-hygiene provenance is invalid",
    );
  }
  if (
    report.control?.requestedMode !== report.controlMode ||
    report.control?.appliedMode !== report.controlMode
  ) {
    failures.push(
      `Moon mip control was not applied exactly (requested=${report.controlMode}, applied=${report.control?.appliedMode ?? "missing"})`,
    );
  }
  if (report.browser?.channel !== "msedge") {
    failures.push("Moon mip probe browser channel was not msedge");
  }
  if (
    report.controlMode === "normal" &&
    (report.control?.webgl?.baseLevelOnly !== false ||
      report.control?.webgpu?.baseLevelOnly !== false ||
      report.control?.webgpu?.bindGroupRebuilt !== false)
  ) {
    failures.push(
      "normal control did not retain mip-capable sampling on both backends",
    );
  }
  if (
    report.controlMode === "force-lod0" &&
    (report.control?.webgl?.baseLevelOnly !== true ||
      report.control?.webgpu?.baseLevelOnly !== true ||
      report.control?.webgpu?.bindGroupRebuilt !== true)
  ) {
    failures.push(
      "force-lod0 did not bind a base-level-only sampler on both backends",
    );
  }
  if (report.readiness?.ready !== true) {
    failures.push(
      "wall-clock readiness deadline elapsed before both Moon mip chains became current",
    );
  }
  if (
    ready?.webgl?.textureLoaded !== true ||
    ready?.webgl?.normalLoaded !== true ||
    ready?.webgpu?.textureLoaded !== true ||
    ready?.webgpu?.normalLoaded !== true ||
    ready?.webgpu?.pipelineReady !== true
  ) {
    failures.push(
      "readiness did not revalidate loaded Moon textures and the WebGPU pipeline",
    );
  }
  if (ready?.webgl?.rendererType !== "webgl") {
    failures.push(
      `left renderer was ${ready?.webgl?.rendererType ?? "missing"}`,
    );
  }
  if (ready?.webgpu?.rendererType !== "webgpu") {
    failures.push(
      `right renderer was ${ready?.webgpu?.rendererType ?? "missing"}`,
    );
  }
  for (const backend of ["webgl", "webgpu"]) {
    if (Math.abs(ready?.[backend]?.clockOffsetSeconds ?? Infinity) > 1e-9) {
      failures.push(
        `${backend} readiness clock was not pinned to the fixture instant`,
      );
    }
  }

  for (const backend of ["webgl", "webgpu"]) {
    const diagnostics = ready?.[backend];
    for (const channel of ["albedo", "normal"]) {
      const mip = diagnostics?.mips?.[channel];
      if (!mip || mip.fullChain !== true) {
        failures.push(
          `${backend} ${channel} mip chain was incomplete (actual=${mip?.actualMipLevelCount ?? "missing"}, expected=${mip?.expectedMipLevelCount ?? "missing"})`,
        );
      }
    }
  }
  if (ready?.webgpu?.pendingTextureMipJobs !== 0) {
    failures.push(
      `WebGPU readiness retained ${ready?.webgpu?.pendingTextureMipJobs ?? "unknown"} pending texture-mip job(s)`,
    );
  }
  if (
    report.gpuDrain?.completed !== true ||
    report.gpuDrain?.pendingTextureMipJobs !== 0
  ) {
    failures.push(
      "WebGPU queue did not complete with an empty frame-owned texture-mip queue",
    );
  }
  for (const backend of ["webgl", "webgpu"]) {
    const finalBackend = report.finalDiagnostics?.[backend];
    if (
      finalBackend?.textureLoaded !== true ||
      finalBackend?.normalLoaded !== true ||
      (backend === "webgpu" && finalBackend?.pipelineReady !== true)
    ) {
      failures.push(
        `${backend} final diagnostics did not retain loaded Moon textures${backend === "webgpu" ? " and a ready pipeline" : ""}`,
      );
    }
    for (const channel of ["albedo", "normal"]) {
      const mip = finalBackend?.mips?.[channel];
      if (!mip || mip.fullChain !== true) {
        failures.push(
          `${backend} ${channel} mip chain was not retained through final capture`,
        );
      }
    }
  }

  const compile = report.webglShaderCompile;
  if (
    compile?.colorProgramReady !== true ||
    compile?.pickProgramReady !== true
  ) {
    failures.push("WebGL Moon color/pick shader programs were not both ready");
  }
  for (const required of [
    "LUNAR_EXPLICIT_GRADIENTS",
    "LUNAR_ALBEDO_EXPLICIT_GRADIENTS",
    "LUNAR_NORMAL_EXPLICIT_GRADIENTS",
  ]) {
    if (!compile?.colorDefines?.includes(required)) {
      failures.push(`WebGL color shader did not compile with ${required}`);
    }
  }
  for (const required of [
    "LUNAR_EXPLICIT_GRADIENTS",
    "LUNAR_ALBEDO_EXPLICIT_GRADIENTS",
  ]) {
    if (!compile?.pickDefines?.includes(required)) {
      failures.push(`WebGL pick shader did not compile with ${required}`);
    }
  }
  if (compile?.pickedProbeId !== true) {
    failures.push("WebGL center pick did not return the Moon probe id");
  }

  const expectedLaneIds = MOON_MIP_MOTION_LANES.map((lane) => lane.id);
  const actualLanes = Array.isArray(report.lanes) ? report.lanes : [];
  const actualLaneIds = actualLanes.map((lane) => lane?.id);
  if (report.sampleCount !== MOON_MIP_SAMPLE_COUNT) {
    failures.push(
      `sampleCount must equal the pre-registered ${MOON_MIP_SAMPLE_COUNT}; received ${report.sampleCount}`,
    );
  }
  if (
    actualLaneIds.length !== expectedLaneIds.length ||
    actualLaneIds.some((laneId, index) => laneId !== expectedLaneIds[index])
  ) {
    failures.push(
      `Moon motion lanes must be exactly ${expectedLaneIds.join(", ")} in declaration order; received ${actualLaneIds.join(", ") || "none"}`,
    );
  }
  for (let laneIndex = 0; laneIndex < actualLanes.length; laneIndex++) {
    const lane = actualLanes[laneIndex];
    const definition = MOON_MIP_MOTION_LANES[laneIndex];
    exactObjectKeys(
      lane,
      [
        "id",
        "description",
        "localCameraDirection",
        "targetDiscDiameterPx",
        "angularSweepRadians",
        "seamPlacement",
        "motion",
        "motionSummary",
        "backends",
        "parity",
      ],
      `lanes[${laneIndex}]`,
      failures,
    );
    if (
      !definition ||
      lane?.id !== definition.id ||
      lane?.description !== definition.description ||
      lane?.targetDiscDiameterPx !== definition.targetDiscDiameterPx ||
      lane?.angularSweepRadians !== definition.angularSweepRadians ||
      lane?.seamPlacement !== definition.seamPlacement ||
      !Array.isArray(lane?.localCameraDirection) ||
      vectorDistance(
        lane.localCameraDirection,
        definition.localCameraDirection,
      ) !== 0
    ) {
      failures.push(
        `lanes[${laneIndex}] did not bind the complete pre-registered lane definition`,
      );
    }
  }
  const manualLaneIds = report.manualInspection?.requiredLaneIds;
  if (
    report.manualInspection?.required !== true ||
    !["PENDING", "PASS", "FAIL"].includes(report.manualInspection?.status) ||
    !Array.isArray(manualLaneIds) ||
    manualLaneIds.length !==
      MANUAL_INSPECTION_REQUIREMENT.requiredLaneIds.length ||
    manualLaneIds.some(
      (laneId, index) =>
        laneId !== MANUAL_INSPECTION_REQUIREMENT.requiredLaneIds[index],
    )
  ) {
    failures.push(
      "mandatory seam-centered and seam-at-limb manual PNG inspection was not declared",
    );
  }
  if (
    report.manualInspection?.status === "PASS" &&
    (!Array.isArray(report.manualInspection?.evidence) ||
      report.manualInspection.evidence.length === 0)
  ) {
    failures.push(
      "mandatory Moon seam PNG inspection PASS lacked retained evidence",
    );
  }

  const retainedPngPaths = new Set();
  let fixedMoonGeometry = null;
  for (let laneIndex = 0; laneIndex < actualLanes.length; laneIndex++) {
    const lane = actualLanes[laneIndex];
    const laneDefinition = MOON_MIP_MOTION_LANES[laneIndex];
    if (!laneDefinition) {
      continue;
    }
    const minimumInteriorPixels =
      laneDefinition.id === "minified-16px" ? 20 : 1000;
    if (lane.motion?.length !== report.sampleCount) {
      failures.push(
        `${lane.id} recorded ${lane.motion?.length ?? 0} camera sample(s), expected ${report.sampleCount}`,
      );
    }
    for (const backend of ["webgl", "webgpu"]) {
      const evidence = lane.backends?.[backend];
      const expectedCanvasSelector =
        backend === "webgl" ? "#leftViewer canvas" : "#rightViewer canvas";
      if (
        evidence?.captureKind !== "playwright-canvas-element-png" ||
        evidence?.canvasSelector !== expectedCanvasSelector
      ) {
        failures.push(
          `${lane.id}/${backend} did not use the exact canvas-element PNG capture`,
        );
      }
      const frames = Array.isArray(evidence?.frames) ? evidence.frames : [];
      if (evidence?.frames?.length !== report.sampleCount) {
        failures.push(
          `${lane.id}/${backend} captured ${evidence?.frames?.length ?? 0} canvas PNG(s), expected ${report.sampleCount}`,
        );
      }
      for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
        const frame = frames[frameIndex];
        const expectedName = `${laneDefinition.id}-${String(frameIndex).padStart(2, "0")}-${backend}.png`;
        if (
          !isPortableEvidencePath(frame?.pngPath) ||
          frame.pngPath.split("/").at(-1) !== expectedName
        ) {
          failures.push(
            `${lane.id}/${backend}/${frameIndex} did not retain its portable canonical PNG path`,
          );
        } else if (retainedPngPaths.has(frame.pngPath)) {
          failures.push(`duplicate retained PNG path ${frame.pngPath}`);
        } else {
          retainedPngPaths.add(frame.pngPath);
        }
        if (!/^[0-9a-f]{64}$/u.test(frame?.pngSha256 ?? "")) {
          failures.push(
            `${lane.id}/${backend}/${frameIndex} did not retain a canonical PNG hash`,
          );
        }
      }
      const spatialKeys = [
        "discDiameterPxMedian",
        "discDiameterPxMin",
        "discDiameterPxMax",
        "normalizedSpatialHighFrequencyMean",
        "normalizedSpatialHighFrequencyP95",
        "normalizedLaplacianEnergyMean",
        "normalizedLaplacianEnergyP95",
      ];
      const recomputedSpatial = summarizeSpatial(frames);
      if (
        !numericSummaryMatches(
          evidence?.spatial,
          recomputedSpatial,
          spatialKeys,
        )
      ) {
        failures.push(
          `${laneDefinition.id}/${backend} spatial summary disagreed with its frame measurements`,
        );
      }
      if (recomputedSpatial.discDiameterPxMin <= 0) {
        failures.push(`${lane.id}/${backend} had no illuminated Moon pixels`);
      }
      const minimumFrameInterior = Math.min(
        ...frames.map((frame) => frame.interiorPixels),
      );
      if (
        !Number.isFinite(minimumFrameInterior) ||
        minimumFrameInterior < minimumInteriorPixels
      ) {
        failures.push(
          `${lane.id}/${backend} had ${minimumFrameInterior} interior pixel(s), below the non-vacuous floor ${minimumInteriorPixels}`,
        );
      }
      const temporalPairs = Array.isArray(evidence?.temporal?.pairs)
        ? evidence.temporal.pairs
        : [];
      const temporalPairKeys = [
        "comparedPixels",
        "meanAbsoluteLumaDelta",
        "p95AbsoluteLumaDelta",
        "normalizedMeanAbsoluteLumaDelta",
        "meanHighPassDelta",
        "normalizedMeanHighPassDelta",
      ];
      if (
        temporalPairs.length !== report.sampleCount - 1 ||
        temporalPairs.some(
          (pair) =>
            !exactObjectKeys(
              pair,
              temporalPairKeys,
              `${laneDefinition.id}/${backend}.temporal.pair`,
              failures,
            ) ||
            !Number.isInteger(pair.comparedPixels) ||
            pair.comparedPixels < 0 ||
            temporalPairKeys
              .slice(1)
              .some((key) => !Number.isFinite(pair[key]) || pair[key] < 0),
        )
      ) {
        failures.push(
          `${laneDefinition.id}/${backend} did not retain 12 complete temporal pair measurements`,
        );
      }
      const recomputedTemporal = recomputeTemporalSummary(
        frames,
        temporalPairs,
      );
      const temporalSummaryKeys = [
        "pairCount",
        "comparedPixelsMin",
        "meanAbsoluteLumaDelta",
        "p95PairMeanAbsoluteLumaDelta",
        "normalizedMeanAbsoluteLumaDelta",
        "normalizedP95PairLumaDelta",
        "normalizedMeanHighPassDelta",
        "normalizedP95HighPassDelta",
        "spatialHighFrequencyMean",
        "spatialHighFrequencyP95",
        "spatialHighFrequencyCoefficientOfVariation",
      ];
      if (
        !numericSummaryMatches(
          evidence?.temporal,
          recomputedTemporal,
          temporalSummaryKeys,
        )
      ) {
        failures.push(
          `${laneDefinition.id}/${backend} temporal summary disagreed with its pair/frame measurements`,
        );
      }
      if (recomputedTemporal.comparedPixelsMin < minimumInteriorPixels) {
        failures.push(
          `${lane.id}/${backend} temporal overlap was below the non-vacuous floor ${minimumInteriorPixels}`,
        );
      }
      if (recomputedTemporal.pairCount !== report.sampleCount - 1) {
        failures.push(
          `${lane.id}/${backend} recorded ${recomputedTemporal.pairCount} temporal pair(s), expected ${report.sampleCount - 1}`,
        );
      }
      const recomputedMotionSummary = cameraMotionSummary(
        lane.motion ?? [],
        backend,
      );
      const motionSummaryKeys = [
        "stepCount",
        "totalDistanceMeters",
        "minStepDistanceMeters",
        "maxStepDistanceMeters",
        "frameAdvance",
      ];
      if (
        !numericSummaryMatches(
          lane.motionSummary?.[backend],
          recomputedMotionSummary,
          motionSummaryKeys,
        )
      ) {
        failures.push(
          `${laneDefinition.id}/${backend} motion summary disagreed with actual post-sync WC samples`,
        );
      }
      if (recomputedMotionSummary.minStepDistanceMeters <= 0.1) {
        failures.push(
          `${lane.id}/${backend} camera track contained a stationary step`,
        );
      }
      if (recomputedMotionSummary.frameAdvance < report.sampleCount - 1) {
        failures.push(
          `${lane.id}/${backend} did not advance a rendered frame per camera sample`,
        );
      }
      const unpinnedSample = (lane.motion ?? []).find(
        (sample) =>
          !Number.isFinite(sample?.[backend]?.clockOffsetSeconds) ||
          Math.abs(sample[backend].clockOffsetSeconds) > 1e-9,
      );
      if (unpinnedSample) {
        failures.push(
          `${lane.id}/${backend} camera route advanced the pinned clock`,
        );
      }
      for (
        let sampleIndex = 0;
        sampleIndex < (lane.motion?.length ?? 0);
        sampleIndex++
      ) {
        const sample = lane.motion[sampleIndex]?.[backend];
        const moonBasis = sample?.moonLocalToWorldBasis;
        const vectors = [
          sample?.cameraWorldPosition,
          sample?.directionWC,
          sample?.rightWC,
          sample?.upWC,
          sample?.cameraLocalDirection,
          sample?.requestedCameraWorldPosition,
          sample?.requestedDirectionWC,
          sample?.requestedUpWC,
          sample?.requestedCameraLocalDirection,
          sample?.moonCenterWorld,
          moonBasis?.xWC,
          moonBasis?.yWC,
          moonBasis?.zWC,
        ];
        if (
          sample?.poseSource !== "post-sync-camera-world-coordinates" ||
          sample?.postSyncStableFrameCount < 2 ||
          vectors.some(
            (vector) =>
              !Array.isArray(vector) ||
              vector.length !== 3 ||
              vector.some((component) => !Number.isFinite(component)),
          )
        ) {
          failures.push(
            `${lane.id}/${backend}/${sampleIndex} lacked actual post-sync WC pose evidence`,
          );
          continue;
        }
        const [direction, right, up] = [
          sample.directionWC,
          sample.rightWC,
          sample.upWC,
        ];
        const magnitude = (vector) => Math.hypot(...vector);
        const dot = (left, rightVector) =>
          left.reduce(
            (sum, component, index) => sum + component * rightVector[index],
            0,
          );
        const cross = (left, rightVector) => [
          left[1] * rightVector[2] - left[2] * rightVector[1],
          left[2] * rightVector[0] - left[0] * rightVector[2],
          left[0] * rightVector[1] - left[1] * rightVector[0],
        ];
        const positionError = Math.hypot(
          ...sample.cameraWorldPosition.map(
            (component, index) =>
              component - sample.requestedCameraWorldPosition[index],
          ),
        );
        const toMoonUnnormalized = sample.moonCenterWorld.map(
          (component, index) => component - sample.cameraWorldPosition[index],
        );
        const toMoonMagnitude = magnitude(toMoonUnnormalized);
        const toMoon = toMoonUnnormalized.map(
          (component) => component / toMoonMagnitude,
        );
        const directionDotRequested = dot(
          direction,
          sample.requestedDirectionWC,
        );
        const upDotRequested = dot(up, sample.requestedUpWC);
        const directionToMoonDot = dot(direction, toMoon);
        const expectedLocalDirection = expectedCameraLocalDirection(
          laneDefinition,
          sampleIndex,
          report.sampleCount,
        );
        const [moonX, moonY, moonZ] = [
          moonBasis.xWC,
          moonBasis.yWC,
          moonBasis.zWC,
        ];
        const expectedOutwardUnnormalized = moonX.map(
          (component, index) =>
            component * expectedLocalDirection[0] +
            moonY[index] * expectedLocalDirection[1] +
            moonZ[index] * expectedLocalDirection[2],
        );
        const expectedOutwardMagnitude = magnitude(expectedOutwardUnnormalized);
        const expectedOutward = expectedOutwardUnnormalized.map(
          (component) => component / expectedOutwardMagnitude,
        );
        const expectedRequestedPosition = sample.moonCenterWorld.map(
          (component, index) =>
            component + expectedOutward[index] * sample.centerDistanceMeters,
        );
        const expectedRequestedDirection = expectedOutward.map(
          (component) => -component,
        );
        const expectedRightUnnormalized = cross(
          expectedRequestedDirection,
          moonZ,
        );
        const expectedRightMagnitude = magnitude(expectedRightUnnormalized);
        const expectedRight = expectedRightUnnormalized.map(
          (component) => component / expectedRightMagnitude,
        );
        const focalPixels =
          sample.canvasHeight / (2 * Math.tan(sample.fovyRadians * 0.5));
        const projectedRadius = laneDefinition.targetDiscDiameterPx * 0.5;
        const tangentDistance =
          (sample.moonRadiusMeters * focalPixels) / projectedRadius;
        const expectedCenterDistance = Math.sqrt(
          sample.moonRadiusMeters ** 2 + tangentDistance ** 2,
        );
        if (fixedMoonGeometry === null) {
          fixedMoonGeometry = {
            center: [...sample.moonCenterWorld],
            radius: sample.moonRadiusMeters,
            basis: {
              xWC: [...moonX],
              yWC: [...moonY],
              zWC: [...moonZ],
            },
          };
        } else if (
          vectorDistance(sample.moonCenterWorld, fixedMoonGeometry.center) >
            1e-3 ||
          Math.abs(sample.moonRadiusMeters - fixedMoonGeometry.radius) > 1e-9 ||
          vectorDistance(moonX, fixedMoonGeometry.basis.xWC) > 1e-9 ||
          vectorDistance(moonY, fixedMoonGeometry.basis.yWC) > 1e-9 ||
          vectorDistance(moonZ, fixedMoonGeometry.basis.zWC) > 1e-9
        ) {
          failures.push(
            `${lane.id}/${backend}/${sampleIndex} changed the fixed-time Moon WC geometry`,
          );
        }
        const scalarProofs = [
          sample.positionErrorMeters,
          sample.directionDotRequested,
          sample.upDotRequested,
          sample.directionToMoonDot,
          sample.seamNormalDot,
          sample.basis?.directionMagnitude,
          sample.basis?.rightMagnitude,
          sample.basis?.upMagnitude,
          sample.basis?.directionRightDot,
          sample.basis?.directionUpDot,
          sample.basis?.rightUpDot,
          sample.basis?.handedness,
        ];
        if (
          scalarProofs.some((value) => !Number.isFinite(value)) ||
          Math.abs(magnitude(direction) - 1) > 1e-9 ||
          Math.abs(magnitude(right) - 1) > 1e-9 ||
          Math.abs(magnitude(up) - 1) > 1e-9 ||
          Math.abs(magnitude(sample.cameraLocalDirection) - 1) > 1e-9 ||
          Math.abs(dot(direction, right)) > 1e-9 ||
          Math.abs(dot(direction, up)) > 1e-9 ||
          Math.abs(dot(right, up)) > 1e-9 ||
          Math.abs(dot(cross(direction, up), right) - 1) > 1e-9 ||
          !Number.isFinite(toMoonMagnitude) ||
          toMoonMagnitude <= 0 ||
          Math.abs(toMoonMagnitude - sample.centerDistanceMeters) > 1e-3 ||
          !Number.isFinite(sample.centerDistanceMeters) ||
          !Number.isFinite(sample.altitudeAboveMoonMeters) ||
          !Number.isFinite(sample.moonRadiusMeters) ||
          sample.moonRadiusMeters <= 0 ||
          !Number.isFinite(sample.canvasHeight) ||
          sample.canvasHeight <= 0 ||
          !Number.isFinite(sample.fovyRadians) ||
          sample.fovyRadians <= 0 ||
          sample.fovyRadians >= Math.PI ||
          !Number.isFinite(expectedOutwardMagnitude) ||
          Math.abs(expectedOutwardMagnitude - 1) > 1e-9 ||
          !Number.isFinite(expectedRightMagnitude) ||
          expectedRightMagnitude <= 0 ||
          Math.abs(magnitude(moonX) - 1) > 1e-9 ||
          Math.abs(magnitude(moonY) - 1) > 1e-9 ||
          Math.abs(magnitude(moonZ) - 1) > 1e-9 ||
          Math.abs(dot(moonX, moonY)) > 1e-9 ||
          Math.abs(dot(moonX, moonZ)) > 1e-9 ||
          Math.abs(dot(moonY, moonZ)) > 1e-9 ||
          Math.abs(dot(cross(moonX, moonY), moonZ) - 1) > 1e-9 ||
          vectorDistance(
            sample.requestedCameraWorldPosition,
            expectedRequestedPosition,
          ) > 1e-3 ||
          vectorDistance(
            sample.requestedDirectionWC,
            expectedRequestedDirection,
          ) > 1e-9 ||
          vectorDistance(sample.requestedUpWC, moonZ) > 1e-9 ||
          vectorDistance(right, expectedRight) > 1e-7 ||
          Math.abs(sample.centerDistanceMeters - expectedCenterDistance) >
            1e-6 ||
          Math.abs(
            sample.altitudeAboveMoonMeters -
              (sample.centerDistanceMeters - sample.moonRadiusMeters),
          ) > 1e-9 ||
          sample.targetDiscDiameterPx !== laneDefinition.targetDiscDiameterPx ||
          sample.lightingFixture !== "camera-coincident-directional-light" ||
          vectorDistance(
            sample.requestedCameraLocalDirection,
            expectedLocalDirection,
          ) > 1e-12 ||
          vectorDistance(sample.cameraLocalDirection, expectedLocalDirection) >
            1e-9 ||
          positionError > 1e-3 ||
          directionDotRequested < 1 - 1e-7 ||
          upDotRequested < 1 - 1e-7 ||
          directionToMoonDot < 1 - 1e-7 ||
          Math.abs(sample.positionErrorMeters - positionError) > 1e-9 ||
          Math.abs(sample.directionDotRequested - directionDotRequested) >
            1e-12 ||
          Math.abs(sample.upDotRequested - upDotRequested) > 1e-12 ||
          Math.abs(sample.directionToMoonDot - directionToMoonDot) > 1e-12 ||
          Math.abs(sample.seamNormalDot + sample.cameraLocalDirection[0]) >
            1e-12
        ) {
          failures.push(
            `${lane.id}/${backend}/${sampleIndex} post-sync WC pose or basis was not the requested orthonormal Moon track`,
          );
        }
        const basis = sample.basis;
        if (
          Math.abs(
            (basis?.directionMagnitude ?? Infinity) - magnitude(direction),
          ) > 1e-12 ||
          Math.abs((basis?.rightMagnitude ?? Infinity) - magnitude(right)) >
            1e-12 ||
          Math.abs((basis?.upMagnitude ?? Infinity) - magnitude(up)) > 1e-12 ||
          Math.abs(
            (basis?.directionRightDot ?? Infinity) - dot(direction, right),
          ) > 1e-12 ||
          Math.abs((basis?.directionUpDot ?? Infinity) - dot(direction, up)) >
            1e-12 ||
          Math.abs((basis?.rightUpDot ?? Infinity) - dot(right, up)) > 1e-12 ||
          Math.abs(
            (basis?.handedness ?? Infinity) - dot(cross(direction, up), right),
          ) > 1e-12
        ) {
          failures.push(
            `${lane.id}/${backend}/${sampleIndex} basis self-attestation disagreed with actual WC vectors`,
          );
        }
      }
    }

    for (
      let sampleIndex = 0;
      sampleIndex < (lane.motion?.length ?? 0);
      sampleIndex++
    ) {
      const motionSample = lane.motion[sampleIndex];
      const delta = motionSample?.backendPoseDelta;
      const poseKeys = [
        ["positionMeters", "cameraWorldPosition"],
        ["direction", "directionWC"],
        ["right", "rightWC"],
        ["up", "upWC"],
      ];
      const recomputedDelta = Object.fromEntries(
        poseKeys.map(([deltaKey, poseKey]) => {
          const left = motionSample?.webgl?.[poseKey];
          const right = motionSample?.webgpu?.[poseKey];
          return [
            deltaKey,
            Array.isArray(left) && Array.isArray(right)
              ? vectorDistance(left, right)
              : Infinity,
          ];
        }),
      );
      if (
        !delta ||
        poseKeys.some(
          ([deltaKey]) =>
            !Number.isFinite(delta?.[deltaKey]) ||
            delta[deltaKey] < 0 ||
            Math.abs(delta[deltaKey] - recomputedDelta[deltaKey]) > 1e-12,
        ) ||
        recomputedDelta.positionMeters > 1e-3 ||
        recomputedDelta.direction > 1e-9 ||
        recomputedDelta.right > 1e-9 ||
        recomputedDelta.up > 1e-9
      ) {
        failures.push(
          `${lane.id}/${sampleIndex} WebGL/WebGPU post-sync WC poses diverged`,
        );
      }
    }

    const paritySamples = Array.isArray(lane.parity?.samples)
      ? lane.parity.samples
      : [];
    const paritySampleKeys = [
      "comparedPixels",
      "maskIntersectionOverUnion",
      "meanAbsoluteRgbError",
      "meanAbsoluteLumaError",
      "normalizedMeanAbsoluteLumaError",
      "changedPixelFraction",
      "spatialHighFrequencyRatio",
    ];
    if (
      paritySamples.length !== report.sampleCount ||
      paritySamples.some(
        (sample, sampleIndex) =>
          !exactObjectKeys(
            sample,
            paritySampleKeys,
            `${laneDefinition.id}.parity.sample`,
            failures,
          ) ||
          !Number.isInteger(sample.comparedPixels) ||
          sample.comparedPixels < 0 ||
          paritySampleKeys
            .slice(1)
            .some((key) => !Number.isFinite(sample[key]) || sample[key] < 0) ||
          sample.maskIntersectionOverUnion > 1 ||
          sample.changedPixelFraction > 1 ||
          Math.abs(
            sample.spatialHighFrequencyRatio -
              (lane.backends?.webgpu?.frames?.[sampleIndex]
                ?.normalizedSpatialHighFrequency ?? Infinity) /
                Math.max(
                  1e-9,
                  lane.backends?.webgl?.frames?.[sampleIndex]
                    ?.normalizedSpatialHighFrequency ?? -Infinity,
                ),
          ) > 1e-12,
      )
    ) {
      failures.push(
        `${laneDefinition.id} did not retain 13 complete parity measurements`,
      );
    }
    const recomputedParity = recomputeParitySummary(paritySamples);
    const paritySummaryKeys = [
      "sampleCount",
      "comparedPixelsMin",
      "maskIntersectionOverUnionMean",
      "meanAbsoluteRgbError",
      "meanAbsoluteLumaError",
      "normalizedMeanAbsoluteLumaError",
      "normalizedP95AbsoluteLumaError",
      "changedPixelFractionMean",
      "spatialHighFrequencyRatioMean",
    ];
    if (
      !numericSummaryMatches(lane.parity, recomputedParity, paritySummaryKeys)
    ) {
      failures.push(
        `${laneDefinition.id} parity summary disagreed with its sample measurements`,
      );
    }
    if (recomputedParity.sampleCount !== report.sampleCount) {
      failures.push(
        `${lane.id} recorded ${recomputedParity.sampleCount} parity sample(s), expected ${report.sampleCount}`,
      );
    }
    if (recomputedParity.comparedPixelsMin < minimumInteriorPixels) {
      failures.push(
        `${laneDefinition.id} parity overlap was below the non-vacuous floor ${minimumInteriorPixels}`,
      );
    }

    const target = laneDefinition.targetDiscDiameterPx;
    for (const backend of ["webgl", "webgpu"]) {
      const frames = lane.backends?.[backend]?.frames ?? [];
      for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
        const strayLitPixels = frames[frameIndex]?.strayLitPixels;
        if (!Number.isInteger(strayLitPixels) || strayLitPixels < 0) {
          failures.push(
            `${lane.id}/${backend} frame ${frameIndex}: stray lit pixel count is missing or invalid`,
          );
          continue;
        }
        if (strayLitPixels > 0) {
          failures.push(
            `${lane.id}/${backend} frame ${frameIndex}: ${strayLitPixels} stray lit pixel(s) outside the principal disc - background is not black`,
          );
        }
      }
      const measured = summarizeSpatial(frames).discDiameterPxMedian;
      const lower = laneDefinition.id === "minified-16px" ? 8 : target * 0.55;
      const upper = laneDefinition.id === "minified-16px" ? 28 : target * 1.45;
      if (measured < lower || measured > upper) {
        failures.push(
          `${lane.id}/${backend} measured ${measured}px, outside structural framing band ${lower}-${upper}px`,
        );
      }
    }

    const centerDots = (lane.motion ?? []).map((sample) =>
      Math.abs(-(sample.webgl?.cameraLocalDirection?.[0] ?? Infinity)),
    );
    if (
      laneDefinition.seamPlacement === "center" &&
      (centerDots.length !== report.sampleCount ||
        Math.max(...centerDots.map((value) => Math.abs(1 - value))) > 0.001)
    ) {
      failures.push(
        "seam-centered route did not keep the U seam at disc center",
      );
    }
    if (
      laneDefinition.seamPlacement === "limb" &&
      (centerDots.length !== report.sampleCount ||
        Math.max(...centerDots) > 0.03)
    ) {
      failures.push("seam-at-limb route did not keep the U seam on the limb");
    }
  }

  if (
    retainedPngPaths.size !==
    MOON_MIP_MOTION_LANES.length * MOON_MIP_SAMPLE_COUNT * BACKEND_IDS.length
  ) {
    failures.push(
      `raw evidence retained ${retainedPngPaths.size} unique PNG paths instead of 104`,
    );
  }

  if ((report.gpuGateArm?.total ?? 0) < 1) {
    failures.push("WebGPU error gate did not arm a live GPUDevice");
  }
  const gpuFaults = [
    ...(report.gpuGate?.errors ?? []),
    ...(report.gpuGate?.deviceLost ? [report.gpuGate.deviceLost] : []),
    ...(report.gpuConsoleFaults ?? []),
  ];
  if (gpuFaults.length > 0) {
    failures.push(`${gpuFaults.length} WebGPU validation/device fault(s)`);
  }
  if ((report.pageErrors ?? []).length > 0) {
    failures.push(`${report.pageErrors.length} uncaught page error(s)`);
  }
  const consoleErrors = (report.consoleMessages ?? []).filter(
    (message) => message.type === "error",
  );
  if (consoleErrors.length > 0) {
    failures.push(`${consoleErrors.length} console error(s)`);
  }
  const moonRequestFailures = (report.requestFailures ?? []).filter((entry) =>
    /Moon|moonSmall/i.test(entry.url),
  );
  if (moonRequestFailures.length > 0) {
    failures.push(
      `${moonRequestFailures.length} Moon asset request failure(s)`,
    );
  }
  return failures;
}

export function evaluateCalibratedQuality(report, thresholds) {
  if (thresholds === null) {
    return [];
  }
  const schemaFailures = validateCalibratedThresholds(thresholds);
  if (schemaFailures.length > 0) {
    return schemaFailures.map(
      (failure) => `invalid calibrated-threshold schema: ${failure}`,
    );
  }
  const failures = [];
  const expectedLaneIds = MOON_MIP_MOTION_LANES.map((lane) => lane.id);
  const actualLaneIds = Array.isArray(report?.lanes)
    ? report.lanes.map((lane) => lane?.id)
    : [];
  if (
    actualLaneIds.length !== expectedLaneIds.length ||
    actualLaneIds.some((laneId, index) => laneId !== expectedLaneIds[index])
  ) {
    return [
      `quality report lanes must be exactly ${expectedLaneIds.join(", ")} in declaration order`,
    ];
  }
  const requireFiniteMetric = (value, path, maximum = Infinity) => {
    if (!Number.isFinite(value) || value < 0 || value > maximum) {
      failures.push(
        `${path} must be a finite measured value in [0, ${Number.isFinite(maximum) ? maximum : "Infinity"}]`,
      );
      return false;
    }
    return true;
  };
  for (const lane of report.lanes) {
    const laneThresholds = thresholds.lanes[lane.id];
    for (const backend of BACKEND_IDS) {
      const temporal = lane.backends?.[backend]?.temporal ?? {};
      const spatial = lane.backends?.[backend]?.spatial ?? {};
      const temporalThresholds = laneThresholds[backend].temporal;
      const spatialThresholds = laneThresholds[backend].spatial;
      for (const [key, value] of [
        [
          "normalizedMeanAbsoluteLumaDelta",
          temporal.normalizedMeanAbsoluteLumaDelta,
        ],
        ["normalizedP95PairLumaDelta", temporal.normalizedP95PairLumaDelta],
        ["normalizedMeanHighPassDelta", temporal.normalizedMeanHighPassDelta],
        ["normalizedP95HighPassDelta", temporal.normalizedP95HighPassDelta],
        [
          "spatialHighFrequencyCoefficientOfVariation",
          temporal.spatialHighFrequencyCoefficientOfVariation,
        ],
        [
          "normalizedSpatialHighFrequencyMean",
          spatial.normalizedSpatialHighFrequencyMean,
        ],
        [
          "normalizedLaplacianEnergyMean",
          spatial.normalizedLaplacianEnergyMean,
        ],
      ]) {
        requireFiniteMetric(value, `${lane.id}/${backend}.${key}`);
      }
      if (
        temporal.normalizedMeanAbsoluteLumaDelta >
        temporalThresholds.maxNormalizedMeanAbsoluteLumaDelta
      ) {
        failures.push(
          `${lane.id}/${backend} temporal luma shimmer exceeded calibration`,
        );
      }
      if (
        temporal.normalizedP95PairLumaDelta >
        temporalThresholds.maxNormalizedP95PairLumaDelta
      ) {
        failures.push(
          `${lane.id}/${backend} p95 temporal luma shimmer exceeded calibration`,
        );
      }
      if (
        temporal.normalizedMeanHighPassDelta >
        temporalThresholds.maxNormalizedMeanHighPassDelta
      ) {
        failures.push(
          `${lane.id}/${backend} temporal high-pass shimmer exceeded calibration`,
        );
      }
      if (
        temporal.normalizedP95HighPassDelta >
        temporalThresholds.maxNormalizedP95HighPassDelta
      ) {
        failures.push(
          `${lane.id}/${backend} p95 temporal high-pass shimmer exceeded calibration`,
        );
      }
      if (
        temporal.spatialHighFrequencyCoefficientOfVariation >
        temporalThresholds.maxSpatialHighFrequencyCoefficientOfVariation
      ) {
        failures.push(
          `${lane.id}/${backend} spatial high-frequency variation exceeded calibration`,
        );
      }
      if (
        spatial.normalizedSpatialHighFrequencyMean <
          spatialThresholds.minNormalizedSpatialHighFrequencyMean ||
        spatial.normalizedSpatialHighFrequencyMean >
          spatialThresholds.maxNormalizedSpatialHighFrequencyMean
      ) {
        failures.push(
          `${lane.id}/${backend} spatial high-frequency detail left its calibrated band`,
        );
      }
      if (
        spatial.normalizedLaplacianEnergyMean <
          spatialThresholds.minNormalizedLaplacianEnergyMean ||
        spatial.normalizedLaplacianEnergyMean >
          spatialThresholds.maxNormalizedLaplacianEnergyMean
      ) {
        failures.push(
          `${lane.id}/${backend} laplacian detail left its calibrated band`,
        );
      }
    }
    const parity = lane.parity ?? {};
    for (const [key, value, maximum] of [
      [
        "maskIntersectionOverUnionMean",
        parity.maskIntersectionOverUnionMean,
        1,
      ],
      [
        "normalizedMeanAbsoluteLumaError",
        parity.normalizedMeanAbsoluteLumaError,
        Infinity,
      ],
      [
        "normalizedP95AbsoluteLumaError",
        parity.normalizedP95AbsoluteLumaError,
        Infinity,
      ],
      ["changedPixelFractionMean", parity.changedPixelFractionMean, 1],
    ]) {
      requireFiniteMetric(value, `${lane.id}/parity.${key}`, maximum);
    }
    if (
      parity.normalizedMeanAbsoluteLumaError >
      laneThresholds.parity.maxNormalizedMeanAbsoluteLumaError
    ) {
      failures.push(`${lane.id} WebGL/WebGPU luma parity exceeded calibration`);
    }
    if (
      parity.normalizedP95AbsoluteLumaError >
      laneThresholds.parity.maxNormalizedP95AbsoluteLumaError
    ) {
      failures.push(
        `${lane.id} WebGL/WebGPU p95 luma parity exceeded calibration`,
      );
    }
    if (
      parity.changedPixelFractionMean >
      laneThresholds.parity.maxChangedPixelFractionMean
    ) {
      failures.push(
        `${lane.id} WebGL/WebGPU changed-pixel parity exceeded calibration`,
      );
    }
    if (
      parity.maskIntersectionOverUnionMean <
      laneThresholds.parity.minMaskIntersectionOverUnionMean
    ) {
      failures.push(
        `${lane.id} WebGL/WebGPU mask intersection-over-union fell below calibration`,
      );
    }
  }
  return failures;
}

function sensitivityMetricValue(lane, backend, metric) {
  if (
    metric === "normalizedSpatialHighFrequencyMean" ||
    metric === "normalizedLaplacianEnergyMean"
  ) {
    return lane?.backends?.[backend]?.spatial?.[metric];
  }
  return lane?.backends?.[backend]?.temporal?.[metric];
}

function passesPairedSensitivityAbsoluteGate(controlMinusNormal) {
  if (PAIRED_SENSITIVITY_COMPARISON !== ">=") {
    throw new Error(
      `unsupported paired-sensitivity comparison ${PAIRED_SENSITIVITY_COMPARISON}`,
    );
  }
  return controlMinusNormal >= PAIRED_SENSITIVITY_MINIMUM_EFFECT;
}

/**
 * Compare one structurally green normal report with its deliberately broken
 * base-level-only control. The four cells are source-controlled above; a
 * caller cannot substitute a favorable lane, backend, or measurement.
 */
export function evaluatePairedReportSensitivity(normalReport, forceLod0Report) {
  const failures = [];
  const comparisons = [];
  if (normalReport?.controlMode !== "normal") {
    failures.push("first paired report must use normal control mode");
  }
  if (forceLod0Report?.controlMode !== "force-lod0") {
    failures.push("second paired report must use force-lod0 control mode");
  }
  if (
    typeof normalReport?.runId !== "string" ||
    typeof forceLod0Report?.runId !== "string" ||
    normalReport.runId === forceLod0Report.runId
  ) {
    failures.push("paired reports must retain distinct non-empty run ids");
  }
  for (const [label, report] of [
    ["normal", normalReport],
    ["force-lod0", forceLod0Report],
  ]) {
    if (!Array.isArray(report?.result?.hardFailures)) {
      failures.push(`${label} report did not retain hardFailures evidence`);
    } else if (report.result.hardFailures.length > 0) {
      failures.push(`${label} report contains structural hard failures`);
    }
    const actualLaneIds = Array.isArray(report?.lanes)
      ? report.lanes.map((lane) => lane?.id)
      : [];
    const expectedLaneIds = MOON_MIP_MOTION_LANES.map((lane) => lane.id);
    if (
      actualLaneIds.length !== expectedLaneIds.length ||
      actualLaneIds.some((laneId, index) => laneId !== expectedLaneIds[index])
    ) {
      failures.push(`${label} report does not contain the exact lane set`);
    }
  }

  for (const [field, normalValue, controlValue] of [
    ["sampleCount", normalReport?.sampleCount, forceLod0Report?.sampleCount],
    ["fixedTimeIso", normalReport?.fixedTimeIso, forceLod0Report?.fixedTimeIso],
    [
      "browser.version",
      normalReport?.browser?.version,
      forceLod0Report?.browser?.version,
    ],
    [
      "runtimeIdentity.identitySha256",
      normalReport?.runtimeIdentity?.identitySha256,
      forceLod0Report?.runtimeIdentity?.identitySha256,
    ],
    [
      "setup.albedoUrl",
      normalReport?.setup?.albedoUrl,
      forceLod0Report?.setup?.albedoUrl,
    ],
    [
      "setup.normalUrl",
      normalReport?.setup?.normalUrl,
      forceLod0Report?.setup?.normalUrl,
    ],
  ]) {
    if (
      normalValue === undefined ||
      normalValue === null ||
      controlValue === undefined ||
      controlValue === null ||
      normalValue !== controlValue
    ) {
      failures.push(`paired reports do not share exact ${field}`);
    }
  }
  if (normalReport?.sampleCount !== MOON_MIP_SAMPLE_COUNT) {
    failures.push(
      `paired reports do not contain the pre-registered ${MOON_MIP_SAMPLE_COUNT}-sample count`,
    );
  }

  {
    const seenRequirements = new Set();
    const normalLaneById = new Map(
      (normalReport?.lanes ?? []).map((lane) => [lane.id, lane]),
    );
    const controlLaneById = new Map(
      (forceLod0Report?.lanes ?? []).map((lane) => [lane.id, lane]),
    );
    const validLaneIds = new Set(MOON_MIP_MOTION_LANES.map((lane) => lane.id));
    for (const requirement of PAIRED_SENSITIVITY_REQUIREMENTS) {
      const laneId = requirement?.laneId;
      const backend = requirement?.backend;
      const metric = requirement?.metric;
      const key = `${laneId}:${backend}:${metric}`;
      if (seenRequirements.has(key)) {
        failures.push(`duplicate paired sensitivity requirement ${key}`);
        continue;
      }
      seenRequirements.add(key);
      if (!validLaneIds.has(laneId)) {
        failures.push(`unknown paired sensitivity lane ${laneId}`);
        continue;
      }
      if (!BACKEND_IDS.includes(backend)) {
        failures.push(`unknown paired sensitivity backend ${backend}`);
        continue;
      }
      if (!PAIRED_SENSITIVITY_METRICS.includes(metric)) {
        failures.push(`unknown paired sensitivity metric ${metric}`);
        continue;
      }
      const normalValue = sensitivityMetricValue(
        normalLaneById.get(laneId),
        backend,
        metric,
      );
      const controlValue = sensitivityMetricValue(
        controlLaneById.get(laneId),
        backend,
        metric,
      );
      if (
        !Number.isFinite(normalValue) ||
        normalValue < 0 ||
        !Number.isFinite(controlValue) ||
        controlValue < 0
      ) {
        failures.push(`${key} did not provide finite non-negative values`);
        continue;
      }
      const controlMinusNormal = controlValue - normalValue;
      const normalToControlRatio =
        controlValue === 0 ? null : normalValue / controlValue;
      const controlMeetsAbsoluteGate =
        passesPairedSensitivityAbsoluteGate(controlMinusNormal);
      comparisons.push({
        laneId,
        backend,
        metric,
        normalValue,
        controlValue,
        controlMinusNormal,
        minimumControlMinusNormal: PAIRED_SENSITIVITY_MINIMUM_EFFECT,
        normalToControlRatio,
        controlStrictlyWorse: controlMeetsAbsoluteGate,
      });
      if (!controlMeetsAbsoluteGate) {
        failures.push(
          `${key} did not exceed normal by the derived minimum effect ${PAIRED_SENSITIVITY_MINIMUM_EFFECT}`,
        );
      }
    }
  }

  return {
    verdict: failures.length === 0 ? "PASS" : "FAIL",
    sensitive: failures.length === 0,
    failures,
    comparisons,
  };
}

async function installBrowserHarness(page) {
  return await page.evaluate(
    async ({ fixedTimeIso, lanes, controlModes }) => {
      const C = globalThis.Cesium;
      const webgl = globalThis.webglViewer;
      const webgpu = globalThis.webgpuViewer;
      if (!C || !webgl || !webgpu) {
        throw new Error("split comparison viewers were not available");
      }

      const fixedTime = C.JulianDate.fromIso8601(fixedTimeIso);
      const validControlModes = new Set(controlModes);
      let activeControlMode = null;
      try {
        await C.Transforms.preloadIcrfFixed(
          new C.TimeInterval({
            start: C.JulianDate.addDays(fixedTime, -1, new C.JulianDate()),
            stop: C.JulianDate.addDays(fixedTime, 1, new C.JulianDate()),
          }),
        );
      } catch (_error) {
        // The shared deterministic fallback transform remains a valid parity
        // lane when Earth-orientation preload data is unavailable offline.
      }

      const albedoUrl = C.Moon.getVariantTextureUrl(
        C.Moon.Variant.LROC_COLOR_2K,
      );
      const normalUrl = C.Moon.getVariantNormalMapUrl(
        C.Moon.Variant.LROC_COLOR_2K,
      );
      for (const viewer of [webgl, webgpu]) {
        viewer.resolutionScale = 1;
        viewer.clock.currentTime = C.JulianDate.clone(fixedTime);
        viewer.clock.startTime = C.JulianDate.clone(fixedTime);
        viewer.clock.stopTime = C.JulianDate.clone(fixedTime);
        viewer.clock.shouldAnimate = false;
        viewer.clock.multiplier = 0;
        const scene = viewer.scene;
        scene.requestRenderMode = false;
        scene.backgroundColor = C.Color.BLACK;
        scene.highDynamicRange = false;
        scene.globe.show = false;
        scene.imageryLayers.removeAll();
        if (scene.skyBox) {
          scene.skyBox.show = false;
          if (scene.skyBox.starField) {
            // The catalog starfield renders independently of skyBox.show.
            scene.skyBox.starField.show = false;
          }
        }
        scene.skyAtmosphere.show = false;
        scene.sun.show = false;
        scene.moon.show = true;
        scene.moon.onlySunLighting = false;
        scene.moon.textureUrl = albedoUrl;
        scene.moon.normalMapUrl = normalUrl;
        scene.moon.normalMapStrength = 1;
        // This lane isolates texture filtering from astronomical phase. A
        // camera-coincident directional light is updated with every camera
        // sample, so the whole visible hemisphere remains a non-vacuous
        // albedo+normal-map measurement at every seam orientation.
        scene.light = new C.DirectionalLight({
          direction: C.Cartesian3.clone(C.Cartesian3.UNIT_X),
        });
        if (scene.postProcessStages?.fxaa) {
          scene.postProcessStages.fxaa.enabled = false;
        }
        const conditions =
          scene.atmosphericConditions ?? scene.globe?.atmosphericConditions;
        if (conditions?.lighting) {
          conditions.lighting.enableMoonPhase = true;
          conditions.lighting.enableLunarNormalMap = true;
          conditions.lighting.enableMoonSkyWash = false;
          conditions.lighting.enableEarthshine = false;
        }
      }
      webgl.scene.moon._ellipsoidPrimitive.id = "c12-moon-mip-probe";

      for (const selector of [
        ".pane-label",
        ".pane-status",
        ".cesium-widget-credits",
      ]) {
        for (const element of document.querySelectorAll(selector)) {
          element.style.display = "none";
        }
      }

      const expectedMipCount = (width, height) =>
        Number.isFinite(width) && Number.isFinite(height)
          ? Math.floor(Math.log2(Math.max(width, height))) + 1
          : null;
      const textureDimensions = (texture, width, height) => ({
        width: texture?.width ?? width ?? null,
        height: texture?.height ?? height ?? null,
      });
      const channelMipDiagnostics = (stats, dimensions, channel) => {
        const albedo = channel === "albedo";
        const actualMipLevelCount = albedo
          ? (stats?.moonTextureMipLevelCount ??
            stats?.albedoTextureMipLevelCount ??
            stats?.lifecycle?.albedo?.mipLevelCount ??
            null)
          : (stats?.normalTextureMipLevelCount ??
            stats?.lifecycle?.normal?.mipLevelCount ??
            null);
        const maxLod = albedo
          ? (stats?.moonTextureMaxLod ??
            stats?.albedoTextureMaxLod ??
            stats?.lifecycle?.albedo?.maxLod ??
            null)
          : (stats?.normalTextureMaxLod ??
            stats?.lifecycle?.normal?.maxLod ??
            null);
        const expected = expectedMipCount(dimensions.width, dimensions.height);
        return {
          ...dimensions,
          actualMipLevelCount,
          expectedMipLevelCount: expected,
          maxLod,
          fullChain:
            expected !== null &&
            actualMipLevelCount === expected &&
            maxLod === expected - 1,
        };
      };
      const backendDiagnostics = (viewer) => {
        const scene = viewer.scene;
        const moon = scene.moon;
        const stats = moon.getDebugStatistics(scene);
        const webgpuBackend = scene.context.rendererType === "webgpu";
        const cache = moon._webgpuCache;
        const albedoDimensions = webgpuBackend
          ? textureDimensions(
              undefined,
              cache?.moonTextureWidth,
              cache?.moonTextureHeight,
            )
          : textureDimensions(moon._albedoMapTexture);
        const normalDimensions = webgpuBackend
          ? textureDimensions(
              undefined,
              cache?.normalTextureWidth,
              cache?.normalTextureHeight,
            )
          : textureDimensions(moon._normalMapTexture);
        return {
          rendererType: scene.context.rendererType,
          frameNumber: scene._frameState.frameNumber,
          clockOffsetSeconds: C.JulianDate.secondsDifference(
            viewer.clock.currentTime,
            fixedTime,
          ),
          textureLoaded:
            stats?.moonTextureLoaded === true ||
            stats?.albedoTextureLoaded === true,
          normalLoaded:
            stats?.normalMapLoaded === true ||
            stats?.normalTextureLoaded === true,
          pipelineReady: webgpuBackend ? stats?.pipelineReady === true : true,
          mips: {
            albedo: channelMipDiagnostics(stats, albedoDimensions, "albedo"),
            normal: channelMipDiagnostics(stats, normalDimensions, "normal"),
          },
          pendingTextureMipJobs: webgpuBackend
            ? (scene.context._pendingTextureMipJobs?.length ?? null)
            : 0,
          moonStatistics: stats,
        };
      };
      const diagnostics = () => ({
        webgl: backendDiagnostics(webgl),
        webgpu: backendDiagnostics(webgpu),
      });
      const diagnosticsReady = (snapshot) =>
        snapshot.webgl.rendererType === "webgl" &&
        snapshot.webgpu.rendererType === "webgpu" &&
        snapshot.webgl.textureLoaded &&
        snapshot.webgl.normalLoaded &&
        snapshot.webgpu.textureLoaded &&
        snapshot.webgpu.normalLoaded &&
        snapshot.webgpu.pipelineReady &&
        snapshot.webgl.mips.albedo.fullChain &&
        snapshot.webgl.mips.normal.fullChain &&
        snapshot.webgpu.mips.albedo.fullChain &&
        snapshot.webgpu.mips.normal.fullChain &&
        snapshot.webgpu.pendingTextureMipJobs === 0;

      const nextAnimationFrame = () =>
        new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
      const waitForReadiness = async (timeoutMs) => {
        const started = performance.now();
        const deadline = started + timeoutMs;
        let snapshot = diagnostics();
        while (performance.now() < deadline) {
          for (const viewer of [webgl, webgpu]) {
            viewer.clock.currentTime = C.JulianDate.clone(fixedTime);
            viewer.scene.requestRender();
          }
          await nextAnimationFrame();
          snapshot = diagnostics();
          if (diagnosticsReady(snapshot)) {
            return {
              ready: true,
              elapsedWallClockMs: performance.now() - started,
              diagnostics: snapshot,
            };
          }
        }
        return {
          ready: false,
          elapsedWallClockMs: performance.now() - started,
          diagnostics: snapshot,
        };
      };

      const normalized = (value) => {
        const magnitude = Math.hypot(value[0], value[1], value[2]);
        return value.map((component) => component / magnitude);
      };
      const laneById = new Map(lanes.map((lane) => [lane.id, lane]));
      const positionViewer = (viewer, lane, sampleIndex, sampleCount) => {
        const scene = viewer.scene;
        const moon = scene.moon;
        const matrix = moon._ellipsoidPrimitive.modelMatrix;
        const center = C.Matrix4.getTranslation(matrix, new C.Cartesian3());
        const fraction = sampleIndex / (sampleCount - 1);
        const angle = lane.angularSweepRadians * (2 * fraction - 1);
        const base = lane.localCameraDirection;
        const cosine = Math.cos(angle);
        const sine = Math.sin(angle);
        const localDirection = normalized([
          base[0] * cosine - base[1] * sine,
          base[0] * sine + base[1] * cosine,
          0,
        ]);
        const directionVector = C.Matrix4.multiplyByPointAsVector(
          matrix,
          new C.Cartesian3(...localDirection),
          new C.Cartesian3(),
        );
        C.Cartesian3.normalize(directionVector, directionVector);
        const localUp = C.Matrix4.multiplyByPointAsVector(
          matrix,
          C.Cartesian3.UNIT_Z,
          new C.Cartesian3(),
        );
        C.Cartesian3.normalize(localUp, localUp);
        const localXAxis = C.Matrix4.multiplyByPointAsVector(
          matrix,
          C.Cartesian3.UNIT_X,
          new C.Cartesian3(),
        );
        const localYAxis = C.Matrix4.multiplyByPointAsVector(
          matrix,
          C.Cartesian3.UNIT_Y,
          new C.Cartesian3(),
        );
        C.Cartesian3.normalize(localXAxis, localXAxis);
        C.Cartesian3.normalize(localYAxis, localYAxis);

        const frustum = viewer.camera.frustum;
        if ("fov" in frustum) {
          frustum.fov = C.Math.toRadians(50);
        }
        const fovy = frustum.fovy ?? frustum.fov;
        const canvasHeight = scene.canvas.getBoundingClientRect().height;
        const focalPixels = canvasHeight / (2 * Math.tan(fovy * 0.5));
        const radius = moon.ellipsoid.maximumRadius;
        const projectedRadius = lane.targetDiscDiameterPx * 0.5;
        const tangentDistance = (radius * focalPixels) / projectedRadius;
        const centerDistance = Math.sqrt(
          radius * radius + tangentDistance * tangentDistance,
        );
        const offset = C.Cartesian3.multiplyByScalar(
          directionVector,
          centerDistance,
          new C.Cartesian3(),
        );
        const cameraPosition = C.Cartesian3.add(
          center,
          offset,
          new C.Cartesian3(),
        );
        const viewDirection = C.Cartesian3.normalize(
          C.Cartesian3.subtract(center, cameraPosition, new C.Cartesian3()),
          new C.Cartesian3(),
        );
        // DirectionalLight.direction is the direction photons travel. Point
        // it from the camera toward the Moon; UniformState negates it to the
        // surface-to-light vector used by both Moon shaders.
        scene.light.direction = C.Cartesian3.clone(
          viewDirection,
          scene.light.direction,
        );
        viewer.camera.setView({
          destination: cameraPosition,
          orientation: { direction: viewDirection, up: localUp },
        });
        viewer.clock.currentTime = C.JulianDate.clone(fixedTime);
        scene.requestRender();
        return {
          frameNumberBefore: scene._frameState.frameNumber,
          requestedCameraWorldPosition: [
            cameraPosition.x,
            cameraPosition.y,
            cameraPosition.z,
          ],
          requestedDirectionWC: [
            viewDirection.x,
            viewDirection.y,
            viewDirection.z,
          ],
          requestedUpWC: [localUp.x, localUp.y, localUp.z],
          moonCenterWorld: [center.x, center.y, center.z],
          moonLocalToWorldBasis: {
            xWC: [localXAxis.x, localXAxis.y, localXAxis.z],
            yWC: [localYAxis.x, localYAxis.y, localYAxis.z],
            zWC: [localUp.x, localUp.y, localUp.z],
          },
          requestedCameraLocalDirection: localDirection,
          centerDistanceMeters: centerDistance,
          altitudeAboveMoonMeters: centerDistance - radius,
          moonRadiusMeters: radius,
          lightingFixture: "camera-coincident-directional-light",
          targetDiscDiameterPx: lane.targetDiscDiameterPx,
          canvasHeight,
          fovyRadians: fovy,
        };
      };

      const xyz = (value) => [value.x, value.y, value.z];
      const postSyncCameraPose = (viewer, requested) => {
        const camera = viewer.camera;
        const position = C.Cartesian3.clone(camera.positionWC);
        const direction = C.Cartesian3.clone(camera.directionWC);
        const right = C.Cartesian3.clone(camera.rightWC);
        const up = C.Cartesian3.clone(camera.upWC);
        const moonCenter = new C.Cartesian3(...requested.moonCenterWorld);
        const outward = C.Cartesian3.normalize(
          C.Cartesian3.subtract(position, moonCenter, new C.Cartesian3()),
          new C.Cartesian3(),
        );
        const toMoon = C.Cartesian3.negate(outward, new C.Cartesian3());
        const inverseMoonMatrix = C.Matrix4.inverseTransformation(
          viewer.scene.moon._ellipsoidPrimitive.modelMatrix,
          new C.Matrix4(),
        );
        const localOutward = C.Matrix4.multiplyByPointAsVector(
          inverseMoonMatrix,
          outward,
          new C.Cartesian3(),
        );
        C.Cartesian3.normalize(localOutward, localOutward);
        const directionCrossUp = C.Cartesian3.cross(
          direction,
          up,
          new C.Cartesian3(),
        );
        const requestedPosition = new C.Cartesian3(
          ...requested.requestedCameraWorldPosition,
        );
        const requestedDirection = new C.Cartesian3(
          ...requested.requestedDirectionWC,
        );
        const requestedUp = new C.Cartesian3(...requested.requestedUpWC);
        return {
          cameraWorldPosition: xyz(position),
          directionWC: xyz(direction),
          rightWC: xyz(right),
          upWC: xyz(up),
          cameraLocalDirection: xyz(localOutward),
          seamNormalDot: -localOutward.x,
          positionErrorMeters: C.Cartesian3.distance(
            position,
            requestedPosition,
          ),
          directionDotRequested: C.Cartesian3.dot(
            direction,
            requestedDirection,
          ),
          upDotRequested: C.Cartesian3.dot(up, requestedUp),
          directionToMoonDot: C.Cartesian3.dot(direction, toMoon),
          basis: {
            directionMagnitude: C.Cartesian3.magnitude(direction),
            rightMagnitude: C.Cartesian3.magnitude(right),
            upMagnitude: C.Cartesian3.magnitude(up),
            directionRightDot: C.Cartesian3.dot(direction, right),
            directionUpDot: C.Cartesian3.dot(direction, up),
            rightUpDot: C.Cartesian3.dot(right, up),
            handedness: C.Cartesian3.dot(directionCrossUp, right),
          },
        };
      };

      const poseDelta = (left, right) => ({
        positionMeters: Math.hypot(
          ...left.cameraWorldPosition.map(
            (component, index) => component - right.cameraWorldPosition[index],
          ),
        ),
        direction: Math.hypot(
          ...left.directionWC.map(
            (component, index) => component - right.directionWC[index],
          ),
        ),
        right: Math.hypot(
          ...left.rightWC.map(
            (component, index) => component - right.rightWC[index],
          ),
        ),
        up: Math.hypot(
          ...left.upWC.map((component, index) => component - right.upWC[index]),
        ),
      });

      const poseIsStable = (delta) =>
        delta.positionMeters <= 1e-4 &&
        delta.direction <= 1e-12 &&
        delta.right <= 1e-12 &&
        delta.up <= 1e-12;

      const moveTrackedCamera = async (
        laneId,
        sampleIndex,
        sampleCount,
        timeoutMs,
      ) => {
        const lane = laneById.get(laneId);
        if (!lane) {
          throw new Error(`unknown Moon motion lane: ${laneId}`);
        }
        const records = {
          webgl: positionViewer(webgl, lane, sampleIndex, sampleCount),
          webgpu: positionViewer(webgpu, lane, sampleIndex, sampleCount),
        };
        const deadline = performance.now() + timeoutMs;
        let previousPoses = null;
        let stableFrameCount = 0;
        while (performance.now() < deadline) {
          await nextAnimationFrame();
          const webglFrame = webgl.scene._frameState.frameNumber;
          const webgpuFrame = webgpu.scene._frameState.frameNumber;
          if (
            webglFrame > records.webgl.frameNumberBefore &&
            webgpuFrame > records.webgpu.frameNumberBefore
          ) {
            const currentPoses = {
              webgl: postSyncCameraPose(webgl, records.webgl),
              webgpu: postSyncCameraPose(webgpu, records.webgpu),
            };
            if (
              previousPoses !== null &&
              poseIsStable(
                poseDelta(currentPoses.webgl, previousPoses.webgl),
              ) &&
              poseIsStable(poseDelta(currentPoses.webgpu, previousPoses.webgpu))
            ) {
              stableFrameCount++;
            } else {
              stableFrameCount = 0;
            }
            previousPoses = currentPoses;
            if (stableFrameCount >= 2) {
              for (const [backend, viewer, frameNumber] of [
                ["webgl", webgl, webglFrame],
                ["webgpu", webgpu, webgpuFrame],
              ]) {
                Object.assign(records[backend], currentPoses[backend], {
                  frameNumber,
                  clockOffsetSeconds: C.JulianDate.secondsDifference(
                    viewer.clock.currentTime,
                    fixedTime,
                  ),
                  postSyncStableFrameCount: stableFrameCount,
                  poseSource: "post-sync-camera-world-coordinates",
                });
              }
              records.backendPoseDelta = poseDelta(
                currentPoses.webgl,
                currentPoses.webgpu,
              );
              return records;
            }
          }
        }
        throw new Error(
          `camera sample ${laneId}/${sampleIndex} missed its ${timeoutMs}ms wall-clock render deadline`,
        );
      };

      const compileWebGLPick = async () => {
        const scene = webgl.scene;
        const primitive = scene.moon._ellipsoidPrimitive;
        const canvas = scene.canvas;
        const picked = await Promise.resolve(
          scene.pick(
            new C.Cartesian2(
              canvas.clientWidth * 0.5,
              canvas.clientHeight * 0.5,
            ),
          ),
        );
        scene.requestRender();
        await nextAnimationFrame();
        return {
          colorProgramReady: primitive._sp !== undefined,
          pickProgramReady: primitive._pickSP !== undefined,
          colorDefines: Array.from(
            primitive._sp?.fragmentShaderSource?.defines ?? [],
          ),
          pickDefines: Array.from(
            primitive._pickSP?.fragmentShaderSource?.defines ?? [],
          ),
          picked: picked !== undefined,
          pickedId: picked?.id ?? null,
          pickedProbeId: picked?.id === "c12-moon-mip-probe",
        };
      };

      const applyControlMode = async (requestedMode) => {
        if (!validControlModes.has(requestedMode)) {
          throw new Error(`unknown Moon mip control mode: ${requestedMode}`);
        }
        if (activeControlMode !== null && activeControlMode !== requestedMode) {
          throw new Error(
            `Moon mip control already fixed to ${activeControlMode}; refusing ${requestedMode}`,
          );
        }

        if (requestedMode === "normal") {
          activeControlMode = requestedMode;
          return {
            requestedMode,
            appliedMode: activeControlMode,
            webgl: { baseLevelOnly: false },
            webgpu: { baseLevelOnly: false, bindGroupRebuilt: false },
          };
        }

        const webglMoon = webgl.scene.moon;
        const albedoTexture = webglMoon._albedoMapTexture;
        const normalTexture = webglMoon._normalMapTexture;
        if (!albedoTexture || !normalTexture) {
          throw new Error(
            "force-lod0 requires current WebGL albedo and normal textures",
          );
        }
        const webglSampler = new C.Sampler({
          wrapS: C.TextureWrap.REPEAT,
          wrapT: C.TextureWrap.CLAMP_TO_EDGE,
          minificationFilter: C.TextureMinificationFilter.LINEAR,
          magnificationFilter: C.TextureMagnificationFilter.LINEAR,
        });
        albedoTexture.sampler = webglSampler;
        normalTexture.sampler = webglSampler;

        const webgpuScene = webgpu.scene;
        const cache = webgpuScene.moon._webgpuCache;
        const device = webgpuScene.context._device;
        if (!cache?.bindGroup || !cache?.sampler || !device) {
          throw new Error(
            "force-lod0 requires a current WebGPU Moon bind group and sampler",
          );
        }
        const previousBindGroup = cache.bindGroup;
        const descriptor = {
          minFilter: "linear",
          magFilter: "linear",
          mipmapFilter: "linear",
          addressModeU: "repeat",
          addressModeV: "clamp-to-edge",
          lodMinClamp: 0,
          lodMaxClamp: 0,
        };
        cache.sampler = device.createSampler(descriptor);
        const bundleManager = webgpuScene.context.renderBundleManager;
        let bundleInvalidated = false;
        if (bundleManager && cache._bundleKey !== undefined) {
          bundleManager.invalidate(cache._bundleKey);
          cache._bundleInvalidationCount =
            (cache._bundleInvalidationCount ?? 0) + 1;
          bundleInvalidated = true;
        }
        cache.bindGroup = undefined;
        cache.bundle = undefined;
        cache.command = undefined;
        cache._bundleStale = true;
        activeControlMode = requestedMode;

        for (const viewer of [webgl, webgpu]) {
          viewer.scene.requestRender();
        }
        const deadline = performance.now() + 10_000;
        while (performance.now() < deadline && !cache.bindGroup) {
          await nextAnimationFrame();
        }
        return {
          requestedMode,
          appliedMode: activeControlMode,
          webgl: {
            baseLevelOnly:
              albedoTexture.sampler.minificationFilter ===
                C.TextureMinificationFilter.LINEAR &&
              normalTexture.sampler.minificationFilter ===
                C.TextureMinificationFilter.LINEAR,
            albedoMinificationFilter: albedoTexture.sampler.minificationFilter,
            normalMinificationFilter: normalTexture.sampler.minificationFilter,
          },
          webgpu: {
            baseLevelOnly: descriptor.lodMaxClamp === 0,
            samplerDescriptor: descriptor,
            bundleInvalidated,
            bindGroupRebuilt:
              cache.bindGroup !== undefined &&
              cache.bindGroup !== previousBindGroup,
          },
        };
      };

      const drainGpu = async () => {
        const context = webgpu.scene.context;
        const device = context._device;
        if (!device?.queue?.onSubmittedWorkDone) {
          return {
            completed: false,
            pendingTextureMipJobs:
              context._pendingTextureMipJobs?.length ?? null,
          };
        }
        await device.queue.onSubmittedWorkDone();
        await nextAnimationFrame();
        return {
          completed: true,
          pendingTextureMipJobs: context._pendingTextureMipJobs?.length ?? null,
        };
      };

      globalThis.__c12MoonMipMotionProbe = {
        waitForReadiness,
        moveTrackedCamera,
        compileWebGLPick,
        applyControlMode,
        drainGpu,
        diagnostics,
      };
      const loadedCesiumScriptUrl = Array.from(document.scripts)
        .map((script) => script.src)
        .find((source) =>
          /\/Build\/CesiumUnminified\/Cesium\.js$/u.test(source),
        );
      return {
        fixedTimeIso,
        albedoUrl,
        normalUrl,
        lightingFixture: "camera-coincident-directional-light",
        catalogStarFieldDisabled: [webgl, webgpu].every(
          (viewer) => viewer.scene.skyBox?.starField?.show === false,
        ),
        sameJavaScriptRealm:
          webgl.scene.canvas.ownerDocument.defaultView ===
          webgpu.scene.canvas.ownerDocument.defaultView,
        adapterIdentity: {
          kind: "Apps/WebGPUTest/split-screen-comparison.html",
          loadedCesiumScriptUrl: loadedCesiumScriptUrl ?? null,
          globalCesiumObjectPresent: typeof C === "object" && C !== null,
          globalMoonConstructorPresent: typeof C.Moon === "function",
          webglMoonUsesGlobalConstructor:
            webgl.scene.moon?.constructor === C.Moon,
          webgpuMoonUsesGlobalConstructor:
            webgpu.scene.moon?.constructor === C.Moon,
          distinctMoonInstances: webgl.scene.moon !== webgpu.scene.moon,
          webglSceneUsesGlobalConstructor: webgl.scene?.constructor === C.Scene,
          webgpuSceneUsesGlobalConstructor:
            webgpu.scene?.constructor === C.Scene,
        },
      };
    },
    {
      fixedTimeIso: FIXED_TIME_ISO,
      lanes: MOON_MIP_MOTION_LANES,
      controlModes: MOON_MIP_CONTROL_MODES,
    },
  );
}

async function runProbe() {
  const controlMode = parseControlMode();
  activeInvocationControlMode = controlMode;
  const runId = parseRunId() ?? generatedRunId();
  activeInvocationRunId = runId;
  const outputPath = resolve(
    process.argv[2] ?? defaultOutputPath(controlMode, runId),
  );
  activeInvocationOutputPath = outputPath;
  const evidenceDirectory = /\.json$/i.test(outputPath)
    ? outputPath.replace(/\.json$/i, "-frames")
    : `${outputPath}-frames`;
  const sampleCount = parseSampleCount();
  const base = process.env.PROBE_BASE ?? "http://localhost:8080";
  const viewerUrlObject = new URL(
    "/Apps/WebGPUTest/split-screen-comparison.html",
    base,
  );
  viewerUrlObject.searchParams.set("baseLayer", "false");
  const viewerUrl = viewerUrlObject.href;
  const headed = process.env.PROBE_HEADED === "1";
  const capturedProducerSourceIdentity = await producerSourceIdentity();

  await mkdirWithoutSymbolicAncestors(dirname(outputPath));
  await mkdir(evidenceDirectory, { recursive: false });

  const browser = await chromium.launch({
    channel: "msedge",
    headless: !headed,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--disable-cache",
    ],
  });
  let context;
  let completedReport;
  let executionError;
  let cleanupResults;
  try {
    context = await browser.newContext({
      viewport: { width: 1600, height: 900 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(90_000);
    const gpuConsoleFaults = attachConsoleErrorGate(page);
    const pageErrors = [];
    const consoleMessages = [];
    const requestFailures = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") {
        consoleMessages.push({
          type: message.type(),
          text: message.text(),
        });
      }
    });
    page.on("requestfailed", (request) => {
      requestFailures.push({
        url: request.url(),
        errorText: request.failure()?.errorText ?? null,
      });
    });
    await page.addInitScript(errorGateInit);
    await page.goto(viewerUrl, {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
    await page.locator("#btnLaunch").click();
    await page.waitForFunction(
      () => globalThis.webglViewer && globalThis.webgpuViewer,
      undefined,
      { timeout: 90_000 },
    );
    const gpuGateArm = await armWebGPUDevices(page);
    const setup = await installBrowserHarness(page);
    const capturedRuntimeIdentity = await runtimeIdentity(
      base,
      viewerUrl,
      setup,
      capturedProducerSourceIdentity,
    );
    const readiness = await page.evaluate(() =>
      globalThis.__c12MoonMipMotionProbe.waitForReadiness(60_000),
    );
    const control = await page.evaluate(
      (requestedMode) =>
        globalThis.__c12MoonMipMotionProbe.applyControlMode(requestedMode),
      controlMode,
    );

    const lanes = [];
    let webglShaderCompile = null;
    for (const lane of MOON_MIP_MOTION_LANES) {
      const motion = [];
      const rawFrames = { webgl: [], webgpu: [] };
      const publicFrames = { webgl: [], webgpu: [] };
      for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
        const cameraSample = await page.evaluate(
          ({ laneId, sampleIndex, sampleCount }) =>
            globalThis.__c12MoonMipMotionProbe.moveTrackedCamera(
              laneId,
              sampleIndex,
              sampleCount,
              10_000,
            ),
          { laneId: lane.id, sampleIndex, sampleCount },
        );
        motion.push(cameraSample);

        for (const [backend, selector] of [
          ["webgl", "#leftViewer canvas"],
          ["webgpu", "#rightViewer canvas"],
        ]) {
          const pngPath = resolve(
            evidenceDirectory,
            `${lane.id}-${String(sampleIndex).padStart(2, "0")}-${backend}.png`,
          );
          const buffer = await page.locator(selector).first().screenshot({
            path: pngPath,
            type: "png",
            animations: "disabled",
          });
          const frame = await analyzePng(buffer);
          rawFrames[backend].push(frame);
          publicFrames[backend].push(
            publicFrameMetric(
              frame,
              portableEvidencePath(outputPath, pngPath),
              buffer,
            ),
          );
        }
      }

      if (lane.id === "close") {
        webglShaderCompile = await page.evaluate(() =>
          globalThis.__c12MoonMipMotionProbe.compileWebGLPick(),
        );
      }

      const backendEvidence = {};
      for (const backend of ["webgl", "webgpu"]) {
        const temporal = computeTemporalSeries(rawFrames[backend]);
        Object.assign(
          temporal,
          recomputeTemporalSummary(publicFrames[backend], temporal.pairs),
        );
        backendEvidence[backend] = {
          captureKind: "playwright-canvas-element-png",
          canvasSelector:
            backend === "webgl" ? "#leftViewer canvas" : "#rightViewer canvas",
          frames: publicFrames[backend],
          spatial: summarizeSpatial(publicFrames[backend]),
          temporal,
        };
      }
      const parity = computeParitySeries(rawFrames.webgl, rawFrames.webgpu);
      parity.samples.forEach((sample, sampleIndex) => {
        sample.spatialHighFrequencyRatio =
          publicFrames.webgpu[sampleIndex].normalizedSpatialHighFrequency /
          Math.max(
            1e-9,
            publicFrames.webgl[sampleIndex].normalizedSpatialHighFrequency,
          );
      });
      Object.assign(parity, recomputeParitySummary(parity.samples));
      lanes.push({
        ...lane,
        motion,
        motionSummary: {
          webgl: cameraMotionSummary(motion, "webgl"),
          webgpu: cameraMotionSummary(motion, "webgpu"),
        },
        backends: backendEvidence,
        parity,
      });
    }

    const gpuDrain = await page.evaluate(() =>
      globalThis.__c12MoonMipMotionProbe.drainGpu(),
    );
    const finalDiagnostics = await page.evaluate(() =>
      globalThis.__c12MoonMipMotionProbe.diagnostics(),
    );
    const gpuGate = await collectGateErrors(page);

    const laneById = Object.fromEntries(lanes.map((lane) => [lane.id, lane]));
    const spatialScale = {};
    for (const backend of ["webgl", "webgpu"]) {
      const close =
        laneById.close.backends[backend].spatial
          .normalizedSpatialHighFrequencyMean;
      const minified =
        laneById["minified-16px"].backends[backend].spatial
          .normalizedSpatialHighFrequencyMean;
      spatialScale[backend] = {
        close,
        minified,
        minifiedToCloseRatio: minified / Math.max(1e-9, close),
      };
    }

    const report = {
      schemaVersion: 1,
      campaign: "C12-33",
      probe: "probe-moon-mip-motion-edge",
      certificationClaim: C12_33_SHIMMER_ENVELOPE_CERTIFICATION,
      doesNotMeasure: [...C12_33_DOES_NOT_MEASURE],
      designId: MOON_MIP_PREREGISTRATION_DESIGN_ID,
      preregistrationSha256: MOON_MIP_PREREGISTRATION_SHA256,
      filedDiscrepancy: C12_33_FILED_DESIGN_DISCREPANCY,
      runId,
      capturedAt: new Date().toISOString(),
      controlMode,
      viewerUrl,
      fixedTimeIso: FIXED_TIME_ISO,
      sampleCount,
      browser: {
        channel: "msedge",
        version: await browser.version(),
        headed,
      },
      runtimeIdentity: capturedRuntimeIdentity,
      setup,
      readiness,
      control,
      webglShaderCompile,
      lanes,
      spatialScale,
      finalDiagnostics,
      gpuDrain,
      gpuGateArm,
      gpuGate,
      gpuConsoleFaults,
      pageErrors,
      consoleMessages,
      requestFailures,
      calibratedThresholds: CALIBRATED_THRESHOLDS,
      manualInspection: {
        required: MANUAL_INSPECTION_REQUIREMENT.required,
        status: MANUAL_INSPECTION_REQUIREMENT.status,
        requiredLaneIds: [...MANUAL_INSPECTION_REQUIREMENT.requiredLaneIds],
        checks: [...MANUAL_INSPECTION_REQUIREMENT.checks],
        evidence: [],
      },
    };
    const hardFailures = validateStructuralEvidence(report);
    const qualityFailures = evaluateCalibratedQuality(
      report,
      CALIBRATED_THRESHOLDS,
    );
    report.result = {
      ...decideVerdict(
        hardFailures,
        qualityFailures,
        CALIBRATED_THRESHOLDS,
        report.manualInspection,
      ),
      hardFailures,
      qualityFailures,
    };
    report.measurementStatus = deriveMeasurementStatus(
      report.result,
      CALIBRATED_THRESHOLDS,
      report.manualInspection,
    );
    Object.assign(report, classifyRawReport(report.result));
    completedReport = report;
  } catch (error) {
    executionError = error;
  } finally {
    // Teardown belongs in a `finally`, not after the catch: a throw from inside
    // the catch clause would otherwise skip it and strand a headless Edge plus
    // its GPU process for the life of the run.
    cleanupResults = await Promise.allSettled([
      context?.close() ?? Promise.resolve(),
      browser.close(),
    ]);
  }
  const cleanupFailures = cleanupResults
    .filter((result) => result.status === "rejected")
    .map((result) => String(result.reason?.stack ?? result.reason));
  if (cleanupFailures.length > 0) {
    const cleanupError = new Error(
      `Moon mip probe cleanup failed: ${cleanupFailures.join("; ")}`,
      executionError ? { cause: executionError } : undefined,
    );
    cleanupError.failureKind = "CLEANUP";
    throw cleanupError;
  }
  if (executionError) {
    throw executionError;
  }
  await writeFile(outputPath, `${JSON.stringify(completedReport, null, 2)}\n`, {
    flag: "wx",
  });
  console.log(JSON.stringify(completedReport, null, 2));
  console.error(
    `[${C12_33_SHIMMER_ENVELOPE_CERTIFICATION}] ${completedReport.status} — ${outputPath} ` +
      `(hardFailures=${completedReport.result.hardFailures.length}, qualityFailures=${completedReport.result.qualityFailures.length})`,
  );
  return completedReport;
}

const isMainModule =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  runProbe()
    .then((report) => {
      process.exitCode = report.exitCode;
    })
    .catch(async (error) => {
      await emitFatalProbeArtifact(error, error?.failureKind ?? "ERROR");
      console.error(error?.stack ?? error);
      process.exitCode = EXIT_CODES.FAIL;
    })
    .finally(() => {
      clearTimeout(watchdog);
    });
}
