#!/usr/bin/env node
/**
 * C11-169 — Tools-only nested primitive-traversal CPU discriminator.
 *
 * The production profiler intentionally keeps its fixed 11-phase schema. This
 * bounded diagnostic nests four instance-local timers inside the already
 * measured coarse phases:
 *
 *   primitiveTraversal = ground update + ordinary update + globe render
 *                        + primitive residual
 *   computeShadows     = dynamic-environment drain + compute/shadow residual
 *
 * The wrappers exist only inside this probe and are restored exactly. They do
 * not change the engine's default-disabled path. Absolute timings remain
 * instrumented, synchronous CPU observations and are not causal FPS evidence.
 *
 * Usage:
 *   node Tools/visual-regression/probe-c11-169-primitive-breakdown.mjs
 *
 * Environment:
 *   PROBE_BASE=http://localhost:8080
 *   PROBE_HEADED=1
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  armWebGPUDevices,
  attachConsoleErrorGate,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";
import {
  CPU_SCENE_PHASE_NAMES,
  evaluateAccountingFrames,
  normalizeLastFrame,
  percentile,
  summarize,
} from "./probe-webgpu-frame-breakdown.mjs";
import {
  GLOBE_CAMERA_TRACK,
  GLOBE_CAMERA_TRACK_ID,
} from "./lib/globe-camera-track.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const HEADED = process.env.PROBE_HEADED === "1";
const VIEWPORT = Object.freeze({ width: 1280, height: 720 });
const MEASURE_FRAMES = 120;
const PRIME_FRAMES_PER_WAYPOINT = 5;
const ROUTE_START_PRIME_FRAMES = 18;
export const CONTROL_PAIRS = 12;
const INJECTED_MS = 8;
const DETAIL_EPSILON_MS = 0.05;
const CONTROL_TARGET_MIN_RATIO = 0.625;
const CONTROL_OFF_TARGET_MAX_RATIO = 0.25;
const MIN_PROFILED_FRAME_RATIO = 0.85;
const WATCHDOG_MS = 240_000;
const RUN_ID = randomUUID();
const OUTPUT_PATH = path.join(
  __dirname,
  "output",
  "performance",
  "c11-169-primitive-traversal-breakdown.json",
);
const FIRST_RED_OUTPUT_PATH = path.join(
  __dirname,
  "output",
  "performance",
  "c11-169-primitive-traversal-breakdown.first-red.json",
);

export const PRIMITIVE_DETAIL_NAMES = Object.freeze([
  "groundPrimitiveUpdate",
  "ordinaryPrimitiveUpdate",
  "dynamicEnvironmentDrain",
  "globeRender",
]);

export const PRIMITIVE_BREAKDOWN_CONFIG = Object.freeze({
  viewport: VIEWPORT,
  measureFrames: MEASURE_FRAMES,
  primeFramesPerWaypoint: PRIME_FRAMES_PER_WAYPOINT,
  routeStartPrimeFrames: ROUTE_START_PRIME_FRAMES,
  controlPairs: CONTROL_PAIRS,
  injectedMs: INJECTED_MS,
  detailEpsilonMs: DETAIL_EPSILON_MS,
  controlTargetMinRatio: CONTROL_TARGET_MIN_RATIO,
  controlOffTargetMaxRatio: CONTROL_OFF_TARGET_MAX_RATIO,
  minProfiledFrameRatio: MIN_PROFILED_FRAME_RATIO,
  watchdogMs: WATCHDOG_MS,
});

export const PRIMITIVE_DETAIL_CONTROL_SPECS = Object.freeze([
  Object.freeze({
    id: "ground-primitives",
    detail: "groundPrimitiveUpdate",
    parentPhase: "primitiveTraversal",
    owner: "scene._groundPrimitives",
    method: "update",
  }),
  Object.freeze({
    id: "ordinary-primitives",
    detail: "ordinaryPrimitiveUpdate",
    parentPhase: "primitiveTraversal",
    owner: "scene._primitives",
    method: "update",
  }),
  Object.freeze({
    id: "dynamic-environment-drain",
    detail: "dynamicEnvironmentDrain",
    parentPhase: "computeShadows",
    owner: "frameState.context",
    method: "drainEnvironmentMapUpdates",
  }),
  Object.freeze({
    id: "globe-render",
    detail: "globeRender",
    parentPhase: "primitiveTraversal",
    owner: "scene._globe",
    method: "render",
  }),
]);

/**
 * Verify that the probe installed and restored the exact four instance hooks.
 */
export function evaluatePrimitiveInstrumentation(instrumentation) {
  const failures = [];
  if (instrumentation?.installed !== true) {
    failures.push("primitive detail wrappers were not installed");
  }
  if (instrumentation?.restored !== true) {
    failures.push("primitive detail wrappers were not restored");
  }
  const targets = Array.isArray(instrumentation?.targets)
    ? instrumentation.targets
    : [];
  if (targets.length !== PRIMITIVE_DETAIL_CONTROL_SPECS.length) {
    failures.push(
      `instrumentation target count ${targets.length} != ${PRIMITIVE_DETAIL_CONTROL_SPECS.length}`,
    );
  }
  for (let index = 0; index < PRIMITIVE_DETAIL_CONTROL_SPECS.length; index++) {
    const expected = PRIMITIVE_DETAIL_CONTROL_SPECS[index];
    const target = targets[index];
    if (
      target?.detailName !== expected.detail ||
      target?.owner !== expected.owner ||
      target?.methodName !== expected.method
    ) {
      failures.push(
        `instrumentation target[${index}] ${JSON.stringify(target)} did not match ${expected.owner}.${expected.method} -> ${expected.detail}`,
      );
      continue;
    }
    if (target.installedExact !== true) {
      failures.push(
        `instrumentation target[${index}] was not installed exactly`,
      );
    }
    if (target.restoredExact !== true) {
      failures.push(
        `instrumentation target[${index}] was not restored exactly`,
      );
    }
  }
  return { pass: failures.length === 0, failures, targets };
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function detailSum(detailMs, names) {
  return names.reduce((sum, name) => sum + (detailMs?.[name] ?? 0), 0);
}

function hasExactOrderedKeys(value, expectedKeys) {
  if (!value || typeof value !== "object") return false;
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index])
  );
}

/**
 * Attach one exact Tools timer capture to the engine's authoritative lastFrame.
 */
