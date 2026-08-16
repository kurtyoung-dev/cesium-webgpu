// @purpose Guard for the frame-breakdown probe's accounting: phase names match the engine profiler, coverage/overlap validity, request-render suppression.
// @status ACTIVE

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  CPU_SCENE_PHASE_NAMES,
  evaluateAccountingFrames,
  evaluatePhaseControl,
  evaluateRequestRenderSuppression,
  interpolateTrack,
  normalizeLastFrame,
} from "./probe-webgpu-frame-breakdown.mjs";
import { GLOBE_CAMERA_TRACK } from "./lib/globe-camera-track.mjs";
import { CPU_SCENE_PHASE_NAMES as ENGINE_CPU_SCENE_PHASE_NAMES } from "../../packages/engine/Source/Renderer/WebGPU/WebGPUCpuPassProfiler.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const probeSource = fs.readFileSync(
  path.join(__dirname, "probe-webgpu-frame-breakdown.mjs"),
  "utf8",
);

function makeFrame(index, overrides = {}) {
  const totalMs = overrides.totalMs ?? 10;
  const profiledPassMs = overrides.profiledPassMs ?? 4;
  const overlapMs = overrides.overlapMs ?? 0;
  const unaccountedMs =
    overrides.unaccountedMs ?? totalMs + overlapMs - profiledPassMs;
  const phaseTotalMs = overrides.phaseTotalMs ?? unaccountedMs;
  const phaseMs =
    overrides.phaseMs ??
    Object.fromEntries(
      CPU_SCENE_PHASE_NAMES.map((phase) => [
        phase,
        phaseTotalMs / CPU_SCENE_PHASE_NAMES.length,
      ]),
    );
  return {
    sequence: index + 1,
    sceneFrameNumber: 100 + index,
    kind: "scene",
    totalMs,
    profiledPassMs,
    unaccountedMs,
    overlapMs,
    coverageRatio: totalMs > 0 ? profiledPassMs / totalMs : 0,
    valid: overlapMs === 0,
    passMs: { globe: profiledPassMs },
    phaseAttributionEnabled: true,
    phaseMs,
    phaseTotalMs,
    unattributedMs: overrides.unattributedMs ?? 0,
    attributionOverlapMs: overrides.attributionOverlapMs ?? 0,
    attributionValid: true,
    routeProgress: index / 179,
    segmentIndex: Math.min(7, Math.floor((index / 179) * 8)),
    frustumCount: index === 90 ? 2 : 1,
    ...overrides,
  };
}

test("normalizes only the exact lastFrame surface", () => {
  const normalized = normalizeLastFrame({
    frameAccounting: { samples: 1 },
    lastFrame: makeFrame(0),
  });
  assert.equal(normalized.sequence, 1);
  assert.equal(normalized.profiledPassMs, 4);
  assert.deepEqual(normalized.passMs, { globe: 4 });
  assert.match(
    normalizeLastFrame({ passes: { globe: { lastMs: 4 } } }).structuralError,
    /missing exact lastFrame/,
  );
});

test("probe phase schema exactly matches the frozen engine schema", () => {
  assert.deepEqual(CPU_SCENE_PHASE_NAMES, [...ENGINE_CPU_SCENE_PHASE_NAMES]);
  assert.equal(Object.isFrozen(CPU_SCENE_PHASE_NAMES), true);
});

test("accepts a complete conserved moving-route population", () => {
  const frames = Array.from({ length: 180 }, (_, index) => makeFrame(index));
  const gate = evaluateAccountingFrames(frames, {
    expectedSamples: 180,
    expectedSegmentCount: 8,
    requireFullRoute: true,
  });
  assert.equal(gate.pass, true, gate.failures.join("\n"));
  assert.equal(gate.observed.routeSegments.length, 8);
  assert.equal(gate.observed.maxFrustumCount, 2);
});

test("rejects non-conservation, overlap, stale sequence, and vacuous passes", () => {
  const frames = [
    makeFrame(0, {
      profiledPassMs: 0,
      unaccountedMs: 1,
      overlapMs: 1,
      valid: false,
      passMs: {},
    }),
    makeFrame(0),
  ];
  const gate = evaluateAccountingFrames(frames, {
    expectedSamples: 2,
    minProfiledFrameRatio: 1,
  });
  assert.equal(gate.pass, false);
  assert.match(gate.failures.join("\n"), /overlapping pass timers/);
  assert.match(gate.failures.join("\n"), /duplicate sequence/);
  assert.match(gate.failures.join("\n"), /profiled-frame ratio/);
});

test("rejects invalid individual pass buckets", () => {
  const negative = makeFrame(0, {
    totalMs: 10,
    profiledPassMs: 4,
    unaccountedMs: 6,
    passMs: { negative: -1, positive: 5 },
  });
  const nonFinite = normalizeLastFrame({
    lastFrame: makeFrame(1, { passMs: { globe: Number.NaN } }),
  });
  const gate = evaluateAccountingFrames([negative, nonFinite], {
    expectedSamples: 2,
    minProfiledFrameRatio: 0,
  });
  assert.equal(gate.pass, false);
  assert.match(gate.failures.join("\n"), /negative time/);
  assert.match(gate.failures.join("\n"), /non-finite pass buckets globe/);
});

