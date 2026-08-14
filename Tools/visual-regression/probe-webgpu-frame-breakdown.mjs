#!/usr/bin/env node
/**
 * C11-169 — exact WebGPU CPU frame-accounting browser gate.
 *
 * This is deliberately a DIAGNOSTIC, NON-CAUSAL run. Enabling the CPU pass
 * profiler adds clock reads around render passes, so its absolute timings must
 * never replace the uninstrumented C11-205 causal result. The purpose of this
 * probe is narrower and exact:
 *
 *   total + attribution overlap
 *     = named pass CPU + coarse phase CPU + unattributed CPU
 *
 * It drives the shared orbit-to-ground camera track while the profiler records
 * one exact `lastFrame` record per synchronous `Scene.render()` call. It also
 * runs controlled phase-discriminator lanes and negative lanes for
 * request-render suppression, standalone picking, multi-frustum rendering, and
 * the two-viewport SCENE2D wrap.
 *
 * The old version compared the median of manually-timed static renders with a
 * sum of independently-windowed pass averages while Cesium's default RAF loop
 * was still active. Those populations were not frame-aligned. This version
 * disables the default loop, reads each exact record only after render returns,
 * and gates conservation per frame.
 *
 * Usage:
 *   node Tools/visual-regression/probe-webgpu-frame-breakdown.mjs
 *
 * Environment:
 *   PROBE_BASE=http://localhost:8080
 *   PROBE_HEADED=1
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  armWebGPUDevices,
  attachConsoleErrorGate,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";
import {
  GLOBE_CAMERA_TRACK,
  GLOBE_CAMERA_TRACK_ID,
} from "./lib/globe-camera-track.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const HEADED = process.env.PROBE_HEADED === "1";
const VIEWPORT = { width: 1280, height: 720 };
const MEASURE_FRAMES = 180;
const PRIME_FRAMES_PER_WAYPOINT = 6;
const ROUTE_START_PRIME_FRAMES = 24;
const CONTROL_PAIRS = 24;
const INJECTED_PHASE_MS = 8;
const CONSERVATION_EPSILON_MS = 0.05;
const PASS_SUM_EPSILON_MS = 0.05;
const CONTROL_TARGET_MIN_RATIO = 0.625;
const CONTROL_OFF_TARGET_MAX_RATIO = 0.25;
const MIN_PROFILED_FRAME_RATIO = 0.9;
const REQUEST_RENDER_QUIESCENCE_TIMEOUT_MS = 30_000;
const REQUEST_RENDER_MAX_DRAIN_FRAMES = 900;
const REQUEST_RENDER_ZERO_STREAK = 3;
const WATCHDOG_MS = 300_000;
const RUN_ID = randomUUID();
const OUTPUT_PATH = path.join(
  __dirname,
  "output",
  "performance",
  "c11-169-whole-frame-phase-attribution.json",
);
const FIRST_RED_OUTPUT_PATH = path.join(
  __dirname,
  "output",
  "performance",
  "c11-169-whole-frame-phase-attribution.first-red.json",
);

export const CPU_SCENE_PHASE_NAMES = Object.freeze([
  "sceneUpdate",
  "frameState",
  "contextBegin",
  "sceneEnvironmentUpdate",
  "visibilityCommandPrep",
  "primitiveTraversal",
  "computeShadows",
  "rendererOverhead",
  "frameFinalize",
  "contextEndSubmit",
  "afterRenderCreditTrace",
]);

const PHASE_CONTROL_SPECS = Object.freeze([
  Object.freeze({ id: "primitive-traversal", phase: "primitiveTraversal" }),
  Object.freeze({ id: "pvs-prep", phase: "visibilityCommandPrep" }),
  Object.freeze({ id: "renderer-overhead", phase: "rendererOverhead" }),
  Object.freeze({
    id: "after-render-credit-trace",
    phase: "afterRenderCreditTrace",
  }),
]);

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function rounded(value, digits = 4) {
  if (!isFiniteNumber(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

export function percentile(values, fraction) {
  const finite = values
    .filter(isFiniteNumber)
    .slice()
    .sort((a, b) => a - b);
  if (finite.length === 0) return null;
  const index = Math.min(
    finite.length - 1,
    Math.max(0, Math.floor(fraction * (finite.length - 1))),
  );
  return finite[index];
}

export function summarize(values) {
  const finite = values.filter(isFiniteNumber);
  if (finite.length === 0) return null;
  return {
    samples: finite.length,
    min: rounded(Math.min(...finite)),
    median: rounded(percentile(finite, 0.5)),
    p95: rounded(percentile(finite, 0.95)),
    max: rounded(Math.max(...finite)),
    mean: rounded(
      finite.reduce((sum, value) => sum + value, 0) / finite.length,
    ),
  };
}

/**
 * Normalize the additive C11-169 profile surface. `lastFrame` is authoritative;
 * rolling fields are intentionally not used to reconstruct an exact frame.
 */
export function normalizeLastFrame(profile, metadata = {}) {
  const frame = profile?.lastFrame ?? profile?.frameAccounting?.lastFrame;
  if (!frame || typeof frame !== "object") {
    return { ...metadata, structuralError: "missing exact lastFrame record" };
  }
  const passMs = {};
  const invalidPassBuckets = [];
  for (const [name, value] of Object.entries(frame.passMs ?? {})) {
    if (isFiniteNumber(value)) {
      passMs[name] = value;
    } else {
      invalidPassBuckets.push(name);
    }
  }
  const phaseMs = {};
  const invalidPhaseBuckets = [];
  for (const [name, value] of Object.entries(frame.phaseMs ?? {})) {
    if (isFiniteNumber(value)) {
      phaseMs[name] = value;
    } else {
      invalidPhaseBuckets.push(name);
    }
  }
  return {
    ...metadata,
    sequence: frame.sequence,
    sceneFrameNumber: frame.sceneFrameNumber,
    kind: frame.kind,
    totalMs: frame.totalMs,
    profiledPassMs: frame.profiledPassMs,
    unaccountedMs: frame.unaccountedMs,
    overlapMs: frame.overlapMs,
    coverageRatio: frame.coverageRatio,
    valid: frame.valid,
    passMs,
    invalidPassBuckets,
    phaseAttributionEnabled: frame.phaseAttributionEnabled,
    phaseMs,
    phaseTotalMs: frame.phaseTotalMs,
    unattributedMs: frame.unattributedMs,
    attributionOverlapMs: frame.attributionOverlapMs,
    attributionValid: frame.attributionValid,
    invalidPhaseBuckets,
  };
}

function accountingResidual(frame) {
  return (
    frame.totalMs + frame.overlapMs - frame.profiledPassMs - frame.unaccountedMs
  );
}

function attributionResidual(frame) {
  return (
    frame.totalMs +
    frame.attributionOverlapMs -
    frame.profiledPassMs -
    frame.phaseTotalMs -
    frame.unattributedMs
  );
}

function bridgeResidual(frame) {
  return (
    frame.unaccountedMs +
    frame.attributionOverlapMs -
    frame.phaseTotalMs -
    frame.unattributedMs -
    frame.overlapMs
  );
}

function passSum(frame) {
  return Object.values(frame.passMs ?? {}).reduce(
    (sum, value) => sum + (isFiniteNumber(value) ? value : 0),
    0,
  );
}

function phaseSum(frame) {
  return Object.values(frame.phaseMs ?? {}).reduce(
    (sum, value) => sum + (isFiniteNumber(value) ? value : 0),
    0,
  );
}