export function normalizePrimitiveCapture(capture) {
  const frame = normalizeLastFrame(capture?.profile, capture?.metadata);
  if (!frame || typeof frame !== "object") {
    return {
      ...(capture?.metadata ?? {}),
      structuralError: "missing normalized lastFrame record",
      primitiveDetail: { structuralError: "missing primitive detail capture" },
    };
  }
  const rawDetail = capture?.detail;
  if (!rawDetail || typeof rawDetail !== "object") {
    return {
      ...frame,
      primitiveDetail: { structuralError: "missing primitive detail capture" },
    };
  }

  const detailMs = {};
  const hits = {};
  const detailKeys = Object.keys(rawDetail.detailMs ?? {});
  const hitKeys = Object.keys(rawDetail.hits ?? {});
  const invalidDetailBuckets = [];
  const invalidHitBuckets = [];
  for (const name of PRIMITIVE_DETAIL_NAMES) {
    const duration = rawDetail.detailMs?.[name];
    const hitCount = rawDetail.hits?.[name];
    if (isFiniteNumber(duration)) {
      detailMs[name] = duration;
    } else {
      invalidDetailBuckets.push(name);
    }
    if (Number.isInteger(hitCount)) {
      hits[name] = hitCount;
    } else {
      invalidHitBuckets.push(name);
    }
  }

  const primitiveNestedMs = detailSum(detailMs, [
    "groundPrimitiveUpdate",
    "ordinaryPrimitiveUpdate",
    "globeRender",
  ]);
  const primitiveResidualMs =
    frame?.phaseMs?.primitiveTraversal - primitiveNestedMs;
  const computeResidualMs =
    frame?.phaseMs?.computeShadows - detailMs.dynamicEnvironmentDrain;
  const settlementResidualMs =
    primitiveNestedMs +
    primitiveResidualMs +
    detailMs.dynamicEnvironmentDrain +
    computeResidualMs -
    frame?.phaseMs?.primitiveTraversal -
    frame?.phaseMs?.computeShadows;

  return {
    ...frame,
    primitiveDetail: {
      detailMs,
      hits,
      detailKeys,
      hitKeys,
      detailKeySchemaValid: hasExactOrderedKeys(
        rawDetail.detailMs,
        PRIMITIVE_DETAIL_NAMES,
      ),
      hitKeySchemaValid: hasExactOrderedKeys(
        rawDetail.hits,
        PRIMITIVE_DETAIL_NAMES,
      ),
      invalidDetailBuckets,
      invalidHitBuckets,
      sequenceBefore: rawDetail.sequenceBefore,
      sequenceAfter: rawDetail.sequenceAfter,
      normalSampleDelta: rawDetail.normalSampleDelta,
      primitiveNestedMs,
      primitiveResidualMs,
      computeResidualMs,
      settlementResidualMs,
    },
  };
}

function validatePrimitiveRecord(
  record,
  index,
  failures,
  { expectedHitsPerDetail = 1, detailEpsilonMs = DETAIL_EPSILON_MS } = {},
) {
  const label = `record[${index}]`;
  const detail = record?.primitiveDetail;
  if (record?.structuralError) {
    failures.push(`${label}: ${record.structuralError}`);
    return;
  }
  if (detail?.structuralError) {
    failures.push(`${label}: ${detail.structuralError}`);
    return;
  }
  if ((detail?.invalidDetailBuckets?.length ?? 0) > 0) {
    failures.push(
      `${label}: non-finite detail buckets ${detail.invalidDetailBuckets.join(", ")}`,
    );
  }
  if ((detail?.invalidHitBuckets?.length ?? 0) > 0) {
    failures.push(
      `${label}: invalid detail hit buckets ${detail.invalidHitBuckets.join(", ")}`,
    );
  }
  if (detail?.detailKeySchemaValid !== true) {
    failures.push(
      `${label}: detail keys ${JSON.stringify(detail?.detailKeys)} did not exactly match ${JSON.stringify(PRIMITIVE_DETAIL_NAMES)}`,
    );
  }
  if (detail?.hitKeySchemaValid !== true) {
    failures.push(
      `${label}: hit keys ${JSON.stringify(detail?.hitKeys)} did not exactly match ${JSON.stringify(PRIMITIVE_DETAIL_NAMES)}`,
    );
  }
  for (const name of PRIMITIVE_DETAIL_NAMES) {
    const duration = detail?.detailMs?.[name];
    const hits = detail?.hits?.[name];
    if (!isFiniteNumber(duration) || duration < 0) {
      failures.push(`${label}: ${name} duration ${duration} is invalid`);
    }
    const expectedHits =
      typeof expectedHitsPerDetail === "object"
        ? expectedHitsPerDetail[name]
        : expectedHitsPerDetail;
    if (Number.isInteger(expectedHits) && hits !== expectedHits) {
      failures.push(
        `${label}: ${name} hit count ${hits} did not equal ${expectedHits}`,
      );
    }
  }
  if (detail?.normalSampleDelta !== 1) {
    failures.push(
      `${label}: normal sample delta ${detail?.normalSampleDelta} did not equal 1`,
    );
  }
  if (
    detail?.sequenceAfter !== record.sequence ||
    detail?.sequenceBefore + 1 !== detail?.sequenceAfter
  ) {
    failures.push(
      `${label}: detail sequence ${detail?.sequenceBefore}->${detail?.sequenceAfter} did not settle frame ${record.sequence}`,
    );
  }
  for (const [name, value] of [
    ["primitiveNestedMs", detail?.primitiveNestedMs],
    ["primitiveResidualMs", detail?.primitiveResidualMs],
    ["computeResidualMs", detail?.computeResidualMs],
    ["settlementResidualMs", detail?.settlementResidualMs],
  ]) {
    if (!isFiniteNumber(value)) {
      failures.push(`${label}: ${name} is not finite`);
    }
  }
  if (detail?.primitiveResidualMs < -detailEpsilonMs) {
    failures.push(
      `${label}: primitive residual ${detail.primitiveResidualMs.toFixed(4)}ms is below -${detailEpsilonMs}ms`,
    );
  }
  if (detail?.computeResidualMs < -detailEpsilonMs) {
    failures.push(
      `${label}: compute residual ${detail.computeResidualMs.toFixed(4)}ms is below -${detailEpsilonMs}ms`,
    );
  }
  if (Math.abs(detail?.settlementResidualMs) > detailEpsilonMs) {
    failures.push(
      `${label}: detail settlement residual ${detail.settlementResidualMs.toFixed(4)}ms exceeds ${detailEpsilonMs}ms`,
    );
  }
}

export function evaluatePrimitiveDetailFrames(
  records,
  {
    expectedSamples,
    expectedHitsPerDetail = 1,
    detailEpsilonMs = DETAIL_EPSILON_MS,
  } = {},
) {
  const failures = [];
  if (isFiniteNumber(expectedSamples) && records.length !== expectedSamples) {
    failures.push(
      `detail sample count ${records.length} did not equal expected ${expectedSamples}`,
    );
  }
  for (let index = 0; index < records.length; index++) {
    validatePrimitiveRecord(records[index], index, failures, {
      expectedHitsPerDetail,
      detailEpsilonMs,
    });
  }
  return {
    pass: failures.length === 0,
    failures,
    observed: {
      samples: records.length,
      detailMs: Object.fromEntries(
        PRIMITIVE_DETAIL_NAMES.map((name) => [
          name,
          summarize(
            records.map((record) => record.primitiveDetail?.detailMs?.[name]),
          ),
        ]),
      ),
      hits: Object.fromEntries(
        PRIMITIVE_DETAIL_NAMES.map((name) => [
          name,
          summarize(
            records.map((record) => record.primitiveDetail?.hits?.[name]),
          ),
        ]),
      ),
      primitiveNestedMs: summarize(
        records.map((record) => record.primitiveDetail?.primitiveNestedMs),
      ),
      primitiveResidualMs: summarize(
        records.map((record) => record.primitiveDetail?.primitiveResidualMs),
      ),
      computeResidualMs: summarize(
        records.map((record) => record.primitiveDetail?.computeResidualMs),
      ),
      settlementResidualMs: summarize(
        records.map((record) =>
          Math.abs(record.primitiveDetail?.settlementResidualMs),
        ),
      ),
    },
  };
}