test("four phase controls move only their exact target ledger", () => {
  for (const targetPhase of [
    "primitiveTraversal",
    "visibilityCommandPrep",
    "rendererOverhead",
    "afterRenderCreditTrace",
  ]) {
    const pairs = Array.from({ length: 12 }, (_, index) => {
      const baseline = makeFrame(index * 2, {
        seamHitDelta: 1,
        spinHitDelta: 0,
      });
      const injectedPhaseMs = {
        ...baseline.phaseMs,
        [targetPhase]: baseline.phaseMs[targetPhase] + 8,
      };
      const injected = makeFrame(index * 2 + 1, {
        totalMs: 18,
        profiledPassMs: 4,
        unaccountedMs: 14,
        phaseTotalMs: 14,
        phaseMs: injectedPhaseMs,
        seamHitDelta: 1,
        spinHitDelta: 1,
      });
      return { baseline, injected };
    });
    assert.equal(
      evaluatePhaseControl(pairs, targetPhase, 8).pass,
      true,
      targetPhase,
    );

    const rerouted = structuredClone(pairs);
    for (const pair of rerouted) {
      pair.injected.phaseMs[targetPhase] -= 8;
      pair.injected.phaseMs.sceneUpdate += 8;
    }
    assert.equal(evaluatePhaseControl(rerouted, targetPhase, 8).pass, false);

    const badHits = structuredClone(pairs);
    badHits[0].injected.spinHitDelta = 2;
    assert.equal(evaluatePhaseControl(badHits, targetPhase, 8).pass, false);

    const namedPassLeak = structuredClone(pairs);
    for (const pair of namedPassLeak) {
      pair.baseline.passMs = { globe: 4, opaque: 4 };
      pair.injected.passMs = { globe: 7, opaque: 1 };
    }
    assert.equal(
      evaluatePhaseControl(namedPassLeak, targetPhase, 8).pass,
      false,
    );

    const vacuousNamedPasses = structuredClone(pairs);
    for (const pair of vacuousNamedPasses) {
      pair.baseline.profiledPassMs = 0;
      pair.baseline.passMs = {};
      pair.injected.profiledPassMs = 0;
      pair.injected.passMs = {};
    }
    assert.equal(
      evaluatePhaseControl(vacuousNamedPasses, targetPhase, 8).pass,
      false,
    );

    for (const arm of ["baseline", "injected"]) {
      const vacuousArm = structuredClone(pairs);
      for (const pair of vacuousArm) {
        pair[arm].profiledPassMs = 0;
        pair[arm].passMs = {};
      }
      assert.equal(
        evaluatePhaseControl(vacuousArm, targetPhase, 8).pass,
        false,
        `${targetPhase} ${arm}`,
      );
    }
  }
});

test("phase accounting rejects schema, validity, and partition mutants", () => {
  const mutations = [];
  const missing = makeFrame(0);
  delete missing.phaseMs.contextBegin;
  mutations.push(missing);
  const extra = makeFrame(1);
  extra.phaseMs.unknown = 0;
  mutations.push(extra);
  const reordered = makeFrame(2);
  reordered.phaseMs = Object.fromEntries(
    Object.entries(reordered.phaseMs).reverse(),
  );
  mutations.push(reordered);
  mutations.push(
    makeFrame(3, {
      phaseMs: { ...makeFrame(3).phaseMs, frameState: Number.NaN },
    }),
  );
  mutations.push(
    makeFrame(4, {
      phaseMs: { ...makeFrame(4).phaseMs, frameState: -1 },
    }),
  );
  mutations.push(makeFrame(5, { phaseTotalMs: 5 }));
  mutations.push(makeFrame(6, { phaseAttributionEnabled: false }));
  mutations.push(makeFrame(7, { attributionValid: false }));
  mutations.push(makeFrame(8, { unattributedMs: 1, phaseTotalMs: 5 }));
  mutations.push(makeFrame(9, { attributionOverlapMs: 1 }));

  for (const frame of mutations) {
    const normalized = normalizeLastFrame({ lastFrame: frame });
    const gate = evaluateAccountingFrames([normalized], {
      expectedSamples: 1,
      minProfiledFrameRatio: 0,
    });
    assert.equal(gate.pass, false, JSON.stringify(frame));
  }
});