export function evaluateAccountingFrames(
  frames,
  {
    expectedSamples,
    expectedSegmentCount,
    requireFullRoute = false,
    conservationEpsilonMs = CONSERVATION_EPSILON_MS,
    passSumEpsilonMs = PASS_SUM_EPSILON_MS,
    minProfiledFrameRatio = MIN_PROFILED_FRAME_RATIO,
  } = {},
) {
  const failures = [];
  if (isFiniteNumber(expectedSamples) && frames.length !== expectedSamples) {
    failures.push(
      `sample count ${frames.length} did not equal expected ${expectedSamples}`,
    );
  }
  const sequences = new Set();
  const sceneFrames = new Set();
  const segments = new Set();
  const observedPositivePhases = new Set();
  let profiledFrames = 0;
  let maxFrustumCount = 0;
  let previousSequence = null;
  let previousSceneFrame = null;
  let minProgress = Infinity;
  let maxProgress = -Infinity;

  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index];
    const label = `frame[${index}]`;
    if (frame.structuralError) {
      failures.push(`${label}: ${frame.structuralError}`);
      continue;
    }
    for (const field of [
      "sequence",
      "sceneFrameNumber",
      "totalMs",
      "profiledPassMs",
      "unaccountedMs",
      "overlapMs",
      "coverageRatio",
      "phaseTotalMs",
      "unattributedMs",
      "attributionOverlapMs",
    ]) {
      if (!isFiniteNumber(frame[field])) {
        failures.push(`${label}: ${field} is not finite`);
      }
    }
    if (frame.kind !== "scene") failures.push(`${label}: kind is not scene`);
    if (frame.valid !== true) failures.push(`${label}: engine marked invalid`);
    if (frame.phaseAttributionEnabled !== true) {
      failures.push(`${label}: coarse phase attribution was not enabled`);
    }
    if (frame.attributionValid !== true) {
      failures.push(`${label}: engine marked phase attribution invalid`);
    }
    if ((frame.invalidPassBuckets?.length ?? 0) > 0) {
      failures.push(
        `${label}: non-finite pass buckets ${frame.invalidPassBuckets.join(", ")}`,
      );
    }
    for (const [name, value] of Object.entries(frame.passMs ?? {})) {
      if (value < 0) {
        failures.push(`${label}: pass ${name} has negative time ${value}`);
      }
    }
    if ((frame.invalidPhaseBuckets?.length ?? 0) > 0) {
      failures.push(
        `${label}: non-finite phase buckets ${frame.invalidPhaseBuckets.join(", ")}`,
      );
    }
    const phaseKeys = Object.keys(frame.phaseMs ?? {});
    const expectedPhaseKeys = CPU_SCENE_PHASE_NAMES;
    if (
      phaseKeys.length !== expectedPhaseKeys.length ||
      phaseKeys.some(
        (name, phaseIndex) => name !== expectedPhaseKeys[phaseIndex],
      )
    ) {
      failures.push(
        `${label}: phase schema was not the exact fixed 11-key set`,
      );
    }
    for (const [name, value] of Object.entries(frame.phaseMs ?? {})) {
      if (value < 0) {
        failures.push(`${label}: phase ${name} has negative time ${value}`);
      }
      if (value > 0) observedPositivePhases.add(name);
    }
    if (
      isFiniteNumber(frame.totalMs) &&
      isFiniteNumber(frame.profiledPassMs) &&
      isFiniteNumber(frame.unaccountedMs) &&
      isFiniteNumber(frame.overlapMs) &&
      isFiniteNumber(frame.phaseTotalMs) &&
      isFiniteNumber(frame.unattributedMs) &&
      isFiniteNumber(frame.attributionOverlapMs)
    ) {
      if (
        frame.totalMs < 0 ||
        frame.profiledPassMs < 0 ||
        frame.unaccountedMs < 0 ||
        frame.overlapMs < 0 ||
        frame.phaseTotalMs < 0 ||
        frame.unattributedMs < 0 ||
        frame.attributionOverlapMs < 0
      ) {
        failures.push(`${label}: negative accounting value`);
      }
      const residual = Math.abs(accountingResidual(frame));
      if (residual > conservationEpsilonMs) {
        failures.push(
          `${label}: conservation residual ${residual.toFixed(4)}ms exceeds ${conservationEpsilonMs}ms`,
        );
      }
      if (frame.overlapMs > conservationEpsilonMs) {
        failures.push(
          `${label}: overlapping pass timers ${frame.overlapMs.toFixed(4)}ms`,
        );
      }
      const phaseResidual = Math.abs(attributionResidual(frame));
      if (phaseResidual > conservationEpsilonMs) {
        failures.push(
          `${label}: attribution residual ${phaseResidual.toFixed(4)}ms exceeds ${conservationEpsilonMs}ms`,
        );
      }
      const ledgerBridgeResidual = Math.abs(bridgeResidual(frame));
      if (ledgerBridgeResidual > conservationEpsilonMs) {
        failures.push(
          `${label}: legacy/phase bridge residual ${ledgerBridgeResidual.toFixed(4)}ms exceeds ${conservationEpsilonMs}ms`,
        );
      }
      if (frame.attributionOverlapMs > conservationEpsilonMs) {
        failures.push(
          `${label}: attribution overlap ${frame.attributionOverlapMs.toFixed(4)}ms`,
        );
      }
      if (frame.unattributedMs > conservationEpsilonMs) {
        failures.push(
          `${label}: unattributed time ${frame.unattributedMs.toFixed(4)}ms`,
        );
      }
      const summedPasses = passSum(frame);
      if (Math.abs(summedPasses - frame.profiledPassMs) > passSumEpsilonMs) {
        failures.push(
          `${label}: pass sum ${summedPasses.toFixed(4)}ms != profiled ${frame.profiledPassMs.toFixed(4)}ms`,
        );
      }
      const summedPhases = phaseSum(frame);
      if (Math.abs(summedPhases - frame.phaseTotalMs) > passSumEpsilonMs) {
        failures.push(
          `${label}: phase sum ${summedPhases.toFixed(4)}ms != phase total ${frame.phaseTotalMs.toFixed(4)}ms`,
        );
      }
      if (frame.profiledPassMs > 0 && Object.keys(frame.passMs).length > 0) {
        profiledFrames++;
      }
    }
    if (
      isFiniteNumber(frame.coverageRatio) &&
      (frame.coverageRatio < 0 || frame.coverageRatio > 1)
    ) {
      failures.push(`${label}: coverageRatio outside [0,1]`);
    }
    if (sequences.has(frame.sequence)) {
      failures.push(`${label}: duplicate sequence ${frame.sequence}`);
    }
    if (sceneFrames.has(frame.sceneFrameNumber)) {
      failures.push(
        `${label}: duplicate scene frame ${frame.sceneFrameNumber}`,
      );
    }
    sequences.add(frame.sequence);
    sceneFrames.add(frame.sceneFrameNumber);
    if (
      previousSequence !== null &&
      isFiniteNumber(frame.sequence) &&
      frame.sequence !== previousSequence + 1
    ) {
      failures.push(
        `${label}: sequence ${frame.sequence} did not follow ${previousSequence}`,
      );
    }
    if (
      previousSceneFrame !== null &&
      isFiniteNumber(frame.sceneFrameNumber) &&
      frame.sceneFrameNumber !== previousSceneFrame + 1
    ) {
      failures.push(
        `${label}: scene frame ${frame.sceneFrameNumber} did not follow ${previousSceneFrame}`,
      );
    }
    previousSequence = frame.sequence;
    previousSceneFrame = frame.sceneFrameNumber;
    if (Number.isInteger(frame.segmentIndex)) segments.add(frame.segmentIndex);
    if (isFiniteNumber(frame.routeProgress)) {
      minProgress = Math.min(minProgress, frame.routeProgress);
      maxProgress = Math.max(maxProgress, frame.routeProgress);
    }
    if (isFiniteNumber(frame.frustumCount)) {
      maxFrustumCount = Math.max(maxFrustumCount, frame.frustumCount);
    }
  }

  const profiledFrameRatio =
    frames.length > 0 ? profiledFrames / frames.length : 0;
  if (profiledFrameRatio < minProfiledFrameRatio) {
    failures.push(
      `profiled-frame ratio ${profiledFrameRatio.toFixed(3)} < ${minProfiledFrameRatio}`,
    );
  }
  if (requireFullRoute) {
    if (!(minProgress <= 0.001 && maxProgress >= 0.999)) {
      failures.push(
        `route progress did not span [0,1] (observed ${minProgress}..${maxProgress})`,
      );
    }
    for (const phase of CPU_SCENE_PHASE_NAMES) {
      if (!observedPositivePhases.has(phase)) {
        failures.push(`moving route never observed positive ${phase} time`);
      }
    }
    if (
      isFiniteNumber(expectedSegmentCount) &&
      segments.size !== expectedSegmentCount
    ) {
      failures.push(
        `route exercised ${segments.size}/${expectedSegmentCount} segments`,
      );
    }
  }

  return {
    pass: failures.length === 0,
    failures,
    observed: {
      samples: frames.length,
      uniqueSequences: sequences.size,
      uniqueSceneFrames: sceneFrames.size,
      profiledFrames,
      profiledFrameRatio: rounded(profiledFrameRatio),
      routeProgress:
        minProgress === Infinity
          ? null
          : { min: rounded(minProgress), max: rounded(maxProgress) },
      routeSegments: [...segments].sort((a, b) => a - b),
      maxFrustumCount,
      totalMs: summarize(frames.map((frame) => frame.totalMs)),
      profiledPassMs: summarize(frames.map((frame) => frame.profiledPassMs)),
      unaccountedMs: summarize(frames.map((frame) => frame.unaccountedMs)),
      phaseTotalMs: summarize(frames.map((frame) => frame.phaseTotalMs)),
      unattributedMs: summarize(frames.map((frame) => frame.unattributedMs)),
      attributionOverlapMs: summarize(
        frames.map((frame) => frame.attributionOverlapMs),
      ),
      positivePhases: [...observedPositivePhases].sort(),
      phaseMs: Object.fromEntries(
        CPU_SCENE_PHASE_NAMES.map((phase) => [
          phase,
          summarize(frames.map((frame) => frame.phaseMs?.[phase])),
        ]),
      ),
      coverageRatio: summarize(frames.map((frame) => frame.coverageRatio)),
    },
  };
}