function medianDelta(pairs, selector) {
  return percentile(
    pairs.map((pair) => selector(pair.injected) - selector(pair.baseline)),
    0.5,
  );
}

/**
 * Evaluate one equal-instrumentation paired 8 ms discriminator.
 */
export function evaluatePrimitiveDetailControl(
  pairs,
  spec,
  injectedMs = INJECTED_MS,
  chronologicalFrames = [],
) {
  const failures = [];
  const minimumExpectedDelta = injectedMs * CONTROL_TARGET_MIN_RATIO;
  const maximumOffTargetDelta = injectedMs * CONTROL_OFF_TARGET_MAX_RATIO;
  const candidatePairs = Array.isArray(pairs) ? pairs : [];
  const chronological = Array.isArray(chronologicalFrames)
    ? chronologicalFrames
    : [];
  const controlSpecIndex = PRIMITIVE_DETAIL_CONTROL_SPECS.findIndex(
    (candidate) => candidate.id === spec?.id,
  );
  if (candidatePairs.length !== CONTROL_PAIRS) {
    failures.push(
      `control pair count ${candidatePairs.length} != ${CONTROL_PAIRS}`,
    );
  }
  if (chronological.length !== CONTROL_PAIRS * 2) {
    failures.push(
      `chronological control frame count ${chronological.length} != ${CONTROL_PAIRS * 2}`,
    );
  }
  if (!PRIMITIVE_DETAIL_NAMES.includes(spec?.detail)) {
    failures.push(`unknown detail target ${spec?.detail}`);
  }
  if (controlSpecIndex < 0) {
    failures.push(`unknown control spec ${spec?.id}`);
  }
  if (!CPU_SCENE_PHASE_NAMES.includes(spec?.parentPhase)) {
    failures.push(`unknown parent phase ${spec?.parentPhase}`);
  }

  const completePairs = [];
  let baselineProfiledFrames = 0;
  let injectedProfiledFrames = 0;
  let previousPairLastSequence = null;
  for (let index = 0; index < candidatePairs.length; index++) {
    const pair = candidatePairs[index];
    if (!pair?.baseline || !pair?.injected) {
      failures.push(`pair[${index}] missing baseline/injected record`);
      continue;
    }
    const expectedRouteProgress = index / (CONTROL_PAIRS - 1);
    if (
      !isFiniteNumber(pair.routeProgress) ||
      Math.abs(pair.routeProgress - expectedRouteProgress) > Number.EPSILON
    ) {
      failures.push(
        `pair[${index}] route progress ${pair.routeProgress} != ${expectedRouteProgress}`,
      );
    }
    if (typeof pair.injectedFirst !== "boolean") {
      failures.push(
        `pair[${index}] injectedFirst ${pair.injectedFirst} was not boolean`,
      );
    }
    const expectedInjectedFirst =
      controlSpecIndex >= 0 ? (index + controlSpecIndex) % 2 === 1 : null;
    if (pair.injectedFirst !== expectedInjectedFirst) {
      failures.push(
        `pair[${index}] injectedFirst ${pair.injectedFirst} did not match counterbalance ${expectedInjectedFirst}`,
      );
    }
    for (const [arm, record, expectedInjected] of [
      ["baseline", pair.baseline, false],
      ["injected", pair.injected, true],
    ]) {
      if (record.controlId !== spec?.id) {
        failures.push(
          `pair[${index}] ${arm} control id ${record.controlId} != ${spec?.id}`,
        );
      }
      if (record.targetDetail !== spec?.detail) {
        failures.push(
          `pair[${index}] ${arm} detail ${record.targetDetail} != ${spec?.detail}`,
        );
      }
      if (record.parentPhase !== spec?.parentPhase) {
        failures.push(
          `pair[${index}] ${arm} parent ${record.parentPhase} != ${spec?.parentPhase}`,
        );
      }
      if (record.pairIndex !== index) {
        failures.push(
          `pair[${index}] ${arm} pair index ${record.pairIndex} != ${index}`,
        );
      }
      if (
        !isFiniteNumber(record.routeProgress) ||
        !isFiniteNumber(pair.routeProgress) ||
        Math.abs(record.routeProgress - pair.routeProgress) > Number.EPSILON
      ) {
        failures.push(
          `pair[${index}] ${arm} route progress ${record.routeProgress} != ${pair.routeProgress}`,
        );
      }
      if (record.injected !== expectedInjected) {
        failures.push(
          `pair[${index}] ${arm} injected metadata ${record.injected} != ${expectedInjected}`,
        );
      }
    }

    const first = pair.injectedFirst ? pair.injected : pair.baseline;
    const second = pair.injectedFirst ? pair.baseline : pair.injected;
    const expectedFirstInjected = pair.injectedFirst === true;
    if (
      !isFiniteNumber(first.sequence) ||
      !isFiniteNumber(second.sequence) ||
      second.sequence !== first.sequence + 1 ||
      second.primitiveDetail?.sequenceBefore !== first.sequence
    ) {
      failures.push(
        `pair[${index}] chronology ${first.sequence}->${second.sequence} was not adjacent with injectedFirst=${pair.injectedFirst}`,
      );
    }
    if (
      previousPairLastSequence !== null &&
      first.sequence !== previousPairLastSequence + 1
    ) {
      failures.push(
        `pair[${index}] first sequence ${first.sequence} did not follow ${previousPairLastSequence}`,
      );
    }
    previousPairLastSequence = second.sequence;

    for (const [offset, record, expectedInjected] of [
      [0, first, expectedFirstInjected],
      [1, second, !expectedFirstInjected],
    ]) {
      const chronologicalRecord = chronological[index * 2 + offset];
      if (
        !chronologicalRecord ||
        chronologicalRecord.sequence !== record.sequence ||
        chronologicalRecord.pairIndex !== index ||
        chronologicalRecord.injected !== expectedInjected ||
        chronologicalRecord.routeProgress !== pair.routeProgress
      ) {
        failures.push(
          `pair[${index}] arm ${offset} did not match chronological frame ${index * 2 + offset}`,
        );
      } else if (
        JSON.stringify(chronologicalRecord) !== JSON.stringify(record)
      ) {
        failures.push(
          `pair[${index}] arm ${offset} payload diverged from chronological frame ${index * 2 + offset}`,
        );
      }
    }
    validatePrimitiveRecord(pair.baseline, index * 2, failures);
    validatePrimitiveRecord(pair.injected, index * 2 + 1, failures);
    if (pair.baseline.seamHitDelta !== 1 || pair.baseline.spinHitDelta !== 0) {
      failures.push(
        `pair[${index}] baseline hits were seam=${pair.baseline.seamHitDelta}, spin=${pair.baseline.spinHitDelta}`,
      );
    }
    if (pair.injected.seamHitDelta !== 1 || pair.injected.spinHitDelta !== 1) {
      failures.push(
        `pair[${index}] injected hits were seam=${pair.injected.seamHitDelta}, spin=${pair.injected.spinHitDelta}`,
      );
    }
    if (pair.baseline.profiledPassMs > 0) baselineProfiledFrames++;
    if (pair.injected.profiledPassMs > 0) injectedProfiledFrames++;
    completePairs.push(pair);
  }
  if (completePairs.length === 0) {
    failures.push("control contains no complete pairs");
  }
  if (baselineProfiledFrames === 0 || injectedProfiledFrames === 0) {
    failures.push(
      `control named-pass work was vacuous (baseline=${baselineProfiledFrames}, injected=${injectedProfiledFrames})`,
    );
  }

  const targetDelta = medianDelta(
    completePairs,
    (record) => record.primitiveDetail.detailMs[spec.detail],
  );
  const parentDelta = medianDelta(
    completePairs,
    (record) => record.phaseMs[spec.parentPhase],
  );
  const totalDelta = medianDelta(completePairs, (record) => record.totalMs);
  const phaseTotalDelta = medianDelta(
    completePairs,
    (record) => record.phaseTotalMs,
  );
  const unaccountedDelta = medianDelta(
    completePairs,
    (record) => record.unaccountedMs,
  );
  for (const [label, value] of [
    [spec.detail, targetDelta],
    [spec.parentPhase, parentDelta],
    ["total", totalDelta],
    ["phase total", phaseTotalDelta],
    ["legacy unaccounted", unaccountedDelta],
  ]) {
    if (!isFiniteNumber(value) || value < minimumExpectedDelta) {
      failures.push(
        `${label} median delta ${value}ms < ${minimumExpectedDelta}ms`,
      );
    }
  }

  const detailDeltaMs = Object.fromEntries(
    PRIMITIVE_DETAIL_NAMES.map((name) => [
      name,
      completePairs.map(
        (pair) =>
          pair.injected.primitiveDetail.detailMs[name] -
          pair.baseline.primitiveDetail.detailMs[name],
      ),
    ]),
  );
  const phaseDeltaMs = Object.fromEntries(
    CPU_SCENE_PHASE_NAMES.map((phase) => [
      phase,
      completePairs.map(
        (pair) => pair.injected.phaseMs[phase] - pair.baseline.phaseMs[phase],
      ),
    ]),
  );
  for (const name of PRIMITIVE_DETAIL_NAMES) {
    if (name === spec.detail) continue;
    const value = percentile(detailDeltaMs[name], 0.5);
    if (!isFiniteNumber(value) || Math.abs(value) > maximumOffTargetDelta) {
      failures.push(
        `${name} median delta ${value}ms exceeded ${maximumOffTargetDelta}ms`,
      );
    }
  }
  for (const phase of CPU_SCENE_PHASE_NAMES) {
    if (phase === spec.parentPhase) continue;
    const value = percentile(phaseDeltaMs[phase], 0.5);
    if (!isFiniteNumber(value) || Math.abs(value) > maximumOffTargetDelta) {
      failures.push(
        `${phase} median delta ${value}ms exceeded ${maximumOffTargetDelta}ms`,
      );
    }
  }

  const residualDeltas = {
    primitiveResidualMs: completePairs.map(
      (pair) =>
        pair.injected.primitiveDetail.primitiveResidualMs -
        pair.baseline.primitiveDetail.primitiveResidualMs,
    ),
    computeResidualMs: completePairs.map(
      (pair) =>
        pair.injected.primitiveDetail.computeResidualMs -
        pair.baseline.primitiveDetail.computeResidualMs,
    ),
  };
  for (const [name, values] of Object.entries(residualDeltas)) {
    const value = percentile(values, 0.5);
    if (!isFiniteNumber(value) || Math.abs(value) > maximumOffTargetDelta) {
      failures.push(
        `${name} median delta ${value}ms exceeded ${maximumOffTargetDelta}ms`,
      );
    }
  }

  const namedPasses = new Set(
    completePairs.flatMap((pair) => [
      ...Object.keys(pair.baseline.passMs ?? {}),
      ...Object.keys(pair.injected.passMs ?? {}),
    ]),
  );
  const namedPassDeltaMs = {};
  if (namedPasses.size === 0) {
    failures.push("control population contained no named pass buckets");
  }
  for (const name of namedPasses) {
    const values = completePairs.map(
      (pair) =>
        (pair.injected.passMs?.[name] ?? 0) -
        (pair.baseline.passMs?.[name] ?? 0),
    );
    namedPassDeltaMs[name] = values;
    const value = percentile(values, 0.5);
    if (!isFiniteNumber(value) || Math.abs(value) > maximumOffTargetDelta) {
      failures.push(
        `named pass ${name} median delta ${value}ms exceeded ${maximumOffTargetDelta}ms`,
      );
    }
  }

  for (const [label, selector] of [
    ["profiled pass", (record) => record.profiledPassMs],
    ["unattributed", (record) => record.unattributedMs],
    ["pass overlap", (record) => record.overlapMs],
    ["attribution overlap", (record) => record.attributionOverlapMs],
  ]) {
    const value = medianDelta(completePairs, selector);
    const limit =
      label.includes("overlap") || label === "unattributed"
        ? DETAIL_EPSILON_MS
        : maximumOffTargetDelta;
    if (!isFiniteNumber(value) || Math.abs(value) > limit) {
      failures.push(`${label} median delta ${value}ms exceeded ${limit}ms`);
    }
  }

  return {
    pass: failures.length === 0,
    failures,
    observed: {
      pairs: completePairs.length,
      injectedMs,
      targetDetail: spec?.detail,
      parentPhase: spec?.parentPhase,
      baselineProfiledFrames,
      injectedProfiledFrames,
      totalDeltaMs: summarize(
        completePairs.map(
          (pair) => pair.injected.totalMs - pair.baseline.totalMs,
        ),
      ),
      phaseTotalDeltaMs: summarize(
        completePairs.map(
          (pair) => pair.injected.phaseTotalMs - pair.baseline.phaseTotalMs,
        ),
      ),
      unaccountedDeltaMs: summarize(
        completePairs.map(
          (pair) => pair.injected.unaccountedMs - pair.baseline.unaccountedMs,
        ),
      ),
      targetDetailDeltaMs: summarize(detailDeltaMs[spec?.detail] ?? []),
      parentPhaseDeltaMs: summarize(phaseDeltaMs[spec?.parentPhase] ?? []),
      detailDeltaMs: Object.fromEntries(
        PRIMITIVE_DETAIL_NAMES.map((name) => [
          name,
          summarize(detailDeltaMs[name]),
        ]),
      ),
      phaseDeltaMs: Object.fromEntries(
        CPU_SCENE_PHASE_NAMES.map((phase) => [
          phase,
          summarize(phaseDeltaMs[phase]),
        ]),
      ),
      residualDeltaMs: Object.fromEntries(
        Object.entries(residualDeltas).map(([name, values]) => [
          name,
          summarize(values),
        ]),
      ),
      namedPassDeltaMs: Object.fromEntries(
        [...namedPasses]
          .sort()
          .map((name) => [name, summarize(namedPassDeltaMs[name])]),
      ),
    },
  };
}