test("request-render suppression requires proven quiescence and zero deltas", () => {
  const passing = {
    scored: true,
    confirmedSuppressedPreflight: true,
    normalSampleDelta: 0,
    legacyFrameDelta: 0,
    sceneFrameDelta: 0,
    lastNormalRecordUnchanged: true,
    normalAccountingUnchanged: true,
    quiescence: {
      reached: true,
      timeoutMs: 30_000,
      maxDrainFrames: 900,
      requiredZeroForegroundFrames: 3,
      zeroForegroundStreak: 3,
      drainFrames: 8,
      elapsedMs: 150,
      preflightAttempts: 1,
    },
    preconditions: {
      pendingForegroundCount: 0,
      pendingByKind: {},
      requestRenderMode: true,
      renderRequested: false,
      logDepthBufferDirty: false,
      hdrDirty: false,
      maximumRenderTimeChangeDefined: false,
      afterRenderCount: 0,
      sceneMode: 3,
      expectedSceneMode: 3,
    },
    afterState: {
      pendingForegroundCount: 0,
      renderRequested: false,
      logDepthBufferDirty: false,
      hdrDirty: false,
      afterRenderCount: 0,
    },
  };
  assert.equal(evaluateRequestRenderSuppression(passing).pass, true);

  const contaminated = structuredClone(passing);
  contaminated.scored = false;
  contaminated.confirmedSuppressedPreflight = false;
  contaminated.quiescence.reached = false;
  contaminated.quiescence.zeroForegroundStreak = 0;
  contaminated.preconditions.pendingForegroundCount = 1;
  const gate = evaluateRequestRenderSuppression(contaminated);
  assert.equal(gate.pass, false);
  assert.match(gate.failures.join("\n"), /quiescence was not reached/);
  assert.match(gate.failures.join("\n"), /preflight did not suppress/);
  assert.match(gate.failures.join("\n"), /had 1 foreground jobs/);
});

test("track interpolation reaches every route segment and wraps longitude", () => {
  const observed = new Set();
  for (let index = 0; index < 180; index++) {
    const state = interpolateTrack(GLOBE_CAMERA_TRACK, index / 179);
    observed.add(state.segmentIndex);
    assert.ok(Number.isFinite(state.lon));
    assert.ok(Number.isFinite(state.height));
  }
  assert.deepEqual([...observed], [0, 1, 2, 3, 4, 5, 6, 7]);
});

test("source locks the noncausal moving-route and isolation policies", () => {
  assert.match(probeSource, /GLOBE_CAMERA_TRACK/);
  assert.match(probeSource, /renderer=webgpu&offline=true/);
  assert.match(probeSource, /const MEASURE_FRAMES = 180/);
  assert.match(probeSource, /viewer\.useDefaultRenderLoop = false/);
  assert.match(probeSource, /instrumentationMode: "diagnostic-noncausal"/);
  assert.match(
    probeSource,
    /lastFrame\.sequence` is the lifetime count since profiler/,
  );
  assert.match(probeSource, /const normalSequence = \(\) =>/);
  assert.doesNotMatch(
    probeSource,
    /frameAccounting\.samples[^\n]*(?:normalSampleDelta|sequenceDelta)/,
  );
  assert.match(probeSource, /phaseInjectionControls/);
  assert.match(probeSource, /scene\._primitives, "update"/);
  assert.match(probeSource, /"createPotentiallyVisibleSet"/);
  assert.match(probeSource, /renderer, "executeCommands"/);
  assert.match(probeSource, /scene\.frameState\.afterRender\.push/);
  assert.match(probeSource, /return false/);
  assert.match(probeSource, /\(pairIndex \+ controlIndex\) % 2 === 1/);
  assert.match(probeSource, /finally \{[\s\S]*restoreHook\(\)/);
  assert.match(probeSource, /const CONTROL_PAIRS = 24/);
  assert.match(probeSource, /const INJECTED_PHASE_MS = 8/);
  assert.match(
    probeSource,
    /expectedSamples: CONTROL_PAIRS \* 2,[\s\S]*minProfiledFrameRatio: 0/,
  );
  assert.match(probeSource, /control route did not span \[0,1\]/);
  assert.match(
    probeSource,
    /raw\?\.setup\?\.imagery !== "NaturalEarthII-local"/,
  );
  assert.match(probeSource, /status: "RUNNING"/);
  assert.match(probeSource, /policy: "write-once"/);
  assert.match(probeSource, /localRequestFailures/);
  assert.doesNotMatch(probeSource, /setCpuScenePhase\s*=/);
  assert.match(probeSource, /negativeLanes\.requestRender/);
  assert.match(probeSource, /negativeLanes\.pick/);
  assert.match(probeSource, /negativeLanes\.scene2D/);
  assert.match(probeSource, /negativeLanes\.multiFrustum/);
  assert.match(probeSource, /pendingByKind/);
  assert.match(probeSource, /confirmedSuppressedPreflight/);
  assert.match(probeSource, /const REQUEST_RENDER_ZERO_STREAK = 3/);
  assert.ok(
    probeSource.indexOf("Score request-render suppression") <
      probeSource.indexOf("Explicit multi-frustum lane"),
  );
  assert.doesNotMatch(probeSource, /cpuPassSumMs/);
  assert.doesNotMatch(probeSource, /SETTLE_MS/);
});
