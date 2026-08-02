#!/usr/bin/env node
/**
 * C12-33 — moving-camera Moon mip/seam acceptance in real Microsoft Edge.
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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import sharp from "sharp";
import {
  armWebGPUDevices,
  attachConsoleErrorGate,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";

export const FIXED_TIME_ISO = "2026-07-02T16:22:00Z";
export const EXIT_CODES = Object.freeze({ PASS: 0, FAIL: 1, INCONCLUSIVE: 2 });
export const MOON_MIP_CONTROL_MODES = Object.freeze(["normal", "force-lod0"]);

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

const toolDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = resolve(toolDirectory, "..", "..");
function generatedRunId() {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
}

let activeInvocationRunId = null;

export function parseRunId(value = process.env.C12_MOON_MIP_RUN_ID) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }
  const normalized = String(value).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(normalized)) {
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
      exitCode: EXIT_CODES.INCONCLUSIVE,
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
      exitCode: EXIT_CODES.INCONCLUSIVE,
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

function publicFrameMetric(metric, pngPath, pngBuffer) {
  return {
    pngPath,
    pngSha256: createHash("sha256")
      .update(pngBuffer)
      .digest("hex")
      .toUpperCase(),
    width: metric.width,
    height: metric.height,
    coveredPixels: metric.coveredPixels,
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

async function runtimeBundleIdentity() {
  const bundlePath = resolve(
    repositoryDirectory,
    "Build",
    "CesiumUnminified",
    "Cesium.js",
  );
  try {
    const bytes = await readFile(bundlePath);
    return {
      path: "Build/CesiumUnminified/Cesium.js",
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex").toUpperCase(),
    };
  } catch (error) {
    return {
      path: "Build/CesiumUnminified/Cesium.js",
      error: String(error?.message ?? error),
    };
  }
}

function parseSampleCount() {
  const parsed = Number(process.env.C12_MOON_MIP_SAMPLES ?? 13);
  if (!Number.isInteger(parsed) || parsed < 5 || parsed % 2 === 0) {
    throw new Error(
      "C12_MOON_MIP_SAMPLES must be an odd integer greater than or equal to 5",
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

function summarizeSpatial(frames) {
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

function cameraMotionSummary(motion, backend) {
  const positions = motion.map((sample) => sample[backend].cameraWorldPosition);
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

function validateStructuralEvidence(report) {
  const failures = [];
  const ready = report.readiness?.diagnostics;
  if (report.setup?.sameJavaScriptRealm !== true) {
    failures.push(
      "split viewers were not proven to share one JavaScript realm",
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
    for (const channel of ["albedo", "normal"]) {
      const mip = report.finalDiagnostics?.[backend]?.mips?.[channel];
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
  if (
    !Number.isInteger(report.sampleCount) ||
    report.sampleCount < 5 ||
    report.sampleCount % 2 === 0
  ) {
    failures.push(
      `sampleCount must be an odd integer greater than or equal to 5; received ${report.sampleCount}`,
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

  for (const lane of actualLanes) {
    const minimumInteriorPixels = lane.id === "minified-16px" ? 20 : 1000;
    if (lane.motion?.length !== report.sampleCount) {
      failures.push(
        `${lane.id} recorded ${lane.motion?.length ?? 0} camera sample(s), expected ${report.sampleCount}`,
      );
    }
    for (const backend of ["webgl", "webgpu"]) {
      const evidence = lane.backends?.[backend];
      if (evidence?.frames?.length !== report.sampleCount) {
        failures.push(
          `${lane.id}/${backend} captured ${evidence?.frames?.length ?? 0} canvas PNG(s), expected ${report.sampleCount}`,
        );
      }
      if ((evidence?.spatial?.discDiameterPxMin ?? 0) <= 0) {
        failures.push(`${lane.id}/${backend} had no illuminated Moon pixels`);
      }
      const minimumFrameInterior = Math.min(
        ...(evidence?.frames ?? []).map((frame) => frame.interiorPixels),
      );
      if (
        !Number.isFinite(minimumFrameInterior) ||
        minimumFrameInterior < minimumInteriorPixels
      ) {
        failures.push(
          `${lane.id}/${backend} had ${minimumFrameInterior} interior pixel(s), below the non-vacuous floor ${minimumInteriorPixels}`,
        );
      }
      if (
        (evidence?.temporal?.comparedPixelsMin ?? 0) < minimumInteriorPixels
      ) {
        failures.push(
          `${lane.id}/${backend} temporal overlap was below the non-vacuous floor ${minimumInteriorPixels}`,
        );
      }
      if (evidence?.temporal?.pairCount !== report.sampleCount - 1) {
        failures.push(
          `${lane.id}/${backend} recorded ${evidence?.temporal?.pairCount ?? 0} temporal pair(s), expected ${report.sampleCount - 1}`,
        );
      }
      if ((lane.motionSummary?.[backend]?.minStepDistanceMeters ?? 0) <= 0.1) {
        failures.push(
          `${lane.id}/${backend} camera track contained a stationary step`,
        );
      }
      if (
        (lane.motionSummary?.[backend]?.frameAdvance ?? 0) <
        report.sampleCount - 1
      ) {
        failures.push(
          `${lane.id}/${backend} did not advance a rendered frame per camera sample`,
        );
      }
      const unpinnedSample = (lane.motion ?? []).find(
        (sample) => Math.abs(sample[backend].clockOffsetSeconds) > 1e-9,
      );
      if (unpinnedSample) {
        failures.push(
          `${lane.id}/${backend} camera route advanced the pinned clock`,
        );
      }
    }

    if (lane.parity?.sampleCount !== report.sampleCount) {
      failures.push(
        `${lane.id} recorded ${lane.parity?.sampleCount ?? 0} parity sample(s), expected ${report.sampleCount}`,
      );
    }

    const target = lane.targetDiscDiameterPx;
    for (const backend of ["webgl", "webgpu"]) {
      const measured =
        lane.backends?.[backend]?.spatial?.discDiameterPxMedian ?? 0;
      const lower = lane.id === "minified-16px" ? 8 : target * 0.55;
      const upper = lane.id === "minified-16px" ? 28 : target * 1.45;
      if (measured < lower || measured > upper) {
        failures.push(
          `${lane.id}/${backend} measured ${measured}px, outside structural framing band ${lower}-${upper}px`,
        );
      }
    }

    const centerDots = (lane.motion ?? []).map((sample) =>
      Math.abs(sample.webgl.seamNormalDot),
    );
    if (
      lane.seamPlacement === "center" &&
      (centerDots.length !== report.sampleCount ||
        Math.max(...centerDots.map((value) => Math.abs(1 - value))) > 0.001)
    ) {
      failures.push(
        "seam-centered route did not keep the U seam at disc center",
      );
    }
    if (
      lane.seamPlacement === "limb" &&
      (centerDots.length !== report.sampleCount ||
        Math.max(...centerDots) > 0.03)
    ) {
      failures.push("seam-at-limb route did not keep the U seam on the limb");
    }
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

/**
 * Compare one structurally green normal report with its deliberately broken
 * base-level-only control. This helper establishes sensitivity direction; it
 * deliberately does not invent a numeric effect-size threshold. Calibration
 * owns that policy and supplies the exact cells/metrics it requires.
 */