export function evaluatePhaseControl(
  pairs,
  targetPhase,
  injectedMs = INJECTED_PHASE_MS,
) {
  const failures = [];
  const totalDeltas = [];
  const profiledDeltas = [];
  const phaseTotalDeltas = [];
  const unaccountedDeltas = [];
  const targetDeltas = [];
  const offTargetDeltas = [];
  const unattributedDeltas = [];
  const perPhaseDeltas = Object.fromEntries(
    CPU_SCENE_PHASE_NAMES.map((phase) => [phase, []]),
  );
  const namedPasses = new Set(
    pairs.flatMap((pair) => [
      ...Object.keys(pair?.baseline?.passMs ?? {}),
      ...Object.keys(pair?.injected?.passMs ?? {}),
    ]),
  );
  const namedPassDeltas = Object.fromEntries(
    [...namedPasses].map((name) => [name, []]),
  );
  let baselineProfiledFrames = 0;
  let injectedProfiledFrames = 0;
  for (let index = 0; index < pairs.length; index++) {
    const pair = pairs[index];
    const baseline = pair.baseline;
    const injected = pair.injected;
    if (!baseline || !injected) {
      failures.push(`pair[${index}] missing baseline/injected record`);
      continue;
    }
    if (baseline.seamHitDelta !== 1 || baseline.spinHitDelta !== 0) {
      failures.push(
        `pair[${index}] baseline hit counts were seam=${baseline.seamHitDelta}, spin=${baseline.spinHitDelta}`,
      );
    }
    if (injected.seamHitDelta !== 1 || injected.spinHitDelta !== 1) {
      failures.push(
        `pair[${index}] injected hit counts were seam=${injected.seamHitDelta}, spin=${injected.spinHitDelta}`,
      );
    }
    if (
      baseline.profiledPassMs > 0 &&
      Object.keys(baseline.passMs ?? {}).length > 0
    ) {
      baselineProfiledFrames++;
    }
    if (
      injected.profiledPassMs > 0 &&
      Object.keys(injected.passMs ?? {}).length > 0
    ) {
      injectedProfiledFrames++;
    }
    totalDeltas.push(injected.totalMs - baseline.totalMs);
    profiledDeltas.push(injected.profiledPassMs - baseline.profiledPassMs);
    for (const name of namedPasses) {
      namedPassDeltas[name].push(
        (injected.passMs?.[name] ?? 0) - (baseline.passMs?.[name] ?? 0),
      );
    }
    phaseTotalDeltas.push(injected.phaseTotalMs - baseline.phaseTotalMs);
    unaccountedDeltas.push(injected.unaccountedMs - baseline.unaccountedMs);
    for (const phase of CPU_SCENE_PHASE_NAMES) {
      perPhaseDeltas[phase].push(
        injected.phaseMs?.[phase] - baseline.phaseMs?.[phase],
      );
    }
    targetDeltas.push(
      injected.phaseMs?.[targetPhase] - baseline.phaseMs?.[targetPhase],
    );
    offTargetDeltas.push(
      CPU_SCENE_PHASE_NAMES.filter((phase) => phase !== targetPhase).reduce(
        (sum, phase) =>
          sum + (injected.phaseMs?.[phase] - baseline.phaseMs?.[phase]),
        0,
      ),
    );
    unattributedDeltas.push(injected.unattributedMs - baseline.unattributedMs);
  }
  const totalMedianDelta = percentile(totalDeltas, 0.5);
  const profiledMedianDelta = percentile(profiledDeltas, 0.5);
  const phaseTotalMedianDelta = percentile(phaseTotalDeltas, 0.5);
  const unaccountedMedianDelta = percentile(unaccountedDeltas, 0.5);
  const targetMedianDelta = percentile(targetDeltas, 0.5);
  const offTargetMedianDelta = percentile(offTargetDeltas, 0.5);
  const unattributedMedianDelta = percentile(unattributedDeltas, 0.5);
  const minimumExpectedDelta = injectedMs * CONTROL_TARGET_MIN_RATIO;
  const maximumOffTargetDelta = injectedMs * CONTROL_OFF_TARGET_MAX_RATIO;
  if (namedPasses.size === 0) {
    failures.push("control population contained no named pass buckets");
  }
  if (baselineProfiledFrames === 0 || injectedProfiledFrames === 0) {
    failures.push(
      `control named-pass work was vacuous (baseline=${baselineProfiledFrames}, injected=${injectedProfiledFrames})`,
    );
  }
  if (
    !isFiniteNumber(totalMedianDelta) ||
    totalMedianDelta < minimumExpectedDelta
  ) {
    failures.push(
      `total median delta ${totalMedianDelta}ms < ${minimumExpectedDelta}ms`,
    );
  }
  if (!CPU_SCENE_PHASE_NAMES.includes(targetPhase)) {
    failures.push(`unknown target phase ${targetPhase}`);
  }
  if (
    !isFiniteNumber(targetMedianDelta) ||
    targetMedianDelta < minimumExpectedDelta
  ) {
    failures.push(
      `${targetPhase} median delta ${targetMedianDelta}ms < ${minimumExpectedDelta}ms`,
    );
  }
  for (const [label, value] of [
    ["phase total", phaseTotalMedianDelta],
    ["legacy unaccounted", unaccountedMedianDelta],
  ]) {
    if (!isFiniteNumber(value) || value < minimumExpectedDelta) {
      failures.push(
        `${label} median delta ${value}ms < ${minimumExpectedDelta}ms`,
      );
    }
  }
  if (
    !isFiniteNumber(profiledMedianDelta) ||
    Math.abs(profiledMedianDelta) > maximumOffTargetDelta
  ) {
    failures.push(
      `profiled median delta ${profiledMedianDelta}ms exceeded ${maximumOffTargetDelta}ms`,
    );
  }
  for (const phase of CPU_SCENE_PHASE_NAMES) {
    if (phase === targetPhase) continue;
    const medianDelta = percentile(perPhaseDeltas[phase], 0.5);
    if (
      !isFiniteNumber(medianDelta) ||
      Math.abs(medianDelta) > maximumOffTargetDelta
    ) {
      failures.push(
        `${phase} median delta ${medianDelta}ms exceeded ${maximumOffTargetDelta}ms`,
      );
    }
  }
  for (const name of namedPasses) {
    const medianDelta = percentile(namedPassDeltas[name], 0.5);
    if (
      !isFiniteNumber(medianDelta) ||
      Math.abs(medianDelta) > maximumOffTargetDelta
    ) {
      failures.push(
        `named pass ${name} median delta ${medianDelta}ms exceeded ${maximumOffTargetDelta}ms`,
      );
    }
  }
  if (
    !isFiniteNumber(offTargetMedianDelta) ||
    Math.abs(offTargetMedianDelta) > maximumOffTargetDelta
  ) {
    failures.push(
      `off-target phase median delta ${offTargetMedianDelta}ms exceeded ${maximumOffTargetDelta}ms`,
    );
  }
  if (
    !isFiniteNumber(unattributedMedianDelta) ||
    Math.abs(unattributedMedianDelta) > CONSERVATION_EPSILON_MS
  ) {
    failures.push(
      `unattributed median delta ${unattributedMedianDelta}ms exceeded ${CONSERVATION_EPSILON_MS}ms`,
    );
  }
  for (const [label, value] of [
    ["total", totalMedianDelta],
    ["phase total", phaseTotalMedianDelta],
    ["legacy unaccounted", unaccountedMedianDelta],
  ]) {
    if (
      isFiniteNumber(value) &&
      isFiniteNumber(targetMedianDelta) &&
      Math.abs(value - targetMedianDelta) > maximumOffTargetDelta
    ) {
      failures.push(
        `${label}/target median deltas diverged by ${Math.abs(value - targetMedianDelta)}ms`,
      );
    }
  }
  return {
    pass: failures.length === 0,
    failures,
    observed: {
      pairs: pairs.length,
      baselineProfiledFrames,
      injectedProfiledFrames,
      injectedMs,
      targetPhase,
      totalDeltaMs: summarize(totalDeltas),
      profiledPassDeltaMs: summarize(profiledDeltas),
      phaseTotalDeltaMs: summarize(phaseTotalDeltas),
      unaccountedDeltaMs: summarize(unaccountedDeltas),
      targetPhaseDeltaMs: summarize(targetDeltas),
      offTargetPhaseDeltaMs: summarize(offTargetDeltas),
      unattributedDeltaMs: summarize(unattributedDeltas),
      phaseDeltaMs: Object.fromEntries(
        CPU_SCENE_PHASE_NAMES.map((phase) => [
          phase,
          summarize(perPhaseDeltas[phase]),
        ]),
      ),
      namedPassDeltaMs: Object.fromEntries(
        [...namedPasses]
          .sort()
          .map((name) => [name, summarize(namedPassDeltas[name])]),
      ),
    },
  };
}