export function evaluateDefaultGlobeScope(scope) {
  const failures = [];
  if (scope?.id !== "default-globe-local-v1") {
    failures.push(`scope id was ${scope?.id}`);
  }
  if (scope?.explicitAssetsAdded !== 0) {
    failures.push(`probe added ${scope?.explicitAssetsAdded} explicit assets`);
  }
  for (const point of ["beforePrime", "afterScoring"]) {
    if (scope?.[point]?.ordinaryPrimitiveCount !== 0) {
      failures.push(
        `${point} ordinary primitive count was ${scope?.[point]?.ordinaryPrimitiveCount}`,
      );
    }
    if (scope?.[point]?.groundPrimitiveCount !== 0) {
      failures.push(
        `${point} ground primitive count was ${scope?.[point]?.groundPrimitiveCount}`,
      );
    }
    if (scope?.[point]?.globePresent !== true) {
      failures.push(`${point} globe was absent`);
    }
    if (scope?.[point]?.globeShown !== true) {
      failures.push(`${point} globe was hidden`);
    }
  }
  if (scope?.representativeTilesetWorkload !== false) {
    failures.push("scope incorrectly claims a representative tileset workload");
  }
  if (scope?.transferableToC11168 !== false) {
    failures.push("scope incorrectly transfers timing to C11-168");
  }
  return { pass: failures.length === 0, failures, observed: scope ?? null };
}