export function evaluatePairedReportSensitivity(
  normalReport,
  forceLod0Report,
  requirements,
) {
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
      "runtimeBundle.sha256",
      normalReport?.runtimeBundle?.sha256,
      forceLod0Report?.runtimeBundle?.sha256,
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
  if (
    !Number.isInteger(normalReport?.sampleCount) ||
    normalReport.sampleCount < 5 ||
    normalReport.sampleCount % 2 === 0
  ) {
    failures.push("paired reports do not contain a valid odd sample count");
  }

  if (!Array.isArray(requirements) || requirements.length === 0) {
    failures.push("paired sensitivity requirements must be a non-empty array");
  } else {
    const seenRequirements = new Set();
    const normalLaneById = new Map(
      (normalReport?.lanes ?? []).map((lane) => [lane.id, lane]),
    );
    const controlLaneById = new Map(
      (forceLod0Report?.lanes ?? []).map((lane) => [lane.id, lane]),
    );
    const validLaneIds = new Set(MOON_MIP_MOTION_LANES.map((lane) => lane.id));
    for (const requirement of requirements) {
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
      comparisons.push({
        laneId,
        backend,
        metric,
        normalValue,
        controlValue,
        controlMinusNormal,
        normalToControlRatio,
        controlStrictlyWorse: controlValue > normalValue,
      });
      if (controlValue <= normalValue) {
        failures.push(
          `${key} did not prove force-lod0 was strictly worse than normal`,
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
        scene.skyBox.show = false;
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
          cameraWorldPosition: [
            cameraPosition.x,
            cameraPosition.y,
            cameraPosition.z,
          ],
          moonCenterWorld: [center.x, center.y, center.z],
          cameraLocalDirection: localDirection,
          centerDistanceMeters: centerDistance,
          altitudeAboveMoonMeters: centerDistance - radius,
          seamNormalDot: -localDirection[0],
          lightingFixture: "camera-coincident-directional-light",
          targetDiscDiameterPx: lane.targetDiscDiameterPx,
          canvasHeight,
          fovyRadians: fovy,
        };
      };

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
        while (performance.now() < deadline) {
          await nextAnimationFrame();
          const webglFrame = webgl.scene._frameState.frameNumber;
          const webgpuFrame = webgpu.scene._frameState.frameNumber;
          if (
            webglFrame > records.webgl.frameNumberBefore &&
            webgpuFrame > records.webgpu.frameNumberBefore
          ) {
            records.webgl.frameNumber = webglFrame;
            records.webgpu.frameNumber = webgpuFrame;
            records.webgl.clockOffsetSeconds = C.JulianDate.secondsDifference(
              webgl.clock.currentTime,
              fixedTime,
            );
            records.webgpu.clockOffsetSeconds = C.JulianDate.secondsDifference(
              webgpu.clock.currentTime,
              fixedTime,
            );
            return records;
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
      return {
        fixedTimeIso,
        albedoUrl,
        normalUrl,
        lightingFixture: "camera-coincident-directional-light",
        sameJavaScriptRealm:
          webgl.scene.canvas.ownerDocument.defaultView ===
          webgpu.scene.canvas.ownerDocument.defaultView,
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
  const runId = parseRunId() ?? generatedRunId();
  activeInvocationRunId = runId;
  const outputPath = resolve(
    process.argv[2] ?? defaultOutputPath(controlMode, runId),
  );
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

  await mkdir(dirname(outputPath), { recursive: true });
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
          publicFrames[backend].push(publicFrameMetric(frame, pngPath, buffer));
        }
      }

      if (lane.id === "close") {
        webglShaderCompile = await page.evaluate(() =>
          globalThis.__c12MoonMipMotionProbe.compileWebGLPick(),
        );
      }

      const backendEvidence = {};
      for (const backend of ["webgl", "webgpu"]) {
        backendEvidence[backend] = {
          captureKind: "playwright-canvas-element-png",
          canvasSelector:
            backend === "webgl" ? "#leftViewer canvas" : "#rightViewer canvas",
          frames: publicFrames[backend],
          spatial: summarizeSpatial(rawFrames[backend]),
          temporal: computeTemporalSeries(rawFrames[backend]),
        };
      }
      lanes.push({
        ...lane,
        motion,
        motionSummary: {
          webgl: cameraMotionSummary(motion, "webgl"),
          webgpu: cameraMotionSummary(motion, "webgpu"),
        },
        backends: backendEvidence,
        parity: computeParitySeries(rawFrames.webgl, rawFrames.webgpu),
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
      runtimeBundle: await runtimeBundleIdentity(),
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
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
      flag: "wx",
    });
    console.log(JSON.stringify(report, null, 2));
    console.error(
      `[C12-33] ${report.result.verdict} — ${outputPath} ` +
        `(hardFailures=${hardFailures.length}, qualityFailures=${qualityFailures.length})`,
    );
    return report;
  } finally {
    await context?.close();
    await browser.close();
  }
}

const isMainModule =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  runProbe()
    .then((report) => {
      process.exitCode = report.result.exitCode;
    })
    .catch(async (error) => {
      let fatalControlMode = "invalid-control";
      try {
        fatalControlMode = parseControlMode();
      } catch (_controlError) {
        // Preserve the original fail-closed parse error in result.failures.
      }
      let fatalRunId = activeInvocationRunId ?? generatedRunId();
      try {
        fatalRunId = parseRunId() ?? fatalRunId;
      } catch (_runIdError) {
        // Preserve the original fail-closed parse error in result.failures.
      }
      const outputPath = resolve(
        process.argv[2] ?? defaultOutputPath(fatalControlMode, fatalRunId),
      );
      const fatalReport = {
        schemaVersion: 1,
        campaign: "C12-33",
        probe: "probe-moon-mip-motion-edge",
        runId: fatalRunId,
        capturedAt: new Date().toISOString(),
        measurementStatus: "FATAL_FAIL",
        requestedControlMode: process.env.C12_MOON_MIP_CONTROL ?? "normal",
        result: {
          verdict: "FAIL",
          exitCode: EXIT_CODES.FAIL,
          failures: [String(error?.stack ?? error)],
          inconclusive: [],
        },
      };
      try {
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(
          outputPath,
          `${JSON.stringify(fatalReport, null, 2)}\n`,
          {
            flag: "wx",
          },
        );
      } catch (_writeError) {
        // The original failure remains the actionable error.
      }
      console.error(error?.stack ?? error);
      process.exitCode = EXIT_CODES.FAIL;
    });
}