export function evaluateRequestRenderSuppression(lane) {
  const failures = [];
  const quiescence = lane?.quiescence;
  if (quiescence?.reached !== true) {
    failures.push(
      `foreground/request-render quiescence was not reached within ${quiescence?.timeoutMs}ms and ${quiescence?.maxDrainFrames} drain frames`,
    );
  }
  if (
    !Number.isInteger(quiescence?.zeroForegroundStreak) ||
    quiescence.zeroForegroundStreak <
      (quiescence?.requiredZeroForegroundFrames ?? Infinity)
  ) {
    failures.push(
      `foreground-zero streak ${quiescence?.zeroForegroundStreak} did not reach ${quiescence?.requiredZeroForegroundFrames}`,
    );
  }
  if (lane?.confirmedSuppressedPreflight !== true) {
    failures.push("request-render suppression preflight did not suppress");
  }
  if (lane?.scored !== true) {
    failures.push("request-render suppression sample was not scored");
  } else {
    if (lane.normalSampleDelta !== 0) {
      failures.push(
        `suppressed requestRender call added ${lane.normalSampleDelta} normal samples`,
      );
    }
    if (lane.sceneFrameDelta !== 0) {
      failures.push(
        `suppressed requestRender call advanced scene frame by ${lane.sceneFrameDelta}`,
      );
    }
    if (lane.lastNormalRecordUnchanged !== true) {
      failures.push(
        "suppressed requestRender call changed the exact last normal record",
      );
    }
    if (lane.normalAccountingUnchanged !== true) {
      failures.push(
        "suppressed requestRender call changed the normal accounting window",
      );
    }
    if (lane.legacyFrameDelta !== 0) {
      failures.push(
        `suppressed requestRender call added ${lane.legacyFrameDelta} legacy profiler frames`,
      );
    }
  }

  const preconditions = lane?.preconditions;
  if (preconditions?.pendingForegroundCount !== 0) {
    failures.push(
      `request-render suppression precondition had ${preconditions?.pendingForegroundCount} foreground jobs`,
    );
  }
  if (preconditions?.requestRenderMode !== true) {
    failures.push("requestRenderMode was not enabled before suppression");
  }
  if (preconditions?.renderRequested !== false) {
    failures.push("_renderRequested was dirty before suppression");
  }
  if (preconditions?.logDepthBufferDirty !== false) {
    failures.push("log-depth state was dirty before suppression");
  }
  if (preconditions?.hdrDirty !== false) {
    failures.push("HDR state was dirty before suppression");
  }
  if (preconditions?.maximumRenderTimeChangeDefined !== false) {
    failures.push("maximumRenderTimeChange could legitimately force a frame");
  }
  if (preconditions?.afterRenderCount !== 0) {
    failures.push(
      `${preconditions?.afterRenderCount} afterRender callbacks remained before suppression`,
    );
  }
  if (preconditions?.sceneMode !== preconditions?.expectedSceneMode) {
    failures.push(
      `request-render suppression lane was in scene mode ${preconditions?.sceneMode}, expected ${preconditions?.expectedSceneMode}`,
    );
  }
  const afterState = lane?.afterState;
  if (lane?.scored === true) {
    if (afterState?.pendingForegroundCount !== 0) {
      failures.push(
        `scored suppression left ${afterState?.pendingForegroundCount} foreground jobs`,
      );
    }
    if (
      afterState?.renderRequested !== false ||
      afterState?.logDepthBufferDirty !== false ||
      afterState?.hdrDirty !== false ||
      afterState?.afterRenderCount !== 0
    ) {
      failures.push(
        "scored suppression left a legitimate next-frame trigger dirty",
      );
    }
  }

  return {
    pass: failures.length === 0,
    failures,
    observed: {
      scored: lane?.scored === true,
      drainFrames: quiescence?.drainFrames ?? null,
      elapsedMs: quiescence?.elapsedMs ?? null,
      zeroForegroundStreak: quiescence?.zeroForegroundStreak ?? null,
      preflightAttempts: quiescence?.preflightAttempts ?? null,
      pendingByKind: preconditions?.pendingByKind ?? null,
    },
  };
}

function interpolateDegrees(start, end, amount) {
  let delta = ((end - start + 540) % 360) - 180;
  if (delta === -180) delta = 180;
  return start + delta * amount;
}

export function interpolateTrack(track, routeProgress) {
  assert(track.length >= 2, "camera track must contain at least two waypoints");
  const progress = Math.min(1, Math.max(0, routeProgress));
  const scaled = progress * (track.length - 1);
  const segmentIndex = Math.min(track.length - 2, Math.floor(scaled));
  const amount = Math.min(1, scaled - segmentIndex);
  const start = track[segmentIndex];
  const end = track[segmentIndex + 1];
  return {
    segmentIndex,
    segmentName: `${start.name}->${end.name}`,
    lon: interpolateDegrees(start.lon, end.lon, amount),
    lat: start.lat + (end.lat - start.lat) * amount,
    height: start.height + (end.height - start.height) * amount,
    heading: interpolateDegrees(start.heading, end.heading, amount),
    pitch: start.pitch + (end.pitch - start.pitch) * amount,
    roll: interpolateDegrees(start.roll, end.roll, amount),
  };
}

function normalizeCaptured(captured) {
  return normalizeLastFrame(captured?.profile, captured?.metadata);
}