function summarizeSegments(records) {
  const bySegment = new Map();
  for (const record of records) {
    if (!Number.isInteger(record.segmentIndex)) continue;
    let segment = bySegment.get(record.segmentIndex);
    if (!segment) {
      segment = [];
      bySegment.set(record.segmentIndex, segment);
    }
    segment.push(record);
  }
  return [...bySegment.entries()]
    .sort(([left], [right]) => left - right)
    .map(([segmentIndex, frames]) => ({
      segmentIndex,
      segmentName: frames[0]?.segmentName ?? null,
      frames: frames.length,
      cameraHeight: summarize(frames.map((frame) => frame.height)),
      primitiveTraversalMs: summarize(
        frames.map((frame) => frame.phaseMs?.primitiveTraversal),
      ),
      computeShadowsMs: summarize(
        frames.map((frame) => frame.phaseMs?.computeShadows),
      ),
      detailMs: Object.fromEntries(
        PRIMITIVE_DETAIL_NAMES.map((name) => [
          name,
          summarize(
            frames.map((frame) => frame.primitiveDetail?.detailMs?.[name]),
          ),
        ]),
      ),
      primitiveResidualMs: summarize(
        frames.map((frame) => frame.primitiveDetail?.primitiveResidualMs),
      ),
      computeResidualMs: summarize(
        frames.map((frame) => frame.primitiveDetail?.computeResidualMs),
      ),
    }));
}

export function buildPrimitiveBreakdownReport(
  raw,
  consoleErrors = [],
  gpuGate = { armedDevices: 0, errors: [], deviceLost: null },
  outerFatalError = null,
) {
  const fatalError = outerFatalError ?? raw?.inPageFatal ?? null;
  const routeRecords = (raw?.route?.frames ?? []).map(
    normalizePrimitiveCapture,
  );
  const routeAccountingGate = evaluateAccountingFrames(routeRecords, {
    expectedSamples: MEASURE_FRAMES,
    expectedSegmentCount: GLOBE_CAMERA_TRACK.length - 1,
    requireFullRoute: true,
    minProfiledFrameRatio: MIN_PROFILED_FRAME_RATIO,
  });
  const routeDetailGate = evaluatePrimitiveDetailFrames(routeRecords, {
    expectedSamples: MEASURE_FRAMES,
  });
  const scopeGate = evaluateDefaultGlobeScope(raw?.scope);
  const instrumentationGate = evaluatePrimitiveInstrumentation(
    raw?.instrumentation,
  );

  const controlReports = [];
  const controlFailures = [];
  for (const spec of PRIMITIVE_DETAIL_CONTROL_SPECS) {
    const rawLane = (raw?.controls?.lanes ?? []).find(
      (lane) => lane.id === spec.id,
    );
    if (!rawLane) {
      controlFailures.push(`missing control lane ${spec.id}`);
      continue;
    }
    const chronologicalFrames = (rawLane.frames ?? []).map(
      normalizePrimitiveCapture,
    );
    const pairs = (rawLane.pairs ?? []).map((pair) => ({
      routeProgress: pair.routeProgress,
      injectedFirst: pair.injectedFirst,
      baseline: normalizePrimitiveCapture(pair.baseline),
      injected: normalizePrimitiveCapture(pair.injected),
    }));
    const accountingGate = evaluateAccountingFrames(chronologicalFrames, {
      expectedSamples: CONTROL_PAIRS * 2,
      minProfiledFrameRatio: 0,
    });
    const detailGate = evaluatePrimitiveDetailFrames(chronologicalFrames, {
      expectedSamples: CONTROL_PAIRS * 2,
    });
    const discriminatorGate = evaluatePrimitiveDetailControl(
      pairs,
      spec,
      INJECTED_MS,
      chronologicalFrames,
    );
    const hitFailures = [];
    if (rawLane.seamHits !== CONTROL_PAIRS * 2) {
      hitFailures.push(
        `${spec.id} seam hits ${rawLane.seamHits} != ${CONTROL_PAIRS * 2}`,
      );
    }
    if (rawLane.spinHits !== CONTROL_PAIRS) {
      hitFailures.push(
        `${spec.id} spin hits ${rawLane.spinHits} != ${CONTROL_PAIRS}`,
      );
    }
    controlFailures.push(
      ...accountingGate.failures.map((failure) => `${spec.id}: ${failure}`),
      ...detailGate.failures.map((failure) => `${spec.id}: ${failure}`),
      ...discriminatorGate.failures.map((failure) => `${spec.id}: ${failure}`),
      ...hitFailures,
    );
    controlReports.push({
      ...spec,
      seamHits: rawLane.seamHits,
      spinHits: rawLane.spinHits,
      accountingGate,
      detailGate,
      discriminatorGate,
      hitFailures,
      framePairs: pairs,
    });
  }
  if (
    (raw?.controls?.lanes?.length ?? 0) !==
    PRIMITIVE_DETAIL_CONTROL_SPECS.length
  ) {
    controlFailures.push(
      `control lane count ${raw?.controls?.lanes?.length ?? 0} != ${PRIMITIVE_DETAIL_CONTROL_SPECS.length}`,
    );
  }

  const structuralFailures = [];
  if (fatalError) structuralFailures.push(fatalError);
  if (raw?.rendererType !== "webgpu") {
    structuralFailures.push(`renderer type was ${raw?.rendererType}`);
  }
  if (raw?.setup?.imagery !== "NaturalEarthII-local") {
    structuralFailures.push(
      `local NaturalEarthII imagery was not installed: ${raw?.setup?.imagery}`,
    );
  }
  if (raw?.profiler?.available !== true) {
    structuralFailures.push("WebGPU CPU pass profiler unavailable");
  }
  if (raw?.profiler?.defaultDisabled !== true) {
    structuralFailures.push("CPU pass profiler was not disabled by default");
  }
  if (raw?.profiler?.disabledAfter !== true) {
    structuralFailures.push("CPU pass profiler was not disabled after scoring");
  }
  structuralFailures.push(...instrumentationGate.failures);
  if (raw?.route?.sequenceDelta !== MEASURE_FRAMES) {
    structuralFailures.push(
      `route sequence delta ${raw?.route?.sequenceDelta} != ${MEASURE_FRAMES}`,
    );
  }
  if ((gpuGate?.armedDevices ?? 0) < 1) {
    structuralFailures.push("WebGPU error gate armed no GPUDevice");
  }

  const runtimeErrors = [
    ...consoleErrors,
    ...(raw?.pageErrors ?? []),
    ...(raw?.localRequestFailures ?? []),
    ...(raw?.renderErrors ?? []),
    ...(gpuGate?.errors ?? []),
    ...(gpuGate?.deviceLost ? [gpuGate.deviceLost] : []),
  ];
  const failures = [
    ...structuralFailures,
    ...scopeGate.failures,
    ...routeAccountingGate.failures,
    ...routeDetailGate.failures,
    ...controlFailures,
    ...runtimeErrors.map((error) => `runtime error: ${error}`),
  ];
  const pass = failures.length === 0;
  const exitCode = fatalError ? 2 : pass ? 0 : 1;

  return {
    probe: "c11-169-webgpu-primitive-traversal-breakdown",
    schemaVersion: 1,
    runId: raw?.runId ?? null,
    generatedAt: new Date().toISOString(),
    instrumentationMode: "diagnostic-noncausal-tools-nested",
    status: fatalError ? "ERROR" : pass ? "PASS" : "FAIL",
    pass,
    exitCode,
    incomplete: false,
    result: pass ? "pass" : "fail",
    failures,
    contract: {
      productionProfilerSchema: "fixed-11-phase-unchanged",
      productionDisabledPathChanged: false,
      detailNames: PRIMITIVE_DETAIL_NAMES,
      primitiveEquation:
        "phaseMs.primitiveTraversal = groundPrimitiveUpdate + ordinaryPrimitiveUpdate + globeRender + primitiveResidualMs",
      computeEquation:
        "phaseMs.computeShadows = dynamicEnvironmentDrain + computeResidualMs",
      intervals:
        "instance-local synchronous method bodies, accumulated once per logical Scene.render",
      detailEpsilonMs: DETAIL_EPSILON_MS,
      gpuAsyncExcluded: true,
      causalTimingClaim: false,
    },
    scopeQualification: {
      gate: scopeGate,
      statement:
        "Default local NaturalEarthII globe only; no explicit model or 3D Tiles asset is added.",
      exclusions: [
        "Not the C11-168/C11-205 representative resident SF tileset workload.",
        "No percentage or phase share transfers to the causal WebGL/WebGPU deficit.",
        "A dynamic-environment seam hit does not prove nonzero C11-193 refresh work.",
      ],
    },
    setup: {
      base: BASE,
      viewport: VIEWPORT,
      rendererType: raw?.rendererType ?? null,
      imagery: raw?.setup?.imagery ?? null,
      fixedTime: raw?.setup?.fixedTime ?? null,
      profiler: raw?.profiler ?? null,
      instrumentation: raw?.instrumentation ?? null,
      instrumentationGate,
      gpuGate,
    },
    route: {
      id: GLOBE_CAMERA_TRACK_ID,
      waypointCount: GLOBE_CAMERA_TRACK.length,
      segmentCount: GLOBE_CAMERA_TRACK.length - 1,
      frames: MEASURE_FRAMES,
      prime: raw?.prime ?? null,
      accountingGate: routeAccountingGate,
      detailGate: routeDetailGate,
      segmentSummaries: summarizeSegments(routeRecords),
      frameRecords: routeRecords,
      accountingStart: raw?.route?.accountingStart ?? null,
      accountingEnd: raw?.route?.accountingEnd ?? null,
    },
    controls: {
      injectedMs: INJECTED_MS,
      pairsPerLane: CONTROL_PAIRS,
      specs: PRIMITIVE_DETAIL_CONTROL_SPECS,
      pass: controlFailures.length === 0,
      failures: controlFailures,
      lanes: controlReports,
    },
    errors: {
      console: consoleErrors,
      page: raw?.pageErrors ?? [],
      localRequestFailures: raw?.localRequestFailures ?? [],
      render: raw?.renderErrors ?? [],
      gpu: gpuGate?.errors ?? [],
      deviceLost: gpuGate?.deviceLost ?? null,
      fatal: fatalError,
    },
  };
}