function buildReport(raw, consoleErrors, gpuGate, fatalError) {
  const routeFrames = (raw?.route?.frames ?? []).map(normalizeCaptured);
  const routeGate = evaluateAccountingFrames(routeFrames, {
    expectedSamples: MEASURE_FRAMES,
    expectedSegmentCount: GLOBE_CAMERA_TRACK.length - 1,
    requireFullRoute: true,
  });

  const phaseControlReports = (raw?.phaseInjectionControls?.lanes ?? []).map(
    (lane) => {
      const pairs = (lane?.pairs ?? []).map((pair) => ({
        baseline: normalizeCaptured(pair.baseline),
        injected: normalizeCaptured(pair.injected),
        routeProgress: pair.routeProgress,
        injectedFirst: pair.injectedFirst,
      }));
      // Preserve capture chronology for the exact +1 sequence gate. Pair order
      // alternates across both pair and lane index to cancel second-render bias.
      const frames = pairs.flatMap((pair) =>
        pair.injectedFirst
          ? [pair.injected, pair.baseline]
          : [pair.baseline, pair.injected],
      );
      const accountingGate = evaluateAccountingFrames(frames, {
        expectedSamples: CONTROL_PAIRS * 2,
        // Route-level non-vacuity is established over the 180 moving frames.
        // Repeated paired controls can legitimately quantize otherwise real
        // named-pass work to 0 ms. Their direct discriminator below instead
        // requires nonempty named buckets and positive work in both arms.
        minProfiledFrameRatio: 0,
      });
      const discriminatorGate = evaluatePhaseControl(
        pairs,
        lane?.targetPhase,
        INJECTED_PHASE_MS,
      );
      const hitFailures = [];
      if (lane?.seamHits !== CONTROL_PAIRS * 2) {
        hitFailures.push(
          `${lane?.id} seam hits ${lane?.seamHits} != ${CONTROL_PAIRS * 2}`,
        );
      }
      if (lane?.spinHits !== CONTROL_PAIRS) {
        hitFailures.push(
          `${lane?.id} spin hits ${lane?.spinHits} != ${CONTROL_PAIRS}`,
        );
      }
      const controlProgress = pairs
        .map((pair) => pair.routeProgress)
        .filter(isFiniteNumber);
      const minControlProgress =
        controlProgress.length > 0 ? Math.min(...controlProgress) : null;
      const maxControlProgress =
        controlProgress.length > 0 ? Math.max(...controlProgress) : null;
      if (
        controlProgress.length !== CONTROL_PAIRS ||
        minControlProgress > 0.001 ||
        maxControlProgress < 0.999
      ) {
        hitFailures.push(
          `${lane?.id} control route did not span [0,1] (${minControlProgress}..${maxControlProgress})`,
        );
      }
      return {
        id: lane?.id ?? null,
        targetPhase: lane?.targetPhase ?? null,
        seamHits: lane?.seamHits ?? null,
        spinHits: lane?.spinHits ?? null,
        accountingGate,
        discriminatorGate,
        hitFailures,
        framePairs: pairs,
      };
    },
  );
  const phaseControlFailures = [];
  if (phaseControlReports.length !== PHASE_CONTROL_SPECS.length) {
    phaseControlFailures.push(
      `phase control lane count ${phaseControlReports.length} != ${PHASE_CONTROL_SPECS.length}`,
    );
  }
  for (const spec of PHASE_CONTROL_SPECS) {
    const matches = phaseControlReports.filter((lane) => lane.id === spec.id);
    if (matches.length !== 1) {
      phaseControlFailures.push(
        `phase control ${spec.id} appeared ${matches.length} times`,
      );
      continue;
    }
    if (matches[0].targetPhase !== spec.phase) {
      phaseControlFailures.push(
        `phase control ${spec.id} targeted ${matches[0].targetPhase}, expected ${spec.phase}`,
      );
    }
  }
  for (const lane of phaseControlReports) {
    phaseControlFailures.push(
      ...lane.accountingGate.failures.map(
        (failure) => `${lane.id}: ${failure}`,
      ),
      ...lane.discriminatorGate.failures.map(
        (failure) => `${lane.id}: ${failure}`,
      ),
      ...lane.hitFailures,
    );
  }

  const negative = raw?.negativeLanes ?? {};
  const negativeFailures = [];
  const negativeAccountingFrames = [
    negative.multiFrustum?.frame
      ? normalizeCaptured(negative.multiFrustum.frame)
      : null,
    negative.scene2D?.frame ? normalizeCaptured(negative.scene2D.frame) : null,
  ].filter(Boolean);
  const negativeAccountingGate = evaluateAccountingFrames(
    negativeAccountingFrames,
    {
      expectedSamples: 2,
      minProfiledFrameRatio: MIN_PROFILED_FRAME_RATIO,
    },
  );
  // The selected multi-frustum and 2D samples are separated by bounded search
  // candidates, so their sequence numbers need not be adjacent. Conservation
  // is still exact; remove only the cross-lane adjacency diagnostic.
  const negativeAccountingFailures = negativeAccountingGate.failures.filter(
    (failure) => !failure.includes("did not follow"),
  );
  negativeAccountingGate.failures = negativeAccountingFailures;
  negativeAccountingGate.pass = negativeAccountingFailures.length === 0;
  const requestRenderGate = evaluateRequestRenderSuppression(
    negative.requestRender,
  );
  negativeFailures.push(...requestRenderGate.failures);
  if (negative.pick?.available !== true) {
    negativeFailures.push("Scene.pickAsync unavailable");
  }
  if (negative.pick?.error) {
    negativeFailures.push(`standalone pick threw: ${negative.pick.error}`);
  }
  if (negative.pick?.normalSampleDelta !== 0) {
    negativeFailures.push(
      `standalone pick added ${negative.pick?.normalSampleDelta} normal samples`,
    );
  }
  if (negative.pick?.lastNormalSequenceChanged === true) {
    negativeFailures.push("standalone pick overwrote last normal frame");
  }
  if (negative.pick?.lastNormalRecordUnchanged !== true) {
    negativeFailures.push("standalone pick changed the exact normal record");
  }
  if (negative.pick?.normalAccountingUnchanged !== true) {
    negativeFailures.push(
      "standalone pick changed the normal accounting window",
    );
  }
  if (!(negative.pick?.legacyFrameDelta >= 1)) {
    negativeFailures.push("standalone pick lane was not exercised");
  }
  if (negative.multiFrustum?.found !== true) {
    negativeFailures.push("no explicit multi-frustum frame was produced");
  }
  if (negative.multiFrustum?.normalSampleDelta !== 1) {
    negativeFailures.push(
      `multi-frustum render added ${negative.multiFrustum?.normalSampleDelta} normal samples`,
    );
  }
  if (!(negative.multiFrustum?.frustumCount >= 2)) {
    negativeFailures.push("multi-frustum lane was vacuous");
  }
  if (negative.scene2D?.foundSplit !== true) {
    negativeFailures.push("no two-viewport SCENE2D wrap was produced");
  }
  if (negative.scene2D?.executeCalls !== 2) {
    negativeFailures.push(
      `SCENE2D split executed renderer ${negative.scene2D?.executeCalls} times instead of 2`,
    );
  }
  if (negative.scene2D?.normalSampleDelta !== 1) {
    negativeFailures.push(
      `SCENE2D split added ${negative.scene2D?.normalSampleDelta} normal samples`,
    );
  }

  const runtimeErrors = [
    ...consoleErrors,
    ...(raw?.pageErrors ?? []),
    ...(raw?.localRequestFailures ?? []),
    ...(gpuGate?.errors ?? []),
    ...(gpuGate?.deviceLost ? [gpuGate.deviceLost] : []),
  ];
  const structuralFailures = [];
  if (fatalError) structuralFailures.push(fatalError);
  if (raw?.profiler?.available !== true) {
    structuralFailures.push("WebGPU CPU pass profiler unavailable");
  }
  if (raw?.profiler?.defaultDisabled !== true) {
    structuralFailures.push("CPU pass profiler was not disabled by default");
  }
  if (raw?.rendererType !== "webgpu") {
    structuralFailures.push(`renderer type was ${raw?.rendererType}`);
  }
  if (raw?.setup?.imagery !== "NaturalEarthII-local") {
    structuralFailures.push(
      `local NaturalEarthII imagery was not installed: ${raw?.setup?.imagery}`,
    );
  }
  if ((gpuGate?.armedDevices ?? 0) < 1) {
    structuralFailures.push("WebGPU error gate armed no GPUDevice");
  }
  if (raw?.route?.sequenceDelta !== MEASURE_FRAMES) {
    structuralFailures.push(
      `normal-frame sequence delta ${raw?.route?.sequenceDelta} != ${MEASURE_FRAMES}`,
    );
  }

  const failures = [
    ...structuralFailures,
    ...routeGate.failures,
    ...phaseControlFailures,
    ...negativeAccountingGate.failures,
    ...negativeFailures,
    ...runtimeErrors.map((error) => `runtime error: ${error}`),
  ];
  const pass = failures.length === 0;
  const exitCode = fatalError ? 2 : pass ? 0 : 1;

  return {
    probe: "c11-169-webgpu-whole-frame-phase-attribution",
    schemaVersion: 4,
    runId: raw?.runId ?? null,
    generatedAt: new Date().toISOString(),
    instrumentationMode: "diagnostic-noncausal",
    status: fatalError ? "ERROR" : pass ? "PASS" : "FAIL",
    pass,
    exitCode,
    incomplete: false,
    result: pass ? "pass" : "fail",
    failures,
    contract: {
      legacyEquation: "totalMs + overlapMs = profiledPassMs + unaccountedMs",
      attributionEquation:
        "totalMs + attributionOverlapMs = profiledPassMs + phaseTotalMs + unattributedMs",
      bridgeEquation:
        "unaccountedMs + attributionOverlapMs = phaseTotalMs + unattributedMs + overlapMs",
      phaseNames: CPU_SCENE_PHASE_NAMES,
      frameBoundary:
        "unmodified Scene.render body entry through return, after postRender/creditDisplay.endFrame",
      gpuAsyncExcluded: true,
      causalTimingClaim: false,
      conservationEpsilonMs: CONSERVATION_EPSILON_MS,
      passSumEpsilonMs: PASS_SUM_EPSILON_MS,
    },
    setup: {
      base: BASE,
      viewport: VIEWPORT,
      rendererType: raw?.rendererType ?? null,
      imagery: raw?.setup?.imagery ?? null,
      fixedTime: raw?.setup?.fixedTime ?? null,
      profiler: raw?.profiler ?? null,
      gpuGate,
    },
    route: {
      id: GLOBE_CAMERA_TRACK_ID,
      waypointCount: GLOBE_CAMERA_TRACK.length,
      segmentCount: GLOBE_CAMERA_TRACK.length - 1,
      frames: MEASURE_FRAMES,
      prime: raw?.prime ?? null,
      gate: routeGate,
      frameRecords: routeFrames,
      accountingStart: raw?.route?.accountingStart ?? null,
      accountingEnd: raw?.route?.accountingEnd ?? null,
    },
    phaseInjectionControls: {
      injectedMs: INJECTED_PHASE_MS,
      pairsPerLane: CONTROL_PAIRS,
      specs: PHASE_CONTROL_SPECS,
      pass: phaseControlFailures.length === 0,
      failures: phaseControlFailures,
      lanes: phaseControlReports,
    },
    negativeLanes: {
      gate: {
        pass:
          negativeFailures.length === 0 && negativeAccountingGate.pass === true,
        failures: [...negativeAccountingGate.failures, ...negativeFailures],
      },
      accountingGate: negativeAccountingGate,
      requestRenderGate,
      ...negative,
    },
    errors: {
      console: consoleErrors,
      page: raw?.pageErrors ?? [],
      localRequestFailures: raw?.localRequestFailures ?? [],
      gpu: gpuGate?.errors ?? [],
      deviceLost: gpuGate?.deviceLost ?? null,
      fatal: fatalError,
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
  let fatalError = null;
  try {
    await page.goto(
      `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu&offline=true`,
      {
        waitUntil: "domcontentloaded",
        timeout: 90_000,
      },
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
        phaseControlSpecs,
        injectedPhaseMs,
        requestRenderTimeoutMs,
        requestRenderMaxDrainFrames,
        requestRenderZeroStreak,
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
          prime: {},
          route: { frames: [] },
          phaseInjectionControls: { lanes: [] },
          negativeLanes: {},
        };

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
        const recordsEqual = (left, right) =>
          JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
        // `frameAccounting.samples` is the rolling-window population and caps
        // at 60. `lastFrame.sequence` is the lifetime count since profiler
        // reset, so all exact +1 logical-frame gates use it instead.
        const normalSequence = () => profileSnapshot().lastFrame?.sequence ?? 0;
        const nextAnimationFrame = () =>
          new Promise((resolve) => requestAnimationFrame(resolve));
        const renderOne = async (beforeRender) => {
          beforeRender?.();
          scene.initializeFrame();
          scene.render(viewer.clock.currentTime);
          const profile = profileSnapshot();
          const metadata = {
            frustumCount: scene._view?.frustumCommandsList?.length ?? 0,
            cameraHeight: scene.camera.positionCartographic?.height ?? null,
          };
          await nextAnimationFrame();
          return { profile, metadata };
        };
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

        // One render owner only. Awaited RAFs below merely yield for async
        // pipelines/tiles; they cannot trigger a second Cesium render.
        viewer.useDefaultRenderLoop = false;
        scene.requestRenderMode = false;
        viewer.clock.shouldAnimate = false;
        viewer.clock.currentTime = C.JulianDate.fromIso8601(
          "2026-06-21T19:00:00Z",
        );
        out.setup.fixedTime = C.JulianDate.toIso8601(viewer.clock.currentTime);

        // Replace a possibly-online base layer with the repository-local
        // NaturalEarth pyramid. This keeps imagery present while removing an
        // external-network readiness variable.
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

        // Resident-prime every altitude/region with profiling disabled. The
        // measured lane remains moving; this only moves startup compilation and
        // first tile realization outside its accounting population.
        let primeFrames = 0;
        for (
          let waypointIndex = 0;
          waypointIndex < track.length;
          waypointIndex++
        ) {
          applyProgress(waypointIndex / (track.length - 1));
          for (let frame = 0; frame < primeFramesPerWaypoint; frame++) {
            await renderOne();
            primeFrames++;
          }
        }
        applyProgress(0);
        for (let frame = 0; frame < routeStartPrimeFrames; frame++) {
          await renderOne();
          primeFrames++;
        }
        out.prime = {
          frames: primeFrames,
          globeTilesLoaded: scene.globe?.tilesLoaded ?? null,
          pendingForegroundCount:
            scene.context?.asyncResources?.pendingForegroundCount ?? null,
        };

        // Enabling resets the profiler. Capture every exact finalized frame;
        // no rolling-pass reconstruction is used.
        renderer.setCpuPassProfiling(true);
        out.route.accountingStart = profileSnapshot().frameAccounting;
        const routeStartSequence = normalSequence();
        for (let frameIndex = 0; frameIndex < measureFrames; frameIndex++) {
          const routeProgress =
            measureFrames <= 1 ? 1 : frameIndex / (measureFrames - 1);
          const trackState = applyProgress(routeProgress);
          const captured = await renderOne();
          captured.metadata = {
            ...captured.metadata,
            frameIndex,
            routeProgress,
            ...trackState,
          };
          out.route.frames.push(captured);
        }
        const routeEndProfile = profileSnapshot();
        out.route.accountingEnd = routeEndProfile.frameAccounting;
        out.route.sequenceDelta = normalSequence() - routeStartSequence;

        // Four orthogonal equal-instrumentation controls inject the same
        // bounded delay at an exact coarse-phase seam. Every arm records exact
        // seam/spin hit deltas; pair order alternates across lane and pair to
        // cancel second-render/TAA/cache bias. All wrappers are instance-local
        // and restored before the requestRender/2D/pick negative lanes.
        const busySpin = () => {
          const start = performance.now();
          while (performance.now() - start < injectedPhaseMs) {
            // Intentional bounded diagnostic delay.
          }
        };
        for (
          let controlIndex = 0;
          controlIndex < phaseControlSpecs.length;
          controlIndex++
        ) {
          const spec = phaseControlSpecs[controlIndex];
          const lane = {
            id: spec.id,
            targetPhase: spec.phase,
            seamHits: 0,
            spinHits: 0,
            pairs: [],
          };
          let inject = false;
          let restoreHook = () => {};
          let scheduleAfterRender;

          const installWrappedHook = (owner, methodName) => {
            const original = owner?.[methodName];
            if (typeof original !== "function") {
              throw new Error(
                `phase control ${spec.id} missing ${methodName} hook`,
              );
            }
            owner[methodName] = function (...args) {
              lane.seamHits++;
              if (inject) {
                lane.spinHits++;
                busySpin();
              }
              return original.apply(this, args);
            };
            restoreHook = () => {
              owner[methodName] = original;
            };
          };

          if (spec.id === "primitive-traversal") {
            installWrappedHook(scene._primitives, "update");
          } else if (spec.id === "pvs-prep") {
            installWrappedHook(
              scene._defaultView,
              "createPotentiallyVisibleSet",
            );
          } else if (spec.id === "renderer-overhead") {
            installWrappedHook(renderer, "executeCommands");
          } else if (spec.id === "after-render-credit-trace") {
            scheduleAfterRender = () => {
              scene.frameState.afterRender.push(() => {
                lane.seamHits++;
                if (inject) {
                  lane.spinHits++;
                  busySpin();
                }
                return false;
              });
            };
          } else {
            throw new Error(`unknown phase control ${spec.id}`);
          }

          try {
            for (let pairIndex = 0; pairIndex < controlPairs; pairIndex++) {
              const routeProgress =
                controlPairs <= 1 ? 0.5 : pairIndex / (controlPairs - 1);
              const trackState = applyProgress(routeProgress);
              const injectedFirst = (pairIndex + controlIndex) % 2 === 1;
              // Sequential awaits complete both arms before the loop advances;
              // the lane-local injection flag cannot escape this iteration.
              // eslint-disable-next-line no-loop-func
              const captureControl = async (injected) => {
                inject = injected;
                const seamHitsBefore = lane.seamHits;
                const spinHitsBefore = lane.spinHits;
                const captured = await renderOne(scheduleAfterRender);
                captured.metadata = {
                  ...captured.metadata,
                  controlId: spec.id,
                  targetPhase: spec.phase,
                  pairIndex,
                  routeProgress,
                  injected,
                  seamHitDelta: lane.seamHits - seamHitsBefore,
                  spinHitDelta: lane.spinHits - spinHitsBefore,
                  ...trackState,
                };
                return captured;
              };
              const first = await captureControl(injectedFirst);
              const second = await captureControl(!injectedFirst);
              lane.pairs.push({
                pairIndex,
                routeProgress,
                injectedFirst,
                baseline: injectedFirst ? second : first,
                injected: injectedFirst ? first : second,
              });
            }
          } finally {
            inject = false;
            restoreHook();
          }
          out.phaseInjectionControls.lanes.push(lane);
        }

        // Score request-render suppression while the ordinary 3D route is
        // still resident. The forced multi-frustum and SCENE2D lanes below can
        // legitimately mint new pipeline work, so they must not contaminate
        // this negative lane's precondition.
        const snapshotRequestRenderState = () => {
          const monitor = scene.context?.asyncResources;
          return {
            pendingForegroundCount: monitor?.pendingForegroundCount ?? 0,
            pendingCount: monitor?.pendingCount ?? 0,
            pendingByKind: monitor?.pendingByKind ?? null,
            requestRenderMode: scene.requestRenderMode === true,
            renderRequested: scene._renderRequested === true,
            logDepthBufferDirty: scene._logDepthBufferDirty === true,
            hdrDirty: scene._hdrDirty === true,
            maximumRenderTimeChangeDefined:
              scene.maximumRenderTimeChange !== undefined,
            afterRenderCount: scene.frameState?.afterRender?.length ?? null,
            sceneMode: scene.mode,
            expectedSceneMode: C.SceneMode.SCENE3D,
            globeTilesLoaded: scene.globe?.tilesLoaded ?? null,
          };
        };
        const prepareSuppressionAttempt = () => {
          scene.requestRenderMode = true;
          scene.maximumRenderTimeChange = undefined;
          scene._renderRequested = false;
          scene._logDepthBufferDirty = false;
          scene._hdrDirty = false;
        };
        const attemptSuppression = () => {
          const preconditions = snapshotRequestRenderState();
          const before = profileSnapshot();
          const frameBefore = scene.frameState.frameNumber;
          scene.initializeFrame();
          scene.render(viewer.clock.currentTime);
          const after = profileSnapshot();
          const afterState = snapshotRequestRenderState();
          const result = {
            normalSampleDelta:
              (after.lastFrame?.sequence ?? 0) -
              (before.lastFrame?.sequence ?? 0),
            legacyFrameDelta: after.frameCount - before.frameCount,
            sceneFrameDelta: scene.frameState.frameNumber - frameBefore,
            lastSequenceBefore: before.lastFrame?.sequence ?? null,
            lastSequenceAfter: after.lastFrame?.sequence ?? null,
            lastNormalRecordUnchanged: recordsEqual(
              before.lastFrame,
              after.lastFrame,
            ),
            normalAccountingUnchanged: recordsEqual(
              before.frameAccounting,
              after.frameAccounting,
            ),
            preconditions,
            afterState,
          };
          result.suppressed =
            result.normalSampleDelta === 0 &&
            result.legacyFrameDelta === 0 &&
            result.sceneFrameDelta === 0 &&
            result.lastNormalRecordUnchanged &&
            result.normalAccountingUnchanged;
          return result;
        };

        scene.requestRenderMode = false;
        const quiescenceStart = performance.now();
        let requestRenderDrainFrames = 0;
        let zeroForegroundStreak = 0;
        let lastPendingForeground = null;
        let confirmedSuppressedPreflight = false;
        const quiescenceHistory = [];
        const preflightAttempts = [];
        while (
          requestRenderDrainFrames < requestRenderMaxDrainFrames &&
          performance.now() - quiescenceStart < requestRenderTimeoutMs
        ) {
          await renderOne();
          requestRenderDrainFrames++;
          const state = snapshotRequestRenderState();
          zeroForegroundStreak =
            state.pendingForegroundCount === 0 ? zeroForegroundStreak + 1 : 0;
          if (
            requestRenderDrainFrames <= 5 ||
            state.pendingForegroundCount !== lastPendingForeground ||
            requestRenderDrainFrames % 30 === 0
          ) {
            quiescenceHistory.push({
              drainFrame: requestRenderDrainFrames,
              elapsedMs: performance.now() - quiescenceStart,
              zeroForegroundStreak,
              ...state,
            });
          }
          lastPendingForeground = state.pendingForegroundCount;

          if (zeroForegroundStreak < requestRenderZeroStreak) {
            continue;
          }

          // This unscored attempt consumes any otherwise-invisible camera
          // change and drains afterRender callbacks. It must itself suppress,
          // and leave every explicit shouldRender trigger clean, before the
          // immediately-following attempt is eligible to be scored.
          prepareSuppressionAttempt();
          const preflight = attemptSuppression();
          preflightAttempts.push(preflight);
          const afterState = preflight.afterState;
          confirmedSuppressedPreflight =
            preflight.suppressed === true &&
            afterState.pendingForegroundCount === 0 &&
            afterState.renderRequested === false &&
            afterState.logDepthBufferDirty === false &&
            afterState.hdrDirty === false &&
            afterState.afterRenderCount === 0 &&
            afterState.sceneMode === C.SceneMode.SCENE3D;
          if (confirmedSuppressedPreflight) {
            break;
          }

          scene.requestRenderMode = false;
          zeroForegroundStreak = 0;
        }

        const quiescence = {
          reached: confirmedSuppressedPreflight,
          timeoutMs: requestRenderTimeoutMs,
          maxDrainFrames: requestRenderMaxDrainFrames,
          requiredZeroForegroundFrames: requestRenderZeroStreak,
          drainFrames: requestRenderDrainFrames,
          elapsedMs: performance.now() - quiescenceStart,
          zeroForegroundStreak,
          preflightAttempts: preflightAttempts.length,
          history: quiescenceHistory,
          preflights: preflightAttempts,
          finalState: snapshotRequestRenderState(),
        };

        if (confirmedSuppressedPreflight) {
          // No await/yield occurs between the successful preflight and this
          // scored call, so a new async completion cannot manufacture a dirty
          // state between proof of readiness and measurement.
          prepareSuppressionAttempt();
          const scored = attemptSuppression();
          out.negativeLanes.requestRender = {
            scored: true,
            confirmedSuppressedPreflight,
            quiescence,
            ...scored,
          };
        } else {
          out.negativeLanes.requestRender = {
            scored: false,
            confirmedSuppressedPreflight,
            quiescence,
            preconditions: snapshotRequestRenderState(),
          };
        }

        // Subsequent explicit render lanes are continuous by construction.
        scene.requestRenderMode = false;

        // Explicit multi-frustum lane. The route itself may legitimately use a
        // single log-depth frustum, so force the established non-log split and
        // search bounded camera heights for a non-vacuous >=2-frustum frame.
        scene.morphTo3D(0);
        const originalLogDepth = scene.logarithmicDepthBuffer;
        const originalFarToNearRatio = scene.farToNearRatio;
        const multiCandidates = [];
        try {
          scene.logarithmicDepthBuffer = false;
          scene.farToNearRatio = 1000;
          for (const height of [18_000_000, 6_000_000, 900_000, 60_000]) {
            scene.camera.setView({
              destination: C.Cartesian3.fromDegrees(-122.35, 37.74, height),
              orientation: {
                heading: C.Math.toRadians(35),
                pitch: C.Math.toRadians(-70),
                roll: 0,
              },
            });
            const before = normalSequence();
            const captured = await renderOne();
            const after = normalSequence();
            multiCandidates.push({
              height,
              frustumCount: captured.metadata.frustumCount,
              normalSampleDelta: after - before,
              captured,
            });
            if (captured.metadata.frustumCount >= 2) break;
          }
        } finally {
          scene.logarithmicDepthBuffer = originalLogDepth;
          scene.farToNearRatio = originalFarToNearRatio;
        }
        const selectedMulti = multiCandidates.find(
          (candidate) => candidate.frustumCount >= 2,
        );
        out.negativeLanes.multiFrustum = selectedMulti
          ? {
              found: true,
              height: selectedMulti.height,
              frustumCount: selectedMulti.frustumCount,
              normalSampleDelta: selectedMulti.normalSampleDelta,
              frame: selectedMulti.captured,
            }
          : { found: false, candidates: multiCandidates };

        // Force a real SCENE2D wrap and count backend renderer entries. The
        // logical Scene.render must still commit exactly one normal sample.
        scene.morphTo2D(0);
        const original2DExecute = renderer.executeCommands;
        let execute2DCalls = 0;
        renderer.executeCommands = function (...args) {
          execute2DCalls++;
          return original2DExecute.apply(this, args);
        };
        const candidates2D = [];
        try {
          for (const lon of [179, 150, 90, 45, -179, -90]) {
            scene.camera.setView({
              destination: C.Cartesian3.fromDegrees(lon, 20, 1_500_000),
            });
            execute2DCalls = 0;
            const before = normalSequence();
            const captured = await renderOne();
            const after = normalSequence();
            candidates2D.push({
              lon,
              executeCalls: execute2DCalls,
              normalSampleDelta: after - before,
              captured,
            });
            if (execute2DCalls === 2) break;
          }
        } finally {
          renderer.executeCommands = original2DExecute;
        }
        const selected2D = candidates2D.find(
          (candidate) => candidate.executeCalls === 2,
        );
        out.negativeLanes.scene2D = selected2D
          ? {
              foundSplit: true,
              lon: selected2D.lon,
              executeCalls: selected2D.executeCalls,
              normalSampleDelta: selected2D.normalSampleDelta,
              frame: selected2D.captured,
            }
          : { foundSplit: false, candidates: candidates2D };

        // Return to a stable 3D view before pick isolation.
        scene.morphTo3D(0);
        applyProgress(0.5);
        scene.requestRenderMode = false;
        await renderOne();

        // Standalone pick is an offscreen mini-frame. It may update legacy pass
        // windows/frameCount, but must never overwrite the last NORMAL record.
        const pickBefore = profileSnapshot();
        let pickError = null;
        const pickAvailable = typeof scene.pickAsync === "function";
        if (pickAvailable) {
          try {
            await scene.pickAsync(
              new C.Cartesian2(
                scene.canvas.clientWidth * 0.5,
                scene.canvas.clientHeight * 0.5,
              ),
            );
          } catch (error) {
            pickError = String(error?.message ?? error);
          }
        }
        const pickAfter = profileSnapshot();
        out.negativeLanes.pick = {
          available: pickAvailable,
          error: pickError,
          normalSampleDelta:
            (pickAfter.lastFrame?.sequence ?? 0) -
            (pickBefore.lastFrame?.sequence ?? 0),
          legacyFrameDelta: pickAfter.frameCount - pickBefore.frameCount,
          lastNormalSequenceChanged:
            pickAfter.lastFrame?.sequence !== pickBefore.lastFrame?.sequence,
          lastNormalRecordUnchanged: recordsEqual(
            pickBefore.lastFrame,
            pickAfter.lastFrame,
          ),
          normalAccountingUnchanged: recordsEqual(
            pickBefore.frameAccounting,
            pickAfter.frameAccounting,
          ),
          sequenceBefore: pickBefore.lastFrame?.sequence ?? null,
          sequenceAfter: pickAfter.lastFrame?.sequence ?? null,
        };

        renderer.setCpuPassProfiling(false);
        scene.requestRenderMode = false;
        return out;
      },
      {
        runId: RUN_ID,
        track: GLOBE_CAMERA_TRACK,
        measureFrames: MEASURE_FRAMES,
        primeFramesPerWaypoint: PRIME_FRAMES_PER_WAYPOINT,
        routeStartPrimeFrames: ROUTE_START_PRIME_FRAMES,
        controlPairs: CONTROL_PAIRS,
        phaseControlSpecs: PHASE_CONTROL_SPECS,
        injectedPhaseMs: INJECTED_PHASE_MS,
        requestRenderTimeoutMs: REQUEST_RENDER_QUIESCENCE_TIMEOUT_MS,
        requestRenderMaxDrainFrames: REQUEST_RENDER_MAX_DRAIN_FRAMES,
        requestRenderZeroStreak: REQUEST_RENDER_ZERO_STREAK,
      },
    );
    gpuGate = await collectGateErrors(page);
  } catch (error) {
    fatalError = String(error?.stack ?? error?.message ?? error);
    try {
      gpuGate = await collectGateErrors(page);
    } catch {
      gpuGate = { armedDevices: 0, errors: [], deviceLost: null };
    }
  } finally {
    // Snapshot errors before teardown. Closing the context may abort otherwise
    // healthy local requests and must not manufacture a probe failure.
    raw.pageErrors = pageErrors.slice();
    raw.localRequestFailures = localRequestFailures.slice();
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  return buildReport(raw, consoleErrors, gpuGate, fatalError);
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
    schemaVersion: 4,
    runId: RUN_ID,
    startedAt: new Date().toISOString(),
    generatedAt: new Date().toISOString(),
    probe: "c11-169-webgpu-whole-frame-phase-attribution",
    instrumentationMode: "diagnostic-noncausal",
    status: "RUNNING",
    pass: false,
    exitCode: 2,
    incomplete: true,
    firstRed,
    failures: [],
  };
  // Replace any stale final before work begins. An interrupted process leaves
  // an explicit incomplete marker rather than preserving an old PASS.
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(running, null, 2)}\n`);
  const watchdog = setTimeout(() => {
    const timeoutArtifact = {
      ...running,
      generatedAt: new Date().toISOString(),
      status: "ERROR",
      incomplete: false,
      failures: [`watchdog fired after ${WATCHDOG_MS}ms`],
      firstRed: {
        ...firstRed,
        written: !firstRed.existedBefore,
        preserved: firstRed.existedBefore,
      },
    };
    const serialized = `${JSON.stringify(timeoutArtifact, null, 2)}\n`;
    fs.writeFileSync(OUTPUT_PATH, serialized);
    if (!firstRed.existedBefore) {
      fs.writeFileSync(FIRST_RED_OUTPUT_PATH, serialized);
    }
    console.error(`[c11-169] watchdog fired after ${WATCHDOG_MS}ms`);
    process.exit(2);
  }, WATCHDOG_MS);
  watchdog.unref?.();
  let report;
  try {
    report = await runBrowserProbe();
  } catch (error) {
    report = buildReport(
      { runId: RUN_ID },
      [],
      { armedDevices: 0, errors: [], deviceLost: null },
      String(error?.stack ?? error),
    );
  }
  report.runId = RUN_ID;
  report.firstRed = {
    ...firstRed,
    written: report.exitCode !== 0 && !firstRed.existedBefore,
    preserved: firstRed.existedBefore,
  };
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
        route: report.route?.gate?.observed,
        phaseInjectionControls: {
          pass: report.phaseInjectionControls?.pass,
          failures: report.phaseInjectionControls?.failures,
        },
        negativeLanes: report.negativeLanes?.gate,
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