/**
 * Apply the write-once first-red policy without touching the filesystem.
 */
export function applyPrimitiveFirstRedPolicy(report, firstRed) {
  const existedBefore = firstRed?.existedBefore === true;
  return {
    ...report,
    firstRed: {
      ...firstRed,
      existedBefore,
      written: report?.exitCode !== 0 && !existedBefore,
      preserved: existedBefore,
    },
  };
}

async function runBrowserProbe() {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: !HEADED,
    args: ["--enable-unsafe-webgpu"],
  });
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  const consoleErrors = attachConsoleErrorGate(page);
  const pageErrors = [];
  const localRequestFailures = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    if (request.url().startsWith(BASE)) {
      localRequestFailures.push(
        `${request.failure()?.errorText ?? "request failed"}: ${request.url()}`,
      );
    }
  });
  await page.addInitScript(errorGateInit);

  let raw = {};
  let gpuGate;
  let outerFatalError = null;
  try {
    await page.goto(
      `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu&offline=true`,
      { waitUntil: "domcontentloaded", timeout: 90_000 },
    );
    await page.waitForFunction(
      () =>
        !!window.viewer?.scene?._alternateSceneRenderer &&
        !!window.viewer?.scene?.context,
      null,
      { timeout: 90_000 },
    );
    await armWebGPUDevices(page);

    raw = await page.evaluate(
      async ({
        runId,
        track,
        measureFrames,
        primeFramesPerWaypoint,
        routeStartPrimeFrames,
        controlPairs,
        controlSpecs,
        detailNames,
        injectedMs,
      }) => {
        const C = await import("/Build/CesiumUnminified/index.js");
        const viewer = window.viewer;
        const scene = viewer.scene;
        const renderer = scene._alternateSceneRenderer;
        const out = {
          runId,
          rendererType: scene.context.rendererType,
          setup: {},
          profiler: {},
          instrumentation: {
            mode: "tools-instance-wrappers",
            installed: false,
            restored: false,
            targets: [],
          },
          scope: {
            id: "default-globe-local-v1",
            explicitAssetsAdded: 0,
            representativeTilesetWorkload: false,
            transferableToC11168: false,
          },
          prime: {},
          route: { frames: [] },
          controls: { lanes: [] },
          renderErrors: [],
          inPageFatal: null,
        };

        scene.renderError.addEventListener((_scene, error) => {
          out.renderErrors.push(
            String(error?.stack ?? error?.message ?? error),
          );
        });

        const profileSnapshot = () => {
          const profile = renderer.getCpuPassProfile();
          const accounting = profile.frameAccounting ?? null;
          const last = profile.lastFrame ?? accounting?.lastFrame ?? null;
          return {
            enabled: profile.enabled,
            frameCount: profile.frameCount,
            frameAccounting: accounting ? { ...accounting } : null,
            lastFrame: last
              ? {
                  ...last,
                  passMs: { ...(last.passMs ?? {}) },
                  phaseMs: { ...(last.phaseMs ?? {}) },
                }
              : null,
          };
        };
        const normalSequence = () => profileSnapshot().lastFrame?.sequence ?? 0;
        const nextAnimationFrame = () =>
          new Promise((resolve) => requestAnimationFrame(resolve));
        const scopeSnapshot = () => ({
          ordinaryPrimitiveCount: scene._primitives?.length ?? null,
          groundPrimitiveCount: scene._groundPrimitives?.length ?? null,
          globePresent: scene._globe != null,
          globeShown: scene._globe?.show === true,
        });
        const interpolateDegrees = (start, end, amount) => {
          let delta = ((end - start + 540) % 360) - 180;
          if (delta === -180) delta = 180;
          return start + delta * amount;
        };
        const applyProgress = (routeProgress) => {
          const progress = Math.min(1, Math.max(0, routeProgress));
          const scaled = progress * (track.length - 1);
          const segmentIndex = Math.min(track.length - 2, Math.floor(scaled));
          const amount = Math.min(1, scaled - segmentIndex);
          const start = track[segmentIndex];
          const end = track[segmentIndex + 1];
          const state = {
            segmentIndex,
            segmentName: `${start.name}->${end.name}`,
            lon: interpolateDegrees(start.lon, end.lon, amount),
            lat: start.lat + (end.lat - start.lat) * amount,
            height: start.height + (end.height - start.height) * amount,
            heading: interpolateDegrees(start.heading, end.heading, amount),
            pitch: start.pitch + (end.pitch - start.pitch) * amount,
            roll: interpolateDegrees(start.roll, end.roll, amount),
          };
          scene.camera.setView({
            destination: C.Cartesian3.fromDegrees(
              state.lon,
              state.lat,
              state.height,
            ),
            orientation: {
              heading: C.Math.toRadians(state.heading),
              pitch: C.Math.toRadians(state.pitch),
              roll: C.Math.toRadians(state.roll),
            },
          });
          return state;
        };

        viewer.useDefaultRenderLoop = false;
        scene.requestRenderMode = false;
        viewer.clock.shouldAnimate = false;
        viewer.clock.currentTime = C.JulianDate.fromIso8601(
          "2026-06-21T19:00:00Z",
        );
        out.setup.fixedTime = C.JulianDate.toIso8601(viewer.clock.currentTime);
        try {
          const imageryUrl = C.buildModuleUrl("Assets/Textures/NaturalEarthII");
          const provider =
            await C.TileMapServiceImageryProvider.fromUrl(imageryUrl);
          viewer.imageryLayers.removeAll();
          viewer.imageryLayers.addImageryProvider(provider);
          out.setup.imagery = "NaturalEarthII-local";
        } catch (error) {
          out.setup.imagery = `local imagery error: ${String(error?.message ?? error)}`;
        }

        out.profiler.available =
          typeof renderer?.setCpuPassProfiling === "function" &&
          typeof renderer?.getCpuPassProfile === "function";
        if (!out.profiler.available) return out;
        const defaultProfile = profileSnapshot();
        out.profiler.defaultDisabled = defaultProfile.enabled === false;
        out.profiler.defaultProfile = defaultProfile;
        renderer.setCpuPassProfiling(false);
        out.scope.beforePrime = scopeSnapshot();

        const unscoredRender = async () => {
          scene.initializeFrame();
          scene.render(viewer.clock.currentTime);
          await nextAnimationFrame();
        };
        let primeFrames = 0;
        for (
          let waypointIndex = 0;
          waypointIndex < track.length;
          waypointIndex++
        ) {
          applyProgress(waypointIndex / (track.length - 1));
          for (let frame = 0; frame < primeFramesPerWaypoint; frame++) {
            await unscoredRender();
            primeFrames++;
          }
        }
        applyProgress(0);
        for (let frame = 0; frame < routeStartPrimeFrames; frame++) {
          await unscoredRender();
          primeFrames++;
        }
        out.prime = {
          frames: primeFrames,
          globeTilesLoaded: scene.globe?.tilesLoaded ?? null,
          pendingForegroundCount:
            scene.context?.asyncResources?.pendingForegroundCount ?? null,
        };

        let activeDetail = null;
        let activeControl = null;
        const restorations = [];
        const zeroMap = () =>
          Object.fromEntries(detailNames.map((name) => [name, 0]));
        const busySpin = () => {
          const start = performance.now();
          while (performance.now() - start < injectedMs) {
            // Intentional bounded diagnostic delay.
          }
        };
        const installTimedWrapper = (
          owner,
          methodName,
          detailName,
          ownerLabel,
        ) => {
          const original = owner?.[methodName];
          if (typeof original !== "function") {
            throw new Error(
              `primitive detail ${detailName} missing ${methodName} hook`,
            );
          }
          const hadOwn = Object.prototype.hasOwnProperty.call(
            owner,
            methodName,
          );
          const descriptor = hadOwn
            ? Object.getOwnPropertyDescriptor(owner, methodName)
            : undefined;
          const wrapper = function (...args) {
            const detail = activeDetail;
            if (!detail) return original.apply(this, args);
            detail.hits[detailName]++;
            const scoresControl = activeControl?.targetDetail === detailName;
            if (scoresControl) {
              activeControl.lane.seamHits++;
            }
            const start = performance.now();
            try {
              if (scoresControl && activeControl.inject) {
                activeControl.lane.spinHits++;
                busySpin();
              }
              return original.apply(this, args);
            } finally {
              detail.detailMs[detailName] += performance.now() - start;
            }
          };
          owner[methodName] = wrapper;
          const target = {
            owner: ownerLabel,
            detailName,
            methodName,
            hadOwn,
            installedExact: owner[methodName] === wrapper,
            restoredExact: false,
          };
          restorations.push({
            owner,
            methodName,
            detailName,
            original,
            wrapper,
            hadOwn,
            descriptor,
            target,
          });
          out.instrumentation.targets.push(target);
        };
        const restoreWrappers = () => {
          let restored = true;
          for (let index = restorations.length - 1; index >= 0; index--) {
            const restoration = restorations[index];
            if (restoration.hadOwn) {
              Object.defineProperty(
                restoration.owner,
                restoration.methodName,
                restoration.descriptor,
              );
            } else {
              delete restoration.owner[restoration.methodName];
            }
            const restoredExact =
              restoration.owner[restoration.methodName] ===
                restoration.original &&
              Object.prototype.hasOwnProperty.call(
                restoration.owner,
                restoration.methodName,
              ) === restoration.hadOwn;
            restoration.target.restoredExact = restoredExact;
            restored = restored && restoredExact;
          }
          return restored;
        };

        try {
          installTimedWrapper(
            scene._groundPrimitives,
            "update",
            "groundPrimitiveUpdate",
            "scene._groundPrimitives",
          );
          installTimedWrapper(
            scene._primitives,
            "update",
            "ordinaryPrimitiveUpdate",
            "scene._primitives",
          );
          installTimedWrapper(
            scene.frameState.context,
            "drainEnvironmentMapUpdates",
            "dynamicEnvironmentDrain",
            "frameState.context",
          );
          installTimedWrapper(
            scene._globe,
            "render",
            "globeRender",
            "scene._globe",
          );
          out.instrumentation.installed = true;

          const renderOne = async (metadata = {}) => {
            const detail = { detailMs: zeroMap(), hits: zeroMap() };
            scene.initializeFrame();
            const sequenceBefore = normalSequence();
            activeDetail = detail;
            try {
              scene.render(viewer.clock.currentTime);
            } finally {
              activeDetail = null;
            }
            const profile = profileSnapshot();
            const sequenceAfter = profile.lastFrame?.sequence ?? 0;
            detail.sequenceBefore = sequenceBefore;
            detail.sequenceAfter = sequenceAfter;
            detail.normalSampleDelta = sequenceAfter - sequenceBefore;
            const captured = {
              profile,
              detail,
              metadata: {
                frustumCount: scene._view?.frustumCommandsList?.length ?? 0,
                cameraHeight: scene.camera.positionCartographic?.height ?? null,
                ...metadata,
              },
            };
            await nextAnimationFrame();
            return captured;
          };
          const captureControlArm = async ({
            lane,
            spec,
            pairIndex,
            routeProgress,
            trackState,
            inject,
          }) => {
            const seamHitsBefore = lane.seamHits;
            const spinHitsBefore = lane.spinHits;
            activeControl = {
              lane,
              targetDetail: spec.detail,
              inject,
            };
            let captured;
            try {
              captured = await renderOne({
                controlId: spec.id,
                targetDetail: spec.detail,
                parentPhase: spec.parentPhase,
                pairIndex,
                routeProgress,
                injected: inject,
                ...trackState,
              });
            } finally {
              activeControl = null;
            }
            captured.metadata.seamHitDelta = lane.seamHits - seamHitsBefore;
            captured.metadata.spinHitDelta = lane.spinHits - spinHitsBefore;
            lane.frames.push(captured);
            return captured;
          };

          renderer.setCpuPassProfiling(true);
          out.route.accountingStart = profileSnapshot().frameAccounting;
          const routeStartSequence = normalSequence();
          for (let frameIndex = 0; frameIndex < measureFrames; frameIndex++) {
            const routeProgress =
              measureFrames <= 1 ? 1 : frameIndex / (measureFrames - 1);
            const trackState = applyProgress(routeProgress);
            out.route.frames.push(
              await renderOne({
                frameIndex,
                routeProgress,
                ...trackState,
              }),
            );
          }
          out.route.accountingEnd = profileSnapshot().frameAccounting;
          out.route.sequenceDelta = normalSequence() - routeStartSequence;

          for (
            let controlIndex = 0;
            controlIndex < controlSpecs.length;
            controlIndex++
          ) {
            const spec = controlSpecs[controlIndex];
            const lane = {
              id: spec.id,
              targetDetail: spec.detail,
              parentPhase: spec.parentPhase,
              seamHits: 0,
              spinHits: 0,
              frames: [],
              pairs: [],
            };
            for (let pairIndex = 0; pairIndex < controlPairs; pairIndex++) {
              const routeProgress =
                controlPairs <= 1 ? 0.5 : pairIndex / (controlPairs - 1);
              const trackState = applyProgress(routeProgress);
              const injectedFirst = (pairIndex + controlIndex) % 2 === 1;
              let baseline;
              let injected;
              if (injectedFirst) {
                injected = await captureControlArm({
                  lane,
                  spec,
                  pairIndex,
                  routeProgress,
                  trackState,
                  inject: true,
                });
                baseline = await captureControlArm({
                  lane,
                  spec,
                  pairIndex,
                  routeProgress,
                  trackState,
                  inject: false,
                });
              } else {
                baseline = await captureControlArm({
                  lane,
                  spec,
                  pairIndex,
                  routeProgress,
                  trackState,
                  inject: false,
                });
                injected = await captureControlArm({
                  lane,
                  spec,
                  pairIndex,
                  routeProgress,
                  trackState,
                  inject: true,
                });
              }
              lane.pairs.push({
                baseline,
                injected,
                routeProgress,
                injectedFirst,
              });
            }
            out.controls.lanes.push(lane);
          }
          out.scope.afterScoring = scopeSnapshot();
        } catch (error) {
          out.inPageFatal = String(error?.stack ?? error?.message ?? error);
        } finally {
          activeDetail = null;
          activeControl = null;
          out.instrumentation.restored = restoreWrappers();
          renderer.setCpuPassProfiling(false);
          out.profiler.disabledAfter = profileSnapshot().enabled === false;
        }
        return out;
      },
      {
        runId: RUN_ID,
        track: GLOBE_CAMERA_TRACK,
        measureFrames: MEASURE_FRAMES,
        primeFramesPerWaypoint: PRIME_FRAMES_PER_WAYPOINT,
        routeStartPrimeFrames: ROUTE_START_PRIME_FRAMES,
        controlPairs: CONTROL_PAIRS,
        controlSpecs: PRIMITIVE_DETAIL_CONTROL_SPECS,
        detailNames: PRIMITIVE_DETAIL_NAMES,
        injectedMs: INJECTED_MS,
      },
    );
    gpuGate = await collectGateErrors(page);
  } catch (error) {
    outerFatalError = String(error?.stack ?? error?.message ?? error);
    try {
      gpuGate = await collectGateErrors(page);
    } catch {
      gpuGate = { armedDevices: 0, errors: [], deviceLost: null };
    }
  } finally {
    raw.pageErrors = pageErrors.slice();
    raw.localRequestFailures = localRequestFailures.slice();
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  return buildPrimitiveBreakdownReport(
    raw,
    consoleErrors,
    gpuGate,
    outerFatalError,
  );
}

export async function main() {
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  const firstRed = {
    path: FIRST_RED_OUTPUT_PATH,
    policy: "write-once",
    existedBefore: fs.existsSync(FIRST_RED_OUTPUT_PATH),
    written: false,
    preserved: false,
  };
  const running = {
    probe: "c11-169-webgpu-primitive-traversal-breakdown",
    schemaVersion: 1,
    runId: RUN_ID,
    startedAt: new Date().toISOString(),
    generatedAt: new Date().toISOString(),
    instrumentationMode: "diagnostic-noncausal-tools-nested",
    status: "RUNNING",
    pass: false,
    exitCode: 2,
    incomplete: true,
    failures: [],
    firstRed,
  };
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(running, null, 2)}\n`);

  const watchdog = setTimeout(() => {
    const timeoutArtifact = applyPrimitiveFirstRedPolicy(
      {
        ...running,
        generatedAt: new Date().toISOString(),
        status: "ERROR",
        incomplete: false,
        failures: [`watchdog fired after ${WATCHDOG_MS}ms`],
      },
      firstRed,
    );
    const serialized = `${JSON.stringify(timeoutArtifact, null, 2)}\n`;
    fs.writeFileSync(OUTPUT_PATH, serialized);
    if (!firstRed.existedBefore) {
      fs.writeFileSync(FIRST_RED_OUTPUT_PATH, serialized);
    }
    console.error(`[c11-169-primitive] watchdog fired after ${WATCHDOG_MS}ms`);
    process.exit(2);
  }, WATCHDOG_MS);
  watchdog.unref?.();

  let report;
  try {
    report = await runBrowserProbe();
  } catch (error) {
    report = buildPrimitiveBreakdownReport(
      { runId: RUN_ID },
      [],
      { armedDevices: 0, errors: [], deviceLost: null },
      String(error?.stack ?? error),
    );
  }
  report = applyPrimitiveFirstRedPolicy({ ...report, runId: RUN_ID }, firstRed);
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  fs.writeFileSync(OUTPUT_PATH, serialized);
  if (report.firstRed.written) {
    fs.writeFileSync(FIRST_RED_OUTPUT_PATH, serialized);
  }
  console.log(
    JSON.stringify(
      {
        probe: report.probe,
        result: report.result,
        failures: report.failures,
        scope: report.scopeQualification?.gate,
        route: report.route?.detailGate?.observed,
        controls: {
          pass: report.controls?.pass,
          failures: report.controls?.failures,
        },
        output: OUTPUT_PATH,
      },
      null,
      2,
    ),
  );
  clearTimeout(watchdog);
  process.exitCode = report.exitCode;
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(__filename)) {
  await main();
}
